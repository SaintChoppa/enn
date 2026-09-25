# Contributing to Enn

Enn is a small, opinionated project — a real-time audio engine and a
framework-free UI, both kept intentionally simple. Contributions are welcome,
but please open an issue before starting anything beyond a small fix so we
can agree on the approach first.

## Development setup

Requirements: [Rust](https://rustup.rs) (stable), Node.js (for the Tauri
CLI), and on Windows the MSVC toolchain.

```bash
npm install
npm run tauri dev      # run in development, with hot reload for ui/
```

`src-tauri/build.rs` downloads the `yt-dlp` and `ffmpeg` sidecars on first
build (not stored in the repository); this only happens on Windows today.

## Before opening a PR

```bash
cd src-tauri
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo test
node --check ../ui/app.js
```

CI runs the same checks on `[windows, ubuntu, macos]`; a PR that doesn't pass
locally on your platform won't pass there either.

## Code style

- Rust: follow `rustfmt` defaults, keep `unsafe` blocks small and commented
  with *why* they're sound, prefer returning `Result<_, String>` with a
  message a user could actually read over `unwrap()` outside of tests.
- JS: no framework, no build step — `ui/app.js` is loaded as-is. Keep new
  code in the same plain-function style as the surrounding file.
- Comments explain *why*, not *what* — the code should read clearly enough
  that a comment restating it would be redundant.

## Scope

Enn deliberately does **not** aim to be a Spotify/streaming client — see
`ROADMAP-ENN.md` section 0 for why, and what a legal, metadata-based
integration would look like instead. Feature requests along those lines are
welcome as long as they respect that constraint.

## Reporting bugs

Please include: OS + version, Enn version, steps to reproduce, and — if it's
an audio issue — the output device and whether exclusive/bit-perfect mode
was on. `%TEMP%\enn-debug.log` (Windows) has structured logs; set
`ENN_LOG=debug` before launching for more detail.
