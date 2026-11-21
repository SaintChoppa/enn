---
resumen: Inventario por área de lo que la app hace hoy; ⚠ marca lo documentado que no existe en el código.
estado: vivo
actualizado: 2026-11-09
tags: [enn, funciones]
---

# Características actuales

Estado a fecha de 2026-09-25. Las 28 propuestas originales están implementadas
(ver [[Propuestas de implementación]]) y se sumó una **fase 2** de 30 commits
(robustez, seguridad, biblioteca y UI) tras una auditoría real del código —
detalle en [[Roadmap]] y en [[Decisiones de desarrollo]].

## Audio

| Área | Detalle |
|---|---|
| Formatos | MP3, FLAC, WAV, AIFF, OGG/Vorbis, M4A/AAC (Symphonia). **Opus NO está soportado**: Symphonia 0.5.5 no trae decodificador de Opus y `SUPPORTED_EXT` no incluye `.opus` (el README ya no lo anuncia) — ver [[Auditoría de bugs 2026-10-03]] #6 |
| Salida compartida | WASAPI vía CPAL, f32, hasta 2 canales |
| Salida exclusiva | WASAPI exclusivo opcional (bit-perfect) con negociación float32/int32/int16 y fallback automático a compartido |
| Hi-Res | En exclusiva, el stream se abre a la tasa nativa del archivo (44.1–192 kHz) |
| Cadena DSP | EQ gráfico 10 bandas → 4 bandas paramétricas libres (f/Q/ganancia) → graves/agudos → balance → ReplayGain → ganancia por pista → fundidos in/out |
| Resampler | Polifásico sinc Blackman 64 taps × 256 fases, camino rápido 1:1 |
| ReplayGain | EBU R128 (K-weighting, doble puerta), referencia −18 LUFS, análisis en segundo plano con progreso; **modo por álbum** opcional (media del disco, conserva la dinámica) |
| Analizador | Espectro de 48 bandas log (FFT propia) en el mezclador; waveform de 240 bins en la barra de progreso |
| Presets EQ | Rock, Pop, Clásica, Bajos+, Voz, Agudos+, Plano |
| Fade / Crossfade | Fundidos de entrada y salida 0–12 s + **crossfade solapado real equal-power** entre pistas de la cola (doble tubería en el motor) |
| Ganancia por pista | Ajuste dB relativo recordado por archivo, combinado con ReplayGain |
| **Badge de calidad de fuente** | Junto al título: formato, frecuencia de muestreo y bits/profundidad (o kbps si es lossy) de la pista en curso |
| **Reconexión de audio en caliente** | Si el dispositivo de salida se desconecta (Bluetooth que se apaga, USB desenchufado), un supervisor reabre el stream con reintentos y backoff y avisa al usuario en vez de congelar la reproducción en silencio |

## Biblioteca y reproducción

- Escaneo recursivo (**paralelizado con rayon**: cada archivo se decodifica de forma independiente), etiquetas, duración VBR-safe, búsqueda instantánea
- Vistas: Todas, Por artista, **Por género**, **Por año**, Álbumes (rejilla con carátulas), Playlist, Actividad (historial + Más reproducidas + Escuchadas recientemente)
- **Navegación por teclado** en la vista Todas: flechas/Home/End mueven un cursor visible, Enter reproduce (vistas agrupadas por artista/género/año/álbum quedan pendientes, tienen estructura de acordeón)
- Búsqueda avanzada: `artista:`, `album:`, `formato:`, **`favorito:`** + texto libre
- Cola: clic, arrastre con marcador de inserción, menú contextual, vaciar
- Modos: ordenado, aleatorio, repetición una/todo, **modo radio** (sugerencias del mismo artista/álbum al agotarse la cola)
- Historial de reproducción (máx. 500) persistente, colapsado por defecto en la pestaña Actividad
- **Favoritos por pista** (★, campo `favorite: bool` con serde default, filtrable con `favorito:`)
- **Detección de duplicados en la biblioteca** (mismo título ya indexado)
- Menú contextual: reproducir, **reproducir a continuación**, añadir a cola/playlist, mostrar en carpeta (con rama macOS `open -R`), propiedades, **editar etiquetas** (lofty)
- **Editor de etiquetas por lote** («✎ Lote»): edita artista/álbum/género de todo lo que coincide con el filtro de búsqueda activo
- **Autocompletado de artista/álbum** (`<datalist>`) en el editor individual y en el de lote
- Etiquetas de **género y año** extraídas vía `StandardTagKey` de Symphonia (no adivinando nombres de clave crudos); *nota: los `.wav` no exponen ninguna etiqueta por una limitación de Symphonia — ver [[Decisiones de desarrollo]]*
- Arrastrar y soltar archivos; cola persistente

