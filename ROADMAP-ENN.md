---
tags: [enn, roadmap, portfolio, audio, tauri, rust]
status: en-progreso
created: 2026-09-25
updated: 2026-09-25
---

> [!success] Progreso de esta sesión (8 commits, todos compilados y con tests en verde)
> - ✅ Logging estructurado con niveles (`ENN_LOG=debug|warn|error`), incluida la ruta `dbg_log` desde la UI
> - ✅ Errores de yt-dlp/ffmpeg traducidos a mensajes claros en español (privado/borrado, restricción de edad, 403/429, sin red, sin espacio) en vez de stderr crudo
> - ✅ **Recuperación de dispositivo de audio desconectado en caliente** (Bluetooth que se apaga, USB desenchufado): un supervisor reabre el stream con reintentos y backoff, con aviso al usuario — antes la reproducción se congelaba en silencio para siempre, sin recuperación ni aviso
> - 🐛 De paso, un bug latente en `exclusive.rs`: el bucle de render confundía "el llamador cerró el canal" con `try_recv()==Ok`, que nunca ocurre así (el cierre real es un *Disconnected*) — un fallo real de hardware en modo exclusivo se camuflaba como cierre limpio
> - 🔒 **Vulnerabilidad real corregida**: una "URL" de descarga como `--exec=touch pwned` pasaba el único filtro que había (`contains("://")`) y yt-dlp la interpretaba como opción real — su `--exec` ejecuta shell arbitrario tras la descarga. Ahora se exige prefijo `http(s)://` literal sin espacios, en el comando de Tauri y de nuevo dentro de `enqueue()`
> - 🐛 **Bug real en `build.rs`**: descargaba yt-dlp desde una URL que devuelve 404 (confundía la convención de sidecar de Tauri con el nombre real del asset en GitHub) — cualquier clon nuevo del repo se habría quedado sin yt-dlp hasta notarlo a mano. Corregido y verificado con una descarga real en esta sesión
> - ✅ Verificación de checksum (SHA-256 contra `SHA2-256SUMS` que publica el propio yt-dlp) para el binario descargado en `build.rs` — ffmpeg (gyan.dev) no tiene un hash fetcheable equivalente, así que se documentó por qué no se fingió esa verificación
> - ✅ Escaneo de biblioteca paralelizado con `rayon` (`scan_into`/`refresh`/`probe_many`) — cada archivo se decodifica de forma independiente, así que bibliotecas grandes ya no escanean uno por uno
> - ✅ Cobertura de tests para el remuestreador (antes cero): bypass exacto fijado como regresión, más un test de FFT que confirma que un tono de 1 kHz a 44.1→48 kHz conserva su frecuencia sin distorsión armónica relevante
> - 🔍 Revisados los permisos de `capabilities/default.json`: ya es mínimo (`core:default` + `dialog:default`, sin fs/shell genéricos) — no hacía falta tocar nada
>
> Pendiente: el resto de lo marcado abajo. Lo más grande sin empezar sigue siendo la sección 14 (Enn Server + Docker/Ansible/Terraform/AWS) y la salida de audio nativa para Linux/macOS (sección 2) — ambas necesitan, respectivamente, credenciales/infra que no tengo en este entorno y una máquina real no-Windows para validar antes de dar por buena ninguna implementación.

# 🎵 Enn — Roadmap hacia "reproductor definitivo"

> [!info] Cómo usar este documento
> Cada bullet es un ítem independiente con checkbox. Márcalos como quieras (✅ aprobado / ❌ no / 💬 con dudas) y me los devuelves — **no toco nada hasta que apruebes**. Prioridad: 🔴 alta · 🟡 media · 🟢 baja. Esfuerzo estimado: `S` (horas), `M` (1-2 sesiones), `L` (varios días/feature grande).
>
> Todo lo que aparece aquí está basado en una lectura real del código actual (`src-tauri/src/*.rs`, `ui/app.js`, `.github/workflows/ci.yml`), no son suposiciones genéricas.

