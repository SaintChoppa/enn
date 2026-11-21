import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SPRINGS,
  springValue,
  springLinear,
  setMotionLevel,
  motionLevel,
  spring,
  cssTokens,
  FEELS,
  DEFAULT_FEEL,
  feelOf,
  setFeel,
  feelSprings,
  originFor,
  rollPlan,
  whenDone,
  occurrenceKeys,
  flipPlan,
  staggerDelay,
  tabDir,
  FADE_MS,
  stillKeyframes,
  syncStill,
} from "../motion.js";

const SUAVE = "cubic-bezier(0.23, 1, 0.32, 1)";

// sobrepaso máximo (valor máximo - 1) muestreando finamente
function overshoot(bounce) {
  let max = 0;
  for (let i = 0; i <= 2000; i++) max = Math.max(max, springValue(i / 2000, bounce) - 1);
  return max;
}

const noReduce = () => ({ matches: false });
const reduce = () => ({ matches: true });

test("springValue(0) es 0 y el último punto es 1", () => {
  for (const [name, s] of Object.entries(SPRINGS)) {
    assert.equal(springValue(0, s.bounce), 0, name);
    assert.equal(springValue(1, s.bounce), 1, name);
    const css = springLinear(s);
    assert.ok(css.endsWith(", 1)") || css.endsWith("1)"), name);
  }
});

test("el sobrepaso crece con bounce y respeta los topes", () => {
  const sn = overshoot(SPRINGS.snappy.bounce);
  const bo = overshoot(SPRINGS.bouncy.bounce);
  const el = overshoot(SPRINGS.elastic.bounce);
  assert.ok(sn > 0 && sn < 0.06, `snappy ${sn}`);
  assert.ok(sn < bo && bo < el, `${sn} < ${bo} < ${el}`);
  assert.ok(el > 0.1, `elastic ${el}`);
});

test("bounce 0 nunca supera 1", () => {
  for (let i = 0; i <= 1000; i++) {
    assert.ok(springValue(i / 1000, 0) <= 1 + 1e-9);
  }
});

test("springLinear devuelve linear(0 … 1) con números finitos", () => {
  const css = springLinear(SPRINGS.bouncy);
  assert.ok(css.startsWith("linear(0"), css);
  assert.ok(css.endsWith("1)"), css);
  const nums = css.slice("linear(".length, -1).split(",").map((s) => Number(s.trim()));
  assert.ok(nums.length >= 10);
  for (const n of nums) assert.ok(Number.isFinite(n), String(n));
});

test("motion.css coincide con el generador", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "motion.css"), "utf8");
  // solo el bloque :root base (el primero)
  const base = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
  for (const name of ["snappy", "bouncy", "elastic"]) {
    const m = base.match(new RegExp(`--spring-${name}:\\s*([^;]+);`));
    assert.ok(m, `falta --spring-${name}`);
    // el bloque base lleva los muelles del carácter por defecto
    assert.equal(m[1].trim(), springLinear(feelSprings(DEFAULT_FEEL)[name]), name);
    const ms = base.match(new RegExp(`--spring-${name}-ms:\\s*([^;]+);`));
    assert.equal(ms[1].trim(), `${SPRINGS[name].duration}ms`);
  }
  assert.ok(css.includes(cssTokens().trim().split("\n")[0]));
});

test("setMotionLevel / motionLevel", () => {
  const root = { dataset: {} };
  assert.equal(motionLevel(root, noReduce), "completas");
  setMotionLevel("suaves", root);
  assert.equal(root.dataset.motion, "suaves");
  assert.equal(motionLevel(root, noReduce), "suaves");
  setMotionLevel("loquesea", root);
  assert.equal(root.dataset.motion, "completas");
  setMotionLevel("minimas", root);
  assert.equal(motionLevel(root, noReduce), "minimas");
  // el sistema pide reducir movimiento: gana sobre lo guardado
  setMotionLevel("completas", root);
  assert.equal(motionLevel(root, reduce), "minimas");
});

function fakeEl() {
  const calls = [];
  return {
    calls,
    animate(kf, o) {
      calls.push({ kf, o });
      return { fake: true };
    },
  };
}

