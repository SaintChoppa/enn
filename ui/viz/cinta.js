// Cinta (v1 del handoff): una cinta metálica con torsión que recorre una
// lemniscata. Los graves la hacen respirar, la torsión y el filo siguen a
// medios y agudos, y el centroide espectral desplaza el color por la paleta.
// Referencia: `Adjuntos/Handoff visualizador 2026-11-09/Cinta Visualizador.dc.html`.

import { TAU, clamp, OMEGA, easeInOutCubic, f1, springStep, samePalette, compileProgram, blendAdditive, blendOver } from "./common.js";

const K = {
  SEGS: 640, TRAIL: 1.6, LAP_S: 10, Z_AMP: 0.16, TILT: -0.42, FOV_DEG: 8, CAM_D: 12, NEAR: 9, FAR: 16, WIDTH_FRAC: 0.6,
  W0: 0.05, NIB_ANGLE: 0.6, NIB_MIN: 0.42, TAIL: 0.62, HEAD: 0.018, TW: 0.07, LOBE_TILT: 0.22,
  ECHO_ROT: 0.18, ECHO_SCALE: 0.035, ECHO_Z: 0.1, GLOW_W: 3.0, GLOW_I: 0.055,
  BACK_L: 0.65, BACK_C: 0.85, BACK_B: -0.03,
  BREATH_A: 0.05, BREATH_T: 5.6, QUIET_SLOW: 0.6, QUIET_T90: 1.6, STOP_T90: 0.9, IDLE_S: 4,
  ANTIC: 0.35, PAL_FADE: 0.6, DUST_N: 700, LUT_N: 256, FLOATS: 328,
};
const SHADER_CONSTS = ["Z_AMP", "W0", "NIB_ANGLE", "NIB_MIN", "TAIL", "HEAD", "TW", "LOBE_TILT", "ECHO_ROT", "ECHO_SCALE", "ECHO_Z", "GLOW_W", "GLOW_I", "BACK_L", "BACK_C", "BACK_B"];

export const BANDS = [
  { name: "Graves", range: "20–150 Hz" },
  { name: "Medios", range: "150 Hz–2 kHz" },
  { name: "Agudos", range: "2 kHz en adelante" },
  { name: "Tono", range: "centroide espectral" },
];
export const DESTS = [
  { key: "grosor", short: "Grosor", name: "respiración del grosor", min: -0.15, bound: 0.15 },
  { key: "velocidad", short: "Veloc.", name: "velocidad de recorrido", min: -0.2, bound: 0.2 },
  { key: "torsion", short: "Torsión", name: "torsión", min: 0, bound: 0.6 },
  { key: "borde", short: "Borde", name: "brillo del borde", min: 0, bound: 1.5 },
  { key: "color", short: "Color", name: "desplazamiento de color", min: 0, bound: 0.5 },
  { key: "polvo", short: "Polvo", name: "destello del polvo", min: 0, bound: 1.0 },
];
const DI = {};
DESTS.forEach((d, i) => { DI[d.key] = i; });
export const PROFILES = {
  sub: { name: "Sub", desc: "Graves → grosor, lento y pesado. Los agudos encienden el filo y el tono apenas tiñe.", bands: [
    { routes: ["grosor"], sens: 1.0, att: 160, rel: 720, gamma: 1.7, amp: 1.0 },
    { routes: ["torsion"], sens: 0.8, att: 90, rel: 500, gamma: 1.3, amp: 0.45 },
    { routes: ["borde"], sens: 0.75, att: 8, rel: 140, gamma: 1.6, amp: 0.4 },
    { routes: ["color"], sens: 1.0, att: 400, rel: 1200, gamma: 1.0, amp: 0.25 },
  ] },
  aire: { name: "Aire", desc: "Agudos → filo y polvo, una chispa corta. Los graves solo empujan la velocidad.", bands: [
    { routes: ["velocidad"], sens: 0.8, att: 200, rel: 900, gamma: 1.4, amp: 0.5 },
    { routes: [], sens: 0.8, att: 80, rel: 400, gamma: 1.2, amp: 0.3 },
    { routes: ["borde", "polvo"], sens: 1.2, att: 5, rel: 110, gamma: 1.2, amp: 1.0 },
    { routes: ["color"], sens: 1.0, att: 300, rel: 1000, gamma: 1.0, amp: 0.2 },
  ] },
  tono: { name: "Tono", desc: "El centroide recorre la paleta: cuanto más agudo, más se desplaza el color hacia la cola. Graves y agudos quedan de fondo.", bands: [
    { routes: ["grosor"], sens: 0.9, att: 140, rel: 650, gamma: 1.5, amp: 0.4 },
    { routes: ["torsion"], sens: 0.8, att: 120, rel: 600, gamma: 1.2, amp: 0.3 },
    { routes: ["borde"], sens: 0.8, att: 10, rel: 160, gamma: 1.5, amp: 0.35 },
    { routes: ["color"], sens: 1.2, att: 220, rel: 900, gamma: 0.9, amp: 1.0 },
  ] },
};
export const DEFAULT_PROFILE = "sub";
/// Ajustes propios de esta versión: forma de la curva y longitud de la estela.
export const EXTRA_DEFAULTS = { curve: "Bernoulli", trail: K.TRAIL };
const ZERO4 = [0, 0, 0, 0];

