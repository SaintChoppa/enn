//! yt-dlp al día (Sprint 2, T5).
//!
//! YouTube cambia a menudo y yt-dlp deja de funcionar hasta que se actualiza.
//! El propietario eligió «automático» (2026-11-16): Enn busca una vez por
//! semana y cuando una descarga falla con un error conocido, baja la versión
//! estable de GitHub, comprueba su suma SHA-256 publicada (`SHA2-256SUMS`) y
//! solo entonces sustituye su copia de trabajo, en la carpeta de datos. Si
//! algo falla, sigue con la anterior.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tauri::Emitter;

/// Cada cuánto se busca versión nueva.
pub const CHECK_EVERY: Duration = Duration::from_secs(7 * 24 * 3600);
/// Tras un fallo conocido se busca, como mucho, una vez por hora.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(3600);
/// Espera tras abrir Enn antes de la búsqueda semanal (no frena el arranque).
const STARTUP_DELAY: Duration = Duration::from_secs(30);
/// Tope de tamaño de la descarga (yt-dlp.exe pesa ~18 MB).
const MAX_BYTES: u64 = 150 * 1024 * 1024;

/// Archivo de la publicación para este sistema.
#[cfg(windows)]
const ASSET: Option<&str> = Some("yt-dlp.exe");
#[cfg(not(windows))]
const ASSET: Option<&str> = None;

const RELEASE_API: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

struct Tools {
    dir: PathBuf,
    updating: AtomicBool,
    last_failure_check: Mutex<Option<Instant>>,
}

static TOOLS: OnceLock<Tools> = OnceLock::new();

/// ¿Toca buscar? (`last` y `now` en segundos desde 1970)
pub fn due(last: Option<u64>, now: u64, every: Duration) -> bool {
    match last {
        None => true,
        Some(l) => now.saturating_sub(l) >= every.as_secs(),
    }
}

fn version_parts(v: &str) -> Option<Vec<u64>> {
    let v = v.trim();
    if v.is_empty() {
        return None;
    }
    v.split('.').map(|p| p.parse::<u64>().ok()).collect()
}

/// ¿La etiqueta `tag` (p. ej. «2026.11.10») es más nueva que `current`?
pub fn newer(tag: &str, current: &str) -> bool {
    match (version_parts(tag), version_parts(current)) {
        (Some(t), Some(c)) => t > c,
        (Some(_), None) => true,
        _ => false,
    }
}

/// Suma publicada para `name` en un `SHA2-256SUMS` («<hex>  <nombre>» por línea).
pub fn parse_sums(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let hex = it.next()?;
        let file = it.next()?.trim_start_matches('*');
        (file == name).then(|| hex.to_string())
    })
}

/// Comprueba `new_file` contra `expected` y, si coincide, lo pone en `target`
/// (la copia anterior queda como `.old`). Si no coincide, lo borra y deja
/// `target` como estaba.
pub fn verify_and_swap(new_file: &Path, expected: &str, target: &Path) -> Result<(), String> {
    let actual = sha256_file(new_file).map_err(|e| e.to_string())?;
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        let _ = std::fs::remove_file(new_file);
        return Err("la suma SHA-256 no coincide; se descarta la descarga".into());
    }
    let old = PathBuf::from(format!("{}.old", target.display()));
    if target.exists() {
        // si un yt-dlp viejo sigue corriendo, Windows no deja borrarlo (sí renombrarlo)
        let _ = std::fs::remove_file(&old);
        std::fs::rename(target, &old).map_err(|e| e.to_string())?;
    }
    if let Err(e) = std::fs::rename(new_file, target) {
        let _ = std::fs::rename(&old, target);
        return Err(e.to_string());
    }
    Ok(())
}

/// ¿Este error de descarga suena a «yt-dlp está desfasado»?
pub fn looks_outdated(err: &str) -> bool {
    let low = err.to_lowercase();
    [
        "unable to extract",
        "nsig",
        "signature extraction failed",
        "requested format is not available",
        "failed to extract any player response",
        "please update",
    ]
    .iter()
    .any(|p| low.contains(p))
}

fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Copia de trabajo de yt-dlp en la carpeta de datos, si existe.
pub fn working_copy() -> Option<PathBuf> {
    let t = TOOLS.get()?;
    let p = t.dir.join(ASSET?);
    p.is_file().then_some(p)
}

fn state_path(t: &Tools) -> PathBuf {
    t.dir.join("state.json")
}

fn last_check(t: &Tools) -> Option<u64> {
    let s = std::fs::read_to_string(state_path(t)).ok()?;
    serde_json::from_str::<serde_json::Value>(&s).ok()?["last_check"].as_u64()
}

fn save_last_check(t: &Tools) {
    let _ = std::fs::create_dir_all(&t.dir);
    let json = serde_json::json!({ "last_check": now_secs() }).to_string();
    let _ = crate::fsutil::write_atomic(&state_path(t), json.as_bytes());
}

/// Versión que imprime `bin --version` (vacía si no arranca).
pub fn version_of(bin: &Path) -> String {
    let mut cmd = Command::new(bin);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::downloader::hide_console(&mut cmd);
    cmd.output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(60))
        .user_agent("Enn (actualizador de yt-dlp)")
        .build()
}

/// Busca la versión estable y, si es más nueva, la instala verificada.
/// Devuelve la versión instalada, o `None` si ya se tenía la última.
pub fn update_now() -> Result<Option<String>, String> {
    let t = TOOLS.get().ok_or("actualizador sin iniciar")?;
    let Some(asset) = ASSET else {
        return Ok(None); // fuera de Windows se usa el yt-dlp del sistema
    };
    if t.updating.swap(true, Ordering::SeqCst) {
        return Err("ya se está actualizando".into());
    }
    let r = update_inner(t, asset);
    t.updating.store(false, Ordering::SeqCst);
    r
}

fn update_inner(t: &Tools, asset: &str) -> Result<Option<String>, String> {
    let current = version_of(&crate::downloader::yt_dlp_path());
    let ag = agent();
    let rel: serde_json::Value = ag
        .get(RELEASE_API)
        .call()
        .map_err(|e| format!("no se pudo consultar GitHub: {e}"))?
        .into_json()
        .map_err(|e| e.to_string())?;
    save_last_check(t);
    let tag = rel["tag_name"].as_str().unwrap_or_default().to_string();
    if !newer(&tag, &current) {
        return Ok(None);
    }
    let url_of = |name: &str| -> Option<String> {
        rel["assets"].as_array()?.iter().find_map(|a| {
            if a["name"].as_str()? == name {
                a["browser_download_url"].as_str().map(String::from)
            } else {
                None
            }
        })
    };
    let sums_url = url_of("SHA2-256SUMS").ok_or("la publicación no trae SHA2-256SUMS")?;
    let exe_url = url_of(asset).ok_or("la publicación no trae el ejecutable")?;
    let sums = ag
        .get(&sums_url)
        .call()
        .map_err(|e| e.to_string())?
        .into_string()
        .map_err(|e| e.to_string())?;
    let expected = parse_sums(&sums, asset).ok_or("SHA2-256SUMS no trae la suma del ejecutable")?;
    std::fs::create_dir_all(&t.dir).map_err(|e| e.to_string())?;
    let target = t.dir.join(asset);
    let new = t.dir.join(format!("{asset}.new"));
    {
        let resp = ag.get(&exe_url).call().map_err(|e| e.to_string())?;
        let mut f = std::fs::File::create(&new).map_err(|e| e.to_string())?;
        let n = std::io::copy(&mut resp.into_reader().take(MAX_BYTES), &mut f)
            .map_err(|e| e.to_string())?;
        if n >= MAX_BYTES {
            drop(f);
            let _ = std::fs::remove_file(&new);
            return Err("la descarga es demasiado grande".into());
        }
        f.sync_all().map_err(|e| e.to_string())?;
    }
    verify_and_swap(&new, &expected, &target)?;
    // la copia nueva tiene que arrancar; si no, vuelve la anterior
    let got = version_of(&target);
    if got.is_empty() {
        let old = PathBuf::from(format!("{}.old", target.display()));
        let _ = std::fs::remove_file(&target);
        if old.is_file() {
            let _ = std::fs::rename(&old, &target);
        }
        return Err("la versión nueva no arranca; se sigue con la anterior".into());
    }
    crate::player::log_msg(&format!("yt-dlp actualizado: {current} → {got}"));
    Ok(Some(got))
}

