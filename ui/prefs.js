// Preferencias de la interfaz: un único almacén con esquema, validación y
// migración desde las claves sueltas de localStorage (`enn.*`).
//
// Módulo puro: sin DOM ni `window` en el nivel superior, importable en Node
// (las pruebas viven en ui/tests/prefs.test.js). La integración con app.js y
// con el backend de Rust la hace otra tarea; aquí solo hay lógica.

/// Convierte el JSON antiguo `enn.modes` ({ r: 0|1|2 }) en el valor de `repeat.mode`.
function legacyJson(campo) {
  return (raw) => {
    try {
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o[campo] : undefined;
    } catch {
      return undefined;
    }
  };
}

const MODOS = ["simple", "studio"];

/// Esquema de las preferencias. `legacy` = clave antigua de localStorage;
/// `fromLegacy(raw)` adapta formatos antiguos que no son el valor directo.
/// Los valores por defecto salen de ui/app.js (Sprint 1, T2).
export const PREFS_SCHEMA = [
  { id: "shell.mode", type: "choice", default: "simple", options: MODOS, section: "shell", since: "0.1", legacy: "enn.mode" },
  { id: "shell.startMode", type: "choice", default: "last", options: ["last", ...MODOS], section: "shell", since: "0.1", legacy: "enn.startMode" },
  { id: "shell.view", type: "string", default: "nowplaying", section: "shell", since: "0.1", legacy: "enn.view" },
  { id: "shell.prevView", type: "string", default: "nowplaying", section: "shell", since: "0.1", legacy: "enn.prevView" },
  { id: "library.tab", type: "string", default: "all", section: "library", since: "0.1", legacy: "enn.libTab" },
  // la clave antigua guarda JSON { by, rev }: se reparte en dos preferencias
  { id: "library.sort", type: "choice", default: "mtime", options: ["mtime", "title", "artist", "album", "year", "dur", "plays"], section: "library", since: "0.1", legacy: "enn.libSort", fromLegacy: legacyJson("by") },
  { id: "library.sortRev", type: "toggle", default: false, section: "library", since: "0.1", legacy: "enn.libSort", fromLegacy: legacyJson("rev") },
  { id: "library.layout", type: "choice", default: "rows", options: ["rows", "grid", "wheel", "compact"], section: "library", since: "0.1", legacy: "enn.libLayout" },
  { id: "library.width", type: "number", default: 320, section: "library", since: "0.1", legacy: "enn.libW" },
  { id: "library.collapsed", type: "toggle", default: false, section: "library", since: "0.1", legacy: "enn.libCollapsed" },
  { id: "queue.width", type: "number", default: 330, section: "queue", since: "0.1", legacy: "enn.qw" },
  { id: "nowplaying.view", type: "choice", default: "stage", options: ["stage", "classic"], section: "nowplaying", since: "0.1", legacy: "enn.npView" },
  { id: "idle.ms", type: "choice", default: 3000, options: [0, 3000, 5000, 10000], section: "idle", since: "0.1", legacy: "enn.idleMs" },
  { id: "eq.open", type: "toggle", default: false, section: "eq", since: "0.1", legacy: "enn.eqOpen" },
  // ojo: en app.js el panel paramétrico arranca ABIERTO (solo "0" lo cierra)
  { id: "eq.paramOpen", type: "toggle", default: true, section: "eq", since: "0.1", legacy: "enn.eqParam" },
  { id: "spectrum.sensitivity", type: "slider", default: 1, min: 0.5, max: 2, step: 0.05, section: "spectrum", since: "0.1", legacy: "enn.specSens" },
  { id: "radio.on", type: "toggle", default: false, section: "radio", since: "0.1", legacy: "enn.radio" },
  { id: "repeat.mode", type: "choice", default: 0, options: [0, 1, 2], section: "repeat", since: "0.1", legacy: "enn.modes", fromLegacy: legacyJson("r") },
  { id: "downloads.format", type: "choice", default: "m4a", options: ["m4a", "mp3", "flac"], section: "downloads", since: "0.1", legacy: "enn.dlFmt" },
  { id: "motion.level", type: "choice", default: "completas", options: ["completas", "suaves", "minimas"], section: "motion", since: "0.2" },
];

const NO_VALIDO = Symbol("no-valido");

/// Número finito desde un número o un texto no vacío; si no, NaN.
function aNumero(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "") return Number(raw);
  return NaN;
}

