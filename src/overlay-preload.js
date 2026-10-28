// Runs in every overlay, isolated from the page. While the overlay is unlocked it draws an edit frame
// over the page: an outline, a name tab with buttons, a drag surface and resize handles.
// The page itself only gets window.obsstudio, below.
const { contextBridge, ipcRenderer } = require("electron");

// Pages made for OBS often look for window.obsstudio, for example to drop a preview background they show
// in a normal browser. This is what an OBS browser source set to "No access to OBS" gives them.
contextBridge.exposeInMainWorld("obsstudio", {
  pluginVersion: "2.24.0",
  getControlLevel: (callback) => typeof callback === "function" && callback(0),
});

let state = { editing: false, interactive: false, name: "", filled: false, fit: false, empty: true };
let host, root;

const CSS = `
:host { all: initial; }
.frame { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: none;
  font: 600 12px/1.2 "Segoe UI", system-ui, sans-serif; color: #111; }
.frame.on { display: block; }
.outline { position: absolute; inset: 0; border: 3px dashed #00e5ff; box-shadow: inset 0 0 0 1px #111;
  background: rgba(26, 15, 51, 0.18); }
.frame.interactive .outline { background: none; }
.surface { position: absolute; inset: 0; pointer-events: auto; cursor: move; }
.frame.interactive .surface, .frame.filled .surface { display: none; }
.empty { position: absolute; inset: 0; display: none; place-items: center; text-align: center; padding: 16px;
  color: #fff; font-size: 14px; text-shadow: 0 1px 2px #000; }
.frame.empty .empty { display: grid; }
/* --k undoes the overlay's zoom, so the tab and corners stay the same size; the buttons wrap when the
   overlay is narrower than the tab */
.tab { position: absolute; top: 6px; left: 50%; transform: translateX(-50%) scale(var(--k, 1)); transform-origin: top center;
  max-width: calc((100% - 16px) / var(--k, 1)); width: max-content; box-sizing: border-box;
  display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 4px; padding: 3px 4px 3px 10px;
  pointer-events: auto; cursor: move;
  background: #fff27a; border: 2px solid #111; border-radius: 8px; box-shadow: 3px 3px 0 #111; white-space: nowrap; }
.frame.filled .tab { cursor: default; }
.name { overflow: hidden; text-overflow: ellipsis; min-width: 0; padding-right: 4px; }
button { all: unset; cursor: pointer; padding: 2px 8px; border: 2px solid #111; border-radius: 6px; background: #fff;
  font: inherit; line-height: 1.2; }
button:hover { background: #00e5ff; }
button.on { background: #39ff88; }
.h { position: absolute; pointer-events: auto; }
.frame.filled .h, .frame.fit .h { display: none; }
.h.n, .h.s { left: 12px; right: 12px; height: 10px; cursor: ns-resize; }
.h.e, .h.w { top: 12px; bottom: 12px; width: 10px; cursor: ew-resize; }
.h.n { top: -2px; } .h.s { bottom: -2px; } .h.e { right: -2px; } .h.w { left: -2px; }
.h.ne, .h.nw, .h.se, .h.sw { width: 14px; height: 14px; background: #ff2bd6; border: 2px solid #111; }
.h.nw { top: 0; left: 0; cursor: nwse-resize; } .h.se { bottom: 0; right: 0; cursor: nwse-resize; }
.h.ne { top: 0; right: 0; cursor: nesw-resize; } .h.sw { bottom: 0; left: 0; cursor: nesw-resize; }
.h.nw, .h.ne, .h.se, .h.sw { transform: scale(var(--k, 1)); }
.h.nw { transform-origin: top left; } .h.ne { transform-origin: top right; }
.h.se { transform-origin: bottom right; } .h.sw { transform-origin: bottom left; }
`;

