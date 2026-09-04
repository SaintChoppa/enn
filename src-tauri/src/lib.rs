mod decode;
mod dsp;
mod library;
mod player;

use std::path::Path;
use std::sync::Mutex;

use library::{Library, Track};
use player::{Player, PlayState};
use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Estado de la aplicación: librería + rutas de persistencia.
pub struct EnnState {
    lib: Mutex<Library>,
    lib_path: std::path::PathBuf,
    set_path: std::path::PathBuf,
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
}

// ---------------------------------------------------------------- audio

#[tauri::command]
fn play_file(app: tauri::AppHandle, path: String, dur: Option<f64>) -> Result<(), String> {
    app.state::<Player>()
        .play_path(Path::new(&path), 0.0, dur)
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

#[tauri::command]
fn dbg_log(msg: String) {
    player::log_msg(&format!("UI: {msg}"));
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
        .setup(|app| {
            let dir = app.path().app_config_dir().unwrap_or_default();
            let _ = std::fs::create_dir_all(&dir);
            let lib_path = dir.join("library.json");
            let set_path = dir.join("settings.json");
            let player = Player::new(app.handle().clone());
            app.manage(player);
            app.manage(EnnState {
                lib: Mutex::new(Library::load(&lib_path)),
                lib_path,
                set_path: set_path.clone(),
            });
            let settings = load_settings(&set_path);
            apply_settings(app.handle(), &settings);
            let p = app.state::<Player>();
            p.start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            play_file,
            toggle_pause,
            stop,
            seek_to,
            set_volume,
            set_balance,
            set_eq,
            set_fade,
            set_current_gain,
            list_devices,
            select_device,
            lib_add,
            lib_refresh,
            lib_clear,
            lib_list,
            lib_folders,
            probe_paths,
            playlist_save,
            playlist_load,
            settings_get,
            settings_set,
            dbg_log,
            get_state
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar Enn");
}
