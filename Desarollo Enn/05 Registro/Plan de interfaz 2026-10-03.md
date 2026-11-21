---
resumen: Plan y registro de entregas del rediseño de UI (2026-10-03/04), con las decisiones delegadas a Jev.
estado: histórico
actualizado: 2026-11-09
tags: [enn, plan, ui, diseño, en-curso]
status: "fase 1 entregada; resto propuesto"
created: 2026-10-03
---

# Plan de interfaz — 2026-10-03

> **Estado: EN CURSO.** La **fase 1** (descargas) está **implementada y verificada** el mismo día; el resto sigue **propuesto** y sin tocar. Ver [[#Registro de entrega]]. El propietario lo revisa y aprueba por fases antes de tocar código (no se hacen commits).
> **Origen**: cinco peticiones del propietario (cerrar/redimensionar el panel de pistas, cerrar el panel de descargas, acabado más profesional, ecualizador inutilizable en Studio y un plan para cuando no hay canciones) más el hallazgo de que la biblioteca se quedó a 0 pistas.
> **Decisiones**: delegadas a **Jev** (`jev-1.13.0`) por indicación expresa del propietario («déjale todas las decisiones a Jev según la visión de la app»). Cada punto lleva su elección y su confianza. Ver [[#Decisiones de Jev]].

---

## Contexto y principios

La visión declarada del proyecto ([[Visión y objetivos]], [[Visión y objetivos]]) manda sobre el gusto: **reproductor ligero y nativo, audio primero, interfaz de uso inmediato y proyecto vitrina**. De ahí los principios que gobiernan este plan:

1. **Tiempo hasta el valor mínimo**: abrir → añadir carpeta → suena. Cualquier cosa que añada pasos o ceremonia va fuera.
2. **Nada que ocupe espacio sin ganárselo**: paneles que se pueden cerrar, recordando la preferencia.
3. **Consistencia de sistema, no de parches**: botones y estados con tokens, no con utilidades sueltas repetidas.
4. **Nada se anima si se usa cientos de veces al día**; las micro-interacciones son de 100-160 ms y solo `transform`/`opacity`.
5. **La identidad no se toca**: tema oscuro único, Inter, paneles de cristal, acento que sigue al color de la portada. Y una regla explícita del PRD que se respeta: el botón **«Descargar» es el único elemento que NO sigue el acento de la canción** (PRD 6.1) — se queda en marfil.

## Estado actual verificado (punto de partida)

| Hecho | Evidencia |
|---|---|
| La biblioteca tiene **0 pistas**, porque la **carpeta está vacía en disco** | `library.json` = `{"folders":["C:\\Users\\hectr\\Music"],"tracks":[]}` (01:05); en `C:\Users\hectr\Music` solo queda `desktop.ini` (carpeta modificada a las 01:05). **No es un fallo del escaneo**: no hay audio que escanear |
| El estado vacío se ve a la vez que una **pista fantasma** | Las capturas del propietario muestran «0 canciones» junto a la tarjeta «Reproduciendo ahora» con `SWAGGERBOYZ - BUSCANDO…`, que ya no está en la biblioteca, y la barra inferior con esa misma pista y tiempos |
| El panel de pistas **no se puede cerrar ni redimensionar** | `#library-pane` vive dentro de `#view-library`; el único divisor (`#split`) mueve `--qw` (columna derecha), no los paneles del escenario |
| El panel de descargas **no se puede cerrar** | `#btn-download` lleva a la vista `downloads`; para salir hay que navegar a otra vista. No hay ✕ ni alternancia; la vista se persiste en `localStorage` |
| En **Studio** el ecualizador es inutilizable | `.eq-bands` (10 sliders verticales de 24×96) + EQ paramétrico viven en `.mix-eq`, dentro del mezclador de la columna derecha, con `--qw` ≈ 229 px. No hay ninguna regla que ensanche la columna en Studio |
| El acabado de botones es heterogéneo | Alturas de 30/32/34/37/46 px; `:active` solo en `.btn` y `.ctl` (no en `.icon-btn` ni `.tab`); **cero** reglas `:focus-visible`; hovers sin `@media (hover: hover) and (pointer: fine)`; radios de 8/10/12/14 conviviendo |

---

## 1. Panel de pistas: colapsable **y** redimensionable

- **Decisión de Jev**: `ambas_cosas` (0,57 · empate bajo: colapsable 0,16 / redimensionable 0,16).
- **Qué se hace**
  - Un control de **contraer/desplegar** en la cabecera del panel (`#lib-head`), con icono propio y `aria-expanded`; al contraerlo el escenario se queda para la tarjeta de reproducción.
  - Un **asa de arrastre** en el borde del panel (mismo lenguaje que `#split`, con `cursor: col-resize` y guía al pasar), con **ancho mínimo y máximo** para que nunca quede inservible.
  - Ambos estados se **recuerdan** (localStorage, como `enn.mode`/`enn.view`) y se restauran al abrir, con el ancho saneado si la ventana cambió.
- **Criterios de aceptación**: con la ventana en 1120×680 y en 1920 de ancho, el panel se contrae, se despliega y se arrastra sin recortar nada; al reiniciar la app se recuerda; el teclado puede contraer/desplegar (Enter/Espacio sobre el control) y el foco se ve.
- **Esfuerzo**: M. **Riesgo**: el layout del escenario mezcla vista activa y tarjeta de reproducción; hay que medir el estado real antes de tocar (ver «Riesgos y notas»).

## 2. Descargas: abrir/cerrar a voluntad

- **Decisión de Jev**: `alternar_y_cerrar` (0,95).
- **Qué se hace**: `#btn-download` **alterna** (abre la vista de descargas y, pulsado otra vez, vuelve a la vista anterior); se añade **✕ de cerrar** en el panel; al cerrar se **recuerda la vista anterior** y se restaura. El botón refleja el estado con `aria-pressed` y un realce discreto.
- **Criterios de aceptación**: abrir → cerrar → abrir vuelve siempre a la vista previa correcta; `Escape` cierra el panel cuando el foco está dentro; el ✕ no aparece si no hay vista a la que volver (se cae a la vista de biblioteca).
- **Esfuerzo**: S (victoria rápida).

## 3. Studio: ecualizador usable

- **Decisión de Jev**: `ensanchar_columna` (0,67 · la alternativa «mover el EQ al escenario» obtuvo 0,24).
- **Qué se hace**: en `data-mode="studio"` la columna derecha se **ensancha automáticamente hasta un mínimo utilizable** (≈ 420 px), respetando el ancho que el propietario haya arrastrado si es mayor; al volver a Simple se recupera su ancho. El límite actual de saneado (`clampQw`) pasa a ser específico por modo, para que el ecualizador nunca quede por debajo de su ancho mínimo útil (10 bandas + etiqueta + valor).
- **Criterios de aceptación**: en Studio, a 1120×680 y a 1920, las 10 bandas se ven completas con sus etiquetas (31…2k) y el EQ paramétrico es operable con el ratón; el divisor sigue funcionando y el ancho no se sale de la ventana.
- **Esfuerzo**: S/M. **Riesgo**: si el propietario tenía la columna muy ancha en Simple, el cambio de modo no debe «encogerla» de forma sorpresiva.

## 4. Plan del estado sin canciones (y el estado fantasma)

- **Decisión de Jev**: `completo_con_estados` (0,83) + `pista_fantasma` = **pasar a reposo** (0,78).
- **Qué se hace** — se distinguen **cuatro** situaciones, cada una con su copy y sus acciones (nada de un texto genérico al fondo del listado):

  | Situación | Copy propuesto (a revisar) | Acciones |
  |---|---|---|
  | **Primer uso** (nunca hubo carpetas) | «Tu música, en tu equipo. Sin cuentas, sin suscripciones, sin telemetría.» | **[Añadir carpeta]** · [Añadir archivos] · nota: «se escanean las subcarpetas» |
  | **Biblioteca vacía** (hay carpetas guardadas pero 0 pistas) ← *el caso de hoy* | «Las carpetas de tu biblioteca no tienen audio ahora mismo.» + **la ruta guardada** | **[Re-escanear]** · [Añadir carpeta] |
  | **Búsqueda sin resultados** | «Nada coincide con «{término}».» | **[Limpiar búsqueda]** · [Quitar filtros] |
  | **Error al escanear** (permiso, ruta desaparecida) | «No se pudo leer {ruta}: {motivo}» | [Reintentar] · [Quitar carpeta] |

  - **Tarjeta de vacío con ilustración** (sprite actual, nada de imágenes nuevas) centrada y con jerarquía: icono → titular → explicación → botones. Se reutiliza la misma pieza en Artistas, Álbumes, Géneros, Por año, Actividad y Playlists, cambiando solo el copy.
  - **Estado de reposo de la reproducción** (regla de la pista fantasma): cuando no hay nada sonando y la pista actual ya no está en la biblioteca, la tarjeta pasa a **reposo limpio** —sin título, artista, portada ni tiempos antiguos— con el marcador de posición y un aviso corto («Añade música para empezar»), y el transporte queda inerte (botón de reproducir deshabilitado con su `title` explicativo). **Matiz a confirmar**: si la pista *está sonando* y su archivo sigue existiendo, no se corta; el paso a reposo se aplica al iniciar, al quedar en reposo o al perder la pista.
  - La cola vacía mantiene su pista actual («Lo que suene después aparecerá aquí») y las descargas sin elementos estrenan su propio texto con acción.
- **Criterios de aceptación**: con la biblioteca a 0 pistas, la app **explica qué pasa**, ofrece la acción que lo resuelve y **no muestra ninguna pista fantasma**; al añadir una carpeta con audio, el estado vacío desaparece sin recargar; nada de esto rompe el caso «33 pistas» (verificado con la biblioteca llena antes de entregar).
- **Esfuerzo**: M/L (toca marcado, estilos y el estado de la UI, no el motor).
- **Base de diseño**: playbook `onboard` de `impeccable` (los estados vacíos son la oportunidad de onboarding; mostrar valor, CTA clara, ayuda contextual, nunca bloquear).

## 5. Acabado visual: sistema de botones y pase de detalle

- **Decisión de Jev**: `sistema_y_acabado` (0,99).
- **Qué se hace**
  1. **Sistema de botones por tokens**: `.btn` (secundario), `.btn.primary`, `.btn.ghost`, `.icon-btn`, `.ctl` (transporte) con **una sola altura por tamaño** (`--h-btn: 32px`, `--h-btn-sm: 26px`, `--h-icon: 30px`), radios unificados (`--radius-sm: 8px`, `--radius: 12px`) y sin utilidades Tailwind repetidas en el marcado de los botones nuevos. El botón «Descargar» se conserva **marfil** (PRD 6.1) pero pasa a ser una variante declarada (`.btn.ivory`).
  2. **Estados que faltan**: `:focus-visible` en todo lo interactivo (anillo de 2 px con separación), `:disabled` coherente (`opacity: .45`, `cursor: not-allowed`), `aria-pressed` visible en los botones de modo.
  3. **Micro-interacciones** (regla de `emil-design-eng`):

     | Antes | Después | Por qué |
     |---|---|---|
     | `.icon-btn` y `.tab` sin `:active` | `transform: scale(0.97)` en `:active` | Todo lo pulsable debe responder a la pulsación |
     | `transition: background .12s ease, color .12s ease` suelto por el archivo | `transition: transform 160ms var(--ease-out), background 120ms ease, color 120ms ease` | Se declaran solo las propiedades que cambian; nada de `all`; la pulsación es más rápida que el color |
     | hovers sin guarda | `@media (hover: hover) and (pointer: fine)` para todo `:hover` con movimiento | En táctil el hover se dispara al tocar y produce falsos positivos |
     | Sin foco visible | `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` | Accesibilidad y uso con teclado |
     | Alturas 30/32/34/37/46 | `--h-btn`, `--h-btn-sm`, `--h-icon`, `--h-ctl` | Ritmo visual y alineación entre barra, paneles y transporte |
     | Animaciones de entrada sin curva propia | `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` y `--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)` | Las curvas nativas son débiles; estas dan intención |
     | Ningún estado de carga/ocupado | Estados `disabled` + texto «Analizando…» donde ya existe lógica | Evita dobles pulsaciones y transmite el estado real |

  4. **Pase de detalle**: escala tipográfica (11/12/13/15/20/28), ritmo de espaciado en múltiplos de 4, radios unificados, `tabular-nums` en todos los tiempos (hoy ya en algunos), y revisión de contrastes del texto tenue sobre cristal.
  5. **No se toca**: la identidad (tema oscuro único, cristal, acento dinámico), el comportamiento del motor ni el transporte salvo lo listado.
- **Criterios de aceptación**: capturas antes/después a 1120×680 y 1920 de ancho; toda la UI navegable con teclado con foco visible; ninguna animación supera 200 ms en elementos de uso frecuente; los tres gates del proyecto siguen verdes.
- **Esfuerzo**: M.

## 6. Documentación de diseño (PRODUCT.md / DESIGN.md)

- **Decisión de Jev**: `en_el_repo` — **confianza baja (0,25; 0,44 frente a 0,32 de hacerlo en la bóveda)**. Se anota tal cual y se pide confirmación al propietario.
- **Qué se haría**: `PRODUCT.md` (producto, usuarios, principios, no-objetivos) y `DESIGN.md` (tokens, tipografía, radios, espaciados, componentes, estados y reglas de movimiento) en la **raíz del repositorio**, en inglés, como piden los skills de diseño; la bóveda seguiría siendo el registro en español de las decisiones.
- **Esfuerzo**: S.

---

## Orden de implementación propuesto

| Fase | Contenido | Esfuerzo | Por qué en este orden |
|---|---|---|---|
| 1 | Descargas: alternar + ✕ + recordar vista (punto 2) | S | Victoria rápida, sin riesgo de layout |
| 2 | Estado vacío completo + reposo sin pista fantasma (punto 4) | M/L | Es lo que más se ve hoy y también el onboarding del proyecto |
| 3 | Studio: columna con mínimo utilizable (punto 3) | S/M | Arregla lo «inutilizable» con un cambio acotado |
| 4 | Panel de pistas colapsable + redimensionable (punto 1) | M | Toca el layout del escenario: conviene después de medirlo |
| 5 | Sistema de botones + pase de acabado (punto 5) | M | Con la estructura ya cerrada, el acabado no se rehace |
| 6 | `PRODUCT.md` / `DESIGN.md` (punto 6) | S | Pendiente de confirmar la ubicación |

**Verificación de cada fase**: `cargo fmt --check` · `clippy --all-targets -- -D warnings` · `cargo test` (19) · `node --check ui/app.js` · `npm run lint` · `npm run build:css`, más una pasada visual con la app compilada a 1120×680 y a 1920 de ancho (y, cuando aplique, con la biblioteca llena y vacía). Sin commits.

## Riesgos y notas

- **Layout del escenario**: hoy conviven la tarjeta de reproducción y el panel de la vista activa; antes de implementar la fase 4 hay que **medir el estado real** (qué elemento ocupa qué ancho) en lugar de deducirlo, y comprobarlo en Simple y en Studio. Fase 4 va después precisamente por eso.
- **Anchos recordados**: el ancho de la columna derecha y el del panel de pistas se guardan por separado y se sanean al abrir si la ventana es más pequeña.
- **La carpeta de música está vacía en disco**: el estado vacío del punto 4 es real, pero el plan **no** puede recuperar archivos. Si el propietario movió o perdió su música, hay que volver a añadir la carpeta (y, si vuelve a aparecer audio, todo lo demás sigue igual).
- **Nada de esto toca el motor de audio**, ni el formato de `settings.json`/`library.json`, ni el modo exclusivo.

## Decisiones de Jev

| Pregunta | Elección | Confianza | Nota |
|---|---|---|---|
| Panel de pistas | `ambas_cosas` (colapsable + redimensionable, recordado) | 0,57 | Empate bajo entre las dos opciones simples (0,16/0,16) |
| Panel de descargas | `alternar_y_cerrar` | 0,95 | — |
| Ecualizador en Studio | `ensanchar_columna` (mínimo ≈ 420 px) | 0,67 | «Moverlo al escenario» sacó 0,24 |
| Alcance del estado vacío | `completo_con_estados` | 0,83 | Con guía de primer uso: 0,10 |
| Pista fantasma | `pasar_a_reposo` | 0,78 | Seguir con aviso: 0,14 |
| Acabado visual | `sistema_y_acabado` | 0,99 | — |
| Documentación de diseño | `en_el_repo` | **0,25** | Muy justa (0,44 / 0,32): **confirmar con el propietario** |
| Forma de entrega | `plan_primero` | 0,75 | Plan escrito y aprobación antes de tocar código |

*Consultas a la API: `usage` 2 881 in / 479 out. Modelo `jev-1.13.0`.*

## Registro de entrega

### Fase 1 — Descargas: abrir y cerrar a voluntad (2026-10-03) ✔

**Archivos**: `ui/index.html` (✕ del panel), `ui/app.js` (`shell.prevView`, `loadShell`/`saveShell`, `backFromDownloads()`, alternancia del botón, `Escape`, `aria-pressed`) y `ui/styles.css` (posición de la ✕ y realce del botón cuando su vista está abierta).

- `#btn-download` **alterna**: si la vista activa ya es Descargas, vuelve; si no, entra y **recuerda de dónde venía** (`goView` guarda `shell.prevView`, que también se persiste como `enn.prevView` en `localStorage`).
- **✕** (`#btn-dl-close`) dentro del panel con la misma acción, y `Escape` la cierra cuando el foco está dentro del panel.
- El botón refleja el estado abierto con `aria-pressed="true"` — en marfil, **sin seguir al acento de la canción**, porque el PRD 6.1 lo deja como el único elemento que no cambia de color.
- `backFromDownloads()` cae al inicio del modo si no hay vista anterior válida (Simple → Reproduciendo, Studio → Biblioteca).

**Verificación en vivo** (app recompilada, PID 12784):

| Prueba | Resultado |
|---|---|
| ✕ del panel | ✔ cierra y vuelve a la vista anterior |
| «Descargar» con el panel abierto | ✔ cierra (alterna) |
| Entrar desde «Todas las pistas» y cerrar con la ✕ | ✔ vuelve **a la biblioteca**, no a Reproduciendo: el recuerdo de la vista anterior funciona |
| Compuertas | ✔ `node --check` · `npm run lint` · `cargo build` |

**Pendiente de probar en vivo**: el cierre con `Escape` (implementado; necesita el foco dentro del panel).

### Correcciones del propietario al plan (2026-10-03)

- **Documentación de diseño (punto 6)**: Jev eligió `en_el_repo` con confianza 0,25; el propietario lo corrigió → **la documentación de diseño va a la bóveda, en español**, y **no** se crean `PRODUCT.md`/`DESIGN.md` en el repositorio.
- **Pista fantasma (punto 4)**: se confirma la lectura propuesta → **no se corta audio en marcha**; el paso a reposo limpio se aplica al iniciar, al quedarse en reposo o al perder la pista.
- **Orden de fases**: aprobado tal cual; se entrega por fases y se enseña el resultado de cada una antes de seguir.

### Fase 2 — Estado sin canciones y reposo sin pista fantasma (2026-10-03) ✔

**Archivos**: `ui/index.html` (tarjeta de vacío con acciones), `ui/styles.css` (bloque `.empty*`) y `ui/app.js` (`updateEmptyState`, `refreshFolders`, `paintRest`, ganchos en `updateLibMeta` y en el sondeo, más el rótulo de la tarjeta).

- **Cuatro situaciones** en lugar del texto único al fondo del listado, cada una con su copy y sus acciones:
  - **Primer uso** (sin carpetas guardadas): «Tu música, en tu equipo» + [Añadir carpeta] [Añadir archivos] + «se escanean las subcarpetas».
  - **Biblioteca sin audio** (hay carpetas guardadas y 0 pistas ← *el caso real de hoy*): «Las carpetas de tu biblioteca no tienen audio» + **la ruta guardada** (leída con `lib_folders`) + [Re-escanear] [Añadir carpeta] + «si moviste la música de sitio, vuelve a añadir la carpeta».
  - **Búsqueda sin resultados**: «Nada coincide con «{término}»» + [Limpiar búsqueda] + recordatorio de los filtros disponibles.
  - **Error de escaneo**: diseñado, **sin implementar** (ver Pendientes).
- Las acciones del vacío reutilizan los botones reales (`btn-folder`/`btn-files`/`btn-rescan`), así que no hay lógica duplicada.
- **Reposo sin pista fantasma** (`paintRest`): la tarjeta pasa a «En reposo · Nada sonando · Añade música para empezar», con el marcador de posición, sin portada, los tiempos a 0:00 y el mini-título en «—». **Nunca corta audio en marcha**: se retira si el motor está sonando o en pausa y solo actúa cuando la pista actual ya no está en la biblioteca (o el motor no tiene nada cargado). El rótulo de la tarjeta dice «En reposo» en lugar de «Reproduciendo ahora».
- Las carpetas guardadas se consultan **una sola vez** (primer tick del sondeo) para poder distinguir «primer uso» de «biblioteca sin audio».

**Verificación en vivo** (app recompilada, PID 29488): el panel de biblioteca muestra la tarjeta con la ruta guardada y los botones correctos del caso; la tarjeta de reproducción dice **EN REPOSO** con «Nada sonando» y los tiempos a 0:00, donde antes aparecía `SWAGGERBOYZ…` con 0:12/2:26 (la pista fantasma). `node --check`, `npm run lint` y `cargo build` ✔.

**Pendientes conscientes de esta fase**:

- El caso **error de escaneo** (permiso denegado, ruta desaparecida) está diseñado pero **no enganchado** al flujo de escaneo.
- El botón de reproducir **no se deshabilita** en reposo: no hace nada sin pista, pero el deshabilitado con su `title` explicativo queda para el pase de acabado (fase 5).
- Artistas/Álbumes/Géneros/Año/Actividad/Playlists comparten la misma tarjeta con el mismo copy; su copy específico queda para más adelante.
- Probado en vivo el caso *biblioteca sin audio*; «primer uso» y «sin resultados» están implementados pero no se han provocado para no tocar la configuración de biblioteca del propietario.

### Fase 3 — Ecualizador usable en Studio y transporte coherente (2026-10-03) ✔ / ⚠

**Archivos**: `ui/app.js` (`QW_MIN_SIMPLE`, `QW_MIN_STUDIO`, `minQw()`, `clampQw()`, `applyRailWidth()`, gancho en `setMode`, `updatePlayBtn`) y `ui/styles.css` (`.ctl:disabled`).

- **Studio ensancha sola la columna derecha**: el ancho del divisor pasa a tener mínimo por modo (220 px en Simple, **420 px en Studio**, porque ahí viven las 10 bandas del ecualizador más el paramétrico). Si el propietario había arrastrado un ancho mayor, se respeta; al cambiar de modo se recalcula (`applyRailWidth()` desde `setMode`).
- **El botón de reproducir se apaga cuando no hay nada que reproducir** (`updatePlayBtn`): queda atenuado, con `title` explicativo («Añade música para empezar») y estilo `.ctl:disabled`, así el transporte no promete algo que no puede hacer.

**Verificación en vivo** (app recompilada, PID 28868):

| Prueba | Resultado |
|---|---|
| Cambiar a Studio | ✔ la columna derecha pasa de **229 px a 402 px** (medido con los límites del árbol de accesibilidad) y las filas de Studio —Balance, Pista, Normalizar volumen, Por álbum, Temporizador, Salida exclusiva— **entran completas**, donde antes se recortaban contra el borde |
| En reposo | ✔ el botón de reproducir se ve atenuado y no promete reproducción |

**Hallazgo nuevo (abierto)**: ensanchar la columna arregla el **ancho**, pero no el **alto**. El mezclador sigue siendo una tarjeta con `max-height: 58%` y desplazamiento propio, así que en una ventana de 680 px de alto el ecualizador queda **bajo el pliegue** y hay que desplazarse dentro de la tarjeta para llegar a él. Las salidas naturales serían llevarlo al escenario en Studio (era la segunda opción de Jev, 0,24) o darle más alto dentro de la columna. **Decisión pendiente del propietario / Jev.**

**Pendiente aprobado y NO entregado**: el caso *error de escaneo* del estado vacío. El dato ya existe en el backend (`AddResult { added, failed, first_error }`, `library.rs:76`), así que basta con capturarlo en `addFolder()` y en el re-escaneo, y añadir su rama a `updateEmptyState()`.

### Fase 2b — Caso «error de escaneo» del vacío (2026-10-03) ✔

**Archivos**: `ui/app.js` (`noteScan()`, captura en `addFolder()` y en el re-escaneo, `scanIssue` y su rama en `updateEmptyState()`).

- Si el escaneo falla (`failed > 0` con `first_error`) o el comando revienta, el estado vacío pasa a **«No se pudo leer tu música»** con el mensaje real y el recordatorio de comprobar que la carpeta existe y se puede leer, más las acciones [Re-escanear] [Añadir carpeta]. Un escaneo correcto limpia el aviso.
- **No se ha podido provocar en vivo**: requeriría una carpeta ilegible o borrada a mitad del escaneo, y la del propietario existe y se lee. Verificado estáticamente (`node --check`, eslint y la compilación) y por lectura del flujo.

### Decisión de Jev: el ecualizador se va al escenario en Studio (2026-10-03)

- Pregunta: ahora que ensanchar la columna no evita que el ecualizador quede bajo el pliegue en una ventana de 680 px de alto, ¿dónde debe vivir?
- **Elección: `escenario_panel_propio`** — sacar el ecualizador al escenario como panel propio en Studio y dejar en la columna derecha solo los controles esenciales. **Confianza 0,33** (0,51 frente a 0,37 de «más alto en la columna»): es una decisión reñida y conviene revisarla al verla montada.
- **Prioridad**: Jev puso `ecualizador_primero` (0,89; 0,92 de probabilidad) por delante de las fases 4 y 5.
- **Estado**: decidido, **sin implementar**. Es el siguiente trabajo del plan.

### Fase 3b — El ecualizador en el escenario (2026-10-03) ✔

**Archivos**: `ui/index.html` (`#stage-eq`, panel de escenario solo-Studio), `ui/styles.css` (disposición horizontal dentro del panel) y `ui/app.js` (`placeEq()`, llamado desde `syncShell`).

- `placeEq()` **muda el nodo real** `.mix-eq` al panel del escenario en Studio y de vuelta al mezclador en Simple — el mismo patrón que ya usaba `placeParts()` con el transporte, así que no hay controles duplicados ni estado que sincronizar.
- Dentro del panel, el ecualizador se despliega en **horizontal**: las 10 bandas a la izquierda y el paramétrico a la derecha, todo visible a la vez, sin desplazamiento.
- **Fallo propio detectado y corregido en la misma tanda**: la sección llevaba la clase `hidden` y esa regla ganaba a `body[data-mode="studio"] #stage-eq`, de modo que el ecualizador quedaba encerrado en un panel invisible (la primera captura lo demostró: la tarjeta del mezclador se quedó sin ecualizador y el escenario sin panel). Se quitó `hidden`: la clase `studio-only` ya lo oculta en Simple.

**Verificación en vivo** (app recompilada, PID 27724): en Studio el panel del escenario muestra «Ecualizador · Personalizado» con las 10 bandas (31…16k) y el paramétrico (80/300/2500/9000) completos; la tarjeta del mezclador conserva Graves/Agudos/Balance/Fade/Pista/ReplayGain/Por álbum/Temporizador/Salida exclusiva. Cambio solo de interfaz: las compuertas de Rust no se ven afectadas.

## Trabajo nocturno del 2026-10-03 (el propietario se fue a dormir)

Con el propietario ausente, **todas las decisiones quedaron delegadas en Jev** y el trabajo se repartió en agentes. El seguimiento vive ahora en **[[Kanban - Enn]]**.

### Decisiones de Jev de esta ronda

| Pregunta | Elección | Confianza |
|---|---|---|
| Cómo resolver que el ecualizador no se vea completo a 1120×680 | `ancho_completo_del_escenario`: en Studio el escenario pasa a columna y el ecualizador ocupa **todo su ancho**, con portada y biblioteca debajo en su fila | **0,85** (0,89) |
| Ancho de la columna derecha en Studio (el propietario la tenía en 402 px y estrangulaba el escenario) | `limitar_en_studio`: en Studio se limita a su mínimo utilizable (~330 px) y en Simple se recupera el ancho elegido | 0,67 (0,78) |
| Política de visualizadores («no puede haber tres») | `si_uno_solo_en_studio`: un único visualizador en Studio (el del escenario); los del fondo y la portada siguen vivos en Simple | **0,96** (0,98) |
| Despliegue por defecto del ecualizador | `plegado_y_parametrico_desplegado`: plegado en Simple, paramétrico desplegado en Studio, ambos recordados | 0,34 (0,56 vs 0,43) |

### Informe del propietario que originó esta ronda (literal)

> «Hay 3 ecualizadores al mismo tiempo, no puede ser, quita el de arriba a la derecha y el ecualizador pequeño solo debe aparecer con un botón. […] El Ecualizador no se ve completo ahora, necesito un render activo que reaccione al sonido en el modo studio.»

**Ya implementado y verificado en vivo antes de delegar**: el visualizador de la columna desaparece en Simple y se muda al escenario (y en Studio se apagan el del fondo y el de la portada, dejando uno solo); el ecualizador de Simple nace plegado detrás de su botón y el paramétrico tiene el suyo, con estado recordado; y se limpió un byte NUL que se había colado en el marcado.

**Problema medido que queda en manos de los agentes**: a 1120×680 el panel del ecualizador acababa con ~198 px útiles (solo 7 de las 10 bandas, el paramétrico fuera y desplazamiento horizontal) porque vive dentro de la columna de la biblioteca mientras la columna derecha conservaba 402 px. La solución es la decisión `ancho_completo_del_escenario` de arriba.

### Pendiente de confirmar por el propietario

- **Su carpeta de música se vació**: `C:\Users\hectr\Music` quedó sin audio a las 01:05 (solo `desktop.ini`) y por eso la biblioteca llegó a 0 pistas; al compilar y probar anoche apareció con **2 pistas**. Si movió o perdió su música, hay que volver a añadir la carpeta.

## Ronda del 2026-10-04 (petición del propietario)

### Lo que pidió (literal)

> «Necesito un botón para poder restablecer los ecualizadores y opciones en el modo studio. En el modo simple, si el usuario no mueve el mouse o no toca nada durante 3 segundos, se deben esconder las pestañas y solo mostrarse la reproducción actual. En el modo simple las canciones siguientes deben verse debajo del reproduciendo ahora y con estilo glassmorphism y no se deben ver barras de ecualizador ni nada de eso, solo reproducción y la biblioteca y colección etc. Necesito que le pongas más animaciones, que los cambios entre simple y studio se vean mejor, que no aparezcan solamente sino que se expandan o aparezcan desde la derecha estilo filas.»

Invocó además los skills `impeccable`, `emil-design-eng` y `animate` (este último cargado por primera vez: es la disciplina de construcción de animaciones de Emil Kowalski).

### Decisiones de Jev (7)

| Pregunta | Elección | Confianza |
|---|---|---|
| Alcance del botón de restablecer | `todo_el_mezclador`: ecualizador plano (10 bandas, paramétrico a 0 dB y preset «Personalizado»), Graves/Agudos/Balance/Pista a 0, Fade a 0 s, ReplayGain **activado**, Por álbum **desactivado**, Temporizador apagado y Salida exclusiva **desactivada** | 0,90 (0,93) |
| Confirmación al restablecer | `directo_sin_mas`: se aplica al instante, sin confirmación | **1,00** |
| Qué se esconde tras 3 s de inactividad en Simple | `menu_barra_y_cola`: menú lateral, barra de título, cola y mezclador; queda la portada con carátula, título, artista, barra de progreso y transporte | 0,59 (0,69) |
| Cola en Simple | `debajo_y_fuera_la_columna`: lista de cristal debajo de la portada y el panel de cola de la columna derecha **no se duplica** | 0,91 (0,93) |
| Visualizadores en Simple | `fuera_todos`: fuera los tres (fondo, carátula y columna); queda un fondo limpio | 0,44 (0,62) |
| Cómo se anima el cambio de modo | `filas_desde_la_derecha`: las filas entran desde la derecha, escalonadas, con opacidad y un pequeño escalado, y salen igual al volver a Simple | 0,50 (0,63) |
| Cuánta animación en total | `estructura_y_contexto`: se anima la estructura y el contexto (modo, paneles, cola, vacíos, avisos); los botones de uso continuo solo conservan su pulsación | **0,98** (0,99) |

### Disciplina de movimiento aplicada (de los skills cargados)

Solo `transform` y `opacity`; entradas desde `scale(0.98)` + `opacity: 0` (nunca `scale(0)`); `ease-out` fuerte `cubic-bezier(0.23, 1, 0.32, 1)` para entradas y salidas; 180-260 ms con escalonado de 30-80 ms; nada de `transition: all`; `prefers-reduced-motion` y la guarda de punteros finos entregadas con cada animación; y ni una animación en acciones de uso continuo o disparadas por atajo de teclado. Se reutilizan los tokens de movimiento y de botones que ya creó la fase 5.

### Estado

Implementado por un agente de interfaz y **pendiente de verificación visual en vivo** por el agente principal (misma disciplina que las rondas anteriores: nada se da por bueno sin compuertas verdes y captura de la ventana nativa).

### Verificación en vivo (agente principal, 2026-10-04)

| Qué | Resultado |
|---|---|
| Compuertas | ✔ `node --check` · eslint · `cargo fmt --check` · `clippy -D warnings` · **19/19 tests** · `cargo build` |
| Botón «↻ Reestablecer» (cabecera del mezclador, Studio) | ✔ existe, se pulsa en vivo y deja el estado neutro de la decisión de Jev (ReplayGain activado, Por álbum desactivado, Temporizador «Apagado», Salida exclusiva desactivada), sin error |
| Inactividad en Simple | ✔ a los 3 s sin entrada quedan solo la carátula, el título, el artista, la barra y el transporte; el cromo vuelve al primer movimiento (foto antes y después) |
| Cola en cristal en Simple | ✔ «Siguientes (16)» se ve debajo de la portada y el panel de la columna **no** se duplica (el nodo real se muda, patrón `placeParts`/`placeEq`) |
| Sin barras en Simple | ✔ los tres visualizadores quedan fuera; en Studio sigue habiendo uno solo (el del escenario) |
| Filas desde la derecha | ✔ estados verificados; **la curva y el *feel* no se pueden juzgar en una foto**: quedan a ojo del propietario |

### Límites reconocidos de esta ronda

- La inactividad **funde** el cromo pero no colapsa el layout (por la regla de no animar `width`/`height`/`grid`), así que el escenario conserva su espacio y la portada no se ensancha.
- La inactividad solo actúa en Simple **y** con la vista «Reproduciendo» delante: con la biblioteca o las descargas abiertas, esconder el menú dejaría la lista sin navegación. Es una línea en `idleAllowed()` si se prefiere en toda Simple.
- **Nuevo hallazgo**: al arrancar con la cola recordada cuyos archivos ya no existen (el caso del propietario, cuya carpeta se vació), la app intenta reproducir y muestra un aviso técnico crudo («El sistema no puede encontrar el archivo especificado. (os error 2)»). Debería explicarse en lenguaje llano y, si la pista ya no está, pasar a reposo como el resto del trabajo del vacío.

## Ronda del 2026-10-04 (segunda): centrado, ecualizador y barra lateral

### Lo que pidió (literal)

> «En el modo simple, no está centrado el reproduciendo ahora. No necesito que el ecualizador del modo simple esté en una barra lateral movible. La barra lateral izq no debe llegar hasta el fondo, y estar bien diseñado.»

Invocó otra vez `impeccable` y `emil-design-eng`.

### Decisiones de Jev

| Pregunta | Elección | Confianza |
|---|---|---|
| Dónde vive el ecualizador de Simple si no puede estar en una columna que se arrastra | `fuera_del_rail_a_la_portada`: se muda a la portada, detrás de su botón; la columna derecha se queda con Graves, Agudos, Fade y Normalizar volumen | 0,51 (0,63) |
| Cómo se rediseña la barra lateral izquierda | `inset_sin_cristal`: sigue pegada arriba pero con **margen inferior, esquinas redondeadas abajo y borde hairline, sin cristal** (se respeta que hoy es una de las zonas sin desenfoque) | 0,31 — **muy justa** (0,49 frente a 0,43 del panel flotante de cristal): a revisar a ojo |
| Qué pasa con el menú al cambiar el marco | `igual_pero_inset`: mismos contenidos, mismas secciones y mismo estado activo | 0,46 (0,64) |

### El centrado

Se trata como **fallo de maquetación**, no como decisión: el bloque «Reproduciendo ahora» debe quedar centrado con la cola debajo sin descolocarlo, y sin recortar la parte superior en ventanas bajas (`justify-content: safe center` está en duda dentro de WebView2). El agente debe medirlo en el DOM a 1120×680 y 1456×782, con la cola llena y vacía.

### Resultado y verificación (agente principal, en la ventana nativa)

La causa raíz del descuadre y del desborde: la portada apilaba cuatro filas (tarjeta · dock · botón «Ecualizador» · cola) y el bloque se centraba **por encima** del botón, no del conjunto; a 1120×680 el contenido medía 645 px en 592 útiles y a 1456×782 con la cola llena 748 px en 694. El arreglo envuelve la tarjeta y el dock en `#np-block` (lo que se centra), pone el botón «Ecualizador» **en la misma fila que el dock** (`#np-dock-row`), deja la cola fuera del bloque, baja su tope a `min(21vh, 240px)` (`min(19vh, 190px)` en ventanas bajas) y añade un ajuste `@media (max-height: 720px)` que aprieta el ritmo; la carátula sigue con `clamp(150px, 26vh, 300px)`. En Studio, `#np-block` y `#np-dock-row` son `display: contents` (cero regresión).

Medidas del DOM (Chromium = motor de WebView2, con `ui/dev-mock.js`):

| Ventana / cola | Alto de contenido antes | Desborde antes | Δ centro antes | Alto después | Desborde después | Δ centro después |
|---|---|---|---|---|---|---|
| 1120×680 vacía | 645 | **+53** | −31 | **608** | **0** | **0** |
| 1120×680 llena (25) | 691 | **+99** | −31 | **608** | **0** | **0** |
| 1456×782 vacía | 694 | 0 | −31 | 694 | 0 | **0** |
| 1456×782 llena (25) | 748 | **+54** | −31 | 694 | **0** | **0** |

Ningún elemento se sale por abajo, nada queda cortado por arriba, ningún par se solapa y el barrido de alturas 600→1000 px se comporta. **Comprobado además por el agente principal en la ventana nativa de Tauri**: en Simple el bloque queda centrado, el dock y «Ecualizador» comparten fila sin recortes y en Studio todo sigue igual (ecualizador completo, telemetría, «Reestablecer», cola en el rail).

### Límites reconocidos de esta ronda (segunda)

- **En reposo (cromo fundido) el bloque queda algo alto**: la cola oculta sigue reservando su espacio, así que el hueco donde se centra no es toda la ventana. Es consecuencia de la regla de no animar layout; se ve solo en el estado de inactividad.
- **Con el ecualizador desplegado** (acción del usuario) el contenido no cabe y la portada **hace scroll**: no recorta nada y la cola sigue alcanzable, pero es el caso a vigilar si se añade más contenido a la portada.
- La telemetría de Studio sigue con las etiquetas recortadas («FORM…», «MUES…»): le falta una fila de todo el ancho, como el panel del ecualizador.
