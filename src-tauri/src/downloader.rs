use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::decode;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadTask {
    pub id: u64,
    pub url: String,
    pub state: DownloadState,
    pub path: Option<String>,
    pub title: Option<String>,
    pub progress_percent: f64,
    pub target_dir: String,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum DownloadState {
    #[serde(rename = "queued")]
    Queued,
    #[serde(rename = "downloading")]
    Downloading,
    #[serde(rename = "converting")]
    Converting,
    #[serde(rename = "done")]
    Done,
    #[serde(rename = "error")]
    Error,
}

impl std::fmt::Display for DownloadState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            DownloadState::Queued => "en cola",
            DownloadState::Downloading => "descargando",
            DownloadState::Converting => "convirtiendo",
            DownloadState::Done => "completado",
            DownloadState::Error => "error",
        };
        write!(f, "{s}")
    }
}

struct Job {
    id: u64,
    url: String,
    target_dir: PathBuf,
    /// formato destino del audio: m4a (por defecto), mp3 o flac
    fmt: String,
}

/// Estado compartido del descargador: cola de tareas y un único hilo trabajador
/// (las descargas se ejecutan de una en una para no saturar la red ni el disco).
pub struct Downloader {
    tasks: Mutex<Vec<DownloadTask>>,
    next_id: AtomicU64,
    tx: Mutex<Option<mpsc::Sender<Job>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
    stop_flag: Arc<AtomicBool>,
    /// Procesos yt-dlp vivos por id de tarea (para cancelarlos).
    children: Mutex<HashMap<u64, Arc<Mutex<std::process::Child>>>>,
    /// Tareas canceladas antes de arrancar o para distinguir el fallo.
    cancelled: Mutex<HashSet<u64>>,
    pub app: tauri::AppHandle,
}

impl Downloader {
    pub fn new(app: tauri::AppHandle) -> Self {
        Downloader {
            tasks: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            tx: Mutex::new(None),
            worker: Mutex::new(None),
            stop_flag: Arc::new(AtomicBool::new(false)),
            children: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            app,
        }
    }

    pub fn list(&self) -> Vec<DownloadTask> {
        self.tasks.lock().unwrap().clone()
    }

    /// Encola una descarga. Si `url` es una lista de reproducción (playlist de
    /// YouTube, set de SoundCloud, álbum de Bandcamp…) se expande en una tarea
    /// independiente por elemento — cada una con su propio progreso y botón de
    /// cancelar — en vez de descargar un solo vídeo. Devuelve los ids creados,
    /// en el mismo orden que la lista original.
    ///
    /// `url` ya debería haber pasado por `is_valid_download_url` en el comando
    /// de Tauri que llama a esto; se revalida aquí (y cada entrada expandida
    /// de una lista) porque el valor termina como argumento crudo de yt-dlp —
    /// una "URL" tipo `--exec=...` ejecutaría comandos arbitrarios si llegara sin filtrar.
    pub fn enqueue(&self, url: String, target_dir: PathBuf, fmt: String) -> Vec<u64> {
        if !is_valid_download_url(&url) {
            return Vec::new();
        }
        let entries: Vec<_> = resolve_entries(&url)
            .into_iter()
            .filter(|(u, _)| is_valid_download_url(u))
            .collect();
        let mut ids = Vec::with_capacity(entries.len());
        for (entry_url, title) in entries {
            let id = self.next_id.fetch_add(1, Ordering::SeqCst);
            {
                let mut tasks = self.tasks.lock().unwrap();
                tasks.push(DownloadTask {
                    id,
                    url: entry_url.clone(),
                    state: DownloadState::Queued,
                    path: None,
                    title,
                    progress_percent: 0.0,
                    target_dir: target_dir.to_string_lossy().to_string(),
                    error: None,
                });
            }
            let job = Job {
                id,
                url: entry_url,
                target_dir: target_dir.clone(),
                fmt: fmt.clone(),
            };
            self.ensure_worker();
            if let Some(tx) = self.tx.lock().unwrap().as_ref() {
                let _ = tx.send(job);
            }
            ids.push(id);
        }
        ids
    }

