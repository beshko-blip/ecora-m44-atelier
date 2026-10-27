// Загрузка конфигов и коллекций, семейства оттенков, ID конфигурации.
import { hexToLin } from './renderer.js';

export const BASE = new URL('../../', import.meta.url).href;

const getJSON = async p => {
  const r = await fetch(BASE + p, { cache: 'no-cache' });
  if (!r.ok) throw new Error('load ' + p);
  return r.json();
};

function oklch(hex) {
  const [r, g, b] = hexToLin(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

export const FAMILY_ORDER = ['neutral', 'beige', 'brown', 'red', 'green', 'blue', 'dark'];

// Семейство оттенка по OKLCH (вычисляется, а не хранится — новая коллекция работает без правки)
export function family(hex) {
  const { L, C, h } = oklch(hex);
  if (L < 0.36 && C < 0.03) return 'dark';
  if (C < 0.016) return L >= 0.5 ? 'neutral' : 'dark';
  if (h < 45 || h > 330) return 'red';
  if (h < 95) return L < 0.62 ? 'brown' : 'beige';
  if (h < 125) return L >= 0.55 ? 'beige' : 'brown';
  if (h < 195) return 'green';
  return 'blue';
}

export async function loadAll() {
  const [site, copy, collCfg, frames, presets, materials, manifest] = await Promise.all([
    getJSON('config/site.json'), getJSON('config/copy.ru.json'), getJSON('config/collections.json'),
    getJSON('config/frames.json'), getJSON('config/presets.json'), getJSON('config/materials.json'),
    getJSON('assets/manifest.json'),
  ]);
  const collections = await Promise.all(collCfg.collections.map(async c => {
    const d = await getJSON(c.file);
    const hidden = new Set(c.hiddenSwatches || []);
    const swatches = d.swatches
      .filter(s => !s.hidden && !hidden.has(s.id))
      .map(s => ({ id: s.id, n: s.n, name: s.display_ru || s.np || '', np: s.np || '', hex: s.hex_render, family: family(s.hex_render) }));
    return { ...c, displayName: d.display_name, swatches, byId: new Map(swatches.map(s => [s.id, s])) };
  }));
  const frameById = new Map(manifest.frames.map(f => [f.id, f]));
  const order = site.frameOrder.filter(id => frameById.has(id) && !(site.hiddenFrames || []).includes(id));
  return { site, copy, collections, frames, presets: presets.presets, materials: materials.profiles, manifest, frameById, order };
}

export function findSwatch(D, id) {
  for (const c of D.collections) { const s = c.byId.get(id); if (s) return { coll: c, sw: s }; }
  return null;
}

// ID: M44-K50-K56-FG-RB
export function encodeId(D, st) {
  const f = D.frames.frames.find(x => x.id === st.frame), r = D.frames.ropes.find(x => x.id === st.rope);
  return [D.site.product, st.main, st.contrast, f?.code, r?.code].join('-');
}

export function decodeId(D, id) {
  if (!id || typeof id !== 'string') return null;
  const p = id.trim().toUpperCase().split('-');
  if (p.length !== 5 || p[0] !== D.site.product.toUpperCase()) return null;
  const m = findSwatch(D, p[1]), c = findSwatch(D, p[2]);
  const f = D.frames.frames.find(x => x.code === p[3] && !x.hidden);
  const r = D.frames.ropes.find(x => x.code === p[4] && !x.hidden);
  if (!m || !c || !f || !r || m.coll.id !== c.coll.id) return null;
  return { collection: m.coll.id, main: m.sw.id, contrast: c.sw.id, frame: f.id, rope: r.id };
}

export function validState(D, st) {
  try { return st && decodeId(D, encodeId(D, st)) ? st : null; } catch { return null; }
}
