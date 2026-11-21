---
resumen: Prueba de aceptación del Sprint 3 (Algoritmo y recomendaciones). 91 % de las pistas con etiquetas reales (antes, todas «Music»); radio que sigue el hilo sin cambios bruscos en 1 000 pasos simulados; almacén de escuchas y menú de recomendaciones. Pendiente: los 30 minutos de radio con el propietario.
estado: cerrado
actualizado: 2026-11-17
tags: [enn, beta, sprint, pruebas, radio, algoritmo]
---

# Pruebas — Sprint 3

Diseño en [[Sprint 3 - Algoritmo y recomendaciones]]; reparto en [[Sprint 3 - Tareas]].

## Cómo se midió

- **Automáticas**: `cargo test`, 123 pruebas; las 5 con red van marcadas `#[ignore]` y se ejecutaron a mano. `npm test`, 45 pruebas.
- **Respuestas guardadas** de Deezer, iTunes y la radio de YouTube Music (canción pública: Daft Punk, «Get Lucky») en `src-tauri/tests/fixtures/`. Los analizadores se prueban sin red.
- **Biblioteca real** (111 pistas): la pasada de etiquetas completa contra los servicios, desde una prueba que lee `library.json` y escribe solo en una carpeta temporal (`real_library_coverage`).
- **Interfaz**: el panel del navegador con datos de ejemplo. Allí se comprobaron la radio con su motivo, la tarjeta de recomendaciones y el afinador.

## Resultados

| Medida | Resultado | Objetivo | ¿Cumple? |
|---|---|---|---|
| Pistas con etiquetas reales | **101 de 111 (91 %)**; antes, todas «Music» | ≥ 90 % | ✅ |
| De dónde salen | Deezer 64 · propagación 34 · iTunes 3 | — | — |
| Pistas con id de YouTube | 109 de 111 (etiqueta `comment` de las descargas) | — | — |
| Vecindades de la radio de YouTube Music | 208 enlaces entre canciones de tu biblioteca | — | — |
| Pasada completa en segundo plano | 394 s para 111 pistas (pausas de Deezer 5/s e iTunes 20/min) | — | — |
| Simulación de 1 000 pasos (5 familias encadenadas) | **0 cambios bruscos**; el 98,7 % de los pasos comparte familia; las 5 familias alcanzadas | < 2 % y todas | ✅ |
| Real: «Get Lucky» | Pop, Electrónica, Dance y Disco, 116 BPM (Deezer); su vecina «Lose Yourself to Dance», encontrada | — | ✅ |

**Familia principal en tu biblioteca**: Pop latino 53 · Hip-hop 32 · Electrónica 5 · Pop 4 · Dance 3 · Reguetón 2 · Rock 1 · Alternativo 1.

**Sin etiquetas (10)**: sobre todo K-pop (aespa, ILLIT, ITZY), alguna con el campo de artista vacío, y títulos con mucho ruido («(OFFICIAL AUDIO) | ANTI JUDAS»).

## Pruebas automáticas nuevas

| Pieza | Qué se prueba |
|---|---|
| `taxonomy.rs` + `data/taxonomy.json` | Etiquetas → familias, con acentos, mayúsculas y compuestas («Latin Trap» = trap y urbano latino); lista negra («Music», «Música», «Other»…); cercanía simétrica; ninguna familia aislada; todas con nombre |
| `insights.rs` | Clave por id de YouTube o por ruta (FLAC y M4A de la misma canción son una); salto antes del 30 % o de 30 s; solo cuentan las transiciones naturales; saltar justo después debilita la transición; migración del historial una sola vez; guardado atómico y copia anterior si se daña |
| `decode.rs` | Id de YouTube de la etiqueta `comment`; año real de la descripción («Released on: …») |
| `enrich.rs` | Analizadores de Deezer, iTunes, Last.fm y la radio de YouTube Music contra respuestas guardadas; validación por duración ± 5 s (la versión de radio es otra pista); pesos por fuente; una etiqueta con varias familias pesa menos en cada una; propagación con menos peso; la pasada empieza por las más escuchadas, guarda 90 días, sigue sin red con lo local y no llama a nada con el interruptor apagado |
| `features.rs` | Tempo de pistas de clics a 96, 120 y 140 BPM (± 2); 65 BPM se pliega a 130; silencio sin tempo; el ruido es más brillante y con más energía que un seno grave |
| `radio.rs` | Con semilla fija: dos seguidas comparten familia; nunca el mismo artista dos veces seguidas; no repite en la ventana; nunca devuelve vacío con 2 o más canciones; un salto aleja esa familia; elegir a mano recentra la sesión; vecinas y costumbres pesan; cada elección trae su motivo; la simulación de 1 000 pasos |
| `ui/reco.js` | Escucha 1 → sale; 2 → no; 3 → sale; 6 → sale; tercer ciclo en «repetir una»; espera 8 s; una vez por canción y sesión; no sale en canciones de menos de 30 s, con un diálogo o en vista previa; en reposo espera y sale al volver si la canción lleva menos de 60 s; tres descartes → la mitad de las veces |

