---
resumen: Sprint 3 de la beta 0.2. Rescate de géneros y etiquetas (hoy todas las pistas dicen «Music»), almacén de escuchas, radio que sigue el hilo de géneros y artistas combinando la propuesta del propietario con la radio de YouTube Music, y menú de recomendaciones abajo a la derecha.
estado: cerrado
actualizado: 2026-11-17
tags: [enn, beta, sprint, algoritmo, radio]
---

# Sprint 3 — Algoritmo y recomendaciones

Parte del [[Plan maestro - Beta 0.2]]. Evidencia en [[Investigación - Beta 0.2]]. Necesita el Sprint 1 (`BgPool`, `prefs`).

**Objetivo**: que la radio no salte de un rock a un rap; que vaya derivando por géneros y artistas afines según lo que escuchas, y que la app proponga qué poner después.

## Punto de partida (medido)

- Las 104 pistas tienen el género «Music»: no hay nada que seguir.
- No hay contadores de escucha ni registro de «qué suena después de qué».
- Cada descarga guarda su id de YouTube en la etiqueta `comment`.
- La radio de YouTube Music responde sin cuenta en 0,9 s con 50 canciones relacionadas; Deezer da géneros y BPM sin clave en 0,3 s.

## Preguntas de apertura

1. **Datos en línea.** Para saber el género real hay que consultar fuera. Se envía solo artista y título (o el id de YouTube) a Deezer, iTunes y YouTube Music; sin cuenta y sin identificadores. Quedaría un interruptor «Enriquecer con datos en línea» y la lista de servicios en Ajustes. ¿Encendido por defecto, o apagado hasta que lo actives?
2. **Last.fm.** Da las etiquetas más finas (subgéneros y estados de ánimo), que son las que mejor hacen el «hilo». Necesita una clave gratuita a tu nombre y sus términos son de uso no comercial. ¿La creas y la usamos, o seguimos sin Last.fm?
3. **Frecuencia del menú de recomendaciones.** Se entiende «primera escucha y después cada tercera (3.ª, 6.ª, 9.ª…)», más el tercer ciclo seguido en «repetir una». ¿Es eso?

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Dónde vive la lógica | En Rust (`radio.rs`), con semilla fija en las pruebas | Multinúcleo, pruebas deterministas |
| Almacén | `insights.json` en la carpeta de datos, escritura atómica | Durable (el historial actual vive en `localStorage`) |
| Clave de cada canción | Id de YouTube si existe; si no, ruta | Sobrevive a mover o renombrar archivos |
| Mismo artista | Nunca dos veces seguidas; penalización suave en las 3 últimas | «Variedad de artistas» de YouTube Music |
| Elección | Muestreo entre las mejores, no siempre la primera | Variedad sin perder el hilo |
| Explicación | Cada elección de la radio lleva su motivo visible | Confianza: «Sigue el hilo: Alternativo → Trap» |
| Menú de recomendaciones | Tarjeta que no roba el foco y se va sola a los 9 s | Decisión general |

## Diseño

### 1. Almacén de escuchas — `insights.rs`

Por canción: `yt_id`, `tags` (nombre y peso), `bpm`, `energy`, `brightness`, `plays`, `completions`, `skips`, `first_played`, `last_played`, `sources`, `fetched_at`.

Transiciones: mapa disperso `anterior → { siguiente: veces }`. Solo cuentan las «naturales»: la siguiente se escuchó al menos al 50 % después de que la anterior terminó o de elegirla a mano.

La interfaz informa con `insights_event(tipo, ruta, posición)`: `start`, `end`, `skip`, `seek`. Se considera salto si se abandona antes del 30 % o de 30 s. Se migran las 500 entradas del historial actual.

### 2. Rescate de etiquetas — `enrich.rs`

En segundo plano, de más escuchada a menos, con caché de 90 días:

