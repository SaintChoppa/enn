---
resumen: Qué es Enn, contra quién compite, stack y los 5 objetivos/principios del proyecto.
estado: vivo
actualizado: 2026-11-09
tags: [enn, proyecto, objetivos]
---

# Visión y objetivos

> Fusiona las antiguas notas «Contexto general» y «Objetivos del proyecto» (2026-09-11).

## Problema y apuesta

Pocos reproductores cumplen a la vez: **bajo consumo de memoria**, **soporte amplio de formatos** e **interfaz de uso inmediato**. Los de catálogo (Spotify…) traen suscripción, telemetría y procesos auxiliares; los audiófilos (foobar2000, Audirvana…) exigen configuración y curva de aprendizaje.

Enn es el punto intermedio: motor en tiempo real simple (decodificar bajo demanda → f32 → cadena biquad → dispositivo), uso de reproductor ligero (añadir carpeta, clic, suena) y **cero servicios remotos** en el núcleo.

| Competidor | Fortaleza | Debilidad que Enn explota |
|---|---|---|
| Spotify | Catálogo enorme | Suscripción, telemetría, alta RAM |
| foobar2000 | Personalización, audio serio | Interfaz anticuada y difícil |
| MusicBee | Gestión de biblioteca | Pesa más, demasiadas opciones |
| VLC | Reproduce todo | Biblioteca casi nula |
| Audirvana/Roon | Calidad superior | Precio prohibitivo |

**Posicionamiento**: ligero, nativo, audio serio y funciones modernas (descarga, playlists, EQ) sin fricción.

## Stack

- Núcleo **Rust**: Symphonia (decodificación), CPAL/WASAPI (salida), WASAPI exclusivo propio.
- Interfaz **Tauri 2** con HTML/CSS/JS sin framework (+ Tailwind compilado desde 2026-10).
- Persistencia: JSON local + M3U/M3U8 + localStorage para lo ligero.

## Objetivos declarados

1. **Portafolio de GitHub**: README, capturas, build claro, CI en cada push, historia de commits limpia y decisiones documentadas (esta bóveda).
2. **Un proyecto extra** que rellene el perfil.
3. **Máxima optimización**: memoria y CPU como criterio de diseño, medidos → [[Presupuesto de recursos]].
4. **Portable a Linux** (CI compila Linux desde 2026-09-14, macOS desde 2026-09-25). Regla: todo lo específico de Windows (WASAPI exclusivo, SMTC) va tras `#[cfg(target_os = "windows")]` o una abstracción con su equivalente previsto (ALSA/PipeWire, MPRIS). Sin rutas `C:\` ni binarios exclusivos en el núcleo.
5. **Máxima calidad de audio**: es la identidad. WASAPI exclusivo, resampling de calidad, Hi-Res, ReplayGain y DSP limpia.

## Principios derivados

- **Portable primero** · **Optimizado primero** (medir antes de dar por hecho) · **Audio primero** (nada que degrade la cadena) · **Vitrina pública** (código, README y CI presentables).
- **Regla de trabajo**: ninguna decisión de diseño se toma sin consultar al propietario.

Las 28 propuestas iniciales (aprobadas 2026-09-11) están en [[Propuestas de implementación]]; lo vigente en [[Roadmap]].
