use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as SymDecoder, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{Metadata, MetadataOptions};
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;
use symphonia::default::{get_codecs, get_probe};

pub const SUPPORTED_EXT: &[&str] = &[
    "mp3", "flac", "wav", "aiff", "aif", "ogg", "oga", "m4a", "aac", "caf",
];

#[derive(Default, Clone)]
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    /// año de 4 dígitos, tomado de cualquier variante de fecha que traiga el
    /// archivo (grabación, lanzamiento u original) — la primera que aparezca.
    pub year: Option<u32>,
    /// id de YouTube de las descargas (etiqueta `comment`, Sprint 3)
    pub yt_id: Option<String>,
}

pub struct Opened {
    pub sample_rate: u32,
    pub n_frames: Option<u64>,
    pub tags: Tags,
}

pub struct Decoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn SymDecoder>,
    track_id: u32,
    pub sample_rate: u32,
    pub n_frames: Option<u64>,
    /// Profundidad de bits declarada por el contenedor/códec (None si el
    /// formato no la expone, p. ej. muchos códecs con pérdida por VBR puro).
    pub bits_per_sample: Option<u32>,
    pub eof: bool,
    pub served_frames: u64,
    leftover: Vec<f32>,
    sbuf: Option<SampleBuffer<f32>>,
}

pub enum OpenError {
    Io(io::Error),
    Parse(String),
    Unsupported(String),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Io(e) => write!(f, "no se pudo leer el archivo: {e}"),
            OpenError::Parse(e) => write!(f, "el formato no se pudo interpretar: {e}"),
            OpenError::Unsupported(e) => write!(f, "formato no soportado ({e})"),
        }
    }
}

impl std::fmt::Debug for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for OpenError {}

fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_supported_path(path: &Path) -> bool {
    match ext_of(path) {
        Some(e) => SUPPORTED_EXT.contains(&e.as_str()),
        None => false,
    }
}

fn time_from_secs(secs: f64) -> Time {
    if secs <= 0.0 {
        Time::new(0, 0.0)
    } else {
        Time::new(secs.trunc() as u64, secs.fract())
    }
}

impl Decoder {
    pub fn open(path: &Path) -> Result<(Decoder, Opened), OpenError> {
        let file = File::open(path).map_err(OpenError::Io)?;
        let mut hint = Hint::new();
        if let Some(e) = ext_of(path) {
            hint.with_extension(&e);
        }
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let format_opts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let probed = get_probe()
            .format(&hint, mss, &format_opts, &MetadataOptions::default())
            .map_err(|e| OpenError::Parse(e.to_string()))?;
        let mut format = probed.format;
        let track = format
            .default_track()
            .ok_or_else(|| OpenError::Unsupported("sin pista de audio".into()))?;
        let track_id = track.id;
        let params = &track.codec_params;
        let sample_rate = params
            .sample_rate
            .ok_or_else(|| OpenError::Unsupported("sin tasa de muestreo".into()))?;
        let n_frames = params.n_frames;
        let bits_per_sample = params.bits_per_sample.or(params.bits_per_coded_sample);
        let decoder = get_codecs()
            .make(params, &DecoderOptions::default())
            .map_err(|e| OpenError::Unsupported(e.to_string()))?;

        let tags = read_tags(format.metadata());

        let dec = Decoder {
            format,
            decoder,
            track_id,
            sample_rate,
            n_frames,
            bits_per_sample,
            eof: false,
            served_frames: 0,
            leftover: Vec::new(),
            sbuf: None,
        };
        Ok((
            dec,
            Opened {
                sample_rate,
                n_frames,
                tags,
            },
        ))
    }

    pub fn seek_to(&mut self, secs: f64) -> Option<f64> {
        let mut s = secs.max(0.0);
        if let Some(dur) = self.duration() {
            s = s.min(dur);
        }
        let to = SeekTo::Time {
            time: time_from_secs(s),
            track_id: Some(self.track_id),
        };
        let r = self.format.seek(SeekMode::Accurate, to);
        self.leftover.clear();
        self.eof = false;
        match r {
            Ok(_) => {
                self.served_frames = (s * self.sample_rate as f64) as u64;
                Some(s)
            }
            Err(_) => None,
        }
    }

