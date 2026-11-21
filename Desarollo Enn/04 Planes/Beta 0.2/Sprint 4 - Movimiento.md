---
resumen: Sprint 4 de la beta 0.2. Animación elástica en toda la app, ninguna acción instantánea, cambio de color global en olas con origen según la causa, y transición Simple ↔ Studio rehecha con elementos compartidos.
estado: hecho, falta la revisión a mano del propietario
actualizado: 2026-11-21
tags: [enn, beta, sprint, animacion]
---

# Sprint 4 — Movimiento

Parte del [[Plan maestro - Beta 0.2]]. Evidencia en [[Investigación - Beta 0.2]]. Necesita el Sprint 1 (fichas de movimiento, `prefs`).

**Objetivo**: que toda la app se sienta viva y elástica sin volverse lenta ni gastar de más.

## Preguntas de apertura

1. **Cuánto rebote.** Se monta una página de prueba dentro de la app («Laboratorio de movimiento», solo en desarrollo) con tres caracteres aplicados a los mismos controles: suave, medio y elástico. Los pruebas en tu pantalla y eliges el que queda por defecto.

## El criterio

Pediste más rebote y que nada sea instantáneo. Se cumple con tres reglas que evitan que eso vuelva lenta la app:

1. **La acción nunca espera a la animación.** El sonido, el dato o la orden salen al instante; la imagen los sigue.
2. **Lo que se usa cien veces al día va corto** (≤ 120 ms): teclas, pasar el ratón, saltar de canción. Lo ocasional puede lucirse (220–700 ms): abrir un panel, terminar una descarga, cambiar de modo.
3. **Todo se puede interrumpir.** Una animación en curso se redirige hacia el nuevo destino; no se reinicia ni bloquea.

Solo se animan `transform`, `opacity`, `clip-path` y máscaras. Nunca tamaño ni posición de maquetación.

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Motor | CSS con `linear()` (ya existe `--ease-spring`) y WAAPI; sin bibliotecas | Bajo consumo |
| Tres muelles | `snappy` (rebote 0,15 · 260 ms), `bouncy` (0,35 · 520 ms), `elastic` (0,5 · 700 ms) | Un vocabulario corto mantiene la coherencia |
| Salida | Siempre más rápida que la entrada | Criterio de diseño |
| Ola de color | View Transitions API con máscara de borde suave | Es la única forma de cambiar el color «por zonas» sin duplicar la interfaz |
| Origen de la ola | Lo decide la causa del cambio (ver tabla) | Variedad con sentido |
| Cambio de modo | View Transitions con elementos compartidos; sustituye al sistema actual de promesas | Más fluido y elimina el cuelgue de la auditoría |
| Cambio de modo con teclado | Sin animación, como hoy | Regla 2 |
| Nivel de animación | Completas (por defecto), Suaves, Mínimas; respeta «reducir movimiento» de Windows | Accesibilidad |

## Diseño

### 1. Inventario y barrido

Al empezar se pasa `find-animation-opportunities` y `improve-animations` por toda la interfaz para tener la lista completa. Previsto:

| Zona | Movimiento |
|---|---|
| Botones | Pulsación con escala 0,97 y vuelta con `snappy` |
| ▶ / ⏸ | El icono se transforma, no se sustituye |
| Favorito | La estrella da un pequeño salto con destello |
| Interruptores y casillas | El mando viaja con `bouncy` |
| Deslizadores | La bola se aplasta un poco al arrastrar y recupera al soltar |
| Menús y desplegables | Nacen desde su botón (origen correcto), escala 0,96 → 1 |
| Diálogos | Desde el centro; el fondo se difumina a la vez |
| Avisos | Entran con muelle, se apilan y se descartan arrastrando |
| Filas de listas | Entrada escalonada (40 ms) solo en el primer pintado |
| Cola: añadir, quitar | Las filas se recolocan con FLIP y muelle; la que sale se encoge y se desvanece |
| Pestañas de la biblioteca | El contenido se desliza hacia el lado de la pestaña |
| Vistas Filas ↔ Cuadrícula ↔ Rueda ↔ Compacta | Cada carátula viaja a su nuevo sitio |
| Números (volumen, tiempo, contadores) | Los dígitos ruedan |
| Búsqueda | Los resultados entran escalonados; el esqueleto se funde con ellos |
| Ventana | Primer pintado con fundido y escala 0,985 → 1 |

### 2. Nada instantáneo

Regla aplicada en el barrido: cada cambio de estado visible tiene entrada y salida de al menos 120 ms. Se revisan en concreto: aparición y desaparición de paneles, cambios de texto (título, artista, calidad), carga de carátulas (fundido, nunca salto), estados vacíos, contadores, el indicador de reproducción en las filas y el paso plata ↔ color.

### 3. Ola de color al cambiar de canción — `ui/wave.js`

