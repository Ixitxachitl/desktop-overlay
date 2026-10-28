// Frame rates of running apps, from Intel's PresentMon (bundled, MIT). It reads the frame times Windows
// records for every app that draws with DirectX, Vulkan or OpenGL. That needs admin or membership of
// "Performance Log Users"; see permission.js.
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { StringDecoder } = require("string_decoder");

const SESSION = "DesktopOverlay";
const KEEP_MS = 10000; // frame history per app, for the 1% low

// Packaged, PresentMon sits next to the app's resources; from source, in vendor/.
function exePath() {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, "presentmon", "PresentMon.exe");
  if (packaged && require("fs").existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "..", "vendor", "presentmon", "PresentMon.exe");
}

class PresentMon {
  constructor() {
    this.child = null;
    this.apps = new Map(); // pid -> [{ t, ms, chain }], oldest first
    this.now = 0; // newest frame time seen, in PresentMon's clock (ms)
    this.error = null;
    this.wanted = false;
  }

  start() {
    this.wanted = true;
    if (this.child) return;
    if (PresentMon.cleaning) {
      PresentMon.cleaning.then(() => this.wanted && this.start());
      return;
    }
    this.error = null;
    const child = (this.child = spawn(
      exePath(),
      [
        "--output_stdout", "--no_console_stats", "--v2_metrics",
        "--session_name", SESSION, "--stop_existing_session",
        "--no_track_display", "--no_track_input", "--no_track_gpu",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ));
    let decoder = null;
    let rest = "";
    let columns = null;
    child.stdout.on("data", (chunk) => {
      // Piped, PresentMon writes UTF-16 with a byte order mark.
      if (!decoder) {
        const utf16 = chunk[0] === 0xff && chunk[1] === 0xfe;
        decoder = new StringDecoder(utf16 ? "utf16le" : "utf8");
        if (utf16) chunk = chunk.subarray(2);
      }
      const lines = (rest + decoder.write(chunk)).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const cells = line.split(",");
        if (!columns) {
          columns = {
            pid: cells.indexOf("ProcessID"),
            chain: cells.indexOf("SwapChainAddress"),
            t: cells.indexOf("CPUStartTime"),
            ms: cells.indexOf("FrameTime"),
          };
          continue;
        }
        this.add(+cells[columns.pid], cells[columns.chain], +cells[columns.t], +cells[columns.ms]);
      }
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => (this.error = e.message));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code && !this.error) this.error = stderr.trim().split(/\r?\n/).pop() || `PresentMon stopped (${code}).`;
      // Try again in a bit if it's still wanted (it can stop when the system sleeps).
      if (this.wanted) setTimeout(() => this.wanted && this.start(), 5000);
    });
  }

  add(pid, chain, t, ms) {
    if (!pid || !Number.isFinite(t) || !(ms > 0)) return;
    if (t > this.now) this.now = t;
    let frames = this.apps.get(pid);
    if (!frames) this.apps.set(pid, (frames = []));
    frames.push({ t, ms, chain });
    while (frames.length && frames[0].t < t - KEEP_MS) frames.shift();
  }

  // { fps, low1, frametime } for an app, or null if it hasn't drawn anything for a while.
  summary(pid) {
    for (const [p, frames] of this.apps) if (!frames.length || frames[frames.length - 1].t < this.now - KEEP_MS) this.apps.delete(p);
    const all = this.apps.get(pid);
    if (!all || !all.length || all[all.length - 1].t < this.now - 1500) return null;
    // An app can draw to more than one swap chain; the busiest one is the game.
    const counts = {};
    for (const f of all) counts[f.chain] = (counts[f.chain] || 0) + 1;
    const chain = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
    const frames = all.filter((f) => f.chain === chain);
    const last = frames[frames.length - 1].t;
    const recent = frames.filter((f) => f.t > last - 1000);
    const mean = recent.reduce((s, f) => s + f.ms, 0) / recent.length;
    // 1% low: the frame rate of the slowest 1% of frames over the last 10 seconds.
    const sorted = frames.map((f) => f.ms).sort((a, b) => b - a);
    const slow = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 100)));
    const slowMean = slow.reduce((s, ms) => s + ms, 0) / slow.length;
    return { fps: 1000 / mean, low1: 1000 / slowMean, frametime: mean };
  }

  stop() {
    this.wanted = false;
    if (!this.child) return;
    this.child.kill();
    this.child = null;
    this.apps.clear();
    // Killing PresentMon leaves its Windows trace session running; this ends it.
    spawnSync(exePath(), ["--terminate_existing_session", "--session_name", SESSION], { windowsHide: true, timeout: 3000 });
  }

  // Ends a trace session left running by a crash (it would otherwise last until Windows restarts).
  // start() waits for this, so it can't end the new session instead.
  static cleanUp() {
    PresentMon.cleaning = new Promise((resolve) => {
      const child = spawn(exePath(), ["--terminate_existing_session", "--session_name", SESSION], { windowsHide: true, stdio: "ignore" });
      child.on("exit", resolve);
      child.on("error", resolve);
    }).then(() => (PresentMon.cleaning = null));
  }
}
PresentMon.cleaning = null;

module.exports = { PresentMon };
