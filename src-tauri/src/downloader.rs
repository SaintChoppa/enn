use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

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
    /// velocidad actual en bytes/s (0 si no está bajando)
    #[serde(default)]
    pub speed: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum DownloadState {
    #[serde(rename = "queued")]
    Queued,
    /// yt-dlp arrancó pero aún no baja nada (pide la página y los formatos)
    #[serde(rename = "resolving")]
    Resolving,
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
            DownloadState::Resolving => "resolviendo",
            DownloadState::Downloading => "descargando",
            DownloadState::Converting => "convirtiendo",
            DownloadState::Done => "completado",
            DownloadState::Error => "error",
        };
        write!(f, "{s}")
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Job {
    id: u64,
    url: String,
    #[serde(default)]
    title: Option<String>,
    target_dir: PathBuf,
    /// formato destino del audio: m4a (por defecto), mp3 o flac
    fmt: String,
    /// veces que ya se reintentó por un 429/403
    #[serde(default)]
    attempts: u8,
}

/// Descargas a la vez en «Auto».
pub const AUTO_PARALLEL: usize = 3;
/// Tope del ajuste «Descargas a la vez».
pub const MAX_PARALLEL: usize = 6;
/// Primera espera tras un 429/403 (luego 1 min, 2 min… hasta 5 min).
const BACKOFF_BASE: Duration = Duration::from_secs(30);
/// Reintentos de una descarga que el servidor limitó.
const RATE_RETRIES: u8 = 3;
/// Un hilo sin trabajo se va al cabo de esto (se crean otra vez al encolar).
const IDLE_EXIT: Duration = Duration::from_secs(60);

/// Cómo acabó un trabajo, para la adaptación.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Outcome {
    Ok,
    /// 429 o 403: el servidor limita
    RateLimited,
    /// cualquier otro fallo (no cuenta para la adaptación)
    Failed,
}

/// Límite adaptable de trabajos a la vez (Sprint 2, T4). Con un 429/403 baja
/// a 1 y espera 30 s, 1 min, 2 min… hasta 5 min; cuando vuelven a ir bien,
/// sube de uno en uno cada dos aciertos hasta lo pedido.
pub(crate) struct Throttle {
    want: usize,
    limit: usize,
    pub(crate) until: Option<Instant>,
    strikes: u32,
    good: u32,
    base: Duration,
}

impl Throttle {
    pub(crate) fn new(want: usize, base: Duration) -> Self {
        let want = want.clamp(1, MAX_PARALLEL);
        Throttle {
            want,
            limit: want,
            until: None,
            strikes: 0,
            good: 0,
            base,
        }
    }

    pub(crate) fn limit(&self) -> usize {
        self.limit
    }

    pub(crate) fn ready(&self, now: Instant) -> bool {
        self.until.is_none_or(|u| now >= u)
    }

    pub(crate) fn set_want(&mut self, n: usize) {
        let n = n.clamp(1, MAX_PARALLEL);
        // recuperándose de un límite del servidor: subir lo pedido no se
        // salta la subida poco a poco
        self.limit = if self.limit < self.want {
            self.limit.min(n)
        } else {
            n
        };
        self.want = n;
    }

    pub(crate) fn record(&mut self, o: Outcome, now: Instant) {
        match o {
            Outcome::RateLimited => {
                self.limit = 1;
                let wait = self
                    .base
                    .saturating_mul(1u32 << self.strikes.min(16))
                    .min(self.base * 10);
                self.strikes += 1;
                self.good = 0;
                self.until = Some(now + wait);
            }
            Outcome::Ok => {
                self.strikes = 0;
                self.good += 1;
                if self.limit < self.want && self.good >= 2 {
                    self.limit += 1;
                    self.good = 0;
                }
            }
            Outcome::Failed => {}
        }
    }
}

struct SchedState<J> {
    queue: VecDeque<J>,
    active: usize,
    th: Throttle,
    paused: bool,
    closed: bool,
}

/// Cola con límite adaptable: los hilos piden trabajo con `take_timeout` y
/// avisan con `finish`. Nunca hay más de `limit` trabajos en marcha.
pub(crate) struct Sched<J> {
    st: Mutex<SchedState<J>>,
    cv: Condvar,
}

impl<J> Sched<J> {
    pub(crate) fn new(want: usize, base: Duration) -> Self {
        Sched {
            st: Mutex::new(SchedState {
                queue: VecDeque::new(),
                active: 0,
                th: Throttle::new(want, base),
                paused: false,
                closed: false,
            }),
            cv: Condvar::new(),
        }
    }

    pub(crate) fn push(&self, j: J) {
        let mut s = self.st.lock().unwrap();
        s.closed = false;
        s.queue.push_back(j);
        self.cv.notify_all();
    }

    /// Vuelve al principio de la cola (reintento tras un 429).
    pub(crate) fn push_front(&self, j: J) {
        let mut s = self.st.lock().unwrap();
        s.queue.push_front(j);
        self.cv.notify_all();
    }

    /// Siguiente trabajo cuando haya hueco; `None` si pasa `max` sin nada o
    /// la cola se cerró.
    pub(crate) fn take_timeout(&self, max: Duration) -> Option<J> {
        let deadline = Instant::now() + max;
        let mut s = self.st.lock().unwrap();
        loop {
            let now = Instant::now();
            if s.closed {
                return None;
            }
            if !s.paused && !s.queue.is_empty() && s.active < s.th.limit() && s.th.ready(now) {
                s.active += 1;
                return s.queue.pop_front();
            }
            if now >= deadline {
                return None;
            }
            let mut wait = deadline - now;
            if let Some(u) = s.th.until {
                if u > now {
                    wait = wait.min(u - now);
                }
            }
            s = self.cv.wait_timeout(s, wait).unwrap().0;
        }
    }

