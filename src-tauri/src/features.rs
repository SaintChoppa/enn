//! Rasgos sonoros de una canción (Sprint 3, T4): tempo (BPM), energía y
//! brillo, para la «continuidad sonora» de la radio. Sin red.
//!
//! - Energía: volumen RMS medio (−30 dBFS → 0, −6 dBFS → 1).
//! - Brillo: parte de la energía por encima de ~2,5 kHz.
//! - Tempo: envolvente de ataques cada 10 ms y autocorrelación entre 60 y
//!   180 BPM, plegada a 80–160 (lo que se siente al bailarla).

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Features {
    pub bpm: Option<f32>,
    pub energy: f32,
    pub brightness: f32,
}

/// Como mucho se analiza esto (tempo y carácter se ven de sobra).
const MAX_SECS: f64 = 180.0;
/// Corte del filtro de «brillo».
const BRIGHT_HZ: f64 = 2_500.0;

/// Acumula muestras mono y al final da los rasgos.
pub struct Acc {
    hop: usize,
    max_samples: usize,
    n: usize,
    // energía total y por encima de BRIGHT_HZ
    sum2: f64,
    hp2: f64,
    // filtro paso alto de un polo
    a: f64,
    hp_y: f64,
    hp_x: f64,
    // envolvente de ataques (una por cada 10 ms)
    hop_e: f64,
    hop_n: usize,
    last_log: f64,
    env: Vec<f32>,
}

impl Acc {
    pub fn new(sr: f64) -> Self {
        let sr = sr.max(1.0);
        let rc = 1.0 / (2.0 * std::f64::consts::PI * BRIGHT_HZ);
        let dt = 1.0 / sr;
        Acc {
            hop: (sr / 100.0).round().max(1.0) as usize,
            max_samples: (MAX_SECS * sr) as usize,
            n: 0,
            sum2: 0.0,
            hp2: 0.0,
            a: rc / (rc + dt),
            hp_y: 0.0,
            hp_x: 0.0,
            hop_e: 0.0,
            hop_n: 0,
            last_log: 0.0,
            env: Vec::new(),
        }
    }

    pub fn push(&mut self, x: f32) {
        if self.n >= self.max_samples {
            return;
        }
        self.n += 1;
        let x = x as f64;
        self.sum2 += x * x;
        self.hp_y = self.a * (self.hp_y + x - self.hp_x);
        self.hp_x = x;
        self.hp2 += self.hp_y * self.hp_y;
        self.hop_e += x * x;
        self.hop_n += 1;
        if self.hop_n == self.hop {
            // flujo de energía: lo que sube respecto al tramo anterior
            let l = (1.0 + 1000.0 * self.hop_e / self.hop as f64).ln();
            self.env.push((l - self.last_log).max(0.0) as f32);
            self.last_log = l;
            self.hop_e = 0.0;
            self.hop_n = 0;
        }
    }

    pub fn finish(self) -> Features {
        if self.n == 0 || self.sum2 <= 0.0 {
            return Features {
                bpm: None,
                energy: 0.0,
                brightness: 0.0,
            };
        }
        let rms = (self.sum2 / self.n as f64).sqrt();
        let db = 20.0 * rms.max(1e-9).log10();
        let energy = if rms < 1e-5 {
            0.0
        } else {
            ((db + 30.0) / 24.0).clamp(0.0, 1.0)
        };
        let brightness = (self.hp2 / self.sum2).sqrt().clamp(0.0, 1.0);
        Features {
            bpm: tempo(&self.env),
            energy: energy as f32,
            brightness: brightness as f32,
        }
    }
}

