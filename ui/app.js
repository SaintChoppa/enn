import { applyFromArt, resetPalette } from "./palette.js";
import { initViz } from "./viz/index.js";
import { initSearch } from "./search.js";
import { summarize as dlSummarize, fmtSpeed } from "./dl-anim.js";
import { createRecoGate, mountRecoCard } from "./reco.js";
import { initSelects, openSelect } from "./select.js";
import { mark as perfMark, idleProbe, report as perfReport } from "./perf.js";

// medición del arranque (T1): el módulo se evalúa con el DOM ya leído
perfMark("dom");
requestAnimationFrame(() => perfMark("primera-pintura"));

// todos los desplegables con el estilo de la app (los nativos de Windows
// salían en blanco con el texto claro de la app encima: ilegibles, ADR #129)
initSelects();

const { invoke } = window.__TAURI__.core;
const dialog = window.__TAURI__.dialog;
const dialogOpen = dialog.open;
const dialogSave = dialog.save;

const AUDIO_EXTS = [
  "mp3", "flac", "wav", "aiff", "aif", "ogg", "oga",
  "m4a", "aac", "caf",
];

const EQ_FREQS = [31, 62, 125, 250, 500, "1k", "2k", "4k", "8k", "16k"];
const PRESETS = {
  rock: [5, 4, 3, 1, -1, -1, 1, 3, 4, 5],
  pop: [-1, 1, 3, 4, 3, -1, -1, 1, 2, 3],
  clasica: [4, 3, 2, 1, 0, 0, 1, 2, 3, 4],
  bajos: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  voz: [-2, -2, -1, 0, 2, 4, 4, 3, 1, -1],
  treble: [0, 0, 0, 0, 0, 1, 3, 5, 6, 6],
};

const $ = (id) => document.getElementById(id);
const el = {
  search: $("search"), libList: $("lib-list"), libEmpty: $("lib-empty"), libMeta: $("lib-meta"),
  queue: $("queue"), queueTitle: $("queue-title"), queueHint: $("queue-hint"), clear: $("btn-clear"),
  play: $("btn-play"), miniTitle: $("mini-title"), tCur: $("t-cur"), tDur: $("t-dur"),
  seek: $("seek"), volume: $("volume"), volNum: $("vol-num"),
  repeat: $("btn-repeat"), mixer: $("mixer"), btnMixer: $("btn-mixer"),
  device: $("device"), toast: $("toast"),
  bass: $("mix-bass"), treble: $("mix-treble"), balance: $("mix-balance"),
  fade: $("mix-fade"), fadeVal: $("mix-fade-val"), preset: $("eq-preset"), eqBands: $("eq-bands"),
  trackGain: $("mix-track"), trackGainVal: $("mix-track-val"),
  miniArt: $("mini-art"), qualityBadge: $("quality-badge"),
  dl: $("downloader"), dlBtn: $("btn-download"), dlUrl: $("dl-url"), dlStart: $("btn-dl-start"),
  dlTarget: $("dl-target"), dlList: $("dl-list"),
};

const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// ---------------------------------------------------------------- iconos SVG
const SVG = {
  play: '<svg viewBox="0 0 24 24"><polygon points="7 5 19 12 7 19 7 5" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><line x1="7" y1="4" x2="7" y2="20"/><line x1="17" y1="4" x2="17" y2="20"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>',
  next: '<svg viewBox="0 0 24 24"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>',
  repeat:
    '<svg viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  mixer:
    '<svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
};

function iconSet(id, key) {
  const n = $(id);
  if (n) n.innerHTML = SVG[key];
}
function iconSetMode(id, key, label) {
  const n = $(id);
  if (n) n.innerHTML = SVG[key] + `<span class="st">${label}</span>`;
}

// ---------------------------------------------------------------- estado
let library = [];          // Track[]
let filtered = [];         // índices sobre library tras el filtro
let libWinEnd = 500;       // renderizado por ventanas
let session = [];          // Track[] (cola/orden completo)
let curIdx = -1;           // índice en session de la pista actual
let repeatMode = 0;        // 0 ninguno · 1 todo · 2 una
let radioOn = false;       // modo radio: sugiere pistas al agotarse la cola
let playing = false;
let duration = 0;
let pos = 0;
let seeking = false;
let primedFor = null; // ruta de la pista para la que ya se cebó la siguiente (crossfade)
let toastTimer = null;
let deviceList = [];
let deviceSwitching = false;
let settingsTimer = null;
let currentPath = null;
let ui = {
  volume: 0.8, balance: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: 0, treble: 0, fade_secs: 0, rg_norm: true, rg_album: false,
  param_eq: [], // 4 × [freq, q, gain]
  exclusive: false,
  dl_parallel: 0, // descargas a la vez: 0 = Auto (3)
  dl_rate_kib: 0, // límite de velocidad, KiB/s (0 = sin límite)
  enrich_online: true, // etiquetas de Deezer, iTunes y YouTube Music (Sprint 3)
  lastfm_key: "", // opcional
};

/// Ganancia ReplayGain 2.0 de una pista: por pista, o por álbum (media de
/// sonoridad de todas las pistas analizadas del mismo artista+álbum).
/// Sonoridad conocida de una pista: la suya o la de la biblioteca (las pistas
/// de la cola son copias y no se enteran cuando el análisis termina).
function rgOf(track) {
  if (!track) return null;
  if (typeof track.rg === "number") return track.rg;
  const lib = library.find((x) => x.path === track.path);
  if (lib && typeof lib.rg === "number") {
    track.rg = lib.rg;
    return lib.rg;
  }
  return null;
}

function rgGainFor(track) {
  if (!ui.rg_norm) return 0;
  const own = rgOf(track);
  if (own === null) return 0;
  let lufs = own;
  if (ui.rg_album && track.artist && track.album) {
    let sum = 0, n = 0;
    for (const t of library) {
      if (t.artist === track.artist && t.album === track.album && typeof t.rg === "number") {
        sum += t.rg; n++;
      }
    }
    if (n >= 2) lufs = sum / n;
  }
  return Math.max(-15, Math.min(15, -18 - lufs));
}
let gainByPath = new Map(); // path -> dB
try {
  const g = JSON.parse(localStorage.getItem("enn.gains") || "{}");
  for (const [k, v] of Object.entries(g)) gainByPath.set(k, v);
} catch {}

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------- persistencia ligera
function saveQueue() {
  try { localStorage.setItem("enn.queue", JSON.stringify(session)); } catch {}
}
function saveModes() {
  try { localStorage.setItem("enn.modes", JSON.stringify({ r: repeatMode })); } catch {}
}
function loadModes() {
  try {
    const m = JSON.parse(localStorage.getItem("enn.modes") || "null");
    if (m) repeatMode = m.r ?? 0;
  } catch {}
}
/// Lo que el usuario puso en cola y aún no ha sonado (sin las elecciones
/// de la radio, que viajan por delante escondidas).
function upcomingCount() {
  let n = 0;
  for (let i = curIdx + 1; i < session.length; i++) if (!session[i].radio) n++;
  return n;
}
function queueLabel() {
  const n = upcomingCount();
  if (!n) return "Siguientes";
  return radioOn ? `Siguientes (${n}) · en espera` : `Siguientes (${n})`;
}

// ---------------------------------------------------------------- historial (B4)
// [{ path, title, artist, ts }] — máximo 500 entradas, en localStorage
let history = [];
try { history = JSON.parse(localStorage.getItem("enn.history") || "[]"); } catch {}
if (!Array.isArray(history)) history = [];

function recordHistory(track) {
  if (!track || !track.path) return;
  history = history.filter((h) => h.path !== track.path);
  history.unshift({
    path: track.path,
    title: track.title,
    artist: track.artist,
    ts: Date.now(),
  });
  if (history.length > 500) history.length = 500;
  try { localStorage.setItem("enn.history", JSON.stringify(history)); } catch {}
}

// El historial completo (hasta 500 entradas) va colapsado por defecto,
// como grupo aparte de "Escuchadas recientemente" (que ya vive en
// smartLists() y solo muestra un top 25) — evita renderizar 500 filas al
// abrir la pestaña Actividad cuando nadie las pidió todavía.
function renderHistory() {
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "group-head" + (historyOpen ? " open" : "");
  const arrow = document.createElement("span");
  arrow.className = "arrow";
  arrow.textContent = "▶";
  const name = document.createElement("span");
  name.className = "g-name";
  name.textContent = "Historial completo";
  const count = document.createElement("span");
  count.className = "g-count";
  count.textContent = `${history.length}`;
  head.append(arrow, name, count);
  head.addEventListener("click", () => {
    historyOpen = !historyOpen;
    renderLib();
  });
  frag.appendChild(head);
  if (historyOpen) {
    const body = document.createElement("div");
    body.className = "group-body open";
    const ul = document.createElement("ul");
    if (!history.length) {
      const li = document.createElement("li");
      li.className = "list-hint";
      li.style.display = "block";
      li.textContent = "Todavía no has escuchado nada en Enn.";
      ul.appendChild(li);
    }
    for (const h of history) {
      const li = rowEl({ path: h.path, title: h.title, artist: h.artist, dur: null });
      li.addEventListener("click", () => playPathNow(h.path));
      ul.appendChild(li);
    }
    body.appendChild(ul);
    frag.appendChild(body);
  }
  el.libList.appendChild(frag);
}

// ---------------------------------------------------------------- listas inteligentes (C1)
function smartLists() {
  const counts = new Map();
  for (const h of history) counts.set(h.path, (counts.get(h.path) || 0) + 1);
  const byPath = new Map(library.map((t) => [t.path, t]));
  const mostPlayed = [...counts.entries()]
    .map(([path, n]) => ({ t: byPath.get(path), n }))
    .filter((x) => x.t)
    .sort((a, b) => b.n - a.n)
    .slice(0, 25);
  // `history` ya viene deduplicada por ruta y ordenada del más reciente al
  // más antiguo (recordHistory hace unshift tras filtrar la entrada previa),
  // así que "recientemente escuchadas" es directamente sus primeros N
  // resueltos contra la biblioteca actual (título/álbum/arte al día, no la
  // foto vieja que se guardó en el momento de reproducir)
  const recent = history
    .map((h) => byPath.get(h.path))
    .filter(Boolean)
    .slice(0, 25);
  return [
    { name: "Escuchadas recientemente", tracks: recent },
    { name: "Más reproducidas", tracks: mostPlayed.map((x) => x.t) },
  ];
}

function renderSmart() {
  const frag = document.createDocumentFragment();
  for (const sl of smartLists()) {
    const head = document.createElement("div");
    head.className = "group-head" + (openSmart.has(sl.name) ? " open" : "");
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "▶";
    const name = document.createElement("span");
    name.className = "g-name";
    name.textContent = sl.name;
    const count = document.createElement("span");
    count.className = "g-count";
    count.textContent = `${sl.tracks.length}`;
    head.append(arrow, name, count);
    head.addEventListener("click", () => {
      if (openSmart.has(sl.name)) openSmart.delete(sl.name);
      else openSmart.add(sl.name);
      renderLib();
    });
    frag.appendChild(head);
    if (openSmart.has(sl.name)) {
      const body = document.createElement("div");
      body.className = "group-body open";
      const ul = document.createElement("ul");
      for (const t of sl.tracks) ul.appendChild(makeLibRow(t, null));
      body.appendChild(ul);
      frag.appendChild(body);
    }
  }
  el.libList.appendChild(frag);
}

// ---------------------------------------------------------------- construcción de filas
function rowEl(track, opts) {
  const { idx, removable = false, current = false } = opts || {};
  const li = document.createElement("li");
  li.dataset.path = track.path;
  if (freshPaths.has(track.path)) li.classList.add("fresh");
  if (current) li.classList.add("current");
  const art = document.createElement("span");
  art.className = "art";
  art.textContent = "▶";
  if (current) art.classList.add("on");
  const nm = document.createElement("span");
  nm.className = "nm";
  const t = document.createElement("div");
  t.className = "t-title";
  t.textContent = track.artist ? `${track.artist} — ${track.title}` : track.title;
  t.title = track.path;
  nm.appendChild(t);
  const d = document.createElement("span");
  d.className = "dur";
  d.textContent = track.dur ? fmtTime(track.dur) : "–";
  li.append(art, nm, d);
  if (idx !== undefined) li.dataset.idx = String(idx);
  if (removable) {
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Quitar de la cola";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAt(Number(li.dataset.idx));
    });
    li.appendChild(x);
  }
  return li;
}

// ---------------------------------------------------------------- cola / reproducción
/// Mueve una pista de la cola de `from` a `to`, corrigiendo el índice actual.
function moveQueueItem(from, to) {
  if (from < 0 || from >= session.length) return;
  if (to > from) to -= 1; // destino expresado como posición de inserción
  if (to < 0 || to >= session.length || to === from) return;
  const curPath = curIdx >= 0 && curIdx < session.length ? session[curIdx].path : null;
  const [item] = session.splice(from, 1);
  session.splice(to, 0, item);
  curIdx = curPath ? session.findIndex((s) => s.path === curPath) : -1;
  saveQueue();
  renderQueue();
}

/// Carátula pequeña de una fila de la cola: perezosa (solo al entrar en
/// pantalla) y compartida con la del pie a través de `artCache`.
const queueArtIO = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    queueArtIO.unobserve(e.target);
    const img = e.target;
    const path = img.dataset.path;
    const hit = artCache.get(path);
    const show = (uri) => {
      if (uri) { img.src = uri; img.classList.add("on"); }
    };
    if (hit !== undefined) { show(hit); continue; }
    invoke("album_art", { path })
      .then((uri) => { artCache.set(path, uri || null); show(uri); })
      .catch(() => artCache.set(path, null));
  }
}, { rootMargin: "120px" });

/// Fila de la cola: número de orden, carátula, título y artista debajo. La
/// primera va marcada como «Siguiente»; entre filas, una flecha ↓ (CSS).
function queueRowEl(track, n, idx) {
  const li = document.createElement("li");
  li.className = "q-row";
  li.dataset.idx = String(idx);
  li.dataset.path = track.path;
  if (n === 1) li.classList.add("q-next");
  const num = document.createElement("span");
  num.className = "q-num";
  num.textContent = String(n);
  const art = document.createElement("span");
  art.className = "q-art";
  const img = document.createElement("img");
  img.alt = "";
  img.draggable = false;
  img.dataset.path = track.path;
  art.appendChild(img);
  queueArtIO.observe(img);
  const meta = document.createElement("span");
  meta.className = "q-meta";
  const ti = document.createElement("span");
  ti.className = "q-title";
  ti.textContent = track.title || track.path.split(/[\\/]/).pop();
  ti.title = track.path;
  const ar = document.createElement("span");
  ar.className = "q-artist";
  ar.textContent = track.artist || "";
  meta.append(ti, ar);
  if (n === 1) {
    const tag = document.createElement("span");
    tag.className = "q-tag";
    tag.textContent = "Siguiente";
    meta.appendChild(tag);
  }
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.title = "Quitar de la cola";
  x.setAttribute("aria-label", "Quitar de la cola");
  x.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x" /></svg>';
  x.addEventListener("pointerdown", (e) => e.stopPropagation());
  x.addEventListener("click", (e) => {
    e.stopPropagation();
    removeAt(idx);
  });
  li.append(num, art, meta, x);
  return li;
}

// Arrastre propio con punteros (no el drag & drop HTML5, que pinta un
// fantasma estático): la fila sigue al ratón, las vecinas se apartan con un
// resorte y, mientras pasa por encima, se «aprietan» un poco (escala en Y),
// como si la fila empujara. Al soltar, la fila cae en su hueco y entonces se
// reordena la sesión. Un clic sin arrastre reproduce la pista.
// Un clic reproduce la fila. Para moverla hay que mantenerla pulsada un
// momento: al cumplirse Q_HOLD_MS la fila «se levanta» (escala y sombra) y ya
// se puede arrastrar. Si el puntero se mueve antes de eso, no es ni clic ni
// arrastre (se cancela), así un clic algo tembloroso no reordena nada.
const Q_HOLD_MS = 150; // petición del propietario (2026-11-12)
const Q_CLICK_SLOP = 6; // px de temblor que aún cuentan como clic
let qDrag = null;

function queuePointerDown(e) {
  if (e.button !== 0 || qDrag) return; // un solo arrastre a la vez
  const li = e.target.closest(".q-row");
  if (!li) return;
  const rows = Array.from(el.queue.querySelectorAll(".q-row"));
  qDrag = { li, rows, from: rows.indexOf(li), y0: e.clientY, x0: e.clientX, started: false, armed: false, moved: false, target: rows.indexOf(li), pid: e.pointerId };
  const d = qDrag;
  d.timer = setTimeout(() => {
    if (qDrag !== d || d.moved) return;
    d.armed = true;
    li.classList.add("q-armed"); // se levanta: ya se puede arrastrar
  }, Q_HOLD_MS);
  try { li.setPointerCapture(e.pointerId); } catch {} // el arrastre sigue aunque el puntero salga de la fila
  li.addEventListener("pointermove", queuePointerMove);
  li.addEventListener("pointerup", queuePointerUp);
  li.addEventListener("pointercancel", queuePointerUp);
}

function queuePointerMove(e) {
  const d = qDrag;
  if (!d || e.pointerId !== d.pid) return;
  const dy = e.clientY - d.y0;
  if (!d.armed) {
    // se movió antes de mantener lo suficiente: ni clic ni arrastre
    if (Math.abs(dy) > Q_CLICK_SLOP || Math.abs(e.clientX - d.x0) > Q_CLICK_SLOP) {
      d.moved = true;
      clearTimeout(d.timer);
    }
    return;
  }
  if (!d.started) {
    d.started = true;
    // las filas no miden lo mismo (la primera lleva la etiqueta «Siguiente»):
    // cada una se mide, y las vecinas se desplazan el alto de la arrastrada
    d.rects = d.rows.map((r) => r.getBoundingClientRect());
    d.gap = d.rows.length > 1 ? d.rects[1].top - d.rects[0].bottom : 4;
    d.h = d.rects[d.from].height + d.gap;
    el.queue.classList.add("q-dragging");
    d.li.classList.add("q-lifted");
  }
  d.li.style.transform = `translateY(${dy}px) scale(1.02)`;
  // a qué hueco apunta el centro de la fila arrastrada
  const me = d.rects[d.from];
  const center = me.top + dy + me.height / 2;
  let target = d.from;
  for (let i = 0; i < d.rows.length; i++) {
    const c = d.rects[i].top + d.rects[i].height / 2;
    if (i > d.from && center > c) target = i;
    if (i < d.from && center < c && target === d.from) target = i;
  }
  d.target = target;
  d.rows.forEach((r, i) => {
    if (r === d.li) return;
    let shift = 0;
    if (d.from < d.target && i > d.from && i <= d.target) shift = -d.h;
    if (d.from > d.target && i < d.from && i >= d.target) shift = d.h;
    // la vecina inmediata del hueco se aprieta: sensación de empujar
    const near = Math.abs(i - d.target) <= 1 && shift !== 0;
    r.style.transform = `translateY(${shift}px)${near ? " scaleY(0.94)" : ""}`;
  });
}

function queuePointerUp(e) {
  const d = qDrag;
  if (!d || e.pointerId !== d.pid) return;
  d.li.removeEventListener("pointermove", queuePointerMove);
  d.li.removeEventListener("pointerup", queuePointerUp);
  d.li.removeEventListener("pointercancel", queuePointerUp);
  qDrag = null;
  clearTimeout(d.timer);
  d.li.classList.remove("q-armed");
  if (!d.started) {
    // clic (soltó antes de mantener y sin moverse): reproduce la fila
    if (e.type === "pointerup" && !d.armed && !d.moved) playAtManual(Number(d.li.dataset.idx));
    return;
  }
  // la fila cae en su hueco con el resorte y después se reordena
  // hueco final: lo que suman las filas que la arrastrada ha saltado
  let slot = 0;
  if (d.target > d.from) for (let i = d.from + 1; i <= d.target; i++) slot += d.rects[i].height + d.gap;
  if (d.target < d.from) for (let i = d.target; i < d.from; i++) slot -= d.rects[i].height + d.gap;
  d.rows.forEach((r) => { if (r !== d.li) r.style.transform = r.style.transform.replace(/ scaleY\([^)]*\)/, ""); });
  d.li.classList.remove("q-lifted");
  d.li.classList.add("q-drop");
  d.li.style.transform = `translateY(${slot}px)`;
  const from = Number(d.li.dataset.idx);
  const toRow = d.rows[d.target];
  const to = Number(toRow.dataset.idx) + (d.target > d.from ? 1 : 0);
  const finish = () => {
    el.queue.classList.remove("q-dragging");
    if (d.target !== d.from) moveQueueItem(from, to);
    else { d.rows.forEach((r) => { r.style.transform = ""; }); d.li.classList.remove("q-drop"); }
  };
  if (REDUCE_MOTION_Q) finish();
  else setTimeout(finish, 220);
}

const REDUCE_MOTION_Q =
  !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

el.queue.addEventListener("pointerdown", queuePointerDown);

/// Rueda del ratón suave (petición del propietario, 2026-11-12): en vez de
/// saltar a trozos, la lista se desliza hacia el destino con una aproximación
/// exponencial (τ ≈ 90 ms, independiente de los fps). Varios giros seguidos se
/// suman al destino. Si se arrastra la barra de desplazamiento o el contenido
/// cambia, se re-sincroniza y no pelea con ello.
function smoothWheel(box) {
  if (!box || REDUCE_MOTION_Q) return;
  let target = 0, pos = 0, raf = 0, last = 0;
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  const step = (now) => {
    // alguien movió la lista por otro lado (barra, teclado, repintado)
    if (Math.abs(box.scrollTop - Math.round(pos)) > 2) { stop(); return; }
    const dt = Math.min(64, now - last);
    last = now;
    const k = 1 - Math.exp(-dt / 90);
    pos += (target - pos) * k;
    if (Math.abs(target - pos) < 0.5) pos = target;
    box.scrollTop = pos;
    if (pos === target) { raf = 0; return; }
    raf = requestAnimationFrame(step);
  };
  box.addEventListener("wheel", (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) return;
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? box.clientHeight : 1;
    if (!raf) { pos = box.scrollTop; target = pos; }
    target = Math.max(0, Math.min(max, target + e.deltaY * unit));
    e.preventDefault();
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(step); }
  }, { passive: false });
}
smoothWheel(el.queue);
smoothWheel(el.libList);

function renderQueue() {
  // ▶ se enciende o apaga según haya algo que poner
  updatePlayBtn();
  // Revisión 2026-11-12: si la lista se repintaba con una fila pulsada (p. ej.
  // al acabar la canción), la fila desaparecía sin recibir el pointerup y
  // `qDrag` se quedaba puesto: la cola no volvía a dejar arrastrar nada.
  if (qDrag) {
    clearTimeout(qDrag.timer);
    qDrag = null;
    el.queue.classList.remove("q-dragging");
  }
  el.queue.innerHTML = "";
  // las elecciones de la radio no son de la cola: no se enseñan
  let n = 0;
  for (let i = curIdx + 1; i < session.length; i++) {
    if (session[i].radio) continue;
    el.queue.appendChild(queueRowEl(session[i], ++n, i));
  }
  el.queueTitle.textContent = queueLabel();
  el.queueHint.style.display = n ? "none" : "";
}

let playPending = 0; // playAt en curso: el motor puede estar en idle un momento

// ---------------------------------------------------------------- escuchas (Sprint 3)
// El motor guarda escuchas, completas, saltos y transiciones (insights.rs).
// «manual» = la eligió el usuario (no la cola ni la radio): recentra la radio
// y cuenta como transición natural.
let manualNext = false;
let started = null; // { path, ended }
/// recomendaciones: lo pedido al motor para la que suena, y vista previa en curso
let recoFor = null;
let recoCardRef = null; // la tarjeta, cuando ya existe
let previewOn = false;
let repeatCycles = 0; // ciclos seguidos en «repetir una»
function playAtManual(i) {
  manualNext = true;
  return playAt(i);
}
function insightsEvent(kind, path, extra = {}) {
  if (!path) return;
  invoke("insights_event", { kind, path, ...extra }).catch(() => {});
}
/// La anterior se dejó a medias (siguiente, otra canción): cuenta su posición.
function insightsLeavePrev() {
  // también si vuelve a sonar la misma (⏭ con una sola canción): si no, la
  // escucha a medias quedaba abierta y se mezclaba con la siguiente
  if (started && !started.ended) insightsEvent("leave", started.path, { pos });
}

async function playAt(i, gainDb) {
  if (i < 0 || i >= session.length) return;
  playPending++;
  try {
    await playAtInner(i, gainDb);
  } finally {
    playPending--;
  }
}

/// Revisión 2026-11-12: al acabar la cola (o al perder el dispositivo) el
/// sondeo dejaba de refrescar la interfaz, porque solo lo hacía sonando o en
/// pausa: los colores seguían teñidos, el visualizador «sonando», el rótulo
/// decía «Reproduciendo ahora» y el botón podía quedarse en ⏸.
function applyIdle() {
  if (playing) {
    playing = false;
    updatePlayBtn();
  }
  if (document.body.dataset.playing !== "0") document.body.dataset.playing = "0";
  specSync();
  viz.setPlaying(false);
  syncPalette();
  paintKicker();
}

async function playAtInner(i, gainDb) {
  curIdx = i;
  renderQueue();
  const track = session[i];
  if (!track || typeof track.path !== "string" || !track.path) {
    try {
      await invoke("dbg_log", { msg: `playAt(${i}) ruta inválida: ${JSON.stringify(track)}`, level: "warn" });
    } catch {}
    toast("Esta canción no tiene ruta válida");
    return;
  }
  // si la duración no se conoce (MP3 VBR antiguos en la cola), se mide ahora
  if (!track.dur) {
    try {
      const r = await invoke("probe_paths", { paths: [track.path] });
      if (r.tracks && r.tracks[0] && r.tracks[0].dur) {
        Object.assign(track, r.tracks[0]);
        saveQueue();
        renderQueue();
      }
    } catch {}
  }
  try {
    // ganancia total = ajuste manual por pista + normalización ReplayGain 2.0,
    // aplicada desde la primera muestra (antes llegaba después de empezar y el
    // arranque de una canción fuerte se oía a todo volumen)
    const manual = gainDb ?? gainByPath.get(track.path) ?? 0;
    const g = manual + rgGainFor(track);
    await invoke("play_file", { path: track.path, dur: track.dur ?? null, gainDb: g });
    insightsLeavePrev();
    if (!started || started.path !== track.path) repeatCycles = 0;
    insightsEvent("start", track.path, { dur: track.dur ?? null, manual: manualNext });
    started = { path: track.path, ended: false };
    manualNext = false;
    recoReset(track.path);
    recordHistory(track);
    followTrackVolume();
    ensureLoudness(track);
    playing = true;
    updatePlayBtn();
    markPlayingRow();
    ensureRadioAhead();
  } catch (e) {
    try {
      await invoke("dbg_log", {
        msg: `playAt(${i}) tipo=${typeof track.path} valor=${JSON.stringify(track.path)} error=${e}`,
        level: "error",
      });
    } catch {}
    toast(`No se pudo reproducir: ${e}`);
    removeAt(i);
  }
}

// Auditoría 2026-11-13, n.º 8: el sondeo llama a markPlayingRow 4 veces por
// segundo y recorría todas las filas pintadas (hasta 500+) cada vez. Ahora
// solo recorre si cambió la canción o si la lista se repintó o creció.
let markedPath;
let markDirty = true;
new MutationObserver(() => { markDirty = true; }).observe(el.libList, { childList: true, subtree: true });

function markPlayingRow() {
  const p = curIdx >= 0 && curIdx < session.length ? session[curIdx].path : null;
  const changed = p !== markedPath;
  currentPath = p;
  if (changed) syncTrackGainUI();
  if (changed || markDirty) {
    markedPath = p;
    markDirty = false;
    for (const li of el.libList.querySelectorAll("li")) {
      const on = p !== null && li.dataset.path === p;
      li.classList.toggle("current", on);
      const art = li.querySelector(".art");
      if (art) art.classList.toggle("on", on);
    }
  }
  if (!p) {
    document.title = "Enn";
    hideMiniArt();
    return;
  }
}

