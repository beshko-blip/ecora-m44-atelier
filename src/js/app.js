// ECORA M44 Digital Atelier — приложение.
import { createRenderer, loadFrameLayers, zoneParams } from './renderer.js?v=20261029-mobile-r2';
import { BASE, loadAll, encodeId, decodeId, validState, findSwatch, FAMILY_ORDER } from './data.js?v=20261029-mobile-r2';
import { initBridge, on, post, track, inFrame } from './bridge.js?v=20261029-mobile-r2';
import { buildCard, logoImage } from './card.js?v=20261029-mobile-r2';
import { loadScheme, paintScheme } from './scheme.js?v=20261029-mobile-r2';
import { loadLibrary, findShot, pickSrc } from './library.js?v=20261029-mobile-r2';

const LOGO_VIEWBOX = '150 248 296 126';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = typo(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const typo = s => String(s).replace(/(^|[\s(])((?:в|во|на|к|ко|с|со|у|о|об|от|до|по|из|за|и|а|не)) /gi, '$1$2\u00a0').replace(/(\d) (кг|см|мм|₽|м²|дней)/g,'$1\u00a0$2');
const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k] ?? '');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* без хранилища тоже работаем */ } },
};

let D, C, S, R, TR, view, stageTier, zoomTier = null;
const layers = new Map();      // `${id}@${tier}` -> Promise<layers>
const hitData = new Map();     // id -> {w,h,data}
let scheme = null;            // данные мини-схемы (кадр 480 + маска зон)
const sheetState = 'min'; // compatibility for the desktop summary
function cycleSheet() {}
let personalized = false, renderQueued = false, thumbTimer = 0, saveTimer = 0;
const zoom = { s: 1, x: 0, y: 0 };

const isMobile = () => window.matchMedia('(max-width: 1023px)').matches;

async function boot() {
  D = await loadAll();
  C = D.copy;
  initBridge(D.site);
  document.title = C.meta.title;
  $('meta[name=description]')?.setAttribute('content', C.meta.description);
  const fromUrl = decodeId(D, new URLSearchParams(location.search).get('c'));
  const saved = validState(D, store.get(D.site.storageKey));
  S = { ...(fromUrl || saved || D.site.defaultConfig) };
  view = D.site.heroFrame;
  $('#app').replaceChildren();
  buildUI();
  const stageCanvas = $('#stage-canvas');
  // Keep the photographic overlay aligned when the canvas is fitted to a wide, short iframe.
  if (window.ResizeObserver) new ResizeObserver(placeShot).observe(stageCanvas);
  const r = createRenderer(stageCanvas); R = r.r;
  document.documentElement.dataset.renderer = r.kind;
  TR = createRenderer(document.createElement('canvas')).r;
  stageTier = pickTier();
  await showView(view);
  loadLibrary(BASE).then(updateShot).catch(e => console.warn('Photo library unavailable; using the live renderer', e));
  loadScheme(BASE, D.site.heroFrame).then(s => { scheme = s; paintSchemes(); }).catch(e => console.warn(e));
  document.documentElement.classList.add('ready');
  track('atelier_open', { config_id: encodeId(D, S), renderer: r.kind, embedded: inFrame });
  scheduleThumbs(0);
  // предзагрузка остальных кадров в фоне
  // Thumbnails load sequentially below; do not start a second competing preload.
  window.addEventListener('resize', () => { const t = pickTier(); if (t !== stageTier) { stageTier = t; showView(view); } else { placeShot(); updateShot(); } });
  matchMedia('(max-width: 1023px)').addEventListener('change', placePresets);
  on('lead-submitted', () => { track('lead_submit', { config_id: encodeId(D, S) }); openResult('submitted'); });
  on('lead-error', () => track('lead_submit_error', {}));
}

const pickTier = () => {
  const w = ($('.stage')?.clientWidth || 800) * Math.min(window.devicePixelRatio || 1, 2);
  return !isMobile() && w > 1350 ? 2400 : 1280;
};

function getLayers(id, tier) {
  const k = `${id}@${tier}`;
  if (!layers.has(k)) {
    const p = loadFrameLayers(BASE, id, tier);
    p.catch(() => layers.delete(k));
    layers.set(k, p);
  }
  return layers.get(k);
}

function zoneSetup(id) {
  const fr = D.frameById.get(id), coll = D.collections.find(c => c.id === S.collection);
  const up = D.materials[coll.profile || 'upholstery'];
  const out = {};
  const z = fr.zones;
  const m = coll.byId.get(S.main), c = coll.byId.get(S.contrast);
  if (z.main && m) out.main = { ...zoneParams(m.hex, up), Yref: z.main.Yref };
  if (z.contrast && c) out.contrast = { ...zoneParams(c.hex, up), Yref: z.contrast.Yref };
  const f = D.frames.frames.find(x => x.id === S.frame);
  if (z.frame && f && f.mode === 'recolor') out.frame = { ...zoneParams(f.hex, D.materials.frame), Yref: z.frame.Yref };
  return out;
}

