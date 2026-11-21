// Desplegable propio de Enn (ADR #129).
//
// Los <select> nativos abren la lista del sistema: en Windows sale con fondo
// blanco y heredaba el texto claro de la app, así que las opciones casi no se
// leían. Aquí cada <select> se queda en el documento (oculto, sigue siendo la
// fuente de verdad: su `value`, sus eventos `change` y sus manejadores no
// cambian) y encima se pinta un botón y una lista de cristal con el estilo de
// la app. La lista va en la capa superior (Popover API), así que también se
// ve por encima de la ventana de Ajustes, que es un <dialog> modal.
//
// Teclado: Enter/Espacio/↓ abre; ↑ ↓ Inicio Fin recorren; Enter elige; Esc o
// Tab cierran; escribir salta a la opción que empiece por esas letras.

const SEL_PROTO = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
const IDX_PROTO = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
let openMenu = null; // { sel, menu, btn, close }
let uid = 0;

function chevron() {
  return '<svg class="ic" aria-hidden="true"><use href="#i-chevron" /></svg>';
}

function enhance(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = "1";
  const id = `sel-${++uid}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sel-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-controls", id);
  const label = sel.getAttribute("aria-label") || sel.title;
  if (label) btn.setAttribute("aria-label", label);
  if (sel.title) btn.title = sel.title;
  btn.innerHTML = `<span class="sel-val"></span>${chevron()}`;
  sel.classList.add("sel-native");
  sel.tabIndex = -1;
  sel.setAttribute("aria-hidden", "true");
  sel.after(btn);

  const valEl = btn.querySelector(".sel-val");
  const paint = () => {
    const o = sel.options[sel.selectedIndex];
    valEl.textContent = o ? o.textContent : "";
    btn.disabled = sel.disabled;
  };

  // El valor también cambia por código (sel.value = …, selectedIndex = …):
  // se interceptan en esta instancia para repintar el botón.
  Object.defineProperty(sel, "value", {
    configurable: true,
    get() { return SEL_PROTO.get.call(this); },
    set(v) { SEL_PROTO.set.call(this, v); paint(); },
  });
  Object.defineProperty(sel, "selectedIndex", {
    configurable: true,
    get() { return IDX_PROTO.get.call(this); },
    set(v) { IDX_PROTO.set.call(this, v); paint(); },
  });
  // opciones que llegan después (dispositivos de salida, órdenes, presets)
  new MutationObserver(paint).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "selected"] });
  sel.addEventListener("change", paint);

  btn.addEventListener("click", () => (openMenu && openMenu.sel === sel ? closeMenu() : openFor(sel, btn, id)));
  btn.addEventListener("keydown", (e) => {
    if (openMenu && openMenu.sel === sel) return; // abierta: manda onKey
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openFor(sel, btn, id);
    }
  });
  paint();
}

function choose(sel, i) {
  if (i < 0 || i >= sel.options.length || sel.options[i].disabled) return;
  if (sel.selectedIndex !== i) {
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function openFor(sel, btn, id) {
  closeMenu();
  if (sel.disabled || !sel.options.length) return;
  const menu = document.createElement("div");
  menu.className = "sel-menu";
  menu.id = id;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("popover", "manual");
  menu.tabIndex = -1;
  let active = Math.max(0, sel.selectedIndex);
  const items = Array.from(sel.options).map((o, i) => {
    const it = document.createElement("div");
    it.className = "sel-opt";
    it.setAttribute("role", "option");
    it.id = `${id}-o${i}`;
    it.setAttribute("aria-selected", String(i === sel.selectedIndex));
    if (o.disabled) it.setAttribute("aria-disabled", "true");
    it.innerHTML = '<svg class="ic sel-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';
    const tx = document.createElement("span");
    tx.textContent = o.textContent;
    it.appendChild(tx);
    it.addEventListener("pointerdown", (e) => e.preventDefault()); // no robar el foco al botón
    it.addEventListener("click", () => { choose(sel, i); closeMenu(); btn.focus(); });
    it.addEventListener("pointermove", () => setActive(i));
    menu.appendChild(it);
    return it;
  });
  const setActive = (i) => {
    active = i;
    items.forEach((it, k) => it.classList.toggle("active", k === i));
    menu.setAttribute("aria-activedescendant", items[i] ? items[i].id : "");
    if (items[i]) items[i].scrollIntoView({ block: "nearest" });
  };

  // dentro de un <dialog> modal la lista tiene que ser hija suya: lo que
  // queda fuera de un modal es inerte y no recibiría los clics
  (btn.closest("dialog[open]") || document.body).appendChild(menu);
  // posición: debajo del botón (o encima si no cabe), al menos su ancho
  const r = btn.getBoundingClientRect();
  menu.style.minWidth = `${Math.round(r.width)}px`;
  try { menu.showPopover(); } catch { menu.classList.add("sel-fallback"); }
  const mh = menu.offsetHeight;
  const below = window.innerHeight - r.bottom - 8;
  const up = below < mh && r.top > below;
  menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.round(up ? r.top - mh - 4 : r.bottom + 4)}px`;
  menu.dataset.side = up ? "top" : "bottom";
  menu.classList.add("on");
  setActive(active);
  btn.setAttribute("aria-expanded", "true");
  btn.classList.add("open");

  let typed = "", typedT = 0;
  const onKey = (e) => {
    // con la lista abierta las teclas son suyas: que no lleguen a los atajos
    // de la app (Espacio pausaría la música, ← → cambiarían de canción)
    if (e.key !== "Tab") e.stopPropagation();
    const n = items.length;
    const step = (from, d) => {
      let i = from;
      for (let k = 0; k < n; k++) {
        i = Math.max(0, Math.min(n - 1, i + d));
        if (!sel.options[i].disabled) return i;
      }
      return from;
    };
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(step(active, 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(step(active, -1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(step(-1, 1)); }
    else if (e.key === "End") { e.preventDefault(); setActive(step(n, -1)); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(sel, active); closeMenu(); btn.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); btn.focus(); }
    else if (e.key === "Tab") closeMenu();
    else if (e.key.length === 1) {
      clearTimeout(typedT);
      typed += e.key.toLowerCase();
      typedT = setTimeout(() => { typed = ""; }, 600);
      const i = Array.from(sel.options).findIndex((o) => o.textContent.toLowerCase().startsWith(typed));
      if (i >= 0) setActive(i);
    }
  };
  const onDown = (e) => { if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu(); };
  const onScroll = (e) => { if (!menu.contains(e.target)) closeMenu(); };
  // el teclado se escucha en todo el documento mientras está abierta: no
  // depende de que el botón conserve el foco
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
  openMenu = {
    sel,
    close() {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("blur", closeMenu);
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("open");
      // salida corta: se funde y se quita
      menu.classList.remove("on");
      menu.classList.add("off");
      setTimeout(() => { try { menu.hidePopover(); } catch {} menu.remove(); }, 120);
    },
  };
}

/// Abre la lista de `sel` anclada a otro botón (p. ej. el altavoz del dock).
export function openSelect(sel, anchor) {
  if (!sel) return;
  if (openMenu && openMenu.sel === sel) return closeMenu();
  enhance(sel);
  openFor(sel, anchor, `sel-ext-${++uid}`);
}

export function closeMenu() {
  if (!openMenu) return;
  const m = openMenu;
  openMenu = null;
  m.close();
}

/// Mejora todos los <select> presentes y los que se añadan después.
export function initSelects(root = document) {
  root.querySelectorAll("select").forEach(enhance);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "SELECT") enhance(n);
        else n.querySelectorAll && n.querySelectorAll("select").forEach(enhance);
      }
    }
  }).observe(root.body || root, { childList: true, subtree: true });
}
