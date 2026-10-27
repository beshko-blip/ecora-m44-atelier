// Мини-схема зоны: главный кадр 480 px, выбранная зона — её текущим цветом
// с сохранением светлоты исходника, остальное — светло-серый силуэт.
// Источник: assets/photos/<id>/480.webp + assets/masks/<id>/480_zones.webp (R — обивка, G — кант, B — рама).
const CH = { main: 0, contrast: 1, frame: 2 };
const lin = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const LUT = new Uint8ClampedArray(4096);
for (let i = 0; i < 4096; i++) { const v = i / 4095; LUT[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)); }
const enc = v => LUT[Math.max(0, Math.min(4095, (v * 4095) | 0))];

let src = null;

function img(url) {
  return new Promise((ok, fail) => { const i = new Image(); i.decoding = 'async'; i.onload = () => ok(i); i.onerror = fail; i.src = url; });
}

export function loadScheme(base, id) {
  if (src) return src;
  src = Promise.all([img(`${base}assets/photos/${id}/480.webp`), img(`${base}assets/masks/${id}/480_zones.webp`)]).then(([p, z]) => {
    const w = p.naturalWidth, h = p.naturalHeight, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(p, 0, 0); const pd = x.getImageData(0, 0, w, h).data;
    x.clearRect(0, 0, w, h); x.drawImage(z, 0, 0, w, h); const zd = x.getImageData(0, 0, w, h).data;
    const n = w * h, Y = new Float32Array(n), fade = new Uint8ClampedArray(n);
    const sum = [0, 0, 0], wsum = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const r = lin(pd[i * 4] / 255), g = lin(pd[i * 4 + 1] / 255), b = lin(pd[i * 4 + 2] / 255);
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; Y[i] = y;
      // приглушённый силуэт: светлота исходника, сжатая к белому
      fade[i] = 255 - (255 - enc(y)) * 0.32;
      for (let k = 0; k < 3; k++) { const m = zd[i * 4 + k] / 255; if (m > 0.5) { sum[k] += y * m; wsum[k] += m; } }
    }
    // рамка вокруг реформера: белые поля кадра схеме не нужны
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      if (Y[yy * w + xx] < 0.6) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
    }
    const pad = 6;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    if (x1 <= x0 || y1 <= y0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
    const work = document.createElement('canvas'); work.width = w; work.height = h;
    return { w, h, Y, fade, zd, work, crop: [x0, y0, x1 - x0 + 1, y1 - y0 + 1], mean: sum.map((s, k) => s / Math.max(1, wsum[k])) };
  });
  src.catch(() => { src = null; });
  return src;
}

export function paintScheme(canvas, s, zone, hex) {
  const k = CH[zone];
  if (k == null || !s) return;
  const [cx, cy, cw, ch] = s.crop;
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const x = s.work.getContext('2d');
  const out = x.createImageData(s.w, s.h), o = out.data;
  const t = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const mean = s.mean[k] || 0.05;
  for (let i = 0, n = s.w * s.h; i < n; i++) {
    const f = s.fade[i], m = s.zd[i * 4 + k] / 255;
    if (m < 0.02) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = f; o[i * 4 + 3] = 255; continue; }
    const l = Math.min(2.2, (s.Y[i] / mean) ** 0.85);
    for (let c = 0; c < 3; c++) o[i * 4 + c] = f + (enc(t[c] * l) - f) * m;
    o[i * 4 + 3] = 255;
  }
  x.putImageData(out, 0, 0);
  canvas.getContext('2d').drawImage(s.work, cx, cy, cw, ch, 0, 0, cw, ch);
}
