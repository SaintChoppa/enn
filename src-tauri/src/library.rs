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
    /// sonoridad integrada (LUFS, EBU R128) para ReplayGain 2.0
    #[serde(default)]
    pub rg: Option<f64>,
    /// marcada como favorita por el usuario (no viene del archivo)
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub genre: String,
    /// año de lanzamiento/grabación (None si el archivo no lo declara)
    #[serde(default)]
    pub year: Option<u32>,
    /// fecha de modificación del archivo (segundos Unix) para ordenar
    /// «Todas las pistas» por lo más reciente; las bibliotecas guardadas antes
    /// no la traen y se rellena al listar (`fill_mtimes`)
    #[serde(default)]
    pub mtime: Option<u64>,
    /// id de YouTube (descargas): clave estable de la canción para el
    /// almacén de escuchas aunque el archivo se mueva (Sprint 3)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yt_id: Option<String>,
}

/// Segundos Unix de la última modificación de `path` (None si no se puede leer).
pub fn file_mtime(path: &str) -> Option<u64> {
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// Rellena la fecha de las pistas que no la tienen (una sola vez por pista).
pub fn fill_mtimes(tracks: &mut [Track]) {
    for t in tracks.iter_mut().filter(|t| t.mtime.is_none()) {
        t.mtime = file_mtime(&t.path);
    }
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
    let Tags {
        title,
        artist,
        album,
        genre,
        year,
        yt_id,
    } = opened.tags;
    let _ = dec;
    Some(Track {
        path: path.to_string_lossy().to_string(),
        title: tag_or(&title, &fallback),
        artist: tag_or(&artist, ""),
        album: tag_or(&album, ""),
        dur,
        rg: None,
        favorite: false,
        genre: tag_or(&genre, ""),
        year,
        mtime: file_mtime(&path.to_string_lossy()),
        yt_id,
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
        let Ok(s) = std::fs::read_to_string(path) else {
            return Self::default(); // primer uso: no hay archivo
        };
        match serde_json::from_str(&s) {
            Ok(lib) => lib,
            Err(e) => {
                // Sprint 1 (T4): antes se seguía con una biblioteca vacía y el
                // siguiente guardado sobrescribía el archivo dañado → se perdía
                // la biblioteca. Ahora se aparta para poder recuperarla.
                let moved = crate::fsutil::quarantine(path);
                crate::player::log_error(&format!(
                    "library.json no se pudo leer ({e}); apartado en {moved:?}"
                ));
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            if let Err(e) = crate::fsutil::write_atomic(path, s.as_bytes()) {
                crate::player::log_error(&format!("no se pudo guardar la biblioteca: {e}"));
            }
        }
    }

    /// Escanea `folder`, indexa los archivos de audio y guarda el resultado.
    pub fn scan_into(&mut self, folder: &str, path: &Path) -> AddResult {
        if !self.folders.iter().any(|f| f == folder) {
            self.folders.push(folder.to_string());
        }
        let mut files = Vec::new();
        decode::scan_music_dir(Path::new(folder), &mut files);
        let known: std::collections::HashSet<String> =
            self.tracks.iter().map(|t| t.path.clone()).collect();
        let candidates: Vec<PathBuf> = files
            .into_iter()
            .filter(|f| !known.contains(&f.to_string_lossy().to_string()))
            .collect();
        // cada archivo se decodifica/etiqueta de forma independiente (sin
        // estado compartido), así que bibliotecas grandes (10k+ pistas) se
        // benefician de escanear en paralelo en vez de uno por uno; collect()
        // sobre un Vec conserva el orden original pese al paralelismo, así
        // que "primer error" sigue significando lo mismo que antes.
        // en el grupo de fondo de Enn (Sprint 1, T7): mismos núcleos, prioridad
        // baja y un solo hilo con batería
        let probed: Vec<(PathBuf, Option<Track>)> =
            crate::jobs::map(&candidates, |f| (f.clone(), probe(f)));
        let mut res = AddResult::default();
        let mut fresh: Vec<Track> = Vec::new();
        for (f, t) in probed {
            match t {
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
    ///
    /// `rg` (ReplayGain) y `favorite` no vienen del archivo — solo viven en
    /// este índice — así que antes de reconstruir se guarda una copia por
    /// ruta y se restaura al terminar; de lo contrario cada refresh tiraba
    /// el análisis de sonoridad ya hecho y obligaba a repetirlo entero.
    pub fn refresh(&mut self, path: &Path) -> AddResult {
        let preserved: std::collections::HashMap<String, (Option<f64>, bool)> = self
            .tracks
            .drain(..)
            .map(|t| (t.path, (t.rg, t.favorite)))
            .collect();
        let folders = std::mem::take(&mut self.folders);
        let mut total = AddResult::default();
        for f in &folders {
            let r = self.scan_into(f, path);
            total.added += r.added;
            total.failed += r.failed;
            if total.first_error.is_none() {
                total.first_error = r.first_error;
            }
        }
        for t in self.tracks.iter_mut() {
            if let Some((rg, favorite)) = preserved.get(&t.path) {
                t.rg = *rg;
                t.favorite = *favorite;
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

    /// Quita una pista del índice (no borra el archivo del disco). Usado por
    /// el detector de duplicados: "quedarme con esta versión" retira las
    /// demás de la biblioteca sin tocar nada en el sistema de archivos, así
    /// que es reversible con un simple re-escaneo de la carpeta.
    pub fn remove_track(&mut self, track_path: &str, path: &Path) -> bool {
        let before = self.tracks.len();
        self.tracks.retain(|t| t.path != track_path);
        let removed = self.tracks.len() != before;
        if removed {
            self.save(path);
        }
        removed
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProbeMany {
    pub tracks: Vec<Track>,
    pub failed: usize,
    pub first_error: Option<String>,
}

pub fn probe_many(paths: &[PathBuf]) -> ProbeMany {
    let probed: Vec<Option<Track>> = crate::jobs::map(paths, |p| probe(p));
    let mut out = ProbeMany {
        tracks: Vec::new(),
        failed: 0,
        first_error: None,
    };
    for (p, t) in paths.iter().zip(probed) {
        match t {
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

    /// Escribe un WAV PCM16 mono mínimo y válido para pruebas deterministas.
    fn write_tiny_wav(path: &Path) {
        let sr: u32 = 44100;
        let n_samples: u32 = 4410; // 0.1 s
        let bytes = n_samples * 2;
        let mut f = std::fs::File::create(path).unwrap();
        use std::io::Write;
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + bytes).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap(); // PCM
        f.write_all(&1u16.to_le_bytes()).unwrap(); // mono
        f.write_all(&sr.to_le_bytes()).unwrap();
        f.write_all(&(sr * 2).to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&bytes.to_le_bytes()).unwrap();
        f.write_all(&vec![0u8; bytes as usize]).unwrap();
    }

    /// Regresión: `refresh()` reconstruye la biblioteca desde cero (rescan
    /// completo), pero `rg` y `favorite` solo viven en el índice, no en el
    /// archivo — antes de este fix un refresh los perdía y forzaba repetir
    /// el análisis de ReplayGain de toda la biblioteca.
    #[test]
    fn refresh_preserves_rg_and_favorite() {
        let dir = std::env::temp_dir().join(format!("enn_test_refresh_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("track.wav");
        write_tiny_wav(&wav);
        let lib_json = dir.join("library.json");

        let mut lib = Library::default();
        lib.scan_into(&dir.to_string_lossy(), &lib_json);
        assert_eq!(
            lib.tracks.len(),
            1,
            "debería haber indexado el wav de prueba"
        );
        {
            let t = lib.tracks.first_mut().unwrap();
            t.rg = Some(-14.2);
            t.favorite = true;
        }

        lib.refresh(&lib_json);

        assert_eq!(
            lib.tracks.len(),
            1,
            "el refresh no debería duplicar ni perder la pista"
        );
        let t = &lib.tracks[0];
        assert_eq!(t.rg, Some(-14.2), "rg debería sobrevivir al refresh");
        assert!(t.favorite, "favorite debería sobrevivir al refresh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remove_track_drops_from_index_not_disk() {
        let dir = std::env::temp_dir().join(format!("enn_test_remove_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("track.wav");
        write_tiny_wav(&wav);
        let lib_json = dir.join("library.json");

        let mut lib = Library::default();
        lib.scan_into(&dir.to_string_lossy(), &lib_json);
        assert_eq!(lib.tracks.len(), 1);
        let path = lib.tracks[0].path.clone();

        let removed = lib.remove_track(&path, &lib_json);
        assert!(removed, "debería reportar que sí quitó la pista");
        assert!(lib.tracks.is_empty(), "el índice debe quedar vacío");
        assert!(wav.is_file(), "el archivo en disco no debe tocarse");

        // el índice guardado en disco también debe reflejar la quita
        let reloaded = Library::load(&lib_json);
        assert!(reloaded.tracks.is_empty());

        let removed_again = lib.remove_track(&path, &lib_json);
        assert!(
            !removed_again,
            "quitar una ruta que ya no está no es un error, pero tampoco hace nada"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