async function showView(id) {
  view = id;
  const stage = $('.stage');
  stage.classList.toggle('portrait', !!D.frameById.get(id).portrait);
  stage.setAttribute('aria-busy', 'true');
  $('.stage-retry').hidden = true;
  $('.stage-status').textContent = 'Загружаем изображение…';
  resetZoom();
  updateShot();
  // мгновенно — миниатюра, затем полноценный tier
  try {
    const small = await getLayers(id, 480);
    if (view !== id) return;
    if (!R.cache.has(`${id}@1280`) && !R.cache.has(`${id}@2400`)) R.draw(`${id}@480`, small, zoneSetup(id));
    const big = await getLayers(id, stageTier);
    if (view !== id) return;
    drawStage();
    ensureHit(id, small);
    // освобождаем память GPU от лишних крупных tier других кадров на телефоне
    if (isMobile()) for (const k of [...R.cache.keys()]) if (!k.startsWith(id + '@') && !k.endsWith('@480')) R.drop(k);
  } catch (err) {
    console.error(err); $('.stage-retry').hidden = false;
    $('.stage-status').textContent = 'Фото не загрузилось. Нажмите «Повторить».';
  } finally { if(view===id){stage.setAttribute('aria-busy', 'false'); if ($('.stage-retry').hidden) $('.stage-status').textContent = '';} }
  document.querySelectorAll('.view').forEach(b => b.setAttribute('aria-selected', b.dataset.id === id ? 'true' : 'false'));
}

function currentTier() { return zoomTier && R.cache.has(`${view}@${zoomTier}`) ? zoomTier : stageTier; }

function drawStage() {
  updateShot();
  const drawView = view;
  const k = `${view}@${currentTier()}`;
  const p = layers.get(k);
  if (!p) return;
  p.then(l => { if(view!==drawView)return; const t0 = performance.now(); R.draw(k, l, zoneSetup(drawView)); lastDraw = performance.now() - t0; }).catch(()=>{});
}
let lastDraw = 0;
// Замер для проверки бюджета «< 100 мс»: n перерисовок видимого кадра с ожиданием GPU (readPixels)
window.__atelierBench = async (n = 10) => {
  const k = `${view}@${currentTier()}`, l = await layers.get(k), gl = R.gl, px = new Uint8Array(4), t = [], keep = S.main;
  for (let i = 0; i < n; i++) {
    S.main = D.collections[0].swatches[i % D.collections[0].swatches.length].id;
    const t0 = performance.now(); R.draw(k, l, zoneSetup(view)); if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0);
  }
  S.main = keep; drawStage();
  return { tier: currentTier(), ms: t.map(x => +x.toFixed(1)) };
};

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; drawStage(); });
}

function scheduleThumbs(delay = 160) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(async () => {
    for (const id of D.order) {
      try {
        const l = await getLayers(id, 480);
        TR.draw(`${id}@480`, l, zoneSetup(id));
        const cv = document.querySelector(`.view[data-id="${id}"] canvas`);
        if (!cv) continue;
        if (cv.width !== l.w) { cv.width = l.w; cv.height = l.h; }
        cv.getContext('2d').drawImage(TR.canvas, 0, 0);
      } catch (e) { console.warn(e); }
    }
  }, delay);
}

function ensureHit(id, small) {
  if (hitData.has(id)) return;
  const c = document.createElement('canvas'); c.width = small.w; c.height = small.h;
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(small.zones, 0, 0);
  hitData.set(id, { w: small.w, h: small.h, data: x.getImageData(0, 0, small.w, small.h).data });
}

function zoneAt(clientX, clientY) {
  const h = hitData.get(view); if (!h) return -1;
  const r = $('#stage-canvas').getBoundingClientRect();
  const u = (clientX - r.left) / r.width, v = (clientY - r.top) / r.height;
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return -1;
  const i = (Math.floor(v * h.h) * h.w + Math.floor(u * h.w)) * 4;
  const a = [h.data[i], h.data[i + 1], h.data[i + 2]];
  const m = Math.max(...a);
  return m > 110 ? a.indexOf(m) : -1;
}

// ---------- состояние ----------
function setState(patch, event, props = {}) {
  const prev = { ...S };
  Object.assign(S, patch);
  if (!validState(D, S)) { S = prev; return; }
  if (!personalized) { personalized = true; track('personalize_start', { first: event }); }
  if (event) track(event, { ...props, config_id: encodeId(D, S) });
  updateShot(); render(); scheduleThumbs(); syncUI();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 250);
}

function persist() {
  store.set(D.site.storageKey, S);
  const u = new URL(location.href); u.searchParams.set('c', encodeId(D, S));
  try { history.replaceState(null, '', u); } catch { /* в некоторых iframe запрещено */ }
  post('config', { config_id: encodeId(D, S) });
}

function configUrl() {
  const base = D.site.publicUrl || (location.origin + location.pathname);
  const u = new URL(base); u.searchParams.set('c', encodeId(D, S));
  return u.toString();
}

function describe() {
  const coll = D.collections.find(c => c.id === S.collection);
  const m = coll.byId.get(S.main), c = coll.byId.get(S.contrast);
  const fr = D.frames.frames.find(x => x.id === S.frame), ro = D.frames.ropes.find(x => x.id === S.rope);
  const sw = s => `${C.palette.number} ${String(s.n).padStart(2, '0')}${s.name ? ' · ' + s.name : ''}`;
  return {
    coll: C.material[coll.id] || coll.displayName,
    main: sw(m), contrast: sw(c), mainHex: m.hex, contrastHex: c.hex,
    frame: `${C.frames[fr.id]} ${C.frames.suffix}`, rope: C.ropes[ro.id],
    m, c, fr, ro,
  };
}

