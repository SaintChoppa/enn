// Ola de color al cambiar de canción (Sprint 4, T5).
//
// El cambio de paleta se envuelve en `document.startViewTransition()`: el
// navegador congela la vista vieja, aplica la paleta nueva y la revela con una
// máscara circular de borde suave que crece desde un origen que depende de la
// causa del cambio (⏭ desde la derecha, ⏮ desde la izquierda, un clic desde
// su punto…). En pausa va al revés: el color se retira hacia la carátula.
//
// La acción no espera: la paleta nueva ya está aplicada desde el primer
// fotograma; la ola solo decide qué parte de la pantalla la enseña ya.
//
// Módulo sin dependencias e importable desde Node (ui/tests/wave.test.js):
// todo el DOM llega por `env`.

/// Entre dos cambios más cerca que esto no hay ola: solo el fundido.
export const QUICK_MS = 300;
const DUR = { completas: 1000, suaves: 800 };
const EASE = "cubic-bezier(0.65, 0, 0.35, 1)";
/// Si la primera ola va a más de esto por fotograma, se pasa al fundido.
const SLOW_FRAME_MS = 24;

/// "skip" (mismo color), "plain" (fundido CSS, sin ola) o "wave".
export function decide({ same, hidden, mini, busy, level, supported, degraded, sinceLast }) {
  if (same) return "skip";
  // `busy`: hay un cambio de modo en curso (modeswitch.js); una ola lo saltaría
  if (!supported || degraded || hidden || mini || busy || level === "minimas") return "plain";
  if (sinceLast < QUICK_MS) return "plain";
  return "wave";
}

/// Origen de la ola para `cause`. `c` trae el tamaño de la ventana (`w`, `h`)
/// y, si existen, el centro de la carátula (`art`), del botón de radio
/// (`radio`), el punto del clic (`point`) y `flip` para alternar «otros».
export function waveOrigin(cause, c) {
  const mid = { x: c.w / 2, y: c.h / 2 };
  const at = (p) => ({ x: (p ?? mid).x, y: (p ?? mid).y, reverse: false });
  switch (cause) {
    case "ended":
    case "resume":
      return at(c.art);
    case "next":
      return { x: c.w + 40, y: c.h / 2, reverse: false };
    case "prev":
      return { x: -40, y: c.h / 2, reverse: false };
    case "click":
    case "download":
      return at(c.point);
    case "radio":
      return at(c.radio);
    case "reco":
      return { x: c.w, y: c.h, reverse: false };
    case "pause":
      return { ...at(c.art), reverse: true };
    default:
      return { x: c.w / 2, y: c.flip ? -40 : c.h + 40, reverse: false };
  }
}

/// Radio que cubre la ventana entera desde (x, y): hasta la esquina más lejana.
export function waveRadius(x, y, w, h) {
  return Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y));
}