test("spring(): completas usa duración y curva del muelle", () => {
  const root = { dataset: { motion: "completas" } };
  const el = fakeEl();
  const kf = [{ opacity: 0 }, { opacity: 1 }];
  const anim = spring(el, kf, "bouncy", { root, matchMedia: noReduce });
  assert.deepEqual(anim, { fake: true });
  assert.equal(el.calls[0].kf, kf);
  assert.equal(el.calls[0].o.duration, SPRINGS.bouncy.duration);
  assert.equal(el.calls[0].o.easing, springLinear(feelSprings(DEFAULT_FEEL).bouncy));
});

test("spring(): suaves = 0,8x y curva sin sobrepaso", () => {
  const el = fakeEl();
  spring(el, [], "elastic", { root: { dataset: { motion: "suaves" } }, matchMedia: noReduce });
  assert.equal(el.calls[0].o.duration, SPRINGS.elastic.duration * 0.8);
  assert.equal(el.calls[0].o.easing, SUAVE);
});

// ---------------------------------------------------------------- Sprint 4, T7: Mínimas y reducir movimiento

const MOVES = /transform|translate|scale|rotate/i;
const moves = (kf) => kf.some((f) => Object.keys(f).some((k) => MOVES.test(k)));

test("stillKeyframes quita todo desplazamiento y deja la opacidad", () => {
  const kf = [
    { opacity: 0, transform: "translateY(6px) scale(0.98)", transformOrigin: "top left", offset: 0 },
    { opacity: 1, transform: "none", scale: "1", translate: "0", rotate: "0deg" },
  ];
  const out = stillKeyframes(kf);
  assert.ok(!moves(out), JSON.stringify(out));
  assert.deepEqual(out, [{ opacity: 0, offset: 0 }, { opacity: 1 }]);
});

test("Mínimas y reducir movimiento: spring() es un fundido de 300 ms sin desplazamiento", () => {
  for (const [root, mm] of [
    [{ dataset: { motion: "minimas" } }, noReduce],
    [{ dataset: { motion: "completas" } }, reduce],
  ]) {
    const el = fakeEl();
    spring(el, [{ opacity: 0, transform: "translateX(14px)" }, { opacity: 1, transform: "none" }], "bouncy", { root, matchMedia: mm, delay: 120, fill: "backwards" });
    const { kf, o } = el.calls[0];
    assert.ok(!moves(kf), JSON.stringify(kf));
    assert.equal(o.duration, FADE_MS);
    assert.equal(FADE_MS, 300);
    assert.equal(o.delay, 0, "sin escalonado");
    assert.equal(o.fill, "backwards");
    assert.ok(!/linear\(/.test(o.easing), "sin rebote");
  }
});

test("Mínimas: una salida con duración propia la conserva (su tope sigue valiendo)", () => {
  const el = fakeEl();
  spring(el, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.97)" }], "snappy", { root: { dataset: { motion: "minimas" } }, matchMedia: noReduce, duration: 110 });
  assert.equal(el.calls[0].o.duration, 110);
  assert.ok(!moves(el.calls[0].kf));
});

test("Mínimas: lo que solo se mueve (FLIP, pulsación) no anima nada", () => {
  const el = fakeEl();
  spring(el, [{ transform: "translate(0, 40px)" }, { transform: "none" }], "bouncy", { root: { dataset: { motion: "minimas" } }, matchMedia: noReduce });
  assert.deepEqual(el.calls[0].kf, []);
  assert.equal(el.calls[0].o.duration, 0);
});

test("syncStill marca data-still con Mínimas o con reducir movimiento", () => {
  const root = { dataset: { motion: "minimas" } };
  syncStill(root, noReduce);
  assert.equal(root.dataset.still, "1");
  root.dataset.motion = "completas";
  syncStill(root, noReduce);
  assert.ok(!("still" in root.dataset));
  syncStill(root, reduce);
  assert.equal(root.dataset.still, "1");
});

test("las fichas de Mínimas son fundidos, no cortes de 1 ms", () => {
  const css = cssTokens();
  const block = (sel) => {
    const i = css.indexOf(sel);
    return css.slice(i, css.indexOf("}", i));
  };
  for (const b of [block(':root[data-motion="minimas"] {'), block("@media (prefers-reduced-motion: reduce) {")]) {
    assert.ok(!/\b1ms\b/.test(b), b);
    assert.match(b, /--t-base: 300ms;/);
    assert.match(b, /--spring-snappy-ms: 300ms;/);
    assert.match(b, /--mk: 0;/);
  }
  assert.match(block(":root {"), /--mk: 1;/);
});

test("styles.css: toda animación de entrada que mueve escala su movimiento con --mk", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");
  // indicadores de estado (giran o miden) y las del cambio de modo, que en
  // Mínimas no se usan (allí el cambio es un fundido)
  // reco-timer es la cuenta atrás de la tarjeta (su final la cierra, reco.js)
  const funcional = /^(spin|pv-spin|reco-timer|bar-(scan|wave|shine|finish)|mode-(in|out)-[xy]|mode-root-in)$/;
  const re = /@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g;
  let m;
  let n = 0;
  while ((m = re.exec(css))) {
    const [, name, body] = m;
    if (funcional.test(name) || !MOVES.test(body)) continue;
    n++;
    assert.match(body, /var\(--mk\)/, `@keyframes ${name} se mueve también en Mínimas`);
  }
  assert.ok(n >= 10, `solo ${n} animaciones revisadas`);
  // y las transiciones CSS no animan transform en Mínimas ni con reducir movimiento
  assert.match(css, /:root\[data-still\] \*,[\s\S]*?transition-property: opacity[^;]*!important;/);
  assert.ok(!/transition-property:[^;]*transform[^;]*!important/.test(css));
  // los bloques sueltos de «reducir movimiento» pasan a [data-still] (valen
  // también para Mínimas); solo queda el del visualizador
  const media = css.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? [];
  assert.equal(media.length, 1, `quedan ${media.length} bloques de reducir movimiento`);
});