| Orden | Fuente | Aporta | Notas |
|---|---|---|---|
| 1 | Etiquetas del archivo y descripción de YouTube | Año real («Released on»), sello; género si no es de la lista negra («Music», «Música», «Other») | Sin red |
| 2 | Deezer | Géneros del álbum, BPM | Se valida por título, artista y duración ± 5 s |
| 3 | Last.fm (si hay clave) | Etiquetas finas con peso | Opcional |
| 4 | iTunes | Género principal | Respaldo |
| 5 | Radio de YouTube Music | Qué canciones de **tu** biblioteca son vecinas | Se cruza por id y por título + artista |
| 6 | Propagación | Una canción sin etiquetas hereda, con menos peso, las de sus vecinas y las de su artista | Sin red |
| 7 | Análisis local | BPM, energía y brillo, en la misma pasada que el análisis de volumen | Sin red; por `BgPool` |

**Taxonomía**: las etiquetas en bruto se pasan a unas 40 familias (rock, alternativo, indie, metal, punk, pop, urbano latino, reguetón, trap, hip-hop, R&B, electrónica, house, J-pop, J-rock, K-pop, regional, tropical, lo-fi, banda sonora…) con una tabla de cercanía entre familias. Va en un archivo de datos, no en el código, para poder afinarla.

### 3. Radio que sigue el hilo — `radio.rs`

`pick_next(ctx, n) -> Vec<Pick { path, score, reason }>`

Tu propuesta (Rock, alternativo → Alternativo, trap → Trap, …) es una caminata por etiquetas compartidas. Se combina con lo que hace YouTube Music así:

| Señal | Qué mide | Origen |
|---|---|---|
| **Hilo** | Etiquetas que la candidata comparte con la canción actual. Si ambas tienen etiquetas, debe compartir al menos una | Tu propuesta |
| **Ambiente de la sesión** | Parecido con la media móvil de las 5 últimas; deja derivar despacio | Tu propuesta |
| **Vecindad** | La candidata aparece en la radio de YouTube Music de la actual (mejor cuanto más arriba) | YouTube Music |
| **Tu costumbre** | Cuántas veces has pasado de la actual a la candidata | Tus escuchas |
| **Tu gusto** | Escuchas completas, favorita, reciente | Tus escuchas |
| **Continuidad sonora** | Diferencias pequeñas de BPM, energía y volumen | Análisis local |
| − Repetición | Sonó en las últimas 80 o en las 2 últimas horas | — |
| − Artista | Mismo artista que la anterior (fuerte) o en las 3 últimas (suave) | YouTube Music |
| − Saltos | La saltaste hace poco o a menudo; saltarla justo después de la actual debilita esa transición | Tus escuchas |

**Aprende en la sesión**: una escucha completa refuerza la dirección; un salto temprano aleja el ambiente de esas etiquetas; elegir una canción a mano recentra la sesión en ella (como iniciar una radio desde una canción).

**Descubrimiento**: 1 de cada 8 elecciones se reserva para una canción poco escuchada pero cercana.

**Escalera de relajación** (nunca se queda sin candidata): hilo estricto → familia cercana → mismo artista permitido → solo continuidad sonora → cualquiera que no sea la actual.

**Afinador** (en el panel de personalización del Sprint 5; antes, en el menú del botón de radio): Variedad de artistas (baja, media, alta), Selección (familiar ↔ descubrir), Coherencia (estricta ↔ aventurera).

La radio mantiene la regla del 2026-11-12: «Siguientes» queda en espera mientras está encendida.

### 4. Menú de recomendaciones — `ui/reco.js`

