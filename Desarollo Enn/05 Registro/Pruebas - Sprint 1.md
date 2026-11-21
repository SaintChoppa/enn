---
resumen: Prueba de aceptación del Sprint 1 (beta 0.2). Arranque 1040 → ~650 ms, reposo 62 % → ~0,5 % de un núcleo, primer ▶ 1250 → 140 ms, 0 cortes de audio con todos los núcleos ocupados. Memoria sin resolver (~490 MB).
estado: cerrado
actualizado: 2026-11-16
tags: [enn, beta, sprint, pruebas, rendimiento]
---

# Pruebas — Sprint 1

Diseño en [[Sprint 1 - Cimientos y rendimiento]]; reparto en [[Sprint 1 - Tareas]].

## Cómo se midió

- **Versión *release*** (`npx tauri build --no-bundle`, perfil con LTO), en el equipo del propietario, con su biblioteca real (104 pistas) y su salida de audio (FxSound, exclusiva activada en Ajustes). Enn del propietario **cerrado** durante las mediciones.
- **Arranque**: `scripts/bench-startup.ps1` (10 arranques). La app tiene un modo `--bench-startup` que escribe sus marcas internas en un JSON y se cierra.
- **Reposo**: `scripts/bench-idle.ps1` (tiempo de CPU de `enn.exe` y de sus procesos de WebView2). Para ver qué se anima, el modo `--bench-idle` cuenta desde dentro de la app los fotogramas que se piden y las animaciones vivas.
- **Reproducción**: el modo `--bench-play` es una **prueba de humo con el motor real**. Pone dos canciones a volumen 0 y comprueba arranque, avance, pausa, reanudar y paso solo a la siguiente; después ocupa todos los hilos de fondo 8 s analizando la biblioteca y cuenta los cortes de audio.
- Datos en bruto en `.snapshots/sprint-1/` (`bench-base.*`, `bench-base-detalle.*`, `bench-ola2.*`, `bench-final.*`, `smoke-final.json`).

## Resultados

| Medida | Antes | Después | Objetivo | ¿Cumple? |
|---|---|---|---|---|
| Ventana visible | 40 ms (vacía) | 44–58 ms (con el color de la app) | ≤ 400 ms | ✅ |
| **Interactivo** (lista pintada, ▶ responde) | **1040 ms** | **614–697 ms** (−35 a −41 %) | ≤ 1200 ms | ✅ |
| **CPU en reposo**, ventana visible | **62 % de un núcleo** | **0,1–0,8 %** en reposo estable (picos de 1,5–5 % los primeros segundos tras arrancar) | < 0,5 % | ⚠️ en el límite |
| GPU en reposo | 56 % (proceso GPU de WebView2) | 0 % | — | ✅ |
| Fotogramas pedidos en reposo | 200/s | 0/s | 0 | ✅ |
| **Primer ▶** | 1139–1250 ms | **140–270 ms** | — | ✅ |
| Pausa / reanudar | — | 90–133 ms / 243–287 ms | — | ✅ |
| Paso solo a la siguiente canción | — | Funciona (≈0,2 s tras acabar) | — | ✅ |
| Cortes de audio con todos los núcleos ocupados | — | **0** (71–82 análisis completos en 8,7 s; p99 0,5 ms, máx. 1,7–3,7 ms por llamada) | 0 | ✅ |
| Memoria total | 508 MB | 488 MB | ≤ 200 MB | ❌ |
| Tamaño del ejecutable | 17,1 MB | 17,5 MB (con dos complementos nuevos) | — | — |

## Qué causaba cada problema