test("spring(): kind desconocido -> snappy y opts se respetan", () => {
  const el = fakeEl();
  spring(el, [], "nope", {
    root: { dataset: {} },
    matchMedia: noReduce,
    fill: "forwards",
    delay: 30,
  });
  const o = el.calls[0].o;
  assert.equal(o.duration, SPRINGS.snappy.duration);
  assert.equal(o.easing, springLinear(feelSprings(DEFAULT_FEEL).snappy));
  assert.equal(o.fill, "forwards");
  assert.equal(o.delay, 30);
  assert.ok(!("root" in o) && !("matchMedia" in o));
});

// ---------------------------------------------------------------- Sprint 4, T1: carácter

test("hay tres caracteres y el rebote al soltar crece de suave a elástico", () => {
  assert.deepEqual(Object.keys(FEELS), ["suave", "medio", "elastico"]);
  const o = Object.values(FEELS).map((f) => overshoot(f.release.bounce));
  assert.ok(o[0] < o[1] && o[1] < o[2], o.join(" < "));
  // suave casi no rebota; elástico se nota sin pasarse
  assert.ok(o[0] < 0.04, `suave ${o[0]}`);
  assert.ok(o[2] > 0.15 && o[2] < 0.3, `elástico ${o[2]}`);
  assert.ok(FEELS[DEFAULT_FEEL], DEFAULT_FEEL);
});

test("feelOf / setFeel: desconocido o ausente -> el carácter por defecto", () => {
  const root = { dataset: {} };
  assert.equal(feelOf(root), DEFAULT_FEEL);
  setFeel("elastico", root);
  assert.equal(root.dataset.feel, "elastico");
  assert.equal(feelOf(root), "elastico");
  setFeel("loquesea", root);
  assert.equal(root.dataset.feel, DEFAULT_FEEL);
});

test("feelSprings escala el rebote de los tres muelles sin tocar la duración", () => {
  const s = feelSprings("suave");
  const e = feelSprings("elastico");
  for (const n of Object.keys(SPRINGS)) {
    assert.equal(s[n].duration, SPRINGS[n].duration, n);
    assert.ok(s[n].bounce < SPRINGS[n].bounce && SPRINGS[n].bounce < e[n].bounce, n);
    assert.ok(e[n].bounce < 0.8, n);
  }
  assert.deepEqual(feelSprings("medio"), SPRINGS);
});

test("spring(): el carácter del nodo cambia la curva", () => {
  const el = fakeEl();
  spring(el, [], "bouncy", { root: { dataset: { feel: "elastico" } }, matchMedia: noReduce });
  assert.equal(el.calls[0].o.easing, springLinear(feelSprings("elastico").bouncy));
});

