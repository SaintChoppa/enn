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
  shuffle: $("btn-shuffle"), repeat: $("btn-repeat"), mixer: $("mixer"), btnMixer: $("btn-mixer"),
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
  shuffle:
    '<svg viewBox="0 0 24 24"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>',
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
let shuffleOn = false;
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
};

/// Ganancia ReplayGain 2.0 de una pista: por pista, o por álbum (media de
/// sonoridad de todas las pistas analizadas del mismo artista+álbum).
function rgGainFor(track) {
  if (!ui.rg_norm || typeof track.rg !== "number") return 0;
  let lufs = track.rg;
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
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 2600);
}

// ---------------------------------------------------------------- persistencia ligera
function saveQueue() {
  try { localStorage.setItem("enn.queue", JSON.stringify(session)); } catch {}
}
function saveModes() {
  try { localStorage.setItem("enn.modes", JSON.stringify({ r: repeatMode, s: shuffleOn })); } catch {}
}
function loadModes() {
  try {
    const m = JSON.parse(localStorage.getItem("enn.modes") || "null");
    if (m) { repeatMode = m.r ?? 0; shuffleOn = !!m.s; }
  } catch {}
}
function queueLabel() {
  const n = Math.max(0, session.length - curIdx - 1);
  return n > 0 ? `Siguientes (${n})` : "Siguientes";
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

function renderHistory() {
  const frag = document.createDocumentFragment();
  const ul = document.createElement("ul");
  ul.className = "track-list";
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
  frag.appendChild(ul);
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
  return [{ name: "Más reproducidas", tracks: mostPlayed.map((x) => x.t) }];
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
let dragFrom = -1;

function isBelowEvent(e, li) {
  const r = li.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
}

function clearDropMarks() {
  for (const li of el.queue.querySelectorAll("li")) {
    li.classList.remove("drop-target", "drop-below");
  }
}

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

function renderQueue() {
  el.queue.innerHTML = "";
  const upcoming = session.slice(curIdx + 1);
  upcoming.forEach((t, i) => {
    const idx = curIdx + 1 + i;
    const li = rowEl(t, { idx, removable: true });
    li.addEventListener("click", () => playAt(idx));
    li.draggable = true;
    li.addEventListener("dragstart", (e) => {
      dragFrom = idx;
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      clearDropMarks();
      dragFrom = -1;
    });
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const below = isBelowEvent(e, li);
      li.classList.toggle("drop-target", !below);
      li.classList.toggle("drop-below", below);
    });
    li.addEventListener("dragleave", () => {
      li.classList.remove("drop-target", "drop-below");
    });
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const below = isBelowEvent(e, li);
      moveQueueItem(dragFrom, idx + (below ? 1 : 0));
      clearDropMarks();
    });
    el.queue.appendChild(li);
  });
  el.queueTitle.textContent = queueLabel();
  el.queueHint.style.display = session.length ? "none" : "";
}