## Fallos encontrados por el camino (corregidos)

- **«Rock» en «Get Lucky»**: Deezer da «Electro Pop/Electro Rock» y la etiqueta sumaba tres familias enteras. Ahora una etiqueta con varias familias reparte su peso.
- **La tarjeta de recomendaciones salía arriba de la pantalla en Simple**: se colocaba sobre los controles, que en Simple van en el centro. Ahora va en la esquina y, en Studio, sobre la barra.
- Las variables de la tarjeta se declaraban después del código que las podía usar al arrancar. Una canción que empezara durante el arranque habría fallado y se habría quitado de la cola.

## Prueba en la app real (2026-11-17, a petición del propietario)

Versión de prueba en el equipo del propietario, con su biblioteca y su audio, manejada en pantalla.

| Qué | Resultado |
|---|---|
| Rescate de etiquetas dentro de la app | 102 de 112 pistas con etiquetas en la pasada de fondo; Ajustes lo enseña en vivo («Buscando etiquetas… (75 de 112)») |
| Radio con motivo | «Radio · Sigue el hilo: Pop latino», «Sigue el ambiente: Hip-hop» y, tras «LEMONADE» (aespa), **«Vecina de «LEMONADE» en la radio de YouTube Music»** con «It's Me» (ILLIT) |
| Tarjeta «Te puede encajar» | Sale a los 8 s en una primera escucha (con «Sigue el hilo: Pop», «Dance → Electrónica»); se para con el ratón encima, se va sola a los 9 s; «Añadir las 3» pone las tres a continuación en orden |
| Afinador | Clic derecho en el botón de radio; tres filas con su opción marcada |
| Ajustes | Recomendaciones (interruptores, Last.fm, estado de etiquetas) y Descargas (A la vez, Velocidad, versión de yt-dlp) |
| Descargas (Sprint 2) | Vista previa de 10 s por el motor; descarga real con barras, anillo que cancela, final y «▶ Escuchar · + Cola»; la canción entra en la biblioteca |

### Fallos encontrados en la app real (corregidos y comprobados)

