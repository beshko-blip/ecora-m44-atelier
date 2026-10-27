// Персональная карточка конфигурации: canvas 1080×1350 → PNG.
const W = 1080, H = 1350, M = 72;
const GRAPHITE = '#434141';

function loadImg(src) {
  return new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
}

// Логотип: исходный SVG без изменений рисунка; только обрезка артборда и масштаб растеризации
export async function logoImage(base, viewBox, px) {
  const txt = await (await fetch(base + 'brand/RGB_base%20eng.svg')).text();
  const svg = txt.replace(/viewBox="[^"]*"/, `viewBox="${viewBox}" width="${px}" height="${Math.round(px * viewBox.split(' ')[3] / viewBox.split(' ')[2])}"`);
  return loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
}

function qrMatrix(text) {
  const q = window.qrcode(0, 'M');
  q.addData(text); q.make();
  const n = q.getModuleCount();
  return { n, dark: (r, c) => q.isDark(r, c) };
}

function drawQR(ctx, text, x, y, size) {
  const { n, dark } = qrMatrix(text);
  const cell = size / (n + 2);
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = GRAPHITE;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) ctx.fillRect(x + (c + 1) * cell, y + (r + 1) * cell, Math.ceil(cell), Math.ceil(cell));
}

// rows: [{label, value, hex?}], photo: canvas с главным кадром
export async function buildCard({ photo, rows, id, url, copy, contacts, logo }) {
  await document.fonts.ready;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  // логотип
  const lh = 46, lw = lh * logo.width / logo.height;
  ctx.drawImage(logo, M, 56, lw, lh);
  // кадр: вписываем по ширине, обрезая белые поля сверху и снизу
  const ph = photo.height * (W / photo.width);
  const area = 700, top = 130;
  ctx.save(); ctx.beginPath(); ctx.rect(0, top, W, area); ctx.clip();
  ctx.drawImage(photo, 0, top + (area - ph) / 2, W, ph);
  ctx.restore();
  // заголовок
  let y = top + area + 70;
  ctx.fillStyle = GRAPHITE; ctx.textBaseline = 'alphabetic';
  ctx.font = '600 50px Montserrat'; ctx.letterSpacing = '6px';
  ctx.fillText(copy.card.title, M, y);
  ctx.letterSpacing = '0px';
  // параметры
  y += 52;
  const qrSize = 230, colW = W - M * 2 - qrSize - 40;
  for (const r of rows) {
    ctx.font = '300 22px Montserrat'; ctx.fillStyle = '#7a7777';
    ctx.fillText(r.label, M, y);
    ctx.font = '400 26px Montserrat'; ctx.fillStyle = GRAPHITE;
    let vx = M + 250;
    if (r.hex) {
      ctx.beginPath(); ctx.arc(vx + 12, y - 9, 12, 0, Math.PI * 2); ctx.fillStyle = r.hex; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.15)'; ctx.lineWidth = 1; ctx.stroke(); ctx.fillStyle = GRAPHITE; vx += 34;
    }
    ctx.fillText(r.value, vx, y, colW - (vx - M));
    y += 44;
  }
  ctx.font = '300 22px Montserrat'; ctx.fillStyle = '#7a7777'; ctx.fillText(copy.card.id, M, y);
  ctx.font = '600 26px Montserrat'; ctx.fillStyle = GRAPHITE; ctx.fillText(id, M + 250, y);
  // QR
  const qx = W - M - qrSize, qy = top + area + 34;
  drawQR(ctx, url, qx, qy, qrSize);
  ctx.font = '300 18px Montserrat'; ctx.fillStyle = '#7a7777'; ctx.textAlign = 'center';
  ctx.fillText(copy.card.qr, qx + qrSize / 2, qy + qrSize + 26); ctx.textAlign = 'left';
  // контакты
  ctx.fillStyle = '#e6e4e4'; ctx.fillRect(M, H - 104, W - M * 2, 1);
  ctx.font = '400 23px Montserrat'; ctx.fillStyle = GRAPHITE;
  ctx.fillText([contacts.site, contacts.telegram, contacts.phone].join('   ·   '), M, H - 58);
  return c;
}
