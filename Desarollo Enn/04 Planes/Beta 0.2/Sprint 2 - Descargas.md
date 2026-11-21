---
resumen: Sprint 2 de la beta 0.2. Vista previa de 10 s al pulsar una canción en Descargas, botón de descarga plata que sigue el color de la canción, descargas en paralelo a todo el ancho de banda y final de descarga animado.
estado: cerrado
actualizado: 2026-11-17
tags: [enn, beta, sprint, descargas]
---

# Sprint 2 — Descargas

Parte del [[Plan maestro - Beta 0.2]]. Evidencia en [[Investigación - Beta 0.2]]. Necesita el Sprint 1 (`BgPool`, fichas de movimiento).

**Objetivo**: escuchar antes de descargar, descargar lo más rápido que dé la conexión y que cada descarga termine con una animación clara, nunca de golpe.

## Preguntas de apertura

1. **Actualizar yt-dlp solo.** *Respuesta (2026-11-16): automático (ADR #167).* YouTube cambia a menudo y yt-dlp deja de funcionar hasta que se actualiza (la copia actual es de agosto). Propuesta: Enn descarga la versión nueva desde GitHub, comprueba su suma SHA-256 publicada y la guarda en su carpeta de datos; busca una vez por semana y cuando una descarga falla con un error conocido. Supone que la app descargue y ejecute un programa. ¿Automático, preguntando cada vez, o solo a mano desde Ajustes?

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Clic en una pastilla | Vista previa (antes descargaba). Descargar solo con su botón | Petición del propietario |
| Por dónde suena la vista previa | Por el motor de Enn, no por el navegador interno | Respeta el dispositivo elegido, la salida exclusiva y el volumen |
| Qué hace con la música | La baja en 200 ms y la pausa; al acabar la vista previa vuelve sola con fundido | Como los clips de Spotify |
| Duración | 10 s, con entrada de 250 ms y salida de 600 ms | Petición del propietario |
| Qué 10 s | La mejor ventana de «lo más reproducido»; si no hay datos, desde el 38 % | Medido (ver evidencia) |
| Volumen de la vista previa | −4 dB sobre el nivel normal | Los audios de YouTube vienen más altos que la biblioteca normalizada |
| Espera | Se resuelven de antemano los 3 primeros resultados y cualquier pastilla sobre la que el ratón pare 150 ms | Resolver tarda ≈3,3 s; cortar 0,2 s |
| Caché de clips | 60 MB (≈370 clips), se borran los menos usados | Un clip pesa 163 KB |
| Descargas simultáneas | Automático = 3; ajustable 1–6 | Decisión general |
| Fragmentos por descarga | 4, con trozos de 10 MB | Opciones de yt-dlp contra la limitación de velocidad |
| Avance de las descargas | Por eventos, no por sondeo cada 400 ms | Bajo consumo |

## Diseño

### Vista previa

**La ventana de 10 s** — función pura `pick_window(duracion, heatmap) -> (inicio, largo)` en `src-tauri/src/preview.rs`:

| Situación | Resultado |
|---|---|
| Hay heatmap | Se suaviza con una ventana deslizante de 10 s, se ignoran el primer y el último 8 % (el arranque siempre marca el máximo) y se elige la ventana con más suma |
| No hay heatmap | Inicio al 38 % de la duración |
| Duración ≤ 10 s | Toda la canción, desde 0 |
| Duración entre 10 y 20 s | 10 s centrados |
| Más de 15 minutos (mezclas) | Heatmap si existe; si no, al 20 % |
| Duración desconocida o directo | Desde 0; si es un directo, sin vista previa |

**Camino del sonido**:

1. `preview_prepare(id)` — una sola llamada a yt-dlp que imprime la URL del audio M4A, la duración y el heatmap. Se guarda 6 horas.
2. `pick_window` decide el tramo.
3. ffmpeg corta sin recodificar a `PreviewCache/<id>.m4a`.
4. `preview_start(id)` — orden nueva al motor: `EngineCmd::PreviewStart { dec, gain_db }`. Usa una tercera vía de reproducción; la canción en curso baja y se pausa conservando su posición.
5. Al terminar, o con `preview_stop`, la canción vuelve con un fundido de 300 ms si estaba sonando.

**En pantalla**: la carátula de la pastilla muestra un anillo de carga plateado mientras se prepara y un anillo que se vacía durante los 10 s. Pulsar otra pastilla hace un cruce de 150 ms a la nueva. Pulsar la misma la detiene. Con teclado: Espacio o Enter previsualiza, `D` descarga.

**En un álbum**: la fila sigue marcando la casilla con el clic; la vista previa se lanza desde el número de pista, que al pasar el ratón se convierte en ▶.

### Botón de descargar

`.pill-dl` pasa a ser una ficha plateada con el mismo material que «Buscar». En pausa o sin música es plata pura; con música toma el tinte de la canción en curso, como el resto de la interfaz. Estados: reposo, encima, pulsado (escala 0,97), descargando (se convierte en el anillo de avance) y hecho (✓).

### Todo el ancho de banda

- El trabajador único pasa a un **grupo de N trabajos** (`downloader.rs`): N = 3 por defecto.
- Cada yt-dlp con `--concurrent-fragments 4 --http-chunk-size 10M --throttled-rate 100K --retries 5 --fragment-retries 5 --socket-timeout 15`.
- Las conversiones de ffmpeg van por `BgPool`, como mucho núcleos − 1 a la vez.
- **Adaptación**: si aparecen errores 429 o 403 seguidos, baja a 1 trabajo y espera 30 s, 1 min, 2 min… hasta 5 min; cuando vuelven a ir bien, sube poco a poco.
- En Ajustes → Descargas: «Descargas a la vez» (Auto, 1–6) y «Limitar velocidad» (apagado por defecto).
- La barra superior muestra la velocidad total y cuántas quedan.

### Final animado

Estados de una descarga, todos con transición:

| Estado | Lo que se ve |
|---|---|
| En cola | Barras apagadas con un pulso lento |
| Resolviendo | Las barras laten de izquierda a derecha |
| Descargando | Se encienden según el avance real |
| Convirtiendo | Onda brillante que recorre las barras llenas (hoy este tramo no se ve) |
| **Finalizando** (≈900 ms) | Las barras suben a tope con rebote, se comprimen en una línea, la línea se cierra en un anillo, el ✓ se dibuja, la pastilla da un pulso plateado y suena la campanilla justo en el ✓ |
| Hecho | «▶ Escuchar» y «+ Cola» entran con rebote, uno tras otro (60 ms) |
| Error | Las barras se vacían, sacudida corta (2 veces, 6 px), botón «Reintentar» |
| Cancelada | Las barras caen y se desvanecen |

Regla de duración mínima: aunque la descarga real termine en 200 ms, el llenado dura al menos 600 ms.

Fuera del panel: el botón «Descargar» de la barra superior lleva un anillo de avance y un contador. Una descarga que termina con el panel cerrado entra igual en la biblioteca, suena y avisa (hallazgo n.º 3 de la auditoría).

### yt-dlp al día

`src-tauri/src/tools.rs`: copia de trabajo en la carpeta de datos; `tools_update()` descarga la versión estable, comprueba la suma SHA-256 del archivo `SHA2-256SUMS` de la publicación y solo entonces la sustituye. Si algo falla se sigue usando la anterior. La forma de dispararlo depende de la pregunta de apertura.

## Por si acaso

| Caso | Qué pasa |
|---|---|
| Canción de menos de 10 s (hay una de 14 s en la biblioteca) | Reglas de `pick_window` de arriba |
| Sin conexión | La pastilla dice «Sin vista previa sin conexión»; nada se queda cargando |
| El audio M4A no existe para ese video | Se toma el mejor audio y ffmpeg lo convierte (más lento; el anillo lo indica) |
| Video con restricción de edad, privado o de otra región | «Sin vista previa»; el botón de descarga explica el motivo al intentarlo |
| Cinco clics rápidos en cinco canciones | Solo suena la última; las preparaciones anteriores se cancelan (se mata el proceso entero) |
| Resolver tarda más de 6 s | Aviso discreto; a los 12 s se rinde y ofrece reintentar |
| Vista previa con salida exclusiva | Suena por el motor: funciona igual |
| No sonaba nada | Suena la vista previa y al acabar queda en silencio |
| El usuario pulsa ▶/⏸ o una tecla multimedia durante la vista previa | Se detiene la vista previa y se obedece la orden |
| Se cierra Descargas o se cambia de modo | La vista previa se apaga con fundido |
| Volumen de la app en 0 | Aviso «El volumen está en 0» |
| La canción que sonaba termina mientras estaba en pausa por la vista previa | No puede: está en pausa. Al volver, sigue donde estaba |
| Vista previa y descarga de la misma canción a la vez | Permitido |
| Descarga por enlace (no es YouTube) | Sin vista previa |
| Lista de 200 canciones | 3 a la vez; el resto en cola con su posición; «Cancelar todas» |
| Conexión de uso medido | Se pregunta antes de un lote de más de 10 |
| Disco lleno | Se detiene la cola con un aviso claro; los archivos a medias se borran (ya existe) |
| La misma canción pedida dos veces | La segunda se une a la primera |
| Se cierra Enn con descargas en marcha | Se cortan y se limpian los parciales (ya existe); al abrir se ofrece reanudar la cola |
| yt-dlp roto por un cambio de YouTube | Mensaje «Hay que actualizar el descargador» con el botón; ver pregunta de apertura |
| La actualización de yt-dlp se corrompe | La suma no coincide → se descarta y sigue la versión anterior |
| El servidor limita la velocidad | Adaptación automática y aviso |

## Prueba de aceptación

**Automáticas**
- `pick_window`: tabla de casos (con heatmap, sin él, 9 s, 14 s, 3 h, sin duración; el pico del arranque no gana).
- Motor: `PreviewStart` baja y pausa la canción, `PreviewStop` la devuelve a su posición exacta; dos vistas previas seguidas no dejan nada sonando por detrás.
- Grupo de descargas con trabajos simulados: nunca más de N a la vez, cancelar libera el hueco, los errores 429 bajan N y lo recuperan.
- `tools_update`: suma correcta → sustituye; suma incorrecta → conserva la anterior.
- Interfaz (`ui/tests/`): la secuencia «finalizando» dura al menos 600 ms y termina con las acciones visibles; el botón pasa por sus cinco estados.
- Prueba con red (marcada para no correr en la CI): preparar y cortar un clip real.

**Medidas**
- 6 canciones: tiempo total en serie frente a en paralelo (objetivo: al menos 2,5 veces más rápido si la conexión lo permite).
- Tiempo desde el clic hasta el sonido: < 0,3 s si estaba preparada; < 4 s si no.

**A mano**
- Vista previa con música sonando, sin música y con salida exclusiva; clics rápidos; cerrar el panel a mitad; descarga que termina con el panel cerrado.

## Hecho cuando

- [x] Pulsar una canción reproduce 10 s de su mejor parte y la música vuelve sola
- [x] El botón de descarga es plata y sigue el color de la canción
- [x] 3 descargas a la vez por defecto, con adaptación a la limitación
- [x] Ninguna descarga termina de golpe; el tramo de conversión se ve
- [x] yt-dlp se puede actualizar de forma verificada
- [x] Hallazgo n.º 3 de la auditoría cerrado
- [x] Resultados en [[Pruebas - Sprint 2]] (la vista previa en frío no llega al objetivo de < 4 s)
