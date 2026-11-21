import { test } from "node:test";
import assert from "node:assert/strict";
import { CAP_MS, MODE_PARTS, modeKind, createModeSwitch } from "../modeswitch.js";

test("ningún nombre de transición ni selector repetido", () => {
  const names = MODE_PARTS.map(([n]) => n);
  const sels = MODE_PARTS.map(([, s]) => s);
  assert.equal(new Set(names).size, names.length, names.join());
  assert.equal(new Set(sels).size, sels.length, sels.join());
  // «root» es de la página entera: un panel no puede llevarlo
  assert.ok(!names.includes("root"));
});

test("modeKind: con teclado, oculta o sin View Transitions es instantáneo", () => {
  const ok = { animate: true, supported: true, hidden: false, level: "completas" };
  assert.equal(modeKind(ok), "move");
  assert.equal(modeKind({ ...ok, level: "suaves" }), "move");
  assert.equal(modeKind({ ...ok, level: "minimas" }), "fade");
  assert.equal(modeKind({ ...ok, animate: false }), "instant");
  assert.equal(modeKind({ ...ok, hidden: true }), "instant");
  assert.equal(modeKind({ ...ok, supported: false }), "instant");
});

// ---------------------------------------------------------------- documento falso

function fakeEnv({ stuck = false } = {}) {
  const classes = new Set();
  const nodes = new Map(MODE_PARTS.map(([, s]) => [s, { style: { viewTransitionName: "" } }]));
  const timers = new Map();
  let tid = 0;
  let mode = "simple";
  const applied = [];
  const transitions = [];
  let anims = [];
  const doc = {
    visibilityState: "visible",
    documentElement: { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } },
    querySelector: (s) => nodes.get(s) ?? null,
    getAnimations: () => anims,
    startViewTransition(cb) {
      let done;
      const finished = new Promise((r) => (done = r));
      const t = {
        cb,
        ran: false,
        run() {
          if (!t.ran) {
            t.ran = true;
            cb();
          }
        },
        ready: stuck ? new Promise(() => {}) : Promise.resolve(),
        finished,
        skipped: 0,
        skipTransition() {
          t.skipped++;
          t.run();
          done();
        },
        end() {
          t.run();
          done();
        },
      };
      // un documento oculto o congelado no llega ni a llamar al callback
      if (!stuck) queueMicrotask(() => t.run());
      transitions.push(t);
      return t;
    },
  };
  const sw = createModeSwitch({
    doc,
    apply: (m) => {
      mode = m;
      applied.push(m);
    },
    current: () => mode,
    level: () => "completas",
    setTimeout: (fn, ms) => {
      timers.set(++tid, { fn, ms });
      return tid;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    sw,
    doc,
    classes,
    nodes,
    timers,
    transitions,
    applied,
    get mode() { return mode; },
    setAnims(a) { anims = a; },
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const t of all) t.fn();
    },
  };
}

const tickle = () => new Promise((r) => setTimeout(r, 0));

/// Animación falsa de un pseudoelemento de la transición.
function fakeAnim() {
  const a = {
    effect: { pseudoElement: "::view-transition-group(rail)" },
    playbackRate: 1,
    listeners: [],
    reverse() { a.playbackRate *= -1; },
    addEventListener(type, fn) { if (type === "finish") a.listeners.push(fn); },
    finish() {
      const ls = a.listeners;
      a.listeners = [];
      for (const fn of ls) fn();
    },
  };
  return a;
}

test("ida: marca los elementos compartidos, cambia el modo y lo limpia todo al acabar", async () => {
  const e = fakeEnv();
  assert.equal(e.sw.go("studio"), "move");
  assert.ok(e.classes.has("mode-vt"));
  assert.equal(e.nodes.get("#rail").style.viewTransitionName, "rail");
  assert.ok(e.sw.active());
  await tickle();
  assert.equal(e.mode, "studio");
  e.transitions[0].end();
  await tickle();
  assert.equal(e.classes.size, 0);
  for (const [, n] of e.nodes) assert.equal(n.style.viewTransitionName, "");
  assert.equal(e.timers.size, 0, "el tope se retira");
  assert.ok(!e.sw.active());
});

test("documento oculto a mitad o transición colgada: a los 900 ms el modo cambia igual", async () => {
  const e = fakeEnv({ stuck: true });
  e.sw.go("studio");
  const [{ ms }] = [...e.timers.values()];
  assert.equal(ms, CAP_MS);
  assert.ok(CAP_MS < 1000);
  assert.equal(e.mode, "simple", "aún no ha llegado el callback");
  e.fire();
  assert.equal(e.mode, "studio");
  assert.equal(e.transitions[0].skipped, 1);
  await tickle();
  assert.ok(!e.sw.active());
  assert.equal(e.classes.size, 0);
  // y se puede volver enseguida (antes se quedaba en Studio para siempre)
  assert.equal(e.sw.go("simple"), "move");
});

