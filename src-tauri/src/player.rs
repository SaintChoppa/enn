use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::Receiver;
use tauri::Emitter;

use crate::decode::{Decoder, Tags, duration_of};
use crate::dsp;

pub fn log_msg(msg: &str) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{stamp}] {msg}\n");
    let path = std::env::temp_dir().join("enn-debug.log");
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
    eprintln!("enn: {msg}");
}

pub trait SampleOut: Sized {
    fn from_audio(x: f32) -> Self;
}
macro_rules! impl_float_out {
    ($t:ty) => {
        impl SampleOut for $t {
            #[inline]
            fn from_audio(x: f32) -> Self {
                x as $t
            }
        }
    };
}
macro_rules! impl_int_out {
    ($t:ty, $scale:expr) => {
        impl SampleOut for $t {
            #[inline]
            fn from_audio(x: f32) -> Self {
                (x.clamp(-1.0, 1.0) * $scale) as $t
            }
        }
    };
}
impl_float_out!(f32);
impl_float_out!(f64);
impl_int_out!(i16, 32767.0);
impl_int_out!(u16, 32767.5);
impl_int_out!(i32, 2147483647.0);
impl_int_out!(u32, 2147483647.5);
impl_int_out!(i8, 127.0);
impl_int_out!(u8, 127.5);

pub enum EngineCmd {
    Play {
        dec: Decoder,
        path: PathBuf,
        tags: Tags,
        dur: Option<f64>,
        gain_db: f32,
    },
    Seek(f64),
    Shutdown,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum PlayState {
    Idle,
    Playing,
    Paused,
}

pub struct CurrentTrack {
    pub dec: Decoder,
    pub path: PathBuf,
    pub title: String,
    pub artist: String,
    pub state: PlayState,
    pub dur: Option<f64>,
    pub ended: bool,
    pub pos_sec: f64,
    pub gain_lin: f32,
    pub fade_secs: f32,
}

pub struct Core {
    pub cur: Option<CurrentTrack>,
    pub master: f32,
    pub balance: f32,
    pub eq: dsp::Eq,
    pub out_rate: u32,
    pub out_channels: u16,
    cmds: VecDeque<EngineCmd>,
    resampler: dsp::Resampler,
    scratch: Vec<f32>,
    inbuf: Vec<f32>,
    /// Muestras estéreo ya leídas del decodificador pero aún no consumidas por el remuestreador.
    carry: Vec<f32>,
    /// Frame de archivo donde empieza `carry` (base del segmento).
    seg_base: u64,
    /// Segundos de fade de entrada al cambiar de canción (0 = apagado).
    pub fade_secs: f32,
    pub pending_event: Option<&'static str>,
    runtime_error: Option<String>,
    pub dead: bool,
    pub renders: u64,
}

impl Core {
    fn new(out_rate: u32, out_channels: u16) -> Self {
        Core {
            cur: None,
            master: 1.0,
            balance: 0.0,
            eq: dsp::Eq::new(out_rate as f64),
            out_rate,
            out_channels: out_channels.max(1),
            cmds: VecDeque::new(),
            resampler: dsp::Resampler::new(out_rate as f64, out_rate as f64),
            scratch: Vec::new(),
            inbuf: Vec::new(),
            carry: Vec::new(),
            seg_base: 0,
            fade_secs: 0.0,
            pending_event: None,
            runtime_error: None,
            dead: false,
            renders: 0,
        }
    }

