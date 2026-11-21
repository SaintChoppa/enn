// Menú de recomendaciones (Sprint 3, T7).
//
// Tarjeta abajo a la derecha que propone qué poner después de la canción que
// suena. Frecuencia acordada con el propietario (2026-11-17): la 1.ª escucha
// de una canción y después cada 3.ª (3.ª, 6.ª, 9.ª…), más el tercer ciclo
// seguido en «repetir una». Una vez por canción y sesión. No roba el foco y
// se va sola a los 9 s (la cuenta atrás se para con el ratón encima).

/// La canción lleva esto sonando antes de proponer (no salta con los saltos).
export const SHOW_AFTER_S = 8;
/// Canciones más cortas: sin menú.
export const MIN_DUR_S = 30;
/// Si se volvió del reposo con la canción más avanzada, ya no se propone.
export const LATE_RETURN_S = 60;
/// Descartes seguidos tras los que sale la mitad de las veces.
export const DISMISS_STREAK = 3;

/// ¿Toca por número de escuchas? 1.ª y cada 3.ª.
export function isDueByPlays(plays) {
  return plays === 1 || (plays > 0 && plays % 3 === 0);
}

/// Decide si sale la tarjeta: «show», «wait» (aún no, volver a preguntar) o «no».
export function createRecoGate() {
  const shown = new Set();
  const idleKeys = new Set();
  let disabled = false;
  let streak = 0;
  let skipCounter = 0;
  return {
    decide({ key, plays, repeatCycles = 0, posS = 0, durS = 0, blocked = false, idle = false }) {
      if (disabled || !key || shown.has(key)) return "no";
      if (durS && durS < MIN_DUR_S) return "no";
      if (blocked) return "no";
      if (!isDueByPlays(plays) && repeatCycles !== 3) return "no";
      if (idle) {
        idleKeys.add(key);
        return "wait";
      }
      if (idleKeys.has(key) && posS >= LATE_RETURN_S) {
        shown.add(key);
        return "no";
      }
      if (posS < SHOW_AFTER_S) return "wait";
      shown.add(key);
      if (streak >= DISMISS_STREAK) {
        skipCounter++;
        if (skipCounter % 2 === 1) return "no";
      }
      return "show";
    },
    dismissed() { streak++; },
    accepted() { streak = 0; skipCounter = 0; },
    setDisabled(on) { disabled = !!on; },
  };
}

/// La tarjeta. `artUrl(path)` → Promise<url|null>.
export function mountRecoCard({ onPlayNext, onPlayNow, onAddAll, onDismiss, onAccept, onNever, artUrl }) {
  const h = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const card = h("aside", "reco");
  card.setAttribute("aria-label", "Recomendaciones");
  card.hidden = true;
  const head = h("div", "reco-head");
  const title = h("span", "reco-title");
  const more = h("button", "icon-btn reco-more", "⋯");
  more.type = "button";
  more.title = "Más opciones";
  more.setAttribute("aria-label", "Más opciones");
  const x = h("button", "icon-btn reco-x", "✕");
  x.type = "button";
  x.title = "Cerrar (Esc)";
  x.setAttribute("aria-label", "Cerrar las recomendaciones");
  head.append(title, more, x);
  const list = h("ul", "reco-list");
  const foot = h("div", "reco-foot");
  const all = h("button", "btn small ghost reco-all", "Añadir las 3");
  all.type = "button";
  foot.appendChild(all);
  const timer = h("i", "reco-timer");
  card.append(head, list, foot, timer);
  document.body.appendChild(card);

  let items = [];
  let open = false;

  const close = (how) => {
    if (!open) return;
    open = false;
    card.classList.remove("in");
    card.classList.add("out");
    if (how === "dismiss") onDismiss && onDismiss();
    setTimeout(() => { if (!open) { card.hidden = true; card.classList.remove("out"); card.style.transform = ""; } }, 220);
  };

  function show(kind, list_) {
    items = list_;
    title.textContent = kind === "habit" ? "Después de esta sueles escuchar" : "Te puede encajar";
    all.textContent = items.length > 1 ? `Añadir las ${items.length}` : "Añadir";
    list.textContent = "";
    items.forEach((it, i) => {
      const li = h("li", "reco-row");
      li.style.setProperty("--i", String(i));
      li.title = "Poner a continuación";
      const art = h("span", "reco-art");
      const img = h("img");
      img.alt = "";
      art.appendChild(img);
      if (artUrl) artUrl(it.track.path).then((u) => { if (u) { img.onload = () => img.classList.add("on"); img.src = u; } }).catch(() => {});
      const meta = h("span", "reco-meta");
      meta.append(h("span", "reco-t", it.track.title), h("span", "reco-a", it.track.artist || ""), h("span", "reco-why", it.reason || ""));
      const play = h("button", "icon-btn reco-play", "▶");
      play.type = "button";
      play.title = "Reproducir ya";
      play.setAttribute("aria-label", `Reproducir ya «${it.track.title}»`);
      play.addEventListener("click", (e) => { e.stopPropagation(); onAccept && onAccept(); onPlayNow(it.track); close("act"); });
      li.addEventListener("click", () => {
        onAccept && onAccept();
        onPlayNext(it.track);
        li.classList.add("added");
        if (items.length === 1) close("act");
      });
      li.append(art, meta, play);
      list.appendChild(li);
    });
    // reinicia la cuenta atrás
    timer.classList.remove("run");
    void timer.getBoundingClientRect();
    timer.classList.add("run");
    card.hidden = false;
    card.classList.remove("out");
    void card.getBoundingClientRect();
    card.classList.add("in");
    open = true;
  }

  all.addEventListener("click", () => { onAccept && onAccept(); onAddAll(items.map((i) => i.track)); close("act"); });
  x.addEventListener("click", () => close("dismiss"));
  more.addEventListener("click", () => {
    foot.textContent = "";
    const q = h("span", "reco-q", "¿No volver a mostrar?");
    const yes = h("button", "btn small ghost", "Sí");
    yes.type = "button";
    const no = h("button", "btn small ghost", "No");
    no.type = "button";
    yes.addEventListener("click", () => { onNever && onNever(); close("never"); });
    no.addEventListener("click", () => { foot.textContent = ""; foot.appendChild(all); });
    foot.append(q, yes, no);
  });
  timer.addEventListener("animationend", () => close("timeout"));

  // arrastrar a la derecha la descarta
  let drag = null;
  card.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    drag = { x: e.clientX, dx: 0, id: e.pointerId };
  });
  card.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = Math.max(0, e.clientX - drag.x);
    if (drag.dx > 6) {
      card.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
      card.style.transform = `translateX(${drag.dx}px)`;
    }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = drag.dx;
    drag = null;
    card.classList.remove("dragging");
    if (dx > 80) {
      card.style.transform = "translateX(120%)";
      close("dismiss");
    } else {
      card.style.transform = "";
    }
  };
  card.addEventListener("pointerup", endDrag);
  card.addEventListener("pointercancel", endDrag);
  // Esc la descarta (si no hay un diálogo abierto, que tiene su propio Esc)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open && !document.querySelector("dialog[open]")) close("dismiss");
  });

  return { show, hide: () => close("hide"), get open() { return open; } };
}
