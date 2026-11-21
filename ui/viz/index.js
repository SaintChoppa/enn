// Visualizador de Enn: un único canvas WebGL2 detrás de toda la app (sustituye
// al antiguo fondo de barras y al espectro de «Reproduciendo»), con las dos
// versiones del handoff de Claude Design — Cinta y Traza — a elegir en Ajustes.
//
// Decisiones del propietario (bóveda, ADR #84–#97 y #107/#111):
//   · Simple: el render va de fondo, difuminado (8 px por defecto, ajustable).
//   · Studio: va nítido de fondo. Sin modo de inactividad (ADR #111).
//   · Colores de la carátula que suena; el estilo de la app no cambia.
//   · Se puede desactivar, y el panel de control del prototipo vive en la
//     ventana de Ajustes → Visualizador → «Personalizar render».
//
// Coste: el bucle solo corre con la ventana visible, fuera del modo mini y
// mientras suena algo o queda movimiento por asentar; en reposo no hay ni un
// requestAnimationFrame armado ni sondeo al motor.

import { clamp, clock, cloneBands, paletteFromCss, VizFeed } from "./common.js";
import * as TrazaMod from "./traza.js";
import * as CintaMod from "./cinta.js";

const VERSIONS = {
  traza: { mod: TrazaMod, Cls: TrazaMod.Traza, name: "Traza", desc: "Una línea metálica que barre la pantalla como un monitor cardíaco: el tono la sube y la baja y cada golpe de graves dibuja un latido." },
  cinta: { mod: CintaMod, Cls: CintaMod.Cinta, name: "Cinta", desc: "Una cinta metálica que gira sobre un infinito: los graves la hacen respirar y el color recorre la paleta con el timbre." },
};
const STORE = "enn.viz";
const BLUR_DEFAULT = 8; // px de difuminado en Simple (ADR #107)
const SIMPLE_MAX_SCALE = 50; // en Simple va difuminado: más resolución no se vería
const REDUCE_MOTION = !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function versionDefaults(key) {
  const m = VERSIONS[key].mod;
  return { profile: m.DEFAULT_PROFILE, edited: false, bands: cloneBands(m.PROFILES[m.DEFAULT_PROFILE].bands), ...m.EXTRA_DEFAULTS };
}
function defaults() {
  return { enabled: true, blur: BLUR_DEFAULT, version: "traza", scale: 100, pauseIdle: true, sel: 0, traza: versionDefaults("traza"), cinta: versionDefaults("cinta") };
}
function loadSettings() {
  const d = defaults();
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!s || typeof s !== "object") return d;
    const out = { ...d, ...s };
    if (!VERSIONS[out.version]) out.version = "traza";
    for (const k of Object.keys(VERSIONS)) {
      const v = { ...d[k], ...(s[k] || {}) };
      if (!Array.isArray(v.bands) || v.bands.length !== 4) v.bands = d[k].bands;
      if (!VERSIONS[k].mod.PROFILES[v.profile]) v.profile = d[k].profile;
      out[k] = v;
    }
    out.scale = clamp(+out.scale || 100, 50, 100);
    out.enabled = out.enabled !== false;
    out.blur = clamp(Number.isFinite(+out.blur) ? +out.blur : BLUR_DEFAULT, 0, 24);
    out.sel = clamp(out.sel | 0, 0, 3);
    return out;
  } catch {
    return d;
  }
}

