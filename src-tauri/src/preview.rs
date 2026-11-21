//! Vista previa de 10 s en Descargas (Sprint 2).
//!
//! Elegir qué 10 s suenan: la mejor ventana de «lo más reproducido» de
//! YouTube (heatmap) o, sin datos, un punto fijo de la canción.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;

/// Lo que yt-dlp dice de un vídeo para poder cortar su vista previa.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub url: String,
    pub ext: String,
    pub dur: Option<f64>,
    pub is_live: bool,
    pub heat: Vec<HeatSeg>,
}

/// Volumen de la vista previa: los audios de YouTube vienen más altos que la
/// biblioteca normalizada.
pub const GAIN_DB: f32 = -4.0;
/// Caché de clips (un clip pesa ≈163 KB: ≈370 clips).
pub const CACHE_BYTES: u64 = 60 * 1024 * 1024;
/// Lo resuelto por yt-dlp sirve 6 h (las URL de YouTube caducan).
const RESOLVE_TTL: Duration = Duration::from_secs(6 * 3600);
/// Plazos: resolver (≈3,3 s normal) y cortar (≈0,2 s).
const RESOLVE_MAX: Duration = Duration::from_secs(12);
const CUT_MAX: Duration = Duration::from_secs(15);

/// Lee las cinco líneas de `--print` (duración, directo, extensión, heatmap, URL).
pub fn parse_resolved(out: &str) -> Option<Resolved> {
    let mut l = out.lines().map(str::trim);
    let dur = l.next()?.parse::<f64>().ok().filter(|d| *d > 0.0);
    let is_live = l.next()? == "True";
    let ext = l.next()?.to_string();
    let heat = serde_json::from_str::<Vec<HeatSeg>>(l.next()?).unwrap_or_default();
    let url = l.next()?.to_string();
    if !url.starts_with("http") {
        return None;
    }
    Some(Resolved {
        url,
        ext,
        dur,
        is_live,
        heat,
    })
}

/// Argumentos de ffmpeg para cortar `[start, start+len]` de `url` en `out`.
/// M4A se copia sin recodificar; lo demás (opus en webm) se pasa a AAC,
/// porque el motor no decodifica opus.
pub fn cut_args(url: &str, start: f64, len: f64, ext: &str, out: &Path) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        &format!("{start:.3}"),
        "-t",
        &format!("{len:.3}"),
        "-i",
        url,
        "-vn",
        "-map",
        "0:a:0",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if ext == "m4a" {
        a.extend(["-c:a", "copy"].map(String::from));
    } else {
        a.extend(["-c:a", "aac", "-b:a", "160k"].map(String::from));
    }
    a.extend(["-movflags", "+faststart", "-y"].map(String::from));
    a.push(out.to_string_lossy().to_string());
    a
}

