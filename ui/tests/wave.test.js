import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, waveOrigin, waveRadius, createWave, QUICK_MS } from "../wave.js";

const ctx = { w: 1000, h: 600, art: { x: 300, y: 250 }, radio: { x: 520, y: 340 } };

test("waveOrigin: cada causa nace de su sitio", () => {
  assert.deepEqual(waveOrigin("ended", ctx), { x: 300, y: 250, reverse: false });
  assert.deepEqual(waveOrigin("next", ctx), { x: 1040, y: 300, reverse: false });
  assert.deepEqual(waveOrigin("prev", ctx), { x: -40, y: 300, reverse: false });
  assert.deepEqual(waveOrigin("click", { ...ctx, point: { x: 77, y: 88 } }), { x: 77, y: 88, reverse: false });
  assert.deepEqual(waveOrigin("download", { ...ctx, point: { x: 10, y: 20 } }), { x: 10, y: 20, reverse: false });
  assert.deepEqual(waveOrigin("radio", ctx), { x: 520, y: 340, reverse: false });
  assert.deepEqual(waveOrigin("reco", ctx), { x: 1000, y: 600, reverse: false });
  // pausa: al revés, el color se retira hacia la carátula
  assert.deepEqual(waveOrigin("pause", ctx), { x: 300, y: 250, reverse: true });
  // «otros» alterna arriba y abajo
  assert.deepEqual(waveOrigin("other", { ...ctx, flip: false }), { x: 500, y: 640, reverse: false });
  assert.deepEqual(waveOrigin("other", { ...ctx, flip: true }), { x: 500, y: -40, reverse: false });
});

test("waveOrigin: sin carátula, sin radio o sin punto, el centro", () => {
  const bare = { w: 1000, h: 600 };
  assert.deepEqual(waveOrigin("ended", bare), { x: 500, y: 300, reverse: false });
  assert.deepEqual(waveOrigin("radio", bare), { x: 500, y: 300, reverse: false });
  assert.deepEqual(waveOrigin("click", bare), { x: 500, y: 300, reverse: false });
  assert.deepEqual(waveOrigin("loquesea", bare), { x: 500, y: 640, reverse: false });
});

test("waveRadius llega a la esquina más lejana", () => {
  assert.equal(Math.round(waveRadius(0, 0, 300, 400)), 500);
  assert.equal(Math.round(waveRadius(150, 200, 300, 400)), 250);
  assert.equal(Math.round(waveRadius(-40, 300, 1000, 600)), Math.round(Math.hypot(1040, 300)));
});

test("decide: cuándo hay ola", () => {
  const ok = { same: false, hidden: false, mini: false, level: "completas", supported: true, degraded: false, sinceLast: 5000 };
  assert.equal(decide(ok), "wave");
  assert.equal(decide({ ...ok, level: "suaves" }), "wave");
  assert.equal(decide({ ...ok, same: true }), "skip");
  for (const k of [{ hidden: true }, { mini: true }, { level: "minimas" }, { supported: false }, { degraded: true }, { busy: true }, { sinceLast: QUICK_MS - 1 }]) {
    assert.equal(decide({ ...ok, ...k }), "plain", JSON.stringify(k));
  }
});

// ---------------------------------------------------------------- controlador con un documento falso

function fakeEnv() {
  const classes = new Set();
  const vars = new Map();
  const log = { started: 0, skipped: 0, animated: 0 };
  let clock = 0;
  const transitions = [];
  const doc = {
    visibilityState: "visible",
    documentElement: {
      classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
      style: { setProperty: (k, v) => vars.set(k, v), removeProperty: (k) => vars.delete(k) },
      animate() {
        log.animated++;
        return { finished: Promise.resolve(), cancel() {} };
      },
    },
    startViewTransition(cb) {
      log.started++;
      let done;
      const finished = new Promise((r) => (done = r));
      const t = {
        ready: Promise.resolve(),
        finished,
        updateCallbackDone: Promise.resolve(cb()),
        skipTransition() {
          log.skipped++;
          done();
        },
        end: () => done(),
      };
      transitions.push(t);
      return t;
    },
  };
  let applied = null;
  const wave = createWave({
    doc,
    apply: (p) => (applied = p),
    keyOf: (p) => p.key,
    now: () => clock,
    context: () => ctx,
    mini: () => false,
    level: () => "completas",
    storage: { get: () => null, set() {} },
  });
  return {
    wave,
    doc,
    classes,
    vars,
    log,
    transitions,
    get applied() { return applied; },
    tick(ms) { clock += ms; },
  };
}

