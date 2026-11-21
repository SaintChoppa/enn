// el enlazador de MSVC emite una nota informativa al crear enn_lib.dll: no es código muerto
#![allow(linker_messages)]

mod art;
mod decode;
mod downloader;
mod dsp;
mod enrich;
// la salida exclusiva (WASAPI) solo existe en Windows
#[cfg(target_os = "windows")]
mod exclusive;
mod features;
mod fsutil;
mod insights;
mod jobs;
mod library;
mod media_keys;
mod perf;
mod player;
mod plstores;
mod preview;
mod radio;
mod rg;
mod taxonomy;
mod tools;
mod viz;
mod waves;
mod ytmusic;

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
    /// «Descargas a la vez»: 0 = Auto (3), si no 1–6 (Sprint 2)
    pub dl_parallel: u8,
    /// «Limitar velocidad» de las descargas en KiB/s (0 = sin límite)
    pub dl_rate_kib: u32,
    /// «Enriquecer con datos en línea» (Sprint 3; encendido de fábrica)
    pub enrich_online: bool,
    /// clave de Last.fm (opcional; vacía = sin Last.fm)
    pub lastfm_key: String,
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
            dl_parallel: 0,
            dl_rate_kib: 0,
            enrich_online: true,
            lastfm_key: String::new(),
        }
    }
}

fn load_settings(path: &Path) -> Settings {
    let Ok(s) = std::fs::read_to_string(path) else {
        return Settings::default();
    };
    serde_json::from_str(&s).unwrap_or_else(|e| {
        // dañado: se aparta (no se pierde) y se arranca con valores por defecto
        let moved = fsutil::quarantine(path);
        player::log_error(&format!(
            "settings.json no se pudo leer ({e}); apartado en {moved:?}"
        ));
        Settings::default()
    })
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
    if let Some(ins) = app.try_state::<InsightsState>() {
        ins.online
            .store(s.enrich_online, std::sync::atomic::Ordering::SeqCst);
        *ins.lastfm_key.lock().unwrap() = s.lastfm_key.clone();
    }
    // al arrancar el descargador aún no existe: se aplica al crearlo
    if let Some(d) = app.try_state::<downloader::Downloader>() {
        d.set_limits(s.dl_parallel as usize, s.dl_rate_kib as u64);
    }
}

// ---------------------------------------------------------------- audio

/// `gain_db`: ganancia de la pista (normalización + ajuste manual) aplicada
/// desde la primera muestra. Antes se mandaba después de empezar a sonar y el
/// arranque de una canción fuerte se oía a todo volumen (2026-11-12).
#[tauri::command]
fn play_file(
    app: tauri::AppHandle,
    path: String,
    dur: Option<f64>,
    gain_db: Option<f64>,
) -> Result<(), String> {
    app.state::<Player>()
        .play_path(Path::new(&path), gain_db.unwrap_or(0.0) as f32, dur)
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
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn list_devices() -> Result<Vec<String>, String> {
    off_main(player::list_output_devices).await
}

#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn select_device(app: tauri::AppHandle, name: Option<String>) -> Result<(), String> {
    off_main(move || app.state::<Player>().select_output(name)).await?
}

// ---------------------------------------------------------------- librería

/// Ejecuta `f` fuera del hilo de la ventana. Los comandos de Tauri sin
/// `async` corren en el hilo principal: escanear una carpeta, leer carátulas o
/// medir archivos la dejaban congelada mientras duraba (revisión 2026-11-12).
async fn off_main<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn lib_add(app: tauri::AppHandle, folder: String) -> Result<library::AddResult, String> {
    off_main(move || {
        let st = app.state::<EnnState>();
        let mut lib = st.lib.lock().unwrap();
        lib.scan_into(&folder, &st.lib_path)
    })
    .await
}

#[tauri::command]
async fn lib_refresh(app: tauri::AppHandle) -> Result<library::AddResult, String> {
    off_main(move || {
        let st = app.state::<EnnState>();
        let mut lib = st.lib.lock().unwrap();
        lib.refresh(&st.lib_path)
    })
    .await
}

#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn lib_clear(app: tauri::AppHandle) -> Result<(), String> {
    off_main(move || {
        let st = app.state::<EnnState>();
        let mut lib = st.lib.lock().unwrap();
        lib.clear(&st.lib_path);
    })
    .await
}

#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn lib_list(app: tauri::AppHandle) -> Result<Vec<Track>, String> {
    off_main(move || {
        let st = app.state::<EnnState>();
        let mut l = st.lib.lock().unwrap();
        // las pistas indexadas antes de existir `mtime` la reciben aquí, en
        // memoria; se guarda con la biblioteca la próxima vez que se escriba
        library::fill_mtimes(&mut l.tracks);
        l.tracks.clone()
    })
    .await
}

#[tauri::command]
fn lib_folders(app: tauri::AppHandle) -> Vec<String> {
    let st = app.state::<EnnState>();
    let l = st.lib.lock().unwrap();
    l.folders.clone()
}

/// Obtiene metadatos de un conjunto de archivos sin indexarlos.
#[tauri::command]
async fn probe_paths(paths: Vec<String>) -> Result<library::ProbeMany, String> {
    off_main(move || {
        let p: Vec<std::path::PathBuf> = paths.iter().map(Path::new).map(Into::into).collect();
        library::probe_many(&p)
    })
    .await
}

/// Marca/desmarca una pista de la biblioteca como favorita.
#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn lib_set_favorite(
    app: tauri::AppHandle,
    path: String,
    favorite: bool,
) -> Result<(), String> {
    off_main(move || {
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
    })
    .await?
}

/// Quita una pista del índice de la biblioteca (no borra el archivo).
#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn lib_remove_track(app: tauri::AppHandle, path: String) -> Result<(), String> {
    off_main(move || {
        let st = app.state::<EnnState>();
        let mut lib = st.lib.lock().unwrap();
        if lib.remove_track(&path, &st.lib_path) {
            Ok(())
        } else {
            Err("la pista no está en la biblioteca".into())
        }
    })
    .await?
}

// ---------------------------------------------------------------- playlists

#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn playlist_save(
    app: tauri::AppHandle,
    path: String,
    tracks: Vec<Track>,
) -> Result<(), String> {
    off_main(move || {
        let _ = app;
        library::write_m3u(Path::new(&path), &tracks)
    })
    .await?
}

