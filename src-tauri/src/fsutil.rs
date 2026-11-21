//! Escritura segura de los archivos de datos de Enn (Sprint 1, T4).
//!
//! `write_atomic` escribe en un temporal junto al destino, lo fuerza a disco y
//! lo renombra encima: un corte de luz o un cierre a mitad deja el archivo
//! viejo entero o el nuevo entero, nunca uno a medias.
//!
//! `quarantine` aparta un archivo que no se pudo leer (JSON dañado) antes de
//! que la app lo sobrescriba con valores vacíos: así nunca se pierde la
//! biblioteca por un archivo corrupto.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Escribe `bytes` en `path` de forma atómica.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = temp_path(path);
    let res = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // en Windows `rename` reemplaza el destino si existe (MOVEFILE_REPLACE_EXISTING)
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

fn temp_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "datos".into());
    path.with_file_name(format!(".{name}.tmp-{}", std::process::id()))
}

/// Renombra `path` a `<nombre>.dañado-<segundos unix>` y devuelve la ruta
/// nueva. Si no existe o no se puede renombrar, devuelve `None`.
pub fn quarantine(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = path.file_name()?.to_string_lossy().to_string();
    let dest = path.with_file_name(format!("{name}.dañado-{secs}"));
    std::fs::rename(path, &dest).ok()?;
    Some(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("enn-fsutil-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn writes_and_replaces_without_leaving_temp_files() {
        let d = dir("write");
        let p = d.join("library.json");
        write_atomic(&p, b"uno").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"uno");
        write_atomic(&p, b"dos, mas largo").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"dos, mas largo");
        let restos: Vec<_> = std::fs::read_dir(&d)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        let _ = std::fs::remove_dir_all(&d);
        assert!(restos.is_empty());
    }

    #[test]
    fn write_into_missing_folder_fails_cleanly() {
        let d = dir("missing");
        let p = d.join("no-existe").join("x.json");
        assert!(write_atomic(&p, b"x").is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn quarantine_moves_the_file_aside() {
        let d = dir("quarantine");
        let p = d.join("library.json");
        std::fs::write(&p, b"{ esto no es json").unwrap();
        let dest = quarantine(&p).expect("apartado");
        assert!(!p.exists());
        assert_eq!(std::fs::read(&dest).unwrap(), b"{ esto no es json");
        assert!(dest
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("library.json.dañado-"));
        assert!(quarantine(&d.join("no-existe.json")).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