    pub(crate) fn finish(&self, o: Outcome) {
        let mut s = self.st.lock().unwrap();
        s.active = s.active.saturating_sub(1);
        s.th.record(o, Instant::now());
        self.cv.notify_all();
    }

    /// Saca de la cola los que cumplan `f` (cancelados antes de empezar).
    pub(crate) fn remove(&self, f: impl Fn(&J) -> bool) -> Vec<J> {
        let mut s = self.st.lock().unwrap();
        let (out, keep): (Vec<J>, Vec<J>) = s.queue.drain(..).partition(|j| f(j));
        s.queue = keep.into();
        self.cv.notify_all();
        out
    }

    pub(crate) fn set_want(&self, n: usize) {
        self.st.lock().unwrap().th.set_want(n);
        self.cv.notify_all();
    }

    pub(crate) fn limit(&self) -> usize {
        self.st.lock().unwrap().th.limit()
    }

    /// Cola detenida (disco lleno): no sale nada hasta reanudar.
    pub(crate) fn set_paused(&self, on: bool) {
        self.st.lock().unwrap().paused = on;
        self.cv.notify_all();
    }

    /// (en cola, en marcha)
    pub(crate) fn counts(&self) -> (usize, usize) {
        let s = self.st.lock().unwrap();
        (s.queue.len(), s.active)
    }

    /// Cierra la cola y devuelve lo que quedaba (al salir de la app).
    pub(crate) fn close(&self) -> Vec<J> {
        let mut s = self.st.lock().unwrap();
        s.closed = true;
        let left = s.queue.drain(..).collect();
        self.cv.notify_all();
        left
    }
}

/// Tarea viva (en cola o en marcha) con esa URL: pedir dos veces la misma
/// canción se une a la primera.
fn find_active(tasks: &[DownloadTask], url: &str) -> Option<u64> {
    tasks
        .iter()
        .find(|t| {
            t.url == url
                && matches!(
                    t.state,
                    DownloadState::Queued
                        | DownloadState::Resolving
                        | DownloadState::Downloading
                        | DownloadState::Converting
                )
        })
        .map(|t| t.id)
}

/// Opciones de velocidad de yt-dlp: fragmentos en paralelo y trozos de 10 MB
/// contra la limitación de YouTube, reintentos, y el límite elegido por el
/// usuario (`rate_kib` KiB/s para todo, repartido entre `parallel`).
fn speed_args(rate_kib: u64, parallel: usize) -> Vec<String> {
    let mut a: Vec<String> = [
        "--concurrent-fragments",
        "4",
        "--http-chunk-size",
        "10M",
        "--throttled-rate",
        "100K",
        "--retries",
        "5",
        "--fragment-retries",
        "5",
        "--socket-timeout",
        "15",
    ]
    .map(String::from)
    .to_vec();
    if rate_kib > 0 {
        let each = (rate_kib / parallel.max(1) as u64).max(64);
        a.push("--limit-rate".into());
        a.push(format!("{each}K"));
    }
    a
}

