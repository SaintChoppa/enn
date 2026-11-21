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

// Bloque que se pega en motion.css. Regenerar con:
//   node -e "import('./ui/motion.js').then(m => process.stdout.write(m.cssTokens()))"
export function cssTokens() {
  const nombres = Object.keys(SPRINGS);
  const base = [];
  const suaves = [];
  const minimas = [];
  for (const n of nombres) {
    base.push(`  --spring-${n}: ${springLinear(SPRINGS[n])};`);
    base.push(`  --spring-${n}-ms: ${SPRINGS[n].duration}ms;`);
    suaves.push(`  --spring-${n}: ${SUAVE};`);
    suaves.push(`  --spring-${n}-ms: ${Math.round(SPRINGS[n].duration * 0.8)}ms;`);
    minimas.push(`  --spring-${n}: linear;`);
    minimas.push(`  --spring-${n}-ms: 1ms;`);
  }
  const t = ["  --t-fast: 1ms;", "  --t-base: 1ms;", "  --t-slow: 1ms;"];
  return [
    ":root {",
    ...base,
    "  --t-fast: 120ms;",
    "  --t-base: 220ms;",
    "  --t-slow: 420ms;",
    "}",
    "",
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
    "  :root {",
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
  const s = SPRINGS[kind] ?? SPRINGS.snappy;
  const nivel = motionLevel(root, mm);
  let tiempo;
  if (nivel === "minimas") {
    tiempo = { duration: 1, easing: "linear" };
  } else if (nivel === "suaves") {
    tiempo = { duration: s.duration * 0.8, easing: SUAVE };
  } else {
    tiempo = { duration: s.duration, easing: springLinear(s) };
  }
  return el.animate(keyframes, { ...tiempo, ...resto });
}