/// ¿Está `path` entre las que faltan por sonar? La sesión guarda también lo
/// ya escuchado y lo que suena; antes se comparaba contra todo y por eso una
/// canción ya escuchada decía «Ya está en la cola» sin aparecer en Siguientes.
function isUpcoming(path) {
  for (let i = curIdx + 1; i < session.length; i++) if (!session[i].radio && session[i].path === path) return true;
  return false;
}

function pushTracks(list, { playNow = false, quiet = false } = {}) {
  if (!list || !list.length) return 0;
  let added = 0;
  for (const t of list) {
    if (!t || !t.path) continue;
    if (isUpcoming(t.path)) continue;
    session.push(t);
    added++;
  }
  saveQueue();
  renderQueue();
  // autoplay solo cuando el usuario acción explícita o la cola estaba vacía
  const shouldPlay = !quiet && (playNow || (curIdx < 0 && !playing) || session.length === added);
  if (added && shouldPlay) {
    if (playNow) manualNext = true;
    playAt(session.length - added);
  } else if (!playNow) {
    markPlayingRow();
  }
  return added;
}

function findInQueue(path) {
  return session.findIndex((s) => s.path === path);
}

async function playPathNow(path) {
  const inLib = library.find((x) => x.path === path);
  if (inLib) return playNowKeepingQueue(inLib);
  try {
    const probed = await invoke("probe_paths", { paths: [path] });
    if (probed.tracks && probed.tracks.length) {
      await playNowKeepingQueue(probed.tracks[0]);
    } else {
      throw new Error(probed.first_error || "Desconocido");
    }
  } catch (e) {
    toast(`Error al leer pista: ${e.message || e}`);
  }
}

/// Inserta una pista justo después de la que suena (reproducir a continuación).
function playNext(track) {
  if (!track || !track.path) return;
  const at = findInQueue(track.path);
  // la que suena no se mueve: sacarla de su sitio desordenaba la cola
  if (at >= 0 && at === curIdx) return toast("Ya está sonando");
  if (at === curIdx + 1) return toast("Ya es la siguiente");
  if (at >= 0) {
    const [item] = session.splice(at, 1);
    if (at < curIdx) curIdx--;
    // punto de inserción tras ajustar el índice por la eliminación
    session.splice(curIdx + 1, 0, item);
  } else {
    session.splice(curIdx + 1, 0, { ...track, soon: true });
  }
  if (session[curIdx + 1]) session[curIdx + 1].soon = true;
  saveQueue();
  renderQueue();
  toast(`A continuación: ${track.artist ? track.artist + " — " : ""}${track.title}`);
}

async function enqueuePath(path) {
  if (isUpcoming(path)) {
    toast("Ya está en la cola");
    return;
  }
  try {
    const probed = await invoke("probe_paths", { paths: [path] });
    if (probed.tracks && probed.tracks.length) {
      pushTracks(probed.tracks, { quiet: true });
      toast("Agregada a la cola");
    } else {
      throw new Error(probed.first_error || "Desconocido");
    }
  } catch (e) {
    toast(`Error al encolar pista: ${e.message || e}`);
  }
}

function removeAt(i) {
  if (i < 0 || i >= session.length) return;
  const wasCurrent = i === curIdx;
  const before = i < curIdx;
  session.splice(i, 1);
  if (wasCurrent) {
    curIdx = -1;
    invoke("stop");
    playing = false;
    updatePlayBtn();
  } else if (before) {
    curIdx--;
  }
  saveQueue();
  renderQueue();
  markPlayingRow();
}

async function onEnded() {
  if (started && !started.ended) {
    started.ended = true;
    insightsEvent("end", started.path);
    if (repeatMode === 2) repeatCycles++;
  }
  if (session.length === 0) return;
  if (repeatMode === 2 && curIdx >= 0) {
    playAt(curIdx);
    return;
  }
  // la radio manda: sigue al azar por la biblioteca y la cola espera.
  // (No hay aleatorio: la radio lo sustituye por completo, ADR #154.)
  if (radioOn) return radioOrSoon();
  const next = curIdx + 1;
  if (next < session.length) {
    playAt(next);
  } else if (repeatMode === 1) {
    playAt(0);
  } else {
    // sin repetición ni radio y fin de la cola: Enn se detiene aquí…
    // …y la interfaz tiene que detenerse también. El sondeo de 250 ms solo
    // refresca el estado en `playing`/`paused`, así que al pasar el motor a
    // `idle` el botón se quedaba en ⏸ y el reloj clavado en el total de la
    // pista (medido el 2026-10-03 con la app real).
    playing = false;
    updatePlayBtn();
    markPlayingRow();
  }
}

/// Modo radio (ADR #152; Sprint 3, ADR #175): la elige el motor siguiendo el
/// hilo de géneros y artistas, con su motivo (radio.rs). No usa la cola: lo
/// que hay en «Siguientes» se queda en espera y sigue donde estaba al apagar
/// la radio. Si el motor no responde, al azar sin repetir las últimas 80.
async function radioPick() {
  const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  try {
    const exclude = session.slice(curIdx + 1).filter((t) => !t.radio).map((t) => t.path);
    const r = await invoke("radio_next", { cur: cur ? cur.path : null, n: 1, exclude });
    const hit = r && r[0] && library.find((t) => t.path === r[0].path);
    // copia marcada: la marca no debe colarse en la biblioteca
    if (hit) return { ...hit, radio: true, why: r[0].reason };
  } catch {}
  const recent = new Set(session.slice(Math.max(0, curIdx - 80), curIdx + 1).map((t) => t.path));
  let pool = library.filter((t) => t.path && !recent.has(t.path));
  if (!pool.length) pool = library.filter((t) => t.path && (!cur || t.path !== cur.path));
  if (!pool.length) return null;
  return { ...pool[Math.floor(Math.random() * pool.length)], radio: true, why: "Al azar de tu biblioteca" };
}

/// Con la radio puesta, la próxima elección espera justo detrás de la que
/// suena (escondida de «Siguientes»): así el crossfade la puede preparar y
/// la cola del usuario queda intacta detrás.
let radioBusy = null;
/// Dónde va (o está) la elección de la radio: detrás de lo que el usuario
/// pidió «a continuación», que suena antes.
function radioSlot() {
  let j = curIdx + 1;
  while (session[j] && session[j].soon && !session[j].radio) j++;
  return j;
}
function ensureRadioAhead() {
  if (!radioOn || !library.length) return Promise.resolve(false);
  const nx = session[radioSlot()];
  if (nx && nx.radio) return Promise.resolve(true);
  if (radioBusy) return radioBusy;
  radioBusy = (async () => {
    const pick = await radioPick();
    if (!pick || !radioOn) return false;
    const at = radioSlot();
    if (session[at] && session[at].radio) return true;
    session.splice(at, 0, pick);
    saveQueue();
    renderQueue();
    return true;
  })().finally(() => { radioBusy = null; });
  return radioBusy;
}

/// Al apagar la radio se retira la elección que esperaba: lo siguiente vuelve
/// a ser la cola del usuario.
function dropRadioAhead() {
  for (let i = session.length - 1; i > curIdx; i--) if (session[i].radio) session.splice(i, 1);
  saveQueue();
  renderQueue();
}

async function radioNext() {
  if (!(await ensureRadioAhead())) return toast("No hay música en la biblioteca para el modo radio");
  playAt(radioSlot());
}

/// Con la radio puesta, «Siguientes» espera (ADR #152), salvo lo que el
/// usuario pidió expresamente «a continuación» (menú o recomendaciones):
/// eso suena primero y luego sigue la radio, como en Spotify.
function radioOrSoon() {
  const nx = session[curIdx + 1];
  if (nx && nx.soon && !nx.radio) {
    nx.soon = false;
    return playAt(curIdx + 1);
  }
  return radioNext();
}

async function nextManual() {
  if (radioOn) return radioOrSoon();
  if (!session.length) return;
  playAt((curIdx + 1 + session.length) % session.length);
}

function prevManual() {
  if (!session.length) return;
  if (curIdx >= 0 && pos > 3) {
    if (started && !started.ended) insightsEvent("seek", started.path, { pos, to: 0 });
    invoke("seek_to", { seconds: 0 });
    return;
  }
  playAt((curIdx - 1 + session.length) % session.length);
}

async function playFromLibrary(idx) {
  const t = filtered[idx] !== undefined ? library[filtered[idx]] : undefined;
  if (!t) return;
  if (!t.path) {
    try {
      await invoke("dbg_log", { msg: `playFromLibrary(${idx}) sin path: ${JSON.stringify(t)}`, level: "warn" });
    } catch {}
    toast("Esa entrada no tiene ruta");
    return;
  }
  playNowKeepingQueue(t);
}

/// Reproduce `t` ya, sin perder «Siguientes» (bug 2026-11-12): antes se
/// añadía al final de la sesión y se saltaba allí, así que todo lo que estaba
/// en cola pasaba a «ya escuchado». Ahora entra justo después de la actual y
/// el resto de la cola sigue detrás de ella.
function playNowKeepingQueue(t) {
  // si ya estaba en lo que falta por sonar, se saca de ahí (no se duplica)
  for (let i = session.length - 1; i > curIdx; i--) if (session[i].path === t.path) session.splice(i, 1);
  const at = curIdx + 1;
  session.splice(at, 0, t);
  saveQueue();
  return playAtManual(at);
}

// Un clic en una fila de la cola la reproduce; lo gestiona queuePointerUp,
// que distingue el clic del arrastre. Aquí vivía un manejador delegado antiguo
// que reproducía con cualquier clic, también al soltar tras arrastrar.

el.play.addEventListener("click", () => {
  // nada cargado: con la radio, arranca la radio (o lo pedido «a
  // continuación»); sin ella, lo primero de «Siguientes»
  if (engineState === "idle" && !playPending) {
    if (radioOn) return radioOrSoon();
    if (session.length > curIdx + 1) return playAtManual(curIdx + 1);
  }
  invoke("toggle_pause");
});
$("btn-next").addEventListener("click", nextManual);
$("btn-prev").addEventListener("click", prevManual);

// Animación al activar un botón de la pastilla: un anillo que se expande y
// se apaga (una vez, 420 ms). Solo al pasar a activo.
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".np-side-pill button");
  if (!b) return;
  requestAnimationFrame(() => {
    const on = b.classList.contains("active") || b.getAttribute("aria-expanded") === "true" || b.getAttribute("aria-pressed") === "true";
    if (!on || REDUCE_MOTION) return;
    b.classList.remove("pop");
    void b.offsetWidth;
    b.classList.add("pop");
  });
});

// altavoz del dock: abre la lista de salidas (la misma de Ajustes)
if ($("btn-output")) $("btn-output").addEventListener("click", (e) => openSelect(el.device, e.currentTarget));

el.repeat.addEventListener("click", () => {
  repeatMode = (repeatMode + 1) % 3;
  paintModes();
  saveModes();
});

const radioBtn = document.getElementById("btn-radio");
if (radioBtn) {
  try { radioOn = localStorage.getItem("enn.radio") === "1"; } catch {}
  radioBtn.classList.toggle("active", radioOn);
  radioBtn.addEventListener("click", () => {
    // en las dos vistas es la radio (ADR #152; antes, en Escenario, era el aleatorio)
    if (!radioOn && !library.length) return toast("Añade una carpeta de música para usar la radio");
    radioOn = !radioOn;
    try { localStorage.setItem("enn.radio", radioOn ? "1" : "0"); } catch {}
    if (radioOn) {
      // con la cola vacía (o nada sonando) empieza a sonar ya
      if (engineState === "idle" && !playPending) radioOrSoon();
      else ensureRadioAhead();
      toast(upcomingCount() ? "Radio: sigue el hilo de lo que escuchas · «Siguientes» espera" : "Radio: sigue el hilo de lo que escuchas");
    } else {
      dropRadioAhead();
      toast(upcomingCount() ? "Radio apagada · sigue «Siguientes»" : "Radio apagada");
    }
    paintModes();
  });
}

function paintModes() {
  const rb = $("btn-radio");
  if (rb) {
    rb.classList.toggle("active", radioOn);
    rb.setAttribute("aria-pressed", String(radioOn));
    rb.title = `Radio: sigue el hilo de géneros y artistas (${radioOn ? "on" : "off"}) · clic derecho: afinar`;
  }
  if (el.queueTitle) el.queueTitle.textContent = queueLabel();
  updatePlayBtn();
  el.repeat.classList.toggle("active", repeatMode !== 0);
  el.repeat.title = `Repetición: ${["off", "todo", "una"][repeatMode]}`;
  el.repeat.setAttribute("aria-pressed", String(repeatMode !== 0));
  iconSetMode("btn-repeat", "repeat", ["off", "all", "1"][repeatMode]);
}

// ---------------------------------------------------------------- biblioteca
function libCountText() {
  return `${library.length} canciones`;
}

let view = "all"; // all | artist | genre | year | albums | playlist | activity
let openGenreGroups = new Set();
let openYearGroups = new Set();
let expandedPl = null;
let openAlbum = null; // clave "artista\u0000álbum" expandida en la rejilla
let openSmart = new Set(); // listas inteligentes expandidas
let historyOpen = false; // historial completo (hasta 500), colapsado por defecto

// ---- carátulas: caché en memoria + carga diferida por visibilidad
const artCache = new Map(); // ruta de pista -> data URI
let artObserver = null;

function ensureArtObserver() {
  if (artObserver) return artObserver;
  artObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          artObserver.unobserve(en.target);
          loadArtInto(en.target);
        }
      }
    },
    { root: el.libList, rootMargin: "400px" }
  );
  return artObserver;
}

async function loadArtInto(img) {
  const p = img.dataset.art;
  if (!p) return;
  let uri = artCache.get(p);
  if (uri === undefined) {
    try {
      uri = await invoke("album_art", { path: p });
    } catch {
      uri = null;
    }
    artCache.set(p, uri);
  }
  if (uri) {
    img.src = uri;
  } else {
    img.classList.add("noart");
    img.textContent = "♪";
  }
}

function makeLibRow(track, i, opts = {}) {
  const li = rowEl(track, opts);
  const play = () => {
    // el clic también mueve el cursor de navegación por teclado, si no
    // las flechas seguirían desde donde se habían dejado antes del clic
    kbdFocusPath = track.path;
    applyKbdFocus();
    if (i === null || i === undefined) playPathNow(track.path);
    else playFromLibrary(i);
  };
  li.addEventListener("click", play);
  const fav = document.createElement("button");
  fav.className = "x fav" + (track.favorite ? " on" : "");
  fav.textContent = track.favorite ? "★" : "☆";
  fav.title = track.favorite ? "Quitar de favoritos" : "Marcar como favorita";
  fav.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !track.favorite;
    try {
      await invoke("lib_set_favorite", { path: track.path, favorite: next });
      track.favorite = next;
      fav.classList.toggle("on", next);
      fav.textContent = next ? "★" : "☆";
      fav.title = next ? "Quitar de favoritos" : "Marcar como favorita";
    } catch (err) {
      toast(`No se pudo actualizar favorito: ${err}`);
    }
  });
  li.appendChild(fav);
  const add = document.createElement("button");
  add.className = "x";
  add.textContent = "+";
  add.title = "Añadir a la cola";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const added = pushTracks([track]);
    if (!added) toast("Ya está en la cola");
  });
  li.appendChild(add);
  return li;
}

function updateLibMeta() {
  updateEmptyState();
  el.libMeta.textContent = filtered.length !== library.length
    ? `${filtered.length} de ${library.length} canciones`
    : libCountText();
  markPlayingRow();
}

// ---------------------------------------------------------------- vacío y reposo
// El vacío explica QUÉ pasa y ofrece la acción que lo resuelve; nunca es un
// texto suelto al fondo del listado. Son cuatro situaciones distintas y no se
// cuentan con el mismo texto:
//   · primer uso           → no hay ninguna carpeta guardada todavía
//   · biblioteca sin audio → hay carpetas guardadas y 0 pistas (lo que pasó el
//                            2026-10-03, cuando la carpeta quedó vacía en disco)
//   · búsqueda sin nada    → el filtro no encuentra nada
// `emptyFolders` se consulta una sola vez (primer tick del sondeo) para poder
// distinguir los dos primeros casos.
let emptyFolders = [];
let foldersRead = false;
let engineState = "idle";
let scanIssue = null; // { failed, message } del último escaneo, si falló algo

async function refreshFolders() {
  try {
    emptyFolders = (await invoke("lib_folders")) || [];
  } catch {
    emptyFolders = [];
  }
  updateEmptyState();
}

function updateEmptyState() {
  const q = (el.search.value || "").trim();
  const noResults = library.length > 0 && filtered.length === 0 && q !== "";
  const show = library.length === 0 || noResults;
  const wasHidden = el.libEmpty.classList.contains("hidden");
  el.libEmpty.classList.toggle("hidden", !show);
  if (!show) return;
  // el vacío aparece con un gesto suave (opacidad + escala, sin desplazamiento)
  if (wasHidden) popAnim(el.libEmpty, { from: "none" });

  const set = (icon, title, text, hint, actions) => {
    const u = document.querySelector("#lib-empty .empty-ic use");
    if (u) u.setAttribute("href", icon);
    $("empty-title").textContent = title;
    $("empty-text").textContent = text;
    $("empty-hint").textContent = hint || "";
    for (const [id, key] of [
      ["empty-folder", "folder"],
      ["empty-files", "files"],
      ["empty-rescan", "rescan"],
      ["empty-clear", "clear"],
    ]) {
      $(id).classList.toggle("hidden", !actions.includes(key));
    }
  };

  if (noResults) {
    set(
      "#i-search",
      `Nada coincide con «${q}»`,
      "Prueba con otras palabras o quita los filtros. Puedes filtrar por artista:, album:, género:, año: o formato:.",
      "",
      ["clear"],
    );
  } else if (scanIssue) {
    set(
      "#i-folder-open",
      "No se pudo leer tu música",
      scanIssue.message
        ? `El escaneo se quedó con este error: ${scanIssue.message}`
        : `No se pudieron leer ${scanIssue.failed} archivos de tus carpetas.`,
      "Comprueba que la carpeta sigue existiendo y que tu usuario puede leerla.",
      ["rescan", "folder"],
    );
  } else if (emptyFolders.length) {
    const where = emptyFolders.length === 1 ? emptyFolders[0] : `${emptyFolders.length} carpetas`;
    set(
      "#i-folder-open",
      "Las carpetas de tu biblioteca no tienen audio",
      `Tenemos guardadas ${where} y ahora mismo no hay ningún archivo de audio dentro.`,
      "Si moviste la música de sitio, vuelve a añadir la carpeta.",
      ["rescan", "folder"],
    );
  } else {
    set(
      "#i-music",
      "Tu música, en tu equipo",
      "Sin cuentas, sin suscripciones y sin telemetría: lo que suena son tus archivos.",
      "Se escanean las subcarpetas de la carpeta que elijas.",
      ["folder", "files"],
    );
  }
}

// las acciones del vacío reutilizan los botones reales del panel
$("empty-folder").addEventListener("click", () => $("btn-folder").click());
$("empty-files").addEventListener("click", () => $("btn-files").click());
$("empty-rescan").addEventListener("click", () => $("btn-rescan").click());
$("empty-clear").addEventListener("click", () => {
  el.search.value = "";
  el.search.dispatchEvent(new Event("input", { bubbles: true }));
  el.search.dispatchEvent(new Event("change", { bubbles: true }));
});

/// Estado de reposo: la tarjeta deja de mostrar una canción que ya no está en
/// la biblioteca (nada de pistas fantasma) y el transporte queda inerte. Nunca
/// corta audio en marcha: si el motor está sonando o en pausa, no toca nada.
let restPainted = false; // la tarjeta ya está en reposo: no repintar en cada sondeo

function paintRest() {
  if (engineState === "playing" || engineState === "paused") return;
  if (currentPath && library.some((t) => t.path === currentPath)) return;
  // Sprint 1: el sondeo llama aquí 4 veces por segundo sin nada cargado; antes
  // repintaba todo (y reaplicaba la paleta) cada vez
  if (restPainted && currentPath === null) return;
  restPainted = true;
  currentPath = null;
  lastTitle = null;
  lastArtPath = null;
  setNowPlayingText("Nada sonando", "Añade música para empezar");
  setNowPlayingArt(null);
  hideMiniArt();
  refreshWave(null);
  duration = 0;
  pos = 0;
  el.seek.value = "0";
  el.tCur.textContent = "0:00";
  el.tDur.textContent = "0:00";
  drawWave();
  el.miniTitle.textContent = "—";
  el.qualityBadge.classList.add("hidden");
  el.qualityBadge.textContent = "";
  updatePlayBtn();
  markPlayingRow();
}

// ---- vistas de «Todas las pistas» (petición del propietario, 2026-11-12; ADR #153)
const LIB_LAYOUTS = ["rows", "grid", "wheel", "compact"];
let libLayout = "rows";
try {
  const s = localStorage.getItem("enn.libLayout");
  if (LIB_LAYOUTS.includes(s)) libLayout = s;
} catch {}
const layoutBox = $("lib-layouts");
function paintLayouts() {
  if (layoutBox) {
    layoutBox.hidden = view !== "all";
    for (const b of layoutBox.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.layout === libLayout));
  }
  if (view === "all") el.libList.dataset.layout = libLayout;
  else delete el.libList.dataset.layout;
}
function setLibLayout(v) {
  if (!LIB_LAYOUTS.includes(v) || v === libLayout) return;
  libLayout = v;
  try { localStorage.setItem("enn.libLayout", v); } catch {}
  el.libList.scrollTop = 0;
  renderLib();
}
if (layoutBox) {
  layoutBox.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-layout]");
    if (b) setLibLayout(b.dataset.layout);
  });
  // radiogroup: flechas izquierda/derecha
  layoutBox.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = LIB_LAYOUTS.indexOf(libLayout);
    const n = LIB_LAYOUTS[(i + (e.key === "ArrowRight" ? 1 : LIB_LAYOUTS.length - 1)) % LIB_LAYOUTS.length];
    setLibLayout(n);
    const nb = layoutBox.querySelector(`[data-layout="${n}"]`);
    if (nb) nb.focus();
  });
}

/// «Rueda»: carrusel de carátulas. La del centro, grande y de frente; las
/// demás giran hacia los lados. Se gira con la rueda del ratón, las flechas
/// o pulsando una carátula; pulsar la del centro la reproduce. Solo existen
/// en el DOM las ±6 más cercanas (bibliotecas grandes).
let wheelPath = null;
function renderWheel() {
  const items = filtered;
  if (!items.length) return;
  let c = wheelPath ? items.findIndex((i) => library[i].path === wheelPath) : -1;
  if (c < 0 && currentPath) c = items.findIndex((i) => library[i].path === currentPath);
  let at = Math.max(0, c);
  const SPAN = 6;
  const wrap = document.createElement("div");
  wrap.className = "wheel";
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "listbox");
  wrap.setAttribute("aria-label", "Rueda de canciones: flechas para girar, Enter para reproducir");
  const stage = document.createElement("div");
  stage.className = "wheel-stage";
  const cap = document.createElement("div");
  cap.className = "wheel-cap";
  const capT = document.createElement("strong");
  const capA = document.createElement("span");
  const capN = document.createElement("span");
  capN.className = "wheel-n";
  cap.append(capT, capA, capN);
  wrap.append(stage, cap);
  el.libList.appendChild(wrap);
  const nodes = new Map(); // posición en `filtered` -> carátula

  const make = (p) => {
    const t = library[items[p]];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wheel-item";
    b.setAttribute("aria-label", `${t.title}${t.artist ? " — " + t.artist : ""}`);
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.dataset.art = t.path;
    b.appendChild(img);
    loadArtInto(img);
    b.addEventListener("click", () => {
      if (p === at) playFromLibrary(p);
      else go(p);
    });
    return b;
  };
  const place = (n, d) => {
    const a = Math.abs(d), s = Math.sign(d);
    n.style.setProperty("--x", String(a === 0 ? 0 : s * (62 + (a - 1) * 30)));
    n.style.setProperty("--r", String(-s * Math.min(a, 1) * 52));
    n.style.setProperty("--z", String(-a * 70));
    n.style.setProperty("--s", String(a === 0 ? 1 : Math.max(0.6, 0.86 - 0.05 * a)));
    n.style.zIndex = String(100 - a);
    n.style.opacity = a > 4 ? "0" : String(Math.max(0, 1 - a * 0.16));
    n.classList.toggle("center", d === 0);
    n.tabIndex = -1;
  };
  function layout() {
    for (let p = at - SPAN; p <= at + SPAN; p++) {
      if (p < 0 || p >= items.length || nodes.has(p)) continue;
      const n = make(p);
      place(n, p - at);
      n.classList.add("enter");
      nodes.set(p, n);
      stage.appendChild(n);
    }
    for (const [p, n] of nodes) {
      if (Math.abs(p - at) > SPAN) { n.remove(); nodes.delete(p); continue; }
      place(n, p - at);
      n.classList.toggle("playing", library[items[p]].path === currentPath);
    }
    requestAnimationFrame(() => { for (const n of stage.querySelectorAll(".enter")) n.classList.remove("enter"); });
    const t = library[items[at]];
    wheelPath = t.path;
    capT.textContent = t.title;
    capA.textContent = t.artist || "Sin artista";
    capN.textContent = `${at + 1} de ${items.length}`;
    wrap.setAttribute("aria-activedescendant", "");
  }
  function go(p) {
    const n = Math.max(0, Math.min(items.length - 1, p));
    if (n === at) return;
    at = n;
    layout();
  }
  // rueda: un paso por «muesca» (o por cada ~60 px de un touchpad)
  let acc = 0, lastStep = 0;
  wrap.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    acc += e.deltaMode === 1 ? d * 40 : d;
    const now = performance.now();
    if (Math.abs(acc) >= 60 && now - lastStep > 70) {
      go(at + Math.sign(acc));
      acc = 0;
      lastStep = now;
    }
  }, { passive: false });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); go(at + 1); }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); go(at - 1); }
    else if (e.key === "Home") { e.preventDefault(); go(0); }
    else if (e.key === "End") { e.preventDefault(); go(items.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); playFromLibrary(at); }
  });
  layout();
}

function renderLib() {
  el.libList.innerHTML = "";
  const sortBox = document.getElementById("lib-sortbox");
  if (sortBox) sortBox.hidden = view !== "all";
  paintLayouts();
  if (view === "artist") {
    renderByArtist();
  } else if (view === "genre") {
    renderByGenre();
  } else if (view === "year") {
    renderByYear();
  } else if (view === "albums") {
    renderAlbums();
  } else if (view === "playlist") {
    renderPlaylists();
  } else if (view === "activity") {
    renderSmart();
    renderHistory();
  } else if (libLayout === "wheel") {
    renderWheel();
  } else {
    renderFlat();
  }
  updateLibMeta();
}

