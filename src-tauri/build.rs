use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn main() {
    download_sidecars();
    tauri_build::build()
}

// build-force
// include-ui-v0.3
// ui-v0.4
// ui-v0.5

/// yt-dlp y ffmpeg no viven en el repositorio (~100 MB juntos): si faltan, se
/// descargan aquí, la primera vez que se compila. El instalador los empaqueta
/// como sidecars de Tauri (externalBin).
fn download_sidecars() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return; // el port a Linux elegirá sus propios sidecars
    }
    let dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("binaries");
    let _ = std::fs::create_dir_all(&dir);

    // El nombre local (con el triple de destino) es la convención de Tauri
    // para sidecars (`externalBin` en tauri.conf.json); el asset real que
    // publica yt-dlp para Windows x64 se llama solo "yt-dlp.exe" — no
    // "yt-dlp-x86_64-pc-windows-msvc.exe" (esa URL devolvía 404 y dejaba a
    // cualquier clon nuevo del repo sin yt-dlp hasta que alguien lo notara).
    let ytdlp = dir.join("yt-dlp-x86_64-pc-windows-msvc.exe");
    if !ytdlp.is_file() {
        eprintln!("enn: descargando yt-dlp…");
        if ps_download(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
            &ytdlp,
        )
        .is_ok()
            && ytdlp.is_file()
        {
            verify_or_delete(&ytdlp, "yt-dlp.exe");
        }
    }

    let ffmpeg = dir.join("ffmpeg-x86_64-pc-windows-msvc.exe");
    if !ffmpeg.is_file() {
        eprintln!("enn: descargando ffmpeg (build essentials de gyan.dev)…");
        let zip = dir.join("ffmpeg-essentials.zip");
        if !zip.is_file() {
            let _ = ps_download(
                "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
                &zip,
            );
        }
        if zip.is_file() {
            let script = format!(
                "Expand-Archive -Force -Path '{}' -DestinationPath '{}'",
                zip.display(),
                dir.display()
            );
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command", &script])
                .status();
            if let Some(src) = find_file(&dir, "ffmpeg.exe") {
                let _ = std::fs::copy(src, &ffmpeg);
            }
            let _ = std::fs::remove_file(&zip);
            // limpia la carpeta descomprimida (bin/, doc/, …)
            for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                if e.path().is_dir() {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
}

/// Verifica `path` contra el hash SHA-256 publicado por yt-dlp en su propio
/// `SHA2-256SUMS` del mismo release ("latest"), buscando la línea de
/// `asset_name` (el nombre del asset tal como lo publica GitHub, no el
/// nombre local con el triple de Tauri). Si el hash no coincide — descarga
/// corrupta o manipulada en tránsito — borra el archivo en vez de dejar un
/// binario sin verificar en `binaries/`; el resto del build sigue (yt-dlp
/// terminará resuelto por PATH en tiempo de ejecución, con su propio error
/// claro si tampoco está ahí). Si no se puede ni descargar ni parsear la
/// lista de sumas (sin red, GitHub caído...) se deja el binario tal cual:
/// no hay base para decidir que está mal, y bloquear el build entero por un
/// problema de red transitorio sería peor que arrancar sin verificar.
fn verify_or_delete(path: &Path, asset_name: &str) {
    let dir = match path.parent() {
        Some(d) => d,
        None => return,
    };
    let sums_path = dir.join("SHA2-256SUMS.tmp");
    if ps_download(
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS",
        &sums_path,
    )
    .is_err()
        || !sums_path.is_file()
    {
        eprintln!("enn: no se pudo descargar SHA2-256SUMS, se omite la verificación de {asset_name}");
        return;
    }
    let expected = std::fs::read_to_string(&sums_path)
        .ok()
        .and_then(|sums| {
            sums.lines().find_map(|line| {
                let mut parts = line.split_whitespace();
                let hash = parts.next()?;
                let name = parts.next()?.trim_start_matches('*');
                (name == asset_name).then(|| hash.to_ascii_lowercase())
            })
        });
    let _ = std::fs::remove_file(&sums_path);
    let Some(expected) = expected else {
        eprintln!("enn: {asset_name} no aparece en SHA2-256SUMS, se omite la verificación");
        return;
    };

    let script = format!("(Get-FileHash -Algorithm SHA256 -Path '{}').Hash", path.display());
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output();
    let actual = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_ascii_lowercase(),
        _ => {
            eprintln!("enn: no se pudo calcular el hash local de {asset_name}, se omite la verificación");
            return;
        }
    };
    if actual != expected {
        eprintln!(
            "cargo:warning=enn: el hash de {asset_name} no coincide con SHA2-256SUMS (esperado {expected}, obtenido {actual}) — se borra, no se empaqueta un binario sin verificar"
        );
        let _ = std::fs::remove_file(path);
    } else {
        eprintln!("enn: {asset_name} verificado contra SHA2-256SUMS");
    }
}

fn ps_download(url: &str, dest: &Path) -> std::io::Result<()> {
    let script = format!(
        "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '{}' -OutFile '{}' -UseBasicParsing",
        url,
        dest.display()
    );
    let st = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .status()?;
    if !st.success() {
        let _ = std::fs::remove_file(dest);
    }
    Ok(())
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    let mut seen: HashMap<PathBuf, ()> = HashMap::new();
    while let Some(d) = stack.pop() {
        if seen.insert(d.clone(), ()).is_some() {
            continue;
        }
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.file_name().and_then(|n| n.to_str()) == Some(name) {
                return Some(p);
            }
        }
    }
    None
}