function configText() {
  const d = describe(), id = encodeId(D, S);
  const sw = s => `№ ${String(s.n).padStart(2, '0')} (${[s.np, s.name !== s.np ? s.name : null, s.hex].filter(Boolean).join(', ')})`;
  return [
    C.lead.textHeader, `ID: ${id}`,
    `${C.card.collection}: ${d.coll}`,
    `${C.card.main}: ${sw(d.m)}`, `${C.card.contrast}: ${sw(d.c)}`,
    `${C.card.frame}: ${d.frame}`, `${C.card.rope}: ${d.rope}`,
    `${C.lead.price}: ${D.site.price.custom.toLocaleString('ru-RU').replace(/ /g, ' ')} ₽`,
    `${C.lead.link}: ${configUrl()}`,
  ].join('\n');
}

// ---------- UI ----------
async function inlineLogo(target) {
  try {
    const txt = await (await fetch(BASE + 'brand/RGB_base%20eng.svg')).text();
    const doc = new DOMParser().parseFromString(txt, 'image/svg+xml').documentElement;
    doc.setAttribute('viewBox', LOGO_VIEWBOX); doc.removeAttribute('id');
    doc.setAttribute('role', 'img'); doc.setAttribute('aria-label', C.a11y.logo);
    target.append(doc);
  } catch (e) { target.textContent = 'ECORA'; }
}

function swatchBtn(sw, kind) {
  return el('button', {
    class: 'sw', type: 'button', 'data-id': sw.id, 'data-kind': kind,
    'aria-label': fmt(C.a11y.swatch, { n: sw.n, name: sw.name }), 'aria-pressed': 'false',
    onclick: () => setState({ [kind]: sw.id }, kind === 'main' ? 'main_color_change' : 'contrast_color_change', { swatch: sw.id }),
  }, el('span', { class: 'dot', style: `--c:${sw.hex}` }), el('span', { class: 'num', text: String(sw.n).padStart(2, '0') }));
}

function paletteBlock(kind) {
  const coll = D.collections.find(c => c.id === S.collection);
  const groups = FAMILY_ORDER.map(f => [f, coll.swatches.filter(s => s.family === f)]).filter(([, l]) => l.length);
  const search=el('input',{type:'search',class:'palette-search',placeholder:'Номер или цвет','aria-label':'Найти оттенок'});
  const filter=el('select',{'aria-label':'Группа оттенков'},el('option',{value:'all',text:'Все цвета'}),groups.map(([f])=>el('option',{value:f,text:C.families[f]})));
  const empty=el('p',{class:'palette-empty',hidden:true,text:'Оттенок не найден. Попробуйте другой номер или цвет.'});
  const block=el('div', { class: 'palette' },
    el('div',{class:'palette-tools'},search,filter),
    groups.map(([f, list]) => el('div', { class: 'fam' },
      el('div', { class: 'fam-name', text: C.families[f] }),
      el('div', { class: 'sw-grid' }, list.sort((a, b) => a.n - b.n).map(s => swatchBtn(s, kind))))),
    empty,el('p', { class: 'disclaimer', text: C.palette.disclaimer }));
  const apply=()=>{
    const q=search.value.toLocaleLowerCase('ru').trim().replace(/^№\s*/,'');
    let count=0;
    block.querySelectorAll('.fam').forEach((group,i)=>{
      let visible=0;
      group.querySelectorAll('.sw').forEach(b=>{
        const sw=coll.byId.get(b.dataset.id);
        const matchNumber=/^\d+$/.test(q)?sw.n===Number(q):true;
        const matchText=/^\d+$/.test(q)||!q||(sw.name+' '+sw.np).toLocaleLowerCase('ru').includes(q);
        b.hidden=!(matchNumber&&matchText&&(filter.value==='all'||filter.value===groups[i][0]));
        if(!b.hidden)visible++;
      });
      group.hidden=!visible;count+=visible;
    });
    empty.hidden=!!count;
  };
  search.addEventListener('input',apply);filter.addEventListener('change',apply);
  return block;
}

// «Сейчас выбираете»: мини-схема зоны + имя зоны + текущий образец + сноска с деталями. Липкий внутри шага.
function nowBlock(kind) {
  return el('div', { class: 'now', 'data-now': kind },
    el('canvas', { class: 'scheme', width: 480, height: 320, role: 'img', 'data-scheme': kind }),
    el('div', { class: 'now-text' },
      el('span', { class: 'now-label', text: C.zones.now }),
      el('span', { class: 'now-line' },
        el('span', { class: 'now-zone', text: C.zones[kind] }),
        el('span', { class: 'now-val' }, el('span', { class: 'now-dot', 'aria-hidden': 'true' }), el('span', { class: 'now-sw' }))),
      el('span', { class: 'now-parts', text: C.zones[kind + 'Parts'] })));
}

function zoneValue(kind, d = describe()) {
  if (kind === 'main') return { text: d.main, hex: d.mainHex };
  if (kind === 'contrast') return { text: d.contrast, hex: d.contrastHex };
  if (kind === 'frame') return { text: d.frame, hex: d.fr.hex };
  return { text: d.rope, hex: d.ro.hex };
}

function paintSchemes() {
  if (!scheme) return;
  const d = describe();
  document.querySelectorAll('.step.open canvas[data-scheme]').forEach(cv => {
    const k = cv.dataset.scheme, v = zoneValue(k, d);
    paintScheme(cv, scheme, k, v.hex);
    cv.setAttribute('aria-label', fmt(C.zones.scheme, { zone: C.zones[k], value: v.text }));
  });
}

