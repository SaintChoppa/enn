---
resumen: Flujo de audio, módulos Rust, shell de la UI, IPC, rutas de datos y entorno de desarrollo.
estado: vivo
actualizado: 2026-11-09
tags: [enn, arquitectura]
---

# Arquitectura

El proyecto se divide en dos componentes que se comunican a través del puente IPC de Tauri.

Actualizado 2026-09-25.

## Flujo de audio

```
Archivo de audio
     │
     ▼
 Symphonia ── decodificación a PCM f32 estéreo
     │
     ▼
 EQ 10 bandas + 4 paramétricas · tono · balance · ReplayGain (pista o álbum)
     │
     ▼
 remuestreo polifásico sinc (64 taps × 256 fases) a la frecuencia del dispositivo
     │                          ▲
     │            (crossfade equal-power: doble tubería cur+next)
     ▼
 WASAPI compartido (CPAL) o exclusivo a tasa nativa ── altavoces
```

## Núcleo Rust (`src-tauri/src/`)

| Módulo | Responsabilidad |
|---|---|
| `main.rs` | Punto de entrada mínimo |
| `lib.rs` | Estado de la app (`EnnState`), ~40 comandos `#[tauri::command]`, settings, bandeja, hotkeys globales, glue de descargador/playlists/tags; **logging estructurado con niveles** (`ENN_LOG=debug\|warn\|error`), `dbg_log` expone la misma ruta desde la UI |
| `decode.rs` | Contenedores y códecs vía Symphonia; normalización a estéreo f32; medición de duración (VBR); escaneo de directorios; `read_tags` extrae género/año vía `StandardTagKey` (WAV no expone tags, ver [[Decisiones de desarrollo]]) |
| `dsp.rs` | Biquads RBJ, EQ 10 bandas + 4 paramétricas, remuestreador polifásico sinc (Blackman 64 taps × 256 fases, con bypass exacto cuando ratio≈1), FFT radix-2 para el espectro; cobertura de tests de regresión (bypass + THD a 44.1→48 kHz) |
| `player.rs` | Motor: doble tubería (cur + next para crossfade equal-power), fades por muestra, ReplayGain como ganancia, hilo de audio CPAL/WASAPI, eventos hacia la UI; **supervisor de reconexión** ante dispositivo desconectado en caliente (reintentos + backoff, expone `audio_error` en `get_state`) |
| `exclusive.rs` | Salida WASAPI exclusiva bit-perfect (IAudioClient COM), tasa nativa del archivo, fallback a compartido (solo Windows, `#![cfg(target_os = "windows")]`). *Bug corregido 2026-09-25: el bucle de render confundía `try_recv()==Ok` con "canal cerrado"; el cierre real es un variant `Disconnected` — un fallo de hardware se camuflaba como cierre limpio* |
| `rg.rs` | Análisis EBU R128 (ponderación K, doble puerta), referencia −18 LUFS |
| `art.rs` | Extracción de carátulas incrustadas (cabeceras) + respaldo cover/folder.jpg + caché en disco con podado |
| `waves.rs` | Waveform: picos por 240 bins en segundo plano, caché en disco |
| `media_keys.rs` | SMTC/MPRIS vía souvlaki: metadatos + carátula + posición al sistema, eventos hacia la cola de la UI |
| `library.rs` | Índice persistente JSON (con `rg`, favoritos, género/año por pista), `probe` de metadatos, M3U leer/escribir; `scan_into`/`refresh`/`probe_many` **paralelizados con `rayon`** (cada archivo se decodifica de forma independiente); detección de duplicados por título normalizado |
| `downloader.rs` | Worker serie con `mpsc`, yt-dlp (formatos M4A/MP3/FLAC), título real (`--print ENN-TITLE`), progreso por stdout, cancelación por proceso; `resolve_entries()` expande playlists de YouTube en una tarea por vídeo; `is_valid_download_url()` exige `http(s)://` literal (blindaje contra inyección de argumentos, ver [[Decisiones de desarrollo]]); `friendly_download_error()` traduce fallos comunes a mensajes claros en español; aviso de duplicado por título normalizado |
| `plstores.rs` | Playlists nombradas en M3U8; alta/baja editando el archivo línea a línea |

## Build de frontend (2026-10)

