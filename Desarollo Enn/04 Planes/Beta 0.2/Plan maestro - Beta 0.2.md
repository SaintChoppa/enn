---
resumen: Plan de desarrollo de la beta 0.2 en 7 sprints (rendimiento, descargas, algoritmo, movimiento, personalización, video de fondo, lanzamiento). Decisiones generales al estilo Spotify/YouTube Music; las preguntas importantes van al inicio de cada sprint.
estado: propuesto
actualizado: 2026-11-15
tags: [enn, beta, plan]
---

# Plan maestro — Beta 0.2

> [!info] Cómo leer esto
> Esta nota es el mapa. Cada sprint tiene su nota con el diseño, los «por si acaso», las pruebas y **sus preguntas de apertura**. La evidencia (mediciones y fuentes) está en [[Investigación - Beta 0.2]].
> Al empezar un sprint se lee **solo** su nota, se responden sus preguntas y se escribe el plan de tareas detallado (pruebas primero).

## 1. El alma: altísima calidad y bajo consumo

Todo lo de este plan se decide con dos preguntas: **¿se siente mejor que en las apps grandes?** y **¿cuánto cuesta en CPU, GPU, memoria, disco y red?** Si algo no pasa las dos, no entra.

**Presupuestos** (se miden en cada sprint con la versión *release*, no con `tauri dev`; la línea base se toma el primer día del Sprint 1 y los objetivos se ajustan con ella):

| Recurso | Objetivo |
|---|---|
| Arranque en frío: ventana visible | ≤ 0,4 s desde el clic |
| Arranque en frío: se puede usar (lista pintada, ▶ responde) | ≤ 1,2 s |
| Reabrir desde la bandeja | instantáneo (< 0,1 s) |
| CPU en reposo (ventana visible, sin sonar) | < 0,5 % |
| CPU sonando en Simple con visualizador | ≤ 4 % de un núcleo |
| Sobrecoste del video de fondo | ≤ +3 % CPU y ≤ +8 % GPU a 1080p |
| Ventana oculta en la bandeja | 0 sondeos de interfaz; solo el motor |
| Memoria total (con los procesos de WebView2) | ≤ 200 MB sin video, ≤ 280 MB con video |
| Animaciones | 60 fps; solo `transform`, `opacity`, `clip-path` y máscaras; ninguna tarea > 50 ms durante una transición |
| Disco por canción con video | ≤ 5 MB de media (360p AV1) y tope total configurable |
| Red | Nada sale sin una función declarada y con interruptor; sin cuentas ni telemetría |
| Audio | 0 cortes con todos los núcleos ocupados por trabajos de fondo |

## 2. Cómo se trabaja

1. **Preguntas solo de lo importante, y al abrir cada sprint.** Las decisiones generales se toman como lo hacen Spotify o YouTube Music y quedan escritas en la tabla de decisiones de cada sprint (el propietario puede corregir cualquiera).
2. **Pruebas primero.** La lógica nueva nace con su prueba (`cargo test` en Rust; `node --test` para los módulos de la interfaz, que se añade en el Sprint 1).
3. **Cada sprint termina con una prueba de aceptación** escrita en `05 Registro/Pruebas - Sprint N.md`: qué se probó, con qué números y qué quedó sin verificar.
4. **Puertas de siempre**: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `npm run lint`, `node --check`, y desde el Sprint 1 `npm test` y el banco de arranque.
5. **Bóveda**: cada cambio con fecha en [[Registro de cambios]], cada decisión como ADR, cada tarea en el [[Kanban - Enn]].
6. **Git**: sin commits hasta que el propietario lo diga (confirmado el 2026-11-16). Los puntos de vuelta atrás son copias fechadas del código en `.snapshots/`, al empezar y al cerrar cada sprint.

## 3. Los sprints