export function initViz({ invoke }) {
  const body = document.body;
  const canvas = document.getElementById("viz");
  const S = loadSettings();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch {} };
  const api = { setPlaying() {}, kick() {} };
  if (!canvas) return api;

  let gl = null;
  try {
    gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true, depth: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
  } catch {}
  if (!gl) {
    canvas.remove();
    buildSettings(null);
    return api;
  }

  /// «Activado» y «Difuminado» se aplican al canvas por CSS (sin recompilar nada).
  function applyLook() {
    canvas.style.setProperty("--viz-blur", `${S.blur}px`);
    canvas.hidden = !S.enabled;
  }
  applyLook();

  const feed = new VizFeed(invoke);
  let renderer = null;
  let appPlaying = false;
  let raf = 0, last = 0, kickUntil = 0;
  // Red de seguridad (Sprint 1): sin música, a los IDLE_STOP_S segundos se deja
  // de dibujar aunque algún muelle no haya asentado del todo. Sin esto, un
  // muelle que se queda a 0,5^gamma en vez de 0,5 mantenía el WebGL a la
  // frecuencia del monitor para siempre.
  const IDLE_STOP_S = 8;
  let quietSince = 0;
  let meterEls = [];

  function makeRenderer() {
    if (renderer) renderer.destroy();
    renderer = null;
    try {
      renderer = new VERSIONS[S.version].Cls(gl, paletteFromCss());
    } catch (e) {
      console.error("visualizador:", e && e.message);
    }
    feed.reset();
    kick(1.5);
  }

  // ---------------------------------------------------------------- tamaño
  function effScale() {
    return body.dataset.mode === "studio" ? S.scale : Math.min(S.scale, SIMPLE_MAX_SCALE);
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2), s = effScale() / 100;
    const w = Math.max(2, Math.round(r.width * dpr * s)), h = Math.max(2, Math.round(r.height * dpr * s));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    kick(0.3);
  }
  new ResizeObserver(resize).observe(canvas);

  // ---------------------------------------------------------------- bucle
  const canRun = () => S.enabled && !document.hidden && !body.classList.contains("mini") && !REDUCE_MOTION && renderer;
  function kick(sec = 1.2) {
    kickUntil = Math.max(kickUntil, clock() + sec);
    if (!raf && canRun()) { last = 0; raf = requestAnimationFrame(frame); }
  }
  function frame() {
    raf = 0;
    if (!canRun()) return;
    const t = clock();
    const dt = last ? clamp(t - last, 0.0005, 0.05) : 1 / 60;
    const tPrev = last || t - dt;
    last = t;
    if (appPlaying) feed.request();
    const playing = appPlaying && feed.play;
    let settled;
    try {
      settled = renderer.frame({ t, dt, tPrev, playing, feed, cfg: { ...S[S.version], pauseIdle: S.pauseIdle }, cw: canvas.width, ch: canvas.height });
    } catch (e) {
      console.error("visualizador:", e && e.message);
      return;
    }
    // pulso de graves para el botón multicolor de Escenario: solo ese
    // elemento recibe la variable (no el documento entero)
    const beatEl = document.getElementById("btn-radio");
    if (beatEl) {
      const b = playing ? clamp(renderer.meters()[0], 0, 1) : 0;
      beatEl.style.setProperty("--beat", b.toFixed(3));
    }
    const dlg = document.getElementById("settings-dlg");
    if (meterEls.length && dlg && dlg.open) {
      const m = renderer.meters();
      for (let b = 0; b < 4; b++) if (meterEls[b]) meterEls[b].style.transform = `scaleX(${clamp(m[b], 0, 1).toFixed(3)})`;
    }
    const idleTooLong = !appPlaying && t - quietSince > IDLE_STOP_S && t >= kickUntil;
    if (appPlaying || (!settled && !idleTooLong) || t < kickUntil) raf = requestAnimationFrame(frame);
  }

  document.addEventListener("visibilitychange", () => kick());
  document.addEventListener("enn:palette", () => {
    if (renderer) renderer.setPalette(paletteFromCss(), clock());
    kick();
  });
  // modo, vista y mini cambian atributos del body: reescalar y reevaluar
  new MutationObserver(() => { resize(); kick(); }).observe(body, { attributes: true, attributeFilter: ["data-mode", "class"] });

  api.setPlaying = (on) => {
    if (on === appPlaying) return;
    appPlaying = on;
    if (!on) {
      feed.play = false;
      quietSince = clock();
    }
    kick(on ? 1.2 : 2);
  };
  api.kick = kick;

  makeRenderer();
  resize();
  buildSettings(gl);
  return api;

  // ---------------------------------------------------------------- Ajustes
  function buildSettings(glOk) {
    const host = document.getElementById("viz-settings");
    if (!host) return;
    host.textContent = "";
    const h = (tag, attrs = {}, kids = []) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") n.className = v;
        else if (k === "text") n.textContent = v;
        else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v);
      }
      for (const c of [].concat(kids)) if (c) n.appendChild(c);
      return n;
    };
    if (!glOk) {
      host.appendChild(h("p", { class: "set-hint", text: "Este equipo no ofrece WebGL2, así que el visualizador está desactivado." }));
      return;
    }

    // activado
    const en = h("input", { type: "checkbox" });
    en.checked = S.enabled;
    en.addEventListener("change", () => { S.enabled = en.checked; save(); applyLook(); kick(); });
    host.appendChild(h("label", { class: "set-check" }, [en, h("span", { text: "Mostrar el visualizador de fondo" })]));

    // difuminado en Simple
    const bOut = h("span", { class: "set-val", text: `${S.blur} px` });
    const bInp = h("input", { type: "range", min: "0", max: "24", step: "1", value: String(S.blur), "aria-label": "Difuminado en Simple" });
    bInp.addEventListener("input", () => { S.blur = +bInp.value; bOut.textContent = `${S.blur} px`; save(); applyLook(); });
    host.appendChild(h("label", { class: "set-slider" }, [h("span", { text: "Difuminado (Simple)" }), bInp, bOut]));

    // selector de versión
    const seg = h("div", { class: "seg", role: "radiogroup", "aria-label": "Versión del visualizador" });
    const desc = h("p", { class: "set-hint" });
    for (const [key, v] of Object.entries(VERSIONS)) {
      seg.appendChild(h("button", {
        type: "button", role: "radio", "aria-checked": String(S.version === key), text: v.name,
        onclick: () => {
          if (S.version === key) return;
          S.version = key; save(); makeRenderer(); buildSettings(true);
        },
      }));
    }
    desc.textContent = VERSIONS[S.version].desc;
    host.appendChild(h("div", { class: "set-row" }, [h("span", { class: "set-label", text: "Versión" }), seg]));
    host.appendChild(desc);

    // Personalizar render (plegado)
    const det = h("details", { class: "set-details", id: "viz-custom" });
    if (sessionOpen) det.open = true;
    det.addEventListener("toggle", () => { sessionOpen = det.open; });
    det.appendChild(h("summary", { text: "Personalizar render" }));
    const box = h("div", { class: "set-custom" });
    det.appendChild(box);
    host.appendChild(det);
    buildCustom(box, h);
  }

  function buildCustom(box, h) {
    const key = S.version, V = S[key], M = VERSIONS[key].mod;
    const rebuild = () => { save(); kick(); buildCustom(box, h); };
    box.textContent = "";

    // perfiles
    const prof = h("div", { class: "seg", role: "radiogroup", "aria-label": "Perfil" });
    for (const [pk, pf] of Object.entries(M.PROFILES)) {
      prof.appendChild(h("button", {
        type: "button", role: "radio", "aria-checked": String(V.profile === pk), text: pf.name,
        onclick: () => { V.profile = pk; V.edited = false; V.bands = cloneBands(pf.bands); rebuild(); },
      }));
    }
    box.appendChild(h("div", { class: "set-row" }, [h("span", { class: "set-label", text: "Perfil" + (V.edited ? " · editado" : "") }), prof]));
    box.appendChild(h("p", { class: "set-hint", text: M.PROFILES[V.profile].desc }));

    // matriz de ruteo banda → destino, con medidores en vivo
    const tbl = h("div", { class: "viz-matrix", role: "grid", "aria-label": "Qué mueve cada banda" });
    tbl.style.setProperty("--cols", String(M.DESTS.length));
    tbl.appendChild(h("span", { class: "vm-corner" }));
    for (const d of M.DESTS) tbl.appendChild(h("span", { class: "vm-head", text: d.short, title: d.name }));
    meterEls = [];
    M.BANDS.forEach((b, i) => {
      const meter = h("i", { class: "vm-meter", "aria-hidden": "true" });
      meterEls[i] = meter;
      tbl.appendChild(h("button", {
        type: "button", class: "vm-band", "aria-pressed": String(S.sel === i), title: b.range,
        onclick: () => { S.sel = i; save(); buildCustom(box, h); },
      }, [h("span", { text: b.name }), h("span", { class: "vm-track" }, [meter])]));
      for (const d of M.DESTS) {
        const on = V.bands[i].routes.includes(d.key);
        tbl.appendChild(h("button", {
          type: "button", class: "vm-cell", "aria-pressed": String(on), "aria-label": `${b.name} → ${d.name}`,
          onclick: () => {
            const r = V.bands[i].routes, j = r.indexOf(d.key);
            if (j >= 0) r.splice(j, 1); else r.push(d.key);
            V.edited = true; rebuild();
          },
        }, [h("i", { "aria-hidden": "true" })]));
      }
    });
    box.appendChild(tbl);

    // ajustes de la banda elegida
    const B = V.bands[S.sel];
    const band = M.BANDS[S.sel];
    const sliders = h("div", { class: "set-sliders" });
    sliders.appendChild(h("p", { class: "set-sub", text: `${band.name} · ${band.range}` }));
    const sl = (label, field, min, max, step, fmt) => {
      const out = h("span", { class: "set-val", text: fmt(B[field]) });
      const inp = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(B[field]), "aria-label": label });
      inp.addEventListener("input", () => { B[field] = +inp.value; V.edited = true; out.textContent = fmt(B[field]); save(); kick(); });
      inp.addEventListener("change", () => buildCustom(box, h));
      return h("label", { class: "set-slider" }, [h("span", { text: label }), inp, out]);
    };
    sliders.appendChild(sl("Sensibilidad", "sens", 0, 2, 0.01, (v) => `×${v.toFixed(2)}`));
    sliders.appendChild(sl("Ataque", "att", 1, 400, 1, (v) => `${v} ms`));
    sliders.appendChild(sl("Liberación", "rel", 20, 1500, 10, (v) => `${v} ms`));
    sliders.appendChild(sl("Curva γ", "gamma", 0.5, 3, 0.05, (v) => v.toFixed(2)));
    sliders.appendChild(sl("Amplitud", "amp", 0, 1, 0.01, (v) => `${Math.round(v * 100)} %`));
    box.appendChild(sliders);

    // ajustes propios de cada versión
    const extra = h("div", { class: "set-sliders" });
    if (key === "traza") {
      const chk = h("input", { type: "checkbox" });
      chk.checked = !!V.syncTempo;
      chk.addEventListener("change", () => { V.syncTempo = chk.checked; save(); kick(); });
      extra.appendChild(h("label", { class: "set-check" }, [chk, h("span", { text: "Barrido al tempo (los golpes caen siempre en la misma columna)" })]));
      const out = h("span", { class: "set-val", text: `${(+V.sweep).toFixed(1)} s` });
      const inp = h("input", { type: "range", min: "2", max: "8", step: "0.1", value: String(V.sweep), "aria-label": "Duración del barrido" });
      inp.addEventListener("input", () => { V.sweep = +inp.value; out.textContent = `${V.sweep.toFixed(1)} s`; save(); kick(); });
      extra.appendChild(h("label", { class: "set-slider" }, [h("span", { text: "Barrido sin tempo" }), inp, out]));
    } else {
      const cur = h("div", { class: "seg", role: "radiogroup", "aria-label": "Curva" });
      for (const c of ["Bernoulli", "Gerono"]) {
        cur.appendChild(h("button", { type: "button", role: "radio", "aria-checked": String(V.curve === c), text: c, onclick: () => { V.curve = c; rebuild(); } }));
      }
      extra.appendChild(h("div", { class: "set-row" }, [h("span", { class: "set-label", text: "Curva" }), cur]));
      const out = h("span", { class: "set-val", text: `${(+V.trail).toFixed(2)} vueltas` });
      const inp = h("input", { type: "range", min: "1", max: "2", step: "0.05", value: String(V.trail), "aria-label": "Longitud de la estela" });
      inp.addEventListener("input", () => { V.trail = +inp.value; out.textContent = `${V.trail.toFixed(2)} vueltas`; save(); kick(); });
      extra.appendChild(h("label", { class: "set-slider" }, [h("span", { text: "Estela" }), inp, out]));
    }
    // comunes
    const sOut = h("span", { class: "set-val", text: `${S.scale} %` });
    const sInp = h("input", { type: "range", min: "50", max: "100", step: "5", value: String(S.scale), "aria-label": "Resolución del render" });
    sInp.addEventListener("input", () => { S.scale = +sInp.value; sOut.textContent = `${S.scale} %`; save(); resize(); });
    extra.appendChild(h("label", { class: "set-slider" }, [h("span", { text: "Resolución (Studio)" }), sInp, sOut]));
    const pchk = h("input", { type: "checkbox" });
    pchk.checked = !!S.pauseIdle;
    pchk.addEventListener("change", () => { S.pauseIdle = pchk.checked; save(); kick(); });
    extra.appendChild(h("label", { class: "set-check" }, [pchk, h("span", { text: "Frenar y detener el render al pausar" })]));
    box.appendChild(extra);

    box.appendChild(h("div", { class: "set-actions" }, [h("button", {
      type: "button", class: "btn small ghost", text: "Restablecer esta versión",
      onclick: () => { S[key] = versionDefaults(key); rebuild(); },
    })]));
  }
}

let sessionOpen = false;
