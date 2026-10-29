// Desktop Overlay: web pages as see-through, always-on-top overlays on the Windows desktop,
// like OBS browser sources. Lives in the system tray.
const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, screen, dialog, shell, nativeImage, clipboard, powerMonitor } = require("electron");
const path = require("path");
const { Store, DEFAULT_CSS } = require("./store");
const { Overlay } = require("./overlay");
const { keepOnTop } = require("./topmost");
const { labelOf, homeOf, homePosition } = require("./displays");
const { StatsHub } = require("./stats/hub");
const { startServer } = require("./stats/server");

// A separate data folder (and so a separate running copy), for trying things without touching your overlays.
if (process.env.DESKTOP_OVERLAY_DATA) app.setPath("userData", path.resolve(process.env.DESKTOP_OVERLAY_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Like OBS: media can play without a click, and overlays never slow down when something covers them.
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
app.setAppUserModelId("com.ixitxachitl.desktop-overlay");

const ICON = path.join(__dirname, "icon.ico");
const STARTUP_ARG = "--startup";

let store, tray, editor;
const overlays = new Map(); // source id -> Overlay
let hotkeyErrors = {}; // "hotkeyAll" / "hotkeyLock" / source id -> message

// System stats (CPU, GPU, frame rate), served on this computer for overlays and OBS alike.
const STATS_PORT = 7319;
const STATS_URL = `http://127.0.0.1:${STATS_PORT}/`;
let stats, statsServer;
let statsError = null;
let topmost;

// ---------- overlays ----------
const hooks = {
  onBounds: (id, b) => update(id, { x: b.x, y: b.y, width: b.width, height: b.height }),
  // the other overlays on screen, for snapping to
  others: (id) => [...overlays.values()].filter((o) => o.id !== id && !o.win.isDestroyed() && o.win.isVisible()).map((o) => o.win.getBounds()),
  onAction: (id, action) => {
    const s = store.get(id);
    if (!s) return;
    if (action === "hide") update(id, { visible: false });
    else if (action === "lock") update(id, { locked: true });
    else if (action === "interactive") update(id, { interactive: !s.interactive });
    else if (action === "edit") openEditor(id);
  },
};

const GEOMETRY = ["x", "y", "width", "height"];

// placed: false when the app moves an overlay itself (its display went away or changed), so the spot it was
// put in stays its home.
function update(id, patch, { placed = true } = {}) {
  // Filling a screen means the screen the overlay is on now, unless one was picked before.
  const s = store.get(id);
  if (s && patch.fill && patch.fill !== "none" && s.display === null && !("display" in patch)) {
    patch = { ...patch, display: screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height }).id };
  }
  if (patch.display != null) patch = { ...patch, displayLabel: labelOf(patch.display) };
  const r = store.update(id, patch);
  if (!r) return;
  if (placed && r.after.fill === "none" && GEOMETRY.some((k) => k in patch)) store.update(id, homeOf(r.after));
  // Nothing actually changed (a value already set, or clamped back to what it was): nothing to do.
  if (Object.keys(r.after).every((k) => r.after[k] === r.before[k])) return;
  overlays.get(id)?.apply(r.after);
  if (r.before.hotkey !== r.after.hotkey) registerHotkeys();
  changed();
}

function addSource(fields, afterId) {
  const s = store.add({ ...fields, ...homeOf({ x: 0, y: 0, width: 800, height: 600, ...fields }) }, afterId);
  overlays.set(s.id, new Overlay(s, hooks));
  changed();
  return s;
}

function removeSource(id) {
  overlays.get(id)?.destroy();
  overlays.delete(id);
  store.remove(id);
  registerHotkeys();
  changed();
}

// A spot for a new overlay: centred on the display the mouse is on.
function centredOn(display, width, height) {
  const wa = display.workArea;
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height };
}