| # | Sprint | Qué entrega | Tamaño | Depende de |
|---|---|---|---|---|
| 1 | [[Sprint 1 - Cimientos y rendimiento]] | Arranque rápido, multinúcleo, base de preferencias, base de movimiento, pruebas de interfaz, medición | Grande | — |
| 2 | [[Sprint 2 - Descargas]] | Vista previa de 10 s, botón plata, descargas en paralelo a todo el ancho de banda, final animado | Grande | 1 |
| 3 | [[Sprint 3 - Algoritmo y recomendaciones]] | Géneros y etiquetas reales, radio que sigue el hilo, menú de recomendaciones | Grande | 1 |
| 4 | [[Sprint 4 - Movimiento]] | Animación elástica en toda la app, nada instantáneo, ola de color, transición Simple ↔ Studio nueva | Media | 1 |
| 5 | [[Sprint 5 - Personalización]] | Botón y panel de personalización, destello de bordes en los picos | Media | 1, 4 (y 3 para el afinador) |
| 6 | [[Sprint 6 - Video de fondo]] | Video de cada canción, comprimido, sincronizado, nítido en reposo y borroso fuera | Muy grande | 1, 2, 3, 5 |
| 7 | [[Sprint 7 - Beta]] | Estabilización, auditoría pendiente, instalador, firma, actualizaciones, lanzamiento | Grande | todos |

**Por qué este orden.** El rendimiento va primero porque el video, el paralelismo y las animaciones se apoyan en él y porque es lo que más se nota al abrir la app. Descargas y algoritmo son independientes entre sí (podrían intercambiarse). El movimiento va antes de la personalización porque el panel usa sus piezas. El video va el último de las funciones porque es lo más arriesgado y necesita las descargas en paralelo, las preferencias y el presupuesto de rendimiento ya medidos.

## 4. Lo pedido → dónde se hace

| Petición del propietario | Sprint |
|---|---|
| Clic en una canción de Descargas = vista previa de ~10 s de la mejor parte | 2 |
| Botón de descargar plata que cambia con la canción actual | 2 |
| Radio que sigue géneros y artistas como YouTube Music, sin saltos de rock a rap | 3 |
| Rescatar género y etiquetas de las canciones | 3 |
| Menú de recomendaciones abajo a la derecha (1.ª escucha y cada 3.ª) | 3 |
| La app abre muy lento | 1 |
| Soporte multinúcleo, procesar en paralelo | 1 |
| Usar todo el internet posible en las descargas | 2 |
| Animaciones elásticas en casi toda la app | 4 (base en 1) |
| Ningún proceso instantáneo; el final de una descarga, animado | 2 (descargas) y 4 (resto) |
| Cambio de color global en olas con origen variable | 4 |
| Mejor transición Simple ↔ Studio | 4 |
| Botón de personalización arriba a la derecha en Simple | 5 |
| Destello en los bordes con los picos (solo Simple, plata y adaptativo) | 5 |
| Video de la canción de fondo, comprimido, con fundido, borrado junto con la canción | 6 |
| Prepararse para el lanzamiento beta | 7 |
| Hallazgos de la [[Auditoría de interfaz 2026-11-13]] | 1 (n.º 1 y 8), 2 (n.º 3), 4 (n.º 2), 7 (n.º 4–7) |

## 5. Decisiones generales ya tomadas

Siguen lo que hacen Spotify o YouTube Music cuando existe referencia; si no, lo que mejor sirve al alma de la app. Cada una se convierte en ADR al implementarse.

