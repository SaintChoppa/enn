//! Medición del arranque y de la llamada de audio (Sprint 1, T1).
//!
//! Solo instrumentación: no cambia el comportamiento ni el orden de arranque.
//!
//! - Marcas de arranque: milisegundos desde el inicio del proceso (`init`,
//!   primera línea de `run()`). La primera vez gana.
//! - Estadísticas de la llamada de audio en tiempo real: solo atómicos (sin
//!   reservar memoria, sin cerrojos y sin logs dentro de la llamada).
//! - Modo banco (`--bench-startup [--bench-out <ruta>]`): al llegar la marca
//!   `interactivo` (o a los 20 s) escribe el informe en JSON y cierra la app.
//! - Modo reposo (`--bench-idle`): igual, pero espera a que la interfaz mida
//!   qué sigue animándose sin música (`perf_note("reposo", …)` y la marca
//!   `reposo-medido`), con un tope de 45 s.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Instante de inicio del proceso (lo fija `init`, lo antes posible).
static START: OnceLock<Instant> = OnceLock::new();

/// Tope de marcas guardadas y de longitud de su nombre: `perf_mark` llega
/// desde la interfaz y no debe poder hacer crecer la lista sin límite.
const MAX_MARKS: usize = 256;
const MAX_NAME: usize = 64;

/// Cubos del histograma de duraciones: el cubo `i ≥ 1` cubre
/// `[2^(i-1), 2^i)` µs; el cubo 0 es exactamente 0 µs; el último se queda
/// con todo lo que lo supere.
const BUCKETS: usize = 32;

