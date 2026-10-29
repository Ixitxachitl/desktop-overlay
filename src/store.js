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
    displayLabel: "", // that display's name, for finding it again if Windows renumbers the displays
    // Where it was last put (by dragging, resizing or typing a position), kept while its display is missing so
    // it can go back there: the display, and the distance from its homeAnchor corner (t/b + l/r) to the overlay
    homeDisplay: null,
    homeLabel: "",
    homeAnchor: "tl",
    homeX: 0,
    homeY: 0,
    visible: true,
    locked: false,
    interactive: false, // when locked: true lets the page take the mouse, false lets clicks through
    onTop: true,
    opacity: 100,
    hoverFade: false, // fade to hoverOpacity while the mouse is over it (when locked)
    hoverOpacity: 10,
    zoom: 100,
    muted: false,
    reloadOnShow: false,
    css: DEFAULT_CSS,
    hotkey: "",
  };
}

const ENUMS = { kind: ["url", "file", "html"], fill: ["none", "screen", "workarea"], homeAnchor: ["tl", "tr", "bl", "br"] };
const RANGES = {
  opacity: [5, 100], hoverOpacity: [0, 100], zoom: [25, 500], width: [16, 16384], height: [16, 16384],
  x: [-65536, 65536], y: [-65536, 65536], homeX: [-65536, 65536], homeY: [-65536, 65536],
};

// Coerces a patch from the editor into valid fields; drops anything unknown or malformed.
function cleanPatch(patch) {
  const defaults = sourceDefaults();
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "id" || !(key in defaults)) continue;
    if (key === "display" || key === "homeDisplay") {
      if (value === null || Number.isFinite(value)) out[key] = value;
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

// The saved data in a file, or null if it's missing or broken (a crash can leave a file full of zeros).
function readData(file) {
  try {
    // (a file saved by Notepad can start with a byte order mark)
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return data && Array.isArray(data.sources) ? data : null;
  } catch {
    return null;
  }
}

class Store {
  constructor(dir) {
    this.file = path.join(dir, "overlays.json");
    // The saved file; else a newer one a crash interrupted mid-save; else the one before the last save.
    const files = [this.file, this.file + ".tmp", this.file + ".bak"];
    this.isNew = !files.some((f) => fs.existsSync(f));
    const found = files.map((f) => [f, readData(f)]).find(([, d]) => d);
    const data = found ? found[1] : {};
    this.recoveredFrom = found && found[0] !== this.file ? path.basename(found[0]) : null;
    // A broken file is kept aside, never over the backup.
    if (fs.existsSync(this.file) && !readData(this.file)) {
      fs.renameSync(this.file, path.join(dir, `overlays.broken-${Date.now()}.json`));
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

  // Writes are batched. Each one is made crash-proof: the new version is written to a temporary file and
  // forced onto the disk before it replaces anything (otherwise Windows can keep it in memory, and a crash
  // leaves a file full of zeros), and the version it replaces is kept as overlays.json.bak.
  save(delay = 300) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        this.flush();
      } catch {
        this.save(1000); // something (antivirus, a backup tool) had the file open; try again shortly
      }
    }, delay);
  }

  flush() {
    clearTimeout(this.timer);
    const json = JSON.stringify({ version: 1, sources: this.sources, settings: this.settings }, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + ".bak");
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, DEFAULT_CSS };
