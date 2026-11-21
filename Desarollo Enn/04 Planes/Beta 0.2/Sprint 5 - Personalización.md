---
resumen: Sprint 5 de la beta 0.2. Botón y panel de personalización en el modo Simple (opacidad del color, estilo, fondo, efectos, opciones futuras) y destello de bordes con los picos de sonido, con limitador de seguridad.
estado: propuesto
actualizado: 2026-11-15
tags: [enn, beta, sprint, personalizacion]
---

# Sprint 5 — Personalización

Parte del [[Plan maestro - Beta 0.2]]. Necesita el Sprint 1 (`prefs`) y el Sprint 4 (movimiento, ola de color).

**Objetivo**: que el modo Simple se pueda ajustar al gusto desde un solo sitio, y que la app «respire» con la música en los bordes.

## Preguntas de apertura

Ninguna imprescindible. Las decisiones de abajo se pueden corregir al empezar.

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Dónde | Botón arriba a la derecha, solo en Simple: el logo de Enn dentro de un cuadrado de esquinas redondeadas | Petición del propietario |
| Forma | Panel flotante que nace del botón; no es una ventana modal | Se ven los cambios en vivo detrás |
| Qué va aquí y qué en Ajustes | Aquí, el aspecto y el comportamiento visual. En Ajustes, el audio, las descargas y el sistema | Dos sitios con propósito claro |
| Cómo crecen las opciones | Se declaran en el esquema de `prefs`; el panel se genera solo | «Múltiples opciones que se van a implementar en el futuro» |
| Aplicación | Inmediata, con animación; «Restablecer» por sección | Sin botón de guardar |
| Destello | Encendido por defecto al 40 %, con limitador | Lo pidió el propietario; el limitador lo hace seguro |
| Origen del destello | Los ataques que ya calcula el motor para el visualizador | Coste extra de análisis: cero |

## Diseño

### 1. Panel de personalización — `ui/personalize.js`

| Sección | Opciones |
|---|---|
| **Color** | Intensidad del color (0–100 %; controla la opacidad del tinte) · Seguir el color de la canción (si se apaga, siempre plata) · Olas al cambiar de canción (encendidas, solo fundido) |
| **Estilo** | Escenario / Clásica, como tarjetas con miniatura. Los estilos futuros se añaden aquí |
| **Fondo** | Visualizador: Cinta, Traza, Video (Sprint 6) o Ninguno · Intensidad del fondo · Desenfoque |
| **Efectos** | Destello de bordes (interruptor e intensidad) · Animaciones: Completas, Suaves, Mínimas · Tiempo de inactividad |
| **Radio** | Afinador del Sprint 3: variedad de artistas, familiar ↔ descubrir, coherencia |
| **Recomendaciones** | Frecuencia del menú: nunca, 1.ª y cada 3.ª, siempre |
| **Próximamente** | Opciones marcadas como experimentales en el esquema |

Cada opción es una entrada del esquema: `{ id, tipo: interruptor | deslizador | elección, por_defecto, sección, desde, experimental }`. Añadir una opción nueva en el futuro es añadir una entrada y su efecto; el panel no se toca.

Comportamiento: abre con muelle desde el botón; cierra con Esc, con clic fuera o con el botón; el foco queda atrapado dentro y vuelve al botón al cerrar; cada cambio se ve al instante en la app; se guarda en `settings.json`.

El selector «Reproduciendo» de Ajustes → Interfaz y el de inactividad se mudan aquí, con un enlace en su sitio antiguo.

### 2. Destello de bordes — `ui/edgeflash.js`

