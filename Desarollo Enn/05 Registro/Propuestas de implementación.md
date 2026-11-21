---
resumen: Las 28 propuestas originales (A–F), todas hechas, y la tabla resumen de la fase 2.
estado: histórico
actualizado: 2026-11-09
tags: [enn, propuestas]
---

# Propuestas de implementación

Las 28 propuestas originales. Estado a 2026-09-12. **Cerradas y superadas por una fase 2**
iniciada 2026-09-25 — ver el resumen al final de esta nota y [[Roadmap]]
para el detalle completo (14 secciones con checkboxes).

> 🟡 Pendiente · ✅ Aprobada · 🚧 Implementada, verificación audible/en vivo pendiente · ✔️ Hecha y verificada

## A. Calidad de audio (la identidad de Enn)

- [x] 🚧 **A1. WASAPI exclusivo (opcional)**
  *Implementada (2026-09-12): módulo `exclusive.rs` con IAudioClient COM directo (crate `windows`); negocia formatos float32→int32→int16 y tasas vecinas; bucle de render por sondeo; fallback automático a compartido si el dispositivo rechaza todo; usa el dispositivo predeterminado del sistema. Compila y los tests pasan; la verificación audible con hardware real queda para la prueba manual (`mixer → Salida exclusiva`).*
- [x] 🚧 **A3. Soporte de alta resolución**
  *Implementada junto a A1 (2026-09-12): al activar la salida exclusiva, `play_path` reabre el stream a la tasa nativa de cada archivo (44.1/88.2/96/176.4/192 kHz); en compartido Windows remuestrea igual que antes.*
- [x] ✔️ **A2. Resampling de alta calidad**
  *HECHA (2026-09-11): resampler polifásico sinc con ventana Blackman (64 taps, 256 fases), camino rápido 1:1; margen de histórico de 64 frames en el motor.*
- [x] ✔️ **A4. Normalización ReplayGain / EBU R128**
  *HECHA (2026-09-11): `rg.rs` con ponderación K cookbook y doble puerta; referencia −18 LUFS (RG 2.0); análisis en segundo plano con progreso; persistido en `library.json`; casilla en el mezclador. Modo álbum HECHA (2026-09-13): casilla «Por álbum» que usa la media de LUFS de artista+álbum, aplicada en reproducción y en el cebo del crossfade.*
- [x] ✔️ **A5. Analizador de espectro**
  *HECHA (2026-09-12): anillo mono en `Core` alimentado desde el hilo de audio; FFT radix-2 propia en `dsp.rs` (con test del pico de seno); comando `get_spectrum` con 48 bandas logarítmicas hasta 16 kHz; canvas en el mezclador a 12 fps solo cuando está visible.*

## B. Biblioteca y experiencia

- [x] ✔️ **B1. Vista de álbumes con carátulas** — *HECHA (2026-09-11), ver nota de fase anterior.*
- [x] ✔️ **B2. Menú contextual** — *HECHA (2026-09-11).*
- [x] ✔️ **B3. Reordenar la cola por arrastre** — *HECHA (2026-09-11).*
- [x] ✔️ **B4. Historial y "Reproducidas recientemente"**
  *HECHA (2026-09-12): historial en localStorage (máx. 500) registrado en cada reproducción; pestaña nueva «Actividad» con el historial y las listas inteligentes.*
- [x] ✔️ **B5. Búsqueda avanzada**
  *HECHA (2026-09-12): prefijos `artista:`, `album:`, `formato:` (case-insensitive, sin tildes) combinables con texto libre.*
- [x] ✔️ **B6. Editor de etiquetas**
  *HECHA (2026-09-12): `tags_write` con crate `lofty` (título/artista/álbum, crea etiqueta si el archivo no tiene); refresca la biblioteca con los metadatos reales; editor desde el menú contextual.*
- [x] ✔️ **B7. Waveform en la barra de progreso**
  *HECHA (2026-09-12): picos por 240 bins calculados en segundo plano (solo archivos con índice de frames), caché en disco junto a la de carátulas, canvas detrás del slider coloreado por posición.*

