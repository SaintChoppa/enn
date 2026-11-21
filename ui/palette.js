// Paleta reactiva: extrae el color de la carátula y lo inyecta como
// variables CSS. La base plateada no cambia; lo que cambia es el acento y
// un tinte muy leve, de modo que la app "respira" con la canción sin que
// el titanio deje de leerse como metal.
//
// Coste: se reescala la portada a 24×24 (576 px) en un canvas fuera de
// pantalla y se recorre una sola vez. Son microsegundos, y además el
// resultado se cachea por pista, así que volver a una canción ya escuchada
// no vuelve a calcular nada.

const SIZE = 24;
const MAX_CACHE = 240;

/** src de la carátula -> paleta ya calculada */
const cache = new Map();

let canvas = null;
let ctx = null;

function ctx2d() {
  if (!ctx) {
    canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    // willReadFrequently evita que el navegador suba el canvas a la GPU:
    // aquí solo leemos píxeles, nunca pintamos en pantalla.
    ctx = canvas.getContext("2d", { willReadFrequently: true });
  }
  return ctx;
}

// ---------------------------------------------------------------- color

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Lleva un color a un rango que se lee bien sobre obsidiana sin perder su
// identidad: se respeta el tono, y solo se corrigen saturación y luminosidad
// si se salen de lo legible. Una portada casi negra no puede dar un acento
// casi negro, y una fosforita no puede quemar la pantalla.
function normalize(h, s, l) {
  return [h, clamp(s, 0.32, 0.86), clamp(l, 0.55, 0.74)];
}

/** Plateado de reserva: portadas en blanco y negro, o sin carátula. */
export const SILVER = Object.freeze({
  h: 215,
  accent: [188, 198, 212],
  accent2: [138, 150, 168],
  grey: true,
});

// ---------------------------------------------------------------- extracción

// Agrupa los píxeles por tono en 24 cubos de 15° y devuelve los dos tonos
// con más peso. El peso no es la cuenta de píxeles a secas: se prima el
// color saturado y de luminosidad media, porque en una portada el fondo
// suele ser oscuro y plano, y lo que identifica al disco es el trazo de
// color, aunque ocupe pocos píxeles.
function analyze(data) {
  const BUCKETS = 24;
  const weight = new Float64Array(BUCKETS);
  const sumS = new Float64Array(BUCKETS);
  const sumL = new Float64Array(BUCKETS);
  const sumH = new Float64Array(BUCKETS);
  let colorful = 0;
  let greyL = 0;
  let greyN = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);

    // casi blanco o casi negro: sirve para saber si la portada es gris,
    // pero no puede ganar la votación de tono
    if (s < 0.12 || l < 0.08 || l > 0.94) {
      greyL += l;
      greyN++;
      continue;
    }

    const b = Math.min(BUCKETS - 1, Math.floor((h / 360) * BUCKETS));
    const w = s * (1 - Math.abs(l - 0.5) * 1.1);
    if (w <= 0) continue;
    weight[b] += w;
    sumS[b] += s * w;
    sumL[b] += l * w;
    sumH[b] += h * w;
    colorful += w;
  }

  // portada en blanco y negro: no inventamos un tono que no está
  if (colorful < 4) {
    return { ...SILVER, grey: true, coverLightness: greyN ? greyL / greyN : 0.5 };
  }

  let i1 = 0;
  for (let b = 1; b < BUCKETS; b++) if (weight[b] > weight[i1]) i1 = b;

  // el secundario tiene que estar a más de 45 grados del dominante, si no
  // serían el mismo color y el degradado quedaría plano
  let i2 = -1;
  const h1 = sumH[i1] / weight[i1];
  for (let b = 0; b < BUCKETS; b++) {
    if (!weight[b]) continue;
    const hb = sumH[b] / weight[b];
    let d = Math.abs(hb - h1);
    if (d > 180) d = 360 - d;
    if (d < 45) continue;
    if (i2 < 0 || weight[b] > weight[i2]) i2 = b;
  }

  const take = (b) => {
    const w = weight[b];
    return normalize(sumH[b] / w, sumS[b] / w, sumL[b] / w);
  };

  const [ha, sa, la] = take(i1);
  // sin secundario claro, se deriva girando el tono y bajando la luz: se
  // nota como profundidad sin meter un color ajeno a la portada
  const [hb, sb, lb] = i2 >= 0 ? take(i2) : [ha + 28, sa * 0.8, la * 0.78];

  return {
    h: ha,
    accent: hslToRgb(ha, sa, la),
    accent2: hslToRgb(hb, clamp(sb, 0.28, 0.8), clamp(lb, 0.42, 0.66)),
    grey: false,
  };
}