    pub fn duration(&self) -> Option<f64> {
        self.n_frames.map(|n| n as f64 / self.sample_rate as f64)
    }

    /// Sirve hasta `out.len()/2` frames estéreo en `out` (interleaved L,R).
    /// Devuelve el número de frames escritos (0 => fin del archivo).
    pub fn pull_stereo(&mut self, out: &mut [f32]) -> usize {
        let out_frames = out.len() / 2;
        let mut written = 0usize;
        while written < out_frames {
            if !self.leftover.is_empty() {
                let take = ((self.leftover.len() / 2).min(out_frames - written)) * 2;
                out[written * 2..written * 2 + take].copy_from_slice(&self.leftover[..take]);
                self.leftover.drain(..take);
                written += take / 2;
                continue;
            }
            if self.eof {
                break;
            }
            match self.decode_next() {
                Ok(true) => {}
                Ok(false) | Err(_) => {
                    self.eof = true;
                    break;
                }
            }
        }
        self.served_frames += written as u64;
        written
    }

    fn decode_next(&mut self) -> Result<bool, String> {
        let mut resets = 0u32;
        loop {
            let packet = match self.format.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                Err(SymError::ResetRequired) => {
                    if resets > 2 {
                        return Ok(false);
                    }
                    resets += 1;
                    self.reset_pos();
                    continue;
                }
                Err(_) => return Ok(false),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                Err(SymError::ResetRequired) => {
                    if resets > 2 {
                        return Ok(false);
                    }
                    resets += 1;
                    self.reset_pos();
                    continue;
                }
                Err(_) => return Err("error decodificando".into()),
            };
            let spec = *decoded.spec();
            let frames = decoded.frames();
            let ch = spec.channels.count().clamp(1, 8);
            if self
                .sbuf
                .as_ref()
                .map(|s| s.capacity() < frames * ch)
                .unwrap_or(true)
            {
                self.sbuf = Some(SampleBuffer::<f32>::new(frames as u64, spec));
            }
            let sb = self.sbuf.as_mut().unwrap();
            sb.clear();
            sb.copy_interleaved_ref(decoded);
            let stereo = sb
                .samples()
                .chunks(ch)
                .flat_map(|frm| {
                    let mut l = frm[0];
                    let mut r = if ch > 1 { frm[1] } else { frm[0] };
                    if ch >= 3 {
                        let c = frm[2] * std::f32::consts::FRAC_1_SQRT_2;
                        l += c;
                        r += c;
                    }
                    if ch >= 6 {
                        l += frm[4] * std::f32::consts::FRAC_1_SQRT_2;
                        r += frm[5] * std::f32::consts::FRAC_1_SQRT_2;
                    }
                    [l, r]
                })
                .collect::<Vec<f32>>();
            self.leftover = stereo;
            return Ok(true);
        }
    }

    fn reset_pos(&mut self) {
        let _ = self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: time_from_secs(self.served_frames as f64 / self.sample_rate as f64),
                track_id: Some(self.track_id),
            },
        );
        self.leftover.clear();
    }
}

