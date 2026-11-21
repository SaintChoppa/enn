---
resumen: Usuarios, problema que resuelve, principios de diseño y no-objetivos de Enn.
estado: vivo
actualizado: 2026-11-09
tags: [enn, diseño, producto]
status: vigente
created: 2026-10-03
---

# Diseño — Producto

Contexto de producto de Enn, reunido a partir de lo que ya dicen las notas de la
bóveda y el `README.md` de la raíz. **No introduce visión nueva**; cada afirmación
va con su fuente. Los principios y no-objetivos que aparecen aquí estaban ya
declarados, solo se consolidan en un sitio.

## Qué es Enn

Reproductor de música local para Windows. Núcleo en **Rust** (decodificación con
Symphonia, salida con CPAL sobre WASAPI) e interfaz **Tauri 2** con UI web sin
frameworks ([[Visión y objetivos]] §Stack). Todo el procesamiento —decodificación,
mezcla, ecualización y salida— ocurre de forma local: «sin suscripciones, sin
telemetría, sin procesos auxiliares» ([[00 Índice]] §Filosofía).

## Para quién es

No hay un «persona» formal en la bóveda; el usuario objetivo se deduce de la
tabla de competidores y del posicionamiento ([[Visión y objetivos]]):

| Usuario que Enn busca | Por qué las alternativas no le sirven |
|---|---|
| Quien tiene su música en disco y quiere reproducirla ya | Spotify exige suscripción y telemetría; pesa más en RAM |
| Quien cuida la calidad de sonido pero no quiere configurar | foobar2000 tiene «interfaz anticuada y difícil»; Audirvana/Roon, «precio prohibitivo» |
| Quien quiere biblioteca usable sin un gestor pesado | VLC reproduce todo pero con «experiencia de biblioteca casi nula»; MusicBee «pesa más, muchas opciones» |

**Posicionamiento declarado**: «reproductor ligero, nativo, con calidad de audio
seria y funciones modernas (descarga, playlists, EQ) sin fricción»
([[Visión y objetivos]] §Competidores).

## Qué problema resuelve

La nota de contexto lo plantea como un hueco de mercado: «sigue siendo poco
frecuente encontrar una [aplicación] que satisfaga al mismo tiempo tres
criterios» — **bajo consumo de memoria**, **soporte amplio de formatos** e
**interfaz de uso inmediato** ([[Visión y objetivos]] §El problema). La apuesta de
Enn es un «punto intermedio deliberado»:

- motor de audio en tiempo real simple: el archivo se decodifica bajo demanda, a
  f32, por una cadena de biquads hasta el dispositivo del sistema;
- la operación típica es «agregar una carpeta, elegir una canción y la
  reproducción comienza de inmediato»;
- cero dependencia de servicios remotos para el núcleo ([[Visión y objetivos]]).

## Principios de diseño ya declarados

1. **Reproductor ligero y nativo.** Rust + Tauri 2 + UI web sin frameworks, en
   vez de Electron: «un GC'd runtime… hace ese presupuesto de latencia mucho más
   difícil de garantizar», y Electron embarca «un Chromium + Node completo
   (100+ MB)» para lo que aquí «es un shell fino de HTML/CSS/JS» (`README.md`
   §Design decisions). La CI verifica el portaje a Linux en cada push
   ([[Visión y objetivos]] §4).

2. **Calidad de audio seria como identidad.** «El audio es la identidad del
   proyecto»: prioridad a WASAPI exclusivo, resampling de calidad, Hi-Res,
   ReplayGain y una cadena DSP limpia ([[Visión y objetivos]] §5). En el
   código es la tubería Symphonia → f32 → EQ → resampler polifásico → device
   ([[Arquitectura]] §Flujo de audio).

3. **Interfaz de uso inmediato.** Objetivo de partida: «instant to use — add a
   folder, click a song, it plays» (`README.md` §Why Enn). Se materializa en el
   **arranque perezoso del audio** (la ventana abre al instante, el dispositivo
   se abre al reproducir; [[Decisiones de desarrollo]] #33).

4. **Sin servicios remotos.** Sin suscripciones ni telemetría ni cloud
   (`README.md` §intro, [[00 Índice]]). El único acceso a red es el descargador
   opcional (yt-dlp), que no forma parte del motor.

5. **Consumo bajo como criterio de diseño, no como efecto colateral.**
   «Presupuesto de recursos medido y documentado»; toda feature se mide
   (memoria, CPU) antes de darse por terminada ([[Visión y objetivos]] §3 y
   §Principios). Presupuesto publicado en [[Presupuesto de recursos]]
   (con la corrección de metodología de [[Auditoría de bugs 2026-10-03]] §18).

6. **Proyecto vitrina.** Enn es «un proyecto extra más en el perfil»: README de
   calidad, capturas, CI en cada push e «historia de commits limpia y decisiones
   documentadas (esta bóveda)» ([[Visión y objetivos]] §1-2). Reglas de
   trabajo asociadas: **portable primero**, **optimizado primero**, **audio
   primero**, **vitrina pública** ([[Visión y objetivos]] §Principios).

> [!note] Regla de trabajo declarada
> «Ninguna decisión de diseño se toma sin consultarlo antes»
> ([[Visión y objetivos]] §Todas las propuestas aprobadas).

## No-objetivos (lo que Enn no pretende ser)

- **No es un servicio de streaming con catálogo.** Nada de suscripción, catálogo
  remoto ni telemetría ([[Visión y objetivos]], `README.md`).
- **No compite por maximalismo de funciones.** No busca la personalización de
  foobar2000 ni el nicho de precio de Audirvana/Roon; el posicionamiento es el
  término medio ([[Visión y objetivos]] §Competidores).
- **No usa Electron ni un framework de frontend.** «A framework's reactivity
  model buys little and costs a build step, a bundle, and a dependency tree»
  (`README.md` §Design decisions; [[Decisiones de desarrollo]] #1).
- **No fabrica datos que no mide.** THD+N, jitter, headroom y latencia de buffer
  quedan explícitamente en «N/D» porque el motor no los mide; fabricarlos «sería
  falso» ([[Decisiones de desarrollo]] #67).
- **Opus no está soportado** y no se anuncia como tal: Symphonia 0.5.5 no trae
  decodificador ([[Características actuales]] §Audio; [[Auditoría de bugs 2026-10-03]] #6).
- **Fuera del alcance actual**: salida de audio nativa en Linux/macOS y «Enn
  Server» (streaming remoto), porque «requieren infraestructura/hardware no
  disponibles en este entorno»; y **letras** (necesitan fuente externa)
  ([[00 Índice]] §Estado; [[Características actuales]]).

## Dónde se conecta con el resto de la bóveda

- [[Visión y objetivos]] — problema, apuesta, competidores, stack.
- [[Visión y objetivos]] — objetivos, principios, regla de trabajo.
- [[Diseño - Sistema visual]] — cómo se traduce lo anterior en tokens y componentes.
- [[Características actuales]] — inventario verificable de lo implementado.
- [[Decisiones de desarrollo]] — ADR con contexto y consecuencia.
