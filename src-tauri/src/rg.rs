//! ReplayGain 2.0: análisis de sonoridad integrada (EBU R128) por pista.
//!
//! Ponderación K en dos biquads RBJ (shelf de agudos +4 dB @ 1681 Hz y
//! paso alto Butterworth @ 38.15 Hz), bloques de 400 ms con solape del 75 %
//! y doble puerta (absoluta −70 LUFS y relativa −10 LU). Referencia de
//! reproducción: −18 LUFS (estándar ReplayGain 2.0).

use std::path::Path;

use crate::decode::Decoder;

const ABS_GATE_LUFS: f64 = -70.0;
const REL_GATE_LU: f64 = -10.0;

/// Biquad directo (DF-I) con coeficientes RBJ cookbook exactos: los shelves
/// de `dsp::Biquad` usan una variante de alpha pensada para el tono, no para
/// la ponderación K, que exige los coeficientes estándar del estándar.
#[derive(Clone, Copy)]
struct F {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl F {
    fn highshelf(sr: f64, f0: f64, gain_db: f64, q: f64) -> F {
        let a = 10f64.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f64::consts::PI * f0 / sr;
        let (cw, sw) = (w0.cos(), w0.sin());
        let alpha = (sw / 2.0) * ((a + 1.0 / a) * (1.0 / q - 1.0) + 2.0).sqrt();
        let sa = a.sqrt();
        let a0 = (a + 1.0) - (a - 1.0) * cw + 2.0 * sa * alpha;
        F {
            b0: (a * ((a + 1.0) + (a - 1.0) * cw + 2.0 * sa * alpha)) / a0,
            b1: (-2.0 * a * ((a - 1.0) + (a + 1.0) * cw)) / a0,
            b2: (a * ((a + 1.0) + (a - 1.0) * cw - 2.0 * sa * alpha)) / a0,
            a1: (2.0 * ((a - 1.0) - (a + 1.0) * cw)) / a0,
            a2: ((a + 1.0) - (a - 1.0) * cw - 2.0 * sa * alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn highpass(sr: f64, f0: f64, q: f64) -> F {
        let w0 = 2.0 * std::f64::consts::PI * f0 / sr;
        let (cw, sw) = (w0.cos(), w0.sin());
        let alpha = sw / (2.0 * q);
        let a0 = 1.0 + alpha;
        F {
            b0: ((1.0 + cw) / 2.0) / a0,
            b1: (-(1.0 + cw)) / a0,
            b2: ((1.0 + cw) / 2.0) / a0,
            a1: (-2.0 * cw) / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f64) -> f64 {
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

struct KWeight {
    shelf: [F; 2],
    hp: [F; 2],
}

impl KWeight {
    fn new(sr: f64) -> Self {
        KWeight {
            shelf: [
                F::highshelf(sr, 1681.0, 3.9991043, 1.0 / std::f64::consts::SQRT_2),
                F::highshelf(sr, 1681.0, 3.9991043, 1.0 / std::f64::consts::SQRT_2),
            ],
            hp: [
                F::highpass(sr, 38.15, 0.5003),
                F::highpass(sr, 38.15, 0.5003),
            ],
        }
    }
}

/// Analiza el archivo completo y devuelve la sonoridad integrada en LUFS
/// (ponderación K, doble puerta EBU). None si es silencio o ilegible.
pub fn analyze_lufs(path: &Path) -> Option<f64> {
    let (mut dec, opened) = Decoder::open(path).ok()?;
    let sr = dec.sample_rate.max(1) as f64;
    let _ = opened;
    let mut kw = KWeight::new(sr);

    let hop = (0.1 * sr).max(1.0) as usize; // 100 ms
    let block_len = (0.4 * sr).max(1.0) as usize; // 400 ms

    let mut buf = vec![0.0f32; 8192 * 2];
    let mut sums: Vec<f64> = Vec::new(); // suma de cuadrados por bloque
    let mut acc = [0.0f64; 4]; // anillo de 4 bloques activos (75 % solape)
    let mut j: usize = 0; // frame global

    loop {
        let got = dec.pull_stereo(&mut buf);
        if got == 0 {
            break;
        }
        for f in 0..got {
            let l = buf[f * 2] as f64;
            let r = buf[f * 2 + 1] as f64;
            let l = kw.hp[0].process(kw.shelf[0].process(l));
            let r = kw.hp[1].process(kw.shelf[1].process(r));
            let ms = l * l + r * r; // pesos de canal 1.0 (estéreo)
            let b = j / hop;
            // cada muestra pertenece a hasta 4 bloques consecutivos
            for k in 0..4 {
                if k == 0 || (k * hop) < block_len {
                    let bi = b.checked_sub(k);
                    if let Some(bi) = bi {
                        acc[bi % 4] += ms;
                    }
                }
            }
            j += 1;
            // cierre de bloque: al entrar en un bloque nuevo, el anterior completa
            // sus 400 ms justo cuando j alcanza (b_prev+1)*hop + (block_len-hop)
            if j.is_multiple_of(hop) && j >= block_len {
                let done = (j - block_len) / hop; // bloque que acaba de completarse
                sums.push(acc[done % 4]);
                acc[done % 4] = 0.0;
            }
        }
    }

    if sums.is_empty() {
        return None;
    }
    // sonoridad de bloque: L = −0.691 + 10·log10(suma de cuadrados / longitud)
    let block_l: Vec<f64> = sums
        .iter()
        .map(|s| -0.691 + 10.0 * (s / block_len as f64).log10())
        .collect();
    // puerta absoluta
    let abs_ok: Vec<f64> = block_l
        .iter()
        .copied()
        .filter(|l| *l > ABS_GATE_LUFS)
        .collect();
    if abs_ok.is_empty() {
        return None;
    }
    let mean_sq: f64 = 10.0
        * (abs_ok
            .iter()
            .map(|l| 10f64.powf((l + 0.691) / 10.0))
            .sum::<f64>()
            / abs_ok.len() as f64)
            .log10();
    let rel_threshold = mean_sq - REL_GATE_LU;
    // puerta relativa
    let rel_ok: Vec<f64> = abs_ok
        .iter()
        .copied()
        .filter(|l| *l > rel_threshold)
        .collect();
    let final_set = if rel_ok.is_empty() {
        &abs_ok[..]
    } else {
        &rel_ok[..]
    };
    let integrated: f64 = -0.691
        + 10.0
            * (final_set
                .iter()
                .map(|l| 10f64.powf((l + 0.691) / 10.0))
                .sum::<f64>()
                / final_set.len() as f64)
                .log10();
    if !integrated.is_finite() {
        return None;
    }
    Some(integrated)
}

/// Referencia de reproducción de ReplayGain 2.0: −18 LUFS.
/// La ganancia aplicada es `(-18 - lufs)` acotada a ±15 dB (la calcula la UI
/// al reproducir, junto con la ganancia manual por pista).

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_sine_wav(path: &Path, seconds: u32, sr: u32, amp: f32) {
        let mut f = std::fs::File::create(path).unwrap();
        let bytes: u32 = sr * 2 * seconds;
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + bytes).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&2u16.to_le_bytes()).unwrap();
        f.write_all(&sr.to_le_bytes()).unwrap();
        f.write_all(&(sr * 4).to_le_bytes()).unwrap();
        f.write_all(&4u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&bytes.to_le_bytes()).unwrap();
        for n in 0..sr * seconds {
            let v = amp * (2.0 * std::f32::consts::PI * 1000.0 * n as f32 / sr as f32).sin();
            let bits = ((v * 32767.0) as i16).to_le_bytes();
            f.write_all(&bits).unwrap();
            f.write_all(&bits).unwrap();
        }
    }

    #[test]
    fn sine_lufs_is_sane() {
        let p = std::env::temp_dir().join("enn-rg-test.wav");
        write_sine_wav(&p, 5, 44100, 0.5);
        let lufs = analyze_lufs(&p).expect("análisis de seno");
        // seno 1 kHz a amplitud 0.5: ms por canal = 0.125 → ~−6.7 LUFS ponderados
        assert!(
            lufs > -9.0 && lufs < -5.0,
            "LUFS fuera de lo esperado: {lufs}"
        );
        let _ = std::fs::remove_file(&p);
        write_sine_wav(&p, 2, 48000, 0.0001);
        let l2 = analyze_lufs(&p);
        assert!(l2.is_none() || l2.unwrap() < -60.0);
        let _ = std::fs::remove_file(&p);
    }
}