- **Cuándo**: la canción lleva 8 s sonando (para no saltar con los saltos) y es su 1.ª escucha, o la 3.ª, 6.ª, 9.ª…; o el tercer ciclo seguido en «repetir una». Una vez por canción y sesión.
- **Qué propone** (hasta 3): primero lo que más has escuchado después de esta canción; si no hay historial suficiente, las mejores de `pick_next`; nunca canciones que ya estén en «Siguientes».
- **Aspecto**: tarjeta abajo a la derecha, por encima de la barra. Título «Después de esta sueles escuchar» (o «Te puede encajar» si viene del motor). Cada fila: carátula, título, artista y motivo.
- **Acciones**: pulsar una fila la pone a continuación; ▶ la reproduce ya; «Añadir las 3».
- **Comportamiento**: entra con rebote desde la esquina, línea fina de cuenta atrás de 9 s que se detiene con el ratón encima, se descarta arrastrándola a la derecha o con Esc, no captura el foco.
- **No aparece**: en reposo (se guarda y sale al volver si la canción lleva menos de 60 s), en modo mini, con un diálogo o menú abierto, durante una vista previa, en canciones de menos de 30 s.
- **Se modera sola**: tres descartes seguidos → aparece la mitad de veces; menú «No volver a mostrar».

## Por si acaso

| Caso | Qué pasa |
|---|---|
| Sin conexión o con el enriquecimiento apagado | Funciona con análisis local, artista y tus transiciones; lo demás queda pendiente |
| Canción que ningún servicio conoce | Hereda de su artista y de sus vecinas; si no, solo continuidad sonora |
| Coincidencia equivocada (otra versión, en directo, remix) | Validación por duración; si no cuadra se descarta |
| Canción con varios artistas | Cuentan todos (ya existe `splitArtists`) |
| Biblioteca muy pequeña o un solo género | Escalera de relajación; el periodo sin repetir se acorta a la mitad de la biblioteca |
| Archivo local que no viene de YouTube | Búsqueda por título y artista; clave por ruta |
| Etiquetas contradictorias entre fuentes | Peso por fuente; gana la suma |
| El servicio limita las consultas | Cola con pausa entre llamadas (Deezer 5/s, iTunes 20/min) y reintento al día siguiente |
| Primeras horas, sin historial | Recomendaciones del motor con el título «Te puede encajar» |
| Saltos en cadena | Tras 3 saltos seguidos la radio vuelve al ambiente de la última canción escuchada entera |
| Una canción se borra o se mueve | La limpieza semanal retira sus datos; con id de YouTube, sobrevive al movimiento |
| `insights.json` dañado | Se restaura la copia anterior; si no hay, se reconstruye desde cero sin perder música |
| La radio de YouTube Music cambia de formato | El analizador falla en silencio y esa señal vale 0; el resto sigue |
| La misma canción en FLAC y en M4A | Se tratan como una para las estadísticas |

## Prueba de aceptación

**Automáticas**
- Taxonomía: etiquetas en bruto → familias (tabla de casos, acentos y mayúsculas).
- Analizadores de Deezer, iTunes y YouTube Music contra respuestas guardadas (sin red en la CI).
- `pick_next`, con semilla fija:
  - con etiquetas conocidas, dos elecciones seguidas comparten al menos una familia;
  - nunca el mismo artista dos veces seguidas mientras haya otro;
  - no repite dentro de la ventana;
  - nunca devuelve vacío con 2 o más canciones;
  - un salto temprano reduce la probabilidad de esa familia;
  - elegir a mano recentra la sesión.
- **Simulación**: biblioteca sintética con 5 familias y puentes entre ellas, 1 000 pasos → cambios bruscos de familia sin puente < 2 % y todas las familias alcanzables.
- `insights`: cuenta escuchas, saltos y transiciones naturales; migra el historial; guardado atómico.
- Menú (`ui/tests/reco.test.js`): escucha 1 → sale; 2 → no; 3 → sale; 6 → sale; tres descartes → mitad de frecuencia.

**A mano (con el propietario)**
- 30 minutos de radio con la biblioteca real: se apuntan los saltos «que chirrían». Objetivo: como mucho 1 de cada 15.
- El menú aparece en la primera y en la tercera escucha, y no molesta en reposo.

## Hecho cuando

- [x] Al menos el 90 % de las pistas con etiquetas reales (o razón anotada): 91 %
- [x] La radio sigue el hilo y lo explica
- [x] Contadores de escucha y transiciones funcionando
- [x] Menú de recomendaciones con la frecuencia acordada
- [x] Resultados en [[Pruebas - Sprint 3]] (falta la prueba de 30 minutos con el propietario)
