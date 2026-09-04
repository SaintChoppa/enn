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
let filtered = [];         // Ã­ndices sobre library tras el filtro
let libWinEnd = 500;       // renderizado por ventanas
let session = [];          // Track[] (cola/orden completo)
let curIdx = -1;           // Ã­ndice en session de la pista actual
let repeatMode = 0;        // 0 ninguno Â· 1 todo Â· 2 una
let shuffleOn = false;
let playing = false;
let duration = 0;
let pos = 0;
let seeking = false;
let toastTimer = null;
let deviceList = [];
let deviceSwitching = false;
let settingsTimer = null;
let currentPath = null;
let ui = {
  volume: 0.8, balance: 0, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: 0, treble: 0, fade_secs: 0,
};
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

// ---------------------------------------------------------------- construcciÃ³n de filas
function rowEl(track, opts) {
  const { idx, removable = false, current = false } = opts || {};
  const li = document.createElement("li");
  li.dataset.path = track.path;
  if (current) li.classList.add("current");
  const art = document.createElement("span");
  art.className = "art";
  art.textContent = "â–¶";
  if (current) art.classList.add("on");
  const nm = document.createElement("span");
  nm.className = "nm";
  const t = document.createElement("div");
  t.className = "t-title";
  t.textContent = track.artist ? `${track.artist} â€” ${track.title}` : track.title;
  t.title = track.path;
  nm.appendChild(t);
  const d = document.createElement("span");
  d.className = "dur";
  d.textContent = track.dur ? fmtTime(track.dur) : "â€“";
  li.append(art, nm, d);
  if (idx !== undefined) li.dataset.idx = String(idx);
  if (removable) {
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "âœ•";
    x.title = "Quitar de la cola";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeAt(Number(li.dataset.idx));
    });
    li.appendChild(x);
  }
  return li;
}

// ---------------------------------------------------------------- cola / reproducciÃ³n
function renderQueue() {
  el.queue.innerHTML = "";
  const upcoming = session.slice(curIdx + 1);
  upcoming.forEach((t, i) => {
    const li = rowEl(t, { idx: curIdx + 1 + i, removable: true });
    li.addEventListener("click", () => playAt(curIdx + 1 + i));
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
      await invoke("dbg_log", { msg: `playAt(${i}) ruta invÃ¡lida: ${JSON.stringify(track)}` });
    } catch {}
    toast("Esta canciÃ³n no tiene ruta vÃ¡lida");
    return;
  }
  // si la duraciÃ³n no se conoce (MP3 VBR antiguos en la cola), se mide ahora
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
    const g = gainDb ?? gainByPath.get(track.path) ?? 0;
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
    return;
  }
}

function pushTracks(list, { playNow = false } = {}) {
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
  if (added && (session.length === 1 || playNow || (curIdx < 0 && !playing))) {
    playAt(session.length - added);
  } else {
    markPlayingRow();
  }
  return added;
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
  // Sin aleatorio ni repeticiÃ³n: al terminar la pista, Enn se detiene.
  if (!shuffleOn && repeatMode === 0) return;
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
  }
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

function paintModes() {
  el.shuffle.classList.toggle("active", shuffleOn);
  el.shuffle.title = `Aleatorio: ${shuffleOn ? "on" : "off"}`;
  iconSetMode("btn-shuffle", "shuffle", shuffleOn ? "on" : "off");
  el.repeat.classList.toggle("active", repeatMode !== 0);
  el.repeat.title = `RepeticiÃ³n: ${["off", "todo", "una"][repeatMode]}`;
  iconSetMode("btn-repeat", "repeat", ["off", "all", "1"][repeatMode]);
}

// ---------------------------------------------------------------- biblioteca
function libCountText() {
  const folders = library.length;
  void folders;
  return `${library.length} canciones`;
}

