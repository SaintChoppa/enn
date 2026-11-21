---
resumen: Evidencia del plan de la beta 0.2: mediciones hechas el 2026-11-15 sobre el código y con yt-dlp/APIs reales, comparación con Spotify, YouTube Music y Apple Music, y fuentes.
estado: vivo
actualizado: 2026-11-15
tags: [enn, beta, investigacion]
---

# Investigación — Beta 0.2

Respaldo de las decisiones del [[Plan maestro - Beta 0.2]]. Todo lo de «Medido» se ejecutó el 2026-11-15 en el equipo del propietario; lo de «Fuentes» viene de búsquedas web del mismo día.

## 1. Medido en el código y en la biblioteca

| Qué | Resultado | Consecuencia |
|---|---|---|
| Biblioteca real | 104 pistas (88 M4A, 16 FLAC), 1,3 GB | Los algoritmos deben funcionar con bibliotecas pequeñas (relajar reglas) |
| Género de las pistas | **104 de 104 dicen «Music»** (categoría de YouTube que incrusta yt-dlp) | El género actual no sirve: hay que rescatarlo de fuera (Sprint 3) |
| Etiqueta `comment` | Cada descarga guarda su URL de YouTube (`https://www.youtube.com/watch?v=…`) | Se conoce el id de YouTube de cada canción: sirve para la radio, el video y los datos |
| Contadores de escucha | `recordHistory` quita la entrada anterior de la misma ruta → cada canción aparece **una sola vez** en el historial; `playCountOf` vale 0 o 1 | Hoy **no existe** «más escuchadas» ni «qué suena después de qué». Hay que crear el almacén de escuchas (Sprint 3) |
| Arranque: `setup()` | ~~`set_exclusive(true)` abre el dispositivo dentro de `setup()`~~ **Corregido el 2026-11-16**: al arrancar solo guarda el ajuste; el dispositivo se abre en el primer ▶ | Afecta a la primera reproducción (con FxSound prueba todos los formatos exclusivos y falla), no al arranque |
| Arranque: ventana | `tauri.conf.json` no tiene `visible: false` ni `backgroundColor`; `decorations: false` | La ventana aparece vacía hasta que WebView2 pinta: se percibe lento |
| Arranque: JS | `init()` hace `await refreshDevices()` (enumera dispositivos, comando síncrono) **antes** de `reloadLibrary()` | La lista de canciones espera a algo que solo hace falta en Ajustes |
| Arranque: `lib_list` | Comando síncrono, hace `stat` de cada pista sin fecha y clona todo | A mover fuera del hilo de la ventana |
| Perfil de compilación | No hay `[profile.release]` (sin LTO, sin `codegen-units = 1`, sin `strip`) | Binario más grande y algo más lento de lo necesario |
| Recursos de la UI | `app.js` 205 KB, `styles.css` 135 KB, favicon de 282 KB (PNG de 1024 px), 4 fuentes woff2 (240 KB) | El favicon sobra; el resto es razonable |
| Visualizador | `powerPreference: "high-performance"` y `preserveDrawingBuffer: true`; se inicializa al cargar | Fuerza la GPU dedicada (más consumo) y compila shaders en el arranque |
| Sondeos | `get_state` cada 250 ms siempre; `get_spectrum` cada 60 ms al sonar; `download_list` cada 400 ms con el panel abierto | Pasar a eventos del motor y parar todo con la ventana oculta |
| Decodificación | `render_pull` (Symphonia) corre **dentro** de la llamada de audio en tiempo real | Con trabajos en paralelo hay riesgo de cortes: medir y, si hace falta, sacar la decodificación a su hilo |
| Paralelismo actual | `rayon` solo en el escaneo (`scan_into`, `probe_many`); el análisis de volumen va en **un** hilo, pista a pista | Margen claro para multinúcleo |
| Instancia única | No hay `tauri-plugin-single-instance` | Abrir Enn dos veces crea dos motores |
| Sidecars | `ffmpeg` pesa **103 MB**, `yt-dlp` 17,8 MB (versión 2026.08.19) | El instalador es grande; yt-dlp caduca cada pocas semanas |
| Git | 31 commits locales, **48 archivos sin commitear** | Riesgo para una beta: no hay puntos de vuelta atrás |

## 2. Medido con yt-dlp (el binario empaquetado)

