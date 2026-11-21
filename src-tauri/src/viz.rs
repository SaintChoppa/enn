//! Análisis de audio para el visualizador (Cinta y Traza).
//!
//! Reproduce en Rust lo que el prototipo de Claude Design hacía con un
//! `AnalyserNode` de WebAudio (ver la bóveda: «Visualizador - Cinta y Traza»):
//!
//! * FFT con ventana Blackman y magnitud |X|/N, igual que
//!   `getFloatFrequencyData`, sobre una ventana de ~85 ms (4096 muestras a
//!   48 kHz; crece con la tasa para que la resolución en Hz no se degrade).
//! * Tres energías por banda (20–150 / 150–2000 / 2000–16000 Hz) en dB con un
//!   AGC de referencia que cae 2 dB/s, normalizadas a 0..1.
//! * Tono dominante: producto armónico reducido en 150–1200 Hz con
//!   interpolación parabólica (Traza), y centroide espectral logarítmico
//!   (Cinta).
//! * Ataques por banda sobre la señal ADELANTADA (la que el motor todavía no
//!   ha mandado al altavoz): flujo sobre una media exponencial de 250 ms, con
//!   umbral y periodo refractario por banda.
//!
//! El análisis se hace bajo demanda (un `get_viz_frame` por frame de la UI) y
//! el reloj es el de muestras del motor, así que no depende del ritmo al que
//! la UI pregunte. Sin sondeo no hay coste.

use crate::dsp;

/// Bordes de las tres bandas, en Hz.
const BAND_EDGES: [f64; 4] = [20.0, 150.0, 2000.0, 16000.0];
/// Tono: rango del producto armónico y confianza mínima.
const PITCH_LO: f64 = 150.0;
const PITCH_HI: f64 = 1200.0;
const PITCH_CONF: f32 = 2.6;
/// Ataques: umbral de flujo, nivel mínimo, refractario (s) y peso, por banda.
const ON_TH: [f32; 3] = [0.16, 0.20, 0.22];
const ON_MIN: f32 = 0.3;
const ON_REF: [f64; 3] = [0.18, 0.12, 0.08];
const ON_W: [f32; 3] = [1.0, 0.6, 0.35];
const EMA_S: f64 = 0.25;

/// Longitud de ventana para una tasa dada: ~85 ms redondeados a potencia de 2.
pub fn window_len(rate: u32) -> usize {
    match rate {
        0..=50_000 => 4096,
        50_001..=100_000 => 8192,
        _ => 16384,
    }
}

/// Un ataque detectado en este análisis.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Onset {
    /// 0 graves, 1 medios, 2 agudos
    pub band: u8,
    /// fuerza = clamp(2.2·flujo, 0.3, 1) · peso de la banda (sin la amplitud
    /// del perfil, que es cosa de la UI)
    pub strength: f32,
    /// nivel normalizado de la banda en el momento del ataque
    pub level: f32,
}

#[derive(Clone, Debug, Default)]
pub struct VizFrame {
    /// energías normalizadas 0..1 (graves, medios, agudos) de la señal adelantada
    pub n: [f32; 3],
    /// tono dominante 0..1 (escala log 150–1200 Hz) o el último válido
    pub tone: f32,
    /// confianza del tono (máximo / media del producto armónico)
    pub conf: f32,
    /// centroide espectral 0..1 (log2(c/150)/log2(40)) o el último válido
    pub centroid: f32,
    pub onsets: Vec<Onset>,
    /// segundos de muestras nuevas desde el análisis anterior (0 = nada nuevo)
    pub dt: f32,
}

pub struct VizAnalyzer {
    ref_db: [f32; 3],
    ema: [f32; 3],
    last_on: [f64; 3],
    clock: f64,
    prev_total: Option<u64>,
    tone: f32,
    centroid: f32,
    last: VizFrame,
    // búferes reutilizados entre llamadas (sin asignar en cada frame)
    win: Vec<f64>,
    re: Vec<f64>,
    im: Vec<f64>,
    mag: Vec<f64>,
}

