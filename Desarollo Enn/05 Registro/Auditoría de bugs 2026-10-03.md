---
resumen: Auditoría del 2026-10-03: bugs con prueba y estado de corrección. Leer solo si se toca uno de ellos.
estado: histórico
actualizado: 2026-11-09
tags: [enn, auditoria, bugs, calidad]
status: abierto
created: 2026-10-03
updated: 2026-10-03
---

# Auditoría de bugs — 2026-10-03

> [!info] Qué es esta nota
> Registro **fechado** de los problemas encontrados en una auditoría real del código de Enn
> (lectura completa del núcleo Rust, la UI, la CI y la configuración, más compilación,
> tests y una prueba de la interfaz en un navegador real).
>
> **Ningún problema de esta lista se corrige sin aprobación del propietario** (regla de trabajo
> del proyecto). Estado a 2026-10-03: **los 14 puntos están arreglados y verificados** — #1, #2,
> #3, #4, #5, #6, #7, #8, #9, #10 (más el extra de separar los `.peaks` del tope de carátulas),
> #11, #12, #13 y #14. Las cuatro decisiones que quedaron abiertas las resolvió **Jev**
> (System One) por delegación expresa del propietario; ver [[#Decisiones tomadas]].
> El detalle de cada corrección, con su prueba, está en [[#Registro de correcciones]].
>
> ⚠ **Sigue en pie una cosa**: el rediseño «Obsidian Hi-Fi» y estos arreglos están **sin
> commitear** (instrucción expresa del propietario: «no hagas commit por ahora»). La rama
> `claude/project-review-964ba7` apunta al mismo commit que `master`, así que **nada de esto está
> respaldado en git todavía**.

## Contexto de la auditoría

| Dato | Valor |
|---|---|
| Fecha | 2026-10-03 |
| Alcance | `src-tauri/src/*.rs` (12 módulos), `ui/*`, `build.rs`, `tauri.conf.json`, `capabilities/`, `package.json`, `ci.yml`, `.gitignore`, README y esta bóveda |
| Método | Lectura completa + ejecución real: `cargo test`, `cargo fmt --check`, `cargo clippy`, `node --check`, ESLint y la UI servida por HTTP con un `__TAURI__` simulado |
| Cambios aplicados al código | **Ninguno** (solo se creó esta nota) |
| Commits | Ninguno, por instrucción explícita |

**Estado verificado del código en esta fecha**

- `cargo test` → **19/19 tests en verde** (incluye `audio_smoke` real con tarjeta de sonido).
- `cargo fmt --check` → limpio.
- `cargo clippy --all-targets -- -D warnings` → limpio.
- `node --check ui/app.js ui/palette.js` → OK. ESLint → sin hallazgos.
- La UI arranca sin errores de consola y renderiza (10 bandas de EQ, biblioteca, colas).

> [!warning] Matiz importante sobre lo anterior
> Todo eso es cierto **solo** usando `CARGO_TARGET_DIR=D:\enn-target` (lo que hace `dev.ps1`).
> Con el `target\` que vive dentro del repo, cualquier comando de cargo falla — problema #1.

## Resumen ejecutivo

| Bloque | Cuántos | Ejemplos |
|---|---|---|
| 🔴 Rompe un flujo real (build / descarga / layout) | 4 | #1 target estancado, #2 progreso de descarga congelado, #3 `tw-output.css` fuera de git, #4 barra de pestañas vieja visible |
| 🟠 Bugs de código concretos | 9 | #7 error de audio descartado, #8 análisis ReplayGain que nunca "termina", #9 `PATH` roto fuera de Windows, #10 caché O(n) por imagen |
| 🟡 Deuda menor / rendimiento | 4 | #11 carátula recalculada 4×/s, #12 inversión de locks, #13 CI que enmascara clippy, #14 `.gitignore` inútil |
| 📄 Bóveda desincronizada con el código | 6 afirmaciones | perillas del Modo Simple, widget de caché, Material Symbols, Inter, build de Tailwind, Opus |

---

## 1. 🔴 El proyecto no compila con cargo "a pelo"

- **Síntoma**: `cargo test` (y `check`, `build`, `clippy`) dentro de `src-tauri\` muere en el
  build script de Tauri con `failed to read plugin permissions: … os error 3`.
- **Causa**: `src-tauri\target\` (**12 GB**) contiene artefactos generados cuando el proyecto
  vivía en `…\Reproductor de musica`. Llevan rutas absolutas grabadas dentro, y el build
  script de Tauri intenta leer ficheros de esa ruta inexistente.
- **Dónde**: `src-tauri\target\` (no versionado, pero presente en disco).
- **Comprobado**: ✔ reproducido. Con `CARGO_TARGET_DIR=D:\enn-target` compila y pasan 19/19.
- **Arreglo propuesto (sin aplicar)**: borrar `src-tauri\target\` y fijar `CARGO_TARGET_DIR`
  en `src-tauri\.cargo\config.toml`, para que valga igual con o sin `dev.ps1`
  (`dev.ps1` seguiría funcionando).
- **Nota**: explica también por qué la bóveda sigue citando la carpeta vieja (ver sección 📄).

## 2. 🔴 El progreso de las descargas nunca se mueve — ✔ corregido 2026-10-03

- **Síntoma**: la barra y el chip se quedan en `0%` durante toda la descarga, aunque el
  backend informe del avance real.
- **Causa (dos fallos que se suman)**:
  1. `j.pct` **nunca recibe** `progress_percent`; el valor se guarda en `j.targetPct`
     (`ui/app.js:2346`) mientras el render lee `j.pct` (`ui/app.js:2189` barra, `:2216` chip).
     Además, un cambio de progreso no marca `changed`, así que la lista ni se vuelve a pintar.
  2. `animateDlBars()` (`ui/app.js:2375-2387`) — el único que lee `targetPct` — sale en el
     primer fotograma porque `dlClosed` es `true`, y **no vuelve a armar el `requestAnimationFrame`**:
     el bucle está muerto para siempre tras el arranque.
- **Dónde**: `ui/app.js:2189, 2216, 2346, 2375-2387`.
- **Comprobado**: ✔ en navegador. Con el backend devolviendo 12 → 24 → 36 … → 95 %, la barra
  midió `0%` y el chip `0%` en 6 muestras repartidas en 4 s.
- **Arreglo propuesto (sin aplicar)**: una sola fuente de verdad para el porcentaje
  (`pct`), marcar `changed` en cada avance y rearmar el bucle de animación al entrar en la vista.

## 3. 🔴 `ui/tw-output.css` no está en git y nada lo genera — ✔ corregido 2026-10-03

- **Síntoma**: `index.html` carga `tw-output.css`, pero es un artefacto **generado**, no
  trackeado (`git ls-files ui` → solo `app.js`, `index.html`, `styles.css`), **no ignorado**
  por `.gitignore` y **sin ningún script que lo produzca**.
- **Causa**: `package.json` no tiene `build:css`/`watch:css` ni `tailwindcss`/`@tailwindcss/cli`
  en `devDependencies` (y `package-lock.json` no los menciona: `npm ci` no los instala).
  `tauri.conf.json` no tiene `beforeDevCommand`/`beforeBuildCommand`. La CI tampoco lo construye.
  El único rastro del proceso es un comentario en `ui/tw-input.css:19` con el `npx tailwindcss`
  manual. En `node_modules` sí están (instalados a mano en su día).
- **Dónde**: `package.json`, `package-lock.json`, `tauri.conf.json`, `.gitignore`.
- **Comprobado**: ✔ (`git ls-files`, `grep` en el lock, inspección de la config).
- **Riesgo real**: si se commitea el `index.html` nuevo sin ese fichero, cualquier clon queda
  sin utilidades de Tailwind → el shell se desarma (verificado que hoy sí se aplican:
  `bg-surface/85`, `gap-3.5`, etc.).

## 4. 🔴 La barra de pestañas vieja (`#view-tabs`) se sigue viendo — ✔ corregido 2026-10-03

- **Síntoma**: sobre la biblioteca aparece una fila de pestañas horizontales duplicando la
  navegación del menú lateral, con `Todas · Por artista · Por género …`.
- **Causa**: en el HTML lleva el atributo `hidden` (`ui/index.html:161`), pero el CSS
  `#view-tabs { display: flex }` (`ui/styles.css:200`) gana sobre `[hidden]`.
- **Comprobado**: ✔ en navegador, en la vista de biblioteca: `display:flex`, **322 × 89 px**
  visibles.
- **Arreglo propuesto (sin aplicar)**: `#view-tabs[hidden] { display: none }` o retirar el
  marcado de las pestañas (la UI ya no las usa como tales).

## 5. 🟠 `ui/fonts/` (4,4 MB) no lo carga nadie

- **Síntoma**: el proyecto trae Inter (4 pesos × latin/latin-ext) y Material Symbols Outlined
  (~4 MB), pero se sirve con **Segoe UI Variable** y los iconos que se ven son un sprite SVG propio.
- **Causa**: `ui/fonts/fonts.css` no está enlazado en `index.html` ni importado desde
  `styles.css`; la familia tipográfica real está en `ui/styles.css:108`.
- **Comprobado**: ✔ `document.fonts` vacío en la UI servida; `grep` sin referencias a
  `fonts.css` en todo `ui/`.
- **Decisión pendiente**: enlazarlo (y migrar iconos) **o** borrar los ficheros. Hoy es peso
  muerto en un repo de portafolio.

## 6. 🟠 Se documenta soporte Opus que no existe

- **Síntoma**: README y bóveda venden Opus entre los formatos soportados.
- **Causa**: Symphonia 0.5.5 (versión fijada en `Cargo.toml:29`) **no incluye decodificador Opus**
  — en el registro local solo hay `aac, adpcm, alac, pcm, vorbis, mp3/flac`. Además
  `decode.rs:15-17` (`SUPPORTED_EXT`) no incluye `.opus`, así que ni se indexa; un `.ogg`
  con Opus dentro sí pasa el filtro de extensión y luego falla al decodificar (cuenta como error).
- **Comprobado**: ✔ contra el registro de crates local.
- **Arreglo propuesto (sin aplicar)**: quitar Opus de README/bóveda, o evaluar otra librería
  si de verdad se quiere soportar.

## 7. 🟠 Un error de audio puede perderse silenciosamente

- **Dónde**: `player.rs:1120-1130` (`reporter_loop`).
- **Causa**: el error se extrae del `Core` con `take()` **antes** de decidir si hay evento;
  si hay evento pendiente, la rama hace `continue` y el error ya extraído se descarta
  (nunca llega a `enn://error`).
- **Comprobado**: por lectura del código (no reproducible a voluntad).
- **Nota**: el sondeo de `get_state` cada 250 ms suele tapar el hueco, pero no siempre.

## 8. 🟠 El análisis ReplayGain puede no terminar nunca en la UI

- **Dónde**: `lib.rs:329-350` (`rg_scan_start`).
- **Causa**: si el fichero de una pista pendiente ya no existe, el `continue` (líneas 331-333)
  salta **también el `emit`** de progreso. Si es la última, `finished` no llega jamás: la UI se
  queda en «Analizando… (N−1)/N» con el botón deshabilitado hasta reiniciar.
- **Arreglo propuesto (sin aplicar)**: filtrar `is_file` al construir `pending` (el contador
  se vuelve exacto) o emitir progreso antes del `continue`.

## 9. 🟠 `PATH` con separador equivocado fuera de Windows

- **Dónde**: `downloader.rs:375` y `:478`.
- **Causa**: `cmd.env("PATH", format!("{};{}", dir, old))` usa `;` fijo. En Linux/macOS eso
  corrompe el `PATH` de yt-dlp justo cuando hay un ffmpeg en el `PATH` (que es el caso normal
  fuera de Windows). El resto del mismo fichero sí usa el separador por plataforma
  (`yt_dlp_path`, `ffmpeg_path`).
- **Comprobado**: por lectura; relevante para el objetivo de portabilidad a Linux.

## 10. 🟠 La poda de la caché corre en cada escritura (y mezcla tipos)

- **Dónde**: `art.rs:167-189` (`prune`), invocada en `art.rs:127` y `:160` tras **cada** escritura.
- **Causa**: recorre el directorio completo cada vez → O(n) por imagen (miles de `read_dir`
  durante el escaneo de una biblioteca grande). Y el tope de 1500 cuenta **carátulas y `.peaks`
  de waveform juntas** (comparten `art_dir`), así que las ondas pueden ser desalojadas por
  portadas nuevas (y obligan a recalcular).
- **Arreglo propuesto (sin aplicar)**: podar con menos frecuencia (cada N escrituras o una vez
  al terminar la vista) y/o separar los contadores por tipo de fichero.

## 11. 🟡 La carátula del sistema se recalcula 4 veces por segundo

- **Dónde**: `media_keys.rs:90-97`.
- **Causa**: el comentario dice «carátula solo cuando cambia la pista», pero `cached_cover_url()`
  se llama en cada vuelta del bucle (250 ms) → `fs::metadata` + hasta 4 `is_file()` por vuelta
  mientras suena algo.
- **Arreglo propuesto (sin aplicar)**: moverlo dentro del bloque `if track_key != last_track`.

## 12. 🟡 Inversión de cerrojos (y dos detalles del modo exclusivo)

- **Dónde**: `player.rs:923-930` (toma `desired_rate` → `streams`) frente a
  `player.rs:838-851` (`ensure_streams`, toma `streams` → `desired_rate`).
- **Causa**: si el hilo supervisor de reconexión y un comando de UI coinciden con la salida
  exclusiva activa, hay riesgo de interbloqueo.
- **Extras del modo exclusivo** (`exclusive.rs`): `let avail = buffer_frames - padding;` (línea 184)
  resta `u32` sin proteger (underflow ⇒ pánico en debug, y el canal `ok_tx` no responde);
  y si `core.lock()` falla (líneas 198-218) se llama `ReleaseBuffer` de un búfer sin rellenar.

## 13. 🟡 La CI enmascara los fallos de clippy

- **Dónde**: `.github/workflows/ci.yml:38-40`.
- **Causa**: `cargo clippy -- -D warnings || cargo check` — el `||` convierte un fallo de clippy
  en un éxito (basta con que `cargo check` pase). No hay paso de `cargo fmt --check` ni de
  build del CSS, aunque `CONTRIBUTING.md` y la bóveda afirman que sí.
- **Comprobado**: ✔ por lectura del workflow.

## 14. 🟡 Detalles menores de configuración y datos

- `.gitignore`: `*.exe` + `!src-tauri/target/**/*.exe` no sirve de nada (git no re-incluye
  ficheros dentro de un directorio ignorado, y `src-tauri/target/` ya está ignorado).
- `dlJobs` se indexa por los **primeros 46 caracteres** de la URL (`ui/app.js:2319`): dos vídeos
  cuyos enlaces coincidan hasta ahí se pisarían en la lista de descargas.
- `get_state` calcula `bitrate_kbps` con `std::fs::metadata` en **cada** sondeo de 250 ms.
- `cache_stats` (Rust) existe y **no se llama desde ninguna parte** de la UI (ver sección 📄).

---

## 📄 La bóveda dice cosas que el código no tiene

Encontrado al leer esta bóveda contra el código real. Nada de esto está en disco **ni en
ninguna rama de git** (la rama `claude/project-review-964ba7` está en el mismo commit que `master`):

| Afirmación de la bóveda | Realidad en el código |
|---|---|
| Mezclador Simple con **perillas** Graves/Medios/Agudos y 4 perfiles rápidos, incluido «Natural» (Decisión #76-77) | No existe: `ui/index.html` trae sliders (`mix-bass`, `mix-treble`) y `PRESETS` (`ui/app.js:14`) no tiene «Natural» |
| **Widget de caché** en la barra lateral usando el comando `cache_stats` (Decisión #79) | `cache_stats` existe en Rust (`lib.rs`) y **nadie lo invoca**; el menú lateral no tiene ese widget |
| Iconografía **Material Symbols Outlined** (Decisión #81) | El marcado usa un **sprite SVG propio** (`#i-*`) |
| Fuentes **Inter** autoalojadas en uso (Decisión #80) | No se cargan (ver #5): se sirve Segoe UI |
| `beforeDevCommand`/`beforeBuildCommand` + `npm run build:css` + `tw-output.css` en `.gitignore` (Decisión #64) | Nada de eso está en `package.json`/`tauri.conf.json`/`.gitignore` (ver #3) |
| «9 tests de Rust en verde» y proyecto en `…\Reproductor de musica` | Son **19 tests**, y el proyecto está en `…\Enn` (la ruta vieja es la que rompe el build, ver #1) |

**Consecuencia**: la bóveda es una pieza de portafolio valiosa, pero hoy describe una versión
distinta de la que está en disco. Conviene o implementar lo que falta, o marcarlo como
«planeado» para que la documentación no mienta.

## ✅ Lo que está bien (verificado, no sospecha)

- **Núcleo de audio**: 19/19 tests, `fmt` y `clippy -D warnings` limpios; el resampler
  polifásico, el crossfade equal-power y la recuperación de dispositivo en caliente tienen
  cobertura o están bien razonados.
- **Seguridad**: la validación de URLs contra inyección de argumentos en yt-dlp es correcta y
  está doblemente aplicada; el permiso de `capabilities/default.json` sí es mínimo.
- **UI de la nueva shell**: arranca sin errores, el layout de rejilla funciona, Tailwind aplica
  bien sus utilidades y el color reactivo de la carátula llega al DOM.
- **`ui/dev-mock.js`**: útil, pero **no está enlazado en `index.html`**; para usarlo hay que
  añadir el `<script>` a mano (o servir la carpeta por HTTP: con `file://` los ES modules no cargan).

## 🗑️ Ya resuelto por el propietario (2026-10-03)

- ~~`scrape_eddcabarcas.py` en la raíz del repo~~ → retirado por el propietario en esta fecha
  (verificado: ya no está). No era parte de Enn y sobraba en un repo de portafolio.

## Decisiones tomadas (2026-10-03)

**Aprobadas por el propietario:**

1. **Orden de trabajo**: #2 → #4 → #3 → #8 → #7 → #9 → #11 → #10 → #5/#6 → #13 → #1. Se ejecutó en ese orden.
2. **Borrar `src-tauri\target\`** (solo caché de compilación): sí — hecho, 12 GB liberados.
3. **Enlazar esta nota desde `00 Índice.md`**: sí — hecho.
4. **Marcar lo no implementado** en las notas de la bóveda: sí — hecho en `Características actuales`, `Arquitectura` y `Decisiones de desarrollo`, más la corrección de la ruta vieja del índice y del «9 tests → 19».
5. **Sin commits**: instrucción expresa, respetada en todo el trabajo.

**Delegadas a Jev** (TypeSafe System One, `jev-1.13.0`), porque el propietario prefirió no decidirlas:

| Decisión | Elección de Jev | Confianza |
|---|---|---|
| Config de `CARGO_TARGET_DIR` | `src-tauri/.cargo/config.toml` **sin versionar** (añadido a `.gitignore`) | 0,97 |
| Fuente Material Symbols (~4 MB que nunca se descargaba) | **borrar** el `.woff2`, su `@font-face` y sus clases | 0,98 |
| Detalles menores (#14) | **arreglar los tres** | 0,61 (prob. 0,75) |
| Registro en el ADR | **una fila resumen (#83)** | 0,27 ⚠ — la segunda opción («una fila por arreglo») sacó 0,44, así que esta decisión es la menos segura de las cuatro |

## Registro de correcciones

| Fecha | Ítem | Qué se cambió | Verificación |
|---|---|---|---|
| 2026-10-03 | #2 progreso de descargas | `ui/app.js`: el avance pasa a tener **una sola fuente** (`j.pct`/`j.targetPct`), el chip `%` y la barra se actualizan en sitio desde el bucle de suavizado, y el bucle (`dlBarsStep`/`dlBarsKick`) **se enciende y se apaga solo** en vez de morir en el primer fotograma. Extra aprobable/revertible: el estado `convirtiendo` ya no dice «en cola» | ✔ en navegador (HTTP + `__TAURI__` simulado): la barra interpola 3,4 % → 9,1 % → 16,7 % → 25,4 % → 45,4 % → 100 %, el chip la sigue hasta `✓`, cero errores de consola y **los rAF armados quedan planos (25→25→25) tras terminar** |
| 2026-10-03 | #4 pestañas viejas | `ui/styles.css`: nueva regla `#view-tabs[hidden] { display: none }` para que el atributo del marcado gane sobre `display:flex` | ✔ en navegador: en la vista de biblioteca, `#view-tabs` pasa de **322 × 89 px visibles** a `display:none` |
| 2026-10-03 | #3 Tailwind fuera de git (Opción A, aprobada por el propietario) | `package.json`: `tailwindcss` + `@tailwindcss/cli` en `devDependencies` (4.3.3, las que ya tenía `node_modules`) y scripts `build:css`/`watch:css`; `tauri.conf.json`: `beforeDevCommand` (con `wait: true`) y `beforeBuildCommand`; `.gitignore`: `ui/tw-output.css`; comentario de `ui/tw-input.css` actualizado a los scripts | ✔ `npm run build:css` regenera el CSS en 54 ms y **reproduce el archivo byte a byte** (10434 B, `diff -q` idéntico); `git check-ignore` confirma que ya está ignorado; `npm ci --dry-run` sin errores de sincronía; UI revalidada en navegador (Tailwind aplica: `flex`/`gap 14px`/fondo translúcido, 10 bandas de EQ, sin errores) |
| 2026-10-03 | Correcciones factuales de la bóveda (aprobadas) | `00 Índice.md` (ruta vieja → `…\Escritorio\Enn`), `Propuestas de implementación.md` (9 → **19** tests), `Arquitectura.md` (ids reales del shell, `#view-tabs`, fuentes y `dev-mock` marcados), `Características actuales.md` (⚠ PENDIENTE en perillas/caché/reactor/VU/iconos/fuentes; tema oscuro único), `Decisiones de desarrollo.md` (aviso sobre #66/#68/#70/#76/#77/#79/#80/#81/#82) | ✔ por lectura del código + los `grep` que confirman la ausencia (0 coincidencias de `reactor`, `VU`, `cache_stats`, `Material`, `knob`, `mixer-simple`, `natural`) |
| 2026-10-03 | #8 el análisis ReplayGain podía no «terminar» | `lib.rs` (`rg_scan_start`): `pending` filtra por `is_file()` (contador exacto) y el progreso se emite **aunque** un archivo desaparezca a mitad (antes el `continue` se comía el `emit` y `finished` no llegaba nunca) | ✔ `cargo test` 19/19 · `cargo fmt --check` limpio · `clippy --all-targets -D warnings` limpio |
| 2026-10-03 | #7 un error de audio podía perderse | `player.rs` (`reporter_loop`): el error se emite **antes** de la rama de eventos (el `continue` descartaba el valor ya extraído del `Core`) | ✔ compila y pasa la suite (no reproducible a voluntad: requeriría un fallo de dispositivo justo en el mismo tick) |
| 2026-10-03 | #9 `PATH` con separador `;` fijo | `downloader.rs`: separador por plataforma (`;` en Windows, `:` fuera) en los **dos** sitios que anteponen la carpeta de ffmpeg al `PATH` de yt-dlp | ✔ idem (19/19, fmt, clippy) |
| 2026-10-03 | #11 carátula del sistema recalculada 4 veces por segundo | `media_keys.rs`: el cálculo de la carátula se movió **dentro** del bloque «cambió la pista» (el comentario ya decía eso; el código no lo hacía) | ✔ idem |
| 2026-10-03 | #10 poda de caché O(n) en cada escritura | `art.rs` (`prune`): la poda se ejecuta cada 128 escrituras en vez de en cada una (seguía recorriendo el directorio entero con su `read_dir` + `sort`) | ✔ idem |
| 2026-10-03 | #10 extra: `.peaks` fuera del tope de carátulas (aprobado) | `art.rs` (`prune`): se saltan los `.peaks` de waveform, así una portada nueva ya no puede desalojar una onda ya calculada | ✔ idem |
| 2026-10-03 | #5 fuentes autoalojadas sin usar (aprobado: enlazarlas) | `ui/index.html`: `<link rel="stylesheet" href="fonts/fonts.css">`; `ui/styles.css`: `"Inter"` primero en la pila tipográfica del `body` | ✔ en navegador: `document.fonts` pasa de 0 a Inter cargada, el `font-family` computado es `Inter, …` y **solo se descargan los 3 pesos usados** (`inter-400/600/700-latin.woff2`); el `material-symbols-outlined.woff2` de 4 MB queda `unloaded` (nunca se pide) y la app arranca sin errores |
| 2026-10-03 | #6 Opus anunciado sin soporte (aprobado: quitarlo) | `README.md`: se quita Opus de la lista de formatos; `Características actuales.md`: la fila Formatos ahora dice explícitamente que **Opus no está soportado** y por qué | ✔ `grep -n Opus README.md` → sin resultados; en el núcleo no había ninguna referencia que quitar |
| 2026-10-03 | #12 cerrojos e integridad del modo exclusivo (aprobado: los tres) | `player.rs` (`play_path`): el cerrojo de `desired_rate` se suelta **antes** de tomar `streams` (se elimina la inversión de orden con `ensure_streams`); `exclusive.rs`: `saturating_sub` en el cálculo de frames disponibles y `ReleaseBuffer` con `AUDCLNT_BUFFERFLAGS_SILENT` cuando el motor no se pudo bloquear y el búfer quedó sin rellenar | ✔ `cargo test` 19/19 · `fmt`/`clippy -D warnings` limpios; el interbloqueo y el underflow son riesgos de carrera/hardware, no reproducibles aquí |
| 2026-10-03 | #13 CI que enmascaraba clippy | `.github/workflows/ci.yml`: fuera el `\|\| cargo check` (convertía un fallo de clippy en éxito), ahora `clippy --all-targets -- -D warnings`; nuevo paso `cargo fmt --check`; el paso de UI también corre `npm run build:css` | ✔ lectura del workflow; los tres comandos pasan en local |
| 2026-10-03 | #1 build estancado (decisión de **Jev**: config local sin versionar) | Borrado `src-tauri\target\` (**12 GB**, ya no existe) y creado `src-tauri/.cargo/config.toml` con `target-dir = "D:/enn-target"`, añadido a `.gitignore` (no se versiona: en la CI y en Linux/macOS no hay unidad D:) | ✔ **`cargo test` a pelo** desde `src-tauri` (sin `dev.ps1` ni variables de entorno): 19/19, `fmt --check` y `clippy -D warnings` limpios, y **no se crea ningún `target\` dentro del repo** |
| 2026-10-03 | #5 extra: Material Symbols (decisión de **Jev**: borrar) | Fuera `ui/fonts/material-symbols-outlined.woff2` (**4,0 MB**), su `@font-face` y las clases `.material-symbols-outlined` de `fonts.css` (nadie en el marcado las usaba) | ✔ `ui/fonts/` baja de 4,6 MB a **536 KB**; sin referencias en `grep` y `document.fonts` ya solo lista Inter; la app arranca sin errores |
| 2026-10-03 | #14 los tres detalles menores (decisión de **Jev**: arreglar los tres) | `.gitignore`: eliminada la negación inútil `!src-tauri/target/**/*.exe`; `ui/app.js`: la lista de descargas usa la **URL completa** como clave (el recorte a 46 caracteres podía fundir dos vídeos en una sola fila); `player.rs`/`lib.rs`: la tasa de bits se calcula **una vez al cargar la pista** (`CurrentTrack.bitrate_kbps`) en vez de con un `fs::metadata` en cada sondeo de 250 ms | ✔ en navegador: dos descargas con los **mismos primeros 46 caracteres** aparecen como **2 filas** (antes se fundían en 1) y su progreso avanza; 19/19 tests, fmt y clippy limpios |
| 2026-10-03 | Registro de la delegación en **Jev** (System One, `jev-1.13.0`) | El propietario delegó cuatro decisiones de cierre; se consultó la API con el contexto del proyecto y se aplicó lo elegido: `config_toml` = local sin versionar (0,97), `material_symbols` = borrar (0,98), `minor_fixes` = los tres (0,61) y `adr_rows` = una fila resumen (0,27 — la ganadora salió **casi empatada** con «una fila por arreglo», que obtuvo 0,44) | ✔ respuesta real de la API (`usage: 1395 in / 180 out`); el bloque completo quedó resumido en la fila #83 del ADR |
| 2026-10-03 | #15 SMTC sin metadatos (decisión de **Jev**: `aplicar_y_verificar`, 0,99) | `src-tauri/src/art.rs` (`cached_cover_url`): se pasa la ruta **nativa** (`let path = dest.to_string_lossy(); Some(format!("file://{path}"))`) en vez de `file:///` + ruta con barras normales. `StorageFile::GetFileFromPathAsync` **exige separadores `\`** | ✔ 19/19 tests · fmt · clippy `-D warnings` · `node --check`/eslint; app recompilada: **0** avisos `fallo set_metadata` en la sesión nueva · **prueba positiva** leyendo la sesión SMTC de Windows: `enn.exe · Playing · pos=23 s end=162 s · título='@YUNGSARRIA x KIDD KEO - Rock & Rolla - NU MIXTAPE 22/07/22' · artista='Kidd Keo' · miniatura ✔` |
| 2026-10-03 | #16 fin de cola con la UI «reproduciendo» (decisión de **Jev**: `aplicar_y_verificar`, 0,58) | `ui/app.js` (`onEnded`): la rama final (sin repetición, radio ni aleatorio y cola agotada) apaga el estado de la interfaz (`playing = false; updatePlayBtn(); markPlayingRow()`) | ✔ app recompilada: pista FLAC (última de la cola) reproducida hasta el final → **▶ con 2:41/2:41** (antes: ⏸ clavado) · `node --check`/eslint limpios · 19/19 tests |

## Ampliación — prueba nativa en vivo (2026-10-03, madrugada)

Prueba del binario nativo (ventana real, clic real, audio real) manejada por automatización de escritorio. El motor confirmó reproducción real: `audio_owner: usando «Altavoces (FxSound Audio Enhancer)»` · `formato F32 a 48000 Hz, 2 canales` · `OK, stream activo` · `ENGINE play cmd: C:\Users\hectr\Music\@YUNGSARRIA x KIDD KEO - Rock & Rolla - NU MIXTAPE 22/07/22 - Kidd Keo.flac (dur=Some(161.9708125), sr=48000)`; posición 0:16 → 1:09 → 2:41 en tiempo real y ~3,8 % de un núcleo decodificando FLAC.

### 15. 🔴 El panel multimedia de Windows (SMTC) se quedaba sin metadatos — ✔ corregido 2026-10-03

- **Dónde**: `src-tauri/src/art.rs:162` (`cached_cover_url`) + dependencia `souvlaki 0.8.3` (`src/platform/windows/mod.rs:191-204`).
- **Evidencia**: `[WARN] smtc: fallo set_metadata: La ruta de acceso especificada (UNABLE_TO_MASK_PATH) es demasiado larga. Supera la longitud máxima de … (0x800700A1)` justo después de cada `ENGINE play cmd` de una pista con portada. El HRESULT `0x800700A1` es `ERROR_BAD_PATHNAME` (161), no un problema real de longitud (el «máximo» que imprime el mensaje es memoria sin inicializar y cambia entre ejecuciones).
- **Causa raíz (comprobada ejecutando la API de Windows con las cuatro formas de ruta)**: souvlaki hace `url.trim_start_matches("file://")` y pasa el resto tal cual a `StorageFile::GetFileFromPathAsync`, que **exige separadores nativos `\`**: `C:\…\x.jpg` → OK · `C:/…/x.jpg` → falla `0x800700A1` · `file:///` + barras → falla · `file://` + ruta nativa → OK. El código anterior (`file:///{url}` con `url` ya convertido a barras normales) entregaba `/C:/…`. El `?` de `SetThumbnail(&stream)?` abortaba la función **antes** de `display_updater.Update()`, de modo que Windows se quedaba sin título, sin artista y sin línea de tiempo en **toda pista con portada**.
- **Arreglo aplicado**: `let path = dest.to_string_lossy(); Some(format!("file://{path}"))` — en Windows el recorte es `C:\…` (válido) y en Unix la ruta ya usa `/`, así que el resultado sigue siendo un `file:///…` correcto.
- **Verificación**: `cargo test` 19/19 · `cargo fmt --check` · `clippy --all-targets -D warnings` · `node --check` y eslint limpios; app recompilada y **cero** avisos `fallo set_metadata` tras el arranque nuevo; **prueba positiva** leyendo la sesión SMTC de Windows con WinRT: `app: enn.exe · estado=Playing · pos=23 s end=162 s · título='@YUNGSARRIA x KIDD KEO - Rock & Rolla - NU MIXTAPE 22/07/22' · artista='Kidd Keo' · miniatura ✔`.
- **Nota**: era **pre-existente**; el arreglo #11 de la víspera solo evitó que el aviso se registrara cuatro veces por segundo.

### 16. 🟠 Al terminar la última pista de la cola, la interfaz se quedaba «reproduciendo» — ✔ corregido 2026-10-03

- **Dónde**: `ui/app.js:531-552` (`onEnded`) y el sondeo de 250 ms (`ui/app.js:3147-3162`).
- **Evidencia**: con el motor en `idle`, la ventana seguía mostrando ⏸ y el reloj clavado en **2:41 / 2:41**; en el log no aparecía `audio_owner: hilo terminado (stream cerrado)`.
- **Causa raíz**: el motor **sí** pasa a `Idle` en el EOF (`player.rs:553-559`), pero el sondeo solo llama a `applyStatus(s)` si el estado es `playing` o `paused`, así que la transición a `idle` **nunca refresca la interfaz**; y `onEnded()` no hacía nada al agotarse la cola (sin repetición, radio ni aleatorio).
- **Arreglo aplicado**: la rama final de `onEnded()` apaga el estado de la UI (`playing = false; updatePlayBtn(); markPlayingRow();`).
- **Verificación**: app recompilada; pista FLAC (última de la cola) reproducida hasta el final → la ventana muestra **▶** con **2:41 / 2:41** (antes: ⏸ clavado) · `node --check` y eslint limpios · 19/19 tests.
- **Residual (observado, sin arreglar)**: el motor deja el stream de audio abierto al pasar a `idle` (no aparece `hilo terminado (stream cerrado)`) y el proceso mantiene ~1,6-1,9 % de CPU; no se pudo separar si es el hilo de audio en vacío o el sondeo/visualizador de la interfaz.

### 17. 🟡 Maquetación a 1120×680 (registrado, sin tocar)

- La fila **«Normalizar volumen (ReplayGain)»** y el valor **«Fade 6.0 s»** del mezclador terminan en x ≈ 1558 px, fuera del cliente (1528 px): se recortan contra el borde derecho de la ventana.
- La vista **Descargas** corta el subtítulo («La mú…») y el marcador de posición («Pega un enlac…») a ese ancho.

### 18. 📉 Corrección del presupuesto de memoria (defecto de metodología)

La nota `Objetivos y presupuesto de recursos.md` da **166 MB**. Medición de hoy con el **árbol completo** de procesos (enn + *todos* sus descendientes):

| Build | enn.exe | WebView2 (6 procesos) | TOTAL | CPU en reposo |
|---|---|---|---|---|
| debug | 45,0 MB | 376,0 MB | **421,0 MB** | 0,3 % |
| release | 43,6 MB | 366,3 MB | **409,8 MB** | 0,3 % |

El 166 MB equivale a enn + **solo el hijo directo** del WebView2 (43,6 + 127,4 = 171 MB): el filtro «ParentProcessId == enn» omite los cinco procesos nietos (renderer, GPU, utility). Es un **defecto de metodología de la bóveda**, no una regresión de la aplicación.

### Decisiones de Jev en esta ampliación (2026-10-03, `jev-1.13.0`)

| Decisión | Elección de Jev | Confianza |
|---|---|---|
| ¿Anotar los hallazgos en la bóveda? | `texto_para_aprobar` (redactar y esperar al propietario; él aprobó el redactado) | 0,38 — empate 0,54 / 0,44 |
| ¿Aplicar el parche del SMTC? | `aplicar_y_verificar` | 0,99 |
| ¿Arreglar el fin de cola? | `aplicar_y_verificar` (la opción «solo mostrar el parche» 0,27) | 0,58 |

### Cómo se manejó la ventana nativa (para futuras pruebas)

El árbol de accesibilidad del WebView2 **solo se expone cuando la ventana está activada**; antes de eso `capture` devuelve solo la barra de ventana. Los clics en segundo plano **no llegan** al WebView2: hace falta `delivery_mode=foreground` (y, cuando está disponible, `bring_to_front`), y conviene capturar inmediatamente antes de cada acción (`No active window — call capture() first`). Las coordenadas de clic son **relativas al cliente** de la ventana (origen suma: pantalla = origen del cliente + coordenada), mientras que los límites de los elementos vienen en coordenadas de pantalla. La verificación fiable es el **log de la app** (`%LOCALAPPDATA%\Temp\enn-debug.log`), la lectura del **SMTC de Windows** por WinRT y la **CPU** del proceso.

### 19. 🟡 Dos recortes de maquetación a 1120×680 — ✔ corregido 2026-10-03

- **Mezclador**: `.mix-tone` tenía `min-width: 270px` fijo, y las filas con valor («Fade 6.0 s», «Pista 0 dB») o con etiqueta larga («Normalizar volumen (ReplayGain)») no caben en media columna. Con la columna derecha arrastrada hasta ~229 px, el contenido terminaba en x ≈ 1558 px, fuera del cliente (1528 px), y se recortaba contra el borde de la ventana. Arreglado en `ui/styles.css`: la rejilla pasa a `repeat(auto-fit, minmax(120px, 1fr))` (una sola columna cuando no hay sitio para dos), las filas pueden encogerse y las etiquetas largas pueden pasar de línea.
- **Panel de descargas** (comparte el escenario con la tarjeta «Reproduciendo ahora», así que sólo dispone de ~293 px): `.dl-target` estaba limitado a `max-width: 55%` con elipsis y el campo de la URL quedaba en 32 px. Arreglado con `flex-wrap` en `.dl-title` y `.dl-url-row`, `.dl-target` sin recorte y `flex: 1 1 170px` en el campo.
- **Verificación en la app recompilada**: «Fade … 6.0 s» y «Normalizar volumen (ReplayGain)» completos dentro de la ventana; «La música se guardará en: C:\Users\hectr\Music» con 252 px (antes 42 px recortados) y el campo de enlace con 268 px (antes 32 px). Medido con los límites del árbol de accesibilidad y confirmado en capturas.
- **Decisión de Jev**: `aplicar_los_dos_verificando` (0,91).

### 20. 🔎 El stream de audio queda abierto en `idle` — investigado (solo lectura): **es intencionado**

- **Qué se ve**: al terminar la última pista el motor queda en `idle`, pero no aparece `audio_owner: hilo terminado (stream cerrado)` y el proceso mantiene ~1,6 % de CPU.
- **Causa (código)**: `player.rs:776-779` — el hilo de audio se queda bloqueado en `keep.recv()` a propósito («A partir de aquí esta función se queda viva con el stream en su marco»). El stream **no se cierra** al pasar a `idle`: sólo termina cuando el canal `keep` se cierra (cierre de la app o cambio de dispositivo).
- **Coste medido**: con la app recién arrancada y sin haber reproducido nada (sin stream) la CPU en reposo era **0,3 %**; tras reproducir y quedar en `idle` con el stream abierto, **~1,6 %**. La diferencia aparece sólo cuando existe el stream, de modo que corresponde a la callback de audio, que sigue corriendo (toma el cerrojo del `Core` y genera silencio) en cada búfer; el sondeo de la interfaz (250 ms) y el visualizador no explican el salto.
- **Consecuencia a valorar (no es un fallo)**: el dispositivo sigue tomado en reposo; en modo exclusivo eso podría impedir que otra aplicación reproduzca. Cerrar el stream tras un tiempo de inactividad sería una decisión de diseño del propietario.
- **Decisión de Jev**: `investigar_solo_lectura` (0,93).

### 21. 🟡 Observación: la carpeta de destino no aparece si la app arranca ya en la vista de Descargas

Si la aplicación se cerró estando en «Descargas», al volver a abrirla el panel se muestra sin la línea «La música se guardará en: …»: el elemento `#dl-target` se rellena al **entrar** en esa vista desde la interfaz, no al restaurar la vista guardada. Al pulsar «Descargar» (o «Descargas») la línea reaparece con la ruta completa. Registrado sin tocar, porque no formaba parte de los dos recortes de maquetación aprobados.
