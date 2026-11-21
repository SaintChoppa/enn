---
resumen: Reparto de tareas del Sprint 1 de la beta 0.2 por olas y por modelo (subagentes Opus o Sonnet, supervisión de Fable), con el estado de cada una.
estado: cerrado
actualizado: 2026-11-16
tags: [enn, beta, sprint, tareas]
---

# Sprint 1 — Tareas

Diseño y criterios en [[Sprint 1 - Cimientos y rendimiento]]. Esta nota es el reparto y el estado.

## Cómo se trabaja (pedido por el propietario el 2026-11-16)

- Cada tarea la hace un **subagente**: **Opus** si es difícil (motor de audio, concurrencia, arranque), **Sonnet** si está acotada (módulos puros con pruebas, configuración).
- **Fable supervisa**: escribe el encargo de cada tarea, revisa el diff, ejecuta las puertas de calidad, mide y decide.
- Sin commits (ADR #161). Copia de inicio en `.snapshots/sprint-1-inicio-2026-11-16.zip`; los encargos, los informes de los agentes y el diario están en `.snapshots/sprint-1/`.
- Las tareas van por **olas**: dentro de una ola, cada tarea tiene su lista cerrada de archivos y no se pisan; solo una ejecuta `cargo`.

## Olas

| Ola | Tarea | Modelo | Qué hace | Estado |
|---|---|---|---|---|
| 1 | T1 Medición | Opus | Marcas de arranque, modo banco `--bench-startup`, estadísticas de la llamada de audio, guion de medición | Hecha y revisada |
| 1 | T2 Preferencias | Sonnet | `ui/prefs.js` con esquema, validación y migración; `npm test` y su paso en la CI | Hecha y revisada (1 corrección) |
| 1 | T3 Movimiento | Sonnet | `ui/motion.css` y `ui/motion.js`: tres muelles generados por física y niveles de animación | Hecha y revisada |
| — | Línea base | Fable | Compilar *release* y medir 10 arranques con el código sin arreglar | Hecha: interactivo 1040 ms; 487 ms eran la lista de dispositivos |
| 2 | T4 Arranque del motor | Opus | El dispositivo de audio deja de abrirse en `setup()`; memoria de «exclusiva no admitida»; comandos fuera del hilo de la ventana; perfil *release*; instancia única; escritura atómica | Hecha (en el chat). Además: memoria de exclusiva persistente, `Cargo.toml` corregido para Linux/macOS, «Abrir con Windows» |
| 2 | T5 Arranque de la interfaz | Sonnet u Opus | Ventana con fondo y esqueleto; `init()` en paralelo; visualizador diferido; favicon ligero; cajón del ecualizador `inert`; `markPlayingRow` barato | Hecha (en el chat). Además: el arreglo de los 62 % de CPU en reposo (paleta y visualizador) |
| 3 | T6 Eventos del motor | Opus | El motor avisa de los cambios; desaparece el sondeo de 250 ms; nada trabaja con la ventana oculta | Hecha (en el chat): sondeo adaptativo + eventos del motor; errores del motor ya llegan |
| 4 | T7 Multinúcleo | Opus | `BgPool`, análisis de volumen en paralelo, prioridad de tiempo real para el audio | Hecha (en el chat): `jobs.rs`, análisis en paralelo, 0 cortes con carga |
| 4 | T8 Integración | Opus | `prefs` conectado a la app y a `settings.json`; carátulas por protocolo de archivos | **Aplazada** a los Sprints 4 y 5 (ver [[Pruebas - Sprint 1]]) |
| — | Medición final y aceptación | Fable | Tabla antes/después, prueba de carga, [[Pruebas - Sprint 1]] | Hecha |

## Decisiones del supervisor

| Decisión | Motivo |
|---|---|
| Tareas en paralelo solo con archivos que no se solapan | No hay commits que separen el trabajo de cada agente |
| Un solo agente con `cargo` por ola | Dos compilaciones a la vez en `D:\enn-target` ya dieron un error de enlazado el 2026-11-12 |
| `prefs.js` y `motion.js` se crean en la ola 1 y se conectan en la ola 4 | Permite avanzar en paralelo con la medición |
| La línea base se mide con la instrumentación puesta y nada más cambiado | Para que el antes y el después sean comparables |

## Corrección (2026-11-16)

El plan decía que el motor abría el dispositivo de audio dentro de `setup()`. **Es falso**: al arrancar, `set_exclusive` solo guarda el ajuste; el dispositivo se abre en el primer ▶. La causa del arranque lento la dirá la línea base. Lo que sí cuesta la apertura (y la prueba de formatos exclusivos con FxSound) es el **primer ▶**.

## Cambio de forma de trabajo (2026-11-16)

Tras la ola 1, el propietario pidió seguir **sin subagentes**, todo en el chat principal. Las olas 2–4 se hacen así.

## Cierre (2026-11-16)

Sprint terminado. Resultados, causas y lo que queda en [[Pruebas - Sprint 1]]. Copia del final en `.snapshots/sprint-1-fin-2026-11-16.zip`. Sin commits.
