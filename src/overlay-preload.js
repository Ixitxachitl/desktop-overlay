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

let state = { editing: false, interactive: false, name: "", filled: false, empty: true };
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
.tab { position: absolute; top: 6px; left: 50%; transform: translateX(-50%); max-width: calc(100% - 16px);
  display: flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; pointer-events: auto; cursor: move;
  background: #fff27a; border: 2px solid #111; border-radius: 8px; box-shadow: 3px 3px 0 #111; white-space: nowrap; }
.frame.filled .tab { cursor: default; }
.name { overflow: hidden; text-overflow: ellipsis; min-width: 0; padding-right: 4px; }
button { all: unset; cursor: pointer; padding: 2px 8px; border: 2px solid #111; border-radius: 6px; background: #fff;
  font: inherit; line-height: 1.2; }
button:hover { background: #00e5ff; }
button.on { background: #39ff88; }
.h { position: absolute; pointer-events: auto; }
.frame.filled .h { display: none; }
.h.n, .h.s { left: 12px; right: 12px; height: 10px; cursor: ns-resize; }
.h.e, .h.w { top: 12px; bottom: 12px; width: 10px; cursor: ew-resize; }
.h.n { top: -2px; } .h.s { bottom: -2px; } .h.e { right: -2px; } .h.w { left: -2px; }
.h.ne, .h.nw, .h.se, .h.sw { width: 14px; height: 14px; background: #ff2bd6; border: 2px solid #111; }
.h.nw { top: 0; left: 0; cursor: nwse-resize; } .h.se { bottom: 0; right: 0; cursor: nwse-resize; }
.h.ne { top: 0; right: 0; cursor: nesw-resize; } .h.sw { bottom: 0; left: 0; cursor: nesw-resize; }
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

ipcRenderer.on("overlay:state", (_e, s) => {
  state = s;
  render();
});

window.addEventListener("DOMContentLoaded", () => {
  build();
  render();
  // Only the document and its root element are watched, so busy pages don't wake this up.
  const watch = () => document.documentElement && observer.observe(document.documentElement, { childList: true });
  const observer = new MutationObserver(() => {
    if (!host.isConnected) attach();
    watch();
  });
  observer.observe(document, { childList: true });
  watch();
});
