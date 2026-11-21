// Laboratorio de movimiento (Sprint 4, T1): los mismos controles con los tres
// caracteres, uno por columna. Cada columna lleva `data-feel`, así que las
// fichas CSS (motion.css) y `spring()` usan su curva sin tocar el resto.
import { FEELS, feelOf, setFeel, spring } from "./motion.js";

const NOMBRES = {
  suave: ["Suave", "casi sin rebote"],
  medio: ["Medio", "más rebote"],
  elastico: ["Elástico", "rebote marcado"],
};

const host = window.parent !== window ? window.parent : null;
const hostRoot = host ? host.document.documentElement : document.documentElement;
let slow = false;

// ---------------------------------------------------------------- cámara lenta
// Vale para las animaciones de WAAPI y para las transiciones CSS (también son
// objetos Animation): se frenan al nacer.
function frenar(anim) {
  if (slow && anim) anim.playbackRate = 0.25;
  return anim;
}
document.addEventListener("transitionrun", (e) => {
  if (!slow) return;
  for (const a of e.target.getAnimations({ subtree: false })) a.playbackRate = 0.25;
});

// ---------------------------------------------------------------- demos
function pop(card, col, open) {
  card._anim?.cancel();
  if (open) {
    card.hidden = false;
    card._anim = frenar(spring(card, [
      { opacity: 0, transform: "translateY(-6px) scale(0.96)" },
      { opacity: 1, transform: "none" },
    ], "bouncy", { root: col }));
  } else {
    // la salida siempre más rápida que la entrada
    card._anim = frenar(spring(card, [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(-4px) scale(0.97)" },
    ], "snappy", { root: col, duration: 160, easing: "cubic-bezier(0.4, 0, 1, 1)" }));
    card._anim.onfinish = () => { card.hidden = true; };
  }
}

function star(btn, col) {
  const on = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(on));
  if (!on) return;
  frenar(spring(btn, [{ transform: "scale(0.6)" }, { transform: "scale(1)" }], "elastic", { root: col }));
}

// FLIP: se mide, se reordena y cada fila viaja desde donde estaba
function shuffle(list, col) {
  const items = [...list.children];
  const first = new Map(items.map((li) => [li, li.getBoundingClientRect().top]));
  const order = items.slice(1).concat(items[0]);
  for (const li of order) list.appendChild(li);
  for (const li of order) {
    const dy = first.get(li) - li.getBoundingClientRect().top;
    if (!dy) continue;
    li._anim?.cancel();
    li._anim = frenar(spring(li, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], "bouncy", { root: col }));
  }
}

function toggle(sw) {
  sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
}

// ---------------------------------------------------------------- columnas
const cols = [];
const tpl = document.getElementById("lab-col-tpl");
for (const feel of Object.keys(FEELS)) {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.feel = feel;
  node.querySelector("h2").textContent = NOMBRES[feel][0];
  node.querySelector("small").textContent = NOMBRES[feel][1];
  const card = node.querySelector(".lab-card");
  const list = node.querySelector(".lab-list");
  const sw = node.querySelector(".lab-switch");
  const st = node.querySelector(".lab-star");
  const openBtn = node.querySelector(".lab-open");
  const demo = {
    feel,
    node,
    open() {
      const o = card.hidden;
      pop(card, node, o);
      openBtn.textContent = o ? "Cerrar" : "Abrir";
    },
    all() {
      toggle(sw);
      star(st, node);
      shuffle(list, node);
      this.open();
    },
  };
  openBtn.addEventListener("click", () => demo.open());
  node.querySelector(".lab-shuffle").addEventListener("click", () => shuffle(list, node));
  sw.addEventListener("click", () => toggle(sw));
  st.addEventListener("click", () => star(st, node));
  node.querySelector(".lab-pick").addEventListener("click", () => choose(feel));
  document.getElementById("lab-cols").appendChild(node);
  cols.push(demo);
}

function paintChosen() {
  const cur = feelOf(hostRoot);
  for (const c of cols) {
    c.node.dataset.chosen = c.feel === cur ? "1" : "0";
    c.node.querySelector(".lab-pick").textContent = c.feel === cur ? "En uso" : "Usar este";
  }
}

function choose(feel) {
  // el laboratorio comparte origen con Enn: misma preferencia y mismo documento
  setFeel(feel, hostRoot);
  try {
    localStorage.setItem("enn.motionFeel", feel);
  } catch {}
  paintChosen();
}

document.getElementById("lab-all").addEventListener("click", () => cols.forEach((c) => c.all()));
const slowBtn = document.getElementById("lab-slow");
slowBtn.addEventListener("click", () => {
  slow = !slow;
  slowBtn.setAttribute("aria-pressed", String(slow));
});
document.getElementById("lab-close").addEventListener("click", () => {
  if (host) host.document.dispatchEvent(new Event("enn:lab-close"));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && host) host.document.dispatchEvent(new Event("enn:lab-close"));
});
paintChosen();
