---
resumen: Visualizador nuevo (Cinta y Traza) del handoff de Claude Design; decisiones del propietario, dónde vive y estado de la implementación.
estado: vivo
actualizado: 2026-11-09
tags: [enn, visualizador, render, webgl, plan]
---

# Visualizador — Cinta y Traza

Fuente: handoff de Claude Design del 2026-11-09, copiado íntegro en `Adjuntos/Handoff visualizador 2026-11-09/`. **Solo hay que abrir esos HTML para portar fórmulas concretas**: cada uno trae arriba el prototipo WebGL2 (GLSL ES 3.0) y abajo una sección «Handoff para wgpu» con fórmulas, constantes, tiempos, layout de uniforms y WGSL.

## Las dos versiones

| | Cinta (v1) | Traza (v2) |
|---|---|---|
| Archivo | `Cinta Visualizador.dc.html` (handoff l. 208–616) | `Cinta Visualizador v2.dc.html` (handoff l. 216–636) |
| Idea | Cinta metálica con torsión sobre una lemniscata `P(t)=(cos t, sin t cos t)/(1+k sin²t)` | Traza metálica que barre de izquierda a derecha como un monitor cardíaco |
| Qué la mueve | Graves → grosor/velocidad; torsión, borde, color y polvo por ruteo | Tono dominante → altura; ataques de graves → pulso QRS+T con ecos; agudos → filo; chispas en los saltos; estrellas que parpadean con los graves |
| Draws | 4: polvo (700 quads), halo, cinta (strip 2×640), destello | 6: polvo, ecos (2 instancias), halo, traza (strip 2×1024), chispas, cabeza |
| Datos GPU | 1 UBO de 1312 B (LUT de 64 vec4 por longitud de arco) | UBO de 288 B + historial de 2 filas × 1024 vec4 (32 KB) |
| Extra | Eco con rotación, paleta OKLab | Barrido al tempo (k × periodo de graves, ~4,4 s), historial que se sobrescribe |

Comunes: sin vertex buffers (todo con `gl_VertexID`), OKLab en shader con fundido de paleta de 600 ms `easeInOutCubic`, filo de 1 px con `fwidth`, resorte crítico exacto `ω = 3,89 / T90`, bandas 20–150 / 150–2 k / 2 k–16 k Hz con AGC, perfiles y matriz de ruteo, **lookahead de 90 ms**, frenado con resorte de 0,9 s al pausar y render detenido en reposo (coste 0).

## Decisiones del propietario (2026-11-09)

ADR #84–#90 en [[Decisiones de desarrollo]].

1. **Las dos versiones** se incluyen y el usuario escoge en **Ajustes generales**.
2. **WebGL2 dentro del webview** (no wgpu): así se puede difuminar con CSS y convivir con el cristal.
3. **Dónde**: sustituye al `#bg-visualizer` y al `#np-spectrum` (concretado en los puntos 11 y 12).
4. **Lookahead real de 90 ms**, bien afinado: el análisis va por delante de lo que suena para que el pulso caiga justo con el golpe.
5. **Colores** de la carátula de la pista en curso (`ui/palette.js`), como el resto de la app.
6. **Panel de control** (perfiles, ruteo, barrido…) solo en una sección aparte, «Personalizar render».
7. **El cristal y el estilo de la app no cambian**: el render se adapta a la app.

## Decisiones de la segunda ronda (2026-11-09, ADR #93–#97)

8. **Lookahead** = línea de retardo al final de la cadena (90 ms − latencia medida del dispositivo). El analizador lee antes del retardo. La posición mostrada se compensa.
9. **Análisis en Rust** (FFT 4096 Blackman, energías con AGC, tono, ataques). La UI recibe un frame pequeño con marca de tiempo.
10. **Vista «Ajustes»** nueva en la barra lateral, con el selector Cinta/Traza y «Personalizar render» plegada debajo.
11. **Studio**: render completo de fondo; tras 5 s sin actividad, pantalla completa sobre la app (se funde todo el cromo). Las barras `#spectrum` del mezclador se quedan.
12. **Simple**: render todo difuminado (estrellas incluidas) de fondo, con la canción en el medio.

