//! Trabajos de fondo en paralelo (Sprint 1, T7).
//!
//! Un único grupo de hilos para todo lo pesado que no es audio: análisis de
//! sonoridad, formas de onda, y lo que venga (etiquetas, video…).
//!
//! - Núcleos − 1, como mucho 6: rápido sin dejar el equipo sin aire.
//! - En Windows los hilos corren en modo «segundo plano» (prioridad de CPU y
//!   de disco bajas): el audio y la interfaz siempre van primero.
//! - Modo ahorro (con batería, o a mano): un trabajo cada vez.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use rayon::prelude::*;

static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
static SAVER: AtomicBool = AtomicBool::new(false);

/// Hilos del grupo para un equipo con `cores` núcleos lógicos.
pub fn threads_for(cores: usize) -> usize {
    cores.saturating_sub(1).clamp(1, 6)
}

fn pool() -> &'static rayon::ThreadPool {
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(2);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads_for(cores))
            .thread_name(|i| format!("enn-bg-{i}"))
            .start_handler(|_| lower_this_thread())
            .build()
            .expect("grupo de hilos de fondo")
    })
}

/// Modo ahorro a mano: los lotes van de uno en uno. Lo usará el panel de
/// personalización (Sprint 5); hoy solo lo activa la batería (`on_battery`).
#[allow(dead_code)]
pub fn set_saver(on: bool) {
    SAVER.store(on, Ordering::Relaxed);
}

pub fn saver() -> bool {
    SAVER.load(Ordering::Relaxed) || on_battery()
}

/// Lanza `f` en el grupo y vuelve en seguida.
pub fn spawn(f: impl FnOnce() + Send + 'static) {
    pool().spawn(f);
}

/// Aplica `f` a cada elemento en paralelo y devuelve los resultados **en el
/// mismo orden**. En modo ahorro, uno detrás de otro (en un hilo del grupo).
pub fn map<T: Sync, R: Send>(items: &[T], f: impl Fn(&T) -> R + Sync + Send) -> Vec<R> {
    if saver() {
        pool().install(|| items.iter().map(&f).collect())
    } else {
        pool().install(|| items.par_iter().map(&f).collect())
    }
}

/// Recorre en paralelo sin recoger resultados (para trabajos que informan
/// por su cuenta, como el análisis de volumen).
pub fn for_each<T: Sync>(items: &[T], f: impl Fn(&T) + Sync + Send) {
    if saver() {
        pool().install(|| items.iter().for_each(&f))
    } else {
        pool().install(|| items.par_iter().for_each(&f))
    }
}

#[cfg(target_os = "windows")]
fn lower_this_thread() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_MODE_BACKGROUND_BEGIN,
    };
    // SAFETY: GetCurrentThread devuelve un pseudo-identificador siempre válido
    // para el hilo que llama; SetThreadPriority no toma memoria nuestra.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

#[cfg(not(target_os = "windows"))]
fn lower_this_thread() {}

/// ¿El equipo funciona con batería? (Windows; en otros sistemas, no).
#[cfg(target_os = "windows")]
pub fn on_battery() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY: rellena la estructura que le pasamos, propiedad de esta función.
    let ok = unsafe { GetSystemPowerStatus(&mut s) }.is_ok();
    // ACLineStatus: 0 = con batería, 1 = enchufado, 255 = desconocido
    ok && s.ACLineStatus == 0
}

#[cfg(not(target_os = "windows"))]
pub fn on_battery() -> bool {
    false
}

/// Sube la prioridad del hilo que llama a «tiempo crítico», como hace cpal con
/// su hilo de audio. Para el hilo de la salida exclusiva.
#[cfg(target_os = "windows")]
pub fn raise_audio_thread() {
    use windows::Win32::System::Threading::{
        GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_TIME_CRITICAL,
    };
    // SAFETY: igual que arriba, solo actúa sobre el hilo actual.
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[test]
    fn threads_for_leaves_one_core_and_caps_at_six() {
        assert_eq!(threads_for(1), 1);
        assert_eq!(threads_for(2), 1);
        assert_eq!(threads_for(4), 3);
        assert_eq!(threads_for(8), 6);
        assert_eq!(threads_for(32), 6);
    }

    /// Mide cuántos trabajos llegan a correr a la vez.
    fn max_concurrency(n: usize) -> usize {
        let now = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let items: Vec<usize> = (0..n).collect();
        for_each(&items, |_| {
            let c = now.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(c, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(15));
            now.fetch_sub(1, Ordering::SeqCst);
        });
        peak.load(Ordering::SeqCst)
    }

    // Un solo test para el modo ahorro y el paralelo: SAVER es global y los
    // tests corren en paralelo.
    #[test]
    fn map_keeps_order_respects_the_cap_and_saver_runs_one_at_a_time() {
        let items: Vec<u32> = (0..200).collect();
        let out = map(&items, |x| x * 2);
        assert_eq!(out, items.iter().map(|x| x * 2).collect::<Vec<_>>());

        let cap = pool().current_num_threads();
        let peak = max_concurrency(cap * 3);
        assert!(peak <= cap, "pico {peak} > {cap}");
        if !on_battery() && cap > 1 {
            assert!(peak > 1, "no corrió en paralelo");
        }

        set_saver(true);
        assert_eq!(max_concurrency(8), 1);
        assert_eq!(map(&items, |x| x + 1)[199], 200);
        set_saver(false);
    }
}