    fn ensure_worker(&self) {
        let mut tx = self.tx.lock().unwrap();
        if tx.is_some() && !self.stop_flag.load(Ordering::SeqCst) {
            return;
        }
        let (stx, rx) = mpsc::channel::<Job>();
        *tx = Some(stx);
        let app = self.app.clone();
        let stop = self.stop_flag.clone();
        let worker = std::thread::spawn(move || worker_loop(&app, rx, stop));
        *self.worker.lock().unwrap() = Some(worker);
    }

    fn set_state(&self, id: u64, state: DownloadState) {
        if let Some(t) = self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id) {
            t.state = state;
        }
    }

    fn set_progress(&self, id: u64, pct: f64) {
        if let Some(t) = self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id) {
            t.progress_percent = pct;
        }
    }

    fn set_title(&self, id: u64, title: &str) {
        if let Some(t) = self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id) {
            t.title = Some(title.to_string());
        }
    }

    fn finish(&self, id: u64, result: &Result<PathBuf, String>) {
        if let Some(t) = self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id) {
            match result {
                Ok(path) => {
                    t.state = DownloadState::Done;
                    t.path = Some(path.to_string_lossy().to_string());
                    t.progress_percent = 100.0;
                }
                Err(e) => {
                    t.state = DownloadState::Error;
                    t.error = Some(e.clone());
                }
            }
        }
        self.children.lock().unwrap().remove(&id);
        self.cancelled.lock().unwrap().remove(&id);
    }

    /// Cancela una descarga: mata el proceso si está en marcha, o la marca
    /// para que el trabajador la salte si aún está en cola.
    pub fn cancel(&self, id: u64) -> Result<(), String> {
        self.cancelled.lock().unwrap().insert(id);
        if let Some(c) = self.children.lock().unwrap().get(&id) {
            let _ = c.lock().unwrap().kill();
        }
        if let Some(t) = self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id) {
            if t.state == DownloadState::Queued {
                t.state = DownloadState::Error;
                t.error = Some("descarga cancelada".into());
            }
        }
        Ok(())
    }

    /// Detiene todo al cerrar la app: corta la cola y mata los yt-dlp en marcha.
    pub fn shutdown(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        // al soltar el canal el trabajador termina la descarga en curso y sale
        *self.tx.lock().unwrap() = None;
        for c in self.children.lock().unwrap().values() {
            let _ = c.lock().unwrap().kill();
        }
    }
}

fn worker_loop(app: &tauri::AppHandle, rx: mpsc::Receiver<Job>, stop: Arc<AtomicBool>) {
    for job in rx {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let d = match app.try_state::<Downloader>() {
            Some(d) => d,
            None => break,
        };
        if d.cancelled.lock().unwrap().contains(&job.id) {
            d.finish(job.id, &Err("descarga cancelada".into()));
            continue;
        }
        d.set_state(job.id, DownloadState::Downloading);
        let result = yt_download(&d, job.id, &job.url, &job.target_dir, &job.fmt, &stop);
        d.finish(job.id, &result);
        let _ = app.emit("download://finished", job.id);
    }
}

pub fn yt_dlp_path() -> PathBuf {
    let exe_names: &[&str] = if cfg!(windows) {
        &["yt-dlp.exe", "yt-dlp-x86_64-pc-windows-msvc.exe"]
    } else {
        // build.rs todavía no descarga sidecars fuera de Windows (ver
        // download_sidecars); en Linux/macOS dependemos de PATH por ahora.
        &["yt-dlp"]
    };
    // En desarrollo el binario vive en src-tauri/binaries/ ; en el instalador se
    // empaqueta junto al ejecutable de la aplicación (sin el sufijo de target).
    if let Some(self_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
    {
        for name in exe_names {
            let candidate = self_dir.join(name);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    // ruta de desarrollo (fuente del proyecto)
    for name in exe_names {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(name);
        if dev.exists() {
            return dev;
        }
    }
    // último recurso: un yt-dlp instalado por el usuario (pip, apt, brew…)
    // y visible en PATH — antes solo ffmpeg_path() buscaba aquí
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(if cfg!(windows) { ';' } else { ':' }) {
            for name in exe_names {
                let p = PathBuf::from(dir).join(name);
                if p.is_file() {
                    return p;
                }
            }
        }
    }
    PathBuf::from(exe_names[0])
}

/// Directorios donde pueden vivir las herramientas empaquetadas (yt-dlp, ffmpeg):
/// junto al ejecutable (instalador) o en src-tauri/binaries (desarrollo).
fn sidecar_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            v.push(d.to_path_buf());
        }
    }
    v.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    v
}

