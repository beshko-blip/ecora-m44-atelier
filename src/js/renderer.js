// Перекраска фото по маскам зон. WebGL2, запасной вариант — Canvas 2D (та же математика на CPU).
// Модель — копия tools/recolor.py (см. описание там).

const ZONES = ['main', 'contrast', 'frame'];

export function srgbToLin(x) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
export function hexToLin(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => srgbToLin(parseInt(h.slice(i, i + 2), 16) / 255));
}
const lerp = (a, b, t) => a + (b - a) * t;
const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// Параметры зоны для конкретного целевого цвета (как в recolor.py)
export function zoneParams(targetHex, profile) {
  const T = hexToLin(targetHex);
  const Yt = lum(T);
  const lightness = Math.min(1, Math.max(0, (Yt - 0.08) / 0.5));
  return {
    T,
    tau: profile.tau,
    dg: 1 + (profile.detailLight - 1) * lightness,
    gamma: 1 + (profile.gammaLight - 1) * lightness * lightness,
    Yt, micro: lerp(profile.microDark ?? 0, profile.microLight ?? 0, lightness), microSpec: profile.microSpec ?? 0,
    spec: profile.specGain + (profile.specLight - profile.specGain) * lightness,
    shCap: lerp(profile.shCap ?? 9, profile.shCapLight ?? profile.shCap ?? 9, lightness),
    shSlope: lerp(profile.shSlope ?? 1, profile.shSlopeLight ?? profile.shSlope ?? 1, lightness),
  };
}

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('load ' + url);
  const blob = await res.blob();
  return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

