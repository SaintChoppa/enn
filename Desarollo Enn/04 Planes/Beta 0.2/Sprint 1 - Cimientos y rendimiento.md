---
resumen: Sprint 1 de la beta 0.2. Arranque rápido (el motor de audio deja de bloquear el inicio), multinúcleo con trabajos de fondo, y las piezas base que usan los demás sprints (preferencias, movimiento, pruebas de interfaz, medición).
estado: propuesto
actualizado: 2026-11-15
tags: [enn, beta, sprint, rendimiento]
---

# Sprint 1 — Cimientos y rendimiento

Parte del [[Plan maestro - Beta 0.2]]. Evidencia en [[Investigación - Beta 0.2]].

**Objetivo**: que Enn abra rápido de verdad, use todos los núcleos sin gastar de más, y dejar puestas las piezas que necesitan los sprints siguientes.

## Preguntas de apertura

1. **Git.** Hay 48 archivos sin commitear y la regla es no commitear. Para la beta hacen falta puntos de vuelta atrás. Propuesta: una rama `beta-0.2` con un commit al cerrar cada sprint (sin `push` hasta que lo digas). ¿Se permite?
   - **Respondida el 2026-11-16: no, sin commits todavía.** Los puntos de vuelta atrás se hacen fuera de Git (ver «Copias de seguridad» en la tabla de decisiones).

No hay más preguntas: el resto son decisiones técnicas que quedan en la tabla de abajo.

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Dispositivo de audio al arrancar | No se abre en `setup()`. Se abre en segundo plano 300 ms después de mostrar la ventana, o al primer ▶ si llega antes | Es lo que hoy bloquea el inicio (ver evidencia) |
| Salida exclusiva que falla | Se recuerda por dispositivo que no la admite y no se vuelve a probar hasta que cambie el dispositivo o el ajuste | Con FxSound falla siempre, tras probar todos los formatos |
| Ventana | Se crea con el color de fondo de la app y un esqueleto fijo en el HTML; el contenido entra con un fundido | Microsoft recomienda no usar el webview como pantalla de carga |
| Estado del motor | El motor avisa por eventos cuando algo cambia; el sondeo de 250 ms desaparece. La posición llega 4 veces por segundo solo si suena y la ventana se ve | Bajo consumo |
| Ventana oculta en la bandeja | Cero trabajo de interfaz | Bajo consumo |
| Abrir con Windows | Opción en Ajustes, apagada por defecto, minimizado en la bandeja | Como Spotify |
| Hilos de fondo | Núcleos − 1 (mínimo 1, máximo 6), prioridad de fondo; con batería, 1 | Rápido sin molestar |
| GPU del visualizador | `powerPreference` pasa de `high-performance` a `default` | No forzar la gráfica dedicada |
| Instancia única | La segunda ejecución enfoca la primera | Evita dos motores |
| Copias de seguridad (en lugar de commits) | Al empezar y al cerrar cada sprint se guarda un zip fechado del código (`src-tauri/src`, configuración, `ui/`, sin binarios ni caché) en `.snapshots/` dentro de la carpeta del proyecto, ignorada solo en local (`.git/info/exclude`, sin tocar archivos versionados) | El propietario no quiere commits todavía; sin esto no habría forma de volver atrás |

## Trabajo

### A. Medir antes de tocar

- `perf.rs` + `ui/perf.js`: marcas `proceso`, `setup-fin`, `ventana`, `dom`, `primera-pintura`, `biblioteca-pintada`, `interactivo`, `audio-listo`. Se escriben en el log y las devuelve el comando `perf_report`.
- Argumento `--bench-startup`: arranca, espera a `interactivo`, escribe el informe y sale.
- `scripts/bench-startup.ps1`: 10 arranques en frío de la versión *release*, mediana y percentil 90; guarda la tabla en la nota de pruebas.
- Contador de cortes de audio (`xruns`) y duración máxima y percentil 99 de la llamada de audio.
- **Línea base** con el código tal como está, antes de cualquier cambio.

### B. Arranque

| # | Cambio | Dónde |
|---|---|---|
| B1 | Apertura del dispositivo fuera de `setup()`; `set_exclusive` al arrancar solo guarda el ajuste | `lib.rs` (`apply_settings`), `player.rs` |
| B2 | Memoria de «exclusiva no admitida» por dispositivo | `player.rs`, `exclusive.rs` |
| B3 | `backgroundColor` de la ventana y esqueleto con CSS crítico en línea; mostrar al primer fotograma | `tauri.conf.json`, `index.html` |
| B4 | `init()` en paralelo: biblioteca y ajustes primero; dispositivos solo al abrir Ajustes o el menú del altavoz | `app.js` |
| B5 | `lib_list`, `list_devices`, `select_device`, `waveform`, `settings_set`, `lib_remove_track`, `playlist_*` fuera del hilo de la ventana | `lib.rs` |
| B6 | Fechas de archivo guardadas (no recalcular en cada arranque); biblioteca cargada en segundo plano | `library.rs` |
| B7 | Visualizador: se crea cuando la interfaz ya responde y solo compila el estilo elegido | `ui/viz/index.js` |
| B8 | Favicon de 32 px (hoy 282 KB); precarga de la fuente principal | `index.html`, `ui/img/` |
| B9 | `[profile.release]`: `lto = "thin"`, `codegen-units = 1`, `strip = true`, `opt-level = 3`. **Sin** `panic = "abort"` (el motor usa `catch_unwind`) | `Cargo.toml` |
| B10 | Eventos del motor en vez de sondeo; pausa total con la ventana oculta | `player.rs` (`reporter_loop`), `app.js` |
| B11 | Carátulas por protocolo de archivos con caché, en vez de base64 por IPC | `tauri.conf.json` (`assetProtocol`), `art.rs`, `app.js` |
| B12 | Instancia única y opción «Abrir con Windows» | `Cargo.toml`, `lib.rs`, Ajustes |
| B13 | `markPlayingRow()` toca solo la fila que cambia (hallazgo n.º 8 de la auditoría) | `app.js` |
| B14 | Cajón del ecualizador `inert` cuando está cerrado (hallazgo n.º 1; posible causa del +12 dB) | `app.js` (`setEqOpen`) |

