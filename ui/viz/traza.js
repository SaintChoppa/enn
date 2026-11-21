// Traza (v2 del handoff): una cinta metálica que barre la pantalla de
// izquierda a derecha como un monitor cardíaco. El tono dominante la sube y la
// baja, cada golpe de graves dibuja un pulso con ecos y los agudos encienden
// el filo. Referencia: `Adjuntos/Handoff visualizador 2026-11-09/Cinta
// Visualizador v2.dc.html` (sección «Handoff para wgpu»).

import { TAU, clamp, OMEGA, easeInOutCubic, f1, springStep, samePalette, compileProgram, blendAdditive, blendOver } from "./common.js";

const K = {
  N: 1024, SWEEP: 4.6, Y_MAX: 0.28, PULSE_Y: 0.22, TILT: -0.22, FOV_DEG: 8, CAM_D: 12, NEAR: 9, FAR: 16, WIDTH_FRAC: 0.84,
  W0: 0.0045, TRAIL_W: 0.9, TWIST: 0.22, ROLL: 0.02, SPARK_N: 64, SPARK_P: 18, SPARK_JUMP: 0.09, OLD_A: 0.22, GHOST_Z: 0.12, GHOST_S: 0.012, GLOW_W: 4.0, GLOW_I: 0.05,
  BACK_L: 0.65, BACK_C: 0.85, BACK_B: -0.03,
  BREATH_A: 0.05, BREATH_T: 5.6, QUIET_T90: 1.2, STOP_T90: 0.9, IDLE_S: 4,
  PAL_FADE: 0.6, DUST_N: 700, FLOATS: 72,
};
const SHADER_CONSTS = ["W0", "TRAIL_W", "TWIST", "ROLL", "OLD_A", "GHOST_Z", "GHOST_S", "GLOW_W", "GLOW_I", "BACK_L", "BACK_C", "BACK_B"];

export const BANDS = [
  { name: "Graves", range: "20–150 Hz" },
  { name: "Medios", range: "150 Hz–2 kHz" },
  { name: "Agudos", range: "2 kHz en adelante" },
  { name: "Tono", range: "tono dominante 150–1200 Hz" },
];
export const DESTS = [
  { key: "altura", short: "Altura", name: "altura de la línea", min: -1.2, bound: 1 },
  { key: "pulso", short: "Pulso", name: "pulso en cada ataque", min: 0, bound: 1 },
  { key: "rastro", short: "Rastro", name: "rastro y ecos", min: 0, bound: 1 },
  { key: "grosor", short: "Grosor", name: "grosor", min: 0, bound: 0.4 },
  { key: "brillo", short: "Brillo", name: "brillo del filo", min: 0, bound: 1.5 },
  { key: "polvo", short: "Polvo", name: "destello del polvo", min: 0, bound: 1 },
];
const DI = {};
DESTS.forEach((d, i) => { DI[d.key] = i; });
export const PROFILES = {
  monitor: { name: "Monitor", desc: "El tono sube y baja la línea casi nota a nota. Cada golpe de graves dibuja un latido y deja rastro, y los agudos hacen brillar el filo.", bands: [
    { routes: ["pulso", "rastro"], sens: 1.1, att: 6, rel: 280, gamma: 1.2, amp: 1.0 },
    { routes: ["grosor"], sens: 0.9, att: 40, rel: 300, gamma: 1.3, amp: 0.35 },
    { routes: ["brillo", "polvo"], sens: 1.1, att: 4, rel: 120, gamma: 1.3, amp: 0.8 },
    { routes: ["altura"], sens: 1.0, att: 25, rel: 45, gamma: 1.0, amp: 1.0 },
  ] },
  sub: { name: "Sub", desc: "Mandan los graves: latido alto, rastro largo y la línea engorda con cada golpe. El tono se mueve con más inercia.", bands: [
    { routes: ["pulso", "rastro", "grosor"], sens: 1.2, att: 10, rel: 650, gamma: 1.4, amp: 1.0 },
    { routes: [], sens: 0.8, att: 60, rel: 400, gamma: 1.2, amp: 0.3 },
    { routes: ["brillo"], sens: 0.8, att: 6, rel: 150, gamma: 1.5, amp: 0.4 },
    { routes: ["altura"], sens: 1.0, att: 120, rel: 260, gamma: 1.0, amp: 0.7 },
  ] },
  aire: { name: "Aire", desc: "El tono dibuja la línea casi sin suavizado y los agudos marcan pequeños pulsos, filo y polvo. Los graves solo dejan un rastro corto.", bands: [
    { routes: ["rastro"], sens: 0.9, att: 8, rel: 200, gamma: 1.3, amp: 0.5 },
    { routes: ["altura"], sens: 0.8, att: 30, rel: 120, gamma: 1.0, amp: 0.25 },
    { routes: ["brillo", "polvo", "pulso"], sens: 1.3, att: 3, rel: 90, gamma: 1.1, amp: 1.0 },
    { routes: ["altura"], sens: 1.1, att: 20, rel: 50, gamma: 0.9, amp: 1.0 },
  ] },
};
export const DEFAULT_PROFILE = "monitor";
/// Ajustes propios de esta versión (además del perfil).
export const EXTRA_DEFAULTS = { syncTempo: true, sweep: K.SWEEP };