function step(no, key, title, body) {
  const hint = ['main', 'contrast', 'frame'].includes(key) ? nowBlock(key) : null;
  const id = `step-${key}`;
  return el('section', { class: 'step', 'data-step': key },
    el('h2', {},
      el('button', { class: 'step-head', type: 'button', 'aria-expanded': 'false', 'aria-controls': id, onclick: () => openStep(key, true) },
        el('span', { class: 'step-no', text: no }), el('span', { class: 'step-title', text: title }),
        el('span', { class: 'step-val', 'data-val': key }))),
    el('div', { class: 'step-body', id, hidden: true }, hint, body));
}

function openStep(key, toggle = false) {
  if (isMobile()) { selectMobilePanel(key); return; }
  document.querySelectorAll('.step').forEach(s => {
    const open = s.dataset.step === key ? (toggle ? !s.classList.contains('open') : true) : false;
    s.classList.toggle('open', open);
    $('.step-head', s).setAttribute('aria-expanded', String(open));
    $('.step-body', s).hidden = !open;
    if (open && (key === 'main' || key === 'contrast')) track('palette_open', { step: key });
  });
  paintSchemes();
  const opening = isMobile() && sheetState === 'min';
  if (opening) setSheet('half');
  const s = document.querySelector(`.step[data-step="${key}"]`);
  if (s?.classList.contains('open')) setTimeout(() => {
    const box = $('.panel-scroll');
    const smooth = !opening && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    box.scrollTo({ top: s.offsetTop - box.offsetTop, behavior: smooth ? 'smooth' : 'auto' });
  }, opening ? 360 : 30);
}

function buildUI() {
  const app = $('#app');
  const coll = D.collections.find(c => c.id === S.collection);

  const views = el('div', { class: 'views', role: 'tablist', 'aria-label': C.views.label },
    D.order.map(id => el('button', {
      class: 'view', role: 'tab', type: 'button', 'data-id': id, 'aria-selected': 'false',
      'aria-label': fmt(C.a11y.view, { name: C.views[id] || id }), title: C.views[id] || id,
      onclick: () => { if (id !== view) { track('view_switch', { view: id }); showView(id); } },
    }, el('canvas', { width: 48, height: 32 }), el('span', {class:'view-label',text: ({'0350':'Общий вид','0438':'Профиль','0453':'Ракурс ¾','0368':'Обивка','0718':'Сложение'})[id] || C.views[id]}))));

  const stage = el('div', { class: 'stage', tabindex: '0', role: 'group', 'aria-label': C.a11y.stage },
    el('div', { class: 'zoomer' }, el('canvas', { id: 'stage-canvas' }), el('img', { class: 'shot', alt: '', 'aria-hidden': 'true', decoding: 'async', hidden: true })),
    el('button', { class: 'zoom-out', type: 'button', hidden: true, text: C.stage.zoomOut, onclick: () => resetZoom(true) }),
    el('span', { class: 'stage-note', hidden: true, text: C.ropes.stageNote }),
    el('span', {class:'stage-status', role:'status', 'aria-live':'polite'}),
    el('button', {class:'stage-retry', type:'button',hidden:true,text:'Повторить',onclick:()=>showView(view)}),
    el('button', {class:'zoom-in',type:'button','aria-label':'Увеличить фото',onclick:e=>{e.stopPropagation();const r=stage.getBoundingClientRect();toggleZoom(r.left+r.width/2,r.top+r.height/2);}}, el('span',{class:'zoom-icon','aria-hidden':'true'})),
    el('span', { class: 'zoom-hint', text: matchMedia('(hover: hover) and (pointer: fine)').matches ? C.stage.zoomHintDesktop : C.stage.zoomHint }));

  const presets = el('section', { class: 'presets', 'aria-labelledby': 'presets-title' },
    el('h2', { class: 'presets-title', id: 'presets-title', text: C.presets.title }),
    el('p', { class: 'presets-sub', text: C.presets.sub }),
    el('div', { class: 'preset-list' }, D.presets.filter(p => findSwatch(D, p.main) && findSwatch(D, p.contrast)).map(p => {
      const m = findSwatch(D, p.main).sw, c = findSwatch(D, p.contrast).sw;
      const no = s => `${C.palette.number} ${String(s.n).padStart(2, '0')}`;
      return el('button', {
        class: 'preset', type: 'button', 'data-preset': p.id, 'aria-pressed': 'false',
        onclick: () => setState({ collection: p.collection, main: p.main, contrast: p.contrast, frame: p.frame, rope: p.rope }, 'preset_select', { preset: p.id }),
      }, el('span', { class: 'duo', 'aria-hidden': 'true', style: `--a:${m.hex};--b:${c.hex}` }),
         el('span', { class: 'preset-text' },
           el('span', { class: 'preset-name', text: C.presets[p.id] || p.id }),
           el('span', { class: 'preset-meta', text: `${no(m)} + ${no(c)} · ${C.presets.frame} ${(C.frames[p.frame + 'Adj'] || C.frames[p.frame]).toLowerCase()}` }),
           C.presets[p.id + 'Note'] ? el('span', { class: 'preset-note', text: C.presets[p.id + 'Note'] }) : null));
    })));

  const material = el('div', { class: 'opts' }, D.collections.map(cl => el('button', {
    class: 'opt', type: 'button', 'data-coll': cl.id, 'aria-pressed': 'false',
    onclick: () => {
      if (cl.id !== S.collection) {
        const [a, b] = [cl.swatches[0].id, cl.swatches[1]?.id || cl.swatches[0].id];
        setState({ collection: cl.id, main: a, contrast: b }, 'material_select', { collection: cl.id });
        rebuildPalettes();
      } else track('material_select', { collection: cl.id });
    },
  }, el('span', { class: 'opt-title', text: C.material[cl.id] || cl.displayName }),
     C.material[cl.id + 'Note'] ? el('span', { class: 'opt-note', text: C.material[cl.id + 'Note'] }) : null)));

  const frameOpts = el('div', { class: 'chips' }, D.frames.frames.filter(f => !f.hidden).map(f => el('button', {
    class: 'chip', type: 'button', 'data-frame': f.id, 'aria-pressed': 'false',
    onclick: () => setState({ frame: f.id }, 'frame_change', { frame: f.id }),
  }, el('span', { class: 'chip-dot metal', style: `--c:${f.hex}` }), el('span', { text: `${C.frames[f.id]}` }))));

  const ropeOpts = el('div', {},
    el('div', { class: 'chips' }, D.frames.ropes.filter(r => !r.hidden).map(r => el('button', {
      class: 'chip', type: 'button', 'data-rope': r.id, 'aria-pressed': 'false',
      onclick: () => setState({ rope: r.id }, 'rope_change', { rope: r.id }),
    }, el('span', { class: 'chip-dot', style: `--c:${r.hex}` }), el('span', { text: C.ropes[r.id] })))),
    el('p', { class: 'hint soft rope-note', hidden: true, text: C.ropes.previewNote }));

  const steps = el('div', { class: 'steps' },
    step('01', 'material', C.steps.s01, material),
    step('02', 'main', C.steps.s02, el('div', { 'data-palette': 'main' }, paletteBlock('main'))),
    step('03', 'contrast', C.steps.s03, el('div', { 'data-palette': 'contrast' }, paletteBlock('contrast'))),
    step('04', 'frame', C.steps.s04, frameOpts),
    step('05', 'rope', C.steps.s05, el('div', {}, el('p', { class: 'hint', text: C.steps.s05hint }), ropeOpts)));

  const foot = el('div', { class: 'panel-foot' },
    el('div', { class: 'foot-row' },
      el('span', { class: 'cfg-id', 'aria-label': C.actions.configId }),
      el('button', { class: 'share', type: 'button', onclick: share },
        el('span', { 'aria-hidden': 'true', class: 'share-ico' }), el('span', { text: C.actions.share }))),
    el('button', { class: 'cta', type: 'button', onclick: cta }, el('span', { text: C.actions.cta }), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' })));

  const handle = el('button', { class: 'sheet-handle', type: 'button', 'aria-label': C.actions.sheetLabelOpen, 'aria-expanded': 'false', onclick: cycleSheet },
    el('span', { class: 'grip', 'aria-hidden': 'true' }), el('span', { class: 'sheet-summary' }));

  const panel = el('aside', { class: 'panel', 'data-sheet': 'min' }, handle,
    el('div', { class: 'panel-scroll' }, el('div', { class: 'presets-slot' }), steps), foot);

  app.append(
    el('header', { class: 'top' }, el('h1',{class:'mobile-heading',text:'Создайте свой M44'}), el('button',{class:'mobile-share',type:'button','aria-label':'Поделиться конфигурацией',onclick:share},el('span',{class:'share-ico','aria-hidden':'true'}))),
    el('main', { class: 'main' },
      el('section', { class: 'intro' },
        el('h1', { text: C.hero.title }), el('p', { class: 'lead', text: C.hero.lead }), el('p', { class: 'sub', text: C.hero.sub })),
      el('section', { class: 'gallery' }, stage, views),
      el('div', { class: 'presets-home' }, presets)),
    panel);
  document.body.append(
    el('div', { class: 'result', id: 'result', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'result-title' }),
    el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }));
  bindStage(stage);
  placePresets();
  new ResizeObserver(placeShot).observe($('#stage-canvas'));
  buildMobileNavigation(panel);
  syncUI();
}


