---
resumen: Sprint 7 de la beta 0.2. Estabilización, cierre de la auditoría pendiente, primer uso, instalador, firma, actualizaciones automáticas, cumplimiento de licencias, matriz de pruebas y lanzamiento de la 0.2.0-beta.1.
estado: propuesto
actualizado: 2026-11-15
tags: [enn, beta, sprint, lanzamiento]
---

# Sprint 7 — Beta

Parte del [[Plan maestro - Beta 0.2]]. Va el último: reúne todo y lo deja instalable.

**Objetivo**: una versión `0.2.0-beta.1` que alguien que no eres tú pueda instalar, usar y actualizar sin ayuda.

## Preguntas de apertura

1. **Firma del instalador.** Sin firma, Windows muestra «Windows protegió su PC» al instalar. Opciones: SignPath Foundation (gratuita para proyectos de código abierto, requiere solicitud), Azure Trusted Signing (de pago mensual, requiere verificar identidad y no está disponible en todos los países), o salir sin firma con instrucciones para la primera beta.
2. **Beta abierta o cerrada.** ¿Publicación pública en GitHub, o instalador para un grupo pequeño primero?
3. **Informes de fallos.** Hoy no sale nada de la app. Propuesta: seguir así y añadir «Copiar diagnóstico» para que el usuario lo pegue donde quiera. ¿De acuerdo, o prefieres envío voluntario?
4. **Logo.** Sigue pendiente confirmar el permiso o la licencia del dibujo (ADR #132). Bloquea la publicación.

## Trabajo

### A. Estabilizar

- Hallazgos pendientes de la [[Auditoría de interfaz 2026-11-13]]: contraste (n.º 4), texto diminuto (n.º 5), objetivos pequeños (n.º 6), panel de pistas estrecho en Studio (n.º 7).
- Tarjetas abiertas del Kanban que afectan a la beta (salida exclusiva de oído, reposo en Simple, etc.).
- Caza de fallos de dos sesiones: cada función del plan, con la lista de «por si acaso» de su sprint como guion.
- Prueba de resistencia: 8 horas sonando con radio, video y descargas ocasionales. Memoria con deriva < 10 MB, 0 cortes de audio.
- Registro en archivo (`enn.log`, con rotación) y captura de pánicos del motor; «Copiar diagnóstico» en Ajustes (versión, sistema, dispositivo de audio, últimos errores; sin rutas personales ni títulos).
- Revisión de código y de seguridad completas (`code-review`, `security-review`): comandos de Tauri, argumentos que llegan a yt-dlp y ffmpeg, rutas que se forman con datos de fuera, actualizador.

### B. Primer uso

Al abrir por primera vez:
1. Elegir la carpeta de música (o empezar por Descargas).
2. Una pantalla clara con los interruptores de lo que usa red: enriquecer con datos en línea, descargar videos, actualizar el descargador. Con su explicación de qué se envía.
3. Análisis de la biblioteca en segundo plano con avance visible y sin bloquear.

Al venir de la 0.1: copia de seguridad de `library.json` y `settings.json`, migración y aviso de lo nuevo.

### C. Empaquetado

| Tema | Trabajo |
|---|---|
| Versión | `0.2.0-beta.1` en `package.json`, `Cargo.toml` y `tauri.conf.json` |
| Instalador | NSIS por usuario, sin permisos de administrador; WebView2 con instalador en línea |
| Tamaño | ffmpeg pesa 103 MB: sustituirlo por una compilación reducida (solo lo que Enn usa) si baja de 40 MB sin perder funciones |
| Seguridad | Hoy `csp` es `null`: definir una política que permita solo lo propio, el protocolo de archivos y las miniaturas remotas necesarias; repasar permisos |
| Firma | Según la pregunta 1 |
| Actualizaciones | `tauri-plugin-updater` con las publicaciones de GitHub; claves de firma propias (la privada, solo en los secretos de la CI); canal «beta» |
| Experiencia de actualización | Descarga silenciosa, punto de aviso y «Reiniciar para actualizar»; nunca corta la música |
| CI | Flujo de publicación: etiqueta `v0.2.0-beta.1` → compila → firma → sube instalador y `latest.json`. Las puertas actuales más `npm test` |

### D. Cumplimiento y documentación

- Licencias de lo que se empaqueta: yt-dlp, ffmpeg (según la compilación: texto de la licencia y enlace al código), fuente IBM Plex, bibliotecas de Rust (`cargo about` o equivalente). Pantalla «Acerca de» con todo.
- Términos de los servicios consultados (Deezer, iTunes, Last.fm si se usa): atribución donde la pidan.
- Aviso de uso responsable en Descargas: la herramienta es para contenido que el usuario tiene derecho a descargar.
- `README` con capturas, `CHANGELOG`, problemas conocidos, cómo informar de un fallo (las plantillas ya existen).
- Bóveda: [[Características actuales]] y [[Arquitectura]] al día con todo lo nuevo.

## Matriz de pruebas

| Eje | Casos |
|---|---|
| Sistema | Windows 10 22H2 · Windows 11 |
| Gráfica | Integrada · dedicada |
| Pantalla | 60 Hz · 144 Hz o más · escala 100 % y 150 % |
| Audio | Predeterminado · Bluetooth · DAC USB en exclusiva · FxSound |
| Red | Normal · sin conexión · lenta · de uso medido |
| Instalación | Limpia · encima de la 0.1 · modo portable |
| Biblioteca | La real (104) · sintética de 10 000 pistas |
| Rutas | Con acentos, cirílico, japonés, emoji, muy largas, dentro de OneDrive |
| Energía | Enchufado · con batería |

## Por si acaso

| Caso | Qué pasa |
|---|---|
| GitHub retira el repositorio o el instalador (riesgo real en descargadores de YouTube) | Copia de los instaladores fuera de GitHub; el descargador se puede separar en un componente opcional si hiciera falta; el actualizador admite cambiar de dirección |
| La actualización se descarga mal | La firma no coincide → se descarta y se reintenta; la app sigue con la versión actual |
| Una actualización rompe algo | Se puede volver a instalar la anterior; los datos tienen copia previa a cada migración |
| SmartScreen asusta al usuario | Instrucciones con captura en el `README` mientras no haya firma |
| La migración desde la 0.1 falla | Se restaura la copia y se arranca con valores por defecto, avisando |
| Antivirus marca yt-dlp o ffmpeg | Documentado en problemas conocidos; la firma lo reduce |
| WebView2 no está instalado | El instalador lo descarga; mensaje claro si no hay red |
| La clave de firma de actualizaciones se pierde | Copia cifrada fuera del equipo; sin ella no se puede actualizar a nadie: se documenta dónde está |
| Alguien informa de un fallo sin datos | «Copiar diagnóstico» da lo necesario sin información personal |

## Prueba de aceptación

- Presupuestos de la sección 1 del plan maestro, medidos con el instalable y anotados.
- Matriz de pruebas recorrida (lo que no se pueda probar por falta de equipo, anotado como no verificado).
- Prueba de resistencia de 8 horas superada.
- Instalación limpia y actualización desde la 0.1 y desde una 0.2 anterior con el actualizador.
- Todas las puertas en verde en la CI, incluida la publicación en un repositorio de prueba.
- Una semana de uso real del propietario.

## Hecho cuando

- [ ] 0 fallos altos conocidos; auditoría cerrada o aceptada punto por punto
- [ ] Instalador `0.2.0-beta.1` generado por la CI
- [ ] Actualización automática probada de extremo a extremo
- [ ] Licencias y «Acerca de» completos; logo con permiso confirmado
- [ ] `README`, `CHANGELOG` y problemas conocidos publicados
- [ ] Visto bueno del propietario
- [ ] Resultados en `05 Registro/Pruebas - Sprint 7.md`