---

## 0. ⚠️ Antes de nada — expectativas correctas sobre "Spotify"

> [!warning] Léelo antes de aprobar la sección de importación
> No es técnicamente posible (ni legal) reproducir el catálogo con DRM de Spotify dentro de una app de terceros sin ser Spotify — su streaming está cifrado y ligado a su SDK oficial, que exige cuenta **Premium** y solo permite reproducir *dentro* de un flujo controlado por ellos, no descargar ni mezclar con tu propio motor de audio.
>
> Lo que **sí es real y legítimo**:
> - [ ] 🔴 `S` Importar una playlist de Spotify **por metadatos** (nombre, artista, álbum) vía la Web API pública de Spotify (necesitas crear una app gratuita en su Developer Dashboard — te guío en el setup, requiere tu client-id/secret).
> - [ ] 🔴 `M` Con esos metadatos, buscar automáticamente la mejor coincidencia en YouTube/SoundCloud vía yt-dlp y ofrecer descargarla a tu biblioteca local (misma lógica que ya usas para descargas individuales).
> - [ ] 🟢 `S` Modo alternativo: pegar el link de la playlist de Spotify → mostrar la lista de coincidencias encontradas antes de descargar, para que confirmes track por track (evita descargar basura por nombres ambiguos).
>
> Esto te da "listas de Spotify funcionando en Enn" de forma 100% legal y sin depender de su SDK. Lo dejo aparte para que apruebes con esa aclaración clara.

---

## 1. ⬇️ Importación, descarga y "guardar mis canciones"

- [x] 🔴 `S` **Arreglar YouTube playlists ya mismo** — ✅ hecho: `resolve_entries()` expande la URL en una tarea por vídeo antes de encolar, reutilizando el progreso/cancelación existentes por tarea.
- [ ] 🔴 `M` Soporte de importación de playlists de Spotify (ver sección 0).
- [ ] 🟡 `M` Importar playlists de YouTube Music / Apple Music (Apple Music vía export de biblioteca; YT Music comparte backend con YouTube así que es casi gratis una vez resuelto lo anterior).
- [x] 🟡 `S` Detección de duplicados al descargar — ✅ hecho: aviso (no bloqueante) cuando el título normalizado ya está en la biblioteca.
- [ ] 🟢 `S` Normalización automática post-descarga: aplicar ReplayGain al vuelo a lo recién descargado en vez de esperar al escaneo manual.
- [ ] 🟡 `M` Cola de descargas persistente entre reinicios (si cierras Enn a mitad de una descarga larga, hoy se pierde).
- [ ] 🟢 `S` Elegir calidad de descarga (bitrate/formato) por descarga individual, no solo un formato global.

## 2. 🌍 Multiplataforma real (hoy es Windows-only de facto)

- [ ] 🔴 `L` **Linux**: `exclusive.rs` está `#![cfg(target_os = "windows")]` completo (WASAPI exclusivo no existe en Linux) — implementar salida ALSA/PipeWire de baja latencia equivalente vía `cpal` (ya está la dependencia) para no perder la promesa de "bit-perfect" fuera de Windows.
- [x] ~~🔴 `M` Linux: `media_keys.rs` solo Windows~~ — ✅ **ya estaba bien**: usa `souvlaki` genérico, solo el HWND está gateado a Windows. El comentario "MPRIS-ready" del código era correcto.
- [x] 🟡 `S` `reveal_in_folder` — ✅ agregada la rama macOS (`open -R`).
- [ ] 🔴 `L` **macOS**: validar/CoreAudio vía cpal, iconos `.icns`, firma y notarización para distribución fuera de la App Store.
- [x] 🔴 `M` Extender `.github/workflows/ci.yml` a matriz `[windows-latest, ubuntu-latest, macos-latest]` — ✅ hecho (más el compile-fix de `exclusive.rs` que lo bloqueaba). Sin verificar en un run real de GH Actions todavía.
- [ ] 🟡 `M` Atajos globales (`ctrl+alt+p/←/→/s/m`) — verificar que `tauri-plugin-global-shortcut` funcione igual en Linux (Wayland tiene restricciones distintas a X11) y documentar el fallback.
- [ ] 🟢 `S` Rutas de configuración por plataforma: hoy usa `app_config_dir()` de Tauri (ya es cross-platform), pero el "modo portable" (`Enn.portable` junto al .exe) es un concepto Windows — decidir equivalente en Linux/macOS o documentarlo como Windows-only conscientemente.

