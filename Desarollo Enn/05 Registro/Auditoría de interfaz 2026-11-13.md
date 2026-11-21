---
resumen: Auditoría de la interfaz del 2026-11-13 (Simple, Studio, Descargas, Ajustes a 1366×768). 2 hallazgos altos, 3 medios y 3 bajos; nada se corrige sin aprobación del propietario.
estado: abierto
actualizado: 2026-11-13
tags: [enn, auditoria, interfaz, accesibilidad]
---

# Auditoría de interfaz — 2026-11-13

> [!info] Qué es esta nota
> Revisión de la interfaz pedida por el propietario («Audita la interfaz y crea los resultados en la bóveda»).
> **Solo diagnóstico**: los arreglos se hacen cuando el propietario los apruebe.
> El único cambio aplicado durante la auditoría es el desborde de las bandas del ecualizador, que se había introducido ese mismo día (ver «Corregido durante la auditoría»).

## Cómo se hizo

| Dato | Valor |
|---|---|
| Fecha | 2026-11-13 |
| Pantallas | Simple · Reproduciendo, Simple · Descargas, Studio · Todas las pistas, Studio · Descargas, ventana de Ajustes |
| Tamaño | 1366×768 (el mínimo de la app, ADR #124) |
| Entorno | Navegador de pruebas con `dev-mock.js` (6 canciones de prueba) |
| Método | Script que recorre el DOM: botones sin nombre, campos sin etiqueta, imágenes sin `alt`, IDs repetidos, desbordes, objetivos < 24 px, contraste WCAG (texto contra el fondo opaco más cercano) y tamaños de letra; foco con la tecla Tab real; lectura del código de los casos dudosos |

## Resumen

| # | Gravedad | Hallazgo | Dónde |
|---|---|---|---|
| 1 | 🔴 Alta | El cajón del ecualizador **cerrado** sigue recibiendo el foco con Tab: las flechas cambian bandas y Agudos/Graves **sin que se vea** | `#np-eq-drawer` (Simple) |
| 2 | 🔴 Alta | Pasar de Studio a Simple espera a que terminen las animaciones de salida: si la ventana está oculta o minimizada el cambio **se queda colgado** | `leaveStudio()` en `app.js` |
| 3 | 🟠 Media | Una descarga que termina con el panel de Descargas **cerrado** no entra en la biblioteca (ni suena el aviso) hasta volver a abrirlo | sondeo de `download_list` en `app.js` |
| 4 | 🟠 Media | **Contraste bajo** (< 4,5:1) en rótulos pequeños | ver tabla de contraste |
| 5 | 🟠 Media | **Texto diminuto**: «off» bajo el botón de repetir a 7,5 px; rótulos de la telemetría a 9 px | `.ctl .st`, `#studio-telemetry` |
| 6 | 🟡 Baja | **Objetivos pequeños**: estrella de favorito 24×20 px; asa «Guardar el panel» 20 px de ancho | `.x.fav`, `.panel-close` |
| 7 | 🟡 Baja | En Studio el panel de pistas (320 px) es estrecho: las pastillas de la cabecera pasan a dos filas y los títulos se cortan pronto («Oasis…») | `#library-pane` |
| 8 | 🟡 Baja | `markPlayingRow()` recorre todas las filas de la biblioteca cada 250 ms; con bibliotecas grandes puede pesar (no medible con 6 pistas) | `applyStatus()` |

---

## 1. 🔴 El cajón del ecualizador cerrado recibe el foco

- **Síntoma**: en Simple, con el cajón del ecualizador cerrado (alto 0 px), al pulsar Tab el foco entra en sus controles (comprobado: llegó a `#mix-treble`). Desde ahí, las flechas mueven Agudos, Graves o las bandas sin que nada se vea en pantalla.
- **Por qué importa**: es una causa muy probable del **+12 dB que apareció solo** en las 10 bandas el 2026-11-09 (tarjeta abierta en el Kanban). El arreglo de ADR #128 hizo que los atajos no actúen con un control enfocado, pero el control escondido seguía pudiendo enfocarse.
- **Arreglo propuesto**: poner `inert` en `#np-eq-drawer` mientras está cerrado (en `setEqOpen`). Nada se puede enfocar ni pulsar dentro hasta abrirlo.

## 2. 🔴 El cambio a Simple puede quedarse colgado

- **Síntoma**: `leaveStudio()` espera a `animation.finished` de los paneles de Studio antes de cambiar de modo. Con la línea de tiempo de animaciones parada (ventana oculta o minimizada; se reprodujo en el navegador de pruebas con el panel oculto) esas promesas no se cumplen y el modo se queda en Studio, con `modeAnimating = true`, hasta que la ventana vuelve a verse.
- **Arreglo propuesto**: un tope de tiempo (≈ 700 ms) con `Promise.race`: si las animaciones no terminan, el modo cambia igual.
- **Cerrado (2026-11-21, Sprint 4 T6).** `leaveStudio()` y `modeAnimating` ya no existen. El cambio de modo va por `ui/modeswitch.js`: una View Transition cuyo callback cambia el modo, con la ventana oculta se cambia al instante, y un tope de 900 ms fuerza el cambio si la transición se cuelga. Pruebas en `ui/tests/modeswitch.test.js`.

## 3. 🟠 Descargas que terminan con el panel cerrado

- **Síntoma**: el sondeo de `download_list` (cada 400 ms) hace `return` si el panel está cerrado (`dlClosed`). Desde el 2026-11-12 las descargas siguen en segundo plano (ADR #144), así que puede terminar una con el panel cerrado: no se refresca la biblioteca, no suena la campanilla, no se analiza su volumen y no sale el aviso hasta reabrir Descargas.
- **Arreglo propuesto**: con el panel cerrado, sondear igualmente pero más despacio (cada ~2 s) solo para detectar las terminadas.

## 4. 🟠 Contraste bajo

| Elemento | Texto | Contraste | Tamaño |
|---|---|---|---|
| Títulos de sección de la barra lateral | «Biblioteca», «Colección» | 3,97:1 | 11 px |
| Cabecera del mezclador | «Mezclador» | 3,62:1 | 10,5 px |
| Rótulos de la telemetría (Studio) | «Formato», «Muestreo»… | 3,62:1 | 9 px |
| Cifra del volumen | «22» | 3,62–3,97:1 | 12 px |

El mínimo WCAG AA para texto pequeño es 4,5:1. La causa común es `--text-faint: #6b7079`.

- **Arreglo propuesto**: subirlo a ~`#80858e` (≈ 5:1). Afecta a todo el texto «tenue», que se vería algo menos apagado. La alternativa es corregir solo estos cuatro.
- **Falso positivo**: «Buscar» (1,03:1) es el botón plateado. Su fondo es un degradado que el script no lee; a la vista se lee bien.

## 5. 🟠 Texto diminuto

- «off» bajo el botón de repetir: **7,5 px**, ilegible. Propuesta: 9–10 px o quitarlo (el estado ya se ve en el icono).
- Rótulos de la telemetría: **9 px** (`fitTelemetry()` los encoge para que quepan). Propuesta: mínimo 10 px.

## 6. 🟡 Objetivos pequeños

- Estrella de favorito en las filas: 24×20 px (lo recomendable es ≥ 24×24).
- Asa «Guardar el panel»: 20 px de ancho (48 de alto). Aceptable, pero fácil de fallar.

## 7. 🟡 Panel de pistas estrecho en Studio

Con el ancho por defecto (320 px) las tres pastillas de la cabecera ocupan dos filas y los títulos se cortan muy pronto. Propuestas: un ancho por defecto mayor (~400 px), o dejar las herramientas de Studio (lote, duplicados, m3u) en un menú «…».

## 8. 🟡 Coste del sondeo con bibliotecas grandes

`applyStatus()` llama cada 250 ms a `markPlayingRow()`, que recorre todas las filas pintadas (hasta 500 + las que se añaden al bajar). Propuesta: tocar solo la fila que deja de sonar y la que empieza.

---

## ✅ Lo que está bien (comprobado)

- Ningún botón visible sin nombre accesible; ningún campo sin etiqueta; ninguna imagen sin `alt`; ningún ID repetido.
- Foco visible con Tab: contorno de 2 px (probado con la tecla real en el botón del ecualizador, ⏭ y Agudos).
- Sin desbordes horizontales en ninguna pantalla (tras el arreglo de abajo).
- La ventana de Ajustes cabe a 1366×768 (614×676) y desplaza su contenido por dentro.
- Sin errores en la consola en ninguna de las pantallas probadas.

## Corregido durante la auditoría

- Las bandas del ecualizador grande se desbordaban (573 px de contenido en 526) y salía una barra de desplazamiento. El motivo era el sitio que se había dado a las cifras ese mismo día. Ahora reservan 20 px por banda y la cifra se aparta a 26 px cuando aparece la perilla. Vuelve a medir 526/526.

## Siguiente paso

Que el propietario elija qué hallazgos se corrigen. Están en «Por hacer» del [[Kanban - Enn]].