/// Controlador. `env`:
///   doc        documento (startViewTransition, documentElement, visibilityState)
///   apply(p)   aplica la paleta (palette.js)
///   keyOf(p)   clave de la paleta, para saber si es el mismo color
///   now()      reloj en ms
///   context()  { w, h, art?, radio? } en coordenadas de la ventana
///   mini()     ¿modo mini?
///   level()    nivel de animación efectivo (completas, suaves, minimas)
///   storage    { get(), set(v) } para recordar que el equipo va lento
///   report     opcional: tiempos por fotograma de las 5 primeras olas
///   initial    opcional: la paleta que ya hay en pantalla al empezar
///   busy()     opcional: ¿hay otra View Transition en curso (cambio de modo)?
export function createWave(env) {
  const { doc, apply, keyOf, now, context, mini, level, storage, report, initial, busy } = env;
  const root = doc.documentElement;
  // la app arranca en plateado (styles.css): volver a ponerlo no es un cambio
  let lastKey = initial ? keyOf(initial) : null;
  let lastAt = -Infinity;
  let current = null;
  let flip = false;
  let measured = false;
  let degraded = false;
  try {
    degraded = storage?.get() === "1";
  } catch {}

  const clear = () => {
    root.classList.remove("wave-on");
    root.classList.remove("wave-rev");
  };

  // Se miden las 5 primeras olas (para el registro); la primera decide si el
  // equipo va lento.
  let waves = 0;
  function measure(vt, cause) {
    if (waves >= 5 || typeof globalThis.requestAnimationFrame !== "function") return;
    const n = waves++;
    const gaps = [];
    let prev = 0;
    let live = true;
    const step = (t) => {
      if (prev) gaps.push(t - prev);
      prev = t;
      if (live) globalThis.requestAnimationFrame(step);
    };
    globalThis.requestAnimationFrame(step);
    vt.finished.finally(() => {
      live = false;
      if (gaps.length < 5) return;
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const sorted = [...gaps].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const max = sorted[sorted.length - 1];
      try {
        report?.({ n, cause, avg, p95, max, at: gaps.indexOf(max), frames: gaps.length });
      } catch {}
      if (n === 0 && !measured && avg > SLOW_FRAME_MS) {
        degraded = true;
        try {
          storage?.set("1");
        } catch {}
      }
      measured = true;
    });
  }

  /// Cambia a la paleta `p`. Devuelve lo que hizo ("skip", "plain", "wave").
  function change(p, { cause = "other", point = null } = {}) {
    const key = keyOf(p);
    const t = now();
    const lvl = level();
    const d = decide({
      same: key === lastKey,
      hidden: doc.visibilityState === "hidden",
      mini: mini(),
      busy: busy ? busy() : false,
      level: lvl,
      supported: typeof doc.startViewTransition === "function",
      degraded,
      sinceLast: t - lastAt,
    });
    if (d === "skip") return d;
    lastKey = key;
    lastAt = t;
    // una ola en curso no se espera: se salta y la nueva empieza ya
    if (current) {
      const old = current;
      current = null;
      try {
        old.skipTransition();
      } catch {}
      clear();
    }
    if (d === "plain") {
      apply(p);
      return d;
    }

    const c = { ...context(), point, flip };
    if (cause === "other" || !["ended", "resume", "next", "prev", "click", "download", "radio", "reco", "pause"].includes(cause)) flip = !flip;
    const o = waveOrigin(cause, c);
    const r = waveRadius(o.x, o.y, c.w, c.h) + 140;
    root.style.setProperty("--wave-x", `${Math.round(o.x)}px`);
    root.style.setProperty("--wave-y", `${Math.round(o.y)}px`);
    root.classList.add("wave-on");
    if (o.reverse) root.classList.add("wave-rev");

    let vt;
    try {
      vt = doc.startViewTransition(() => apply(p));
    } catch {
      clear();
      apply(p);
      return "plain";
    }
    current = vt;
    const dur = DUR[lvl] ?? DUR.completas;
    let anim = null;
    vt.ready
      .then(() => {
        if (current !== vt) return;
        const kf = o.reverse ? [{ "--wave-r": `${r}px` }, { "--wave-r": "0px" }] : [{ "--wave-r": "0px" }, { "--wave-r": `${r}px` }];
        anim = root.animate(kf, {
          duration: dur,
          easing: EASE,
          fill: "both",
          pseudoElement: o.reverse ? "::view-transition-old(root)" : "::view-transition-new(root)",
        });
      })
      .catch(() => {});
    measure(vt, cause);
    vt.finished
      .catch(() => {})
      .finally(() => {
        // la animación es del documento, no de la transición: si no se
        // cancela se queda viva y se aplicaría a la siguiente ola
        try {
          anim?.cancel();
        } catch {}
        if (current === vt) {
          current = null;
          clear();
        }
      });
    return d;
  }

  /// Termina ya la ola en curso (la paleta nueva ya está aplicada). Mientras
  /// dura una View Transition, Chromium manda todo clic a <html>: app.js la
  /// salta al pulsar para que el clic llegue a su sitio.
  function skip() {
    if (!current) return;
    const vt = current;
    current = null;
    try {
      vt.skipTransition();
    } catch {}
    clear();
  }

  return { change, skip };
}