    fn drain_cmds(&mut self) {
        while let Some(c) = self.cmds.pop_front() {
            match c {
                EngineCmd::Play { mut dec, path, tags, dur, gain_db } => {
                    log_msg(&format!(
                        "ENGINE play cmd: {} (dur={dur:?}, sr={})",
                        path.display(),
                        dec.sample_rate
                    ));
                    let out_rate = self.out_rate.max(1) as f64;
                    let in_rate = dec.sample_rate.max(1) as f64;
                    self.resampler = dsp::Resampler::new(in_rate, out_rate);
                    self.carry.clear();
                    self.seg_base = 0;
                    self.eq.set_sr(out_rate);
                    let title = tags
                        .title
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| {
                            path.file_stem()
                                .map(|s| s.to_string_lossy().to_string())
                                .unwrap_or_default()
                        });
                    let artist = tags.artist.unwrap_or_default();
                    dec.served_frames = 0;
                    self.cur = Some(CurrentTrack {
                        dec,
                        path,
                        title,
                        artist,
                        state: PlayState::Playing,
                        dur,
                        ended: false,
                        pos_sec: 0.0,
                        gain_lin: (10f32).powf(gain_db.clamp(-30.0, 30.0) / 20.0),
                        fade_secs: self.fade_secs.max(0.0),
                    });
                    self.pending_event = Some("track");
                }
                EngineCmd::Seek(secs) => {
                    if let Some(c) = &mut self.cur {
                        c.ended = false;
                        if secs <= 0.0 {
                            c.dec.seek_to(0.0);
                            c.pos_sec = 0.0;
                        } else if let Some(found) = c.dec.seek_to(secs) {
                            c.pos_sec = found;
                        }
                        // si la pista había terminado y el usuario busca, se reanuda
                        if c.state == PlayState::Idle {
                            c.state = PlayState::Playing;
                            self.pending_event = Some("resume");
                        }
                        self.resampler.reset();
                        self.carry.clear();
                        self.seg_base = 0;
                    }
                }
                EngineCmd::Shutdown => {
                    self.dead = true;
                    self.cur = None;
                }
            }
        }
    }

    /// Llamado desde el hilo de audio WASAPI. Rellena `data`.
    pub fn render_into<T: SampleOut>(&mut self, data: &mut [T]) {
        self.drain_cmds();
        let frames = data.len() / self.out_channels as usize;
        if frames == 0 {
            return;
        }
        self.renders += 1;
        if self.renders <= 3 {
            log_msg(&format!(
                "ENGINE render #{} (state={:?})",
                self.renders,
                self.cur.as_ref().map(|t| t.state).unwrap_or(PlayState::Idle)
            ));
        }
        let mut scr = std::mem::take(&mut self.scratch);
        if scr.len() < frames * 2 {
            scr.resize(frames * 2, 0.0);
        }

        let mut cur = self.cur.take();
        let mut sound = false;
        let mut buf_start = 0.0;
        let mut gain_lin = 1.0f32;
        let mut fade_secs = 0.0f32;
        if let Some(t) = &mut cur {
            if t.state == PlayState::Playing {
                sound = true;
                buf_start = t.pos_sec;
                gain_lin = t.gain_lin;
                fade_secs = t.fade_secs;
                render_pull(self, t, &mut scr[..frames * 2], frames);
            }
        }
        if !sound {
            for s in scr.iter_mut() {
                *s = 0.0;
            }
        } else {
            // envolvente de entrada (fade) + ganancia relativa de la pista
            let need_env = fade_secs > 0.0 && buf_start < fade_secs as f64;
            if gain_lin != 1.0 || need_env {
                let or = self.out_rate.max(1) as f64;
                for f in 0..frames {
                    let mut g = gain_lin;
                    if need_env {
                        let t = (buf_start + f as f64 / or) as f32;
                        g *= (t / fade_secs).clamp(0.0, 1.0);
                    }
                    scr[f * 2] *= g;
                    scr[f * 2 + 1] *= g;
                }
            }
        }
        self.cur = cur;

        let gl = 1.0 - self.balance.max(0.0);
        let gr = 1.0 + self.balance.min(0.0);
        let m = self.master.clamp(0.0, 2.0);
        let chn = self.out_channels as usize;
        for (i, out) in data.iter_mut().enumerate() {
            let frame = i / chn;
            let chan = i % chn;
            let s = match chn {
                1 => (scr[frame * 2] + scr[frame * 2 + 1]) * 0.5,
                2 if chan == 0 => scr[frame * 2] * gl,
                2 => scr[frame * 2 + 1] * gr,
                _ if chan == 0 => scr[frame * 2] * gl,
                _ if chan == 1 => scr[frame * 2 + 1] * gr,
                _ => (scr[frame * 2] + scr[frame * 2 + 1]) * 0.5,
            };
            *out = T::from_audio((s * m).clamp(-1.0, 1.0));
        }
        self.scratch = scr;
    }
}