| Problema | Causa encontrada | Arreglo |
|---|---|---|
| Arranque lento | `init()` esperaba la lista de dispositivos de audio (**487 ms**, WASAPI despertando en frío) antes de pintar la biblioteca; el comando era síncrono y además bloqueaba el hilo de la ventana | Se pide en segundo plano; 13 comandos más pasan fuera del hilo de la ventana |
| Ventana vacía al abrir | La ventana nativa no tenía color de fondo | `backgroundColor` y CSS crítico en línea |
| **62 % de CPU sin música** | En reposo, el sondeo llamaba a `paintRest()` 4 veces por segundo → `resetPalette()` reescribía 13 variables en `:root` (estilo de todo el documento) y avisaba al visualizador, que con cada aviso se despertaba 1,2 s → **el WebGL a pantalla completa no paraba nunca, a 200 fps** | `paintRest()` y `applyPalette()` no hacen nada si no hay cambio; red de seguridad en el visualizador (deja de dibujar a los 8 s sin música) |
| Sondeo constante | `get_state` cada 250 ms siempre; el motor emitía eventos que nadie escuchaba | Ritmo adaptativo (250 ms sonando, 2 s en reposo, nada oculto sin música) y los eventos del motor despiertan el sondeo |
| Primer ▶ lento | Con «Salida exclusiva» y FxSound, cada arranque probaba todos los formatos exclusivos y fallaba; además se repetía en cada cambio de tasa entre canciones | Memoria de «exclusiva no admitida» por nombre real del dispositivo (`exclusive.json`); no se reabre el stream en compartida |

## Fallos encontrados por el camino (corregidos)

- **Errores del motor perdidos**: el hilo informador se quedaba el error del dispositivo para emitir `enn://error`, que nadie escuchaba; el aviso de «dispositivo desconectado» casi nunca salía.
- **Cola que podía no avanzar en la bandeja**: Chromium frena los temporizadores de las páginas ocultas (tras unos minutos, a uno por minuto); el paso a la siguiente canción dependía de un temporizador. Ahora lo mueven los eventos del motor.
- **Pérdida de la biblioteca con un `library.json` dañado**: se cargaba vacía y el siguiente guardado sobrescribía el archivo. Ahora se aparta como `library.json.dañado-<fecha>` (igual con `settings.json`) y los guardados son atómicos.
- **`Cargo.toml`**: la sección «solo Windows» estaba en medio y dejaba `souvlaki`, `lofty`, `rayon`, `ureq` y `base64` fuera de Linux y macOS.
- **Dos Enn a la vez**: ahora la segunda ejecución enfoca la primera.
- **Cajón del ecualizador cerrado que recibía el foco** (auditoría n.º 1, posible causa del +12 dB) y **`markPlayingRow` recorriendo todas las filas** 4 veces por segundo (auditoría n.º 8).
- **`viz/traza.js`**: la comprobación de «asentado» compara la banda de tono con 0,5 en vez de con su destino real (0,5^gamma). Con un preajuste de gamma ≠ 1 el visualizador no se detendría solo. La red de seguridad lo cubre; la corrección fina queda anotada.

## No verificado

- **CPU con la ventana escondida en la bandeja**: el guion la oculta con `ShowWindow`, que no avisa a WebView2; la cifra no es representativa. Pendiente de medir con «cerrar a la bandeja» de verdad.
- **CPU sonando** en Simple con visualizador (objetivo ≤ 4 %): no medido en este sprint.
- **«Abrir con Windows»**: el interruptor existe y llama al sistema, pero no se reinició Windows para comprobar el arranque en la bandeja.
- **Instancia única**: probada indirectamente (el banco no arranca dos a la vez); no se probó abrir la app dos veces a mano.
- Arranque en Linux y macOS: sin probar (la CI lo hará).

## Pendiente que pasa a otros sprints

| Tema | Por qué | A dónde |
|---|---|---|
| **Memoria (~490 MB, objetivo 200 MB)** | Casi todo es WebView2 (proceso principal, GPU y renderizador, ~130 MB cada uno); el motor de Enn usa 37 MB. Bajarlo exige gestionar la memoria de WebView2 (nivel de memoria bajo con la ventana oculta, lienzos más pequeños). **Decisión del propietario**: aceptar un objetivo realista (~350 MB) o dedicarle trabajo | Pregunta al abrir el Sprint 4 |
| Conectar `prefs.js` a toda la app y a `settings.json` | `app.js` lee sus 22 claves de forma síncrona al cargar: conectarlo obliga a reordenar el arranque. Su primer usuario real es el panel de personalización | Sprint 5 |
| Carátulas por protocolo de archivos en vez de base64 | Menos memoria y menos IPC; mejor junto al trabajo de memoria | Sprint 4 (con la memoria) |
| Corrección fina de «asentado» en Traza y Cinta | Comparar cada muelle con su destino real | Sprint 4 |
