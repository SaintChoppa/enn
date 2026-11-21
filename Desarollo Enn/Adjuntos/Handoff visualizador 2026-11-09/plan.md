Plan del visualizador "Cinta" (Enn) — pendiente de construir

Archivo: Cinta Visualizador.dc.html (DC; WebGL2, sin librerías)
Tokens Enn (styles.css): bg #09090b, panel opaco #16161a (sin cristal: prohibido), borde rgba(255,255,255,.08), texto #e8eaee/#99a0aa/#6b7079, plata #bcc6d4/#8a96a8, radios 8/12, --ease-out cubic-bezier(0.23,1,0.32,1), range: carril 5px rgba(255,255,255,.12), thumb 13px #bcc6d4. Inter en ./fonts/. Iconos copiados del sprite de index.html (i-wave, i-x, i-chevron, i-folder-open; play/pause de app.js).

Render (4 draws, sin vertex buffers, gl_VertexID, un UBO std140 de 1312 B = 328 floats):
energy0 fx4 fx2 8 timev12 view16 cam20 drift24 counts28 palA32 palB52 lut72(64 vec4)
1 polvo: 700 quads (6 vért), aditivo. 2 halo: tira ×3 ancho, aditivo. 3 cinta: TRIANGLE_STRIP 2×640, alfa + depth. 4 destello: 1 quad anamórfico, paralaje 1.8.
Curva P(t)=(cos t, sin t cos t)/(1+k sin²t), z=0.16 sin t; LUT t(s) 256 por longitud de arco; cruces u=.25/.75.
Torsión θ=π[ss(.25±.07)+ss(.75±.07)]+0.22 sin4πu+τr sin(6πu−1.7τ). Grosor W0·nib·taper·(1+g+breath). Eco: Rz(0.18a)·(1+0.035a), z−0.1a.
OKLab en shader, fundido 600 ms easeInOutCubic, reverso L·.65 C·.85 b−.03, filo 1px con fwidth.
Audio: WebAudio, analizador antes de DelayNode 90 ms (lookahead), bandas 20–150/150–2k/2k+, AGC, centroide log. Resorte crítico exacto ω=3.89/T90. Anticipación sin² 90 ms en graves. Perfiles Sub/Aire/Tono; matriz de ruteo 4×6; límites grosor ±.15, vel ±.2, torsión .6, borde 1.5, color .5, polvo 1.
Sintético 104 BPM, 16 compases (12 groove, 2 barrido solo, 2 silencio). Pausa → frenado (resorte 0.9 s) → render detenido.
Debajo: sección "Handoff para wgpu" (fórmulas, constantes, tiempos, layout de uniforms, WGSL).
