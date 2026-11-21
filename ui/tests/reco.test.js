// Sprint 3, T7: cuándo sale el menú de recomendaciones (lógica pura).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDueByPlays, createRecoGate, SHOW_AFTER_S } from "../reco.js";

const base = { posS: 10, durS: 200, repeatCycles: 0, blocked: false, idle: false };

test("1.ª escucha sí, 2.ª no, 3.ª sí, 6.ª sí", () => {
  assert.equal(isDueByPlays(1), true);
  assert.equal(isDueByPlays(2), false);
  assert.equal(isDueByPlays(3), true);
  assert.equal(isDueByPlays(4), false);
  assert.equal(isDueByPlays(6), true);
  assert.equal(isDueByPlays(9), true);
  assert.equal(isDueByPlays(0), false);
});

test("espera 8 s y sale una sola vez por canción y sesión", () => {
  const g = createRecoGate();
  assert.equal(g.decide({ ...base, key: "a", plays: 1, posS: SHOW_AFTER_S - 1 }), "wait");
  assert.equal(g.decide({ ...base, key: "a", plays: 1 }), "show");
  assert.equal(g.decide({ ...base, key: "a", plays: 1 }), "no");
  assert.equal(g.decide({ ...base, key: "b", plays: 2 }), "no");
  assert.equal(g.decide({ ...base, key: "c", plays: 3 }), "show");
});

test("tercer ciclo seguido en «repetir una»", () => {
  const g = createRecoGate();
  assert.equal(g.decide({ ...base, key: "r", plays: 4, repeatCycles: 2 }), "no");
  assert.equal(g.decide({ ...base, key: "r", plays: 5, repeatCycles: 3 }), "show");
});

test("no sale en canciones cortas, con un diálogo o vista previa, ni apagado", () => {
  const g = createRecoGate();
  assert.equal(g.decide({ ...base, key: "s", plays: 1, durS: 25 }), "no");
  assert.equal(g.decide({ ...base, key: "d", plays: 1, blocked: true }), "no");
  g.setDisabled(true);
  assert.equal(g.decide({ ...base, key: "e", plays: 1 }), "no");
});

test("en reposo se guarda y sale al volver si la canción lleva menos de 60 s", () => {
  const g = createRecoGate();
  assert.equal(g.decide({ ...base, key: "i", plays: 1, idle: true }), "wait");
  assert.equal(g.decide({ ...base, key: "i", plays: 1, posS: 40 }), "show");
  const g2 = createRecoGate();
  assert.equal(g2.decide({ ...base, key: "j", plays: 1, idle: true }), "wait");
  // volvió tarde: ya no tiene sentido proponer «después de esta»
  assert.equal(g2.decide({ ...base, key: "j", plays: 1, posS: 75 }), "no");
});

test("tres descartes seguidos → sale la mitad de las veces; aceptar lo restablece", () => {
  const g = createRecoGate();
  for (const k of ["x1", "x2", "x3"]) {
    assert.equal(g.decide({ ...base, key: k, plays: 1 }), "show");
    g.dismissed();
  }
  let shown = 0;
  for (let i = 0; i < 10; i++) if (g.decide({ ...base, key: `y${i}`, plays: 1 }) === "show") shown++;
  assert.equal(shown, 5);
  g.accepted();
  let after = 0;
  for (let i = 0; i < 4; i++) if (g.decide({ ...base, key: `z${i}`, plays: 1 }) === "show") after++;
  assert.equal(after, 4);
});