/// Tempo de una envolvente de ataques a 100 Hz.
fn tempo(env: &[f32]) -> Option<f32> {
    let (lo, hi) = (33usize, 100usize); // 181 … 60 BPM
    if env.len() < hi * 4 {
        return None;
    }
    let mean = env.iter().map(|x| *x as f64).sum::<f64>() / env.len() as f64;
    let e: Vec<f64> = env.iter().map(|x| *x as f64 - mean).collect();
    let r0: f64 = e.iter().map(|x| x * x).sum();
    if r0 <= 1e-9 {
        return None;
    }
    let ac = |l: usize| -> f64 { (0..e.len() - l).map(|k| e[k] * e[k + l]).sum::<f64>() };
    let r: Vec<f64> = (lo - 1..=hi + 1).map(ac).collect();
    let (mut best, mut best_v) = (0usize, f64::MIN);
    for (i, v) in r.iter().enumerate().take(r.len() - 1).skip(1) {
        if *v > best_v {
            best_v = *v;
            best = i;
        }
    }
    if best_v / r0 < 0.1 {
        return None;
    }
    // interpolación parabólica para un retardo fraccionario
    let (a, b, c) = (r[best - 1], r[best], r[best + 1]);
    let den = a - 2.0 * b + c;
    let off = if den.abs() > 1e-12 {
        0.5 * (a - c) / den
    } else {
        0.0
    };
    let lag = (best + lo - 1) as f64 + off.clamp(-0.5, 0.5);
    let mut bpm = 6000.0 / lag;
    while bpm < 80.0 {
        bpm *= 2.0;
    }
    while bpm > 160.0 {
        bpm /= 2.0;
    }
    Some(bpm as f32)
}

/// Rasgos de un archivo (analiza como mucho los 3 primeros minutos).
pub fn analyze_file(path: &Path) -> Option<Features> {
    let (mut dec, _opened) = crate::decode::Decoder::open(path).ok()?;
    let mut acc = Acc::new(dec.sample_rate as f64);
    let mut buf = vec![0.0f32; 8192 * 2];
    let limit = (MAX_SECS * dec.sample_rate.max(1) as f64) as usize;
    let mut done = 0usize;
    while done < limit {
        let got = dec.pull_stereo(&mut buf);
        if got == 0 {
            break;
        }
        for f in 0..got {
            acc.push((buf[f * 2] + buf[f * 2 + 1]) * 0.5);
        }
        done += got;
    }
    Some(acc.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 44_100.0;

    /// Ruido determinista en [-1, 1].
    fn noise(seed: &mut u32) -> f32 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 17;
        *seed ^= *seed << 5;
        (*seed as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    /// Golpes de ruido cortos a `bpm` durante `secs`.
    fn clicks(bpm: f64, secs: f64) -> Features {
        let mut a = Acc::new(SR);
        let period = (60.0 / bpm * SR) as usize;
        let hit = (0.03 * SR) as usize;
        let mut seed = 7u32;
        for n in 0..(secs * SR) as usize {
            let x = if n % period < hit {
                0.8 * noise(&mut seed)
            } else {
                0.01 * noise(&mut seed)
            };
            a.push(x);
        }
        a.finish()
    }

    #[test]
    fn finds_the_tempo_of_a_click_track() {
        for bpm in [120.0, 96.0, 140.0] {
            let f = clicks(bpm, 30.0);
            let got = f.bpm.expect("tempo") as f64;
            assert!((got - bpm).abs() <= 2.0, "esperaba {bpm}, salió {got}");
        }
    }

    #[test]
    fn folds_very_slow_or_fast_tempos_into_the_danceable_range() {
        let got = clicks(65.0, 30.0).bpm.expect("tempo") as f64;
        assert!(
            (got - 130.0).abs() <= 3.0,
            "65 BPM se siente a 130: salió {got}"
        );
    }

    #[test]
    fn silence_has_no_tempo_and_no_energy() {
        let mut a = Acc::new(SR);
        for _ in 0..(10.0 * SR) as usize {
            a.push(0.0);
        }
        let f = a.finish();
        assert_eq!(f.bpm, None);
        assert_eq!(f.energy, 0.0);
    }

    #[test]
    fn noise_is_brighter_and_louder_than_a_quiet_low_sine() {
        let mut bright = Acc::new(SR);
        let mut dull = Acc::new(SR);
        let mut seed = 3u32;
        for n in 0..(5.0 * SR) as usize {
            bright.push(0.5 * noise(&mut seed));
            dull.push(0.05 * (2.0 * std::f64::consts::PI * 100.0 * n as f64 / SR).sin() as f32);
        }
        let (b, d) = (bright.finish(), dull.finish());
        assert!(b.brightness > d.brightness + 0.3, "{b:?} {d:?}");
        assert!(b.energy > d.energy + 0.3, "{b:?} {d:?}");
        assert!((0.0..=1.0).contains(&b.energy) && (0.0..=1.0).contains(&b.brightness));
    }
}