// Mobile: one stable preview, direct section tabs and one scrollable choices region.
let mobilePanel = 'presets';
const mobileSections = [['presets','Сочетания'],['material','Материал'],['main','Обивка'],['contrast','Кант'],['frame','Рама'],['rope','Тросы']];
function buildMobileNavigation(panel) {
  const nav=el('div',{class:'mobile-nav',role:'tablist','aria-label':'Настройки реформера'});
  for(const [key,label] of mobileSections) nav.append(el('button',{
    class:'mobile-tab',id:'mobile-tab-'+key,type:'button',role:'tab','data-mobile-panel':key,
    'aria-controls':'mobile-panel-'+key,'aria-selected':'false',tabindex:'-1',
    onclick:()=>selectMobilePanel(key)
  },el('span',{text:label})));
  nav.addEventListener('keydown',e=>{
    const keys=mobileSections.map(s=>s[0]),i=keys.indexOf(mobilePanel);
    let n=i;
    if(e.key==='ArrowRight')n=(i+1)%6;
    else if(e.key==='ArrowLeft')n=(i+5)%6;
    else if(e.key==='ArrowDown')n=(i+3)%6;
    else if(e.key==='ArrowUp')n=(i+3)%6;
    else if(e.key==='Home')n=0;
    else if(e.key==='End')n=5;else return;
    e.preventDefault();selectMobilePanel(keys[n]);nav.children[n].focus();
  });
  panel.insertBefore(nav,$('.panel-scroll'));
  placePresets();
}
function selectMobilePanel(key) {
  mobilePanel=key;
  if(!isMobile())return;
  for(const [k] of mobileSections){
    const item=k==='presets'?$('.presets'):$('.step[data-step="'+k+'"]');
    item.id='mobile-panel-'+k;item.hidden=k!==key;
    item.setAttribute('role','tabpanel');item.setAttribute('aria-labelledby','mobile-tab-'+k);
    const tab=$('[data-mobile-panel="'+k+'"]');
    tab.setAttribute('aria-selected',String(k===key));tab.tabIndex=k===key?0:-1;
    if(k!=='presets'){
      item.classList.toggle('open',k===key);
      $('.step-body',item).hidden=k!==key;
      $('.step-head',item).setAttribute('aria-expanded',String(k===key));
    }
  }
  $('.panel-scroll').scrollTop=0;
  paintSchemes();
  if(key==='main'||key==='contrast')track('palette_open',{step:key});
}
function placePresets(){
  const p=$('.presets'),to=$('.presets-slot');
  if(p&&to&&p.parentElement!==to)to.append(p);
  if(!$('.mobile-nav'))return;
  delete document.body.dataset.sheet;document.body.classList.remove('sheet-open');
  if(isMobile())selectMobilePanel(mobilePanel);
  else {
   document.querySelectorAll('.palette-search').forEach(input=>{input.value='';});
   document.querySelectorAll('.palette-tools select').forEach(select=>{select.value='all';select.dispatchEvent(new Event('change'));});
   for(const [key] of mobileSections){
    const item=key==='presets'?p:$('.step[data-step="'+key+'"]');
    item.hidden=false;item.removeAttribute('role');item.removeAttribute('aria-labelledby');
   }
  }
}

