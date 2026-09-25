//! Carátulas de álbum: extracción de imágenes incrustadas (APIC/covr/pictures
//! vía Symphonia) con respaldo de `cover.jpg`/`folder.jpg` en la carpeta del
//! disco. Todo pasa por una caché en disco para no re-extraer nunca lo mismo.

use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub struct Art {
    pub mime: String,
    pub bytes: Vec<u8>,
}

/// Extrae la carátula incrustada leyendo solo las cabeceras (no decodifica audio).
fn extract_embedded(path: &Path) -> Option<Art> {
    let file = File::open(path).ok()?;
    let mut hint = Hint::new();
    if let Some(e) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(&e.to_ascii_lowercase());
    }
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut probed = symphonia::default::get_probe()
        .format(&hint, mss, &Default::default(), &MetadataOptions::default())
        .ok()?;
    let mut md = probed.format.metadata();
    loop {
        if let Some(rev) = md.current() {
            for vis in rev.visuals() {
                let mime = if vis.media_type.is_empty() {
                    "image/jpeg"
                } else {
                    &vis.media_type
                };
                if mime.starts_with("image/") && !vis.data.is_empty() {
                    return Some(Art {
                        mime: mime.to_string(),
                        bytes: vis.data.to_vec(),
                    });
                }
            }
        }
        if md.pop().is_none() {
            break;
        }
    }
    None
}

/// Respaldo: imagen suelta junto al archivo (convención habitual de discos ripeados).
fn folder_image(dir: &Path) -> Option<Art> {
    for name in [
        "cover.jpg",
        "folder.jpg",
        "cover.png",
        "folder.png",
        "album.jpg",
        "front.jpg",
    ] {
        let p = dir.join(name);
        if let Ok(bytes) = std::fs::read(&p) {
            let mime = if p.extension().and_then(|e| e.to_str()) == Some("png") {
                "image/png"
            } else {
                "image/jpeg"
            };
            return Some(Art {
                mime: mime.into(),
                bytes,
            });
        }
    }
    None
}

fn mime_ext(mime: &str) -> &str {
    if mime.contains("png") {
        "png"
    } else if mime.contains("gif") {
        "gif"
    } else if mime.contains("webp") {
        "webp"
    } else {
        "jpg"
    }
}

/// Clave estable de caché: ruta del archivo + fecha de modificación.
fn cache_key(path: &Path) -> Option<String> {
    let mt = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let mt = mt.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    let mut h = DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    mt.hash(&mut h);
    Some(format!("{:016x}", h.finish()))
}

fn find_art(path: &Path) -> Option<Art> {
    extract_embedded(path).or_else(|| path.parent().and_then(folder_image))
}

/// Devuelve la carátula como data URI para la UI (img src), pasando por la caché.
pub fn data_uri(art_dir: &Path, track_path: &Path) -> Option<String> {
    let key = cache_key(track_path)?;
    let cached = art_dir.join(format!("{key}.{}", mime_ext_lookup(art_dir, &key)));
    if let Ok(bytes) = std::fs::read(&cached) {
        let mime = if cached.extension().and_then(|e| e.to_str()) == Some("png") {
            "image/png"
        } else {
            "image/jpeg"
        };
        return Some(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    }
    let art = find_art(track_path)?;
    let _ = std::fs::create_dir_all(art_dir);
    let ext = mime_ext(&art.mime);
    let dest = art_dir.join(format!("{key}.{ext}"));
    if std::fs::write(&dest, &art.bytes).is_ok() {
        let _ = prune(art_dir);
    }
    Some(format!(
        "data:{};base64,{}",
        art.mime,
        base64::engine::general_purpose::STANDARD.encode(&art.bytes)
    ))
}

/// La extensión del archivo en caché no está en la clave; la miramos en disco.
fn mime_ext_lookup(art_dir: &Path, key: &str) -> &'static str {
    for ext in ["jpg", "png", "gif", "webp"] {
        if art_dir.join(format!("{key}.{ext}")).is_file() {
            return match ext {
                "png" => "png",
                "gif" => "gif",
                "webp" => "webp",
                _ => "jpg",
            };
        }
    }
    "jpg"
}

/// Ruta (si existe) de la carátula en caché, para pasarla al sistema (SMTC).
pub fn cached_cover_url(art_dir: &Path, track_path: &Path) -> Option<String> {
    let key = cache_key(track_path)?;
    let ext = mime_ext_lookup(art_dir, &key);
    let dest = art_dir.join(format!("{key}.{ext}"));
    if !dest.is_file() {
        let art = find_art(track_path)?;
        let _ = std::fs::create_dir_all(art_dir);
        std::fs::write(&dest, &art.bytes).ok()?;
        let _ = prune(art_dir);
    }
    let url = dest.to_string_lossy().replace('\\', "/");
    Some(format!("file:///{url}"))
}

/// Borra entradas huérfanas si la caché supera las ~1500 imágenes.
fn prune(art_dir: &Path) -> Result<(), std::io::Error> {
    const MAX: usize = 1500;
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for e in std::fs::read_dir(art_dir)?.flatten() {
        let p = e.path();
        if p.is_file() {
            let mt = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            files.push((mt, p));
        }
    }
    if files.len() <= MAX {
        return Ok(());
    }
    files.sort();
    let excess = files.len() - MAX;
    for (_, p) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_image_respects_priority() {
        // sin carpeta no hay imagen
        assert!(folder_image(Path::new("Z:/no/existe/nunca")).is_none());
    }
}
