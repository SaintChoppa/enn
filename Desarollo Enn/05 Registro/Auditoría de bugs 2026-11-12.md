---
resumen: Auditoría del 2026-11-12: 5 bugs confirmados con prueba. Los 5 corregidos el mismo día con aprobación del propietario (ADR #144).
estado: cerrado
actualizado: 2026-11-12
tags: [enn, auditoria, bugs, calidad]
status: cerrado
created: 2026-11-12
updated: 2026-11-12
---

# Auditoría de bugs — 2026-11-12

> [!info] Qué es esta nota
> Registro **fechado** de los problemas encontrados en una auditoría real del código de Enn
> (lectura completa del núcleo Rust y de la UI, más `cargo test`, `node --check`, ESLint y un
> harness de verificación aislado para los bugs de lógica pura).
>
> **Revisor: bug-finder (Hermes)** · Fecha: 2026-11-12.
>
> **Ningún problema de esta lista se corrige sin aprobación del propietario** (regla de trabajo
> del proyecto). Las recomendaciones de arreglo son **orientativas**: son el diagnóstico de un
> revisor, **no** una instrucción que deba seguirse al pie de la letra.

## Contexto de la auditoría

| Dato | Valor |
|---|---|
| Fecha | 2026-11-12 |
| Revisor | bug-finder (Hermes) |
| Alcance | `src-tauri/src/*.rs` (incluye `ytmusic.rs`, nuevo), `ui/*` (incluye `search.js` y `select.js`, nuevos), `downloader.rs`, `lib.rs`, `plstores.rs` |
| Método | Lectura completa + `cargo test` (27/27 en verde) + `node --check` (8/8 OK) + ESLint (solo avisos `no-undef` en `dev-mock.js`, sin relevancia) + harness Rust aislado para los bugs de lógica |
| Cambios aplicados al código | **Ninguno** (solo se crea esta nota) |

**Estado verificado del código en esta fecha**

- `cargo test` → **27/27 en verde** (antes 19; ahora incluye crossfade C3, retardo de salida, cambio de tasa en caliente, parseo de ytmusic, etc.).
- `node --check` sobre `ui/*.js` y `ui/viz/*.js` → 8/8 OK.
- ESLint: sin errores en el código de la app (los 5 avisos son `no-undef` en `dev-mock.js`, que es un mock de desarrollo).

---

## Resolución — 2026-11-12

> [!success] Corregidos los 5 (aprobado por el propietario: «revísalos y arréglalos»)
> Sin commitear. `cargo fmt --check`, `cargo clippy -D warnings` y `cargo test` (29/29, +2 nuevos) en verde.

| # | Arreglo | Dónde |
|---|---|---|
| 1 | `CloseRequested` ya no llama a `shutdown()`. Además `ensure_worker` crea una **bandera de parada nueva** para cada trabajador, así que aunque se apague y se vuelva a encolar, el nuevo nace limpio | `lib.rs`, `downloader.rs` |
| 2 | Cerrar la ventana esconde en la bandeja y las descargas siguen en segundo plano; solo «Salir» las corta. Decidido después: cancelar o salir **borra los archivos a medias** (ADR #145) | `lib.rs` |
| 3 | `download_music` es `async` y el `enqueue`/`resolve_entries` va en `spawn_blocking`. `download_tracks` no se toca (no lanza yt-dlp) | `lib.rs` |
| 4 | El bucle salta la cabecera original (también con BOM). Test `remove_keeps_a_single_header` | `plstores.rs` |
| 5 | `h:mm:ss` desde 3600 s. Test `formats_hours` | `ytmusic.rs` |

No verificado a mano en la app: cerrar a la bandeja con una descarga en curso y pegar una lista grande (el #1 no tiene test: el descargador necesita un `AppHandle`).

## Resumen ejecutivo

| # | Severidad | Título | Verificado |
|---|---|---|---|
| 1 | 🔴 Alta | El descargador queda **muerto para siempre** tras cerrar la app a la bandeja | ✔ harness |
| 2 | 🟠 Media | Cerrar a la bandeja **mata las descargas en curso** (minimizar no debería cancelarlas) | ✔ lectura + mismo camino que #1 |
| 3 | 🟠 Media | `download_music` **congela la ventana** mientras resuelve una lista de reproducción | ✔ docs Tauri v2 |
| 4 | 🟡 Baja | `playlist_remove` escribe un encabezado `#EXTM3U` **duplicado** | ✔ harness |
| 5 | 🟡 Baja | Las duraciones ≥ 1 hora se muestran mal en el buscador (`60:00` en vez de `1:00:00`) | ✔ harness |

---

## 1. 🔴 El descargador queda muerto para siempre tras cerrar a la bandeja

- **Síntoma**: después de cerrar la ventana una sola vez (que la minimiza a la bandeja) y volver a abrirla, **ninguna descarga nueva arranca**: las tareas se quedan clavadas en «en cola» al 0 % hasta reiniciar la app.
- **Cómo se produce**:
  1. Cerrar la ventana (clic en ✕). `lib.rs:953-962` trata `CloseRequested` como «minimizar a la bandeja» pero llama a `downloader.shutdown()`.
  2. `shutdown()` (`downloader.rs:234-241`) pone `stop_flag = true` y suelta el canal (`tx = None`).
  3. Al encolar de nuevo, `ensure_worker()` (`downloader.rs:168-179`) ve `tx` vacío y **crea un worker nuevo**… pero el `stop_flag` **nunca se resetea a `false`** (no hay ningún sitio del código que lo haga).
  4. El worker nuevo arranca con `stop = true` y en `worker_loop` (`downloader.rs:245-248`) hace `break` **en el primer job**, sin procesar nada.
- **Cuándo**: siempre, tras el primer cierre a la bandeja; irreparable sin reiniciar la app.
- **Dónde**: `downloader.rs:83` (inicialización), `:168-179` (`ensure_worker`), `:234-241` (`shutdown`), `:244-248` (`worker_loop`); disparado desde `lib.rs:953-962`.
- **Comprobado**: ✔ con un harness Rust aislado que replica el estado `stop_flag`/`ensure_worker`/`worker_loop`/`shutdown` — tras `shutdown()` el job nuevo nunca llega a procesarse. No depende de la red ni de yt-dlp.
- **Recomendación (orientativa, no seguir al pie de la letra)**: distinguir «minimizar a la bandeja» de «cerrar de verdad». En `CloseRequested` no llamar a `shutdown()` (o que `shutdown()` no mate el descargador); reservar `shutdown()` para «Salir» del menú de la bandeja. Además, si `shutdown()` va a poder reutilizarse, habría que resetear `stop_flag = false` en `ensure_worker` o no dejar que el worker arranque con el flag en `true`.

---

## 2. 🟠 Cerrar a la bandeja mata las descargas en curso

- **Síntoma**: con una descarga (o varias) en marcha, cerrar la ventana cancela todas las descargas activas. La tarea en curso pasa a «error: descarga cancelada» y puede quedar un **archivo parcial** en la carpeta de destino.
- **Cómo se produce**: el mismo `CloseRequested` de #1 llama a `shutdown()` (`lib.rs:959`), que recorre `children` y hace `kill()` a cada proceso yt-dlp vivo (`downloader.rs:238-240`).
- **Cuándo**: siempre que se cierra la ventana (minimiza a bandeja) mientras hay descargas corriendo.
- **Dónde**: `lib.rs:953-962` + `downloader.rs:234-241`.
- **Comprobado**: por lectura del código (es el mismo camino que #1); el `kill()` del hijo y el abandono del canal son inequívocos. El archivo parcial no se limpia (no hay `remove_file` en la ruta de cancelación).
- **Recomendación (orientativa)**: en un reproductor, minimizar a la bandeja no debería detener descargas (lo normal es que sigan en segundo plano). Mover la lógica de apagado a «Salir» únicamente, y/o limpiar el archivo parcial al cancelar.

---

## 3. 🟠 `download_music` congela la ventana mientras resuelve una lista

- **Síntoma**: al pegar un enlace de lista de reproducción (playlist de YouTube, set de SoundCloud, álbum de Bandcamp…) y pulsar Descargar, **la ventana se queda congelada** (sin responder) durante el tiempo que tarda yt-dlp en resolver la lista.
- **Cómo se produce**: `download_music` (`lib.rs:764-796`) es un comando **síncrono** (`#[tauri::command]` sin `async`). Llama a `enqueue()` → `resolve_entries()` (`downloader.rs:398-451`), que ejecuta yt-dlp `--flat-playlist` con `cmd.output()` y **espera a que termine** en el mismo hilo.
- **Cuándo**: cada descarga de una URL que yt-dlp tenga que resolver (lista grande = varios segundos). Una URL de vídeo suelto también pasa por `resolve_entries`, así que el coste existe siempre, aunque es más visible con listas.
- **Dónde**: `lib.rs:764-796` y `downloader.rs:398-451`.
- **Comprobado**: ✔ por la documentación oficial de Tauri v2 — *«Commands without the async keyword are executed on the main thread»* — y por el propio patrón del proyecto: `music_search`, `music_album` y `music_artist_photo` ya son `async` + `spawn_blocking` (`lib.rs:800-832`) precisamente para no bloquear, pero `download_music` no lo es.
- **Recomendación (orientativa)**: convertir `download_music` (y si procede `download_tracks`, que no resuelve pero sí encola) a `async` y ejecutar `enqueue`/`resolve_entries` dentro de `tauri::async_runtime::spawn_blocking`, como ya hacen los comandos de búsqueda.

---

## 4. 🟡 `playlist_remove` escribe un encabezado `#EXTM3U` duplicado

- **Síntoma**: al quitar una canción de una playlist, el archivo `.m3u8` acaba con **dos** líneas `#EXTM3U` al principio. Funcionalmente es inocuo (los reproductores tratan `#EXTM3U` como comentario), pero el archivo queda mal formado y el encabezado se acumula visualmente.
- **Cómo se produce**: `plstores::remove` (`plstores.rs:153-184`) inicializa `out` con `String::from("#EXTM3U\n")` (línea 156) y, al recorrer las líneas existentes, **también copia la línea `#EXTM3U` original** al final del bucle (línea 176). Resultado: dos encabezados.
- **Cuándo**: en cada `playlist_remove` sobre una playlist no vacía.
- **Dónde**: `plstores.rs:153-184` (en concreto 156 + 176).
- **Comprobado**: ✔ con harness Rust aislado: al quitar la única pista de `#EXTM3U\n#EXTINF:…\nC:\…\n`, el resultado es `#EXTM3U\n#EXTM3U\n` (2 encabezados).
- **Recomendación (orientativa)**: no sembrar `out` con `#EXTM3U\n` y a la vez copiar la línea de cabecera; o saltar la línea `#EXTM3U` en el bucle, o inicializar `out` vacío y dejar que el bucle escriba el encabezado existente (añadiéndolo solo si falta).

---

## 5. 🟡 Las duraciones ≥ 1 hora se muestran mal en el buscador

- **Síntoma**: en los resultados de búsqueda de YouTube Music, una pista de 1 hora (mix, set en vivo, DJ set, podcast) se muestra como **`60:00`** en vez de `1:00:00`; una de 2 horas, como `120:00`.
- **Cómo se produce**: `ytmusic::fmt_secs` (`ytmusic.rs:379-382`) hace `format!("{}:{:02}", s/60, s%60)`, que no añade la parte de horas. `fmt_secs(3600)` → `"60:00"`.
- **Cuándo**: cuando el backend de yt-dlp devuelve un `duration` ≥ 3600 s (cae en el respaldo `ytdlp_songs`, ya que la interfaz `youtubei` devuelve duraciones con hora en otro formato).
- **Dónde**: `ytmusic.rs:379-382`.
- **Comprobado**: ✔ con harness Rust aislado: `fmt_secs(3600)` = `"60:00"`, `fmt_secs(5400)` = `"90:00"`.
- **Recomendación (orientativa)**: formatear con horas cuando `s >= 3600` (p. ej. `h:mm:ss`), o reutilizar el formateador de tiempo de la UI, que ya contempla el caso.

---

## ✅ Lo que está bien (verificado, no sospecha)

- **Núcleo de audio**: 27/27 tests en verde; el crossfade (C3) con promoción de la pista preparada, la línea de retardo de salida (ADR #93) y el cambio de tasa en caliente tienen cobertura específica.
- **Seguridad del descargador**: `is_valid_download_url` sigue cerrando la vía de inyección de argumentos en yt-dlp (exige `http(s)://` literal y sin espacios), y la validación está doblemente aplicada (en el comando y en `enqueue`).
- **Resolución de listas**: `--flat-playlist` + tope `MAX_PLAYLIST_ITEMS = 500` evita encolar una lista gigante por accidente.
- **`search.js`**: el guardado de `seq` descarta respuestas viejas si se escribe más rápido que la red, y la re-búsqueda al recuperar conexión está bien razonada.
- **`select.js`**: el despliegue propio con Popover API y el teclado completo está bien implementado (no hay bucles infinitos en `step`, acotado por `n`).

---

## Notas del revisor

- Los bugs #1 y #2 comparten la misma raíz (`shutdown()` invocado en `CloseRequested`); se han separado porque tienen síntomas distintos (descargador permanentemente roto vs. descargas en curso canceladas) y arreglos que conviene sopesar por separado.
- Ningún cambio fue aplicado al repositorio. El harness de verificación vive en el directorio de caché del revisor (`enn_bug_harness.rs`), fuera del proyecto.
