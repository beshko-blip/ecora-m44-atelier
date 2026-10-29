# ECORA. Искусство движения — рендер внутреннего фильма.
# Кадры собираются в PIL и отдаются в ffmpeg как rawvideo. Тайминг сцен строится
# от фактической длительности реплик озвучки (vo/durations.json).
import json, math, os, sys, subprocess
from functools import lru_cache
from multiprocessing import Pool
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
import numpy as np
import qrcode

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = '/home/user/ecora-m44-atelier'
LIB = REPO + '/ECORA_M44_VISUAL_LIBRARY/WEB/'
W, H, FPS = 1920, 1080, 25

# Палитра: тёплый белый, молочный, кремовый, чёрный, графит
BG = (245, 242, 236)
MILK = (238, 234, 226)
CREAM = (230, 223, 210)
INK = (20, 20, 20)
GRAPHITE = (58, 58, 58)
MUTED = (132, 127, 119)
LINE = (190, 184, 174)
DARK = (14, 14, 14)
ACCENT = (0, 116, 114)  # бирюзовый из утверждённого логотипа (#007472)

# ---------------------------------------------------------------- timeline
SCENE_PADS = {  # pre, gap между репликами, post (сек)
    'open': (1.6, 0.8, 1.2), 'title': (0.6, 1.0, 1.0), 'manifest': (0.5, 0.6, 1.4),
    'patent': (1.0, 0.8, 1.5), 'morph': (0.3, 0, 1.6), 'detail': (0.6, 0.9, 1.2),
    'plan': (1.0, 0.8, 1.2), 'zone1': (0.8, 0.9, 1.4), 'zone2': (0.8, 0, 1.6),
    'zone3': (0.6, 0, 3.4), 'zone4': (0.8, 0, 1.6), 'tasks': (0.6, 0.8, 1.5),
    'final': (0.8, 1.2, 3.0),
}
NO_FADE_OUT = {'patent'}
NO_FADE_IN = {'morph'}


def build_timeline():
    script = json.load(open(HERE + '/script.json'))
    durs = {d[0]: d[1] for d in json.load(open(HERE + '/vo/durations.json'))}
    t = 0.0
    scenes, cues = [], []
    for si, s in enumerate(script):
        pre, gap, post = SCENE_PADS[s['scene']]
        start = t
        t += pre
        lines = []
        for li, (_, sub) in enumerate(s['lines']):
            fn = f'vo/{si:02d}_{li}.wav'
            d = durs[fn]
            lines.append((t, t + d))
            cues.append({'start': t, 'end': t + d, 'text': sub, 'wav': fn, 'scene': s['scene']})
            t += d + (gap if li < len(s['lines']) - 1 else 0)
        t += post
        scenes.append({'name': s['scene'], 'start': start, 'end': t, 'lines': lines})
    return scenes, cues, t