/// Tiempo máximo del modo banco antes de escribir el informe con `timeout`.
const BENCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Mark {
    pub name: String,
    pub ms: f64,
}

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq)]
pub struct AudioStats {
    /// número de llamadas de audio
    pub calls: u64,
    /// duración máxima de una llamada (µs)
    pub max_us: u64,
    /// percentil 99 estimado por el histograma: límite superior de su cubo,
    /// acotado por `max_us` (µs)
    pub p99_us: u64,
    /// llamadas separadas de la anterior más de 2× el periodo esperado
    pub late: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct PerfReport {
    pub marks: Vec<Mark>,
    pub audio: AudioStats,
    /// notas libres de la interfaz (p. ej. el sondeo de reposo)
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    pub notes: serde_json::Map<String, serde_json::Value>,
    /// la interfaz debe medir el reposo (`--bench-idle`)
    pub idle_mode: bool,
    /// la interfaz debe hacer la prueba de reproducción (`--bench-play`)
    pub play_mode: bool,
    /// solo en el modo banco, y solo si se agotó el tiempo
    #[serde(skip_serializing_if = "is_false")]
    pub timeout: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

// ---------------------------------------------------------------- marcas

/// Lista de marcas en orden de llegada. Nunca se usa desde el hilo de audio.
pub struct Marks {
    list: Mutex<Vec<Mark>>,
}

impl Marks {
    pub const fn new() -> Self {
        Marks {
            list: Mutex::new(Vec::new()),
        }
    }

    /// Guarda la marca si es la primera con ese nombre. Devuelve si se guardó.
    pub fn record(&self, name: &str, ms: f64) -> bool {
        let name: String = name.chars().take(MAX_NAME).collect();
        let Ok(mut l) = self.list.lock() else {
            return false;
        };
        if l.len() >= MAX_MARKS || l.iter().any(|m| m.name == name) {
            return false;
        }
        l.push(Mark { name, ms });
        true
    }

    pub fn list(&self) -> Vec<Mark> {
        self.list.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

static MARKS: Marks = Marks::new();

/// Fija el instante de inicio. Llamar en la primera línea de `run()`.
pub fn init() {
    START.get_or_init(Instant::now);
}

/// Milisegundos desde el inicio del proceso.
pub fn now_ms() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Microsegundos desde el inicio, para la llamada de audio: si `init` aún no
/// se llamó devuelve 0 en vez de inicializar (la inicialización podría
/// esperar a otro hilo).
#[inline]
fn now_us() -> u64 {
    match START.get() {
        Some(s) => s.elapsed().as_micros() as u64,
        None => 0,
    }
}

/// Pone una marca de arranque (la primera vez gana) y la escribe en el log.
pub fn mark(name: &str) {
    let ms = now_ms();
    if MARKS.record(name, ms) {
        crate::player::log_msg(&format!("PERF {name} {ms:.1} ms"));
    }
}

static NOTES: Mutex<Vec<(String, serde_json::Value)>> = Mutex::new(Vec::new());

/// Guarda una nota de la interfaz (como mucho 32; la clave, 64 caracteres).
pub fn note(key: &str, value: serde_json::Value) {
    let key: String = key.chars().take(MAX_NAME).collect();
    if let Ok(mut n) = NOTES.lock() {
        if n.len() < 32 {
            n.push((key, value));
        }
    }
}

pub fn report() -> PerfReport {
    let notes = NOTES
        .lock()
        .map(|n| n.iter().cloned().collect())
        .unwrap_or_default();
    PerfReport {
        marks: MARKS.list(),
        audio: audio_stats(),
        notes,
        idle_mode: bench_idle(),
        play_mode: bench_play(),
        timeout: false,
    }
}

// ---------------------------------------------------------------- audio

/// Contadores de la llamada de audio. Todo atómico: se actualiza desde el
/// hilo de tiempo real.
pub struct AudioCounters {
    calls: AtomicU64,
    max_us: AtomicU64,
    late: AtomicU64,
    /// inicio de la llamada anterior en µs + 1 (0 = no hay anterior)
    last_start: AtomicU64,
    hist: [AtomicU64; BUCKETS],
}

impl AudioCounters {
    pub const fn new() -> Self {
        #[allow(clippy::declare_interior_mutable_const)]
        const Z: AtomicU64 = AtomicU64::new(0);
        AudioCounters {
            calls: Z,
            max_us: Z,
            late: Z,
            last_start: Z,
            hist: [Z; BUCKETS],
        }
    }

    /// Anota una llamada que empezó en `start_us` y duró `dur_us`.
    /// `period_us` es el periodo esperado entre llamadas (0 = desconocido:
    /// no se cuentan llamadas tardías).
    #[inline]
    pub fn record(&self, start_us: u64, dur_us: u64, period_us: u64) {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.max_us.fetch_max(dur_us, Ordering::Relaxed);
        self.hist[bucket_of(dur_us)].fetch_add(1, Ordering::Relaxed);
        let cur = start_us.saturating_add(1);
        let prev = self.last_start.swap(cur, Ordering::Relaxed);
        if prev != 0 && period_us > 0 && cur.saturating_sub(prev) > period_us.saturating_mul(2) {
            self.late.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Olvida la llamada anterior: el hueco al (re)abrir un stream no es un corte.
    pub fn gap_reset(&self) {
        self.last_start.store(0, Ordering::Relaxed);
    }

    pub fn reset(&self) {
        self.calls.store(0, Ordering::Relaxed);
        self.max_us.store(0, Ordering::Relaxed);
        self.late.store(0, Ordering::Relaxed);
        self.last_start.store(0, Ordering::Relaxed);
        for h in &self.hist {
            h.store(0, Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> AudioStats {
        let max_us = self.max_us.load(Ordering::Relaxed);
        let hist: Vec<u64> = self
            .hist
            .iter()
            .map(|h| h.load(Ordering::Relaxed))
            .collect();
        let total: u64 = hist.iter().sum();
        let mut p99_us = 0;
        if total > 0 {
            let target = (total * 99).div_ceil(100);
            let mut acc = 0;
            for (i, n) in hist.iter().enumerate() {
                acc += n;
                if acc >= target {
                    p99_us = if i == 0 {
                        0
                    } else if i == BUCKETS - 1 {
                        max_us
                    } else {
                        ((1u64 << i) - 1).min(max_us)
                    };
                    break;
                }
            }
        }
        AudioStats {
            calls: self.calls.load(Ordering::Relaxed),
            max_us,
            p99_us,
            late: self.late.load(Ordering::Relaxed),
        }
    }
}

impl Default for AudioCounters {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for Marks {
    fn default() -> Self {
        Self::new()
    }
}

/// Cubo del histograma para una duración en µs (potencias de 2).
#[inline]
pub fn bucket_of(us: u64) -> usize {
    ((64 - us.leading_zeros()) as usize).min(BUCKETS - 1)
}

static AUDIO: AudioCounters = AudioCounters::new();

/// Principio de la llamada de audio: devuelve el instante (µs) para `audio_cb_end`.
#[inline]
pub fn audio_cb_begin() -> u64 {
    now_us()
}

/// Final de la llamada de audio. Solo atómicos.
#[inline]
pub fn audio_cb_end(start_us: u64, period_us: u64) {
    let end = now_us();
    AUDIO.record(start_us, end.saturating_sub(start_us), period_us);
}

/// Llamar al abrir un stream (fuera de la llamada de audio).
pub fn audio_gap_reset() {
    AUDIO.gap_reset();
}

pub fn audio_stats() -> AudioStats {
    AUDIO.snapshot()
}

#[allow(dead_code)] // API pública del encargo; aún sin llamador
pub fn audio_stats_reset() {
    AUDIO.reset();
}

// ---------------------------------------------------------------- modo banco

/// `Some(ruta)` si se pidió el modo banco.
static BENCH_OUT: OnceLock<Option<PathBuf>> = OnceLock::new();
static BENCH_DONE: AtomicBool = AtomicBool::new(false);
static BENCH_IDLE: AtomicBool = AtomicBool::new(false);
static BENCH_PLAY: AtomicBool = AtomicBool::new(false);

/// ¿Prueba de reproducción (`--bench-play`)?
pub fn bench_play() -> bool {
    BENCH_PLAY.load(Ordering::Relaxed)
}

/// Marca que cierra el banco según el modo.
pub fn bench_final_mark() -> &'static str {
    if bench_play() {
        "reproduccion-medida"
    } else if bench_idle() {
        "reposo-medido"
    } else {
        "interactivo"
    }
}

/// ¿Modo reposo (`--bench-idle`)?
pub fn bench_idle() -> bool {
    BENCH_IDLE.load(Ordering::Relaxed)
}

/// Lee `--bench-startup` y `--bench-out <ruta>` (por defecto
/// `%TEMP%\enn-bench.json`). Sin `--bench-startup` devuelve `None`.
pub fn parse_bench_args<I: IntoIterator<Item = String>>(args: I) -> Option<PathBuf> {
    let mut on = false;
    let mut out = None;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--bench-startup" => on = true,
            "--bench-idle" => {
                on = true;
                BENCH_IDLE.store(true, Ordering::Relaxed);
            }
            "--bench-play" => {
                on = true;
                BENCH_PLAY.store(true, Ordering::Relaxed);
            }
            "--bench-out" => out = it.next().map(PathBuf::from),
            _ => {}
        }
    }
    on.then(|| out.unwrap_or_else(|| std::env::temp_dir().join("enn-bench.json")))
}

/// Lee los argumentos del proceso. Llamar al principio de `run()`.
pub fn bench_init() {
    BENCH_OUT.get_or_init(|| parse_bench_args(std::env::args().skip(1)));
}

/// En modo banco, a los 20 s del inicio del proceso se escribe el informe
/// con `timeout: true` (si `interactivo` no llegó antes).
pub fn bench_watchdog(app: tauri::AppHandle) {
    if !matches!(BENCH_OUT.get(), Some(Some(_))) {
        return;
    }
    let cap = if bench_idle() || bench_play() {
        Duration::from_secs(45)
    } else {
        BENCH_TIMEOUT
    };
    let left = cap.saturating_sub(Duration::from_secs_f64(now_ms() / 1000.0));
    std::thread::spawn(move || {
        std::thread::sleep(left);
        bench_finish(&app, true);
    });
}

/// En modo banco (y solo una vez): escribe el informe y cierra la app.
pub fn bench_finish(app: &tauri::AppHandle, timeout: bool) {
    let Some(Some(path)) = BENCH_OUT.get() else {
        return;
    };
    if BENCH_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut r = report();
    r.timeout = timeout;
    match serde_json::to_string_pretty(&r) {
        Ok(s) => {
            if let Err(e) = std::fs::write(path, s) {
                crate::player::log_error(&format!(
                    "PERF banco: no se pudo escribir {}: {e}",
                    path.display()
                ));
            } else {
                crate::player::log_msg(&format!(
                    "PERF banco: informe en {} (timeout: {timeout})",
                    path.display()
                ));
            }
        }
        Err(e) => crate::player::log_error(&format!("PERF banco: {e}")),
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marcas_en_orden_de_llegada_y_no_decrecientes() {
        let m = Marks::new();
        m.record("b", now_ms());
        std::thread::sleep(std::time::Duration::from_millis(2));
        m.record("a", now_ms());
        m.record("c", now_ms());
        let l = m.list();
        let names: Vec<&str> = l.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, ["b", "a", "c"]);
        assert!(l.windows(2).all(|w| w[0].ms <= w[1].ms));
        assert!(l[1].ms - l[0].ms >= 1.0);
    }

    #[test]
    fn marca_repetida_conserva_el_primer_valor() {
        let m = Marks::new();
        assert!(m.record("x", 5.0));
        assert!(!m.record("x", 9.0));
        let l = m.list();
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].ms, 5.0);
    }

    #[test]
    fn marcas_acotadas_en_numero_y_longitud() {
        let m = Marks::new();
        for i in 0..(MAX_MARKS + 10) {
            m.record(&format!("m{i}"), i as f64);
        }
        assert_eq!(m.list().len(), MAX_MARKS);
        let m = Marks::new();
        m.record(&"n".repeat(500), 0.0);
        assert_eq!(m.list()[0].name.chars().count(), MAX_NAME);
    }

    #[test]
    fn informe_se_serializa_con_marks_y_audio() {
        let m = Marks::new();
        m.record("setup-inicio", 1.5);
        let r = PerfReport {
            marks: m.list(),
            audio: AudioCounters::new().snapshot(),
            notes: serde_json::Map::new(),
            idle_mode: false,
            play_mode: false,
            timeout: false,
        };
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["marks"][0]["name"], "setup-inicio");
        assert_eq!(v["marks"][0]["ms"], 1.5);
        for k in ["calls", "max_us", "p99_us", "late"] {
            assert!(v["audio"][k].is_u64(), "falta audio.{k}");
        }
        // sin tiempo agotado no aparece la clave
        assert!(v.get("timeout").is_none());
        let r2 = PerfReport { timeout: true, ..r };
        assert_eq!(serde_json::to_value(&r2).unwrap()["timeout"], true);
    }

    #[test]
    fn p99_cae_en_el_cubo_bajo_con_un_solo_valor_alto() {
        let a = AudioCounters::new();
        for i in 0..99 {
            a.record(1 + i * 1000, 100, 0);
        }
        a.record(200_000, 10_000, 0);
        let s = a.snapshot();
        assert_eq!(s.calls, 100);
        assert_eq!(s.max_us, 10_000);
        assert_eq!(bucket_of(s.p99_us), bucket_of(100));
    }

    #[test]
    fn p99_cae_en_el_cubo_alto_con_diez_valores_altos() {
        let a = AudioCounters::new();
        for i in 0..90 {
            a.record(1 + i * 1000, 100, 0);
        }
        for i in 0..10 {
            a.record(200_000 + i * 1000, 10_000, 0);
        }
        let s = a.snapshot();
        assert_eq!(bucket_of(s.p99_us), bucket_of(10_000));
    }

    #[test]
    fn late_cuenta_solo_separaciones_mayores_de_dos_periodos() {
        let a = AudioCounters::new();
        // periodo 10 ms: separaciones de 10, 20 (justo 2×, no cuenta), 21, 35 ms
        let starts = [1_000, 11_000, 31_000, 52_000, 87_000];
        for s in starts {
            a.record(s, 50, 10_000);
        }
        assert_eq!(a.snapshot().late, 2);
        // con periodo desconocido (0) no se cuenta nada
        let b = AudioCounters::new();
        for s in starts {
            b.record(s, 50, 0);
        }
        assert_eq!(b.snapshot().late, 0);
    }

    #[test]
    fn reinicio_de_separacion_no_cuenta_el_hueco_al_reabrir() {
        let a = AudioCounters::new();
        a.record(1_000, 50, 10_000);
        a.gap_reset();
        a.record(500_000, 50, 10_000);
        assert_eq!(a.snapshot().late, 0);
        a.reset();
        assert_eq!(a.snapshot(), AudioStats::default());
    }

    #[test]
    fn argumentos_del_modo_banco() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_bench_args(v(&[])), None);
        assert_eq!(parse_bench_args(v(&["--bench-out", "x.json"])), None);
        assert_eq!(
            parse_bench_args(v(&["--bench-startup"])),
            Some(std::env::temp_dir().join("enn-bench.json"))
        );
        assert_eq!(
            parse_bench_args(v(&["--bench-startup", "--bench-out", "C:\\t\\b.json"])),
            Some(PathBuf::from("C:\\t\\b.json"))
        );
    }
}
