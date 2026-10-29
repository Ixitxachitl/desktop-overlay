// Which display is which, across restarts and monitors being unplugged, switched off or rearranged.
// Electron's display ids can change when Windows renumbers its monitors, so each is also known by its name
// (its label, e.g. "DELL U2719D").
const { screen } = require("electron");

// The display a saved id and name mean now, or null if it isn't connected.
function findDisplay(id, label) {
  const all = screen.getAllDisplays();
  const byId = all.find((d) => d.id === id);
  if (byId && (!label || !byId.label || byId.label === label)) return byId;
  // renumbered: the one monitor with that name, if there's only one
  const named = label ? all.filter((d) => d.label === label) : [];
  if (named.length === 1) return named[0];
  return byId || null;
}

function labelOf(id) {
  return screen.getAllDisplays().find((d) => d.id === id)?.label || "";
}

// An overlay's home: the display it's on and where on it, measured from the display's nearest corner, so one in
// a corner stays in that corner when the resolution or scaling changes.
function homeOf(b) {
  const d = screen.getDisplayMatching(b);
  const a = d.bounds;
  const right = b.x + b.width / 2 > a.x + a.width / 2;
  const bottom = b.y + b.height / 2 > a.y + a.height / 2;
  return {
    homeDisplay: d.id,
    homeLabel: d.label || "",
    homeAnchor: (bottom ? "b" : "t") + (right ? "r" : "l"),
    homeX: right ? a.x + a.width - (b.x + b.width) : b.x - a.x,
    homeY: bottom ? a.y + a.height - (b.y + b.height) : b.y - a.y,
  };
}

// Where a source's home puts it now, or null if it has none or its display isn't connected. At least KEEP DIPs of
// it stay on the display, in case the display got smaller.
const KEEP = 40;
function homePosition(s) {
  if (s.homeDisplay === null) return null;
  const d = findDisplay(s.homeDisplay, s.homeLabel);
  if (!d) return null;
  const a = d.bounds;
  const x = s.homeAnchor[1] === "r" ? a.x + a.width - s.homeX - s.width : a.x + s.homeX;
  const y = s.homeAnchor[0] === "b" ? a.y + a.height - s.homeY - s.height : a.y + s.homeY;
  const keepX = Math.min(KEEP, s.width);
  const keepY = Math.min(KEEP, s.height);
  return {
    x: Math.round(Math.min(Math.max(x, a.x - s.width + keepX), a.x + a.width - keepX)),
    y: Math.round(Math.min(Math.max(y, a.y - s.height + keepY), a.y + a.height - keepY)),
  };
}

module.exports = { findDisplay, labelOf, homeOf, homePosition };
