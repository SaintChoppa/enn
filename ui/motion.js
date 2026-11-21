// Fichas de movimiento de Enn: muelles generados por física (no a ojo) como
// curvas CSS `linear()`, más niveles de intensidad (completas / suaves / mínimas).
//
// Módulo ES sin dependencias e importable desde Node (las pruebas lo hacen):
// no toca `document` ni `window` en el nivel superior.

export const SPRINGS = {
  snappy: { bounce: 0.15, duration: 260 },
  bouncy: { bounce: 0.35, duration: 520 },
  elastic: { bounce: 0.5, duration: 700 },
};

// Curva sin sobrepaso que usa el nivel «suaves» (misma que --ease-out de la app).
const SUAVE = "cubic-bezier(0.23, 1, 0.32, 1)";
const NIVELES = ["completas", "suaves", "minimas"];

// Cuánto ha de decaer la envolvente al llegar a t = 1: e^-LN_ASENTADO ≈ 0,001.
// Así el muelle queda prácticamente en 1 al final y el salto de «forzar» el
// último punto a 1 es invisible.
const LN_ASENTADO = Math.log(1000);

// Posición 0→1 de un muelle amortiguado en el instante normalizado t ∈ [0, 1].
// `bounce` al estilo Apple: 0 = críticamente amortiguado (sin sobrepaso); el
// coeficiente de amortiguamiento es ζ = 1 - bounce. La frecuencia natural se
// elige para que la envolvente exp(-ζ·ω·t) valga ≈ 0,001 en t = 1.
export function springValue(t, bounce) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const b = Math.min(Math.max(bounce, 0), 0.99);
  const zeta = 1 - b;
  const w = LN_ASENTADO / zeta;
  if (b === 0) {
    // críticamente amortiguado
    return 1 - (1 + w * t) * Math.exp(-w * t);
  }
  const wd = w * Math.sqrt(1 - zeta * zeta); // frecuencia amortiguada
  const env = Math.exp(-zeta * w * t);
  return 1 - env * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

// Redondea a 3 decimales y evita «-0».
function num(x) {
  const r = Math.round(x * 1000) / 1000;
  return String(r === 0 ? 0 : r);
}

// Cadena CSS `linear(0, …, 1)` válida para `transition-timing-function`.
export function springLinear({ bounce }, samples = 40) {
  const pts = [];
  for (let i = 0; i <= samples; i++) {
    pts.push(i === 0 ? 0 : i === samples ? 1 : springValue(i / samples, bounce));
  }
  return `linear(${pts.map(num).join(", ")})`;
}

// Sprint 4, T1: carácter del movimiento. Cambia cuánto rebota toda la app sin
// tocar las duraciones (la regla «lo frecuente va corto» no depende de él).
// `release` es el muelle con el que vuelven botones, interruptores y demás al
// soltar (`--ease-spring` + `--t-release` en CSS); `scale` multiplica el
// rebote de los tres muelles con nombre.
export const FEELS = {
  suave: { release: { bounce: 0.2, duration: 320 }, scale: 0.5 },
  medio: { release: { bounce: 0.45, duration: 400 }, scale: 1 },
  elastico: { release: { bounce: 0.6, duration: 540 }, scale: 1.3 },
};
// Elegido por el propietario en el laboratorio (2026-11-21); se cambia en Ajustes.
export const DEFAULT_FEEL = "suave";

/// Los tres muelles con el rebote escalado por el carácter `name`.
export function feelSprings(name) {
  const f = FEELS[name] ?? FEELS[DEFAULT_FEEL];
  const out = {};
  for (const [n, s] of Object.entries(SPRINGS)) {
    out[n] = f.scale === 1 ? s : { bounce: Math.round(s.bounce * f.scale * 1000) / 1000, duration: s.duration };
  }
  return out;
}

/// Carácter guardado en `root.dataset.feel`; desconocido o ausente → por defecto.
export function feelOf(root) {
  const r = root ?? globalThis.document?.documentElement;
  const f = r?.dataset?.feel;
  return f && FEELS[f] ? f : DEFAULT_FEEL;
}

export function setFeel(name, root = globalThis.document?.documentElement) {
  root.dataset.feel = FEELS[name] ? name : DEFAULT_FEEL;
}