/// NOTA: para WAV, el lector RIFF de Symphonia (`symphonia-format-riff`) no
/// expone ninguna etiqueta desde aquí — probado escribiendo un chunk LIST/
/// INFO con lofty y comprobando que `Metadata::current()` llega vacío. Los
/// demás formatos soportados (MP3/FLAC/M4A/OGG) sí funcionan. No es una
/// regresión de este cambio: título/artista/álbum en WAV ya venían vacíos
/// antes; simplemente nunca se había puesto a prueba. Arreglarlo requeriría
/// leer las etiquetas de WAV con lofty en vez de Symphonia — más trabajo del
/// que entra aquí, y WAV es un formato de nicho en la biblioteca real.
fn read_tags(mut md: Metadata<'_>) -> Tags {
    use symphonia::core::meta::StandardTagKey as Std;

    let mut tags = Tags::default();
    // (std_key si el lector de este formato lo reconoció, la clave cruda en
    // minúsculas, el valor) — preferimos std_key porque `key` es específico
    // de cada formato (ID3v2 vs Vorbis comments vs átomos MP4); std_key es
    // la normalización que Symphonia ya hace por nosotros y es lo que la
    // documentación del propio crate recomienda usar en vez de adivinar
    // nombres de clave por formato.
    let mut entries: Vec<(Option<Std>, String, String)> = Vec::new();
    loop {
        if let Some(rev) = md.current() {
            for t in rev.tags() {
                let k = t.key.to_ascii_lowercase();
                let v = t.value.to_string();
                entries.push((t.std_key, k, v));
            }
        }
        if md.pop().is_none() {
            break;
        }
    }
    let get_std = |want: Std| -> Option<String> {
        entries
            .iter()
            .find(|(sk, _, v)| *sk == Some(want) && !v.trim().is_empty())
            .map(|(_, _, v)| v.trim().to_string())
    };
    let get_key = |keys: &[&str]| -> Option<String> {
        entries
            .iter()
            .find(|(_, k, v)| keys.contains(&k.as_str()) && !v.trim().is_empty())
            .map(|(_, _, v)| v.trim().to_string())
    };
    tags.title = get_std(Std::TrackTitle).or_else(|| get_key(&["title", "song"]));
    tags.artist = get_std(Std::Artist).or_else(|| get_key(&["artist"]));
    tags.album = get_std(Std::Album).or_else(|| get_key(&["album"]));
    tags.genre = get_std(Std::Genre).or_else(|| get_key(&["genre"]));
    let date_str = get_std(Std::Date)
        .or_else(|| get_std(Std::OriginalDate))
        .or_else(|| get_std(Std::ReleaseDate))
        .or_else(|| get_key(&["date", "year"]));
    // una fecha puede venir como "2019" o "2019-05-01": los primeros 4
    // caracteres bastan para el año si son dígitos; si no (formatos raros
    // tipo "5/1/2019") se descarta en vez de extraer un año inventado
    tags.year = date_str.and_then(|s| s.get(0..4)?.parse::<u32>().ok());
    // descargas de YouTube: el id está en `comment` y el año real en la
    // descripción («Released on: …»; `date` es el día en que se subió)
    for (_, _, v) in &entries {
        if tags.yt_id.is_none() {
            tags.yt_id = yt_id_from(v);
        }
        if let Some(y) = released_year_from(v) {
            tags.year = Some(y);
        }
    }
    tags
}

pub fn duration_of(opened: &Opened) -> Option<f64> {
    opened
        .n_frames
        .map(|n| n as f64 / opened.sample_rate as f64)
}

/// Mide la duración real decodificando el archivo completo (para formatos sin
/// duración declarada, p. ej. MP3 VBR). Devuelve None si no puede.
pub fn measure_duration_secs(path: &Path) -> Option<f64> {
    let (mut dec, _) = Decoder::open(path).ok()?;
    let sr = dec.sample_rate.max(1) as f64;
    let mut buf = vec![0.0f32; 8192 * 2];
    let mut total: u64 = 0;
    let mut rounds: u32 = 0;
    loop {
        let got = dec.pull_stereo(&mut buf);
        total += got as u64;
        if got == 0 {
            break;
        }
        rounds += 1;
        if rounds > 40_000_000 {
            return None; // salvaguarda (~más de 12 h)
        }
    }
    Some(total as f64 / sr)
}

/// Recorre recursivamente `dir` y agrega las rutas de audio soportadas a `out`.
pub fn scan_music_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_music_dir(&p, out);
        } else if is_supported_path(&p) {
            out.push(p);
        }
    }
}

