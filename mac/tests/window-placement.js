'use strict';
// node mac/tests/window-placement.js — no Electron installation or user settings required.
const assert = require('node:assert/strict');
const { restoreWindow } = require('../app/main/window-placement');
const display = (id, x, y, width, height, scaleFactor = 1) => ({ id, scaleFactor, workArea: { x, y, width, height } });
const primary = display(1, 0, 25, 1920, 1015);
const initial = { x: 220, y: 63, width: 1480, height: 940, minWidth: 980, minHeight: 640 };
let checks = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++; }

equal(restoreWindow(null, [primary], primary), initial);
const retina = display(1, 0, 25, 1920, 1015, 2);
equal(restoreWindow(null, [retina], retina), initial); // Retina must not double the DIP size.
const laptop = display(1, 0, 25, 1440, 815, 2);
equal(restoreWindow(null, [laptop], laptop), { x: 40, y: 55, width: 1360, height: 755, minWidth: 980, minHeight: 640 });
const small = display(1, 0, 25, 800, 535, 2);
equal(restoreWindow(null, [small], small), { x: 0, y: 25, width: 800, height: 535, minWidth: 800, minHeight: 535 });
equal(restoreWindow([50, 60, 1200, 800], [primary], primary), { x: 50, y: 60, width: 1200, height: 800, minWidth: 980, minHeight: 640 });
equal(restoreWindow([1800, 1000, 1480, 940], [primary], primary), { ...initial, x: 440, y: 100 });
equal(restoreWindow([0, 25, 3500, 2000], [primary], primary), { x: 0, y: 25, width: 1920, height: 1015, minWidth: 980, minHeight: 640 });
equal(restoreWindow([50, 60, 400, 250], [primary], primary), { x: 50, y: 60, width: 980, height: 640, minWidth: 980, minHeight: 640 });
equal(restoreWindow([5000, 60, 1480, 940], [primary], primary), initial);
const left = display(2, -1920, 25, 1920, 1015, 2);
equal(restoreWindow([-1800, 60, 1480, 940], [primary, left], primary), { ...initial, x: -1800, y: 60 });
equal(restoreWindow([-200, 60, 1480, 940], [left, primary], left), { ...initial, x: 0, y: 60 });
for (const bad of [[], [0, 0, 1480], [0, 0, 1480, -1], [0, NaN, 1480, 940], [0, Infinity, 1480, 940], ['0', 25, 1480, 940]])
  equal(restoreWindow(bad, [primary], primary), initial);
console.log(`macOS window placement: ${checks} checks passed.`);