/// Decodifica + remuestrea hasta `frames` frames estéreo para `out`.
/// La cadena de muestras es continua: `core.carry` conserva lo leído y no consumido.
fn render_pull(core: &mut Core, cur: &mut CurrentTrack, out: &mut [f32], frames: usize) {
    let ratio = core.resampler.ratio;
    let mut produced = 0usize;
    let mut guard = 0u32;
    loop {
        if produced >= frames || guard > 32 {
            break;
        }
        guard += 1;

        let have = core.carry.len() / 2;
        let remain = frames - produced;
        // entrada necesaria para lo que queda de salida (más un pequeño margen)
        let want = (((remain as f64) * ratio).ceil() as usize + 2).max(have);
        let need_pull = want - have;

        // monta el segmento: arrastre + datos nuevos del decodificador
        if core.inbuf.len() < want * 2 + 8 {
            core.inbuf.resize(want * 2 + 8, 0.0);
        }
        if have > 0 {
            core.inbuf[..have * 2].copy_from_slice(&core.carry);
        }
        let got = if need_pull > 0 {
            cur.dec.pull_stereo(&mut core.inbuf[have * 2..have * 2 + need_pull * 2])
        } else {
            0
        };
        let total = have + got;
        if total == 0 {
            // fin de archivo real
            if !cur.ended {
                cur.ended = true;
                cur.state = PlayState::Idle;
                core.pending_event = Some("ended");
            }
            for s in out.iter_mut().skip(produced * 2) {
                *s = 0.0;
            }
            return;
        }

        let (consumed, prod) = {
            let src = &mut core.inbuf[..total * 2];
            core.resampler
                .process(src, total, &mut out[produced * 2..], core.seg_base as usize)
        };
        if prod > 0 {
            produced += prod;
            cur.pos_sec += prod as f64 / core.out_rate.max(1) as f64;
        }
        // conserva lo no consumido para la siguiente iteración (continua, sin huecos)
        if consumed < total {
            let tail = &core.inbuf[consumed * 2..total * 2];
            if core.carry.len() < tail.len() {
                core.carry.resize(tail.len(), 0.0);
            }
            core.carry[..tail.len()].copy_from_slice(tail);
            core.carry.truncate(tail.len());
            core.seg_base += consumed as u64;
        } else {
            core.carry.clear();
            core.seg_base += consumed as u64;
        }
        if prod == 0 && consumed == 0 {
            // el remuestreador no pudo avanzar: no hay datos útiles nuevos
            break;
        }
    }

    // ecualizador + tono sobre la salida ya remuestreada
    core.eq.sync_gains();
    let done = out[..produced * 2].len();
    for f in 0..produced {
        let mut l = out[f * 2];
        let mut r = out[f * 2 + 1];
        core.eq.process_stereo(&mut l, &mut r);
        out[f * 2] = l;
        out[f * 2 + 1] = r;
    }
    let _ = done;
    if produced < frames {
        for s in out.iter_mut().skip(produced * 2) {
            *s = 0.0;
        }
    }
}

pub struct Player {
    pub core: Arc<Mutex<Core>>,
    /// Sender que mantiene vivo al hilo dueño del stream de audio.
    streams: Mutex<Option<crossbeam_channel::Sender<()>>>,
    /// Dispositivo de salida elegido por el usuario (nombre WASAPI), si lo hay.
    device_name: Mutex<Option<String>>,
    pub app: tauri::AppHandle,
    stop_tx: Mutex<Option<crossbeam_channel::Sender<()>>>,
    pub shutting_down: Arc<AtomicBool>,
}

/// Devuelve los nombres de los dispositivos de salida disponibles.
pub fn list_output_devices() -> Vec<String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    let mut out = Vec::new();
    if let Ok(devs) = host.output_devices() {
        for d in devs {
            if let Ok(n) = d.name() {
                out.push(n);
            }
        }
    }
    out
}