## C. Composición y automatización

- [x] ✔️ **C1. Listas inteligentes**
  *HECHA (2026-09-12): «Más reproducidas» (top 25 por historial) en la pestaña Actividad, expandible; la infraestructura admite nuevas reglas.*
- [x] ✔️ **C2. Modo radio / autocompletar cola**
  *HECHA (2026-09-12): botón 📻 en la cola; al agotarse sugiere del mismo artista/álbum y si no algo aleatorio no en cola; persistido.*
- [x] ✔️ **C3. Crossfade entre pistas**
  *HECHA (2026-09-12): crossfade solapado real. El motor mantiene dos tuberías (`cur` + `next` decodificado); la UI ceba la siguiente pista con `prime_file` cuando entra en la ventana del fade, el motor la mezcla linealmente según el tiempo restante y la promueve al morir la actual (sin hueco de silencio ni evento de fin). Test `crossfade_promotes_primed` con dos senos de 4 s. Curvas equal-power (2026-09-13) para sonoridad constante en el cruce. En shuffle/repetir-una/búsqueda el cebo se cancela (el motor invalida la pista preparada al Seek).*
- [x] ✔️ **C4. Temporizador de apagado** — *HECHA (2026-09-12): 15/30/60 min en el mezclador.*
- [x] ✔️ **C5. Ecualizador paramétrico**
  *HECHA (2026-09-12): 4 bandas peaking libres (frecuencia, Q 0.3–10, ±12 dB) tras las 10 del gráfico; `Eq::set_param_band` recrea coeficientes; persistido en settings; UI compacta en el mezclador.*

## D. Descargador

- [x] ✔️ **D1. Cancelar descarga** — *HECHA (2026-09-12).*
- [x] ✔️ **D2. Formatos destino M4A/MP3/FLAC**
  *HECHA (2026-09-12): selector en el panel; yt-dlp recibe `--audio-format` correspondiente (siempre a la mejor tasa).*
- [x] ✔️ **D3. Más fuentes**
  *HECHA (2026-09-12): el backend ya aceptaba cualquier URL de yt-dlp; UI y validación actualizadas (YouTube, SoundCloud, Bandcamp…).*
- [x] ✔️ **D4. Empaquetar ffmpeg** — *HECHA (2026-09-12).*

## E. Plataforma

- [x] ✔️ **E1. Modo mini**
  *HECHA (2026-09-12): botón 🗕 en la barra; redimensiona la ventana a 430×90, oculta paneles por CSS; doble clic en la barra restaura.*
- [x] ✔️ **E2. SMTC + media keys** — *HECHA (2026-09-11).*
- [x] ✔️ **E3. Atajos globales**
  *HECHA (2026-09-12): plugin `tauri-plugin-global-shortcut`; Ctrl+Alt+P (play/pausa), Ctrl+Alt+←/→ (anterior/siguiente), Ctrl+Alt+S (stop), Ctrl+Alt+M (mezclador).*
- [x] ✔️ **E4. Bandeja del sistema**
  *HECHA (2026-09-12): tray con Reproducir/Pausar · Siguiente · Anterior · Mostrar · Salir; cerrar la ventana minimiza a la bandeja (corta descargas y para el motor); clic izquierdo restaura.*
- [x] ✔️ **E5. Instalador con sidecars** — *HECHA (2026-09-12).*
- [x] ✔️ **E6. Modo portable**
  *HECHA (2026-09-12): si existe `Enn.portable` junto al .exe, todos los datos viven en `Enn Data` al lado del ejecutable.*

## F. Calidad interna

- [x] ✔️ **F1. Tests del descargador**
  *HECHA (2026-09-12): la clasificación de stdout de yt-dlp es función testeable (`classify_line`) con test de líneas reales (progreso, Destination, ruta impresa por --print, URLs, errores).*
