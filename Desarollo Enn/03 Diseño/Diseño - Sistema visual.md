---
resumen: Tokens, tipografía, radios, cristal, componentes, iconos, estados y movimiento de la UI (extraídos del código).
estado: vivo
actualizado: 2026-11-09
tags: [enn, diseño, sistema-visual, ui]
status: vigente
created: 2026-10-03
---

# Diseño — Sistema visual

Sistema visual **real** de Enn, extraído leyendo el código a **2026-10-03**:
`ui/styles.css` (2363 líneas), `ui/index.html` (363 líneas) y `ui/tw-input.css`
(49 líneas). Los datos son valores y selectores tal como están en el código; donde
no hay nada implementado se dice explícitamente (ver §Ausencias y dudas) en vez de
describirlo como si existiera.

> [!warning] La interfaz se está editando en paralelo
> `ui/styles.css`, `ui/app.js` y `ui/index.html` los está modificando otro agente.
> Los valores de esta nota corresponden a la lectura de la fecha indicada; si el
> diseño cambia, esta nota hay que releerla contra el CSS, no al revés.

## 1. Tema

**Oscuro único.** `styles.css:1-5`: «Obsidian Hi-Fi: base obsidiana + cromo
plateado. Tema único (oscuro): el plateado solo se lee como metal sobre fondo
oscuro». `:root { color-scheme: dark }`.

- **No hay variante clara** ni `prefers-color-scheme` en el CSS. La decisión #70
  de [[Decisiones de desarrollo]] hablaba de conservar el tema «mármol/titanio»,
  pero **eso no está en el código**: coincide con el aviso de
  [[Características actuales]] §Interfaz y sistema y con [[Auditoría de bugs 2026-10-03]].
- Fondo del `body`: dos degradados radiales con el tinte reactivo + un
  `linear-gradient(160deg, var(--bg), var(--bg-soft))` fijo (`styles.css:1479-1488`).

## 2. Tipografía