test("motion.css contiene exactamente el bloque generado", () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "motion.css"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(css.includes(cssTokens()), "regenera motion.css con cssTokens()");
  for (const f of Object.keys(FEELS)) assert.ok(css.includes(`[data-feel="${f}"]`), f);
  // reducir movimiento gana también sobre un nivel o un carácter guardados
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*:root, :root\[data-motion\], \[data-feel\] \{/);
});

// ---------------------------------------------------------------- Sprint 4, T3: controles

test("originFor: el menú nace del punto del clic, también si se dio la vuelta", () => {
  const rect = { left: 100, top: 200, width: 210, height: 120 };
  // menú abierto hacia abajo y a la derecha del clic
  assert.equal(originFor({ x: 100, y: 200 }, rect), "0px 0px");
  // no cabía: quedó arriba a la izquierda del clic
  assert.equal(originFor({ x: 310, y: 320 }, rect), "210px 120px");
  // el punto fuera del menú se recorta a su borde
  assert.equal(originFor({ x: 50, y: 500 }, rect), "0px 120px");
});

test("rollPlan: solo ruedan los dígitos que cambian, hacia el lado del cambio", () => {
  assert.deepEqual(rollPlan("12", "13"), [{ ch: "1", roll: 0 }, { ch: "3", roll: 1 }]);
  assert.deepEqual(rollPlan("5", "4"), [{ ch: "4", roll: -1 }]);
  // cambia la longitud: el dígito nuevo también entra rodando
  assert.deepEqual(rollPlan("9", "10"), [{ ch: "1", roll: 1 }, { ch: "0", roll: 1 }]);
  // lo que no es número se compara carácter a carácter y no rueda
  assert.deepEqual(rollPlan("", "3"), [{ ch: "3", roll: 0 }]);
  assert.deepEqual(rollPlan("7", "7"), [{ ch: "7", roll: 0 }]);
});

test("whenDone: termina con la animación o con el tope, una sola vez", async () => {
  // animación que nunca acaba (ventana oculta): manda el tope
  let n = 0;
  whenDone({ onfinish: null }, 20, () => n++);
  // el tope es ms + 50
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(n, 1);
  // acaba antes del tope: una sola llamada
  const a = { onfinish: null };
  let m = 0;
  whenDone(a, 30, () => m++);
  a.onfinish();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(m, 1);
});

// ---------------------------------------------------------------- Sprint 4, T4: listas

test("occurrenceKeys: la misma canción dos veces en la cola tiene dos claves", () => {
  assert.deepEqual(occurrenceKeys(["a", "b", "a", "a"]), ["a#0", "b#0", "a#1", "a#2"]);
  assert.deepEqual(occurrenceKeys([]), []);
});

test("flipPlan: lo que se movió, lo que entra y lo que sale", () => {
  const r = (top, left = 0) => ({ top, left, width: 100, height: 40 });
  const before = new Map([["a#0", r(0)], ["b#0", r(40)], ["c#0", r(80)]]);
  // «a» se quitó: «b» y «c» suben; entra «d»
  const after = new Map([["b#0", r(0)], ["c#0", r(40)], ["d#0", r(80)]]);
  const p = flipPlan(before, after);
  assert.deepEqual(p.moves, [{ key: "b#0", dx: 0, dy: 40 }, { key: "c#0", dx: 0, dy: 40 }]);
  assert.deepEqual(p.enters, ["d#0"]);
  assert.deepEqual(p.exits, ["a#0"]);
  // sin cambios (o menos de 1 px): no se anima nada
  const same = flipPlan(after, new Map([["b#0", r(0.4)], ["c#0", r(40)], ["d#0", r(80)]]));
  assert.deepEqual(same, { moves: [], enters: [], exits: [] });
});

test("staggerDelay: 40 ms entre filas y solo las primeras", () => {
  assert.equal(staggerDelay(0), 0);
  assert.equal(staggerDelay(3), 120);
  // más allá del tope la fila aparece sin escalonado (null = no animar)
  assert.equal(staggerDelay(12), null);
  assert.equal(staggerDelay(2, 25, 2), null);
});

test("tabDir: el contenido entra desde el lado de la pestaña", () => {
  const order = ["all", "artist", "albums", "genre"];
  assert.equal(tabDir(order, "all", "albums"), 1);
  assert.equal(tabDir(order, "genre", "artist"), -1);
  assert.equal(tabDir(order, "all", "all"), 0);
  assert.equal(tabDir(order, "x", "all"), 0);
});
