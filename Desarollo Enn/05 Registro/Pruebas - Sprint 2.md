---
resumen: Prueba de aceptación del Sprint 2 (Descargas). Vista previa de 10 s por el motor, descargas en paralelo 2,55× más rápidas, yt-dlp que se actualiza solo y verificado, final animado y hallazgo n.º 3 cerrado. Pendiente: la vista previa en frío tarda más de 4 s.
estado: cerrado
actualizado: 2026-11-17
tags: [enn, beta, sprint, pruebas, descargas]
---

# Pruebas — Sprint 2

Diseño en [[Sprint 2 - Descargas]]; reparto en [[Sprint 2 - Tareas]].

## Cómo se midió

- **Automáticas**: `cargo test` (84 pruebas, 3 con red marcadas `#[ignore]` y ejecutadas a mano) y `npm test` (39 pruebas).
- **Con red**: `cargo test -- --ignored` prepara y corta un clip real y actualiza yt-dlp desde GitHub de verdad.
- **Descargas**: `scripts/bench-downloads.ps1`. Seis canciones reales con las mismas opciones de yt-dlp que usa Enn, primero de una en una y luego de tres en tres.
- **A mano**: versión *release* en el equipo del propietario, con su biblioteca y su salida de audio (FxSound). Se buscó «daft punk get lucky», se oyó una vista previa y se descargaron dos canciones, una con el panel cerrado.

## Resultados

| Medida | Resultado | Objetivo | ¿Cumple? |
|---|---|---|---|
| 6 canciones, de una en una frente a 3 a la vez | **62,1 s → 24,4 s (2,55×)**, 78,8 MB | ≥ 2,5× | ✅ |
| Clic → sonido, canción resuelta de antemano (los 3 primeros resultados y la pastilla bajo el ratón) | 158–222 ms hasta tener el clip, más 90 ms de la salida: **≈0,25–0,31 s** | < 0,3 s | ⚠️ en el límite |
| Clic → sonido en frío (sin resolver) | **4,3–6,1 s** (resolver con yt-dlp ≈3,2 s; arrancar yt-dlp 1,1 s) | < 4 s | ❌ |
| Repetir la vista previa de la misma canción | 0,2 ms (sale de la caché) | — | ✅ |
| Corte del clip con ffmpeg | 0,13–0,22 s, sin recodificar, 163 KB | — | ✅ |
| yt-dlp al día | En la app: **2026.08.19 → 2026.10.26** a los 30 s de abrir, con la suma SHA-256 comprobada y la copia nueva arrancando | Verificado | ✅ |
| Descarga que termina con el panel cerrado | Entró en la biblioteca (109 → 111 canciones) y avisó | Hallazgo n.º 3 | ✅ |
| Instancia única | Abrir la app otra vez trajo al frente la ventana abierta | — | ✅ |

## Pruebas automáticas nuevas

| Pieza | Qué se prueba |
|---|---|
| `preview.rs` | `pick_window`: con heatmap, sin él, 9 s, 14 s, 3 h, sin duración, directo; el pico del arranque no gana; nunca se sale del final. Lectura de lo que imprime yt-dlp, argumentos del corte (copia el M4A, convierte el resto) y caché de 60 MB que borra lo menos usado |
| Motor (`player.rs`) | La vista previa baja la canción (200 ms) y la pausa; vuelve sola a su posición exacta; entrada de 250 ms y salida de 600 ms; dos vistas previas seguidas dejan solo la última; ▶/⏸, ⏹ y una canción nueva la cortan; sin música queda en silencio; una canción en pausa sigue en pausa; el fin de la vista previa **no** salta a la siguiente canción |
| `downloader.rs` | Con trabajos simulados: nunca más de N a la vez; cancelar libera el hueco; un 429 baja a 1, espera 30 s → 1 → 2 → 4 → 5 min y se recupera de uno en uno; la cola en pausa conserva sus trabajos. Opciones de velocidad, líneas de conversión y de velocidad, la misma canción pedida dos veces se une a la primera |
| `tools.rs` | Suma correcta → sustituye (la anterior queda como `.old`); suma incorrecta → conserva la anterior y borra la descarga; lectura de `SHA2-256SUMS`; comparación de versiones; una búsqueda por semana; errores de yt-dlp desfasado |
| `ui/dl-anim.js` | El llenado de 0 a 100 dura al menos 600 ms; una descarga instantánea pasa por «finalizando» (900 ms) y termina con las acciones; la campanilla suena en el ✓; el botón pasa por sus cinco estados; error y cancelación cortan la secuencia; resumen de la barra superior |

## Fallos encontrados por el camino (corregidos)

- **El fin de una vista previa habría saltado a la siguiente canción**: `render_pull` avisaba «ended» desde cualquier tubería al agotarse el archivo. Ahora solo avisa la canción en curso.
- **Consolas negras**: yt-dlp se lanzaba sin `CREATE_NO_WINDOW`. Ahora las descargas corren sin ventana y con prioridad baja, así no le quitan CPU al audio.
- **Prueba de audio que fallaba a veces**: dos pruebas escribían el mismo WAV temporal a la vez.
- **El generador de WAV de las pruebas** declaraba la mitad del audio: un «2 s» duraba 1 s.
- **Doble campanilla** con el panel cerrado (la del aviso y la de la pastilla).
- **El resumen «1 descargando · 2,4 MB/s» empujaba los resultados** al aparecer y el clic caía en otra pastilla. Ahora va en la fila del formato.

## No verificado

- **El *feel* de las animaciones** (llenado, «finalizando», anillos): la lógica está probada, pero el panel del navegador de pruebas estaba oculto y congela las animaciones. Pendiente del ojo del propietario.
- **Reanudar la cola al abrir**, **disco lleno** y **limitación real de YouTube (429)**: probados con trabajos simulados, no provocados de verdad.
- Límite de velocidad y «Descargas a la vez» con valores distintos de los de fábrica: no probados en la app.
- **Conexión de uso medido** (preguntar antes de un lote de más de 10): no hecho. Windows lo expone por WinRT y necesita otra parte de la biblioteca `windows`.

## Pendiente que pasa a otros sprints

| Tema | Por qué | A dónde |
|---|---|---|
| Vista previa en frío > 4 s | Es lo que tarda yt-dlp en resolver. Opciones: resolver también los 10 primeros resultados o el álbum entero al abrirlo, o un cliente de YouTube más ligero. Cuesta más red y CPU al buscar | Pregunta al propietario |
| Conversiones de ffmpeg por el grupo de fondo (`jobs.rs`) | yt-dlp lanza su propio ffmpeg. Hoy hay como mucho 3 a la vez y a prioridad baja | Sprint 7 si hiciera falta |
| Conexión de uso medido | Ver arriba | Sprint 7 |