fn resolve_device(want: &Option<String>) -> Result<cpal::Device, String> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let host = cpal::default_host();
    if let Some(name) = want {
        if let Ok(devs) = host.output_devices() {
            for d in devs {
                if let Ok(n) = d.name() {
                    if &n == name {
                        return Ok(d);
                    }
                }
            }
        }
    }
    host.default_output_device()
        .ok_or_else(|| {
            let all = list_output_devices().len();
            if all > 0 {
                format!(
                    "no se encontró el dispositivo de audio por defecto (hay {all} disponibles; elige uno en el selector)"
                )
            } else {
                "no se encontró ningún dispositivo de salida de audio (¿altavoces apagados o desenchufados?)"
                    .to_string()
            }
        })
}

/// Construye el stream WASAPI, avisa por `ok_tx` y se queda viviendo dentro de
/// esta función (mantiene vivo el stream) hasta que `keep` se cierre.
fn audio_owner(
    core: &Arc<Mutex<Core>>,
    want: &Option<String>,
    ok_tx: &crossbeam_channel::Sender<Result<(), String>>,
    keep: &Receiver<()>,
) {
    use cpal::traits::{DeviceTrait, StreamTrait};

    log_msg("audio_owner: buscando host/dispositivo");
    let dev = match resolve_device(want) {
        Ok(d) => d,
        Err(e) => {
            log_msg(&format!("audio_owner: sin dispositivo: {e}"));
            let _ = ok_tx.send(Err(e));
            return;
        }
    };
    let dev_name = dev.name().unwrap_or_else(|_| "desconocido".into());
    log_msg(&format!("audio_owner: usando «{dev_name}»"));
    let sup = match dev.default_output_config() {
        Ok(s) => s,
        Err(e) => {
            let m = format!("no se pudo abrir el dispositivo («{dev_name}»): {e}");
            log_msg(&m);
            let _ = ok_tx.send(Err(m));
            return;
        }
    };
    let fmt = sup.sample_format();
    let cfg = sup.config();
    let rate = cfg.sample_rate.0;
    let channels = cfg.channels.max(1);
    log_msg(&format!(
        "audio_owner: formato {fmt:?} a {rate} Hz, {channels} canales"
    ));

    macro_rules! build {
        ($ty:ty) => {{
            let c1 = core.clone();
            let c2 = core.clone();
            dev.build_output_stream(
                &cfg,
                move |data: &mut [$ty], _| {
                    if let Ok(mut c) = c1.lock() {
                        c.render_into(data);
                    }
                },
                move |e| {
                    let m = format!("error del stream de audio: {e}");
                    log_msg(&m);
                    if let Ok(mut c) = c2.lock() {
                        c.runtime_error = Some(m);
                        c.pending_event = Some("state");
                    }
                },
                None,
            )
        }};
    }

    log_msg("audio_owner: creando stream");
    let stream = match fmt {
        cpal::SampleFormat::F32 => build!(f32),
        cpal::SampleFormat::I16 => build!(i16),
        other => {
            let m = format!("el dispositivo «{dev_name}» usa un formato aún no soportado: {other:?}");
            log_msg(&m);
            let _ = ok_tx.send(Err(m));
            return;
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let m = format!("fallo al iniciar la salida de audio en «{dev_name}»: {e}");
            log_msg(&m);
            let _ = ok_tx.send(Err(m));
            return;
        }
    };

    {
        let mut c = core.lock().unwrap();
        c.out_rate = rate;
        c.out_channels = channels;
        c.eq.set_sr(rate as f64);
    }
    log_msg("audio_owner: iniciando reproducción (play)");
    if let Err(e) = stream.play() {
        let m = format!("no se pudo iniciar la reproducción en «{dev_name}»: {e}");
        log_msg(&m);
        let _ = ok_tx.send(Err(m));
        return;
    }
    log_msg("audio_owner: OK, stream activo");
    let _ = ok_tx.send(Ok(()));

    // A partir de aquí esta función se queda viva con el stream en su marco.
    let _ = keep.recv();
    log_msg("audio_owner: hilo terminado (stream cerrado)");
}