// Devuelve la paleta de una carátula. `src` puede ser un data-URI o una URL
// ya cacheada en disco por art.rs. Nunca lanza: si la imagen no carga,
// devuelve el plateado neutro.
export async function extractPalette(src) {
  if (!src) return SILVER;
  const hit = cache.get(src);
  if (hit) return hit;

  let palette;
  try {
    const img = new Image();
    img.decoding = "async";
    const loaded = new Promise((ok, fail) => {
      img.onload = ok;
      img.onerror = () => fail(new Error("carátula ilegible"));
    });
    img.src = src;
    await loaded;
    const c = ctx2d();
    c.clearRect(0, 0, SIZE, SIZE);
    c.drawImage(img, 0, 0, SIZE, SIZE);
    palette = analyze(c.getImageData(0, 0, SIZE, SIZE).data);
  } catch {
    palette = SILVER;
  }

  // caché sencilla con desalojo del más antiguo: 240 portadas es de sobra
  // para una sesión y no deja crecer la memoria sin control
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(src, palette);
  return palette;
}

// ---------------------------------------------------------------- aplicación

const rgb = (c) => `${c[0]}, ${c[1]}, ${c[2]}`;

// Inyecta la paleta en :root. Solo se tocan variables de acento y tinte —
// el plateado base vive en styles.css y no se mueve nunca.
let lastKey = null;

export function applyPalette(p) {
  const r = document.documentElement.style;
  const a = p.accent;
  const b = p.accent2;
  // Sprint 1: la misma paleta otra vez no hace nada. Antes, en reposo, el
  // sondeo la reaplicaba 4 veces por segundo: 13 variables en :root (estilo
  // de todo el documento recalculado) y un aviso que despertaba al
  // visualizador, que así no se detenía nunca (≈60 % de un núcleo sin música).
  const key = `${rgb(a)}|${rgb(b)}|${p.grey ? 1 : 0}`;
  if (key === lastKey) return;
  lastKey = key;

  // las variables *-rgb NO están registradas con @property, así que no
  // transicionan: los canvas las leen para tener el color nuevo al instante
  // (las registradas devolverían el valor a mitad del fundido CSS)
  r.setProperty("--accent-rgb", rgb(a));
  r.setProperty("--accent2-rgb", rgb(b));
  r.setProperty("--accent", `rgb(${rgb(a)})`);
  r.setProperty("--accent-2", `rgb(${rgb(b)})`);
  r.setProperty("--accent-soft", `rgba(${rgb(a)}, 0.16)`);
  r.setProperty("--accent-line", `rgba(${rgb(a)}, 0.38)`);
  r.setProperty("--thumb", `rgb(${rgb(a)})`);

  // el tinte es deliberadamente bajo: por encima de ~0.07 el plateado deja
  // de leerse como metal y la app se vuelve monocroma del color del disco
  r.setProperty("--tint", p.grey ? "rgba(0, 0, 0, 0)" : `rgba(${rgb(a)}, 0.055)`);
  r.setProperty("--tint-strong", p.grey ? "rgba(0, 0, 0, 0)" : `rgba(${rgb(a)}, 0.1)`);
  r.setProperty("--halo", `rgba(${rgb(a)}, 0.3)`);
  r.setProperty("--halo-2", `rgba(${rgb(b)}, 0.22)`);

  // los visualizadores pintan en canvas, que no ve las variables CSS por su
  // cuenta: se les avisa para que reconstruyan su degradado
  document.dispatchEvent(new CustomEvent("enn:palette"));
}

/** Vuelve al plateado neutro (sin pista, o pista sin carátula). */
export function resetPalette() {
  applyPalette(SILVER);
}

/** Atajo: extrae y aplica en un paso. */
export async function applyFromArt(src) {
  const p = await extractPalette(src);
  applyPalette(p);
  return p;
}