function build() {
  host = document.createElement("desktop-overlay-frame");
  root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>${CSS}</style>
    <div class="frame">
      <div class="outline"></div>
      <div class="empty">No source yet. Pick a web address, file or HTML for it in the editor.</div>
      <div class="surface" data-edge="move"></div>
      <div class="tab" data-edge="move">
        <span class="name"></span>
        <button data-action="interactive" title="Let the page use the mouse (move it by this tab)">Interact</button>
        <button data-action="edit" title="Open the source editor">Edit</button>
        <button data-action="hide" title="Hide this overlay">Hide</button>
        <button data-action="lock" title="Lock it in place">Lock</button>
      </div>
      ${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((e) => `<div class="h ${e}" data-edge="${e}"></div>`).join("")}
    </div>`;

  root.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn && e.isTrusted) ipcRenderer.send("overlay:action", btn.dataset.action);
  });

  // Drags: the main process moves the window with the mouse cursor until the button is released.
  root.addEventListener("pointerdown", (e) => {
    const el = e.target.closest("[data-edge]");
    if (!el || e.button !== 0 || !e.isTrusted || e.target.closest("button")) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    ipcRenderer.send("overlay:gesture", "start", el.dataset.edge, !e.altKey);
    const end = () => {
      el.removeEventListener("lostpointercapture", end);
      ipcRenderer.send("overlay:gesture", "end");
    };
    el.addEventListener("lostpointercapture", end);
  });

  // Arrow keys nudge an unlocked overlay (Shift: 10 at a time).
  window.addEventListener(
    "keydown",
    (e) => {
      if (!state.editing || state.interactive || !e.isTrusted) return;
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ipcRenderer.send("overlay:nudge", ...d);
    },
    true,
  );
}

function render() {
  if (!root) return;
  const frame = root.querySelector(".frame");
  frame.classList.toggle("on", state.editing);
  frame.classList.toggle("interactive", state.interactive);
  frame.classList.toggle("filled", state.filled);
  frame.classList.toggle("fit", !!state.fit);
  frame.style.setProperty("--k", String(100 / (state.zoom || 100)));
  frame.classList.toggle("empty", state.empty);
  root.querySelector(".name").textContent = state.name;
  root.querySelector('[data-action="interactive"]').classList.toggle("on", state.interactive);
  attach();
}

// Keeps the frame on the page, even if the page rewrites its document.
function attach() {
  const parent = document.documentElement;
  if (parent && host.parentNode !== parent) parent.appendChild(host);
}

// ---------- fit to content ----------
// The room the page's content takes at its natural size: what's in <body> laid out without wrapping,
// from the top left corner, margins included. Content pinned to the right or bottom of the window follows
// the window rather than the other way round, so it doesn't count. null if there's nothing to measure.
function contentSize() {
  const body = document.body;
  if (!body) return null;
  // Margins the page set (8px, say), but not automatic ones: OBS's default CSS centres the body with
  // "margin: 0 auto", and that space isn't content.
  const map = body.computedStyleMap();
  const setMargin = (side) => {
    const v = map.get(`margin-${side}`);
    return v instanceof CSSUnitValue && v.unit === "px" ? v.value : 0;
  };
  const marginLeft = setMargin("left");
  const marginRight = setMargin("right");
  // Measured at its natural width, against the left edge; put back before anything is drawn.
  const props = ["width", "margin-left", "margin-right"];
  const old = props.map((p) => [body.style.getPropertyValue(p), body.style.getPropertyPriority(p)]);
  body.style.setProperty("width", "max-content", "important");
  body.style.setProperty("margin-left", "0", "important");
  body.style.setProperty("margin-right", "0", "important");
  try {
    let right = 0;
    let bottom = 0;
    const include = (r, marginRight = 0, marginBottom = 0) => {
      if (!r.width && !r.height) return;
      right = Math.max(right, r.right + marginRight);
      bottom = Math.max(bottom, r.bottom + marginBottom);
    };
    for (const node of body.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        const range = document.createRange();
        range.selectNodeContents(node);
        include(range.getBoundingClientRect());
      } else if (node.nodeType === Node.ELEMENT_NODE && !["SCRIPT", "STYLE", "TEMPLATE"].includes(node.tagName)) {
        const cs = getComputedStyle(node);
        if (cs.display === "none") continue;
        if ((cs.position === "fixed" || cs.position === "absolute") && (cs.right !== "auto" || cs.bottom !== "auto")) continue;
        include(node.getBoundingClientRect(), parseFloat(cs.marginRight) || 0, parseFloat(cs.marginBottom) || 0);
      }
    }
    if (!right || !bottom) return null;
    const bs = getComputedStyle(body);
    const pad = (side) => (parseFloat(bs[`padding${side}`]) || 0) + (parseFloat(bs[`border${side}Width`]) || 0);
    return {
      width: Math.ceil(marginLeft + right + pad("Right") + marginRight),
      height: Math.ceil(bottom + pad("Bottom") + (parseFloat(bs.marginBottom) || 0)),
    };
  } finally {
    props.forEach((p, i) => {
      if (old[i][0]) body.style.setProperty(p, old[i][0], old[i][1]);
      else body.style.removeProperty(p);
    });
  }
}

// While fitting, the content is measured again whenever it changes size (at most once a frame).
let fitResize = null;
let fitChildren = null;
let fitQueued = false;

function sendSize() {
  fitQueued = false;
  const size = state.fit && contentSize();
  if (size) ipcRenderer.send("overlay:content-size", size.width, size.height);
}

function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(sendSize);
}

function watchFit() {
  fitResize?.disconnect();
  fitChildren?.disconnect();
  fitResize = fitChildren = null;
  if (!state.fit || !document.body) return;
  fitResize = new ResizeObserver(queueFit);
  const observeAll = () => {
    fitResize.observe(document.body);
    for (const child of document.body.children) fitResize.observe(child);
  };
  observeAll();
  fitChildren = new MutationObserver(() => {
    observeAll();
    queueFit();
  });
  fitChildren.observe(document.body, { childList: true });
  queueFit();
}

ipcRenderer.on("overlay:state", (_e, s) => {
  const wasFit = !!state.fit;
  state = s;
  render();
  // Only when fitting is switched on or off: otherwise the size it sets would set it off again.
  if (!!s.fit !== wasFit) watchFit();
});

window.addEventListener("DOMContentLoaded", () => {
  build();
  render();
  watchFit();
  // Only the document and its root element are watched, so busy pages don't wake this up.
  const watch = () => document.documentElement && observer.observe(document.documentElement, { childList: true });
  const observer = new MutationObserver(() => {
    if (!host.isConnected) attach();
    watch();
  });
  observer.observe(document, { childList: true });
  watch();
});