impl Player {
    pub fn new(app: tauri::AppHandle) -> Self {
        Player {
            core: Arc::new(Mutex::new(Core::new(48000, 2))),
            streams: Mutex::new(None),
            device_name: Mutex::new(None),
            app,
            stop_tx: Mutex::new(None),
            shutting_down: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start(&self) {
        let app = self.app.clone();
        let core = self.core.clone();
        let (tx, rx) = crossbeam_channel::bounded::<()>(1);
        *self.stop_tx.lock().unwrap() = Some(tx);
        std::thread::spawn(move || reporter_loop(app, core, rx));
    }

    /// Cambia de dispositivo de salida y reinicia el stream de audio.
    pub fn select_output(&self, name: Option<String>) -> Result<(), String> {
        {
            let mut want = self.device_name.lock().unwrap();
            *want = name.filter(|n| !n.trim().is_empty());
        }
        // Cierra el stream actual (el hilo dueño termina al soltar el sender).
        self.streams.lock().unwrap().take();
        self.ensure_streams()
    }

    fn ensure_streams(&self) -> Result<(), String> {
        let mut guard = self.streams.lock().unwrap();
        if guard.is_some() {
            return Ok(());
        }
        let core = self.core.clone();
        let want = self.device_name.lock().unwrap().clone();
        let (ok_tx, ok_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);
        let (kill_tx, kill_rx) = crossbeam_channel::bounded::<()>(1);
        let ok_tx2 = ok_tx.clone();
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                audio_owner(&core, &want, &ok_tx2, &kill_rx)
            }));
            if let Err(p) = result {
                let msg = p
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| p.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "pánico desconocido".into());
                log_msg(&format!("audio_owner: PÁNICO: {msg}"));
                let _ = ok_tx2.send(Err(format!("el motor de audio falló internamente: {msg}")));
            }
        });
        *guard = Some(kill_tx);
        match ok_rx.recv_timeout(Duration::from_secs(30)) {
            Ok(r) => r,
            Err(_) => {
                let m = "el dispositivo de audio no respondió a tiempo".to_string();
                log_msg(&m);
                Err(m)
            }
        }
    }

    fn push(&self, cmd: EngineCmd) {
        if let Ok(mut c) = self.core.lock() {
            c.cmds.push_back(cmd);
        }
    }

    pub fn play_path(&self, path: &Path, gain_db: f32, dur_hint: Option<f64>) -> Result<(), String> {
        self.ensure_streams()?;
        let (dec, opened) = Decoder::open(path).map_err(|e| e.to_string())?;
        // si el archivo no declara duración pero el llamador la conoce (medida), se usa
        let dur = duration_of(&opened).or(dur_hint);
        if let Ok(mut c) = self.core.lock() {
            c.runtime_error = None;
        }
        self.push(EngineCmd::Play {
            dec,
            path: path.to_path_buf(),
            tags: opened.tags,
            dur,
            gain_db,
        });
        Ok(())
    }

    pub fn set_fade(&self, secs: f32) {
        if let Ok(mut c) = self.core.lock() {
            c.fade_secs = secs.clamp(0.0, 15.0);
        }
    }

    /// Ajusta la ganancia relativa de la pista actual (en vivo).
    pub fn set_current_gain_db(&self, gain_db: f32) {
        if let Ok(mut c) = self.core.lock() {
            if let Some(cur) = &mut c.cur {
                cur.gain_lin = (10f32).powf(gain_db.clamp(-30.0, 30.0) / 20.0);
            }
        }
    }

    pub fn toggle(&self) {
        if let Ok(mut c) = self.core.lock() {
            if let Some(cur) = &mut c.cur {
                cur.state = match cur.state {
                    PlayState::Playing => PlayState::Paused,
                    PlayState::Paused => PlayState::Playing,
                    PlayState::Idle => PlayState::Idle,
                };
                c.pending_event = Some("state");
            }
        }
    }

    pub fn stop(&self) {
        if let Ok(mut c) = self.core.lock() {
            c.cur = None;
            c.pending_event = Some("stop");
        }
    }

    pub fn seek(&self, secs: f64) {
        self.push(EngineCmd::Seek(secs));
    }

    pub fn set_volume(&self, v: f32) {
        if let Ok(mut c) = self.core.lock() {
            c.master = v.clamp(0.0, 2.0);
        }
    }

    pub fn set_balance(&self, b: f32) {
        if let Ok(mut c) = self.core.lock() {
            c.balance = b.clamp(-1.0, 1.0);
        }
    }

    pub fn set_eq(&self, bands: [f32; 10], bass: f32, treble: f32) {
        if let Ok(mut c) = self.core.lock() {
            c.eq.bands_db = bands;
            c.eq.bass_db = bass;
            c.eq.treble_db = treble;
        }
    }
}