### C. Multinúcleo

- `jobs.rs` — `BgPool`: grupo de hilos `enn-bg` con prioridad de fondo de Windows. Interfaz: `BgPool::spawn(f)`, `BgPool::map(items, f)`, `BgPool::set_saver(bool)`.
- El análisis de volumen pasa de un hilo, pista a pista, a `BgPool::map`; guarda cada 25 pistas como ahora.
- Forma de onda y miniaturas de carátula, por el mismo grupo.
- Hilo de audio registrado en MMCSS («Pro Audio») para que nada de lo anterior lo interrumpa.
- **Decisión con datos**: si el percentil 99 de la llamada de audio supera el 30 % del periodo del búfer con el grupo a plena carga, la decodificación sale a un hilo propio con un anillo sin bloqueos de ~2 s. Si no lo supera, se deja como está.
- En la interfaz: la extracción de color de la carátula pasa a un *worker*; el filtrado y orden de la biblioteca también cuando haya más de 2 000 pistas.

### D. Piezas base

- `ui/prefs.js`: esquema `{ id, tipo, por_defecto, sección, desde }`, validación, migración de las 22 claves `enn.*` de `localStorage`, eventos de cambio; persistencia en `settings.json` con `prefs_get` / `prefs_set`. Las claves desconocidas se conservan (compatibilidad hacia delante).
- `ui/motion.css` + `ui/motion.js`: fichas `--spring-snappy`, `--spring-bouncy`, `--spring-elastic`, duraciones, `spring(el, keyframes, tipo)` sobre WAAPI y nivel de animación (`completas` / `suaves` / `mínimas`).
- `npm test` con `node --test` en `ui/tests/`; se añade a la CI.
- Escritura atómica (temporal + renombrar) para `library.json` y `settings.json`.

## Por si acaso

| Caso | Qué pasa |
|---|---|
| ▶ antes de que el dispositivo esté abierto | La canción espera a la apertura (máx. 2 s) con el botón en estado «preparando»; si falla, aviso y reintento |
| El dispositivo guardado ya no existe | Se usa el predeterminado y se avisa una vez |
| La exclusiva deja de fallar (cambio de dispositivo o de controlador) | La memoria se borra al cambiar el dispositivo, el ajuste o la versión de Enn |
| `settings.json` de la 0.1 | Migración con copia `settings.json.bak-<fecha>`; si no se puede leer, valores por defecto y aviso |
| `localStorage` vacío o bloqueado | `prefs` funciona con valores por defecto |
| WebView2 tarda (antivirus, disco lento) | Se ve la ventana con su fondo y el esqueleto, nunca un rectángulo blanco |
| Equipo de 2 núcleos | 1 hilo de fondo; el análisis espera a que no suene nada si hay cortes |
| Portátil con batería | Modo ahorro automático |
| Segunda instancia con una ruta de archivo como argumento | Se pasa a la primera y se pone en cola |
| La biblioteca aún carga cuando el usuario escribe en el buscador | La búsqueda se aplica al terminar la carga |
| Evento del motor perdido | Resincronización completa cada 5 s mientras suena |
| El arranque con Windows no gusta | Se apaga desde Ajustes o desde el Administrador de tareas |

## Prueba de aceptación

**Automáticas**
- `perf`: las marcas salen en orden y `interactivo` llega aunque no haya dispositivo de audio.
- `jobs`: `BgPool::map` devuelve los resultados en orden, respeta el máximo de hilos y `set_saver(true)` lo baja a 1.
- `prefs` (`ui/tests/prefs.test.js`): migra las claves antiguas, corrige valores inválidos al valor por defecto, conserva claves desconocidas.
- Motor: abrir el dispositivo en diferido no pierde el primer ▶ (prueba con dispositivo simulado).
- Todas las puertas, más `npm test`.

**Medidas (versión *release*, 10 arranques)**
- Tabla antes/después: ventana visible ≤ 0,4 s e interactivo ≤ 1,2 s (o la mejora que permita WebView2, documentada).
- CPU en reposo < 0,5 % durante 60 s; con la ventana oculta, sin actividad de interfaz.
- Prueba de carga: FLAC sonando mientras se analizan las 104 pistas con todos los hilos → 0 cortes.

**A mano**
- Abrir, cerrar a la bandeja y reabrir; abrir dos veces; arrancar sin altavoces; arrancar con la salida exclusiva activada.

## Hecho cuando

- [ ] Línea base y tabla final en `05 Registro/Pruebas - Sprint 1.md`
- [ ] Presupuestos de arranque y de reposo cumplidos o justificados con números
- [ ] 0 cortes de audio en la prueba de carga
- [ ] `prefs`, `motion`, `BgPool`, `perf` y `npm test` disponibles para los demás sprints
- [ ] Hallazgos n.º 1 y n.º 8 de la auditoría cerrados