/// Velocidad de una línea de progreso (`… at 1.20MiB/s …`) en bytes/s.
fn parse_speed(line: &str) -> Option<f64> {
    let rest = &line[line.find(" at ")? + 4..];
    let tok = rest.split_whitespace().next()?;
    let tok = tok.strip_suffix("/s")?;
    let cut = tok.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    let n: f64 = tok[..cut].parse().ok()?;
    let mult = match &tok[cut..] {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(n * mult)
}

/// Archivos a medias de una descarga (petición del propietario, 2026-11-12:
/// al cancelar o salir se borran). yt-dlp avisa del nombre que va a usar
/// (`ENN-FILE:`); todo lo que empiece por ese nombre y no estuviera en la
/// carpeta antes de empezar (`.part`, `.ytdl`, miniatura, `.temp.m4a`, el
/// audio a medio convertir…) es de esta descarga.
#[derive(Clone)]
struct Partial {
    dir: PathBuf,
    before: HashSet<std::ffi::OsString>,
    stem: Option<String>,
}

/// Estado compartido del descargador: cola con límite adaptable y un grupo
/// de hilos (Sprint 2, T4: antes era uno solo, de una en una).
pub struct Downloader {
    tasks: Mutex<Vec<DownloadTask>>,
    next_id: AtomicU64,
    sched: Sched<Job>,
    /// hilos trabajadores vivos
    workers: AtomicUsize,
    /// la app se está cerrando: se cortan las descargas en marcha
    stopping: AtomicBool,
    /// Procesos yt-dlp vivos por id de tarea (para cancelarlos).
    children: Mutex<HashMap<u64, Arc<Mutex<std::process::Child>>>>,
    /// Tareas canceladas antes de arrancar o para distinguir el fallo.
    cancelled: Mutex<HashSet<u64>>,
    /// Lo necesario para borrar lo que deja a medias cada descarga en marcha.
    partials: Mutex<HashMap<u64, Partial>>,
    /// trabajos en marcha (para guardarlos si se cierra la app)
    running: Mutex<HashMap<u64, Job>>,
    /// último aviso de avance por tarea (como mucho ~8 por segundo)
    last_emit: Mutex<HashMap<u64, Instant>>,
    /// límite de velocidad total en KiB/s (0 = sin límite)
    rate_kib: AtomicU64,
    /// cola sin terminar guardada al salir, para ofrecer reanudarla
    pending_path: Mutex<Option<PathBuf>>,
    pub app: tauri::AppHandle,
}

impl Downloader {
    pub fn new(app: tauri::AppHandle) -> Self {
        Downloader {
            tasks: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
            sched: Sched::new(AUTO_PARALLEL, BACKOFF_BASE),
            workers: AtomicUsize::new(0),
            stopping: AtomicBool::new(false),
            children: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashSet::new()),
            partials: Mutex::new(HashMap::new()),
            running: Mutex::new(HashMap::new()),
            last_emit: Mutex::new(HashMap::new()),
            rate_kib: AtomicU64::new(0),
            pending_path: Mutex::new(None),
            app,
        }
    }

    pub fn list(&self) -> Vec<DownloadTask> {
        self.tasks.lock().unwrap().clone()
    }

    /// «Descargas a la vez» (0 = Auto) y «Limitar velocidad» (KiB/s, 0 = no).
    pub fn set_limits(&self, parallel: usize, rate_kib: u64) {
        let n = if parallel == 0 {
            AUTO_PARALLEL
        } else {
            parallel
        };
        self.sched.set_want(n);
        self.rate_kib.store(rate_kib, Ordering::Relaxed);
    }

    /// Reanuda una cola detenida (disco lleno).
    pub fn resume(&self) {
        self.sched.set_paused(false);
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
        self.enqueue_entries(entries, target_dir, fmt)
    }

    /// Encola entradas que ya se conocen una a una (resultados del buscador,
    /// pistas de un álbum): no hace falta lanzar yt-dlp para resolverlas, así
    /// que es instantáneo. Cada URL se revalida igual que en `enqueue`.
    pub fn enqueue_known(
        &self,
        entries: Vec<(String, Option<String>)>,
        target_dir: PathBuf,
        fmt: String,
    ) -> Vec<u64> {
        let entries: Vec<_> = entries
            .into_iter()
            .filter(|(u, _)| is_valid_download_url(u))
            .collect();
        self.enqueue_entries(entries, target_dir, fmt)
    }

    fn enqueue_entries(
        &self,
        entries: Vec<(String, Option<String>)>,
        target_dir: PathBuf,
        fmt: String,
    ) -> Vec<u64> {
        // encolar después de un cierre (no debería pasar): se arranca limpio
        self.stopping.store(false, Ordering::SeqCst);
        let mut ids = Vec::with_capacity(entries.len());
        for (entry_url, title) in entries {
            let id = {
                let mut tasks = self.tasks.lock().unwrap();
                if let Some(id) = find_active(&tasks, &entry_url) {
                    ids.push(id);
                    continue;
                }
                let id = self.next_id.fetch_add(1, Ordering::SeqCst);
                tasks.push(DownloadTask {
                    id,
                    url: entry_url.clone(),
                    state: DownloadState::Queued,
                    path: None,
                    title: title.clone(),
                    progress_percent: 0.0,
                    target_dir: target_dir.to_string_lossy().to_string(),
                    error: None,
                    speed: 0.0,
                });
                id
            };
            self.sched.push(Job {
                id,
                url: entry_url,
                title,
                target_dir: target_dir.clone(),
                fmt: fmt.clone(),
                attempts: 0,
            });
            self.emit_task(id, true);
            ids.push(id);
        }
        self.ensure_workers();
        ids
    }

    fn ensure_workers(&self) {
        let (queued, _) = self.sched.counts();
        let want = queued.min(MAX_PARALLEL);
        while self.workers.load(Ordering::SeqCst) < want {
            self.workers.fetch_add(1, Ordering::SeqCst);
            let app = self.app.clone();
            std::thread::Builder::new()
                .name("enn-descarga".into())
                .spawn(move || worker_loop(app))
                .ok();
        }
    }

    fn with_task(&self, id: u64, f: impl FnOnce(&mut DownloadTask)) {
        if let Some(t) = self.tasks.lock().unwrap().iter_mut().find(|t| t.id == id) {
            f(t);
        }
    }

    fn set_state(&self, id: u64, state: DownloadState) {
        self.with_task(id, |t| t.state = state);
    }

    fn set_title(&self, id: u64, title: &str) {
        self.with_task(id, |t| t.title = Some(title.to_string()));
    }

    /// Avisa a la interfaz de cómo va la tarea `id` (`force`: cambio de
    /// estado; si no, como mucho ~8 avisos por segundo por tarea).
    fn emit_task(&self, id: u64, force: bool) {
        if !force {
            let mut le = self.last_emit.lock().unwrap();
            let now = Instant::now();
            if le
                .get(&id)
                .is_some_and(|t| now.duration_since(*t) < Duration::from_millis(120))
            {
                return;
            }
            le.insert(id, now);
        }
        let task = self
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|t| t.id == id)
            .cloned();
        if let Some(t) = task {
            let _ = self.app.emit("download://task", t);
        }
    }

    fn on_progress(&self, id: u64, pct: f64, speed: f64) {
        let mut state_changed = false;
        self.with_task(id, |t| {
            if t.state == DownloadState::Resolving {
                t.state = DownloadState::Downloading;
                state_changed = true;
            }
            t.progress_percent = pct;
            t.speed = speed;
        });
        self.emit_task(id, state_changed);
    }

    fn on_converting(&self, id: u64) {
        let mut changed = false;
        self.with_task(id, |t| {
            if t.state != DownloadState::Converting {
                t.state = DownloadState::Converting;
                t.progress_percent = 100.0;
                t.speed = 0.0;
                changed = true;
            }
        });
        if changed {
            self.emit_task(id, true);
        }
    }

    fn finish(&self, id: u64, result: &Result<PathBuf, String>) {
        self.with_task(id, |t| {
            t.speed = 0.0;
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
        });
        self.children.lock().unwrap().remove(&id);
        self.cancelled.lock().unwrap().remove(&id);
        self.last_emit.lock().unwrap().remove(&id);
    }

    /// Cancela una descarga: mata el proceso si está en marcha, o la saca
    /// de la cola si aún no empezó.
    pub fn cancel(&self, id: u64) -> Result<(), String> {
        self.cancelled.lock().unwrap().insert(id);
        let child = self.children.lock().unwrap().get(&id).cloned();
        if let Some(c) = child {
            kill_tree(&mut c.lock().unwrap());
        }
        if !self.sched.remove(|j| j.id == id).is_empty() {
            self.finish(id, &Err("descarga cancelada".into()));
            self.emit_task(id, true);
        }
        Ok(())
    }

    /// «Cancelar todas»: las que están en cola y las que están en marcha.
    pub fn cancel_all(&self) {
        let ids: Vec<u64> = self
            .tasks
            .lock()
            .unwrap()
            .iter()
            .filter(|t| find_active(std::slice::from_ref(t), &t.url).is_some())
            .map(|t| t.id)
            .collect();
        for id in ids {
            let _ = self.cancel(id);
        }
    }

    /// Dónde guardar la cola sin terminar al salir.
    pub fn set_pending_store(&self, path: PathBuf) {
        *self.pending_path.lock().unwrap() = Some(path);
    }

    /// Cuántas descargas quedaron sin terminar la última vez que se cerró Enn.
    pub fn pending_count(&self) -> usize {
        self.read_pending().len()
    }

    /// Reanuda (o descarta) la cola guardada al salir. Devuelve los ids nuevos.
    pub fn pending_take(&self, resume: bool) -> Vec<u64> {
        let jobs = self.read_pending();
        if let Some(p) = self.pending_path.lock().unwrap().as_ref() {
            let _ = std::fs::remove_file(p);
        }
        if !resume {
            return Vec::new();
        }
        let mut ids = Vec::new();
        for j in jobs {
            if j.target_dir.is_dir() && is_valid_download_url(&j.url) {
                ids.extend(self.enqueue_entries(vec![(j.url, j.title)], j.target_dir, j.fmt));
            }
        }
        ids
    }

    fn read_pending(&self) -> Vec<Job> {
        let path = self.pending_path.lock().unwrap().clone();
        path.and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Detiene todo al **salir** de la app (menú de la bandeja → Salir): corta
    /// la cola y mata los yt-dlp en marcha. No se llama al cerrar la ventana,
    /// que solo la esconde en la bandeja (auditoría 2026-11-12, bug #2).
    pub fn shutdown(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        // lo que no terminó se guarda para ofrecer reanudarlo al abrir
        let mut left: Vec<Job> = self.running.lock().unwrap().values().cloned().collect();
        left.sort_by_key(|j| j.id);
        left.extend(self.sched.close());
        if let Some(p) = self.pending_path.lock().unwrap().as_ref() {
            if left.is_empty() {
                let _ = std::fs::remove_file(p);
            } else if let Ok(json) = serde_json::to_string(&left) {
                let _ = crate::fsutil::write_atomic(p, json.as_bytes());
            }
        }
        let kids: Vec<_> = self.children.lock().unwrap().values().cloned().collect();
        for c in &kids {
            kill_tree(&mut c.lock().unwrap());
        }
        // la app se cierra justo después: se limpia aquí mismo, sin esperar
        // a que el trabajador llegue a hacerlo
        let ids: Vec<u64> = self.partials.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.clean_partial(id);
        }
    }

    fn track_partial(&self, id: u64, dir: &Path) {
        let before = file_names(dir);
        self.partials.lock().unwrap().insert(
            id,
            Partial {
                dir: dir.to_path_buf(),
                before,
                stem: None,
            },
        );
    }

    fn set_partial_stem(&self, id: u64, file: &str) {
        let stem = Path::new(file)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty());
        if let Some(p) = self.partials.lock().unwrap().get_mut(&id) {
            p.stem = stem;
        }
    }

    /// Borra lo que dejó a medias la descarga `id` (cancelada o cortada al salir).
    fn clean_partial(&self, id: u64) {
        let info = self.partials.lock().unwrap().get(&id).cloned();
        if let Some(Partial {
            dir,
            before,
            stem: Some(stem),
        }) = info
        {
            for f in partial_files(&dir, &stem, &before) {
                remove_soon(&f);
            }
        }
        self.partials.lock().unwrap().remove(&id);
    }

    fn drop_partial(&self, id: u64) {
        self.partials.lock().unwrap().remove(&id);
    }

    fn is_cancelled(&self, id: u64) -> bool {
        self.cancelled.lock().unwrap().contains(&id) || self.stopping.load(Ordering::SeqCst)
    }

    /// Una descarga entera. Devuelve cómo acabó para la adaptación.
    fn run_job(&self, job: Job) -> Outcome {
        let id = job.id;
        if self.is_cancelled(id) {
            self.finish(id, &Err("descarga cancelada".into()));
            self.emit_task(id, true);
            return Outcome::Failed;
        }
        self.set_state(id, DownloadState::Resolving);
        self.emit_task(id, true);
        self.running.lock().unwrap().insert(id, job.clone());
        let result = yt_download(self, &job);
        self.running.lock().unwrap().remove(&id);
        // solo se borra si de verdad no terminó: un «cancelar» pulsado justo
        // después de acabar no debe llevarse el archivo bueno
        let cancelled = self.is_cancelled(id);
        if result.is_err() && cancelled {
            self.clean_partial(id);
        } else {
            self.drop_partial(id);
        }
        if let Err(e) = &result {
            // un yt-dlp desfasado da estos errores: se busca versión nueva
            if !cancelled && (crate::tools::looks_outdated(e) || is_rate_limited(e)) {
                crate::tools::on_known_failure(&self.app);
            }
            if !cancelled && is_rate_limited(e) {
                if job.attempts < RATE_RETRIES {
                    // a esperar: vuelve al principio de la cola
                    self.with_task(id, |t| {
                        t.state = DownloadState::Queued;
                        t.progress_percent = 0.0;
                        t.speed = 0.0;
                    });
                    self.emit_task(id, true);
                    self.sched.push_front(Job {
                        attempts: job.attempts + 1,
                        ..job
                    });
                    let _ = self.app.emit("download://throttled", ());
                    return Outcome::RateLimited;
                }
            } else if !cancelled && is_disk_full(e) {
                // sin sitio: se detiene la cola con un aviso claro
                self.sched.set_paused(true);
                let _ = self.app.emit("download://halted", e.clone());
            }
        }
        self.finish(id, &result);
        self.emit_task(id, true);
        let _ = self.app.emit("download://finished", id);
        match &result {
            Ok(_) => Outcome::Ok,
            Err(e) if is_rate_limited(e) => Outcome::RateLimited,
            Err(_) => Outcome::Failed,
        }
    }
}