// Puts overlays where they belong on the displays connected now: home, if their display is connected (it may
// have moved or changed size since); else, if they'd be off screen, the middle of the primary display until it
// comes back. Neither changes their home.
function placeAll() {
  const displays = screen.getAllDisplays();
  for (const s of store.sources) {
    if (s.fill !== "none" || overlays.get(s.id)?.gesture) continue;
    const at = homePosition(s);
    if (at) {
      if (at.x !== s.x || at.y !== s.y) update(s.id, at, { placed: false });
      continue;
    }
    const visible = displays.some((d) => {
      const a = d.workArea;
      return s.x < a.x + a.width - 20 && s.x + s.width > a.x + 20 && s.y < a.y + a.height - 20 && s.y + s.height > a.y;
    });
    if (!visible) update(s.id, centredOn(screen.getPrimaryDisplay(), s.width, s.height), { placed: false });
    // saved before overlays had a home: where it is now is home
    if (s.homeDisplay === null) store.update(s.id, homeOf(s));
  }
}

function setAll(patch) {
  for (const s of store.sources) update(s.id, patch);
}

function toggleAll() {
  setAll({ visible: !store.sources.some((s) => s.visible) });
}

function toggleLockAll() {
  setAll({ locked: store.sources.some((s) => !s.locked) });
}

// ---------- hotkeys ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = {};
  const reg = (key, accel, fn) => {
    if (!accel) return;
    try {
      if (!globalShortcut.register(accel, fn)) hotkeyErrors[key] = "Another app is already using this hotkey.";
    } catch {
      hotkeyErrors[key] = "Not a valid hotkey.";
    }
  };
  reg("hotkeyAll", store.settings.hotkeyAll, toggleAll);
  reg("hotkeyLock", store.settings.hotkeyLock, toggleLockAll);
  for (const s of store.sources) {
    reg(s.id, s.hotkey, () => {
      const cur = store.get(s.id);
      if (cur) update(cur.id, { visible: !cur.visible });
    });
  }
}

// ---------- tray ----------
function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip("Desktop Overlay");
  tray.on("click", () => openEditor());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const anyVisible = store.sources.some((s) => s.visible);
  const anyUnlocked = store.sources.some((s) => !s.locked);
  const sources = store.sources.map((s) => ({
    label: s.name.replace(/&/g, "&&") || "(unnamed)",
    type: "checkbox",
    checked: s.visible,
    click: () => update(s.id, { visible: !s.visible }),
  }));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(sources.length ? sources : [{ label: "No overlays yet", enabled: false }]),
      { type: "separator" },
      { label: anyVisible ? "Hide all" : "Show all", accelerator: store.settings.hotkeyAll || undefined, enabled: sources.length > 0, click: toggleAll },
      { label: anyUnlocked ? "Lock all" : "Unlock all to move", accelerator: store.settings.hotkeyLock || undefined, enabled: sources.length > 0, click: toggleLockAll },
      { type: "separator" },
      { label: "Edit sources…", click: () => openEditor() },
      { label: "Start with Windows", type: "checkbox", checked: launchAtLogin(), click: (i) => setLaunchAtLogin(i.checked) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

// ---------- start with Windows ----------
function launchAtLogin() {
  return app.getLoginItemSettings({ args: [STARTUP_ARG] }).openAtLogin;
}

function setLaunchAtLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, args: [STARTUP_ARG] });
  changed();
}

// ---------- editor ----------
function openEditor(selectId) {
  if (editor && !editor.isDestroyed()) {
    if (editor.isMinimized()) editor.restore();
    editor.show();
    editor.focus();
    if (selectId) editor.webContents.send("editor:select", selectId);
    return;
  }
  editor = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 760,
    minHeight: 520,
    title: "Desktop Overlay",
    icon: ICON,
    backgroundColor: "#1a0f33",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "editor-preload.js"), sandbox: true, contextIsolation: true },
  });
  editor.removeMenu();
  editor.loadFile(path.join(__dirname, "editor", "editor.html"), selectId ? { query: { select: selectId } } : undefined);
  editor.once("ready-to-show", () => editor.show());
  editor.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // Above the overlays while it's being used, so an unlocked full-screen overlay can't bury it.
  editor.on("focus", () => editor.setAlwaysOnTop(true, "screen-saver"));
  editor.on("blur", () => editor.setAlwaysOnTop(false));
  editor.on("closed", () => (editor = null));
}

function snapshot() {
  return {
    seq: ++stateSeq, // newer snapshots have bigger numbers, so the editor can drop one that arrives late
    sources: store.sources,
    settings: { ...store.settings, launchAtLogin: launchAtLogin() },
    hotkeyErrors,
    // numbered left to right, top to bottom
    displays: [...screen.getAllDisplays()].sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y).map((d, i) => {
      const primary = d.id === screen.getPrimaryDisplay().id;
      return { id: d.id, primary, label: `Screen ${i + 1}: ${d.size.width}×${d.size.height}${primary ? " (main)" : ""}` };
    }),
    defaultCss: DEFAULT_CSS,
    stats: { url: STATS_URL, error: statsError, fps: stats.fpsAccess() },
    version: app.getVersion(),
  };
}