| Prueba | Resultado |
|---|---|
| Arrancar yt-dlp (`--version`) | **1,06 s** (el ejecutable se desempaqueta en cada llamada) |
| Resolver metadatos de una canción (`-J`) | 3,2–4,4 s |
| Sacar la URL del audio (`-g`, formato 140) | 3,3 s |
| Cortar 10 s con ffmpeg desde esa URL (`-ss 60 -t 10 -c copy`) | **0,2 s** → clip de 163 KB |
| Clip de 10 s con `--download-sections` en una llamada | 3,8 s |

**Conclusión para la vista previa**: casi toda la espera (≈3,3 s) es yt-dlp resolviendo; el corte es instantáneo. Hay que resolver **antes** del clic (los 3 primeros resultados y al pasar el ratón) y cachear.

**«Lo más reproducido» (heatmap de YouTube)** — campo `heatmap` del JSON de yt-dlp:

| Canción | Vistas | Heatmap |
|---|---|---|
| Video oficial (189 s) | 1,03 M | **Sí**: 100 tramos. El primero (0–2 s) siempre marca 1,0 (sesgo de inicio); el siguiente pico real está en 38–42 s |
| Pista «Topic» (14 s) | 327 | **No** |

**Conclusión**: el heatmap sirve para elegir «la mejor parte» cuando existe, ignorando el arranque; si no existe, se usa la regla del 38 % de la duración. En la biblioteca hay una canción de **14 s**: el caso «canción muy corta» es real.

**Tamaños reales de video (solo video, sin audio), canción de 189 s**:

| Calidad | AV1 | VP9 | H.264 |
|---|---|---|---|
| 240p | **2,0 MB** | 2,3 MB | 3,3 MB |
| 360p | **4,2 MB** | 5,5 MB | 6,3 MB |
| 480p | **7,4 MB** | 8,7 MB | 10,9 MB |
| 720p | 13,2 MB | 17,1 MB | 20,8 MB |

El audio M4A de esa canción pesa 3,1 MB. Un video 360p AV1 añade ≈1,3 MB por minuto.

**Pista «Topic» (sin video real)**: su flujo de video a 360p va a **57 kbps** (imagen fija), frente a 176 kbps del video oficial. Trae `track/artist/album` rellenos y la descripción «Auto-generated by YouTube». Las etiquetas de YouTube del video oficial eran basura de posicionamiento («sleep music», «country music»): **no sirven como género**.

## 3. Medido con APIs (pista neutra: Daft Punk — Get Lucky)

| Servicio | Clave | Tiempo | Qué devuelve |
|---|---|---|---|
| YouTube Music `youtubei/v1/next` con `playlistId: RDAMVM<id>` | No | 0,9 s | **La radio real de YouTube Music**: 50 canciones relacionadas, con tipo (`MUSIC_VIDEO_TYPE_OMV` video oficial / `ATV` solo audio) y duración |
| Deezer `search` + `album/{id}` + `track/{id}` | No | 0,3 s | Géneros del álbum (Electro, Dance, Pop, Disco, Soul & Funk…), **BPM** (116,13), ganancia y clip de 30 s |
| iTunes Search | No | 0,5 s | Género principal («Pop»), fecha, clip de vista previa |
| MusicBrainz | No | — | Respondió «servidor ocupado»: no fiable como fuente principal |
| Last.fm `track.getTopTags` | Sí (gratis) | — | Etiquetas finas con peso (subgéneros y estados de ánimo). Términos: uso no comercial |

Notas: la búsqueda avanzada de Deezer (`artist:"…" track:"…"`) devolvió vacío; la búsqueda simple funciona. El «contraparte» canción↔video no vino en la respuesta de `next` probada: hay que buscar el video oficial por búsqueda (filtro de videos) y validar por duración.

## 4. Cómo lo hacen las mejores

| Tema | Spotify | YouTube Music | Apple Music | Decisión para Enn |
|---|---|---|---|---|
| Vista previa | Clips cortos elegidos por el sello; la música en curso se pausa | No tiene clic para previsualizar | Clips de 30–90 s | 10 s de la mejor parte (heatmap) o del 38 %; pausa suave de lo que suena y vuelta |
| Radio / continuidad | Autoplay y Smart Shuffle mezclan recomendaciones marcadas con ✨ | Radio por canción + «Afinador» (variedad de artistas, familiar↔descubrir, filtros de ánimo/BPM) | Estación por canción | Motor propio: hilo de géneros + radio de YTM + tus transiciones; con afinador |
| Video | Canvas: bucle vertical de 3–8 s; videos completos en algunos mercados | Cambio canción↔video en la misma posición | Portadas animadas | Video oficial completo sincronizado; si no hay, «portada viva» |
| Color al cambiar de canción | Fundido del fondo | Fundido | Degradado animado | Ola con origen según la causa del cambio |
| Arranque | Opción de abrir con el sistema, minimizado | — | — | Opción disponible, apagada por defecto |

