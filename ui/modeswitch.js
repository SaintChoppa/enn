// Cambio Simple ↔ Studio (Sprint 4, T6).
//
// El cambio de modo se envuelve en `document.startViewTransition()`. Las
// piezas que existen en los dos modos (carátula, título, botonera, cola…)
// llevan un nombre de transición propio solo mientras dura el cambio, así que
// el navegador las hace viajar y cambiar de tamaño hasta su sitio nuevo; las
// que solo existen en Studio entran y salen por su lado (styles.css).
//
// Sustituye al sistema de promesas de antes, que esperaba a que terminaran
// las animaciones de salida: con la ventana oculta no terminaban nunca y Enn
// se quedaba en Studio (auditoría 2026-11-13, hallazgo n.º 2). Ahora:
//   - el modo cambia siempre, a lo sumo a los CAP_MS;
//   - pulsar el otro modo a mitad invierte la transición desde donde esté;
//   - con teclado (o la ventana oculta) el cambio es instantáneo.
//
// Módulo sin dependencias e importable desde Node (ui/tests/modeswitch.test.js):
// todo el DOM llega por `env`.

/// Tope de seguridad: si la transición no ha terminado, el modo cambia igual.
export const CAP_MS = 900;

/// Piezas compartidas: [nombre de transición, selector]. Cada una es un único
/// nodo que app.js muda entre los dos modos (placeParts, placeEq, placeQueue).
export const MODE_PARTS = [
  ["np-art", "#now-playing .np-art-wrap"],
  ["np-title", "#np-title"],
  ["np-artist", "#np-artist"],
  ["transport", "#transport"],
  ["seek", ".seekwrap"],
  ["outdock", "#outdock"],
  ["queue", "#queue-panel"],
  ["eq", "#mix-eq-box"],
  ["lib-pane", "#library-pane"],
  ["downloads", "#view-downloads"],
  ["rail", "#rail"],
  // solo Studio: entran desde su lado
  ["stage-eq", "#stage-eq"],
  ["telemetry", "#studio-telemetry"],
];

/// "instant" (sin transición), "fade" (fundido de la página entera, Mínimas)
/// o "move" (elementos compartidos).
export function modeKind({ animate, supported, hidden, level }) {
  if (!animate || !supported || hidden) return "instant";
  if (level === "minimas") return "fade";
  return "move";
}

/// Controlador. `env`:
///   doc            documento (startViewTransition, getAnimations, querySelector)
///   apply(mode)    cambia el modo en el DOM, síncrono
///   current()      modo actual
///   level()        nivel de animación efectivo (completas, suaves, minimas)
///   visible(node)  opcional: ¿se ve de verdad? (un nodo dentro de un cajón
///                  cerrado se capturaría sin el recorte de su contenedor)
///   setTimeout / clearTimeout   opcionales (pruebas)
export function createModeSwitch(env) {
  const { doc, apply, current, level } = env;
  const visible = env.visible ?? (() => true);
  const setT = env.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = env.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const root = doc.documentElement;
  /// la transición en curso: { vt, from, to, reversed, gen, named, cap, over }
  let run = null;

  const dest = (r) => (r.reversed ? r.from : r.to);
  /// Lleva la página al modo `m` si aún no está (idempotente).
  function land(m) {
    if (current() !== m) apply(m);
  }

  /// Da nombre a las piezas que se ven y se lo quita a las que no. Se llama
  /// antes de capturar la vista vieja y otra vez tras cambiar el modo: una
  /// pieza que solo se ve en un lado entra o sale sola, sin viajar.
  function name(r) {
    for (const [n, sel] of MODE_PARTS) {
      let node = null;
      try {
        node = doc.querySelector(sel);
      } catch {}
      if (!node) continue;
      let show = false;
      try {
        show = visible(node);
      } catch {}
      node.style.viewTransitionName = show ? n : "";
      if (show && !r.named.includes(node)) r.named.push(node);
    }
  }

  /// Fin de la transición, venga de donde venga (final normal, salto o tope).
  function end(r) {
    if (r.over) return;
    r.over = true;
    clearT(r.cap);
    land(dest(r));
    root.classList.remove("mode-vt");
    root.classList.remove("mode-fade");
    for (const n of r.named) n.style.viewTransitionName = "";
    r.named = [];
    if (run === r) run = null;
  }

  function armCap(r) {
    clearT(r.cap);
    r.cap = setT(() => {
      land(dest(r));
      try {
        r.vt.skipTransition();
      } catch {}
      end(r);
    }, CAP_MS);
  }

  /// Animaciones de los pseudoelementos de la transición.
  function vtAnims() {
    try {
      return (doc.getAnimations?.() ?? []).filter((a) => String(a.effect?.pseudoElement ?? "").startsWith("::view-transition"));
    } catch {
      return [];
    }
  }

  /// Pone cada animación en el sentido que toca. Hacia atrás, cuando la última
  /// vuelve al principio la página regresa al modo de partida en ese mismo
  /// fotograma (el evento `finish` llega antes de que se suelte la transición),
  /// así que no se ve el modo de destino ni un instante.
  function syncReverse(r) {
    const gen = ++r.gen;
    const anims = vtAnims();
    for (const a of anims) {
      const back = (a.playbackRate ?? 1) < 0;
      if (back !== r.reversed) {
        try {
          a.reverse();
        } catch {}
      }
    }
    if (!r.reversed || !anims.length) return;
    let left = anims.length;
    const one = () => {
      if (gen === r.gen && r.reversed && --left === 0) land(r.from);
    };
    for (const a of anims) a.addEventListener?.("finish", one, { once: true });
  }

  /// Cambia al modo `mode`. Devuelve lo que hizo: "same", "instant", "fade",
  /// "move" o "reverse".
  function go(mode, { animate = true } = {}) {
    const r0 = run;
    if (r0) {
      if (!animate) {
        // teclado a mitad: al final que toque, sin animación
        r0.reversed = mode === r0.from;
        land(dest(r0));
        try {
          r0.vt.skipTransition();
        } catch {}
        end(r0);
        return "instant";
      }
      if (mode === dest(r0)) return "same";
      r0.reversed = !r0.reversed;
      syncReverse(r0);
      armCap(r0);
      return "reverse";
    }
    if (mode === current()) return "same";
    const kind = modeKind({
      animate,
      supported: typeof doc.startViewTransition === "function",
      hidden: doc.visibilityState === "hidden",
      level: level(),
    });
    if (kind === "instant") {
      apply(mode);
      return kind;
    }
    const r = { vt: null, from: current(), to: mode, reversed: false, gen: 0, named: [], cap: 0, over: false };
    run = r;
    root.classList.add(kind === "fade" ? "mode-fade" : "mode-vt");
    if (kind === "move") name(r);
    try {
      r.vt = doc.startViewTransition(() => {
        land(dest(r));
        if (kind === "move" && !r.over) name(r);
      });
    } catch {
      end(r);
      return "instant";
    }
    armCap(r);
    // si se invirtió antes de que existieran las animaciones, se aplica ahora
    Promise.resolve(r.vt.ready)
      .then(() => {
        if (!r.over && r.reversed) syncReverse(r);
      })
      .catch(() => {});
    Promise.resolve(r.vt.finished)
      .catch(() => {})
      .finally(() => end(r));
    return kind;
  }

  /// Termina ya el cambio en curso, en el modo al que iba.
  function skip() {
    const r = run;
    if (!r) return;
    land(dest(r));
    try {
      r.vt.skipTransition();
    } catch {}
    end(r);
  }

  return { go, skip, active: () => !!run };
}
