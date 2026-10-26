// One overlay: a frameless, see-through, always-on-top window showing a web page.
const { BrowserWindow, screen, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const MIN_SIZE = 40;
const SNAP = 10; // DIPs from a screen edge at which a dragged overlay snaps to it

// What gets loaded for a source; a change in this string means the page has to be reloaded.
function target(src) {
  if (src.kind === "file") return src.file ? pathToFileURL(src.file).href : "";
  if (src.kind === "html") return src.html ? "data:text/html;charset=utf-8;base64," + Buffer.from(src.html).toString("base64") : "";
  const url = src.url.trim();
  if (!url) return "";
  // "example.com/x" means https; a bare Windows path means a file
  if (/^[a-z]:[\\/]/i.test(url)) return pathToFileURL(url).href;
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : "https://" + url;
}

// The display a filled overlay covers.
function displayFor(src) {
  return screen.getAllDisplays().find((d) => d.id === src.display) || screen.getPrimaryDisplay();
}

function boundsFor(src) {
  if (src.fill === "screen") return displayFor(src).bounds;
  if (src.fill === "workarea") return displayFor(src).workArea;
  return { x: src.x, y: src.y, width: src.width, height: src.height };
}

class Overlay {
  // hooks: onBounds(id, bounds) after a drag or resize, onAction(id, action) from the frame's buttons
  constructor(src, hooks) {
    this.src = { ...src };
    this.hooks = hooks;
    this.loaded = null; // the target() string currently loaded
    this.cssKey = null;
    this.watcher = null;
    this.retry = null;
    this.gesture = null;
    this.quitting = false;
    this.create();
  }

  get id() {
    return this.src.id;
  }

  create() {
    const b = boundsFor(this.src);
    const win = (this.win = new BrowserWindow({
      ...b,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false, // resizing is done by the frame's own handles
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      type: "toolbar", // keeps it out of Alt+Tab
      title: this.src.name,
      webPreferences: {
        preload: path.join(__dirname, "overlay-preload.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
        spellcheck: false,
      },
    }));
    const wc = win.webContents;

    // A page calling window.close() only hides its overlay.
    win.on("close", (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.hooks.onAction(this.id, "hide");
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    wc.on("dom-ready", () => {
      this.cssKey = null;
      this.applyCss();
      wc.setZoomFactor(this.src.zoom / 100);
      this.sendState();
    });
    wc.on("did-finish-load", () => this.sendState());
    // Retry pages that fail to load (a server that isn't up yet, no network after waking from sleep).
    wc.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !this.loaded) return; // -3: aborted by a newer load
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.load(true), 5000);
    });
    wc.on("render-process-gone", () => {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.load(true), 2000);
    });

    this.apply(this.src, true);
  }

  // Brings the window in line with a source; `first` forces everything, even what hasn't changed.
  apply(src, first = false) {
    const prev = this.src;
    this.src = { ...src };
    const win = this.win;
    const wc = win.webContents;

    if (first || target(src) !== this.loaded) this.load();
    if (first || src.kind !== prev.kind || src.file !== prev.file || src.liveReload !== prev.liveReload) this.watch();
    if (first || src.css !== prev.css || src.opacity !== prev.opacity) this.applyCss();
    if (src.zoom !== prev.zoom) wc.setZoomFactor(src.zoom / 100);
    if (first || src.muted !== prev.muted) wc.setAudioMuted(src.muted);
    if (first || src.onTop !== prev.onTop) win.setAlwaysOnTop(src.onTop, "screen-saver");
    if (src.name !== prev.name) win.setTitle(src.name);
    this.applyBounds();

    // Locked and not interactive means the overlay is invisible to the mouse.
    const passThrough = src.locked && !src.interactive;
    win.setIgnoreMouseEvents(passThrough);
    win.setFocusable(!passThrough);

    if (src.visible && !win.isVisible()) {
      if (!first && src.reloadOnShow) this.load(true);
      win.showInactive();
      // showInactive can lose the topmost level; set it again
      if (src.onTop) win.setAlwaysOnTop(true, "screen-saver");
    } else if (!src.visible && win.isVisible()) {
      win.hide();
    }
    this.sendState();
  }

  applyBounds() {
    if (this.gesture) return;
    const want = boundsFor(this.src);
    const have = this.win.getBounds();
    if (want.x !== have.x || want.y !== have.y || want.width !== have.width || want.height !== have.height) {
      this.win.setBounds(want);
    }
  }

  load(force = false) {
    clearTimeout(this.retry);
    const url = target(this.src);
    if (!force && url === this.loaded) return;
    this.loaded = url;
    // An empty source still gets a page, so the frame has somewhere to draw in edit mode.
    this.win.loadURL(url || "data:text/html;charset=utf-8,<title></title>").catch(() => {});
  }

  reload() {
    this.load(true);
  }

  async applyCss() {
    const wc = this.win.webContents;
    const css = `${this.src.css}\n${this.src.opacity < 100 ? `html { opacity: ${this.src.opacity / 100} !important; }` : ""}`;
    const old = this.cssKey;
    this.cssKey = null;
    try {
      if (old) await wc.removeInsertedCSS(old);
      if (css.trim()) this.cssKey = await wc.insertCSS(css, { cssOrigin: "author" });
    } catch {
      // the page is mid-navigation; dom-ready will apply it
    }
  }

  // File sources reload when anything in their folder changes, so editing the page shows up at once.
  watch() {
    this.watcher?.close();
    this.watcher = null;
    if (this.src.kind !== "file" || !this.src.liveReload || !this.src.file) return;
    let timer;
    try {
      this.watcher = fs.watch(path.dirname(this.src.file), () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.reload(), 250);
      });
      this.watcher.on("error", () => {});
    } catch {
      // the folder doesn't exist (yet)
    }
  }

  // What the frame drawn by overlay-preload.js needs to know.
  sendState() {
    const s = this.src;
    if (this.win.isDestroyed()) return;
    this.win.webContents.send("overlay:state", {
      editing: !s.locked,
      interactive: s.interactive,
      name: s.name,
      filled: s.fill !== "none",
      empty: !this.loaded,
    });
  }

  // ---------- drag to move, drag the edges to resize ----------
  // The frame says when a drag starts and ends; in between, the window follows the mouse cursor.
  startGesture(edge, snap) {
    if (this.src.locked || this.src.fill !== "none") return;
    this.gesture = { edge, snap, cursor: screen.getCursorScreenPoint(), bounds: this.win.getBounds() };
    clearInterval(this.gestureTimer);
    this.gestureTimer = setInterval(() => this.stepGesture(), 8);
  }

  stepGesture() {
    const g = this.gesture;
    if (!g || this.win.isDestroyed()) return this.endGesture();
    const p = screen.getCursorScreenPoint();
    const dx = p.x - g.cursor.x;
    const dy = p.y - g.cursor.y;
    let { x, y, width, height } = g.bounds;

    if (g.edge === "move") {
      x += dx;
      y += dy;
      if (g.snap) [x, y] = this.snap(x, y, width, height, p);
    } else {
      if (g.edge.includes("e")) width = Math.max(MIN_SIZE, width + dx);
      if (g.edge.includes("s")) height = Math.max(MIN_SIZE, height + dy);
      if (g.edge.includes("w")) {
        const w = Math.max(MIN_SIZE, width - dx);
        x += width - w;
        width = w;
      }
      if (g.edge.includes("n")) {
        const h = Math.max(MIN_SIZE, height - dy);
        y += height - h;
        height = h;
      }
    }
    const next = { x, y, width, height };
    const have = this.win.getBounds();
    if (next.x !== have.x || next.y !== have.y || next.width !== have.width || next.height !== have.height) {
      this.win.setBounds(next);
    }
  }

  // Snaps the window's edges to the edges of the screen (and of the space above the taskbar) under the cursor.
  snap(x, y, w, h, cursor) {
    const d = screen.getDisplayNearestPoint(cursor);
    const near = (v, targets) => targets.find((t) => Math.abs(v - t) <= SNAP) ?? v;
    for (const r of [d.workArea, d.bounds]) {
      x = near(x, [r.x, r.x + r.width - w]);
      y = near(y, [r.y, r.y + r.height - h]);
    }
    return [x, y];
  }

  endGesture() {
    clearInterval(this.gestureTimer);
    if (!this.gesture) return;
    this.gesture = null;
    if (!this.win.isDestroyed()) this.hooks.onBounds(this.id, this.win.getBounds());
  }

  nudge(dx, dy) {
    if (this.src.locked || this.src.fill !== "none") return;
    const b = this.win.getBounds();
    this.hooks.onBounds(this.id, { ...b, x: b.x + dx, y: b.y + dy });
  }

  destroy() {
    this.quitting = true;
    clearTimeout(this.retry);
    clearInterval(this.gestureTimer);
    this.watcher?.close();
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { Overlay };
