use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::library::{probe, read_m3u, Track};

pub const PLAYLIST_FOLDER: &str = "Enn Playlists";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaylistMeta {
    pub name: String,
    pub path: String,
    pub count: usize,
}

pub fn dir_for(lib_dir: &str) -> PathBuf {
    Path::new(lib_dir).join(PLAYLIST_FOLDER)
}

fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    cleaned.trim().trim_end_matches('.').to_string()
}

fn file_for(dir: &Path, name: &str) -> PathBuf {
    let s = sanitize(name);
    dir.join(format!("{s}.m3u8"))
}

pub fn list(lib_dir: &str) -> Vec<PlaylistMeta> {
    let dir = dir_for(lib_dir);
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            match p.extension().and_then(|x| x.to_str()) {
                Some("m3u8") | Some("m3u") => {
                    let name = p
                        .file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let count = count_lines(&p);
                    out.push(PlaylistMeta {
                        name,
                        path: p.to_string_lossy().to_string(),
                        count,
                    });
                }
                _ => {}
            }
        }
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

fn count_lines(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && !t.starts_with('#')
                })
                .count()
        })
        .unwrap_or(0)
}

pub fn create(lib_dir: &str, name: &str) -> Result<PlaylistMeta, String> {
    let s = sanitize(name);
    if s.is_empty() {
        return Err("introduce un nombre válido".into());
    }
    let dir = dir_for(lib_dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = file_for(&dir, name);
    if path.exists() {
        return Err(format!("ya existe una playlist llamada «{s}»"));
    }
    std::fs::write(&path, "#EXTM3U\n").map_err(|e| e.to_string())?;
    Ok(PlaylistMeta {
        name: s,
        path: path.to_string_lossy().to_string(),
        count: 0,
    })
}

pub fn content(path: &Path) -> Vec<Track> {
    read_m3u(path)
        .iter()
        .filter_map(|p| probe(Path::new(p)))
        .collect()
}

pub fn resolve(lib_dir: &str, name: &str) -> Result<PathBuf, String> {
    let dir = dir_for(lib_dir);
    let direct = file_for(&dir, name);
    if direct.exists() {
        return Ok(direct);
    }
    // por si el nombre tiene diferencias de mayúsculas
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.file_stem()
                .map(|s| s.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default()
                == name.to_ascii_lowercase()
            {
                return Ok(p);
            }
        }
    }
    Err("playlist no encontrada".into())
}

/// Añade una pista al final de la playlist, sin volver a leer los metadatos
/// del resto de archivos (se anexan las líneas EXTINF+ruta directamente).
pub fn add(lib_dir: &str, name: &str, track: &Track) -> Result<usize, String> {
    let path = resolve(lib_dir, name)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if raw_paths(&existing).iter().any(|p| p == &track.path) {
        return Ok(0);
    }
    let mut out = existing;
    if !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    let name = if track.artist.is_empty() {
        track.title.clone()
    } else {
        format!("{} - {}", track.artist, track.title)
    };
    let secs = track.dur.unwrap_or(0.0).round() as u64;
    if !track.title.is_empty() {
        out.push_str(&format!("#EXTINF:{secs},{name}\n"));
    }
    out.push_str(&track.path);
    out.push('\n');
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(1)
}

/// Quita una pista de la playlist editando el archivo línea a línea,
/// sin decodificar las cabeceras de los demás archivos.
pub fn remove(lib_dir: &str, name: &str, track_path: &str) -> Result<usize, String> {
    let path = resolve(lib_dir, name)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut out = String::from("#EXTM3U\n");
    let mut removed = 0usize;
    let mut pending_extinf: Option<String> = None;
    for line in existing.lines() {
        let t = line.trim();
        if t.starts_with("#EXTINF") {
            pending_extinf = Some(line.to_string());
            continue;
        }
        if t == track_path {
            removed += 1;
            pending_extinf = None;
            continue;
        }
        if !t.is_empty() && !t.starts_with('#') {
            if let Some(e) = pending_extinf.take() {
                out.push_str(&e);
                out.push('\n');
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    if removed == 0 {
        return Ok(0);
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    Ok(1)
}

/// Rutas de canción presentes en el texto sin decodificar audio.
fn raw_paths(content: &str) -> Vec<&str> {
    content
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect()
}