## Playlists

- M3U/M3U8 import/export; playlists nombradas de la app en el directorio de configuración
- Añadir pista actual o cualquier pista vía menú contextual (submenú de playlists)

## Descargador integrado

- yt-dlp + ffmpeg empaquetados como sidecars (descargados en build con **verificación de checksum SHA-256** contra `SHA2-256SUMS` de yt-dlp; ffmpeg no tiene hash fetcheable equivalente y se documenta como tal)
- Fuentes: cualquier URL soportada por yt-dlp (YouTube, SoundCloud, Bandcamp…); **playlists de YouTube** se expanden en una tarea por vídeo (`resolve_entries()`) reutilizando progreso/cancelación por tarea
- Formatos: M4A (mejor calidad), MP3, FLAC sin pérdida
- **Título real de la canción** en la lista desde el primer segundo (vía `--print`), no la URL
- **Aviso de duplicado**: si el título normalizado ya está en la biblioteca, se avisa (no bloqueante) antes de descargar de nuevo
- **Chips de estado con color**: en cola (gris) · descargando (azul marino, %) · ✓ completada (verde) · error (rojo) · cancelada (gris)
- **Mensajes de error claros** (`friendly_download_error`): privado/borrado, restricción de edad, 403/429, sin red, sin espacio — en español, no stderr crudo
- **Sonidos** (solo descargas): campanilla al completar, tono grave en error — generados con WebAudio, sin archivos
- **Validación estricta de URL** (`http(s)://` literal, sin espacios) contra inyección de argumentos a yt-dlp — ver [[Decisiones de desarrollo]]
- Progreso en tiempo real, cancelación por tarea, auto-indexado, «Escuchar»/«Cola»

## Interfaz y sistema

> [!warning] Verificado 2026-10-03: esta sección describía piezas que NO están en el código
> El rediseño «Obsidian Hi-Fi» que sí existe (shell fijo, color reactivo de la carátula, dock,
> tema obsidiana) está mezclado abajo con trabajo que **nunca llegó al repositorio**: perillas del
> Modo Simple, perfil «Natural», widget de caché, reactor cinético, medidores VU, iconos Material
> Symbols y fuentes Inter. Todo lo que falta va marcado con ⚠ **PENDIENTE**.
> Detalle y pruebas: [[Auditoría de bugs 2026-10-03]].

- **Rediseño "Obsidian Hi-Fi" (2026-10)**, en dos pasadas — ver [[Decisiones de desarrollo]] #63-71 (paleta/color reactivo) y #72-82 (shell completo + backend):
  - **Shell fijo**: cabecera arriba (`marca · Modo Simple/Studio · botón Descargar · controles de ventana`), barra lateral izquierda (navegación de biblioteca), dock de reproducción abajo — todo fijo, el contenido central hace scroll. ⚠ **PENDIENTE**: el widget de caché de la barra lateral no existe
  - **Vista "Reproduciendo"**: carátula grande, glow ambiental, scrubber y transporte grandes, favorito/añadir — es la landing por defecto en Modo Simple, con las vistas de biblioteca (Todas/artista/género/año/álbumes/playlist/actividad) como enlaces de la barra lateral en vez de pestañas horizontales
  - **Rail derecho persistente**: mezclador siempre visible; EQ gráfico de 10 bandas + 4 paramétricas + telemetría en Modo Studio — mismo estado por debajo, dos superficies según el modo. ⚠ **PENDIENTE**: no hay perillas (son sliders `mix-bass`/`mix-treble`) ni los 4 perfiles rápidos con «Natural»; tampoco reactor ni VU
  - **Color de acento reactivo**: extraído en vivo de la carátula (canvas 24×24, cubos de color, sin librerías), aplicado a glow, scrubbers, tabs activos y espectros; cae a un platino neutro sin pista. Verde/rojo de éxito-error siguen fijos (señalética, no identidad)
  - ⚠ **PENDIENTE — Iconografía**: el marcado usa un **sprite SVG propio** (`#i-*` en `index.html`), no Material Symbols; el archivo de la fuente existe en `ui/fonts/` pero no se carga
  - ⚠ **PENDIENTE — Fuentes**: `ui/fonts/fonts.css` (Inter + Material Symbols) no está enlazado ni importado; la app se sirve con Segoe UI Variable
