'use strict';

// Electron bounds and display work areas are already DIP points, including on Retina displays.
// Multiplying them by scaleFactor would scale the window a second time.
function restoreWindow(saved, displays, primary) {
  let r = Array.isArray(saved) && saved.length === 4 && saved.every(Number.isSafeInteger)
    && saved[2] > 0 && saved[3] > 0 && Number.isSafeInteger(saved[0] + saved[2]) && Number.isSafeInteger(saved[1] + saved[3])
    ? { x: saved[0], y: saved[1], width: saved[2], height: saved[3] } : null;
  let display = primary, largest = 0;
  if (r) {
    for (const d of displays) {
      const a = d.workArea;
      const area = Math.max(0, Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x))
        * Math.max(0, Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y));
      if (area > largest) { display = d; largest = area; }
    }
    if (!largest) r = null;
  }
  const a = display.workArea;
  const minWidth = Math.min(980, a.width), minHeight = Math.min(640, a.height);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const width = r ? clamp(r.width, minWidth, a.width) : clamp(1480, minWidth, Math.max(minWidth, a.width - 80));
  const height = r ? clamp(r.height, minHeight, a.height) : clamp(940, minHeight, Math.max(minHeight, a.height - 60));
  const x = r ? clamp(r.x, a.x, a.x + a.width - width) : a.x + Math.round((a.width - width) / 2);
  const y = r ? clamp(r.y, a.y, a.y + a.height - height) : a.y + Math.round((a.height - height) / 2);
  return { x, y, width, height, minWidth, minHeight };
}

module.exports = { restoreWindow };
