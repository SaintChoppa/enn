// Piezas compartidas por los dos renders del visualizador (Cinta y Traza).
//
// Portado del handoff de Claude Design del 2026-11-09 (bóveda: «Visualizador -
// Cinta y Traza»). Las fórmulas son las mismas que el prototipo; lo que cambia
// es de dónde sale el audio: aquí lo analiza el motor de Rust por delante de
// lo que suena (`get_viz_frame`, ADR #93/#94) en vez de un AnalyserNode.

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const OMEGA = (t90) => 3.89 / t90;
export const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const f1 = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
export const cloneBands = (b) => b.map((x) => ({ ...x, routes: x.routes.slice() }));

/// Reloj común de todo el visualizador, en segundos desde que cargó el módulo
/// (relativo para no perder precisión al subirlo a la GPU como float32).
const T0 = performance.now();
export const clock = () => (performance.now() - T0) / 1000;

/// Resorte crítico exacto (estable con cualquier dt).
export function springStep(s, target, omega, dt) {
  const d = s.x - target, j = s.v + omega * d, e = Math.exp(-omega * dt);
  s.x = target + (d + j * dt) * e;
  s.v = (s.v - omega * j * dt) * e;
}

function srgbToLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function linToSrgb(c) { c = clamp(c, 0, 1); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

export function rgbToOklab(R, G, B) {
  const r = srgbToLin(R / 255), g = srgbToLin(G / 255), b = srgbToLin(B / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function hexToOklab(hex) {
  const h = hex.replace("#", "");
  return rgbToOklab(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}
export function oklabToRgb([L, A, B]) {
  const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3), m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3), s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3);
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((v) => Math.round(linToSrgb(v) * 255));
}

/// Paleta del render a partir del color de la carátula (ADR #88): los dos
/// acentos de `palette.js`, una sombra honda del segundo y el plateado de Enn.
/// Sin portada (o portada gris) cae a la paleta «Plata» del handoff.
export function paletteFromCss() {
  const cs = getComputedStyle(document.documentElement);
  const parse = (name, fb) => {
    const v = cs.getPropertyValue(name).trim().split(",").map((x) => parseInt(x, 10));
    return v.length === 3 && v.every((x) => Number.isFinite(x)) ? v : fb;
  };
  const a = parse("--accent-rgb", [188, 198, 212]);
  const b = parse("--accent2-rgb", [138, 150, 168]);
  const silverish = a[0] === 188 && a[1] === 198 && a[2] === 212;
  if (silverish) return [[232, 234, 238], [188, 198, 212], [138, 150, 168]].map((c) => rgbToOklab(...c));
  const la = rgbToOklab(...a), lb = rgbToOklab(...b);
  const deep = [Math.min(lb[0] * 0.42, 0.34), lb[1] * 0.8, lb[2] * 0.8];
  return [la, lb, deep, rgbToOklab(188, 198, 212)];
}

/// ¿Dos paletas OKLab iguales (a efectos visuales)?
export function samePalette(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, i) => Math.abs(c[0] - b[i][0]) + Math.abs(c[1] - b[i][1]) + Math.abs(c[2] - b[i][2]) < 1e-3);
}

/// Compila un programa WebGL2; lanza con el log si falla.
export function compileProgram(gl, vs, fs, label) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(label + ": " + gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(label + " link: " + gl.getProgramInfoLog(p));
  return p;
}

/// Mezclas premultiplicadas: el canvas es transparente para que debajo sigan
/// los halos reactivos del fondo de la app. Las pasadas aditivas suman color
/// sin tocar el alfa (brillan encima de lo que haya); la cinta/traza tapa.
export function blendAdditive(gl) { gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE); }
export function blendOver(gl) { gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }

// ---------------------------------------------------------------- análisis del motor
/// Recibe los frames de `get_viz_frame`. El motor analiza la señal que va
/// `la` segundos por delante del altavoz: los ataques sirven para programar
/// pulsos que caen justo cuando suena el golpe, y las energías se retrasan
/// `la` para que la imagen se mueva con lo que se oye.
export class VizFeed {
  constructor(invoke) {
    this.invoke = invoke;
    this.inflight = false;
    this.la = 0.09;
    this.play = false;
    this.raw = [0, 0, 0, 0.5, 0];
    this.cen = 0;
    this.hist = [];
    this.onsets = [];
  }
  /// Pide un frame (como mucho uno en vuelo: si Rust tarda, no se apilan).
  request() {
    if (this.inflight || !this.invoke) return;
    this.inflight = true;
    this.invoke("get_viz_frame")
      .then((f) => this.ingest(f, clock()))
      .catch(() => {})
      .finally(() => { this.inflight = false; });
  }
  ingest(f, t) {
    if (!f) return;
    this.play = !!f.play;
    this.la = clamp(+f.la || 0.09, 0.02, 0.3);
    if (!(f.dt > 0)) return; // nada nuevo: en pausa
    this.raw = [f.n[0], f.n[1], f.n[2], f.tone, f.conf];
    this.cen = f.cen;
    for (const o of f.on || []) this.onsets.push({ b: o[0], s: o[1], n: o[2], t });
    this.hist.push({ t, v: this.raw.slice(), c: f.cen });
    if (this.hist.length > 120) this.hist.splice(0, this.hist.length - 120);
  }
  takeOnsets() {
    const o = this.onsets;
    this.onsets = [];
    return o;
  }
  /// Lo que suena en el instante `t`: el análisis que llegó `la` s antes.
  delayed(t) {
    const target = t - this.la;
    while (this.hist.length > 1 && this.hist[1].t <= target) this.hist.shift();
    const h = this.hist[0];
    return h && h.t <= target + 1e-6 ? h : null;
  }
  reset() {
    this.hist = [];
    this.onsets = [];
  }
}