// ---------- гибрид: готовое изображение из библиотеки или живая перекраска ----------
let shotKey = '', shotPending = '';
const shotBad = new Set();   // файлы, которых нет: не запрашиваем повторно
function placeShot() {
  const cv = $('#stage-canvas'), img = $('.shot'); if (!cv || !img) return;
  Object.assign(img.style, { left: cv.offsetLeft + 'px', top: cv.offsetTop + 'px', width: cv.offsetWidth + 'px', height: cv.offsetHeight + 'px' });
}
function updateShot() {
  const img = $('.shot'); if (!img) return;
  const shot = findShot(D, S, view);
  const need = ($('.stage').clientWidth || 800) * Math.min(window.devicePixelRatio || 1, 2) * (zoom.s > 1.2 ? 2 : 1);
  let src = shot && pickSrc(BASE, shot, need);
  if (src && shotBad.has(src.url)) src = null;
  const key = src ? `${encodeId(D, S)}@${view}` : '';
  if (!src) { shotKey = ''; shotPending = ''; delete img.dataset.w; img.hidden = true; img.removeAttribute('src'); $('.stage').classList.remove('library'); return; }
  if (key === shotKey && (shotPending === src.url || (img.dataset.w && +img.dataset.w >= src.w))) return;
  // пока грузится — виден живой рендер той же конфигурации; другое изображение не показываем
  if (key !== shotKey) { delete img.dataset.w; img.hidden = true; $('.stage').classList.remove('library'); }
  shotKey = key;
  shotPending = src.url;
  const off = () => { shotBad.add(src.url); shotPending = ''; if (shotKey === key) { shotKey = ''; img.hidden = true; $('.stage').classList.remove('library'); } };
  // живой рендер той же конфигурации остаётся под фото — пустого кадра не бывает
  const pre = new Image();
  pre.onload = () => {
    if (shotKey !== key) return;
    img.onload = () => { if (shotKey === key) { img.hidden = false; placeShot(); $('.stage').classList.add('library'); } };
    img.onerror = off;
    if (img.getAttribute('src') === src.url) img.removeAttribute('src');
    img.dataset.w = src.w; img.src = src.url; shotPending = '';
  };
  pre.onerror = off;
  pre.src = src.url;
}

function rebuildPalettes() {
  for (const k of ['main', 'contrast']) { const h = document.querySelector(`[data-palette="${k}"]`); h.replaceChildren(paletteBlock(k)); }
  syncUI();
}

