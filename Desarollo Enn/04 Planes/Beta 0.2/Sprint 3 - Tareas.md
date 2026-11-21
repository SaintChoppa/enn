---
resumen: Reparto del Sprint 3 (Algoritmo y recomendaciones) en tareas con prueba primero. Datos en línea encendidos por defecto, sin Last.fm (preparado para una clave), menú en la 1.ª escucha y cada 3.ª.
estado: cerrado
actualizado: 2026-11-17
tags: [enn, beta, sprint, algoritmo, tareas]
---

# Sprint 3 — Tareas

Diseño en [[Sprint 3 - Algoritmo y recomendaciones]]. Resultados en `05 Registro/Pruebas - Sprint 3.md`.

## Respuestas de apertura (2026-11-17)

1. **Datos en línea: encendidos por defecto.** Interruptor «Enriquecer con datos en línea» y lista de servicios en Ajustes. Solo se envía artista y título, o el id de YouTube; sin cuenta.
2. **Sin Last.fm por ahora.** Queda preparado: si se pega una clave en Ajustes, se usa.
3. **Menú de recomendaciones: 1.ª escucha y después cada 3.ª** (3.ª, 6.ª, 9.ª…), más el tercer ciclo seguido en «repetir una». Una vez por canción y sesión.

## Estado (2026-11-17)

T1–T8 hechas, con sus pruebas. Resultados en [[Pruebas - Sprint 3]].

## Decisiones de la ejecución

- **Peldaño extra en la escalera de relajación** («familia cercana con ventana corta») antes de «cualquiera»: con un rincón de género ya escuchado entero, la radio habría saltado a algo sin relación.
- **Rasgos sonoros en una pasada local aparte**: las pistas ya medidas no vuelven a pasar por la del volumen.
- **El afinador va con clic derecho en el botón de radio** hasta el panel del Sprint 5.
- **La medida con la biblioteca real** se hizo con una prueba que lee `library.json` y escribe solo en una carpeta temporal. La copia de prueba del Sprint 2 seguía abierta y la instancia única no dejaba abrir otra.

## Reglas

Las del [[Sprint 2 - Tareas]]: sin commits, prueba primero y puertas al final de cada tarea. Las pruebas con red van marcadas `#[ignore]` y las respuestas guardadas en `src-tauri/tests/fixtures/`.

## Tareas

| # | Tarea | Archivos | Prueba primero |
|---|---|---|---|
| T1 | **Taxonomía**: etiquetas en bruto → ~40 familias y tabla de cercanía, en un archivo de datos | `taxonomy.rs`, `data/taxonomy.json` | Tabla de casos con acentos y mayúsculas; lista negra («Music», «Música», «Other»); cercanía simétrica |
| T2 | **Almacén de escuchas**: escuchas, completas, saltos, transiciones naturales, clave por id de YouTube o ruta; migra `enn.history`; guardado atómico con copia anterior | `insights.rs`, `library.rs` (id de YouTube del archivo), `lib.rs` | Salto antes del 30 % o 30 s; solo cuentan las transiciones naturales; FLAC y M4A de la misma canción son una; restaura la copia si se daña |
| T3 | **Rescate de etiquetas**: archivo y descripción → Deezer → Last.fm (si hay clave) → iTunes → vecinas en la radio de YouTube Music → propagación; cola en segundo plano con pausas y caché de 90 días | `enrich.rs`, `ytmusic.rs` | Analizadores contra respuestas guardadas; validación por duración ± 5 s; propagación con menos peso |
| T4 | **Rasgos sonoros**: BPM, energía y brillo, en la pasada del análisis de volumen | `features.rs`, `rg.rs` | Señales sintéticas: clic a 120 BPM, ruido brillante frente a seno grave |
| T5 | **Radio que sigue el hilo**: `pick_next` con todas las señales, escalera de relajación, descubrimiento 1 de cada 8, aprendizaje en la sesión y motivo de cada elección | `radio.rs`, `lib.rs` | Semilla fija: comparte familia, nunca el mismo artista seguido, no repite, nunca vacío, salto aleja, elegir a mano recentra; simulación de 1 000 pasos con < 2 % de saltos sin puente |
| T6 | **Interfaz de la radio**: la radio pide al motor, enseña el motivo, avisa de inicios, fines, saltos y búsquedas; afinador en el menú del botón de radio; Ajustes con el interruptor, los servicios y la clave de Last.fm | `app.js`, `index.html`, `styles.css` | Lógica de «¿es un salto?» y del motivo en `ui/tests/` |
| T7 | **Menú de recomendaciones** | `ui/reco.js`, `app.js`, `styles.css` | Escucha 1 → sale; 2 → no; 3 → sale; 6 → sale; tres descartes → la mitad; no sale en reposo, en vista previa ni con < 30 s |
| T8 | **Medidas y cierre**: % de pistas con etiquetas reales, simulación, vault | `05 Registro/`, `02 Técnica/` | — |