async function playAt(i, gainDb) {
  if (i < 0 || i >= session.length) return;
  curIdx = i;
  renderQueue();
  const track = session[i];
  if (!track || typeof track.path !== "string" || !track.path) {
    try {
      await invoke("dbg_log", { msg: `playAt(${i}) ruta inválida: ${JSON.stringify(track)}` });
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
    await invoke("play_file", { path: track.path, dur: track.dur ?? null });
    recordHistory(track);
    // ganancia total = ajuste manual por pista + normalización ReplayGain 2.0
    const manual = gainDb ?? gainByPath.get(track.path) ?? 0;
    const g = manual + rgGainFor(track);
    if (g !== 0) await invoke("set_current_gain", { gain_db: g }).catch(() => {});
    playing = true;
    updatePlayBtn();
    markPlayingRow();
  } catch (e) {
    try {
      await invoke("dbg_log", {
        msg: `playAt(${i}) tipo=${typeof track.path} valor=${JSON.stringify(track.path)} error=${e}`,
      });
    } catch {}
    toast(`No se pudo reproducir: ${e}`);
    removeAt(i);
  }
}

function markPlayingRow() {
  const p = curIdx >= 0 && curIdx < session.length ? session[curIdx].path : null;
  currentPath = p;
  syncTrackGainUI();
  for (const li of el.libList.querySelectorAll("li")) {
    const on = p !== null && li.dataset.path === p;
    li.classList.toggle("current", on);
    const art = li.querySelector(".art");
    if (art) art.classList.toggle("on", on);
  }
  if (!p) {
    document.title = "Enn";
    hideMiniArt();
    return;
  }
}

function pushTracks(list, { playNow = false, quiet = false } = {}) {
  if (!list || !list.length) return 0;
  let added = 0;
  for (const t of list) {
    if (!t || !t.path) continue;
    if (session.some((s) => s.path === t.path)) continue;
    session.push(t);
    added++;
  }
  saveQueue();
  renderQueue();
  // autoplay solo cuando el usuario acción explícita o la cola estaba vacía
  const shouldPlay = !quiet && (playNow || (curIdx < 0 && !playing) || session.length === added);
  if (added && shouldPlay) {
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
  const known = findInQueue(path);
  if (known >= 0) {
    playAt(known);
    return;
  }
  const probed = await invoke("probe_paths", { paths: [path] });
  if (probed.tracks && probed.tracks.length) {
    session.push(probed.tracks[0]);
    saveQueue();
    renderQueue();
    await playAt(session.length - 1);
  }
}

/// Inserta una pista justo después de la que suena (reproducir a continuación).
function playNext(track) {
  if (!track || !track.path) return;
  const at = findInQueue(track.path);
  if (at === curIdx + 1) return toast("Ya es la siguiente");
  if (at >= 0) {
    const [item] = session.splice(at, 1);
    if (at < curIdx) curIdx--;
    // punto de inserción tras ajustar el índice por la eliminación
    session.splice(curIdx + 1, 0, item);
  } else {
    session.splice(curIdx + 1, 0, track);
  }
  saveQueue();
  renderQueue();
  toast(`A continuación: ${track.artist ? track.artist + " — " : ""}${track.title}`);
}

async function enqueuePath(path) {
  if (findInQueue(path) >= 0) {
    toast("Ya está en la cola");
    return;
  }
  const probed = await invoke("probe_paths", { paths: [path] });
  if (probed.tracks && probed.tracks.length) {
    pushTracks(probed.tracks, { quiet: true });
    toast("Agregada a la cola");
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
  if (session.length === 0) return;
  if (repeatMode === 2 && curIdx >= 0) {
    playAt(curIdx);
    return;
  }
  if (shuffleOn && session.length > 1) {
    let i;
    do { i = Math.floor(Math.random() * session.length); } while (i === curIdx && session.length > 1);
    playAt(i);
    return;
  }
  const next = curIdx + 1;
  if (next < session.length) {
    playAt(next);
  } else if (repeatMode === 1) {
    playAt(0);
  } else if (radioOn) {
    radioNext();
  }
  // sin repetición ni radio y fin de la cola: Enn se detiene aquí
}

/// Modo radio: al agotarse la cola sugiere una pista parecida de la biblioteca
/// (primero del mismo artista o álbum; si no, cualquier otra no escuchada aún).
function radioNext() {
  const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
  const inQueue = new Set(session.map((s) => s.path));
  let pool = library.filter((t) => !inQueue.has(t.path));
  if (!pool.length) pool = library;
  if (!pool.length) return toast("No hay música en la biblioteca para el modo radio");
  let pick;
  if (cur) {
    pick = pool.find((t) => t.artist && t.artist === cur.artist)
      || pool.find((t) => t.album && t.album === cur.album);
  }
  pick = pick || pool[Math.floor(Math.random() * pool.length)];
  session.push(pick);
  saveQueue();
  renderQueue();
  playAt(session.length - 1);
  toast(`Radio: ${pick.artist ? pick.artist + " — " : ""}${pick.title}`);
}

async function nextManual() {
  if (!session.length) return;
  if (shuffleOn && session.length > 1) {
    let i;
    do { i = Math.floor(Math.random() * session.length); } while (i === curIdx);
    playAt(i);
    return;
  }
  playAt((curIdx + 1 + session.length) % session.length);
}

function prevManual() {
  if (!session.length) return;
  if (curIdx >= 0 && pos > 3) {
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
      await invoke("dbg_log", { msg: `playFromLibrary(${idx}) sin path: ${JSON.stringify(t)}` });
    } catch {}
    toast("Esa entrada no tiene ruta");
    return;
  }
  const known = session.findIndex((s) => s.path === t.path);
  if (known >= 0) {
    playAt(known);
  } else {
    session.push(t);
    saveQueue();
    renderQueue();
    playAt(session.length - 1);
  }
}

el.queue.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (li && !e.target.classList.contains("x")) playAt(Number(li.dataset.idx));
});