function renderLib() {
  el.libList.innerHTML = "";
  const n = Math.min(libWinEnd, filtered.length);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const li = rowEl(library[filtered[i]]);
    li.addEventListener("click", () => playFromLibrary(i));
    const add = document.createElement("button");
    add.className = "x";
    add.textContent = "+";
    add.title = "AÃ±adir a la cola";
    add.addEventListener("click", (e) => {
      e.stopPropagation();
      const added = pushTracks([library[filtered[i]]]);
      if (!added) toast("Ya estÃ¡ en la cola");
    });
    li.appendChild(add);
    frag.appendChild(li);
  }
  el.libList.appendChild(frag);
  el.libEmpty.classList.toggle("hidden", library.length > 0);
  el.libMeta.textContent = filtered.length !== library.length
    ? `${filtered.length} de ${library.length} canciones`
    : libCountText();
  markPlayingRow();
}

el.search.addEventListener("input", () => {
  const q = el.search.value.trim().toLowerCase();
  filtered = library
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (!q) return true;
      return `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q);
    })
    .map((x) => x.i);
  libWinEnd = 500;
  renderLib();
});

el.libList.addEventListener("scroll", () => {
  if (
    libWinEnd < filtered.length &&
    el.libList.scrollTop + el.libList.clientHeight >= el.libList.scrollHeight - 400
  ) {
    const before = libWinEnd;
    libWinEnd = Math.min(filtered.length, libWinEnd + 300);
    const frag = document.createDocumentFragment();
    for (let i = before; i < libWinEnd; i++) {
      const li = rowEl(library[filtered[i]]);
      li.addEventListener("click", () => playFromLibrary(i));
      const add = document.createElement("button");
      add.className = "x";
      add.textContent = "+";
      add.addEventListener("click", (e) => {
        e.stopPropagation();
        pushTracks([library[filtered[i]]]);
      });
      li.appendChild(add);
      frag.appendChild(li);
    }
    el.libList.appendChild(frag);
    markPlayingRow();
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

// ---------------------------------------------------------------- aÃ±adir archivos/carpetas
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
      toast(`${r.tracks.length} canciÃ³n(es) agregada(s)`);
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
      toast(`${r.added} canciones indexadas${r.failed ? ` (${r.failed} no leÃ­das)` : ""}`);
    } else if (r.failed > 0) {
      toast(`No se pudo leer ningÃºn audio ahÃ­: ${r.first_error || "?"}`);
    } else {
      toast("La carpeta no tenÃ­a audio nuevo (o ya estaba indexada)");
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
    toast(`Biblioteca actualizada (+${r.added}${r.failed ? `, ${r.failed} no leÃ­das` : ""})`);
  } catch (e) {
    toast(`Error al re-escanear: ${e}`);
  }
});

// ---------------------------------------------------------------- playlists
async function savePlaylist() {
  if (!session.length) return toast("La cola estÃ¡ vacÃ­a");
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
});

// ---------------------------------------------------------------- estado del motor
function updatePlayBtn() {
  el.play.innerHTML = playing ? SVG.pause : SVG.play;
}

let lastTitle = "";
function applyStatus(s) {
  playing = s.state === "playing";
  pos = s.pos || 0;
  updatePlayBtn();
  const effDur = s.dur
    ?? (curIdx >= 0 && curIdx < session.length && session[curIdx] ? session[curIdx].dur : 0)
    ?? 0;
  if (s.title && s.title !== lastTitle) {
    lastTitle = s.title;
    el.miniTitle.textContent = s.title;
  }
  duration = effDur;
  if (duration) {
    if (!seeking) {
      const ratio = duration > 0 ? (s.pos || 0) / duration : 0;
      el.seek.value = String(Math.round(ratio * 1000));
    }
    el.tCur.textContent = fmtTime(s.pos || 0);
    el.tDur.textContent = fmtTime(duration);
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
    toast(name ? `Audio â†’ ${name}` : "Audio â†’ predeterminado");
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

// ---------------------------------------------------------------- teclado
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.code === "Space") { e.preventDefault(); invoke("toggle_pause"); }
  else if (e.code === "ArrowRight") nextManual();
  else if (e.code === "ArrowLeft") prevManual();
  else if (e.key === "m" || e.key === "M") el.btnMixer.click();
});


// ---------------------------------------------------------------- arranque
async function init() {
  try {
    buildEqSliders();
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
      };
      el.volume.value = String(Math.round(ui.volume * 100));
      el.volNum.textContent = String(Math.round(ui.volume * 100));
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






