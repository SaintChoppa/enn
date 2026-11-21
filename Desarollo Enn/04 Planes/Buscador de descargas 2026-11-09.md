---
resumen: Especificación aprobada del buscador del descargador (YouTube Music en tiempo real, pastillas, álbumes, barras de progreso) y del ajuste de texto de la telemetría; estado.
estado: vivo
actualizado: 2026-11-09
tags: [enn, plan, descargas, ui]
---

# Buscador de descargas — 2026-11-09

Petición del propietario del 2026-11-09. Aceptó todas las opciones recomendadas y además pidió álbumes, pastillas, barras de progreso y carga en esqueleto (ADR #112–#119 en [[Decisiones de desarrollo]]).

## Comportamiento

- **Una sola barra** en Descargas.
  - Si el texto parece un enlace (empieza por `http`, `www.` o contiene `://` o un dominio como `youtu.be`), el botón dice **Descargar** y descarga directamente, sin buscar.
  - Si no, el botón dice **Buscar** y, 0,35 s después de dejar de escribir, se despliega la lista de resultados.
- **Botón** blanco plateado con un brillo suave constante que se intensifica al pasar el ratón (es el mismo botón en los dos estados).
- **Fuente de búsqueda**: YouTube Music consultado directamente desde Rust (interfaz interna `youtubei`, cliente `WEB_REMIX`; ~0,6–0,8 s). Si falla, se recurre a **yt-dlp**: primero la búsqueda de YouTube Music y después `ytsearch` de YouTube. No se envía ningún dato del usuario: solo el texto buscado y el idioma `es`.
- **Resultados**:
  - 8 canciones como **pastillas**: carátula, título, artista · álbum, duración y botón de descarga. Pulsar la pastilla también descarga.
  - **Álbumes oficiales mezclados** como pastillas más grandes. Solo álbumes cuyo artista es un canal oficial de artista y coincide con el artista buscado o con los de las canciones.
  - Primero aparecen los textos; las carátulas entran después con un fundido.
- **Mientras busca**: pastillas en **esqueleto** con un brillo que las recorre.
- **Álbum**: al pulsarlo, la lista se cambia por el álbum, con una flecha para volver, la portada, el artista y el año. Sus canciones son pastillas con casilla, todas marcadas, y hay dos botones: **Descargar seleccionadas** y **Todo el álbum**.
- **Ya en tu biblioteca**: una marca en los resultados que coinciden con algo de la biblioteca.
- **Progreso**: una fila de barras finas de alturas aleatorias que ondulan en la parte inferior de cada pastilla. Se encienden de izquierda a derecha según el porcentaje descargado; al terminar queda ✓.
- **Sin conexión**: aparece el mensaje «Sin conexión a internet: conéctate para buscar y descargar». Al volver la conexión, la búsqueda se repite sola.

## Telemetría de Studio

Los valores que no caben (p. ej. «Compartida») **reducen la fuente** hasta caber completos, con un mínimo de 10 px. Ya no se cortan con «…».

## Estado

- [x] Motor: `src-tauri/src/ytmusic.rs` (búsqueda, álbum y respaldo con yt-dlp, con `CREATE_NO_WINDOW` en Windows), los comandos `music_search` / `music_album` (asíncronos) / `download_tracks` en `lib.rs`, y `Downloader::enqueue_known` en `downloader.rs`. Dependencia `ureq` 2.12 (rustls).
- [x] Tests: 3 unitarios del análisis del JSON y una prueba contra la red real (`cargo test ytm_live -- --ignored`): «bad bunny» devuelve canciones con artista, álbum y duración, y los álbumes «Un Verano Sin Ti» y «DeBÍ TiRAR MáS FOToS»; el álbum abre sus 23 pistas.
- [x] UI: `ui/search.js` (barra única, pastillas, esqueleto, álbum, barras, sin conexión, «Ya en tu biblioteca») + estilos al final de `styles.css` y `#dl-results` en `index.html`.
- [x] Telemetría con ajuste de texto (`fitTelemetry()` en `app.js`).
- [x] Verificado en la ventana nativa: búsqueda real con esqueleto → resultados mezclados con carátulas, álbum abierto con 23 pistas y cambio del botón a «Descargar» al pegar un enlace.
- [x] Verificado en el navegador con datos simulados: barras de progreso encendiéndose con el %.
- [ ] Sin probar: una descarga real desde el buscador (no se descargaron archivos a la carpeta del propietario) y el aviso sin conexión con la red cortada de verdad.