// Variables de un carácter: los tres muelles más el soltado.
function feelVars(name) {
  const sp = feelSprings(name);
  const out = [];
  for (const n of Object.keys(sp)) {
    out.push(`  --spring-${n}: ${springLinear(sp[n])};`);
    out.push(`  --spring-${n}-ms: ${sp[n].duration}ms;`);
  }
  const r = FEELS[name].release;
  out.push(`  --ease-spring: ${springLinear(r)};`);
  out.push(`  --t-release: ${r.duration}ms;`);
  return out;
}

// Bloque que se pega en motion.css. Regenerar con:
//   node -e "import('./ui/motion.js').then(m => process.stdout.write(m.cssTokens()))"
// Orden y especificidad: :root (carácter por defecto) < [data-feel] (lo
// cambia, también en un contenedor, como hace el laboratorio) <
// :root[data-motion] (nivel) < reducir movimiento (gana a todo).
export function cssTokens() {
  const suaves = [];
  const minimas = [];
  for (const n of Object.keys(SPRINGS)) {
    suaves.push(`  --spring-${n}: ${SUAVE};`);
    suaves.push(`  --spring-${n}-ms: ${Math.round(SPRINGS[n].duration * 0.8)}ms;`);
    minimas.push(`  --spring-${n}: ease-out;`);
    minimas.push(`  --spring-${n}-ms: ${FADE_MS}ms;`);
  }
  suaves.push(`  --ease-spring: ${SUAVE};`, "  --t-release: 300ms;");
  // Sprint 4, T7: en Mínimas y con «reducir movimiento» nada se desplaza
  // (--mk = 0 anula el movimiento de las animaciones de styles.css) y lo que
  // aparece o desaparece se funde en 300 ms, en vez de cortar en 1 ms
  minimas.push("  --ease-spring: ease-out;", "  --t-release: 120ms;", "  --mk: 0;");
  const t = ["  --t-fast: 120ms;", `  --t-base: ${FADE_MS}ms;`, `  --t-slow: ${FADE_MS}ms;`];
  const feels = [];
  for (const f of Object.keys(FEELS)) feels.push(`[data-feel="${f}"] {`, ...feelVars(f), "}", "");
  return [
    ":root {",
    ...feelVars(DEFAULT_FEEL),
    // factor de movimiento de las animaciones CSS (1 = normal, 0 = solo fundido)
    "  --mk: 1;",
    "  --t-fast: 120ms;",
    "  --t-base: 220ms;",
    "  --t-slow: 420ms;",
    "}",
    "",
    ...feels,
    ':root[data-motion="suaves"] {',
    ...suaves,
    "  --t-fast: 96ms;",
    "  --t-base: 176ms;",
    "  --t-slow: 336ms;",
    "}",
    "",
    ':root[data-motion="minimas"] {',
    ...minimas,
    ...t,
    "}",
    "",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root, :root[data-motion], [data-feel] {",
    ...minimas.map((l) => "  " + l),
    ...t.map((l) => "  " + l),
    "  }",
    "}",
    "",
  ].join("\n");
}

// Aplica el nivel de intensidad a `root.dataset.motion`. Desconocido → completas.
export function setMotionLevel(level, root = globalThis.document?.documentElement) {
  root.dataset.motion = NIVELES.includes(level) ? level : "completas";
  syncStill(root);
}

/// Duración del fundido que sustituye al movimiento en Mínimas.
export const FADE_MS = 300;

/// `data-still` en la raíz cuando el nivel efectivo es Mínimas (elegido o por
/// «reducir movimiento» de Windows): styles.css lo usa para que nada se
/// desplace. Llamar también cuando cambie la preferencia del sistema.
export function syncStill(root = globalThis.document?.documentElement, mm) {
  if (!root?.dataset) return;
  if (motionLevel(root, mm) === "minimas") root.dataset.still = "1";
  else delete root.dataset.still;
}

const MOVE_KEYS = /^(transform|transformOrigin|translate|scale|rotate)$/;
/// Los mismos fotogramas sin nada que desplace (Mínimas): queda la opacidad.
export function stillKeyframes(kf) {
  if (!Array.isArray(kf)) return kf;
  return kf.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => !MOVE_KEYS.test(k))));
}

