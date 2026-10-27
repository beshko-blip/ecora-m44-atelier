// Связь с родительской страницей (Tilda) и аналитика.
// Все сообщения: { source: 'ecora-atelier', type, ... }. Персональные данные сюда не попадают.
const SRC = 'ecora-atelier';
export const inFrame = (() => { try { return window.self !== window.top; } catch { return true; } })();

let site = null;
const listeners = new Map();

export function initBridge(siteCfg) {
  site = siteCfg;
  window.addEventListener('message', e => {
    const d = e.data;
    if (e.source !== window.parent || !d || d.source !== 'ecora-tilda' || typeof d.type !== 'string') return;
    (listeners.get(d.type) || []).forEach(fn => fn(d));
  });
  if (inFrame) post('ready', {});
}

export function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

export function post(type, payload) {
  if (!inFrame) return;
  try { window.parent.postMessage({ source: SRC, type, ...payload }, '*'); } catch (err) { console.warn(err); }
}

// Аналитика: родителю (там ym reachGoal) или напрямую в Метрику, иначе — консоль
export function track(event, props = {}) {
  if (site?.analytics?.consoleLog !== false) console.info('[atelier] track', event, props);
  if (inFrame) { post('track', { event, props }); return; }
  const id = site?.analytics?.metrikaId;
  try { if (id && typeof window.ym === 'function') window.ym(id, 'reachGoal', event, props); } catch { /* метрика необязательна */ }
}
