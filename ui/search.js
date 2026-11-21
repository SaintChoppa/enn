// Buscador del descargador (bóveda: «Buscador de descargas 2026-11-09»).
//
// Una sola barra: si lo escrito parece un enlace, el botón dice «Descargar» y
// se descarga tal cual; si no, dice «Buscar» y, 0,35 s después de dejar de
// escribir, se despliegan pastillas con las canciones (y álbumes oficiales)
// de YouTube Music. Mientras busca, pastillas en esqueleto; los textos salen
// primero y las carátulas entran después. Sin conexión, un aviso; al volver
// la red, se repite la búsqueda.
//
// Sprint 2: pulsar una pastilla suena 10 s de su mejor parte (vista previa,
// por el motor de Enn); descargar es solo con su botón plateado. Cada
// descarga pasa por sus fases con animación (dl-anim.js) y nunca termina de golpe.

import { createPillMotion, buttonState, ACTS_STAGGER_MS } from "./dl-anim.js";

const DEBOUNCE_MS = 350;
const MIN_CHARS = 2;
const BARS = 32;
const SKELETONS = 5;
/// Resultados que se resuelven de antemano para que la vista previa salga al instante.
const PREFETCH_TOP = 3;
/// Tiempo con el ratón encima antes de resolver de antemano.
const HOVER_PREFETCH_MS = 150;
/// Aviso discreto si la vista previa tarda (a los 12 s el motor se rinde).
const PV_SLOW_MS = 6000;

/// ¿Parece un enlace? (entonces no se busca: se descarga)
export function looksLikeUrl(s) {
  const v = s.trim();
  if (!v) return false;
  if (/^(https?:\/\/|www\.)/i.test(v) || v.includes("://")) return true;
  // dominio + ruta sin protocolo: youtu.be/abc, soundcloud.com/x/y
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i.test(v);
}