| Tema | Decisión | Referencia |
|---|---|---|
| Vista previa | Pausa suave de lo que suena, 10 s, y vuelve sola a la música | Spotify pausa la música durante sus clips |
| Mejor parte | «Lo más reproducido» de YouTube si existe; si no, desde el 38 % de la canción | Medido: el heatmap existe en videos con muchas vistas |
| Descargas a la vez | 3 en paralelo, cada una con 4 fragmentos simultáneos; se reduce sola si el servidor limita | Las apps de streaming descargan varias pistas a la vez |
| Radio | Hilo de géneros (tu propuesta) + radio real de YouTube Music + tus propias transiciones; nunca el mismo artista dos veces seguidas | Radio y «Afinador» de YouTube Music |
| Recomendaciones | Tarjeta discreta que se va sola; nunca roba el foco | «A continuación» y «Relacionado» de YouTube Music |
| Datos en línea | Solo metadatos (artista + título o id de YouTube), sin cuenta, con interruptor y lista de servicios a la vista | Principio de Enn: sin telemetría |
| Video | Video oficial completo, sincronizado si dura lo mismo; si no hay video, «portada viva» | Cambio canción↔video de YouTube Music; Canvas/portada de Spotify |
| Calidad del video | 360p, el códec que la máquina decodifique con menos energía (AV1 → VP9 → H.264) | Medido: 4,2 MB por canción en AV1 |
| Abrir con Windows | Opción disponible, apagada por defecto | Spotify la ofrece (minimizado) |
| Movimiento | Elástico y con rebote, pero nunca retrasa la acción: el sonido responde al instante y la imagen lo sigue | Criterio de diseño (Emil Kowalski, Apple) |
| Seguridad de los destellos | Máximo 3 por segundo y brillo limitado | WCAG 2.3.1 |
| Actualizaciones | Descarga silenciosa y aviso «Reiniciar para actualizar»; nunca corta la música | Spotify |

## 6. «Por si acaso» que valen para todo

| Riesgo | Medida |
|---|---|
| YouTube cambia y yt-dlp deja de funcionar (pasa cada pocas semanas) | Actualizador de yt-dlp verificado con suma SHA-256 (Sprint 2); mensajes claros; la app sigue reproduciendo lo local |
| Un servicio externo cae o cambia (Deezer, iTunes, YouTube Music) | Todo enriquecimiento es opcional, con caché y caducidad; sin red la app se comporta igual que hoy |
| Archivo de datos corrupto o corte de luz al guardar | Escritura atómica (temporal + renombrar) y copia de seguridad antes de cada migración |
| Trabajos de fondo que cortan el audio | Hilo de audio con prioridad de tiempo real (MMCSS), trabajos en prioridad baja, contador de cortes y prueba de carga |
| Portátil con batería | Modo ahorro: un solo hilo de fondo, sin video, sin análisis masivo |
| Disco lleno | Las descargas y los videos se detienen con aviso; nunca se corrompe la biblioteca |
| Conexión de uso medido | Se pregunta antes de descargar videos o lotes grandes |
| Dos Enn abiertos a la vez | Instancia única: la segunda enfoca la primera (Sprint 1) |
| PC suspendido, auriculares desconectados, dispositivo que cae | El motor suelta el dispositivo y lo reabre (ya corregido el 2026-11-13); se añade pausar al desconectar la salida, como Spotify |
| Bibliotecas enormes (10 000+) | Biblioteca sintética de prueba; listas virtualizadas; nada recorre toda la biblioteca cada 250 ms |
| Rutas largas, con emoji o en otros alfabetos | Casos de prueba fijos (ya hubo un fallo con cirílico) |
| GPU débil o sin decodificación por hardware | Sonda de capacidad y degradación automática: sin video → sin olas → animación mínima |
| Sensibilidad al movimiento o a los destellos | Niveles de animación, respeto a «reducir movimiento» del sistema, limitador de destellos |
| Riesgo legal al distribuir un descargador de YouTube | Aviso de uso responsable, funciones de descarga iniciadas por el usuario, plan B de distribución (Sprint 7) |

## 7. Piezas compartidas (contratos entre sprints)

Para que un sprint no rompa a otro, estos nombres quedan fijados aquí.