// ---- vista "Álbumes": rejilla de carátulas con carga diferida
function renderAlbums() {
  const groups = new Map(); // clave -> { artist, album, items: [índices] }
  for (const i of filtered) {
    const t = library[i];
    const artist = (t.artist || "").trim() || "Sin artista";
    const album = (t.album || "").trim() || "Sencillos";
    const key = artist + "\u0000" + album;
    if (!groups.has(key)) groups.set(key, { artist, album, items: [] });
    groups.get(key).items.push(i);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "es"));
  const grid = document.createElement("div");
  grid.className = "albums-grid";
  const obs = ensureArtObserver();
  for (const key of keys) {
    const g = groups.get(key);
    const card = document.createElement("div");
    card.className = "album-card" + (openAlbum === key ? " open" : "");
    const cover = document.createElement("div");
    cover.className = "cover";
    const img = document.createElement("img");
    img.alt = "";
    img.dataset.art = library[g.items[0]].path;
    cover.appendChild(img);
    obs.observe(img);
    const name = document.createElement("span");
    name.className = "a-name";
    name.textContent = g.album;
    const artist = document.createElement("span");
    artist.className = "a-artist";
    artist.textContent = g.artist;
    const count = document.createElement("span");
    count.className = "a-count";
    count.textContent = `${g.items.length} canción(es)`;
    card.append(cover, name, artist, count);
    card.addEventListener("click", () => {
      openAlbum = openAlbum === key ? null : key;
      renderLib();
    });
    grid.appendChild(card);
    if (openAlbum === key) {
      const detail = document.createElement("div");
      detail.className = "album-detail";
      const ul = document.createElement("ul");
      ul.className = "track-list";
      for (const i of g.items) {
        ul.appendChild(makeLibRow(library[i], i));
      }
      detail.appendChild(ul);
      grid.appendChild(detail);
    }
  }
  el.libList.appendChild(grid);
}

// ---- orden de «Todas las pistas»: por defecto, lo modificado más reciente
// arriba; se recuerda entre sesiones. «Más escuchadas» usa el historial.
const LIB_SORTS = {
  mtime: { label: "Recientes", dir: -1, key: (t) => t.mtime || 0 },
  title: { label: "Título", dir: 1, key: (t) => (t.title || "").toLocaleLowerCase("es") },
  artist: { label: "Artista", dir: 1, key: (t) => (t.artist || "").toLocaleLowerCase("es") },
  album: { label: "Álbum", dir: 1, key: (t) => (t.album || "").toLocaleLowerCase("es") },
  year: { label: "Año", dir: -1, key: (t) => t.year || 0 },
  dur: { label: "Duración", dir: 1, key: (t) => t.dur || 0 },
  plays: { label: "Más escuchadas", dir: -1, key: (t) => playCountOf(t.path) },
};
let libSort = { by: "mtime", rev: false };
try {
  const s = JSON.parse(localStorage.getItem("enn.libSort") || "null");
  if (s && LIB_SORTS[s.by]) libSort = { by: s.by, rev: !!s.rev };
} catch {}
let playCounts = null;
function playCountOf(path) {
  if (!playCounts) {
    playCounts = new Map();
    for (const h of history) playCounts.set(h.path, (playCounts.get(h.path) || 0) + 1);
  }
  return playCounts.get(path) || 0;
}
function sortFiltered() {
  const s = LIB_SORTS[libSort.by] || LIB_SORTS.mtime;
  const dir = s.dir * (libSort.rev ? -1 : 1);
  playCounts = null;
  const k = new Map(filtered.map((i) => [i, s.key(library[i])]));
  filtered.sort((a, b) => {
    const x = k.get(a), y = k.get(b);
    const c = typeof x === "string" ? x.localeCompare(y, "es") : x - y;
    return c * dir || a - b;
  });
}
(function libSortControls() {
  const sel = document.getElementById("lib-sort");
  const dirBtn = document.getElementById("lib-sort-dir");
  if (!sel || !dirBtn) return;
  for (const [k, s] of Object.entries(LIB_SORTS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = s.label;
    sel.appendChild(o);
  }
  const paint = () => {
    sel.value = libSort.by;
    dirBtn.classList.toggle("rev", libSort.rev);
    dirBtn.title = libSort.rev ? "Orden invertido" : "Orden normal";
  };
  const apply = () => {
    try { localStorage.setItem("enn.libSort", JSON.stringify(libSort)); } catch {}
    paint();
    sortFiltered();
    libWinEnd = 500;
    renderLib();
  };
  sel.addEventListener("change", () => { libSort = { by: sel.value, rev: false }; apply(); });
  dirBtn.addEventListener("click", () => { libSort.rev = !libSort.rev; apply(); });
  paint();
})();

/// Fila completa de pista: carátula, título, artista, álbum · año, formato,
/// duración y acciones (favorito, añadir a la cola).
function richRow(track, i) {
  const li = makeLibRow(track, i);
  li.classList.add("trk-row");
  const art = li.querySelector(".art");
  if (art) {
    art.textContent = "";
    art.className = "trk-art";
    const img = document.createElement("img");
    img.alt = "";
    img.dataset.art = track.path;
    art.appendChild(img);
    ensureArtObserver().observe(img);
  }
  const nm = li.querySelector(".nm");
  if (nm) {
    nm.textContent = "";
    const ti = document.createElement("span");
    ti.className = "trk-title";
    ti.textContent = track.title;
    ti.title = track.path;
    const ar = document.createElement("span");
    ar.className = "trk-artist";
    ar.textContent = track.artist || "Sin artista";
    nm.append(ti, ar);
  }
  const extra = document.createElement("span");
  extra.className = "trk-album";
  extra.textContent = [track.album, track.year].filter(Boolean).join(" · ");
  const fmt = document.createElement("span");
  fmt.className = "trk-fmt";
  fmt.textContent = (track.path.split(".").pop() || "").toUpperCase();
  const dur = li.querySelector(".dur");
  li.insertBefore(extra, dur);
  li.insertBefore(fmt, dur);
  return li;
}

function renderFlat() {
  const n = Math.min(libWinEnd, filtered.length);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.appendChild(richRow(library[filtered[i]], i));
  }
  el.libList.appendChild(frag);
  applyKbdFocus();
}

// ---------------------------------------------------------------- navegación por teclado (E7)
// Solo en la vista "Todas" (plana): las vistas agrupadas/álbumes tienen su
// propia estructura de acordeón y no son una lista simple de filas.
let kbdFocusPath = null;

function libRows() {
  // ":scope > li" y no un selector genérico: en otras vistas el mismo
  // #lib-list contiene <div> de grupo, no solo <li> de pista
  return Array.from(el.libList.querySelectorAll(":scope > li"));
}

function applyKbdFocus() {
  if (view !== "all" || !kbdFocusPath) return;
  for (const li of libRows()) {
    li.classList.toggle("kbd-focus", li.dataset.path === kbdFocusPath);
  }
}

el.libList.addEventListener("keydown", (e) => {
  if (view !== "all") return;
  const rows = libRows();
  if (!rows.length) return;
  const curIdxInRows = rows.findIndex((li) => li.dataset.path === kbdFocusPath);

  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
    e.preventDefault();
    let next;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = rows.length - 1;
    else if (e.key === "ArrowDown") next = Math.min(curIdxInRows + 1, rows.length - 1);
    else next = Math.max(curIdxInRows - 1, 0);
    kbdFocusPath = rows[next].dataset.path;
    applyKbdFocus();
    rows[next].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    if (curIdxInRows < 0) return;
    e.preventDefault();
    // la fila con foco de teclado puede no ser la #0 de `filtered` si hay
    // scroll infinito de por medio — se resuelve por ruta, no por posición
    const flatIdx = filtered.findIndex((i) => library[i].path === kbdFocusPath);
    if (flatIdx >= 0) playFromLibrary(flatIdx);
  }
});

// ---- agrupador genérico: grupos expandibles con acordeón, usado por
// "Por artista"/"Por género"/"Por año" — misma UI, distinta clave de
// agrupación y su propio Set de grupos abiertos (independiente por vista,
// para que no se hereden expansiones entre pestañas por coincidencia de texto)
function renderGrouped(keyFn, openSet, sortNumeric) {
  const groups = new Map();
  for (const i of filtered) {
    const t = library[i];
    const key = keyFn(t);
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(i, t);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (!sortNumeric) return a.localeCompare(b, "es");
    // orden numérico descendente (más reciente primero); "Sin año" no es un
    // número — se manda siempre al final en vez de intercalarse al azar
    const na = Number(a), nb = Number(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b, "es");
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return nb - na;
  });
  const frag = document.createDocumentFragment();
  for (const key of keys) {
    const songs = groups.get(key);
    const head = document.createElement("div");
    head.className = "group-head" + (openSet.has(key) ? " open" : "");
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "▶";
    const name = document.createElement("span");
    name.className = "g-name";
    name.textContent = key;
    const count = document.createElement("span");
    count.className = "g-count";
    count.textContent = `${songs.size}`;
    head.append(arrow, name, count);
    head.addEventListener("click", () => {
      const nowOpen = openSet.has(key);
      if (nowOpen) openSet.delete(key);
      else openSet.add(key);
      head.classList.toggle("open", !nowOpen);
      const body = head.nextSibling;
      if (body && body.classList) body.classList.toggle("open", !nowOpen);
    });
    const body = document.createElement("div");
    body.className = "group-body" + (openSet.has(key) ? " open" : "");
    const ul = document.createElement("ul");
    for (const [i, t] of songs) {
      ul.appendChild(makeLibRow(t, i));
    }
    body.appendChild(ul);
    frag.appendChild(head);
    frag.appendChild(body);
  }
  el.libList.appendChild(frag);
}

let openArtist = null; // nombre del artista abierto (su página) o null

/// «A, B & C feat. D» → ["A", "B", "C", "D"]. Se separa por comas, «&»,
/// «feat./ft.» y « x ». No por « y »: rompería nombres como «Wisin y Yandel».
function splitArtists(s) {
  const out = [];
  const seen = new Set();
  for (const a of (s || "").split(/\s*(?:,|&|\bfeat\.?(?=\s)|\bft\.?(?=\s)|\s+x\s+)\s*/i)) {
    const n = a.trim();
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out.length ? out : ["Sin artista"];
}

// Foto del artista desde YouTube Music, cacheada 7 días por nombre (sin red,
// o si no se encuentra, queda la carátula de una de sus canciones).
const PHOTO_TTL = 7 * 24 * 3600 * 1000;
let artistPhotos = {};
try { artistPhotos = JSON.parse(localStorage.getItem("enn.artistPhotos") || "{}") || {}; } catch {}
const photoWait = new Map();
function artistPhoto(name) {
  const key = name.toLowerCase();
  const hit = artistPhotos[key];
  if (hit && Date.now() - hit.t < PHOTO_TTL) return Promise.resolve(hit.u);
  if (photoWait.has(key)) return photoWait.get(key);
  const p = invoke("music_artist_photo", { name })
    .then((u) => {
      artistPhotos[key] = { u: u || null, t: Date.now() };
      try { localStorage.setItem("enn.artistPhotos", JSON.stringify(artistPhotos)); } catch {}
      return u || null;
    })
    .catch(() => (hit ? hit.u : null)) // sin red: lo último que se supo
    .finally(() => photoWait.delete(key));
  photoWait.set(key, p);
  return p;
}
/// Pone la foto del artista en `img` cuando llegue (si llega).
function applyArtistPhoto(img, name) {
  if (name === "Sin artista") return;
  artistPhoto(name).then((u) => {
    if (!u || !img.isConnected) return;
    const pre = new Image();
    pre.onload = () => { img.src = u; img.classList.remove("noart"); img.textContent = ""; img.classList.add("photo"); };
    pre.src = u;
  });
}

function renderByArtist() {
  const groups = new Map();
  // cada artista por separado: una canción con dos artistas sale en los dos
  const display = new Map(); // clave en minúsculas -> nombre tal como se ve
  for (const i of filtered) {
    for (const name of splitArtists(library[i].artist)) {
      const k = name.toLowerCase();
      if (!display.has(k)) display.set(k, name);
      const shown = display.get(k);
      if (!groups.has(shown)) groups.set(shown, []);
      groups.get(shown).push(i);
    }
  }
  if (openArtist && groups.has(openArtist)) return renderArtistPage(openArtist, groups.get(openArtist));
  openArtist = null;
  const grid = document.createElement("div");
  grid.className = "artist-grid";
  const obs = ensureArtObserver();
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "es"));
  names.forEach((name, n) => {
    const items = groups.get(name);
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "artist-pill";
    pill.style.setProperty("--i", String(Math.min(n, 10)));
    const av = document.createElement("span");
    av.className = "artist-av";
    const img = document.createElement("img");
    img.alt = "";
    img.dataset.art = library[items[0]].path;
    av.appendChild(img);
    obs.observe(img);
    applyArtistPhoto(img, name);
    const meta = document.createElement("span");
    meta.className = "artist-meta";
    const nm = document.createElement("span");
    nm.className = "artist-name";
    nm.textContent = name;
    nm.title = name;
    const ct = document.createElement("span");
    ct.className = "artist-count";
    ct.textContent = items.length === 1 ? "1 canción" : `${items.length} canciones`;
    meta.append(nm, ct);
    pill.append(av, meta);
    pill.addEventListener("click", () => { openArtist = name; renderLib(); el.libList.scrollTop = 0; });
    grid.appendChild(pill);
  });
  el.libList.appendChild(grid);
}

function renderArtistPage(name, items) {
  const head = document.createElement("div");
  head.className = "artist-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "icon-btn artist-back";
  back.title = "Volver a los artistas";
  back.setAttribute("aria-label", "Volver a los artistas");
  back.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-chevron" /></svg>';
  back.addEventListener("click", () => { openArtist = null; renderLib(); });
  const av = document.createElement("span");
  av.className = "artist-av big";
  const img = document.createElement("img");
  img.alt = "";
  img.dataset.art = library[items[0]].path;
  av.appendChild(img);
  ensureArtObserver().observe(img);
  applyArtistPhoto(img, name);
  const meta = document.createElement("span");
  meta.className = "artist-meta";
  const nm = document.createElement("strong");
  nm.className = "artist-name";
  nm.textContent = name;
  const ct = document.createElement("span");
  ct.className = "artist-count";
  ct.textContent = items.length === 1 ? "1 canción" : `${items.length} canciones`;
  meta.append(nm, ct);
  head.append(back, av, meta);
  el.libList.appendChild(head);
  const ul = document.createElement("ul");
  ul.className = "track-list artist-tracks";
  for (const i of items) ul.appendChild(richRow(library[i], null));
  el.libList.appendChild(ul);
}

function renderByGenre() {
  renderGrouped((t) => (t.genre || "").trim() || "Sin género", openGenreGroups);
}

function renderByYear() {
  renderGrouped((t) => (t.year ? String(t.year) : "Sin año"), openYearGroups, true);
}

// ---- vista "Playlist"
async function renderPlaylists() {
  try {
    const plDir = await invoke("playlist_dir");
    const info = document.getElementById("pl-info");
    if (info) info.textContent = plDir ? `Guardadas en: ${plDir}` : "";
    document.getElementById("pl-bar").classList.remove("hidden");
  } catch {}
  let pls = [];
  try {
    pls = await invoke("playlist_list");
  } catch {}
  const frag = document.createDocumentFragment();
  const listUL = document.createElement("ul");
  for (const pl of pls) {
    const item = document.createElement("li");
    item.className = "pl-item";
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = expandedPl === pl.name ? "▼" : "▶";
    const name = document.createElement("span");
    name.className = "pl-name";
    name.textContent = pl.name;
    const count = document.createElement("span");
    count.className = "pl-count";
    count.textContent = `${pl.count} canción(es)`;
    item.append(arrow, name, count);
    item.addEventListener("click", () => {
      expandedPl = expandedPl === pl.name ? null : pl.name;
      renderLib();
    });
    listUL.appendChild(item);
    if (expandedPl === pl.name) {
      const body = document.createElement("div");
      body.className = "group-body open";
      const inner = document.createElement("ul");
      inner.className = "track-list";
      const tracks = await invoke("playlist_content", { name: pl.name });
      for (const t of tracks) {
        const li = rowEl(t);
        li.addEventListener("click", () => {
          const known = findInQueue(t.path);
          if (known >= 0) {
            playAtManual(known);
          } else {
            session.push(t);
            saveQueue();
            renderQueue();
            playAtManual(session.length - 1);
          }
        });
        const rm = document.createElement("button");
        rm.className = "x";
        rm.textContent = "✕";
        rm.title = "Quitar de la playlist";
        rm.addEventListener("click", async (e) => {
          e.stopPropagation();
          await invoke("playlist_remove", { name: pl.name, path: t.path });
          renderLib();
        });
        li.appendChild(rm);
        inner.appendChild(li);
      }
      body.appendChild(inner);
      frag.appendChild(body);
    }
  }
  frag.appendChild(listUL);
  el.libList.appendChild(frag);
}

el.search.addEventListener("input", () => {
  const q = el.search.value.trim().toLowerCase();
  // Petición del propietario (2026-11-12): con el panel de pistas cerrado la
  // búsqueda filtraba una lista que no se veía. Al empezar a escribir se abre.
  if (q) openLibraryForSearch();
  // búsqueda avanzada: artista:…, album:…, formato:…, favorito: (prefijos) + texto libre
  const filters = [];
  const free = [];
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(artista|álbum|album|género|genero|año|ano|formato|ext|favorito|favorita|fav):(.*)$/i);
    if (m) {
      let key = m[1].toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
      if (key === "favorita" || key === "fav") key = "favorito";
      if (key === "genero") key = "género";
      if (key === "ano") key = "año";
      filters.push([key, m[2].toLowerCase()]);
    } else {
      free.push(tok);
    }
  }
  const freeQ = free.join(" ");
  filtered = library
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (freeQ && !`${t.title} ${t.artist} ${t.album} ${t.genre || ""}`.toLowerCase().includes(freeQ)) {
        return false;
      }
      for (const [key, val] of filters) {
        // "favorito:" no necesita valor: su sola presencia filtra a favoritas
        if (key === "favorito") {
          if (!t.favorite) return false;
          continue;
        }
        if (!val) continue;
        if (key === "artista" && !(t.artist || "").toLowerCase().includes(val)) return false;
        if (key === "album" && !(t.album || "").toLowerCase().includes(val)) return false;
        if (key === "género" && !(t.genre || "").toLowerCase().includes(val)) return false;
        if (key === "año" && String(t.year || "") !== val) return false;
        if (key === "formato" || key === "ext") {
          const ext = (t.path.split(".").pop() || "").toLowerCase();
          if (ext !== val) return false;
        }
      }
      return true;
    })
    .map((x) => x.i);
  sortFiltered();
  libWinEnd = 500;
  renderLib();
});

el.libList.addEventListener("scroll", () => {
  if (view !== "all" || libLayout === "wheel") return;
  if (
    libWinEnd < filtered.length &&
    el.libList.scrollTop + el.libList.clientHeight >= el.libList.scrollHeight - 400
  ) {
    const before = libWinEnd;
    libWinEnd = Math.min(filtered.length, libWinEnd + 300);
    const frag = document.createDocumentFragment();
    for (let i = before; i < libWinEnd; i++) {
      frag.appendChild(richRow(library[filtered[i]], i));
    }
    el.libList.appendChild(frag);
    markPlayingRow();
  }
});

/// Abre el panel de pistas para enseñar lo que se busca: si está cerrado, o
/// en una pestaña sin lista de canciones (Playlists, Actividad), en «Todas».
function openLibraryForSearch() {
  const listTab = shell.libTab && !["playlist", "activity"].includes(shell.libTab) ? shell.libTab : "all";
  if (shell.view !== "library") goView("library", listTab);
  else if (listTab !== shell.libTab) goView("library", "all");
  if (libPane && libPane.classList.contains("collapsed")) setLibCollapsed(false);
}

// ---- pestañas de vista
function setView(v) {
  const changed = v !== view;
  view = v;
  for (const id of ["tab-all", "tab-artist", "tab-genre", "tab-year", "tab-albums", "tab-playlist", "tab-activity"]) {
    document.getElementById(id).classList.toggle("active", id === `tab-${v}`);
  }
  const bar = document.getElementById("pl-bar");
  if (bar) bar.classList.toggle("hidden", v !== "playlist");
  if (v === "playlist") expandedPl = null;
  if (v !== "albums") openAlbum = null;
  if (v !== "artist") openArtist = null;
  // pequeño crossfade al cambiar de pestaña: sin esto el contenido de la
  // lista se reemplazaba de golpe, se sentía más "página recargada" que app
  if (changed && el.libList) {
    el.libList.style.opacity = "0";
    requestAnimationFrame(() => {
      try {
        renderLib();
      } finally {
        requestAnimationFrame(() => { el.libList.style.opacity = "1"; });
      }
    });
  } else {
    renderLib();
  }
}
document.getElementById("tab-all").addEventListener("click", () => setView("all"));
document.getElementById("tab-artist").addEventListener("click", () => setView("artist"));
document.getElementById("tab-genre").addEventListener("click", () => setView("genre"));
document.getElementById("tab-year").addEventListener("click", () => setView("year"));
document.getElementById("tab-albums").addEventListener("click", () => setView("albums"));
document.getElementById("tab-playlist").addEventListener("click", () => setView("playlist"));
document.getElementById("tab-activity").addEventListener("click", () => setView("activity"));

$("btn-pl-create").addEventListener("click", async () => {
  const name = document.getElementById("pl-name").value.trim();
  if (!name) return toast("Escribe un nombre primero");
  try {
    await invoke("playlist_create", { name });
    document.getElementById("pl-name").value = "";
    toast(`Playlist «${name}» creada`);
    renderLib();
  } catch (e) {
    toast(String(e));
  }
});

document.getElementById("tab-playlist").addEventListener("click", () => {
  const name = document.getElementById("pl-name");
  if (name) setTimeout(() => name.focus(), 60);
});

// añade la pista que suena ahora a la playlist abierta (expandida) en la vista
$("btn-pl-add").addEventListener("click", async () => {
  if (!expandedPl) return toast("Abre (expande) primero una playlist de la lista");
  const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  if (!cur) return toast("No está sonando ninguna canción");
  try {
    const n = await invoke("playlist_add", { name: expandedPl, track: cur });
    toast(n ? `Añadida a «${expandedPl}»` : "Ya estaba en la playlist");
    renderLib();
  } catch (e) {
    toast(String(e));
  }
});
// Autocompletado del editor de etiquetas: nombres ya presentes en la
// biblioteca, para no volver a escribir "Bad Bunny" letra por letra ni
// terminar con "Bad bunny"/"bad Bunny" como artistas distintos por un typo.
function refreshTagDatalists() {
  const artists = new Set();
  const albums = new Set();
  for (const t of library) {
    if (t.artist) artists.add(t.artist);
    if (t.album) albums.add(t.album);
  }
  const fill = (id, values) => {
    const dl = document.getElementById(id);
    if (!dl) return;
    dl.innerHTML = "";
    for (const v of Array.from(values).sort((a, b) => a.localeCompare(b, "es"))) {
      const opt = document.createElement("option");
      opt.value = v;
      dl.appendChild(opt);
    }
  };
  fill("artists-datalist", artists);
  fill("albums-datalist", albums);
}

async function reloadLibrary() {
  try {
    library = await invoke("lib_list");
    perfMark("biblioteca-leida");
  } catch (e) {
    library = [];
  }
  filtered = library.map((_, i) => i);
  sortFiltered();
  libWinEnd = 500;
  renderLib();
  refreshTagDatalists();
}

// ---------------------------------------------------------------- añadir archivos/carpetas
async function openFiles() {
  const sel = await dialogOpen({
    multiple: true,
    filters: [{ name: "Audio", extensions: AUDIO_EXTS }],
  });
  const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
  if (!paths.length) return;
  try {
    const r = await invoke("probe_paths", { paths });
    if (r.tracks && r.tracks.length) {
      pushTracks(r.tracks);
      toast(`${r.tracks.length} canción(es) agregada(s)`);
    } else {
      toast(`Ninguno se pudo leer: ${r.first_error || "?"}`);
    }
    if (r.failed && r.tracks.length) {
      setTimeout(() => toast(`${r.failed} archivo(s) no legible(s): ${r.first_error || "?"}`), 1500);
    }
  } catch (e) {
    toast(`Error: ${e}`);
  }
}

/// Guarda el resultado del último escaneo: si falló algo, el estado vacío lo
/// cuenta (permisos, ruta rota) en vez de decir sin más que «no hay audio».
function noteScan(r) {
  const failed = r && r.failed ? r.failed : 0;
  scanIssue = failed > 0 ? { failed, message: (r && r.first_error) || "" } : null;
}

async function addFolder() {
  const dir = await dialogOpen({ directory: true });
  if (!dir) return;
  try {
    const r = await invoke("lib_add", { folder: dir });
    noteScan(r);
    if (r.added > 0) {
      toast(`${r.added} canciones indexadas${r.failed ? ` (${r.failed} no leídas)` : ""}`);
    } else if (r.failed > 0) {
      toast(`No se pudo leer ningún audio ahí: ${r.first_error || "?"}`);
    } else {
      toast("La carpeta no tenía audio nuevo (o ya estaba indexada)");
    }
    await reloadLibrary();
  } catch (e) {
    scanIssue = { failed: 0, message: String(e) };
    toast(`Error al indexar: ${e}`);
  }
}

$("btn-folder").addEventListener("click", addFolder);
$("btn-files").addEventListener("click", openFiles);
$("btn-batch-tags").addEventListener("click", () => {
  // el filtro de búsqueda es la "selección múltiple": exigir uno activo
  // evita editar por accidente toda la biblioteca con un clic
  if (!el.search.value.trim()) {
    return toast("Escribe algo en el buscador para elegir qué canciones editar");
  }
  const tracks = filtered.map((i) => library[i]);
  if (!tracks.length) return toast("La búsqueda actual no tiene resultados");
  showBatchTagEditor(tracks);
});
$("btn-rescan").addEventListener("click", async () => {
  try {
    const r = await invoke("lib_refresh");
    noteScan(r);
    await reloadLibrary();
    toast(`Biblioteca actualizada (+${r.added}${r.failed ? `, ${r.failed} no leídas` : ""})`);
  } catch (e) {
    scanIssue = { failed: 0, message: String(e) };
    toast(`Error al re-escanear: ${e}`);
  }
});

// ---------------------------------------------------------------- playlists
async function savePlaylist() {
  if (!session.length) return toast("La cola está vacía");
  const path = await dialogSave({
    defaultPath: "enn.m3u8",
    filters: [{ name: "Playlist", extensions: ["m3u8", "m3u"] }],
  });
  if (!path) return;
  try {
    await invoke("playlist_save", { path, tracks: session });
    toast("Playlist guardada");
  } catch (e) {
    toast(`No se pudo guardar: ${e}`);
  }
}

async function openPlaylist() {
  const path = await dialogOpen({
    multiple: false,
    filters: [{ name: "Playlist M3U", extensions: ["m3u", "m3u8"] }],
  });
  if (!path) return;
  try {
    const tracks = await invoke("playlist_load", { path });
    if (!tracks.length) return toast("La playlist no tiene canciones legibles");
    pushTracks(tracks);
    toast(`${tracks.length} canciones cargadas`);
  } catch (e) {
    toast(`No se pudo abrir: ${e}`);
  }
}

$("btn-save-m3u").addEventListener("click", savePlaylist);
$("btn-open-m3u").addEventListener("click", openPlaylist);

// ---------------------------------------------------------------- mezclador
/// Tope magnético: el control se mueve fino (0,05 dB) pero el valor solo
/// puede ser entero o medio, y los enteros «atrapan» un margen más ancho
/// (±0,3 dB) que los medios. Al cruzar un entero el pulgar salta a él: se
/// nota como una traba en cada cifra significativa.
function eqDetent(raw) {
  const n = Math.round(raw);
  return Math.abs(raw - n) < 0.3 ? n : Math.floor(raw) + 0.5;
}
const fmtDb = (v) => `${v > 0 ? "+" : ""}${Number.isInteger(v) ? v : v.toFixed(1)}`;

/// Coloca la cifra de una banda junto al pulgar (sube y baja con él).
function paintBandValue(band) {
  const inp = band.querySelector("input");
  const out = band.querySelector(".band-val");
  if (!inp || !out) return;
  const v = Number(inp.value);
  const frac = (v - Number(inp.min)) / (Number(inp.max) - Number(inp.min));
  band.style.setProperty("--p", frac.toFixed(4));
  // cuánto se aparta del 0 (0…1): la línea pasa de plateada al color de la canción
  band.style.setProperty("--m", Math.min(1, Math.abs(v) / 12).toFixed(3));
  out.textContent = fmtDb(v);
  out.classList.toggle("zero", v === 0);
}
function refreshEqLabels() {
  for (const band of el.eqBands.querySelectorAll(".band")) paintBandValue(band);
}