export function initSearch({ invoke, toast, startUrlDownload, inLibrary, playPath, enqueuePath, downloadDir, downloadFmt, chime, volume }) {
  const input = document.getElementById("dl-url");
  const btn = document.getElementById("btn-dl-start");
  const box = document.getElementById("dl-results");
  // descargas que no nacieron de una pastilla (enlace pegado, lista): se
  // enseñan también como pastillas, aquí (sustituye a la lista vieja, ADR #122)
  const active = document.getElementById("dl-active");
  const api = { onTask() {}, onTasks() {}, onPreview() {}, stopPreview() {} };
  if (!input || !btn || !box) return api;

  input.placeholder = "Busca una canción, un artista o pega un enlace…";
  btn.className = "btn dl-go";
  btn.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-search" /></svg><span>Buscar</span>';
  const btnLabel = btn.querySelector("span");
  const btnIcon = btn.querySelector("use");

  let timer = 0;
  let seq = 0; // descarta respuestas viejas si se escribe más rápido que la red
  let lastQuery = "";
  let lastItems = [];
  /// id de tarea → pastilla que la muestra
  const taskPills = new Map();
  /// ids de tareas que ya tuvieron pastilla de resultados (no se duplican abajo)
  const tied = new Set();
  /// ids de vídeo ya resueltos (o resolviéndose) de antemano
  const prefetched = new Set();
  /// URL de descarga → pastilla, apuntada ANTES de pedir la descarga: el
  /// primer aviso del motor puede llegar antes que la respuesta con los ids,
  /// y sin esto se tomaba por una descarga por enlace (pastilla de más que se
  /// quedaba girando, visto en la app real el 2026-11-17)
  const expected = new Map();
  const urlOf = (id) => `https://music.youtube.com/watch?v=${id}`;

  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function setMode() {
    const url = looksLikeUrl(input.value);
    btn.classList.toggle("is-url", url);
    btnLabel.textContent = url ? "Descargar" : "Buscar";
    btnIcon.setAttribute("href", url ? "#i-download" : "#i-search");
  }

  function show(state) {
    box.dataset.state = state;
    box.hidden = state === "idle";
  }

  // ---------------------------------------------------------------- estados de la lista
  function skeleton() {
    box.textContent = "";
    const list = h("div", "pills");
    for (let i = 0; i < SKELETONS; i++) {
      const p = h("div", "pill pill-skel");
      p.style.setProperty("--i", String(i));
      p.append(h("span", "pill-art"), h("span", "skel-lines"));
      list.appendChild(p);
    }
    box.appendChild(list);
    show("loading");
  }

  function message(kind, title, sub) {
    box.textContent = "";
    const m = h("div", `dl-msg dl-msg-${kind}`);
    const ic = h("span", "dl-msg-ic");
    ic.innerHTML = kind === "offline"
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 8.8a15 15 0 0 1 4.2-2.6M9.9 5.2A15 15 0 0 1 22 8.8M5 12.5a10 10 0 0 1 3.4-2M15.6 10.4A10 10 0 0 1 19 12.5M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
    m.append(ic, h("strong", "", title));
    if (sub) m.appendChild(h("span", "", sub));
    box.appendChild(m);
    show(kind);
  }

  /// Carátulas después de los textos: se asignan un frame más tarde y entran
  /// con un fundido cuando terminan de cargar.
  function lazyArt(img, url) {
    if (!url) return;
    requestAnimationFrame(() => {
      img.onload = () => img.classList.add("on");
      img.src = url;
    });
  }

  /// Botón plateado de descargar: icono, anillo de avance y ✓ (dl-anim.js).
  function dlButton(label) {
    const b = h("button", "pill-dl");
    b.type = "button";
    b.title = label;
    b.dataset.st = "idle";
    b.setAttribute("aria-label", label);
    b.innerHTML =
      '<svg class="ic dl-ic" aria-hidden="true"><use href="#i-download" /></svg>' +
      '<svg class="dl-ring" viewBox="0 0 30 30" aria-hidden="true"><circle class="dl-ring-track" cx="15" cy="15" r="13" pathLength="100" /><circle class="dl-ring-arc" cx="15" cy="15" r="13" pathLength="100" /></svg>' +
      '<svg class="dl-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.5l3.6 3.6 7.4-8.2" pathLength="1" /></svg>';
    return b;
  }

  /// Anillo de la vista previa alrededor de la carátula (carga y cuenta atrás).
  function pvRing() {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("class", "pv-ring");
    s.setAttribute("viewBox", "0 0 44 44");
    s.setAttribute("aria-hidden", "true");
    s.innerHTML = '<circle class="pv-arc" cx="22" cy="22" r="20.5" pathLength="100" />';
    return s;
  }

  // ---------------------------------------------------------------- vista previa
  /// Vista previa en curso: id de vídeo, pastilla y fase («loading» | «playing»).
  let pv = { id: null, pill: null, state: "idle" };
  let pvSeq = 0;

  function paintPv(p, state, len) {
    if (!p) return;
    p.dataset.pv = state;
    if (len) p.style.setProperty("--pv-len", `${len}s`);
    const ring = p.querySelector(".pv-ring");
    if (ring && state === "playing") {
      // reinicia la cuenta atrás aunque sea la misma pastilla
      ring.classList.remove("run");
      void ring.getBoundingClientRect();
      ring.classList.add("run");
    }
  }

  function clearPv() {
    if (pv.pill) {
      delete pv.pill.dataset.pv;
      const ring = pv.pill.querySelector(".pv-ring");
      if (ring) ring.classList.remove("run");
    }
    pv = { id: null, pill: null, state: "idle" };
  }

  function stopPreview() {
    if (!pv.id) return;
    pvSeq++;
    clearPv();
    invoke("preview_stop").catch(() => {});
  }

  async function preview(s, p) {
    if (pv.id === s.id) return stopPreview(); // pulsar la misma la detiene
    if (!navigator.onLine) return toast("Sin vista previa sin conexión");
    clearPv();
    const my = ++pvSeq;
    pv = { id: s.id, pill: p, state: "loading" };
    paintPv(p, "loading");
    prefetched.add(s.id);
    const slow = setTimeout(() => { if (my === pvSeq) toast("La vista previa está tardando…"); }, PV_SLOW_MS);
    try {
      const r = await invoke("preview_play", { id: s.id });
      if (my !== pvSeq) return;
      pv.state = "playing";
      paintPv(p, "playing", r && r.len);
      if (volume && volume() <= 0) toast("El volumen está en 0");
    } catch (e) {
      if (my !== pvSeq || /cancelada/.test(String(e))) return;
      clearPv();
      toast(`Sin vista previa: ${e}`);
    } finally {
      clearTimeout(slow);
    }
  }

  /// Aviso del motor (`enn://preview`): `false` = acabó (o se cortó).
  api.onPreview = (on) => {
    if (!on && pv.state === "playing") clearPv();
  };
  api.stopPreview = stopPreview;
  // al cerrar Descargas o cambiar de modo (app.js)
  document.addEventListener("enn:dl-close", stopPreview);

  function prefetch(id) {
    if (!id || prefetched.has(id) || !navigator.onLine) return;
    prefetched.add(id);
    invoke("preview_prefetch", { id }).catch(() => prefetched.delete(id));
  }

  /// Ratón 150 ms encima de una pastilla: se resuelve de antemano.
  function hoverPrefetch(p, id) {
    let t = 0;
    p.addEventListener("pointerenter", () => { t = setTimeout(() => prefetch(id), HOVER_PREFETCH_MS); });
    p.addEventListener("pointerleave", () => clearTimeout(t));
  }

  // ---------------------------------------------------------------- pastillas
  function songPill(s, opts = {}) {
    const p = h("div", "pill");
    p.tabIndex = 0;
    p.setAttribute("role", "button");
    p.dataset.id = s.id;
    if (opts.check) {
      const c = h("input", "pill-check");
      c.type = "checkbox";
      c.checked = true;
      c.setAttribute("aria-label", `Incluir «${s.title}»`);
      c.addEventListener("click", (e) => e.stopPropagation());
      c.addEventListener("change", () => opts.onCheck && opts.onCheck());
      p.appendChild(c);
    }
    let art;
    if (opts.check) {
      // dentro de un álbum: el número de pista; al pasar el ratón es ▶ y
      // lanza la vista previa (el clic en la fila sigue marcando la casilla)
      art = h("button", "pill-art pill-num pv-num");
      art.type = "button";
      art.title = `Escuchar 10 s de «${s.title}»`;
      art.setAttribute("aria-label", art.title);
      art.append(h("span", "pv-n", String(opts.n)), h("span", "pv-play", "▶"));
      art.addEventListener("click", (e) => { e.stopPropagation(); preview(s, p); });
    } else {
      art = h("span", "pill-art");
      const img = h("img");
      img.alt = "";
      img.draggable = false;
      art.appendChild(img);
      lazyArt(img, s.thumb);
    }
    art.appendChild(pvRing());
    const meta = h("span", "pill-meta");
    meta.appendChild(h("span", "pill-title", s.title));
    const sub = [s.artist, opts.check ? null : s.album].filter(Boolean).join(" · ");
    if (sub) meta.appendChild(h("span", "pill-sub", sub));
    // solo si es la misma canción: mismo título y alguno de sus artistas
    if (inLibrary(s.title, s.artist)) meta.appendChild(h("span", "pill-have", "Ya en tu biblioteca"));
    p.append(art, meta);
    if (s.duration) p.appendChild(h("span", "pill-dur", s.duration));
    const b = dlButton(`Descargar «${s.title}»`);
    p.appendChild(b);
    b.addEventListener("click", (e) => { e.stopPropagation(); onDlButton([s], [p]); });
    hoverPrefetch(p, s.id);
    if (!opts.check) {
      p.title = `Escuchar 10 s · D para descargar`;
      p.addEventListener("click", () => preview(s, p));
    } else {
      p.addEventListener("click", () => { const c = p.querySelector(".pill-check"); c.checked = !c.checked; opts.onCheck && opts.onCheck(); });
    }
    p.addEventListener("keydown", (e) => {
      if (e.target !== p) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); preview(s, p); }
      else if (e.key === "d" || e.key === "D") { e.preventDefault(); onDlButton([s], [p]); }
    });
    return p;
  }

  function albumPill(a) {
    const p = h("div", "pill pill-album");
    p.tabIndex = 0;
    p.setAttribute("role", "button");
    p.setAttribute("aria-label", `Abrir el álbum «${a.title}»`);
    const art = h("span", "pill-art");
    const img = h("img");
    img.alt = "";
    art.appendChild(img);
    lazyArt(img, a.thumb);
    const meta = h("span", "pill-meta");
    meta.appendChild(h("span", "pill-kicker", a.label || "Álbum"));
    meta.appendChild(h("span", "pill-title", a.title));
    meta.appendChild(h("span", "pill-sub", [a.artist, a.year].filter(Boolean).join(" · ")));
    const chev = h("span", "pill-chev");
    chev.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-chevron" /></svg>';
    p.append(art, meta, chev);
    const open = () => openAlbum(a);
    p.addEventListener("click", open);
    p.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    return p;
  }

  function renderResults(items) {
    stopPreview();
    box.textContent = "";
    const list = h("div", "pills");
    items.forEach((it, i) => {
      const p = it.kind === "album" ? albumPill(it) : songPill(it);
      p.style.setProperty("--i", String(Math.min(i, 8)));
      list.appendChild(p);
    });
    box.appendChild(list);
    show("results");
    // las primeras canciones se resuelven ya: su vista previa saldrá al instante
    items.filter((it) => it.kind !== "album").slice(0, PREFETCH_TOP).forEach((it) => prefetch(it.id));
  }

  // ---------------------------------------------------------------- álbum
  async function openAlbum(a) {
    // revisión 2026-11-12: sin esto, si se escribía otra búsqueda mientras
    // cargaba el álbum, el álbum llegaba tarde y tapaba los resultados nuevos
    const my = ++seq;
    stopPreview();
    skeleton();
    let d;
    try {
      d = await invoke("music_album", { browseId: a.browse_id });
    } catch (e) {
      if (my !== seq) return;
      if (!navigator.onLine) return message("offline", "Sin conexión a internet", "Conéctate para buscar y descargar.");
      toast(`No se pudo abrir el álbum: ${e}`);
      return renderResults(lastItems);
    }
    if (my !== seq) return;
    box.textContent = "";
    const head = h("div", "album-head");
    const back = h("button", "icon-btn album-back");
    back.type = "button";
    back.title = "Volver a los resultados";
    back.setAttribute("aria-label", "Volver a los resultados");
    back.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-chevron" /></svg>';
    back.addEventListener("click", () => renderResults(lastItems));
    const art = h("span", "album-art");
    const img = h("img");
    img.alt = "";
    art.appendChild(img);
    lazyArt(img, d.thumb || a.thumb);
    const meta = h("div", "album-meta");
    meta.appendChild(h("span", "pill-kicker", a.label || "Álbum"));
    meta.appendChild(h("strong", "album-title", d.title || a.title));
    meta.appendChild(h("span", "pill-sub", [d.artist || a.artist, d.year || a.year, `${d.tracks.length} canciones`].filter(Boolean).join(" · ")));
    head.append(back, art, meta);

    const actions = h("div", "album-actions");
    const sel = h("button", "btn dl-go small");
    sel.type = "button";
    const all = h("button", "btn small ghost", "Todo el álbum");
    all.type = "button";
    // marcar / desmarcar todas de golpe
    const toggle = h("button", "btn small ghost", "Deseleccionar todas");
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      const checks = pills.map((p) => p.querySelector(".pill-check"));
      const allOn = checks.every((c) => c.checked);
      checks.forEach((c) => { c.checked = !allOn; });
      refreshSel();
    });
    actions.append(sel, toggle, all);

    const list = h("div", "pills pills-album");
    const pills = [];
    const refreshSel = () => {
      const n = pills.filter((p) => p.querySelector(".pill-check").checked).length;
      sel.textContent = `Descargar seleccionadas (${n})`;
      sel.disabled = n === 0;
      toggle.textContent = n === pills.length ? "Deseleccionar todas" : "Seleccionar todas";
    };
    d.tracks.forEach((t, i) => {
      const p = songPill(t, { check: true, n: i + 1, onCheck: refreshSel });
      p.style.setProperty("--i", String(Math.min(i, 8)));
      pills.push(p);
      list.appendChild(p);
    });
    refreshSel();
    sel.addEventListener("click", () => {
      const pick = pills.map((p, i) => [p, d.tracks[i]]).filter(([p]) => p.querySelector(".pill-check").checked);
      download(pick.map((x) => x[1]), pick.map((x) => x[0]));
    });
    all.addEventListener("click", () => download(d.tracks, pills));
    box.append(head, actions, list);
    show("album");
  }

  // ---------------------------------------------------------------- descargar
  function addBars(p) {
    let bars = p.querySelector(".pill-bars");
    if (bars) return bars;
    bars = h("span", "pill-bars");
    bars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < BARS; i++) {
      const b = h("i");
      // alturas y ritmos al azar: cada pastilla tiene su propia «onda»
      b.style.setProperty("--h", (0.25 + Math.random() * 0.75).toFixed(2));
      b.style.setProperty("--d", `${(0.55 + Math.random() * 0.9).toFixed(2)}s`);
      b.style.setProperty("--o", `${(-Math.random() * 1.2).toFixed(2)}s`);
      b.style.setProperty("--k", String(i));
      bars.appendChild(b);
    }
    p.appendChild(bars);
    return bars;
  }

  /// Animador de la pastilla `p` (fases de dl-anim.js → atributos y clases).
  function motionOf(p) {
    if (p._motion) return p._motion;
    const setPhase = (ph) => {
      p.dataset.phase = ph;
      const b = p.querySelector(".pill-dl");
      if (b) {
        b.dataset.st = buttonState(ph);
        const busy = b.dataset.st === "busy";
        const t = p.querySelector(".pill-title");
        const name = t ? t.textContent : "";
        b.title = busy ? `Cancelar «${name}»` : ph === "error" ? `Reintentar «${name}»` : `Descargar «${name}»`;
        b.setAttribute("aria-label", b.title);
      }
      if (ph === "error") chime && chime("err");
      if (ph === "cancelled") {
        // las barras caen y se desvanecen; luego la pastilla vuelve a reposo
        setTimeout(() => {
          if (p.dataset.phase !== "cancelled") return;
          delete p.dataset.phase;
          p.querySelector(".pill-bars")?.remove();
          p._motion = null;
          const b2 = p.querySelector(".pill-dl");
          if (b2) b2.dataset.st = "idle";
        }, 600);
      }
    };
    p._motion = createPillMotion({
      setPhase,
      onChime: () => chime && chime("ok"),
      onDone: () => doneActions(p, p._path),
    });
    return p._motion;
  }

  /// Botón de la pastilla: descarga; si está descargando, cancela; tras un
  /// error, reintenta.
  function onDlButton(songs, pills) {
    const p = pills[0];
    const st = p.querySelector(".pill-dl")?.dataset.st;
    if (st === "busy" && p._task) {
      invoke("download_cancel", { id: p._task }).catch((e) => toast(`No se pudo cancelar: ${e}`));
      return;
    }
    if (st === "done") return;
    download(songs, pills);
  }

  async function download(songs, pills) {
    if (!songs.length) return;
    if (!navigator.onLine) return message("offline", "Sin conexión a internet", "Conéctate para buscar y descargar.");
    songs.forEach((s, i) => { if (pills[i]) expected.set(urlOf(s.id), pills[i]); });
    pills.forEach((p) => {
      p._motion = null;
      p.querySelector(".pill-acts")?.remove();
      addBars(p);
      motionOf(p).update({ state: "queued" });
    });
    try {
      const dir = await downloadDir();
      const ids = await invoke("download_tracks", {
        tracks: songs.map((s) => ({ id: s.id, title: s.artist ? `${s.artist} - ${s.title}` : s.title })),
        dir,
        fmt: downloadFmt(),
      });
      ids.forEach((id, i) => { if (pills[i]) { taskPills.set(id, pills[i]); pills[i]._task = id; tied.add(id); } });
      if (ids.length > 1) toast(`${ids.length} canciones en cola`);
    } catch (e) {
      pills.forEach((p) => motionOf(p).update({ state: "error", error: String(e) }));
      toast(`No se pudo descargar: ${e}`);
    }
  }

  /// Al terminar, la pastilla ofrece escucharla ya o ponerla en la cola
  /// (entran con rebote, una tras otra).
  function doneActions(p, path) {
    if (!path || p.querySelector(".pill-acts")) return;
    const acts = h("span", "pill-acts");
    const play = h("button", "btn small ghost", "▶ Escuchar");
    play.type = "button";
    play.addEventListener("click", (e) => { e.stopPropagation(); stopPreview(); playPath(path); });
    const add = h("button", "btn small ghost", "+ Cola");
    add.type = "button";
    add.addEventListener("click", (e) => { e.stopPropagation(); enqueuePath(path); });
    [play, add].forEach((b, k) => b.style.setProperty("--d", `${k * ACTS_STAGGER_MS}ms`));
    acts.append(play, add);
    const dl = p.querySelector(".pill-dl") || p.querySelector(".pill-slot");
    if (dl) dl.replaceWith(acts);
    else p.appendChild(acts);
  }

  /// Pastilla de una descarga por enlace (no viene de los resultados).
  function activePill(task) {
    const p = h("div", "pill pill-task");
    p.dataset.task = String(task.id);
    p._task = task.id;
    const art = h("span", "pill-art pill-num");
    art.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-download" /></svg>';
    const meta = h("span", "pill-meta");
    meta.appendChild(h("span", "pill-title", task.title || task.url));
    meta.appendChild(h("span", "pill-sub", "Descarga por enlace"));
    const b = dlButton("Cancelar");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.st === "busy") invoke("download_cancel", { id: task.id }).catch(() => {});
    });
    p.append(art, meta, h("span", "pill-dur", ""), b);
    return p;
  }

  // ---------------------------------------------------------------- avance (por eventos)
  /// Pastillas con barras que aún se mueven (un solo bucle para todas).
  const moving = new Set();
  let raf = 0;
  let last = 0;
  function loop(t) {
    const dt = last ? Math.min(64, t - last) : 16;
    last = t;
    for (const p of moving) {
      const m = p._motion;
      const still = m && p.isConnected ? m.tick(dt) : false;
      const bars = p.querySelector(".pill-bars");
      if (bars && m) {
        const lit = Math.round((m.shown / 100) * BARS);
        const kids = bars.children;
        for (let i = 0; i < kids.length; i++) kids[i].classList.toggle("on", i < lit);
        p.querySelector(".pill-dl")?.style.setProperty("--p", (m.shown / 100).toFixed(3));
      }
      if (!still) moving.delete(p);
    }
    raf = moving.size ? requestAnimationFrame(loop) : 0;
    if (!raf) last = 0;
  }
  function kick(p) {
    moving.add(p);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  /// Una tarea del motor (`download://task`).
  api.onTask = (t) => {
    if (!taskPills.has(t.id) && expected.has(t.url)) {
      const p = expected.get(t.url);
      expected.delete(t.url);
      taskPills.set(t.id, p);
      p._task = t.id;
      tied.add(t.id);
    }
    if (active && !tied.has(t.id) && !taskPills.has(t.id) && t.state !== "done" && t.state !== "error") {
      // descarga por enlace: su propia pastilla, la más nueva arriba
      const p = activePill(t);
      active.prepend(p);
      active.hidden = false;
      taskPills.set(t.id, p);
      tied.add(t.id);
    }
    const p = taskPills.get(t.id);
    if (!p || !p.isConnected) return;
    if (p.classList.contains("pill-task") && t.title) {
      const ti = p.querySelector(".pill-title");
      if (ti && ti.textContent !== t.title) ti.textContent = t.title;
    }
    addBars(p);
    if (t.path) p._path = t.path;
    if (t.state === "error" && t.error) p.title = t.error;
    motionOf(p).update(t);
    kick(p);
    if (t.state === "done" || t.state === "error") taskPills.delete(t.id);
  };

  /// Todas a la vez (al abrir el panel, para ponerse al día).
  api.onTasks = (tasks) => { for (const t of tasks) api.onTask(t); };

  // ---------------------------------------------------------------- buscar
  async function search(q) {
    const my = ++seq;
    lastQuery = q;
    if (!navigator.onLine) return message("offline", "Sin conexión a internet", "Conéctate para buscar y descargar.");
    skeleton();
    let r;
    try {
      r = await invoke("music_search", { query: q });
    } catch (e) {
      if (my !== seq) return;
      return message("empty", "No se pudo buscar", String(e));
    }
    if (my !== seq) return; // llegó tarde: ya se escribió otra cosa
    if (r.offline) return message("offline", "Sin conexión a internet", "Conéctate para buscar y descargar.");
    if (!r.items.length) return message("empty", "Sin resultados", `No encontramos nada para «${q}».`);
    lastItems = r.items;
    renderResults(r.items);
  }

  function schedule() {
    clearTimeout(timer);
    setMode();
    const q = input.value.trim();
    if (looksLikeUrl(q) || q.length < MIN_CHARS) {
      seq++;
      if (!q) { lastQuery = ""; show("idle"); }
      return;
    }
    timer = setTimeout(() => search(q), DEBOUNCE_MS);
  }

  async function go() {
    const q = input.value.trim();
    if (!q) return;
    clearTimeout(timer);
    if (looksLikeUrl(q)) {
      await startUrlDownload();
      setMode();
      return;
    }
    search(q);
  }

  input.addEventListener("input", schedule);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); go(); }
    if (e.key === "Escape" && input.value) { e.stopPropagation(); input.value = ""; schedule(); }
  });
  btn.addEventListener("click", go);
  // al volver la red se repite la búsqueda que se quedó sin conexión
  window.addEventListener("online", () => { if (lastQuery && box.dataset.state === "offline") search(lastQuery); });
  window.addEventListener("offline", () => { if (box.dataset.state === "loading") message("offline", "Sin conexión a internet", "Conéctate para buscar y descargar."); });

  setMode();
  show("idle");
  return api;
}
