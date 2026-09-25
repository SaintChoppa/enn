# Enn

A lightweight, high-fidelity music player for Windows, written in Rust with a native-feeling web UI (Tauri 2). No subscriptions, no telemetry, no cloud: decoding, mixing, equalization and output all happen locally.

![Enn](docs/enn-ui.png)

## Why Enn

Most players force a trade-off: commercial catalog apps are heavy and phone home; audiophile players demand a steep setup. Enn takes a deliberate middle path:

- **Very low resource usage** — a real-time engine in Rust, a framework-free UI, no background services.
- **Broad format support** — MP3, FLAC, WAV, AIFF, OGG/Vorbis, Opus, M4A/AAC via [Symphonia](https://github.com/pdeljanov/Symphonia).
- **Serious audio quality** — 32-bit float pipeline, polyphase resampler, 10-band EQ, ReplayGain 2.0 loudness normalization.
- **Instant to use** — add a folder, click a song, it plays.

## Features

| Area | Details |
|---|---|
| Audio engine | Symphonia decode → f32 stereo → 10-band + 4 parametric biquad EQ (RBJ) → bass/treble/balance → polyphase resampler (64-tap Blackman-windowed sinc, 256 phases) → WASAPI shared (CPAL) or **exclusive bit-perfect** output at the file's native sample rate (44.1–192 kHz) |
| Loudness | ReplayGain 2.0 (EBU R128 K-weighting, double gating) analyzed in background, applied per track |
| Visualization | 48-band log spectrum analyzer (own radix-2 FFT) and per-track waveform in the seek bar |
| Library | Recursive folder scan, tag reading, VBR-safe durations, advanced search (`artist:`, `album:`, `format:`, `favorite:`), per-track favorites (★, survive rescans), artist and album views with embedded cover art |
| Queue | Visible up-next list, drag to reorder, context menu, shuffle, repeat one/all, **radio mode** that keeps suggesting similar tracks |
| History | Recently played and most-played smart lists |
| Playlists | M3U/M3U8 import/export plus named app playlists with per-track add/remove |
| Tag editor | Rewrite title/artist/album directly into the audio files (lofty) |
| Downloader | Built-in audio download for any yt-dlp site (YouTube, SoundCloud, Bandcamp…), single tracks **or full playlists/albums** (auto-expanded into individual per-track jobs), M4A/MP3/FLAC output, per-task cancel, real-time progress |
| System integration | SMTC media keys / volume overlay (Windows), global hotkeys (Ctrl+Alt+P/←/→/S/M), system tray with close-to-tray, output device picker, mini mode, auto light/dark theme, portable mode |
| Persistence | Library, mixer settings, queue, per-track gains, playlists and art/waveform caches survive restarts |

## Architecture

```
Audio file
     │
     ▼
 Symphonia ── decode to f32 stereo PCM
     │
     ▼
 10-band EQ · tone · balance · ReplayGain gain
     │
     ▼
 polyphase resampler (to device rate)
     │
     ▼
 WASAPI shared ── speakers or chosen output
```

- `src-tauri/src/decode.rs` — container/codec handling, f32 normalization
- `src-tauri/src/dsp.rs` — RBJ biquads, 10-band + parametric EQ, polyphase resampler, FFT
- `src-tauri/src/player.rs` — stream owner thread, command queue, sample-accurate fades
- `src-tauri/src/exclusive.rs` — WASAPI exclusive mode (bit-perfect, native rates)
- `src-tauri/src/rg.rs` — EBU R128 loudness analysis (K-weighting, dual gate)
- `src-tauri/src/art.rs` — embedded cover extraction with on-disk cache
- `src-tauri/src/waves.rs` — waveform peak analysis with on-disk cache
- `src-tauri/src/media_keys.rs` — SMTC now, MPRIS-ready (Linux port planned)
- `src-tauri/src/downloader.rs` — serial download worker around yt-dlp
- `ui/` — framework-free HTML/CSS/JS over typed Tauri commands

The UI polls engine state every 250 ms (no event accumulation between processes) and renders the library in windows of 500 rows.

## Build

Requirements: [Rust](https://rustup.rs), Node.js (for the Tauri CLI), and on Windows the MSVC toolchain.

```bash
npm install
npm run tauri dev      # run in development
npm run tauri build    # produce the NSIS installer
```

On first build, `build.rs` downloads the `yt-dlp` and `ffmpeg` sidecars (not stored in the repository) so the installer works out of the box.

## Testing

```bash
cd src-tauri
cargo test             # decode drain, audio smoke, LUFS analysis, FFT, yt-dlp line parsing
```

## Roadmap

Linux port (ALSA/PipeWire + MPRIS), overlapped crossfade and more — tracked in the project notes.

## License

[MIT](LICENSE)