## 5. Límites conocidos de la plataforma

- **WebView2 en frío**: Microsoft documenta que el primer arranque crea procesos y cachés y que la demora es inherente; recomienda no usar el webview como pantalla de carga. Por eso la ventana debe mostrarse con un color de fondo nativo y el motor no debe bloquear `setup()`.
- **AV1 en WebView2**: no se encontró confirmación oficial de que venga siempre de serie (Edge ha dependido de la extensión «AV1 Video Extension» de la Tienda). **Se comprobará en la máquina** con `mediaCapabilities.decodingInfo` y habrá escalera AV1 → VP9 → H.264.
- **View Transitions API**: en Chromium desde la versión 111 (WebView2 es Chromium). Patrón conocido: `document.startViewTransition()` y animar `clip-path`/máscara sobre `::view-transition-new(root)` tras `transition.ready`.
- **Destellos**: WCAG 2.3.1 pide no más de 3 destellos por segundo.
- **yt-dlp**: opciones útiles confirmadas en su documentación: `-N/--concurrent-fragments`, `--http-chunk-size` (ayuda con la limitación de velocidad), `--throttled-rate`, `--download-sections` (necesita ffmpeg).

## Fuentes

- YouTube Music, radio y afinador: [9to5Google (lanzamiento)](https://9to5google.com/2023/02/21/youtube-music-create-radio-launch/) · [RouteNote (Radio Builder)](https://routenote.com/blog/youtube-music-radio-builder/) · [Digital Music News](https://www.digitalmusicnews.com/2023/02/23/youtube-music-create-a-radio-feature/)
- Radio por canción y tipos de video en la API no oficial: [ytmusicapi · watch](https://ytmusicapi.readthedocs.io/en/latest/reference/watch.html) · [ytmusicapi · discusión sobre contraparte](https://github.com/sigma67/ytmusicapi/discussions/390)
- Spotify: [Shuffle y Smart Shuffle (soporte)](https://support.spotify.com/us/using_spotify/features/shuffle/) · [Smart Shuffle (TechCrunch)](https://techcrunch.com/2023/03/08/spotify-revamps-its-app-with-tiktok-style-discovery-feeds-smart-shuffle-for-playlists-and-more) · [Canvas (Spotify for Artists)](https://artists.spotify.com/canvas?cb=03715) · [Especificaciones de Canvas (artist.tools, tercero)](https://www.artist.tools/post/spotify-canvas-specifications-a-complete-guide)
- yt-dlp: [opciones de descarga](https://mintlify.com/yt-dlp/yt-dlp/cli/download-options) · [manual](https://dokk.org/manpages/debian/12/yt-dlp/yt-dlp.1.en)
- WebView2 y arranque: [Rendimiento de WebView2 (Microsoft)](https://learn.microsoft.com/microsoft-edge/webview2/concepts/performance) · [Arranque en frío de Tauri (DEV)](https://dev.to/tinyforge/tauri-cold-launch-was-1s-heres-how-i-got-it-to-feel-instant-32lh)
- View Transitions: [MDN · ViewTransition](https://developer.mozilla.org/docs/Web/API/ViewTransition) · [Chrome · mismo documento](https://developer.chrome.com/docs/web-platform/view-transitions/same-document?authuser=1) · [Cambio de tema a página completa](https://akashhamirwasia.pages.dev/blog/full-page-theme-toggle-animation-with-view-transitions-api)
- Etiquetas: [Last.fm · track.getTopTags](https://www.last.fm/api/show/track.getTopTags)
- Códecs en Windows: [AV1 en RDNA2 (Guru3D)](https://www.guru3d.com/news-story/amd-rdna2-gpus-also-will-support-av1-decode-hardware-acceleration.html) · [Extensión AV1 (Windows Report)](https://windowsreport.com/play-av1-files/)
