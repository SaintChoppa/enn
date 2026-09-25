// el enlazador de MSVC emite una nota informativa al crear enn_lib.dll: no es código muerto
#![allow(linker_messages)]

mod art;
mod decode;
mod downloader;
mod dsp;
#[cfg(target_os = "windows")]
mod exclusive;
mod library;
mod media_keys;
mod player;
mod plstores;
mod rg;
mod waves;

use std::path::Path;
use std::sync::Mutex;

use library::{Library, Track};
use player::{PlayState, Player};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/// Estado de la aplicación: librería + rutas de persistencia.
pub struct EnnState {
    lib: Mutex<Library>,
    lib_path: std::path::PathBuf,
    set_path: std::path::PathBuf,
    /// Carpeta fija (en el directorio de configuración) donde viven las playlists.
    pl_dir: std::path::PathBuf,
    /// Caché de carátulas de álbum (accesible para media_keys).
    pub art_dir: std::path::PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub volume: f32,
    pub balance: f32,
    pub bands: [f32; 10],
    pub bass: f32,
    pub treble: f32,
    pub fade_secs: f32,
    /// normalización de volumen (ReplayGain 2.0) activada
    pub rg_norm: bool,
    /// ReplayGain por álbum (media de sonoridad del disco) en vez de por pista
    pub rg_album: bool,
    /// EQ paramétrico: 4 bandas [f0 Hz, Q, ganancia dB]
    pub param_eq: Vec<[f64; 3]>,
    /// salida WASAPI exclusiva (bit-perfect, tasa nativa del archivo)
    pub exclusive: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            volume: 0.8,
            balance: 0.0,
            bands: [0.0; 10],
            bass: 0.0,
            treble: 0.0,
            fade_secs: 0.0,
            rg_norm: true,
            rg_album: false,
            param_eq: Vec::new(),
            exclusive: false,
        }
    }
}

