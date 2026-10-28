# Desktop Overlay

Put any web page on your Windows desktop as a see-through, always-on-top overlay, like an OBS browser
source but over your desktop, games in borderless windowed mode, or anything else. It lives in the system
tray.

- **Sources:** a web address, a local `.html` file (it reloads when you save it), or HTML typed into the
  editor.
- **See-through:** real per-pixel transparency. Like OBS, the default custom CSS makes the page's
  background clear.
- **Unlocked:** a dashed outline and a yellow tab show up. Drag the tab or the overlay to move it, drag the
  edges or pink corners to resize it, and use the arrow keys to nudge it. Moving and resizing snap to the
  edges of the screen, the taskbar and other overlays nearby; hold Alt to stop that.
- **Locked:** the overlay stays put and clicks go straight through to whatever's under it. Turn on
  **Interactive** to let the page take the mouse instead.
- **Fill:** cover a whole screen, or the screen minus the taskbar. It follows resolution changes and the
  taskbar moving or hiding.
- **Fit to content:** the overlay takes the size of what's on the page and follows it when that changes.
- Opacity, zoom, mute, always on top, reload when shown, custom CSS, and DevTools for each overlay.
- Hotkeys: show/hide everything (Ctrl+Alt+O), lock/unlock everything (Ctrl+Alt+L), and an optional one per
  overlay. Change them in Settings.
- **Start with Windows** from the tray menu or Settings.
- **System stats:** a little pixel panel with CPU and GPU use, video memory, and the frame rate, frame time
  and 1% low of the app in focus. See below.

Windows 10 and 11 only. Overlays show over games in borderless or windowed fullscreen (tried with GTA V).
Nothing can draw over a game in true exclusive fullscreen, which some older games use, short of hooking into
the game itself.

## Using it

Download `DesktopOverlay-<version>-windows-x64.zip` from
[Releases](https://github.com/Ixitxachitl/desktop-overlay/releases/latest), unzip it anywhere and run
`Desktop Overlay.exe`. There's no installer.

Windows 11 puts new tray icons in the **^** overflow menu; drag it onto the taskbar to keep it in reach.
Click the tray icon for the editor, right-click it for the menu.

Overlays and settings are saved in `%APPDATA%\Desktop Overlay\overlays.json`.

## System stats

**Add > System stats** in the editor puts the stats panel on your desktop. While Desktop Overlay runs, the
same panel is at `http://127.0.0.1:7319/` (only reachable from this computer), so it also works as an OBS
browser source. Options go in the address: `?scale=1` for small text or `3` for big, `show=cpu,gpu,vram,fps,app`
to pick rows, `bg=0` for no panel.

- **CPU, GPU, video memory:** Windows' own performance counters (the numbers Task Manager shows), for any
  GPU. GPU temperature comes from `nvidia-smi` on NVIDIA cards.
- **Frame rate:** [Intel PresentMon](https://github.com/GameTechDev/PresentMon) (included) reads the frame
  times of the app in focus, for anything drawn with DirectX, Vulkan or OpenGL. Windows only allows that for
  members of its *Performance Log Users* group, so the first time, Settings shows **Turn on frame rate**:
  one Windows prompt adds you to the group (the same thing Xbox Game Bar's FPS counter asks for), and it
  works after you sign out and back in.
- **CPU temperature:** Windows can't read it without a driver, so it's borrowed from MSI Afterburner (with CPU
  temperature on in its monitoring settings), HWiNFO (with Shared Memory Support on) or LibreHardwareMonitor
  (with its Remote Web Server on), whichever is running. Without one, that number is left out.

## Build and run

Requires Node.js 22 or newer.

```sh
npm install
npm start          # run from source
npm run dist       # dist/DesktopOverlay-<version>-windows-x64.zip
```

To try things without touching your own overlays, point it at another data folder; it then runs as a
separate copy next to your usual one: `$env:DESKTOP_OVERLAY_DATA = "C:\temp\overlay-test"; npm start`.

## Release

Set `version` in `package.json`, commit, then tag and push it (`git tag v0.1.0 && git push --tags`).
`.github/workflows/release.yml` builds the zip and attaches it to a GitHub release.

## Layout

```text
src/main.js              tray, hotkeys, the editor window, start-up
src/overlay.js           one overlay window: loading, CSS, click-through, fill, drag and resize
src/overlay-preload.js   the edit frame drawn over an unlocked overlay
src/store.js             sources and settings in overlays.json
src/stats/               system stats: Windows readings, PresentMon, CPU temperature, the local server and panel
vendor/presentmon/       PresentMon.exe, shipped next to the app
src/editor/              the source editor
build/icon.*             the app icon (icon.svg is the source)
```

## License

GPL-3.0-or-later

The editor uses the [Bangers](https://github.com/googlefonts/bangers) and
[Comic Neue](https://github.com/crozynski/comicneue) fonts, and the stats panel
[Press Start 2P](https://github.com/google/fonts/tree/main/ofl/pressstart2p) (all SIL Open Font License 1.1;
see `src/editor/fonts/` and `src/stats/page/fonts/`). PresentMon is © Intel, MIT license
(`vendor/presentmon/LICENSE.txt`). Native Windows calls go through [koffi](https://koffi.dev/) (MIT).