#[tauri::command]
async fn playlist_load(path: String) -> Result<Vec<Track>, String> {
    off_main(move || {
        library::read_m3u(Path::new(&path))
            .iter()
            .filter_map(|p| library::probe(Path::new(p)))
            .collect()
    })
    .await
}

// ---------------------------------------------------------------- ajustes

#[tauri::command]
fn settings_get(app: tauri::AppHandle) -> Settings {
    let st = app.state::<EnnState>();
    load_settings(&st.set_path)
}

#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn settings_set(app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
    off_main(move || {
        apply_settings(&app, &settings);
        let st = app.state::<EnnState>();
        serde_json::to_string_pretty(&settings)
            .map_err(|e| e.to_string())
            .and_then(|s| {
                fsutil::write_atomic(&st.set_path, s.as_bytes()).map_err(|e| e.to_string())
            })
    })
    .await?
}

// ---------------------------------------------------------------- carátulas

/// Data URI de la carátula de un archivo (para `img src` en la UI).
#[tauri::command]
async fn album_art(app: tauri::AppHandle, path: String) -> Result<Option<String>, String> {
    off_main(move || {
        let st = app.state::<EnnState>();
        art::data_uri(&st.art_dir, Path::new(&path))
    })
    .await
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
            // solo los que existen AHORA: si se cuela un archivo ya borrado,
            // el contador no cuadra y el progreso nunca llega a `finished`
            .filter(|t| t.rg.is_none() && std::path::Path::new(&t.path).is_file())
            .map(|t| t.path.clone())
            .collect()
    };
    let total = pending.len();
    if total == 0 {
        state.running.store(false, Ordering::SeqCst);
        return Ok(0);
    }
    std::thread::spawn(move || {
        // en paralelo, en el grupo de fondo (Sprint 1, T7): antes, una pista
        // detrás de otra en un solo hilo
        let done = std::sync::atomic::AtomicUsize::new(0);
        jobs::for_each(&pending, |path| {
            // el archivo pudo desaparecer entre la foto y este momento: se
            // salta el análisis, pero el progreso se emite igual — antes el
            // `continue` se comía también el emit y `finished` no llegaba nunca
            let lufs = if std::path::Path::new(path).is_file() {
                rg::analyze_lufs(Path::new(path))
            } else {
                None
            };
            let n = {
                let st = app.state::<EnnState>();
                let mut lib = st.lib.lock().unwrap();
                if let Some(t) = lib.tracks.iter_mut().find(|t| &t.path == path) {
                    t.rg = lufs;
                }
                let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                // guarda cada 25 archivos para no perder trabajo si se cierra
                if n.is_multiple_of(25) || n == total {
                    lib.save(&st.lib_path);
                }
                n
            };
            // la ruta y su sonoridad viajan en el evento: la interfaz actualiza
            // esa pista sin releer toda la biblioteca (y, si es la que suena,
            // ajusta su volumen al momento)
            let _ = app.emit(
                "enn://rg",
                serde_json::json!({
                    "done": n,
                    "total": total,
                    "finished": n == total,
                    "path": path,
                    "lufs": lufs,
                }),
            );
        });
        app.state::<RgState>()
            .running
            .store(false, Ordering::SeqCst);
    });
    Ok(total)
}