impl Default for VizAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl VizAnalyzer {
    pub fn new() -> Self {
        VizAnalyzer {
            ref_db: [-30.0; 3],
            ema: [0.0; 3],
            last_on: [-10.0; 3],
            clock: 0.0,
            prev_total: None,
            tone: 0.5,
            centroid: 0.0,
            last: VizFrame {
                tone: 0.5,
                ..Default::default()
            },
            win: Vec::new(),
            re: Vec::new(),
            im: Vec::new(),
            mag: Vec::new(),
        }
    }

    /// Analiza la ventana `samples` (mono, la más antigua primero, longitud
    /// potencia de 2) que termina en la muestra número `total` del reloj del
    /// motor. Si no hay muestras nuevas desde la llamada anterior devuelve el
    /// último resultado sin ataques.
    pub fn analyze(&mut self, samples: &[f32], rate: u32, total: u64) -> VizFrame {
        let n = samples.len();
        if n < 8 || n & (n - 1) != 0 || rate == 0 {
            return self.last.clone();
        }
        let dt = match self.prev_total {
            Some(p) if total > p => (total - p) as f64 / rate as f64,
            Some(_) => {
                let mut f = self.last.clone();
                f.onsets.clear();
                f.dt = 0.0;
                return f;
            }
            None => 1.0 / 60.0,
        };
        self.prev_total = Some(total);
        // un salto grande (pausa larga, búsqueda) no debe vaciar el AGC de golpe
        let dt = dt.min(0.25);
        self.clock += dt;

        if self.win.len() != n {
            let nf = n as f64;
            self.win = (0..n)
                .map(|i| {
                    let x = std::f64::consts::TAU * i as f64 / nf;
                    0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()
                })
                .collect();
            self.re = vec![0.0; n];
            self.im = vec![0.0; n];
            self.mag = vec![0.0; n / 2];
        }
        for ((re, &x), &w) in self.re.iter_mut().zip(samples).zip(&self.win) {
            *re = x as f64 * w;
        }
        self.im.fill(0.0);
        dsp::fft_in_place(&mut self.re, &mut self.im);
        let nf = n as f64;
        for i in 0..n / 2 {
            self.mag[i] = (self.re[i] * self.re[i] + self.im[i] * self.im[i]).sqrt() / nf;
        }

        let bin_hz = rate as f64 / nf;
        let top = ((BAND_EDGES[3] / bin_hz).floor() as usize).min(n / 2);
        let lo = (BAND_EDGES[0] / bin_hz).ceil() as usize;
        let mut pw = [0.0f64; 3];
        let mut cnt = [0usize; 3];
        let (mut cw, mut cs) = (0.0f64, 0.0f64);
        let start = lo.max(1);
        for (i, m) in self.mag.iter().enumerate().take(top).skip(start) {
            let f = i as f64 * bin_hz;
            let b = if f < BAND_EDGES[1] {
                0
            } else if f < BAND_EDGES[2] {
                1
            } else {
                2
            };
            let p = m * m;
            pw[b] += p;
            cnt[b] += 1;
            if f > 40.0 {
                cw += f * p;
                cs += p;
            }
        }
        let mut out = VizFrame {
            dt: dt as f32,
            ..Default::default()
        };
        for b in 0..3 {
            let db = (10.0 * (pw[b] / cnt[b].max(1) as f64 + 1e-15).log10()) as f32;
            self.ref_db[b] = (self.ref_db[b] - 2.0 * dt as f32).max(db).max(-60.0);
            out.n[b] = ((db - self.ref_db[b] + 30.0) / 30.0).clamp(0.0, 1.0);
        }
        let loud = out.n.iter().cloned().fold(0.0f32, f32::max);

        // centroide (Cinta)
        if cs > 1e-12 && loud > 0.02 {
            self.centroid = (((cw / cs / 150.0).log2()) / 40f64.log2()).clamp(0.0, 1.0) as f32;
        }
        out.centroid = self.centroid;

        // tono dominante por producto armónico reducido (Traza)
        let plo = (PITCH_LO / bin_hz).ceil() as usize;
        let phi = ((PITCH_HI / bin_hz).floor() as usize).min(n / 2 - 2);
        let m = |i: usize| -> f64 { self.mag.get(i).copied().unwrap_or(0.0) };
        let (mut best, mut bi, mut sum) = (0.0f64, 0usize, 0.0f64);
        if phi > plo {
            for i in plo..=phi {
                let s = m(i) + 0.5 * m(2 * i) + 0.4 * m(3 * i);
                sum += s;
                if s > best {
                    best = s;
                    bi = i;
                }
            }
            out.conf = (best / (sum / (phi - plo + 1) as f64 + 1e-12)) as f32;
        }
        if bi > 0 && out.conf > PITCH_CONF && loud > 0.05 {
            let (am, a0, ap) = (m(bi - 1), m(bi), m(bi + 1));
            let den = am - 2.0 * a0 + ap;
            let delta = if den.abs() > 1e-12 {
                (0.5 * (am - ap) / den).clamp(-0.5, 0.5)
            } else {
                0.0
            };
            let f = (bi as f64 + delta) * bin_hz;
            self.tone =
                ((f / PITCH_LO).log2() / (PITCH_HI / PITCH_LO).log2()).clamp(0.0, 1.0) as f32;
        }
        out.tone = self.tone;

        // ataques sobre la señal adelantada
        let k = 1.0 - (-dt / EMA_S).exp() as f32;
        for b in 0..3 {
            let flux = out.n[b] - self.ema[b];
            if flux > ON_TH[b] && out.n[b] > ON_MIN && self.clock - self.last_on[b] > ON_REF[b] {
                self.last_on[b] = self.clock;
                out.onsets.push(Onset {
                    band: b as u8,
                    strength: (2.2 * flux).clamp(0.3, 1.0) * ON_W[b],
                    level: out.n[b],
                });
            }
            self.ema[b] += (out.n[b] - self.ema[b]) * k;
        }
        self.last = out.clone();
        self.last.onsets.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: u32, n: usize, amp: f32) -> Vec<f32> {
        (0..n)
            .map(|i| amp * (std::f64::consts::TAU * freq * i as f64 / rate as f64).sin() as f32)
            .collect()
    }