`playWave({ origen, forma })` envuelve el cambio de paleta en `document.startViewTransition()`. La vista nueva se revela con una máscara de borde suave animada mediante una propiedad registrada (`@property --wave-r`).

| Causa del cambio | Origen de la ola |
|---|---|
| La canción terminó sola | Desde la carátula, en círculo hacia fuera |
| ⏭ Siguiente | Desde la derecha |
| ⏮ Anterior | Desde la izquierda |
| Clic en una fila o carátula | Desde el punto del clic |
| La radio eligió | Desde el botón de radio |
| Desde el menú de recomendaciones | Desde abajo a la derecha |
| Desde Descargas («Escuchar») | Desde esa pastilla |
| Otros | Alterna arriba y abajo |
| Pausa (vuelta a plata) | Al revés: el color se retira desde los bordes hacia la carátula |

Detalles:
- Duración 900–1 100 ms con aceleración y frenada suaves.
- El visualizador y el video llevan su propio grupo de transición sin animación: no se congelan durante la ola.
- `::view-transition { pointer-events: none }`: la app sigue respondiendo mientras dura.
- La ola y el cruce de video del Sprint 6 arrancan en el mismo fotograma.

### 4. Simple ↔ Studio

Elementos con nombre de transición propio: carátula, título y artista, botonera, barra de progreso, volumen, cola, ecualizador, panel de pistas, panel de descargas y columna derecha.

- Cada uno viaja y cambia de tamaño hasta su sitio nuevo con `snappy`.
- Los paneles que solo existen en Studio (telemetría, mezclador) entran escalonados desde su lado y salen por donde entraron.
- El fondo hace un zoom leve (1,04 → 1).
- Duración total ≤ 650 ms.
- Pulsar el otro modo a mitad invierte desde donde esté.
- Los nodos se siguen moviendo entre sus sitios (`placeParts`, `placeEq`, `placeQueue`, `placePill`), ahora dentro de la transición.
- Tope de seguridad: si la transición no termina en 900 ms, el modo cambia igual (cierra el hallazgo n.º 2 de la auditoría).

## Por si acaso

| Caso | Qué pasa |
|---|---|
| Saltar 10 canciones en 2 segundos | La ola en curso se salta y empieza la nueva; si pasan menos de 300 ms entre cambios, solo fundido. El color final siempre es el correcto |
| Dos canciones del mismo álbum (mismo color) | No hay ola |
| Ventana oculta o minimizada | El color se aplica sin animación |
| Modo mini | Fundido simple |
| «Reducir movimiento» activado o nivel Mínimas | Fundido de 300 ms; sin desplazamientos ni rebotes |
| GPU débil | Se mide la primera ola: si la media por fotograma pasa de 24 ms, se degrada a fundido y se recuerda |
| WebView2 antiguo sin View Transitions | Se usa el fundido y la transición de modo actuales |
| Cambio de modo con Descargas abierto, el cajón del ecualizador abierto o en reposo | Casos de prueba fijos; Descargas ya se mantiene (2026-11-13) |
| Redimensionar la ventana a mitad de una transición | Se salta al estado final |
| Dos elementos con el mismo nombre de transición | No puede ocurrir: los nodos se mueven, no se duplican; hay una prueba que lo comprueba |
| Listas largas con entrada escalonada | Solo las filas visibles y solo la primera vez; el desplazamiento no se anima |
| Animación a mitad cuando llega otra orden | Se redirige (transiciones CSS), no se reinicia |
| Pantallas de 144 Hz o más | Todo depende del tiempo, no de los fotogramas |
| El rebote cansa con el uso | Selector de nivel en el panel de personalización |

## Prueba de aceptación

**Automáticas** (`ui/tests/` y el arnés del navegador)
- `wave`: origen correcto para cada causa; 10 cambios en 2 s terminan con la paleta de la última canción y sin restos de `::view-transition`.
- Cambio de modo: termina en menos de 1 s incluso con el documento oculto; ningún nombre de transición repetido; ida y vuelta 20 veces sin fugas de nodos.
- Movimiento reducido: ninguna animación con desplazamiento.
- Tiempos por fotograma durante la ola y el cambio de modo a 1366×768: percentil 95 < 20 ms; ninguna tarea > 50 ms.

**A mano (con el propietario)**
- Revisión del tacto en la app real y a la frecuencia de su monitor, a velocidad normal y a cámara lenta.
- Revisión al día siguiente con ojos frescos.

## Hecho cuando

- [x] Carácter por defecto elegido en el laboratorio
- [x] Barrido completo aplicado; ningún cambio de estado visible es instantáneo (salvo lo que debe serlo: el cambio de modo con teclado y, en Mínimas, el movimiento)
- [x] Ola de color con origen según la causa
- [x] Transición Simple ↔ Studio nueva y sin cuelgues
- [x] Hallazgo n.º 2 de la auditoría cerrado
- [x] Resultados en [[Pruebas - Sprint 4]]
