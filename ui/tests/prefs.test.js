// Pruebas de ui/prefs.js (node --test). Sin DOM: todo con almacenes simulados.
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PREFS_SCHEMA, createPrefs } from "../prefs.js";

afterEach(() => mock.timers.reset());

/// localStorage simulado: solo getItem, como pide el módulo.
function fakeLegacy(obj) {
  return { getItem: (k) => (k in obj ? obj[k] : null) };
}

/// Backend simulado que recuerda lo último guardado.
function fakeBackend(initial = null) {
  const b = {
    saves: [],
    load: async () => initial,
    save: async (o) => {
      b.saves.push(structuredClone(o));
    },
  };
  return b;
}

test("esquema: ids únicos, defaults válidos y motion.level presente", () => {
  const ids = PREFS_SCHEMA.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const m = PREFS_SCHEMA.find((e) => e.id === "motion.level");
  assert.equal(m.default, "completas");
  assert.equal(m.since, "0.2");
  assert.deepEqual(m.options, ["completas", "suaves", "minimas"]);
  // el valor por defecto de cada entrada pasa su propia validación
  const p = createPrefs();
  for (const e of PREFS_SCHEMA) assert.equal(p.get(e.id), e.default, e.id);
});

test("valores por defecto con backend vacío", async () => {
  for (const backend of [null, fakeBackend(null), fakeBackend({})]) {
    const p = createPrefs({ backend });
    const r = await p.load();
    assert.deepEqual(r, { migrated: [] });
    assert.equal(p.get("shell.mode"), "simple");
    assert.equal(p.get("shell.startMode"), "last");
    assert.equal(p.get("library.layout"), "rows");
    assert.equal(p.get("library.collapsed"), false);
    assert.equal(p.get("eq.paramOpen"), true);
    assert.equal(p.get("idle.ms"), 3000);
    assert.equal(p.get("spectrum.sensitivity"), 1);
    assert.equal(p.get("repeat.mode"), 0);
    assert.equal(p.get("downloads.format"), "m4a");
    assert.equal(p.get("motion.level"), "completas");
  }
});

test("id desconocido -> undefined", () => {
  assert.equal(createPrefs().get("no.existe"), undefined);
});

test("migración de los casos especiales", async () => {
  const p = createPrefs({
    legacyStorage: fakeLegacy({
      "enn.libCollapsed": "1",
      "enn.idleMs": "5000",
      "enn.modes": '{"r":2,"s":true}',
      "enn.specSens": "1.5",
      "enn.libLayout": "zzz",
      "enn.radio": "1",
      "enn.eqParam": "0",
      "enn.libW": "400",
      "enn.dlFmt": "flac",
      "enn.libSort": '{"by":"title","rev":true}',
    }),
  });
  const { migrated } = await p.load();
  assert.equal(p.get("library.collapsed"), true);
  assert.equal(p.get("idle.ms"), 5000);
  assert.equal(p.get("repeat.mode"), 2);
  assert.equal(p.get("spectrum.sensitivity"), 1.5);
  assert.equal(p.get("library.layout"), "rows"); // inválido -> defecto
  assert.equal(p.get("radio.on"), true);
  assert.equal(p.get("eq.paramOpen"), false);
  assert.equal(p.get("library.width"), 400);
  assert.equal(p.get("downloads.format"), "flac");
  assert.equal(p.get("library.sort"), "title");
  assert.equal(p.get("library.sortRev"), true);
  assert.ok(migrated.includes("library.collapsed"));
  assert.ok(migrated.includes("repeat.mode"));
  assert.ok(!migrated.includes("library.layout"));
});

test("migración: JSON roto o basura -> defecto", async () => {
  const p = createPrefs({
    legacyStorage: fakeLegacy({ "enn.modes": "{no es json", "enn.libSort": "basura", "enn.idleMs": "7" }),
  });
  await p.load();
  assert.equal(p.get("repeat.mode"), 0);
  assert.equal(p.get("library.sort"), "mtime");
  assert.equal(p.get("idle.ms"), 3000);
});