function buildEqSliders() {
  el.eqBands.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const band = document.createElement("div");
    band.className = "band";
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = "-12";
    inp.max = "12";
    inp.step = "0.05";
    inp.value = "0";
    inp.setAttribute("aria-label", `Banda de ${EQ_FREQS[i]} Hz`);
    const val = document.createElement("span");
    val.className = "band-val zero";
    val.textContent = "0";
    // teclado: medio dB por flecha y 3 dB por RePág/AvPág, sin pasar por el
    // tope magnético (que devolvería cada paso de 0,05 dB al entero)
    inp.addEventListener("keydown", (e) => {
      const steps = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 };
      const d = steps[e.key];
      if (d === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      inp.value = String(Math.max(-12, Math.min(12, (ui.bands[i] || 0) + d)));
      inp.dataset.key = "1";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
    inp.addEventListener("input", () => {
      const before = ui.bands[i];
      const byKey = inp.dataset.key === "1";
      inp.dataset.key = "";
      const v = byKey ? Number(inp.value) : eqDetent(Number(inp.value));
      inp.value = String(v);
      paintBandValue(band);
      if (v === before) return;
      if (Number.isInteger(v)) { val.classList.remove("tick"); void val.offsetWidth; val.classList.add("tick"); }
      ui.bands[i] = v;
      ui.bass = Number(el.bass.value);
      ui.treble = Number(el.treble.value);
      sendEq();
      scheduleSettingsSave();
    });
    const lb = document.createElement("span");
    lb.className = "band-f";
    lb.textContent = EQ_FREQS[i];
    const rail = document.createElement("div");
    rail.className = "band-rail";
    // Perilla «realista» detrás de la línea (solo en el ecualizador grande de
    // Studio, ADR #155): aparece al mover la banda, gira con el valor (subir =
    // sentido del reloj) y acompaña a la bola un poco en vertical.
    const knob = document.createElement("span");
    knob.className = "band-knob";
    knob.setAttribute("aria-hidden", "true");
    const face = document.createElement("i");
    face.className = "knob-face";
    knob.appendChild(face);
    let knobOff = 0;
    const turnOn = () => { clearTimeout(knobOff); rail.classList.add("turning"); };
    const turnOff = (ms) => { clearTimeout(knobOff); knobOff = setTimeout(() => rail.classList.remove("turning"), ms); };
    inp.addEventListener("pointerdown", () => {
      turnOn();
      window.addEventListener("pointerup", () => turnOff(380), { once: true });
    });
    inp.addEventListener("keydown", () => { turnOn(); turnOff(900); });
    rail.append(knob, inp, val);
    band.append(rail, lb);
    el.eqBands.appendChild(band);
  }
}

function currentBands() {
  return Array.from(el.eqBands.querySelectorAll("input")).map((x) => Number(x.value));
}

function sendEq() {
  invoke("set_eq", {
    bands: currentBands(),
    bass: Number(el.bass.value),
    treble: Number(el.treble.value),
  }).catch(() => {});
}

function scheduleSettingsSave() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(persistSettings, 900);
}

// Diagnóstico (2026-11-09): las 10 bandas aparecieron guardadas en +12 dB sin
// que nadie las tocara y no se pudo reproducir. Si el ecualizador cambia de
// golpe en varias bandas a la vez sin un preset ni «Reestablecer» por medio,
// se deja en el log quién lo pidió (pila de llamadas) para encontrar la causa.
let lastSavedBands = null;
let lastSavedTone = null;
let eqBulkOk = false; // preset, «Plano», «Reestablecer»: cambios en bloque legítimos
function auditBands() {
  const now = ui.bands.slice();
  const prev = lastSavedBands;
  lastSavedBands = now;
  if (!prev || eqBulkOk) { eqBulkOk = false; return; }
  const jumped = now.filter((v, i) => Math.abs(v - (prev[i] || 0)) >= 6).length;
  const tone = [ui.bass, ui.treble];
  const prevTone = lastSavedTone || tone;
  lastSavedTone = tone;
  if (Math.abs(tone[0] - prevTone[0]) >= 6 || Math.abs(tone[1] - prevTone[1]) >= 6) {
    invoke("dbg_log", {
      msg: `EQ: graves/agudos ${JSON.stringify(prevTone)} → ${JSON.stringify(tone)} (foco: ${document.activeElement && document.activeElement.id})\n${new Error().stack}`,
      level: "warn",
    }).catch(() => {});
  }
  if (jumped >= 3) {
    invoke("dbg_log", {
      msg: `EQ: ${jumped} bandas cambiaron de golpe ${JSON.stringify(prev)} → ${JSON.stringify(now)}
${new Error().stack}`,
      level: "warn",
    }).catch(() => {});
  }
}

async function persistSettings() {
  auditBands();
  const s = {
    volume: ui.volume,
    balance: ui.balance,
    bands: ui.bands,
    bass: ui.bass,
    treble: ui.treble,
    fade_secs: ui.fade_secs,
    rg_norm: ui.rg_norm,
    rg_album: ui.rg_album,
    param_eq: ui.param_eq,
    exclusive: ui.exclusive,
    dl_parallel: ui.dl_parallel,
    dl_rate_kib: ui.dl_rate_kib,
    enrich_online: ui.enrich_online,
    lastfm_key: ui.lastfm_key,
  };
  try { await invoke("settings_set", { settings: s }); } catch {}
}

function paintMixerFromState() {
  const sliders = el.eqBands.querySelectorAll("input");
  for (let i = 0; i < 10 && i < sliders.length; i++) sliders[i].value = String(ui.bands[i]);
  refreshEqLabels();
  el.bass.value = String(ui.bass);
  el.treble.value = String(ui.treble);
  el.balance.value = String(ui.balance * 100);
  el.fade.value = String(ui.fade_secs);
  el.fadeVal.textContent = `${ui.fade_secs.toFixed(1)} s`;
  el.preset.value = "";
  paintToneValues();
}

el.preset.addEventListener("change", () => {
  const v = el.preset.value;
  if (v === "flat") {
    ui.bands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  } else if (v) {
    ui.bands = PRESETS[v].map((x) => x);
  } else return;
  eqBulkOk = true;
  const sliders = el.eqBands.querySelectorAll("input");
  for (let i = 0; i < 10; i++) sliders[i].value = String(ui.bands[i]);
  refreshEqLabels();
  sendEq();
  scheduleSettingsSave();
});

$("btn-eq-reset").addEventListener("click", () => {
  el.preset.value = "";
  ui.bands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  eqBulkOk = true;
  const sliders = el.eqBands.querySelectorAll("input");
  for (let i = 0; i < 10; i++) sliders[i].value = "0";
  refreshEqLabels();
  sendEq();
  scheduleSettingsSave();
});

el.bass.addEventListener("input", () => { ui.bass = Number(el.bass.value); paintToneValues(); sendEq(); scheduleSettingsSave(); });
el.treble.addEventListener("input", () => { ui.treble = Number(el.treble.value); paintToneValues(); sendEq(); scheduleSettingsSave(); });
el.balance.addEventListener("input", () => paintToneValues());

/// Cifras de la columna «valor» del mezclador (rejilla etiqueta · control · valor).
function paintToneValues() {
  const b = $("mix-bass-val"), tr = $("mix-treble-val"), bl = $("mix-balance-val");
  if (b) b.textContent = `${fmtDb(Number(el.bass.value))} dB`;
  if (tr) tr.textContent = `${fmtDb(Number(el.treble.value))} dB`;
  if (bl) {
    const v = Math.round(Number(el.balance.value));
    bl.textContent = v === 0 ? "C" : v < 0 ? `I ${-v}` : `D ${v}`;
  }
}
el.balance.addEventListener("input", () => {
  ui.balance = Number(el.balance.value) / 100;
  invoke("set_balance", { balance: ui.balance });
  scheduleSettingsSave();
});
el.fade.addEventListener("input", () => {
  ui.fade_secs = Number(el.fade.value);
  el.fadeVal.textContent = `${ui.fade_secs.toFixed(1)} s`;
  invoke("set_fade", { seconds: ui.fade_secs });
  scheduleSettingsSave();
});

// volumen relativo de la pista actual
el.trackGain.addEventListener("input", () => {
  const v = Number(el.trackGain.value);
  el.trackGainVal.textContent = `${v > 0 ? "+" : ""}${v} dB`;
  if (currentPath) {
    gainByPath.set(currentPath, v);
    try { localStorage.setItem("enn.gains", JSON.stringify(Object.fromEntries(gainByPath))); } catch {}
    // + la normalización de la pista: sin ella, tocar este control la quitaba
    const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
    if (playing) invoke("set_current_gain", { gainDb: v + (cur ? rgGainFor(cur) : 0) }).catch(() => {});
  }
});

function syncTrackGainUI() {
  const db = currentPath ? gainByPath.get(currentPath) ?? 0 : 0;
  el.trackGain.value = String(db);
  el.trackGainVal.textContent = `${db > 0 ? "+" : ""}${db} dB`;
  el.trackGain.disabled = !currentPath;
}