/// Sonoridad (LUFS) de una sola pista, para la que va a sonar o la siguiente
/// cuando aún no está analizada: no espera al análisis de toda la biblioteca.
/// Se guarda en la biblioteca si la pista está en ella.
#[tauri::command]
async fn rg_analyze(app: tauri::AppHandle, path: String) -> Result<Option<f64>, String> {
    off_main(move || {
        let lufs = rg::analyze_lufs(Path::new(&path));
        if lufs.is_some() {
            let st = app.state::<EnnState>();
            let mut lib = st.lib.lock().unwrap();
            if let Some(t) = lib.tracks.iter_mut().find(|t| t.path == path) {
                t.rg = lufs;
                lib.save(&st.lib_path);
            }
        }
        lufs
    })
    .await
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
    // el anillo va `lookahead_s()` por delante del altavoz: las barras leen
    // la ventana que está sonando AHORA, no la que sonará dentro de 90 ms
    let behind = ((c.lookahead_s() * c.out_rate as f32) as usize).min(len - N);
    let mut s = vec![0.0f32; N];
    for (i, slot) in s.iter_mut().enumerate() {
        let idx = (c.spec_pos + 2 * len - behind - N + i) % len;
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

/// Estado del analizador del visualizador (AGC, medias y refractarios).
#[derive(Default)]
struct VizState(Mutex<viz::VizAnalyzer>);

/// Un frame de análisis para el visualizador (Cinta/Traza, ADR #94).
///
/// Analiza la ventana más nueva del anillo, que va `la` segundos por delante
/// de lo que suena. Campos (nombres cortos: se pide una vez por frame):
/// `la` lookahead real (s) · `n` energías graves/medios/agudos 0..1 ·
/// `tone` tono dominante 0..1 · `conf` su confianza · `cen` centroide 0..1 ·
/// `on` ataques `[banda, fuerza, nivel]` · `dt` segundos de audio nuevo desde
/// la llamada anterior (0 = nada nuevo: en pausa) · `play` si hay pista sonando.
#[tauri::command]
fn get_viz_frame(app: tauri::AppHandle) -> serde_json::Value {
    let p = app.state::<Player>();
    let (samples, rate, total, la, play) = {
        let c = p.core.lock().unwrap();
        let n = viz::window_len(c.out_rate);
        let len = c.spec_buf.len();
        let mut s = vec![0.0f32; n];
        for (i, slot) in s.iter_mut().enumerate() {
            *slot = c.spec_buf[(c.spec_pos + len - n + i) % len];
        }
        let play = c
            .cur
            .as_ref()
            .map(|t| t.state == PlayState::Playing)
            .unwrap_or(false);
        (s, c.out_rate, c.spec_total, c.lookahead_s(), play)
    };
    // la FFT se hace fuera del cerrojo del motor: el hilo de audio no espera
    let st = app.state::<VizState>();
    let f = st.0.lock().unwrap().analyze(&samples, rate, total);
    let r3 = |x: f32| (x * 1000.0).round() / 1000.0;
    serde_json::json!({
        "la": r3(la),
        "n": [r3(f.n[0]), r3(f.n[1]), r3(f.n[2])],
        "tone": r3(f.tone),
        "conf": r3(f.conf),
        "cen": r3(f.centroid),
        "on": f.onsets.iter().map(|o| serde_json::json!([o.band, r3(o.strength), r3(o.level)])).collect::<Vec<_>>(),
        "dt": r3(f.dt),
        "play": play,
    })
}

/// Picos de la forma de onda de una pista (para la barra de progreso).
#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn waveform(app: tauri::AppHandle, path: String) -> Result<Option<Vec<u8>>, String> {
    off_main(move || waves::get_or_spawn(&app, Path::new(&path))).await
}

/// Escribe en `path` los campos presentes (`Some`); un campo en `None` no se
/// toca en absoluto (el batch lo usa para "no tocar artista/álbum en estas
/// pistas"), mientras que `Some("")` sí borra la clave — mismo comportamiento
/// que ya tenía el editor de una sola pista.
fn write_tags_partial(
    path: &str,
    title: Option<&str>,
    artist: Option<&str>,
    album: Option<&str>,
    genre: Option<&str>,
) -> Result<(), String> {
    use lofty::file::TaggedFileExt;
    use lofty::prelude::*;

    let p = Path::new(path);
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
        (ItemKey::TrackTitle, title),
        (ItemKey::TrackArtist, artist),
        (ItemKey::AlbumTitle, album),
        (ItemKey::Genre, genre),
    ] {
        let Some(v) = v else { continue };
        if v.trim().is_empty() {
            tag.remove_key(&k);
        } else {
            tag.insert_text(k, v.trim().to_string());
        }
    }
    tagged
        .save_to_path(p, lofty::config::WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// Refresca en la biblioteca en memoria los metadatos reales de `path` tras
/// escribirlos en el archivo (título/duración pueden no haber cambiado, pero
/// releerlos evita que la lista muestre algo distinto de lo que hay en disco).
fn refresh_lib_entry(app: &tauri::AppHandle, path: &str) {
    let st = app.state::<EnnState>();
    let mut lib = st.lib.lock().unwrap();
    if let Some(t) = lib.tracks.iter_mut().find(|t| t.path == path) {
        if let Some(fresh) = library::probe(Path::new(path)) {
            t.title = fresh.title;
            t.artist = fresh.artist;
            t.album = fresh.album;
            t.dur = fresh.dur.or(t.dur);
            t.genre = fresh.genre;
            t.year = fresh.year;
        }
    }
    lib.save(&st.lib_path);
}

/// Escribe etiquetas en el archivo (B6) y actualiza la biblioteca.
#[tauri::command]
async fn tags_write(
    app: tauri::AppHandle,
    path: String,
    title: String,
    artist: String,
    album: String,
    genre: Option<String>,
) -> Result<(), String> {
    off_main(move || {
        write_tags_partial(
            &path,
            Some(&title),
            Some(&artist),
            Some(&album),
            Some(genre.as_deref().unwrap_or("")),
        )?;
        refresh_lib_entry(&app, &path);
        Ok(())
    })
    .await?
}

#[derive(serde::Serialize)]
struct BatchTagResult {
    updated: usize,
    failed: usize,
    first_error: Option<String>,
}

/// Editor de etiquetas por lote: aplica `artist`/`album`/`genre` (cuando
/// vienen, `None` = no tocar ese campo) a varias pistas de una vez. El
/// título se deja fuera a propósito — cambiarlo igual en varias pistas casi
/// nunca es lo que se quiere.
#[tauri::command]
async fn tags_write_batch(
    app: tauri::AppHandle,
    paths: Vec<String>,
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
) -> Result<BatchTagResult, String> {
    off_main(move || tags_batch(&app, &paths, artist, album, genre)).await
}

fn tags_batch(
    app: &tauri::AppHandle,
    paths: &[String],
    artist: Option<String>,
    album: Option<String>,
    genre: Option<String>,
) -> BatchTagResult {
    let mut res = BatchTagResult {
        updated: 0,
        failed: 0,
        first_error: None,
    };
    for path in paths {
        match write_tags_partial(
            path,
            None,
            artist.as_deref(),
            album.as_deref(),
            genre.as_deref(),
        ) {
            Ok(()) => {
                refresh_lib_entry(app, path);
                res.updated += 1;
            }
            Err(e) => {
                res.failed += 1;
                if res.first_error.is_none() {
                    res.first_error = Some(format!("{path}: {e}"));
                }
            }
        }
    }
    res
}

#[tauri::command]
fn dbg_log(msg: String, level: Option<String>) {
    let line = format!("UI: {msg}");
    match level.as_deref() {
        Some("debug") => player::log_debug(&line),
        Some("warn") => player::log_warn(&line),
        Some("error") => player::log_error(&line),
        _ => player::log_msg(&line),
    }
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
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn playlist_create(
    app: tauri::AppHandle,
    name: String,
) -> Result<plstores::PlaylistMeta, String> {
    off_main(move || plstores::create(&playlists_base(&app), &name)).await?
}

/// Lista las playlists existentes.
#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn playlist_list(app: tauri::AppHandle) -> Result<Vec<plstores::PlaylistMeta>, String> {
    off_main(move || plstores::list(&playlists_base(&app))).await
}

/// Contenido de una playlist (con metadatos).
#[tauri::command]
async fn playlist_content(
    app: tauri::AppHandle,
    name: String,
) -> Result<Vec<library::Track>, String> {
    off_main(move || {
        let base = playlists_base(&app);
        let Ok(path) = plstores::resolve(&base, &name) else {
            return Vec::new();
        };
        plstores::content(&path)
    })
    .await
}

/// Agrega una canción a una playlist. Devuelve 1 si se agregó, 0 si ya existía.
#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn playlist_add(
    app: tauri::AppHandle,
    name: String,
    track: library::Track,
) -> Result<usize, String> {
    off_main(move || plstores::add(&playlists_base(&app), &name, &track)).await?
}

/// Quita una canción de una playlist.
#[tauri::command]
/// Fuera del hilo de la ventana (Sprint 1, T4): en el hilo principal bloqueaba la interfaz.
async fn playlist_remove(
    app: tauri::AppHandle,
    name: String,
    path: String,
) -> Result<usize, String> {
    off_main(move || plstores::remove(&playlists_base(&app), &name, &path)).await?
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
        fsutil::write_atomic(&store, json.as_bytes()).map_err(|e| e.to_string())
    }
}