el.play.addEventListener("click", () => invoke("toggle_pause"));
$("btn-next").addEventListener("click", nextManual);
$("btn-prev").addEventListener("click", prevManual);

el.shuffle.addEventListener("click", () => {
  shuffleOn = !shuffleOn;
  paintModes();
  saveModes();
});
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
    radioOn = !radioOn;
    radioBtn.classList.toggle("active", radioOn);
    try { localStorage.setItem("enn.radio", radioOn ? "1" : "0"); } catch {}
    toast(radioOn ? "Modo radio activado" : "Modo radio desactivado");
  });
}

function paintModes() {
  el.shuffle.classList.toggle("active", shuffleOn);
  el.shuffle.title = `Aleatorio: ${shuffleOn ? "on" : "off"}`;
  iconSetMode("btn-shuffle", "shuffle", shuffleOn ? "on" : "off");
  el.repeat.classList.toggle("active", repeatMode !== 0);
  el.repeat.title = `Repetición: ${["off", "todo", "una"][repeatMode]}`;
  iconSetMode("btn-repeat", "repeat", ["off", "all", "1"][repeatMode]);
}

// ---------------------------------------------------------------- biblioteca
function libCountText() {
  return `${library.length} canciones`;
}

let view = "all"; // all | artist | albums | playlist | activity
let openGroups = new Set();
let expandedPl = null;
let openAlbum = null; // clave "artista\u0000álbum" expandida en la rejilla
let openSmart = new Set(); // listas inteligentes expandidas

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
  if (i === null || i === undefined) {
    li.addEventListener("click", () => playPathNow(track.path));
  } else {
    li.addEventListener("click", () => playFromLibrary(i));
  }
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
  el.libEmpty.classList.toggle("hidden", library.length > 0);
  el.libMeta.textContent = filtered.length !== library.length
    ? `${filtered.length} de ${library.length} canciones`
    : libCountText();
  markPlayingRow();
}

function renderLib() {
  el.libList.innerHTML = "";
  if (view === "artist") {
    renderByArtist();
  } else if (view === "albums") {
    renderAlbums();
  } else if (view === "playlist") {
    renderPlaylists();
  } else if (view === "activity") {
    renderSmart();
    renderHistory();
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

function renderFlat() {
  const n = Math.min(libWinEnd, filtered.length);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    frag.appendChild(makeLibRow(library[filtered[i]], i));
  }
  el.libList.appendChild(frag);
}

// ---- vista "Por artista": grupos expandibles con acordeón
function renderByArtist() {
  const groups = new Map();
  for (const i of filtered) {
    const t = library[i];
    const key = (t.artist || "").trim() || "Sin artista";
    if (!groups.has(key)) groups.set(key, new Map());
    groups.get(key).set(i, t);
  }
  const keys = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, "es"));
  const frag = document.createDocumentFragment();
  for (const key of keys) {
    const songs = groups.get(key);
    const head = document.createElement("div");
    head.className = "group-head" + (openGroups.has(key) ? " open" : "");
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
      const nowOpen = openGroups.has(key);
      if (nowOpen) openGroups.delete(key);
      else openGroups.add(key);
      head.classList.toggle("open", !nowOpen);
      const body = head.nextSibling;
      if (body && body.classList) body.classList.toggle("open", !nowOpen);
    });
    const body = document.createElement("div");
    body.className = "group-body" + (openGroups.has(key) ? " open" : "");
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

