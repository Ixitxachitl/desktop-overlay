// Collects system stats once a second while anything is showing them: CPU, GPU, video memory, the app
// in focus and its frame rate, and the CPU temperature when a hardware monitor that has it is running.
// Everything stops a few seconds after the last viewer goes.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Counters, focusedApp, descendants, canTraceFrames, performanceLogUsersName, runAsAdmin } = require("./windows");
const { PresentMon } = require("./presentmon");
const { cpuTemp } = require("./sensors");

const SYSTEM32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const NVIDIA_SMI = path.join(SYSTEM32, "nvidia-smi.exe");
const NET = path.join(SYSTEM32, "net.exe");

class StatsHub {
  constructor() {
    this.listeners = new Set();
    this.counters = null;
    this.timer = null;
    this.stopTimer = null;
    this.presentMon = new PresentMon();
    this.nvidia = null; // latest nvidia-smi reading
    this.nvidiaChild = null;
    this.vramTotal = null;
    this.signOutPending = false; // the one-time permission was granted, but needs a new sign-in
    this.latest = null;
    this.checkGroup();
    if (canTraceFrames()) PresentMon.cleanUp();
  }

  // Calls fn with every new snapshot until the returned function is called.
  subscribe(fn) {
    this.listeners.add(fn);
    clearTimeout(this.stopTimer);
    this.start();
    if (this.latest) fn(this.latest);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size) this.stopTimer = setTimeout(() => this.stop(), 5000);
    };
  }

  start() {
    if (this.timer) return;
    try {
      this.counters = new Counters();
    } catch {
      this.counters = null;
    }
    if (canTraceFrames()) this.presentMon.start();
    this.startNvidia();
    if (this.vramTotal === null) this.readVramTotal();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.counters?.close();
    this.counters = null;
    this.presentMon.stop();
    this.nvidiaChild?.kill();
    this.nvidiaChild = null;
    this.latest = null;
  }

  tick() {
    const c = this.counters?.read() || {};
    // Desktop Overlay's own windows (the editor, an overlay being moved) don't count as the app in focus.
    let app = focusedApp();
    if (app && app.pid === process.pid) app = null;
    const nv = this.nvidia;
    const snapshot = {
      cpu: c.cpu ?? null,
      cpuTemp: cpuTemp(),
      gpu: {
        usage: c.gpu ?? null,
        temp: nv?.temp ?? null,
        power: nv?.power ?? null,
        vramUsed: c.vramUsed ?? nv?.vramUsed ?? null,
        vramTotal: nv?.vramTotal ?? this.vramTotal,
      },
      app,
      fps: this.fps(app),
    };
    this.latest = snapshot;
    for (const fn of this.listeners) fn(snapshot);
  }

  // The frame rate of the app in focus, and if there's none, why.
  fps(app) {
    const pm = this.presentMon;
    if (!pm.wanted) return { status: this.signOutPending ? "signout" : "setup" };
    if (pm.error && !pm.child) return { status: "error", message: pm.error };
    if (!app) return { status: "idle" };
    let s = pm.summary(app.pid);
    // Browsers and Electron apps draw from a GPU child process, not the one that owns the window.
    if (!s) {
      for (const pid of descendants(app.pid)) {
        const c = pm.summary(pid);
        if (c && (!s || c.fps > s.fps)) s = c;
      }
    }
    if (!s) return { status: "idle" }; // the focused app isn't drawing frames
    return { status: "ok", fps: s.fps, low1: s.low1, frametime: s.frametime };
  }

  // NVIDIA's driver comes with nvidia-smi, which adds temperature and power. Other GPUs go without.
  startNvidia() {
    if (this.nvidiaChild || !fs.existsSync(NVIDIA_SMI)) return;
    const child = (this.nvidiaChild = spawn(
      NVIDIA_SMI,
      ["--query-gpu=temperature.gpu,power.draw,memory.used,memory.total", "--format=csv,noheader,nounits", "-lms", "1000"],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    ));
    let rest = "";
    child.stdout.on("data", (d) => {
      const lines = (rest + d).split(/\r?\n/);
      rest = lines.pop();
      const line = lines.filter(Boolean).pop(); // the first GPU is listed first; one line per GPU per tick
      if (!line) return;
      const [temp, power, used, total] = line.split(",").map((v) => parseFloat(v));
      this.nvidia = {
        temp: Number.isFinite(temp) ? temp : null,
        power: Number.isFinite(power) ? power : null,
        vramUsed: Number.isFinite(used) ? used * 2 ** 20 : null,
        vramTotal: Number.isFinite(total) ? total * 2 ** 20 : null,
      };
    });
    child.on("error", () => {});
    child.on("exit", () => {
      if (this.nvidiaChild === child) this.nvidiaChild = null;
    });
  }

  // Total video memory, for GPUs without nvidia-smi: the biggest adapter Windows lists.
  readVramTotal() {
    this.vramTotal = 0;
    execFile(
      "reg.exe",
      ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}", "/s", "/v", "HardwareInformation.qwMemorySize"],
      { windowsHide: true },
      (_err, out) => {
        for (const m of String(out || "").matchAll(/REG_QWORD\s+0x([0-9a-f]+)/gi)) {
          this.vramTotal = Math.max(this.vramTotal, parseInt(m[1], 16));
        }
      },
    );
  }

  // ---------- the one-time permission frame rates need ----------
  // "ok": frame rates work. "signout": granted, works after signing out and in. "setup": not granted.
  fpsAccess() {
    if (canTraceFrames()) return "ok";
    return this.signOutPending ? "signout" : "setup";
  }

  // Whether the user is listed in Performance Log Users, even if this sign-in doesn't have it yet.
  async checkGroup() {
    if (canTraceFrames()) return;
    const out = await new Promise((resolve) =>
      execFile(NET, ["localgroup", performanceLogUsersName()], { windowsHide: true }, (_e, stdout) => resolve(String(stdout || ""))),
    );
    const me = (process.env.USERNAME || "").toLowerCase();
    this.signOutPending = out
      .split(/\r?\n/)
      .some((line) => me && [me, `${(process.env.USERDOMAIN || "").toLowerCase()}\\${me}`].includes(line.trim().toLowerCase()));
  }

  // Asks Windows (one "Do you want to allow…" prompt) to add the user to Performance Log Users, the way
  // Game Bar's FPS counter does. Resolves to fpsAccess() afterwards.
  async requestFpsAccess() {
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    if (!runAsAdmin(NET, `localgroup "${performanceLogUsersName()}" "${user}" /add`)) return this.fpsAccess();
    // net.exe runs on its own after the prompt; give it a moment, then look.
    for (let i = 0; i < 10 && !this.signOutPending; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      await this.checkGroup();
    }
    return this.fpsAccess();
  }
}

module.exports = { StatsHub };