function syncUI() {
  const d = describe();
  document.querySelectorAll('.sw').forEach(b => {
    const on = b.dataset.id === S[b.dataset.kind];
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', fmt(C.a11y.swatch, { n: +b.dataset.id.slice(1), name: findSwatch(D, b.dataset.id)?.sw.name || '' }) + (on ? ', ' + C.a11y.selected : ''));
  });
  document.querySelectorAll('[data-now]').forEach(n => {
    const v = zoneValue(n.dataset.now, d);
    $('.now-dot', n).style.setProperty('--c', v.hex);
    $('.now-dot', n).classList.toggle('metal', n.dataset.now === 'frame');
    $('.now-sw', n).textContent = v.text;
  });
  paintSchemes();
  const vals = { material: d.coll, main: d.main, contrast: d.contrast, frame: d.frame, rope: d.rope };
  for (const [k, v] of Object.entries(vals)) { const n = document.querySelector(`[data-val="${k}"]`); if (n) n.textContent = v; }
  const dots = { main: d.mainHex, contrast: d.contrastHex };
  for (const [k, hex] of Object.entries(dots)) document.querySelector(`[data-val="${k}"]`)?.style.setProperty('--c', hex);
  document.querySelectorAll('[data-coll]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.coll === S.collection)));
  document.querySelectorAll('[data-frame]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.frame === S.frame)));
  document.querySelectorAll('[data-rope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rope === S.rope)));
  // опция без фото: выбирается и идёт в заявку, на снимке исходный вариант — говорим об этом прямо
  const noPreview = d.ro.preview === false;
  document.querySelectorAll('.rope-note, .stage-note').forEach(n => { n.hidden = !noPreview; });
  document.querySelectorAll('[data-preset]').forEach(b => {
    const p = D.presets.find(x => x.id === b.dataset.preset);
    b.setAttribute('aria-pressed', String(p.main === S.main && p.contrast === S.contrast && p.frame === S.frame && p.rope === S.rope));
  });
  $('.cfg-id').textContent = encodeId(D, S);
  const sum = $('.sheet-summary');
  const no = s => `${C.palette.number} ${String(s.n).padStart(2, '0')}`;
  if (sum) sum.replaceChildren(
    el('span', { class: 'sum-dots', 'aria-hidden': 'true' },
      el('span', { class: 'mini-dot', style: `--c:${d.mainHex}` }), el('span', { class: 'mini-dot', style: `--c:${d.contrastHex}` }),
      el('span', { class: 'mini-dot metal', style: `--c:${d.fr.hex}` })),
    el('span', { class: 'sum-text' },
      el('span', {}, el('b', { text: C.zones.mainShort }), ' ' + no(d.m)),
      el('span', {}, el('b', { text: C.zones.contrastShort }), ' ' + no(d.c))),
    el('span', { class: 'sheet-cta', 'data-dir': sheetState === 'full' ? 'down' : 'up', text: { min: C.actions.sheetOpen, half: C.actions.sheetExpand, full: C.actions.sheetClose }[sheetState] }));
}

// ---------- сцена: тап по зоне, подсветка, зум ----------
const ZONE_STEP = ['main', 'contrast', 'frame'];
function bindStage(stage) {
  const zoomer = $('.zoomer', stage);
  const pts = new Map();
  let start = null, pinch = null, lastTap = 0, tapTimer = 0;

  stage.addEventListener('pointermove', e => {
    if (e.pointerType === 'mouse' && !pts.size && matchMedia('(hover: hover)').matches) {
      // только курсор-«рука»: подсветка контура на фото выглядела как дефект маски
      stage.classList.toggle('hot', zoneAt(e.clientX, e.clientY) >= 0);
    }
  });
  stage.addEventListener('pointerleave', () => stage.classList.remove('hot'));

  stage.addEventListener('pointerdown', e => {
    if(e.target.closest('button'))return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    if (pts.size === 1) start = { x: e.clientX, y: e.clientY, t: performance.now(), zx: zoom.x, zy: zoom.y, moved: false };
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: zoom.s, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zx: zoom.x, zy: zoom.y };
    }
  });
  stage.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt(pinch.cx, pinch.cy, Math.max(1, Math.min(4, pinch.s * d / pinch.d)), pinch);
      return;
    }
    if (start && pts.size === 1) {
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > 6) start.moved = true;
      if (zoom.s > 1 && start.moved) { zoom.x = start.zx + dx; zoom.y = start.zy + dy; applyZoom(); }
    }
  });
  const end = e => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!start || pts.size) return;
    const tap = !start.moved && performance.now() - start.t < 350;
    const { x, y } = start; start = null;
    if (!tap) return;
    const now = performance.now();
    if (now - lastTap < 300) { clearTimeout(tapTimer); lastTap = 0; toggleZoom(x, y); return; }
    lastTap = now;
    const z = zoneAt(x, y);
    if (z < 0) return;
    tapTimer = setTimeout(() => { track('zone_tap', { zone: ZONE_STEP[z], view }); openStep(ZONE_STEP[z]); }, e.pointerType === 'mouse' ? 0 : 260);
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', e => { pts.delete(e.pointerId); pinch = null; start = null; });
  stage.addEventListener('dblclick', e => e.preventDefault());
  stage.addEventListener('wheel', e => {
    if (!e.ctrlKey && zoom.s === 1) return;
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.max(1, Math.min(4, zoom.s * Math.exp(-e.deltaY * 0.004))));
  }, { passive: false });
  stage.addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') { const r = stage.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, Math.min(4, zoom.s * 1.5)); }
    if (e.key === '-' || e.key === 'Escape') resetZoom(true);
  });
  zoomer.style.transformOrigin = '0 0';
}

function zoomAt(cx, cy, s, base = null) {
  const r = $('.stage').getBoundingClientRect();
  const b = base || { s: zoom.s, zx: zoom.x, zy: zoom.y, cx, cy };
  const px = cx - r.left, py = cy - r.top;
  // точка под пальцем остаётся на месте
  const ux = (b.cx - r.left - b.zx) / b.s, uy = (b.cy - r.top - b.zy) / b.s;
  zoom.s = s; zoom.x = px - ux * s; zoom.y = py - uy * s;
  applyZoom();
}
function toggleZoom(x, y) { if (zoom.s > 1.05) resetZoom(true); else zoomAt(x, y, 2.5); }
function applyZoom() {
  const st = $('.stage'), r = st.getBoundingClientRect();
  if (zoom.s <= 1.001) { zoom.s = 1; zoom.x = 0; zoom.y = 0; }
  zoom.x = Math.min(0, Math.max(r.width - r.width * zoom.s, zoom.x));
  zoom.y = Math.min(0, Math.max(r.height - r.height * zoom.s, zoom.y));
  $('.zoomer').style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
  st.classList.toggle('zoomed', zoom.s > 1);
  $('.zoom-out').hidden = zoom.s === 1;
  if (zoom.s > 1.2 && !zoomTier) {
    track('zoom', { view });
    zoomTier = isMobile() ? 2400 : 3600;
    updateShot();
    if (zoomTier > stageTier) getLayers(view, zoomTier).then(() => render()).catch(()=>{zoomTier=null;toast('Не удалось загрузить детализацию. Попробуйте ещё раз.');}); else zoomTier = null;
  }
}
function resetZoom(user = false) {
  zoom.s = 1; zoom.x = 0; zoom.y = 0;
  if (zoomTier) { R.drop(`${view}@${zoomTier}`); layers.delete(`${view}@${zoomTier}`); zoomTier = null; }
  const z = $('.zoomer'); if (z) { z.style.transform = ''; $('.stage').classList.remove('zoomed'); $('.zoom-out').hidden = true; }
  if (user) render();
}

