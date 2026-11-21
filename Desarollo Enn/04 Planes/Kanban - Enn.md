---

kanban-plugin: board
resumen: Tablero de trabajo (plugin Kanban); una tarjeta por tarea, el detalle está en la nota enlazada.
estado: vivo
actualizado: 2026-11-09
tags: [enn, kanban, seguimiento]

---

## Por hacer

- [ ] Beta 0.2 · Memoria: ~490 MB (objetivo 200 MB). Decidir objetivo realista o dedicarle trabajo; pregunta al abrir el Sprint 4 ([[Pruebas - Sprint 1]])
- [ ] Beta 0.2 · Medir CPU con la ventana cerrada a la bandeja de verdad y CPU sonando en Simple
- [ ] Beta 0.2 · Vista previa en frío tarda 4–6 s (objetivo < 4 s): ¿resolver más resultados de antemano? Pregunta al propietario ([[Pruebas - Sprint 2]])
- [ ] Beta 0.2 · Revisión del propietario del *feel* de las descargas (llenado, «finalizando», anillos de la vista previa)
- [ ] Beta 0.2 · Descargas: preguntar antes de un lote de más de 10 con conexión de uso medido (Sprint 7)
- [ ] Beta 0.2 · Radio: 30 minutos con la biblioteca real apuntando los saltos que chirrían (objetivo ≤ 1 de cada 15) ([[Pruebas - Sprint 3]])
- [ ] Beta 0.2 · Etiquetas: «Pop latino» abarca casi todo el urbano en español (Deezer solo dice «Latin Music»). ¿Last.fm o reglas por artista? Pregunta al propietario
- [ ] Beta 0.2 · Etiquetas: K-pop y títulos con mucho ruido sin etiquetas (10 de 111); limpiar más el título (Sprint 7)
- [ ] Beta 0.2 · Escuchas: con crossfade, la interfaz no avisa del inicio de la siguiente (Sprint 4)
- [ ] Beta 0.2 · Sprint 4 — Movimiento: animación elástica, ola de color, Simple ↔ Studio ([[Sprint 4 - Movimiento]])
- [ ] Beta 0.2 · Sprint 5 — Personalización: panel y destello de bordes ([[Sprint 5 - Personalización]])
- [ ] Beta 0.2 · Sprint 6 — Video de fondo ([[Sprint 6 - Video de fondo]])
- [ ] Beta 0.2 · Sprint 7 — Estabilizar, empaquetar y lanzar ([[Sprint 7 - Beta]])
- [ ] Auditoría de interfaz 2026-11-13 · ALTA: cajón del ecualizador cerrado enfocable con Tab (posible causa del +12 dB) → `inert` ([[Auditoría de interfaz 2026-11-13]])
- [ ] Auditoría de interfaz 2026-11-13 · ALTA: el cambio a Simple puede quedarse colgado si las animaciones no terminan → tope de tiempo
- [ ] Auditoría de interfaz 2026-11-13 · MEDIA: contraste bajo de rótulos (`--text-faint`) y texto de 7,5–9 px
- [ ] Auditoría de interfaz 2026-11-13 · BAJA: objetivos pequeños, panel de pistas estrecho en Studio, coste de `markPlayingRow`
- [ ] Logo: confirmar permiso o licencia del dibujo antes de publicar el repo (ADR #132)
- [ ] Probar de oído la salida exclusiva tras la corrección del 2026-11-09 (archivos de 44,1 / 96 kHz)
- [ ] Visualizador: revisión del propietario (difuminado, movimiento, sincronía del pulso con el golpe)
- [ ] Buscador: probar el aviso con la red cortada (la descarga real desde las pastillas ya se probó el 2026-11-17)
- [ ] Ecualizador: confirmar que no vuelve el +12 dB tras la corrección de los atajos de teclado (ADR #128). Si vuelve, buscar «EQ:» en el log
- [ ] Rediseño: revisión del propietario del *feel* de las animaciones (botones, cambio de modo, cajón, arrastre de la cola)
- [ ] Volumen de la app: quedó en 0 tras las pruebas del 2026-11-09 (antes 126); subirlo a mano
- [ ] Botón del mezclador `#btn-mixer`: decidir si se muestra (el código dice que se oculta a propósito, por Ctrl+Alt+M) — decide el propietario
- [ ] Reposo en Simple: el bloque queda algo alto porque la cola oculta sigue reservando su espacio
- [ ] Ecualizador desplegado en Simple: la portada hace scroll, conviene vigilarlo
- [ ] Revisar la decisión del ecualizador cuando el propietario la vea montada (salió reñida: 0,51 frente a 0,37)
- [ ] A ojo del propietario: el *feel* del cambio de modo y de las entradas; ¿la inactividad aplica en toda Simple o solo en «Reproduciendo»?
- [ ] Documentar el sistema de botones por tokens y los estados de foco en [[Diseño - Sistema visual]]
- [ ] La carpeta `C:\Users\hectr\Music` quedó casi vacía: confirmar si hay que volver a escanear la música
- [ ] Git: decidir cuándo commitear (17 archivos modificados + 7 sin seguimiento) y hacer push de los 30 commits pendientes

## En curso



## Hecho

**Complete**
- [x] 2026-11-17 — **Beta 0.2 · Sprint 3 cerrado**: 91 % de la biblioteca con etiquetas reales, radio que sigue el hilo y lo explica, almacén de escuchas, tarjeta de recomendaciones ([[Pruebas - Sprint 3]])
- [x] 2026-11-17 — **Beta 0.2 · Sprint 2 cerrado**: vista previa de 10 s, descargas en paralelo 2,55× más rápidas, yt-dlp al día solo y verificado, final animado, hallazgo n.º 3 cerrado ([[Pruebas - Sprint 2]])
- [x] 2026-11-16 — **Beta 0.2 · Sprint 1 cerrado**: arranque −40 %, reposo 62 % → ~0,5 %, primer ▶ 140 ms, 0 cortes con carga ([[Pruebas - Sprint 1]])
- [x] 2026-11-13 — Selector de formato encima de la búsqueda de Descargas (ADR #159)
- [x] 2026-11-13 — Cifras del ecualizador más claras, barra de sensibilidad, botones en pastilla (ADR #157, #158)
- [x] 2026-11-13 — Corregido: tras caer el dispositivo sin nada sonando no volvía a sonar nada
- [x] 2026-11-13 — Descargas se mantiene al cambiar de modo; perillas del ecualizador; espectro en lápiz con línea de pico (ADR #155, #156)
- [x] 2026-11-12 — Quitado el aleatorio: lo sustituye la radio (ADR #154)
- [x] 2026-11-12 — Radio al azar por toda la biblioteca, la cola espera (ADR #152)
- [x] 2026-11-12 — «Todas las pistas»: iconos, filas grandes, 4 vistas, buscar abre, segundo clic cierra (ADR #153)
- [x] 2026-11-12 — Igualar volumen entre canciones, automático, con la barra que se mueve sola (ADR #148, #149)
- [x] 2026-11-12 — «Siguientes» vacía al abrir; onda alineada; pastilla más grande; rueda suave (ADR #150, #151)
- [x] 2026-11-12 — Volumen de ancho fijo, sin alargarse (ADR #146)
- [x] 2026-11-12 — Revisión de la app: 7 bugs corregidos (ADR #147)
- [x] 2026-11-12 — Cancelar/salir borra los archivos a medias de la descarga; cancelar mata también ffmpeg (ADR #145)
- [x] 2026-11-12 — Corregidos los 5 bugs de la auditoría (descargador y bandeja, ventana congelada, `#EXTM3U` doble, duraciones ≥ 1 h) (ADR #144)
- [x] 2026-11-09 — Cola: botón ▶ por fila; la fila solo se arrastra (ADR #130)
- [x] 2026-11-09 — Desplegables propios legibles en toda la app (ADR #129)
- [x] 2026-11-09 — Telemetría de Studio en su propia fila a todo el ancho; mínimo de ventana 1366×768
- [x] 2026-11-09 — Biblioteca: «Todas las pistas» con filas completas y orden; «Artistas» en rejilla de 2 columnas con página
- [x] 2026-11-09 — Cola, «Ya en tu biblioteca», paleta en pausa, Simple centrado, lista vieja de Descargas fuera, atajos de teclado
- [x] 2026-11-09 — Buscador de descargas: YouTube Music en tiempo real, pastillas, álbumes oficiales, barras de progreso y telemetría sin recortes → [[Buscador de descargas 2026-11-09]]
- [x] 2026-11-09 — Rediseño: IBM Plex Sans, resortes, transiciones, ventana de Ajustes, Simple centrado con cajón, cola con arrastre, ecualizador con cifras → [[Rediseño de interfaz 2026-11-09]]
- [x] 2026-11-09 — Corregido el modo exclusivo: el motor ya conoce la tasa real del dispositivo (`set_output_format`) → [[Visualizador - Cinta y Traza]]
- [x] 2026-11-09 — Visualizador Cinta y Traza implementado y verificado en la ventana nativa: lookahead real en el motor, `get_viz_frame`, `ui/viz/`, vista Ajustes → [[Visualizador - Cinta y Traza]]
- [x] 2026-11-09 — Bóveda reorganizada para LLM, plugin Kanban instalado, roadmap movido a la bóveda, [[Registro de cambios]] creado y worktrees viejos borrados
- [x] 2026-10-04 — Segunda ronda: centrado en Simple, ecualizador movido a la portada y barra lateral inset → [[Plan de interfaz 2026-10-03]]
- [x] 2026-10-04 — Primera ronda: botón «↻ Reestablecer», cromo que se funde a los 3 s, cola en cristal en Simple, sin barras en Simple, filas de Studio que entran desde la derecha
- [x] 2026-10-03 — Verificación final: `node --check`, eslint, `fmt`, `clippy -D warnings`, 19/19 tests, build y ventana nativa
- [x] 2026-10-03 — Fase 6: notas [[Diseño - Producto]] y [[Diseño - Sistema visual]]
- [x] 2026-10-03 — Fase 5: botones por tokens, `:focus-visible`, `:active` con escala y escala tipográfica
- [x] 2026-10-03 — Fase 4: panel de pistas colapsable y redimensionable, con su estado recordado
- [x] 2026-10-03 — Ecualizador completo en Studio a todo el ancho del escenario; en Simple, plegado detrás de su botón
- [x] 2026-10-03 — Un solo visualizador por modo
- [x] 2026-10-03 — Fases 3 y 3b: ecualizador usable en Studio y movido al escenario
- [x] 2026-10-03 — Fases 2 y 2b: estado sin canciones (4 casos + error de escaneo), sin pista fantasma
- [x] 2026-10-03 — Fase 1: descargas que se abren y cierran a voluntad
- [x] 2026-10-03 — Plan de interfaz escrito y aprobado → [[Plan de interfaz 2026-10-03]]
- [x] 2026-10-03 — Auditoría de bugs con sus correcciones → [[Auditoría de bugs 2026-10-03]]




%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[false,false,true],"show-checkboxes":true}
```
%%