| Pieza | Dónde | Nace en | La usan |
|---|---|---|---|
| `BgPool` — trabajos de fondo en paralelo y prioridad baja | `src-tauri/src/jobs.rs` | 1 | 2, 3, 6 |
| `perf` — marcas de tiempo del arranque y contador de cortes de audio | `src-tauri/src/perf.rs`, `ui/perf.js` | 1 | todos |
| `prefs` — preferencias con esquema, validación y migración; se guardan en `settings.json` | `ui/prefs.js` + comandos `prefs_get` / `prefs_set` | 1 | 3, 4, 5, 6 |
| Fichas de movimiento (`--spring-snappy`, `--spring-bouncy`, `--spring-elastic`) y `motion.js` | `ui/motion.css`, `ui/motion.js` | 1 | 2, 4, 5, 6 |
| Pruebas de interfaz con `node --test` | `ui/tests/` | 1 | todos |
| `insights` — por canción: id de YouTube, etiquetas, BPM, energía, escuchas, saltos, transiciones, video | `src-tauri/src/insights.rs` → `insights.json` | 3 | 5, 6 |
| `preview` — ventana de 10 s y clip | `src-tauri/src/preview.rs`, `ui/preview.js` | 2 | — |
| `radio` — elección de la siguiente canción | `src-tauri/src/radio.rs` | 3 | — |
| `wave` — ola de color | `ui/wave.js` | 4 | 6 |
| `bgvideo` — capa de video | `src-tauri/src/video.rs`, `ui/bgvideo.js` | 6 | — |

Nota: `insights` nace en el Sprint 3 y el Sprint 6 lo necesita (guarda qué video tiene cada canción). Si el orden de los sprints cambia, esa pieza va primero.

## 8. Skills por sprint

Se cargan al empezar cada sprint; así se usa todo lo disponible sin gastar contexto antes de tiempo.

| Sprint | Skills |
|---|---|
| Plan (hecho) | `brainstorming`, `writing-plans`, `tauri-v2`, `emil-design-eng`, `audio-reactive` |
| 1 | `writing-plans`, `test-driven-development`, `systematic-debugging`, `tauri-v2`, `rust-best-practices`, `verification-before-completion` |
| 2 | `tauri-v2`, `ffmpeg`, `audio-dsp`, `animate`, `emil-design-eng`, `test-driven-development` |
| 3 | `rust-best-practices`, `test-driven-development`, `design:ux-copy`, `impeccable` |
| 4 | `find-animation-opportunities`, `improve-animations`, `animate`, `emil-design-eng`, `apple-design`, `animation-vocabulary` |
| 5 | `impeccable`, `audio-reactive`, `design:accessibility-review`, `design:ux-copy` |
| 6 | `ffmpeg`, `video-editing`, `tauri-v2`, `audio-reactive`, `rust-best-practices` |
| 7 | `code-review`, `security-review`, `requesting-code-review`, `design:accessibility-review`, `finishing-a-development-branch`, `humanizer` |
| Siempre | `obsidian-markdown` para la bóveda |

## 9. Qué significa «lista para beta»

La beta sale cuando, con la versión instalable:

- Los presupuestos de la sección 1 se cumplen y están medidos.
- No queda ningún fallo alto conocido y los hallazgos de la auditoría están cerrados o aceptados.
- Todas las puertas automáticas pasan en la CI.
- Una sesión de 8 horas sonando no pierde memoria (deriva < 10 MB) ni corta el audio.
- Instalar encima de la 0.1 conserva biblioteca, ajustes y playlists.
- El propietario la usa una semana y da el visto bueno.

El detalle está en [[Sprint 7 - Beta]].

## 10. Interpretaciones que conviene confirmar

No bloquean el plan; se preguntan al abrir el sprint que tocan.

- «o migre» (video): se entiende como *cuando la canción cambia* y también como *al traer la biblioteca que ya existe*. El Sprint 6 cubre las dos.
- «la tercera vez cuando esta se repite/escuche» (recomendaciones): se entiende como *la primera escucha y después cada tercera* (3.ª, 6.ª, 9.ª…), más el tercer ciclo seguido en «repetir una».
- «un logo cuadrado con bordes circulares»: el logo de Enn dentro de un cuadrado de esquinas redondeadas.