// ---------- действия ----------
function toast(msg) {
  const t = $('.toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}

async function share() {
  const url = configUrl();
  track('share', { config_id: encodeId(D, S) });
  try {
    if (navigator.share) { await navigator.share({ title: C.actions.shareText, text: C.actions.shareText, url }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast(C.actions.copied); }
  catch { prompt(C.actions.copied, url); }
}

function cta() {
  const payload = { config_id: encodeId(D, S), config_text: configText(), config_url: configUrl() };
  track('lead_form_open', { config_id: payload.config_id });
  if (inFrame) post('open-lead', payload);
  else openResult('standalone');
}

async function heroCanvas() {
  const id = D.site.heroFrame, tier = 1280;
  const shot = findShot(D, S, id), src = shot && pickSrc(BASE, shot, 1280);
  if (src) {
    try {
      const im = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src.url; });
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0); return c;
    } catch { /* нет файла — живой рендер */ }
  }
  const l = await getLayers(id, tier);
  TR.draw(`${id}@${tier}`, l, zoneSetup(id));
  const c = document.createElement('canvas'); c.width = l.w; c.height = l.h;
  c.getContext('2d').drawImage(TR.canvas, 0, 0);
  TR.drop(`${id}@${tier}`);
  return c;
}

async function openResult(mode) {
  const box = $('#result');
  const d = describe(), id = encodeId(D, S), url = configUrl();
  const close = () => { box.hidden = true; document.body.classList.remove('modal'); lastFocus?.focus(); };
  const lastFocus = document.activeElement;
  const img = el('img', { class: 'card-img', alt: `${C.card.title}: ${d.main}, ${d.contrast}, ${d.frame}` });
  const dl = el('a', { class: 'btn primary', download: `ECORA-${id}.png`, href: '#', onclick: () => track('card_download', { config_id: id }) }, C.result.download);
  const linkInput = el('input', { class: 'link', readonly: true, value: url, 'aria-label': C.result.link, onfocus: e => e.target.select() });
  const contacts = mode === 'standalone' ? el('div', { class: 'contacts' },
    el('p', { class: 'contacts-title', text: C.result.contactTitle }),
    el('a', { class: 'btn', href: D.site.contacts.telegramUrl, target: '_blank', rel: 'noopener' }, C.result.telegram),
    el('a', { class: 'btn', href: D.site.contacts.phoneHref }, C.result.call),
    el('button', { class: 'btn ghost', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(configText()); toast(C.result.textCopied); } catch { prompt('', configText()); } } }, C.result.copyText)) : null;
  box.replaceChildren(el('div', { class: 'result-inner' },
    el('button', { class: 'close', type: 'button', 'aria-label': C.actions.close, onclick: close, text: '×' }),
    el('h2', { id: 'result-title', text: mode === 'submitted' ? C.result.submittedTitle : C.result.title }),
    el('p', { class: 'result-sub', text: mode === 'submitted' ? C.result.submittedSub : C.result.sub }),
    el('div', { class: 'card-wrap' }, img),
    el('div', { class: 'result-actions' }, dl,
      el('label', { class: 'link-label' }, el('span', { text: C.result.link }), linkInput)),
    contacts));
  box.hidden = false; document.body.classList.add('modal');
  box.onkeydown = e => { if (e.key === 'Escape') close(); };
  box.onclick = e => { if (e.target === box) close(); };
  $('.close', box).focus();
  try {
    const logo = await logoImage(BASE, LOGO_VIEWBOX, 900);
    const card = await buildCard({
      photo: await heroCanvas(), id, url, copy: C, contacts: D.site.contacts, logo,
      rows: [
        { label: C.card.collection, value: d.coll },
        { label: C.card.main, value: d.main, hex: d.mainHex },
        { label: C.card.contrast, value: d.contrast, hex: d.contrastHex },
        { label: C.card.frame, value: d.frame },
        { label: C.card.rope, value: d.ro.preview === false ? `${d.rope} · ${C.ropes.cardNote}` : d.rope },
      ],
    });
    card.toBlob(b => { const u = URL.createObjectURL(b); img.src = u; dl.href = u; }, 'image/png');
  } catch (e) { console.error(e); }
}

boot().catch(e => { console.error(e); $('#app').replaceChildren(el('div',{class:'boot-error'},el('h1',{text:'Не удалось открыть конструктор'}),el('p',{text:'Проверьте соединение и попробуйте ещё раз. Ваш выбор сохранён.'}),el('button',{class:'btn primary',type:'button',text:'Загрузить снова',onclick:()=>location.reload()}))); });