// el mezclador está fijo en la columna derecha; el atajo Ctrl+Alt+M (que
// pulsa este botón oculto) ahora solo lo trae a la vista
el.btnMixer.addEventListener("click", () => {
  el.mixer.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

// temporizador de apagado: detiene la reproducción al acabar la cuenta
let sleepTimer = null;
const sleepSel = document.getElementById("mix-sleep");
if (sleepSel) {
  sleepSel.addEventListener("change", () => {
    clearTimeout(sleepTimer);
    const mins = Number(sleepSel.value);
    if (mins > 0) {
      sleepTimer = setTimeout(() => {
        invoke("stop").catch(() => {});
        playing = false;
        updatePlayBtn();
        toast("Temporizador: reproducción detenida");
        sleepSel.value = "0";
      }, mins * 60_000);
      toast(`La música se detendrá en ${mins} min`);
    }
  });
}

function buildParamEq() {
  const host = document.getElementById("eq-param");
  if (!host) return;
  host.innerHTML = "";
  const defaults = [[80, 1], [300, 1], [2500, 1], [9000, 1]];
  ui.param_eq = [0, 1, 2, 3].map((i) => ui.param_eq[i] || [defaults[i][0], defaults[i][1], 0]);
  for (let i = 0; i < 4; i++) {
    const [f, q, g] = ui.param_eq[i];
    const row = document.createElement("div");
    row.className = "pband";
    const fIn = document.createElement("input");
    fIn.type = "number";
    fIn.min = "20";
    fIn.max = "20000";
    fIn.step = "10";
    fIn.value = String(Math.round(f));
    fIn.title = "Frecuencia central (Hz)";
    const qIn = document.createElement("input");
    qIn.type = "range";
    qIn.min = "0.3";
    qIn.max = "10";
    qIn.step = "0.1";
    qIn.value = String(q);
    qIn.title = `Q: ${q}`;
    const gIn = document.createElement("input");
    gIn.type = "range";
    gIn.min = "-12";
    gIn.max = "12";
    gIn.step = "0.05";
    gIn.value = String(g);
    gIn.title = `Ganancia: ${g} dB`;
    const qLbl = document.createElement("span");
    qLbl.className = "pq-val";
    qLbl.textContent = `Q ${Number(q).toFixed(1)}`;
    const gLbl = document.createElement("span");
    gLbl.className = "pg-val";
    gLbl.textContent = `${fmtDb(g)} dB`;
    const send = () => {
      const nf = Math.max(20, Math.min(20000, Number(fIn.value) || f));
      const nq = Number(qIn.value);
      const ng = eqDetent(Number(gIn.value));
      gIn.value = String(ng);
      qIn.title = `Q: ${nq}`;
      qLbl.textContent = `Q ${nq.toFixed(1)}`;
      gLbl.textContent = `${fmtDb(ng)} dB`;
      ui.param_eq[i] = [nf, nq, ng];
      invoke("set_param_band", { index: i, freq: nf, q: nq, gain: ng }).catch(() => {});
      scheduleSettingsSave();
    };
    fIn.addEventListener("change", send);
    qIn.addEventListener("input", send);
    gIn.addEventListener("input", send);
    row.append(fIn, qIn, qLbl, gIn, gLbl);
    host.appendChild(row);
  }
}

// salida exclusiva (bit-perfect): se aplica al instante
const exBox = document.getElementById("mix-exclusive");
if (exBox) {
  exBox.addEventListener("change", async () => {
    ui.exclusive = exBox.checked;
    try {
      await invoke("set_exclusive", { on: ui.exclusive });
      toast(ui.exclusive ? "Salida exclusiva activada" : "Salida exclusiva desactivada");
    } catch (e) {
      toast(`No se pudo cambiar el modo: ${e}`);
      exBox.checked = !ui.exclusive;
      ui.exclusive = !ui.exclusive;
    }
    scheduleSettingsSave();
  });
}

// ---------------------------------------------------------------- ReplayGain
const rgBox = document.getElementById("mix-rg");
const rgStatus = document.getElementById("rg-status");
if (rgBox) {
  rgBox.addEventListener("change", () => {
    ui.rg_norm = rgBox.checked;
    // aplica de inmediato a la pista en curso (y analiza lo que falte)
    applyCurrentGain();
    if (ui.rg_norm) {
      autoRgScan();
      ensureLoudness(curIdx >= 0 ? session[curIdx] : null);
    }
    scheduleSettingsSave();
  });
}
const rgAlbumBox = document.getElementById("mix-rg-album");
if (rgAlbumBox) {
  rgAlbumBox.addEventListener("change", () => {
    ui.rg_album = rgAlbumBox.checked;
    applyCurrentGain();
    scheduleSettingsSave();
  });
}
const rgBtn = document.getElementById("btn-rg-scan");
let rgManual = false; // el análisis lo pidió el botón (entonces sí se avisa al acabar)
let rgAgain = false; // llegaron canciones nuevas mientras se analizaba
async function startRgScan(manual) {
  try {
    const pending = await invoke("rg_scan_start");
    if (pending === 0) {
      if (manual && rgStatus) rgStatus.textContent = "Toda la biblioteca ya está analizada.";
      return;
    }
    rgManual = rgManual || manual;
    if (rgBtn) rgBtn.disabled = true;
    if (rgStatus) rgStatus.textContent = `Analizando… 0 / ${pending}`;
  } catch (e) {
    // ya hay uno en marcha: se repite al terminar para cubrir lo nuevo
    rgAgain = true;
    if (manual && rgStatus) rgStatus.textContent = String(e);
  }
}
/// Normalización automática (petición del propietario, 2026-11-12): al abrir
/// la app y tras cada descarga se analiza en segundo plano lo que falte.
function autoRgScan() {
  if (ui.rg_norm) startRgScan(false);
}
if (rgBtn) rgBtn.addEventListener("click", () => startRgScan(true));
try {
  window.__TAURI__.event.listen("enn://rg", (e) => {
    const { done, total, finished, path, lufs } = e.payload || {};
    if (rgStatus) rgStatus.textContent = finished ? "Análisis completo." : `Analizando… ${done} / ${total}`;
    if (path && typeof lufs === "number") noteLoudness(path, lufs);
    if (finished) {
      if (rgBtn) rgBtn.disabled = false;
      if (rgManual) toast("Análisis de volumen completado");
      rgManual = false;
      if (rgAgain) { rgAgain = false; autoRgScan(); }
    }
  });
} catch {}

/// Guarda la sonoridad recién medida en la biblioteca y en la cola; si es la
/// pista que suena, su volumen se ajusta ya (el motor lo desliza, sin saltos).
function noteLoudness(path, lufs) {
  const lib = library.find((x) => x.path === path);
  if (lib) lib.rg = lufs;
  for (const s of session) if (s.path === path) s.rg = lufs;
  const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  if (cur && cur.path === path) applyCurrentGain();
}

/// Reenvía al motor la ganancia de la pista en curso y mueve la barra.
function applyCurrentGain() {
  const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  if (cur && (playing || engineState === "paused")) {
    const manual = gainByPath.get(cur.path) ?? 0;
    invoke("set_current_gain", { gainDb: manual + rgGainFor(cur) }).catch(() => {});
  }
  followTrackVolume();
}

/// La que suena (o la siguiente) aún sin analizar: se mide ya, sin esperar a
/// que el análisis de toda la biblioteca llegue a ella. Una a una.
const loudnessWait = new Set();
async function ensureLoudness(track) {
  if (!ui.rg_norm) return;
  const todo = [track, session[curIdx + 1]].filter((t) => t && t.path && rgOf(t) === null && !loudnessWait.has(t.path));
  for (const t of todo) {
    loudnessWait.add(t.path);
    try {
      const lufs = await invoke("rg_analyze", { path: t.path });
      if (typeof lufs === "number") noteLoudness(t.path, lufs);
    } catch {}
    loudnessWait.delete(t.path);
  }
}

// ---------------------------------------------------------------- reestablecer el mezclador (Studio)
// Devuelve TODO el mezclador y el ecualizador a neutro, de golpe y sin
// confirmación. No escribe el estado del motor a mano: mueve cada control y
// dispara su evento real, de modo que pasan por los mismos manejadores que ya
// aplican cada ajuste al motor (set_eq, set_balance, set_fade, set_param_band,
// set_exclusive…) y la interfaz queda coherente.
function resetMixer() {
  eqBulkOk = true;
  // 1) las 10 bandas del ecualizador, planas (mismo camino que el preset «Plano»)
  el.eqBands.querySelectorAll("input").forEach((s) => {
    s.value = "0";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // 2) el ecualizador paramétrico a 0 dB (cada fila es [frecuencia, Q, ganancia])
  document.querySelectorAll("#eq-param .pband").forEach((row) => {
    const gain = row.querySelectorAll("input")[2];
    if (gain) {
      gain.value = "0";
      gain.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  // 3) preset en «Personalizado»
  el.preset.value = "";
  // 4) Graves, Agudos, Balance y Pista, a 0
  el.bass.value = "0"; el.bass.dispatchEvent(new Event("input", { bubbles: true }));
  el.treble.value = "0"; el.treble.dispatchEvent(new Event("input", { bubbles: true }));
  el.balance.value = "0"; el.balance.dispatchEvent(new Event("input", { bubbles: true }));
  el.trackGain.value = "0"; el.trackGain.dispatchEvent(new Event("input", { bubbles: true }));
  // 5) Fade a 0 s
  el.fade.value = "0"; el.fade.dispatchEvent(new Event("input", { bubbles: true }));
  // 6) Normalizar volumen (ReplayGain) ACTIVADO · Por álbum desactivado
  rgBox.checked = true; rgBox.dispatchEvent(new Event("change", { bubbles: true }));
  rgAlbumBox.checked = false; rgAlbumBox.dispatchEvent(new Event("change", { bubbles: true }));
  // 7) Temporizador apagado (el propio manejador cancela la cuenta)
  sleepSel.value = "0"; sleepSel.dispatchEvent(new Event("change", { bubbles: true }));
  // 8) Salida exclusiva (bit-perfect) desactivada
  exBox.checked = false; exBox.dispatchEvent(new Event("change", { bubbles: true }));
  // el valor en dB de «Pista» se refresca desde su estado real
  syncTrackGainUI();
  toast("Mezclador y ecualizador reestablecidos");
}
$("btn-mix-reset").addEventListener("click", resetMixer);

// ---------------------------------------------------------------- espectro (A5)
// ---------------------------------------------------------------- espectro compartido
// Un único sondeo de get_spectrum alimenta las barras del mezclador (el fondo
// y «Reproduciendo» los pinta ahora el visualizador de ui/viz/, con su propio
// análisis en Rust: get_viz_frame). Antes cada uno pedía lo mismo a Rust por su
// lado — hasta ~43 llamadas por segundo — y el fondo repintaba la ventana
// entera a 60 fps aunque la música estuviera en pausa. Ahora:
//   · solo se sondea mientras suena algo y la ventana es visible;
//   · el bucle de dibujo se apaga en cuanto las barras dejan de moverse, así
//     que en reposo no queda ni un requestAnimationFrame armado;
//   · en reposo no se pinta nada (antes quedaba una fila de barras de 2 px
//     cruzando la ventana).
const SPEC_N = 48;
const SPEC_POLL_MS = 60;
const specTarget = new Float32Array(SPEC_N);
const specVisuals = []; // { step(target) -> ¿sigue moviéndose?, rebuild() }
let specTimer = 0;
let specInflight = false;
let specRaf = 0;

// Las *-rgb no están registradas con @property: no transicionan, así que dan
// el color de la canción nueva al instante. Las registradas (--accent)
// devolverían el valor a mitad del fundido de 700 ms.
function specColors() {
  const cs = getComputedStyle(document.documentElement);
  const a = cs.getPropertyValue("--accent-rgb").trim() || "188, 198, 212";
  const b = cs.getPropertyValue("--accent2-rgb").trim() || "138, 150, 168";
  return { a: `rgb(${a})`, b: `rgb(${b})` };
}

async function specPoll() {
  if (specInflight) return; // si Rust tarda, no apilar peticiones
  specInflight = true;
  try {
    const bands = await invoke("get_spectrum");
    for (let i = 0; i < SPEC_N; i++) specTarget[i] = bands[i] || 0;
    specKick();
  } catch {}
  specInflight = false;
}

// Se llama en cada applyStatus (250 ms): solo actúa cuando algo cambia.
function specSync() {
  const want = playing && !document.hidden;
  if (want && !specTimer) {
    specTimer = setInterval(specPoll, SPEC_POLL_MS);
    specPoll();
  } else if (!want && specTimer) {
    clearInterval(specTimer);
    specTimer = 0;
    specTarget.fill(0); // las barras caen a cero y el bucle se apaga solo
    specKick();
  }
}

function specKick() {
  if (!specRaf && !document.hidden) specRaf = requestAnimationFrame(specLoop);
}

function specLoop() {
  specRaf = 0;
  let moving = false;
  for (const v of specVisuals) if (v.step(specTarget)) moving = true;
  // cada sondeo vuelve a encender el bucle: si todo está quieto, se apaga
  if (moving) specRaf = requestAnimationFrame(specLoop);
}

// Ajusta un canvas a su caja CSS con la densidad de píxeles real. Devuelve el
// tamaño en px CSS; el contexto queda escalado para dibujar en esas unidades.
function specFit(canvas, ctx, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const SPEC_STILL = 0.002; // por debajo de esto nadie nota el movimiento
const SPEC_MIN_PX = 0.75; // una barra más baja que esto no se pinta

document.addEventListener("visibilitychange", () => {
  specSync();
  specKick();
});
document.addEventListener("enn:palette", () => {
  for (const v of specVisuals) v.rebuild();
  specKick();
});

// Sensibilidad de las barras (petición del propietario, 2026-11-13; ADR #158):
// barra horizontal mínima abajo a la derecha del ecualizador grande. ×0,5 a
// ×2, recordada en `enn.specSens`.
let specSens = 1;
try {
  const s = Number(localStorage.getItem("enn.specSens"));
  if (s >= 0.5 && s <= 2) specSens = s;
} catch {}
(function sensBar() {
  const host = $("stage-eq");
  if (!host) return;
  const wrap = document.createElement("label");
  wrap.className = "spec-sens";
  wrap.title = "Sensibilidad de las barras";
  const ic = document.createElement("span");
  ic.className = "spec-sens-ic";
  ic.setAttribute("aria-hidden", "true");
  ic.innerHTML = '<svg class="ic" viewBox="0 0 24 24"><path d="M4 20v-4"/><path d="M9 20v-8"/><path d="M14 20V8"/><path d="M19 20V4"/></svg>';
  const r = document.createElement("input");
  r.type = "range";
  r.min = "0.5";
  r.max = "2";
  r.step = "0.05";
  r.value = String(specSens);
  r.setAttribute("aria-label", "Sensibilidad de las barras del ecualizador");
  const out = document.createElement("output");
  const paint = () => {
    out.textContent = `×${specSens.toFixed(1)}`;
    r.style.setProperty("--vp", `${((specSens - 0.5) / 1.5) * 100}%`);
  };
  r.addEventListener("input", () => {
    let v = Number(r.value);
    if (Math.abs(v - 1) < 0.06) v = 1; // tope suave en ×1
    r.value = String(v);
    specSens = v;
    paint();
    try { localStorage.setItem("enn.specSens", String(v)); } catch {}
    specKick();
  });
  // doble clic: vuelve a ×1
  r.addEventListener("dblclick", () => { r.value = "1"; r.dispatchEvent(new Event("input")); });
  paint();
  wrap.append(ic, r, out);
  host.appendChild(wrap);
})();

// ---- mezclador: barras desde abajo, siempre visible en la columna derecha
(function specMixer() {
  const canvas = document.getElementById("spectrum");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const cur = new Float32Array(SPEC_N);
  const want = new Float32Array(SPEC_N);
  let W = 0, H = 0, grad = null, tipCol = "#fff", dim = "rgba(255,255,255,0.6)";
  // línea de pico (ADR #156): el punto más alto de todas las barras; se queda
  // ~2 s y luego baja despacio hasta que otro pico la empuja
  let peak = 0, peakRaw = 0, peakAt = 0, lastT = 0;
  const PEAK_HOLD = 2000, PEAK_FALL = 0.28; // por segundo

  // más sensible (petición del propietario, 2026-11-13): curva que levanta
  // los niveles bajos y medios para que el movimiento se note
  // × la sensibilidad que elige el usuario con la barra del ecualizador
  const sens = (v) => Math.min(1, Math.pow(v, 0.72) * 1.12 * specSens);
  // valor 0…1 del motor → dBFS aproximados (get_spectrum: v = 1 − e^(−6m),
  // y un seno a fondo de escala da m ≈ 0,5 con ventana de Hann)
  const toDb = (v) => {
    const m = -Math.log(Math.max(1e-6, 1 - Math.min(v, 0.999999))) / 6;
    return Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(1e-6, 2 * m))));
  };

  function rebuild() {
    const { a, b } = specColors();
    grad = ctx.createLinearGradient(0, 0, 0, H || 1);
    grad.addColorStop(0, a);
    grad.addColorStop(1, b);
    tipCol = a;
    const cs = getComputedStyle(document.documentElement);
    dim = cs.getPropertyValue("--text-dim").trim() || dim;
  }
  /// Barra con forma de lápiz: cuerpo recto y punta afilada arriba (la mina,
  /// un poco más clara).
  function pencil(x, w, top) {
    const tip = Math.min(w * 1.15, (H - top) * 0.45);
    const cx = x + w / 2;
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(x, top + tip);
    ctx.lineTo(cx, top);
    ctx.lineTo(x + w, top + tip);
    ctx.lineTo(x + w, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    if (tip > 3) {
      // la mina: el tercio superior de la punta
      const k = 0.38;
      ctx.beginPath();
      ctx.moveTo(cx - (w / 2) * k, top + tip * k);
      ctx.lineTo(cx, top);
      ctx.lineTo(cx + (w / 2) * k, top + tip * k);
      ctx.closePath();
      ctx.fillStyle = tipCol;
      ctx.globalAlpha = 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    const bw = W / SPEC_N;
    const top0 = 14; // sitio para la cifra del pico
    const span = H - top0 - 1;
    for (let i = 0; i < SPEC_N; i++) {
      const h = cur[i] * span;
      if (h < SPEC_MIN_PX) continue;
      pencil(i * bw + 1, Math.max(1, bw - 2), H - h);
    }
    if (peak > 0.01) {
      const y = Math.round(H - peak * span) + 0.5;
      ctx.save();
      ctx.strokeStyle = dim;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      ctx.setLineDash([]);
      // la medida, al final (sobre la última barra)
      ctx.font = "600 10px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = dim;
      const db = toDb(peakRaw);
      ctx.fillText(`${db <= -59.5 ? "−∞" : "−" + Math.abs(db).toFixed(1)} dB`, W - 2, Math.max(11, y - 2));
      ctx.restore();
    }
  }
  new ResizeObserver(([e]) => {
    W = e.contentRect.width;
    H = e.contentRect.height;
    if (!W || !H) return;
    specFit(canvas, ctx, W, H);
    rebuild();
    draw();
  }).observe(canvas);

  specVisuals.push({
    rebuild,
    step(t) {
      // subida rápida y caída más lenta: los golpes se ven, no parpadean
      let d = 0, top = 0, topRaw = 0;
      for (let i = 0; i < SPEC_N; i++) {
        want[i] = sens(t[i]);
        const x = want[i] - cur[i];
        cur[i] += x * (x > 0 ? 0.5 : 0.2);
        const ax = x < 0 ? -x : x;
        if (ax > d) d = ax;
        if (cur[i] > top) top = cur[i];
        if (t[i] > topRaw) topRaw = t[i];
      }
      const now = performance.now();
      const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0;
      lastT = now;
      if (top >= peak) {
        peak = top;
        peakRaw = Math.max(peakRaw * 0.9, topRaw);
        peakAt = now;
      } else if (now - peakAt > PEAK_HOLD) {
        peak = Math.max(top, peak - PEAK_FALL * dt);
        if (peak <= top + 0.001) peakRaw = topRaw;
      }
      if (!W || document.body.classList.contains("mini")) return false;
      draw();
      return d > SPEC_STILL || peak > top + 0.002;
    },
  });
})();

// ---------------------------------------------------------------- Ahora suena (E5)
// Vista a pantalla completa: carátula grande + título/artista. Detrás va el
// visualizador (ui/viz/), que en Simple se ve difuminado.
let npOpen = false;
function setNowPlayingArt(uri) {
  const img = document.getElementById("np-art");
  const ph = document.getElementById("np-placeholder");
  if (!img || !ph) return;
  if (uri) {
    img.src = uri;
    img.classList.remove("hidden");
    ph.classList.add("hidden");
  } else {
    img.classList.add("hidden");
    ph.classList.remove("hidden");
  }
}
function setNowPlayingText(title, artist) {
  const t = document.getElementById("np-title");
  const a = document.getElementById("np-artist");
  if (t) t.textContent = title || "—";
  if (a) a.textContent = artist || "";
  paintKicker();
}

/// El rótulo de la tarjeta no puede decir «Reproduciendo ahora» en reposo.
/// Revisión 2026-11-12: solo se repintaba al cambiar el título, así que al
/// abrir la app con una canción ya sonando se quedaba en «En reposo».
function paintKicker() {
  const k = document.querySelector("#now-playing .np-kicker span");
  if (!k) return;
  const on = engineState === "playing" || engineState === "paused";
  const t = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  // con la radio, el motivo de la elección («Sigue el hilo: Rock → Indie»)
  const txt = !on ? "En reposo" : t && t.radio && t.why ? `Radio · ${t.why}` : "Reproduciendo ahora";
  if (k.textContent !== txt) k.textContent = txt;
}

(function initNowPlaying() {
  const panel = document.getElementById("now-playing");
  const metaBtn = document.getElementById("ctl-meta");
  if (!panel || !metaBtn) return;

  // Ya no es un overlay a pantalla completa: es la vista "Reproduciendo"
  // del escenario, y npOpen lo gobierna syncShell(). La mini portada del
  // pie lleva a ella. Escape vuelve a la biblioteca solo en Studio: en
  // Simple esta vista es el inicio y no hay "atrás".
  metaBtn.addEventListener("click", () => goView("nowplaying"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && npOpen && shell.mode === "studio") goView("library", shell.libTab);
  });
})();

// ---------------------------------------------------------------- waveform (B7)
const waveCanvas = document.getElementById("seek-wave");
let wavePath = null;
let waveData = null;

/// La onda ocupaba toda la fila (incluidos los textos de tiempo) y la bola solo
/// el centro: el azul no coincidía con la bola. Ahora el lienzo cubre justo el
/// recorrido del centro de la bola (el ancho del deslizador menos la bola).
const SEEK_THUMB = 13;
function fitWave() {
  if (!waveCanvas || !el.seek) return;
  const left = el.seek.offsetLeft + SEEK_THUMB / 2;
  const width = Math.max(0, el.seek.offsetWidth - SEEK_THUMB);
  waveCanvas.style.left = `${left}px`;
  waveCanvas.style.width = `${width}px`;
  waveCanvas.style.right = "auto";
  const px = Math.max(1, Math.round(width));
  if (waveCanvas.width !== px) {
    waveCanvas.width = px;
    drawWave();
  }
}
if (waveCanvas && "ResizeObserver" in window) {
  new ResizeObserver(fitWave).observe(el.seek);
  new ResizeObserver(fitWave).observe(waveCanvas.parentElement);
}

async function refreshWave(path) {
  wavePath = path;
  waveData = null;
  fitWave();
  if (!path) return;
  try {
    const peaks = await invoke("waveform", { path });
    if (peaks && wavePath === path) {
      waveData = peaks;
      drawWave();
    } else if (!peaks) {
      // se está calculando: reintenta en unos segundos
      setTimeout(() => { if (wavePath === path) refreshWave(path); }, 4000);
    }
  } catch {}
}

function drawWave() {
  if (!waveCanvas) return;
  const ctx = waveCanvas.getContext("2d");
  const W = waveCanvas.width, H = waveCanvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!waveData || !duration) return;
  const n = waveData.length;
  const playedX = (pos / duration) * W;
  for (let i = 0; i < n; i++) {
    const x = (i / n) * W;
    const h = Math.max(1, (waveData[i] / 255) * H);
    ctx.fillStyle = x <= playedX ? "#4a9eff" : "rgba(128,128,128,0.6)";
    ctx.fillRect(x, (H - h) / 2, Math.max(1, W / n - 1), h);
  }
}

// ---------------------------------------------------------------- volumen / seek
// Volumen 0–150 %: el 100 % es un tope suave (se engancha al pasar por él,
// ±4) y por encima la pista se marca como zona de amplificación. Ancho fijo:
// ya no se alarga al pasar el ratón (2026-11-12, al propietario le molestaba).
(function volumeControl() {
  const v = el.volume;
  const box = v.closest(".vol");
  if (!box) return;
  const track = document.createElement("span");
  track.className = "vol-track";
  v.before(track);
  track.appendChild(v);
  const mark = document.createElement("i");
  mark.className = "vol-mark";
  mark.setAttribute("aria-hidden", "true");
  track.appendChild(mark);
  v.step = "1";
  const paint = () => {
    const n = Number(v.value);
    box.classList.toggle("boost", n > 100);
    v.style.setProperty("--vp", `${(n / 150) * 100}%`);
  };
  v.addEventListener("input", () => {
    const n = Number(v.value);
    if (n !== 100 && Math.abs(n - 100) <= 4) v.value = "100";
    paint();
  }, true); // antes que el manejador que lo manda al motor
  v.addEventListener("pointerdown", () => box.classList.add("active"));
  window.addEventListener("pointerup", () => box.classList.remove("active"));
  new MutationObserver(paint).observe(v, { attributes: true, attributeFilter: ["value"] });
  paint();
  const obs = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(v, "value", { configurable: true, get() { return obs.get.call(this); }, set(x) { obs.set.call(this, x); paint(); } });
})();

// La barra enseña el volumen que de verdad se oye: el tuyo × la normalización
// de la canción. Al cambiar de canción se desliza sola hasta su nivel
// (petición del propietario, 2026-11-12); al moverla tú, se guarda tu volumen
// «de base» (lo que pones dividido entre la normalización de esa canción).
let volFactor = 1; // factor lineal de normalización de la pista que suena
let volAnim = 0;
function shownVolume() {
  return Math.max(0, Math.min(150, Math.round(ui.volume * volFactor * 100)));
}
function paintVolume(n) {
  el.volume.value = String(n);
  el.volNum.textContent = String(n);
}
function followTrackVolume() {
  const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  const f = cur ? Math.pow(10, rgGainFor(cur) / 20) : 1;
  volFactor = f;
  const to = shownVolume();
  const from = Number(el.volume.value);
  cancelAnimationFrame(volAnim);
  volAnim = 0;
  // si la estás moviendo tú, no se la quita de la mano
  const box = el.volume.closest(".vol");
  if (from === to || REDUCE_MOTION || (box && box.classList.contains("active"))) return paintVolume(to);
  const t0 = performance.now(), T = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / T);
    const e = 0.5 - 0.5 * Math.cos(Math.PI * k); // entrada y salida suaves
    paintVolume(Math.round(from + (to - from) * e));
    volAnim = k < 1 ? requestAnimationFrame(step) : 0;
  };
  volAnim = requestAnimationFrame(step);
}

el.volume.addEventListener("input", () => {
  cancelAnimationFrame(volAnim);
  volAnim = 0;
  const shown = Number(el.volume.value);
  const v = Math.max(0, Math.min(1.5, shown / 100 / (volFactor || 1)));
  ui.volume = v;
  el.volNum.textContent = String(shown);
  invoke("set_volume", { volume: v });
  scheduleSettingsSave();
});

el.seek.addEventListener("input", () => {
  seeking = true;
  if (duration) el.tCur.textContent = fmtTime((Number(el.seek.value) / 1000) * duration);
});
// Clic en un punto de la barra (no arrastre): la bola y el progreso viajan
// hasta allí con un rebote corto. El salto real del motor es inmediato.
let seekAnim = 0;
(function seekBounce() {
  let from = null, x0 = 0;
  el.seek.addEventListener("pointerdown", (e) => { from = Number(el.seek.value); x0 = e.clientX; });
  el.seek.addEventListener("pointerup", (e) => {
    const start = from;
    from = null;
    if (start === null || Math.abs(e.clientX - x0) > 4 || REDUCE_MOTION || !duration) return;
    const to = Number(el.seek.value);
    if (Math.abs(to - start) < 8) return;
    const t0 = performance.now(), T = 460;
    cancelAnimationFrame(seekAnim);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / T);
      // muelle amortiguado: pasa un poco del destino y vuelve
      const s = 1 - Math.exp(-6.5 * k) * Math.cos(9.5 * k);
      const v = k >= 1 ? to : start + (to - start) * s;
      el.seek.value = String(Math.round(v));
      pos = (v / 1000) * duration;
      drawWave();
      seekAnim = k < 1 ? requestAnimationFrame(step) : 0;
    };
    seekAnim = requestAnimationFrame(step);
  });
})();

el.seek.addEventListener("change", () => {
  if (!duration) { seeking = false; return; }
  const to = (Number(el.seek.value) / 1000) * duration;
  // el almacén cuenta lo escuchado de verdad, no la posición
  if (started && !started.ended) insightsEvent("seek", started.path, { pos, to });
  invoke("seek_to", { seconds: to });
  seeking = false;
  primedFor = null; // el motor suelta la pista cebada al buscar
});

// ---------------------------------------------------------------- estado del motor
function updatePlayBtn() {
  el.play.innerHTML = playing ? SVG.pause : SVG.play;
  el.play.setAttribute("aria-label", playing ? "Pausar" : "Reproducir");
  document.body.classList.toggle("is-playing", playing);
  // sin pista cargada no hay nada que reproducir: el botón se apaga y lo explica
  // (en reposo, `paintRest` deja `currentPath` y `duration` a cero)
  // con la radio puesta o algo en «Siguientes», ▶ también tiene qué poner
  // (antes se apagaba y la radio no se podía arrancar con ▶, visto en la app
  // real el 2026-11-17)
  const queued = session.length > curIdx + 1 || (radioOn && library.length > 0);
  const ready = playing || !!currentPath || duration > 0 || queued;
  el.play.disabled = !ready;
  el.play.title = ready ? "Reproducir/Pausar (espacio)" : "Añade música para empezar";
}

let lastTitle = "";
let lastArtPath = null;

async function setMiniArt(path) {
  let uri = artCache.get(path);
  if (uri === undefined) {
    try {
      uri = await invoke("album_art", { path });
    } catch {
      uri = null;
    }
    artCache.set(path, uri);
  }
  if (uri) {
    el.miniArt.src = uri;
    el.miniArt.classList.remove("hidden");
  } else {
    el.miniArt.classList.add("hidden");
  }
  setNowPlayingArt(uri);
  // la carátula de la pista que suena tiñe toda la interfaz (paleta reactiva).
  // No se espera: el color entra cuando esté listo y la transición CSS lo
  // funde, así que nunca bloquea el cambio de pista. En pausa o parada la app
  // se queda en su plateado (syncPalette).
  lastArtUri = uri || null;
  paletteSilver = !(uri && playing);
  if (uri && playing) applyFromArt(uri);
  else resetPalette();
}

/// Color de la canción solo mientras suena; en pausa o parada, plateado.
let lastArtUri = null;
let paletteSilver = true;
function syncPalette() {
  if (!playing && !paletteSilver) {
    paletteSilver = true;
    resetPalette();
  } else if (playing && paletteSilver && lastArtUri) {
    paletteSilver = false;
    applyFromArt(lastArtUri);
  }
}

function hideMiniArt() {
  lastArtPath = null;
  lastArtUri = null;
  paletteSilver = true;
  el.miniArt.classList.add("hidden");
  setNowPlayingArt(null);
  resetPalette();
}

// muestra formato/tasa de muestreo/profundidad (o tasa de bits aproximada si
// el archivo no declara bits fijos, p. ej. MP3) de la pista en curso, tal
// como la reporta get_state — calidad de la FUENTE, no del dispositivo
function updateQualityBadge(s) {
  if (!s.path || !s.sample_rate) {
    el.qualityBadge.classList.add("hidden");
    return;
  }
  const ext = (s.path.split(/[\\/]/).pop().split(".").pop() || "").toUpperCase();
  const khz = (s.sample_rate / 1000).toFixed(1).replace(/\.0$/, "");
  let detail = `${khz}kHz`;
  if (s.bits_per_sample) detail += `/${s.bits_per_sample}bit`;
  else if (s.bitrate_kbps) detail += ` · ${s.bitrate_kbps}kbps`;
  el.qualityBadge.textContent = `${ext} · ${detail}`;
  el.qualityBadge.classList.remove("hidden");
}

function applyStatus(s) {
  if (s.state) engineState = s.state;
  playing = s.state === "playing";
  pos = s.pos || 0;
  updatePlayBtn();
  updateQualityBadge(s);
  // se escribe solo al cambiar: tocar el atributo cada 250 ms invalidaría
  // el estilo de todo el documento aunque el valor fuese el mismo
  const pv = playing ? "1" : "0";
  if (document.body.dataset.playing !== pv) document.body.dataset.playing = pv;
  specSync();
  viz.setPlaying(playing);
  syncPalette();
  updateTelemetry(s);
  paintKicker();
  const effDur = s.dur
    ?? (curIdx >= 0 && curIdx < session.length && session[curIdx] ? session[curIdx].dur : 0)
    ?? 0;
  // título + artista: con solo el título, dos canciones que se llaman igual
  // (p. ej. «Caro» de dos artistas) dejaban puesto el artista de la anterior
  const titleKey = s.title ? `${s.title}\u0001${s.artist || ""}` : "";
  if (s.title && titleKey !== lastTitle) {
    lastTitle = titleKey;
    el.miniTitle.textContent = s.title;
    setNowPlayingText(s.title, s.artist);
  }
  if (s.path && s.path !== lastArtPath) {
    lastArtPath = s.path;
    restPainted = false;
    setMiniArt(s.path);
    refreshWave(s.path);
  } else if (!s.path && lastArtPath) {
    hideMiniArt();
    refreshWave(null);
  }
  duration = effDur;
  if (duration) {
    if (!seeking && !seekAnim) {
      const ratio = duration > 0 ? (s.pos || 0) / duration : 0;
      el.seek.value = String(Math.round(ratio * 1000));
    }
    el.tCur.textContent = fmtTime(s.pos || 0);
    el.tDur.textContent = fmtTime(duration);
    drawWave();
  }
  markPlayingRow();
}

// ---------------------------------------------------------------- dispositivos
async function refreshDevices(selectValue = "") {
  try {
    deviceList = await invoke("list_devices");
  } catch {
    deviceList = [];
  }
  const keep = selectValue || el.device.value;
  el.device.innerHTML = '<option value="">Predeterminado</option>';
  deviceList.forEach((n) => {
    const opt = document.createElement("option");
    opt.value = n;
    opt.textContent = n;
    el.device.appendChild(opt);
  });
  el.device.disabled = deviceList.length === 0;
  if (keep && deviceList.includes(keep)) el.device.value = keep;
}

el.device.addEventListener("change", async () => {
  if (deviceSwitching) return;
  deviceSwitching = true;
  el.device.disabled = true;
  const name = el.device.value === "" ? null : el.device.value;
  try {
    await invoke("select_device", { name });
    toast(name ? `Audio → ${name}` : "Audio → predeterminado");
  } catch (e) {
    toast(`No se pudo usar ese dispositivo: ${e}`);
    await refreshDevices();
  } finally {
    deviceSwitching = false;
    el.device.disabled = deviceList.length === 0;
  }
});

// ---------------------------------------------------------------- arrastrar y soltar archivos
function setupDragDrop() {
  try {
    const tauri = window.__TAURI__ || {};
    const w = tauri.window
      ? (typeof tauri.window.getCurrentWindow === "function" ? tauri.window.getCurrentWindow() : typeof tauri.window.getCurrent === "function" ? tauri.window.getCurrent() : null)
      : null;
    if (!w || typeof w.onDragDropEvent !== "function") return;
    w.onDragDropEvent(async (event) => {
      const t = event && event.payload ? event.payload.type : "";
      if (t === "enter" || t === "over") {
        document.body.classList.add("drop-zone");
      } else if (t === "leave") {
        document.body.classList.remove("drop-zone");
      } else if (t === "drop") {
        document.body.classList.remove("drop-zone");
        const paths = (event.payload.paths || []).filter((p) => {
          const ext = (p.split(".").pop() || "").toLowerCase();
          return AUDIO_EXTS.includes(ext);
        });
        if (!paths.length) return;
        try {
          const r = await invoke("probe_paths", { paths });
          const n = pushTracks(r.tracks || []);
          if (!n && r.failed) toast(`Archivos no legibles: ${r.first_error || "?"}`);
          else if (n) toast(`${n} canción(es) agregada(s)`);
        } catch (e) {
          toast(`Error: ${e}`);
        }
      }
    });
  } catch (e) {
    // sin arrastrar y soltar nunca debe romper la app
  }
}

// ---------------------------------------------------------------- divisor arrastrable
// Ancho mínimo que se le respeta siempre a la biblioteca: sin esto, una
// cola arrastrada a su máximo (700px) en una ventana grande se quedaba así
// guardada en localStorage, y al abrir Enn en una ventana más angosta (o
// encogerla luego) la biblioteca podía quedar con apenas ~150px de ancho.
const MIN_LIBRARY_W = 480;

// La columna derecha lleva el mezclador. En Simple basta un mínimo pequeño,
// pero en Studio el ecualizador de 10 bandas + el paramétrico son inutilizables
// por debajo de ~420 px (medido el 2026-10-03 a 1120x680: con 229 px no se
// podían ni leer las etiquetas), así que en Studio se ensancha sola.
const QW_MIN_SIMPLE = 220;
// El ecualizador se mudó al escenario (ver `placeEq`), así que la columna de
// Studio ya no necesita 420 px: con ese mínimo le robaba el ancho justo al
// ecualizador y las bandas quedaban cortadas. Solo necesita sitio para sus
// filas propias (ReplayGain, Por álbum, Temporizador, Salida exclusiva).
const QW_MIN_STUDIO = 330;
const QW_MAX = 700;

/// Topes de la columna derecha para el modo actual (decisión de Jev
/// `limitar_en_studio`, 0,67). En Studio la columna queda **limitada a su
/// mínimo utilizable** porque su ancho lo paga el escenario —el ecualizador
/// ocupa ahí toda una fila—; en Simple se respeta el ancho que el propietario
/// eligiera. Antes, un ancho guardado de 402 px estrangulaba el escenario en
/// Studio y dejaba fuera media docena de bandas.
function railLimits(appWidth) {
  const min = shell.mode === "studio" ? QW_MIN_STUDIO : QW_MIN_SIMPLE;
  const hardMax = shell.mode === "studio" ? QW_MIN_STUDIO : QW_MAX;
  return { min, max: Math.max(min, Math.min(hardMax, appWidth - MIN_LIBRARY_W - 6)) };
}

function clampQw(w, appWidth) {
  const { min, max } = railLimits(appWidth);
  return Math.max(min, Math.min(max, w));
}

/// Deja la columna derecha con el ancho que el propietario haya arrastrado en
/// Simple o, como mínimo, con el que su contenido necesita en el modo actual.
function applyRailWidth() {
  const app = $("app");
  // Simple ya no tiene columna derecha (ADR #106): su ancho es cero
  if (shell.mode !== "studio") {
    app.style.setProperty("--qw", "0px");
    return;
  }
  app.style.setProperty("--qw", clampQw(QW_MIN_STUDIO, window.innerWidth) + "px");
}

function setupDivider() {
  const split = $("split");
  const app = $("app");
  applyRailWidth();
  // si la ventana se encoge después (o empieza más angosta que la cola
  // guardada), reclampa en vez de dejar a la biblioteca sin espacio
  window.addEventListener("resize", () => {
    const cur = parseFloat(getComputedStyle(app).getPropertyValue("--qw")) || QW_MIN_STUDIO;
    const clamped = clampQw(cur, window.innerWidth);
    if (clamped !== cur) app.style.setProperty("--qw", clamped + "px");
  });
  split.addEventListener("pointerdown", (e) => {
    // En Studio la columna está limitada a su mínimo: no se arrastra. Así el
    // ancho que el propietario eligió para Simple nunca se pisa desde Studio.
    if (shell.mode === "studio") return;
    split.classList.add("dragging");
    split.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const rect = app.getBoundingClientRect();
      const w = clampQw(rect.right - ev.clientX, rect.width);
      app.style.setProperty("--qw", w + "px");
      try { localStorage.setItem("enn.qw", String(Math.round(w))); } catch {}
    };
    const up = (ev) => {
      split.classList.remove("dragging");
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", up);
      if (split.hasPointerCapture && ev) split.releasePointerCapture(ev.pointerId);
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", up);
  });
}

// ---------------------------------------------------------------- panel de pistas (fase 4)
// El panel de pistas hace dos cosas nuevas, decididas por Jev (`ambas_cosas`,
// 0,57): se pliega con un control de su cabecera (#btn-lib-collapse) y se
// redimensiona arrastrando su borde izquierdo (#lib-resize, el mismo lenguaje
// que #split). Los dos estados se recuerdan entre sesiones: `enn.libCollapsed`
// y `enn.libW`.
const MIN_LIBW = 240; // por debajo, la lista es inservible
const MAX_LIBW = 760;

const libPane = $("library-pane");
const libCollapseBtn = $("btn-lib-collapse");
const libResize = $("lib-resize");

/// Tope del ancho del panel: deja siempre ~220 px para la portada y nunca se
/// sale del escenario cuando la ventana es más angosta que el ancho guardado.
function clampLibW(w) {
  const stage = $("stage");
  const avail = stage ? stage.clientWidth : window.innerWidth;
  const max = Math.max(MIN_LIBW, Math.min(MAX_LIBW, avail - 220));
  return Math.round(Math.max(MIN_LIBW, Math.min(max, w)));
}

function applyLibWidth(w) {
  $("app").style.setProperty("--libw", clampLibW(w) + "px");
}

/// Aplica el ancho guardado, saneado a la ventana actual. No lo sobrescribe: si
/// la ventana es más pequeña se recorta lo justo para que quepa y, al volver a
/// agrandarla, se recupera el ancho que el propietario eligió.
function reapplyLibW() {
  let saved = 320;
  try { saved = Number(localStorage.getItem("enn.libW")) || 320; } catch {}
  applyLibWidth(saved);
}

function saveLibW(w) {
  try { localStorage.setItem("enn.libW", String(clampLibW(w))); } catch {}
}

function setLibCollapsed(collapsed) {
  libPane.classList.toggle("collapsed", collapsed);
  libCollapseBtn.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "Desplegar el panel de pistas" : "Contraer el panel de pistas";
  libCollapseBtn.setAttribute("aria-label", label);
  libCollapseBtn.title = label;
  try { localStorage.setItem("enn.libCollapsed", collapsed ? "1" : "0"); } catch {}
}

libCollapseBtn.addEventListener("click", () => setLibCollapsed(!libPane.classList.contains("collapsed")));

// estado recordado al abrir (el ancho se sanea si la ventana cambió)
reapplyLibW();
setLibCollapsed((() => {
  try { return localStorage.getItem("enn.libCollapsed") === "1"; } catch { return false; }
})());

// arrastre del borde izquierdo (mismo patrón que #split)
libResize.addEventListener("pointerdown", (e) => {
  libResize.classList.add("dragging");
  libResize.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const rect = $("stage-views").getBoundingClientRect();
    applyLibWidth(rect.right - ev.clientX);
    saveLibW(rect.right - ev.clientX);
  };
  const up = (ev) => {
    libResize.classList.remove("dragging");
    libResize.removeEventListener("pointermove", move);
    libResize.removeEventListener("pointerup", up);
    if (libResize.hasPointerCapture && ev) libResize.releasePointerCapture(ev.pointerId);
  };
  libResize.addEventListener("pointermove", move);
  libResize.addEventListener("pointerup", up);
});

// el asa es un `separator` enfocable: las flechas también lo mueven (10 px, o
// 40 con Shift), así el ajuste no depende del ratón
libResize.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const cur = parseFloat(getComputedStyle($("app")).getPropertyValue("--libw")) || 320;
  const next = cur + (e.key === "ArrowLeft" ? (e.shiftKey ? 40 : 10) : -(e.shiftKey ? 40 : 10));
  applyLibWidth(next);
  saveLibW(next);
});

// si la ventana cambia, el ancho guardado se sanea para no comerse la portada
window.addEventListener("resize", reapplyLibW);

// ---------------------------------------------------------------- sonidos de descarga (WebAudio, sin archivos)
let audioCtx = null;
function chime(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const notes = kind === "ok" ? [[660, 0], [990, 0.12]] : [[220, 0], [160, 0.15]];
    for (const [freq, delay] of notes) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = kind === "ok" ? "sine" : "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + delay);
      g.gain.exponentialRampToValueAtTime(0.08, now + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + delay);
      o.stop(now + delay + 0.4);
    }
  } catch {}
}

// ---------------------------------------------------------------- descargador de música
let dlClosed = true;
/// Tareas del descargador por id: llegan por eventos (`download://task`), con
/// el panel abierto o cerrado (Sprint 2; antes, sondeo cada 400 ms solo con
/// el panel abierto, y una descarga que acababa con él cerrado no entraba en
/// la biblioteca: hallazgo n.º 3 de la auditoría).
const dlTasks = new Map();
/// Lo que ya se avisó de cada tarea (duplicado, terminada).
const dlSeen = new Map();
const freshPaths = new Set(); // rutas recién descargadas (parpadea en la biblioteca)

async function refreshDlTarget() {
  try {
    const dir = await invoke("get_download_dir");
    el.dlTarget.textContent = `La música se guardará en: ${dir}`;
    return dir;
  } catch (e) {
    el.dlTarget.textContent = String(e);
    return null;
  }
}

function fnameBase(p) {
  return (p || "").split(/[\\/]/).pop() || p || "";
}

// Descargar ABRE y vuelve a CERRAR su vista (alterna). `goView` refresca
// destino, lista y duplicados, y recuerda de dónde venimos para volver allí.
el.dlBtn.addEventListener("click", () => {
  if (shell.view === "downloads") backFromDownloads();
  else goView("downloads");
});

// ✕ del propio panel: misma acción que volver a pulsar «Descargar»
$("btn-dl-close").addEventListener("click", () => backFromDownloads());

// Escape cierra las descargas cuando el foco está dentro del panel
el.dl.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && shell.view === "downloads") {
    e.stopPropagation();
    backFromDownloads();
  }
});