/// Deja la carpeta de clips por debajo de `max_bytes` borrando primero los
/// menos usados (cada uso actualiza la fecha del archivo).
pub fn prune_cache(dir: &Path, max_bytes: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut clips: Vec<(SystemTime, u64, PathBuf)> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "m4a"))
        .filter_map(|p| {
            let md = p.metadata().ok()?;
            Some((md.modified().ok()?, md.len(), p))
        })
        .collect();
    clips.sort_by_key(|c| std::cmp::Reverse(c.0)); // del más reciente al más viejo
    let mut total = 0u64;
    for (_, len, p) in clips {
        total += len;
        if total > max_bytes {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/// Id de vídeo de YouTube: 11 caracteres `[A-Za-z0-9_-]` (nada que yt-dlp
/// pueda tomar por una opción).
pub fn valid_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Marca el clip como recién usado (para el borrado de los menos usados).
fn touch(p: &Path) {
    if let Ok(f) = std::fs::File::options().write(true).open(p) {
        let _ = f.set_modified(SystemTime::now());
    }
}

/// Vistas previas: resuelve, corta, guarda y manda al motor. Solo cuenta la
/// última pulsada; las anteriores se cancelan matando su proceso.
pub struct Previewer {
    dir: PathBuf,
    resolved: Mutex<HashMap<String, (Instant, Resolved)>>,
    /// ids que se están resolviendo ahora (para no lanzar dos yt-dlp iguales)
    inflight: Mutex<HashSet<String>>,
    inflight_cv: Condvar,
    /// número de la última vista previa pedida
    gen: AtomicU64,
    /// proceso de la vista previa pedida (yt-dlp o ffmpeg), para cortarlo
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

impl Previewer {
    pub fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Previewer {
            dir,
            resolved: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashSet::new()),
            inflight_cv: Condvar::new(),
            gen: AtomicU64::new(0),
            child: Mutex::new(None),
        }
    }

    /// Resuelve de antemano (los 3 primeros resultados, la pastilla bajo el
    /// ratón): cuando se pulse, solo faltará cortar.
    pub fn prefetch(&self, id: &str) -> Result<(), String> {
        if !valid_id(id) {
            return Err("id de vídeo no válido".into());
        }
        self.resolve(id, None).map(|_| ())
    }

    /// Prepara y hace sonar la vista previa de `id`. Devuelve `(inicio, largo)`.
    pub fn play(&self, id: &str, player: &crate::player::Player) -> Result<(f64, f64), String> {
        let (clip, start, len, gen) = self.prepare(id)?;
        player.preview_start(&clip, GAIN_DB)?;
        // una vista previa más nueva pudo llegar mientras se abría esta
        if self.check(gen).is_err() {
            player.preview_stop();
        }
        let dir = self.dir.clone();
        crate::jobs::spawn(move || prune_cache(&dir, CACHE_BYTES));
        Ok((start, len))
    }

    /// Resuelve y corta (o reutiliza) el clip de `id`: (clip, inicio, largo, número).
    fn prepare(&self, id: &str) -> Result<(PathBuf, f64, f64, u64), String> {
        if !valid_id(id) {
            return Err("id de vídeo no válido".into());
        }
        let gen = self.gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.kill_current();
        let r = self.resolve(id, Some(gen))?;
        self.check(gen)?;
        let (start, len) =
            pick_window(r.dur, &r.heat, r.is_live).ok_or("sin vista previa: es un directo")?;
        let clip = self.dir.join(format!("{id}.m4a"));
        if !clip.is_file() {
            if let Err(e) = self.cut(&r, start, len, &clip, gen) {
                // URL caducada antes de tiempo: se olvida y se resuelve otra vez
                self.check(gen)?;
                self.resolved.lock().unwrap().remove(id);
                let r = self.resolve(id, Some(gen))?;
                self.cut(&r, start, len, &clip, gen)
                    .map_err(|e2| format!("{e2} ({e})"))?;
            }
        }
        self.check(gen)?;
        touch(&clip);
        Ok((clip, start, len, gen))
    }

    /// Apaga la que suena y cancela la que se esté preparando.
    pub fn stop(&self, player: &crate::player::Player) {
        self.gen.fetch_add(1, Ordering::SeqCst);
        self.kill_current();
        player.preview_stop();
    }

    fn check(&self, gen: u64) -> Result<(), String> {
        if self.gen.load(Ordering::SeqCst) == gen {
            Ok(())
        } else {
            Err("cancelada".into())
        }
    }

    fn kill_current(&self) {
        if let Some(c) = self.child.lock().unwrap().take() {
            crate::downloader::kill_tree(&mut c.lock().unwrap());
        }
    }

    fn resolve(&self, id: &str, gen: Option<u64>) -> Result<Resolved, String> {
        let deadline = Instant::now() + RESOLVE_MAX;
        // si otro ya lo está resolviendo, se espera a su resultado
        {
            let mut fl = self.inflight.lock().unwrap();
            loop {
                if let Some((t, r)) = self.resolved.lock().unwrap().get(id) {
                    if t.elapsed() < RESOLVE_TTL {
                        return Ok(r.clone());
                    }
                }
                if !fl.contains(id) {
                    fl.insert(id.to_string());
                    break;
                }
                if let Some(g) = gen {
                    self.check(g)?;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err("la vista previa tardó demasiado".into());
                }
                fl = self
                    .inflight_cv
                    .wait_timeout(fl, left.min(Duration::from_millis(200)))
                    .unwrap()
                    .0;
            }
        }
        let res = self.run_ytdlp(id, gen, deadline);
        self.inflight.lock().unwrap().remove(id);
        self.inflight_cv.notify_all();
        let r = res?;
        self.resolved
            .lock()
            .unwrap()
            .insert(id.to_string(), (Instant::now(), r.clone()));
        Ok(r)
    }

    fn run_ytdlp(&self, id: &str, gen: Option<u64>, deadline: Instant) -> Result<Resolved, String> {
        let mut cmd = Command::new(crate::downloader::yt_dlp_path());
        cmd.args([
            "--no-playlist",
            "--no-warnings",
            "--encoding",
            "utf-8",
            "-f",
            "bestaudio[ext=m4a]/bestaudio",
            "--print",
            "duration",
            "--print",
            "is_live",
            "--print",
            "ext",
            "--print",
            "%(heatmap)j",
            "--print",
            "url",
        ])
        .arg(format!("https://www.youtube.com/watch?v={id}"));
        let (ok, out, err) = self.run(cmd, gen, deadline)?;
        if !ok {
            return Err(crate::downloader::friendly_download_error(1, &err));
        }
        parse_resolved(&out).ok_or_else(|| "yt-dlp no devolvió el audio".to_string())
    }

    fn cut(&self, r: &Resolved, start: f64, len: f64, clip: &Path, gen: u64) -> Result<(), String> {
        let ff =
            crate::downloader::ffmpeg_path().ok_or("hace falta ffmpeg para la vista previa")?;
        let tmp = clip.with_extension("tmp.m4a");
        let mut cmd = Command::new(ff);
        cmd.args(cut_args(&r.url, start, len, &r.ext, &tmp));
        let (ok, _, err) = self.run(cmd, Some(gen), Instant::now() + CUT_MAX)?;
        let good = ok && tmp.metadata().map(|m| m.len() > 1024).unwrap_or(false);
        if !good {
            let _ = std::fs::remove_file(&tmp);
            let line = err.lines().last().unwrap_or("").trim().to_string();
            return Err(format!("no se pudo cortar la vista previa {line}"));
        }
        std::fs::rename(&tmp, clip).map_err(|e| e.to_string())
    }

    /// Ejecuta `cmd` con plazo. Si `gen` deja de ser la última, lo mata.
    /// Devuelve (terminó bien, stdout, stderr).
    fn run(
        &self,
        mut cmd: Command,
        gen: Option<u64>,
        deadline: Instant,
    ) -> Result<(bool, String, String), String> {
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::downloader::hide_console(&mut cmd);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("no se pudo iniciar: {e}"))?;
        // lectores aparte: una salida grande (el heatmap) llenaría la tubería
        let mut so = child.stdout.take().unwrap();
        let mut se = child.stderr.take().unwrap();
        let t_out = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = so.read_to_string(&mut s);
            s
        });
        let t_err = std::thread::spawn(move || {
            let mut s = String::new();
            let _ = se.read_to_string(&mut s);
            s
        });
        let child = Arc::new(Mutex::new(child));
        if gen.is_some() {
            *self.child.lock().unwrap() = Some(child.clone());
        }
        let status = loop {
            if let Some(st) = child
                .lock()
                .unwrap()
                .try_wait()
                .map_err(|e| e.to_string())?
            {
                break Some(st);
            }
            let stale = gen.is_some_and(|g| self.check(g).is_err());
            if stale || Instant::now() >= deadline {
                crate::downloader::kill_tree(&mut child.lock().unwrap());
                break None;
            }
            std::thread::sleep(Duration::from_millis(30));
        };
        // ya terminó: que nadie lo intente matar después (taskkill tarda ~0,3 s)
        {
            let mut slot = self.child.lock().unwrap();
            if slot.as_ref().is_some_and(|c| Arc::ptr_eq(c, &child)) {
                *slot = None;
            }
        }
        let out = t_out.join().unwrap_or_default();
        let err = t_err.join().unwrap_or_default();
        if let Some(g) = gen {
            self.check(g)?;
        }
        match status {
            Some(st) => Ok((st.success(), out, err)),
            None => Err("la vista previa tardó demasiado".into()),
        }
    }
}