## 3. 📦 Formatos de audio — cobertura y calidad

- [ ] 🟡 `S` Symphonia ya cubre MP3/FLAC/WAV/AIFF/OGG/Opus/M4A/AAC/ALAC — añadir **APE (Monkey's Audio)** y **WavPack** si Symphonia los soporta en la versión fijada (`=0.5.5`), o evaluar actualizar la dependencia.
- [ ] 🟢 `S` DSD/DSF (audiófilos de verdad lo piden) — evaluar viabilidad vía librería externa; es un formato de nicho, dejar como "nice to have" explícito.
- [x] 🔴 `M` Exponer en la UI la **tasa de bits/profundidad real** — ✅ hecho: badge junto al título con formato/Hz/bits o kbps.
- [x] ~~🟡 `M` Verificar bypass del resampler~~ — ✅ **ya estaba bien**: `dsp.rs:362-367` copia directa sin filtrar cuando `ratio≈1`.
- [ ] 🟢 `S` Dither opcional al reducir bit-depth (para salidas de 16-bit desde fuentes de mayor profundidad).
- [x] 🟡 `S` Extraer **género y año** de las etiquetas (`Tags`/`Track`) — ✅ hecho, vía `StandardTagKey` de Symphonia en vez de adivinar nombres de clave crudos por formato.
- [ ] 🟡 `S` **Bug encontrado, no arreglado**: el lector WAV de Symphonia no expone ninguna etiqueta (título/artista/álbum/género/año quedan vacíos siempre en archivos `.wav`) — confirmado escribiendo con lofty y comprobando que Symphonia no ve nada. Arreglarlo implica leer etiquetas de WAV vía lofty en vez de Symphonia; WAV es poco común en la biblioteca real, así que se dejó documentado (`decode.rs`, función `read_tags`) en vez de arriesgar una refactorización más grande.

## 4. 📚 Biblioteca, indexación y organización

- [ ] 🔴 `M` Escaneo incremental más inteligente: detectar archivos movidos/renombrados sin re-analizar todo (hoy `scan_into`/`refresh` — revisar si hace diff por hash o solo por ruta).
- [ ] 🟡 `M` Vistas adicionales: por **año**, **género**, **carpeta física**, y "compilaciones" (detectar Various Artists correctamente en vez de romper la agrupación por álbum).
- [ ] 🔴 `M` **Smart playlists** basadas en reglas (ej: "rating > 4 AND género = Rock AND agregado en los últimos 30 días") — hoy solo hay M3U estático y playlists manuales.
- [x] 🟡 `S` Sistema de **favoritos** por pista — ✅ hecho (★, filtro `favorito:`, campo `favorite: bool` con serde default). Rating numérico 1-5 queda pendiente si lo prefieres sobre el booleano.
- [x] 🟡 `M` Editor de etiquetas por lote — ✅ hecho: botón "✎ Lote" edita artista/álbum/**género** de todo lo que coincide con el filtro de búsqueda activo (esa es la "selección"). `Track` ya almacena género y año (ver sección 3).
- [x] 🟢 `S` Auto-completado de artista/álbum al escribir en el editor de etiquetas — ✅ hecho vía `<datalist>`, en el editor individual y el de lote.
- [ ] 🟡 `M` Detección de biblioteca duplicada (mismo archivo en dos carpetas indexadas, o mismo track en distinta calidad) con opción de "quedarme con la mejor versión".
- [x] 🟢 `S` Ordenar biblioteca por "más escuchado recientemente" además de "más reproducido total" — ✅ hecho: "Escuchadas recientemente" junto a "Más reproducidas" en Actividad; de paso, el historial completo (hasta 500) pasó a colapsado por defecto en vez de volcarse entero siempre.

## 5. 🔎 Metadatos enriquecidos (nivel Spotify/Plex)

- [ ] 🟡 `L` Integración opcional con **MusicBrainz** para completar metadatos faltantes (año, género, MBID) cuando el archivo trae tags pobres.
- [ ] 🟡 `M` Descarga automática de carátulas faltantes desde MusicBrainz Cover Art Archive cuando no hay arte embebido (hoy `art.rs` solo extrae lo embebido).
- [ ] 🟢 `M` Letras de canciones (embebidas si existen en el tag `USLT`/`LYRICS`, o buscadas y cacheadas localmente).
- [ ] 🟢 `S` Biografía/artista destacado en la vista de artista (opcional, requiere API externa — dejar como toggle apagado por defecto para respetar el "sin telemetría/sin nube" del README).

## 6. 🎨 UI/UX

- [ ] 🟡 `M` Mini-reproductor / "mini mode" — confirmar que ya existe (README lo menciona) y pulir: siempre-visible-encima, tamaño configurable.
- [x] ~~🟡 `S` Drag & drop de archivos~~ — ✅ **ya estaba implementado** (`setupDragDrop()` en `app.js`).
- [ ] 🟢 `S` Temas de color personalizables más allá de auto claro/oscuro (acento de color, alto contraste).
- [x] 🟡 `M` Vista "Ahora suena" a pantalla completa con carátula grande + espectro — ✅ hecho (clic en el título del reproductor). Letras queda pendiente (necesita fuente de letras, fuera de alcance de esto).
- [ ] 🟢 `S` Animaciones de transición entre vistas más pulidas (hoy `styles.css` tiene +758 líneas nuevas — revisar consistencia general del sistema visual, no solo agregar).
- [ ] 🟡 `S` Onboarding de primera ejecución (hoy quien abre Enn por primera vez ve una biblioteca vacía sin guía — un flujo "añade tu primera carpeta / importa tu primera playlist").

## 7. ⌨️ Accesibilidad y atajos

- [x] 🟡 `M` Navegación por teclado en la lista de biblioteca — ✅ hecho para la vista "Todas" (flechas/Home/End mueven un cursor visible, Enter reproduce; Space para pausar ya funcionaba globalmente, sin conflicto). **Confirmado: no había ninguna cobertura antes de esto.** Las vistas agrupadas (por artista/género/año/álbumes) quedan pendientes — tienen su propia estructura de acordeón, no una lista plana.
- [x] 🟡 `S` Atributos ARIA en los controles principales — ✅ hecho: `aria-label` en todos los controles icon-only, `aria-pressed` sincronizado en shuffle/repeat, label dinámico en play/pause.
- [ ] 🟢 `S` Tamaño de fuente / densidad de lista ajustable (accesibilidad visual).
- [ ] 🟢 `S` Soporte de lector de pantalla básico para los controles de transporte.

## 8. 🛡️ Robustez y manejo de errores (deuda técnica real encontrada)

- [x] ~~🔴 `L` Auditar los ~120 `.unwrap()`~~ — ✅ **auditado, no hacía falta tocar la mayoría**: son `Mutex::lock().unwrap()` (idiomático) o viven en `#[cfg(test)]`. Arreglé el único caso real (`tags_write` en `lib.rs`, `unreachable!()` innecesario).
- [x] 🟡 `S` `player.rs:1217` `panic!(...)` — ✅ confirmado: está dentro de `#[cfg(test)] mod tests` (línea 1030), no alcanzable en producción.
- [x] 🟡 `M` Recuperación ante dispositivo de audio desconectado en caliente — ✅ hecho: supervisor con reintentos/backoff en `player.rs`, aviso al usuario vía `get_state().audio_error`.
- [x] 🟡 `S` Mensajes de error de usuario más claros cuando yt-dlp/ffmpeg fallan — ✅ hecho: `friendly_download_error()` traduce las causas más comunes a español claro.
- [x] 🟢 `S` Logging estructurado con niveles — ✅ hecho: `ENN_LOG=debug|warn|error`, niveles reales en los call sites, `dbg_log` con nivel opcional desde la UI.

## 9. ⚡ Rendimiento

- [x] 🟡 `M` Perfilar el escaneo de biblioteca en colecciones grandes (10k+ pistas) — ✅ hecho: `scan_into`/`refresh`/`probe_many` ahora usan `rayon::par_iter` (cada archivo es independiente, sin estado compartido).
- [ ] 🟢 `S` Revisar que el polling de estado cada 250ms (mencionado en README) no cause renders innecesarios en `app.js` cuando no hay cambios reales.
- [ ] 🟡 `S` Caché de biblioteca en formato binario (ej. `bincode`) en vez de JSON si `library.json` crece mucho con bibliotecas grandes — mide primero, no optimices a ciegas.
- [ ] 🟢 `S` Lazy-loading de carátulas en listas largas (si no está ya, para no decodificar 500 imágenes de golpe al abrir la vista de álbumes).

## 10. 🧪 Testing y CI/CD

- [x] 🔴 `M` Matriz de CI cross-platform (ver punto 2) — ✅ ya hecho en la sesión anterior (`[windows, ubuntu, macos]`), sin verificar aún en un run real de GH Actions.
- [ ] 🟡 `S` Tests de integración para el flujo completo de descarga (mock del proceso yt-dlp, no solo `classify_line` como hoy en `downloader.rs`).
- [x] 🟢 `S` Test de regresión para el resampler — ✅ hecho: bypass exacto fijado + test de FFT (1 kHz, 44.1→48 kHz) que verifica frecuencia y THD acotado.
- [x] 🟢 `S` Linting de UI (`app.js`) más allá de `node --check` — ✅ hecho: ESLint (`npm run lint`), en CI y en el checklist de `CONTRIBUTING.md`. Encontró y arregló una asignación inútil real (`plDir` en `renderPlaylists`).

## 11. 📦 Empaquetado y distribución

- [ ] 🟡 `M` Instalador Linux: `.AppImage` y/o paquete `.deb`/Flatpak.
- [ ] 🟡 `M` Instalador macOS: `.dmg` firmado (requiere cuenta de desarrollador Apple — nota de costo/tiempo).
- [ ] 🟢 `S` Auto-actualización dentro de la app (Tauri tiene plugin oficial de updater) en vez de reinstalar manualmente.
- [ ] 🟢 `S` Página de releases con changelog generado (útil también de cara al portafolio: demuestra proceso de release serio).

## 12. 🔐 Seguridad

- [x] 🟡 `M` Sandboxing/validación de URLs antes de pasarlas a yt-dlp — ✅ hecho, y era un hueco real: `is_valid_download_url()` exige `http(s)://` literal; sin ella, `--exec=...` como "URL" ejecutaba shell arbitrario vía yt-dlp.
- [x] 🟢 `S` Verificar checksum de los binarios sidecar — ✅ hecho para yt-dlp (contra su propio `SHA2-256SUMS`); ffmpeg (gyan.dev) no publica un hash fetcheable equivalente, así que se dejó explícitamente sin verificar en vez de fingirlo.
- [x] 🟢 `S` Revisar permisos de Tauri en `capabilities/default.json` — ✅ revisado: ya es mínimo (`core:default` + `dialog:default`, sin fs/shell genéricos), no hacía falta tocar nada.

## 13. 📄 Documentación y presentación como portafolio

- [ ] 🟡 `S` Sección de **arquitectura con diagrama** más visual en el README (ya hay un diagrama ASCII — considerar uno más elaborado para GitHub).
- [x] 🟡 `S` `CONTRIBUTING.md` + issues templates — ✅ hecho (y de paso, arreglados los `clippy`/`fmt` que el propio CONTRIBUTING.md ahora exige en el checklist de PR).
- [ ] 🟢 `S` Capturas/GIF de features clave (ahora mismo solo hay una imagen estática `docs/enn-ui.png`).
- [x] 🟢 `S` Sección "decisiones de diseño" — ✅ hecho: Rust+Tauri vs Electron, DSP propio vs librería, sin framework en el frontend.

---

## 14. ☁️ Despliegue en la nube — práctica de DevOps (Docker + Ansible + Terraform + AWS)

> [!note] Enn es una app de escritorio nativa — no se "despliega" en AWS tal cual. Para que el ejercicio de nube tenga sentido real (y no sea cosmético), propongo construir un **componente servidor opcional: "Enn Server"** — un modo headless que expone tu biblioteca para streaming remoto (estilo Jellyfin/Navidrome pero ligero y hecho por ti). Esto te da:
> - Una razón real para contenedores, Ansible y Terraform.
> - Una feature legítima para el producto: escuchar tu biblioteca desde el navegador/móvil cuando no estás en tu PC.
> - Una pieza de portafolio de infraestructura, no un despliegue de relleno.

- [ ] 🟡 `L` Diseñar **Enn Server**: reutiliza `library.rs`/`decode.rs`/`dsp.rs` (ya está en Rust, se puede compartir crate) tras una API HTTP (Axum/Actix) que sirve streaming transcodeado + metadatos + carátulas.
- [ ] 🟡 `M` **Dockerfile** multi-stage para Enn Server (build de Rust + imagen final mínima, ej. `distroless` o `alpine`).
- [ ] 🟡 `M` `docker-compose.yml` para levantar Enn Server + un volumen de biblioteca local en un solo comando (práctica de containerización real).
- [ ] 🟡 `M` **Terraform**: módulo que provisiona una instancia EC2 (o Lightsail, más barato para práctica), su security group (solo puertos necesarios), y un volumen EBS para la biblioteca — como ejercicio de IaC declarativo.
- [ ] 🟡 `M` **Ansible**: playbook que instala Docker en la instancia provisionada por Terraform, despliega el contenedor de Enn Server, configura logs y reinicio automático (systemd/docker restart policy) — separa claramente "provisión" (Terraform) de "configuración" (Ansible), que es justo la práctica que buscas.
- [ ] 🟢 `S` HTTPS con Let's Encrypt/Caddy delante del servidor (aprender a manejar certificados en un ejercicio real).
- [ ] 🟢 `S` CI/CD que construya y publique la imagen Docker a un registry (Docker Hub o ECR) en cada tag de versión.
- [ ] 🟢 `S` Documentar el costo estimado mensual de la infra (útil mostrar consciencia de costos en entrevistas de nube).

---

## 📋 Resumen de aprobación rápida

Si quieres aprobar por bloques enteros en vez de ítem por ítem, dime cuáles de estas 14 secciones apruebas tal cual y cuáles quieres que ajuste antes de empezar:

1. Importación/descarga (Spotify+YouTube) — 0 y 1
2. Multiplataforma — 2
3. Formatos/calidad — 3
4. Biblioteca/organización — 4 y 5
5. UI/UX y accesibilidad — 6 y 7
6. Robustez/rendimiento/testing (deuda técnica) — 8, 9, 10
7. Empaquetado/seguridad/docs — 11, 12, 13
8. Enn Server + nube (Docker/Ansible/Terraform/AWS) — 14

> [!tip] Sobre trabajar "en automático hasta las 8am"
> En cuanto apruebes bloques, puedo encadenar el trabajo en una sesión larga sin pedirte confirmación en cada paso (commits incrementales, no un solo commit gigante). Dime hasta qué hora quieres que corra y si prefieres que pare para que revises en algún punto intermedio, o que siga sin interrupciones hasta el límite.
