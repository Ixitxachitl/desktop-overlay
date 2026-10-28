// CPU temperature. Windows has no way to read it without a driver, so this borrows it from a hardware
// monitor that's already running: MSI Afterburner or HWiNFO (both share their sensors through shared
// memory), or LibreHardwareMonitor (through its web server, when that's turned on).
const http = require("http");
const koffi = require("koffi");

const kernel32 = koffi.load("kernel32.dll");
const OpenFileMappingW = kernel32.func("void * __stdcall OpenFileMappingW(uint32 access, bool inherit, const char16_t *name)");
const MapViewOfFile = kernel32.func("void * __stdcall MapViewOfFile(void *mapping, uint32 access, uint32 offHigh, uint32 offLow, uintptr_t size)");
const UnmapViewOfFile = kernel32.func("bool __stdcall UnmapViewOfFile(void *view)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *handle)");
// Copies into a Buffer. (koffi.view would wrap the memory without copying, which Electron doesn't allow.)
const RtlMoveMemory = kernel32.func("void __stdcall RtlMoveMemory(_Out_ uint8_t *dest, void *src, uintptr_t size)");
const FILE_MAP_READ = 4;

function copy(ptr, size) {
  const buf = Buffer.alloc(size);
  RtlMoveMemory(buf, ptr, size);
  return buf;
}

// A copy of a named shared memory block, read in two steps: first the header, to learn the size.
function readShared(name, headerSize, sizeFromHeader) {
  const mapping = OpenFileMappingW(FILE_MAP_READ, false, name);
  if (!mapping) return null; // the tool isn't running (or doesn't share)
  try {
    const view = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
    if (!view) return null;
    try {
      const size = sizeFromHeader(copy(view, headerSize));
      if (!size || size > 64 * 2 ** 20) return null;
      return copy(view, size);
    } finally {
      UnmapViewOfFile(view);
    }
  } finally {
    CloseHandle(mapping);
  }
}

const text = (buf, start, len) => buf.toString("latin1", start, start + len).split("\0")[0];

// MSI Afterburner's monitoring ("MAHM"): the CPU temperature, if it's turned on in Afterburner's
// monitoring settings. Its "CPU temperature" is the package; per-core ones are named "CPU1 temperature"…
function afterburner() {
  const buf = readShared("MAHMSharedMemory", 32, (h) =>
    h.readUInt32LE(0) === 0x4d41484d ? h.readUInt32LE(8) + h.readUInt32LE(12) * h.readUInt32LE(16) : 0,
  );
  if (!buf || buf.readUInt32LE(0) !== 0x4d41484d) return null; // 'MAHM'; 0xdead when Afterburner closed
  const headerSize = buf.readUInt32LE(8);
  const count = buf.readUInt32LE(12);
  const entrySize = buf.readUInt32LE(16);
  let best = null;
  for (let i = 0; i < count; i++) {
    const at = headerSize + i * entrySize;
    const name = text(buf, at, 260);
    if (!/^CPU\d* temperature$/i.test(name)) continue;
    const value = buf.readFloatLE(at + 260 * 5);
    if (!(value > 0 && value < 150)) continue;
    if (/^CPU temperature$/i.test(name)) return value; // the package
    best = Math.max(best ?? 0, value); // otherwise the hottest core
  }
  return best;
}

// HWiNFO, when "Shared Memory Support" is on in its settings.
function hwinfo() {
  const buf = readShared("Global\\HWiNFO_SENS_SM2", 44, (h) =>
    h.readUInt32LE(0) === 0x53695748 ? h.readUInt32LE(32) + h.readUInt32LE(36) * h.readUInt32LE(40) : 0,
  );
  if (!buf || buf.readUInt32LE(0) !== 0x53695748) return null; // 'HWiS'
  const offset = buf.readUInt32LE(32);
  const size = buf.readUInt32LE(36);
  const count = buf.readUInt32LE(40);
  // Readings: type (1 = temperature), sensor index, id, original label [128], user label [128], unit [16], value…
  const LABELS = [/^CPU Package$/i, /^CPU \(Tctl\/Tdie\)$/i, /^CPU Die \(average\)$/i, /^Core Max$/i, /^CPU$/i];
  const found = [];
  for (let i = 0; i < count; i++) {
    const at = offset + i * size;
    if (buf.readUInt32LE(at) !== 1) continue;
    const label = text(buf, at + 12, 128);
    const rank = LABELS.findIndex((re) => re.test(label));
    if (rank >= 0) found.push({ rank, value: buf.readDoubleLE(at + 12 + 128 + 128 + 16) });
  }
  found.sort((a, b) => a.rank - b.rank);
  const v = found[0]?.value;
  return v > 0 && v < 150 ? v : null;
}

// LibreHardwareMonitor's "Remote Web Server" (Options menu), on its default port.
let lhmValue = null;
let lhmBusy = false;
function libreHardwareMonitor() {
  if (!lhmBusy) {
    lhmBusy = true;
    const req = http.get({ host: "127.0.0.1", port: 8085, path: "/data.json", timeout: 800 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        lhmBusy = false;
        try {
          lhmValue = findLhmCpuTemp(JSON.parse(body));
        } catch {
          lhmValue = null;
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      lhmBusy = false;
      lhmValue = null;
    });
  }
  return lhmValue; // last second's answer
}

// Its tree: computer > hardware (the CPU has an "images_icon/cpu.png" icon) > "Temperatures" > sensors.
function findLhmCpuTemp(node, inCpu = false) {
  const cpu = inCpu || /cpu\.png$/i.test(node.ImageURL || "");
  if (cpu && node.Text === "Temperatures") {
    const sensors = node.Children || [];
    const pick = sensors.find((s) => /package|tctl|tdie/i.test(s.Text)) || sensors.find((s) => /max|average/i.test(s.Text)) || sensors[0];
    const v = pick && parseFloat(pick.Value);
    return v > 0 && v < 150 ? v : null;
  }
  for (const child of node.Children || []) {
    const v = findLhmCpuTemp(child, cpu);
    if (v != null) return v;
  }
  return null;
}

// The CPU temperature in °C from the first tool that has one, or null.
function cpuTemp() {
  for (const read of [afterburner, hwinfo, libreHardwareMonitor]) {
    try {
      const v = read();
      if (v != null) return v;
    } catch {
      // a tool closing mid-read
    }
  }
  return null;
}

module.exports = { cpuTemp };