/// Largo de la vista previa en segundos.
pub const CLIP_S: f64 = 10.0;
/// Paso con el que se prueban los inicios de ventana.
const STEP_S: f64 = 0.5;
/// Margen que se ignora al principio y al final (el arranque siempre marca el máximo).
const EDGE: f64 = 0.08;

/// Tramo del heatmap de yt-dlp (`heatmap`: lista de `{start_time, end_time, value}`).
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct HeatSeg {
    #[serde(rename = "start_time")]
    pub start: f64,
    #[serde(rename = "end_time")]
    pub end: f64,
    pub value: f64,
}

/// Qué tramo suena: `(inicio, largo)` en segundos, o `None` si no hay vista
/// previa (directos).
pub fn pick_window(dur: Option<f64>, heat: &[HeatSeg], is_live: bool) -> Option<(f64, f64)> {
    if is_live {
        return None;
    }
    let dur = match dur {
        Some(d) if d.is_finite() && d > 0.0 => d,
        _ => return Some((0.0, CLIP_S)),
    };
    if dur <= CLIP_S {
        return Some((0.0, dur));
    }
    if dur <= 2.0 * CLIP_S {
        return Some(((dur - CLIP_S) / 2.0, CLIP_S));
    }
    let last = dur - CLIP_S;
    if let Some(s) = best_heat_start(dur, heat) {
        return Some((s.clamp(0.0, last), CLIP_S));
    }
    // sin datos: las mezclas largas tardan en arrancar; el resto, poco antes
    // de la mitad, donde suele estar el primer estribillo
    let frac = if dur > 15.0 * 60.0 { 0.20 } else { 0.38 };
    Some(((dur * frac).clamp(0.0, last), CLIP_S))
}