$("btn-dl-dir").addEventListener("click", async () => {
  const dir = await dialogOpen({ directory: true });
  if (!dir) return;
  try {
    const ok = await invoke("set_download_dir", { dir });
    el.dlTarget.textContent = `La música se guardará en: ${ok}`;
    toast("Carpeta de descarga actualizada");
  } catch (e) {
    toast(`No se pudo cambiar la carpeta: ${e}`);
  }
});

async function startDownload() {
  const url = el.dlUrl.value.trim();
  if (!url) return;
  el.dlStart.disabled = true;
  try {
    const dir = await invoke("get_download_dir");
    const fmt = document.getElementById("dl-fmt")?.value || "m4a";
    const res = await invoke("download_music", { url, dir, fmt });
    // las tareas reales (una por vídeo, aunque `url` fuera una lista) las
    // trae el sondeo de download_list de abajo con su propio título; no
    // creamos aquí una fila optimista para no duplicarla ni mostrar la URL
    // cruda de la lista completa como si fuera una sola canción
    el.dlUrl.value = "";
    const n = (res.ids || []).length;
    toast(n > 1 ? `Lista encolada: ${n} canciones` : "Descarga iniciada");
  } catch (e) {
    toast(`No se pudo descargar: ${e}`);
  } finally {
    el.dlStart.disabled = false;
  }
}

// la barra y el botón los gobierna el buscador (search.js): con un enlace
// llama a startDownload(); con texto busca en YouTube Music

// detección de duplicados (E1): normaliza títulos para comparar "Song (Official Video)"
// contra "Song" sin falsos negativos por mayúsculas/acentos/paréntesis
function normTitleKey(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[([].*?[)\]]/g, "") // quita "(Official Video)", "[HQ]", etc.
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
let libTitleKeys = new Set();
/// Buscador del descargador (ADR #112–#119)
const search = initSearch({
  invoke,
  toast,
  startUrlDownload: startDownload,
  inLibrary: (title, artist) => inLibrarySong(title, artist),
  playPath: (path) => playPathNow(path),
  enqueuePath: (path) => enqueuePath(path),
  downloadDir: () => invoke("get_download_dir"),
  downloadFmt: () => (document.getElementById("dl-fmt") || {}).value || "m4a",
  // con el panel cerrado avisa onDlTask (una sola campanilla, con su aviso)
  chime: (kind) => { if (!dlClosed) chime(kind); },
  volume: () => ui.volume,
});

/// Clave de canción para el buscador: como normTitleKey, pero los paréntesis
/// solo se quitan si son ruido («(feat. …)», «(Official Video)», «[HQ]»); un
/// «(Remix)» o «(En vivo)» es otra canción y se conserva.
function songKey(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{Diacritic}/gu, "")
    .replace(/[([][^)\]]*\b(feat|ft|official|oficial|audio|video|v[ií]deo|lyrics?|letra|visualizer|hd|hq|4k)\b[^)\]]*[)\]]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
/// Artistas de un texto «A, B & C feat. D» → { "a", "b", "c", "d" }.
function artistSet(s) {
  return new Set(
    (s || "")
      .toLowerCase()
      .normalize("NFD").replace(/\p{Diacritic}/gu, "")
      .split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b|\by\b|\band\b)\s*/)
      .map((a) => a.replace(/[^a-z0-9]+/g, " ").trim())
      .filter(Boolean),
  );
}
/// título → lista de conjuntos de artistas de la biblioteca con ese título
let libSongs = new Map();
function inLibrarySong(title, artist) {
  const cands = libSongs.get(songKey(title));
  if (!cands) return false;
  const want = artistSet(artist);
  return cands.some((have) => {
    if (!have.size || !want.size) return false; // sin artista no se puede afirmar
    for (const a of want) if (have.has(a)) return true;
    return false;
  });
}

async function refreshDupCache() {
  try {
    const tracks = await invoke("lib_list");
    libTitleKeys = new Set(tracks.map((t) => normTitleKey(t.title)).filter(Boolean));
    libSongs = new Map();
    for (const tr of tracks) {
      const k = songKey(tr.title);
      if (!k) continue;
      if (!libSongs.has(k)) libSongs.set(k, []);
      libSongs.get(k).push(artistSet(tr.artist));
    }
  } catch {}
}

// ---------------------------------------------------------------- avance de las descargas (Sprint 2)
/// Una tarea cambió: pastilla, resumen, barra superior y, si terminó, la
/// biblioteca (con el panel abierto o cerrado).
async function onDlTask(t) {
  dlTasks.set(t.id, t);
  search.onTask(t);
  paintDlSummary();
  const seen = dlSeen.get(t.id) || {};
  dlSeen.set(t.id, seen);
  // aviso de posible duplicado (E1): mismo título ya en la biblioteca; no
  // bloquea la descarga, solo avisa una vez por tarea
  if (t.title && !seen.dup && libTitleKeys.has(normTitleKey(t.title))) {
    seen.dup = true;
    toast(`Ya tienes algo parecido a "${t.title}" en tu biblioteca`);
  }
  if (t.state !== "done" || !t.path || seen.done) return;
  seen.done = true;
  try {
    const inLib = await invoke("lib_folders");
    const isIndexed = t.target_dir && inLib.some((f) => t.path.startsWith(f));
    if (isIndexed) {
      await invoke("lib_refresh");
      await reloadLibrary();
      autoRgScan();
      freshPaths.add(t.path);
      setTimeout(() => freshPaths.delete(t.path), 15000);
      refreshDupCache();
    }
    // con el panel abierto lo cuenta la pastilla (✓ y campanilla); cerrado, un aviso
    if (dlClosed) {
      chime("ok");
      toast(`${isIndexed ? "Descargada y agregada a la biblioteca: " : "Descargada: "}${t.title || fnameBase(t.path)}`);
    }
  } catch {}
}

/// Resumen del panel («2 descargando · 5 en cola · 2,4 MB/s») y anillo con
/// contador en el botón «Descargar» de la barra superior.
function paintDlSummary() {
  const sum = dlSummarize([...dlTasks.values()]);
  const box = $("dl-summary");
  if (box) {
    box.hidden = sum.left === 0;
    const parts = [];
    if (sum.running) parts.push(`${sum.running} descargando`);
    if (sum.waiting) parts.push(`${sum.waiting} en cola`);
    const sp = fmtSpeed(sum.speed);
    if (sp) parts.push(sp);
    $("dl-summary-text").textContent = parts.join(" · ");
  }
  const badge = $("dl-badge");
  if (badge) {
    badge.hidden = sum.left === 0;
    $("dl-badge-n").textContent = String(sum.left);
    badge.style.setProperty("--p", (sum.pct / 100).toFixed(3));
    el.dlBtn.title = sum.left
      ? `Descargando: ${sum.left} ${sum.left === 1 ? "canción" : "canciones"}`
      : "Descargar música (YouTube, SoundCloud, Bandcamp…)";
  }
}

/// Al abrir el panel se pone al día con la lista del motor.
async function syncDlTasks() {
  try {
    const tasks = await invoke("download_list");
    for (const t of tasks) dlTasks.set(t.id, t);
    search.onTasks(tasks);
    paintDlSummary();
  } catch {}
}

/// Aviso fijo del panel: cola detenida (disco lleno) o cola sin terminar del
/// último cierre. `action` = [texto, función].
function dlBanner(text, actions) {
  const b = $("dl-banner");
  if (!b) return;
  b.textContent = "";
  if (!text) { b.hidden = true; return; }
  const span = document.createElement("span");
  span.textContent = text;
  b.appendChild(span);
  for (const [label, fn] of actions || []) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "btn small ghost";
    x.textContent = label;
    x.addEventListener("click", () => { dlBanner(null); fn(); });
    b.appendChild(x);
  }
  b.hidden = false;
}

$("btn-dl-cancel-all")?.addEventListener("click", () => {
  invoke("download_cancel_all").then(() => toast("Descargas canceladas")).catch((e) => toast(String(e)));
});

(function dlEvents() {
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (!ev) return;
  ev.listen("download://task", (e) => { if (e && e.payload) onDlTask(e.payload); });
  ev.listen("download://halted", (e) => {
    toast(`Descargas detenidas: ${e.payload}`);
    dlBanner(`Descargas detenidas: ${e.payload}`, [["Reanudar", () => invoke("download_resume")]]);
  });
  ev.listen("download://throttled", () => {
    toast("YouTube está limitando las descargas: Enn va más despacio y reintenta solo");
  });
  ev.listen("tools://updated", (e) => toast(`Descargador actualizado (yt-dlp ${e.payload})`));
  ev.listen("enn://preview", (e) => {
    previewOn = !!(e && e.payload);
    search.onPreview(previewOn);
  });
  // ¿quedaron descargas a medias al cerrar la última vez?
  invoke("download_pending").then((n) => {
    if (!n) return;
    const text = `Quedaron ${n} ${n === 1 ? "descarga" : "descargas"} sin terminar al cerrar Enn`;
    toast(`${text}: ábrelas en Descargas`);
    dlBanner(text, [
      ["Reanudar", () => invoke("download_pending_take", { resume: true })],
      ["Descartar", () => invoke("download_pending_take", { resume: false })],
    ]);
  }).catch(() => {});
})();

// ---------------------------------------------------------------- menú contextual + propiedades
const ctxEl = $("ctx");
const propsEl = $("props");

function closeCtx() {
  ctxEl.classList.add("hidden");
  ctxEl.innerHTML = "";
}

function openCtx(x, y, items) {
  ctxEl.innerHTML = "";
  for (const it of items) {
    if (it === "-") {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      ctxEl.appendChild(s);
      continue;
    }
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.dim) b.classList.add("ctx-back");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeCtx();
      it.fn();
    });
    ctxEl.appendChild(b);
  }
  ctxEl.classList.remove("hidden");
  const r = ctxEl.getBoundingClientRect();
  const vx = Math.max(4, Math.min(x, window.innerWidth - r.width - 8));
  const vy = Math.max(4, Math.min(y, window.innerHeight - r.height - 8));
  ctxEl.style.left = vx + "px";
  ctxEl.style.top = vy + "px";
}

document.addEventListener("click", closeCtx);
window.addEventListener("blur", closeCtx);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCtx();
});

/// Resuelve la pista que representa una fila de la biblioteca (idx de filtrado
/// cuando existe, si no por ruta).
function trackFromLi(li) {
  if (li.dataset.idx !== undefined) {
    const t = filtered[Number(li.dataset.idx)] !== undefined
      ? library[filtered[Number(li.dataset.idx)]]
      : undefined;
    if (t) return t;
  }
  return (
    library.find((t) => t.path === li.dataset.path) ||
    session.find((s) => s.path === li.dataset.path)
  );
}

async function playlistSubmenu(track, x, y) {
  let pls = [];
  try {
    pls = await invoke("playlist_list");
  } catch {}
  const items = pls.length
    ? pls.map((pl) => ({
        label: pl.name,
        fn: async () => {
          try {
            const n = await invoke("playlist_add", { name: pl.name, track });
            toast(n ? `Añadida a «${pl.name}»` : "Ya estaba en la playlist");
          } catch (err) {
            toast(String(err));
          }
        },
      }))
    : [{ label: "(no hay playlists: créala en la pestaña Playlist)", fn: () => {} }];
  openCtx(x, y, items);
}

function showProps(t) {
  const body = $("props-body");
  const ext = (t.path.split(".").pop() || "").toUpperCase();
  const rows = [
    ["Título", t.title],
    ["Artista", t.artist || "—"],
    ["Álbum", t.album || "—"],
    ["Género", t.genre || "—"],
    ["Año", t.year || "—"],
    ["Duración", t.dur ? fmtTime(t.dur) : "—"],
    ["Formato", ext || "—"],
    ["Sonoridad", typeof t.rg === "number" ? `${t.rg.toFixed(1)} LUFS` : "sin analizar"],
    ["Ruta", t.path],
  ];
  body.innerHTML = "";
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    body.append(dt, dd);
  }
  propsEl.classList.remove("hidden");
}

$("props-close").addEventListener("click", () => propsEl.classList.add("hidden"));
propsEl.addEventListener("click", (e) => {
  if (e.target === propsEl) propsEl.classList.add("hidden");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !propsEl.classList.contains("hidden")) {
    propsEl.classList.add("hidden");
  }
});

el.libList.addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li");
  if (!li || !li.dataset.path) return;
  e.preventDefault();
  const t = trackFromLi(li);
  if (!t) return;
  openCtx(e.clientX, e.clientY, [
    {
      label: "▶ Reproducir ahora",
      fn: () => {
        if (li.dataset.idx !== undefined) playFromLibrary(Number(li.dataset.idx));
        else playPathNow(t.path);
      },
    },
    { label: "⏭ Reproducir a continuación", fn: () => playNext(t) },
    {
      label: "＋ Añadir a la cola",
      fn: () => {
        const n = pushTracks([t], { quiet: true });
        toast(n ? "Agregada a la cola" : "Ya está en la cola");
      },
    },
    { label: "＋ Añadir a playlist…", fn: () => playlistSubmenu(t, e.clientX, e.clientY) },
    "-",
    {
      label: "📂 Mostrar en carpeta",
      fn: () => invoke("reveal_in_folder", { path: t.path }).catch((err) => toast(String(err))),
    },
    { label: "ℹ Propiedades", fn: () => showProps(t) },
    { label: "✎ Editar etiquetas…", fn: () => showTagEditor(t) },
  ]);
});

function showTagEditor(t) {
  const body = $("props-body");
  $("props-title").textContent = "Editar etiquetas";
  body.innerHTML = "";
  body.style.display = "block";
  const mk = (label, value, listId) => {
    const l = document.createElement("label");
    l.style.cssText = "display:block;margin:8px 0;font-size:12px;color:var(--text-dim,#888)";
    l.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = value || "";
    if (listId) inp.setAttribute("list", listId);
    inp.style.cssText = "width:100%;margin-top:3px;padding:6px 8px;border:none;border-radius:6px;background:var(--track,rgba(128,128,128,0.15));color:inherit;font:inherit";
    l.appendChild(inp);
    body.appendChild(l);
    return inp;
  };
  const fTitle = mk("Título", t.title);
  const fArtist = mk("Artista", t.artist, "artists-datalist");
  const fAlbum = mk("Álbum", t.album, "albums-datalist");
  const fGenre = mk("Género", t.genre);
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;margin-top:12px;justify-content:flex-end";
  const cancel = document.createElement("button");
  cancel.className = "btn small";
  cancel.textContent = "Cancelar";
  cancel.addEventListener("click", () => {
    body.style.display = "";
    propsEl.classList.add("hidden");
  });
  const save = document.createElement("button");
  save.className = "btn small primary";
  save.textContent = "Guardar";
  save.addEventListener("click", async () => {
    try {
      await invoke("tags_write", {
        path: t.path,
        title: fTitle.value,
        artist: fArtist.value,
        album: fAlbum.value,
        genre: fGenre.value,
      });
      propsEl.classList.add("hidden");
      body.style.display = "";
      toast("Etiquetas guardadas");
      await reloadLibrary();
    } catch (e) {
      toast(`No se pudo guardar: ${e}`);
    }
  });
  row.append(cancel, save);
  body.appendChild(row);
  propsEl.classList.remove("hidden");
}

// Editor de etiquetas por lote: aplica artista/álbum/género a todas las
// `tracks` que coincidían con el filtro de búsqueda activo. Cada campo tiene su
// propio checkbox: sin marcar, ese campo no se toca en ninguna pista;
// marcado, se escribe el valor (vacío incluido) en todas.
function showBatchTagEditor(tracks) {
  const body = $("props-body");
  $("props-title").textContent = `Editar etiquetas de ${tracks.length} canciones`;
  body.innerHTML = "";
  body.style.display = "block";
  const mkField = (label, listId) => {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:block;margin:8px 0;font-size:12px;color:var(--text-dim,#888)";
    const head = document.createElement("div");
    head.style.cssText = "display:flex;align-items:center;gap:6px";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    const span = document.createElement("span");
    span.textContent = `Cambiar ${label} a:`;
    head.append(chk, span);
    const inp = document.createElement("input");
    inp.type = "text";
    inp.disabled = true;
    if (listId) inp.setAttribute("list", listId);
    inp.style.cssText = "width:100%;margin-top:3px;padding:6px 8px;border:none;border-radius:6px;background:var(--track,rgba(128,128,128,0.15));color:inherit;font:inherit";
    chk.addEventListener("change", () => { inp.disabled = !chk.checked; });
    wrap.append(head, inp);
    body.appendChild(wrap);
    return { chk, inp };
  };
  const fArtist = mkField("artista", "artists-datalist");
  const fAlbum = mkField("álbum", "albums-datalist");
  const fGenre = mkField("género");
  const hint = document.createElement("div");
  hint.style.cssText = "font-size:12px;color:var(--text-dim,#888);margin-top:4px";
  hint.textContent = "Deja un campo sin marcar para no tocarlo. Dejarlo marcado pero vacío borra esa etiqueta en las canciones seleccionadas.";
  body.appendChild(hint);
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;margin-top:12px;justify-content:flex-end";
  const cancel = document.createElement("button");
  cancel.className = "btn small";
  cancel.textContent = "Cancelar";
  cancel.addEventListener("click", () => {
    body.style.display = "";
    propsEl.classList.add("hidden");
  });
  const save = document.createElement("button");
  save.className = "btn small primary";
  save.textContent = `Guardar en ${tracks.length}`;
  save.addEventListener("click", async () => {
    if (!fArtist.chk.checked && !fAlbum.chk.checked && !fGenre.chk.checked) {
      return toast("Marca al menos un campo para cambiar");
    }
    try {
      const res = await invoke("tags_write_batch", {
        paths: tracks.map((t) => t.path),
        artist: fArtist.chk.checked ? fArtist.inp.value : null,
        album: fAlbum.chk.checked ? fAlbum.inp.value : null,
        genre: fGenre.chk.checked ? fGenre.inp.value : null,
      });
      propsEl.classList.add("hidden");
      body.style.display = "";
      toast(
        res.failed
          ? `Actualizadas ${res.updated}, ${res.failed} fallaron (${res.first_error || ""})`
          : `Etiquetas actualizadas en ${res.updated} canciones`
      );
      await reloadLibrary();
    } catch (e) {
      toast(`No se pudo guardar: ${e}`);
    }
  });
  row.append(cancel, save);
  body.appendChild(row);
  propsEl.classList.remove("hidden");
}

// Detección de duplicados en biblioteca: agrupa por título+artista
// normalizados (mismo normTitleKey que ya usa el aviso de descarga) — no
// hace falta comparar contenido de archivo, dos pistas con el mismo título
// y artista casi siempre son la misma canción en dos copias/calidades.
function findLibraryDuplicates() {
  const groups = new Map();
  for (const t of library) {
    const key = `${normTitleKey(t.artist)}|${normTitleKey(t.title)}`;
    if (key === "|") continue; // sin título ni artista: no hay nada que comparar
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const dupGroups = [];
  for (const tracks of groups.values()) {
    if (tracks.length > 1) dupGroups.push(tracks);
  }
  dupGroups.sort((a, b) => b.length - a.length);
  return dupGroups;
}

function showDuplicatesPanel() {
  const groups = findLibraryDuplicates();
  const body = $("props-body");
  $("props-title").textContent = groups.length
    ? `Posibles duplicados (${groups.length} grupos)`
    : "Sin duplicados";
  body.innerHTML = "";
  body.style.display = "block";
  if (!groups.length) {
    const p = document.createElement("div");
    p.style.cssText = "font-size:13px;color:var(--text-dim,#888)";
    p.textContent = "No se encontraron pistas con el mismo título y artista.";
    body.appendChild(p);
  }
  for (const group of groups) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border,rgba(128,128,128,.2))";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:6px;font-size:13px";
    title.textContent = `${group[0].artist || "Sin artista"} — ${group[0].title}`;
    wrap.appendChild(title);
    for (const t of group) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0";
      const ext = (t.path.split(".").pop() || "").toUpperCase();
      const info = document.createElement("span");
      info.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-dim,#888)";
      info.title = t.path;
      info.textContent = `${ext} · ${fmtTime(t.dur || 0)} · ${t.path}`;
      const keep = document.createElement("button");
      keep.className = "btn small";
      keep.textContent = "Quedarme con esta";
      keep.addEventListener("click", async () => {
        const others = group.filter((x) => x.path !== t.path);
        keep.disabled = true;
        let ok = 0;
        for (const o of others) {
          try {
            await invoke("lib_remove_track", { path: o.path });
            ok++;
          } catch {}
        }
        toast(`Quitadas ${ok} de la biblioteca (los archivos no se tocan en disco)`);
        await reloadLibrary();
        showDuplicatesPanel(); // refresca la lista con este grupo ya resuelto
      });
      row.append(info, keep);
      wrap.appendChild(row);
    }
    body.appendChild(wrap);
  }
  const closeRow = document.createElement("div");
  closeRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:8px";
  const close = document.createElement("button");
  close.className = "btn small";
  close.textContent = "Cerrar";
  close.addEventListener("click", () => {
    body.style.display = "";
    propsEl.classList.add("hidden");
  });
  closeRow.appendChild(close);
  body.appendChild(closeRow);
  propsEl.classList.remove("hidden");
}

const btnDuplicates = $("btn-duplicates");
if (btnDuplicates) btnDuplicates.addEventListener("click", showDuplicatesPanel);

el.queue.addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li");
  if (!li || li.dataset.idx === undefined) return;
  e.preventDefault();
  const idx = Number(li.dataset.idx);
  const t = session[idx];
  if (!t) return;
  openCtx(e.clientX, e.clientY, [
    { label: "▶ Reproducir ahora", fn: () => playAtManual(idx) },
    { label: "⏭ Poner a continuación", fn: () => playNext(t) },
    { label: "↑ Subir en la cola", fn: () => moveQueueItem(idx, idx - 1) },
    { label: "↓ Bajar en la cola", fn: () => moveQueueItem(idx, idx + 2) },
    "-",
    { label: "✕ Quitar de la cola", fn: () => removeAt(idx) },
    {
      label: "📂 Mostrar en carpeta",
      fn: () => invoke("reveal_in_folder", { path: t.path }).catch((err) => toast(String(err))),
    },
    { label: "ℹ Propiedades", fn: () => showProps(t) },
  ]);
});

// ---------------------------------------------------------------- teclado
// Un deslizador usado con el ratón suelta el foco al soltar el botón: así las
// flechas vuelven a ser los atajos de la app y no mueven ese control sin que
// se vea. Con el teclado (Tab) se siguen pudiendo enfocar y mover.
document.addEventListener("pointerup", (e) => {
  const r = e.target && e.target.closest && e.target.closest('input[type="range"]');
  if (r) setTimeout(() => r.blur(), 0);
}, true);

document.addEventListener("keydown", (e) => {
  // Ctrl+F: buscar en la biblioteca desde cualquier parte
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  // Con un control enfocado los atajos no actúan. Antes los deslizadores
  // quedaban fuera de esta regla a propósito y era un fallo: con Graves (o
  // una banda) enfocado tras usarlo con el ratón, cada → pasaba de canción Y
  // subía el deslizador un paso; mantenerla pulsada lo llevaba a +12 dB.
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target.isContentEditable) return;
  if (e.code === "Space") { e.preventDefault(); invoke("toggle_pause"); }
  else if (e.code === "ArrowRight") nextManual();
  else if (e.code === "ArrowLeft") prevManual();
  else if (e.key === "m" || e.key === "M") el.btnMixer.click();
});

// ---------------------------------------------------------------- controles multimedia del sistema
// SMTC (Windows) / MPRIS (Linux futuro): anterior/siguiente dependen de la cola de la UI.
try {
  const evApi = window.__TAURI__.event;
  evApi.listen("enn://media", (e) => {
    if (e.payload === "next") nextManual();
    else if (e.payload === "prev") prevManual();
  });
  // acciones de UI desde atajos globales (Ctrl+Alt+M)
  evApi.listen("enn://ui", (e) => {
    if (e.payload === "mixer") el.btnMixer.click();
  });
} catch {}

// ---------------------------------------------------------------- modo mini (E1)
// El tamaño mínimo del layout completo (980x600, ver tauri.conf.json — el
// límite estático ahí es el de modo mini, 430x90, para no bloquearlo) se
// aplica en tiempo de ejecución: si fuera estático siempre, no se podría
// encoger a modo mini nunca. Sin este mínimo dinámico en modo normal, la
// ventana se podía arrastrar hasta romper la barra de controles y el
// selector de dispositivo/volumen quedaban recortados e inalcanzables.
// 1366×768 (la resolución estándar de portátil): lo mínimo en que Studio
// enseña sin recortes la barra lateral, las 10 bandas con sus cifras más el
// paramétrico, la portada, la biblioteca, la telemetría y la columna del
// mezclador; medido el 2026-11-09 (a 1280 se perdía la banda de 16 kHz y la
// telemetría recortaba sus títulos). ADR #124.
const NORMAL_MIN = { w: 1366, h: 768 };
const MINI_MIN = { w: 430, h: 90 };

async function applyMinSize(w, h) {
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    const { LogicalSize } = window.__TAURI__.dpi || {};
    if (!LogicalSize) return;
    await getCurrentWindow().setMinSize(new LogicalSize(w, h));
  } catch {}
}
applyMinSize(NORMAL_MIN.w, NORMAL_MIN.h);

const btnMini = $("btn-mini");
if (btnMini) {
  const setMini = async (mini) => {
    try {
      const { getCurrentWindow } = window.__TAURI__.window;
      const { LogicalSize } = window.__TAURI__.dpi || {};
      const w = getCurrentWindow();
      document.body.classList.toggle("mini", mini);
      if (mini && recoCardRef && recoCardRef.open) recoCardRef.hide();
      // en mini solo existe el pie: la botonera tiene que volver a él
      placeParts();
      // relajar el mínimo ANTES de encoger (si no, setSize se recorta al
      // mínimo todavía vigente) y restaurarlo ANTES de volver a crecer
      await applyMinSize(mini ? MINI_MIN.w : NORMAL_MIN.w, mini ? MINI_MIN.h : NORMAL_MIN.h);
      if (LogicalSize) {
        await w.setSize(mini ? new LogicalSize(430, 90) : new LogicalSize(NORMAL_MIN.w, NORMAL_MIN.h));
      }
      btnMini.classList.toggle("active", mini);
      btnMini.title = mini ? "Volver al modo completo" : "Modo mini";
    } catch {}
  };
  btnMini.addEventListener("click", () => setMini(!document.body.classList.contains("mini")));
  // doble clic en la barra de controles restaura el modo completo
  $("controls").addEventListener("dblclick", (e) => {
    if (document.body.classList.contains("mini") && e.target.closest("input") === null) {
      setMini(false);
    }
  });
}


// ---------------------------------------------------------------- fase 2: modos, vistas y barra de título
// El estado de la interfaz vive en <body>: data-mode (simple | studio) y
// data-view (nowplaying | library | downloads). El CSS decide qué se ve a
// partir de ahí; este bloque solo mantiene ese estado y lo persiste.

const shell = {
  mode: "simple",
  view: "nowplaying",
  libTab: "all", // agrupación de la biblioteca (la misma que usa setView)
  prevView: "nowplaying", // vista a la que vuelve la ✕ / alternancia de Descargas
};

const LIB_TABS = new Set(["all", "artist", "albums", "genre", "year", "activity", "playlist"]);
const SHELL_VIEWS = new Set(["nowplaying", "library", "downloads"]);

// Visualizador (Cinta / Traza): canvas de fondo + su sección de Ajustes.
const viz = initViz({ invoke });

function loadShell() {
  try {
    const m = localStorage.getItem("enn.mode");
    if (m === "simple" || m === "studio") shell.mode = m;
    // Ajustes → Interfaz → «Al abrir» (ADR #104)
    const sm = localStorage.getItem("enn.startMode");
    if (sm === "simple" || sm === "studio") shell.mode = sm;
    const v = localStorage.getItem("enn.view");
    if (SHELL_VIEWS.has(v)) shell.view = v;
    const t = localStorage.getItem("enn.libTab");
    if (LIB_TABS.has(t)) shell.libTab = t;
    // de dónde volver al cerrar Descargas (nunca es «downloads»)
    const p = localStorage.getItem("enn.prevView");
    if (SHELL_VIEWS.has(p) && p !== "downloads") shell.prevView = p;
  } catch {}
  // Studio no tiene "Reproduciendo" en el menú: arranca en la biblioteca
  if (shell.mode === "studio" && shell.view === "nowplaying") shell.view = "library";
}