- **Qué es**: un resplandor que nace en los bordes de la ventana cuando hay un pico, y se apaga enseguida. Solo en Simple.
- **Color**: plata de base, mezclada con el color de la canción; en pausa, plata pura.
- **De dónde sale la señal**: del campo `on` de `get_viz_frame` (ataques con banda, fuerza y nivel), que ya va adelantado para coincidir con el sonido.
- **Cómo se dibuja**: una sola capa fija con cuatro degradados ya pintados (uno por borde). Por fotograma solo cambia su `opacity` y una escala mínima, que resuelve la tarjeta gráfica sin repintar.
- **Respuesta**: sube en 30 ms y cae de forma exponencial en unos 280 ms. Los graves encienden abajo y los lados; los agudos, arriba, más tenue.
- **Umbral adaptativo**: se compara con la media reciente, para que una canción densa no esté destellando siempre y una suave también tenga sus momentos.

**Seguridad**:
- Limitador: como mucho 3 destellos completos por segundo (norma WCAG 2.3.1), con un mínimo de 350 ms entre dos.
- Brillo máximo acotado (opacidad ≤ 0,35 con la intensidad por defecto) y color tirando a plata, nunca rojo saturado.
- Apagado automático con «reducir movimiento» de Windows y con el nivel de animación Mínimas.
- Aviso la primera vez que se enciende, con enlace a su interruptor.

**No se dibuja**: en Studio, en modo mini, en pausa, con la ventana oculta ni en modo ahorro.

**Sin visualizador**: si el fondo es «Ninguno» o «Video», el análisis sigue llegando con un sondeo ligero de 30 veces por segundo solo mientras el destello esté encendido y la ventana visible.

## Por si acaso

| Caso | Qué pasa |
|---|---|
| Música muy densa (golpes continuos) | El limitador y el umbral adaptativo lo contienen |
| Música muy suave o hablada | Pocos destellos y tenues; nunca fuerza uno |
| Volumen de la app muy bajo | El análisis es anterior al volumen: el destello no depende de él |
| Persona sensible a los destellos | Limitador, intensidad, interruptor y respeto a la preferencia del sistema |
| Intensidad del color al 0 % | La interfaz queda en plata; el destello también |
| Valor guardado fuera de rango o de una versión futura | `prefs` lo corrige al valor por defecto y conserva lo que no conoce |
| Panel abierto al cambiar a Studio | Se cierra con su animación; el botón desaparece |
| Panel abierto y entra el reposo | El reposo espera mientras el panel esté abierto |
| Ventana estrecha o modo mini | El panel se ajusta al alto disponible y desplaza su contenido; en mini no hay botón |
| Solo teclado | Todo el panel es navegable; los deslizadores responden a flechas; nombres accesibles en cada control |
| Una opción experimental falla | Se puede apagar desde el mismo panel; «Restablecer todo» devuelve los valores de fábrica |
| Se elige «Video» sin video disponible | Se muestra la portada viva (Sprint 6) |

## Prueba de aceptación

**Automáticas**
- Esquema de `prefs`: cada opción del panel existe, tiene valor por defecto válido y sección.
- El panel se genera desde el esquema: añadir una entrada de prueba la hace aparecer sin tocar el panel.
- Limitador del destello: con cualquier secuencia de ataques (incluida una aleatoria de 10 000), nunca más de 3 destellos por segundo ni dos a menos de 350 ms.
- El destello no se activa en Studio, mini, pausa ni con movimiento reducido.
- Accesibilidad del panel: foco atrapado, Esc cierra, el foco vuelve al botón, cada control tiene nombre.

**Medidas**
- Con el destello encendido: sin repintados (solo composición) y tiempo por fotograma sin cambios respecto a apagado.

**A mano**
- Probar cada opción en vivo; cerrar y abrir la app: todo se conserva.
- Destello con tres canciones de carácter distinto (densa, suave, con mucho grave).

## Hecho cuando

- [ ] Botón y panel en Simple, con las secciones de arriba
- [ ] Opciones nuevas se añaden solo declarándolas
- [ ] Destello de bordes plata y adaptativo, con limitador probado
- [ ] Hallazgos de contraste y texto diminuto de la auditoría (n.º 4 y 5) revisados de paso en los controles nuevos
- [ ] Resultados en `05 Registro/Pruebas - Sprint 5.md`