pub struct Status {
    pub state: PlayState,
    pub path: Option<PathBuf>,
    pub title: String,
    pub artist: String,
    pub pos: f64,
    pub dur: Option<f64>,
}

fn status_json(s: &Status) -> serde_json::Value {
    serde_json::json!({
        "state": match s.state {
            PlayState::Idle => "idle",
            PlayState::Playing => "playing",
            PlayState::Paused => "paused",
        },
        "path": s.path.as_ref().map(|p| p.to_string_lossy().to_string()),
        "title": s.title,
        "artist": s.artist,
        "pos": s.pos,
        "dur": s.dur,
    })
}

fn reporter_loop(app: tauri::AppHandle, core: Arc<Mutex<Core>>, rx: Receiver<()>) {
    let mut last_tick = std::time::Instant::now();
    loop {
        if rx.recv_timeout(Duration::from_millis(200)).is_ok() {
            return;
        }
        let (event, err, st) = {
            let mut c = match core.lock() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if c.dead {
                return;
            }
            let event = c.pending_event.take();
            let err = c.runtime_error.take();
            let st = Status {
                state: c.cur.as_ref().map(|t| t.state).unwrap_or(PlayState::Idle),
                path: c.cur.as_ref().map(|t| t.path.clone()),
                title: c.cur.as_ref().map(|t| t.title.clone()).unwrap_or_default(),
                artist: c.cur.as_ref().map(|t| t.artist.clone()).unwrap_or_default(),
                pos: c.cur.as_ref().map(|t| t.pos_sec).unwrap_or(0.0),
                dur: c.cur.as_ref().and_then(|t| t.dur),
            };
            (event, err, st)
        };
        let json = status_json(&st);
        if let Some(e) = event {
            let _ = app.emit("enn://status", json.clone());
            if e == "ended" {
                let _ = app.emit("enn://ended", json);
            }
            last_tick = std::time::Instant::now();
            continue;
        }
        if let Some(e) = err {
            let _ = app.emit("enn://error", e);
        }
        if last_tick.elapsed() >= Duration::from_millis(500) {
            let _ = app.emit("enn://tick", json);
            last_tick = std::time::Instant::now();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_silence_wav(path: &Path, seconds: u32) {
        use std::io::Write;
        let sr: u32 = 44100;
        let ch: u16 = 2;
        let bytes: u32 = sr * 2 * seconds;
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + bytes).to_le_bytes()).unwrap();
        f.write_all(b"WAVEfmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&ch.to_le_bytes()).unwrap();
        f.write_all(&sr.to_le_bytes()).unwrap();
        f.write_all(&(sr * 4).to_le_bytes()).unwrap();
        f.write_all(&4u16.to_le_bytes()).unwrap();
        f.write_all(&16u16.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&bytes.to_le_bytes()).unwrap();
        let zeros = vec![0u8; bytes as usize];
        f.write_all(&zeros).unwrap();
    }

    #[test]
    fn decode_drain() {
        let wav = std::env::temp_dir().join("enn-selftest.wav");
        write_silence_wav(&wav, 8);
        let (mut dec, _opened) = crate::decode::Decoder::open(&wav).expect("abrir wav");
        let mut buf = vec![0.0f32; 480 * 2];
        let mut total = 0u64;
        let mut zero_after_data = None;
        let mut last_nonzero_at = None;
        let mut round = 0u32;
        loop {
            round += 1;
            let got = dec.pull_stereo(&mut buf);
            total += got as u64;
            if got == 0 {
                if zero_after_data.is_none() {
                    zero_after_data = Some(round);
                }
                if round > 400 {
                    break;
                }
            } else {
                last_nonzero_at = Some(round);
            }
            if round > 8000 {
                break;
            }
        }
        log_msg(&format!(
            "decode_drain: total={total}, n_frames={:?}, última_vez_con_datos=#{last_nonzero_at:?}, primera_vez_vacío=#{zero_after_data:?}, rounds={round}",
            dec.n_frames
        ));
        assert_eq!(total, dec.n_frames.unwrap_or(0), "no se drenó todo el archivo");
        assert!(zero_after_data.unwrap_or(0) > last_nonzero_at.unwrap_or(0), "eof prematuro");
    }

    #[test]
    fn audio_smoke() {
        let wav = std::env::temp_dir().join("enn-selftest.wav");
        write_silence_wav(&wav, 8);

        let core = Arc::new(Mutex::new(Core::new(48000, 2)));
        {
            let (dec, opened) = crate::decode::Decoder::open(&wav).expect("abrir wav");
            let dur = duration_of(&opened);
            let mut c = core.lock().unwrap();
            c.cmds.push_back(EngineCmd::Play {
                dec,
                path: wav.clone(),
                tags: Default::default(),
                dur,
                gain_db: 0.0,
            });
        }

        let (ok_tx, ok_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);
        let (kill_tx, kill_rx) = crossbeam_channel::bounded::<()>(1);
        let c2 = core.clone();
        std::thread::spawn(move || {
            audio_owner(&c2, &None, &ok_tx, &kill_rx);
        });

        match ok_rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) => log_msg("selftest: stream OK"),
            Ok(Err(e)) => panic!("selftest: error abriendo audio: {e}"),
            Err(_) => panic!("selftest: timeout abriendo audio"),
        }

        for s in 1..=3 {
            std::thread::sleep(Duration::from_secs(1));
            let (renders, pos, state, n_frames, eof, served) = {
                let c = core.lock().unwrap();
                (
                    c.renders,
                    c.cur.as_ref().map(|t| t.pos_sec).unwrap_or(0.0),
                    c.cur.as_ref().map(|t| t.state).unwrap_or(PlayState::Idle),
                    c.cur.as_ref().and_then(|t| t.dec.n_frames),
                    c.cur.as_ref().map(|t| t.dec.eof).unwrap_or(false),
                    c.cur.as_ref().map(|t| t.dec.served_frames).unwrap_or(0),
                )
            };
            log_msg(&format!(
                "selftest: +{s}s -> renders={renders}, pos={pos:.3}s, state={state:?}, n_frames={n_frames:?}, eof={eof}, served={served}"
            ));
        }
        // tras ~3 s debe seguir sonando y avanzando
        let (renders, pos, state) = {
            let c = core.lock().unwrap();
            (
                c.renders,
                c.cur.as_ref().map(|t| t.pos_sec).unwrap_or(0.0),
                c.cur.as_ref().map(|t| t.state).unwrap_or(PlayState::Idle),
            )
        };
        log_msg(&format!(
            "selftest: FINAL renders={renders}, pos={pos:.3}s, state={state:?}"
        ));
        assert!(renders > 200, "el callback de audio apenas se invocó: {renders}");
        assert!(
            matches!(state, PlayState::Playing),
            "no está reproduciendo tras 3 s"
        );
        assert!(pos > 2.0, "la posición no avanzó (pos={pos})");
        // espera al fin del archivo (4 s) y comprueba cierre limpio
        std::thread::sleep(Duration::from_millis(1700));
        let st = {
            let c = core.lock().unwrap();
            (
                c.cur.as_ref().map(|t| t.state).unwrap_or(PlayState::Idle),
                c.cur.as_ref().map(|t| t.pos_sec).unwrap_or(-1.0),
                c.cur.as_ref().map(|t| t.dec.eof).unwrap_or(false),
            )
        };
        drop(kill_tx);
        log_msg(&format!(
            "selftest: tras fin -> state={:?}, pos={:.3}s, eof={}",
            st.0, st.1, st.2
        ));
        assert!(matches!(st.0, PlayState::Idle), "debería estar idle al acabar");
        assert!(st.2, "eof debería ser true");
        assert!((st.1 - 4.0).abs() < 0.1, "pos final extraña: {}", st.1);
    }
}