fn load_settings(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn apply_settings(app: &tauri::AppHandle, s: &Settings) {
    let p = app.state::<Player>();
    p.set_volume(s.volume);
    p.set_balance(s.balance);
    p.set_eq(s.bands, s.bass, s.treble);
    p.set_fade(s.fade_secs);
    // la exclusiva se (re)inicia aquí solo si cambió el ajuste; play_path
    // reabre el stream a la tasa nativa de cada pista
    p.set_exclusive(s.exclusive).ok();
    for (i, b) in s.param_eq.iter().enumerate().take(4) {
        if b.len() == 3 {
            p.set_param_band(i, b[0], b[1], b[2] as f32);
        }
    }
}

// ---------------------------------------------------------------- audio

#[tauri::command]
fn play_file(app: tauri::AppHandle, path: String, dur: Option<f64>) -> Result<(), String> {
    app.state::<Player>().play_path(Path::new(&path), 0.0, dur)
}

/// Precarga la siguiente pista para el crossfade (C3).
#[tauri::command]
fn prime_file(
    app: tauri::AppHandle,
    path: String,
    dur: Option<f64>,
    gain_db: Option<f64>,
) -> Result<(), String> {
    app.state::<Player>()
        .prime_path(Path::new(&path), gain_db.unwrap_or(0.0) as f32, dur)
}

#[tauri::command]
fn toggle_pause(app: tauri::AppHandle) {
    app.state::<Player>().toggle();
}

#[tauri::command]
fn stop(app: tauri::AppHandle) {
    app.state::<Player>().stop();
}

#[tauri::command]
fn seek_to(app: tauri::AppHandle, seconds: f64) {
    app.state::<Player>().seek(seconds);
}

#[tauri::command]
fn set_volume(app: tauri::AppHandle, volume: f64) {
    app.state::<Player>().set_volume(volume as f32);
}

#[tauri::command]
fn set_balance(app: tauri::AppHandle, balance: f64) {
    app.state::<Player>().set_balance(balance as f32);
}

#[tauri::command]
fn set_eq(app: tauri::AppHandle, bands: Vec<f64>, bass: f64, treble: f64) {
    let mut b = [0.0f32; 10];
    for (i, v) in bands.iter().take(10).enumerate() {
        b[i] = *v as f32;
    }
    app.state::<Player>().set_eq(b, bass as f32, treble as f32);
}

#[tauri::command]
fn set_fade(app: tauri::AppHandle, seconds: f64) {
    app.state::<Player>().set_fade(seconds as f32);
}

/// Recoloca una banda paramétrica del EQ (C5): índice 0-3, f0 Hz, Q y dB.
#[tauri::command]
fn set_param_band(app: tauri::AppHandle, index: usize, freq: f64, q: f64, gain: f64) {
    app.state::<Player>()
        .set_param_band(index, freq, q, gain as f32);
}

/// Activa/desactiva la salida WASAPI exclusiva (bit-perfect, A1).
#[tauri::command]
fn set_exclusive(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    app.state::<Player>().set_exclusive(on)
}

#[tauri::command]
fn set_current_gain(app: tauri::AppHandle, gain_db: f64) {
    app.state::<Player>().set_current_gain_db(gain_db as f32);
}

#[tauri::command]
fn list_devices() -> Vec<String> {
    player::list_output_devices()
}

#[tauri::command]
fn select_device(app: tauri::AppHandle, name: Option<String>) -> Result<(), String> {
    app.state::<Player>().select_output(name)
}

// ---------------------------------------------------------------- librería

#[tauri::command]
fn lib_add(app: tauri::AppHandle, folder: String) -> library::AddResult {
    let st = app.state::<EnnState>();
    let mut lib = st.lib.lock().unwrap();
    lib.scan_into(&folder, &st.lib_path)
}

#[tauri::command]
fn lib_refresh(app: tauri::AppHandle) -> library::AddResult {
    let st = app.state::<EnnState>();
    let mut lib = st.lib.lock().unwrap();
    lib.refresh(&st.lib_path)
}

#[tauri::command]
fn lib_clear(app: tauri::AppHandle) {
    let st = app.state::<EnnState>();
    let mut lib = st.lib.lock().unwrap();
    lib.clear(&st.lib_path);
}

#[tauri::command]
fn lib_list(app: tauri::AppHandle) -> Vec<Track> {
    let st = app.state::<EnnState>();
    let l = st.lib.lock().unwrap();
    l.tracks.clone()
}

#[tauri::command]
fn lib_folders(app: tauri::AppHandle) -> Vec<String> {
    let st = app.state::<EnnState>();
    let l = st.lib.lock().unwrap();
    l.folders.clone()
}

/// Obtiene metadatos de un conjunto de archivos sin indexarlos.
#[tauri::command]
fn probe_paths(paths: Vec<String>) -> library::ProbeMany {
    let p: Vec<std::path::PathBuf> = paths.iter().map(Path::new).map(Into::into).collect();
    library::probe_many(&p)
}

/// Marca/desmarca una pista de la biblioteca como favorita.
#[tauri::command]
fn lib_set_favorite(app: tauri::AppHandle, path: String, favorite: bool) -> Result<(), String> {
    let st = app.state::<EnnState>();
    let mut lib = st.lib.lock().unwrap();
    match lib.tracks.iter_mut().find(|t| t.path == path) {
        Some(t) => {
            t.favorite = favorite;
            lib.save(&st.lib_path);
            Ok(())
        }
        None => Err("la pista no está en la biblioteca".into()),
    }
}

// ---------------------------------------------------------------- playlists

#[tauri::command]
fn playlist_save(app: tauri::AppHandle, path: String, tracks: Vec<Track>) -> Result<(), String> {
    let _ = app;
    library::write_m3u(Path::new(&path), &tracks)
}

#[tauri::command]
fn playlist_load(path: String) -> Vec<Track> {
    library::read_m3u(Path::new(&path))
        .iter()
        .filter_map(|p| library::probe(Path::new(p)))
        .collect()
}

// ---------------------------------------------------------------- ajustes

#[tauri::command]
fn settings_get(app: tauri::AppHandle) -> Settings {
    let st = app.state::<EnnState>();
    load_settings(&st.set_path)
}

#[tauri::command]
fn settings_set(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    apply_settings(&app, &settings);
    let st = app.state::<EnnState>();
    serde_json::to_string_pretty(&settings)
        .map_err(|e| e.to_string())
        .and_then(|s| std::fs::write(&st.set_path, s).map_err(|e| e.to_string()))
}

// ---------------------------------------------------------------- carátulas

/// Data URI de la carátula de un archivo (para `img src` en la UI).
#[tauri::command]
fn album_art(app: tauri::AppHandle, path: String) -> Option<String> {
    let st = app.state::<EnnState>();
    art::data_uri(&st.art_dir, Path::new(&path))
}

// ---------------------------------------------------------------- ReplayGain

/// Marca de que hay un análisis de sonoridad en curso (uno solo a la vez).
#[derive(Default)]
pub struct RgState {
    running: std::sync::atomic::AtomicBool,
}

/// Lanza el análisis ReplayGain (EBU R128) de todas las pistas sin `rg`.
/// Progreso por el evento `enn://rg` = { done, total, finished }.
#[tauri::command]
fn rg_scan_start(app: tauri::AppHandle) -> Result<usize, String> {
    use std::sync::atomic::Ordering;
    let state = app.state::<RgState>();
    if state
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("ya hay un análisis en curso".into());
    }
    let pending: Vec<String> = {
        let st = app.state::<EnnState>();
        let lib = st.lib.lock().unwrap();
        lib.tracks
            .iter()
            .filter(|t| t.rg.is_none())
            .map(|t| t.path.clone())
            .collect()
    };
    let total = pending.len();
    if total == 0 {
        state.running.store(false, Ordering::SeqCst);
        return Ok(0);
    }
    std::thread::spawn(move || {
        for (i, path) in pending.iter().enumerate() {
            if !std::path::Path::new(path).is_file() {
                continue;
            }
            let lufs = rg::analyze_lufs(Path::new(path));
            {
                let st = app.state::<EnnState>();
                let mut lib = st.lib.lock().unwrap();
                if let Some(t) = lib.tracks.iter_mut().find(|t| &t.path == path) {
                    t.rg = lufs;
                }
                // guarda cada 25 archivos para no perder trabajo si se cierra
                if (i + 1) % 25 == 0 || i + 1 == total {
                    lib.save(&st.lib_path);
                }
            }
            let _ = app.emit(
                "enn://rg",
                serde_json::json!({ "done": i + 1, "total": total, "finished": i + 1 == total }),
            );
        }
        app.state::<RgState>()
            .running
            .store(false, Ordering::SeqCst);
    });
    Ok(total)
}

