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
    assert.equal(m[1].trim(), springLinear(SPRINGS[name]), name);
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
  assert.equal(el.calls[0].o.easing, springLinear(SPRINGS.bouncy));
});

test("spring(): suaves = 0,8x y curva sin sobrepaso; minimas = 1 ms", () => {
  const el = fakeEl();
  spring(el, [], "elastic", { root: { dataset: { motion: "suaves" } }, matchMedia: noReduce });
  assert.equal(el.calls[0].o.duration, SPRINGS.elastic.duration * 0.8);
  assert.equal(el.calls[0].o.easing, SUAVE);
  spring(el, [], "snappy", { root: { dataset: { motion: "minimas" } }, matchMedia: noReduce });
  assert.equal(el.calls[1].o.duration, 1);
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
  assert.equal(o.easing, springLinear(SPRINGS.snappy));
  assert.equal(o.fill, "forwards");
  assert.equal(o.delay, 30);
  assert.ok(!("root" in o) && !("matchMedia" in o));
});
