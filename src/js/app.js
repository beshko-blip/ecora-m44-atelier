// ECORA M44 Digital Atelier — приложение.
import { createRenderer, loadFrameLayers, zoneParams } from './renderer.js';
import { BASE, loadAll, encodeId, decodeId, validState, findSwatch, FAMILY_ORDER } from './data.js';
import { initBridge, on, post, track, inFrame } from './bridge.js';
import { buildCard, logoImage } from './card.js';

const LOGO_VIEWBOX = '150 248 296 126';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
};
const fmt = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => o[k] ?? '');
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* без хранилища тоже работаем */ } },
};

let D, C, S, R, TR, view, stageTier, zoomTier = null;
const layers = new Map();      // `${id}@${tier}` -> Promise<layers>
const hitData = new Map();     // id -> {w,h,data}
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
  buildUI();
  const stageCanvas = $('#stage-canvas');
  const r = createRenderer(stageCanvas); R = r.r;
  document.documentElement.dataset.renderer = r.kind;
  TR = createRenderer(document.createElement('canvas')).r;
  stageTier = pickTier();
  await showView(view);
  document.documentElement.classList.add('ready');
  track('atelier_open', { config_id: encodeId(D, S), renderer: r.kind, embedded: inFrame });
  scheduleThumbs(0);
  // предзагрузка остальных кадров в фоне
  D.order.forEach(id => getLayers(id, 480));
  window.addEventListener('resize', () => { const t = pickTier(); if (t !== stageTier) { stageTier = t; showView(view); } });
  on('lead-submitted', () => { track('lead_submit', { config_id: encodeId(D, S) }); openResult('submitted'); });
  on('lead-error', () => track('lead_submit_error', {}));
}

const pickTier = () => {
  const w = ($('.stage')?.clientWidth || 800) * Math.min(window.devicePixelRatio || 1, 2);
  return w > 1350 ? 2400 : 1280;
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
  resetZoom();
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
    if (isMobile()) for (const k of [...R.cache.keys()]) if (!k.startsWith(id + '@') && !k.endsWith('@480') && !k.endsWith(`@${stageTier}`)) R.drop(k);
  } catch (err) {
    console.error(err); toast(C.errors.load);
  } finally { stage.setAttribute('aria-busy', 'false'); }
  document.querySelectorAll('.view').forEach(b => b.setAttribute('aria-selected', b.dataset.id === id ? 'true' : 'false'));
}

function currentTier() { return zoomTier && R.cache.has(`${view}@${zoomTier}`) ? zoomTier : stageTier; }

function drawStage() {
  const k = `${view}@${currentTier()}`;
  const p = layers.get(k);
  if (!p) return;
  p.then(l => { const t0 = performance.now(); R.draw(k, l, zoneSetup(view)); lastDraw = performance.now() - t0; });
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
  render(); scheduleThumbs(); syncUI();
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
  return el('div', { class: 'palette' },
    groups.map(([f, list]) => el('div', { class: 'fam' },
      el('div', { class: 'fam-name', text: C.families[f] }),
      el('div', { class: 'sw-grid' }, list.sort((a, b) => a.n - b.n).map(s => swatchBtn(s, kind))))),
    el('p', { class: 'disclaimer', text: C.palette.disclaimer }));
}

function current(kind) {
  return el('div', { class: 'current', 'data-current': kind },
    el('span', { class: 'big-dot' }), el('span', { class: 'cur-text' }));
}

function step(no, key, title, hint, body) {
  const id = `step-${key}`;
  return el('section', { class: 'step', 'data-step': key },
    el('h2', {},
      el('button', { class: 'step-head', type: 'button', 'aria-expanded': 'false', 'aria-controls': id, onclick: () => openStep(key, true) },
        el('span', { class: 'step-no', text: no }), el('span', { class: 'step-title', text: title }),
        el('span', { class: 'step-val', 'data-val': key }))),
    el('div', { class: 'step-body', id, hidden: true }, hint ? el('p', { class: 'hint', text: hint }) : null, body));
}

