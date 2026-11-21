---
resumen: Prueba de aceptación del Sprint 4 (Movimiento) en Enn real a 1366×768. Ola de color y cambio de modo con percentil 95 de 5–10 ms por fotograma; cambio de modo en ~470 ms, invertible y sin cuelgues (auditoría n.º 2 cerrada). Una tarea larga (71–93 ms) en la primera entrada a Studio de cada sesión. Memoria en reposo +5–7 MB; tras mucho uso, +20–30 MB más que antes, sin fuga en JavaScript.
estado: hecho, falta la revisión a mano del propietario
actualizado: 2026-11-21
tags: [enn, beta, sprint, pruebas, animacion, rendimiento, memoria]
---

# Pruebas — Sprint 4

Diseño en [[Sprint 4 - Movimiento]]; reparto en [[Sprint 4 - Tareas]].

## Cómo se midió

- **Automáticas**: `npm test`, 86 pruebas (45 al cerrar el Sprint 3), y `npm run lint` sin avisos. No se tocó Rust, así que `cargo test` no se volvió a pasar.
- **Enn real**, compilación de pruebas, ventana de 1366×768 (lo confirma cada informe: `vp 1366x768`), salida exclusiva activa, 115 pistas.
  - **Tiempo por fotograma**: Enn deja en el registro de depuración (`%TEMP%\enn-debug.log`) una línea por cada una de las 5 primeras olas y de los 10 primeros cambios de modo de cada sesión. Cada línea da la media, el percentil 95 y el peor hueco entre fotogramas, y las tareas largas (> 50 ms, `PerformanceObserver`) que hubo mientras duraba.
  - **Memoria**: memoria privada de `enn.exe` y de sus 6 procesos de WebView2, sumada. Siempre igual: arranque en Simple, en pausa, 30 s quieta y medir; luego 11 idas y vueltas Simple ↔ Studio, 30 s quieta y medir.
  - **Antes**: el último commit (`008e76f`, antes del sprint) exportado aparte y compilado igual.
- **Navegador de pruebas** (`ui-mock`) para lo que en Enn real no se puede inspeccionar: montón de JavaScript, nodos, nombres de transición y animaciones activas.

## Resultados

| Medida | Resultado | Objetivo | ¿Cumple? |
|---|---|---|---|
| Ola de color: percentil 95 | **5,1 ms** en las 8 olas medidas (radio, ⏭, ⏮, pausa) | < 20 ms | ✅ |
| Ola de color: peor fotograma | 15–40 ms (el de la captura de la vista vieja); 0 tareas largas | ninguna tarea > 50 ms | ✅ |
| Cambio de modo: duración | **466–485 ms**; la primera de cada sesión, 532–560 ms | ≤ 650 ms | ✅ |
| Cambio de modo: percentil 95 | **5,1–10,1 ms** (30 cambios en 3 sesiones) | < 20 ms | ✅ |
| Cambio de modo: peor fotograma | 35–45 ms (la captura), salvo la primera entrada a Studio de cada sesión | ninguna tarea > 50 ms | ⚠️ |
| Primera entrada a Studio tras arrancar | Una tarea larga de **71–93 ms** (tres sesiones de tres). Las siguientes, ninguna | ninguna tarea > 50 ms | ❌ |
| Cambio de modo con teclado | Instantáneo; sin tareas largas, ni siquiera el primero | — | ✅ |
| Invertir a mitad (ratón) | Studio → Simple pulsado a los 150 ms → acaba en Studio; en el navegador, de vuelta a los 382 ms sin pasar por el destino | — | ✅ |
| Minimizar a mitad del cambio | Los dos sentidos: al volver está en el modo pedido y se puede seguir cambiando (antes se quedaba en Studio) | auditoría n.º 2 | ✅ |
| Dos ⏭ dentro de la misma ola | Las dos cuentan (Caro → Jimmy El Favor… → La Monda) | — | ✅ |
| Mínimas en Enn real | El cambio de modo es un fundido de la página entera; nada se desplaza | — | ✅ |
| 20 idas y vueltas (navegador) | 1 075 nodos antes y después; ningún nombre de transición suelto; 0 animaciones vivas | sin fugas | ✅ |
| Montón de JavaScript tras 30 idas y vueltas más | 4,0 → 3,8 MB | sin fugas | ✅ |