- [x] ✔️ **F2. Cero warnings de Rust** — *HECHA (2026-09-12): código muerto eliminado (EngineCmd::Shutdown, shutting_down, channels, HighPass, leftover_len…).*
- [x] ✔️ **F3. Cierre limpio de la app**
  *HECHA (2026-09-12): `Downloader::shutdown` corta la cola y mata los yt-dlp en marcha; se dispara al cerrar la ventana y al Salir desde la bandeja.*
- [x] ✔️ **F4. CI (GitHub Actions)** — *HECHA (2026-09-11): clippy, tests y chequeo de UI en cada push.*
- [x] ✔️ **F5. Presupuesto de memoria** — *Ver [[Presupuesto de recursos]].*

## Resumen

**28 de 28 propuestas implementadas y cerradas** (A1 pendiente solo de verificación audible con hardware real). **19 tests de Rust en verde** (contados con `cargo test` el 2026-10-03; el «9» que decía antes esta nota estaba desactualizado), cero warnings.

## Fase 2 (desde 2026-09-25) — resumen por sección de [[Roadmap]]

Roadmap fundamentado en lectura real del código (`src-tauri/src/*.rs`, `ui/app.js`, CI), no en suposiciones. Se trabaja por bloques aprobados, commits incrementales. Estado tras 30 commits:

| # | Sección | Estado |
|---|---|---|
| 0 | Expectativas sobre "Spotify" (aclaración legal/técnica) | Informativo, sin ítems propios |
| 1 | Importación/descarga | YouTube playlists ✅, duplicados al descargar ✅ · Spotify/YT Music/Apple Music, cola persistente: pendientes |
| 2 | Multiplataforma real | CI matriz macOS ✅, `reveal_in_folder` macOS ✅, media_keys ya era portable ✅ · Salida ALSA/PipeWire y CoreAudio nativas: pendientes (necesitan hardware real) |
| 3 | Formatos/calidad | Badge de calidad ✅, género/año ✅, bypass del resampler ya estaba bien ✅ · APE/WavPack, DSD, dither, **bug WAV sin tags**: pendientes/documentados |
| 4 | Biblioteca/organización | Favoritos ✅, editor por lote ✅, autocompletado ✅, "escuchadas recientemente" ✅, vistas Por género/Por año ✅, detección de duplicados en biblioteca ✅ · Smart playlists por reglas, escaneo incremental por hash: pendientes |
| 5 | Metadatos enriquecidos | Todo pendiente (MusicBrainz, letras, biografía — requieren APIs externas) |
| 6 | UI/UX | Now Playing a pantalla completa ✅, drag&drop ya existía ✅ · Temas personalizables, onboarding: pendientes |
| 7 | Accesibilidad | Navegación por teclado (vista Todas) ✅, ARIA ✅ · Densidad ajustable, lector de pantalla: pendientes |
| 8 | Robustez (deuda técnica) | Auditoría de `.unwrap()` ✅, reconexión de audio en caliente ✅, errores de descarga claros ✅, logging con niveles ✅ |
| 9 | Rendimiento | Escaneo paralelizado con rayon ✅ · Caché binaria, lazy-loading de carátulas: pendientes |
| 10 | Testing/CI | CI cross-platform ✅, tests del resampler ✅, ESLint ✅ · Tests de integración del downloader: pendiente |
| 11 | Empaquetado | Todo pendiente (AppImage/deb, dmg, auto-update, changelog) |
| 12 | Seguridad | **Inyección de argumentos en yt-dlp corregida** ✅, checksum de sidecars ✅, permisos de Tauri revisados ✅ |
| 13 | Documentación/portafolio | CONTRIBUTING.md + issue templates ✅, sección de decisiones de diseño ✅ · Diagrama más visual, capturas/GIF: pendientes |
| 14 | Enn Server + nube (Docker/Ansible/Terraform/AWS) | Todo pendiente — necesita credenciales/infra que no están disponibles en este entorno |

Detalle completo de cada ítem, con bugs encontrados y su justificación, en [[Decisiones de desarrollo]] (#40 a #62) y en [[Roadmap]].
