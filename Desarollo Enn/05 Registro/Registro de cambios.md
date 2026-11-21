---
resumen: Diario fechado de TODOS los cambios (código, bóveda, git), el más reciente arriba. Una línea por cambio.
estado: vivo
actualizado: 2026-11-12
tags: [enn, registro, changelog]
---

# Registro de cambios

**Regla**: cada cambio que se haga en el proyecto añade aquí una línea con su fecha, **arriba del todo**. El formato es `- [área] qué cambió → dónde (commit o «sin commitear»)`. Las áreas son `audio`, `ui`, `motor`, `build`, `ci`, `docs`, `bóveda` y `git`. El detalle largo va en la nota del tema y aquí solo el enlace.

## 2026-11-21

- [ui] **Sprint 4, T8: medidas y cierre** → [[Pruebas - Sprint 4]]. En Enn real a 1366×768: ola de color con percentil 95 de 5,1 ms; cambio de modo en 466–485 ms con percentil 95 de 5,1–10,1 ms; una tarea larga de 71–93 ms solo en la primera entrada a Studio de cada sesión (pendiente). Memoria privada en reposo 266–268 MB (antes del sprint, 261); tras 11 idas y vueltas 313–325 MB (antes, 294), en cachés nativas del navegador: el montón de JavaScript y los nodos no crecen. Para medir, Enn deja en el registro de depuración una línea por cada uno de los 10 primeros cambios de modo de la sesión (`MODE #n`) y las olas cuentan sus tareas largas. Dos arreglos: **← → en el selector Simple/Studio ya no cambian también de canción** (el atajo global no miraba si un control había usado la tecla; venía de antes), y **con crossfade la canción nueva cuenta como empezada** (escuchas, historial, tarjeta de recomendación y radio; tarjeta del tablero que venía del Sprint 3). Este último no se pudo ver en marcha: con la salida exclusiva el motor no llegó a encadenar la pista cebada (pendiente aparte). 86 pruebas de interfaz en verde. Sin commitear.
- [ui] **Sprint 4, T7: Mínimas y «reducir movimiento» sin desplazamientos y sin cortes** → [[Sprint 4 - Tareas]]. Antes las animaciones se cortaban a 1 ms y los bloques de «reducir movimiento» de `styles.css` solo valían para la opción de Windows, no para el nivel Mínimas de Ajustes. Ahora los dos son lo mismo: `motion.js` marca `data-still` en la raíz (`syncStill`, que también sigue el cambio de la opción de Windows con Enn abierto); `spring()` deja solo el fundido (300 ms, sin rebote ni escalonado; lo que solo se movía no se anima); las transiciones CSS dejan de animar `transform` y tamaños; las animaciones de entrada multiplican su movimiento por `--mk` (0 en Mínimas), así que quedan en fundido en vez de desaparecer; los paneles de Simple, el diálogo de Ajustes, el menú contextual y la ventana emergente se funden al cerrar (antes, con «reducir movimiento», se cerraban de golpe). Las constantes `REDUCE_MOTION`, que solo miraban Windows al arrancar, desaparecen. Una prueba nueva revisa `styles.css`: toda animación que mueve algo debe escalar con `--mk` (salvo los indicadores de estado: giros, barras de progreso y la cuenta atrás de la tarjeta de recomendación). Comprobado en el navegador de pruebas: en Mínimas, al cambiar de modo y abrir y cerrar paneles, todas las animaciones son fundidos. 86 pruebas de interfaz en verde. Sin commitear.
- [ui] **Sprint 4, T6: Simple ↔ Studio nuevo** (`ui/modeswitch.js`) → [[Sprint 4 - Tareas]]. El cambio de modo va dentro de una View Transition: 13 piezas compartidas (carátula, título, artista, botonera, barra, volumen, cola, ecualizador, panel de pistas, descargas, columna derecha, fila del ecualizador, telemetría) viajan y cambian de tamaño hasta su sitio, las de Studio entran escalonadas por su lado y salen por donde entraron, y el fondo hace un zoom leve (1,04 → 1). Pulsar el otro modo a mitad invierte desde donde esté; con teclado, la ventana oculta o sin View Transitions el cambio es instantáneo; en Mínimas, fundido de 300 ms. Tope de 900 ms: el modo cambia siempre. **Cierra el hallazgo n.º 2** de la [[Auditoría de interfaz 2026-11-13]] (`leaveStudio` y `modeAnimating` eliminados). Medido en el navegador de pruebas a 1366×768: 493 ms la ida; invertida a los 200 ms, de vuelta a los 382 ms sin pasar por Studio; 20 idas y vueltas con los mismos 1075 nodos y ningún nombre de transición suelto. Durante un cambio de modo no hay ola de color (solo el fundido). **Arreglo de paso para la ola (T5)**: en Enn real (WebView2, Chrome 156) todo clic durante una View Transition iba a `<html>`, aunque `::view-transition` tenga `pointer-events: none`, así que un segundo ⏭ en el segundo que dura la ola se perdía. Ahora, un clic durante una transición la termina en el acto y se reenvía a lo que hay debajo; sobre el otro botón de modo, a mitad de un cambio, la invierte. Comprobado en Enn real: invertir con el ratón, minimizar a mitad en los dos sentidos (ya no se queda colgado) y dos ⏭ dentro de la misma ola. 79 pruebas de interfaz en verde. Sin commitear.
- [ui] **Sprint 4, T5: ola de color al cambiar de canción** (`ui/wave.js`) → [[Sprint 4 - Tareas]]. El cambio de paleta va dentro de una View Transition y la paleta nueva se revela con una máscara circular de borde suave desde un origen según la causa: ⏭ desde la derecha, ⏮ desde la izquierda, un clic desde su punto, la radio desde su botón, las recomendaciones desde abajo a la derecha, «Escuchar» de Descargas desde la pastilla, el final de una canción desde la carátula; en pausa el color se retira hacia la carátula. Una ola nueva salta la anterior; con menos de 300 ms entre cambios, mismo color, ventana oculta, modo mini, nivel Mínimas o sin View Transitions, solo fundido. Con «reducir movimiento» el color ya no salta: se funde en 300 ms. Medido en la app real (5 olas): media 5,1 ms por fotograma, p95 5,1 ms, peor fotograma 25–30 ms (la captura inicial). Arreglado al probar: una ola inútil al arrancar. 67 pruebas de interfaz en verde. Sin commitear.
- [ui] **Sprint 4, T4: movimiento en listas y contenido** → [[Sprint 4 - Tareas]]. La cola recoloca sus filas con FLIP (la que se quita se encoge en su sitio mientras las demás suben; la nueva entra); al cambiar de pestaña de la biblioteca el contenido entra desde el lado de la pestaña; Filas ↔ Cuadrícula ↔ Compacta hace viajar cada carátula visible (máx. 40) a su sitio nuevo; la biblioteca entra escalonada (40 ms, solo lo visible) la primera vez que se ve; los resultados de búsqueda usan el muelle del carácter; la carátula y el título de Reproduciendo se funden al cambiar; la ventana entra con fundido y escala 0,985. Visto en la app real: cola y cambio de vista. 57 pruebas de interfaz en verde. Sin commitear.
- [ui] **Sprint 4, T3: movimiento en los controles** → [[Sprint 4 - Tareas]], [[Inventario de movimiento]]. ▶/⏸ se transforma (120 ms); la estrella de favorito cambia al instante y salta (antes esperaba al motor); el menú contextual nace del punto del clic y sale en 110 ms; los desplegables nacen del borde de su botón con el muelle; Ajustes entra con muelle y el fondo se difumina a la vez; el afinador de la radio entra con muelle y sale en 120 ms; el aviso entra con muelle; los botones del transporte vuelven con el muelle del carácter; la bola de los deslizadores se aplasta al arrastrar; las casillas de Ajustes pasan a interruptores; el contador de descargas rueda. Toda salida tiene un tope de tiempo (`whenDone`), así que nada se queda a medias con la ventana oculta. 53 pruebas de interfaz en verde. Sin commitear.
- [ui] **Rebote «suave» por defecto**, elegido por el propietario en el laboratorio, y **configurable** en Ajustes → Interfaz: «Rebote» (Suave, Medio, Elástico) y «Animaciones» (Completas, Suaves, Mínimas), que se aplican al momento (ADR #179). 50 pruebas de interfaz en verde. Sin commitear.
- [ui] **Empieza el Sprint 4 (Movimiento)** → [[Sprint 4 - Tareas]]. Copia de seguridad en `.snapshots/sprint-4-inicio-2026-11-21.zip`. Respuesta de apertura: sin objetivo de memoria en este sprint («primero hagamos y luego pensamos en ahorrar»); las issues que Zaphkl no haga se trabajan igual. T1 hecha: tres caracteres de movimiento (suave, medio y elástico; rebote al soltar del 1,5 %, 12,6 % y 25 %) generados por `motion.js` en `motion.css`, que ahora sí se carga en la app; `--ease-spring` y `--t-release` pasan de `styles.css` a `motion.css`; «reducir movimiento» gana también sobre el nivel guardado. **Laboratorio de movimiento** (`ui/lab.html`, Ctrl+Alt+Mayús+M dentro de Enn) para elegir el carácter. T2 hecha: [[Inventario de movimiento]]. 50 pruebas de interfaz en verde. Sin commitear.
- [git] Seis issues en GitHub para que Zaphkl audite y pruebe lo de los sprints 1–3, elegidas por el propietario: [#1](https://github.com/SaintChoppa/enn/issues/1) memoria, [#2](https://github.com/SaintChoppa/enn/issues/2) sin conexión, [#3](https://github.com/SaintChoppa/enn/issues/3) animaciones de descarga, [#4](https://github.com/SaintChoppa/enn/issues/4) latencia de la vista previa, [#5](https://github.com/SaintChoppa/enn/issues/5) revisión de código, [#6](https://github.com/SaintChoppa/enn/issues/6) pendientes de la auditoría de interfaz. Etiquetas nuevas: `auditoría`, `pruebas`, `sprint-1`, `sprint-2` y `sprint-3`. Sin asignar: Zaphkl aún no ha aceptado la invitación.

## 2026-11-20

- [ci] **La CI de GitHub pasa por primera vez en Windows, Linux y macOS** (`2ff8f48`). Fallaba en los tres:
  - Faltaban los ejecutables de yt-dlp y ffmpeg que Tauri exige para compilar; ahora se crean archivos vacíos en su lugar (`2cd2532`).
  - El `cfg(windows)` de la salida exclusiva se había quedado encima de `mod enrich` desde el Sprint 3, así que `enrich` no existía fuera de Windows. Además había dos avisos de código sin usar fuera de Windows (`3cb0c87`).
  - Un aviso nuevo de clippy en Rust 1.100 (`fad4813`).
  - Una prueba de tiempos demasiado ajustada para la máquina de macOS (`835062f`).
- [git] A petición del propietario, todo lo local sube a GitHub (`SaintChoppa/enn`) en dos commits: el código de la beta 0.2 (sprints 1-3, `935187c`) y la bóveda (`eaf0d16`). Quedan fuera las carpetas de herramientas de IA (`.claude/`, `.agents/`, `skills-lock.json`), la disposición de ventanas de Obsidian y las notas vacías («Sin título…»), ahora en `.gitignore`. Se invita a **Zaphkl** como colaborador con permiso de escritura (pendiente de que acepte).

## 2026-11-17

- [radio] **Revisión del Sprint 3 contra su diseño** (a petición del propietario): faltaban 8 puntos y ya están hechos → [[Pruebas - Sprint 3]]. Reintento cada hora sin conexión, tarjeta fuera del modo mini, limpieza semanal segura, año real en todas las pistas, búsquedas dentro de la canción (cuenta lo escuchado), volumen y lo reciente en la radio, y ADR #178. Prueba primero: 130 pruebas en Rust y 45 en la interfaz, en verde. Visto en la app real después (años, tarjeta en la 3.ª escucha, modo mini, limpieza, búsquedas). Al probar apareció un fallo más (escucha falsa al volver a poner la misma canción), ya corregido. 131 pruebas en Rust y 45 en la interfaz. Sin commitear.

- [radio+ui] **Prueba en la app real** de lo que faltaba (a petición del propietario) → [[Pruebas - Sprint 3]]. Funcionan el rescate de etiquetas (102 de 112), la radio con motivo (también por vecinas de YouTube Music), la tarjeta de recomendaciones, el afinador, Ajustes y la descarga con vista previa. **8 fallos encontrados y corregidos**, entre ellos ▶ que no arrancaba la radio, «a continuación» que no sonaba con la radio puesta y escuchas partidas en dos claves. Sin commitear.

- [radio] **Sprint 3 cerrado** (en el chat, sin subagentes) → [[Pruebas - Sprint 3]].
  - **El 91 % de la biblioteca con etiquetas reales** (antes, todas «Music»): Deezer, iTunes, la radio de YouTube Music y propagación entre vecinas y artistas.
  - **Radio que sigue el hilo** de géneros y artistas y explica cada elección («Radio · Sigue el hilo: Reguetón → Trap»), con afinador (clic derecho en el botón de radio).
  - **Almacén de escuchas** (escuchas, saltos, transiciones), con el historial viejo migrado.
  - **Tarjeta «qué escuchar después»** en la 1.ª escucha y cada 3.ª.
  - Ajustes → Recomendaciones: datos en línea, propuestas, clave de Last.fm y estado de las etiquetas.
  - Nuevos: `taxonomy.rs` + `data/taxonomy.json`, `insights.rs`, `enrich.rs`, `features.rs`, `radio.rs`, `ui/reco.js` (ADR #172–#177).
  - Pendiente: tus 30 minutos de radio.
  - Sin commitear.
- [radio] Empieza el Sprint 3. Respuestas de apertura: datos en línea encendidos, sin Last.fm por ahora, menú en la 1.ª escucha y cada 3.ª (ADR #172). Copia de inicio en `.snapshots/sprint-3-inicio-2026-11-17.zip`.

- [descargas] **Sprint 2 cerrado** (en el chat, sin subagentes) → [[Pruebas - Sprint 2]].
  - **Vista previa de 10 s** al pulsar una canción en Descargas: suena por el motor, la música baja y vuelve sola.
  - **Descargas en paralelo**: 3 a la vez, con adaptación si YouTube limita; 2,55× más rápido medido.
  - **yt-dlp se actualiza solo** y verificado: en la app pasó de 2026.08.19 a 2026.10.26.
  - Botón de descargar plateado; descargas animadas que nunca terminan de golpe.
  - Aviso y biblioteca al día aunque el panel esté cerrado (hallazgo n.º 3).
  - En Ajustes: «A la vez», «Velocidad» y la versión del descargador.
  - Nuevos: `preview.rs`, `tools.rs`, `ui/dl-anim.js`, `scripts/bench-downloads.ps1` (ADR #167–#171).
  - Corregidos de paso: el fin de una vista previa habría saltado de canción, consolas negras de yt-dlp, una prueba de audio inestable.
  - Pendiente: la vista previa en frío tarda 4–6 s.
  - Sin commitear.

## 2026-11-16

- [descargas] Empieza el Sprint 2. El propietario responde la pregunta de apertura: **yt-dlp se actualiza solo** (ADR #167). Copia de inicio en `.snapshots/sprint-2-inicio-2026-11-16.zip`; tareas en [[Sprint 2 - Tareas]].

- [rendimiento] **Sprint 1 cerrado** (en el chat, sin subagentes) → [[Pruebas - Sprint 1]]. Arranque interactivo 1040 → ~650 ms; **CPU en reposo 62 % → ~0,5 %** (la paleta se reaplicaba 4 veces por segundo y mantenía el visualizador WebGL dibujando a 200 fps sin música); primer ▶ 1250 → 140 ms; 0 cortes de audio con todos los núcleos ocupados. Nuevos: `fsutil.rs` (guardado atómico, archivos dañados apartados), `jobs.rs` (grupo de hilos de fondo), modos `--bench-idle` y `--bench-play`, `scripts/bench-idle.ps1`, instancia única, «Abrir con Windows». Corregidos de paso: errores del motor perdidos, cola que podía no avanzar en la bandeja, `Cargo.toml` roto en Linux/macOS, auditoría n.º 1 y n.º 8 (ADR #163–#166). Pendiente: memoria (~490 MB). Sin commitear.
- [motor+ui] Sprint 1, ola 1 completa y revisada: medición del arranque (`perf.rs`, `ui/perf.js`, `--bench-startup`, `scripts/bench-startup.ps1`), `ui/prefs.js` (22 pruebas), `ui/motion.css`/`motion.js` (9 pruebas), `npm test` y CI en Node 22. cargo test 40/40, npm test 31/31. **Corrección**: el dispositivo de audio no se abre en `setup()` sino en el primer ▶. El propietario pide seguir sin subagentes (sin commitear).
- [proceso] Empieza el Sprint 1 de la beta 0.2. A petición del propietario, cada tarea la implementa un subagente (Opus si es difícil, Sonnet si está acotada) y Fable supervisa: encargo, revisión del diff, puertas y medición (ADR #162). Copia de inicio en `.snapshots/sprint-1-inicio-2026-11-16.zip`. Ola 1 en marcha: medición del arranque (Opus), `prefs.js` + `npm test` (Sonnet), fichas de movimiento (Sonnet) → [[Sprint 1 - Tareas]].
- [bóveda] Beta 0.2: el propietario responde la pregunta de apertura del Sprint 1: **sin commits todavía**. Los puntos de vuelta atrás serán copias fechadas del código en `.snapshots/` al empezar y cerrar cada sprint (ADR #161). Sin cambios de código.

## 2026-11-15

- [bóveda] Plan de la beta 0.2 en 7 sprints, con investigación y mediciones reales (yt-dlp, APIs de géneros, radio de YouTube Music, tamaños de video, ruta de arranque) → [[Plan maestro - Beta 0.2]] e [[Investigación - Beta 0.2]]. Sin cambios de código. Hallazgos: las 104 pistas tienen el género «Music»; no existen contadores de escucha; el motor de audio abre el dispositivo dentro de `setup()` y bloquea el arranque (ADR #160).

## 2026-11-13

- [ui] Descargas: selector de formato (M4A · MP3 · FLAC) encima de la barra de búsqueda, sincronizado con Ajustes → Descargas y recordado entre sesiones (antes volvía a M4A en cada arranque) (ADR #159). Verificado en el navegador (sin commitear). Los hallazgos de la [[Auditoría de interfaz 2026-11-13]] quedan apuntados para más adelante, a petición del propietario.
- [revisión] Auditoría de la interfaz: 2 hallazgos altos, 3 medios y 3 bajos, sin corregir hasta que decida el propietario → [[Auditoría de interfaz 2026-11-13]].
- [ui] Ecualizador grande: cifras de las bandas más grandes (12,5 px, seminegrita) sobre un fondo oscuro, que se apartan al aparecer la perilla; barra de sensibilidad de las barras (×0,5–×2, doble clic = ×1) abajo a la derecha (ADR #158). Botones de «Todas las pistas» en pastillas de solo iconos, como el selector de vista (ADR #157). Corregido el desborde de las bandas que esto había causado. Verificado en el navegador (sin commitear).
- [audio] **Corregido: no sonaba ninguna canción.** El dispositivo (FxSound) cayó sin nada sonando y el supervisor de reconexión lo ignoraba (`cur.is_none()` → `continue`); el stream muerto se quedaba y `play_path` mandaba las órdenes a un hilo de audio que ya no existía. Ahora se suelta y la siguiente canción reabre el dispositivo (`device_supervisor` en `player.rs`). Comprobado que vuelve a sonar; el caso del fallo no se pudo provocar a mano (sin commitear).
- [ui] Descargas sigue abierta al cambiar entre Simple y Studio y viaja a su sitio con un rebote suave (FLIP); antes se cerraba al pasar a Simple. Verificado en el navegador (sin commitear).
- [ui] Ecualizador grande (Studio): perilla de metal detrás de cada banda que aparece al moverla, gira con el valor (subir = sentido del reloj, ±135°) y sigue un poco a la bola; la línea pasa de plateada al color de la canción según se aparta del 0 (ADR #155). Verificado en el navegador (sin commitear).
- [ui] Espectro: barras con forma de lápiz (cuerpo y punta con la mina más clara), más sensibles (curva y subida rápida) y línea de puntos del pico con su medida en dB al final; se queda ~2 s y baja despacio (ADR #156). Verificado en el navegador (sin commitear).

## 2026-11-12

- [ui] Quitado el aleatorio por completo (botón de la botonera, aviso «MODO ALEATORIO ON» sobre la cola y su lógica): lo sustituye el modo radio (ADR #154). Verificado en el navegador: la botonera queda ⏮ ⏯ ⏭, sin errores (sin commitear).
- [ui] Modo radio nuevo: canciones al azar de toda la biblioteca, arranca solo con la cola vacía y «Siguientes» queda en espera hasta apagarla; en Escenario el botón multicolor es la radio y el aleatorio vuelve a la botonera (ADR #152). Verificado en el navegador: arranca, «siguiente» da otra al azar, la cola no se toca y al apagar sigue la cola (sin commitear).
- [ui] «Todas las pistas»: iconos redibujados (con texto), sin la flecha de plegar, filas más grandes (70 px) y selector de vista Filas / Cuadrícula / Rueda / Compacta; buscar abre el panel; cualquier botón de Biblioteca se cierra con un segundo clic (en Studio pliega el panel) (ADR #153). Verificado en el navegador (sin commitear).
- [audio] **La normalización nunca se aplicaba**: la interfaz mandaba `gain_db` y Tauri 2 espera `gainDb`; `set_current_gain` fallaba en silencio y `prime_file` recibía la ganancia vacía (también la ganancia manual por pista). Corregido en los 5 sitios (ADR #149) (sin commitear).
- [audio] Igualar el volumen entre canciones: análisis automático en segundo plano (al abrir y tras cada descarga; la que suena y la siguiente se miden ya), sube y baja (decisión del propietario), ganancia aplicada desde la primera muestra y deslizada (~0,5 s) si llega a mitad de canción; la barra de volumen se mueve sola con una animación suave de 0,9 s (ADR #148, #149) (sin commitear).
- [ui] «Siguientes» empieza vacía al abrir (antes recuperaba la sesión anterior entera, con lo ya escuchado); onda de la barra de progreso alineada con la bola; pastilla de Escenario más grande (botones de 50 px); rueda del ratón suave en la cola y en las listas de canciones (ADR #150, #151). Verificado en el navegador (sin commitear).
- [ui] El volumen ya no se alarga al pasar el ratón (molestaba): ancho fijo de 220 px; se quitan las tres reglas que se pisaban (ADR #146) (sin commitear).
- [revisión] Revisión de la app y bugs corregidos (ADR #147), detalle en [[Revisión de bugs 2026-11-12]]: comandos pesados fuera del hilo de la ventana; interfaz que se quedaba «sonando» al acabar la cola; arrastre de la cola colgado; rótulo «En reposo» con música sonando; artista que no cambiaba entre canciones con el mismo título; álbum del buscador que tapaba una búsqueda nueva; sondeos solapados. Lint, fmt, clippy y 30/30 tests en verde; verificado en el navegador (sin commitear).
- [motor] Al cancelar una descarga o salir de Enn se borran sus archivos a medias (`.part`, `.ytdl`, miniatura, audio a medio convertir), y solo esos: los que empiezan por el nombre que anuncia yt-dlp (`ENN-FILE:`) y no estaban antes. Cancelar ahora mata también el ffmpeg hijo (`taskkill /T`), que antes seguía escribiendo (ADR #145). 30/30 tests; comprobado con yt-dlp real que el nombre llega antes de descargar (sin commitear).
- [motor] Corregidos los 5 bugs de la [[Auditoría de bugs 2026-11-12]] (ADR #144): cerrar a la bandeja ya no apaga el descargador ni corta descargas (#1, #2); `download_music` asíncrono, no congela la ventana al resolver listas (#3); `playlist_remove` sin `#EXTM3U` duplicado (#4); duraciones `h:mm:ss` en el buscador (#5). fmt, clippy y 29/29 tests en verde (2 nuevos: #4 y #5) (sin commitear).
- [ui] Escenario: pastilla junto a la carátula (aleatorio multicolor que parpadea al ritmo, repetir y ecualizador solo icono, con animación al activar); altavoz que abre la lista de salidas; volumen más largo y centrado en reposo en ambas vistas (ADR #142–#143). Verificado en el navegador (sin commitear).
- [ui] Vistas de Reproduciendo (Escenario predeterminada / Clásica), radio multicolor junto a la carátula, centrado con rebote en reposo, aviso de aleatorio sobre la cola, volumen más largo, rebote al adelantar y seleccionar todas en álbumes (ADR #139–#141). Verificado en el navegador salvo el botón de álbumes (sin commitear).
- [biblioteca] A petición del propietario, enviados a la papelera `LOLI (The Dark Triad) - hyük - Topic.jpg` (resto de una descarga rota) y la copia M4A de «Space Oddity (2015 Remaster)»; se conserva la FLAC.
- [motor] Descargas con títulos en ruso/cirílico o acentos: yt-dlp con `--encoding utf-8` y lectura tolerante de su salida (ADR #133) (sin commitear).
- [ui] Elegir una canción ya no vacía «Siguientes» (ADR #134); radio arreglada y visible en la cola (ADR #135) (sin commitear).
- [ui+motor] Artistas separados con foto de YouTube Music (ADR #136) (sin commitear).
- [ui] Volumen 0–150 % con tope en 100 y barra que se alarga (ADR #137); cola a 0,15 s; asa del panel sin tapar la flecha (ADR #138) (sin commitear).
- [diagnóstico] «Canciones repetidas»: no es un fallo del índice; «Space Oddity (2015 Remaster)» está dos veces en disco (FLAC y M4A). Hay además un `LOLI (The Dark Triad) - hyük - Topic.jpg` suelto en `Music`, resto de una descarga rota por el fallo de codificación.
- [ui] Logo nuevo a partir del dibujo del propietario: en la barra superior toma el color de la canción (`.brand-logo`, máscaras en `ui/img/`); icono de la app regenerado en plateado (`src-tauri/icons/`, `app-icon.png`) (sin commitear).

## 2026-11-09

- [ui] Cola: se quita el botón ▶; un clic reproduce la fila y para moverla hay que mantenerla pulsada ~0,3 s (se levanta) y arrastrar. Verificado en el navegador: el arrastre rápido no reordena ni reproduce; mantener y arrastrar reordena; el clic reproduce (sin commitear).
- [ui] Corregido: al soltar una fila arrastrada de la cola se reproducía. Causa: un manejador de clic antiguo, delegado en `#queue`, reproducía cualquier fila con cualquier clic (y soltar tras arrastrar genera un clic). Eliminado. Verificado con ratón real en el navegador: el arrastre reordena sin reproducir, el clic en la fila no hace nada y ▶ reproduce (sin commitear).
- [ui] Cola «Siguientes»: botón ▶ en cada fila para reproducirla; la fila solo se arrastra. Verificado en el navegador: el clic en la fila no reproduce, el arrastre reordena y ▶ reproduce (sin commitear).
- [ui] Desplegables propios con el estilo de la app (`ui/select.js` + estilos al final de `styles.css`): sustituyen a la lista nativa de Windows, que salía ilegible. Verificados en el navegador el orden, la elección con teclado y la salida de audio dentro de Ajustes (sin commitear).
- [ajustes] Graves y Agudos en +12 dB: los puso el propietario a propósito; se dejan así. El +12 de las 10 bandas (21:14) sigue sin causa confirmada; el fallo de teclado corregido (ADR #128) es la hipótesis principal.
- [ui] Corregido: con un deslizador enfocado, ← → pasaban de canción y además lo subían o bajaban (causa probable de los +12 dB). Los deslizadores sueltan el foco al soltar el ratón; los atajos no actúan con un control enfocado; las bandas se mueven con el teclado de 0,5 en 0,5 dB (sin commitear).
- [ui] Cola: el clic ya no reproduce la fila; «Ya está en la cola» solo cuenta lo que falta por sonar (sin commitear).
- [ui] «Ya en tu biblioteca» exige el mismo título y algún artista en común (sin commitear).
- [ui] La paleta vuelve al plateado en pausa y parada (sin commitear).
- [ui] Lista vieja de Descargas eliminada; descargas por enlace como pastillas; «Escuchar» y «+ Cola» al terminar (sin commitear).
- [ui] Simple: tarjeta centrada en la ventana (la barra lateral flota encima) (sin commitear).
- [ui] Tamaño mínimo y tamaño inicial 1366×768; telemetría en su propia fila bajo el ecualizador (sin commitear).
- [motor+ui] «Todas las pistas» con filas completas y orden (Recientes por fecha de modificación, Título, Artista, Álbum, Año, Duración, Más escuchadas); campo `Track.mtime` (sin commitear).
- [ui] «Artistas»: rejilla de pastillas de 2 columnas y página por artista (sin commitear).
- [ajustes] Ecualizador del usuario devuelto a 0 dB en las 10 bandas a petición del propietario: estaban guardadas en +12 dB desde las 21:14 sin que él las tocara. Copia previa: `%APPDATA%\com.enn.player\settings.json.bak-2026-11-09`.
- [ui] Diagnóstico `auditBands()` en `app.js`: si 3 o más bandas cambian ≥ 6 dB de golpe sin preset ni restablecer, deja en el log (nivel warn) los valores y la pila de llamadas. La causa del +12 no se pudo reproducir. Pista: el archivo de ajustes lo comparte con la versión instalada 0.1 (`%LOCALAPPDATA%\Enn\enn.exe`) (sin commitear).
- [motor] Buscador de música: `ytmusic.rs` (YouTube Music directo, con respaldo yt-dlp), comandos `music_search`, `music_album` y `download_tracks`, `Downloader::enqueue_known`, y la dependencia `ureq`. 27 tests + 1 contra la red real (sin commitear) → [[Buscador de descargas 2026-11-09]].
- [ui] Descargas con una sola barra (busca o descarga según lo escrito), pastillas de canciones y álbumes, esqueleto de carga, vista de álbum con selección, barras de progreso aleatorias, aviso sin conexión y botón plateado con brillo (`ui/search.js`, sin commitear).
- [ui] Telemetría de Studio: los valores bajan la fuente para caber completos (sin commitear).
- [ui] **Rediseño** → [[Rediseño de interfaz 2026-11-09]] (ADR #99–#111). Todo sin commitear:
  - tipografía IBM Plex Sans, autoalojada; fuera Inter;
  - botones con resorte;
  - transición Simple ↔ Studio por lados y FLIP de la portada;
  - Ajustes como ventana aparte, desde el engranaje, con audio, visualizador, interfaz y descargas (esos controles solo viven allí);
  - flecha para guardar los paneles;
  - en Simple: tarjeta siempre centrada, paneles flotantes, cajón del ecualizador, sin columna derecha, difuminado de 8 px ajustable y barra superior fija en inactividad;
  - cola «Siguientes» nueva con arrastre;
  - en Studio: ecualizador con cifras y topes por dB, paramétrico con Q y ganancia, mezclador en rejilla y sin modo de inactividad.
- [ui] Visualizador: opción «Mostrar el visualizador de fondo» y «Difuminado (Simple)»; quitado el protagonismo de Studio (sin commitear).
- [audio] **Corregido el modo exclusivo**: `exclusive.rs` ahora comunica al motor la tasa y los canales negociados mediante `Core::set_output_format` (`player.rs`), que rehace los remuestreadores de las pistas cargadas si la tasa cambia. La ruta compartida usa el mismo método. Test nuevo; 24/24 tests y clippy en verde. Falta probarlo de oído (sin commitear) → [[Visualizador - Cinta y Traza]].
- [motor] Línea de retardo de salida (90 ms − latencia medida del dispositivo) y anillo de análisis de 65536 muestras con reloj de muestras. La posición mostrada se compensa y las barras del mezclador leen lo que suena → `player.rs`, `exclusive.rs`, `lib.rs` (sin commitear).
- [motor] Analizador nuevo `viz.rs`, comando `get_viz_frame` y `dsp::fft_in_place`. Tests nuevos: 3 del analizador y 1 de la línea de retardo (23/23) (sin commitear).
- [ui] Visualizador Cinta/Traza en `ui/viz/` (WebGL2): sustituye a `#bg-visualizer` y `#np-spectrum`; difuminado en Simple; en Studio, nítido y pantalla completa tras 5 s (sin commitear).
- [ui] Vista nueva «Ajustes» con el selector Cinta/Traza y «Personalizar render» (perfiles, matriz de ruteo con medidores, deslizadores por banda, barrido/curva/estela, resolución, frenado) (sin commitear).
- [build] ESLint y `npm run lint` incluyen `ui/viz` (sin commitear).
- [revisión] Verificado: fmt, clippy, 23/23 tests, ESLint, `node --check`, y la ventana nativa en Simple, Studio y Ajustes. El volumen de la app quedó en 0 por las pruebas.
- [hallazgo] El modo exclusivo no actualiza `Core.out_rate`; se deja sin corregir, pendiente de decisión → [[Visualizador - Cinta y Traza]].
- [docs] ADR #93–#97: lookahead por retardo de la salida, análisis en Rust, vista «Ajustes», render de fondo en Studio (pantalla completa tras 5 s) y difuminado en Simple → [[Visualizador - Cinta y Traza]].
- [git] Borrados los worktrees viejos `headroom-install-setup-8c594c` y `project-review-964ba7` (apuntaban a `Escritorio\Enn`) y sus ramas `claude/*`, que no tenían commits propios.
- [bóveda] Reorganizada para lectura por LLM: carpetas `01 Proyecto … 05 Registro`, frontmatter `resumen/estado/actualizado` en cada nota y un índice que hace de router.
- [bóveda] «Contexto general» y «Objetivos del proyecto» fusionadas en [[Visión y objetivos]]; «Objetivos y presupuesto de recursos» pasa a llamarse [[Presupuesto de recursos]].
- [bóveda] `ROADMAP-ENN.md` movido de la raíz del repo a [[Roadmap]]. Se actualizó su referencia en `CONTRIBUTING.md` y en `.github/ISSUE_TEMPLATE/feature_request.md` (sin commitear).
- [bóveda] Plugin **Kanban** 2.0.51 instalado en `.obsidian/plugins/obsidian-kanban` (repo oficial del registro de Obsidian) y [[Kanban - Enn]] convertido a tablero.
- [bóveda] Creadas [[Registro de cambios]] (esta nota) y [[Visualizador - Cinta y Traza]]. El handoff de Claude Design quedó archivado en `Adjuntos/Handoff visualizador 2026-11-09/`.
- [docs] ADR #84–#92 (visualizador, bóveda, no commitear) en [[Decisiones de desarrollo]]; nota en [[Diseño - Sistema visual]] §6: el cristal se mantiene.
- [revisión] Estado verificado: `clippy --all-targets -D warnings` limpio, 19/19 tests, ESLint y `node --check` en verde. `master` va 30 commits por delante de `origin` (sin push) y hay 17 archivos modificados más 7 sin seguimiento, todo sin commitear.

## 2026-10-04 (sin commitear)

- [ui] Botón «↻ Reestablecer» en el mezclador de Studio.
- [ui] En Simple, el cromo se funde tras 3 s de inactividad.
- [ui] Cola en cristal bajo la portada en Simple; en Simple no hay visualizadores de barras.
- [ui] Las filas de Studio entran escalonadas desde la derecha.
- [ui] Segunda ronda: bloque de reproducción centrado en Simple, ecualizador de Simple movido a la portada detrás de su botón, y barra lateral con margen inferior, esquinas redondeadas y borde fino, sin cristal.
- Detalle en [[Plan de interfaz 2026-10-03]].

## 2026-10-03 (sin commitear)

- [motor/ui/ci/build] Correcciones de la auditoría #2–#16 y #19–#21 → [[Auditoría de bugs 2026-10-03]]. Entre ellas:
  - el progreso de las descargas ya se mueve;
  - existe la build de Tailwind (`npm run build:css`, que genera `ui/tw-output.css` y no se versiona);
  - el error del motor se emite siempre;
  - ReplayGain llega a `finished` aunque falte un archivo;
  - ya no hay inversión de cerrojos en el modo exclusivo;
  - la tasa de bits se calcula una vez por pista;
  - la CI usa `clippy --all-targets -D warnings` + `fmt --check` sin el atajo `|| cargo check`;
  - el README deja de anunciar Opus.
- [ui] Rediseño «Obsidian Hi-Fi» por fases:
  - descargas que se abren y cierran a voluntad;
  - estado sin canciones (4 casos + error de escaneo);
  - ecualizador en el escenario de Studio;
  - panel de pistas colapsable y redimensionable;
  - sistema de botones por tokens y `:focus-visible`;
  - barra de título propia (`decorations: false`) con permisos de ventana en `capabilities/default.json`.
  - Detalle en [[Plan de interfaz 2026-10-03]].
- [docs] Notas [[Diseño - Producto]] y [[Diseño - Sistema visual]]; tablero [[Kanban - Enn]].
- [build] El caché de cargo vive en `D:\enn-target` (`src-tauri/.cargo/config.toml`, sin versionar).

## 2026-09-29

- [ui] `bd4a63f` Manejo de errores robusto en `playPathNow` y `enqueuePath`.

## 2026-09-25 — Fase 2 (29 commits)

- [motor] `24cf900` WASAPI exclusivo, ReplayGain, playlists, descargador, cachés de carátulas y waveforms, teclas multimedia.
- [build] `ff5a03e` Compila de verdad en Linux/macOS.
- [motor] `71d36f2` Se simplifica `tags_write`.
- [ui] `a1e116f` Badge de calidad de la fuente.
- [motor] `f6e2ff2` Favoritos por pista; `refresh()` ya no pierde ReplayGain.
- [motor] `6b394ce` Logging por niveles y errores claros de yt-dlp/ffmpeg.
- [audio] `5a8d0dc` Reconexión automática del dispositivo de salida.
- [seguridad] `332f464` Bloqueada la inyección de argumentos en yt-dlp.
- [build] `6a75b72` Arreglada la URL 404 de yt-dlp en `build.rs`, con checksum SHA-256.
- [perf] `3aa5158` Escaneo de la biblioteca en paralelo con rayon.
- [test] `841bff3` Regresión del remuestreador.
- [ui] `7f74c65` Aviso de descarga duplicada.
- [docs] `34bc3f6` `118c391` CONTRIBUTING, plantillas de issues y decisiones de diseño en el README.
- [ui] `8e27ce2` Editor de etiquetas por lote y ARIA.
- [ui] `c19f8ff` Fondo audio-reactivo y animaciones.
- [ui] `1415e1c` Tamaño mínimo de ventana real.
- [ui] `4bdc687` Vista «Reproduciendo» a pantalla completa.
- [motor] `289b990` Etiquetas de género y año.
- [ui] `76d5b18` Vistas Por género / Por año y detección de duplicados.
- [ci] `d7bb1b1` ESLint.
- [ui] `65b5c30` Autocompletado de artista y álbum; «escuchadas recientemente».
- [ui] `6c73e5d` Navegación por teclado.
- [docs] Commits `docs:` que marcan avances del roadmap.

## 2026-09-11 → 2026-09-13

- Implementadas las 28 propuestas A–F (audio, biblioteca, automatización, descargador, plataforma, calidad interna) → [[Propuestas de implementación]].
- Primera medición de recursos → [[Presupuesto de recursos]].

## 2026-09-03

- `a7fba88` Primera versión estable de Enn (0.1.0). Es el único commit publicado en `origin`.