/// ffmpeg empaquetado o del PATH; None si no existe.
pub fn ffmpeg_path() -> Option<PathBuf> {
    for d in sidecar_dirs() {
        for name in ["ffmpeg-x86_64-pc-windows-msvc.exe", "ffmpeg.exe"] {
            let p = d.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    // PATH del sistema (Windows y Unix)
    if let Ok(path) = std::env::var("PATH") {
        let names: [&str; 2] = if cfg!(windows) {
            ["ffmpeg.exe", "ffmpeg"]
        } else {
            ["ffmpeg", "ffmpeg"]
        };
        for dir in path.split([';', ':']) {
            for name in names {
                let p = PathBuf::from(dir).join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Comprueba (una sola vez) que ffmpeg está disponible: --extract-audio lo necesita.
fn ffmpeg_available() -> bool {
    static OK: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *OK.get_or_init(|| ffmpeg_path().is_some())
}

/// Valida que `url` sea una URL http(s) de verdad antes de dejarla llegar a
/// `Command::new(yt_dlp).arg(url)`. yt-dlp parsea sus argumentos con optparse:
/// un solo argv como `--exec=touch pwned` o `-o /etc/passwd` es indistinguible
/// de una opción real si no se filtra antes — y `--exec` ejecuta un comando de
/// shell arbitrario tras la descarga. Exigir el prefijo literal `http(s)://`
/// (no solo "contiene ://") cierra esa vía por completo.
pub(crate) fn is_valid_download_url(url: &str) -> bool {
    let u = url.trim();
    let low = u.to_ascii_lowercase();
    (low.starts_with("http://") || low.starts_with("https://")) && !u.contains(char::is_whitespace)
}

/// Tope duro de elementos por lista para no encolar por accidente una
/// playlist de miles de vídeos (un usuario que pega "Todo YouTube" no debería
/// tumbar la app ni saturar la red).
const MAX_PLAYLIST_ITEMS: usize = 500;

/// Resuelve `url` a la lista de vídeos que hay que descargar, sin descargar
/// nada todavía: si es un solo vídeo, devuelve ese único elemento; si es una
/// lista de reproducción (playlist de YouTube, set de SoundCloud, álbum de
/// Bandcamp…), la expande a una entrada por vídeo con su URL canónica y
/// título cuando yt-dlp lo reporta en el listado plano.
///
/// Usa `--flat-playlist`, que solo pide metadatos ligeros a cada extractor
/// (no descarga audio), así que resolver una lista de cientos de elementos
/// toma segundos, no minutos. Si yt-dlp falla o no imprime nada — enlace
/// raro, sin red, extractor no soportado — cae de vuelta a tratar `url` como
/// un único elemento, igual que el comportamiento anterior.
fn resolve_entries(url: &str) -> Vec<(String, Option<String>)> {
    let bin = yt_dlp_path();
    let mut cmd = Command::new(&bin);
    cmd.arg("--flat-playlist")
        .arg("--no-warnings")
        .arg("--ignore-errors")
        .arg("--print")
        .arg("%(webpage_url)s\t%(title)s")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(ff) = ffmpeg_path() {
        if let Some(dir) = ff.parent() {
            let old = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{};{}", dir.display(), old));
        }
    }
    let out = match cmd.output() {
        Ok(o) if o.status.success() && !o.stdout.is_empty() => o,
        _ => return vec![(url.to_string(), None)],
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut entries = Vec::new();
    for line in text.lines() {
        let mut parts = line.splitn(2, '\t');
        let entry_url = parts.next().unwrap_or("").trim();
        let title = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "NA")
            .map(str::to_string);
        if entry_url.is_empty() || entry_url == "NA" {
            continue;
        }
        entries.push((entry_url.to_string(), title));
        if entries.len() >= MAX_PLAYLIST_ITEMS {
            break;
        }
    }
    if entries.is_empty() {
        vec![(url.to_string(), None)]
    } else {
        entries
    }
}

fn yt_download(
    d: &Downloader,
    id: u64,
    url: &str,
    target_dir: &Path,
    fmt: &str,
    stop: &Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    if !ffmpeg_available() {
        return Err(
            "hace falta ffmpeg para convertir el audio; instálalo (winget install ffmpeg) y vuelve a intentarlo"
                .into(),
        );
    }
    let bin = yt_dlp_path();
    // PathBuf::join usa el separador nativo de cada plataforma (\ en Windows,
    // / en Linux/macOS) — antes se concatenaba "\\" a mano, lo que producía
    // rutas rotas fuera de Windows.
    let out_tmpl = target_dir
        .join("%(title)s - %(uploader)s.%(ext)s")
        .to_string_lossy()
        .to_string();

    // flac conserva la máxima calidad; m4a/mp3 siempre a la mejor tasa
    let fmt = match fmt {
        "mp3" => "mp3",
        "flac" => "flac",
        _ => "m4a",
    };

    let mut cmd = Command::new(&bin);
    cmd.arg("--newline")
        .arg("--no-color")
        // cada Job ya trae la URL de un único elemento (resuelta por
        // resolve_entries antes de encolar), así que forzamos de nuevo
        // --no-playlist para que un enlace ambiguo no vuelva a expandirse aquí
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--progress")
        .arg("--print")
        .arg("ENN-TITLE:%(title)s")
        .arg("--print")
        .arg("after_move:filepath")
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg(fmt)
        .arg("--audio-quality")
        .arg("0")
        .arg("--embed-metadata")
        .arg("--windows-filenames")
        .arg("--trim-filenames")
        .arg("160")
        .arg("-o")
        .arg(out_tmpl)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // ffmpeg empaquetado debe ser visible para yt-dlp
    if let Some(ff) = ffmpeg_path() {
        if let Some(dir) = ff.parent() {
            let old = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{};{}", dir.display(), old));
        }
    }

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(format!("no se pudo iniciar yt-dlp: {e}")),
    };
    let child = Arc::new(Mutex::new(child));
    d.children.lock().unwrap().insert(id, child.clone());
    if d.cancelled.lock().unwrap().contains(&id) || stop.load(Ordering::SeqCst) {
        let _ = child.lock().unwrap().kill();
        return Err("descarga cancelada".into());
    }

    // stderr solo lleva errores reales: se acumula para el mensaje final
    let err_pipe = child.lock().unwrap().stderr.take().unwrap();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        for line in BufReader::new(err_pipe).lines().map_while(Result::ok) {
            if buf.len() < 4000 {
                buf.push_str(&line);
                buf.push('\n');
            }
        }
        buf
    });

    // stdout lleva el progreso (`[download] 42% ...`) y, al final, la ruta
    // absoluta del archivo ya convertido (impresa por --print after_move:filepath)
    let mut stdout = child.lock().unwrap().stdout.take().unwrap();
    let mut final_path: Option<PathBuf> = None;
    let mut last_pct = 0.0f64;
    for line in BufReader::new(&mut stdout).lines().map_while(Result::ok) {
        match classify_line(&line) {
            StreamLine::Progress(pct) => {
                if pct != last_pct {
                    last_pct = pct;
                    d.set_progress(id, pct);
                    let _ = d.app.emit(
                        "download://progress",
                        serde_json::json!({ "id": id, "percent": pct }),
                    );
                }
            }
            StreamLine::Title(title) => {
                d.set_title(id, &title);
            }
            StreamLine::FinalPath(ptext) => {
                // línea impresa por --print: ruta final del archivo
                let p = PathBuf::from(&ptext);
                if p.is_file() {
                    final_path = Some(p);
                }
            }
            StreamLine::Other => {}
        }
    }
    let stderr_out = stderr_thread.join().unwrap_or_default();

    let status = child.lock().unwrap().wait().map_err(|e| e.to_string())?;
    if d.cancelled.lock().unwrap().contains(&id) || stop.load(Ordering::SeqCst) {
        return Err("descarga cancelada".into());
    }
    if !status.success() {
        let code = status.code().unwrap_or(-1);
        return Err(friendly_download_error(code, &stderr_out));
    }

    if let Some(p) = final_path.filter(|p| p.exists()) {
        return Ok(p);
    }
    // respaldo: el archivo de audio más reciente de la carpeta destino
    latest_file_in(target_dir).ok_or_else(|| "se descargó pero no se encontró el archivo".into())
}

/// Traduce el stderr crudo de yt-dlp a un mensaje entendible para el usuario
/// final, cubriendo las causas de fallo más comunes; si ninguna coincide,
/// cae de vuelta a mostrar las últimas líneas de stderr (útil para reportar
/// bugs) en vez de un mensaje genérico sin información.
fn friendly_download_error(code: i32, stderr_out: &str) -> String {
    let low = stderr_out.to_lowercase();
    let tail = || -> String {
        stderr_out
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let reason = if low.contains("video unavailable") || low.contains("this video is unavailable")
    {
        Some("el vídeo ya no está disponible (borrado o retirado por su autor)".to_string())
    } else if low.contains("private video") {
        Some("el vídeo es privado".to_string())
    } else if low.contains("sign in to confirm your age") || low.contains("age-restricted") {
        Some("el vídeo tiene restricción de edad y yt-dlp no pudo saltarla sin iniciar sesión".to_string())
    } else if low.contains("this video is not available") || low.contains("not available in your country") {
        Some("el vídeo no está disponible en tu región".to_string())
    } else if low.contains("http error 403") || low.contains("http error 429") {
        Some("el servidor rechazó la descarga (posible bloqueo temporal por demasiadas peticiones); espera un momento y reintenta".to_string())
    } else if low.contains("unable to download webpage")
        || low.contains("failed to establish a new connection")
        || low.contains("network is unreachable")
        || low.contains("timed out")
    {
        Some("no hay conexión a internet o el servidor no respondió a tiempo".to_string())
    } else if low.contains("no space left on device") {
        Some("no queda espacio en el disco de destino".to_string())
    } else if low.contains("unsupported url") {
        Some("ese enlace no es de un sitio soportado por yt-dlp".to_string())
    } else if low.contains("ffmpeg") && (low.contains("not found") || low.contains("no such file")) {
        Some(
            "no se encontró ffmpeg para convertir el audio; instálalo (winget install ffmpeg) y vuelve a intentarlo"
                .to_string(),
        )
    } else {
        None
    };
    match reason {
        Some(r) => format!("{r} (yt-dlp, código {code})"),
        None => {
            let t = tail();
            let detail = if t.is_empty() {
                String::new()
            } else {
                format!(" — {t}")
            };
            format!("yt-dlp terminó con error (código {code}){detail}")
        }
    }
}

/// Extrae el porcentaje de una línea tipo `[download]  42.5% of ...`
fn parse_percent(line: &str) -> Option<f64> {
    let idx = line.find('%')?;
    let slice = &line[..idx];
    let num = slice.rsplit_once(' ').map(|(_, n)| n).unwrap_or(slice);
    let cleaned: String = num
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    cleaned.parse::<f64>().ok()
}

/// Líneas relevantes de stdout de yt-dlp (--newline --progress --print).
pub(crate) enum StreamLine {
    Progress(f64),
    Title(String),
    FinalPath(String),
    Other,
}

const TITLE_PREFIX: &str = "ENN-TITLE:";

pub(crate) fn classify_line(line: &str) -> StreamLine {
    let t = line.trim();
    if let Some(rest) = t.strip_prefix(TITLE_PREFIX) {
        let title = rest.trim();
        if !title.is_empty() {
            return StreamLine::Title(title.to_string());
        }
        return StreamLine::Other;
    }
    if t.contains("[download]") {
        if let Some(pct) = parse_percent(t) {
            return StreamLine::Progress(pct);
        }
        return StreamLine::Other;
    }
    // la ruta impresa por --print after_move:filepath: sin corchetes, con
    // separador de ruta de Windows y sin ser una URL
    if !t.is_empty()
        && !t.starts_with('[')
        && (t.contains('\\') || t.contains('/'))
        && !t.contains("://")
    {
        return StreamLine::FinalPath(t.to_string());
    }
    StreamLine::Other
}

fn latest_file_in(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            if !decode::is_supported_path(&p) {
                continue;
            }
            if let Ok(md) = p.metadata() {
                if let Ok(mt) = md.modified() {
                    if best.as_ref().map(|(t, _)| mt > *t).unwrap_or(true) {
                        best = Some((mt, p));
                    }
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_real_ytdlp_lines() {
        use StreamLine::*;
        match classify_line("[download]  42.3% of ~3.51MiB at 1.20MiB/s ETA 00:02") {
            Progress(p) => assert!((p - 42.3).abs() < 0.01, "pct={p}"),
            _ => panic!("debería ser progreso"),
        }
        match classify_line("[download] Destination: C:\\musica\\x.webm") {
            Other => {}
            _ => panic!("Destination no es ni progreso ni ruta final"),
        }
        match classify_line("C:\\musica\\canción - autor.m4a") {
            FinalPath(ptext) => assert!(ptext.ends_with(".m4a")),
            _ => panic!("debería ser ruta final"),
        }
        match classify_line("ENN-TITLE:Daft Punk - Get Lucky (Official Video)") {
            Title(t) => assert_eq!(t, "Daft Punk - Get Lucky (Official Video)"),
            _ => panic!("debería ser título"),
        }
        match classify_line("ENN-TITLE:") {
            Other => {}
            _ => panic!("título vacío se ignora"),
        }
        match classify_line("https://www.youtube.com/watch?v=abc") {
            Other => {}
            _ => panic!("una URL no debe tomarse como ruta"),
        }
        match classify_line("") {
            Other => {}
            _ => panic!("línea vacía"),
        }
        match classify_line("ERROR: unable to download video") {
            Other => {}
            _ => panic!("los errores no son rutas"),
        }
    }

    #[test]
    fn url_validator_blocks_arg_injection() {
        assert!(is_valid_download_url("https://www.youtube.com/watch?v=abc"));
        assert!(is_valid_download_url("http://example.com/track.mp3"));
        assert!(!is_valid_download_url("--exec=touch /tmp/pwned"));
        assert!(!is_valid_download_url("-o /etc/passwd"));
        assert!(!is_valid_download_url("file:///etc/passwd"));
        assert!(!is_valid_download_url("javascript:alert(1)"));
        assert!(!is_valid_download_url(""));
        assert!(!is_valid_download_url("https://a.com/x --exec=evil"));
    }

    #[test]
    fn friendly_error_recognizes_common_causes() {
        assert!(friendly_download_error(1, "ERROR: [youtube] abc: Video unavailable")
            .contains("ya no está disponible"));
        assert!(friendly_download_error(1, "ERROR: Private video. Sign in if you've been invited")
            .contains("privado"));
        assert!(friendly_download_error(1, "urllib.error: HTTP Error 429: Too Many Requests")
            .contains("bloqueo temporal"));
        assert!(friendly_download_error(1, "socket.timeout: The read operation timed out")
            .contains("no respondió a tiempo"));
    }

    #[test]
    fn friendly_error_falls_back_to_raw_tail() {
        let msg = friendly_download_error(2, "ERROR: something truly unexpected happened");
        assert!(msg.contains("código 2"));
        assert!(msg.contains("something truly unexpected happened"));
    }

    #[test]
    fn parse_percent_in_line() {
        assert_eq!(
            parse_percent("[download]  42% of 3.5MiB at 1.2MiB/s"),
            Some(42.0)
        );
        assert_eq!(
            parse_percent("[download]  87.5% of 8.0MiB at 4.0MiB/s"),
            Some(87.5)
        );
        assert_eq!(parse_percent("[download]  Destination: nada.m4a"), None);
        assert_eq!(parse_percent(""), None);
    }
}