// Загружает три слоя кадра одного размера
export async function loadFrameLayers(base, id, tier) {
  const [photo, zones, shade] = await Promise.all([
    loadBitmap(`${base}assets/photos/${id}/${tier}.webp`),
    loadBitmap(`${base}assets/masks/${id}/${tier}_zones.webp`),
    loadBitmap(`${base}assets/masks/${id}/${tier}_shade.webp`),
  ]);
  return { photo, zones, shade, w: photo.width, h: photo.height };
}

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = vec2(aPos.x*0.5+0.5, 0.5-aPos.y*0.5); gl_Position = vec4(aPos,0.,1.); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uPhoto, uZones, uShade;
uniform vec3 uT[3]; uniform float uYref[3]; uniform vec4 uP[3]; uniform vec2 uQ[3]; uniform vec3 uM[3]; uniform float uOn[3];
vec3 toLin(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c){ c = clamp(c,0.,1.); return mix(c*12.92, 1.055*pow(c, vec3(1./2.4))-0.055, step(0.0031308, c)); }
float knee(float x){ float k=0.82; return x < k ? x : k + (1.-k)*(1.-exp(-(x-k)/(1.-k))); }
vec3 toneMap(vec3 c){
  float Y = max(dot(c, vec3(0.2126,0.7152,0.0722)), 1e-6), Yk = knee(Y);
  c *= Yk / Y;
  float mx = max(c.r, max(c.g, c.b));
  if (mx > 1.) c = vec3(Yk) + (c - vec3(Yk)) * ((1. - Yk) / max(mx - Yk, 1e-6));
  return c;
}
void main(){
  vec3 c = toLin(texture(uPhoto, vUv).rgb);
  vec3 z = texture(uZones, vUv).rgb;
  vec3 s = texture(uShade, vUv).rgb;
  float sh = (floor(s.r*255.+0.5)*256. + floor(s.g*255.+0.5)) / 65535. * 4.;
  float tex = (floor(s.b*255.+0.5) - 128.) / 127. * 3.; // микрорельеф кожи («сигмы» зерна)
  float Y = dot(c, vec3(0.2126,0.7152,0.0722));
  vec3 acc = vec3(0.); float asum = 0.; // разбиение единицы: исходник·(1−Σa) + Σ res·a
  for(int i=0;i<3;i++){
    float a = i==0?z.r:(i==1?z.g:z.b);
    if(uOn[i] < 0.5 || a <= 0.0) continue;
    float Yr = uYref[i]; vec4 p = uP[i]; // tau, dg, gamma, spec
    float base = max(sh*Yr, 1e-5);
    float det = clamp(Y/base - 1., -1., p.x);
    float w = clamp((-det - 0.12) / 0.25, 0., 1.);
    vec2 q = uQ[i]; // shCap, shSlope
    float shd = sh < q.x ? sh : q.x + (sh - q.x)*q.y;
    float broad = (sh - shd) * Yr;
    float mul = pow(max(shd*(1. + det*mix(p.y, 1., w)), 0.), p.z);
    float spec = max(Y - base*(1. + p.x), 0.) * p.w;
    vec3 m = uM[i]; // micro, microSpec, Yt
    float glint = m.y * max(tex, 0.) * m.z * mul;
    vec3 res = toneMap(uT[i]*(mul*max(1. + m.x*tex, 0.)) + vec3(spec + broad + glint));
    acc += res * a; asum += a;
  }
  vec3 outc = c * (1. - min(asum, 1.)) + acc;
  vec3 srgb = toSrgb(outc);
  o = vec4(srgb, 1.);
}`;

class GLRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: false });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl; this.canvas = canvas; this.cache = new Map();
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.p = p; gl.useProgram(p);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uPhoto', 'uZones', 'uShade', 'uT', 'uYref', 'uP', 'uQ', 'uM', 'uOn']) this.u[n] = gl.getUniformLocation(p, n);
    gl.uniform1i(this.u.uPhoto, 0); gl.uniform1i(this.u.uZones, 1); gl.uniform1i(this.u.uShade, 2);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }
  tex(bmp) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  }
  upload(key, layers) {
    if (this.cache.has(key)) return this.cache.get(key);
    const e = { photo: this.tex(layers.photo), zones: this.tex(layers.zones), shade: this.tex(layers.shade), w: layers.w, h: layers.h };
    this.cache.set(key, e);
    return e;
  }
  drop(key) {
    const e = this.cache.get(key); if (!e) return;
    for (const t of [e.photo, e.zones, e.shade]) this.gl.deleteTexture(t);
    this.cache.delete(key);
  }
  draw(key, layers, zoneSetup) {
    const gl = this.gl, e = this.upload(key, layers);
    if (this.canvas.width !== e.w || this.canvas.height !== e.h) { this.canvas.width = e.w; this.canvas.height = e.h; }
    gl.viewport(0, 0, e.w, e.h);
    [e.photo, e.zones, e.shade].forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); });
    const T = [], Yr = [], P = [], Q = [], M = [], On = [];
    ZONES.forEach((z, i) => {
      const s = zoneSetup[z];
      if (s) { T.push(...s.T); Yr.push(s.Yref); P.push(s.tau, s.dg, s.gamma, s.spec); Q.push(s.shCap, s.shSlope); M.push(s.micro ?? 0, s.microSpec ?? 0, s.Yt ?? 0); On.push(1); }
      else { T.push(0, 0, 0); Yr.push(1); P.push(0, 1, 1, 1); Q.push(9, 1); M.push(0, 0, 0); On.push(0); }
    });
    gl.uniform3fv(this.u.uT, T); gl.uniform1fv(this.u.uYref, Yr); gl.uniform4fv(this.u.uP, P); gl.uniform2fv(this.u.uQ, Q); gl.uniform3fv(this.u.uM, M); gl.uniform1fv(this.u.uOn, On);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

// Canvas 2D: те же формулы на CPU (медленнее, но корректно)
class CPURenderer {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.cache = new Map(); }
  pixels(bmp) {
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  }
  upload(key, l) {
    if (this.cache.has(key)) return this.cache.get(key);
    const e = { photo: this.pixels(l.photo), zones: this.pixels(l.zones), shade: this.pixels(l.shade), w: l.w, h: l.h };
    const lut = new Float32Array(256); for (let i = 0; i < 256; i++) lut[i] = srgbToLin(i / 255);
    e.lut = lut; this.cache.set(key, e); return e;
  }
  drop(key) { this.cache.delete(key); }
  draw(key, layers, zoneSetup) {
    const e = this.upload(key, layers), { w, h } = e;
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const out = this.ctx.createImageData(w, h), o = out.data, ph = e.photo, zn = e.zones, sd = e.shade, lut = e.lut;
    const setups = ZONES.map(z => zoneSetup[z]);
    const enc = v => { v = v <= 0 ? 0 : v >= 1 ? 1 : v; return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255); };
    const knee = x => x < 0.82 ? x : 0.82 + 0.18 * (1 - Math.exp(-(x - 0.82) / 0.18));
    const tone = c => {
      const Y = Math.max(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2], 1e-6), Yk = knee(Y);
      for (let j = 0; j < 3; j++) c[j] *= Yk / Y;
      const mx = Math.max(c[0], c[1], c[2]);
      if (mx > 1) { const t = (1 - Yk) / Math.max(mx - Yk, 1e-6); for (let j = 0; j < 3; j++) c[j] = Yk + (c[j] - Yk) * t; }
      return c;
    };
    for (let i = 0; i < w * h * 4; i += 4) {
      let r = lut[ph[i]], g = lut[ph[i + 1]], b = lut[ph[i + 2]];
      const za = [zn[i] / 255, zn[i + 1] / 255, zn[i + 2] / 255];
      if (za[0] + za[1] + za[2] > 0) {
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const sh = (sd[i] * 256 + sd[i + 1]) / 65535 * 4;
        const tex = (sd[i + 2] - 128) / 127 * 3;
        let ar = 0, ag = 0, ab = 0, aSum = 0;
        for (let k = 0; k < 3; k++) {
          const s = setups[k], a = za[k]; if (!s || a <= 0) continue;
          const base = Math.max(sh * s.Yref, 1e-5);
          const det = Math.min(Math.max(Y / base - 1, -1), s.tau), w = Math.min(Math.max((-det - 0.12) / 0.25, 0), 1);
          const shd = sh < s.shCap ? sh : s.shCap + (sh - s.shCap) * s.shSlope;
          const mul = Math.pow(Math.max(shd * (1 + det * (s.dg + (1 - s.dg) * w)), 0), s.gamma);
          const sp = Math.max(Y - base * (1 + s.tau), 0) * s.spec + (sh - shd) * s.Yref;
          const mm = mul * Math.max(1 + (s.micro ?? 0) * tex, 0), g = sp + (s.microSpec ?? 0) * Math.max(tex, 0) * (s.Yt ?? 0) * mul;
          const c = tone([s.T[0] * mm + g, s.T[1] * mm + g, s.T[2] * mm + g]);
          ar += c[0] * a; ag += c[1] * a; ab += c[2] * a; aSum += a;
        }
        const k = 1 - Math.min(aSum, 1);
        r = r * k + ar; g = g * k + ag; b = b * k + ab;
      }
      o[i] = enc(r); o[i + 1] = enc(g); o[i + 2] = enc(b); o[i + 3] = 255;
    }
    this.ctx.putImageData(out, 0, 0);
  }
}

export function createRenderer(canvas) {
  try { return { r: new GLRenderer(canvas), kind: 'webgl2' }; }
  catch (err) { console.warn('[atelier] WebGL2 недоступен, Canvas 2D', err); return { r: new CPURenderer(canvas), kind: 'canvas2d' }; }
}
