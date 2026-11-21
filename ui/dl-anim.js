// Animación de las descargas (Sprint 2, T6). Lógica pura, sin DOM: la
// pastilla (search.js) le pasa las tareas del motor y pinta la fase que esto
// decide. Regla del propietario: ninguna descarga termina de golpe.
//
// Fases: queued → resolving → downloading → converting → finishing (≈900 ms)
// → done; o error / cancelled en cualquier momento.

/// El llenado de 0 a 100 dura al menos esto, aunque la descarga real tarde 200 ms.
export const FILL_MIN_MS = 600;
/// «Finalizando»: barras arriba con rebote → línea → anillo → ✓ → pulso.
export const FINISH_MS = 900;
/// La campanilla suena justo cuando se dibuja el ✓.
export const CHIME_AT_MS = 620;
/// «▶ Escuchar» y «+ Cola» entran uno tras otro.
export const ACTS_STAGGER_MS = 60;

const RATE = 100 / FILL_MIN_MS; // % por ms como mucho
const BUSY = new Set(["queued", "resolving", "downloading", "converting", "finishing"]);

/// Fase visual de una tarea del motor.
export function phaseOf(task) {
  const s = task && task.state;
  if (s === "error") return /cancelad/i.test(task.error || "") ? "cancelled" : "error";
  if (s === "queued" || s === "resolving" || s === "downloading" || s === "converting" || s === "done") return s;
  return "queued";
}

/// Siguiente valor mostrado del avance: persigue al real con suavidad pero
/// sin pasar de `RATE` (así el llenado nunca es de golpe). Hacia abajo
/// (reintento) va al instante.
export function stepShown(shown, target, dt) {
  if (target <= shown) return target;
  const gap = target - shown;
  const eased = Math.max(gap * Math.min(1, dt / 150), 0.02 * dt);
  const next = shown + Math.min(gap, RATE * dt, eased);
  return target - next < 0.3 ? target : next;
}

/// Estado del botón de descargar de la pastilla (encima y pulsado los da el CSS).
export function buttonState(phase) {
  if (phase === "done") return "done";
  if (BUSY.has(phase)) return "busy";
  return "idle";
}

/// Controla la fase de una pastilla. `update(task)` con cada aviso del motor;
/// `tick(dt)` en cada fotograma mientras devuelva `true`.
export function createPillMotion({
  setPhase,
  onChime,
  onDone,
  setTimer = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer = (t) => globalThis.clearTimeout(t),
}) {
  let phase = null;
  let target = 0;
  let shown = 0;
  let pendingDone = false;
  let timers = [];

  const set = (p) => {
    if (p === phase) return;
    phase = p;
    setPhase(p);
  };
  const clear = () => {
    timers.forEach((t) => clearTimer(t));
    timers = [];
  };
  const finish = () => {
    set("finishing");
    timers.push(setTimer(() => onChime && onChime(), CHIME_AT_MS));
    timers.push(setTimer(() => {
      timers = [];
      set("done");
      onDone && onDone();
    }, FINISH_MS));
  };

  return {
    get phase() { return phase; },
    get shown() { return shown; },
    update(task) {
      if (phase === "finishing" || phase === "done") return;
      const p = phaseOf(task);
      if (p === "error" || p === "cancelled") {
        clear();
        pendingDone = false;
        set(p);
        return;
      }
      if (p === "done") {
        // las barras se llenan hasta arriba y entonces empieza el final
        pendingDone = true;
        target = 100;
        if (phase !== "converting") set("downloading");
        return;
      }
      pendingDone = false;
      set(p);
      target = p === "downloading" ? Math.max(0, Math.min(100, Number(task.progress_percent) || 0))
        : p === "converting" ? 100 : 0;
    },
    tick(dt) {
      shown = stepShown(shown, target, dt);
      if (pendingDone && shown >= 100) {
        pendingDone = false;
        finish();
        return false;
      }
      return shown !== target || pendingDone;
    },
  };
}

/// Resumen para la barra superior: en marcha, esperando, avance medio y velocidad total.
export function summarize(tasks) {
  let running = 0;
  let waiting = 0;
  let sum = 0;
  let speed = 0;
  for (const t of tasks) {
    if (t.state === "queued") waiting++;
    else if (t.state === "resolving" || t.state === "downloading" || t.state === "converting") running++;
    else continue;
    sum += Number(t.progress_percent) || 0;
    speed += Number(t.speed) || 0;
  }
  const left = running + waiting;
  return { running, waiting, left, speed, pct: left ? sum / left : 0 };
}

/// «2,4 MB/s», «512 KB/s» (vacío si no baja nada).
export function fmtSpeed(bps) {
  if (!bps) return "";
  const mb = bps / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1).replace(".", ",")} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}