# ---------------------------------------------------------------- helpers
def ease(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def ease_out(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def ramp(t, a, d=0.8):
    return ease((t - a) / d) if d > 0 else float(t >= a)


def lerp(a, b, k):
    return a + (b - a) * k


def mix(c1, c2, k):
    return tuple(int(round(lerp(a, b, k))) for a, b in zip(c1, c2))


FONT_FILES = {w: f'{HERE}/fonts/Montserrat-{w}.ttf' for w in
              ('ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold')}


@lru_cache(None)
def font(size, weight='Light'):
    return ImageFont.truetype(FONT_FILES[weight], size)


@lru_cache(4096)
def text_sprite(text, size, weight='Light', color=INK, tracking=0.0):
    """RGBA-спрайт строки с ручным трекингом (tracking в долях кегля)."""
    f = font(size, weight)
    tr = tracking * size
    widths = [f.getlength(ch) for ch in text]
    total = sum(widths) + tr * max(0, len(text) - 1)
    asc, desc = f.getmetrics()
    im = Image.new('RGBA', (int(math.ceil(total)) + 4, asc + desc + 4), color + (0,))
    d = ImageDraw.Draw(im)
    if tracking == 0:
        d.text((2, 2), text, font=f, fill=color + (255,))
    else:
        x = 2.0
        for ch, w in zip(text, widths):
            d.text((x, 2), ch, font=f, fill=color + (255,))
            x += w + tr
    return im


def with_alpha(im, a):
    if a >= 0.999:
        return im
    im = im.copy()
    al = im.getchannel('A').point(lambda v: int(v * a))
    im.putalpha(al)
    return im


def paste(canvas, sprite, x, y, alpha=1.0, anchor='lt'):
    if alpha <= 0.002:
        return
    w, h = sprite.size
    if anchor[0] == 'm':
        x -= w / 2
    elif anchor[0] == 'r':
        x -= w
    if anchor[1] == 'm':
        y -= h / 2
    elif anchor[1] == 'b':
        y -= h
    canvas.alpha_composite(with_alpha(sprite, alpha), (int(round(x)), int(round(y))))


def text(canvas, s, x, y, size, weight='Light', color=INK, tracking=0.0, alpha=1.0,
         anchor='lt', rise=0.0):
    """Типографика появляется с лёгким подъёмом: rise — смещение в px."""
    paste(canvas, text_sprite(s, size, weight, color, tracking), x, y + rise, alpha, anchor)


def reveal(canvas, s, x, y, size, t, t0, weight='Light', color=INK, tracking=0.0,
           anchor='lt', dur=0.9, out=None):
    a = ramp(t, t0, dur)
    if out is not None:
        a *= 1 - ramp(t, out, 0.6)
    text(canvas, s, x, y, size, weight, color, tracking, a, anchor, rise=(1 - ease_out((t - t0) / dur)) * 14)


def hline(d, x0, y, x1, color=LINE, width=1):
    if x1 > x0 + 0.5:
        d.line([(x0, y), (x1, y)], fill=color, width=width)


def overlay_draw(canvas):
    layer = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    return layer, ImageDraw.Draw(layer)


def blend_layer(canvas, layer, alpha=1.0):
    canvas.alpha_composite(with_alpha(layer, alpha))


# ---------------------------------------------------------------- assets
def load_rgb(path):
    return Image.open(path).convert('RGB')


def multiply_on(im, bg=BG):
    """Белый фон фото/чертежа «растворяется» в тёплом белом фоне кадра."""
    base = Image.new('RGB', im.size, bg)
    return ImageChops.multiply(im.convert('RGB'), base)


ASSETS = {}


def load_assets():
    A = ASSETS
    A['logo_en'] = Image.open(HERE + '/logo_en.png').convert('RGBA')
    A['mark'] = Image.open(HERE + '/mark.png').convert('RGBA')
    pg = load_rgb(HERE + '/dl/pg-1.png')
    pg = multiply_on(pg, (241, 236, 226))
    A['patent'] = pg
    A['fig1'] = pg.crop((1350, 2600, 4150, 5050))
    A['fig2'] = pg.crop((3900, 2600, 5100, 5050))
    A['fig3'] = pg.crop((1500, 5600, 4100, 7500))
    A['phead'] = pg.crop((900, 1350, 5600, 2250))
    chalk = 'M44_chalk_K05-K45-FB_'
    for v in ('0350', '0368', '0438', '0453', '0718'):
        A['chalk_' + v] = multiply_on(load_rgb(LIB + chalk + v + '_2400.webp'))
    presets = [('blacktitan', 'M44_blacktitan_K44-K45-FS_0350_2400.webp', 'Чёрный титан'),
               ('chalk', 'M44_chalk_K05-K45-FB_0350_2400.webp', 'Мел и графит'),
               ('cognac', 'M44_cognac_K26-K44-FB_0350_2400.webp', 'Коньяк'),
               ('bordeaux', 'M44_bordeaux_K29-K44-FB_0350_2400.webp', 'Бордо'),
               ('navigator', 'M44_navigator_K41-K05-FS_0350_2400.webp', 'Навигатор')]
    A['presets'] = [(k, multiply_on(load_rgb(LIB + f)).resize((600, 400), Image.LANCZOS), n)
                    for k, f, n in presets]
    qr = qrcode.QRCode(border=0, box_size=10)
    qr.add_data('https://ecorafitness.ru')
    qr.make(fit=True)
    q = qr.make_image(fill_color=INK, back_color=(255, 255, 255)).convert('RGB')
    A['qr'] = q.resize((220, 220), Image.NEAREST)
    # постамент: белый объём с мягкой тенью
    A['shadow'] = make_shadow()


def make_shadow():
    im = Image.new('L', (600, 160), 0)
    ImageDraw.Draw(im).ellipse((60, 50, 540, 110), fill=120)
    im = im.filter(ImageFilter.GaussianBlur(22))
    sh = Image.new('RGBA', im.size, (60, 50, 40, 0))
    sh.putalpha(im)
    return sh


def cam(img, rect, out_size):
    """Crop rect (x0,y0,x1,y1) в координатах источника → resize. Ken Burns."""
    x0, y0, x1, y1 = rect
    return img.resize(out_size, Image.BILINEAR, box=(x0, y0, x1, y1))


def fit_rect(img_size, center, zoom, aspect):
    """Прямоугольник кадрирования: центр (доли), zoom (1 = вся ширина), aspect=w/h выхода."""
    iw, ih = img_size
    w = iw / zoom
    h = w / aspect
    if h > ih:
        h = ih / zoom
        w = h * aspect
    cx, cy = center[0] * iw, center[1] * ih
    x0 = min(max(cx - w / 2, 0), iw - w)
    y0 = min(max(cy - h / 2, 0), ih - h)
    return (x0, y0, x0 + w, y0 + h)


def contain(img, box_w, box_h):
    iw, ih = img.size
    s = min(box_w / iw, box_h / ih)
    return img.resize((max(1, int(iw * s)), max(1, int(ih * s))), Image.LANCZOS)


def place_img(canvas, img, x, y, alpha=1.0, mask_round=False):
    im = img.convert('RGBA')
    if alpha < 1:
        im.putalpha(int(255 * alpha))
    canvas.alpha_composite(im, (int(x), int(y)))


# ---------------------------------------------------------------- chrome
SECTIONS = {
    'title': '01  ИДЕЯ', 'manifest': '01  ИДЕЯ', 'patent': '02  ИСТОРИЯ', 'morph': '02  ИСТОРИЯ',
    'detail': '03  ЭКСПОНАТ', 'plan': '04  СТЕНД', 'zone1': '04  СТЕНД · ЗОНА 1',
    'zone2': '04  СТЕНД · ЗОНА 2', 'zone3': '04  СТЕНД · ЗОНА 3', 'zone4': '04  СТЕНД · ЗОНА 4',
    'tasks': '05  РЕАЛИЗАЦИЯ',
}


def chrome(canvas, name, a):
    if name not in SECTIONS or a <= 0:
        return
    text(canvas, 'ECORA  ·  ИСКУССТВО ДВИЖЕНИЯ', 120, 62, 15, 'Regular', MUTED, 0.22, a)
    text(canvas, SECTIONS[name], W - 120, 62, 15, 'Regular', MUTED, 0.22, a, anchor='rt')
    layer, d = overlay_draw(canvas)
    hline(d, 120, 96, W - 120, (214, 208, 198))
    blend_layer(canvas, layer, a)


# ---------------------------------------------------------------- plan
# Метры: x — слева направо, y — от задней стены к фронту. СХЕМА УСЛОВНАЯ.
U = (1.25, 1.2, 3.75, 3.2)  # П-образная конструкция 2.5 × 2.0 м, открыта к фронту
ZONES = {
    1: (0.0, 0.0, 1.15, 5.0),
    2: (1.25, 1.2, 3.75, 3.2),
    3: (3.85, 0.0, 5.0, 5.0),
    4: (1.15, 3.9, 3.85, 5.0),
}
ZONE_NAMES = {1: 'КЛАССИКА', 2: 'ИСТОРИЯ · МЕДИА', 3: 'ИНЖЕНЕРИЯ И ЦВЕТ', 4: 'УЧАСТИЕ'}


def draw_plan(canvas, ox, oy, s, draw=1.0, zone=None, zone_a=0.0, dims=True, labels_a=0.0,
              path_k=0.0, small=False):
    layer, d = overlay_draw(canvas)
    P = lambda x, y: (ox + x * s, oy + y * s)
    # сетка 1 м
    ga = ramp(draw, 0.0, 0.3)
    for i in range(6):
        for j in range(6):
            x, y = P(i, j)
            d.ellipse((x - 1.5, y - 1.5, x + 1.5, y + 1.5), fill=LINE + (int(200 * ga),))
    # зона-подсветка
    if zone and zone_a > 0:
        zx0, zy0, zx1, zy1 = ZONES[zone]
        d.rectangle((*P(zx0, zy0), *P(zx1, zy1)), fill=CREAM + (int(255 * zone_a),))
    # пол / граница
    k = ramp(draw, 0.1, 0.4)
    x0, y0 = P(0, 0)
    x1, y1 = P(5, 5)
    per = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    draw_poly_partial(d, per, k, (150, 145, 138, 255), 1)
    # стены 3 м: задняя и боковые (уточнить по PDF)
    wk = ramp(draw, 0.35, 0.4)
    wt = max(3, int(0.1 * s))
    walls = [(0, 5), (0, 0), (5, 0), (5, 5)]
    draw_poly_partial(d, [P(*p) for p in walls], wk, INK + (255,), wt)
    # П-образная конструкция
    uk = ramp(draw, 0.6, 0.4)
    ux0, uy0, ux1, uy1 = U
    upoly = [P(ux0, uy1), P(ux0, uy0), P(ux1, uy0), P(ux1, uy1)]
    draw_poly_partial(d, upoly, uk, INK + (255,), wt)
    # путь посетителя
    if path_k > 0:
        pts = [(2.5, 5.0), (2.5, 4.4), (2.5, 3.3), (2.5, 2.4)]
        draw_dotted(d, [P(*p) for p in pts], path_k, ACCENT + (255,), max(4, s * 0.06))
    blend_layer(canvas, layer)
    if dims:
        da = ramp(draw, 0.8, 0.3)
        fs = 14 if small else 15
        text(canvas, '5 000', (x0 + x1) / 2, y1 + 18, fs, 'Regular', MUTED, 0.12, da, 'mt')
        sp = text_sprite('5 000', fs, 'Regular', MUTED, 0.12).rotate(90, expand=True)
        paste(canvas, sp, x0 - 20, (y0 + y1) / 2, da, 'rm')
        if not small:
            text(canvas, '2 500 × 2 000', (P(ux0, 0)[0] + P(ux1, 0)[0]) / 2, P(0, uy0)[1] - 26, 13,
                 'Regular', MUTED, 0.12, da * 0.9, 'mt')
            text(canvas, 'ФРОНТ', (x0 + x1) / 2, y1 + 44, 12, 'Regular', MUTED, 0.3, da, 'mt')
    if labels_a > 0:
        for z, (zx0, zy0, zx1, zy1) in ZONES.items():
            cx, cy = P((zx0 + zx1) / 2, (zy0 + zy1) / 2)
            if z == 2:
                cy = P(0, (zy0 + zy1) / 2 + 0.15)[1]
            text(canvas, str(z), cx, cy, 30 if not small else 20, 'Light', GRAPHITE, 0, labels_a, 'mm')


def draw_poly_partial(d, pts, k, fill, width):
    if k <= 0:
        return
    segs = list(zip(pts[:-1], pts[1:]))
    lens = [math.dist(a, b) for a, b in segs]
    total = sum(lens) * k
    for (a, b), L in zip(segs, lens):
        if total <= 0:
            break
        f = min(1, total / L)
        d.line([a, (lerp(a[0], b[0], f), lerp(a[1], b[1], f))], fill=fill, width=width)
        total -= L
    # аккуратные углы
    for p in pts[1:-1]:
        r = width / 2 - 0.5
        if r > 1 and k > 0.05:
            d.rectangle((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=fill)


def draw_dotted(d, pts, k, fill, r):
    segs = list(zip(pts[:-1], pts[1:]))
    total = sum(math.dist(a, b) for a, b in segs)
    step = r * 3.2
    n = int(total * k / step)
    pos = 0
    for a, b in segs:
        L = math.dist(a, b)
        t = 0
        while t < L and n > 0:
            x, y = lerp(a[0], b[0], t / L), lerp(a[1], b[1], t / L)
            d.ellipse((x - r / 2, y - r / 2, x + r / 2, y + r / 2), fill=fill)
            t += step
            n -= 1
        if n <= 0:
            break


# ---------------------------------------------------------------- objects
def plinth(canvas, cx, base_y, w, h, alpha=1.0, depth=0.22):
    """Белый музейный постамент в лёгкой фронтальной перспективе."""
    dpx = w * depth
    layer, d = overlay_draw(canvas)
    sh = ASSETS['shadow'].resize((int(w * 1.6), int(w * 0.42)))
    layer.alpha_composite(sh, (int(cx - sh.width / 2), int(base_y - sh.height * 0.45)))
    x0, x1 = cx - w / 2, cx + w / 2
    top = base_y - h
    d.polygon([(x0, top), (x1, top), (x1 - dpx * 0.35, top - dpx * 0.55), (x0 + dpx * 0.35, top - dpx * 0.55)],
              fill=(252, 251, 248, 255))
    d.rectangle((x0, top, x1, base_y), fill=(249, 247, 242, 255))
    d.rectangle((x1 - w * 0.06, top, x1, base_y), fill=(236, 232, 224, 255))
    d.line([(x0, top), (x1, top)], fill=(222, 216, 206, 255), width=1)
    blend_layer(canvas, layer, alpha)


def frame_box(canvas, x, y, w, h, img=None, alpha=1.0, border=GRAPHITE, mat=10, bw=2):
    """Рамка-экспонат: тонкая рамка, паспарту, изображение."""
    layer, d = overlay_draw(canvas)
    d.rectangle((x + 6, y + 8, x + w + 6, y + h + 8), fill=(80, 70, 60, 26))
    d.rectangle((x, y, x + w, y + h), fill=(252, 251, 248, 255), outline=border + (255,), width=bw)
    if img is not None:
        iw, ih = w - 2 * mat, h - 2 * mat
        r = fit_rect(img.size, (0.5, 0.5), 1.0, iw / ih)
        layer.paste(cam(img, r, (int(iw), int(ih))), (int(x + mat), int(y + mat)))
    blend_layer(canvas, layer, alpha)


def label(canvas, x, y, num, title, meta, a, width=360, size=22):
    """Музейная этикетка."""
    layer, d = overlay_draw(canvas)
    hline(d, x, y, x + width * ease_out(a), INK + (255,), 1)
    blend_layer(canvas, layer, a)
    text(canvas, num, x, y + 14, 14, 'Regular', MUTED, 0.25, a)
    yy = y + 38
    for i, line in enumerate(title):
        text(canvas, line, x, yy, size, 'Regular', INK, 0.0, a)
        yy += int(size * 1.35)
    yy += 6
    for line in meta:
        text(canvas, line, x, yy, 19, 'Light', GRAPHITE, 0.01, a)
        yy += 28


# ---------------------------------------------------------------- scenes
def sc_open(c, t, S):
    L = S['lines']
    T = S['end'] - S['start']
    # свет «включается» в конце сцены: из тёмного в тёплый белый
    k = ramp(t, T - 1.3, 1.3)
    c.paste(mix(DARK, BG, k), (0, 0, W, H))
    fg = mix((235, 230, 222), INK, k)
    a1 = ramp(t, L[0][0] - 0.2, 1.0) * (1 - ramp(t, L[1][0] - 0.3, 0.6))
    text(c, 'СТЕНД, КОТОРЫЙ ПРОДАЁТ ТОВАР', W / 2, H / 2 - 30, 40, 'Light', (176, 171, 163), 0.28, a1, 'mm')
    a2 = ramp(t, L[1][0] - 0.1, 1.2) * (1 - ramp(t, T - 0.6, 0.6))
    text(c, 'ПРОСТРАНСТВО,', W / 2, H / 2 - 62, 40, 'Light', fg, 0.28, a2, 'mm')
    text(c, 'КОТОРОЕ ПОКАЗЫВАЕТ ДВИЖЕНИЕ', W / 2, H / 2 - 2, 40, 'Light', fg, 0.28, a2, 'mm')
    # линия-движение
    lk = ease_out((t - L[1][0]) / 2.6)
    if lk > 0:
        layer, d = overlay_draw(c)
        w = 760 * lk
        hline(d, W / 2 - w / 2, H / 2 + 60, W / 2 + w / 2, mix((200, 196, 188), INK, k) + (255,))
        blend_layer(c, layer, a2)


def sc_title(c, t, S):
    L = S['lines']
    logo = ASSETS['logo_en']
    lw = 620
    lg = logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS)
    a = ramp(t, 0.2, 1.4)
    up = ease(ramp(t, L[1][0] - 0.4, 1.4)) * 70
    sc = 1 + 0.02 * (1 - ease_out(t / 3))
    if sc != 1:
        lg = lg.resize((int(lg.width * sc), int(lg.height * sc)), Image.LANCZOS)
    paste(c, lg, W / 2, H / 2 - 70 - up, a, 'mm')
    ta = ramp(t, L[0][0] + 0.5, 1.2)
    text(c, 'ИСКУССТВО ДВИЖЕНИЯ', W / 2, H / 2 + 120 - up, 38, 'Light', GRAPHITE, 0.42, ta, 'mm',
         rise=(1 - ta) * 12)
    layer, d = overlay_draw(c)
    lk = ease_out((t - L[0][0] - 0.3) / 1.6)
    hline(d, W / 2 - 160 * lk, H / 2 + 72 - up, W / 2 + 160 * lk, INK + (255,))
    blend_layer(c, layer)
    t2 = L[1][0]
    reveal(c, '25 м²', W / 2 - 40, H / 2 + 190, 92, t, t2, 'ExtraLight', INK, 0.0, 'rt')
    reveal(c, 'выставочного стенда,', W / 2 + 10, H / 2 + 212, 24, t, t2 + 0.5, 'Light', GRAPHITE, 0.02, 'lt')
    reveal(c, 'собранного как галерея', W / 2 + 10, H / 2 + 246, 24, t, t2 + 0.8, 'Regular', INK, 0.02, 'lt')


def sc_manifest(c, t, S):
    L = S['lines']
    rows = [('ОБОРУДОВАНИЕ', 'экспонаты'), ('ИСТОРИЯ', 'содержание'),
            ('ДВИЖЕНИЕ', 'искусство'), ('ПОСЕТИТЕЛЬ', 'участник')]
    y0 = 270
    for i, (a, b) in enumerate(rows):
        t0 = L[i][0] - 0.15
        y = y0 + i * 132
        reveal(c, f'0{i + 1}', 420, y + 22, 16, t, t0, 'Regular', MUTED, 0.2)
        reveal(c, a, 500, y, 54, t, t0, 'ExtraLight', GRAPHITE, 0.16)
        layer, d = overlay_draw(c)
        k = ease_out((t - t0 - 0.2) / 0.9)
        hline(d, 1230, y + 36, 1230 + 110 * k, INK + (255,))
        blend_layer(c, layer, ramp(t, t0, 0.5))
        reveal(c, b, 1380, y - 2, 56, t, t0 + 0.35, 'Regular', INK, 0.0)


PATENT_START = (700, 1100, 6000, 5200)  # шапка + Fig.1
PATENT_END = (1468, 3150, 4013, 4930)   # Fig.1 крупно, без Fig.2
LEFT_BOX = (120, 150, 1080, 860)
CENTER_BOX = (460, 150, 1460, 850)


def sc_patent(c, t, S):
    L = S['lines']
    T = S['end'] - S['start']
    pg = ASSETS['patent']
    # камера: сверху вниз от шапки к Fig.1
    k = ease(t / (T - 1.5))
    move = ease(ramp(t, T - 1.6, 1.6))
    bx = tuple(lerp(a, b, move) for a, b in zip(LEFT_BOX, CENTER_BOX))
    bw, bh = int(bx[2] - bx[0]), int(bx[3] - bx[1])
    asp = bw / bh
    r0 = aspect_rect(PATENT_START, asp)
    r1 = aspect_rect(PATENT_END, asp)
    r = tuple(lerp(a, b, k) for a, b in zip(r0, r1))
    img = cam(pg, r, (bw, bh))
    place_img(c, img, bx[0], bx[1], ramp(t, 0.1, 1.2))
    la = ramp(t, L[0][0], 1.0) * (1 - ramp(t, T - 1.7, 0.6))
    x = 1180
    label(c, x, 260, 'АРХИВ  ·  1927', ['Джозеф Пилатес.', 'Гимнастический аппарат'],
          ['Патент США № 1 621 477', 'Заявка — 24 августа 1925', 'Выдан — 15 марта 1927',
           'Источник: USPTO'], la, 520, 30)
    a2 = ramp(t, L[1][0], 0.9) * (1 - ramp(t, T - 1.7, 0.6))
    text(c, 'Подвижная каретка, тросы, сопротивление —', x, 560, 21, 'Light', GRAPHITE, 0.01, a2,
         rise=(1 - a2) * 10)
    text(c, 'прообраз современного реформера', x, 592, 21, 'Regular', INK, 0.01, a2, rise=(1 - a2) * 10)


def aspect_rect(r, asp):
    x0, y0, x1, y1 = r
    w, h = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if w / h > asp:
        h = w / asp
    else:
        w = h * asp
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def sc_morph(c, t, S):
    T = S['end'] - S['start']
    pg = ASSETS['patent']
    bx = CENTER_BOX
    bw, bh = bx[2] - bx[0], bx[3] - bx[1]
    r = aspect_rect(PATENT_END, bw / bh)
    fig = cam(pg, r, (bw, bh))
    m = ASSETS['chalk_0438']
    zoom = lerp(1.0, 1.06, ease(t / T))
    mr = fit_rect(m.size, (0.5, 0.52), zoom * 1.12, bw / bh)
    photo = cam(m, mr, (bw, bh))
    k = ease(ramp(t, 1.2, 2.6))
    place_img(c, Image.blend(fig, photo, k), bx[0], bx[1])
    # 1927 ——— сегодня
    a = ramp(t, 0.6, 1.0)
    y = 905
    text(c, '1927', bx[0], y - 50, 24, 'Regular', INK, 0.1, a)
    text(c, 'СЕГОДНЯ', bx[2], y - 48, 16, 'Regular', MUTED, 0.3, ramp(t, 3.0, 1.0), anchor='rt')
    layer, d = overlay_draw(c)
    hline(d, bx[0] + 80, y - 36, bx[0] + 80 + (bw - 220) * ease(ramp(t, 0.9, 3.2)), LINE + (255,))
    blend_layer(c, layer, a)
    la = ramp(t, 3.2, 1.0)
    text(c, 'ECORA M44', bx[2], y - 100, 26, 'Regular', INK, 0.06, la, anchor='rt', rise=(1 - la) * 10)


def sc_detail(c, t, S):
    L = S['lines']
    T = S['end'] - S['start']
    t2 = L[1][0]
    box = (120, 150, 1220, 870)
    bw, bh = box[2] - box[0], box[3] - box[1]
    a_sw = ease(ramp(t, t2 - 0.4, 0.8))
    m1 = ASSETS['chalk_0368']
    r1 = fit_rect(m1.size, (0.55, 0.5), lerp(1.05, 1.22, ease(t / T)), bw / bh)
    i1 = cam(m1, r1, (bw, bh))
    m2 = ASSETS['chalk_0453']
    r2 = fit_rect(m2.size, (0.45, 0.55), lerp(1.08, 1.2, ease((t - t2) / (T - t2 + 0.01))), bw / bh)
    i2 = cam(m2, r2, (bw, bh))
    place_img(c, Image.blend(i1, i2, a_sw) if a_sw > 0 else i1, box[0], box[1], ramp(t, 0, 0.8))
    words = ['Материал.', 'Геометрия.', 'Деталь.']
    l0s, l0e = L[0]
    for i, wd in enumerate(words):
        t0 = l0s + (l0e - l0s) * i / 3 - 0.1
        reveal(c, wd, 1320, 250 + i * 86, 58, t, t0, 'ExtraLight' if i < 2 else 'Light', INK, 0.0)
    a = ramp(t, t2 + 0.3, 1.0)
    label(c, 1320, 590, 'ПРИНЦИП ЭКСПОЗИЦИИ', ['Оборудование', 'как скульптура'],
          ['Свет, воздух, постамент, этикетка.', 'Фото: ECORA M44, исполнение «Мел и графит»'], a, 460, 28)


PLAN_BIG = (1080, 170, 130)


def sc_plan(c, t, S):
    L = S['lines']
    ox, oy, s = PLAN_BIG
    draw_plan(c, ox, oy, s, draw=min(1, max(0, (t - 0.3) / 4.5)), labels_a=ramp(t, S['end'] - 2.4, 0.8))
    x = 120
    reveal(c, 'РОССИЯ.ФИТНЕС 2026', x, 230, 46, t, L[0][0] - 0.2, 'Light', INK, 0.12)
    reveal(c, 'Сколково  ·  12–14 ноября  ·  09:00–18:00', x, 300, 24, t, L[0][0] + 0.6, 'Light', GRAPHITE, 0.02)
    rows = [('25 м²', 'площадь стенда'), ('5 × 5 м', 'план'), ('3 м', 'высота стен'),
            ('2,5 × 2 м', 'П-образная конструкция (ориент.)')]
    for i, (v, n) in enumerate(rows):
        t0 = L[1][0] + i * 0.7 if i < 3 else L[2][0] + 0.3
        y = 400 + i * 92
        reveal(c, v, x, y, 40, t, t0, 'ExtraLight', INK, 0.0)
        reveal(c, n, x + 260, y + 14, 18, t, t0 + 0.2, 'Regular', MUTED, 0.06)
    na = ramp(t, L[2][0] + 1.0, 1.0)
    text(c, 'Схема условная: размеры и ориентация', x, 790, 18, 'Light', MUTED, 0.01, na)
    text(c, 'сверяются с PDF-чертежом стенда.', x, 816, 18, 'Light', MUTED, 0.01, na)


PLAN_SMALL = (150, 330, 76)


def zone_header(c, t, n, title, sub, t0=0.2):
    reveal(c, f'ЗОНА {n}', 600, 146, 16, t, t0, 'Regular', MUTED, 0.3)
    reveal(c, title, 600, 178, 44, t, t0 + 0.15, 'Light', INK, 0.08)
    if sub:
        reveal(c, sub, 600, 244, 21, t, t0 + 0.4, 'Light', GRAPHITE, 0.01)


def small_plan(c, t, zone, path_k=0.0):
    ox, oy, s = PLAN_SMALL
    za = ramp(t, 0.1, 0.8)
    draw_plan(c, ox, oy, s, draw=1, zone=zone, zone_a=za, dims=True, small=True, path_k=path_k)
    text(c, 'СХЕМА СТЕНДА', ox, oy - 44, 14, 'Regular', MUTED, 0.3, 1)


def sc_zone1(c, t, S):
    L = S['lines']
    small_plan(c, t, 1)
    zone_header(c, t, 1, 'КЛАССИКА', 'Монохромная экспозиция оборудования')
    items = [('Реформер', 'ECORA Форма', 'с башней', 300, 112),
             ('Стул', 'для пилатеса', '', 150, 140),
             ('Бочка-', 'лестница', '', 190, 120),
             ('Шпайн-', 'корректор', '', 160, 96),
             ('Аксессуары', '', '', 170, 150)]
    base = 790
    x = 640
    l0s, l0e = L[0]
    for i, (a1, a2, a3, w, h) in enumerate(items):
        t0 = l0s + 1.2 + i * (l0e - l0s - 1.2) / 5
        a = ramp(t, t0, 0.9)
        cx = x + w / 2
        rise = (1 - ease_out((t - t0) / 0.9)) * 18
        plinth(c, cx, base + rise, w, h, a)
        # место экспоната: фото оборудования будет подставлено
        layer, d = overlay_draw(c)
        top = base - h - 150 + rise
        dash_rect(d, cx - w * 0.42, top, cx + w * 0.42, base - h - 18 + rise, LINE + (255,))
        blend_layer(c, layer, a * 0.9)
        text(c, 'экспонат', cx, top + (base - h - 18 - top) / 2 + rise, 14, 'Regular', MUTED, 0.2, a * 0.8, 'mm')
        yy = base + 24
        for j, ln in enumerate([a1, a2, a3]):
            if ln:
                text(c, ln, x, yy, 19, 'Regular' if j == 0 else 'Light', INK if j == 0 else GRAPHITE, 0.0, a)
                yy += 25
        x += w + 40
    # исторические чертежи рядом с оборудованием
    t2 = L[1][0]
    figs = [ASSETS['fig1'], ASSETS['fig3']]
    for i, f in enumerate(figs):
        a = ramp(t, t2 + 0.4 + i * 0.5, 1.0)
        frame_box(c, 1420 + i * 200, 330, 170, 130 if i == 0 else 110, f, a, mat=8)
    text(c, 'Исторические фото и чертежи — рядом', 1420, 486, 17, 'Light', GRAPHITE, 0.0,
         ramp(t, t2 + 1.2, 1.0))
    text(c, 'Фото экспонатов — после утверждения состава', 600, 296, 17, 'Light', MUTED, 0.0,
         ramp(t, l0s + 2, 1))


def dash_rect(d, x0, y0, x1, y1, fill, dash=6):
    for (ax, ay, bx, by) in [(x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)]:
        L = math.hypot(bx - ax, by - ay)
        n = int(L / (dash * 2))
        for i in range(n + 1):
            s0 = i * dash * 2 / L
            s1 = min(1, (i * dash * 2 + dash) / L)
            if s0 >= 1:
                break
            d.line([(lerp(ax, bx, s0), lerp(ay, by, s0)), (lerp(ax, bx, s1), lerp(ay, by, s1))], fill=fill, width=1)


def sc_zone2(c, t, S):
    L = S['lines']
    T = S['end'] - S['start']
    small_plan(c, t, 2)
    zone_header(c, t, 2, 'ИСТОРИЯ · МЕДИА', 'Внутри П-образной конструкции')
    # развёртка: вертикальный экран в центре, рамки слева и справа
    sx, sy, sw, sh = 1120, 300, 270, 480
    a = ramp(t, 0.5, 1.0)
    layer, d = overlay_draw(c)
    d.rectangle((sx - 8, sy - 8, sx + sw + 8, sy + sh + 8), fill=INK + (255,))
    blend_layer(c, layer, a)
    # контент экрана: чертёж → стоящий реформер
    m = ASSETS['chalk_0718']
    f = ASSETS['fig2']
    k = ease(ramp(t, 2.5, 1.5))
    r1 = fit_rect(f.size, (0.5, 0.5), lerp(1.0, 1.1, ease(t / T)), sw / sh)
    r2 = fit_rect(m.size, (0.5, 0.5), lerp(1.0, 1.08, ease(t / T)), sw / sh)
    scr = Image.blend(cam(f, r1, (sw, sh)), cam(m, r2, (sw, sh)), k)
    place_img(c, scr, sx, sy, a)
    text(c, 'ВЕРТИКАЛЬНЫЙ ЭКРАН', sx + sw / 2, sy + sh + 30, 14, 'Regular', MUTED, 0.3, a, 'mt')
    thumbs = [ASSETS['phead'], ASSETS['fig1'], ASSETS['fig3'], ASSETS['chalk_0368'],
              ASSETS['chalk_0438'], ASSETS['chalk_0453']]
    pos = [(640, 330), (840, 330), (640, 500), (1460, 330), (1660, 330), (1460, 500)]
    sizes = [(180, 140), (180, 140), (380, 150), (180, 140), (180, 140), (380, 150)]
    for i, (img, (x, y), (w, h)) in enumerate(zip(thumbs, pos, sizes)):
        ta = ramp(t, L[0][0] + 1.0 + i * 0.45, 0.9)
        frame_box(c, x, y, w, h, img, ta, border=(40, 40, 40), mat=6, bw=6)
    ca = ramp(t, L[0][0] + 3.5, 1)
    text(c, '6–12 ЦИФРОВЫХ ФОТОРАМОК', 640, 690, 14, 'Regular', MUTED, 0.25, ca)
    text(c, 'Количество уточняется.', 640, 716, 17, 'Light', GRAPHITE, 0.0, ca)
    text(c, 'Архив метода, патенты, движение,', 640, 742, 17, 'Light', GRAPHITE, 0.0, ca)
    text(c, 'оборудование ECORA.', 640, 768, 17, 'Light', GRAPHITE, 0.0, ca)


def sc_zone3(c, t, S):
    T = S['end'] - S['start']
    small_plan(c, t, 3)
    zone_header(c, t, 3, 'ИНЖЕНЕРИЯ И ЦВЕТ', 'Современные реформеры · пример: ECORA M44, коллекция исполнений')
    P = ASSETS['presets']
    drift = lerp(14, -14, ease(t / T))
    w, h = 246, 164
    base = 700
    for i, (k, img, name) in enumerate(P):
        t0 = 0.7 + i * 0.45
        a = ramp(t, t0, 1.0)
        cx = 720 + i * 252 + drift
        rise = (1 - ease_out((t - t0) / 1.0)) * 20
        plinth(c, cx, base + rise, 200, 110, a)
        im = img.resize((w, h), Image.LANCZOS)
        place_img(c, im, cx - w / 2, base - 110 - h + 62 + rise, a)
        text(c, f'0{i + 1}', cx - 100, base + 26, 14, 'Regular', MUTED, 0.2, a)
        text(c, name, cx - 100, base + 48, 19, 'Regular', INK, 0.0, a)
    text(c, 'Состав зоны — на согласовании', 600, 830, 17, 'Light', MUTED, 0.0, ramp(t, 3, 1))


def sc_zone4(c, t, S):
    L = S['lines']
    T = S['end'] - S['start']
    small_plan(c, t, 4, path_k=ease(ramp(t, L[0][0] + 2.5, 3.0)))
    zone_header(c, t, 4, 'УЧАСТИЕ', 'Музейные подписи, QR-коды, вход в экспозицию')
    # музейная этикетка с QR
    x, y, w, h = 600, 330, 780, 330
    a = ramp(t, L[0][0] + 0.3, 1.0)
    layer, d = overlay_draw(c)
    d.rectangle((x + 8, y + 10, x + w + 8, y + h + 10), fill=(80, 70, 60, 22))
    d.rectangle((x, y, x + w, y + h), fill=(253, 252, 249, 255), outline=(210, 204, 194, 255))
    blend_layer(c, layer, a)
    label(c, x + 40, y + 44, 'ЭКСПОНАТ  ·  ЗОНА 1', ['Реформер ECORA Форма', 'с башней'],
          ['Линейка FORMA', 'История и характеристики —', 'по QR-коду'], a, 360, 28)
    place_img(c, ASSETS['qr'], x + w - 260, y + 54, a)
    text(c, 'ecorafitness.ru', x + w - 150, y + 288, 15, 'Regular', MUTED, 0.1, a, 'mt')
    text(c, 'Пример этикетки. Ссылка и тексты — на утверждение.', x, y + h + 26, 17, 'Light', MUTED,
         0.0, ramp(t, L[0][0] + 1.5, 1))
    reveal(c, 'Посетитель —', 1440, 360, 34, t, L[0][0] + 3.6, 'Light', INK, 0.0)
    reveal(c, 'участник', 1440, 408, 34, t, L[0][0] + 3.8, 'Regular', INK, 0.0)
    reveal(c, 'не смотрит со стороны,', 1440, 476, 21, t, L[0][0] + 4.0, 'Light', GRAPHITE, 0.0)
    reveal(c, 'а входит в экспозицию', 1440, 506, 21, t, L[0][0] + 4.3, 'Regular', INK, 0.0)


def sc_tasks(c, t, S):
    L = S['lines']
    reveal(c, 'ЧТО НАМ ПРЕДСТОИТ', 120, 160, 46, t, L[0][0] - 0.2, 'Light', INK, 0.12)
    reveal(c, 'К открытию 12 ноября 2026', 120, 228, 22, t, L[0][0] + 0.4, 'Light', GRAPHITE, 0.02)
    items = [('Геометрия', 'сверить схему с PDF-чертежом стенда'),
             ('Экспонаты', 'утвердить состав и расстановку по зонам'),
             ('Архив и права', 'исторические фото, патенты, лицензии'),
             ('Медиа', 'контент для экрана и 6–12 фоторамок'),
             ('Тексты', 'музейные подписи и QR-страницы'),
             ('Производство', 'свет, постаменты, монтаж, логистика')]
    l1s, l1e = L[1]
    l2s, l2e = L[2]
    starts = [l1s + (l1e - l1s) * i / 3 for i in range(3)] + [l2s + (l2e - l2s) * i / 3 for i in range(3)]
    for i, ((a, b), t0) in enumerate(zip(items, starts)):
        col, row = i // 3, i % 3
        x = 120 + col * 860
        y = 340 + row * 160
        layer, d = overlay_draw(c)
        k = ease_out((t - t0) / 1.0)
        hline(d, x, y, x + 740 * k, LINE + (255,))
        blend_layer(c, layer)
        reveal(c, f'0{i + 1}', x, y + 22, 15, t, t0, 'Regular', ACCENT, 0.2)
        reveal(c, a, x + 70, y + 14, 34, t, t0 + 0.1, 'Light', INK, 0.02)
        reveal(c, b, x + 70, y + 66, 21, t, t0 + 0.3, 'Light', GRAPHITE, 0.0)


def sc_final(c, t, S):
    L = S['lines']
    T = S['end'] - S['start']
    a1 = ramp(t, L[0][0] - 0.2, 0.9) * (1 - ramp(t, L[1][0] - 0.6, 0.6))
    text(c, 'НЕ СТЕНД ПРОИЗВОДИТЕЛЯ.', W / 2, H / 2 - 50, 40, 'ExtraLight', GRAPHITE, 0.28, a1, 'mm')
    a1b = ramp(t, L[0][0] + 1.0, 0.8) * (1 - ramp(t, L[1][0] - 0.6, 0.6))
    text(c, 'ЭКСПОЗИЦИЯ.', W / 2, H / 2 + 20, 40, 'Regular', INK, 0.28, a1b, 'mm')
    a2 = ramp(t, L[1][0] - 0.3, 1.4)
    logo = ASSETS['logo_en']
    lw = 560
    lg = logo.resize((lw, int(logo.height * lw / logo.width)), Image.LANCZOS)
    paste(c, lg, W / 2, H / 2 - 80, a2, 'mm')
    layer, d = overlay_draw(c)
    hline(d, W / 2 - 150 * a2, H / 2 + 50, W / 2 + 150 * a2, INK + (255,))
    blend_layer(c, layer)
    text(c, 'ИСКУССТВО ДВИЖЕНИЯ', W / 2, H / 2 + 92, 34, 'Light', GRAPHITE, 0.42, a2, 'mm')
    text(c, 'РОССИЯ.ФИТНЕС 2026  ·  СКОЛКОВО  ·  12–14 НОЯБРЯ', W / 2, H / 2 + 170, 18, 'Regular', MUTED,
         0.25, ramp(t, L[1][0] + 0.8, 1.2), 'mm')


SCENE_FN = {'open': sc_open, 'title': sc_title, 'manifest': sc_manifest, 'patent': sc_patent,
            'morph': sc_morph, 'detail': sc_detail, 'plan': sc_plan, 'zone1': sc_zone1,
            'zone2': sc_zone2, 'zone3': sc_zone3, 'zone4': sc_zone4, 'tasks': sc_tasks,
            'final': sc_final}

TL = None


def render_frame(n):
    scenes = TL
    tg = n / FPS
    c = Image.new('RGBA', (W, H), BG + (255,))
    for S in scenes:
        if S['start'] <= tg < S['end']:
            break
    else:
        S = scenes[-1]
    t = tg - S['start']
    T = S['end'] - S['start']
    lt = dict(S)
    lt['lines'] = [(a - S['start'], b - S['start']) for a, b in S['lines']]
    lt['end'], lt['start'] = T, 0
    content = Image.new('RGBA', (W, H), BG + (255,))
    SCENE_FN[S['name']](content, t, lt)
    if S['name'] != 'open':
        chrome(content, S['name'], 1.0)
    fi = 1.0 if S['name'] in NO_FADE_IN or S['name'] == 'open' else ramp(t, 0, 0.5)
    fo = 1.0 if S['name'] in NO_FADE_OUT else 1 - ramp(t, T - 0.5, 0.5)
    if S['name'] == 'final':
        fo = 1.0
    a = min(fi, fo)
    if a < 1:
        c = Image.blend(c, content, a)
    else:
        c = content
    if S['name'] == 'final':  # в конце — уход в тёмный
        k = ramp(t, T - 1.2, 1.2)
        if k > 0:
            c = Image.blend(c, Image.new('RGBA', (W, H), DARK + (255,)), k)
    return c.convert('RGB').tobytes()


def init():
    load_assets()


if __name__ == '__main__':
    scenes, cues, total = build_timeline()
    TL = scenes
    json.dump({'scenes': scenes, 'cues': cues, 'total': total}, open(HERE + '/timeline.json', 'w'),
              ensure_ascii=False, indent=1)
    print('total', round(total, 2))
    for s in scenes:
        print(f"{s['name']:10s} {s['start']:7.2f} {s['end']:7.2f}")
    mode = sys.argv[1] if len(sys.argv) > 1 else 'stills'
    if mode == 'stills':
        load_assets()
        os.makedirs(HERE + '/stills', exist_ok=True)
        for s in scenes:
            for frac in (0.5, 0.92):
                tg = s['start'] + (s['end'] - s['start']) * frac
                n = int(tg * FPS)
                Image.frombytes('RGB', (W, H), render_frame(n)).save(f"{HERE}/stills/{s['name']}_{int(frac*100)}.jpg", quality=88)
        print('stills ok')
    else:
        nframes = int(math.ceil(total * FPS))
        out = HERE + '/out/video_clean.mp4'
        os.makedirs(HERE + '/out', exist_ok=True)
        ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
                               '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'slow',
                               '-crf', '16', '-pix_fmt', 'yuv420p', '-tune', 'film', out], stdin=subprocess.PIPE)
        with Pool(4, initializer=init) as pool:
            for i, fr in enumerate(pool.imap(render_frame, range(nframes), chunksize=8)):
                ff.stdin.write(fr)
                if i % 250 == 0:
                    print('frame', i, '/', nframes, flush=True)
        ff.stdin.close()
        ff.wait()
        print('video ok', out)
