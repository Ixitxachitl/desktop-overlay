// Sources and settings, kept as one JSON file in the app's data folder.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// OBS's default custom CSS for browser sources: a see-through page with no margins or scrollbars.
const DEFAULT_CSS = "body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }";

const DEFAULT_SETTINGS = {
  hotkeyAll: "CommandOrControl+Alt+O", // show / hide every overlay
  hotkeyLock: "CommandOrControl+Alt+L", // lock / unlock every overlay
};

// Every field a source can have, with its default. Anything else in a patch is ignored.
function sourceDefaults() {
  return {
    id: crypto.randomUUID(),
    name: "New overlay",
    kind: "url", // url | file | html
    url: "",
    file: "",
    liveReload: true, // file sources: reload when anything in the file's folder changes
    html: "",
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    fill: "none", // none | screen | workarea (the screen minus the taskbar)
    fit: false, // size the window to the page's content (when fill is none)
    display: null, // display id for fill; null is the primary display
    visible: true,
    locked: false,
    interactive: false, // when locked: true lets the page take the mouse, false lets clicks through
    onTop: true,
    opacity: 100,
    zoom: 100,
    muted: false,
    reloadOnShow: false,
    css: DEFAULT_CSS,
    hotkey: "",
  };
}

const ENUMS = { kind: ["url", "file", "html"], fill: ["none", "screen", "workarea"] };
const RANGES = { opacity: [5, 100], zoom: [25, 500], width: [40, 16384], height: [40, 16384], x: [-65536, 65536], y: [-65536, 65536] };

// Coerces a patch from the editor into valid fields; drops anything unknown or malformed.
function cleanPatch(patch) {
  const defaults = sourceDefaults();
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "id" || !(key in defaults)) continue;
    if (key === "display") {
      if (value === null || Number.isFinite(value)) out.display = value;
    } else if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) out[key] = value;
    } else if (RANGES[key]) {
      const n = Math.round(Number(value));
      if (Number.isFinite(n)) out[key] = Math.min(RANGES[key][1], Math.max(RANGES[key][0], n));
    } else if (typeof defaults[key] === "boolean") {
      out[key] = !!value;
    } else if (typeof defaults[key] === "string" && typeof value === "string") {
      out[key] = key === "name" ? value.slice(0, 120) : value;
    }
  }
  return out;
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, "overlays.json");
    this.isNew = !fs.existsSync(this.file);
    let data = {};
    try {
      // (a file saved by Notepad can start with a byte order mark)
      data = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^﻿/, ""));
    } catch {
      // first run, or a broken file: start empty (a broken file is kept as .bak)
      if (!this.isNew) fs.copyFileSync(this.file, this.file + ".bak");
    }
    this.sources = (Array.isArray(data.sources) ? data.sources : []).map((s) => ({
      ...sourceDefaults(),
      ...cleanPatch(s),
      id: typeof s.id === "string" ? s.id : crypto.randomUUID(),
    }));
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    this.timer = null;
  }

  get(id) {
    return this.sources.find((s) => s.id === id);
  }

  // Adds a source at the end of the list, or right below `afterId`.
  add(fields, afterId) {
    const source = { ...sourceDefaults(), ...cleanPatch(fields) };
    const i = this.sources.findIndex((s) => s.id === afterId);
    this.sources.splice(i < 0 ? this.sources.length : i + 1, 0, source);
    this.save();
    return source;
  }

  // Applies a patch and returns the source before and after, or null for an unknown id.
  update(id, patch) {
    const source = this.get(id);
    if (!source) return null;
    const before = { ...source };
    Object.assign(source, cleanPatch(patch));
    this.save();
    return { before, after: source };
  }

  remove(id) {
    this.sources = this.sources.filter((s) => s.id !== id);
    this.save();
  }

  // Moves a source one step up (-1) or down (+1) in the list.
  move(id, dir) {
    const i = this.sources.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.sources.length) return;
    [this.sources[i], this.sources[j]] = [this.sources[j], this.sources[i]];
    this.save();
  }

  setSettings(patch) {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof patch[key] === "string") this.settings[key] = patch[key];
    }
    this.save();
  }

  // Writes are batched, and go through a temporary file so a crash can't leave half a file.
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    const json = JSON.stringify({ version: 1, sources: this.sources, settings: this.settings }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", json);
    fs.renameSync(this.file + ".tmp", this.file);
  }
}

module.exports = { Store, DEFAULT_CSS };
