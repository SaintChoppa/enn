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

/// Ecualizador: 10 bandas peaking + shelf de graves (200 Hz) y agudos (4 kHz),
/// más 4 bandas paramétricas libres (C5). Por canal: bass -> treble -> 10
/// bandas -> paramétricas.
pub struct Eq {
    pub bands_db: [f32; 10],
    pub bass_db: f32,
    pub treble_db: f32,
    /// bandas paramétricas: (f0 Hz, Q, ganancia dB)
    pub param: [(f64, f64, f32); 4],
    sr: f64,
    state: Vec<[Biquad; 16]>,
}

pub const PARAM_DEFAULTS: [(f64, f64, f32); 4] = [
    (80.0, 1.0, 0.0),
    (300.0, 1.0, 0.0),
    (2500.0, 1.0, 0.0),
    (9000.0, 1.0, 0.0),
];

impl Eq {
    pub fn new(sr: f64) -> Self {
        let mut eq = Eq {
            bands_db: [0.0; 10],
            bass_db: 0.0,
            treble_db: 0.0,
            param: PARAM_DEFAULTS,
            sr,
            state: Vec::new(),
        };
        eq.rebuild();
        eq
    }

    fn rebuild(&mut self) {
        let mk = |i: usize| -> [Biquad; 16] {
            let arr = [
                Biquad::new(BiquadKind::LowShelf, self.sr, 200.0, 0.0, 0.707),
                Biquad::new(BiquadKind::HighShelf, self.sr, 4000.0, 0.0, 0.707),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[0], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[1], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[2], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[3], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[4], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[5], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[6], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[7], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[8], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, BAND_FREQS[9], 0.0, 1.4),
                Biquad::new(BiquadKind::Peaking, self.sr, 80.0, 0.0, 1.0),
                Biquad::new(BiquadKind::Peaking, self.sr, 300.0, 0.0, 1.0),
                Biquad::new(BiquadKind::Peaking, self.sr, 2500.0, 0.0, 1.0),
                Biquad::new(BiquadKind::Peaking, self.sr, 9000.0, 0.0, 1.0),
            ];
            let _ = i;
            arr
        };
        self.state = vec![mk(0), mk(1)];
    }

    /// Recoloca una banda paramétrica (frecuencia, Q y ganancia).
    pub fn set_param_band(&mut self, i: usize, f0: f64, q: f64, gain_db: f32) {
        if i >= 4 {
            return;
        }
        let f0 = f0.clamp(20.0, self.sr / 2.0 - 100.0);
        let q = q.clamp(0.2, 12.0);
        self.param[i] = (f0, q, gain_db);
        for ch in &mut self.state {
            ch[12 + i] = Biquad::new(BiquadKind::Peaking, self.sr, f0, gain_db as f64, q);
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
    /// Las paramétricas no van aquí: su ganancia vive en los coeficientes.
    pub fn sync_gains(&mut self) {
        for ch in &mut self.state {
            ch[0].set_gain(self.bass_db as f64);
            ch[1].set_gain(self.treble_db as f64);
            for i in 0..10 {
                ch[2 + i].set_gain(self.bands_db[i] as f64);
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

/// FFT radix-2 iterativa: escribe en `out` las magnitudes normalizadas de la
/// mitad útil del espectro (entrada con ventana de Hann).
pub fn fft_magnitudes(input: &[f32], out: &mut [f32]) {
    let n = input.len();
    if n == 0 || n & (n - 1) != 0 {
        return;
    }
    let mut re: Vec<f64> = input
        .iter()
        .enumerate()
        .map(|(i, &x)| {
            let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
            x as f64 * w
        })
        .collect();
    let mut im = vec![0.0f64; n];
    fft_in_place(&mut re, &mut im);

    let half = n / 2;
    let count = half.min(out.len());
    for (o, i) in out.iter_mut().zip(0..count) {
        *o = ((re[i] * re[i] + im[i] * im[i]).sqrt() / (half as f64)) as f32;
    }
}

/// FFT radix-2 iterativa en el sitio (Cooley-Tukey, decimación en el tiempo).
/// `re` e `im` deben tener la misma longitud, potencia de dos; si no, no hace nada.
pub fn fft_in_place(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    if n == 0 || n & (n - 1) != 0 || im.len() != n {
        return;
    }
    // reordenación bit-reversal
    let mut j = 0usize;
    for i in 0..n {
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
        let mut m = n >> 1;
        while m >= 1 && j & m != 0 {
            j ^= m;
            m >>= 1;
        }
        j ^= m;
    }

    // mariposas
    let mut len = 2usize;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0usize;
        while i < n {
            let (mut cwr, mut cwi) = (1.0f64, 0.0f64);
            for k in 0..len / 2 {
                let a = i + k;
                let b = i + k + len / 2;
                let vr = re[b] * cwr - im[b] * cwi;
                let vi = re[b] * cwi + im[b] * cwr;
                re[b] = re[a] - vr;
                im[b] = im[a] - vi;
                re[a] += vr;
                im[a] += vi;
                let nwr = cwr * wr - cwi * wi;
                cwi = cwr * wi + cwi * wr;
                cwr = nwr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// Remuestreador polifásico en streaming (estéreo): sinc con ventana Blackman,
/// 64 taps y 256 fases precalculadas. Calidad muy superior al lineal (sin las
/// imágenes que produce interpolar a saco) con coste de CPU despreciable.
/// ratio = entrada/salida. `x` es la posición absoluta (en frames de entrada
/// desde el inicio del archivo) de la siguiente muestra de salida. Cada
/// segmento de entrada tiene una base `base` (frame de archivo de su primera
/// muestra); el histórico entre segmentos lo conserva el `carry` del motor.
pub struct Resampler {
    pub ratio: f64,
    x: f64,
    table: Vec<f32>,
}

const TAPS: usize = 64;
const HALF: usize = 32;
const PHASES: usize = 256;

impl Resampler {
    pub fn new(in_rate: f64, out_rate: f64) -> Self {
        let ratio = in_rate / out_rate;
        let table = build_table(in_rate, out_rate);
        Resampler {
            ratio,
            x: (HALF - 1) as f64,
            table,
        }
    }

    pub fn reset(&mut self) {
        self.x = (HALF - 1) as f64;
    }

    /// Produce frames de salida (interleaved estéreo) a partir de `src` (n frames
    /// que empiezan en el frame de archivo `base`).
    /// Devuelve (frames de entrada consumidos, frames de salida producidos).
    pub fn process(
        &mut self,
        src: &[f32],
        n: usize,
        out: &mut [f32],
        base: usize,
    ) -> (usize, usize) {
        // mismo ritmo: copia directa, sin filtrar
        if (self.ratio - 1.0).abs() < 1e-9 {
            let frames = (out.len() / 2).min(n);
            out[..frames * 2].copy_from_slice(&src[..frames * 2]);
            return (frames, frames);
        }
        let mut produced = 0usize;
        let out_frames = out.len() / 2;
        while produced < out_frames {
            let idx_abs = self.x.floor() as i64;
            let start = idx_abs - HALF as i64 + 1; // primer frame de entrada necesario
            let end = idx_abs + HALF as i64; // último frame de entrada necesario
            if start < base as i64 || end >= (base + n) as i64 {
                break;
            }
            let s0 = (start - base as i64) as usize;
            let phase =
                (((self.x - idx_abs as f64) * PHASES as f64).round() as usize).min(PHASES - 1);
            let p = phase * TAPS;
            let mut l = 0.0f32;
            let mut r = 0.0f32;
            for (k, &c) in self.table[p..p + TAPS].iter().enumerate() {
                let s = (s0 + k) * 2;
                l += c * src[s];
                r += c * src[s + 1];
            }
            out[produced * 2] = l;
            out[produced * 2 + 1] = r;
            produced += 1;
            self.x += self.ratio;
        }
        // el siguiente paso de salida necesita histórico: ese es el nuevo consumo
        let consumed =
            ((self.x.floor() as i64) - HALF as i64 + 1 - base as i64).clamp(0, n as i64) as usize;
        (consumed, produced)
    }
}

/// Tabla de fases: por cada desfase fraccional, los 64 coeficientes del FIR
/// (sinc recortado a la frecuencia de Nyquist más baja, ventana Blackman y
/// normalización de ganancia DC).
fn build_table(in_rate: f64, out_rate: f64) -> Vec<f32> {
    let fc = 0.5 * out_rate.min(in_rate) / in_rate; // ciclos por muestra de entrada
    let mut t = vec![0.0f32; PHASES * TAPS];
    for ph in 0..PHASES {
        let frac = ph as f64 / PHASES as f64;
        let center = (HALF - 1) as f64 + frac;
        let mut sum = 0.0f64;
        for k in 0..TAPS {
            let d = k as f64 - center;
            let s = if d.abs() < 1e-9 {
                1.0
            } else {
                let a = std::f64::consts::PI * 2.0 * fc * d;
                a.sin() / a
            };
            let w = 0.42
                + 0.5 * (std::f64::consts::PI * d / HALF as f64).cos()
                + 0.08 * (2.0 * std::f64::consts::PI * d / HALF as f64).cos();
            let v = 2.0 * fc * s * w;
            t[ph * TAPS + k] = v as f32;
            sum += v;
        }
        if sum.abs() > 1e-9 {
            for k in 0..TAPS {
                t[ph * TAPS + k] = (t[ph * TAPS + k] as f64 / sum) as f32;
            }
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fft_finds_sine_bin() {
        const N: usize = 1024;
        let bin = 40;
        let input: Vec<f32> = (0..N)
            .map(|i| (2.0 * std::f32::consts::PI * bin as f32 * i as f32 / N as f32).sin())
            .collect();
        let mut mags = vec![0.0f32; N / 2];
        fft_magnitudes(&input, &mut mags);
        let peak = mags
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        assert_eq!(peak, bin, "el pico debe caer en el bin del seno");
        assert!(mags[bin] > 0.4, "magnitud del pico pequeña: {}", mags[bin]);
    }

    /// Ratio ≈ 1 debe copiar sin filtrar (dsp.rs:362-367): mismo bypass exacto
    /// que se verificó a mano en la auditoría de la sesión anterior, ahora
    /// fijado como regresión en vez de depender de que alguien lo recuerde.
    #[test]
    fn resampler_bypasses_when_rate_matches() {
        let mut r = Resampler::new(48000.0, 48000.0);
        let src: Vec<f32> = (0..64).map(|i| (i as f32 * 0.1).sin()).collect();
        let mut out = vec![0.0f32; src.len()];
        let (consumed, produced) = r.process(&src, src.len() / 2, &mut out, 0);
        assert_eq!(consumed, src.len() / 2);
        assert_eq!(produced, src.len() / 2);
        assert_eq!(
            out, src,
            "en bypass la salida debe ser bit-exacta a la entrada"
        );
    }

    /// Regresión de calidad del remuestreador: una señal de 1 kHz a 44.1 kHz
    /// reamuestreada a 48 kHz debe conservar su frecuencia (el pico de la FFT
    /// cae donde le corresponde a la nueva tasa) sin introducir distorsión
    /// armónica ni imágenes de aliasing por encima de un umbral razonable.
    #[test]
    fn resampler_preserves_tone_frequency_44100_to_48000() {
        let in_rate = 44100.0f64;
        let out_rate = 48000.0f64;
        let freq = 1000.0f64;
        let n_in = 6000usize;
        let mut src = vec![0.0f32; n_in * 2];
        for i in 0..n_in {
            let s = (2.0 * std::f64::consts::PI * freq * i as f64 / in_rate).sin() as f32;
            src[i * 2] = s;
            src[i * 2 + 1] = s;
        }
        let mut r = Resampler::new(in_rate, out_rate);
        let mut out = vec![0.0f32; 4096 * 2];
        let (_, produced) = r.process(&src, n_in, &mut out, 0);

        const N: usize = 2048;
        assert!(
            produced >= N,
            "se esperaban al menos {N} frames de salida, se produjeron {produced}"
        );
        let mono: Vec<f32> = (0..N).map(|i| out[i * 2]).collect();
        let mut mags = vec![0.0f32; N / 2];
        fft_magnitudes(&mono, &mut mags);

        let peak = mags
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i)
            .unwrap();
        let expected_bin = (freq * N as f64 / out_rate).round() as usize;
        assert!(
            peak.abs_diff(expected_bin) <= 1,
            "pico en bin {peak}, se esperaba cerca de {expected_bin} (1 kHz a {out_rate} Hz)"
        );

        // THD/aliasing acotados: la energía fuera de un margen alrededor del
        // tono (y del DC) debe quedar muy por debajo del propio tono.
        let peak_mag = mags[peak] as f64;
        let spurious: f64 = mags
            .iter()
            .enumerate()
            .filter(|(i, _)| *i > 3 && i.abs_diff(peak) > 2)
            .map(|(_, m)| *m as f64)
            .sum();
        assert!(
            spurious < 0.2 * peak_mag,
            "demasiada energía espuria: {spurious:.4} frente a un pico de {peak_mag:.4}"
        );
    }
}