/// Id de vídeo de YouTube de un texto (la etiqueta `comment` de las
/// descargas guarda `https://www.youtube.com/watch?v=<id>`).
pub fn yt_id_from(s: &str) -> Option<String> {
    let start = ["watch?v=", "youtu.be/"]
        .iter()
        .find_map(|m| s.find(m).map(|i| i + m.len()))?;
    let id: String = s[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    (id.len() == 11).then_some(id)
}

/// Año real de una descripción de YouTube Music («Released on: 2013-05-20»).
/// La fecha de la etiqueta `date` de las descargas es la de subida del vídeo.
pub fn released_year_from(s: &str) -> Option<u32> {
    let i = s.find("Released on:")? + "Released on:".len();
    s[i..].trim_start().get(0..4)?.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_the_youtube_id_in_the_comment() {
        use super::yt_id_from;
        assert_eq!(
            yt_id_from("https://www.youtube.com/watch?v=4D7u5KF7SP8").as_deref(),
            Some("4D7u5KF7SP8")
        );
        assert_eq!(
            yt_id_from("https://music.youtube.com/watch?v=a-b_c-d_e-f&list=x").as_deref(),
            Some("a-b_c-d_e-f")
        );
        assert_eq!(
            yt_id_from("https://youtu.be/dQw4w9WgXcQ").as_deref(),
            Some("dQw4w9WgXcQ")
        );
        assert_eq!(yt_id_from("un comentario cualquiera"), None);
        assert_eq!(yt_id_from("https://www.youtube.com/watch?v=corto"), None);
    }

    #[test]
    fn reads_the_real_release_year() {
        use super::released_year_from;
        let d = "Provided to YouTube by Columbia\n\nGet Lucky · Daft Punk\n\n℗ 2013 Daft Life\n\nReleased on: 2013-05-20\n\nAuto-generated by YouTube.";
        assert_eq!(released_year_from(d), Some(2013));
        assert_eq!(released_year_from("sin fecha"), None);
        assert_eq!(released_year_from("Released on: hoy"), None);
    }

    use super::*;
    use symphonia::core::meta::{MetadataBuilder, MetadataLog, StandardTagKey, Tag, Value};

    /// `read_tags` debe preferir `std_key` (la clasificación que Symphonia ya
    /// hace por nosotros) sobre adivinar por el nombre crudo de la clave, que
    /// varía por formato (ID3v2 "TCON" vs Vorbis "GENRE" vs MP4 "©gen"...).
    /// Se construye la metadata en memoria en vez de pasar por un archivo
    /// real: escribir con lofty y releer con Symphonia habría probado el
    /// soporte de metadatos de un contenedor concreto, no la función que de
    /// verdad cambié — y de hecho así fue como se descubrió, al intentarlo
    /// primero con un WAV, que el lector WAV de Symphonia no expone ninguna
    /// etiqueta en absoluto (ver nota en `read_tags`), algo aparte de este
    /// cambio.
    #[test]
    fn read_tags_prefers_std_key_over_raw_key_name() {
        let mut mb = MetadataBuilder::new();
        mb.add_tag(Tag::new(
            Some(StandardTagKey::TrackTitle),
            "unknown_raw_key",
            Value::String("Test Title".to_string()),
        ));
        mb.add_tag(Tag::new(
            Some(StandardTagKey::Genre),
            "unknown_raw_key",
            Value::String("Synthwave".to_string()),
        ));
        mb.add_tag(Tag::new(
            Some(StandardTagKey::OriginalDate),
            "unknown_raw_key",
            Value::String("2019-05-01".to_string()),
        ));
        let mut log = MetadataLog::default();
        log.push(mb.metadata());

        let tags = read_tags(log.metadata());
        assert_eq!(tags.title.as_deref(), Some("Test Title"));
        assert_eq!(tags.genre.as_deref(), Some("Synthwave"));
        assert_eq!(tags.year, Some(2019));
    }

    /// Sin `std_key` (lector que no lo reconoció), el respaldo por nombre
    /// crudo de clave sigue funcionando — no debe quedar como regresión al
    /// preferir std_key en el camino feliz.
    #[test]
    fn read_tags_falls_back_to_raw_key_without_std_key() {
        let mut mb = MetadataBuilder::new();
        mb.add_tag(Tag::new(None, "GENRE", Value::String("Lo-fi".to_string())));
        mb.add_tag(Tag::new(None, "YEAR", Value::String("2021".to_string())));
        let mut log = MetadataLog::default();
        log.push(mb.metadata());

        let tags = read_tags(log.metadata());
        assert_eq!(tags.genre.as_deref(), Some("Lo-fi"));
        assert_eq!(tags.year, Some(2021));
    }

    /// Una fecha con formato inusual (no "AAAA..." al inicio) se descarta en
    /// vez de convertirse en un año inventado.
    #[test]
    fn read_tags_rejects_malformed_year() {
        let mut mb = MetadataBuilder::new();
        mb.add_tag(Tag::new(
            Some(StandardTagKey::Date),
            "unknown_raw_key",
            Value::String("5/1/2019".to_string()),
        ));
        let mut log = MetadataLog::default();
        log.push(mb.metadata());

        let tags = read_tags(log.metadata());
        assert_eq!(tags.year, None);
    }
}
