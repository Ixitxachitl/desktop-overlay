// Keeps overlays in front. Windows has a single "always on top" layer, and whichever window in it was
// activated last is in front: click the taskbar, or open Game Bar or another always-on-top app, and it
// covers the overlays. So whenever the active window changes (and every few seconds, in case), the
// overlays are put back in front of that layer, without taking focus.
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const SetWindowPos = user32.func(
  "bool __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, uint32 flags)",
);
const WinEventProc = koffi.proto(
  "void __stdcall WinEventProc(void *hook, uint32 event, void *hwnd, long idObject, long idChild, uint32 thread, uint32 time)",
);
const SetWinEventHook = user32.func(
  "void * __stdcall SetWinEventHook(uint32 min, uint32 max, void *module, WinEventProc *proc, uint32 pid, uint32 tid, uint32 flags)",
);
const UnhookWinEvent = user32.func("bool __stdcall UnhookWinEvent(void *hook)");

const HWND_TOPMOST = -1;
const SWP_NOSIZE = 0x1;
const SWP_NOMOVE = 0x2;
const SWP_NOACTIVATE = 0x10;
const SWP_NOOWNERZORDER = 0x200;
const EVENT_SYSTEM_FOREGROUND = 0x3;
const WINEVENT_OUTOFCONTEXT = 0x0;
const WINEVENT_SKIPOWNPROCESS = 0x2;
const CHECK_EVERY_MS = 5000;

// windows: returns the BrowserWindows to keep in front (visible, always-on-top overlays).
function keepOnTop(windows) {
  const raise = () => {
    for (const win of windows()) {
      if (win.isDestroyed()) continue;
      const handle = win.getNativeWindowHandle();
      const hwnd = Number(handle.length === 8 ? handle.readBigInt64LE() : handle.readInt32LE());
      SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
    }
  };

  // The newly active window can still be settling (the taskbar raises itself again), so once more shortly after.
  let again;
  const onForeground = koffi.register(() => {
    raise();
    clearTimeout(again);
    again = setTimeout(raise, 250);
  }, koffi.pointer(WinEventProc));
  const hook = SetWinEventHook(
    EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, null, onForeground, 0, 0,
    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
  );
  const timer = setInterval(raise, CHECK_EVERY_MS);

  return {
    raise,
    stop() {
      clearInterval(timer);
      clearTimeout(again);
      if (hook) UnhookWinEvent(hook);
      koffi.unregister(onForeground);
    },
  };
}

module.exports = { keepOnTop };