test("10 cambios en 2 s: termina con la paleta de la última y sin restos", async () => {
  const e = fakeEnv();
  e.tick(10_000);
  for (let i = 0; i < 10; i++) {
    e.wave.change({ key: `p${i}` }, { cause: "next" });
    e.tick(200);
  }
  assert.equal(e.applied.key, "p9");
  // cada ola nueva salta la anterior en vez de esperar a que acabe
  assert.ok(e.log.skipped >= 1, `saltadas ${e.log.skipped}`);
  for (const t of e.transitions) t.end();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.classes.size, 0, [...e.classes].join());
});

test("skip(): la ola en curso termina ya y no deja clases", () => {
  const e = fakeEnv();
  e.tick(10_000);
  e.wave.change({ key: "a" }, { cause: "next" });
  assert.ok(e.classes.has("wave-on"));
  e.wave.skip();
  assert.equal(e.log.skipped, 1);
  assert.equal(e.classes.size, 0);
  assert.equal(e.applied.key, "a");
  e.wave.skip(); // sin ola: no hace nada
  assert.equal(e.log.skipped, 1);
});

test("cambios muy seguidos (< 300 ms): sin ola, solo el fundido", () => {
  const e = fakeEnv();
  e.tick(10_000);
  assert.equal(e.wave.change({ key: "a" }, { cause: "next" }), "wave");
  e.tick(100);
  assert.equal(e.wave.change({ key: "b" }, { cause: "next" }), "plain");
  assert.equal(e.applied.key, "b");
});

test("el mismo color no hace ola ni vuelve a aplicar", () => {
  const e = fakeEnv();
  e.tick(10_000);
  e.wave.change({ key: "a" });
  e.tick(5000);
  assert.equal(e.wave.change({ key: "a" }), "skip");
  assert.equal(e.log.started, 1);
});

test("ventana oculta o sin View Transitions: se aplica sin ola", () => {
  const e = fakeEnv();
  e.tick(10_000);
  e.doc.visibilityState = "hidden";
  assert.equal(e.wave.change({ key: "a" }), "plain");
  assert.equal(e.applied.key, "a");
  e.doc.visibilityState = "visible";
  e.doc.startViewTransition = undefined;
  e.tick(5000);
  assert.equal(e.wave.change({ key: "b" }), "plain");
  assert.equal(e.applied.key, "b");
});

test("la ola marca su origen y el sentido en el documento", async () => {
  const e = fakeEnv();
  e.tick(10_000);
  e.wave.change({ key: "a" }, { cause: "pause" });
  assert.equal(e.vars.get("--wave-x"), "300px");
  assert.equal(e.vars.get("--wave-y"), "250px");
  assert.ok(e.classes.has("wave-on") && e.classes.has("wave-rev"));
  e.transitions[0].end();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(e.classes.size, 0);
});

test("al arrancar, el plateado de partida no cuenta como cambio", () => {
  let applied = 0;
  const w = createWave({
    doc: { visibilityState: "visible", documentElement: { classList: { add() {}, remove() {} }, style: { setProperty() {} } }, startViewTransition: () => { throw new Error("no debería"); } },
    apply: () => applied++,
    keyOf: (p) => p.key,
    now: () => 10_000,
    context: () => ctx,
    mini: () => false,
    level: () => "completas",
    initial: { key: "plata" },
  });
  assert.equal(w.change({ key: "plata" }), "skip");
  assert.equal(applied, 0);
});