// ---- vista "Playlist"
async function renderPlaylists() {
  let plDir = "";
  try {
    plDir = await invoke("playlist_dir");
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
            playAt(known);
          } else {
            session.push(t);
            saveQueue();
            renderQueue();
            playAt(session.length - 1);
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
  // búsqueda avanzada: artista:…, album:…, formato:… (prefijos) + texto libre
  const filters = [];
  const free = [];
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^(artista|álbum|album|formato|ext):(.*)$/i);
    if (m) {
      const key = m[1].normalize("NFD").replace(/\p{Diacritic}/gu, "");
      filters.push([key, m[2].toLowerCase()]);
    } else {
      free.push(tok);
    }
  }
  const freeQ = free.join(" ");
  filtered = library
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (freeQ && !`${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(freeQ)) {
        return false;
      }
      for (const [key, val] of filters) {
        if (!val) continue;
        if (key === "artista" && !(t.artist || "").toLowerCase().includes(val)) return false;
        if (key === "album" && !(t.album || "").toLowerCase().includes(val)) return false;
        if (key === "formato" || key === "ext") {
          const ext = (t.path.split(".").pop() || "").toLowerCase();
          if (ext !== val) return false;
        }
      }
      return true;
    })
    .map((x) => x.i);
  libWinEnd = 500;
  renderLib();
});

el.libList.addEventListener("scroll", () => {
  if (view !== "all") return;
  if (
    libWinEnd < filtered.length &&
    el.libList.scrollTop + el.libList.clientHeight >= el.libList.scrollHeight - 400
  ) {
    const before = libWinEnd;
    libWinEnd = Math.min(filtered.length, libWinEnd + 300);
    const frag = document.createDocumentFragment();
    for (let i = before; i < libWinEnd; i++) {
      frag.appendChild(makeLibRow(library[filtered[i]], i));
    }
    el.libList.appendChild(frag);
    markPlayingRow();
  }
});

// ---- pestañas de vista
function setView(v) {
  view = v;
  for (const id of ["tab-all", "tab-artist", "tab-albums", "tab-playlist", "tab-activity"]) {
    document.getElementById(id).classList.toggle("active", id === `tab-${v}`);
  }
  const bar = document.getElementById("pl-bar");
  if (bar) bar.classList.toggle("hidden", v !== "playlist");
  if (v === "playlist") expandedPl = null;
  if (v !== "albums") openAlbum = null;
  renderLib();
}
document.getElementById("tab-all").addEventListener("click", () => setView("all"));
document.getElementById("tab-artist").addEventListener("click", () => setView("artist"));
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
async function reloadLibrary() {
  try {
    library = await invoke("lib_list");
  } catch (e) {
    library = [];
  }
  filtered = library.map((_, i) => i);
  libWinEnd = 500;
  renderLib();
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

async function addFolder() {
  const dir = await dialogOpen({ directory: true });
  if (!dir) return;
  try {
    const r = await invoke("lib_add", { folder: dir });
    if (r.added > 0) {
      toast(`${r.added} canciones indexadas${r.failed ? ` (${r.failed} no leídas)` : ""}`);
    } else if (r.failed > 0) {
      toast(`No se pudo leer ningún audio ahí: ${r.first_error || "?"}`);
    } else {
      toast("La carpeta no tenía audio nuevo (o ya estaba indexada)");
    }
    await reloadLibrary();
  } catch (e) {
    toast(`Error al indexar: ${e}`);
  }
}

$("btn-folder").addEventListener("click", addFolder);
$("btn-files").addEventListener("click", openFiles);
$("btn-rescan").addEventListener("click", async () => {
  try {
    const r = await invoke("lib_refresh");
    await reloadLibrary();
    toast(`Biblioteca actualizada (+${r.added}${r.failed ? `, ${r.failed} no leídas` : ""})`);
  } catch (e) {
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
function buildEqSliders() {
  el.eqBands.innerHTML = "";
  for (let i = 0; i < 10; i++) {
    const band = document.createElement("div");
    band.className = "band";
    const inp = document.createElement("input");
    inp.type = "range";
    inp.min = "-12";
    inp.max = "12";
    inp.step = "0.5";
    inp.value = "0";
    inp.addEventListener("input", () => {
      ui.bands[i] = Number(inp.value);
      ui.bass = Number(el.bass.value);
      ui.treble = Number(el.treble.value);
      sendEq();
      scheduleSettingsSave();
    });
    const lb = document.createElement("span");
    lb.textContent = EQ_FREQS[i];
    band.append(inp, lb);
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

async function persistSettings() {
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
  };
  try { await invoke("settings_set", { settings: s }); } catch {}
}

function paintMixerFromState() {
  const sliders = el.eqBands.querySelectorAll("input");
  for (let i = 0; i < 10 && i < sliders.length; i++) sliders[i].value = String(ui.bands[i]);
  el.bass.value = String(ui.bass);
  el.treble.value = String(ui.treble);
  el.balance.value = String(ui.balance * 100);
  el.fade.value = String(ui.fade_secs);
  el.fadeVal.textContent = `${ui.fade_secs.toFixed(1)} s`;
  el.preset.value = "";
}

el.preset.addEventListener("change", () => {
  const v = el.preset.value;
  if (v === "flat") {
    ui.bands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  } else if (v) {
    ui.bands = PRESETS[v].map((x) => x);
  } else return;
  const sliders = el.eqBands.querySelectorAll("input");
  for (let i = 0; i < 10; i++) sliders[i].value = String(ui.bands[i]);
  sendEq();
  scheduleSettingsSave();
});

$("btn-eq-reset").addEventListener("click", () => {
  el.preset.value = "";
  ui.bands = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const sliders = el.eqBands.querySelectorAll("input");
  for (let i = 0; i < 10; i++) sliders[i].value = "0";
  sendEq();
  scheduleSettingsSave();
});

el.bass.addEventListener("input", () => { ui.bass = Number(el.bass.value); sendEq(); scheduleSettingsSave(); });
el.treble.addEventListener("input", () => { ui.treble = Number(el.treble.value); sendEq(); scheduleSettingsSave(); });
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
    if (playing) invoke("set_current_gain", { gain_db: v });
  }
});

function syncTrackGainUI() {
  const db = currentPath ? gainByPath.get(currentPath) ?? 0 : 0;
  el.trackGain.value = String(db);
  el.trackGainVal.textContent = `${db > 0 ? "+" : ""}${db} dB`;
  el.trackGain.disabled = !currentPath;
}

el.btnMixer.addEventListener("click", () => {
  el.mixer.classList.toggle("hidden");
  el.btnMixer.classList.toggle("active");
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
    gIn.step = "0.5";
    gIn.value = String(g);
    gIn.title = `Ganancia: ${g} dB`;
    const gLbl = document.createElement("span");
    gLbl.textContent = `${g > 0 ? "+" : ""}${g} dB`;
    const send = () => {
      const nf = Math.max(20, Math.min(20000, Number(fIn.value) || f));
      const nq = Number(qIn.value);
      const ng = Number(gIn.value);
      qIn.title = `Q: ${nq}`;
      gLbl.textContent = `${ng > 0 ? "+" : ""}${ng} dB`;
      ui.param_eq[i] = [nf, nq, ng];
      invoke("set_param_band", { index: i, freq: nf, q: nq, gain: ng }).catch(() => {});
      scheduleSettingsSave();
    };
    fIn.addEventListener("change", send);
    qIn.addEventListener("input", send);
    gIn.addEventListener("input", send);
    row.append(fIn, qIn, gIn, gLbl);
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
    // aplica de inmediato a la pista en curso
    const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
    if (cur && playing) {
      const manual = gainByPath.get(cur.path) ?? 0;
      invoke("set_current_gain", { gain_db: manual + rgGainFor(cur) }).catch(() => {});
    }
    scheduleSettingsSave();
  });
}
const rgAlbumBox = document.getElementById("mix-rg-album");
if (rgAlbumBox) {
  rgAlbumBox.addEventListener("change", () => {
    ui.rg_album = rgAlbumBox.checked;
    const cur = curIdx >= 0 && curIdx < session.length ? session[curIdx] : null;
    if (cur && playing) {
      const manual = gainByPath.get(cur.path) ?? 0;
      invoke("set_current_gain", { gain_db: manual + rgGainFor(cur) }).catch(() => {});
    }
    scheduleSettingsSave();
  });
}
const rgBtn = document.getElementById("btn-rg-scan");
if (rgBtn) {
  rgBtn.addEventListener("click", async () => {
    try {
      const pending = await invoke("rg_scan_start");
      if (pending === 0) {
        rgStatus.textContent = "Toda la biblioteca ya está analizada.";
        return;
      }
      rgBtn.disabled = true;
      rgStatus.textContent = `Analizando… 0 / ${pending}`;
    } catch (e) {
      rgStatus.textContent = String(e);
    }
  });
}
try {
  window.__TAURI__.event.listen("enn://rg", (e) => {
    const { done, total, finished } = e.payload || {};
    if (rgStatus) rgStatus.textContent = finished ? "Análisis completo." : `Analizando… ${done} / ${total}`;
    if (finished) {
      if (rgBtn) rgBtn.disabled = false;
      reloadLibrary();
      toast("Análisis de volumen completado");
    }
  });
} catch {}

// ---------------------------------------------------------------- espectro (A5)
const specCanvas = document.getElementById("spectrum");
let specBusy = false;

function drawSpectrum(bands) {
  if (!specCanvas) return;
  const ctx = specCanvas.getContext("2d");
  const W = specCanvas.width, H = specCanvas.height;
  ctx.clearRect(0, 0, W, H);
  const bw = W / bands.length;
  for (let i = 0; i < bands.length; i++) {
    const h = Math.max(1, bands[i] * (H - 4));
    const g = ctx.createLinearGradient(0, H - h, 0, H);
    g.addColorStop(0, "#4a9eff");
    g.addColorStop(1, "#7fd4a8");
    ctx.fillStyle = g;
    ctx.fillRect(i * bw + 1, H - h, bw - 2, h);
  }
}

setInterval(async () => {
  if (!specCanvas || specBusy) return;
  const open = el.mixer && !el.mixer.classList.contains("hidden");
  if (!open) return; // solo dibuja con el mezclador visible (coste cero si no)
  specBusy = true;
  try {
    const bands = await invoke("get_spectrum");
    drawSpectrum(bands);
  } catch {}
  specBusy = false;
}, 80);

// ---------------------------------------------------------------- waveform (B7)
const waveCanvas = document.getElementById("seek-wave");
let wavePath = null;
let waveData = null;

async function refreshWave(path) {
  wavePath = path;
  waveData = null;
  if (waveCanvas) waveCanvas.width = waveCanvas.clientWidth || 300;
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
el.volume.addEventListener("input", () => {
  const v = Number(el.volume.value) / 100;
  ui.volume = v;
  el.volNum.textContent = String(Math.round(v * 100));
  invoke("set_volume", { volume: v });
  scheduleSettingsSave();
});

el.seek.addEventListener("input", () => {
  seeking = true;
  if (duration) el.tCur.textContent = fmtTime((Number(el.seek.value) / 1000) * duration);
});
el.seek.addEventListener("change", () => {
  if (!duration) { seeking = false; return; }
  invoke("seek_to", { seconds: (Number(el.seek.value) / 1000) * duration });
  seeking = false;
  primedFor = null; // el motor suelta la pista cebada al buscar
});

// ---------------------------------------------------------------- estado del motor
function updatePlayBtn() {
  el.play.innerHTML = playing ? SVG.pause : SVG.play;
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
}

function hideMiniArt() {
  lastArtPath = null;
  el.miniArt.classList.add("hidden");
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
  playing = s.state === "playing";
  pos = s.pos || 0;
  updatePlayBtn();
  updateQualityBadge(s);
  const effDur = s.dur
    ?? (curIdx >= 0 && curIdx < session.length && session[curIdx] ? session[curIdx].dur : 0)
    ?? 0;
  if (s.title && s.title !== lastTitle) {
    lastTitle = s.title;
    el.miniTitle.textContent = s.title;
  }
  if (s.path && s.path !== lastArtPath) {
    lastArtPath = s.path;
    setMiniArt(s.path);
    refreshWave(s.path);
  } else if (!s.path && lastArtPath) {
    hideMiniArt();
    refreshWave(null);
  }
  duration = effDur;
  if (duration) {
    if (!seeking) {
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
function setupDivider() {
  const split = $("split");
  const app = $("app");
  const saved = Number(localStorage.getItem("enn.qw") || 0);
  if (saved >= 220 && saved <= 700) app.style.setProperty("--qw", saved + "px");
  split.addEventListener("pointerdown", (e) => {
    split.classList.add("dragging");
    split.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const rect = app.getBoundingClientRect();
      const w = Math.max(220, Math.min(700, rect.right - ev.clientX));
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
let dlJobs = new Map(); // url -> { row, pct, state }
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

function renderDlList() {
  el.dlList.innerHTML = "";
  const jobs = Array.from(dlJobs.values());
  if (!jobs.length) {
    el.dlList.innerHTML = '<div class="dl-item"><span class="dl-name">Pega un enlace o una lista de YouTube, SoundCloud, Bandcamp… para empezar.</span></div>';
    return;
  }
  for (const j of jobs) {
    const item = document.createElement("div");
    item.className = "dl-item" + (j.state === "done" ? " done" : j.state === "error" ? " error" : "");
    const name = document.createElement("span");
    name.className = "dl-name";
    name.textContent = j.displayName || j.name;
    name.title = j.path ? j.path : j.url || j.name;
    const bar = document.createElement("span");
    bar.className = "dl-bar";
    const fill = document.createElement("i");
    // valor actual (no 0%), así la transición anima entre ticks sin saltos
    const wide = j.state === "done" ? 100 : (j.pct || 0);
    fill.style.width = wide + "%";
    bar.appendChild(fill);
    j.fill = fill;
    item.append(name, bar);
    if (j.state === "done") {
      const act = document.createElement("span");
      act.className = "dl-actions";
      const b1 = document.createElement("button");
      b1.className = "btn small dl-btn";
      b1.textContent = "▶ Escuchar";
      b1.addEventListener("click", () => playPathNow(j.path));
      const b2 = document.createElement("button");
      b2.className = "btn small dl-btn";
      b2.textContent = "＋ Cola";
      b2.addEventListener("click", () => enqueuePath(j.path));
      act.append(b1, b2);
      item.appendChild(act);
      const chip = document.createElement("span");
      chip.className = "dl-chip done";
      chip.textContent = "✓";
      chip.title = "Descarga completada";
      item.appendChild(chip);
    } else {
      const chip = document.createElement("span");
      chip.className = "dl-chip " + j.state;
      if (j.state === "downloading") {
        chip.innerHTML = '<span class="spinner"></span>' + `${Math.round(j.pct ?? 0)}%`;
      } else if (j.state === "error") {
        chip.textContent = /cancelada/.test(j.error || "") ? "cancelada" : "error";
        chip.title = j.error || "";
      } else {
        chip.textContent = "en cola";
      }
      // botón de cancelar para tareas en cola o en marcha
      if (j.state !== "error" && j.id !== undefined) {
        const cx = document.createElement("button");
        cx.className = "x";
        cx.textContent = "✕";
        cx.title = "Cancelar descarga";
        cx.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            await invoke("download_cancel", { id: j.id });
            j.state = "error";
            j.error = "descarga cancelada";
            j.pct = 0;
            renderDlList();
            toast("Descarga cancelada");
          } catch (err) {
            toast(`No se pudo cancelar: ${err}`);
          }
        });
        chip.appendChild(cx);
      }
      item.appendChild(chip);
    }
    el.dlList.appendChild(item);
  }
}

el.dlBtn.addEventListener("click", () => {
  dlClosed = !dlClosed;
  el.dl.classList.toggle("hidden", dlClosed);
  if (!dlClosed) {
    if (el.mixer && !el.mixer.classList.contains("hidden")) {
      el.mixer.classList.add("hidden");
      el.btnMixer.classList.remove("active");
    }
    refreshDlTarget();
    renderDlList();
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

el.dlStart.addEventListener("click", startDownload);
el.dlUrl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); startDownload(); }
});

// progreso de descargas: consulta ligera cada 400 ms mientras el panel está abierto
let dlBusy = false;
setInterval(async () => {
  if (dlClosed || dlBusy) return;
  dlBusy = true;
  try {
    const tasks = await invoke("download_list");
    let changed = false;
    for (const t of tasks) {
      const key = t.url && t.url.length > 46 ? t.url.slice(0, 46) + "…" : t.url;
      if (!dlJobs.has(key)) {
        dlJobs.set(key, { name: key, url: t.url, id: t.id, pct: 0, state: "queued", path: null, displayName: key, shownPct: 0 });
        changed = true;
      }
      const j = dlJobs.get(key);
      if (j.id === undefined) j.id = t.id;
      if (t.error) j.error = t.error;
      // título real (llega pronto vía --print) mientras se descarga
      if (t.title && j.displayName !== t.title) {
        j.displayName = t.title;
        changed = true;
      }
      if (t.state === "done" && t.path) {
        const fname = t.title || fnameBase(t.path);
        if (j.displayName !== fname) {
          j.displayName = fname;
          changed = true;
        }
        j.path = t.path;
      }
      j.targetPct = t.state === "done" ? 100 : (Number(t.progress_percent) || 0);
      if (j.state !== t.state) {
        const was = j.state;
        j.state = t.state;
        changed = true;
        // sonidos: campanilla al completar, tono grave en error
        if (t.state === "done") chime("ok");
        else if (t.state === "error" && was !== "error") chime("err");
      }
      if (j.state === "done" && !j.handled) {
        j.handled = true;
        changed = true;
        const inLib = await invoke("lib_folders");
        const isIndexed = t.path && t.target_dir && inLib.some((f) => t.path.startsWith(f));
        if (isIndexed) {
          await invoke("lib_refresh");
          await reloadLibrary();
          freshPaths.add(t.path);
          setTimeout(() => freshPaths.delete(t.path), 15000);
        }
        toast(`${isIndexed ? "Descargada y agregada a la biblioteca: " : "Descargada: "}${j.displayName || fnameBase(t.path)}`);
      }
    }
    if (changed) renderDlList();
  } catch {}
  dlBusy = false;
}, 400);

// interpolador de la barra: suaviza el cambio entre ticks (independiente del re-render)
function animateDlBars() {
  if (dlClosed) return;
  for (const j of dlJobs.values()) {
    if (!j.fill) continue;
    const target = j.state === "done" ? 100 : (j.targetPct ?? 0);
    // aproximación exponencial: el nodo persigue el objetivo con suavidad
    j.shownPct = j.shownPct === undefined ? target : j.shownPct + (target - j.shownPct) * 0.28;
    if (Math.abs(j.shownPct - target) < 0.4) j.shownPct = target;
    j.fill.style.width = j.shownPct + "%";
  }
  requestAnimationFrame(animateDlBars);
}
requestAnimationFrame(animateDlBars);

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
  const mk = (label, value) => {
    const l = document.createElement("label");
    l.style.cssText = "display:block;margin:8px 0;font-size:12px;color:var(--text-dim,#888)";
    l.textContent = label;
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = value || "";
    inp.style.cssText = "width:100%;margin-top:3px;padding:6px 8px;border:none;border-radius:6px;background:var(--track,rgba(128,128,128,0.15));color:inherit;font:inherit";
    l.appendChild(inp);
    body.appendChild(l);
    return inp;
  };
  const fTitle = mk("Título", t.title);
  const fArtist = mk("Artista", t.artist);
  const fAlbum = mk("Álbum", t.album);
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

el.queue.addEventListener("contextmenu", (e) => {
  const li = e.target.closest("li");
  if (!li || li.dataset.idx === undefined) return;
  e.preventDefault();
  const idx = Number(li.dataset.idx);
  const t = session[idx];
  if (!t) return;
  openCtx(e.clientX, e.clientY, [
    { label: "▶ Reproducir ahora", fn: () => playAt(idx) },
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
document.addEventListener("keydown", (e) => {
  // Ctrl+F: buscar en la biblioteca desde cualquier parte
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
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
const btnMini = $("btn-mini");
if (btnMini) {
  const setMini = async (mini) => {
    try {
      const { getCurrentWindow } = window.__TAURI__.window;
      const { LogicalSize } = window.__TAURI__.dpi || {};
      const w = getCurrentWindow();
      document.body.classList.toggle("mini", mini);
      if (LogicalSize) {
        await w.setSize(mini ? new LogicalSize(430, 90) : new LogicalSize(1120, 680));
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


// ---------------------------------------------------------------- arranque
async function init() {
  try {
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

    // sondeo directo del estado del motor (250 ms)
    let wasPlaying = false;
    let suppressNext = false;
    setInterval(() => {
      pollStateInline();
    }, 250);

    async function pollStateInline() {
      let s;
      try {
        s = await invoke("get_state");
      } catch (err) {
        el.miniTitle.textContent = "—";
        return;
      }
      const nowPlaying = s.state === "playing";
      if (nowPlaying !== wasPlaying) {
        if (wasPlaying && s.state === "idle" && !suppressNext) onEnded();
        suppressNext = false;
        wasPlaying = nowPlaying;
      }
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
        !shuffleOn &&
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
          invoke("prime_file", { path: nxt.path, dur: nxt.dur ?? null, gain_db: manual + rgGainFor(nxt) })
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
      };
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
    } catch {}

    try {
      session = JSON.parse(localStorage.getItem("enn.queue") || "[]");
      if (!Array.isArray(session)) session = [];
      session = session.filter((t) => t && typeof t.path === "string");
      curIdx = -1;
    } catch {
      session = [];
    }

    await refreshDevices();
    await reloadLibrary();
    renderQueue();
  } catch (e) {
    // si el arranque falla, al menos se ve en pantalla con estilo sutil
    const d = document.getElementById("mini-title");
    if (d) d.textContent = "· inicio";
  }
}

init();


// ---- diagnóstico final: timers vivos? ----