function buildLut(k) {
  const M = 4096, S = new Float64Array(M + 1);
  const P = (t) => { const s = Math.sin(t), c = Math.cos(t), d = 1 / (1 + k * s * s); return [c * d, s * c * d]; };
  let prev = P(0);
  for (let j = 1; j <= M; j++) { const p = P((j / M) * TAU); S[j] = S[j - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]); prev = p; }
  const L = S[M], lut = new Float32Array(K.LUT_N);
  let j = 0;
  for (let i = 0; i < K.LUT_N; i++) {
    const target = (i / K.LUT_N) * L;
    while (j < M - 1 && S[j + 1] < target) j++;
    const f = (target - S[j]) / Math.max(1e-12, S[j + 1] - S[j]);
    lut[i] = (j + f) / M;
  }
  return lut;
}

// ---------------------------------------------------------------- GLSL (mismas fórmulas que el WGSL del handoff)
const GL_HEAD = `#version 300 es
precision highp float;
precision highp int;
layout(std140) uniform Frame {
  vec4 energy; vec4 fx; vec4 fx2; vec4 timev; vec4 view; vec4 cam; vec4 drift; vec4 counts;
  vec4 palA[5]; vec4 palB[5]; vec4 lut[64];
};
const float PI = 3.14159265;
const float TAU = 6.28318531;
${SHADER_CONSTS.map((n) => `const float ${n} = ${f1(K[n])};`).join("\n")}
`;
const GL_VS_LIB = `
float comp4(vec4 q, int c) { return c == 0 ? q.x : (c == 1 ? q.y : (c == 2 ? q.z : q.w)); }
float lutT(float u) {
  float x = fract(u) * 256.0;
  int k = min(int(floor(x)), 255);
  float f = x - float(k);
  float a = comp4(lut[k >> 2], k & 3);
  int k1 = k + 1;
  float b = k1 >= 256 ? 1.0 : comp4(lut[k1 >> 2], k1 & 3);
  return mix(a, b, f) * TAU;
}
vec3 curve(float t) {
  float s = sin(t), c = cos(t);
  float d = 1.0 / (1.0 + timev.w * s * s);
  return vec3(c * d, s * c * d, Z_AMP * s);
}
mat3 worldRot() {
  float ct = cos(cam.z), st = sin(cam.z), cy = cos(cam.w), sy = sin(cam.w);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, ct, st, 0.0, -st, ct);
  mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  return ry * rx;
}
vec4 project(vec3 w, float par) {
  float zv = w.z - cam.x;
  float n = drift.z, f = drift.w;
  vec4 c = vec4(w.x * cam.y / view.z, w.y * cam.y, (zv * (f + n) + 2.0 * f * n) / (n - f), -zv);
  c.xy += drift.xy * par * c.w;
  return c;
}
vec2 corner(int c) { return vec2((c == 1 || c == 4 || c == 5) ? 1.0 : -1.0, (c == 2 || c == 3 || c == 5) ? 1.0 : -1.0); }
`;
const GL_FS_LIB = `
vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 encodeSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float pingpong(float x) { return 1.0 - abs(1.0 - (x - 2.0 * floor(x * 0.5))); }
vec3 gradA(float x) { float n = counts.x; float f = x * (n - 1.0); int k = int(min(floor(f), n - 2.0)); return mix(palA[k].xyz, palA[k + 1].xyz, f - float(k)); }
vec3 gradB(float x) { float n = counts.y; float f = x * (n - 1.0); int k = int(min(floor(f), n - 2.0)); return mix(palB[k].xyz, palB[k + 1].xyz, f - float(k)); }
vec3 paletteLab(float x) { return mix(gradA(x), gradB(x), timev.z); }
`;
const GL_RIBBON_VS = `
out vec3 vPw; out vec3 vT; out vec3 vD; out float vSide; out float vGrad; out float vAlpha;
void main() {
  int i = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  float v = float(i) / (counts.z - 1.0);
  float age = 1.0 - v;
  float u = fract(timev.y - age * counts.w);
  float t = lutT(u);
  vec3 tg = normalize(curve(t + 0.002) - curve(t - 0.002));
  vec3 nz = normalize(vec3(0.0, 0.0, 1.0) - tg.z * tg);
  vec3 bn = cross(tg, nz);
  float tau = timev.x;
  float th = PI * (smoothstep(0.25 - TW, 0.25 + TW, u) + smoothstep(0.75 - TW, 0.75 + TW, u))
           + LOBE_TILT * sin(2.0 * TAU * u) * (0.75 + 0.25 * sin(0.4 * tau))
           + fx.y * sin(3.0 * TAU * u - 1.7 * tau);
  vec3 d = cos(th) * bn + sin(th) * nz;
  float nib = NIB_MIN + (1.0 - NIB_MIN) * abs(sin(atan(tg.y, tg.x) - NIB_ANGLE));
  float taper = pow(smoothstep(0.0, TAIL, v), 1.25) * sqrt(clamp(age / HEAD, 0.0, 1.0));
  float w = W0 * nib * taper * (1.0 + clamp(fx.x, -0.15, 0.15) + fx2.z);
  float ea = ECHO_ROT * age;
  mat3 re = mat3(cos(ea), sin(ea), 0.0, -sin(ea), cos(ea), 0.0, 0.0, 0.0, 1.0);
  vec3 p = re * curve(t) * (1.0 + ECHO_SCALE * age) - vec3(0.0, 0.0, ECHO_Z * age);
  mat3 m = worldRot();
#ifdef GLOW
  vec3 off = re * bn * side * max(w, W0 * 0.35 * taper) * GLOW_W;
#else
  vec3 off = re * d * side * w;
#endif
  vec3 pw = m * (p + off) * view.w;
  gl_Position = project(pw, 1.0);
  vPw = pw; vT = m * (re * tg); vD = m * (re * d); vSide = side;
  vGrad = age + fx.w;
  vAlpha = smoothstep(0.0, 0.45, v);
}
`;
const GL_RIBBON_FS = `
in vec3 vPw; in vec3 vT; in vec3 vD; in float vSide; in float vGrad; in float vAlpha;
out vec4 o;
void main() {
  bool front = gl_FrontFacing;
  float fw = fwidth(vSide);
  vec3 lab = paletteLab(pingpong(vGrad));
  if (!front) lab = vec3(lab.x * BACK_L, lab.yz * BACK_C + vec2(0.0, BACK_B));
  vec3 base = max(oklabToLinear(lab), 0.0);
#ifdef GLOW
  float g = exp(-vSide * vSide * 3.5) * (1.0 - vSide * vSide);
  o = vec4(encodeSrgb(base) * g * GLOW_I * (1.0 + 0.6 * fx.z) * vAlpha, 1.0);
#else
  vec3 T = normalize(vT), D = normalize(vD);
  vec3 n = normalize(cross(D, T));
  if (!front) n = -n;
  vec3 ns = normalize(n + vSide * 0.65 * D);
  vec3 V = normalize(vec3(0.0, 0.0, cam.x) - vPw);
  vec3 Lk = normalize(vec3(-0.35, 0.65, 0.68));
  vec3 Lr = normalize(vec3(0.6, -0.3, -0.75));
  vec3 H = normalize(Lk + V);
  float th = dot(T, H);
  float ndl = dot(ns, Lk);
  float spec = pow(max(1.0 - th * th, 0.0), 24.0) * smoothstep(-0.2, 0.5, ndl);
  float diff = (0.5 + 0.5 * ndl) * (0.5 + 0.5 * ndl);
  float fres = pow(1.0 - abs(dot(ns, V)), 4.0);
  float rim = pow(max(dot(ns, Lr), 0.0), 2.0) * 0.35;
  vec3 silver = vec3(0.503, 0.565, 0.658);
  vec3 col = base * (0.10 + 0.78 * diff)
           + spec * mix(base, vec3(1.0, 0.97, 0.92), 0.45) * 0.9
           + fres * silver * 0.22
           + rim * mix(base, silver, 0.5);
  col = 1.0 - exp(-1.15 * col);
  float e = 1.0 - smoothstep(0.0, 1.25 * fw, 1.0 - abs(vSide));
  col = mix(col, vec3(0.93, 0.95, 0.98), clamp(e * (0.42 + 0.30 * spec) * (1.0 + fx.z), 0.0, 0.92));
  o = vec4(encodeSrgb(col), vAlpha);
#endif
}
`;
const GL_DUST_VS = `
out vec2 vQ; out float vI; out float vPx;
vec3 hash3(float n) { return fract(sin(vec3(n, n + 1.7, n + 3.1)) * vec3(43758.5453, 22578.1459, 19642.3490)); }
float hash1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  int id = gl_VertexID / 6;
  vec2 q = corner(gl_VertexID - id * 6);
  float fid = float(id);
  vec3 h = hash3(fid * 1.371 + 0.5);
  float dep = h.z;
  vec2 p = vec2(h.x * 2.4 - 1.2, mod(h.y * 2.4 + timev.x * (0.004 + 0.008 * dep), 2.4) - 1.2);
  p.x += 0.02 * sin(timev.x * 0.07 + h.y * TAU);
  p += drift.xy * (0.25 + 0.2 * dep);
  p.x -= cam.w * (0.25 + 0.25 * dep);
  float px = (0.6 + 1.4 * dep * dep) * max(1.0, view.y / 1000.0);
  float slot = floor(timev.x * 9.0);
  float spark = step(0.965, hash1(fid * 7.13 + slot * 1.618)) * (1.0 - fract(timev.x * 9.0));
  float tw = 0.55 + 0.45 * sin(timev.x * (0.4 + 1.1 * h.x) + h.y * 40.0);
  vI = ((0.05 + 0.22 * dep * dep) * tw * (1.0 + 0.5 * fx2.x) + fx2.x * spark * 0.85) * (0.6 + 0.4 * fx2.w) * min(1.0, px);
  float hs = px + 1.0;
  vQ = q * hs / px;
  vPx = px;
  gl_Position = vec4(p + q * hs * 2.0 / view.xy, 0.0, 1.0);
}
`;
const GL_DUST_FS = `
in vec2 vQ; in float vI; in float vPx;
out vec4 o;
void main() {
  float aa = 1.0 / vPx;
  float a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, length(vQ));
  o = vec4(vec3(0.74, 0.78, 0.83) * vI * a, 1.0);
}
`;
const GL_STREAK_VS = `
out vec2 vQ;
void main() {
  vec2 q = corner(gl_VertexID);
  vec3 pw = worldRot() * curve(lutT(fract(timev.y - 0.03))) * view.w;
  vec4 cl = project(pw, 1.8);
  vec2 ndc = cl.xy / cl.w * 1.06;
  vQ = q;
  gl_Position = vec4(ndc + q * vec2(0.62, 28.0 / view.y), 0.0, 1.0);
}
`;
const GL_STREAK_FS = `
in vec2 vQ;
out vec4 o;
void main() {
  float core = exp(-vQ.y * vQ.y * 9.0) * pow(max(1.0 - vQ.x * vQ.x, 0.0), 3.0);
  float hot = exp(-(vQ.x * vQ.x * 40.0 + vQ.y * vQ.y * 12.0));
  vec3 lab = mix(palA[0].xyz, palB[0].xyz, timev.z);
  vec3 tint = mix(vec3(0.74, 0.78, 0.83), encodeSrgb(max(oklabToLinear(lab), 0.0)), 0.4);
  float I = (0.03 + 0.05 * fx.z) * (0.3 + 0.7 * fx2.w);
  o = vec4(tint * (core * 0.55 + hot) * I, 1.0);
}
`;
function program(gl, kind) {
  const def = kind === "glow" ? "#define GLOW 1\n" : "";
  const body = kind === "dust" ? [GL_DUST_VS, GL_DUST_FS] : kind === "streak" ? [GL_STREAK_VS, GL_STREAK_FS] : [GL_RIBBON_VS, GL_RIBBON_FS];
  return compileProgram(gl, GL_HEAD + def + GL_VS_LIB + body[0], GL_HEAD + def + GL_FS_LIB + body[1], "cinta/" + kind);
}

