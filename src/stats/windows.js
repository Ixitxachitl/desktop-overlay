// Windows' own readings, through its DLLs: CPU and GPU usage and video memory from the performance
// counters (the numbers Task Manager shows, for any GPU vendor), which app is in focus, and the
// permission PresentMon needs.
const koffi = require("koffi");

const pdh = koffi.load("pdh.dll");
const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const advapi32 = koffi.load("advapi32.dll");
const shell32 = koffi.load("shell32.dll");

const PdhOpenQueryW = pdh.func("long __stdcall PdhOpenQueryW(const char16_t *src, uintptr_t user, _Out_ void **query)");
const PdhAddEnglishCounterW = pdh.func(
  "long __stdcall PdhAddEnglishCounterW(void *query, const char16_t *path, uintptr_t user, _Out_ void **counter)",
);
const PdhCollectQueryData = pdh.func("long __stdcall PdhCollectQueryData(void *query)");
const PdhGetFormattedCounterArrayW = pdh.func(
  "long __stdcall PdhGetFormattedCounterArrayW(void *counter, uint32 format, _Inout_ uint32 *size, _Out_ uint32 *count, void *items)",
);
const PdhCloseQuery = pdh.func("long __stdcall PdhCloseQuery(void *query)");

const GetForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)");
const OpenProcess = kernel32.func("void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)");
const QueryFullProcessImageNameW = kernel32.func(
  "bool __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, _Out_ char16_t *name, _Inout_ uint32 *size)",
);
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *handle)");

const PDH_FMT_DOUBLE = 0x200;
const PDH_FMT_NOCAP100 = 0x8000;
const PDH_MORE_DATA = 0x800007d2 | 0;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

// PDH_FMT_COUNTERVALUE_ITEM_W with a double value: name pointer, status, (padding), value.
const Item = koffi.struct("PDH_FMT_COUNTERVALUE_ITEM_W", { name: "char16_t *", status: "uint32", value: "double" });

// Every instance of a counter with a wildcard, as { name: value }.
function readArray(counter) {
  const size = [0];
  const count = [0];
  const flags = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100;
  if (PdhGetFormattedCounterArrayW(counter, flags, size, count, null) !== PDH_MORE_DATA) return {};
  const buf = Buffer.alloc(size[0]);
  if (PdhGetFormattedCounterArrayW(counter, flags, size, count, buf) !== 0) return {};
  const out = {};
  for (const item of koffi.decode(buf, koffi.array(Item, count[0]))) {
    if (item.status === 0) out[item.name] = item.value;
  }
  return out;
}

class Counters {
  constructor() {
    const q = [null];
    if (PdhOpenQueryW(null, 0, q) !== 0) throw new Error("Can't open the performance counters.");
    this.query = q[0];
    this.counters = {};
    for (const [key, path] of Object.entries({
      cpu: "\\Processor Information(_Total)\\% Processor Utility",
      gpu: "\\GPU Engine(*)\\Utilization Percentage",
      vram: "\\GPU Adapter Memory(*)\\Dedicated Usage",
    })) {
      const c = [null];
      if (PdhAddEnglishCounterW(this.query, path, 0, c) === 0) this.counters[key] = c[0];
    }
    PdhCollectQueryData(this.query); // usage counters need two samples; this is the first
  }

  // Call about once a second; usage is measured over the time since the last call.
  read() {
    PdhCollectQueryData(this.query);
    const out = { cpu: null, gpu: null, vramUsed: null };
    if (this.counters.cpu) {
      const v = Object.values(readArray(this.counters.cpu))[0];
      if (v !== undefined) out.cpu = Math.min(100, v);
    }
    if (this.counters.gpu) {
      // Like Task Manager: a GPU is as busy as its busiest kind of engine, and the busiest GPU counts.
      const engines = {};
      for (const [name, v] of Object.entries(readArray(this.counters.gpu))) {
        const m = name.match(/luid_(0x[0-9a-f]+_0x[0-9a-f]+).*engtype_(.+)$/i);
        if (m) engines[m[1] + m[2]] = (engines[m[1] + m[2]] || 0) + v;
      }
      out.gpu = Math.min(100, Math.max(0, ...Object.values(engines)));
    }
    if (this.counters.vram) {
      const adapters = {};
      for (const [name, v] of Object.entries(readArray(this.counters.vram))) {
        const m = name.match(/luid_(0x[0-9a-f]+_0x[0-9a-f]+)/i);
        if (m) adapters[m[1]] = (adapters[m[1]] || 0) + v;
      }
      out.vramUsed = Math.max(0, ...Object.values(adapters));
    }
    return out;
  }

  close() {
    PdhCloseQuery(this.query);
  }
}