## Lo que hace falta en el motor (Rust)

- Hoy `get_spectrum` (`src-tauri/src/lib.rs`) da **48 bandas logarítmicas**. Sirven para las tres energías, pero **no para el tono** de la Traza, que necesita los bins lineales de una FFT de 4096 con ventana Blackman.
- El **lookahead** exige analizar las muestras antes de que suenen: un tap del motor por delante del búfer del dispositivo, y conocer la latencia real (en compartido y en exclusivo).
- El prototipo saca el audio de WebAudio (`AnalyserNode` + `DelayNode` de 90 ms); en Enn eso lo sustituye el comando del motor.

## Estado

- [x] 2026-11-09 — Handoff revisado y archivado en la bóveda; decisiones tomadas.
- [x] 2026-11-09 — Motor: línea de retardo + latencia medida + anillo de análisis con reloj de muestras (`player.rs`, `exclusive.rs`).
- [x] 2026-11-09 — Analizador `src-tauri/src/viz.rs` + comando `get_viz_frame` (`lib.rs`).
- [x] 2026-11-09 — Cinta y Traza portadas a `ui/viz/` (WebGL2) e integradas (fondo, Simple difuminado, Studio con protagonismo, vista Ajustes).
- [x] 2026-11-09 — Verificado en la ventana nativa (ver «Verificación»).
- [ ] A ojo del propietario: el *feel* (cuánto difuminado, cuánto se mueve la Traza con el tono) y la sincronía real del pulso con el golpe.

## Cómo quedó implementado

**Motor (Rust)**
- `player.rs`:
  - El anillo de análisis pasa de 8192 a 65536 muestras, lleva un reloj de muestras (`spec_total`) y se llena ANTES de una línea de retardo estéreo bit-exacta.
  - Retardo = 90 ms − latencia del dispositivo, con un mínimo de 20 ms. Se fija en el primer callback tras abrir la salida.
  - La latencia se mide en cada callback: en CPAL con `OutputCallbackInfo` (inicio de la reproducción + duración del búfer); en exclusivo, con el tamaño del búfer WASAPI.
  - Volumen y balance se aplican después del retardo: responden al instante.
  - La posición que ve la UI (`audible_pos`) descuenta lo que sigue en la línea.
  - `get_spectrum` (las barras del mezclador) lee la ventana que suena ahora, no la adelantada.
- `viz.rs`:
  - FFT Blackman con magnitud |X|/N, como WebAudio. La ventana es de ~85 ms: 4096 muestras a 48 kHz, 8192 a 96 kHz y 16384 a 192 kHz.
  - Tres bandas con AGC, tono por producto armónico con interpolación parabólica, centroide y ataques por banda (umbral, refractario y peso del handoff).
  - Tiene 3 tests.
- `dsp.rs`: se extrajo `fft_in_place` para reutilizarla.
- `lib.rs`: el comando `get_viz_frame` devuelve `{la, n, tone, conf, cen, on, dt, play}`. La FFT se hace fuera del cerrojo del motor.

**UI (`ui/viz/`)**
- `common.js`:
  - resorte crítico, OKLab, compilación de shaders y mezclas premultiplicadas (canvas transparente: los halos del fondo siguen debajo);
  - `paletteFromCss()`: acento, acento 2, una sombra honda y el plateado; sin carátula, la paleta «Plata»;
  - `VizFeed`: un frame en vuelo como máximo, historial para los valores «que suenan» y ataques con su marca de tiempo.
- `traza.js` y `cinta.js` reproducen los prototipos (mismos GLSL, constantes y perfiles). Hay dos cambios:
  - el reloj es real y compartido;
  - los ataques los detecta Rust, y el pulso se programa en `t_recepción + la − 20 ms`.