/// Encola la descarga de audio (YouTube, SoundCloud, Bandcamp… vía yt-dlp)
/// en la carpeta indicada, convirtiendo al formato elegido.
/// Asíncrono: resolver una lista con yt-dlp tarda segundos y, como comando
/// síncrono, congelaba la ventana (auditoría 2026-11-12, bug #3).
#[tauri::command]
async fn download_music(
    app: tauri::AppHandle,
    url: String,
    dir: String,
    fmt: Option<String>,
) -> Result<serde_json::Value, String> {
    use player::log_msg;
    if !std::path::Path::new(&dir).is_dir() {
        return Err("la carpeta de descargas no existe; elige otra (botón Cambiar carpeta)".into());
    }
    if !downloader::is_valid_download_url(&url) {
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
    let fmt = fmt.to_string();
    // si `url` es una lista de reproducción, enqueue() la expande en varias
    // tareas (una por vídeo); ids trae todos los ids creados, en orden
    let ids = tauri::async_runtime::spawn_blocking(move || {
        app.state::<downloader::Downloader>()
            .enqueue(url, std::path::PathBuf::from(&dir), fmt)
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "id": ids.first().copied(), "ids": ids }))
}

/// Busca canciones y álbumes oficiales (YouTube Music; respaldo yt-dlp).
/// Asíncrono: la red no bloquea el hilo de la ventana.
#[tauri::command]
async fn music_search(query: String) -> ytmusic::SearchResult {
    tauri::async_runtime::spawn_blocking(move || ytmusic::search(&query))
        .await
        .unwrap_or(ytmusic::SearchResult {
            source: "ytmusic",
            offline: false,
            items: Vec::new(),
        })
}

/// Foto actual de un artista en YouTube Music (None si no se encuentra).
#[tauri::command]
async fn music_artist_photo(name: String) -> Result<Option<String>, String> {
    let name: String = name.chars().take(120).collect();
    tauri::async_runtime::spawn_blocking(move || ytmusic::artist_photo(&name))
        .await
        .map_err(|e| e.to_string())?
}

