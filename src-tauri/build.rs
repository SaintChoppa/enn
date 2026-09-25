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

    let ytdlp = dir.join("yt-dlp-x86_64-pc-windows-msvc.exe");
    if !ytdlp.is_file() {
        eprintln!("enn: descargando yt-dlp…");
        let _ = ps_download(
            "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp-x86_64-pc-windows-msvc.exe",
            &ytdlp,
        );
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
