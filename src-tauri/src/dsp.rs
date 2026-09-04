//! DSP: biquads (RBJ) para ecualizador de 10 bandas + tono, balance y remuestreo lineal.

#[derive(Clone, Copy)]
pub enum BiquadKind {
    Peaking,
    LowShelf,
    HighShelf,
}

pub struct Biquad {
    kind: BiquadKind,
    sr: f64,
    f0: f64,
    gain_db: f64,
    q: f64,
    a1: f64,
    a2: f64,
    b0: f64,
    b1: f64,
    b2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl Biquad {
    pub fn new(kind: BiquadKind, sr: f64, f0: f64, gain_db: f64, q: f64) -> Self {
        let mut b = Biquad {
            kind,
            sr,
            f0,
            gain_db,
            q,
            a1: 0.0,
            a2: 0.0,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        };
        b.coeffs();
        b
    }

    pub fn set_sr(&mut self, sr: f64) {
        if (self.sr - sr).abs() > 1.0 {
            self.sr = sr;
            self.coeffs();
        }
    }

    pub fn set_gain(&mut self, gain_db: f64) {
        if (self.gain_db - gain_db).abs() > 0.001 {
            self.gain_db = gain_db;
            self.coeffs();
        }
    }

    fn coeffs(&mut self) {
        let sr = self.sr.max(8000.0);
        let w0 = 2.0 * std::f64::consts::PI * self.f0 / sr;
        let cw = w0.cos();
        let sw = w0.sin();
        let a = 10f64.powf(self.gain_db / 40.0);
        match self.kind {
            BiquadKind::Peaking => {
                let alpha = sw / (2.0 * self.q);
                let a0 = 1.0 + alpha / a;
                self.b0 = (1.0 + alpha * a) / a0;
                self.b1 = (-2.0 * cw) / a0;
                self.b2 = (1.0 - alpha * a) / a0;
                self.a1 = (-2.0 * cw) / a0;
                self.a2 = (1.0 - alpha / a) / a0;
            }
            BiquadKind::LowShelf => {
                let s = a.sqrt();
                let alpha = sw * s;
                let a0 = (a + 1.0) + (a - 1.0) * cw + 2.0 * alpha * s;
                self.b0 = (a * ((a + 1.0) - (a - 1.0) * cw + 2.0 * alpha * s)) / a0;
                self.b1 = (2.0 * a * ((a - 1.0) - (a + 1.0) * cw)) / a0;
                self.b2 = (a * ((a + 1.0) - (a - 1.0) * cw - 2.0 * alpha * s)) / a0;
                self.a1 = (-2.0 * ((a - 1.0) + (a + 1.0) * cw)) / a0;
                self.a2 = ((a + 1.0) + (a - 1.0) * cw - 2.0 * alpha * s) / a0;
            }
            BiquadKind::HighShelf => {
                let s = a.sqrt();
                let alpha = sw * s;
                let a0 = (a + 1.0) - (a - 1.0) * cw + 2.0 * alpha * s;
                self.b0 = (a * ((a + 1.0) + (a - 1.0) * cw + 2.0 * alpha * s)) / a0;
                self.b1 = (-2.0 * a * ((a - 1.0) + (a + 1.0) * cw)) / a0;
                self.b2 = (a * ((a + 1.0) + (a - 1.0) * cw - 2.0 * alpha * s)) / a0;
                self.a1 = (2.0 * ((a - 1.0) - (a + 1.0) * cw)) / a0;
                self.a2 = ((a + 1.0) - (a - 1.0) * cw - 2.0 * alpha * s) / a0;
            }
        }
    }

    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

pub static BAND_FREQS: [f64; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

/// Ecualizador: 10 bandas peaking + shelf de graves (200 Hz) y agudos (4 kHz).
/// Por canal, cadena: bass -> treble -> 10 bandas.
pub struct Eq {
    pub bands_db: [f32; 10],
    pub bass_db: f32,
    pub treble_db: f32,
    sr: f64,
    state: Vec<[Biquad; 12]>,
}

impl Eq {
    pub fn new(sr: f64) -> Self {
        let chain = |_i: usize| -> [Biquad; 12] {
            [
                Biquad::new(BiquadKind::LowShelf, sr, 200.0, 0.0, 0.707),
                Biquad::new(BiquadKind::HighShelf, sr, 4000.0, 0.0, 0.707),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[0], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[1], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[2], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[3], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[4], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[5], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[6], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[7], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[8], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, sr, BAND_FREQS[9], 0.0, 1.4),
            ]
        };
        let state = vec![chain(0), chain(1)];
        Eq {
            bands_db: [0.0; 10],
            bass_db: 0.0,
            treble_db: 0.0,
            sr,
            state,
        }
    }

    pub fn set_sr(&mut self, sr: f64) {
        if (self.sr - sr).abs() > 1.0 {
            self.sr = sr;
            for ch in &mut self.state {
                for f in ch.iter_mut() {
                    f.set_sr(sr);
                }
            }
        }
    }

    /// Aplica los valores de ganancia actuales (no-op si no cambiaron).
    pub fn sync_gains(&mut self) {
        for ch in &mut self.state {
            ch[0].set_gain(self.bass_db as f64);
            ch[1].set_gain(self.treble_db as f64);
            for (i, b) in ch.iter_mut().enumerate().skip(2) {
                b.set_gain(self.bands_db[i - 2] as f64);
            }
        }
    }

    #[inline]
    pub fn process_stereo(&mut self, l: &mut f32, r: &mut f32) {
        let x0 = *l as f64;
        let x1 = *r as f64;
        let mut y0 = x0;
        let mut y1 = x1;
        for b in self.state[0].iter_mut() {
            y0 = b.process(y0);
        }
        for b in self.state[1].iter_mut() {
            y1 = b.process(y1);
        }
        *l = y0 as f32;
        *r = y1 as f32;
    }
}

/// Remuestreador lineal en streaming (estéreo). ratio = entrada/salida.
/// `x` es la posición absoluta (en frames de entrada desde el inicio del archivo)
/// de la siguiente muestra de salida. Cada segmento de entrada tiene una base
/// `base` (frame de archivo de su primera muestra).
pub struct Resampler {
    pub ratio: f64,
    x: f64,
}

impl Resampler {
    pub fn new(in_rate: f64, out_rate: f64) -> Self {
        Resampler {
            ratio: in_rate / out_rate,
            x: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.x = 0.0;
    }

    /// Produce frames de salida (interleaved estéreo) a partir de `src` (n frames
    /// que empiezan en el frame de archivo `base`).
    /// Devuelve (frames de entrada consumidos, frames de salida producidos).
    pub fn process(&mut self, src: &[f32], n: usize, out: &mut [f32], base: usize) -> (usize, usize) {
        let mut produced = 0usize;
        while produced * 2 + 1 < out.len() {
            let idx_abs = self.x.floor() as usize;
            if idx_abs < base {
                break;
            }
            let idx = idx_abs - base;
            if idx >= n {
                break;
            }
            let i1 = (idx + 1).min(n - 1);
            let t = (self.x - idx_abs as f64) as f32;
            let l = src[idx * 2] + (src[i1 * 2] - src[idx * 2]) * t;
            let r = src[idx * 2 + 1] + (src[i1 * 2 + 1] - src[idx * 2 + 1]) * t;
            out[produced * 2] = l;
            out[produced * 2 + 1] = r;
            produced += 1;
            self.x += self.ratio;
        }
        let consumed = (self.x.floor() as usize).saturating_sub(base).min(n);
        (consumed, produced)
    }
}