const qrs = (t) => {
  if (t < 0 || t > 0.36) return 0;
  const g = (c, w) => Math.exp(-(((t - c) / w) ** 2));
  return -0.18 * g(0.012, 0.007) + g(0.034, 0.009) - 0.42 * g(0.058, 0.01) + 0.14 * g(0.2, 0.045);
};
const ZERO = [0, 0, 0, 0.5, 0];

// ---------------------------------------------------------------- GLSL (mismas fórmulas que el WGSL del handoff)
const GL_HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
layout(std140) uniform Frame {
  vec4 energy; vec4 fx; vec4 fx2; vec4 timev; vec4 view; vec4 cam; vec4 drift; vec4 counts;
  vec4 palA[5]; vec4 palB[5];
};
uniform sampler2D uHist;
const float PI = 3.14159265;
const float TAU = 6.28318531;
const int SPARK_P = ${K.SPARK_P};
${SHADER_CONSTS.map((n) => `const float ${n} = ${f1(K[n])};`).join("\n")}
`;
const GL_VS_LIB = `
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
vec4 bin(int i, int row) { return texelFetch(uHist, ivec2(clamp(i, 0, int(counts.z) - 1), row), 0); }
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
const GL_TRACE_VS = `
out vec3 vPw; out vec3 vT; out vec3 vD; out float vSide; out float vGrad; out float vAlpha; out float vTrail; out float vBright;
void main() {
  int i = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  float n = counts.z;
  float xb = float(i) / (n - 1.0);
  float age = mod(timev.y - float(i) + n, n) / n;
#ifdef GHOST
  int g = gl_InstanceID;
  vec4 h = bin(i, 1), hm = bin(i - 1, 1), hp = bin(i + 1, 1);
  float y = g == 0 ? h.x : h.z, ym = g == 0 ? hm.x : hm.z, yp = g == 0 ? hp.x : hp.z;
  float trail = g == 0 ? h.y : h.w;
  float thick = 0.0, bright = 0.0, gen = float(g + 1);
#else
  vec4 h = bin(i, 0);
  float y = h.x, ym = bin(i - 1, 0).x, yp = bin(i + 1, 0).x;
  float trail = h.y, bright = h.z, thick = h.w, gen = 0.0;
#endif
  float dx = 2.0 / (n - 1.0);
  vec3 T = normalize(vec3(dx, 0.5 * (yp - ym), 0.0));
  vec3 np = vec3(-T.y, T.x, 0.0);
  float th = TWIST * atan(0.35 * (yp - ym) / (2.0 * dx)) + ROLL * sin(TAU * (2.0 * xb - 0.12 * timev.x));
  vec3 d = cos(th) * np + sin(th) * vec3(0.0, 0.0, 1.0);
  float taper = smoothstep(0.0, 0.006, age) * (1.0 - smoothstep(0.9, 0.985, age));
  float w = W0 * (1.0 + TRAIL_W * trail) * (1.0 + thick) * (1.0 + fx2.z) * taper;
#ifdef GHOST
  w *= 0.7 + 0.8 * trail;
#endif
#ifdef GLOW
  vec3 off = np * side * max(w, W0 * 0.5 * taper) * GLOW_W;
#else
  vec3 off = d * side * w;
#endif
  vec3 p = vec3(2.0 * xb - 1.0, y, -GHOST_Z * gen) * (1.0 + GHOST_S * gen);
  mat3 m = worldRot();
  vec3 pw = m * (p + off) * view.w;
  gl_Position = project(pw, 1.0 - 0.15 * gen);
  vPw = pw; vT = m * T; vD = m * d; vSide = side;
  vGrad = age + 0.35 * gen; vTrail = trail; vBright = bright;
  float fade = mix(1.0, OLD_A, smoothstep(0.08, 0.9, age));
#ifdef GHOST
  vAlpha = trail * (g == 0 ? 0.55 : 0.28) * (1.0 - 0.5 * age);
#else
  vAlpha = max(fade, min(1.0, 1.2 * trail) * (1.0 - 0.6 * age));
#endif
}
`;
const GL_TRACE_FS = `
in vec3 vPw; in vec3 vT; in vec3 vD; in float vSide; in float vGrad; in float vAlpha; in float vTrail; in float vBright;
out vec4 o;
void main() {
  bool front = gl_FrontFacing;
  float fw = fwidth(vSide);
  vec3 lab = paletteLab(pingpong(vGrad));
#ifdef GHOST
  front = false;
#endif
  if (!front) lab = vec3(lab.x * BACK_L, lab.yz * BACK_C + vec2(0.0, BACK_B));
  vec3 base = max(oklabToLinear(lab), 0.0);
#if defined(GHOST)
  float g = exp(-2.0 * vSide * vSide) * (1.0 - vSide * vSide);
  o = vec4(encodeSrgb(base) * g * 0.9 * vAlpha, 1.0);
#elif defined(GLOW)
  float g = exp(-3.5 * vSide * vSide) * (1.0 - vSide * vSide);
  o = vec4(encodeSrgb(base) * g * GLOW_I * (1.0 + 2.5 * vTrail + 0.6 * vBright) * vAlpha, 1.0);
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
           + rim * mix(base, silver, 0.5)
           + base * 0.25 * vTrail;
  col = 1.0 - exp(-1.15 * col);
  float e = 1.0 - smoothstep(0.0, 1.25 * fw, 1.0 - abs(vSide));
  col = mix(col, vec3(0.93, 0.95, 0.98), clamp(e * (0.42 + 0.30 * spec) * (1.0 + vBright + 0.6 * vTrail), 0.0, 0.92));
  o = vec4(encodeSrgb(col), vAlpha);
#endif
}
`;
const GL_DUST_VS = `
out vec2 vQ; out float vI; out float vPx; out float vB;
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
  float blink = energy.x * step(0.5, hash1(fid * 3.7 + counts.w * 11.3));
  float px = (0.6 + 1.4 * dep * dep) * max(1.0, view.y / 1000.0) * (1.0 + 0.6 * blink);
  float slot = floor(timev.x * 9.0);
  float spark = step(0.965, hash1(fid * 7.13 + slot * 1.618)) * (1.0 - fract(timev.x * 9.0));
  float tw = 0.55 + 0.45 * sin(timev.x * (0.4 + 1.1 * h.x) + h.y * 40.0);
  vI = ((0.05 + 0.22 * dep * dep) * tw * (1.0 + 0.5 * fx.z) + fx.z * spark * 0.85) * (0.6 + 0.4 * fx2.w) * min(1.0, px);
  vI += blink * (0.22 + 0.45 * dep) * (0.6 + 0.4 * fx2.w);
  vB = blink * (0.35 + 0.65 * dep) * (0.6 + 0.4 * fx2.w);
  float hs = px * (1.0 + 2.6 * blink) + 1.0;
  vQ = q * hs / px;
  vPx = px;
  gl_Position = vec4(p + q * hs * 2.0 / view.xy, 0.0, 1.0);
}
`;
const GL_DUST_FS = `
in vec2 vQ; in float vI; in float vPx; in float vB;
out vec4 o;
void main() {
  float aa = 1.0 / vPx;
  float d = length(vQ);
  float a = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d);
  float halo = vB * 0.22 * exp(-0.45 * d * d);
  o = vec4(vec3(0.74, 0.78, 0.83) * (vI * a + halo), 1.0);
}
`;
const GL_HEADP_VS = `
out vec2 vQ; out float vKind;
void main() {
  int kind = gl_VertexID / 6;
  vec2 q = corner(gl_VertexID - kind * 6);
  float n = counts.z;
  float hb = timev.y;
  float y = bin(int(floor(hb)), 0).x;
  float xb = hb / (n - 1.0);
  vec3 pw = worldRot() * vec3(2.0 * xb - 1.0, y, 0.0) * view.w;
  vec4 cl = project(pw, kind == 0 ? 1.8 : 1.0);
  vec2 ndc = cl.xy / cl.w * (kind == 0 ? 1.04 : 1.0);
  vec2 hs = kind == 0 ? vec2(0.45, 26.0 / view.y) : vec2(40.0 / view.x, 40.0 / view.y);
  vQ = q; vKind = float(kind);
  gl_Position = vec4(ndc + q * hs, 0.0, 1.0);
}
`;
const GL_HEADP_FS = `
in vec2 vQ; in float vKind;
out vec4 o;
void main() {
  vec3 lab = mix(palA[0].xyz, palB[0].xyz, timev.z);
  vec3 tint = mix(vec3(0.74, 0.78, 0.83), encodeSrgb(max(oklabToLinear(lab), 0.0)), 0.4);
  float act = (0.25 + 0.75 * fx2.w);
  if (vKind < 0.5) {
    float core = exp(-vQ.y * vQ.y * 9.0) * pow(max(1.0 - vQ.x * vQ.x, 0.0), 3.0);
    float hot = exp(-(vQ.x * vQ.x * 40.0 + vQ.y * vQ.y * 12.0));
    o = vec4(tint * (core * 0.55 + hot) * (0.025 + 0.04 * fx.y + 0.1 * fx2.x) * act, 1.0);
  } else {
    float d2 = dot(vQ, vQ);
    float core = exp(-d2 * 60.0);
    float halo = exp(-d2 * 7.0) * max(1.0 - d2, 0.0);
    o = vec4((vec3(0.95, 0.96, 0.98) * core * 0.85 + tint * halo * 0.16) * (0.55 + 0.6 * fx2.x + 0.25 * fx.y) * act, 1.0);
  }
}
`;
const GL_SPARK_VS = `
out float vI; out float vK; out vec2 vQ;
float h1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  int id = gl_VertexID / 6;
  vec2 q = corner(gl_VertexID - id * 6);
  int ev = id / SPARK_P;
  vec4 e = texelFetch(uHist, ivec2(ev, 2), 0);
  float fid = float(id);
  float tau = timev.w - e.z;
  float life = 0.26 + 0.3 * h1(fid * 1.7 + e.z);
  float s = abs(e.w);
  vQ = q; vI = 0.0; vK = 0.0;
  if (s <= 0.0 || tau < 0.0 || tau > life) { gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
  float ang = h1(fid * 3.1 + e.z * 7.0) * TAU;
  float sp = (0.12 + 0.5 * h1(fid * 5.3 + e.z)) * (0.55 + 0.45 * s);
  vec2 v = vec2(cos(ang) * 0.8, sin(ang) * 0.5 + sign(e.w) * 0.3) * sp;
  vec2 g = vec2(0.0, -0.9);
  vec2 p = e.xy + v * tau + 0.5 * g * tau * tau;
  vec2 pt = p - (v + g * tau) * 0.024;
  mat3 m = worldRot();
  vec4 c0 = project(m * vec3(p, 0.02) * view.w, 1.0);
  vec4 c1 = project(m * vec3(pt, 0.02) * view.w, 1.0);
  vec2 a = c0.xy / c0.w, b = c1.xy / c1.w;
  vec2 dp = (a - b) * view.xy;
  vec2 t = length(dp) > 1e-3 ? normalize(dp) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-t.y, t.x);
  float px = 0.8 * max(1.0, view.y / 1000.0);
  vec2 pos = mix(b, a, q.x * 0.5 + 0.5) + (nrm * q.y + t * q.x) * px * 2.0 / view.xy;
  gl_Position = vec4(pos, 0.0, 1.0);
  float k = 1.0 - tau / life;
  vK = k;
  vI = s * k * k * (0.6 + 0.4 * h1(fid * 9.1));
}
`;
const GL_SPARK_FS = `
in float vI; in float vK; in vec2 vQ;
out vec4 o;
void main() {
  vec3 lab = mix(palA[0].xyz, palB[0].xyz, timev.z);
  vec3 tint = encodeSrgb(max(oklabToLinear(lab), 0.0));
  vec3 col = mix(tint, vec3(1.0, 0.96, 0.88), vK);
  float along = 0.3 + 0.7 * (vQ.x * 0.5 + 0.5);
  float across = 1.0 - vQ.y * vQ.y;
  o = vec4(col * vI * along * across * 1.4, 1.0);
}
`;
function program(gl, kind) {
  const def = kind === "glow" ? "#define GLOW 1\n" : kind === "ghost" ? "#define GHOST 1\n" : "";
  const body = kind === "dust" ? [GL_DUST_VS, GL_DUST_FS] : kind === "spark" ? [GL_SPARK_VS, GL_SPARK_FS] : kind === "head" ? [GL_HEADP_VS, GL_HEADP_FS] : [GL_TRACE_VS, GL_TRACE_FS];
  return compileProgram(gl, GL_HEAD + def + GL_VS_LIB + body[0], GL_HEAD + def + GL_FS_LIB + body[1], "traza/" + kind);
}

