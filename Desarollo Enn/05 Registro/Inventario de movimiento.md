---
resumen: Barrido del Sprint 4 (T2) con find-animation-opportunities. Qué cambios de estado siguen siendo instantáneos, qué movimiento se les da y qué se deja quieto a propósito.
estado: hecho
actualizado: 2026-11-21
tags: [enn, beta, sprint, animacion, auditoria]
---

# Inventario de movimiento (Sprint 4, T2)

Barrido de `ui/` con el criterio de Emil Kowalski («a veces la mejor animación es ninguna»), cruzado con la regla del propietario de que nada cambie de golpe. Donde chocan, manda esta regla: **lo frecuente lleva movimiento, pero casi imperceptible (≤ 120 ms y solo opacidad o una escala mínima); lo ocasional puede lucirse**.

Fichas: `--spring-snappy`, `--spring-bouncy`, `--spring-elastic` (y `-ms`), `--ease-spring` y `--t-release` en `ui/motion.css`; `spring()` en `ui/motion.js`. Todas dependen del carácter elegido en el laboratorio.

## Lo que se anima

Por orden de impacto.

| # | Dónde | Hoy | Para qué | Frecuencia | Movimiento |
|---|---|---|---|---|---|
| 1 | `openCtx` (`app.js:3939`), clase `.ctx` | El menú contextual aparece y desaparece de golpe, sin relación con el clic | Coherencia espacial | Varias veces al día | Nace en el punto del clic: `transform-origin` en esa esquina, `opacity 0 → 1` y `scale(0.96) → 1` con `--spring-snappy` (260 ms). Sale en 120 ms con `ease-in`, sin rebote |
| 2 | `setNowPlayingArt` (`app.js:3022`), `miniArt` (`app.js:3281`), título y artista (`app.js:3359`) | La carátula y los textos se sustituyen en seco al cambiar de canción | Evitar el cambio brusco | Decenas al día | Fundido cruzado de 180 ms en la carátula; texto con `opacity` y `translateY(4px)` en 120 ms. Lo cubrirá la ola de color (T5) cuando haya cambio de paleta |
| 3 | `setLibLayout` (`app.js:1323`) | Filas ↔ Cuadrícula ↔ Rueda ↔ Compacta repinta la lista de golpe | Coherencia espacial | Ocasional | FLIP solo de las carátulas visibles (máx. 40) hacia su sitio nuevo con `--spring-snappy`; el resto con fundido de 160 ms |
| 4 | `renderQueue` (`app.js:586`) | Añadir o quitar de la cola rehace la lista entera; las filas saltan | Evitar el cambio brusco | Ocasional | Repintado con clave por ruta: las filas que quedan hacen FLIP con `--spring-bouncy`; la nueva entra con `scale(0.97)` + opacidad; la que sale se encoge en 140 ms |
| 5 | `iconSet("btn-play", …)` (`app.js:86`, `app.js:5208`) | ▶ y ⏸ se sustituyen por `innerHTML` | Indicar el estado | Decenas al día | Cruce de 110 ms: el icono que sale `scale(0.8)` + opacidad 0 y el que entra al revés con `--ease-spring`. El sonido no espera: la orden sale antes |
| 6 | Favorito, `fav` (`app.js:1142`) | La estrella cambia de color sin más | Respuesta | Ocasional | Al marcar: `scale(0.6) → 1` con `--spring-elastic`; al desmarcar solo color. Es el único sitio de «deleite» frecuente que se permite |
| 7 | Pestañas de la biblioteca (`app.js:4836`) | El contenido se sustituye | Coherencia espacial | Varias veces al día | El contenido nuevo entra desde el lado de la pestaña (`translateX(±12px)` + opacidad) en 180 ms. Sin escalonado de filas |

## Lo que se deja quieto

- **Cambio de modo con las flechas** (`app.js:5059`): atajo de teclado. Se queda instantáneo, como ya decía el diseño.
- **Tiempo transcurrido** (`app.js:3377`, se actualiza 4 veces por segundo): son datos que se leen; dígitos rodando ahí serían ruido. El rodado se limita a contadores que cambian poco (pendientes de descarga, número de pistas).
- **Desplazamiento de listas largas**: ninguna animación ligada al scroll; el escalonado de entrada solo en el primer pintado y solo en las filas visibles.
- **Pasar el ratón por filas y botones**: ya tiene color en 120 ms; añadir desplazamiento sería ruido a la frecuencia más alta.
- **Visualizador**: ya se mueve con la música; no lleva transiciones propias (y en la ola va en su propio grupo, sin congelarse).

## Ya resuelto antes

Botones (`.btn`, pulsación y vuelta con `--ease-spring`), Ajustes (`settings-dlg`, escala desde el centro y salida más rápida), avisos (`#toast`, entran y salen por abajo), pastillas de descarga (Sprint 2), tarjeta de recomendaciones (Sprint 3). En T3 solo se pasan a las fichas del carácter (por ejemplo, `.ctl:active` aún usa `transform 0.1s ease`, `styles.css:902`).
