---
resumen: Revisión de la app del 2026-11-12 pedida por el propietario. 7 bugs encontrados y corregidos, más el volumen sin alargarse.
estado: cerrado
actualizado: 2026-11-12
tags: [enn, revision, bugs, calidad]
---

# Revisión de bugs — 2026-11-12

Petición del propietario: «Revisa la app, depura el código y arregla bugs. Quita lo de que se expanda la barra de música». Sin commitear.

**Método**: lectura de la cola, el sondeo del motor, las vistas, el buscador y los comandos de Rust; ESLint, `node --check`, `cargo fmt/clippy/test` (30/30); prueba en el navegador con `dev-mock.js`.

## Corregido

| # | Bug | Síntoma | Arreglo | Dónde |
|---|---|---|---|---|
| 1 | Comandos pesados en el hilo de la ventana | Al añadir o refrescar una carpeta, abrir una playlist, editar etiquetas por lote o recorrer la biblioteca (una carátula por fila) la ventana se congelaba | `async` + `spawn_blocking` (helper `off_main`) en `lib_add`, `lib_refresh`, `probe_paths`, `album_art`, `playlist_load`, `playlist_content`, `tags_write`, `tags_write_batch` | `lib.rs` |
| 2 | La interfaz se quedaba «sonando» | Al acabar la cola o perder el dispositivo: colores teñidos, visualizador activo, «Reproduciendo ahora» y el botón podía quedarse en ⏸ | `applyIdle()` tras dos sondeos en idle si no hay un `playAt` en marcha (así el hueco entre canciones no apaga los colores) | `app.js` |
| 3 | Arrastre de la cola colgado | Si la lista se repintaba con una fila pulsada (p. ej. al acabar la canción), la cola no volvía a dejar arrastrar hasta reiniciar | `renderQueue()` suelta el arrastre pendiente | `app.js` |
| 4 | Rótulo «En reposo» con música sonando | Al abrir la app con una canción ya sonando, o al pausar/parar sin cambiar de título | `paintKicker()` en cada estado | `app.js` |
| 5 | Artista que no cambiaba | Dos canciones con el mismo título (p. ej. «Caro») dejaban el artista de la anterior | Se compara título + artista | `app.js` |
| 6 | Álbum tardío en el buscador | Si se escribía otra búsqueda mientras cargaba un álbum, el álbum tapaba los resultados nuevos | El álbum también usa el contador `seq` | `search.js` |
| 7 | Sondeos solapados | Si `get_state` tardaba más de 250 ms se apilaban llamadas | Un sondeo a la vez | `app.js` |

Además: **volumen de ancho fijo** (220 px, sin alargarse al pasar el ratón; ADR #146), comentarios desfasados corregidos, y `dev-mock.js` devuelve `idle` (como el motor real) y acepta `stop`.

## Encontrado después (mismo día)

- **La normalización y la ganancia manual por pista nunca llegaban al motor**: la interfaz mandaba `gain_db` y Tauri 2 espera los argumentos en camelCase (`gainDb`). `set_current_gain` fallaba y el `.catch(() => {})` lo ocultaba; `prime_file` recibía la ganancia como `None`. Por eso la canción siguiente sonaba «durísimo». Corregido (ADR #149).
- La ganancia se aplicaba *después* de empezar a sonar: ahora va dentro de `play_file`.

## Verificado

- Navegador (1366×768): el volumen mide 220 px con y sin el ratón encima; con la canción sonando el rótulo dice «Reproduciendo ahora»; al parar el motor el botón vuelve a ▶, `data-playing` pasa a 0 y el rótulo a «En reposo».
- No verificado a mano: el arrastre de la cola durante un cambio de canción (difícil de reproducir; arreglo por lectura) y la fluidez real al escanear una carpeta grande en la app.
