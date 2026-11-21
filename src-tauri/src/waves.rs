//! Waveforms (B7): picos de amplitud por bins para dibujar la forma de onda
//! en la barra de progreso. Cálculo en segundo plano (decodifica el archivo
//! una vez) con caché en disco junto a la de carátulas.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

use crate::decode::Decoder;

const BINS: usize = 240;

/// Clave de caché compartida con art.rs (ruta + mtime).
pub fn cache_key(path: &Path) -> Option<String> {
    let mt = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    mt.hash(&mut h);
    Some(format!("w{:016x}", h.finish()))
}

fn peaks_file(art_dir: &Path, track: &Path) -> Option<PathBuf> {
    Some(art_dir.join(format!("{}.peaks", cache_key(track)?)))
}

/// Estado: cálculos en marcha para no duplicar hilos.
#[derive(Default)]
pub struct WaveState {
    pending: Mutex<HashSet<String>>,
}

/// Devuelve los picos (0-255 × BINS) si están en caché; si no, lanza el
/// cálculo en segundo plano y devuelve None. La UI vuelve a preguntar.
pub fn get_or_spawn(app: &tauri::AppHandle, track_path: &Path) -> Option<Vec<u8>> {
    let art_dir = {
        let st = app.state::<crate::EnnState>();
        st.art_dir.clone()
    };
    let pf = peaks_file(&art_dir, track_path)?;
    if let Ok(bytes) = std::fs::read(&pf) {
        if bytes.len() == BINS {
            return Some(bytes);
        }
    }
    let key = cache_key(track_path)?;
    let state = app.state::<WaveState>();
    if !state.pending.lock().unwrap().insert(key) {
        return None; // ya se está calculando
    }
    let app = app.clone();
    let track = track_path.to_path_buf();
    let pf2 = pf.clone();
    // en el grupo de fondo (Sprint 1, T7): antes, un hilo nuevo por pista
    crate::jobs::spawn(move || {
        let peaks = compute(&track);
        if let Some(p) = peaks {
            let _ = std::fs::write(&pf2, &p);
        }
        let state = app.state::<WaveState>();
        if let Some(k) = cache_key(&track) {
            state.pending.lock().unwrap().remove(&k);
        }
    });
    None
}

/// Decodifica el archivo y devuelve el máximo absoluto por bin.
fn compute(path: &Path) -> Option<Vec<u8>> {
    let (mut dec, opened) = Decoder::open(path).ok()?;
    let n_frames = dec.n_frames?; // los VBR sin índice no generan waveform
    let mut peaks = vec![0.0f32; BINS];
    let frames_per_bin = (n_frames as f64 / BINS as f64).max(1.0);
    let mut buf = vec![0.0f32; 16384];
    let mut served = dec.served_frames;
    let _ = opened;
    loop {
        let got = dec.pull_stereo(&mut buf);
        if got == 0 {
            break;
        }
        for f in 0..got {
            let v = (buf[f * 2].abs() + buf[f * 2 + 1].abs()) * 0.5;
            let bin = ((served + f as u64) as f64 / frames_per_bin) as usize;
            if bin < BINS && v > peaks[bin] {
                peaks[bin] = v;
            }
        }
        served += got as u64;
    }
    let max = peaks.iter().cloned().fold(0.0f32, f32::max).max(1e-6);
    Some(
        peaks
            .iter()
            .map(|&v| ((v / max) * 255.0).min(255.0) as u8)
            .collect(),
    )
}