test("la migración programa un guardado", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const backend = fakeBackend(null);
  const p = createPrefs({ backend, legacyStorage: fakeLegacy({ "enn.radio": "1" }) });
  await p.load();
  mock.timers.tick(400);
  await Promise.resolve();
  assert.equal(backend.saves.length, 1);
  assert.equal(backend.saves[0]["radio.on"], true);
});

test("lo guardado en el backend gana a lo antiguo", async () => {
  const p = createPrefs({
    backend: fakeBackend({ "shell.mode": "studio" }),
    legacyStorage: fakeLegacy({ "enn.mode": "simple", "enn.radio": "1" }),
  });
  const { migrated } = await p.load();
  assert.equal(p.get("shell.mode"), "studio");
  assert.equal(p.get("radio.on"), true);
  assert.deepEqual(migrated, ["radio.on"]);
});

test("valor inválido guardado en el backend -> defecto", async () => {
  const p = createPrefs({ backend: fakeBackend({ "library.layout": "zzz", "idle.ms": "10000" }) });
  await p.load();
  assert.equal(p.get("library.layout"), "rows");
  assert.equal(p.get("idle.ms"), 10000); // se convierte al tipo de las opciones
});

test("set inválido devuelve false y no cambia nada", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const backend = fakeBackend(null);
  const p = createPrefs({ backend });
  await p.load();
  const seen = [];
  p.on("*", (v, id) => seen.push([id, v]));
  assert.equal(p.set("library.layout", "zzz"), false);
  assert.equal(p.set("idle.ms", 42), false);
  assert.equal(p.set("radio.on", "quizá"), false);
  assert.equal(p.set("library.width", "abc"), false);
  assert.equal(p.set("no.existe", 1), false);
  assert.equal(p.get("library.layout"), "rows");
  assert.deepEqual(seen, []);
  mock.timers.tick(1000);
  assert.equal(backend.saves.length, 0);
});

test("set convierte tipos válidos y recorta el slider", async () => {
  const p = createPrefs();
  assert.equal(p.set("radio.on", "1"), true);
  assert.equal(p.get("radio.on"), true);
  assert.equal(p.set("radio.on", "false"), true);
  assert.equal(p.get("radio.on"), false);
  assert.equal(p.set("idle.ms", "3000"), false); // igual al valor actual: sin cambio
  assert.equal(p.set("idle.ms", "5000"), true);
  assert.equal(p.get("idle.ms"), 5000);
  assert.equal(p.set("spectrum.sensitivity", 9), true);
  assert.equal(p.get("spectrum.sensitivity"), 2);
  assert.equal(p.set("spectrum.sensitivity", -3), true);
  assert.equal(p.get("spectrum.sensitivity"), 0.5);
  assert.equal(p.set("spectrum.sensitivity", Infinity), false);
  assert.equal(p.set("library.width", "350"), true);
  assert.equal(p.get("library.width"), 350);
});

test("si el valor no cambia, no avisa ni guarda", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const backend = fakeBackend(null);
  const p = createPrefs({ backend });
  await p.load();
  let n = 0;
  p.on("radio.on", () => n++);
  assert.equal(p.set("radio.on", false), false);
  assert.equal(n, 0);
  mock.timers.tick(1000);
  assert.equal(backend.saves.length, 0);
});

test("claves desconocidas del backend sobreviven a cargar -> set -> guardar", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const backend = fakeBackend({ "futuro.cosa": { a: 1 }, "shell.mode": "studio" });
  const p = createPrefs({ backend });
  await p.load();
  p.set("radio.on", true);
  mock.timers.tick(400);
  await Promise.resolve();
  assert.equal(backend.saves.length, 1);
  assert.deepEqual(backend.saves[0]["futuro.cosa"], { a: 1 });
  assert.equal(backend.saves[0]["shell.mode"], "studio");
  assert.equal(backend.saves[0]["radio.on"], true);
});

test("on: recibe el cambio, '*' recibe todo, se puede dejar de escuchar", () => {
  const p = createPrefs();
  const a = [];
  const todo = [];
  const off = p.on("radio.on", (v, id) => a.push([id, v]));
  p.on("*", (v, id) => todo.push([id, v]));
  p.set("radio.on", true);
  p.set("eq.open", true);
  assert.deepEqual(a, [["radio.on", true]]);
  assert.deepEqual(todo, [["radio.on", true], ["eq.open", true]]);
  off();
  p.set("radio.on", false);
  assert.equal(a.length, 1);
  assert.equal(todo.length, 3);
});