// The app whose window is in focus: { pid, name } (name without .exe), or null.
function focusedApp() {
  const hwnd = GetForegroundWindow();
  if (!hwnd) return null;
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  if (!pid[0]) return null;
  let name = "";
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid[0]);
  if (h) {
    const buf = Buffer.alloc(1040);
    const size = [520];
    if (QueryFullProcessImageNameW(h, 0, buf, size)) {
      name = buf.toString("utf16le", 0, size[0] * 2).split("\\").pop().replace(/\.exe$/i, "");
    }
    CloseHandle(h);
  }
  return { pid: pid[0], name };
}

// ---------- process tree ----------
const CreateToolhelp32Snapshot = kernel32.func("void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)");
const PROCESSENTRY32W = koffi.struct("PROCESSENTRY32W", {
  dwSize: "uint32",
  cntUsage: "uint32",
  th32ProcessID: "uint32",
  th32DefaultHeapID: "uintptr_t",
  th32ModuleID: "uint32",
  cntThreads: "uint32",
  th32ParentProcessID: "uint32",
  pcPriClassBase: "int32",
  dwFlags: "uint32",
  szExeFile: koffi.array("char16_t", 260, "Array"),
});
const Process32FirstW = kernel32.func("bool __stdcall Process32FirstW(void *snapshot, _Inout_ PROCESSENTRY32W *entry)");
const Process32NextW = kernel32.func("bool __stdcall Process32NextW(void *snapshot, _Inout_ PROCESSENTRY32W *entry)");
const TH32CS_SNAPPROCESS = 0x2;

// Every process started by pid, and by those, and so on.
function descendants(pid) {
  const snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (!snap || koffi.address(snap) === 0xffffffffffffffffn) return [];
  const children = new Map(); // parent -> [child]
  try {
    const entry = { dwSize: koffi.sizeof(PROCESSENTRY32W) };
    for (let ok = Process32FirstW(snap, entry); ok; ok = Process32NextW(snap, entry)) {
      const list = children.get(entry.th32ParentProcessID) || [];
      list.push(entry.th32ProcessID);
      children.set(entry.th32ParentProcessID, list);
    }
  } finally {
    CloseHandle(snap);
  }
  const out = [];
  const todo = [...(children.get(pid) || [])];
  while (todo.length && out.length < 256) {
    const p = todo.pop();
    if (p === pid || out.includes(p)) continue;
    out.push(p);
    todo.push(...(children.get(p) || []));
  }
  return out;
}

// ---------- permission to read frame times ----------
const ConvertStringSidToSidW = advapi32.func("bool __stdcall ConvertStringSidToSidW(const char16_t *str, _Out_ void **sid)");
const CheckTokenMembership = advapi32.func("bool __stdcall CheckTokenMembership(void *token, void *sid, _Out_ bool *member)");
const LookupAccountSidW = advapi32.func(
  "bool __stdcall LookupAccountSidW(const char16_t *system, void *sid, _Out_ char16_t *name, _Inout_ uint32 *nameSize, _Out_ char16_t *domain, _Inout_ uint32 *domainSize, _Out_ uint32 *use)",
);
const LocalFree = kernel32.func("void * __stdcall LocalFree(void *mem)");
const ShellExecuteW = shell32.func(
  "intptr_t __stdcall ShellExecuteW(void *hwnd, const char16_t *verb, const char16_t *file, const char16_t *params, const char16_t *dir, int show)",
);

const PERFORMANCE_LOG_USERS = "S-1-5-32-559";
const ADMINISTRATORS = "S-1-5-32-544";

function withSid(str, fn) {
  const sid = [null];
  if (!ConvertStringSidToSidW(str, sid)) return null;
  try {
    return fn(sid[0]);
  } finally {
    LocalFree(sid[0]);
  }
}

// Whether this process may read frame times: it's elevated, or the user is in Performance Log Users.
function canTraceFrames() {
  return [PERFORMANCE_LOG_USERS, ADMINISTRATORS].some((s) =>
    withSid(s, (sid) => {
      const member = [false];
      return CheckTokenMembership(null, sid, member) && member[0];
    }),
  );
}

// "Performance Log Users" in the language Windows is set to.
function performanceLogUsersName() {
  return (
    withSid(PERFORMANCE_LOG_USERS, (sid) => {
      const name = Buffer.alloc(512);
      const domain = Buffer.alloc(512);
      if (!LookupAccountSidW(null, sid, name, [256], domain, [256], [0])) return null;
      return name.toString("utf16le").split("\0")[0];
    }) || "Performance Log Users"
  );
}

// Runs a program as administrator, which shows Windows' "Do you want to allow…" prompt.
// Returns false if it couldn't start, including when the prompt is turned down.
function runAsAdmin(file, params) {
  return ShellExecuteW(null, "runas", file, params, null, 0) > 32;
}

module.exports = { Counters, focusedApp, descendants, canTraceFrames, performanceLogUsersName, runAsAdmin };
