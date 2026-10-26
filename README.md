# Desktop Overlay

Put any web page on your Windows desktop as a see-through, always-on-top overlay, like an OBS browser
source but over your desktop, games in borderless windowed mode, or anything else. It lives in the system
tray.

- **Sources:** a web address, a local `.html` file (it reloads when you save it), or HTML typed into the
  editor.
- **See-through:** real per-pixel transparency. Like OBS, the default custom CSS makes the page's
  background clear.
- **Unlocked:** a dashed outline and a yellow tab show up. Drag the tab or the overlay to move it (it snaps
  to the screen edges; hold Alt to stop that), drag the edges or pink corners to resize it, and use the
  arrow keys to nudge it.
- **Locked:** the overlay stays put and clicks go straight through to whatever's under it. Turn on
  **Interactive** to let the page take the mouse instead.
- **Fill:** cover a whole screen, or the screen minus the taskbar. It follows resolution changes and the
  taskbar moving or hiding.
- Opacity, zoom, mute, always on top, reload when shown, custom CSS, and DevTools for each overlay.
- Hotkeys: show/hide everything (Ctrl+Alt+O), lock/unlock everything (Ctrl+Alt+L), and an optional one per
  overlay. Change them in Settings.
- **Start with Windows** from the tray menu or Settings.

Windows 10 and 11 only. Overlays can't appear over games in exclusive fullscreen; use borderless windowed.

## Using it

Download `DesktopOverlay-<version>-windows-x64.zip` from
[Releases](https://github.com/Ixitxachitl/desktop-overlay/releases/latest), unzip it anywhere and run
`Desktop Overlay.exe`. There's no installer.

Windows 11 puts new tray icons in the **^** overflow menu; drag it onto the taskbar to keep it in reach.
Click the tray icon for the editor, right-click it for the menu.

Overlays and settings are saved in `%APPDATA%\Desktop Overlay\overlays.json`.

## Build and run

Requires Node.js 22 or newer.

```sh
npm install
npm start          # run from source
npm run dist       # dist/DesktopOverlay-<version>-windows-x64.zip
```

## Release

Set `version` in `package.json`, commit, then tag and push it (`git tag v0.1.0 && git push --tags`).
`.github/workflows/release.yml` builds the zip and attaches it to a GitHub release.

## Layout

```text
src/main.js              tray, hotkeys, the editor window, start-up
src/overlay.js           one overlay window: loading, CSS, click-through, fill, drag and resize
src/overlay-preload.js   the edit frame drawn over an unlocked overlay
src/store.js             sources and settings in overlays.json
src/editor/              the source editor
build/icon.*             the app icon (icon.svg is the source)
```

## License

GPL-3.0-or-later

The editor uses the [Bangers](https://github.com/googlefonts/bangers) and
[Comic Neue](https://github.com/crozynski/comicneue) fonts (SIL Open Font License 1.1; see
`src/editor/fonts/`).