fn update_and_tell(app: &tauri::AppHandle) {
    match update_now() {
        Ok(Some(v)) => {
            let _ = app.emit("tools://updated", v);
        }
        Ok(None) => {}
        Err(e) => crate::player::log_warn(&format!("actualizar yt-dlp: {e}")),
    }
}

/// Arranca el actualizador: copia de trabajo en `dir` y búsqueda semanal
/// (la primera, 30 s después de abrir).
pub fn start(app: tauri::AppHandle, dir: PathBuf) {
    let _ = TOOLS.set(Tools {
        dir,
        updating: AtomicBool::new(false),
        last_failure_check: Mutex::new(None),
    });
    std::thread::Builder::new()
        .name("enn-ytdlp".into())
        .spawn(move || {
            std::thread::sleep(STARTUP_DELAY);
            loop {
                if let Some(t) = TOOLS.get() {
                    if due(last_check(t), now_secs(), CHECK_EVERY) {
                        update_and_tell(&app);
                    }
                }
                // Enn puede pasar semanas abierto en la bandeja
                std::thread::sleep(Duration::from_secs(6 * 3600));
            }
        })
        .ok();
}

/// Una descarga falló con un error conocido de yt-dlp desfasado: se busca
/// versión nueva en segundo plano (como mucho una vez por hora).
pub fn on_known_failure(app: &tauri::AppHandle) {
    let Some(t) = TOOLS.get() else {
        return;
    };
    {
        let mut last = t.last_failure_check.lock().unwrap();
        if last.is_some_and(|l| l.elapsed() < FAILURE_COOLDOWN) {
            return;
        }
        *last = Some(Instant::now());
    }
    let app = app.clone();
    std::thread::spawn(move || update_and_tell(&app));
}

