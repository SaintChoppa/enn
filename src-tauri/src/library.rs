use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::decode::{self, Tags};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Track {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// duración en segundos (None si el archivo no la declara)
    pub dur: Option<f64>,
}

fn tag_or(t: &Option<String>, fallback: &str) -> String {
    t.as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub fn probe(path: &Path) -> Option<Track> {
    let fallback = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let (dec, opened) = decode::Decoder::open(path).ok()?;
    let dur = match opened.n_frames {
        Some(_) => decode::duration_of(&opened),
        None => decode::measure_duration_secs(path),
    };
    let Tags { title, artist, album } = opened.tags;
    let _ = dec;
    Some(Track {
        path: path.to_string_lossy().to_string(),
        title: tag_or(&title, &fallback),
        artist: tag_or(&artist, ""),
        album: tag_or(&album, ""),
        dur,
    })
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Library {
    pub folders: Vec<String>,
    pub tracks: Vec<Track>,
}

/// Resultado de una operación de indexado.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AddResult {
    pub added: usize,
    pub failed: usize,
    pub first_error: Option<String>,
}

impl Library {
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, s);
        }
    }

    /// Escanea `folder`, indexa los archivos de audio y guarda el resultado.
    pub fn scan_into(&mut self, folder: &str, path: &Path) -> AddResult {
        if !self.folders.iter().any(|f| f == folder) {
            self.folders.push(folder.to_string());
        }
        let mut files = Vec::new();
        decode::scan_music_dir(Path::new(folder), &mut files);
        let mut res = AddResult::default();
        let known: std::collections::HashSet<String> =
            self.tracks.iter().map(|t| t.path.clone()).collect();
        let mut fresh: Vec<Track> = Vec::new();
        for f in files {
            let fstr = f.to_string_lossy().to_string();
            if known.contains(&fstr) {
                continue;
            }
            match probe(&f) {
                Some(t) => {
                    fresh.push(t);
                    res.added += 1;
                }
                None => {
                    res.failed += 1;
                    if res.first_error.is_none() {
                        res.first_error = Some(
                            decode::Decoder::open(&f)
                                .err()
                                .map(|e| e.to_string())
                                .unwrap_or_else(|| "archivo ilegible".into()),
                        );
                    }
                }
            }
        }
        self.tracks.append(&mut fresh);
        self.save(path);
        res
    }

    /// Re-escanea todas las carpetas indexadas desde cero.
    pub fn refresh(&mut self, path: &Path) -> AddResult {
        let folders = std::mem::take(&mut self.folders);
        self.tracks.clear();
        let mut total = AddResult::default();
        for f in &folders {
            let r = self.scan_into(f, path);
            total.added += r.added;
            total.failed += r.failed;
            if total.first_error.is_none() {
                total.first_error = r.first_error;
            }
        }
        self.save(path);
        total
    }

    pub fn clear(&mut self, path: &Path) {
        self.folders.clear();
        self.tracks.clear();
        self.save(path);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProbeMany {
    pub tracks: Vec<Track>,
    pub failed: usize,
    pub first_error: Option<String>,
}

pub fn probe_many(paths: &[PathBuf]) -> ProbeMany {
    let mut out = ProbeMany {
        tracks: Vec::new(),
        failed: 0,
        first_error: None,
    };
    for p in paths {
        match probe(p) {
            Some(t) => out.tracks.push(t),
            None => {
                out.failed += 1;
                if out.first_error.is_none() {
                    out.first_error = Some(
                        decode::Decoder::open(p)
                            .err()
                            .map(|e| e.to_string())
                            .unwrap_or_else(|| "archivo ilegible".into()),
                    );
                }
            }
        }
    }
    out
}

/// Escribe una lista `.m3u8` con los títulos incrustados cuando se conocen.
pub fn write_m3u(path: &Path, tracks: &[Track]) -> Result<(), String> {
    let mut out = String::from("#EXTM3U\n");
    for t in tracks {
        if !t.title.is_empty() {
            let secs = t.dur.unwrap_or(0.0).round() as u64;
            let name = if !t.artist.is_empty() {
                format!("{} - {}", t.artist, t.title)
            } else {
                t.title.clone()
            };
            out.push_str(&format!("#EXTINF:{secs},{name}\n"));
        }
        out.push_str(&t.path);
        out.push('\n');
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

/// Lee una lista `.m3u`/`.m3u8`: resuelve cada ruta (absoluta o relativa a la lista).
pub fn read_m3u(path: &Path) -> Vec<String> {
    let base = path.parent().unwrap_or_else(|| Path::new("."));
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in content.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let p = PathBuf::from(l);
        let resolved = if p.is_absolute() { p } else { base.join(p) };
        if resolved.is_file() && decode::is_supported_path(&resolved) {
            out.push(resolved.to_string_lossy().to_string());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_real_files() {
        let root = std::env::var("ENN_TEST_DIR").unwrap_or_default();
        if root.trim().is_empty() {
            // sin carpeta indicada: solo asegura que el probador básico compila/probea
            eprintln!("probe_real: sin ENN_TEST_DIR (skip)");
            return;
        }
        let mut scanned = 0usize;
        let mut ok = 0usize;
        let mut fail = 0usize;
        for dir in root.split(';').filter(|d| !d.is_empty()) {
            let mut files = Vec::new();
            decode::scan_music_dir(Path::new(dir), &mut files);
            files.sort();
            for f in files.iter().take(60) {
                scanned += 1;
                match decode::Decoder::open(f) {
                    Ok(_) => {
                        ok += 1;
                        if ok <= 8 {
                            eprintln!("probe OK  {f:?}");
                        }
                    }
                    Err(e) => {
                        fail += 1;
                        if fail <= 8 {
                            eprintln!("probe FAIL {f:?}  -> {e}");
                        }
                    }
                }
            }
        }
        eprintln!("probe_real: escaneados={scanned} ok={ok} fail={fail}");
        assert!(fail < scanned, "demasiados fallos de apertura");
    }
}
