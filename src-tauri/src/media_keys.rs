//! Controles multimedia del sistema, con vistas al portaje a Linux:
//! - Windows: SMTC (System Media Transport Controls) → media keys del teclado,
//!   overlay de volumen y dispositivos Bluetooth.
//! - Linux (futuro): el mismo crate expone MPRIS; nada del módulo es específico
//!   de Windows salvo el HWND opcional.

use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::Receiver;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
};
use tauri::{Emitter, Manager};

use crate::player::{log_msg, log_warn, Core, PlayState};

/// Nombre registrado en el bus (MPRIS en Linux); el visible es "Enn".
const DBUS_NAME: &str = "enn";
const DISPLAY_NAME: &str = "Enn";

fn create_controls(app: &tauri::AppHandle) -> Result<MediaControls, String> {
    let mut config = PlatformConfig {
        dbus_name: DBUS_NAME,
        display_name: DISPLAY_NAME,
        hwnd: None,
    };
    #[cfg(target_os = "windows")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        if let Some(w) = app.get_webview_window("main") {
            if let Ok(h) = w.window_handle() {
                if let RawWindowHandle::Win32(win) = h.as_raw() {
                    config.hwnd = Some(win.hwnd.get() as *mut std::ffi::c_void);
                }
            }
        }
    }
    MediaControls::new(config).map_err(|e| e.to_string())
}

/// Hilo de larga vida: posee los controles, reacciona a los eventos del sistema
/// (media keys) y publica metadatos/estado con refresco perezoso (solo cambios).
pub fn spawn(app: tauri::AppHandle, core: Arc<std::sync::Mutex<Core>>, rx: Receiver<()>) {
    std::thread::spawn(move || {
        let mut controls = match create_controls(&app) {
            Ok(c) => c,
            Err(e) => {
                log_warn(&format!("controles multimedia no disponibles: {e}"));
                return;
            }
        };
        {
            let ev_app = app.clone();
            let ev_core = core.clone();
            if let Err(e) = controls.attach(move |ev| handle_event(&ev_app, &ev_core, ev)) {
                log_warn(&format!("no se pudieron registrar los controles: {e}"));
                return;
            }
        }
        log_msg("controles multimedia activos (SMTC/MPRIS)");

        type TrackKey = (String, String, String, Option<f64>, String);
        let mut last_track: Option<TrackKey> = None;
        let mut last_state: Option<(PlayState, u64)> = None;
        loop {
            if rx.recv_timeout(Duration::from_millis(250)).is_ok() {
                return;
            }
            let snapshot = {
                let c = match core.lock() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                (
                    c.cur.as_ref().map(|t| {
                        (
                            t.title.clone(),
                            t.artist.clone(),
                            t.album.clone(),
                            t.dur,
                            t.path.clone(),
                        )
                    }),
                    c.cur.as_ref().map(|t| t.state).unwrap_or(PlayState::Idle),
                    c.cur.as_ref().map(|t| t.pos_sec).unwrap_or(0.0),
                )
            };
            let (track, state, pos) = snapshot;
            let track_key = track.as_ref().map(|(ti, ar, al, d, p)| {
                (
                    ti.clone(),
                    ar.clone(),
                    al.clone(),
                    *d,
                    p.to_string_lossy().to_string(),
                )
            });
            if track_key != last_track {
                last_track = track_key.clone();
                last_state = None; // fuerza refresco del estado también
                                   // la carátula se resuelve SOLO al cambiar de pista: antes se
                                   // calculaba en cada vuelta del bucle (4 veces por segundo), con
                                   // su `fs::metadata` y sus `is_file()` incluidos, mientras suena algo
                let cover_url = track.as_ref().and_then(|(_, _, _, _, p)| {
                    let dir = {
                        let st = app.state::<crate::EnnState>();
                        st.art_dir.clone()
                    };
                    crate::art::cached_cover_url(&dir, p)
                });
                let meta = match &track {
                    Some((ti, ar, al, d, _)) => MediaMetadata {
                        title: Some(ti),
                        artist: Some(ar),
                        album: Some(al),
                        duration: d.map(Duration::from_secs_f64),
                        cover_url: cover_url.as_deref(),
                    },
                    None => MediaMetadata {
                        title: None,
                        artist: None,
                        album: None,
                        duration: None,
                        cover_url: None,
                    },
                };
                if let Err(e) = controls.set_metadata(meta) {
                    log_warn(&format!("smtc: fallo set_metadata: {e}"));
                }
            }
            let state_key = (state, pos as u64);
            if Some(state_key) != last_state {
                last_state = Some(state_key);
                let playback = match state {
                    PlayState::Playing => MediaPlayback::Playing {
                        progress: Some(MediaPosition(Duration::from_secs_f64(pos))),
                    },
                    PlayState::Paused => MediaPlayback::Paused {
                        progress: Some(MediaPosition(Duration::from_secs_f64(pos))),
                    },
                    PlayState::Idle => MediaPlayback::Stopped,
                };
                if let Err(e) = controls.set_playback(playback) {
                    log_warn(&format!("smtc: fallo set_playback: {e}"));
                }
            }
        }
    });
}

fn set_state(core: &Arc<std::sync::Mutex<Core>>, state: PlayState) {
    if let Ok(mut c) = core.lock() {
        if let Some(t) = &mut c.cur {
            t.state = state;
            c.pending_event = Some("state");
        }
    }
}

fn handle_event(app: &tauri::AppHandle, core: &Arc<std::sync::Mutex<Core>>, ev: MediaControlEvent) {
    log_msg(&format!("evento multimedia del sistema: {ev:?}"));
    match ev {
        MediaControlEvent::Play => set_state(core, PlayState::Playing),
        MediaControlEvent::Pause => set_state(core, PlayState::Paused),
        MediaControlEvent::Toggle => {
            if let Ok(mut c) = core.lock() {
                if let Some(t) = &mut c.cur {
                    t.state = match t.state {
                        PlayState::Playing => PlayState::Paused,
                        _ => PlayState::Playing,
                    };
                    c.pending_event = Some("state");
                }
            }
        }
        MediaControlEvent::Stop => {
            if let Ok(mut c) = core.lock() {
                c.cur = None;
                c.pending_event = Some("stop");
            }
        }
        // Anterior/Siguiente dependen de la cola, que vive en la UI: se le delega.
        MediaControlEvent::Next => {
            let _ = app.emit("enn://media", "next");
        }
        MediaControlEvent::Previous => {
            let _ = app.emit("enn://media", "prev");
        }
        MediaControlEvent::Seek(d) => {
            let secs = match d {
                souvlaki::SeekDirection::Forward => 10.0,
                souvlaki::SeekDirection::Backward => -10.0,
            };
            if let Ok(mut c) = core.lock() {
                if let Some(t) = &mut c.cur {
                    let target = (t.pos_sec + secs).max(0.0);
                    c.request_seek(target);
                }
            }
        }
        MediaControlEvent::SetPosition(p) => {
            if let Ok(mut c) = core.lock() {
                if c.cur.is_some() {
                    c.request_seek(p.0.as_secs_f64().max(0.0));
                }
            }
        }
        _ => {}
    }
}