test("pulsar el otro modo a mitad invierte desde donde esté", async () => {
  const e = fakeEnv();
  e.sw.go("studio");
  await tickle();
  const a = fakeAnim();
  const b = fakeAnim();
  e.setAnims([a, b]);
  assert.equal(e.sw.go("simple"), "reverse");
  assert.equal(a.playbackRate, -1);
  assert.equal(b.playbackRate, -1);
  // al volver al principio la página vuelve a Simple justo antes de soltar la transición
  a.finish();
  assert.equal(e.mode, "studio");
  b.finish();
  assert.equal(e.mode, "simple");
  e.transitions[0].end();
  await tickle();
  assert.equal(e.mode, "simple");
  assert.equal(e.transitions.length, 1, "no se abre una segunda transición");
});

test("invertir dos veces sigue hacia el destino original", async () => {
  const e = fakeEnv();
  e.sw.go("studio");
  await tickle();
  const a = fakeAnim();
  e.setAnims([a]);
  e.sw.go("simple");
  e.sw.go("studio");
  assert.equal(a.playbackRate, 1);
  a.finish(); // termina hacia delante: no debe volver a Simple
  e.transitions[0].end();
  await tickle();
  assert.equal(e.mode, "studio");
});

test("con teclado a mitad: salta al final y aplica sin animación", async () => {
  const e = fakeEnv();
  e.sw.go("studio");
  await tickle();
  e.sw.go("simple", { animate: false });
  await tickle();
  assert.equal(e.mode, "simple");
  assert.equal(e.transitions[0].skipped, 1);
  assert.ok(!e.sw.active());
});

test("una pieza que no se ve (cajón cerrado) no lleva nombre", async () => {
  let mode = "studio";
  const eq = { style: { viewTransitionName: "" } };
  const rail = { style: { viewTransitionName: "" } };
  let t;
  const sw = createModeSwitch({
    doc: {
      visibilityState: "visible",
      documentElement: { classList: { add() {}, remove() {} } },
      querySelector: (s) => (s === "#mix-eq-box" ? eq : s === "#rail" ? rail : null),
      startViewTransition(cb) {
        t = { cb, ready: Promise.resolve(), finished: new Promise(() => {}), skipTransition() {} };
        return t;
      },
    },
    apply: (m) => (mode = m),
    current: () => mode,
    level: () => "completas",
    // en Simple el ecualizador va al cajón cerrado y la columna derecha no existe
    visible: (n) => mode === "studio" || (n !== eq && n !== rail),
    setTimeout: () => 0,
    clearTimeout() {},
  });
  sw.go("simple");
  assert.equal(eq.style.viewTransitionName, "eq", "en Studio se ve");
  t.cb();
  assert.equal(eq.style.viewTransitionName, "", "tras el cambio ya no: sale en su sitio, sin viajar al cajón");
  assert.equal(rail.style.viewTransitionName, "");
});

test("skip(): termina ya en el modo de destino, sin restos", async () => {
  const e = fakeEnv({ stuck: true });
  e.sw.go("studio");
  e.sw.skip();
  assert.equal(e.mode, "studio");
  assert.equal(e.transitions[0].skipped, 1);
  assert.ok(!e.sw.active());
  assert.equal(e.classes.size, 0);
  assert.equal(e.timers.size, 0);
  e.sw.skip(); // sin transición: no hace nada
});

test("teclado o Mínimas: sin elementos compartidos", () => {
  const e = fakeEnv();
  assert.equal(e.sw.go("studio", { animate: false }), "instant");
  assert.equal(e.mode, "studio");
  assert.equal(e.transitions.length, 0);
});

test("ida y vuelta 20 veces: sin restos (clases, nombres, topes)", async () => {
  const e = fakeEnv();
  for (let i = 0; i < 40; i++) {
    e.sw.go(i % 2 ? "simple" : "studio");
    await tickle();
    e.transitions.at(-1).end();
    await tickle();
  }
  assert.equal(e.mode, "simple");
  assert.equal(e.transitions.length, 40);
  assert.equal(e.classes.size, 0);
  assert.equal(e.timers.size, 0);
  for (const [, n] of e.nodes) assert.equal(n.style.viewTransitionName, "");
});