function saveShell() {
  try {
    localStorage.setItem("enn.mode", shell.mode);
    localStorage.setItem("enn.view", shell.view);
    localStorage.setItem("enn.libTab", shell.libTab);
    localStorage.setItem("enn.prevView", shell.prevView);
  } catch {}
}

// Piezas que se mudan entre el pie y el escenario. Son los MISMOS nodos:
// moverlos conserva sus eventos y su estado, así que nunca hay dos
// botoneras que sincronizar ni la posibilidad de que se contradigan.
const movable = {
  transport: $("transport"),
  seek: document.querySelector(".seekwrap"),
  dock: $("outdock"),
};

/// La cola de «Siguientes» es también un único nodo: en Studio vive en la
/// columna derecha y en Simple se muda bajo la portada (mismo patrón que
/// `placeParts`). Así nunca hay dos listas que sincronizar.
const queuePanel = $("queue-panel");
const queueSlot = $("np-slot-queue");
const queueHome = queuePanel ? queuePanel.parentElement : null;

function placeQueue() {
  if (!queuePanel || !queueSlot || !queueHome) return;
  const dest = shell.mode === "simple" ? queueSlot : queueHome;
  if (queuePanel.parentElement !== dest) dest.appendChild(queuePanel);
}

function placeParts() {
  // en Simple la tarjeta del centro está siempre a la vista (los paneles
  // flotan encima), así que la botonera vive en ella en cualquier vista
  const onStage = shell.mode === "simple" && !document.body.classList.contains("mini");
  const where = movable.transport.parentElement.id;
  if (onStage === (where === "np-slot-transport")) return; // ya están donde toca

  const footer = $("controls");
  if (onStage) {
    $("np-slot-seek").appendChild(movable.seek);
    $("np-slot-transport").appendChild(movable.transport);
    $("np-slot-dock").appendChild(movable.dock);
  } else {
    footer.insertBefore(movable.transport, $("ctl-meta"));
    footer.insertBefore(movable.seek, el.btnMixer);
    footer.appendChild(movable.dock);
  }
  // la onda del seek y los espectros miden su ancho al redimensionar
  window.dispatchEvent(new Event("resize"));
}

/// Dónde nace el visualizador de espectro (dentro del mezclador): ahí vuelve
/// cuando no está en el escenario.
const spectrumHome = $("spectrum") ? $("spectrum").parentElement : null;

/// El ecualizador vive en el escenario en Studio (donde cabe de verdad) y, en
/// Simple, en la portada detrás de su botón (no en la columna lateral, que no
/// debe arrastrar controles). Se muda el nodo real, igual que `placeParts` hace
/// con el transporte, para no duplicar controles: el panel `.mix-eq` y su botón
/// viajan juntos. El visualizador de espectro lo acompaña: en Studio es el
/// render activo del escenario y en Simple desaparece de la columna (así nunca
/// hay tres visualizadores a la vez).
/// La telemetría de Studio vive en su propia fila, a todo el ancho del
/// escenario y bajo el ecualizador: en la columna de la biblioteca sus cinco
/// celdas recortaban los títulos («FOR…», «MUE…»). Tarea del tablero.
(function placeTelemetry() {
  const tm = $("studio-telemetry");
  const stage = $("stage");
  const views = $("stage-views");
  if (tm && stage && views && tm.parentElement !== stage) stage.insertBefore(tm, views);
})();

function placeEq() {
  const eq = $("mix-eq-box") || document.querySelector("#mixer .mix-eq");
  const row = document.querySelector("#mixer .mix-row");
  const stage = $("stage-eq");
  const slot = $("np-slot-eq");
  const spec = $("spectrum");
  const inSimple = shell.mode !== "studio";

  // El panel va al escenario (Studio) o al slot de la portada (Simple); el
  // botón que lo despliega lo acompaña en Simple y vuelve al mezclador —donde
  // «simple-only» lo oculta— en Studio. En ambos sitios queda antes del panel.
  // en Simple el panel va al cajón de bajo la tarjeta, con Graves/Agudos/Fade
  const drawer = document.querySelector("#np-eq-drawer .np-drawer-inner");
  const tone = $("mixer") && $("mixer").querySelector(".mix-tone") || document.querySelector(".mix-tone");
  if (tone && drawer && row) {
    const toneHome = inSimple ? drawer : row;
    if (tone.parentElement !== toneHome) toneHome.insertBefore(tone, toneHome.firstChild);
  }
  const eqHome = inSimple ? drawer || slot || row : stage;
  if (eqOpenBtn && row) {
    const btnHome = inSimple ? slot || eqHome : row;
    const ref = eq && eq.parentElement === btnHome ? eq : null;
    const inPill = inSimple && typeof npView !== "undefined" && npView === "stage";
    if (!inPill && (eqOpenBtn.parentElement !== btnHome || eqOpenBtn.nextElementSibling !== ref)) {
      btnHome.insertBefore(eqOpenBtn, ref);
    }
  }
  if (eq && eqHome && eq.parentElement !== eqHome) eqHome.appendChild(eq);
  if (spec && stage) {
    if (shell.mode === "studio") {
      if (spec.parentElement !== stage) stage.insertBefore(spec, stage.firstChild);
    } else if (spectrumHome && spec.parentElement !== spectrumHome) {
      spectrumHome.appendChild(spec);
    }
  }
}

/// El ecualizador «pequeño» (el de Simple) solo sale con su botón; el
/// paramétrico también se despliega con el suyo. Ambos estados se recuerdan.
const eqBox = $("mix-eq-box");
const eqOpenBtn = $("btn-eq-open");
const eqParamBox = $("eq-param");
const eqParamBtn = $("btn-eq-param");

function setEqOpen(open) {
  eqBox.dataset.collapsed = open ? "0" : "1";
  eqOpenBtn.setAttribute("aria-expanded", String(open));
  const drawer = $("np-eq-drawer");
  if (drawer) {
    drawer.dataset.open = open ? "1" : "0";
    // Auditoría 2026-11-13, n.º 1: cerrado (alto 0) seguía recibiendo el foco
    // con Tab y las flechas movían bandas y Graves/Agudos sin verse (posible
    // causa del +12 dB que aparecía solo). `inert` lo saca del foco y del clic.
    drawer.inert = !open;
  }
  try {
    localStorage.setItem("enn.eqOpen", open ? "1" : "0");
  } catch {}
}

function setEqParamOpen(open) {
  eqParamBox.classList.toggle("hidden", !open);
  eqParamBtn.setAttribute("aria-pressed", String(open));
  try {
    localStorage.setItem("enn.eqParam", open ? "1" : "0");
  } catch {}
}

eqOpenBtn.setAttribute("aria-controls", "np-eq-drawer");
eqOpenBtn.addEventListener("click", () => setEqOpen(eqBox.dataset.collapsed === "1"));
eqParamBtn.addEventListener("click", () => setEqParamOpen(eqParamBox.classList.contains("hidden")));
setEqOpen((() => {
  try {
    return localStorage.getItem("enn.eqOpen") === "1";
  } catch {
    return false;
  }
})());
setEqParamOpen((() => {
  try {
    return localStorage.getItem("enn.eqParam") !== "0";
  } catch {
    return true;
  }
})());

function syncShell() {
  const b = document.body;
  b.dataset.mode = shell.mode;
  b.dataset.view = shell.view;

  $("mode-simple").setAttribute("aria-checked", String(shell.mode === "simple"));
  $("mode-studio").setAttribute("aria-checked", String(shell.mode === "studio"));

  const current = shell.view === "library" ? shell.libTab : shell.view;
  for (const n of document.querySelectorAll(".nav-item")) {
    const on = n.dataset.nav === current;
    n.classList.toggle("active", on);
    if (on) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  }

  // estos dos flags gobiernan bucles que solo deben correr si su vista se ve
  npOpen = shell.view === "nowplaying";
  const dlWasOpen = !dlClosed;
  dlClosed = shell.view !== "downloads";
  // al cerrar Descargas (o cambiar de modo) la vista previa se apaga con fundido
  if (dlWasOpen && dlClosed) document.dispatchEvent(new Event("enn:dl-close"));
  // el botón de la barra refleja si su vista está abierta (al pulsarlo alterna)
  el.dlBtn.setAttribute("aria-pressed", String(shell.view === "downloads"));

  placeParts();
  placeEq();
  if (typeof placePill === "function" && radioHome !== undefined) placePill();
  placeQueue();
  saveShell();
  specKick();
  armIdle();
}

// ==========================================================================
// FASE 6 — animación de estructura (cambio de modo, cola, vacío) e inactividad.
// Solo transform y opacidad; curva --ease-out y 200 ms (por debajo de 300 ms).
// La entrada arranca en scale(0.98) + opacidad 0 (nunca scale(0)) y el
// escalonado es de 45 ms. Con «reduced motion» se mantiene la opacidad y se
// quita el desplazamiento.
// ==========================================================================
const REDUCE_MOTION =
  !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const ROW_MS = 200; // duración de una fila
const ROW_STAGGER = 45; // escalonado entre filas
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/// Filas propias de Studio: todo lo que en Simple desaparece con el modo.
function studioRows() {
  return Array.from(document.querySelectorAll(".studio-only"));
}

/// Entrada (`show`) o salida de una fila desde la derecha. Devuelve la
/// animación para poder esperar a que termine.
function rowAnim(node, i, show, axis = "x") {
  if (node._rowAnim) node._rowAnim.cancel();
  const d = REDUCE_MOTION ? 0 : 14;
  const shift = d ? `translate${axis.toUpperCase()}(${d}px) scale(0.98)` : "none";
  const from = show ? { opacity: 0, transform: shift } : { opacity: 1, transform: "none" };
  const to = show ? { opacity: 1, transform: "none" } : { opacity: 0, transform: shift };
  const a = node.animate([from, to], {
    duration: ROW_MS,
    delay: Math.min(i, 5) * ROW_STAGGER,
    easing: EASE_OUT,
    fill: show ? "backwards" : "forwards",
  });
  node._rowAnim = a;
  a.onfinish = () => {
    if (show) node._rowAnim = null;
  };
  return a;
}

/// Gesto suelto (estado vacío, aviso): opacidad + un movimiento pequeño.
function popAnim(node, { from = "up" } = {}) {
  if (node._popAnim) node._popAnim.cancel();
  const d = REDUCE_MOTION || from === "none" ? 0 : 8;
  const sm = d ? `translateY(${from === "up" ? d : -d}px) scale(0.98)` : "none";
  node._popAnim = node.animate(
    [{ opacity: 0, transform: sm }, { opacity: 1, transform: "none" }],
    { duration: ROW_MS, easing: EASE_OUT, fill: "backwards" },
  );
}

/// La cola aparece bajo la portada al entrar en Simple.
function animateQueueIn() {
  if (!queuePanel || shell.mode !== "simple" || shell.view !== "nowplaying") return;
  rowAnim(queuePanel, 1, true, "x");
}

// ---------------------------------------------------------------- inactividad (Simple)
// Tras 3 s sin actividad se esconde el cromo (menú, barra de título, cola y
// mezclador) y solo queda la portada. Es estado de sesión: no se persiste.
// Solo con la portada a la vista: en Simple con la biblioteca o las descargas
// abiertas, esconder el menú dejaría la lista sin su navegación.
let IDLE_MS = 3000; // Ajustes → Interfaz → «Inactividad» (0 = nunca)
try {
  const v = Number(localStorage.getItem("enn.idleMs"));
  if ([0, 3000, 5000, 10000].includes(v) && localStorage.getItem("enn.idleMs") !== null) IDLE_MS = v;
} catch {}
let idleTimer = 0;

function idleAllowed() {
  return (
    IDLE_MS > 0 &&
    shell.mode === "simple" &&
    shell.view === "nowplaying" &&
    !document.body.classList.contains("mini")
  );
}
function focusInField() {
  const a = document.activeElement;
  if (!a) return false;
  return (
    a.isContentEditable ||
    a.tagName === "INPUT" ||
    a.tagName === "TEXTAREA" ||
    a.tagName === "SELECT"
  );
}
function overlayOpen() {
  const props = $("props");
  const ctx = $("ctx");
  return (
    (props && !props.classList.contains("hidden")) ||
    (ctx && !ctx.classList.contains("hidden")) ||
    !!document.querySelector("dialog[open]")
  );
}
// Vistas de «Reproduciendo» (ADR #139): «stage» (Escenario, la predeterminada)
// lleva la radio junto a la carátula y centra la tarjeta al quedar inactiva;
// «classic» (Clásica) es la de antes, con la radio en «Siguientes».
let npView = "stage";
try { if (localStorage.getItem("enn.npView") === "classic") npView = "classic"; } catch {}
const radioHome = $("btn-radio") ? $("btn-radio").parentElement : null;
const repeatHome = { parent: $("btn-repeat") && $("btn-repeat").parentElement, next: $("btn-repeat") && $("btn-repeat").nextSibling };
let sidePill = null;
/// Escenario: pastilla vertical a la derecha de la carátula con aleatorio
/// (multicolor), repetir y ecualizador (solo icono). Clásica: cada uno a su sitio.
function placePill() {
  const art = document.querySelector("#now-playing .np-art-wrap");
  const radio = $("btn-radio"), rep = $("btn-repeat"), eqb = $("btn-eq-open");
  if (!art || !radio) return;
  const stage = npView === "stage" && shell.mode === "simple" && !document.body.classList.contains("mini");
  if (stage) {
    if (!sidePill) {
      sidePill = document.createElement("div");
      sidePill.className = "np-side-pill";
      sidePill.setAttribute("role", "group");
      sidePill.setAttribute("aria-label", "Radio, repetir y ecualizador");
    }
    if (sidePill.parentElement !== art) art.appendChild(sidePill);
    for (const b of [radio, rep, eqb]) if (b && b.parentElement !== sidePill) sidePill.appendChild(b);
    // orden fijo: aleatorio, repetir, ecualizador
    for (const b of [radio, rep, eqb]) if (b) sidePill.appendChild(b);
  } else {
    if (radioHome && radio.parentElement !== radioHome) radioHome.insertBefore(radio, radioHome.firstChild);
    if (rep && repeatHome.parent && rep.parentElement !== repeatHome.parent) repeatHome.parent.insertBefore(rep, repeatHome.next && repeatHome.next.parentElement === repeatHome.parent ? repeatHome.next : null);
    if (sidePill) sidePill.remove();
  }
}
function applyNpView() {
  document.body.dataset.npview = npView;
  placeEq();
  placePill();
  paintModes();
  centerOnIdle(document.body.dataset.idle === "1");
}

/// Escenario: en reposo la tarjeta entera viaja al centro de la ventana con un
/// rebote, y vuelve a su sitio igual al salir. Solo transform (fluido).
function centerOnIdle(on) {
  const block = $("np-block");
  if (!block) return;
  if (!on || shell.mode !== "simple") {
    block.classList.remove("np-centered");
    block.style.transform = "";
    return;
  }
  block.style.transform = "";
  const r = block.getBoundingClientRect();
  const dy = window.innerHeight / 2 - (r.top + r.height / 2);
  const dx = window.innerWidth / 2 - (r.left + r.width / 2);
  block.classList.add("np-centered");
  block.style.transform = REDUCE_MOTION ? "" : `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
}
window.addEventListener("resize", () => { if (document.body.dataset.idle === "1") centerOnIdle(true); });

function setIdle(on) {
  const was = document.body.dataset.idle === "1";
  document.body.dataset.idle = on ? "1" : "0";
  if (was !== on) centerOnIdle(on);
}
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = 0;
  if (!idleAllowed()) {
    setIdle(false);
    return;
  }
  idleTimer = setTimeout(() => {
    if (!idleAllowed() || focusInField() || overlayOpen()) return;
    setIdle(true);
  }, IDLE_MS);
}
function onActivity() {
  if (document.body.dataset.idle === "1") setIdle(false);
  armIdle();
}
for (const ev of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) {
  window.addEventListener(ev, onActivity, { passive: true, capture: true });
}

/// Cierra Descargas y vuelve a la vista desde la que se abrió; si no hay una
/// válida, al inicio del modo actual (Simple → Reproduciendo, Studio → Biblioteca).
function backFromDownloads() {
  const home = shell.mode === "studio" ? "library" : "nowplaying";
  const prev = shell.prevView;
  goView(SHELL_VIEWS.has(prev) && prev !== "downloads" ? prev : home);
}

function goView(v, tab) {
  if (v === "library" && tab && LIB_TABS.has(tab)) {
    shell.libTab = tab;
    setView(tab);
  }
  // entrar en Descargas recuerda de dónde venimos para poder volver allí
  if (v === "downloads" && shell.view !== "downloads") shell.prevView = shell.view;
  const was = shell.view;
  shell.view = v;
  syncShell();
  if (v !== was && (v === "library" || v === "downloads")) panelIn(v);
  if (v === "downloads") {
    refreshDlTarget();
    syncDlTasks();
    refreshDupCache();
  } else if (v === "nowplaying") {
    animateQueueIn();
  }
}

/// Sección del escenario de cada vista con panel lateral.
const PANEL_OF = { library: "view-library", downloads: "view-downloads" };

function panelIn(v) {
  const node = $(PANEL_OF[v]);
  if (!node || REDUCE_MOTION) return;
  node.animate(
    [{ opacity: 0, transform: "translateX(24px) scale(0.99)" }, { opacity: 1, transform: "none" }],
    { duration: 260, easing: EASE_OUT },
  );
}

/// La flecha del borde izquierdo «guarda» el panel: sale hacia la derecha y
/// queda «Reproduciendo».
function closePanel(v) {
  const node = $(PANEL_OF[v]);
  const done = () => goView("nowplaying");
  if (!node || REDUCE_MOTION) return done();
  const a = node.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(24px) scale(0.99)" }],
    { duration: 170, easing: EASE_OUT, fill: "forwards" },
  );
  a.onfinish = () => { done(); a.cancel(); };
}

for (const [v, id] of Object.entries(PANEL_OF)) {
  const node = $(id);
  if (!node) continue;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "panel-close";
  b.title = "Guardar el panel";
  b.setAttribute("aria-label", "Guardar el panel");
  b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-chevron" /></svg>';
  b.addEventListener("click", () => closePanel(v));
  node.prepend(b);
}

// La salida de Studio es simétrica a la entrada: los paneles propios se van
// por donde entraron y, cuando terminan, el modo se pliega y la portada viaja
// al centro. `modeAnimating` evita que una segunda pulsación dispare dos
// transiciones a la vez.
let modeAnimating = false;

const MODE_MOVE_MS = 420; // movimiento en pantalla: ease-in-out
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

/// De qué lado entra/sale cada panel propio de Studio.
function studioSide(node) {
  if (node.id === "stage-eq" || node.id === "studio-telemetry") return { axis: "Y", d: -18 };
  if (node.closest && node.closest("#rail")) return { axis: "X", d: 28 };
  return { axis: "X", d: 18 };
}

function sideAnim(node, i, show) {
  if (node._rowAnim) node._rowAnim.cancel();
  const { axis, d } = studioSide(node);
  const shift = REDUCE_MOTION ? "none" : `translate${axis}(${d}px) scale(0.98)`;
  const off = { opacity: 0, transform: shift };
  const on = { opacity: 1, transform: "none" };
  const a = node.animate(show ? [off, on] : [on, off], {
    duration: show ? 260 : 170,
    delay: show ? Math.min(i, 5) * ROW_STAGGER : 0,
    easing: EASE_OUT,
    fill: show ? "backwards" : "forwards",
  });
  node._rowAnim = a;
  a.onfinish = () => { if (show) node._rowAnim = null; };
  return a;
}

/// La portada de «Reproduciendo» es el mismo nodo en los dos modos: se mide
/// antes y después del cambio y se anima la diferencia (FLIP).
function npArt() {
  return document.querySelector("#now-playing .np-art-wrap");
}
function flipNowPlaying(first) {
  const a = npArt();
  if (!a || !first || REDUCE_MOTION) return;
  const last = a.getBoundingClientRect();
  if (!last.width || !first.width) return;
  const dx = first.left - last.left, dy = first.top - last.top, s = first.width / last.width;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01) return;
  a.animate(
    [
      { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${s})` },
      { transformOrigin: "top left", transform: "none" },
    ],
    { duration: MODE_MOVE_MS, easing: EASE_IN_OUT },
  );
}
function studioPanels() {
  return [...studioRows(), $("rail")].filter((n) => n && n.offsetParent !== null);
}

/// Descargas sigue abierta al cambiar de modo (petición del propietario,
/// 2026-11-13): antes, al pasar a Simple, se cerraba. El panel viaja de su
/// sitio viejo al nuevo (FLIP) con un rebote suave.
function flipPanel(node, first) {
  if (!node || !first || REDUCE_MOTION) return;
  const last = node.getBoundingClientRect();
  if (!last.width || !last.height) return;
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const sx = first.width / last.width;
  const sy = first.height / last.height;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
  const spring = getComputedStyle(document.documentElement).getPropertyValue("--ease-spring").trim() || EASE_OUT;
  node.animate(
    [
      { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: "top left", transform: "none" },
    ],
    { duration: 620, easing: spring },
  );
}
const dlPanelRect = () => {
  const n = $("view-downloads");
  if (!n || shell.view !== "downloads") return null;
  const r = n.getBoundingClientRect();
  return r.width && r.height ? r : null;
};

function leaveStudio() {
  modeAnimating = true;
  const rows = studioPanels();
  const anims = rows.map((n, i) => sideAnim(n, i, false));
  const done = anims.length
    ? Promise.all(anims.map((a) => a.finished.catch(() => {})))
    : Promise.resolve();
  done.then(() => {
    // se retira el relleno de la salida y se pliega el modo
    rows.forEach((n) => {
      if (n._rowAnim) {
        n._rowAnim.cancel();
        n._rowAnim = null;
      }
    });
    const first = npArt() && npArt().getBoundingClientRect();
    const dlFirst = dlPanelRect();
    shell.mode = "simple";
    // Descargas se queda abierta; lo demás vuelve al inicio de Simple
    if (shell.view !== "downloads") shell.view = "nowplaying";
    modeAnimating = false;
    applyRailWidth();
    syncShell();
    refreshTelemetry();
    flipNowPlaying(first);
    flipPanel($("view-downloads"), dlFirst);
    animateQueueIn();
  });
}

function setMode(m, opts = {}) {
  if (m === shell.mode || modeAnimating) return;
  const animate = opts.animate !== false;
  // Simple: la cola se muda a la portada; si venimos de Studio, salida animada
  if (m === "simple") {
    if (animate && shell.mode === "studio") return leaveStudio();
    shell.mode = "simple";
    if (shell.view !== "downloads") shell.view = "nowplaying";
    applyRailWidth();
    syncShell();
    refreshTelemetry();
    if (animate) animateQueueIn();
    return;
  }
  // cada modo tiene su inicio: Simple la portada grande, Studio la biblioteca
  const first = npArt() && npArt().getBoundingClientRect();
  const dlFirst = dlPanelRect();
  shell.mode = "studio";
  if (shell.view === "nowplaying") shell.view = "library";
  // Studio necesita una columna derecha donde el ecualizador quepa de verdad
  applyRailWidth();
  syncShell();
  refreshTelemetry();
  // entrada de los paneles de Studio, cada uno desde su lado, y la portada
  // viaja del centro a su columna (se hace ya sincrónica, sin parpadeo)
  if (animate) {
    flipNowPlaying(first);
    studioPanels().forEach((n, i) => sideAnim(n, i, true));
    flipPanel($("view-downloads"), dlFirst);
  }
}

for (const n of document.querySelectorAll(".nav-item")) {
  n.addEventListener("click", () => {
    const k = n.dataset.nav;
    // Petición del propietario (2026-11-12): pulsar otra vez el botón de la
    // vista abierta la cierra. En Simple el panel se guarda y queda
    // «Reproduciendo»; en Studio la biblioteca es la base, así que se pliega
    // el panel de pistas (sustituye a la flecha que había en su cabecera).
    const open = k === "downloads" ? shell.view === "downloads" : shell.view === "library" && shell.libTab === k;
    if (open) {
      if (k === "downloads") {
        if (shell.mode === "simple") closePanel("downloads");
        else backFromDownloads();
      } else if (shell.mode === "simple") {
        closePanel("library");
      } else {
        setLibCollapsed(!libPane.classList.contains("collapsed"));
      }
      return;
    }
    if (k === "nowplaying" || k === "downloads") goView(k);
    else {
      goView("library", k);
      if (libPane.classList.contains("collapsed")) setLibCollapsed(false);
    }
  });
}

$("mode-simple").addEventListener("click", () => setMode("simple"));
$("mode-studio").addEventListener("click", () => setMode("studio"));
// radiogroup: las flechas cambian de modo, como en cualquier control nativo.
// Es un atajo de teclado, así que el cambio es instantáneo (sin animación).
document.querySelector('[role="radiogroup"]').addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  setMode(shell.mode === "simple" ? "studio" : "simple", { animate: false });
  $(`mode-${shell.mode}`).focus();
});

// ---------------------------------------------------------------- barra de título propia
// Todo va dentro de try: este bloque corre al evaluar el módulo, y un error
// aquí (una API de ventana que falte, un permiso sin conceder) abortaría el
// módulo entero — init() incluido — y la app se quedaría muerta.
(function windowControls() {
  try {
    const W = window.__TAURI__ && window.__TAURI__.window;
    if (!W || typeof W.getCurrentWindow !== "function") return; // navegador / dev-mock
    const win = W.getCurrentWindow();
    const maxBtn = $("win-max");
    const maxIcon = maxBtn.querySelector("use");

    $("win-min").addEventListener("click", () => win.minimize());
    maxBtn.addEventListener("click", () => win.toggleMaximize());
    // close() dispara el mismo CloseRequested que la X nativa: misma limpieza
    $("win-close").addEventListener("click", () => win.close());

    let t = 0;
    const syncMax = () => {
      clearTimeout(t);
      // onResized llega decenas de veces mientras se arrastra el borde
      t = setTimeout(async () => {
        try {
          const max = await win.isMaximized();
          maxIcon.setAttribute("href", max ? "#i-win-restore" : "#i-win-max");
          maxBtn.setAttribute("aria-label", max ? "Restaurar" : "Maximizar");
        } catch {}
      }, 120);
    };
    if (typeof win.onResized === "function") win.onResized(syncMax);
    syncMax();
  } catch (e) {
    console.error("controles de ventana no disponibles:", e);
  }
})();

// En modo mini no hay barra de título, así que la barra de controles hace de
// asa. Se arrastra solo tras mover unos píxeles: un clic o el doble clic que
// restaura el modo completo siguen funcionando.
(function miniDrag() {
  const W = window.__TAURI__ && window.__TAURI__.window;
  if (!W || typeof W.getCurrentWindow !== "function") return;
  let arm = null;
  $("controls").addEventListener("mousedown", (e) => {
    if (!document.body.classList.contains("mini") || e.button !== 0) return;
    if (e.target.closest("button, input, select, label, a")) return;
    arm = { x: e.screenX, y: e.screenY };
  });
  window.addEventListener("mousemove", (e) => {
    if (!arm) return;
    if (Math.abs(e.screenX - arm.x) + Math.abs(e.screenY - arm.y) < 5) return;
    arm = null;
    W.getCurrentWindow().startDragging().catch(() => {});
  });
  window.addEventListener("mouseup", () => {
    arm = null;
  });
})();

// ---------------------------------------------------------------- telemetría de Studio
// Solo datos que el motor conoce de verdad. Nada de jitter en picosegundos
// ni THD+N: eso no se puede medir leyendo un archivo.
let lastStatus = null;

