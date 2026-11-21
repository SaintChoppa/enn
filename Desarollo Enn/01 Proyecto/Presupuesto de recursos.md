---
resumen: Objetivos medibles de RAM/CPU, mediciones reales (166 MB en reposo) y estado del portaje a Linux.
estado: vivo
actualizado: 2026-11-09
tags: [enn, rendimiento, linux]
---

# Objetivos y presupuesto de recursos

Actualizado 2026-09-12.

## Presupuesto de recursos (F5)

Enn se diseña con presupuesto explícito. Objetivos medibles para biblioteca de ~5.000 pistas:

**Medición real (2026-09-13, Windows, biblioteca pequeña, ventana en reposo)**

| Métrica | Objetivo | Debug | Release | Estado |
|---|---|---|---|---|
| RSS total en reposo (exe + hijos WebView propios) | < 120 MB | **166.3 MB** | **166.5 MB** | ⚠ superado: el WebView2 domina (124 MB); revisar abajo |
| — exe Rust | — | 32.7–42.2 MB | 42.4 MB | ✔ excelente |
| — procesos WebView2 propios (2) | — | 133.6 MB | 124.1 MB | ↑ domina el render del glassmorphism |
| CPU en reposo (10 s) | ~0 % | 0.05 s (≈0.5 %) | 0.3 s total ≈ 1.2 % medio con arranque | ✔ |
| RSS reproduciendo + mezclador | < 150 MB | — | por medir | pendiente |
| CPU reproducción (compartido) | < 2 % | por medir | por medir | pendiente |
| CPU reproducción (exclusivo) | < 3 % | por medir | por medir | pendiente |
| Arranque en frío | < 2 s | cronómetro del usuario | — | pendiente de tu medida |
| Memoria caché de carátulas (UI) | acotada | data URI bajo demanda + IntersectionObserver | igual | ✔ por diseño |
| Anillo de espectro en el motor | 8192 f32 (32 KB) fijo | constante en `Core` | igual | ✔ por diseño |
| Tabla del resampler | 256×64 f32 (64 KB) por tasa | constante | igual | ✔ por diseño |

**Nota sobre el RSS**: el objetivo de 120 MB quedaba corto — WebView2 con paneles
glassmorphism (backdrop-filter) y la biblioteca renderizada ocupa ~124 MB por sí solo,
y es igual en debug y release (el Rust apenas pesa). Caminos de optimización futuros
si se quiere bajar: reducir capas con backdrop-filter (dejarlo solo en la barra),
render de la biblioteca más agresivo, o `WebView2 --memory-pressure` flags. No es
prioritario: 166 MB está en la media de reproductores Electron (300–500 MB) por debajo.

**Metodología**: `Start-Process target
elease\enn.exe` → dormir 14 s → sumar
WorkingSet del exe + procesos hijos WebView2 cuyo ParentProcessId sea el de Enn
(excluye WebViews de otras apps: filtrar por padre es obligatorio, el total del
sistema da ~2 GB engañosos) → CPU = suma de segundos de procesador del exe.

**Decisiones de diseño que lo hacen posible**
- Sondeo ligero (250 ms estado, 400 ms descargas) en lugar de eventos acumulables
- Render de biblioteca por ventanas (500 + 300 al scroll)
- Carátulas: extracción de solo cabeceras + caché en disco con podado (máx ~1500)
- Waveforms: cálculo en segundo plano una vez, caché en disco, 240 bytes por pista
- Espectro: FFT solo cuando el mezclador está visible (12 fps)
- Descargas serie (un yt-dlp a la vez)
- **(2026-09-25)** Escaneo de biblioteca paralelizado con `rayon` (`scan_into`/`refresh`/`probe_many`) — mejora cualitativa confirmada para bibliotecas grandes; falta medir cifras concretas de antes/después en esta tabla

**Cómo medir (Windows)**

```powershell
Get-Process enn | Select-Object Name, @{n='RSS(MB)';e={[math]::Round($_.WorkingSet64/1MB)}}, CPU
```

Registrar los resultados reales en esta tabla tras cada fase de optimización.

## Estado del portaje a Linux

| Componente | Windows (hoy) | Camino Linux |
|---|---|---|
| Decodificación | Symphonia | igual (puro Rust) |
| Salida compartida | CPAL/WASAPI | CPAL/ALSA-PipeWire |
| Salida exclusiva | `exclusive.rs` (IAudioClient) | ALSA "hw:" o PipeWire quantum | 
| Controles sistema | souvlaki→SMTC | souvlaki→MPRIS (mismo código) |
| Hotkeys | plugin global-shortcut | igual (X11/Wayland vía plugin) |
| Bandeja | Tauri tray-icon | igual |
| "Mostrar en carpeta" | explorer /select | xdg-open (ya implementado) |
| yt-dlp/ffmpeg sidecars | .exe descargados en build.rs (con checksum SHA-256 de yt-dlp desde 2026-09-25) | binarios Linux equivalentes |
| Modo portable | Enn.portable junto al exe | mismo mecanismo |
| CI | Windows + Ubuntu + **macOS** en la matriz desde 2026-09-25 | ya cubierto en la misma matriz; sin verificar aún en un run real de GH Actions |