function openStep(key, toggle = false) {
  document.querySelectorAll('.step').forEach(s => {
    const open = s.dataset.step === key ? (toggle ? !s.classList.contains('open') : true) : false;
    s.classList.toggle('open', open);
    $('.step-head', s).setAttribute('aria-expanded', String(open));
    $('.step-body', s).hidden = !open;
    if (open && (key === 'main' || key === 'contrast')) track('palette_open', { step: key });
  });
  const opening = isMobile() && sheetState === 'min';
  if (opening) setSheet('half');
  const s = document.querySelector(`.step[data-step="${key}"]`);
  if (s?.classList.contains('open')) setTimeout(() => {
    const box = $('.panel-scroll');
    box.scrollTo({ top: s.offsetTop - box.offsetTop - 4, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, opening ? 340 : 30);
}

function buildUI() {
  const app = $('#app');
  const logo = el('a', { class: 'logo', href: 'https://' + D.site.contacts.site, target: '_blank', rel: 'noopener' });
  inlineLogo(logo);
  const coll = D.collections.find(c => c.id === S.collection);

  const views = el('div', { class: 'views', role: 'tablist', 'aria-label': C.views.label },
    D.order.map(id => el('button', {
      class: 'view', role: 'tab', type: 'button', 'data-id': id, 'aria-selected': 'false',
      'aria-label': fmt(C.a11y.view, { name: C.views[id] || id }), title: C.views[id] || id,
      onclick: () => { if (id !== view) { track('view_switch', { view: id }); showView(id); } },
    }, el('canvas', { width: 48, height: 32 }))));

  const stage = el('div', { class: 'stage', tabindex: '0', role: 'img', 'aria-label': C.a11y.stage },
    el('div', { class: 'zoomer' }, el('canvas', { id: 'stage-canvas' })),
    el('button', { class: 'zoom-out', type: 'button', hidden: true, text: C.stage.zoomOut, onclick: () => resetZoom(true) }),
    el('span', { class: 'zoom-hint', text: C.stage.zoomHint }));

  const presets = el('div', { class: 'presets' },
    el('h2', { class: 'presets-title', text: C.presets.title }),
    el('div', { class: 'preset-grid' }, D.presets.filter(p => findSwatch(D, p.main) && findSwatch(D, p.contrast)).map(p => {
      const m = findSwatch(D, p.main).sw, c = findSwatch(D, p.contrast).sw;
      return el('button', {
        class: 'preset', type: 'button', 'data-preset': p.id, 'aria-pressed': 'false',
        onclick: () => setState({ collection: p.collection, main: p.main, contrast: p.contrast, frame: p.frame, rope: p.rope }, 'preset_select', { preset: p.id }),
      }, el('span', { class: 'duo', style: `--a:${m.hex};--b:${c.hex}` }), el('span', { class: 'preset-name', text: C.presets[p.id] || p.id }));
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
    D.frames.ropes.some(r => r.hidden) ? el('p', { class: 'hint soft', text: C.ropes.hiddenNote }) : null);

  const steps = el('div', { class: 'steps' },
    step('01', 'material', C.steps.s01, null, material),
    step('02', 'main', C.steps.s02, C.steps.s02hint, el('div', {}, current('main'), el('div', { 'data-palette': 'main' }, paletteBlock('main')))),
    step('03', 'contrast', C.steps.s03, C.steps.s03hint, el('div', {}, current('contrast'), el('div', { 'data-palette': 'contrast' }, paletteBlock('contrast')))),
    step('04', 'frame', C.steps.s04, null, frameOpts),
    step('05', 'rope', C.steps.s05, C.steps.s05hint, ropeOpts));

  const foot = el('div', { class: 'panel-foot' },
    el('div', { class: 'foot-row' },
      el('span', { class: 'cfg-id', 'aria-label': C.actions.configId }),
      el('button', { class: 'share', type: 'button', onclick: share },
        el('span', { 'aria-hidden': 'true', class: 'share-ico' }), el('span', { text: C.actions.share }))),
    el('button', { class: 'cta', type: 'button', onclick: cta }, el('span', { text: C.actions.cta }), el('span', { class: 'arrow', 'aria-hidden': 'true', text: '→' })));

  const handle = el('button', { class: 'sheet-handle', type: 'button', 'aria-label': C.actions.sheetOpen, onclick: cycleSheet },
    el('span', { class: 'grip', 'aria-hidden': 'true' }), el('span', { class: 'sheet-summary' }));

  const panel = el('aside', { class: 'panel', 'data-sheet': 'min' }, handle,
    el('div', { class: 'panel-scroll' }, presets, steps), foot);

  app.append(
    el('header', { class: 'top' }, logo),
    el('main', { class: 'main' },
      el('section', { class: 'intro' },
        el('h1', { text: C.hero.title }), el('p', { class: 'lead', text: C.hero.lead }), el('p', { class: 'sub', text: C.hero.sub })),
      el('section', { class: 'gallery' }, stage, views)),
    panel);
  document.body.append(
    el('div', { class: 'result', id: 'result', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'result-title' }),
    el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }));
  bindStage(stage);
  bindSheet(panel, handle);
  syncUI();
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
  for (const k of ['main', 'contrast']) {
    const cur = document.querySelector(`[data-current="${k}"]`); if (!cur) continue;
    $('.big-dot', cur).style.setProperty('--c', k === 'main' ? d.mainHex : d.contrastHex);
    $('.cur-text', cur).textContent = k === 'main' ? d.main : d.contrast;
  }
  const vals = { material: d.coll, main: d.main, contrast: d.contrast, frame: d.frame, rope: d.rope };
  for (const [k, v] of Object.entries(vals)) { const n = document.querySelector(`[data-val="${k}"]`); if (n) n.textContent = v; }
  const dots = { main: d.mainHex, contrast: d.contrastHex };
  for (const [k, hex] of Object.entries(dots)) document.querySelector(`[data-val="${k}"]`)?.style.setProperty('--c', hex);
  document.querySelectorAll('[data-coll]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.coll === S.collection)));
  document.querySelectorAll('[data-frame]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.frame === S.frame)));
  document.querySelectorAll('[data-rope]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.rope === S.rope)));
  document.querySelectorAll('[data-preset]').forEach(b => {
    const p = D.presets.find(x => x.id === b.dataset.preset);
    b.setAttribute('aria-pressed', String(p.main === S.main && p.contrast === S.contrast && p.frame === S.frame && p.rope === S.rope));
  });
  $('.cfg-id').textContent = encodeId(D, S);
  const sum = $('.sheet-summary');
  if (sum) sum.replaceChildren(
    el('span', { class: 'mini-dot', style: `--c:${d.mainHex}` }), el('span', { class: 'mini-dot', style: `--c:${d.contrastHex}` }),
    el('span', { text: `${d.main.split(' · ')[0]} + ${d.contrast.split(' · ')[0]} · ${C.frames[S.frame]}` }),
    el('span', { class: 'sheet-cta', text: sheetState === 'min' ? C.actions.sheetOpen : C.actions.sheetClose }));
}

// ---------- шторка (мобильные) ----------
let sheetState = 'min';
function setSheet(s) {
  sheetState = s;
  const p = $('.panel'); p.dataset.sheet = s;
  $('.sheet-handle').setAttribute('aria-expanded', String(s !== 'min'));
  // кадр остаётся главным: при открытой шторке заголовок сворачивается, фото поднимается
  document.body.classList.toggle('sheet-open', s !== 'min');
  if (s !== 'min' && isMobile()) window.scrollTo({ top: 0 });
  syncUI();
}
function cycleSheet() { setSheet(sheetState === 'min' ? 'half' : sheetState === 'half' ? 'full' : 'min'); }
function bindSheet(panel, handle) {
  let y0 = null, moved = false;
  handle.addEventListener('pointerdown', e => { if (!isMobile()) return; y0 = e.clientY; moved = false; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointermove', e => { if (y0 != null && Math.abs(e.clientY - y0) > 12) moved = true; });
  handle.addEventListener('pointerup', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0; y0 = null;
    if (!moved) return;
    const order = ['min', 'half', 'full'];
    let i = order.indexOf(sheetState) + (dy < 0 ? 1 : -1);
    setSheet(order[Math.max(0, Math.min(2, i))]);
    handle.dataset.dragged = '1'; setTimeout(() => delete handle.dataset.dragged, 50);
  });
  handle.addEventListener('click', e => { if (handle.dataset.dragged) e.stopImmediatePropagation(); }, true);
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
    if (zoomTier > stageTier) getLayers(view, zoomTier).then(() => render()); else zoomTier = null;
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
        { label: C.card.rope, value: d.rope },
      ],
    });
    card.toBlob(b => { const u = URL.createObjectURL(b); img.src = u; dl.href = u; }, 'image/png');
  } catch (e) { console.error(e); }
}

boot().catch(e => { console.error(e); document.body.classList.add('failed'); });
