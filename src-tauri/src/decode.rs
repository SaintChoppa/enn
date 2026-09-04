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
    pub channels: usize,
    pub n_frames: Option<u64>,
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
        let channels = params
            .channels
            .map(|c| c.count())
            .unwrap_or(2)
            .clamp(1, 8);
        let n_frames = params.n_frames;
        let decoder = get_codecs()
            .make(params, &DecoderOptions::default())
            .map_err(|e| OpenError::Unsupported(e.to_string()))?;

        let tags = read_tags(format.metadata());

        let dec = Decoder {
            format,
            decoder,
            track_id,
            sample_rate,
            channels,
            n_frames,
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

    pub fn leftover_len(&self) -> usize {
        self.leftover.len() / 2
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
                    let _ = self.reset_pos();
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
                    let _ = self.reset_pos();
                    continue;
                }
                Err(_) => return Err("error decodificando".into()),
            };
            let spec = *decoded.spec();
            let frames = decoded.frames();
            let ch = spec.channels.count().clamp(1, 8);
            if self.sbuf.as_ref().map(|s| s.capacity() < frames * ch).unwrap_or(true) {
                self.sbuf = Some(SampleBuffer::<f32>::new(frames as u64, spec));
            }
            let sb = self.sbuf.as_mut().unwrap();
            sb.clear();
            sb.copy_interleaved_ref(decoded);
            let stereo = sb
                .samples()
                .chunks(ch)
                .map(|frm| {
                    let mut l = frm[0];
                    let mut r = if ch > 1 { frm[1] } else { frm[0] };
                    if ch >= 3 {
                        let c = frm[2] * 0.70710678;
                        l += c;
                        r += c;
                    }
                    if ch >= 6 {
                        l += frm[4] * 0.70710678;
                        r += frm[5] * 0.70710678;
                    }
                    [l, r]
                })
                .flatten()
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

fn read_tags(mut md: Metadata<'_>) -> Tags {
    let mut tags = Tags::default();
    let mut by_key: Vec<(String, String)> = Vec::new();
    loop {
        if let Some(rev) = md.current() {
            for t in rev.tags() {
                let k = t.key.to_ascii_lowercase();
                let v = t.value.to_string();
                by_key.push((k, v));
            }
        }
        if md.pop().is_none() {
            break;
        }
    }
    let get = |keys: &[&str]| -> Option<String> {
        for (k, v) in &by_key {
            if keys.iter().any(|kk| *kk == k.as_str()) && !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
        None
    };
    tags.title = get(&["title", "song"]);
    tags.artist = get(&["artist"]);
    tags.album = get(&["album"]);
    tags
}

pub fn duration_of(opened: &Opened) -> Option<f64> {
    opened.n_frames.map(|n| n as f64 / opened.sample_rate as f64)
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