1. **▶ no hacía nada con la radio encendida y nada cargado**: el botón se apagaba cuando no había pista, así que la radio no se podía arrancar con ▶ (venía de antes de este sprint). Ahora ▶ se enciende con la radio o con algo en «Siguientes», y arranca eso.
2. **Lo pedido «a continuación» no sonaba con la radio puesta**: «Siguientes» espera mientras suena la radio (ADR #152), pero eso se tragaba también lo que el usuario pedía expresamente a continuación (el menú, la tarjeta). Ahora eso suena primero y luego sigue la radio, como en Spotify. El resto de «Siguientes» sigue esperando.
3. **La elección de la radio se colaba delante** de lo pedido a continuación. Ahora va detrás.
4. **Escuchas que se partían en dos claves**: el historial migrado y las primeras escuchas se guardaban por ruta, y la misma canción pasaba luego a su id de YouTube. Por eso la tarjeta no salía en la primera escucha. Ahora los ids se leen al arrancar y lo guardado por ruta se pasa a la clave nueva (21 canciones movidas en el equipo del propietario).
5. **La tarjeta seguía puesta al cambiar de canción**, proponiendo la que ya sonaba. Ahora se va con la canción.
6. **Pastilla de más que se quedaba girando** al descargar desde los resultados: el primer aviso del motor llegaba antes que el id de la tarea y se tomaba por una descarga por enlace. Ahora la URL se apunta antes de pedir la descarga.
7. **«A continuación» sobre la canción que suena** la sacaba de su sitio y desordenaba la cola. Ahora dice «Ya está sonando».
8. **Afinador ilegible** (textos encima unos de otros) y pegado al borde de la ventana. Ahora va con su ancho y se abre debajo del botón si arriba no cabe.

Nota: en Simple, la interfaz pasa a reposo a los 3 s sin mover el ratón. La tarjeta espera a que vuelvas (si la canción lleva menos de 60 s) en vez de salir a una pantalla que nadie mira. Es lo diseñado, pero quien escucha sin tocar nada la verá poco.

## Revisión contra el diseño (2026-11-17)

El propietario pidió comprobar si el sprint se cumplió. Se repasó el diseño punto por punto contra el código. Los cinco «Hecho cuando» y las ocho tareas estaban cumplidos, pero faltaban o quedaban a medias **8 puntos del diseño**. Ya están hechos, con prueba primero:

| # | Faltaba | Ahora |
|---|---|---|
| 1 | Sin conexión, la pasada de etiquetas esperaba 24 h (el comentario decía 1 h) | Reintenta en 1 h si no había conexión; si no, cada 24 h (`next_pass_in`) |
| 2 | La tarjeta podía salir en modo mini | No sale en modo mini y se cierra al pasar a él |
| 3 | No había limpieza de canciones borradas | Limpieza semanal en la pasada de fondo. Si la biblioteca parece no estar (vacía, o se iría más de la mitad), no borra nada (`prune_missing`) |
| 4 | El año real («Released on») solo llegaba a las canciones nuevas | Una vez, al arrancar, se relee de todas las pistas |
| 5 | No se avisaba de las búsquedas dentro de la canción | Evento `seek`: cuenta lo escuchado de verdad. Saltar al final ya no es «escuchada entera», y saltar adelante y dejarla es un salto |
| 6 | La radio no usaba el volumen ni lo reciente | Continuidad sonora con tempo, energía y **volumen**; el gusto suma lo escuchado **el último mes** |
| 7 | El cambio «a continuación» con la radio puesta no estaba en las decisiones | ADR #178 |
| 8 | Pruebas a medias | Las 6 pruebas nuevas, en verde: 130 en Rust y 45 en la interfaz |

**Visto en la app real** (el propietario dejó cerrar su Enn):

- **Años reales**: los dos «Get Lucky» pasan a 2013 (antes, 2014: el año de subida).
- **Tarjeta en la 3.ª escucha**: «wakata» (2 escuchas antes) la saca con «Sigue el hilo: Alternativo → Hip-hop».
- **Modo mini**: al pasar a mini, la tarjeta se cierra.
- **Limpieza semanal**: «1 canciones que ya no están, retiradas».
- **Etiquetas**: 103 de 113 pistas.
- **Búsquedas**: saltar al final a los 10 s y dejarla acabar no suma una escucha completa.

**Un fallo más encontrado así, y corregido**: volver a poner la misma canción sin acabarla (⏭ con una sola canción) dejaba la escucha anterior abierta y podía sumar una escucha completa falsa. Ahora se cierra como salto, y un «terminó» sin su inicio no cuenta como completa. Comprobado: +1 salto y 0 escuchas completas de más. Pruebas: 131 en Rust y 45 en la interfaz, en verde.

Sigue pendiente la prueba de 30 minutos de radio. Last.fm solo se probó con una respuesta inventada, porque no hay clave.

## No verificado

- **30 minutos de radio con tu biblioteca real** apuntando los saltos que chirrían (objetivo: como mucho 1 de cada 15). Hace falta tu oído.
- **Reanudar la cola al abrir**, **disco lleno** y **limitación de YouTube (429)** (Sprint 2): solo con trabajos simulados. Provocarlos de verdad exige salir desde la bandeja con descargas en marcha, llenar un disco o hacer que YouTube bloquee.
- La animación de «finalizando» (0,9 s) se vio solo por su final: la captura de pantalla no llega a esa velocidad.
- «Abrir con Windows» tras reiniciar (Sprint 1).
- **Afinador**: está en el menú del botón de radio (clic derecho). Su sitio definitivo es el panel del Sprint 5.

## Pendiente que pasa a otros sprints

| Tema | Por qué | A dónde |
|---|---|---|
| «Pop latino» abarca el urbano en español | Deezer solo dice «Latin Music» de casi toda tu música urbana. Para separar trap, reguetón y pop latino haría falta Last.fm (clave) o reglas por artista | Pregunta al propietario |
| K-pop y títulos con mucho ruido sin etiquetas | Artista vacío o título con «(OFFICIAL AUDIO) \| …». Se puede limpiar más el título y buscar solo por título | Sprint 7 |
| Las transiciones con crossfade | Cuando el motor encadena con crossfade, la interfaz no ve el inicio de la siguiente como «start» | Sprint 4 (con el movimiento) |