- **Modo Avanzado Studio**: telemetría con datos reales (formato/frecuencia/profundidad/tasa de bits, y el modo de salida elegido). ⚠ **PENDIENTE**: el reactor cinético pseudo-3D y los medidores de nivel L/R no existen en el código; THD+N/jitter/headroom/latencia de buffer siguen sin medirse (marcados como "—", no como números inventados)
- **Botón de descarga marfil**: acabado monocromático de alto contraste, deliberadamente ajeno al color reactivo de la pista; su chip muestra el formato de *destino* seleccionado, no el de la pista sonando (el botón lleva a la vista Descargas, ya no abre un panel flotante)
- ⚠ **PENDIENTE — Caché en disco (barra lateral)**: el comando Rust `cache_stats` (tamaño real de `ArtCache` + nº de pistas) existe, pero **ninguna parte de la UI lo llama**; no hay widget
- Glassmorphism: paneles translúcidos con blur(20px) y sombras suaves sobre fondo con degradado reactivo sutil
- Tema **oscuro único** (obsidiana + cromo plateado: no hay variante clara ni `prefers-color-scheme` — es una desviación respecto de lo que decía este punto y de la decisión #70); divisor arrastrable (rail); modo mini (430×90, reestilizado al nuevo shell)
- **Vista "Reproduciendo"** (clic en la carátula/título del reproductor, o enlace "Reproduciendo" del menú): carátula grande + espectro en vivo, y en Modo Simple el transporte y el scrubber se mudan ahí. Letras queda pendiente (necesita fuente de letras externa)
- **Fondo animado audio-reactivo** + pulido general de animaciones y transiciones entre vistas
- **Tamaño mínimo de ventana real** aplicado; toolbar y tabs hacen wrap en vez de recortarse
- **Arranque perezoso del audio**: la ventana abre al instante; el dispositivo se abre al reproducir
- SMTC: media keys, overlay de Windows, Bluetooth; metadatos + carátula al sistema
- Bandeja del sistema: controles, mostrar, salir; cerrar la ventana minimiza a bandeja
- Atajos globales: Ctrl+Alt+P/←/→/S/M; locales: Espacio, ←/→, M, **Ctrl+F** (buscar)
- **Atributos ARIA**: `aria-label` en todos los controles icon-only, `aria-pressed` en shuffle/repeat, label dinámico en play/pause
- Toasts, iconos SVG, editor de etiquetas con formulario
- **Logging estructurado con niveles** (`ENN_LOG=debug|warn|error`), incluida la ruta `dbg_log` desde la UI hacia los logs de Rust
- **ESLint** sobre `ui/app.js` (antes solo `node --check`), integrado en CI y en el checklist de `CONTRIBUTING.md`

## Visualizador (2026-11-09)

- Dos versiones a elegir en **Ajustes**:
  - **Traza**: monitor cardíaco que sube y baja con el tono, con latidos en los graves.
  - **Cinta**: cinta metálica sobre un infinito.
- Colores de la carátula que suena.
- En Simple va difuminado detrás de todo. En Studio va nítido y, tras 5 s sin actividad con música, ocupa la pantalla.
- Análisis en Rust con 90 ms de adelanto real: los golpes caen sincronizados.
- «Personalizar render»: perfiles, matriz de ruteo banda → destino con medidores en vivo, sensibilidad/ataque/liberación/curva/amplitud por banda, barrido al tempo (Traza), curva y estela (Cinta), resolución y frenado al pausar.
- Detalle en [[Visualizador - Cinta y Traza]].

## Persistencia

- Config dir (o `Enn Data` en modo portable con `Enn.portable`): biblioteca, settings (mezclador + paramétrico + exclusiva + RG), carpeta de descargas, playlists, caché de carátulas y waveforms
- localStorage: cola, modos, radio, historial, ganancias por pista