- `index.js` es el controlador:
  - un canvas `#viz` sustituye a `#bg-visualizer` y `#np-spectrum`;
  - el bucle solo corre con la ventana visible, fuera del modo mini, y mientras suena algo o queda movimiento;
  - en Simple renderiza a ≤50 % de resolución, porque va difuminado;
  - gestiona el protagonismo de Studio (5 s, solo con música sonando, no con un campo enfocado ni con un menú abierto);
  - monta la vista Ajustes;
  - los ajustes se guardan en `localStorage["enn.viz"]`.
- `index.html`: el canvas `#viz`, el icono `i-settings`, el enlace «Ajustes» (sección «App» de la barra lateral) y la vista `#view-settings`.
- `styles.css`: `#viz`; en Simple, `blur(22px)` + `scale(1.06)`; `body[data-viz-takeover]` funde `#app` en 700 ms; estilos de Ajustes (`.seg`, `.viz-matrix`, `.set-*`).
- `app.js`: fuera el fondo de barras y el espectro de «Reproduciendo»; se añade la vista `settings` y la llamada `viz.setPlaying()` en `applyStatus`.
- `eslint.config.js` y `package.json` incluyen `ui/viz`.

## Verificación (2026-11-09)

- Puertas en verde:
  - `cargo fmt --check` y `clippy --all-targets -D warnings`;
  - **23/23 tests**, 4 nuevos: 3 de `viz.rs` y `output_delay_gives_the_analyzer_a_lookahead`;
  - ESLint y `node --check`.
- Ventana nativa, con volumen 0 (el análisis lee antes del volumen):
  - Simple: Traza difuminada detrás de la canción, con el verde de la carátula.
  - Studio: render nítido de fondo; a los 5 s quieto, pantalla completa.
  - Ajustes: cambio a Cinta en vivo, «Personalizar render» con medidores y deslizadores.
- Navegador con datos simulados: compilan los 10 programas de shader sin errores de consola; Simple, Studio, Ajustes y la matriz en un panel estrecho.

## Decisiones menores tomadas al implementar (revisables)

- Paleta: `[acento, acento 2, sombra honda del acento 2, plateado #BCC6D4]`; sin carátula, la «Plata» del handoff (#E8EAEE, #BCC6D4, #8A96A8).
- Protagonismo de Studio solo con música sonando. Con la música parada el render se frena y se queda quieto.
- Con «movimiento reducido» del sistema el render no se muestra (lo mismo que hacía el fondo viejo).
- En Simple la resolución se limita al 50 %: va difuminado y no se nota. El deslizador «Resolución» afecta a Studio.
- Del panel del prototipo no se pasó el editor de colores manual (los colores salen de la carátula, #88).

## Hallazgo: el modo exclusivo no actualizaba la tasa del motor — ✔ corregido 2026-11-09

`exclusive.rs` abre WASAPI a la tasa negociada (la nativa del archivo), pero **nunca escribe `Core.out_rate`/`out_channels`**; solo lo hace la ruta compartida (`audio_owner`).

Si el motor venía de 48 kHz y el exclusivo abre a 44,1 o 96 kHz:
- el remuestreador convierte a la tasa equivocada y la pista suena desafinada o a otra velocidad;
- el retardo del visualizador y los Hz del analizador quedan mal escalados.

**Corregido el 2026-11-09** por orden del propietario (ADR #98):
- Nuevo `Core::set_output_format(rate, channels)` en `player.rs`. Fija la tasa, los canales y la tasa del EQ, y redimensiona la línea de retardo.
- Si la tasa cambia con pistas ya cargadas, rehace sus remuestreadores (el mismo patrón que tras una búsqueda).
- Lo llaman los dos backends al abrir: `audio_owner` (compartido) y `exclusive::open`, con el formato negociado.
- Test `output_format_change_retunes_the_loaded_track`: pista de 48 kHz y dispositivo reabierto a 96 kHz → relación 0,5, avanza 0,1 s por cada 0,1 s de salida y el retardo queda bien escalado.
- **Falta comprobarlo de oído** con salida exclusiva en el hardware del propietario.

Cada avance se apunta también en [[Registro de cambios]] y en [[Kanban - Enn]].