// Tells the tray and the editor that something changed: within 30 ms of the first change, with everything
// that changed meanwhile (a steady stream of changes can't hold it back).
let changedTimer = null;
let stateSeq = 0;
function changed() {
  if (changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    refreshTray();
    if (editor && !editor.isDestroyed()) editor.webContents.send("editor:state", snapshot());
  }, 30);
}

function fromEditor(e) {
  return editor && !editor.isDestroyed() && e.sender === editor.webContents;
}

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => (fromEditor(e) ? fn(...args) : null));
}

handle("editor:state", snapshot);
handle("editor:add", (kind) => {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const names = { url: "Web page", file: "Local file", html: "Custom HTML" };
  return addSource({ kind, name: names[kind] || "New overlay", ...centredOn(display, 800, 600) }).id;
});
handle("editor:update", (id, patch) => update(id, patch));
handle("editor:remove", (id) => removeSource(id));
handle("editor:duplicate", (id) => {
  const s = store.get(id);
  if (!s) return null;
  const { id: _, hotkey: __, ...rest } = s;
  return addSource({ ...rest, name: `${s.name} copy`, x: s.x + 30, y: s.y + 30 }, id).id;
});
handle("editor:move", (id, dir) => {
  store.move(id, dir);
  changed();
});
handle("editor:reload", (id) => overlays.get(id)?.reload());
handle("editor:devtools", (id) => overlays.get(id)?.win.webContents.openDevTools({ mode: "detach" }));
handle("editor:center", (id) => {
  const s = store.get(id);
  if (!s) return;
  const display = screen.getDisplayMatching({ x: s.x, y: s.y, width: s.width, height: s.height });
  update(id, centredOn(display, s.width, s.height));
});
handle("editor:pickFile", async () => {
  const r = await dialog.showOpenDialog(editor, {
    title: "Pick a web page",
    properties: ["openFile"],
    filters: [
      { name: "Web pages", extensions: ["html", "htm", "svg", "xhtml"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});
handle("editor:settings", (patch) => {
  if ("launchAtLogin" in patch) setLaunchAtLogin(!!patch.launchAtLogin);
  store.setSettings(patch);
  registerHotkeys();
  changed();
});
handle("editor:openData", () => shell.openPath(app.getPath("userData")));
handle("editor:openUrl", (url) => /^https:\/\//.test(url) && shell.openExternal(url));
handle("editor:copy", (text) => typeof text === "string" && clipboard.writeText(text));
handle("editor:addStats", () => {
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  return addSource({ name: "System stats", kind: "url", url: STATS_URL, fit: true, width: 460, height: 200, x: wa.x + 20, y: wa.y + 20 }).id;
});
handle("editor:allowFps", async () => {
  const r = await stats.requestFpsAccess();
  changed();
  return r;
});

// The edit frame inside each overlay.
function overlayFor(e) {
  for (const o of overlays.values()) if (!o.win.isDestroyed() && o.win.webContents === e.sender) return o;
  return null;
}
ipcMain.on("overlay:action", (e, action) => {
  const o = overlayFor(e);
  if (o && ["hide", "lock", "interactive", "edit"].includes(action)) hooks.onAction(o.id, action);
});
ipcMain.on("overlay:gesture", (e, phase, edge, snap) => {
  const o = overlayFor(e);
  if (!o) return;
  if (phase === "start" && ["move", "n", "s", "e", "w", "ne", "nw", "se", "sw"].includes(edge)) o.startGesture(edge, !!snap);
  else if (phase === "end") o.endGesture();
});
// Fit to content: the frame measured the page (in CSS pixels, so zoom scales it).
const MIN_FIT_SIZE = 16; // the smallest width or height store.js allows
ipcMain.on("overlay:content-size", (e, w, h) => {
  const o = overlayFor(e);
  const s = o && store.get(o.id);
  if (!s || !s.fit || s.fill !== "none" || o.gesture || !(w > 0 && h > 0)) return;
  // within the sizes an overlay can have, or a page smaller than that would keep asking
  const width = Math.max(MIN_FIT_SIZE, Math.round((w * s.zoom) / 100));
  const height = Math.max(MIN_FIT_SIZE, Math.round((h * s.zoom) / 100));
  if (Math.abs(width - s.width) > 1 || Math.abs(height - s.height) > 1) update(o.id, { width, height });
});
ipcMain.on("overlay:nudge", (e, dx, dy) => {
  const o = overlayFor(e);
  if (o && Number.isInteger(dx) && Number.isInteger(dy) && Math.abs(dx) <= 10 && Math.abs(dy) <= 10) o.nudge(dx, dy);
});

// ---------- the example shown on first run ----------
const EXAMPLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Clock</title>
<style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; overflow: hidden;
    font: 900 64px/1 "Segoe UI Black", "Segoe UI", sans-serif; color: #fff27a;
    -webkit-text-stroke: 3px #111; paint-order: stroke fill; text-shadow: 4px 4px 0 #ff2bd6; }
  small { display: block; font-size: 16px; -webkit-text-stroke: 0; text-shadow: 1px 1px 2px #000; color: #fff; text-align: center; margin-top: 6px; }
</style></head>
<body><div><div id="t"></div><small>Unlock me from the tray to drag me around</small></div>
<script>
  const t = document.getElementById("t");
  const tick = () => (t.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  tick();
  setInterval(tick, 1000);
</script></body></html>
`;

function addExample() {
  const wa = screen.getPrimaryDisplay().workArea;
  addSource({
    name: "Example clock",
    kind: "html",
    html: EXAMPLE_HTML,
    width: 420,
    height: 140,
    x: wa.x + wa.width - 440,
    y: wa.y + 20,
    locked: true,
  });
}

// ---------- start up ----------
app.on("second-instance", () => openEditor());
app.on("window-all-closed", () => {}); // keep running in the tray
// Overlays refuse to close (a page's window.close() only hides them), except when quitting.
app.on("before-quit", () => {
  for (const o of overlays.values()) o.quitting = true;
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  try {
    store?.flush();
  } catch {
    // the last save stands
  }
  for (const o of overlays.values()) o.destroy();
  statsServer?.close();
  stats?.stop(); // ends PresentMon and its trace session
  topmost?.stop();
});

app.whenReady().then(() => {
  stats = new StatsHub();
  statsServer = startServer(stats, STATS_PORT, (e) => {
    statsError = e.code === "EADDRINUSE" ? `Port ${STATS_PORT} is taken by another program.` : e.message;
    changed();
  });
  store = new Store(app.getPath("userData"));
  placeAll(); // before the windows open, so none shows up in the wrong place first
  for (const s of store.sources) overlays.set(s.id, new Overlay(s, hooks));
  if (store.isNew) addExample();
  registerHotkeys();
  buildTray();

  // Always-on-top overlays stay in front of the taskbar and other always-on-top windows. Not while the
  // editor is in use: then it's in front of them, on purpose.
  topmost = keepOnTop(() =>
    editor && !editor.isDestroyed() && editor.isFocused()
      ? []
      : [...overlays.values()].filter((o) => o.src.visible && o.src.onTop && !o.win.isDestroyed()).map((o) => o.win),
  );
  powerMonitor.on("resume", () => topmost.raise());
  powerMonitor.on("unlock-screen", () => topmost.raise());

  // Fade on mouse-over. A locked overlay lets clicks through, so its page never sees the mouse; this does.
  setInterval(() => {
    const p = screen.getCursorScreenPoint();
    for (const o of overlays.values()) {
      if (!o.src.hoverFade || o.win.isDestroyed()) continue;
      const b = o.win.getBounds();
      o.setHovered(o.src.visible && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height);
    }
  }, 100);

  // Overlays follow their screen when it changes: resolution, scaling, the taskbar moving or hiding, being
  // rearranged, unplugged or plugged back in.
  const follow = () => {
    for (const o of overlays.values()) o.applyBounds();
    placeAll();
    topmost.raise();
    changed();
  };
  screen.on("display-metrics-changed", follow);
  screen.on("display-added", follow);
  screen.on("display-removed", follow);

  if (!process.argv.includes(STARTUP_ARG)) openEditor();
});