export class Cinta {
  constructor(gl, palette) {
    this.gl = gl;
    this.U = new Float32Array(K.FLOATS);
    this.progs = {};
    for (const k of ["dust", "glow", "ribbon", "streak"]) this.progs[k] = program(gl, k);
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.U.byteLength, gl.DYNAMIC_DRAW);
    for (const p of Object.values(this.progs)) {
      const i = gl.getUniformBlockIndex(p, "Frame");
      if (i !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, i, 0);
    }
    this.vao = gl.createVertexArray();
    this.curveName = null;
    this.E = {
      springs: BANDS.map(() => ({ x: 0, v: 0 })), quiet: { x: 1, v: 0 }, play: { x: 1, v: 0 },
      head: 0.08, tm: 0, onsetAt: -10, idle: 0,
      palA: palette, palB: palette, palT0: -10, outs: [0, 0, 0, 0], dest: new Float32Array(6),
    };
  }

  destroy() {
    const gl = this.gl;
    for (const p of Object.values(this.progs)) gl.deleteProgram(p);
    gl.deleteBuffer(this.ubo);
    gl.deleteVertexArray(this.vao);
  }

  setPalette(lab, t) {
    const E = this.E;
    // la app avisa de la paleta en cada cambio de carátula, a veces repetida:
    // si es la misma que ya está entrando, no se reinicia el fundido
    if (samePalette(lab, E.palB)) return;
    const fading = t - E.palT0 < K.PAL_FADE;
    if (fading && lab.length === E.palB.length) E.palB = lab;
    else { E.palA = E.palB; E.palB = lab; E.palT0 = t; }
  }

  meters() { return this.E.outs; }

  applyCurve(name) {
    if (name === this.curveName) return;
    this.curveName = name;
    this.curveK = name === "Gerono" ? 0 : 1;
    this.U.set(buildLut(this.curveK), 72);
  }

  /// Un frame. `f` = { t, dt, playing, feed, cfg, cw, ch }. Devuelve true si
  /// ya no queda movimiento pendiente.
  frame(f) {
    const E = this.E, gl = this.gl, U = this.U, cfg = f.cfg, bands = cfg.bands;
    const { t, dt, playing, feed } = f;
    this.applyCurve(cfg.curve);
    const h = playing ? feed.delayed(t) : null;
    const del = h ? [h.v[0], h.v[1], h.v[2], h.c] : ZERO4;
    // anticipación: el motor detectó el golpe de graves antes de que suene;
    // la cinta «toma aire» (sin²) durante el lookahead y el golpe cae encima
    for (const o of feed.takeOnsets()) {
      if (playing && o.b === 0 && o.n > 0.35) E.onsetAt = o.t;
    }
    const la = feed.la;
    const tau = t - E.onsetAt;
    const dip = tau >= 0 && tau < la ? Math.pow(Math.sin((Math.PI * tau) / la), 2) : 0;
    springStep(E.quiet, !playing || Math.max(del[0], del[1], del[2]) < 0.05 ? 1 : 0, OMEGA(K.QUIET_T90), dt);
    const q = clamp(E.quiet.x, 0, 1);
    for (let b = 0; b < 4; b++) {
      const B = bands[b];
      const x = b === 3 ? del[3] * (1 - q) : del[b];
      const target = Math.pow(clamp(x * B.sens, 0, 1), B.gamma);
      const sp = E.springs[b];
      springStep(sp, target, OMEGA(Math.max((target > sp.x ? B.att : B.rel) / 1000, 0.004)), dt);
      E.outs[b] = b === 0 ? sp.x - K.ANTIC * dip : sp.x;
    }
    const d = E.dest;
    d.fill(0);
    for (let b = 0; b < 4; b++) { const B = bands[b]; for (const key of B.routes) { const j = DI[key]; d[j] += E.outs[b] * B.amp * DESTS[j].bound; } }
    for (let j = 0; j < 6; j++) d[j] = clamp(d[j], DESTS[j].min, DESTS[j].bound);
    if (playing) E.idle = 0; else E.idle += dt;
    springStep(E.play, playing || !cfg.pauseIdle || E.idle < K.IDLE_S ? 1 : 0, OMEGA(K.STOP_T90), dt);
    const p = clamp(E.play.x, 0, 1);
    E.tm += dt * p;
    E.head = (((E.head + (dt * (1 + d[1]) * (1 - K.QUIET_SLOW * q) * p) / K.LAP_S) % 1) + 1) % 1;
    const breath = K.BREATH_A * q * p * (0.5 - 0.5 * Math.cos((TAU * E.tm) / K.BREATH_T));
    const yaw = 0.055 * Math.sin((TAU * E.tm) / 16) * (0.35 + 0.65 * q);
    const dx = 0.012 * Math.sin((TAU * E.tm) / 23) * (0.5 + 0.5 * q);
    const dy = 0.008 * Math.sin((TAU * E.tm) / 17 + 1) * (0.5 + 0.5 * q);
    const k = easeInOutCubic(clamp((t - E.palT0) / K.PAL_FADE, 0, 1));
    const { cw, ch } = f;
    const aspect = cw / ch, fl = 1 / Math.tan((K.FOV_DEG * Math.PI) / 360);
    const R = (aspect < 1 ? 0.82 : K.WIDTH_FRAC) * aspect * K.CAM_D / fl;
    U[0] = E.outs[0]; U[1] = E.outs[1]; U[2] = E.outs[2]; U[3] = E.springs[3].x;
    U[4] = d[0]; U[5] = d[2]; U[6] = d[3]; U[7] = d[4];
    U[8] = d[5]; U[9] = q; U[10] = breath; U[11] = p;
    U[12] = E.tm; U[13] = E.head; U[14] = k; U[15] = this.curveK;
    U[16] = cw; U[17] = ch; U[18] = aspect; U[19] = R;
    U[20] = K.CAM_D; U[21] = fl; U[22] = K.TILT; U[23] = yaw;
    U[24] = dx; U[25] = dy; U[26] = K.NEAR; U[27] = K.FAR;
    U[28] = E.palA.length; U[29] = E.palB.length; U[30] = K.SEGS; U[31] = clamp(+cfg.trail || K.TRAIL, 1, 2);
    for (let i = 0; i < 5; i++) {
      const a = E.palA[i] || ZERO4, b = E.palB[i] || ZERO4;
      U[32 + i * 4] = a[0]; U[33 + i * 4] = a[1]; U[34 + i * 4] = a[2]; U[35 + i * 4] = 0;
      U[52 + i * 4] = b[0]; U[53 + i * 4] = b[1]; U[54 + i * 4] = b[2]; U[55 + i * 4] = 0;
    }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, U);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); blendAdditive(gl);
    gl.useProgram(this.progs.dust); gl.drawArrays(gl.TRIANGLES, 0, K.DUST_N * 6);
    gl.useProgram(this.progs.glow); gl.drawArrays(gl.TRIANGLE_STRIP, 0, K.SEGS * 2);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); blendOver(gl);
    gl.useProgram(this.progs.ribbon); gl.drawArrays(gl.TRIANGLE_STRIP, 0, K.SEGS * 2);
    gl.disable(gl.DEPTH_TEST); blendAdditive(gl);
    gl.useProgram(this.progs.streak); gl.drawArrays(gl.TRIANGLES, 0, 6);
    return p < 0.002 && Math.abs(E.play.v) < 0.01 && k >= 1 && E.springs.every((s) => Math.abs(s.x) < 0.003 && Math.abs(s.v) < 0.01);
  }
}
