// Medición del arranque (Sprint 1, T1): marcas de la interfaz hacia el motor.
// Nunca lanza: si el comando no existe o falla (p. ej. en el arnés de
// navegador, donde `perf_mark` devuelve null), se ignora en silencio.

function invokeFn() {
  const t = globalThis.__TAURI__;
  return t && t.core && typeof t.core.invoke === "function" ? t.core.invoke : null;
}

/** Pone una marca de arranque con nombre (la primera vez gana, en Rust). */
export function mark(name) {
  try {
    const invoke = invokeFn();
    if (!invoke) return;
    const p = invoke("perf_mark", { name: String(name) });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // la medición nunca debe romper la app
  }
}

/** Informe `{ marks, audio }` del motor, o null si no está disponible. */
export async function report() {
  try {
    const invoke = invokeFn();
    if (!invoke) return null;
    return (await invoke("perf_report")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Sondeo de reposo (modo `--bench-idle`): espera a que la app asiente y, sin
 * música, cuenta durante 4 s quién pide fotogramas y qué animaciones siguen
 * vivas. Lo deja en el informe (`perf_note("reposo")`) y marca
 * `reposo-medido`, que cierra la app. Fuera de ese modo no hace nada.
 */
export async function idleProbe({ settleMs = 8000, windowMs = 4000 } = {}) {
  const r = await report();
  if (!r || !r.idle_mode) return;
  const invoke = invokeFn();
  await new Promise((res) => setTimeout(res, settleMs));
  const orig = globalThis.requestAnimationFrame.bind(globalThis);
  const who = new Map();
  let frames = 0;
  globalThis.requestAnimationFrame = (cb) => {
    frames++;
    const st = (new Error().stack || "").split(String.fromCharCode(10)).slice(2, 4).map((x) => x.trim().replace(/^.*\/ui\//, "").replace(/^.*?:\/\/[^/]+\//, "")).join(" <- ");
    who.set(st, (who.get(st) || 0) + 1);
    return orig(cb);
  };
  await new Promise((res) => setTimeout(res, windowMs));
  globalThis.requestAnimationFrame = orig;
  const desc = (t) => {
    if (!t) return "?";
    if (t.id) return "#" + t.id;
    const c = t.className && typeof t.className === "object" ? t.className.baseVal : t.className;
    return (t.tagName || "").toLowerCase() + "." + String(c || "").split(" ")[0];
  };
  const doc = globalThis.document;
  const anims = doc.getAnimations()
    .filter((a) => a.playState === "running")
    .map((a) => `${desc(a.effect && a.effect.target)} ${a.animationName || a.transitionProperty || "waapi"} it=${a.effect.getTiming().iterations}`);
  const value = {
    rafPorSegundo: Math.round((frames * 1000) / windowMs),
    quienPide: [...who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    animaciones: anims.slice(0, 20),
    cuerpo: { ...doc.body.dataset },
    viz: (() => {
      const c = doc.getElementById("viz");
      return c ? { w: c.width, h: c.height, filter: getComputedStyle(c).filter, display: getComputedStyle(c).display } : null;
    })(),
  };
  try {
    await invoke("perf_note", { key: "reposo", value });
  } catch {
    // sin motor: nada que informar
  }
  mark("reposo-medido");
}
