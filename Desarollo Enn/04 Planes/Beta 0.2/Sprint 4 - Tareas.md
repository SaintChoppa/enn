---
resumen: Reparto del Sprint 4 (Movimiento) en tareas con prueba primero. Sin objetivo de memoria en este sprint (primero se hace, luego se ahorra). Rebote «suave» por defecto y configurable en Ajustes.
estado: hecho, falta la revisión a mano del propietario
actualizado: 2026-11-21
tags: [enn, beta, sprint, animacion, tareas]
---

# Sprint 4 — Tareas

Diseño en [[Sprint 4 - Movimiento]]. Resultados en `05 Registro/Pruebas - Sprint 4.md`.

## Respuestas de apertura (2026-11-21)

1. **Memoria: sin objetivo en este sprint.** «Primero hagamos y luego pensamos en ahorrar.» Las animaciones solo tocan `transform`, `opacity`, `clip-path` y máscaras, así que se mide que no suban la memoria de forma apreciable, pero no se persigue ninguna cifra. El objetivo se fija más adelante, con los datos del issue #1 si llegan.
2. **Issues del compañero.** Las que Zaphkl no haga se trabajan igual, aquí o en el sprint que toque.
3. **Cuánto rebote: «suave» por defecto, y configurable en Ajustes** (elegido en el laboratorio el mismo día; ADR #179). Ajustes → Interfaz tiene «Rebote» (Suave, Medio, Elástico) y «Animaciones» (Completas, Suaves, Mínimas).

## Estado (2026-11-21)

T1–T8 hechas. Resultados en [[Pruebas - Sprint 4]]. Falta la revisión a mano del propietario (tacto en su monitor y al día siguiente).

## Decisiones de la ejecución

- **Un solo aviso a la vez**, sin pila: Enn solo enseña un aviso cada vez y uno nuevo sustituye al anterior, así que apilarlos y descartarlos arrastrando no aporta nada. Solo cambia la entrada (con muelle).
- **Las casillas de Ajustes se ven como interruptores** (como en Spotify). Siguen siendo casillas por dentro: teclado y lector de pantalla igual.
- **Favorito optimista**: la estrella cambia antes de que responda el motor y vuelve atrás si falla (regla 1: la acción no espera).
- **Tope en toda salida animada** (`whenDone` en `motion.js`): con la ventana oculta las animaciones se congelan y su final no llega; a los pocos milisegundos se termina igual.

- **FLIP solo de lo visible**: la cola y las carátulas se miden solo si se ven (y como mucho 40 carátulas), así una cola o una biblioteca larga no cuesta más. Con la ventana oculta o en «Mínimas» no se mide nada.
- **La Rueda no hace FLIP**: su geometría es otra; al entrar o salir de ella la lista solo se funde.

- **El visualizador no lleva grupo propio en la ola.** Darle nombre de transición lo saca de la captura de la página y lo pinta encima de la interfaz (o, debajo, tapado por el fondo opaco). Se queda en la captura: donde ya llegó la ola sigue vivo; donde no, queda quieto como mucho 1 s. Se revisa en el Sprint 6 con el video.
- **Las 5 primeras olas de cada sesión dejan su tiempo por fotograma en el registro de depuración** (`WAVE #n causa: avg, p95, max`). La primera decide si el equipo va lento (media > 24 ms → solo fundido, recordado).
- **Pulsar ▶ sin nada cargado arranca la radio**, así que esa ola sale del botón de radio.

- **Cambio de modo en `ui/modeswitch.js`**, con 13 piezas con nombre (carátula, título, artista, botonera, barra de progreso, salida y volumen, cola, ecualizador, panel de pistas, descargas, columna derecha, fila del ecualizador y telemetría). Los nombres solo existen mientras dura el cambio, así la ola de color no los captura.
- **Solo llevan nombre las piezas que se ven**, y se vuelve a mirar tras cambiar el modo: el ecualizador dentro del cajón cerrado de Simple se capturaría sin el recorte del cajón y viajaría a la vista. Lo que solo se ve en un lado entra o sale por su lado, sin viajar.
- **Los paneles se recortan al cambiar de tamaño, no se estiran** (cola, panel de pistas, descargas, ecualizador, botonera, barra y volumen). La carátula y los textos escalan, sin deformarse.
- **Invertir a mitad** da la vuelta a las animaciones de la transición en curso (`reverse()`), sin abrir otra. Cuando la última vuelve al principio, el modo de partida se aplica en ese mismo fotograma.
- **Durante un cambio de modo no hay ola**: el color cambia con el fundido. Una ola nueva saltaría la transición del modo.
- **Mínimas**: el cambio de modo es un fundido de la página entera en 300 ms. **Suaves**: sin el zoom del fondo.
- **Mínimas = «reducir movimiento»**: una sola marca, `data-still`, para los dos. Los bloques `@media (prefers-reduced-motion)` de `styles.css` pasan a `:root[data-still]`, salvo el que oculta el visualizador, que sigue siendo solo de Windows (en Mínimas el visualizador tiene su propio interruptor).
- **Fundidos, no cortes**: las animaciones de entrada de `styles.css` multiplican su desplazamiento por `--mk` (1 normal, 0 en Mínimas). Lo que solo se mueve (el salto de un botón, el deslizamiento del volumen o de la barra, el centrado en reposo, FLIP) no se anima. Las salidas con duración propia la conservan, así su tope sigue valiendo.
- **Se mantienen** los indicadores de estado: los giros de carga, las barras de las descargas y la cuenta atrás de la tarjeta de recomendación (su final la cierra).
- **Medidas en el registro de depuración**: las 5 primeras olas y los 10 primeros cambios de modo de cada sesión dejan su tiempo por fotograma y sus tareas largas (`WAVE #n`, `MODE #n`). Así se mide en Enn real sin herramientas del navegador (WebView2 no las abre en Tauri).
- **Memoria «antes»**: el último commit (`008e76f`) exportado aparte y compilado igual, medido con el mismo protocolo.
- **La primera entrada a Studio de cada sesión tiene una tarea de 71–93 ms** y se deja pendiente: pasa una sola vez y solo cuando la transición captura el primer pintado de Studio; arreglarlo pide una traza que Enn real no deja tomar.
- **Clics durante una transición.** En WebView2 (Chrome 156) todos los eventos del puntero van a `<html>` mientras dura una View Transition; `pointer-events: none` en `::view-transition` no basta. Un clic durante la ola o el cambio de modo termina la transición en el acto (saltarla devuelve el clic a la página) y se reenvía a lo que hay debajo; sobre el otro botón de modo, a mitad de un cambio, la invierte. Arrastrar un deslizador que se empiece durante la transición no arrastra a la primera (el clic sí llega).

## Reglas

Las del [[Sprint 2 - Tareas]]: sin commits ni push sin petición, prueba primero y puertas al final de cada tarea (`npm run lint`, `npm test`, `cargo test` si se toca Rust). Las tres reglas del diseño mandan en cada tarea:

1. La acción nunca espera a la animación.
2. Lo frecuente ≤ 120 ms; lo ocasional 220–700 ms.
3. Todo se puede interrumpir (transiciones CSS o WAAPI que se redirigen, nunca promesas que bloquean).

## Tareas

| # | Tarea | Archivos | Prueba primero |
|---|---|---|---|
| T1 | **Laboratorio de movimiento y carácter**: tres caracteres (suave, medio, elástico) que redefinen `--ease-spring` y `--t-release` con los muelles de `motion.js`; página de prueba solo en desarrollo con los mismos controles en los tres | `motion.js`, `motion.css`, `ui/lab.html` | Cada carácter genera su curva con `springLinear`; el bloque de `motion.css` coincide con lo generado; carácter desconocido → el elegido por defecto |
| T2 | **Inventario**: `find-animation-opportunities` e `improve-animations` sobre toda la interfaz; lista de lo que se anima y de lo que no debe animarse | `05 Registro/Inventario de movimiento.md` | — |
| T3 | **Controles**: pulsación, ▶/⏸ que se transforma, favorito con salto, interruptores, deslizadores, menús desde su botón, diálogos, avisos, números que ruedan | `styles.css`, `app.js`, `motion.js` | Origen del menú según el botón; los dígitos que ruedan solo cambian los que cambian |
| T4 | **Listas y contenido**: entrada escalonada solo en el primer pintado y solo lo visible, cola con FLIP, pestañas que se deslizan, cambio de vista con carátulas que viajan, resultados de búsqueda, carátulas y textos con fundido | `app.js`, `search.js`, `styles.css` | Escalonado: tope de filas, nunca al desplazarse; FLIP de la cola sin saltos al interrumpir |
| T5 | **Ola de color** con View Transitions y origen según la causa | `ui/wave.js`, `app.js`, `styles.css` | Origen por causa; 10 cambios en 2 s terminan en la última paleta y sin restos; mismo color → sin ola; ventana oculta → sin animación; reducir movimiento → fundido; sin View Transitions → fundido actual |
| T6 | **Simple ↔ Studio** con View Transitions y elementos compartidos; tope de 900 ms; invertir a mitad; con teclado, sin animación | `app.js`, `styles.css` | Termina en < 1 s con el documento oculto; ningún nombre de transición repetido; ida y vuelta 20 veces sin fugas de nodos |
| T7 | **Nivel de animación** en Ajustes (Completas, Suaves, Mínimas) y respeto a «reducir movimiento» de Windows (fundido de 300 ms, sin desplazamientos) | `index.html`, `app.js`, `prefs.js`, `motion.css` | Mínimas y reducir movimiento: ninguna animación con desplazamiento |
| T8 | **Medidas y cierre**: tiempos por fotograma durante la ola y el cambio de modo a 1366×768, memoria antes y después, auditoría n.º 2 cerrada, vault | `05 Registro/`, `02 Técnica/` | Percentil 95 < 20 ms; ninguna tarea > 50 ms |