/// Valida y convierte `raw` según el tipo de la entrada. Devuelve el valor
/// ya normalizado o NO_VALIDO.
function normalizar(entrada, raw) {
  switch (entrada.type) {
    case "toggle":
      if (typeof raw === "boolean") return raw;
      if (raw === "1" || raw === "true") return true;
      if (raw === "0" || raw === "false") return false;
      return NO_VALIDO;
    case "slider": {
      const n = aNumero(raw);
      if (!Number.isFinite(n)) return NO_VALIDO;
      const min = entrada.min ?? -Infinity;
      const max = entrada.max ?? Infinity;
      return Math.min(max, Math.max(min, n));
    }
    case "number": {
      const n = aNumero(raw);
      return Number.isFinite(n) ? n : NO_VALIDO;
    }
    case "choice": {
      const opciones = entrada.options || [];
      // se compara tras convertir al tipo de las opciones (p. ej. "5000" -> 5000)
      const v = typeof opciones[0] === "number" ? aNumero(raw) : raw;
      return opciones.includes(v) ? v : NO_VALIDO;
    }
    case "string":
      return typeof raw === "string" ? raw : NO_VALIDO;
    default:
      return NO_VALIDO;
  }
}

export function createPrefs({ schema = PREFS_SCHEMA, legacyStorage = null, backend = null, saveDelayMs = 400 } = {}) {
  const entradas = new Map(schema.map((e) => [e.id, e]));
  const valores = new Map(schema.map((e) => [e.id, e.default]));
  const oyentes = new Map(); // id o "*" -> Set<fn>
  let extras = {}; // claves desconocidas del backend (de una versión futura)
  let timer = null;
  let pendiente = false;

  function leerAntiguo(clave) {
    if (!legacyStorage) return null;
    try {
      return legacyStorage.getItem(clave);
    } catch {
      return null; // almacenamiento bloqueado: como si estuviera vacío
    }
  }

  function avisar(id, valor) {
    for (const clave of [id, "*"]) {
      for (const fn of [...(oyentes.get(clave) || [])]) {
        try {
          fn(valor, id);
        } catch {
          // un oyente que falla no debe impedir a los demás
        }
      }
    }
  }

  async function guardar() {
    timer = null;
    pendiente = false;
    if (!backend) return;
    try {
      await backend.save({ ...extras, ...Object.fromEntries(valores) });
    } catch {
      // un fallo al guardar no rompe nada: se reintenta con el siguiente cambio
    }
  }

  function programarGuardado() {
    if (!backend) return;
    pendiente = true;
    if (timer !== null) return;
    timer = setTimeout(guardar, saveDelayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function cambiar(id, valor) {
    if (Object.is(valores.get(id), valor)) return false;
    valores.set(id, valor);
    avisar(id, valor);
    programarGuardado();
    return true;
  }

  async function load() {
    let guardado;
    try {
      guardado = backend ? await backend.load() : null;
    } catch {
      guardado = null;
    }
    if (!guardado || typeof guardado !== "object" || Array.isArray(guardado)) guardado = {};

    extras = {};
    for (const [k, v] of Object.entries(guardado)) if (!entradas.has(k)) extras[k] = v;

    const migrated = [];
    for (const e of entradas.values()) {
      if (Object.hasOwn(guardado, e.id)) {
        // lo guardado gana a lo antiguo; si es basura, vuelve el defecto
        const v = normalizar(e, guardado[e.id]);
        valores.set(e.id, v === NO_VALIDO ? e.default : v);
        continue;
      }
      valores.set(e.id, e.default);
      if (!e.legacy) continue;
      const bruto = leerAntiguo(e.legacy);
      if (bruto === null || bruto === undefined) continue;
      const v = normalizar(e, e.fromLegacy ? e.fromLegacy(bruto) : bruto);
      if (v === NO_VALIDO) continue;
      valores.set(e.id, v);
      migrated.push(e.id);
    }
    if (migrated.length) programarGuardado();
    return { migrated };
  }

  function get(id) {
    return valores.get(id);
  }

  function set(id, value) {
    const e = entradas.get(id);
    if (!e) return false;
    const v = normalizar(e, value);
    if (v === NO_VALIDO) return false;
    return cambiar(id, v);
  }

  function reset(idOrSection) {
    for (const e of entradas.values()) {
      if (e.id === idOrSection || e.section === idOrSection) cambiar(e.id, e.default);
    }
  }

  function all() {
    return Object.fromEntries(valores);
  }

  function on(idOrStar, fn) {
    let set_ = oyentes.get(idOrStar);
    if (!set_) oyentes.set(idOrStar, (set_ = new Set()));
    set_.add(fn);
    return () => set_.delete(fn);
  }

  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pendiente) await guardar();
  }

  return { load, get, set, reset, all, on, flush };
}
