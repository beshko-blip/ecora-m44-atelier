// Гибрид: готовые фотореалистичные изображения из ECORA_M44_VISUAL_LIBRARY.
// Запись манифеста: {model, preset, main, contrast, frame, rope, view, role, master, web: {"1280": path, "2400": path}, status, version}
// Пути — относительно корня atelier. Нет манифеста / нет записи / status != "ready" → живая перекраска.
// Новые изображения добавляются только записью в манифест, код не меняется.
const MANIFEST = 'ECORA_M44_VISUAL_LIBRARY/MANIFEST/manifest.json';

let entries = null;

export async function loadLibrary(base) {
  if (entries) return entries;
  try {
    const r = await fetch(base + MANIFEST, { cache: 'no-cache' });
    if (!r.ok) throw new Error(r.status);
    const m = await r.json();
    const list = Array.isArray(m) ? m : (m.entries || m.items || m.images || []);
    entries = list.filter(e => e && e.status === 'ready' && e.web && typeof e.web === 'object');
  } catch { entries = []; }
  return entries;
}

const same = (a, ...b) => a != null && b.some(x => x != null && String(a).toUpperCase() === String(x).toUpperCase());

// Только точное совпадение всей конфигурации и ракурса — чужое изображение не показываем.
export function findShot(D, S, view) {
  if (!entries?.length) return null;
  const f = D.frames.frames.find(x => x.id === S.frame), r = D.frames.ropes.find(x => x.id === S.rope);
  return entries.find(e =>
    (e.model == null || same(e.model, D.site.product)) &&
    same(e.view, view) && same(e.main, S.main) && same(e.contrast, S.contrast) &&
    same(e.frame, f?.id, f?.code) && same(e.rope, r?.id, r?.code)) || null;
}

// Размер по ширине экрана и DPR: наименьший, который не меньше нужного, иначе самый крупный.
export function pickSrc(base, shot, needPx) {
  const sizes = Object.keys(shot.web).map(Number).filter(n => n > 0 && shot.web[n]).sort((a, b) => a - b);
  if (!sizes.length) return null;
  const w = sizes.find(n => n >= needPx) || sizes[sizes.length - 1];
  return { w, url: base + String(shot.web[w]).replace(/^\.?\//, '') };
}