fn is_rate_limited(e: &str) -> bool {
    e.contains("bloqueo temporal")
}

fn is_disk_full(e: &str) -> bool {
    e.contains("no queda espacio")
}

fn worker_loop(app: tauri::AppHandle) {
    loop {
        let Some(d) = app.try_state::<Downloader>() else {
            return;
        };
        match d.sched.take_timeout(IDLE_EXIT) {
            Some(job) => {
                let o = d.run_job(job);
                d.sched.finish(o);
            }
            None => {
                // sin trabajo: el hilo se va; si justo entró algo, se queda
                d.workers.fetch_sub(1, Ordering::SeqCst);
                let (queued, _) = d.sched.counts();
                if queued > 0 && !d.stopping.load(Ordering::SeqCst) {
                    d.workers.fetch_add(1, Ordering::SeqCst);
                    continue;
                }
                return;
            }
        }
    }
}

pub fn yt_dlp_path() -> PathBuf {
    // copia de trabajo al día (Sprint 2, T5), si el actualizador ya bajó una
    if let Some(p) = crate::tools::working_copy() {
        return p;
    }
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
/// Líneas de un flujo de yt-dlp decodificadas con pérdida: antes se usaba
/// `lines().map_while(Result::ok)`, que ante el primer byte no UTF-8 dejaba de
/// leer en silencio (y la ruta final del archivo nunca llegaba).
fn lossy_lines<R: std::io::Read>(r: R) -> impl Iterator<Item = String> {
    BufReader::new(r)
        .split(b'\n')
        .map_while(Result::ok)
        .map(|b| {
            let s = String::from_utf8_lossy(&b);
            s.trim_end_matches('\r').to_string()
        })
}

fn resolve_entries(url: &str) -> Vec<(String, Option<String>)> {
    let bin = yt_dlp_path();
    let mut cmd = Command::new(&bin);
    cmd.arg("--flat-playlist")
        .arg("--no-warnings")
        .arg("--ignore-errors")
        // sin esto yt-dlp escribe en la página de códigos de la consola de
        // Windows y un título en ruso/japonés lo hace fallar (no imprime nada)
        .arg("--encoding")
        .arg("utf-8")
        .arg("--print")
        .arg("%(webpage_url)s\t%(title)s")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(ff) = ffmpeg_path() {
        if let Some(dir) = ff.parent() {
            // separador por plataforma: con `;` fijo, en Linux/macOS el PATH
            // que recibía yt-dlp quedaba corrupto (allí el separador es `:`) y
            // no encontraba el ffmpeg que sí estaba en el PATH del sistema
            let sep = if cfg!(windows) { ';' } else { ':' };
            let old = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}{sep}{old}", dir.display()));
        }
    }
    hide_console(&mut cmd);
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

fn yt_download(d: &Downloader, job: &Job) -> Result<PathBuf, String> {
    let (id, url, target_dir) = (job.id, job.url.as_str(), job.target_dir.as_path());
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
    let fmt = match job.fmt.as_str() {
        "mp3" => "mp3",
        "flac" => "flac",
        _ => "m4a",
    };

    let mut cmd = Command::new(&bin);
    cmd.arg("--newline")
        .arg("--no-color")
        // Bug 2026-11-12: sin `--encoding utf-8`, en Windows yt-dlp escribía
        // su salida en cp1252. Con un título en ruso (cirílico) fallaba al
        // imprimirlo y abortaba la descarga; con «ü», «ñ»… imprimía bytes que
        // no son UTF-8 y el lector de abajo dejaba de leer, así que la ruta
        // final nunca llegaba (quedaba solo la miniatura .jpg suelta).
        .arg("--encoding")
        .arg("utf-8")
        // cada Job ya trae la URL de un único elemento (resuelta por
        // resolve_entries antes de encolar), así que forzamos de nuevo
        // --no-playlist para que un enlace ambiguo no vuelva a expandirse aquí
        .arg("--no-playlist")
        .arg("--no-warnings")
        .arg("--progress")
        .args(speed_args(
            d.rate_kib.load(Ordering::Relaxed),
            d.sched.limit(),
        ))
        .arg("--print")
        .arg("ENN-TITLE:%(title)s")
        // nombre que va a escribir: sirve para borrar lo que quede a medias
        .arg("--print")
        .arg("ENN-FILE:%(filename)s")
        .arg("--print")
        .arg("after_move:filepath")
        .arg("--extract-audio")
        .arg("--audio-format")
        .arg(fmt)
        .arg("--audio-quality")
        .arg("0")
        .arg("--embed-metadata")
        // La portada no es decoración: de ella sale el color con el que se
        // tiñe toda la interfaz (ui/palette.js). Sin esto los archivos
        // llegan sin arte y la app se queda en plateado neutro.
        // YouTube sirve la miniatura en webp; se convierte a jpg porque es
        // lo que aceptan los tres contenedores que ofrecemos (m4a, mp3, flac).
        .arg("--embed-thumbnail")
        .arg("--convert-thumbnails")
        .arg("jpg")
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
            // separador por plataforma: con `;` fijo, en Linux/macOS el PATH
            // que recibía yt-dlp quedaba corrupto (allí el separador es `:`) y
            // no encontraba el ffmpeg que sí estaba en el PATH del sistema
            let sep = if cfg!(windows) { ';' } else { ':' };
            let old = std::env::var("PATH").unwrap_or_default();
            cmd.env("PATH", format!("{}{sep}{old}", dir.display()));
        }
    }

    hide_console_low(&mut cmd);
    d.track_partial(id, target_dir);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(format!("no se pudo iniciar yt-dlp: {e}")),
    };
    let child = Arc::new(Mutex::new(child));
    d.children.lock().unwrap().insert(id, child.clone());
    if d.is_cancelled(id) {
        kill_tree(&mut child.lock().unwrap());
        return Err("descarga cancelada".into());
    }

    // stderr solo lleva errores reales: se acumula para el mensaje final
    let err_pipe = child.lock().unwrap().stderr.take().unwrap();
    let stderr_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        for line in lossy_lines(err_pipe) {
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
    for line in lossy_lines(&mut stdout) {
        match classify_line(&line) {
            StreamLine::Progress(pct) => {
                d.on_progress(id, pct, parse_speed(&line).unwrap_or(0.0));
            }
            StreamLine::Converting => d.on_converting(id),
            StreamLine::Title(title) => {
                d.set_title(id, &title);
            }
            StreamLine::File(file) => {
                d.set_partial_stem(id, &file);
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
    if d.is_cancelled(id) {
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
pub(crate) fn friendly_download_error(code: i32, stderr_out: &str) -> String {
    let low = stderr_out.to_lowercase();
    let tail = || -> String {
        stderr_out
            .lines()
            .rev()
            .take(3)
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let reason = if low.contains("video unavailable") || low.contains("this video is unavailable") {
        Some("el vídeo ya no está disponible (borrado o retirado por su autor)".to_string())
    } else if low.contains("private video") {
        Some("el vídeo es privado".to_string())
    } else if low.contains("sign in to confirm your age") || low.contains("age-restricted") {
        Some(
            "el vídeo tiene restricción de edad y yt-dlp no pudo saltarla sin iniciar sesión"
                .to_string(),
        )
    } else if low.contains("this video is not available")
        || low.contains("not available in your country")
    {
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
    } else if low.contains("ffmpeg") && (low.contains("not found") || low.contains("no such file"))
    {
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
    /// Nombre que yt-dlp va a escribir (`ENN-FILE:`), antes de descargar.
    File(String),
    /// Ya bajó: ffmpeg convierte, etiqueta y pone la carátula.
    Converting,
    FinalPath(String),
    Other,
}

const TITLE_PREFIX: &str = "ENN-TITLE:";
const FILE_PREFIX: &str = "ENN-FILE:";

pub(crate) fn classify_line(line: &str) -> StreamLine {
    let t = line.trim();
    if let Some(rest) = t.strip_prefix(TITLE_PREFIX) {
        let title = rest.trim();
        if !title.is_empty() {
            return StreamLine::Title(title.to_string());
        }
        return StreamLine::Other;
    }
    if let Some(rest) = t.strip_prefix(FILE_PREFIX) {
        let file = rest.trim();
        if !file.is_empty() && file != "NA" {
            return StreamLine::File(file.to_string());
        }
        return StreamLine::Other;
    }
    const STAGES: [&str; 5] = [
        "[ExtractAudio]",
        "[Metadata]",
        "[EmbedThumbnail]",
        "[ThumbnailsConvertor]",
        "[Fixup",
    ];
    if STAGES.iter().any(|p| t.starts_with(p)) {
        return StreamLine::Converting;
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

/// Sin ventana de consola: Enn es una app de ventana y cada yt-dlp o ffmpeg
/// lanzado sin esto abría una consola negra un instante.
pub(crate) fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Como `hide_console` y además con prioridad baja: las descargas no le
/// quitan CPU al audio ni a la interfaz.
fn hide_console_low(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS
        cmd.creation_flags(0x0800_0000 | 0x0000_4000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Mata yt-dlp **y sus hijos** (ffmpeg): en Windows matar al padre no mata
/// al hijo, y el ffmpeg huérfano seguía escribiendo y bloqueando el archivo.
pub(crate) fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status();
    }
    let _ = child.kill();
}

fn file_names(dir: &Path) -> HashSet<std::ffi::OsString> {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default()
}

/// Archivos de `dir` que empiezan por `stem.` y no estaban en `before`.
fn partial_files(dir: &Path, stem: &str, before: &HashSet<std::ffi::OsString>) -> Vec<PathBuf> {
    let prefix = format!("{stem}.");
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| !before.contains(&e.file_name()))
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect()
}

/// Borra `p`; en Windows el proceso recién matado puede tardar unos
/// milisegundos en soltar el archivo, así que se reintenta un segundo.
fn remove_soon(p: &Path) {
    for _ in 0..10 {
        if std::fs::remove_file(p).is_ok() || !p.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
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

    /// Al cancelar se borra solo lo de esta descarga: ni lo que ya estaba
    /// (otra copia de la misma canción) ni archivos de otras canciones.
    #[test]
    fn partial_files_only_new_and_same_stem() {
        let dir = std::env::temp_dir().join(format!("enn-partial-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Mr. Brightside - The Killers.flac"), b"vieja").unwrap();
        std::fs::write(dir.join("Otra - Autor.m4a"), b"otra").unwrap();
        let before = file_names(&dir);
        for f in [
            "Mr. Brightside - The Killers.webm.part",
            "Mr. Brightside - The Killers.webm.ytdl",
            "Mr. Brightside - The Killers.jpg",
            "Mr. Brightside - The Killers.temp.m4a",
            "Mr. Brightside - The Killers 2.m4a",
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let mut got: Vec<String> = partial_files(&dir, "Mr. Brightside - The Killers", &before)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        got.sort();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got,
            [
                "Mr. Brightside - The Killers.jpg",
                "Mr. Brightside - The Killers.temp.m4a",
                "Mr. Brightside - The Killers.webm.part",
                "Mr. Brightside - The Killers.webm.ytdl",
            ]
        );
    }

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
        match classify_line("ENN-FILE:C:\\musica\\Mr. Brightside - The Killers.webm") {
            File(f) => assert!(f.ends_with("The Killers.webm")),
            _ => panic!("debería ser el nombre previsto"),
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
        assert!(
            friendly_download_error(1, "ERROR: [youtube] abc: Video unavailable")
                .contains("ya no está disponible")
        );
        assert!(
            friendly_download_error(1, "ERROR: Private video. Sign in if you've been invited")
                .contains("privado")
        );
        assert!(
            friendly_download_error(1, "urllib.error: HTTP Error 429: Too Many Requests")
                .contains("bloqueo temporal")
        );
        assert!(
            friendly_download_error(1, "socket.timeout: The read operation timed out")
                .contains("no respondió a tiempo")
        );
    }

    #[test]
    fn friendly_error_falls_back_to_raw_tail() {
        let msg = friendly_download_error(2, "ERROR: something truly unexpected happened");
        assert!(msg.contains("código 2"));
        assert!(msg.contains("something truly unexpected happened"));
    }

    // ------------------------------------------------ Sprint 2, T4

    #[test]
    fn throttle_drops_to_one_backs_off_and_recovers_slowly() {
        let base = Duration::from_secs(30);
        let t0 = Instant::now();
        let mut th = Throttle::new(3, base);
        assert_eq!(th.limit(), 3);
        assert!(th.ready(t0));
        // un 429: un solo trabajo y 30 s de espera
        th.record(Outcome::RateLimited, t0);
        assert_eq!(th.limit(), 1);
        assert!(!th.ready(t0 + Duration::from_secs(29)));
        assert!(th.ready(t0 + Duration::from_secs(30)));
        // seguidos: 1 min, 2 min, 4 min y como mucho 5 min
        let mut waits = Vec::new();
        for _ in 0..5 {
            let now = t0 + Duration::from_secs(1000);
            th.record(Outcome::RateLimited, now);
            waits.push(th.until.unwrap() - now);
        }
        assert_eq!(
            waits.iter().map(|d| d.as_secs()).collect::<Vec<_>>(),
            [60, 120, 240, 300, 300]
        );
        // vuelve a ir bien: sube de uno en uno cada dos aciertos
        let later = t0 + Duration::from_secs(5000);
        th.record(Outcome::Ok, later);
        assert_eq!(th.limit(), 1);
        th.record(Outcome::Ok, later);
        assert_eq!(th.limit(), 2);
        th.record(Outcome::Ok, later);
        th.record(Outcome::Ok, later);
        assert_eq!(th.limit(), 3);
        th.record(Outcome::Ok, later);
        th.record(Outcome::Ok, later);
        assert_eq!(th.limit(), 3, "nunca pasa de lo pedido");
        // tras recuperarse, un 429 nuevo vuelve a esperar 30 s, no 5 min
        th.record(Outcome::RateLimited, later);
        assert_eq!((th.until.unwrap() - later).as_secs(), 30);
        // un fallo normal no cuenta ni a favor ni en contra
        let mut th = Throttle::new(2, base);
        th.record(Outcome::Failed, t0);
        assert_eq!(th.limit(), 2);
        assert!(th.ready(t0));
    }

    #[test]
    fn changing_the_setting_moves_the_limit() {
        let mut th = Throttle::new(3, Duration::from_secs(30));
        th.set_want(5);
        assert_eq!(th.limit(), 5);
        th.set_want(9);
        assert_eq!(th.limit(), 6, "como mucho 6");
        th.set_want(0);
        assert_eq!(th.limit(), 1, "al menos 1");
        // limitado por el servidor: bajar lo pedido baja el límite, subirlo no
        th.set_want(4);
        th.record(Outcome::RateLimited, Instant::now());
        th.set_want(6);
        assert_eq!(th.limit(), 1);
    }

    /// Trabajos simulados: corre `n` con `threads` hilos y devuelve el pico
    /// de trabajos a la vez.
    fn run_fake(sched: &Arc<Sched<u32>>, n: u32, threads: usize, work: Duration) -> usize {
        let now = Arc::new(AtomicU64::new(0));
        let peak = Arc::new(AtomicU64::new(0));
        for i in 0..n {
            sched.push(i);
        }
        let hs: Vec<_> = (0..threads)
            .map(|_| {
                let (s, now, peak) = (sched.clone(), now.clone(), peak.clone());
                std::thread::spawn(move || {
                    while let Some(_j) = s.take_timeout(Duration::from_millis(300)) {
                        let c = now.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(c, Ordering::SeqCst);
                        std::thread::sleep(work);
                        now.fetch_sub(1, Ordering::SeqCst);
                        s.finish(Outcome::Ok);
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        peak.load(Ordering::SeqCst) as usize
    }

    #[test]
    fn the_pool_never_runs_more_than_the_limit() {
        let s = Arc::new(Sched::new(3, Duration::from_millis(50)));
        let peak = run_fake(&s, 12, 6, Duration::from_millis(20));
        assert_eq!(peak, 3);
        assert_eq!(s.counts(), (0, 0), "nada en cola ni en marcha");
        s.set_want(1);
        assert_eq!(run_fake(&s, 4, 6, Duration::from_millis(10)), 1);
    }

    #[test]
    fn removing_a_queued_job_frees_its_place() {
        let s: Sched<u32> = Sched::new(1, Duration::from_millis(50));
        for i in 0..4 {
            s.push(i);
        }
        assert_eq!(s.take_timeout(Duration::from_millis(10)), Some(0));
        // ocupado: el siguiente no sale hasta que acabe el primero
        assert_eq!(s.take_timeout(Duration::from_millis(30)), None);
        // se cancela el 1 (en cola): al acabar el 0 sale directamente el 2
        assert_eq!(s.remove(|j| *j == 1), vec![1]);
        s.finish(Outcome::Ok);
        assert_eq!(s.take_timeout(Duration::from_millis(10)), Some(2));
        assert_eq!(s.counts(), (1, 1));
    }

    #[test]
    fn a_rate_limit_holds_the_queue_until_the_wait_is_over() {
        // márgenes amplios: en las máquinas de la CI (macOS) una espera de
        // 60 ms llegó a durar más que la pausa de 120 ms y la prueba fallaba
        // sin que el planificador hiciera nada mal
        let s: Sched<u32> = Sched::new(3, Duration::from_millis(500));
        s.push(1);
        s.push(2);
        assert_eq!(s.take_timeout(Duration::from_millis(10)), Some(1));
        s.finish(Outcome::RateLimited);
        let t = Instant::now();
        assert_eq!(s.take_timeout(Duration::from_millis(50)), None, "esperando");
        assert_eq!(s.take_timeout(Duration::from_millis(3000)), Some(2));
        assert!(t.elapsed() >= Duration::from_millis(480), "{:?}", t.elapsed());
    }

    #[test]
    fn paused_queues_keep_their_jobs() {
        let s: Sched<u32> = Sched::new(2, Duration::from_millis(50));
        s.push(1);
        s.set_paused(true);
        assert_eq!(s.take_timeout(Duration::from_millis(30)), None);
        s.set_paused(false);
        assert_eq!(s.take_timeout(Duration::from_millis(30)), Some(1));
    }

    #[test]
    fn conversion_lines_and_speed_are_recognised() {
        use StreamLine::*;
        for l in [
            "[ExtractAudio] Destination: C:\\m\\x.m4a",
            "[Metadata] Adding metadata to \"C:\\m\\x.m4a\"",
            "[EmbedThumbnail] ffmpeg: Adding thumbnail to \"C:\\m\\x.m4a\"",
            "[ThumbnailsConvertor] Converting thumbnail \"x.webp\" to jpg",
        ] {
            assert!(matches!(classify_line(l), Converting), "{l}");
        }
        assert_eq!(
            parse_speed("[download]  42.3% of ~3.51MiB at 1.20MiB/s ETA 00:02"),
            Some(1.2 * 1024.0 * 1024.0)
        );
        assert_eq!(
            parse_speed("[download]  10.0% of 3.5MiB at  512.00KiB/s ETA 00:05"),
            Some(512.0 * 1024.0)
        );
        assert_eq!(
            parse_speed("[download]   0.0% of 3.5MiB at Unknown B/s ETA Unknown"),
            None
        );
        assert_eq!(parse_speed("[download] 100% of 3.5MiB in 00:00:02"), None);
    }

    #[test]
    fn the_same_song_asked_twice_joins_the_first() {
        let task = |id, url: &str, state| DownloadTask {
            id,
            url: url.into(),
            state,
            path: None,
            title: None,
            progress_percent: 0.0,
            target_dir: String::new(),
            error: None,
            speed: 0.0,
        };
        let tasks = vec![
            task(
                1,
                "https://music.youtube.com/watch?v=aaaaaaaaaaa",
                DownloadState::Done,
            ),
            task(
                2,
                "https://music.youtube.com/watch?v=bbbbbbbbbbb",
                DownloadState::Downloading,
            ),
            task(
                3,
                "https://music.youtube.com/watch?v=ccccccccccc",
                DownloadState::Queued,
            ),
        ];
        assert_eq!(
            find_active(&tasks, "https://music.youtube.com/watch?v=bbbbbbbbbbb"),
            Some(2)
        );
        assert_eq!(
            find_active(&tasks, "https://music.youtube.com/watch?v=ccccccccccc"),
            Some(3)
        );
        // una que ya terminó se puede volver a pedir
        assert_eq!(
            find_active(&tasks, "https://music.youtube.com/watch?v=aaaaaaaaaaa"),
            None
        );
    }

    #[test]
    fn ytdlp_gets_the_fast_and_robust_options() {
        let a = speed_args(0, 3);
        let s = a.join(" ");
        for want in [
            "--concurrent-fragments 4",
            "--http-chunk-size 10M",
            "--throttled-rate 100K",
            "--retries 5",
            "--fragment-retries 5",
            "--socket-timeout 15",
        ] {
            assert!(s.contains(want), "falta {want}: {s}");
        }
        assert!(!s.contains("--limit-rate"));
        // 3 MB/s para todo, repartido entre 3 descargas
        assert!(speed_args(3072, 3).join(" ").contains("--limit-rate 1024K"));
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
