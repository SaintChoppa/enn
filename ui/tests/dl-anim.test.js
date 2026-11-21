// Sprint 2, T6: animación de las descargas (lógica pura, sin DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  FILL_MIN_MS,
  FINISH_MS,
  CHIME_AT_MS,
  phaseOf,
  stepShown,
  buttonState,
  createPillMotion,
  summarize,
  fmtSpeed,
} from "../dl-anim.js";

/// Reloj falso: temporizadores que solo avanzan con `advance`.
function fakeClock() {
  let now = 0;
  let timers = [];
  return {
    get now() { return now; },
    setTimer(fn, ms) { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer(t) { timers = timers.filter((x) => x !== t); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
  };
}

/// Avanza fotogramas de 16 ms (bucle de animación) hasta que `until` sea cierto.
function frames(m, clock, until, maxMs = 10000) {
  let t = 0;
  while (!until() && t < maxMs) {
    m.tick(16);
    clock.advance(16);
    t += 16;
  }
  return t;
}

function motion(clock) {
  const seen = [];
  const ev = { chime: -1, done: -1 };
  const m = createPillMotion({
    setPhase: (p) => seen.push([p, clock.now]),
    onChime: () => { ev.chime = clock.now; },
    onDone: () => { ev.done = clock.now; },
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (t) => clock.clearTimer(t),
  });
  return { m, seen, ev };
}

test("estado del motor → fase de la pastilla", () => {
  assert.equal(phaseOf({ state: "queued" }), "queued");
  assert.equal(phaseOf({ state: "resolving" }), "resolving");
  assert.equal(phaseOf({ state: "downloading" }), "downloading");
  assert.equal(phaseOf({ state: "converting" }), "converting");
  assert.equal(phaseOf({ state: "done" }), "done");
  assert.equal(phaseOf({ state: "error", error: "el vídeo es privado" }), "error");
  assert.equal(phaseOf({ state: "error", error: "descarga cancelada" }), "cancelled");
});

test("el llenado de 0 a 100 nunca dura menos de 600 ms", () => {
  let shown = 0;
  let t = 0;
  while (shown < 100 && t < 5000) { shown = stepShown(shown, 100, 16); t += 16; }
  assert.equal(shown, 100);
  assert.ok(t >= FILL_MIN_MS, `llenó en ${t} ms`);
  assert.ok(t <= 1500, `demasiado lento: ${t} ms`);
  // un avance pequeño se alcanza enseguida (sin quedarse corto para siempre)
  let s = 40;
  let k = 0;
  while (s < 45 && k < 100) { s = stepShown(s, 45, 16); k++; }
  assert.equal(s, 45);
  // un reintento (429) vuelve a 0 al instante
  assert.equal(stepShown(80, 0, 16), 0);
});

test("una descarga instantánea pasa por llenado y «finalizando» y acaba con las acciones", () => {
  const clock = fakeClock();
  const { m, seen, ev } = motion(clock);
  m.update({ state: "queued" });
  m.update({ state: "done", path: "C:/m/x.m4a" });
  const start = clock.now;
  frames(m, clock, () => m.phase === "finishing");
  clock.advance(FINISH_MS + 50);
  assert.equal(m.phase, "done");
  assert.ok(ev.done - start >= FILL_MIN_MS, `terminó en ${ev.done - start} ms`);
  // «finalizando» dura lo que dice FINISH_MS y la campanilla suena en el ✓
  const fin = seen.find(([p]) => p === "finishing")[1];
  assert.equal(ev.done - fin, FINISH_MS);
  assert.equal(ev.chime - fin, CHIME_AT_MS);
  // orden de fases: nada se salta el final
  const order = seen.map(([p]) => p);
  assert.deepEqual(order.slice(-2), ["finishing", "done"]);
  assert.ok(order.indexOf("downloading") < order.indexOf("finishing"));
});

test("las fases intermedias se ven y el «hecho» repetido no reinicia nada", () => {
  const clock = fakeClock();
  const { m, seen, ev } = motion(clock);
  m.update({ state: "resolving" });
  m.update({ state: "downloading", progress_percent: 50 });
  frames(m, clock, () => m.shown >= 50);
  m.update({ state: "converting" });
  assert.equal(m.phase, "converting");
  m.update({ state: "done" });
  frames(m, clock, () => m.phase === "finishing");
  m.update({ state: "done" });
  clock.advance(FINISH_MS);
  m.update({ state: "done" });
  clock.advance(2000);
  assert.equal(seen.filter(([p]) => p === "finishing").length, 1);
  assert.equal(seen.filter(([p]) => p === "done").length, 1);
  assert.ok(ev.done > 0);
  assert.deepEqual(
    [...new Set(seen.map(([p]) => p))],
    ["resolving", "downloading", "converting", "finishing", "done"],
  );
});

test("error y cancelación cortan en seco cualquier secuencia", () => {
  const clock = fakeClock();
  const { m, ev } = motion(clock);
  m.update({ state: "downloading", progress_percent: 30 });
  m.update({ state: "error", error: "el vídeo es privado" });
  assert.equal(m.phase, "error");
  const c = fakeClock();
  const b = motion(c);
  b.m.update({ state: "downloading", progress_percent: 30 });
  b.m.update({ state: "error", error: "descarga cancelada" });
  assert.equal(b.m.phase, "cancelled");
  c.advance(5000);
  assert.equal(ev.done, -1);
  // tras un error se puede reintentar: vuelve a empezar
  m.update({ state: "queued" });
  assert.equal(m.phase, "queued");
});

test("el botón de descargar pasa por sus cinco estados", () => {
  // reposo → descargando → hecho (encima y pulsado los da el CSS)
  assert.equal(buttonState(null), "idle");
  for (const p of ["queued", "resolving", "downloading", "converting", "finishing"]) assert.equal(buttonState(p), "busy");
  assert.equal(buttonState("done"), "done");
  assert.equal(buttonState("error"), "idle");
  assert.equal(buttonState("cancelled"), "idle");
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");
  for (const sel of [".pill-dl:hover", ".pill-dl:active", '.pill-dl[data-st="busy"]', '.pill-dl[data-st="done"]']) {
    assert.ok(css.includes(sel), `falta ${sel} en styles.css`);
  }
  // pulsado: escala 0,97
  assert.match(css, /\.pill-dl:active\s*\{[^}]*scale\(0\.97\)/);
});

test("resumen para la barra superior", () => {
  const s = summarize([
    { state: "downloading", progress_percent: 50, speed: 1_000_000 },
    { state: "resolving", progress_percent: 0, speed: 0 },
    { state: "queued", progress_percent: 0 },
    { state: "converting", progress_percent: 100, speed: 0 },
    { state: "done", progress_percent: 100 },
    { state: "error", progress_percent: 10 },
  ]);
  assert.equal(s.running, 3);
  assert.equal(s.waiting, 1);
  assert.equal(s.left, 4);
  assert.equal(s.speed, 1_000_000);
  assert.equal(s.pct, 37.5); // (50 + 0 + 0 + 100) / 4
  assert.deepEqual(summarize([]), { running: 0, waiting: 0, left: 0, speed: 0, pct: 0 });
});

test("velocidad legible", () => {
  assert.equal(fmtSpeed(2.4 * 1024 * 1024), "2,4 MB/s");
  assert.equal(fmtSpeed(512 * 1024), "512 KB/s");
  assert.equal(fmtSpeed(0), "");
});
