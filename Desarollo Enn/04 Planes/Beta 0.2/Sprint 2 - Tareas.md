---
resumen: Reparto del Sprint 2 (Descargas) en tareas con prueba primero. Trabajo nativo en el chat, sin subagentes. yt-dlp se actualiza solo (respuesta del propietario).
estado: cerrado
actualizado: 2026-11-16
tags: [enn, beta, sprint, descargas, tareas]
---

# Sprint 2 — Tareas

Diseño en [[Sprint 2 - Descargas]]. Resultados en `05 Registro/Pruebas - Sprint 2.md`.

## Respuesta de apertura (2026-11-16)

**yt-dlp se actualiza solo.** Enn busca una vez por semana y cuando una descarga falla con un error conocido; instala la versión nueva solo si su suma SHA-256 coincide con la publicada. Si algo falla, sigue con la anterior.

## Reglas

- Sin commits. Puntos de vuelta: `.snapshots/sprint-2-inicio-2026-11-16.zip` y el de fin.
- Cada tarea empieza por su prueba (que falla) y termina con las puertas: `npm run lint`, `npm test`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`.
- Decisiones generales: como Spotify o YouTube Music, anotadas en el registro de decisiones.

## Tareas

| # | Tarea | Archivos | Prueba primero |
|---|---|---|---|
| T1 | **Ventana de 10 s**: `pick_window(dur, heatmap)` y lectura del heatmap de yt-dlp | `preview.rs` (nuevo) | Tabla de casos: con heatmap, sin él, 9 s, 14 s, 3 h, sin duración, el pico del arranque no gana |
| T2 | **Vía de vista previa en el motor**: `PreviewStart`/`PreviewStop`, la música baja en 200 ms y se pausa, vuelve con fundido de 300 ms; la vista previa entra en 250 ms y sale en 600 ms; no avisa «ended» | `player.rs` | Baja y pausa; vuelve a la posición exacta; dos seguidas no dejan nada sonando; sin música queda en silencio |
| T3 | **Preparar y cortar**: una llamada a yt-dlp (URL del audio, duración, heatmap; 6 h de caché), corte sin recodificar con ffmpeg, caché de 60 MB que borra lo menos usado, cancelación (solo suena la última) | `preview.rs`, `lib.rs` | Caché: borra lo menos usado al pasar de 60 MB; argumentos del corte; prueba con red marcada `#[ignore]` |
| T4 | **Descargas en paralelo**: grupo de N trabajos (Auto = 3, 1–6), adaptación a 429/403 (baja a 1, espera 30 s → 5 min, sube poco a poco), opciones de fragmentos, estado «convirtiendo» visible, velocidad, misma canción pedida dos veces se une, eventos en vez de sondeo | `downloader.rs`, `lib.rs` | Con trabajos simulados: nunca más de N, cancelar libera el hueco, los 429 bajan N y lo recuperan; lectura de líneas de conversión y velocidad |
| T5 | **yt-dlp al día**: `tools_update()` descarga la versión estable, comprueba `SHA2-256SUMS` y solo entonces la sustituye; copia de trabajo en la carpeta de datos; semanal y tras un error conocido | `tools.rs` (nuevo), `downloader.rs`, `lib.rs`, `Cargo.toml` (`sha2`) | Suma correcta → sustituye; incorrecta → conserva la anterior; «toca buscar» cada 7 días |
| T6 | **Interfaz de Descargas**: clic = vista previa (anillos de carga y de tiempo, cruce de 150 ms, Espacio/Enter y `D`), número de pista ▶ en álbumes, botón plata que sigue el color de la canción, estados animados (en cola → resolviendo → descargando → convirtiendo → finalizando ≈900 ms → hecho / error / cancelada), duración mínima de 600 ms, anillo y contador en el botón de la barra superior, Ajustes (descargas a la vez, limitar velocidad) | `search.js`, `app.js`, `styles.css`, `index.html`, `ui/dl-anim.js` (nuevo) | `ui/tests/`: la secuencia «finalizando» dura ≥ 600 ms y acaba con las acciones visibles; el botón pasa por sus cinco estados |
| T7 | **Hallazgo n.º 3**: una descarga que termina con el panel cerrado entra en la biblioteca y avisa | `app.js` | Por eventos: sin el panel abierto, el evento de fin refresca la biblioteca |
| T8 | **Medidas y cierre**: 6 canciones en serie frente a en paralelo; clic → sonido; pruebas a mano; vault | `05 Registro/`, `02 Técnica/` | — |

## Estado (2026-11-17)

Todas hechas y con sus pruebas: T1–T7 completas y T8 medida. Resultados en [[Pruebas - Sprint 2]].

## Decisiones de la ejecución

- **Sin ffmpeg por el grupo de fondo**: yt-dlp lanza su propio ffmpeg. Con 3 a la vez y prioridad baja no hace falta; queda apuntado.
- **Pulsar el anillo de una descarga en marcha la cancela** (con ✕ al pasar el ratón), como el botón de descarga de Spotify.
- **El resumen de las descargas va en la fila del formato**: debajo de la barra empujaba los resultados y el clic caía en otra pastilla.
- **Conexión de uso medido**: no se hizo; pasa al Sprint 7.

## Por si acaso propios de la ejecución

| Caso | Qué se hace |
|---|---|
| La vista previa pasa por el ecualizador | No: el ecualizador guarda estado por señal y mezclar dos señales por él a la vez da chasquidos durante el cruce. Se oye sin ecualizar (como un clip de Spotify) |
| `render_pull` avisaba «ended» desde cualquier tubería al agotarse el archivo | Solo la tubería 0 avisa; si no, el fin de la vista previa saltaría a la siguiente canción |