/// Canciones de un álbum de YouTube Music (por su `browse_id`).
#[tauri::command]
async fn music_album(browse_id: String) -> Result<ytmusic::AlbumDetail, String> {
    if !browse_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("identificador de álbum no válido".into());
    }
    tauri::async_runtime::spawn_blocking(move || ytmusic::album(&browse_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Una canción elegida en el buscador: id de vídeo y título para la lista.
#[derive(serde::Deserialize)]
struct PickedTrack {
    id: String,
    title: Option<String>,
}

/// Descarga canciones del buscador por su id de vídeo, sin resolverlas con
/// yt-dlp (ya se conocen). Devuelve los ids de tarea en el mismo orden.
#[tauri::command]
fn download_tracks(
    app: tauri::AppHandle,
    tracks: Vec<PickedTrack>,
    dir: String,
    fmt: Option<String>,
) -> Result<Vec<u64>, String> {
    if !std::path::Path::new(&dir).is_dir() {
        return Err("la carpeta de descargas no existe; elige otra en Ajustes".into());
    }
    let fmt = match fmt.as_deref() {
        Some("mp3") => "mp3",
        Some("flac") => "flac",
        _ => "m4a",
    };
    // el id de vídeo de YouTube es [A-Za-z0-9_-]{11}: cualquier otra cosa se
    // descarta antes de construir la URL que recibirá yt-dlp
    let entries: Vec<(String, Option<String>)> = tracks
        .into_iter()
        .filter(|t| {
            t.id.len() == 11
                && t.id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
        .map(|t| {
            (
                format!("https://music.youtube.com/watch?v={}", t.id),
                t.title,
            )
        })
        .collect();
    let d = app.state::<downloader::Downloader>();
    Ok(d.enqueue_known(entries, std::path::PathBuf::from(&dir), fmt.into()))
}

/// Vista previa de 10 s de un resultado del buscador (Sprint 2): suena por el
/// motor, que baja y pausa la canción en curso. Devuelve el tramo elegido.
#[tauri::command]
async fn preview_play(app: tauri::AppHandle, id: String) -> Result<serde_json::Value, String> {
    let (start, len) = off_main(move || {
        app.state::<preview::Previewer>()
            .play(&id, &app.state::<Player>())
    })
    .await??;
    Ok(serde_json::json!({ "start": start, "len": len }))
}

/// Resuelve de antemano (primeros resultados, pastilla bajo el ratón).
#[tauri::command]
async fn preview_prefetch(app: tauri::AppHandle, id: String) -> Result<(), String> {
    off_main(move || app.state::<preview::Previewer>().prefetch(&id)).await?
}

/// Ajustes → Descargas: versión de yt-dlp y última búsqueda de actualización.
#[tauri::command]
async fn tools_status() -> Result<serde_json::Value, String> {
    off_main(tools::status).await
}

/// «Buscar ahora»: actualiza yt-dlp si hay versión nueva (verificada).
#[tauri::command]
async fn tools_update() -> Result<Option<String>, String> {
    off_main(tools::update_now).await?
}

#[tauri::command]
fn preview_stop(app: tauri::AppHandle) {
    app.state::<preview::Previewer>()
        .stop(&app.state::<Player>());
}

// ---------------------------------------------------------------- escuchas, radio y recomendaciones (Sprint 3)

/// Almacén de escuchas (`insights.json`) y sesión de la radio.
pub struct InsightsState {
    pub data: Mutex<insights::Insights>,
    pub path: std::path::PathBuf,
    pub session: Mutex<radio::Session>,
    pub tuner: Mutex<radio::Tuner>,
    /// ajustes del enriquecimiento (de `settings.json`)
    pub online: std::sync::atomic::AtomicBool,
    pub lastfm_key: Mutex<String>,
    /// hay una pasada de etiquetas en marcha
    pub enriching: std::sync::atomic::AtomicBool,
}

impl InsightsState {
    fn save_soon(app: &tauri::AppHandle) {
        let app = app.clone();
        jobs::spawn(move || {
            let st = app.state::<InsightsState>();
            let snap = st.data.lock().unwrap().clone();
            if let Err(e) = snap.save(&st.path) {
                player::log_warn(&format!("no se pudo guardar insights.json: {e}"));
            }
        });
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn norm_artists(a: &str) -> Vec<String> {
    enrich::split_artists(a)
        .iter()
        .map(|x| taxonomy::norm(x))
        .filter(|x| !x.is_empty())
        .collect()
}

/// La biblioteca vista por la radio, con lo que se sabe de cada canción.
fn song_views(tracks: &[library::Track], ins: &insights::Insights) -> Vec<radio::SongView> {
    tracks
        .iter()
        .map(|t| {
            let key = insights::song_key(&t.path, t.yt_id.as_deref());
            let s = ins.songs.get(&key).cloned().unwrap_or_default();
            radio::SongView {
                key,
                artists: norm_artists(&t.artist),
                title: t.title.clone(),
                tags: s.tags,
                bpm: s.bpm,
                energy: s.energy,
                loudness: t.rg.map(|x| x as f32),
                plays: s.plays,
                completions: s.completions,
                skips: s.skips,
                favorite: t.favorite,
                last_played: s.last_played,
                last_skip: s.last_skip,
            }
        })
        .collect()
}

/// Vecinas (radio de YouTube Music) y costumbres desde la canción `cur`.
fn rel_for(views: &[radio::SongView], cur: Option<usize>, ins: &insights::Insights) -> radio::Rel {
    let mut rel = radio::Rel::default();
    let Some(c) = cur else { return rel };
    let key = &views[c].key;
    let pos: std::collections::HashMap<&str, usize> = views
        .iter()
        .enumerate()
        .map(|(i, v)| (v.key.as_str(), i))
        .collect();
    if let Some(s) = ins.songs.get(key) {
        for (rank, k) in s.neighbors.iter().enumerate() {
            if let Some(i) = pos.get(k.as_str()) {
                rel.neighbor_rank.insert(*i, rank);
            }
        }
    }
    if let Some(row) = ins.trans.get(key) {
        for (k, n) in row {
            if let Some(i) = pos.get(k.as_str()) {
                rel.trans.insert(*i, *n);
            }
        }
    }
    rel
}

fn track_list(app: &tauri::AppHandle) -> Vec<library::Track> {
    app.state::<EnnState>().lib.lock().unwrap().tracks.clone()
}

/// La interfaz avisa de lo que pasa con cada canción: `start` (con `manual`
/// si la eligió el usuario), `end` (terminó entera) o `leave` (la dejó en
/// `pos`). Alimenta el almacén de escuchas y la sesión de la radio.
#[tauri::command]
async fn insights_event(
    app: tauri::AppHandle,
    kind: String,
    path: String,
    pos: Option<f64>,
    dur: Option<f64>,
    manual: Option<bool>,
    to: Option<f64>,
) -> Result<(), String> {
    off_main(move || {
        let tracks = track_list(&app);
        let Some(t) = tracks.iter().find(|t| t.path == path) else {
            return;
        };
        let st = app.state::<InsightsState>();
        let key = insights::song_key(&t.path, t.yt_id.as_deref());
        let now = now_secs();
        let dur = dur.or(t.dur).unwrap_or(0.0);
        let view = {
            let mut d = st.data.lock().unwrap();
            match kind.as_str() {
                "start" => d.on_start(&key, dur, manual.unwrap_or(false), now),
                "end" => d.on_end(&key, now),
                "leave" => d.on_leave(&key, pos.unwrap_or(0.0), now),
                "seek" => {
                    d.on_seek(&key, pos.unwrap_or(0.0), to.unwrap_or(0.0));
                    return;
                }
                _ => return,
            }
            song_views(std::slice::from_ref(t), &d).remove(0)
        };
        let mut ses = st.session.lock().unwrap();
        match kind.as_str() {
            "start" if manual.unwrap_or(false) => ses.on_manual(&view),
            "end" => ses.on_end(&view),
            "leave" if insights::is_skip(pos.unwrap_or(0.0), dur) => ses.on_skip(&view),
            "leave" => ses.on_end(&view),
            _ => {}
        }
        drop(ses);
        if kind != "start" {
            InsightsState::save_soon(&app);
        }
    })
    .await
}

/// Pasa el historial viejo de la interfaz (`enn.history`) al almacén, una vez.
#[tauri::command]
async fn insights_migrate(
    app: tauri::AppHandle,
    entries: Vec<(String, u64)>,
) -> Result<(), String> {
    off_main(move || {
        let tracks = track_list(&app);
        let keyed: Vec<(String, u64)> = entries
            .into_iter()
            .map(|(p, ts)| {
                let yt = tracks
                    .iter()
                    .find(|t| t.path == p)
                    .and_then(|t| t.yt_id.clone());
                // el historial guardaba milisegundos
                (insights::song_key(&p, yt.as_deref()), ts / 1000)
            })
            .collect();
        let st = app.state::<InsightsState>();
        let migrated = {
            let mut d = st.data.lock().unwrap();
            let was = d.migrated;
            d.migrate_history(&keyed);
            !was
        };
        if migrated {
            InsightsState::save_soon(&app);
        }
    })
    .await
}

/// Siguiente(s) de la radio para después de `cur`: ruta y motivo de cada una.
#[tauri::command]
async fn radio_next(
    app: tauri::AppHandle,
    cur: Option<String>,
    n: Option<usize>,
    exclude: Option<Vec<String>>,
) -> Result<Vec<serde_json::Value>, String> {
    off_main(move || {
        let mut tracks = track_list(&app);
        if let Some(ex) = &exclude {
            tracks.retain(|t| !ex.contains(&t.path) || cur.as_deref() == Some(t.path.as_str()));
        }
        let st = app.state::<InsightsState>();
        let (views, rel, ci) = {
            let d = st.data.lock().unwrap();
            let views = song_views(&tracks, &d);
            let ci = cur
                .as_ref()
                .and_then(|c| tracks.iter().position(|t| &t.path == c));
            let rel = rel_for(&views, ci, &d);
            (views, rel, ci)
        };
        let tuner = *st.tuner.lock().unwrap();
        let mut ses = st.session.lock().unwrap();
        radio::pick_next(
            &views,
            ci,
            &rel,
            &mut ses,
            &tuner,
            now_secs(),
            n.unwrap_or(1).clamp(1, 10),
        )
        .into_iter()
        .map(|p| serde_json::json!({ "path": tracks[p.index].path, "reason": p.reason }))
        .collect()
    })
    .await
}

/// Afinador de la radio (menú del botón de radio).
#[tauri::command]
fn radio_tuner_set(app: tauri::AppHandle, variety: u8, selection: f32, coherence: f32) {
    *app.state::<InsightsState>().tuner.lock().unwrap() = radio::Tuner {
        variety: variety.min(2),
        selection: selection.clamp(-1.0, 1.0),
        coherence: coherence.clamp(-1.0, 1.0),
    };
}

/// Menú de recomendaciones: hasta 3 para después de `path`. Primero lo que
/// más has escuchado después de ella; si no hay historial, las del motor.
/// `exclude`: lo que ya está en «Siguientes».
#[tauri::command]
async fn reco_for(
    app: tauri::AppHandle,
    path: String,
    exclude: Vec<String>,
) -> Result<serde_json::Value, String> {
    off_main(move || {
        let tracks = track_list(&app);
        let st = app.state::<InsightsState>();
        let d = st.data.lock().unwrap();
        let Some(ci) = tracks.iter().position(|t| t.path == path) else {
            return serde_json::json!({ "kind": "none", "items": [] });
        };
        let views = song_views(&tracks, &d);
        let plays = views[ci].plays;
        let skip = |i: usize| i == ci || exclude.contains(&tracks[i].path);
        let mut habit: Vec<(usize, u32)> = rel_for(&views, Some(ci), &d)
            .trans
            .into_iter()
            .filter(|(i, n)| *n >= 2 && !skip(*i))
            .collect();
        habit.sort_by_key(|h| std::cmp::Reverse(h.1));
        habit.truncate(3);
        if !habit.is_empty() {
            let items: Vec<_> = habit
                .iter()
                .map(|(i, n)| {
                    serde_json::json!({ "path": tracks[*i].path, "reason": format!("La has puesto después {n} veces") })
                })
                .collect();
            return serde_json::json!({ "kind": "habit", "items": items, "plays": plays });
        }
        let rel = rel_for(&views, Some(ci), &d);
        // una sesión aparte: mirar recomendaciones no cambia la radio
        let mut ses = st.session.lock().unwrap().clone();
        let tuner = *st.tuner.lock().unwrap();
        let picks: Vec<_> = radio::pick_next(&views, Some(ci), &rel, &mut ses, &tuner, now_secs(), 6)
            .into_iter()
            .filter(|p| !skip(p.index))
            .take(3)
            .map(|p| serde_json::json!({ "path": tracks[p.index].path, "reason": p.reason }))
            .collect();
        serde_json::json!({ "kind": "engine", "items": picks, "plays": plays })
    })
    .await
}

/// Cuántas pistas tienen etiquetas reales (Ajustes y medidas).
#[tauri::command]
async fn enrich_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    off_main(move || {
        let tracks = track_list(&app);
        let st = app.state::<InsightsState>();
        let d = st.data.lock().unwrap();
        let tagged = tracks
            .iter()
            .filter(|t| {
                d.songs
                    .get(&insights::song_key(&t.path, t.yt_id.as_deref()))
                    .is_some_and(|s| !s.tags.is_empty())
            })
            .count();
        serde_json::json!({
            "tagged": tagged,
            "total": tracks.len(),
            "running": st.enriching.load(std::sync::atomic::Ordering::SeqCst),
        })
    })
    .await
}

/// «Buscar etiquetas ahora» (Ajustes).
#[tauri::command]
fn enrich_now(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        enrich_pass(&app);
    });
}

/// Una pasada completa: id de YouTube que falte, rasgos sonoros (local) y
/// etiquetas (en línea si está encendido). Avisa con `enrich://done`.
/// Devuelve si se quedó sin conexión (para reintentar antes), o `None` si
/// ya había otra pasada en marcha.
fn enrich_pass(app: &tauri::AppHandle) -> Option<bool> {
    use std::sync::atomic::Ordering;
    let st = app.state::<InsightsState>();
    if st.enriching.swap(true, Ordering::SeqCst) {
        return None;
    }
    // 1. id de YouTube de las pistas indexadas antes del Sprint 3
    fill_yt_ids(app);
    // limpieza semanal: fuera lo de canciones que ya no están en la biblioteca
    {
        let keep: std::collections::HashSet<String> = track_list(app)
            .iter()
            .map(|t| insights::song_key(&t.path, t.yt_id.as_deref()))
            .collect();
        let gone = st.data.lock().unwrap().prune_missing(&keep, now_secs());
        if gone > 0 {
            player::log_msg(&format!(
                "escuchas: {gone} canciones que ya no están, retiradas"
            ));
        }
    }
    let tracks = track_list(app);
    // 2. rasgos sonoros de las que no los tienen (sin red, en el grupo de fondo)
    let need: Vec<(String, String)> = {
        let d = st.data.lock().unwrap();
        tracks
            .iter()
            .map(|t| {
                (
                    t.path.clone(),
                    insights::song_key(&t.path, t.yt_id.as_deref()),
                )
            })
            .filter(|(_, k)| d.songs.get(k).is_none_or(|s| s.energy.is_none()))
            .collect()
    };
    let feats = jobs::map(&need, |(p, _)| {
        features::analyze_file(std::path::Path::new(p))
    });
    {
        let mut d = st.data.lock().unwrap();
        for ((_, k), f) in need.iter().zip(feats) {
            if let Some(f) = f {
                let s = d.songs.entry(k.clone()).or_default();
                s.energy = Some(f.energy);
                s.brightness = Some(f.brightness);
                if s.bpm.is_none() {
                    s.bpm = f.bpm;
                }
            }
        }
    }
    // 3. etiquetas
    let cfg = enrich::Cfg {
        online: st.online.load(Ordering::SeqCst),
        lastfm_key: Some(st.lastfm_key.lock().unwrap().clone()).filter(|k| !k.trim().is_empty()),
        now: now_secs(),
        pause: true,
    };
    let app2 = app.clone();
    let out = enrich::run_pass(
        &tracks,
        &st.data,
        &enrich::Http::default(),
        &cfg,
        &move |done, total| {
            let _ = app2.emit(
                "enrich://progress",
                serde_json::json!({ "done": done, "total": total }),
            );
        },
    );
    let snap = st.data.lock().unwrap().clone();
    let _ = snap.save(&st.path);
    st.enriching.store(false, Ordering::SeqCst);
    player::log_msg(&format!(
        "etiquetas: {} de {} pistas con etiquetas reales{}",
        out.tagged,
        out.total,
        if out.offline {
            " (sin conexión: se reintenta luego)"
        } else {
            ""
        }
    ));
    let _ = app.emit(
        "enrich://done",
        serde_json::json!({ "tagged": out.tagged, "total": out.total, "offline": out.offline }),
    );
    Some(out.offline)
}

/// Rellena el id de YouTube de las pistas que no lo tienen (leyendo la
/// etiqueta `comment`) y pasa sus escuchas guardadas por ruta a la clave
/// `yt:` (si no, quedarían huérfanas). Se puede repetir sin efecto.
fn fill_yt_ids(app: &tauri::AppHandle) {
    let ennst = app.state::<EnnState>();
    let st = app.state::<InsightsState>();
    // una vez, todas: el año real («Released on: …») también llega a las
    // pistas indexadas antes del Sprint 3, que guardaban el año de subida
    let all = !st.data.lock().unwrap().years_synced;
    let todo: Vec<String> = ennst
        .lib
        .lock()
        .unwrap()
        .tracks
        .iter()
        .filter(|t| all || t.yt_id.is_none())
        .map(|t| t.path.clone())
        .collect();
    let read: Vec<(String, Option<String>, Option<u32>)> = jobs::map(&todo, |p| {
        decode::Decoder::open(std::path::Path::new(p))
            .ok()
            .map(|(_, o)| (p.clone(), o.tags.yt_id, o.tags.year))
    })
    .into_iter()
    .flatten()
    .collect();
    let mut changed = 0;
    {
        let mut lib = ennst.lib.lock().unwrap();
        for (p, id, year) in &read {
            if let Some(t) = lib.tracks.iter_mut().find(|t| &t.path == p) {
                if t.yt_id.is_none() && id.is_some() {
                    t.yt_id = id.clone();
                    changed += 1;
                }
                if year.is_some() && t.year != *year {
                    t.year = *year;
                    changed += 1;
                }
            }
        }
        if changed > 0 {
            lib.save(&ennst.lib_path);
        }
    }
    if all {
        st.data.lock().unwrap().years_synced = true;
        InsightsState::save_soon(app);
    }
    let pairs: Vec<(String, String)> = track_list(app)
        .iter()
        .filter_map(|t| {
            let id = t.yt_id.as_deref()?;
            Some((
                insights::song_key(&t.path, None),
                insights::song_key(&t.path, Some(id)),
            ))
        })
        .collect();
    let st = app.state::<InsightsState>();
    let mut d = st.data.lock().unwrap();
    let mut moved = 0;
    for (old, new) in pairs {
        if d.songs.contains_key(&old) || d.trans.contains_key(&old) {
            d.rekey(&old, &new);
            moved += 1;
        }
    }
    drop(d);
    if moved > 0 {
        player::log_msg(&format!(
            "escuchas: {moved} canciones pasan a su id de YouTube"
        ));
        InsightsState::save_soon(app);
    }
}

/// Pasadas en segundo plano: la primera 60 s después de abrir, luego cada
/// 24 h (cada hora si no había conexión).
fn start_enrichment(app: tauri::AppHandle) {
    std::thread::Builder::new()
        .name("enn-etiquetas".into())
        .spawn(move || {
            // las claves estables cuanto antes: antes de la primera canción
            fill_yt_ids(&app);
            std::thread::sleep(std::time::Duration::from_secs(60));
            loop {
                // sin conexión, otra vez en una hora; si no, mañana
                let offline = enrich_pass(&app).unwrap_or(false);
                std::thread::sleep(enrich::next_pass_in(offline));
            }
        })
        .ok();
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

/// «Cancelar todas».
#[tauri::command]
fn download_cancel_all(app: tauri::AppHandle) {
    app.state::<downloader::Downloader>().cancel_all();
}

/// Reanuda la cola detenida (disco lleno).
#[tauri::command]
fn download_resume(app: tauri::AppHandle) {
    app.state::<downloader::Downloader>().resume();
}

/// Descargas que quedaron sin terminar al cerrar Enn la última vez.
#[tauri::command]
fn download_pending(app: tauri::AppHandle) -> usize {
    app.state::<downloader::Downloader>().pending_count()
}

/// Reanuda (`resume`) o descarta la cola guardada al salir.
#[tauri::command]
fn download_pending_take(app: tauri::AppHandle, resume: bool) -> Vec<u64> {
    app.state::<downloader::Downloader>().pending_take(resume)
}

#[tauri::command]
fn get_state(app: tauri::AppHandle) -> serde_json::Value {
    let p = app.state::<Player>();
    let mut core = p.core.lock().unwrap();
    // se consume una sola vez (como un toast): dispositivo desconectado en
    // caliente, o aviso de que el supervisor lo reconectó / no pudo hacerlo
    let audio_error = core.runtime_error.take();
    serde_json::json!({
        "audio_error": audio_error,
        "state": match core.cur.as_ref().map(|t| t.state) {
            Some(PlayState::Playing) => "playing",
            Some(PlayState::Paused) => "paused",
            _ => "idle",
        },
        "path": core.cur.as_ref().map(|t| t.path.to_string_lossy().to_string()),
        "title": core.cur.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
        "artist": core.cur.as_ref().map(|t| t.artist.clone()).unwrap_or_default(),
        "pos": core.cur.as_ref().map(|t| core.audible_pos(t)).unwrap_or(0.0),
        "dur": core.cur.as_ref().and_then(|t| t.dur),
        // calidad de la fuente (no del dispositivo de salida): tasa y
        // profundidad nativas del archivo, más una tasa de bits media
        // aproximada a partir del tamaño en disco — útil para lossy sin
        // bitrate declarado (VBR). None cuando no aplica (p. ej. streams
        // sin duración conocida).
        "sample_rate": core.cur.as_ref().map(|t| t.dec.sample_rate),
        "bits_per_sample": core.cur.as_ref().and_then(|t| t.dec.bits_per_sample),
        "bitrate_kbps": core.cur.as_ref().and_then(|t| t.bitrate_kbps),
        "volume": core.master,
        "balance": core.balance,
        "eq": core.eq.bands_db,
        "bass": core.eq.bass_db,
        "treble": core.eq.treble_db,
        "fade": core.fade_secs,
    })
}

// ---------------------------------------------------------------- medición (T1)

/// Marca de arranque desde la interfaz. En modo banco, `interactivo` escribe
/// el informe y cierra la app.
#[tauri::command]
fn perf_mark(app: tauri::AppHandle, name: String) {
    perf::mark(&name);
    if name == perf::bench_final_mark() {
        perf::bench_finish(&app, false);
    }
}

/// Carga de prueba (solo para `--bench-play`): analiza la sonoridad de toda la
/// biblioteca en el grupo de fondo durante `seconds` s, sin guardar nada, para
/// comprobar que el audio no se corta con todos los núcleos ocupados.
/// Devuelve cuántos análisis completó.
#[tauri::command]
async fn perf_stress(app: tauri::AppHandle, seconds: f64) -> Result<usize, String> {
    if !perf::bench_play() {
        return Err("solo en modo de prueba".into());
    }
    let paths: Vec<String> = {
        let st = app.state::<EnnState>();
        let lib = st.lib.lock().unwrap();
        lib.tracks.iter().map(|t| t.path.clone()).collect()
    };
    off_main(move || {
        let until = std::time::Instant::now()
            + std::time::Duration::from_secs_f64(seconds.clamp(0.5, 60.0));
        let done = std::sync::atomic::AtomicUsize::new(0);
        while std::time::Instant::now() < until {
            jobs::for_each(&paths, |p| {
                if std::time::Instant::now() < until {
                    let _ = rg::analyze_lufs(Path::new(p));
                    done.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            });
        }
        done.load(std::sync::atomic::Ordering::Relaxed)
    })
    .await
}

/// Nota libre de la interfaz para el informe de medición.
#[tauri::command]
fn perf_note(key: String, value: serde_json::Value) {
    perf::note(&key, value);
}

#[tauri::command]
fn perf_report() -> perf::PerfReport {
    perf::report()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    perf::init();
    perf::bench_init();
    tauri::Builder::default()
        // Una sola instancia (Sprint 1, T4). Va la primera: la segunda
        // ejecución se cierra aquí mismo y la que ya estaba abierta se muestra
        // y pasa al frente (también si estaba escondida en la bandeja).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        // «Abrir con Windows» (apagado por defecto; se activa desde Ajustes).
        // Arranca con `--minimized`: se queda en la bandeja sin abrir la ventana.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
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
            // cerrar = minimizar a la bandeja; salir de verdad desde el menú de la bandeja.
            // Las descargas siguen en segundo plano: el descargador solo se apaga
            // en «Salir» (auditoría 2026-11-12, bugs #1 y #2).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                window.app_handle().state::<Player>().stop();
            }
        })
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                perf::mark("pagina-cargada");
            }
        })
        .setup(|app| {
            perf::mark("setup-inicio");
            // arrancado con Windows: directo a la bandeja
            if std::env::args().any(|a| a == "--minimized") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            perf::bench_watchdog(app.handle().clone());
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
                                let ins = app.state::<InsightsState>();
                                let snap = ins.data.lock().unwrap().clone();
                                let _ = snap.save(&ins.path);
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
                        player::log_warn(&format!("atajo global {sc} no disponible: {e}"));
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
            // después de aplicar los ajustes: `set_exclusive` (de apagado a
            // encendido al arrancar) borra la memoria, y no debe borrarse sola
            app.state::<Player>()
                .set_exclusive_memory(dir.join("exclusive.json"));
            let p = app.state::<Player>();
            p.start();
            let dl = downloader::Downloader::new(app.handle().clone());
            dl.set_limits(settings.dl_parallel as usize, settings.dl_rate_kib as u64);
            dl.set_pending_store(dir.join("pending_downloads.json"));
            app.manage(dl);
            app.manage(DownloaderConfig::new(dir.join("download_dir.json")));
            app.manage(preview::Previewer::new(dir.join("PreviewCache")));
            tools::start(app.handle().clone(), dir.join("tools"));
            let ins_path = dir.join("insights.json");
            app.manage(InsightsState {
                data: Mutex::new(insights::Insights::load(&ins_path)),
                path: ins_path,
                session: Mutex::new(radio::Session::new(now_secs())),
                tuner: Mutex::new(radio::Tuner::default()),
                online: std::sync::atomic::AtomicBool::new(settings.enrich_online),
                lastfm_key: Mutex::new(settings.lastfm_key.clone()),
                enriching: std::sync::atomic::AtomicBool::new(false),
            });
            start_enrichment(app.handle().clone());
            app.manage(RgState::default());
            app.manage(waves::WaveState::default());
            app.manage(VizState::default());
            perf::mark("setup-fin");
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
            lib_remove_track,
            probe_paths,
            playlist_save,
            playlist_load,
            settings_get,
            settings_set,
            dbg_log,
            get_download_dir,
            set_download_dir,
            download_music,
            download_tracks,
            music_search,
            music_album,
            music_artist_photo,
            download_list,
            download_cancel_all,
            download_resume,
            download_pending,
            download_pending_take,
            preview_play,
            preview_prefetch,
            preview_stop,
            tools_status,
            tools_update,
            insights_event,
            insights_migrate,
            radio_next,
            radio_tuner_set,
            reco_for,
            enrich_status,
            enrich_now,
            download_cancel,
            playlist_create,
            playlist_list,
            playlist_content,
            playlist_add,
            playlist_remove,
            playlist_dir,
            album_art,
            rg_scan_start,
            rg_analyze,
            reveal_in_folder,
            get_spectrum,
            get_viz_frame,
            waveform,
            tags_write,
            tags_write_batch,
            get_state,
            perf_mark,
            perf_note,
            perf_stress,
            perf_report
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Enn");
}