function setText(id, v) {
  const n = $(id);
  if (n && n.textContent !== v) n.textContent = v;
}

function updateTelemetry(s) {
  lastStatus = s;
  if (shell.mode !== "studio") return; // no se ve: no se toca el DOM
  if (!s || !s.path) {
    for (const id of ["tm-format", "tm-rate", "tm-bits", "tm-kbps"]) setText(id, "—");
  } else {
    const ext = (s.path.split(/[\\/]/).pop().split(".").pop() || "").toUpperCase();
    setText("tm-format", ext || "—");
    setText("tm-rate", s.sample_rate ? `${(s.sample_rate / 1000).toFixed(1).replace(/\.0$/, "")} kHz` : "—");
    // con pérdida (MP3, AAC) no hay profundidad fija: se muestra "—", no un número inventado
    setText("tm-bits", s.bits_per_sample ? `${s.bits_per_sample} bit` : "—");
    setText("tm-kbps", s.bitrate_kbps ? `${s.bitrate_kbps} kbps` : "—");
  }
  // es el modo aceptado por el motor (la casilla se revierte si falla),
  // no una confirmación del hardware: de ahí el texto del title
  const ex = $("mix-exclusive");
  const dev = el.device && el.device.selectedOptions[0];
  const mode = ex && ex.checked ? "Exclusiva" : "Compartida";
  setText("tm-out", `${mode} · ${dev ? dev.textContent : "Predeterminado"}`);
  const out = $("tm-out");
  if (out) out.title = "Modo de salida configurado y dispositivo elegido";
  fitTelemetry();
}

// Los valores que no caben bajan la fuente hasta caber enteros (ADR #119),
// en vez de cortarse con «…». Por debajo de 10 px dejaría de leerse: ahí,
// y solo ahí, vuelve el recorte con puntos suspensivos.
const TM_MAX_PX = 13.5;
const TM_MIN_PX = 10;
function fitTelemetry() {
  for (const id of ["tm-format", "tm-rate", "tm-bits", "tm-kbps", "tm-out"]) {
    const n = $(id);
    if (!n || !n.clientWidth) continue;
    let px = TM_MAX_PX;
    n.style.fontSize = `${px}px`;
    while (n.scrollWidth > n.clientWidth + 0.5 && px > TM_MIN_PX) {
      px = Math.max(TM_MIN_PX, px - 0.5);
      n.style.fontSize = `${px}px`;
    }
  }
}
if ($("studio-telemetry")) new ResizeObserver(() => fitTelemetry()).observe($("studio-telemetry"));

function refreshTelemetry() {
  updateTelemetry(lastStatus);
}

$("mix-exclusive").addEventListener("change", refreshTelemetry);
el.device.addEventListener("change", refreshTelemetry);

// ---------------------------------------------------------------- arranque
async function init() {
  perfMark("init-inicio");
  try {
    loadShell();
    setView(shell.libTab);
    syncShell();
    buildEqSliders();
    buildParamEq();
    iconSet("btn-prev", "prev");
    iconSet("btn-next", "next");
    iconSet("btn-mixer", "mixer");
    iconSet("btn-play", "play");
    setupDivider();
    setupDragDrop();
    loadModes();
    paintModes();
    perfMark("init-sincrono");

    // Estado del motor (Sprint 1, T6). Antes: get_state cada 250 ms siempre,
    // también sin música y con la ventana escondida. Ahora el ritmo se adapta
    // y los eventos del motor (que nadie escuchaba) despiertan el sondeo al
    // momento. Con la ventana escondida Chromium frena los temporizadores
    // (tras unos minutos, a uno por minuto) y la cola podía no avanzar: los
    // eventos no se frenan, así que «enn://tick» y «enn://ended» la mueven.
    let wasPlaying = false;
    let suppressNext = false;
    let idlePolls = 0;
    let polling = false;
    let pollTimer = 0;
    const pollDelay = () => {
      if (playing) return document.hidden ? 1000 : 250;
      return document.hidden ? 0 : 2000; // 0 = sin sondeo: lo despiertan los eventos
    };
    async function pollLoop() {
      pollTimer = 0;
      if (!polling) {
        polling = true;
        try { await pollStateInline(); } finally { polling = false; }
      }
      const d = pollDelay();
      if (d && !pollTimer) pollTimer = setTimeout(pollLoop, d);
    }
    const pollNow = () => {
      clearTimeout(pollTimer);
      pollTimer = 0;
      pollLoop();
    };
    try {
      const ev = window.__TAURI__.event;
      for (const name of ["enn://status", "enn://ended", "enn://tick"]) ev.listen(name, pollNow);
      // el hilo informador del motor se queda con el error para emitirlo: antes
      // nadie lo escuchaba y el aviso de «dispositivo desconectado» se perdía
      ev.listen("enn://error", (e) => { if (e && e.payload) toast(String(e.payload)); });
    } catch {}
    document.addEventListener("visibilitychange", pollNow);
    pollLoop();

    async function pollStateInline() {
      let s;
      try {
        s = await invoke("get_state");
      } catch (err) {
        el.miniTitle.textContent = "—";
        return;
      }
      if (s.audio_error) toast(s.audio_error);
      engineState = s.state;
      // las carpetas guardadas se leen una sola vez: distinguen «primer uso» de
      // «hay carpetas pero sin audio» en el estado vacío
      if (!foldersRead) {
        foldersRead = true;
        refreshFolders();
      }
      // En reposo la tarjeta no debe mostrar una pista que ya no está en la
      // biblioteca. Se comprueba solo cuando el motor no tiene nada cargado o
      // cuando la biblioteca ya está leída y no la contiene, para no tocar nada
      // mientras la biblioteca aún se está cargando al arrancar.
      const libReady = library.length > 0;
      if (!s.path || (libReady && !library.some((t) => t.path === s.path))) paintRest();
      const nowPlaying = s.state === "playing";
      // dos sondeos seguidos en idle (≥ 250 ms) y sin un playAt en marcha: así
      // el hueco entre una canción y la siguiente no apaga los colores
      idlePolls = s.state === "idle" ? idlePolls + 1 : 0;
      if (idlePolls >= 2 && !playPending) applyIdle();
      if (nowPlaying !== wasPlaying) {
        if (wasPlaying && s.state === "idle" && !suppressNext) onEnded();
        suppressNext = false;
        wasPlaying = nowPlaying;
      }
      if (nowPlaying) recoTick(s);
      if (nowPlaying || s.state === "paused") {
        try {
          applyStatus(s);
        } catch {
          el.miniTitle.textContent = "—";
        }
      }
      // crossfade (C3): ceba la siguiente pista cuando entra en la ventana del fade
      if (
        nowPlaying &&
        s.dur &&
        ui.fade_secs > 0 &&
        repeatMode !== 2 &&
        curIdx >= 0 &&
        curIdx + 1 < session.length &&
        session[curIdx].path === s.path
      ) {
        const remaining = s.dur - (s.pos || 0);
        const nxt = session[curIdx + 1];
        if (nxt && nxt.path && remaining <= ui.fade_secs + 0.4 && remaining > 0.3 && primedFor !== s.path) {
          primedFor = s.path;
          const manual = gainByPath.get(nxt.path) ?? 0;
          invoke("prime_file", { path: nxt.path, dur: nxt.dur ?? null, gainDb: manual + rgGainFor(nxt) })
            .catch(() => { primedFor = null; });
        }
      }
      // el motor promovió la pista cebada: la cola avanza sola (sin onEnded)
      if (
        s.path &&
        curIdx >= 0 &&
        curIdx + 1 < session.length &&
        session[curIdx].path !== s.path &&
        session[curIdx + 1].path === s.path
      ) {
        curIdx += 1;
        primedFor = null;
        saveQueue();
        renderQueue();
        markPlayingRow();
        followTrackVolume();
        ensureLoudness(session[curIdx]);
      }
    }

    el.clear.addEventListener("click", () => {
      session = [];
      curIdx = -1;
      suppressNext = true;
      invoke("stop").catch(() => {});
      playing = false;
      updatePlayBtn();
      saveQueue();
      renderQueue();
      markPlayingRow();
    });

    try {
      const s = await invoke("settings_get");
      ui = {
        volume: s.volume ?? 0.8,
        balance: s.balance ?? 0,
        bands: s.bands || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        bass: s.bass ?? 0,
        treble: s.treble ?? 0,
        fade_secs: s.fade_secs ?? 0,
        rg_norm: s.rg_norm ?? true,
        rg_album: s.rg_album ?? false,
        param_eq: Array.isArray(s.param_eq) ? s.param_eq : [],
        exclusive: s.exclusive ?? false,
        dl_parallel: s.dl_parallel ?? 0,
        dl_rate_kib: s.dl_rate_kib ?? 0,
        enrich_online: s.enrich_online ?? true,
        lastfm_key: s.lastfm_key ?? "",
      };
      if ($("set-enrich")) $("set-enrich").checked = ui.enrich_online;
      if ($("set-lastfm")) $("set-lastfm").value = ui.lastfm_key;
      if ($("set-dl-parallel")) $("set-dl-parallel").value = String(ui.dl_parallel);
      if ($("set-dl-rate")) $("set-dl-rate").value = String(ui.dl_rate_kib);
      lastSavedBands = ui.bands.slice();
      el.volume.value = String(Math.round(ui.volume * 100));
      el.volNum.textContent = String(Math.round(ui.volume * 100));
      const rgBox = document.getElementById("mix-rg");
      if (rgBox) rgBox.checked = ui.rg_norm;
      const rgAlbumBox = document.getElementById("mix-rg-album");
      if (rgAlbumBox) rgAlbumBox.checked = ui.rg_album;
      const exBox = document.getElementById("mix-exclusive");
      if (exBox) exBox.checked = ui.exclusive;
      paintMixerFromState();
      applyStatus(await invoke("get_state"));
      perfMark("ajustes");
    } catch {}

    // «Siguientes» empieza vacía: se llena con lo que elija el usuario
    // (petición del propietario, 2026-11-12). Antes se recuperaba la sesión
    // anterior entera —con lo ya escuchado— y salía como «siguientes».
    session = [];
    curIdx = -1;
    try { localStorage.removeItem("enn.queue"); } catch {}

    // La lista de salidas de audio tarda ~0,5 s en un arranque en frío (WASAPI
    // despertando) y solo hace falta en Ajustes y en el menú del altavoz: se
    // pide en segundo plano y la biblioteca no la espera (Sprint 1, T4/T5).
    refreshDevices().then(() => perfMark("dispositivos"));
    await reloadLibrary();
    perfMark("biblioteca-pintada");
    renderQueue();
    autoRgScan();
  } catch (e) {
    // si el arranque falla, al menos se ve en pantalla con estilo sutil
    const d = document.getElementById("mini-title");
    if (d) d.textContent = "· inicio";
  }
  requestAnimationFrame(() => perfMark("interactivo"));
  idleProbe(); // solo hace algo con --bench-idle
  perfReport().then((r) => { if (r && r.play_mode) playSmoke(); }); // solo con --bench-play
}

/// Prueba de reproducción con el motor real (`--bench-play`, Sprint 1). Pone
/// dos canciones a volumen 0 y comprueba que la primera arranca, que avanza,
/// cuánto tardan pausa y reanudación, y que al terminar la primera empieza
/// sola la segunda (el camino de los eventos del motor). Deja el resultado en
/// el informe y cierra la app. No toca la cola guardada ni el volumen guardado.
async function playSmoke() {
  const out = { ok: false, pasos: {} };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (fn()) return Math.round(performance.now() - t0);
      await wait(20);
    }
    return -1;
  };
  try {
    await until(() => library.length > 0, 8000);
    const cand = library.filter((x) => x.path && x.dur && x.dur >= 20).sort((a, b) => a.dur - b.dur);
    if (cand.length < 2) throw new Error("hacen falta 2 canciones de 20 s o más");
    const [a, b] = cand;
    await invoke("set_volume", { volume: 0 });
    session = [a, b];
    curIdx = -1;
    const t0 = performance.now();
    playAt(0);
    out.pasos.arranque_ms = await until(() => engineState === "playing" && currentPath === a.path, 8000);
    out.pasos.primera_reproduccion_ms = Math.round(performance.now() - t0);
    const p0 = pos;
    await wait(1500);
    out.pasos.avance_s = Math.round((pos - p0) * 100) / 100;
    invoke("toggle_pause");
    out.pasos.pausa_ms = await until(() => engineState === "paused", 3000);
    invoke("toggle_pause");
    out.pasos.reanudar_ms = await until(() => engineState === "playing", 3000);
    await invoke("seek_to", { seconds: Math.max(0, a.dur - 1.5) });
    out.pasos.siguiente_sola_ms = await until(() => currentPath === b.path && engineState === "playing", 8000);
    out.ok =
      out.pasos.arranque_ms >= 0 && out.pasos.avance_s > 0.8 && out.pasos.pausa_ms >= 0 &&
      out.pasos.reanudar_ms >= 0 && out.pasos.siguiente_sola_ms >= 0;
    out.audio = (await perfReport() || {}).audio;
    // carga: todos los hilos de fondo analizando mientras suena la segunda
    const lateBefore = out.audio ? out.audio.late : 0;
    const p1 = pos;
    const stressT0 = performance.now();
    out.carga = { analisis: await invoke("perf_stress", { seconds: 8 }) };
    out.carga.segundos = Math.round((performance.now() - stressT0) / 100) / 10;
    out.carga.avance_s = Math.round((pos - p1) * 100) / 100;
    const a2 = (await perfReport() || {}).audio || {};
    out.carga.audio = a2;
    out.carga.cortes = (a2.late || 0) - lateBefore;
    out.ok = out.ok && out.carga.cortes === 0;
    await invoke("stop");
  } catch (e) {
    out.error = String(e && e.message || e);
  }
  try { await invoke("perf_note", { key: "reproduccion", value: out }); } catch {}
  perfMark("reproduccion-medida");
}

// ---------------------------------------------------------------- ventana de Ajustes
// Un <dialog> modal: el foco queda dentro, Esc la cierra y el fondo se
// difumina. Entra con una escala leve desde el centro (es un modal, no un
// popover: no sale de su botón) y sale más rápido de lo que entra.
(function settingsDialog() {
  const dlg = $("settings-dlg");
  const openBtn = $("btn-settings");
  const closeBtn = $("settings-close");
  if (!dlg || !openBtn) return;
  const show = () => {
    if (dlg.open) return;
    refreshDlTarget(); // la carpeta de descargas vive aquí ahora (ADR #103)
    dlg.showModal();
    if (!REDUCE_MOTION) {
      dlg.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: EASE_OUT });
    }
  };
  const hide = () => {
    if (!dlg.open || dlg._closing) return;
    if (REDUCE_MOTION) { dlg.close(); return; }
    dlg._closing = true;
    const a = dlg.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.97)" }], { duration: 150, easing: EASE_OUT, fill: "forwards" });
    a.onfinish = () => { dlg.close(); a.cancel(); dlg._closing = false; };
  };
  openBtn.addEventListener("click", show);
  if (closeBtn) closeBtn.addEventListener("click", hide);
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); hide(); });
  // clic en el fondo difuminado (fuera de la ventana) la cierra
  dlg.addEventListener("pointerdown", (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (out) hide();
  });

  // Interfaz → «Al abrir»
  const sm = $("set-start-mode");
  if (sm) {
    try { sm.value = localStorage.getItem("enn.startMode") || "last"; } catch {}
    sm.addEventListener("change", () => {
      try {
        if (sm.value === "last") localStorage.removeItem("enn.startMode");
        else localStorage.setItem("enn.startMode", sm.value);
      } catch {}
    });
  }
  // Interfaz → «Reproduciendo»
  const nv = $("set-npview");
  if (nv) {
    nv.value = npView;
    nv.addEventListener("change", () => {
      npView = nv.value === "classic" ? "classic" : "stage";
      try { localStorage.setItem("enn.npView", npView); } catch {}
      applyNpView();
    });
  }
  applyNpView();
  // Interfaz → «Abrir con Windows» (Sprint 1, T4; apagado por defecto).
  // El estado real vive en Windows: se consulta al abrir Ajustes.
  const sa = $("set-autostart");
  if (sa) {
    const syncAutostart = () =>
      invoke("plugin:autostart|is_enabled").then((on) => { sa.checked = !!on; }).catch(() => { sa.disabled = true; });
    openBtn.addEventListener("click", syncAutostart);
    sa.addEventListener("change", async () => {
      try {
        await invoke(sa.checked ? "plugin:autostart|enable" : "plugin:autostart|disable");
        toast(sa.checked ? "Enn se abrirá con Windows, en la bandeja" : "Enn ya no se abre con Windows");
      } catch (e) {
        sa.checked = !sa.checked;
        toast(`No se pudo cambiar: ${e}`);
      }
    });
  }
  // Interfaz → «Inactividad»
  const si = $("set-idle");
  if (si) {
    si.value = String(IDLE_MS);
    si.addEventListener("change", () => {
      IDLE_MS = Number(si.value);
      try { localStorage.setItem("enn.idleMs", String(IDLE_MS)); } catch {}
      armIdle();
    });
  }
})();

// ---------------------------------------------------------------- recomendaciones (Sprint 3, T7)
const recoGate = createRecoGate();
try { recoGate.setDisabled(localStorage.getItem("enn.recoOff") === "1"); } catch {}
function recoReset(path) {
  recoFor = { path, data: null, asked: false };
  // lo propuesto era para la canción anterior
  if (recoCardRef && recoCardRef.open) recoCardRef.hide();
}
const recoCard = mountRecoCard({
  onPlayNext: (t) => playNext(t),
  onPlayNow: (t) => playNowKeepingQueue(t),
  onAddAll: (list) => {
    for (const t of [...list].reverse()) playNext(t);
    toast(list.length > 1 ? `${list.length} canciones a continuación` : "A continuación");
  },
  onDismiss: () => recoGate.dismissed(),
  onAccept: () => recoGate.accepted(),
  onNever: () => {
    recoGate.setDisabled(true);
    try { localStorage.setItem("enn.recoOff", "1"); } catch {}
    const box = $("set-reco");
    if (box) box.checked = false;
    toast("No se volverá a mostrar · puedes activarlo en Ajustes → Recomendaciones");
  },
  artUrl: (path) => invoke("album_art", { path }),
});
recoCardRef = recoCard;
/// En cada sondeo sonando: ¿toca proponer qué poner después?
async function recoTick(s) {
  try { await recoStep(s); } catch {}
}
async function recoStep(s) {
  if (!recoFor || recoFor.path !== s.path || recoCard.open || recoFor.done) return;
  // no sale en modo mini (ventana de 430×90), con un diálogo o menú abierto, ni en vista previa
  const blocked = previewOn || document.body.classList.contains("mini") || !!document.querySelector("dialog[open]") || !$("ctx").classList.contains("hidden");
  if (!recoFor.data) {
    if (recoFor.asked || (s.pos || 0) < 6) return;
    recoFor.asked = true;
    const upcoming = session.slice(curIdx + 1).filter((t) => !t.radio).map((t) => t.path);
    try {
      recoFor.data = await invoke("reco_for", { path: s.path, exclude: upcoming });
    } catch { recoFor.done = true; }
    return;
  }
  const d = recoFor.data;
  const v = recoGate.decide({
    key: s.path,
    plays: d.plays || 0,
    repeatCycles,
    posS: s.pos || 0,
    durS: s.dur || 0,
    blocked,
    idle: document.body.dataset.idle === "1",
  });
  if (v === "wait") return;
  recoFor.done = true;
  if (v !== "show") return;
  const items = (d.items || [])
    .map((it) => ({ track: library.find((t) => t.path === it.path), reason: it.reason }))
    .filter((it) => it.track && !isUpcoming(it.track.path));
  if (!items.length) return;
  const bar = $("controls");
  // sobre la barra cuando está abajo (Studio); en Simple los controles van
  // en el centro y la tarjeta se queda en la esquina
  const r = bar && bar.getBoundingClientRect();
  const atBottom = r && r.height && window.innerHeight - r.bottom < 40;
  document.documentElement.style.setProperty("--reco-bottom", `${atBottom ? Math.round(window.innerHeight - r.top + 12) : 16}px`);
  recoCard.show(d.kind, items.slice(0, 3));
}

// ---------------------------------------------------------------- afinador de la radio (Sprint 3)
// Clic derecho en el botón de radio: variedad de artistas, selección y coherencia.
(function radioTuner() {
  const rb = $("btn-radio");
  if (!rb) return;
  let tune = { variety: 1, selection: 0, coherence: 0 };
  try { tune = { ...tune, ...JSON.parse(localStorage.getItem("enn.radioTuner") || "{}") }; } catch {}
  const send = () => invoke("radio_tuner_set", tune).catch(() => {});
  send();
  const pop = document.createElement("div");
  pop.className = "radio-tuner";
  pop.hidden = true;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Afinar la radio");
  const rows = [
    ["variety", "Variedad de artistas", [[0, "Baja"], [1, "Media"], [2, "Alta"]]],
    ["selection", "Selección", [[-1, "Familiar"], [0, "Mezcla"], [1, "Descubrir"]]],
    ["coherence", "Coherencia", [[-1, "Estricta"], [0, "Media"], [1, "Aventurera"]]],
  ];
  const paint = () => {
    for (const b of pop.querySelectorAll("button[data-k]")) b.setAttribute("aria-pressed", String(tune[b.dataset.k] === Number(b.dataset.v)));
  };
  for (const [k, label, opts] of rows) {
    const row = document.createElement("div");
    row.className = "rt-row";
    const l = document.createElement("span");
    l.className = "rt-label";
    l.textContent = label;
    const g = document.createElement("div");
    g.className = "lib-pill rt-pill";
    for (const [v, t] of opts) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.k = k;
      b.dataset.v = String(v);
      b.textContent = t;
      b.addEventListener("click", () => {
        tune[k] = v;
        try { localStorage.setItem("enn.radioTuner", JSON.stringify(tune)); } catch {}
        send();
        paint();
      });
      g.appendChild(b);
    }
    row.append(l, g);
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  const close = () => { pop.hidden = true; };
  rb.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    paint();
    pop.hidden = false;
    const r = rb.getBoundingClientRect();
    const w = pop.offsetWidth || 260;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    // encima del botón si cabe; si no, debajo
    const above = r.top - pop.offsetHeight - 10;
    pop.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 10)}px`;
  });
  document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== rb) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) close(); });
})();

// el historial viejo (localStorage) pasa una sola vez al almacén de escuchas
(function migrateHistory() {
  try {
    if (localStorage.getItem("enn.insightsMigrated") === "1" || !history.length) return;
    invoke("insights_migrate", { entries: history.map((h) => [h.path, h.ts || 0]) })
      .then(() => { try { localStorage.setItem("enn.insightsMigrated", "1"); } catch {} })
      .catch(() => {});
  } catch {}
})();

// ---------------------------------------------------------------- Ajustes → Recomendaciones (Sprint 3)
// «Enriquecer con datos en línea» (encendido de fábrica), clave de Last.fm
// (opcional) y cuántas pistas tienen ya etiquetas reales.
(function recoSettings() {
  const online = $("set-enrich");
  const key = $("set-lastfm");
  const stat = $("enrich-status");
  const now = $("btn-enrich-now");
  const reco = $("set-reco");
  if (reco) {
    try { reco.checked = localStorage.getItem("enn.recoOff") !== "1"; } catch {}
    reco.addEventListener("change", () => {
      recoGate.setDisabled(!reco.checked);
      try { localStorage.setItem("enn.recoOff", reco.checked ? "0" : "1"); } catch {}
    });
  }
  if (online) online.addEventListener("change", () => { ui.enrich_online = online.checked; persistSettings(); });
  if (key) key.addEventListener("change", () => { ui.lastfm_key = key.value.trim(); persistSettings(); });
  const paint = async () => {
    if (!stat) return;
    try {
      const s = await invoke("enrich_status");
      stat.textContent = s.running ? `Buscando etiquetas… (${s.tagged} de ${s.total})` : `${s.tagged} de ${s.total} pistas con etiquetas reales`;
    } catch (e) { stat.textContent = String(e); }
  };
  $("btn-settings")?.addEventListener("click", paint);
  if (now) now.addEventListener("click", () => { invoke("enrich_now").catch(() => {}); setTimeout(paint, 300); });
  const ev = window.__TAURI__ && window.__TAURI__.event;
  if (ev) {
    ev.listen("enrich://progress", (e) => { if (stat && e.payload) stat.textContent = `Buscando etiquetas… (${e.payload.done} de ${e.payload.total})`; });
    ev.listen("enrich://done", () => paint());
  }
})();

// ---------------------------------------------------------------- Ajustes → Descargas (Sprint 2)
// «A la vez» (Auto = 3, 1–6), «Velocidad» (sin límite por defecto) y el
// descargador (yt-dlp), que se actualiza solo una vez por semana.
(function downloadSettings() {
  const par = $("set-dl-parallel");
  const rate = $("set-dl-rate");
  if (par) par.addEventListener("change", () => { ui.dl_parallel = Number(par.value) || 0; persistSettings(); });
  if (rate) rate.addEventListener("change", () => { ui.dl_rate_kib = Number(rate.value) || 0; persistSettings(); });
  const ver = $("dl-tool-ver");
  const upd = $("btn-dl-tool");
  if (!ver || !upd) return;
  const paint = async () => {
    try {
      const st = await invoke("tools_status");
      const when = st.last_check ? new Date(st.last_check * 1000).toLocaleDateString() : "nunca";
      ver.textContent = st.updating ? "Actualizando…" : `yt-dlp ${st.version || "?"} · revisado: ${when}`;
    } catch (e) { ver.textContent = String(e); }
  };
  $("btn-settings")?.addEventListener("click", paint);
  upd.addEventListener("click", async () => {
    upd.disabled = true;
    ver.textContent = "Buscando versión nueva…";
    try {
      const v = await invoke("tools_update");
      toast(v ? `Descargador actualizado (yt-dlp ${v})` : "El descargador ya está al día");
    } catch (e) {
      toast(`No se pudo actualizar: ${e}`);
    }
    upd.disabled = false;
    paint();
  });
})();

// ---------------------------------------------------------------- formato de descarga (ADR #159)
// Selector sobre la barra de búsqueda de Descargas. Una sola fuente de verdad:
// el <select id="dl-fmt"> de Ajustes (lo leen el buscador y las descargas por
// enlace); la pastilla y la lista se mantienen iguales. Antes el formato no se
// recordaba: cada arranque volvía a M4A. Ahora se guarda en `enn.dlFmt`.
(function downloadFormat() {
  const sel = $("dl-fmt");
  const pick = $("dl-fmt-pick");
  if (!sel || !pick) return;
  const FMTS = ["m4a", "mp3", "flac"];
  const paint = () => {
    for (const b of pick.querySelectorAll("button[data-fmt]")) {
      const on = b.dataset.fmt === sel.value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  };
  const set = (f, focus) => {
    if (!FMTS.includes(f)) return;
    if (sel.value !== f) {
      sel.value = f;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    try { localStorage.setItem("enn.dlFmt", f); } catch {}
    paint();
    if (focus) pick.querySelector(`[data-fmt="${f}"]`)?.focus();
  };
  try {
    const saved = localStorage.getItem("enn.dlFmt");
    if (FMTS.includes(saved)) sel.value = saved;
  } catch {}
  pick.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fmt]");
    if (b) set(b.dataset.fmt);
  });
  // radiogroup: flechas izquierda/derecha
  pick.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = FMTS.indexOf(sel.value);
    set(FMTS[(i + (e.key === "ArrowRight" ? 1 : FMTS.length - 1)) % FMTS.length], true);
  });
  // si se cambia desde Ajustes, la pastilla lo refleja (y se recuerda)
  sel.addEventListener("change", () => {
    try { localStorage.setItem("enn.dlFmt", sel.value); } catch {}
    paint();
  });
  paint();
})();

init();


// ---- diagnóstico final: timers vivos? ----