test("un oyente que lanza no impide a los demás", () => {
  const p = createPrefs();
  let llegó = false;
  p.on("radio.on", () => {
    throw new Error("boom");
  });
  p.on("radio.on", () => {
    llegó = true;
  });
  assert.equal(p.set("radio.on", true), true);
  assert.equal(llegó, true);
});

test("varias llamadas a set seguidas producen un solo backend.save", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const backend = fakeBackend(null);
  const p = createPrefs({ backend, saveDelayMs: 400 });
  await p.load();
  p.set("radio.on", true);
  p.set("eq.open", true);
  p.set("shell.mode", "studio");
  mock.timers.tick(399);
  assert.equal(backend.saves.length, 0);
  mock.timers.tick(1);
  await Promise.resolve();
  assert.equal(backend.saves.length, 1);
  assert.equal(backend.saves[0]["shell.mode"], "studio");
  assert.equal(backend.saves[0]["eq.open"], true);
});

test("flush guarda ya y cancela el temporizador", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const backend = fakeBackend(null);
  const p = createPrefs({ backend });
  await p.load();
  p.set("radio.on", true);
  await p.flush();
  assert.equal(backend.saves.length, 1);
  mock.timers.tick(1000);
  assert.equal(backend.saves.length, 1);
  await p.flush(); // nada pendiente: no vuelve a guardar
  assert.equal(backend.saves.length, 1);
});

test("reset por id y por sección", () => {
  const p = createPrefs();
  p.set("library.layout", "grid");
  p.set("library.width", 500);
  p.set("radio.on", true);
  p.reset("library.layout");
  assert.equal(p.get("library.layout"), "rows");
  assert.equal(p.get("library.width"), 500);
  p.set("library.layout", "grid");
  const vistos = [];
  p.on("*", (v, id) => vistos.push(id));
  p.reset("library");
  assert.equal(p.get("library.layout"), "rows");
  assert.equal(p.get("library.width"), 320);
  assert.equal(p.get("radio.on"), true); // otra sección: intacta
  assert.ok(vistos.includes("library.layout") && vistos.includes("library.width"));
});

test("all() devuelve todo el esquema", () => {
  const p = createPrefs();
  const todo = p.all();
  assert.deepEqual(Object.keys(todo).sort(), PREFS_SCHEMA.map((e) => e.id).sort());
});

test("backend que lanza en load: sigue con los defectos", async () => {
  const p = createPrefs({
    backend: {
      load: async () => {
        throw new Error("sin disco");
      },
      save: async () => {},
    },
    legacyStorage: fakeLegacy({ "enn.radio": "1" }),
  });
  await p.load();
  assert.equal(p.get("shell.mode"), "simple");
  assert.equal(p.get("radio.on"), true); // lo antiguo sigue migrando
});

test("backend que devuelve basura: sigue con los defectos", async () => {
  for (const basura of ["texto", 42, [1, 2], true]) {
    const p = createPrefs({ backend: { load: async () => basura } });
    await p.load();
    assert.equal(p.get("shell.mode"), "simple");
  }
});

test("backend que lanza en save (síncrono y asíncrono): no rompe nada", async () => {
  for (const save of [
    () => {
      throw new Error("x");
    },
    async () => {
      throw new Error("y");
    },
  ]) {
    mock.timers.enable({ apis: ["setTimeout"] });
    const p = createPrefs({ backend: { load: async () => null, save } });
    await p.load();
    p.set("radio.on", true);
    mock.timers.tick(400);
    await p.flush();
    assert.equal(p.get("radio.on"), true);
    mock.timers.reset();
  }
});

test("legacyStorage que lanza: se trata como vacío", async () => {
  const p = createPrefs({
    legacyStorage: {
      getItem() {
        throw new Error("bloqueado");
      },
    },
  });
  const r = await p.load();
  assert.deepEqual(r, { migrated: [] });
  assert.equal(p.get("shell.mode"), "simple");
});