    #[test]
    fn window_grows_with_rate() {
        assert_eq!(window_len(44_100), 4096);
        assert_eq!(window_len(96_000), 8192);
        assert_eq!(window_len(192_000), 16384);
    }

    #[test]
    fn bass_tone_lights_the_bass_band_and_fires_an_onset() {
        let mut a = VizAnalyzer::new();
        let n = 4096;
        // silencio y luego un golpe de 60 Hz: debe dar ataque en graves
        let quiet = vec![0.0f32; n];
        let mut total = n as u64;
        a.analyze(&quiet, 48_000, total);
        total += 800;
        let f = a.analyze(&tone(60.0, 48_000, n, 0.8), 48_000, total);
        assert!(f.n[0] > 0.5, "graves = {}", f.n[0]);
        assert!(f.n[0] > f.n[2], "graves {} > agudos {}", f.n[0], f.n[2]);
        assert!(f.onsets.iter().any(|o| o.band == 0), "{:?}", f.onsets);
        // la misma muestra otra vez: nada nuevo, sin ataques
        let again = a.analyze(&tone(60.0, 48_000, n, 0.8), 48_000, total);
        assert!(again.onsets.is_empty());
        assert_eq!(again.dt, 0.0);
    }

    #[test]
    fn pitch_tracks_a_harmonic_note() {
        let mut a = VizAnalyzer::new();
        let n = 4096;
        let rate = 48_000;
        // La4 = 440 Hz con dos armónicos: tono = log2(440/150)/3 ≈ 0.518
        let s: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / rate as f64;
                let w = std::f64::consts::TAU * 440.0 * t;
                (0.5 * w.sin() + 0.25 * (2.0 * w).sin() + 0.15 * (3.0 * w).sin()) as f32
            })
            .collect();
        let f = a.analyze(&s, rate, n as u64);
        let want = ((440.0f64 / 150.0).log2() / 3.0) as f32;
        assert!(f.conf > PITCH_CONF, "conf = {}", f.conf);
        assert!((f.tone - want).abs() < 0.01, "tono {} ≠ {}", f.tone, want);
    }
}