- `ui/tw-input.css` → `ui/tw-output.css` vía **Tailwind v4** (`npm run build:css`/`watch:css`); el output NO se commitea (`.gitignore`)
- `tauri.conf.json`: `beforeDevCommand`/`beforeBuildCommand` regeneran el CSS antes de `tauri dev`/`tauri build`
  - ✅ **Implementado 2026-10-03** (antes solo estaba documentado aquí): las dependencias
    `tailwindcss`/`@tailwindcss/cli` están en `devDependencies`, los scripts existen y
    `ui/tw-output.css` figura en `.gitignore`. En `beforeDevCommand` se usa `wait: true` para
    que la UI no cargue antes de que el CSS esté escrito. Ver [[Auditoría de bugs 2026-10-03]] #3.
- Tailwind se usa solo para layout/spacing en marcado nuevo; color/vidrio/acento siguen siendo variables CSS de `styles.css`, expuestas a Tailwind como tokens semánticos vía `@theme inline` (`bg-surface`, `text-ink`, etc. → `var(--bg)`, `var(--text)`...) — ver [[Decisiones de desarrollo]] #64-#65
- `ui/fonts/`: Inter (4 pesos, subconjuntos latin/latin-ext) + Material Symbols Outlined, autoalojadas (`fonts.css`) ⚠ **PENDIENTE**: `fonts.css` no está enlazado ni importado desde ninguna parte, así que en la app real no se carga ninguna de estas fuentes (se sirve Segoe UI Variable) y los iconos que se ven son el sprite SVG propio de `index.html`. Ver decisión #80 en [[Decisiones de desarrollo]] y [[Auditoría de bugs 2026-10-03]] #5
- `ui/dev-mock.js`: stub de `window.__TAURI__` para previsualizar la UI en un navegador normal; no-op en la app real (#82). ⚠ **Ojo**: `index.html` **no lo enlaza**, así que hay que añadir el `<script>` a mano (o servir `ui/` por HTTP: con `file://` los módulos ES no cargan)

## Shell de la UI (2026-10, segunda pasada del rediseño)

Reestructuración completa del layout — ver [[Decisiones de desarrollo]] #72-79.
Nombres reales en el código (verificado 2026-10-03; esta sección citaba ids que no existen):

- `#titlebar` (fijo, arriba): marca, toggle Modo Simple/Studio, buscador, botón Descargar y los controles de ventana (`win-min`/`win-max`/`win-close`, la ventana va sin decoración nativa)
- `#sidebar` (fijo, izquierda): navegación de biblioteca — botones `.nav-item` con `data-nav` (`nowplaying`, `all`, `artist`, `albums`, `genre`, `year`, `activity`, `playlist`, `downloads`); las pestañas `tab-*` siguen en el DOM (ocultas) y `setView()` no cambió
  - ⚠ **PENDIENTE**: no hay widget de caché en la barra lateral; el comando Rust `cache_stats` existe pero **ninguna parte de la UI lo llama** (ver [[Auditoría de bugs 2026-10-03]] sección 📄)
- `#app` (rejilla `title | side | stage | rail | ctrl`, ancho de `rail` controlado por `--qw` y el divisor `#split`):
  - `stage` = `#stage`: contiene las tres vistas (`#now-playing`, `#view-library`, `#view-downloads`), alternadas por `data-view` en `<body>` (`goView()`/`syncShell()`)
  - `rail` = `#rail`: `#mixer` + `#studio-telemetry` (en Studio) y `#queue-panel` siempre visible
    - ⚠ **PENDIENTE**: no existe `#mixer-simple` ni perillas; el mezclador son sliders (`mix-bass`/`mix-treble`) en ambos modos. Tampoco existen el reactor cinético ni los medidores VU (ver #66/#68)
- `#controls` (dock, fijo abajo): transporte, scrubber, carátula/título, salida/volumen — ya sin los botones de abrir mezclador/studio (retirados, ver #75). En Simple + vista "Reproduciendo" el transporte, el scrubber y el dock **se mudan al escenario** (son los mismos nodos; `placeParts()`)
- `#now-playing`: ya no es un overlay a pantalla completa — es la vista "Reproduciendo" del escenario (el `<section id="now-playing">` sigue conservando ese id para el espectro)

## UI (`ui/`)

- `index.html`: paneles biblioteca / mezclador+descargador / cola + barra de controles
- `styles.css`: **glassmorphism** (paneles translúcidos con blur), paleta neutra institucional (grises + azul marino; verde=éxito, rojo=error), tema claro/oscuro automático, modo mini
- `app.js`: sin frameworks; ahora con **ESLint** (`npm run lint`), en CI y en el checklist de `CONTRIBUTING.md`
  - Sondeo del motor cada **250 ms** (`get_state`); **cebo del crossfade** cuando la pista entra en la ventana del fade (`prime_file`) y avance automático de la cola al promover el motor
  - Descargador: sondeo 400 ms con panel abierto, título real, chips de estado, sonidos WebAudio (campanilla/error), mensajes de error amigables
  - Espectro a 12 fps solo con el mezclador visible (también alimenta el fondo audio-reactivo y la vista "Ahora suena"); waveform bajo la barra de progreso
  - Render por ventanas de la biblioteca (500 + 300 al scroll); carátulas con IntersectionObserver
  - Navegación por teclado en la vista Todas (cursor con flechas/Home/End, Enter reproduce); vistas Por género/Por año además de Por artista

## Visualizador (2026-11-09)

- `src-tauri/src/viz.rs`: análisis bajo demanda (FFT Blackman, bandas con AGC, tono, centroide, ataques) sobre el anillo del motor, que va ~90 ms por delante del altavoz gracias a la línea de retardo de `player.rs`.
- Comando `get_viz_frame`, que la UI pide una vez por frame mientras suena algo.
- `ui/viz/` (WebGL2): `common.js` (base y `VizFeed`), `traza.js`, `cinta.js` e `index.js` (controlador, protagonismo de Studio y vista Ajustes).
- Detalle en [[Visualizador - Cinta y Traza]].

## Comunicación

- Comandos tipados `#[tauri::command]` (~40 en `invoke_handler`): incluye `prime_file` (crossfade), `set_exclusive`, `set_param_band`, `get_spectrum`, `waveform`, `tags_write`, `rg_scan_start`, `reveal_in_folder`, `download_cancel`
- Eventos: `download://progress`, `download://finished`, `enn://rg` (análisis ReplayGain), `enn://media` (anterior/siguiente desde SMTC/hotkeys), `enn://ui` (mezclador desde hotkey)

## Rutas de datos

- Config: `%APPDATA%\<identificador>\` → `library.json`, `settings.json`, `download_dir.json`, `Enn Playlists\*.m3u8`
- yt-dlp: junto al ejecutable (instalador) o `src-tauri/binaries/` (dev)

## Desarrollo

- `dev.ps1`: fija `CARGO_TARGET_DIR=D:\enn-target` (OneDrive bloquea `target\`) y lanza `npm run tauri dev`
- Tests: `cargo test` — incluye drenaje del decodificador, humo de audio, **promoción del crossfade**, análisis LUFS, pico de FFT, clasificación de líneas yt-dlp, parseo de porcentaje, carátulas, y (2026-09-25) **regresión del remuestreador** (bypass exacto + tono de 1 kHz 44.1→48 kHz sin distorsión armónica relevante)
- CI (`.github/workflows/ci.yml`): matriz **`[windows-latest, ubuntu-latest, macos-latest]`** (antes solo Windows+Ubuntu) — `fmt`+`clippy -D warnings` en Windows, deps de Tauri/ALSA/dbus + check + clippy + tests en Linux/macOS; `audio_smoke` se omite con gracia si el runner no tiene tarjeta de sonido; sin verificar aún en un run real de GH Actions
- `build.rs`: descarga yt-dlp/ffmpeg como sidecars con **verificación de checksum SHA-256** (contra `SHA2-256SUMS` de yt-dlp); *bug corregido 2026-09-25: la URL del asset de yt-dlp devolvía 404 por confundir la convención de sidecar de Tauri con el nombre real en GitHub — cualquier clon nuevo se quedaba sin binario hasta notarlo a mano*
- Presupuesto medido: ver [[Presupuesto de recursos]] (166 MB reposo, ~0.5 % CPU)

## Decisiones recientes (2026-09-11)

1. Progreso de descarga se lee de **stdout** de yt-dlp (stderr solo errores)
2. Ruta final del archivo descargado vía **`--print after_move:filepath`**, fallback al archivo más reciente
3. Descargas **serie**, no paralelas
4. Playlists de la app en el **directorio de configuración**, no dentro de la primera carpeta de música
5. `playlist_add/remove` edita el M3U8 sin decodificar los archivos referenciados
