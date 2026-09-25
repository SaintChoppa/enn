//! Salida WASAPI en modo exclusivo (A1) a la tasa nativa del archivo (A3,
//! Hi-Res bit-perfect). El motor DSP de Enn sigue procesando (EQ, ReplayGain,
//! volumen/balance), pero se salta el mezclador de Windows y su remuestreo.
//!
//! Si el dispositivo rechaza el formato, se prueban variantes (float32,
//! int32, int16) y tasas vecinas; si nada funciona, el llamador recae en la
//! salida compartida de CPAL. Solo Windows; el port a Linux usará ALSA o
//! PipeWire directo.

#![cfg(target_os = "windows")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{Receiver, TryRecvError};
use windows::core::GUID;
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_EXCLUSIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use crate::player::{log_error, log_msg, Core};

// subtipos KSDATAFORMAT (mmreg)
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x0000_0003_0000_0010_8000_00aa_0038_9b71);
const KSDATAFORMAT_SUBTYPE_PCM: GUID = GUID::from_u128(0x0000_0001_0000_0010_8000_00aa_0038_9b71);

#[derive(Clone, Copy)]
struct Fmt {
    rate: u32,
    channels: u16,
    /// 32 float · 32 int · 16 int
    bits: u16,
    float: bool,
}

impl Fmt {
    fn label(&self) -> String {
        let kind = if self.float {
            "float32".to_string()
        } else {
            format!("int{}", self.bits)
        };
        format!("{} Hz · {} ch · {}", self.rate, self.channels, kind)
    }

    fn extensible(&self) -> WAVEFORMATEXTENSIBLE {
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: 0xFFFE, // EXTENSIBLE
                nChannels: self.channels,
                nSamplesPerSec: self.rate,
                wBitsPerSample: self.bits,
                nBlockAlign: self.channels * self.bits / 8,
                nAvgBytesPerSec: self.rate * (self.channels * self.bits / 8) as u32,
                cbSize: 22,
            },
            Samples: WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: self.bits,
            }, // wValidBitsPerSample
            dwChannelMask: if self.channels >= 2 { 0x3 } else { 0x4 },
            SubFormat: if self.float {
                KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            } else {
                KSDATAFORMAT_SUBTYPE_PCM
            },
        }
    }
}

/// Abre el dispositivo en exclusiva con la primera variante aceptada y
/// rellena el buffer en bucle desde `core` hasta que `keep` se cierre.
/// `ok_tx` recibe Ok (formato elegido, logeado) o Err (motivo).
pub fn open(
    core: &Arc<Mutex<Core>>,
    want_rate: u32,
    want_channels: u16,
    ok_tx: &crossbeam_channel::Sender<Result<(), String>>,
    keep: &Receiver<()>,
    err_tx: &crossbeam_channel::Sender<()>,
) {
    unsafe {
        // S_FALSE si ya estaba inicializado: correcto en ambos casos
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }

    let run =
        || -> Result<(), String> {
            unsafe {
                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                        .map_err(|e| e.to_string())?;
                // La salida exclusiva usa el dispositivo predeterminado del sistema;
                // la selección de dispositivo de la UI se respeta en modo compartido.
                let device = enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .map_err(|e| format!("sin dispositivo de audio: {e}"))?;
                let client: IAudioClient = device
                    .Activate::<IAudioClient>(CLSCTX_ALL, None)
                    .map_err(|e| format!("no se pudo activar WASAPI: {e}"))?;

                let mut def_period = 0i64;
                let mut min_period = 0i64;
                client
                    .GetDevicePeriod(Some(&mut def_period), Some(&mut min_period))
                    .map_err(|e| format!("sin período del dispositivo: {e}"))?;

                // variantes a probar: float32/int32/int16 a la tasa pedida y vecinas
                let mut rates = vec![want_rate, 48000, 44100, 88200, 96000, 176400, 192000];
                rates.dedup();
                let mut variants = Vec::new();
                for r in rates {
                    variants.push(Fmt {
                        rate: r,
                        channels: want_channels,
                        bits: 32,
                        float: true,
                    });
                    variants.push(Fmt {
                        rate: r,
                        channels: want_channels,
                        bits: 32,
                        float: false,
                    });
                    variants.push(Fmt {
                        rate: r,
                        channels: want_channels,
                        bits: 16,
                        float: false,
                    });
                }

                let mut chosen: Option<Fmt> = None;
                let mut last_err = String::new();
                for f in variants {
                    let wfx = f.extensible();
                    let ptr = &wfx as *const WAVEFORMATEXTENSIBLE as *const WAVEFORMATEX;
                    match client.Initialize(
                        AUDCLNT_SHAREMODE_EXCLUSIVE,
                        0,
                        def_period,
                        def_period,
                        ptr,
                        None,
                    ) {
                        Ok(()) => {
                            chosen = Some(f);
                            break;
                        }
                        Err(e) => last_err = format!("{} ({e})", f.label()),
                    }
                }
                let fmt = chosen.ok_or_else(|| {
            format!("el dispositivo no aceptó ningún formato exclusivo; último intento: {last_err}")
        })?;
                log_msg(&format!("WASAPI exclusivo activo: {}", fmt.label()));

                let render: IAudioRenderClient = client.GetService().map_err(|e| e.to_string())?;
                let buffer_frames = client.GetBufferSize().map_err(|e| e.to_string())?;
                client.Start().map_err(|e| e.to_string())?;
                let _ = ok_tx.send(Ok(()));

                // bucle de render por sondeo: despierta cada ~2 ms (el período del
                // dispositivo ronda los 10 ms; despertar tarde provocaría cortes)
                let mut stopped_by_caller = false;
                loop {
                    // el llamador detiene el hilo soltando `kill_tx` (nunca
                    // enviando por él), así que la señal real es Disconnected,
                    // no Ok — solo Empty significa "seguir reproduciendo"
                    match keep.try_recv() {
                        Ok(()) | Err(TryRecvError::Disconnected) => {
                            stopped_by_caller = true;
                            break;
                        }
                        Err(TryRecvError::Empty) => {}
                    }
                    let Ok(padding) = client.GetCurrentPadding() else {
                        break;
                    };
                    let avail = buffer_frames - padding;
                    if avail == 0 {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    std::thread::sleep(Duration::from_micros(500));
                    let p = match render.GetBuffer(avail) {
                        Ok(p) => p,
                        Err(_) => break,
                    };
                    if p.is_null() {
                        break;
                    }
                    let n_units = avail as usize * fmt.channels as usize;
                    if let Ok(mut c) = core.lock() {
                        if fmt.float {
                            c.render_into::<f32>(std::slice::from_raw_parts_mut(
                                p as *mut f32,
                                n_units,
                            ));
                        } else if fmt.bits == 32 {
                            c.render_into::<i32>(std::slice::from_raw_parts_mut(
                                p as *mut i32,
                                n_units,
                            ));
                        } else {
                            c.render_into::<i16>(std::slice::from_raw_parts_mut(
                                p as *mut i16,
                                n_units,
                            ));
                        }
                    }
                    if render.ReleaseBuffer(avail, 0).is_err() {
                        break;
                    }
                }
                let _ = client.Stop();
                if stopped_by_caller {
                    log_msg("WASAPI exclusivo: stream cerrado");
                } else {
                    log_error("WASAPI exclusivo: el dispositivo falló en caliente");
                    let _ = err_tx.send(());
                }
                Ok(())
            }
        };

    if let Err(e) = run() {
        let _ = ok_tx.send(Err(e));
    }
}
