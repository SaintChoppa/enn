---
resumen: Especificación aprobada del rediseño del 2026-11-09 (tipografía IBM Plex Sans, transiciones, ventana de Ajustes, cola con arrastre, Simple centrado, EQ con valores) y su estado.
estado: vivo
actualizado: 2026-11-09
tags: [enn, plan, ui, diseño]
---

# Rediseño de interfaz — 2026-11-09

Petición del propietario del 2026-11-09. Todas las decisiones son suyas; aceptó las opciones recomendadas (ADR #99–#111 en [[Decisiones de desarrollo]]).

## Decisiones

| # | Tema | Decisión |
|---|---|---|
| 1 | Tipografía | **IBM Plex Sans** (variable, con cursiva real) en toda la app, autoalojada en `ui/fonts/`. Sustituye a Inter. Se eliminan los pesos 650 inexistentes. |
| 2 | Simple ↔ Studio | Cada panel entra desde su lado: la barra lateral desde la izquierda, el ecualizador desde arriba y el mezclador/columna desde la derecha. La tarjeta «Reproduciendo» se desliza a su sitio (técnica FLIP). |
| 3 | Botones | Al pulsar se hunden y al soltar rebotan con un resorte corto. |
| 4 | Ajustes | **Ventana flotante de cristal** centrada, con el fondo difuminado. Se abre con un engranaje en la barra superior y se cierra con ✕ o Esc. La vista «Ajustes» y su enlace en la barra lateral desaparecen. |
| 5 | Contenido de Ajustes | **Audio**: dispositivo, salida exclusiva, ReplayGain (con «Por álbum» y «Analizar»). **Visualizador**: activado, Cinta o Traza, difuminado en Simple, Personalizar render. **Interfaz**: modo al abrir la app y tiempo de inactividad. **Descargas**: carpeta y formato. Todo esto vive **solo en Ajustes**: sale del dock, del mezclador y de la vista Descargas. |
| 6 | Paneles de la barra lateral | Flecha minimalista en el borde izquierdo del panel (biblioteca, descargas). Al pulsarla, el panel sale hacia la derecha y vuelve «Reproduciendo». |
| 7 | Simple: centro | «Reproduciendo» queda siempre centrado. La biblioteca y las descargas flotan encima, a un lado, como cristal. |
| 8 | Simple: ecualizador | El botón plateado «Ecualizador» despliega debajo de la tarjeta, con una animación de altura: Graves, Agudos, Fade y las 10 bandas. La columna derecha **desaparece** en Simple y no se puede redimensionar. |
| 9 | Simple: render | Difuminado de 8 px por defecto, ajustable en Ajustes. |
| 10 | Simple: inactividad | Al fundirse el cromo, la **barra superior se queda**. |
| 11 | Cola «Siguientes» | Más cristal y más transparente. Filas numeradas con una flecha pequeña ↓ entre ellas; la primera va marcada como «Siguiente». Carátula pequeña + título + artista debajo. Se reordena arrastrando, con resorte: las vecinas se apartan «apretadas». Igual en Simple y en Studio. |
| 12 | Studio: ecualizador | Valor visible junto a cada barra, en vivo. Paso de 0,5 dB con un tope magnético en cada dB entero. El **paramétrico también** lleva los valores. |
| 13 | Studio: mezclador | Rejilla de etiqueta · control · valor, con las casillas alineadas a la izquierda de su texto. |
| 14 | Studio: inactividad | **Se quita** la pantalla completa a los 5 s (anula el ADR #96). El render queda solo de fondo. |

## Estado

- [x] Tipografía: `ui/fonts/plex-sans-{roman,italic}-{latin,latin-ext}.woff2` + `fonts.css`; se borraron los `inter-*.woff2`.
- [x] Botones con resorte (`--t-release`, `--ease-spring`, bloque «pulsación con resorte» al final de `styles.css`).
- [x] Transición Simple ↔ Studio (`sideAnim`, `flipNowPlaying` en `app.js`).
- [x] Ventana de Ajustes (`#settings-dlg` en `index.html`, `settingsDialog()` en `app.js`; el visualizador monta su sección en `#viz-settings`).
- [x] Flecha de cierre de paneles (`.panel-close`, `panelIn`/`closePanel`).
- [x] Simple: tarjeta centrada con paneles flotantes, cajón del ecualizador (`#np-eq-drawer`), sin columna derecha, difuminado de 8 px, barra superior fija.
- [x] Cola nueva con arrastre (`queueRowEl`, `queuePointerDown/Move/Up`).
- [x] Studio: cifras y topes del ecualizador, mezclador ordenado, sin inactividad.
- [x] Verificado: ESLint, `node --check`, el navegador con datos simulados (arrastre de la cola, cajón, Ajustes, paneles, cambio de modo) y la ventana nativa (Simple, Studio y Ajustes con datos reales).
- [ ] A ojo del propietario: el *feel* de las animaciones (resorte de botones, FLIP de la portada, cajón, arrastre).

## Cómo probar

1. **Simple**: pulsa «Ecualizador» (se despliega abajo), abre «Todas las pistas» (flota a la derecha) y ciérrala con la flecha de su borde.
2. Arrastra una canción de «Siguientes».
3. Cambia a **Studio**: los paneles entran por su lado y la portada viaja. Mueve una banda del ecualizador y fíjate en las trabas de cada dB.
4. Abre el **engranaje** de la barra superior.
