// Mock de window.__TAURI__ SOLO para previsualizar la UI en un navegador
// normal (fuera de `tauri dev`). En la app real, `withGlobalTauri: true`
// en tauri.conf.json inyecta window.__TAURI__ antes de que corra este
// script, así que el guard de abajo lo vuelve un no-op ahí — cero riesgo
// de que esto se cuele en producción.
(function () {
  if (window.__TAURI__) return;

  const PIXEL_ART =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">' +
        '<defs><radialGradient id="g" cx="50%" cy="35%" r="75%">' +
        '<stop offset="0%" stop-color="#d97706"/><stop offset="55%" stop-color="#7c3aed"/>' +
        '<stop offset="100%" stop-color="#0a0a0c"/></radialGradient></defs>' +
        '<rect width="300" height="300" fill="url(#g)"/>' +
        '<circle cx="150" cy="150" r="60" fill="none" stroke="rgba(255,255,255,.5)" stroke-width="3"/>' +
        '<circle cx="150" cy="150" r="90" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="3"/>' +
        "</svg>"
    );

  const library = [
    { path: "C:/Music/cheki.flac", title: "Cheki", artist: "Los Diozes", album: "ft. Xokas", genre: "Reggaetón", year: 2024, favorite: true, dur: 199 },
    { path: "C:/Music/oasis.flac", title: "Oasis de Silencio", artist: "Stellar Echo", album: "Quiet Skies", genre: "Ambient", year: 2022, favorite: false, dur: 252 },
    { path: "C:/Music/nordic.m4a", title: "Nordic Dawn", artist: "Fjord Sound Ensemble", album: "Aurora", genre: "Instrumental", year: 2021, favorite: false, dur: 225 },
    { path: "C:/Music/terminal.mp3", title: "Velocidad Terminal", artist: "LOS DIOZES", album: "Cheki", genre: "Reggaetón", year: 2024, favorite: false, dur: 178 },
    { path: "C:/Music/murmullo.flac", title: "Cálido Murmullo", artist: "Aura K", album: "Susurros", genre: "Folk", year: 2019, favorite: true, dur: 320 },
    { path: "C:/Music/medianoche.wav", title: "Ecos de Medianoche", artist: "Kroma & Silva", album: "Nocturno", genre: "Synthwave", year: 2023, favorite: false, dur: 211 },
  ];

  let playing = false;
  let pos = 0;
  let loaded = null; // path cargado actualmente (null = nada, como al arrancar de verdad)

  function fakeSpectrum() {
    const n = 48;
    const out = new Array(n);
    const t = Date.now() / 400;
    for (let i = 0; i < n; i++) {
      const base = Math.max(0, Math.sin(t + i * 0.3)) * (1 - i / n);
      out[i] = Math.min(1, base * (0.5 + Math.random() * 0.6));
    }
    return out;
  }

  // eventos simulados (download://task, enn://preview…)
  const listeners = {};
  const emit = (name, payload) => (listeners[name] || []).forEach((cb) => cb({ payload }));
  const SONGS = [
    ["aaaaaaaaaa1", "Get Lucky", "Daft Punk", "Random Access Memories", "6:09"],
    ["aaaaaaaaaa2", "Instant Crush", "Daft Punk", "Random Access Memories", "5:37"],
    ["aaaaaaaaaa3", "One More Time", "Daft Punk", "Discovery", "5:20"],
    ["aaaaaaaaaa4", "Falla en el acto", "Prueba", "Errores", "3:10"],
  ].map(([id, title, artist, album, duration]) => ({ kind: "song", id, title, artist, album, duration, thumb: PIXEL_ART }));
  let nextTask = 1;
  let pvTimer = 0;
  /// Descarga simulada: resolviendo → descargando (a saltos) → convirtiendo → hecha.
  function fakeDownload(id, title, fail) {
    const task = { id, url: "https://music.youtube.com/watch?v=x", state: "queued", path: null, title, progress_percent: 0, target_dir: "C:/Music", error: null, speed: 0 };
    const send = () => emit("download://task", { ...task });
    send();
    let pct = 0;
    setTimeout(() => { task.state = "resolving"; send(); }, 400);
    setTimeout(() => {
      if (fail) { task.state = "error"; task.error = "el vídeo es privado (yt-dlp, código 1)"; return send(); }
      task.state = "downloading";
      const iv = setInterval(() => {
        pct = Math.min(100, pct + 7 + Math.random() * 12);
        task.progress_percent = pct;
        task.speed = 2.1 * 1024 * 1024;
        send();
        if (pct >= 100) {
          clearInterval(iv);
          task.state = "converting"; task.speed = 0; send();
          setTimeout(() => { task.state = "done"; task.path = "C:/Music/" + title + ".m4a"; send(); }, 900);
        }
      }, 300);
    }, 1400);
  }

  const invoke = async (cmd, args) => {
    switch (cmd) {
      case "music_search": return { source: "ytmusic", offline: false, items: SONGS };
      case "preview_prefetch": return null;
      case "preview_play": {
        await new Promise((r) => setTimeout(r, 600));
        clearTimeout(pvTimer);
        emit("enn://preview", true);
        pvTimer = setTimeout(() => emit("enn://preview", false), 10000);
        return { start: 40.5, len: 10 };
      }
      case "preview_stop": clearTimeout(pvTimer); emit("enn://preview", false); return null;
      case "download_tracks":
        return args.tracks.map((t) => {
          const id = nextTask++;
          setTimeout(() => fakeDownload(id, t.title, /Falla/.test(t.title)), 0);
          return id;
        });
      case "download_pending": return 0;
      case "insights_event": case "insights_migrate": case "radio_tuner_set": case "enrich_now": return null;
      case "enrich_status": return { tagged: 98, total: library.length, running: false };
      case "radio_next": {
        const pool = library.filter((t) => t.path !== args.cur && !(args.exclude || []).includes(t.path));
        const t = pool[Math.floor(Math.random() * pool.length)];
        return t ? [{ path: t.path, reason: "Sigue el hilo: Reguetón → Trap" }] : [];
      }
      case "reco_for":
        return {
          kind: "engine",
          plays: 1,
          items: library.filter((t) => t.path !== args.path).slice(0, 3).map((t, i) => ({ path: t.path, reason: ["Sigue el hilo: Reguetón", "Vecina en la radio de YouTube Music", "Sueles ponerla después"][i] })),
        };
      case "tools_status": return { version: "2026.10.26", last_check: Math.floor(Date.now() / 1000), updating: false };
      case "lib_list": return library;
      case "lib_folders": return ["C:/Music"];
      case "cache_stats": return { tracks: library.length, cache_bytes: 46 * 1024 * 1024, cache_files: 210 };
      case "get_state": {
        const t = loaded ? library.find((x) => x.path === loaded) : null;
        // el motor real devuelve "idle" sin pista cargada (lib.rs, get_state)
        if (!t) return { state: "idle", path: null, title: null, artist: null, pos: 0, dur: 0 };
        return {
          state: playing ? "playing" : "paused",
          path: t.path, title: t.title, artist: t.artist,
          pos, dur: t.dur,
          sample_rate: 96000, bits_per_sample: 24, bitrate_kbps: null,
        };
      }
      case "get_spectrum": return playing ? fakeSpectrum() : new Array(48).fill(0);
      case "album_art": return PIXEL_ART;
      case "list_devices": return ["Altavoces Hi-Fi (Salida óptica directa)"];
      case "settings_get":
        return { volume: 0.8, balance: 0, bands: Array(10).fill(0), bass: 0, treble: 0, fade_secs: 6, rg_norm: true, rg_album: false, param_eq: [], exclusive: false };
      case "playlist_list": return [];
      case "download_list": return [];
      case "get_download_dir": return "C:/Music/Descargas";
      case "probe_paths": return { tracks: [] };
      case "play_file": loaded = args?.path ?? loaded; playing = true; pos = 0; return null;
      case "toggle_pause": if (loaded) playing = !playing; return null;
      case "stop": loaded = null; playing = false; pos = 0; return null;
      // normalización: todo «analizado» al momento y una canción fuerte (−9 LUFS)
      case "rg_scan_start": return 0;
      case "rg_analyze": return -9;
      case "seek_to": pos = args?.seconds ?? pos; return null;
      case "lib_set_favorite": {
        const t = library.find((x) => x.path === args.path);
        if (t) t.favorite = args.favorite;
        return null;
      }
      default: return null;
    }
  };

  setInterval(() => {
    if (!playing || !loaded) return;
    const t = library.find((x) => x.path === loaded);
    if (t) pos = Math.min(t.dur, pos + 0.25);
  }, 250);

  window.__TAURI__ = {
    core: { invoke },
    event: {
      listen: async (name, cb) => {
        (listeners[name] = listeners[name] || []).push(cb);
        return () => {};
      },
    },
    dialog: { open: async () => null, save: async () => null },
    window: { getCurrentWindow: () => ({ setMinSize: async () => {}, setSize: async () => {} }) },
    dpi: { LogicalSize: function (w, h) { this.w = w; this.h = h; } },
  };
  console.info("[Enn] Vista previa en navegador con datos de ejemplo (window.__TAURI__ simulado) — no es la app real.");
})();