// Nivel efectivo: «minimas» si el sistema pide reducir movimiento; si no, el
// guardado en `root.dataset.motion`; por defecto «completas». `mm` es inyectable.
export function motionLevel(root, mm) {
  // globalThis: el módulo debe poder importarse en Node sin globales de navegador
  const r = root ?? globalThis.document?.documentElement;
  const q = mm ?? globalThis.matchMedia?.bind(globalThis);
  try {
    if (q && q("(prefers-reduced-motion: reduce)").matches) return "minimas";
  } catch {
    // matchMedia no disponible o roto: se ignora y se usa el nivel guardado
  }
  const guardado = r?.dataset?.motion;
  return NIVELES.includes(guardado) ? guardado : "completas";
}

// Envuelve `el.animate` (WAAPI) con la ficha de muelle y el nivel de intensidad.
// `opts` se mezcla con lo calculado; `root` y `matchMedia` son solo para pruebas.
export function spring(el, keyframes, kind = "snappy", opts = {}) {
  const { root, matchMedia: mm, ...resto } = opts;
  const sp = feelSprings(feelOf(root));
  const s = sp[kind] ?? sp.snappy;
  const nivel = motionLevel(root, mm);
  let tiempo;
  if (nivel === "minimas") {
    // solo el fundido: sin desplazamiento, sin rebote y sin escalonado. Lo que
    // solo se movía (FLIP, pulsaciones) no anima nada.
    const still = stillKeyframes(keyframes);
    const fades = Array.isArray(still) && still.some((f) => "opacity" in f);
    if (!fades) return el.animate([], { duration: 0, fill: resto.fill });
    return el.animate(still, { ...resto, duration: resto.duration ?? FADE_MS, easing: "ease-out", delay: 0 });
  } else if (nivel === "suaves") {
    tiempo = { duration: s.duration * 0.8, easing: SUAVE };
  } else {
    tiempo = { duration: s.duration, easing: springLinear(s) };
  }
  return el.animate(keyframes, { ...tiempo, ...resto });
}

// ---------------------------------------------------------------- Sprint 4, T3: controles

/// `transform-origin` (en px, relativo al menú) para que un menú nazca del
/// punto `pt` del clic aunque se haya colocado al otro lado para caber.
export function originFor(pt, rect) {
  const x = Math.min(Math.max(pt.x - rect.left, 0), rect.width);
  const y = Math.min(Math.max(pt.y - rect.top, 0), rect.height);
  return `${Math.round(x)}px ${Math.round(y)}px`;
}

/// Plan de un contador que rueda: cada carácter de `next` con `roll` = 1
/// (entra desde abajo: subió), -1 (desde arriba: bajó) o 0 (no se mueve).
/// Se alinea por la derecha, como se leen las cifras. Si alguno no es un
/// número, nada rueda.
export function rollPlan(prev, next) {
  const a = String(prev ?? "");
  const b = String(next ?? "");
  const num = (s) => /^\d+$/.test(s);
  if (!num(a) || !num(b)) return [...b].map((ch) => ({ ch, roll: 0 }));
  const dir = Math.sign(Number(b) - Number(a));
  const out = [];
  for (let i = 0; i < b.length; i++) {
    const j = a.length - b.length + i;
    const changed = j < 0 || a[j] !== b[i];
    out.push({ ch: b[i], roll: changed ? dir : 0 });
  }
  return out;
}

/// Cambia el texto de `el` haciendo rodar solo los dígitos que cambian.
/// Sin rodar (mismo texto, no números o movimiento mínimo) el texto se pone
/// tal cual. No bloquea: el valor nuevo está en el DOM desde el primer instante.
export function rollText(el, text) {
  const next = String(text);
  const prev = el.dataset.roll ?? el.textContent;
  el.dataset.roll = next;
  if (prev === next) return;
  const plan = rollPlan(prev, next);
  const lvl = motionLevel(el.ownerDocument?.documentElement);
  if (lvl === "minimas" || !plan.some((p) => p.roll) || typeof el.animate !== "function") {
    el.textContent = next;
    return;
  }
  el.textContent = "";
  for (const p of plan) {
    const s = el.ownerDocument.createElement("span");
    s.className = "roll-d";
    s.textContent = p.ch;
    el.appendChild(s);
    if (p.roll) {
      spring(s, [
        { transform: `translateY(${p.roll * 0.6}em)`, opacity: 0 },
        { transform: "none", opacity: 1 },
      ], "snappy");
    }
  }
}