### Memoria (privada, los 7 procesos)

| | Antes (`008e76f`) | Sprint 4 |
|---|---|---|
| En reposo, 30 s tras arrancar | 261 MB | 266–268 MB |
| Tras 11 idas y vueltas | 294 MB (+33) | 313–325 MB (+46 a +57) |
| Tras 22 / 33 idas y vueltas | — | 329 / 344 MB |
| 2 minutos después, quieta | — | 330 MB (no sigue subiendo) |

Por proceso (Sprint 4): el de la GPU pasa de 157 a 171–176 MB y se queda ahí; el de la página, de 44 a 78 MB tras la primera tanda y unos 6 MB más por cada tanda siguiente. Como el montón de JavaScript y el número de nodos no cambian, lo que crece son cachés nativas del navegador (imágenes decodificadas de las carátulas de Studio, recursos de las capturas), no algo que Enn retenga. En este sprint no había objetivo de memoria («primero hagamos y luego pensamos en ahorrar»); queda apuntado para el sprint de ahorro.

## Fallos encontrados y arreglados en el cierre

- **← → en el selector Simple/Studio también cambiaban de canción** (venía de antes). El atajo global de las flechas no miraba si un control ya había usado la tecla; con nada cargado, arrancaba la radio. Ahora un control que usa la tecla la consume (vale también para el selector de vista de la biblioteca, el de formatos y el tirador del panel).
- **Con crossfade, la canción nueva no contaba como empezada** (tarjeta del tablero que venía del [[Pruebas - Sprint 3|Sprint 3]]). Cuando el motor encadena con crossfade, la cola avanzaba pero no se apuntaban el final de la anterior ni el inicio de la nueva en las escuchas, ni el historial, ni se reiniciaba la tarjeta de recomendación ni se pedía la siguiente a la radio. Ahora se hace lo mismo que en un final normal (`crossfadeStarted` en `app.js`). **No se pudo ver en marcha**: con la salida exclusiva activa, el motor cebó la siguiente pero no llegó a encadenarla (al terminar, la interfaz la volvió a lanzar desde el principio), así que este camino no llegó a ejecutarse. Ver «Pendiente».

## No se pudo comprobar

- **El tacto a mano**, a la frecuencia del monitor, a velocidad normal y a cámara lenta, y la revisión al día siguiente con ojos frescos: son del propietario.
- **Lo que ocurre durante la ola o el cambio de modo, en capturas.** La herramienta de capturas oculta las ventanas de procesos no autorizados (`msedgewebview2.exe`) y algunas capturas salen con trozos de la interfaz vacíos. No es Enn: al mover el ratón y volver a capturar, todo está en su sitio.

## Pendiente que pasa a otros sprints

| Tema | Por qué | A dónde |
|---|---|---|
| Revisión a mano del movimiento | Requisito del diseño: el propietario en su monitor, y al día siguiente | Propietario |
| Crossfade con salida exclusiva no encadena | El motor recibe la pista cebada (`ENGINE prime cmd`) pero al acabar la canción no la toma; la interfaz la vuelve a empezar. Con la salida compartida hay una prueba (`crossfade_promotes_primed`) que sí pasa | Motor (Rust), tarea aparte |
| Tarea larga en la primera entrada a Studio | 71–93 ms una vez por sesión: la captura de la transición coincide con la primera vez que se pinta Studio (con el teclado, sin transición, no pasa) | Sprint de rendimiento |
| Memoria tras mucho cambio de modo | +20–30 MB más que antes en cachés nativas del navegador | Sprint de ahorro |
| Visualizador quieto donde aún no llegó la ola | Hasta 1 s; darle grupo propio lo pinta encima de la interfaz | Sprint 6 (video) |
| Arrastrar un deslizador empezado durante una transición | El clic llega (se reenvía), el arrastre no a la primera | Menor; sin sprint |