/// Abre el explorador con el archivo seleccionado (Explorer en Windows,
/// gestor de archivos del escritorio en Linux).
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_file() {
        return Err("el archivo no existe".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", p.display()))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        // `open -R` selecciona el archivo en Finder, igual que /select en Explorer
        std::process::Command::new("open")
            .arg("-R")
            .arg(p)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // no hay un "seleccionar archivo" universal en Linux (varía por gestor de
        // archivos); abrimos la carpeta contenedora, que es lo que todos soportan
        if let Some(dir) = p.parent() {
            std::process::Command::new("xdg-open")
                .arg(dir)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = p;
        return Err("no soportado en esta plataforma".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- espectro y waveform

/// 48 bandas logarítmicas (0..1) del audio en reproducción, para el analizador.
#[tauri::command]
fn get_spectrum(app: tauri::AppHandle) -> Vec<f32> {
    const N: usize = 1024;
    const BANDS: usize = 48;
    const MAX_HZ: f64 = 16000.0;
    let p = app.state::<Player>();
    let c = p.core.lock().unwrap();
    let len = c.spec_buf.len();
    let mut s = vec![0.0f32; N];
    for (i, slot) in s.iter_mut().enumerate() {
        let idx = (c.spec_pos + len - N + i) % len;
        *slot = c.spec_buf[idx];
    }
    let sr = c.out_rate as f64;
    drop(c);
    let mut mags = vec![0.0f32; N / 2];
    dsp::fft_magnitudes(&s, &mut mags);
    let mut out = vec![0.0f32; BANDS];
    for (b, slot) in out.iter_mut().enumerate() {
        // bandas logarítmicas de 30 Hz a MAX_HZ
        let f0 = 30.0 * (MAX_HZ / 30.0).powf(b as f64 / BANDS as f64);
        let f1 = 30.0 * (MAX_HZ / 30.0).powf((b + 1) as f64 / BANDS as f64);
        let i0 = ((f0 / sr) * N as f64).round().max(1.0) as usize;
        let i1 = ((f1 / sr) * N as f64).round().clamp(2.0, (N / 2) as f64) as usize;
        let m = mags[i0.max(1)..i1.max(i0 + 1)]
            .iter()
            .cloned()
            .fold(0.0f32, f32::max);
        // énfasis perceptual: comprime y acota a 0..1
        *slot = (1.0 - (-m * 6.0).exp()).clamp(0.0, 1.0);
    }
    out
}

/// Picos de la forma de onda de una pista (para la barra de progreso).
#[tauri::command]
fn waveform(app: tauri::AppHandle, path: String) -> Option<Vec<u8>> {
    waves::get_or_spawn(&app, Path::new(&path))
}

/// Escribe etiquetas en el archivo (B6) y actualiza la biblioteca.
#[tauri::command]
fn tags_write(
    app: tauri::AppHandle,
    path: String,
    title: String,
    artist: String,
    album: String,
) -> Result<(), String> {
    use lofty::file::TaggedFileExt;
    use lofty::prelude::*;

    let p = Path::new(&path);
    if !p.is_file() {
        return Err("el archivo no existe".into());
    }
    let mut tagged = lofty::read_from_path(p).map_err(|e| e.to_string())?;
    if tagged.primary_tag().is_none() && tagged.first_tag().is_none() {
        tagged.insert_tag(lofty::tag::Tag::new(lofty::tag::TagType::Id3v2));
    }
    let tag = match tagged.primary_tag_mut() {
        Some(t) => t,
        None => tagged
            .first_tag_mut()
            .ok_or("no se pudo crear una etiqueta para este archivo")?,
    };
    for (k, v) in [
        (ItemKey::TrackTitle, title.as_str()),
        (ItemKey::TrackArtist, artist.as_str()),
        (ItemKey::AlbumTitle, album.as_str()),
    ] {
        if v.trim().is_empty() {
            tag.remove_key(&k);
        } else {
            tag.insert_text(k, v.trim().to_string());
        }
    }
    tagged
        .save_to_path(p, lofty::config::WriteOptions::default())
        .map_err(|e| e.to_string())?;

    // refresca la entrada de la biblioteca con los metadatos reales
    {
        let st = app.state::<EnnState>();
        let mut lib = st.lib.lock().unwrap();
        if let Some(t) = lib.tracks.iter_mut().find(|t| t.path == path) {
            if let Some(fresh) = library::probe(p) {
                t.title = fresh.title;
                t.artist = fresh.artist;
                t.album = fresh.album;
                t.dur = fresh.dur.or(t.dur);
            }
        }
        lib.save(&st.lib_path);
    }
    Ok(())
}

#[tauri::command]
fn dbg_log(msg: String) {
    player::log_msg(&format!("UI: {msg}"));
}

// ---------------------------------------------------------------- descargador

/// Carpeta principal de la biblioteca; si no hay ninguna, None.
#[tauri::command]
fn get_download_dir(app: tauri::AppHandle) -> Result<String, String> {
    let st = app.state::<EnnState>();
    let folders = {
        let f = st.lib.lock().unwrap();
        f.folders.clone()
    };
    let cfg = app.state::<DownloaderConfig>();
    if let Some(custom) = cfg.dir.lock().unwrap().clone() {
        if std::path::Path::new(&custom).is_dir() {
            return Ok(custom);
        }
    }
    folders
        .first()
        .cloned()
        .ok_or_else(|| "agrega una carpeta de música primero (botón Carpeta)".to_string())
}

/// Cambia la carpeta donde se guardan las descargas (persistente).
#[tauri::command]
fn set_download_dir(app: tauri::AppHandle, dir: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&dir);
    if !path.is_dir() {
        return Err("esa carpeta no existe".to_string());
    }
    let cfg = app.state::<DownloaderConfig>();
    *cfg.dir.lock().unwrap() = Some(dir.clone());
    let _ = cfg.save();
    Ok(dir)
}

/// Config persistente del descargador (carpeta de salida).
#[derive(Default)]
pub struct DownloaderConfig {
    pub dir: std::sync::Mutex<Option<String>>,
    store: std::sync::Mutex<std::path::PathBuf>,
}

/// Carpeta base de las playlists (independiente de las carpetas de música).
fn playlists_base(app: &tauri::AppHandle) -> String {
    let st = app.state::<EnnState>();
    st.pl_dir.to_string_lossy().to_string()
}

/// Crea una playlist con un nombre dado.
#[tauri::command]
fn playlist_create(app: tauri::AppHandle, name: String) -> Result<plstores::PlaylistMeta, String> {
    plstores::create(&playlists_base(&app), &name)
}

/// Lista las playlists existentes.
#[tauri::command]
fn playlist_list(app: tauri::AppHandle) -> Vec<plstores::PlaylistMeta> {
    plstores::list(&playlists_base(&app))
}

/// Contenido de una playlist (con metadatos).
#[tauri::command]
fn playlist_content(app: tauri::AppHandle, name: String) -> Vec<library::Track> {
    let base = playlists_base(&app);
    let Ok(path) = plstores::resolve(&base, &name) else {
        return Vec::new();
    };
    plstores::content(&path)
}

/// Agrega una canción a una playlist. Devuelve 1 si se agregó, 0 si ya existía.
#[tauri::command]
fn playlist_add(
    app: tauri::AppHandle,
    name: String,
    track: library::Track,
) -> Result<usize, String> {
    plstores::add(&playlists_base(&app), &name, &track)
}

/// Quita una canción de una playlist.
#[tauri::command]
fn playlist_remove(app: tauri::AppHandle, name: String, path: String) -> Result<usize, String> {
    plstores::remove(&playlists_base(&app), &name, &path)
}

/// Ruta completa donde viven las playlists (para mostrarlo en la UI).
#[tauri::command]
fn playlist_dir(app: tauri::AppHandle) -> String {
    playlists_base(&app)
}

impl DownloaderConfig {
    pub fn new(store: std::path::PathBuf) -> Self {
        let cfg = DownloaderConfig {
            dir: std::sync::Mutex::new(None),
            store: std::sync::Mutex::new(store),
        };
        if let Ok(guard) = cfg.store.lock() {
            let p = guard.clone();
            drop(guard);
            if let Ok(s) = std::fs::read_to_string(&p) {
                if let Ok(v) = serde_json::from_str::<Option<String>>(&s) {
                    *cfg.dir.lock().unwrap() = v;
                }
            }
        }
        cfg
    }

    pub fn save(&self) -> Result<(), String> {
        let store = self.store.lock().unwrap().clone();
        let dir = self.dir.lock().unwrap().clone();
        let json = serde_json::to_string(&dir).map_err(|e| e.to_string())?;
        std::fs::write(&store, json).map_err(|e| e.to_string())
    }
}

/// Encola la descarga de audio (YouTube, SoundCloud, Bandcamp… vía yt-dlp)
/// en la carpeta indicada, convirtiendo al formato elegido.
#[tauri::command]
fn download_music(
    app: tauri::AppHandle,
    url: String,
    dir: String,
    fmt: Option<String>,
) -> Result<serde_json::Value, String> {
    use player::log_msg;
    if !std::path::Path::new(&dir).is_dir() {
        return Err("la carpeta de descargas no existe; elige otra (botón Cambiar carpeta)".into());
    }
    if !url.contains("://") {
        return Err("eso no parece una URL; pega el enlace completo (https://…)".into());
    }
    let bin = downloader::yt_dlp_path();
    if !bin.exists() {
        return Err(format!(
            "no se encontró yt-dlp en {}; reinicia la aplicación",
            bin.display()
        ));
    }
    let fmt = match fmt.as_deref() {
        Some("mp3") => "mp3",
        Some("flac") => "flac",
        _ => "m4a",
    };
    log_msg(&format!("descarga solicitada: {url} -> {dir} ({fmt})"));
    let d = app.state::<downloader::Downloader>();
    // si `url` es una lista de reproducción, enqueue() la expande en varias
    // tareas (una por vídeo); ids trae todos los ids creados, en orden
    let ids = d.enqueue(url, std::path::PathBuf::from(&dir), fmt.into());
    Ok(serde_json::json!({ "id": ids.first().copied(), "ids": ids }))
}

#[tauri::command]
fn download_list(app: tauri::AppHandle) -> Vec<downloader::DownloadTask> {
    app.state::<downloader::Downloader>().list()
}

/// Cancela una descarga por id (mata el proceso o la saca de la cola).
#[tauri::command]
fn download_cancel(app: tauri::AppHandle, id: u64) -> Result<(), String> {
    app.state::<downloader::Downloader>().cancel(id)
}

#[tauri::command]
fn get_state(app: tauri::AppHandle) -> serde_json::Value {
    let p = app.state::<Player>();
    let core = p.core.lock().unwrap();
    serde_json::json!({
        "state": match core.cur.as_ref().map(|t| t.state) {
            Some(PlayState::Playing) => "playing",
            Some(PlayState::Paused) => "paused",
            _ => "idle",
        },
        "path": core.cur.as_ref().map(|t| t.path.to_string_lossy().to_string()),
        "title": core.cur.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
        "artist": core.cur.as_ref().map(|t| t.artist.clone()).unwrap_or_default(),
        "pos": core.cur.as_ref().map(|t| t.pos_sec).unwrap_or(0.0),
        "dur": core.cur.as_ref().and_then(|t| t.dur),
        // calidad de la fuente (no del dispositivo de salida): tasa y
        // profundidad nativas del archivo, más una tasa de bits media
        // aproximada a partir del tamaño en disco — útil para lossy sin
        // bitrate declarado (VBR). None cuando no aplica (p. ej. streams
        // sin duración conocida).
        "sample_rate": core.cur.as_ref().map(|t| t.dec.sample_rate),
        "bits_per_sample": core.cur.as_ref().and_then(|t| t.dec.bits_per_sample),
        "bitrate_kbps": core.cur.as_ref().and_then(|t| {
            let dur = t.dur.filter(|d| *d > 0.0)?;
            let bytes = std::fs::metadata(&t.path).ok()?.len();
            Some(((bytes as f64 * 8.0) / dur / 1000.0).round() as u32)
        }),
        "volume": core.master,
        "balance": core.balance,
        "eq": core.eq.bands_db,
        "bass": core.eq.bass_db,
        "treble": core.eq.treble_db,
        "fade": core.fade_secs,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            // atajos globales de sistema (funcionan aunque Enn no tenga foco)
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    let p = app.state::<Player>();
                    if shortcut == &"ctrl+alt+p".parse().unwrap() {
                        p.toggle();
                    } else if shortcut == &"ctrl+alt+right".parse().unwrap() {
                        let _ = app.emit("enn://media", "next");
                    } else if shortcut == &"ctrl+alt+left".parse().unwrap() {
                        let _ = app.emit("enn://media", "prev");
                    } else if shortcut == &"ctrl+alt+s".parse().unwrap() {
                        p.stop();
                    } else if shortcut == &"ctrl+alt+m".parse().unwrap() {
                        let _ = app.emit("enn://ui", "mixer");
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            // cerrar = minimizar a la bandeja; salir de verdad desde el menú de la bandeja
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let app = window.app_handle();
                app.state::<downloader::Downloader>().shutdown();
                app.state::<Player>().stop();
            }
        })
        .setup(|app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            // bandeja del sistema con controles básicos
            if let Some(icon) = app.default_window_icon().cloned() {
                let play = MenuItem::with_id(app, "play", "Reproducir/Pausar", true, None::<&str>)?;
                let next = MenuItem::with_id(app, "next", "Siguiente", true, None::<&str>)?;
                let prev = MenuItem::with_id(app, "prev", "Anterior", true, None::<&str>)?;
                let show = MenuItem::with_id(app, "show", "Mostrar Enn", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&prev, &play, &next, &show, &quit])?;
                TrayIconBuilder::with_id("enn-tray")
                    .icon(icon)
                    .tooltip("Enn")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, ev| {
                        let p = app.state::<Player>();
                        match ev.id().as_ref() {
                            "play" => p.toggle(),
                            "next" => {
                                let _ = app.emit("enn://media", "next");
                            }
                            "prev" => {
                                let _ = app.emit("enn://media", "prev");
                            }
                            "show" => {
                                if let Some(w) = app.get_webview_window("main") {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                            "quit" => {
                                app.state::<downloader::Downloader>().shutdown();
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, ev| {
                        // clic izquierdo en el icono: mostrar/restaurar la ventana
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = ev
                        {
                            let app = tray.app_handle();
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }
            // atajos globales
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                let gs = app.global_shortcut();
                for sc in [
                    "ctrl+alt+p",
                    "ctrl+alt+right",
                    "ctrl+alt+left",
                    "ctrl+alt+s",
                    "ctrl+alt+m",
                ] {
                    if let Err(e) = gs.register(sc) {
                        player::log_msg(&format!("atajo global {sc} no disponible: {e}"));
                    }
                }
            }
            // modo portable: si existe «Enn.portable» junto al ejecutable, todos
            // los datos viven en «Enn Data» al lado del .exe y no en %APPDATA%
            let dir = {
                let exe_dir = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.parent().map(|p| p.to_path_buf()));
                match exe_dir {
                    Some(d) if d.join("Enn.portable").is_file() => {
                        let pd = d.join("Enn Data");
                        std::fs::create_dir_all(&pd).ok();
                        pd
                    }
                    _ => app.path().app_config_dir().unwrap_or_default(),
                }
            };
            let _ = std::fs::create_dir_all(&dir);
            let lib_path = dir.join("library.json");
            let set_path = dir.join("settings.json");
            let pl_dir = dir.join(plstores::PLAYLIST_FOLDER);
            let _ = std::fs::create_dir_all(&pl_dir);
            let art_dir = dir.join("ArtCache");
            let _ = std::fs::create_dir_all(&art_dir);
            let player = Player::new(app.handle().clone());
            app.manage(player);
            app.manage(EnnState {
                lib: Mutex::new(Library::load(&lib_path)),
                lib_path,
                set_path: set_path.clone(),
                pl_dir,
                art_dir,
            });
            let settings = load_settings(&set_path);
            apply_settings(app.handle(), &settings);
            let p = app.state::<Player>();
            p.start();
            app.manage(downloader::Downloader::new(app.handle().clone()));
            app.manage(DownloaderConfig::new(dir.join("download_dir.json")));
            app.manage(RgState::default());
            app.manage(waves::WaveState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            play_file,
            prime_file,
            toggle_pause,
            stop,
            seek_to,
            set_volume,
            set_balance,
            set_eq,
            set_param_band,
            set_exclusive,
            set_fade,
            set_current_gain,
            list_devices,
            select_device,
            lib_add,
            lib_refresh,
            lib_clear,
            lib_list,
            lib_folders,
            lib_set_favorite,
            probe_paths,
            playlist_save,
            playlist_load,
            settings_get,
            settings_set,
            dbg_log,
            get_download_dir,
            set_download_dir,
            download_music,
            download_list,
            download_cancel,
            playlist_create,
            playlist_list,
            playlist_content,
            playlist_add,
            playlist_remove,
            playlist_dir,
            album_art,
            rg_scan_start,
            reveal_in_folder,
            get_spectrum,
            waveform,
            tags_write,
            get_state
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Enn");
}