/// Llama a `fn` cuando `anim` termina o, como tarde, a los `ms` + 50 ms: con
/// la ventana oculta o minimizada las animaciones se congelan y su final no
/// llega (así se colgaba el cambio a Simple, auditoría n.º 2). Una sola vez.
export function whenDone(anim, ms, fn) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    clearTimeout(t);
    fn();
  };
  const t = setTimeout(once, ms + 50);
  if (anim) anim.onfinish = once;
  return once;
}

// ---------------------------------------------------------------- Sprint 4, T4: listas

/// Claves estables para FLIP: la misma canción repetida en la cola recibe
/// `ruta#0`, `ruta#1`… en el orden en que aparece.
export function occurrenceKeys(ids) {
  const seen = new Map();
  return ids.map((id) => {
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}#${n}`;
  });
}

/// Qué hacer entre dos fotos de una lista (clave → rectángulo): `moves` con
/// el desplazamiento desde el sitio viejo, `enters` lo nuevo, `exits` lo que
/// se fue. Lo que se movió menos de 1 px no cuenta.
export function flipPlan(before, after) {
  const moves = [];
  const enters = [];
  for (const [key, b] of after) {
    const a = before.get(key);
    if (!a) {
      enters.push(key);
      continue;
    }
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) moves.push({ key, dx, dy });
  }
  const exits = [...before.keys()].filter((k) => !after.has(k));
  return { moves, enters, exits };
}

/// Retraso de la fila `i` en una entrada escalonada; `null` = sin animación
/// (las filas lejanas aparecen ya, nunca se hace esperar a una lista larga).
export function staggerDelay(i, step = 40, max = 10) {
  return i < max ? i * step : null;
}

/// -1 si la pestaña nueva está a la izquierda, 1 a la derecha, 0 si no se sabe.
export function tabDir(order, from, to) {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  return a < 0 || b < 0 ? 0 : Math.sign(b - a);
}

// en Mínimas también se mide: lo nuevo se funde (spring quita el movimiento)
const animado = (doc) => doc.visibilityState !== "hidden";

/// Foto de los hijos `[data-flip]` de `box` que se ven: clave → { rect, node }.
export function measureFlip(box) {
  const out = new Map();
  if (!box || !animado(box.ownerDocument)) return out;
  const view = box.getBoundingClientRect();
  for (const node of box.querySelectorAll(":scope > [data-flip]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom || !r.height) continue;
    out.set(node.dataset.flip, { rect: r, node });
  }
  return out;
}

/// Tras repintar `box`, cada fila viaja desde donde estaba (muelle «bouncy»),
/// la nueva entra con una escala leve y la que se fue se encoge en su sitio.
/// Nada espera: la lista ya es la nueva desde el primer fotograma.
export function playFlip(box, before) {
  if (!box || !before.size || !animado(box.ownerDocument)) return;
  const nodes = new Map();
  const after = new Map();
  const view = box.getBoundingClientRect();
  for (const node of box.querySelectorAll(":scope > [data-flip]")) {
    const r = node.getBoundingClientRect();
    if (r.bottom < view.top || r.top > view.bottom || !r.height) continue;
    nodes.set(node.dataset.flip, node);
    after.set(node.dataset.flip, r);
  }
  const rects = new Map([...before].map(([k, v]) => [k, v.rect]));
  const plan = flipPlan(rects, after);
  for (const m of plan.moves) {
    spring(nodes.get(m.key), [{ transform: `translate(${m.dx}px, ${m.dy}px)` }, { transform: "none" }], "bouncy");
  }
  plan.enters.forEach((k, i) => {
    spring(nodes.get(k), [{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }], "snappy", {
      delay: Math.min(i, 4) * 30,
      fill: "backwards",
    });
  });
  if (!plan.exits.length) return;
  if (getComputedStyle(box).position === "static") box.style.position = "relative";
  for (const k of plan.exits) {
    const { rect, node } = before.get(k);
    const g = node.cloneNode(true);
    delete g.dataset.flip;
    g.setAttribute("aria-hidden", "true");
    Object.assign(g.style, {
      position: "absolute",
      left: `${rect.left - view.left + box.scrollLeft}px`,
      top: `${rect.top - view.top + box.scrollTop}px`,
      width: `${rect.width}px`,
      margin: "0",
      pointerEvents: "none",
      zIndex: "1",
    });
    box.appendChild(g);
    const a = spring(g, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.92)" }], "snappy", {
      duration: 140,
      easing: "ease-in",
      fill: "forwards",
    });
    whenDone(a, 140, () => g.remove());
  }
}
