---
resumen: Punto de entrada de la bóveda. Dice qué nota leer para cada tarea, las reglas de trabajo y el estado actual.
estado: vivo
actualizado: 2026-11-09
tags: [enn, indice]
---

# Enn — Índice

Enn es un reproductor de música para Windows (Rust + Tauri 2, con UI HTML/CSS/JS sin framework). Es local, sin telemetría y con audio serio. Va por la v0.1.0 y tiene licencia MIT.

## Reglas (para personas y LLM)

1. **Lee primero este índice**. Después abre solo la nota que pida la tarea. Cada nota trae en su frontmatter un `resumen` de una línea.
2. Las notas con `estado: histórico` son registro del pasado. **No hace falta leerlas** salvo que la tarea toque algo de ellas.
3. **Cada cambio se apunta con fecha** en [[Registro de cambios]], arriba del todo. Si es una decisión, va además como fila en [[Decisiones de desarrollo]]. Si es una tarea, va en [[Kanban - Enn]].
4. **Decisiones** (regla actualizada el 2026-11-15): se pregunta solo lo importante para la app, y al abrir cada sprint. Las decisiones generales se toman como lo hacen Spotify o YouTube Music y se dejan escritas para que el propietario las corrija.
5. **No se commitea** hasta que el propietario lo diga.
6. Todo lo escrito del proyecto vive aquí, roadmap incluido.

## Qué leer según la tarea

| Tarea | Nota |
|---|---|
| Qué es Enn, objetivos, principios | [[Visión y objetivos]] (01 Proyecto) |
| Memoria/CPU, medición, port a Linux | [[Presupuesto de recursos]] (01) |
| Código: módulos, flujo de audio, IPC, rutas, dev | [[Arquitectura]] (02 Técnica) |
| Qué hace la app hoy | [[Características actuales]] (02) |
| Por qué algo es como es (ADR #1–#92) | [[Decisiones de desarrollo]] (02) |
| Usuarios, principios de producto, no-objetivos | [[Diseño - Producto]] (03 Diseño) |
| Tokens, cristal, componentes, movimiento | [[Diseño - Sistema visual]] (03) |
| Qué hay que hacer ahora | [[Kanban - Enn]] (04 Planes) |
| **Plan de la beta 0.2** (7 sprints) | [[Plan maestro - Beta 0.2]] → la nota del sprint en curso (Sprint 1 cerrado: [[Pruebas - Sprint 1]]; siguiente: [[Sprint 2 - Descargas]]) · evidencia en [[Investigación - Beta 0.2]] (04 Planes/Beta 0.2) |
| Plan largo (fase 2, 14 secciones) | [[Roadmap]] (04) |
| Buscador del descargador (YouTube Music) | [[Buscador de descargas 2026-11-09]] (04) |
| Rediseño de la interfaz (2026-11-09) | [[Rediseño de interfaz 2026-11-09]] (04) |
| Visualizador nuevo Cinta/Traza | [[Visualizador - Cinta y Traza]] (04) + `Adjuntos/Handoff visualizador 2026-11-09/` |
| Qué cambió y cuándo | [[Registro de cambios]] (05 Registro) |
| Histórico: auditoría, plan de UI, 28 propuestas | [[Auditoría de bugs 2026-10-03]] · [[Auditoría de bugs 2026-11-12]] · [[Auditoría de interfaz 2026-11-13]] · [[Revisión de bugs 2026-11-12]] · [[Plan de interfaz 2026-10-03]] · [[Propuestas de implementación]] (05) |

## Mapa rápido del repo

- `src-tauri/src/` es el motor Rust:
  - `player.rs`: hilo del stream, cola y fundidos;
  - `dsp.rs`: EQ, remuestreador y FFT;
  - `decode.rs`, `exclusive.rs` (WASAPI exclusivo), `rg.rs` (R128), `library.rs`, `downloader.rs`, `art.rs`, `waves.rs`, `media_keys.rs`, `plstores.rs`;
  - `lib.rs`: comandos de Tauri.
- `ui/` es la interfaz:
  - `index.html`, `app.js` (unas 3.900 líneas), `styles.css`;
  - `palette.js`: color de la carátula;
  - `tw-input.css` genera `tw-output.css` (no se versiona);
  - `fonts/`, y `dev-mock.js` para previsualizar en un navegador.
- Build:
  - `npm run tauri dev` / `build`;
  - el caché de cargo está en `D:\enn-target` (lo fija `src-tauri/.cargo/config.toml`, sin versionar);
  - `build.rs` descarga yt-dlp y ffmpeg.
- Puertas de calidad: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (24), `npm run lint`, `node --check ui/app.js`.

## Estado (2026-11-09)

- **Carpeta del proyecto**: `C:\Users\hectr\OneDrive\Documentos\Codes\Enn`. Las rutas antiguas `Escritorio\Enn` y `Reproductor de musica` ya no valen.
- **Git**: `master` va 30 commits por delante de `origin`, que solo tiene `a7fba88`. El rediseño de UI y las correcciones de la auditoría (2026-10-03/04) están **sin commitear**.
- **Calidad**: clippy limpio, 24/24 tests, lint en verde.
- **Visualizador Cinta/Traza**: implementado y verificado el 2026-11-09, pendiente de la revisión del propietario → [[Visualizador - Cinta y Traza]].
- **Modo exclusivo**: el 2026-11-09 se corrigió que no actualizaba la tasa del motor; falta probarlo de oído.
- **Lo grande pendiente** del [[Roadmap]]: salida nativa en Linux/macOS y Enn Server.