export class Traza {
  constructor(gl, palette) {
    this.gl = gl;
    this.U = new Float32Array(K.FLOATS);
    this.H = new Float32Array(K.N * 4 * 3);
    this.progs = {};
    for (const k of ["dust", "ghost", "glow", "trace", "spark", "head"]) this.progs[k] = program(gl, k);
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferData(gl.UNIFORM_BUFFER, this.U.byteLength, gl.DYNAMIC_DRAW);
    for (const p of Object.values(this.progs)) {
      const i = gl.getUniformBlockIndex(p, "Frame");
      if (i !== gl.INVALID_INDEX) gl.uniformBlockBinding(p, i, 0);
      gl.useProgram(p);
      const loc = gl.getUniformLocation(p, "uHist");
      if (loc) gl.uniform1i(loc, 0);
    }
    this.tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, K.N, 3, 0, gl.RGBA, gl.FLOAT, this.H);
    this.vao = gl.createVertexArray();
    const sw0 = K.SWEEP;
    this.E = {
      springs: BANDS.map((_, i) => ({ x: i === 3 ? 0.5 : 0, v: 0 })), quiet: { x: 1, v: 0 }, play: { x: 1, v: 0 }, sw: { x: sw0, v: 0 },
      sweepTarget: sw0, bpm: 0, hb: 0, t: 0, tm: 0, onsets: [], pulses: [],
      prev: { y: 0, trail: 0, bright: 0, thick: 0 }, toneHold: 0.5, beats: 0, sparkI: 0, lastSpark: -10, idle: 0, dirty: true,
      palA: palette, palB: palette, palT0: -10, outs: [0, 0, 0, 0.5], dest: new Float32Array(6),
    };
  }

  destroy() {
    const gl = this.gl;
    for (const p of Object.values(this.progs)) gl.deleteProgram(p);
    gl.deleteBuffer(this.ubo);
    gl.deleteTexture(this.tex);
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

  /// Salidas de los resortes (para los medidores del panel).
  meters() { return this.E.outs; }

  pulseAt(t) {
    let y = 0;
    for (const p of this.E.pulses) y += qrs(t - p.t0) * p.s;
    return y * K.PULSE_Y;
  }

  tempoFromOnset(t) {
    const E = this.E;
    E.onsets.push(t);
    if (E.onsets.length > 13) E.onsets.shift();
    const iv = [];
    for (let i = 1; i < E.onsets.length; i++) { const d = E.onsets[i] - E.onsets[i - 1]; if (d > 0.25 && d < 1.5) iv.push(d); }
    if (iv.length < 4) return;
    iv.sort((a, b) => a - b);
    const tb = iv[iv.length >> 1];
    let best = 0, bestD = 1e9;
    for (const k of [2, 4, 8, 16]) { const s = k * tb; if (s >= 3 && s <= 6 && Math.abs(s - 4.4) < bestD) { best = s; bestD = Math.abs(s - 4.4); } }
    if (best) { E.sweepTarget = best; let bpm = 60 / tb; while (bpm < 70) bpm *= 2; while (bpm > 180) bpm /= 2; E.bpm = bpm; }
  }

  /// Un frame. `f` = { t, dt, tPrev, playing, feed, cfg, cw, ch }. Devuelve
  /// true si ya no queda movimiento pendiente (el render puede pararse).
  frame(f) {
    const E = this.E, gl = this.gl, U = this.U, H = this.H, N = K.N, cfg = f.cfg, bands = cfg.bands;
    const { t, dt, tPrev, playing, feed } = f;
    E.t = t;
    const h = playing ? feed.delayed(t) : null;
    const del = h ? h.v : ZERO;

    // ataques (detectados por el motor sobre la señal adelantada) → pulsos
    // programados para el instante en que suene el golpe
    for (const o of feed.takeOnsets()) {
      if (!playing) continue;
      if (o.b === 0) E.beats = (E.beats + 1) % 997;
      const B = bands[o.b];
      if (B.routes.includes("pulso")) E.pulses.push({ t0: o.t + feed.la - 0.02, s: o.s * B.amp });
      if (o.b === 0) this.tempoFromOnset(o.t);
    }
    E.pulses = E.pulses.filter((p) => t - p.t0 < 0.4);

    springStep(E.quiet, !playing || Math.max(del[0], del[1], del[2]) < 0.05 ? 1 : 0, OMEGA(K.QUIET_T90), dt);
    const q = clamp(E.quiet.x, 0, 1);
    for (let b = 0; b < 4; b++) {
      const B = bands[b];
      if (b === 3 && Math.abs(del[3] - E.toneHold) > 0.025) E.toneHold = del[3];
      const x = b === 3 ? E.toneHold + (0.5 - E.toneHold) * q : del[b];
      const target = Math.pow(clamp(b === 3 ? x : x * B.sens, 0, 1), B.gamma);
      const sp = E.springs[b];
      springStep(sp, target, OMEGA(Math.max((target > sp.x ? B.att : B.rel) / 1000, 0.003)), dt);
      E.outs[b] = sp.x;
    }
    const d = E.dest;
    d.fill(0);
    for (let b = 0; b < 4; b++) {
      const B = bands[b];
      for (const key of B.routes) {
        const j = DI[key];
        if (key === "pulso") continue;
        let v = E.outs[b];
        if (key === "altura") v = b === 3 ? (clamp(0.5 + (E.outs[3] - 0.5) * B.sens, 0, 1) - 0.5) * 2 : v;
        d[j] += v * B.amp * DESTS[j].bound;
      }
    }
    for (let j = 0; j < 6; j++) d[j] = clamp(d[j], DESTS[j].min, DESTS[j].bound);

    if (playing) E.idle = 0; else E.idle += dt;
    springStep(E.play, playing || !cfg.pauseIdle || E.idle < K.IDLE_S ? 1 : 0, OMEGA(K.STOP_T90), dt);
    const p = clamp(E.play.x, 0, 1);
    E.tm += dt * p;
    const swTarget = cfg.syncTempo && E.bpm ? E.sweepTarget : cfg.sweep || K.SWEEP;
    springStep(E.sw, swTarget, OMEGA(2), dt);
    const sweep = clamp(E.sw.x, 1.5, 10);

    // escritura de los bins que cruza la cabeza en este frame
    const cur = { y: d[0] * K.Y_MAX, trail: d[2], bright: d[4], thick: d[3] };
    const hb0 = E.hb, hb1 = E.hb + (dt * p * N) / sweep;
    const i0 = Math.floor(hb0) + 1, i1 = Math.floor(hb1);
    for (let k = i0; k <= i1; k++) {
      const fr = (k - hb0) / Math.max(1e-9, hb1 - hb0);
      const tb = tPrev + fr * dt;
      const lerp = (a, b) => a + (b - a) * fr;
      const idx = ((k % N) + N) % N, o0 = idx * 4, o1 = (N + idx) * 4;
      H[o1 + 2] = H[o1]; H[o1 + 3] = H[o1 + 1] * 0.85;
      H[o1] = H[o0]; H[o1 + 1] = H[o0 + 1] * 0.85;
      H[o0] = clamp(lerp(E.prev.y, cur.y) + this.pulseAt(tb), -0.6, 0.6);
      H[o0 + 1] = lerp(E.prev.trail, cur.trail);
      H[o0 + 2] = lerp(E.prev.bright, cur.bright);
      H[o0 + 3] = lerp(E.prev.thick, cur.thick);
      E.dirty = true;
      if (idx >= 4) {
        const yb = H[(idx - 4) * 4], jump = H[o0] - yb;
        if (Math.abs(jump) > K.SPARK_JUMP && tb - E.lastSpark > 0.07) {
          E.lastSpark = tb;
          const so = (2 * N + E.sparkI) * 4;
          H[so] = (2 * idx) / (N - 1) - 1; H[so + 1] = (H[o0] + yb) / 2; H[so + 2] = tb;
          H[so + 3] = Math.sign(jump) * clamp(Math.abs(jump) / 0.22, 0.35, 1);
          E.sparkI = (E.sparkI + 1) % K.SPARK_N;
        }
      }
    }
    E.prev = cur;
    E.hb = hb1 >= N ? hb1 - N : hb1;

    const breath = K.BREATH_A * q * p * (0.5 - 0.5 * Math.cos((TAU * E.tm) / K.BREATH_T));
    const yaw = 0.04 * Math.sin((TAU * E.tm) / 16) * (0.35 + 0.65 * q);
    const dx = 0.012 * Math.sin((TAU * E.tm) / 23) * (0.5 + 0.5 * q);
    const dy = 0.008 * Math.sin((TAU * E.tm) / 17 + 1) * (0.5 + 0.5 * q);
    const k = easeInOutCubic(clamp((t - E.palT0) / K.PAL_FADE, 0, 1));
    const { cw, ch } = f;
    const aspect = cw / ch, fl = 1 / Math.tan((K.FOV_DEG * Math.PI) / 360);
    const R = (aspect < 1 ? 0.9 : K.WIDTH_FRAC) * aspect * K.CAM_D / fl;
    U[0] = E.outs[0]; U[1] = E.outs[1]; U[2] = E.outs[2]; U[3] = E.outs[3];
    U[4] = d[3]; U[5] = d[4]; U[6] = d[5]; U[7] = d[2];
    U[8] = clamp(Math.abs(this.pulseAt(t)) / K.PULSE_Y, 0, 1); U[9] = q; U[10] = breath; U[11] = p;
    U[12] = E.tm; U[13] = E.hb; U[14] = k; U[15] = t;
    U[16] = cw; U[17] = ch; U[18] = aspect; U[19] = R;
    U[20] = K.CAM_D; U[21] = fl; U[22] = K.TILT; U[23] = yaw;
    U[24] = dx; U[25] = dy; U[26] = K.NEAR; U[27] = K.FAR;
    U[28] = E.palA.length; U[29] = E.palB.length; U[30] = N; U[31] = E.beats;
    for (let i = 0; i < 5; i++) {
      const a = E.palA[i] || ZERO, b = E.palB[i] || ZERO;
      U[32 + i * 4] = a[0] || 0; U[33 + i * 4] = a[1] || 0; U[34 + i * 4] = a[2] || 0; U[35 + i * 4] = 0;
      U[52 + i * 4] = b[0] || 0; U[53 + i * 4] = b[1] || 0; U[54 + i * 4] = b[2] || 0; U[55 + i * 4] = 0;
    }
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, U);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.ubo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (E.dirty) { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 3, gl.RGBA, gl.FLOAT, H); E.dirty = false; }
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); blendAdditive(gl);
    gl.useProgram(this.progs.dust); gl.drawArrays(gl.TRIANGLES, 0, K.DUST_N * 6);
    gl.useProgram(this.progs.ghost); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, N * 2, 2);
    gl.useProgram(this.progs.glow); gl.drawArrays(gl.TRIANGLE_STRIP, 0, N * 2);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); blendOver(gl);
    gl.useProgram(this.progs.trace); gl.drawArrays(gl.TRIANGLE_STRIP, 0, N * 2);
    gl.disable(gl.DEPTH_TEST); blendAdditive(gl);
    gl.useProgram(this.progs.spark); gl.drawArrays(gl.TRIANGLES, 0, K.SPARK_N * K.SPARK_P * 6);
    gl.useProgram(this.progs.head); gl.drawArrays(gl.TRIANGLES, 0, 12);

    return t - E.lastSpark > 0.7 && p < 0.002 && Math.abs(E.play.v) < 0.01 && k >= 1 &&
      E.springs.every((s, i) => Math.abs(s.x - (i === 3 ? 0.5 : 0)) < 0.003 && Math.abs(s.v) < 0.01);
  }
}