> [!note] Cambio del 2026-11-09 (#99)
> La familia es ahora **IBM Plex Sans** (variable, con cursiva real), autoalojada en `ui/fonts/`. Lo que sigue describe la etapa con Inter; los tamaños no cambiaron y los pesos 650 pasaron a 600.

**Familia** (`styles.css:108`):

```css
font-family: "Inter", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
font-size: 14px;   /* base del body */
```

- **Inter está autoalojada** en `ui/fonts/`. `fonts/fonts.css` declara `@font-face`
  para los pesos **400, 500, 600 y 700**, cada uno en subconjuntos **latin** y
  **latin-ext** (8 `.woff2`, ~536 KB en total). `index.html:12` enlaza
  `fonts/fonts.css`, así que **sí se carga** (esto es un cambio posterior a lo que
  decía [[Auditoría de bugs 2026-10-03]] #5; el propio `fonts.css` anota que
  Material Symbols se retiró el 2026-10-03).
- **Pesos realmente usados en el CSS:** 400 (normal), 500 (Tailwind
  `font-medium` en el selector Simple/Studio), 600 (`font-weight: 600`), **650**
  (varios selectores) y 700. ⚠ El valor **650 no tiene archivo propio** en
  `ui/fonts/` (solo hay 400/500/600/700): el navegador lo aproxima al más cercano.
  Queda como duda abierta.

**Escala tipográfica real** (no hay una escala con nombre; son valores sueltos en
px, `clamp()` en las vistas grandes). Selector → tamaño:

| Tamaño | Dónde |
|---|---|
| 19px | `.ctl.big` (botón reproducir) |
| 17px | `.ctl`, `.ctl.mode` |
| 15px | `.empty-title` |
| 14px | `body` base; `.ctl.small`; `#now-playing #np-artist` |
| 13.5px | `.props-head`; valores de la telemetría Studio (`#tm-*`, Tailwind `text-[13.5px]`) |
| 13px | `.btn`, `.icon-btn`, `.panel-head`, `.nav-item`, `.toast`, `.list-hint`, `.track-list li`, buscador `#lib-head input`, `#pl-name`, `.dl-url-row input` |
| 12.5px | `.tab`, `.btn.small`, `.ctx button`, `.props-card dl`, `.dl-title`, `#mini-title`, `.album-card .a-name`, `.empty-text`, `#btn-download` |
| 12px | `.dl-item`, `.track-list li .x`, `.mix-tone`, `.mix-eq-top`, `select` |
| 11.5px | `.pane-meta`, `.track-list li .t-artist`, `.dev select` |
| 11px | `.pl-info`, `.pl-count`, `.dur`, `.g-count`, `.dl-target`, `.dl-chip`, `.dl-sub`, `.rg-status`, `.tm`, `.eq-param .pband`, `.empty-hint` |
| 10.5px | `.nav-sec`, `.album-card .a-count`, `.np-kicker` |
| 10px | `.quality-badge`; etiquetas de la telemetría Studio (`text-[10px]`) |
| 9px | `.eq-bands .band span` (rótulos de banda del EQ) |
| 7.5px | `.ctl .st` (sufijo de estado de shuffle/repeat) |
| `clamp(22px,3.4vh,32px)` | `#now-playing #np-title` |
| `clamp(170px,36vh,330px)` | carátula de «Reproduciendo» (es medida, no tipo) |

Convenciones de peso observadas: títulos y rótulos usan **600/650**; texto de
cuerpo y secundario, **400**; el sufijo `.ctl .st`, **700**.

## 3. Tokens de `:root`

Definidos en `styles.css:20-82` (base, Obsidian Hi-Fi) y ampliados en
`styles.css:1600-1609` (segunda pasada, shell).

**Color (base):**

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#09090b` | obsidiana de fondo |
| `--bg-soft` | `#0e0e12` | fondo de inputs/superficies secundarias |
| `--panel` | `rgba(22,22,27,.62)` | cristal de paneles |
| `--panel-solid` | `#16161a` | panel opaco |
| `--panel-hi` | `rgba(33,33,40,.72)` | panel elevado |
| `--text` | `#e8eaee` | texto principal |
| `--text-dim` | `#99a0aa` | texto secundario |
| `--text-faint` | `#6b7079` | texto terciario |
| `--silver` / `--silver-dim` | `#bcc6d4` / `#8a96a8` | cromo plateado |
| `--border` | `rgba(255,255,255,.08)` | hairline |
| `--border-hi` | `rgba(255,255,255,.14)` | hairline reforzada (focus de inputs) |
| `--track` | `rgba(255,255,255,.12)` | carril de sliders/barras |
| `--on-accent` | `#0b0b0e` | texto encima del acento (siempre oscuro) |
| `--glass-blur` | `20px` | radio de blur del cristal |

Semánticos **fijos** (no siguen al acento): `--success #5fc98d`,
`--success-soft rgba(95,201,141,.16)`, `--danger #e2695c`,
`--danger-soft rgba(226,105,92,.14)`, `--warning #e0a84e`.

**Acento (valores de arranque, plateado neutro):** `--accent rgb(188,198,212)`,
`--accent-2 rgb(138,150,168)`, `--accent-soft rgba(188,198,212,.16)`,
`--accent-line rgba(188,198,212,.38)`, `--thumb rgb(188,198,212)`,
`--accent-rgb 188,198,212`, `--accent2-rgb 138,150,168`, `--halo rgba(188,198,212,.3)`,
`--halo-2 rgba(138,150,168,.22)`, `--tint rgba(0,0,0,0)`, `--tint-strong rgba(0,0,0,0)`.

**Tokens del shell (Fase 2):** `--tb-h 46px` (barra de título),
`--sw 212px` (menú lateral), `--ctrl-h 64px` (barra inferior),
`--ivory #f1efe9` y `--ivory-ink #0b0b0e` (único blanco de marca: solo el botón
Descargar), `--obsidian-chip rgba(255,255,255,.045)`, `--radius 12px`,
`--radius-sm 8px`.

**Registro `@property`** (`styles.css:10-18`): las variables de acento y tinte se
registran con `syntax: "<color>"` e `initial-value`. Esto es lo que permite que el
navegador las **interpole** (fundido de 700 ms, §Movimiento) cuando `palette.js`
reescribe el acento al cambiar de canción. `--accent-rgb`/`--accent2-rgb` **no**
están registradas a propósito: los canvas necesitan el color nuevo al instante
(`palette.js:214-216`).

### Cómo el acento sigue al color de la portada

`ui/palette.js` (no es CSS, pero es el mecanismo):

1. Reescala la carátula a **24×24** en un canvas fuera de pantalla y la recorre una
   vez (cacheada por pista, máx. 240).
2. Agrupa los píxeles en **24 cubos de tono (15°)** y pondera primando saturación y
   luminosidad media (el trazo de color de una portada pesa aunque ocupe poco).
3. **Normaliza** el color: `saturación 0.32–0.86`, `luminosidad 0.55–0.74`
   (`palette.js:80-82`). Portada en blanco y negro → **plateado de reserva**
   `[188,198,212]`/`[138,150,168]` (`SILVER`).
4. Escribe `--accent`, `--accent-2`, `--accent-soft`, `--accent-line`, `--thumb`,
   `--tint`, `--tint-strong`, `--halo`, `--halo-2` (y las `*-rgb`) en `:root`.
   El tinte es **bajo a propósito**: `rgba(acento,0.055)` y `0.1`, porque «por
   encima de ~0.07 el plateado deja de leerse como metal» (`palette.js:225-228`).
5. `styles.css:56-62`: verde/rojo/ámbar **no** siguen al acento — son señalética,
   no identidad (coherente con [[Decisiones de desarrollo]] #69).

## 4. Radios

No hay escala única: conviven todos estos valores.

| Radio | Selectores representativos |
|---|---|
| 3px | `.dl-bar` (barra de progreso de descarga) |
| 4px | `.quality-badge`, `.eq-param .pband input` |
| 5px | `.ctl .st`; botones Simple/Studio (Tailwind `rounded-[5px]`) |
| 6px | `.mini-art`, `.track-list li .x`, `.ctx button`, `#spectrum` |
| 8px | `.icon-btn`, `.group-head`, `.pl-item`, `.track-list li`, `.ctl-meta`, `.ctx`, `.dev select`, `.album-card .cover`, `var(--radius-sm)` |
| 10px | `.btn`, buscadores, `#pl-name`, `.dl-url-row input`, `#toast`, `.props-card`, `.album-card`, `.album-detail` |
| 12px | `var(--radius)` (p. ej. `#np-slot-dock #outdock`) |
| 14px | `.tab`, paneles de cristal (§6), `#now-playing #np-art` |
| 16px | `#np-art` legacy |
| 50% | `.ctl`, `.spinner`, `.live-dot`, `.np-halo` |
| 999px | `.dl-chip` (pastilla de estado de descarga) |

## 5. Alturas, anchos y espaciados

**Alturas/anchos clave:** barra de título `--tb-h 46px`; menú lateral `--sw 212px`
(**60px** por debajo de `max-width: 1020px`, donde se ocultan los textos,
`styles.css:2124-2132`); barra inferior `--ctrl-h 64px`; columna derecha
`var(--qw, 330px)` (el HTML la fija en `330px` inline: `index.html:51`);
`.ctl` 36×36, `.ctl.big` 44×44, `.ctl.small` 32×32; `.nav-item` alto 34px.

⚠ **Conviven dos alturas de barra inferior**: la rejilla antigua usaba filas de
`66px` (`styles.css:135-141`) y la Fase 2 usa `--ctrl-h` = **64px**
(`styles.css:1600-1609, 1648`). Es duda abierta si es deuda o intencional.

**Espaciados:** no hay escala tokenizada; conviven valores en px literales y la
escala por defecto de Tailwind (`gap-3.5` = 14px) en el marcado nuevo. Patrones
repetidos: separación entre paneles de cristal `margin: 6px`; `#controls`
`gap:14px; padding:0 14px`; `#sidebar` `padding:14px 10px; gap:1px`; `#rail`
`padding:12px 12px 6px 6px; gap:10px`; barra de título `pl-4` (16px) + `gap-3.5`
(14px). Escala de facto en múltiplos de 2 y 4 (1,2,3,4,6,8,10,12,14,18,20,24,26,28).

## 6. Paneles de cristal (glassmorphism)

> [!note] Decisión 2026-11-09 (#90)
> El cristal **se mantiene**. El visualizador nuevo ([[Visualizador - Cinta y Traza]]) se adapta a este estilo; el «sin cristal: prohibido» del plan del handoff no aplica a la app.

Regla real (`styles.css:1490-1509`), aplicada a **`#library-pane`, `#queue-panel`,
`#mixer`, `#downloader`** y a **`#controls`**:

```css
background: linear-gradient(var(--tint), var(--tint)), var(--panel);
backdrop-filter: blur(var(--glass-blur)) saturate(1.15);
-webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.15);
border: 1px solid var(--border);
border-radius: 14px;
box-shadow: 0 10px 34px rgba(0,0,0,.55);
margin: 6px;
```

El tinte va **encima** del cristal (`linear-gradient` delante del `--panel`) para
que el blur no lo lave. La barra inferior `#controls` usa el mismo cristal pero con
`border-top` en vez de borde y radio.

⚠ **`#titlebar` y `#sidebar` NO usan `backdrop-filter`**: la barra de título usa
Tailwind `bg-surface/85` (fondo `--bg` al 85 %) y la lateral
`rgba(9,9,11,0.6)` (`styles.css:1672`). No hay una clase `.glass` única; el cristal
se aplica por selector de contenedor.

## 7. Componentes

### Botones

| Clase | Reglas (`styles.css`) |
|---|---|
| `.btn` | borde `1px solid var(--border)`, fondo `--bg-soft`, padding `8px 14px`, radio **10px**, fuente 13px, `transition: filter .15s ease, transform .1s ease, background-color .15s ease`; `:hover { filter: brightness(1.05) }`; `:active { transform: scale(.96) }` |
| `.btn.small` | padding `7px 10px`, fuente **12.5px**, `flex:none` |
| `.btn.primary` | fondo `var(--accent)`, `color: var(--on-accent)`, borde transparente; `:hover { filter: brightness(1.12) }` |
| `.icon-btn` | sin borde ni fondo, color `--text-dim`, 13px, padding `4px 8px`, radio **8px**; `:hover` → fondo `--accent-soft`, color `--text` |
| `.ctl` | sin borde/fondo, 36×36, radio **50%**, 17px; `.big` 44×44 con fondo `--accent`; `.small` 32×32; `.mode` 17px; `.active` color `--accent`; `:active { transform: scale(.88) }`; `:disabled { opacity:.4; cursor:not-allowed }` |
| `.tab` | píldora (radio 14px), 12.5px, 600; `.active` → fondo `--accent-soft`, color `--accent` (heredado del rediseño) |
| `.nav-item` | alto 34px, radio `--radius-sm` (8px), 13px, gap 11px; `.active` fondo `rgba(255,255,255,.07)` y una barra de 2px en `--accent` por `::before` |
| `.dl-chip` | pastilla 999px, 11px, 600; variantes `.queued`, `.downloading`, `.done`, `.error`, `.cancelada` con `--track`/`--accent-soft`/`--success-soft`/`--danger-soft` |

Los iconos dentro de `.btn` y `.icon-btn` miden **15–16px** de lado
(`styles.css:2032-2035`, `2111-2115`). El botón Descargar (`#btn-download`) es el
**único elemento marfil** (`--ivory`), deliberadamente ajeno al acento.

⚠ Conviven **dos sistemas**: los botones de `styles.css` (`.btn`, `.ctl`…) y los de
la barra de título, que llevan las utilidades Tailwind **inline** en
`index.html` (`bg-ivory`, `aria-checked:bg-white/10`, `active:scale-[0.97]`). No
está unificado en tokens de botón; es justo lo que pide la Fase 5 del
[[Kanban - Enn]].

### Sliders y campos

- `input[type=range]`: carril `--track` de 5px (radio 3px), thumb circular de 13px
  en `--thumb` (`styles.css:1016-1039`).
- Inputs de texto/búsqueda: borde `--border`, fondo `--bg-soft`, radio 10px,
  `outline: none`.
- `select`: borde `--border`, fondo `--bg-soft`, radio 8px.
- Scrollbar: 10px de ancho, thumb `--track` (radio 6px, `background-clip:content-box`).

## 8. Iconos — sprite SVG propio

`index.html:17-47`: **un único `<svg class="sprite">`** oculto
(`position:absolute; width:0; height:0; overflow:hidden`) con **28 `<symbol>`**
`id="i-*"`, usados vía `<use href="#i-…">`:

`i-wave`, `i-search`, `i-download`, `i-win-min`, `i-win-max`, `i-win-restore`,
`i-win-close`, `i-disc`, `i-library`, `i-mic`, `i-album`, `i-tag`, `i-calendar`,
`i-history`, `i-playlist`, `i-cloud-down`, `i-mini`, `i-folder-plus`, `i-music`,
`i-rescan`, `i-pencil`, `i-copy`, `i-save`, `i-folder-open`, `i-radio`, `i-x`,
`i-speaker`, `i-volume`.

**Convención de trazo** (`styles.css:1621-1632`, en `@layer base`): todos los
símbolos son de **línea** (`viewBox="0 0 24 24"`, sin relleno), y la clase `.ic`
los pinta con:

```css
width: 18px; height: 18px; flex: none;
fill: none; stroke: currentColor; stroke-width: 1.75;
stroke-linecap: round; stroke-linejoin: round;
```

`currentColor` hace que el icono herede el color del texto (navegación, títulos).
Excepciones observadas: los iconos de ventana llevan `[stroke-width:1.5]`, el de
`#btn-download` `[stroke-width:2]`, el glifo de `.ctl svg` dentro del transporte
usa `stroke-width:2` con lado 17px, y el icono suelto de `#btn-eq-open` trae su
propio `<g stroke-width="1.7">` inline. El placeholder de carátula usa
`stroke-width:1` a gran tamaño.

⚠ **No hay Material Symbols en uso**: el archivo y sus clases se retiraron
(`ui/fonts/fonts.css` §final; [[Auditoría de bugs 2026-10-03]] #5).

## 9. Estados

| Estado | Implementación real |
|---|---|
| **Hover** | fondos `--accent-soft` / `--bg-soft` / `rgba(255,255,255,.04)`; `filter: brightness(1.05–1.12)` en `.btn`; `.dl-bar:hover > i` cambia a `--thumb` |
| **`:active`** | `transform: scale(.96)` (`.btn`, `.tab`), `scale(.88)` (`.ctl`), botón Descargar `scale(.97)` (Tailwind) |
| **`:disabled`** | `.ctl:disabled { opacity:.4; cursor:not-allowed }`; `input:disabled { opacity:.4 }` en el mezclador. No hay `.btn:disabled` |
| **Foco de teclado** | ⚠ **Ausente como sistema**: no existe ninguna regla `:focus` ni `:focus-visible` en `styles.css`. Lo único con foco visible es `#lib-head`/buscador por `focus-within` de Tailwind (`index.html:62`) y `.track-list li.kbd-focus { outline: 2px solid var(--accent); outline-offset: -2px }` (navegación por flechas). El `:focus-visible` general está pendiente en la Fase 5 del [[Kanban - Enn]] |
| **Selección actual** | `li.current { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent) }`; la fila que suena «respira» con `now-playing-pulse` |

## 10. Movimiento

Duraciones y curvas **reales** encontradas en `styles.css`:

| Duración / curva | Qué anima |
|---|---|
| `0.1s ease` | `transform` de `:active` (`.btn`, `.tab`, `.ctl`) |
| `0.12s ease` | fondo/color de `.nav-item` y su icono; `opacity` de `.track-list` |
| `0.15s ease` | fondos de hover (`.btn`, `.icon-btn`, `.track-list li`, `.ctl`, `.ctl-meta`) y `.tab` |
| `0.18s ease` | `slideup` del mezclador |
| `0.25s ease` | flecha del acordeón (`.group-head .arrow`); overlay legacy `#now-playing` |
| `0.3s ease` | despliegue del acordeón (`.group-body`, `grid-template-rows 0fr→1fr`); `opacity` de `.live-dot` |
| `0.35s ease` | ancho de `.dl-bar > i` (progreso de descarga) |
| `0.7s ease` | fundido del acento y el tinte al cambiar de canción (transición de `:root`, §3) |
| `0.8s linear infinite` | `spin` (`.spinner`) |
| `1.1s ease-in-out infinite` | `now-playing-pulse` (fila que suena) |
| `1.8s ease-in-out` | `fresh-fade` (×6, fila recién descargada) y `live-pulse` (punto del menú) |

Curvas: **`ease`** domina; **`ease-in-out`** para los bucles infinitos; **`linear`**
para el spinner. `@keyframes` definidos: `now-playing-pulse`, `slideup`, `spin`,
`fresh-fade`, `live-pulse`.

**Accesibilidad de movimiento:** `@media (prefers-reduced-motion: reduce)` apaga la
transición de `:root` (`styles.css:84-86`), oculta `#bg-visualizer` (124-128) y
desactiva `live-pulse` (2154-2156).

## 11. Ausencias y dudas abiertas

Cosas **no implementadas** hoy, dichas como tales:

- **`:focus-visible` / sistema de foco** — no existe regla alguna; solo el
  `kbd-focus` de la vista Todas. (Fase 5 del [[Kanban - Enn]].)
- **Sistema de botones por tokens** — hoy conviven `.btn`/`.ctl` de `styles.css`
  con utilidades Tailwind inline en la barra de título. (Fase 5.)
- **Tema claro** — no implementado pese a la decisión #70; el tema es oscuro único.
- **Perillas, reactor cinético, medidores VU, widget de caché, Material Symbols** —
  descritos en la bóveda pero ausentes del código ([[Auditoría de bugs 2026-10-03]] §📄).

Dudas que dejo planteadas en vez de suponer:

1. **`font-weight: 650`** aparece en varios selectores pero no hay `.woff2` de ese
   peso en `ui/fonts/` (solo 400/500/600/700): el navegador aproxima. ¿Se añade el
   peso o se redondea el CSS a 600/700?
2. **Alturas `64px` vs `66px`** de la barra inferior conviven (Fase 2 vs rejilla
   antigua). ¿Deuda a limpiar?
3. ~~Cristal desigual~~ (2026-11-09: el cristal se queda como está, #90). **Cristal desigual**: `#titlebar` y `#sidebar` no usan `backdrop-filter`. ¿Es
   intencional (barra de título con `bg-surface/85`) o queda por unificar?
4. `--qw` está fijado a `330px` **inline** en `index.html:51` además del fallback
   `330px` del CSS. ¿Se mantiene el inline como fuente de verdad?