/// Inicio de la ventana de 10 s con más «reproducciones», sin el primer ni el
/// último 8 %. `None` si no hay heatmap útil (vacío o plano).
fn best_heat_start(dur: f64, heat: &[HeatSeg]) -> Option<f64> {
    let (lo, hi) = heat.iter().fold((f64::MAX, f64::MIN), |(lo, hi), h| {
        (lo.min(h.value), hi.max(h.value))
    });
    if heat.is_empty() || hi - lo < 0.05 {
        return None;
    }
    let first = dur * EDGE;
    let last = dur * (1.0 - EDGE) - CLIP_S;
    if last < first {
        return None;
    }
    // como mucho ~2000 inicios, también en una mezcla de 3 h
    let step = STEP_S.max((last - first) / 2000.0);
    let mut best = (f64::MIN, first);
    let mut s = first;
    while s <= last + 1e-9 {
        let sum = heat_integral(heat, s, s + CLIP_S);
        if sum > best.0 + 1e-9 {
            best = (sum, s);
        }
        s += step;
    }
    Some(best.1)
}

/// Integral del heatmap (constante por tramos) entre `a` y `b`.
fn heat_integral(heat: &[HeatSeg], a: f64, b: f64) -> f64 {
    heat.iter()
        .map(|h| (h.end.min(b) - h.start.max(a)).max(0.0) * h.value)
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f64, end: f64, value: f64) -> HeatSeg {
        HeatSeg { start, end, value }
    }

    /// Heatmap de 100 tramos para una canción de `dur` s con un valor por tramo.
    fn heat_from(dur: f64, f: impl Fn(f64) -> f64) -> Vec<HeatSeg> {
        let n = 100;
        (0..n)
            .map(|i| {
                let a = dur * i as f64 / n as f64;
                let b = dur * (i + 1) as f64 / n as f64;
                seg(a, b, f((a + b) / 2.0 / dur))
            })
            .collect()
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 0.01
    }

    #[test]
    fn without_heatmap_starts_at_38_percent() {
        let (s, l) = pick_window(Some(200.0), &[], false).unwrap();
        assert!(close(s, 76.0), "inicio {s}");
        assert!(close(l, CLIP_S));
    }

    #[test]
    fn the_heatmap_peak_wins_but_not_the_intro() {
        // el arranque marca 1,0 (siempre pasa); el estribillo, 0,8 hacia el 60 %
        let dur = 240.0;
        let heat = heat_from(dur, |x| {
            if x < 0.05 {
                1.0
            } else if (0.58..0.63).contains(&x) {
                0.8
            } else {
                0.2
            }
        });
        let (s, l) = pick_window(Some(dur), &heat, false).unwrap();
        assert!(close(l, CLIP_S));
        // la ventana cae sobre el estribillo (139–151 s), no sobre el arranque
        assert!(s >= 135.0 && s + l <= 155.0, "ventana {s}–{}", s + l);
    }

    #[test]
    fn a_flat_heatmap_falls_back_to_a_point_inside_the_song() {
        let dur = 180.0;
        let heat = heat_from(dur, |_| 0.5);
        let (s, l) = pick_window(Some(dur), &heat, false).unwrap();
        assert!(s >= dur * EDGE && s + l <= dur * (1.0 - EDGE), "inicio {s}");
    }

    #[test]
    fn short_songs() {
        // 9 s: toda la canción
        assert_eq!(pick_window(Some(9.0), &[], false), Some((0.0, 9.0)));
        // 14 s: 10 s centrados
        let (s, l) = pick_window(Some(14.0), &[], false).unwrap();
        assert!(close(s, 2.0) && close(l, 10.0), "{s} {l}");
        // exactamente 10 s
        assert_eq!(pick_window(Some(10.0), &[], false), Some((0.0, 10.0)));
    }

    #[test]
    fn long_mixes_without_heatmap_start_at_20_percent() {
        let dur = 3.0 * 3600.0;
        let (s, _) = pick_window(Some(dur), &[], false).unwrap();
        assert!(close(s, dur * 0.2), "inicio {s}");
    }

    #[test]
    fn long_mixes_use_the_heatmap_when_there_is_one() {
        let dur = 3.0 * 3600.0;
        let heat = heat_from(dur, |x| if (0.70..0.71).contains(&x) { 0.9 } else { 0.1 });
        let (s, _) = pick_window(Some(dur), &heat, false).unwrap();
        assert!(s > dur * 0.69 && s < dur * 0.72, "inicio {s}");
    }

    #[test]
    fn unknown_duration_starts_at_zero_and_live_has_no_preview() {
        assert_eq!(pick_window(None, &[], false), Some((0.0, CLIP_S)));
        assert_eq!(pick_window(Some(0.0), &[], false), Some((0.0, CLIP_S)));
        assert_eq!(pick_window(Some(300.0), &[], true), None);
        assert_eq!(pick_window(None, &[], true), None);
    }

    #[test]
    fn the_window_never_runs_past_the_end() {
        // pico pegado al final: se respeta el margen y no se sale de la canción
        let dur = 60.0;
        let heat = heat_from(dur, |x| if x > 0.95 { 1.0 } else { 0.1 });
        let (s, l) = pick_window(Some(dur), &heat, false).unwrap();
        assert!(s + l <= dur, "{s}+{l} > {dur}");
    }

    #[test]
    fn reads_what_ytdlp_prints() {
        let out = "213.5\nFalse\nm4a\n[{\"start_time\": 0.0, \"end_time\": 2.1, \"value\": 1.0}]\nhttps://rr1.googlevideo.com/videoplayback?x=1\n";
        let r = parse_resolved(out).unwrap();
        assert_eq!(r.dur, Some(213.5));
        assert!(!r.is_live);
        assert_eq!(r.ext, "m4a");
        assert_eq!(r.heat.len(), 1);
        assert!(r.url.starts_with("https://"));
        // sin heatmap (NA), duración desconocida, directo
        let r = parse_resolved("NA\nTrue\nwebm\nNA\nhttps://x.example/a\n").unwrap();
        assert_eq!(r.dur, None);
        assert!(r.is_live && r.heat.is_empty());
        // sin URL no hay nada que cortar
        assert!(parse_resolved("200\nFalse\nm4a\nNA\nNA\n").is_none());
        assert!(parse_resolved("").is_none());
    }

    #[test]
    fn the_cut_copies_m4a_and_converts_the_rest() {
        let out = Path::new("C:/cache/abc.m4a");
        let a = cut_args("https://u", 76.0, 10.0, "m4a", out);
        let s = a.join(" ");
        // -ss antes de -i: salta por rangos HTTP, sin bajar el principio
        assert!(
            s.find("-ss 76.000").unwrap() < s.find("-i https://u").unwrap(),
            "{s}"
        );
        assert!(s.contains("-t 10.000") && s.contains("-c:a copy"), "{s}");
        assert!(a.last().unwrap().ends_with("abc.m4a"));
        // opus/webm: el motor no decodifica opus → AAC
        let s = cut_args("https://u", 0.0, 9.0, "webm", out).join(" ");
        assert!(s.contains("-c:a aac") && !s.contains("copy"), "{s}");
    }

    #[test]
    fn the_cache_drops_the_least_used_clips_over_the_limit() {
        let dir = std::env::temp_dir().join(format!("enn-pvcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let now = std::time::SystemTime::now();
        // cuatro clips de 100 bytes; «c» es el más usado y «a» el que menos
        for (name, age) in [("a", 400), ("b", 300), ("c", 10), ("d", 200)] {
            let p = dir.join(format!("{name}.m4a"));
            std::fs::write(&p, [0u8; 100]).unwrap();
            let f = std::fs::File::options().write(true).open(&p).unwrap();
            f.set_modified(now - std::time::Duration::from_secs(age))
                .unwrap();
        }
        std::fs::write(dir.join("nota.txt"), [0u8; 500]).unwrap(); // no es un clip
        prune_cache(&dir, 250);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        left.sort();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(left, ["c.m4a", "d.m4a", "nota.txt"]);
    }

    #[test]
    fn only_youtube_video_ids_are_accepted() {
        assert!(valid_id("dQw4w9WgXcQ"));
        assert!(valid_id("a-b_c-d_e-f"));
        assert!(!valid_id("--exec=evil"));
        assert!(!valid_id("short"));
        assert!(!valid_id("dQw4w9WgXc/"));
    }

    /// Con red y con las herramientas empaquetadas: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn prepares_and_cuts_a_real_clip() {
        let dir = std::env::temp_dir().join(format!("enn-pvnet-{}", std::process::id()));
        let pv = Previewer::new(dir.clone());
        let t = Instant::now();
        let (clip, start, len, _) = pv.prepare("dQw4w9WgXcQ").expect("preparar");
        let first = t.elapsed();
        let size = clip.metadata().unwrap().len();
        // la segunda vez sale de la caché
        let t = Instant::now();
        pv.prepare("dQw4w9WgXcQ").unwrap();
        let again = t.elapsed();
        eprintln!(
            "clip {size} B, tramo {start:.1}+{len:.1}, {first:?} la primera, {again:?} la segunda"
        );
        // resuelta de antemano (como los 3 primeros resultados): solo falta cortar
        pv.prefetch("kJQP7kiw5Fk").expect("resolver");
        let t = Instant::now();
        pv.prepare("kJQP7kiw5Fk").expect("cortar");
        let cut = t.elapsed();
        eprintln!("resuelta de antemano: {cut:?} hasta tener el clip");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(size > 50_000 && (len - CLIP_S).abs() < 0.01);
        assert!(again < Duration::from_millis(50));
        assert!(cut < Duration::from_millis(1500), "{cut:?}");
    }

    #[test]
    fn parses_the_ytdlp_heatmap() {
        let v: Vec<HeatSeg> = serde_json::from_str(
            r#"[{"start_time": 0.0, "end_time": 2.5, "value": 1.0},
                {"start_time": 2.5, "end_time": 5.0, "value": 0.42}]"#,
        )
        .unwrap();
        assert_eq!(v[1], seg(2.5, 5.0, 0.42));
    }
}