/// Para Ajustes: versión en uso, última búsqueda y si está actualizando.
pub fn status() -> serde_json::Value {
    let bin = crate::downloader::yt_dlp_path();
    let t = TOOLS.get();
    serde_json::json!({
        "version": version_of(&bin),
        "last_check": t.and_then(last_check),
        "updating": t.is_some_and(|t| t.updating.load(Ordering::SeqCst)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("enn-tools-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_good_checksum_replaces_the_copy() {
        let d = tmpdir("good");
        let target = d.join("yt-dlp.exe");
        std::fs::write(&target, b"vieja").unwrap();
        let new = d.join("yt-dlp.exe.new");
        std::fs::write(&new, b"nueva").unwrap();
        let sum = format!("{:x}", Sha256::digest(b"nueva"));
        verify_and_swap(&new, &sum, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"nueva");
        assert_eq!(std::fs::read(d.join("yt-dlp.exe.old")).unwrap(), b"vieja");
        assert!(!new.exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_bad_checksum_keeps_the_old_copy() {
        let d = tmpdir("bad");
        let target = d.join("yt-dlp.exe");
        std::fs::write(&target, b"vieja").unwrap();
        let new = d.join("yt-dlp.exe.new");
        std::fs::write(&new, b"corrompida").unwrap();
        let sum = format!("{:x}", Sha256::digest(b"nueva"));
        assert!(verify_and_swap(&new, &sum, &target).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"vieja");
        assert!(!new.exists(), "la descarga mala se borra");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_first_copy_needs_no_old_one() {
        let d = tmpdir("first");
        let target = d.join("yt-dlp.exe");
        let new = d.join("yt-dlp.exe.new");
        std::fs::write(&new, b"nueva").unwrap();
        let sum = format!("{:X}", Sha256::digest(b"nueva")); // en mayúsculas también vale
        verify_and_swap(&new, &sum, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"nueva");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reads_the_published_sums() {
        let text = "aaa111  yt-dlp\nbbb222  yt-dlp.exe\nccc333  yt-dlp_macos\n";
        assert_eq!(parse_sums(text, "yt-dlp.exe").as_deref(), Some("bbb222"));
        assert_eq!(parse_sums(text, "yt-dlp").as_deref(), Some("aaa111"));
        assert_eq!(parse_sums(text, "yt-dlp_x86.exe"), None);
        // formato binario de sha256sum («*nombre»)
        assert_eq!(
            parse_sums("ddd444 *yt-dlp.exe\n", "yt-dlp.exe").as_deref(),
            Some("ddd444")
        );
    }

    #[test]
    fn compares_date_versions() {
        assert!(newer("2026.11.10", "2026.08.19"));
        assert!(newer("2026.08.19.1", "2026.08.19"));
        assert!(!newer("2026.08.19", "2026.08.19"));
        assert!(!newer("2026.01.02", "2026.08.19"));
        assert!(newer("2027.01.01", "2026.12.31"));
        // versión actual desconocida: se actualiza
        assert!(newer("2026.11.10", ""));
        assert!(!newer("", "2026.08.19"));
    }

    #[test]
    fn checks_once_a_week() {
        let week = CHECK_EVERY.as_secs();
        assert!(due(None, 1000, CHECK_EVERY));
        assert!(!due(Some(1000), 1000 + week - 1, CHECK_EVERY));
        assert!(due(Some(1000), 1000 + week, CHECK_EVERY));
        // reloj que fue hacia atrás: no se vuelve loco
        assert!(!due(Some(5000), 1000, CHECK_EVERY));
    }

    /// Con red: baja la versión estable de verdad, la verifica y la arranca.
    /// `cargo test -- --ignored`
    #[test]
    #[ignore]
    fn updates_from_github_for_real() {
        let d = tmpdir("net");
        let _ = TOOLS.set(Tools {
            dir: d.clone(),
            updating: AtomicBool::new(false),
            last_failure_check: Mutex::new(None),
        });
        let before = version_of(&crate::downloader::yt_dlp_path());
        let r = update_now();
        eprintln!("antes {before:?} → {r:?}");
        let got = r.expect("actualizar");
        if let Some(v) = got {
            assert!(
                newer(&v, &before) || before.is_empty(),
                "{v} no es más nueva que {before}"
            );
            assert_eq!(
                working_copy().as_deref(),
                Some(d.join(ASSET.unwrap()).as_path())
            );
            // ya al día: la segunda vez no baja nada
            assert_eq!(update_now().unwrap(), None);
        }
        assert!(last_check(TOOLS.get().unwrap()).is_some());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn recognises_errors_of_an_outdated_ytdlp() {
        for e in [
            "yt-dlp terminó con error (código 1) — ERROR: [youtube] abc: Unable to extract nsig function code",
            "yt-dlp terminó con error (código 1) — ERROR: [youtube] abc: Requested format is not available",
            "yt-dlp terminó con error (código 1) — ERROR: Signature extraction failed: Some formats may be missing",
            "yt-dlp terminó con error (código 1) — ERROR: [youtube] abc: Failed to extract any player response",
        ] {
            assert!(looks_outdated(e), "{e}");
        }
        assert!(!looks_outdated("el vídeo es privado (yt-dlp, código 1)"));
        assert!(!looks_outdated("descarga cancelada"));
    }
}
