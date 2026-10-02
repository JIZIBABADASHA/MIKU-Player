'use strict';
// AutoEq headphone database search (github.com/jaakkopasanen/AutoEq)
const fs = require('fs');
const path = require('path');
const { AppPaths, getText } = require('./common');

const Base = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/';
const Line = /^\s*-\s*\[(.+?)\]\((\.\/[^)]+)\)(.*)$/;
let index = null;

async function getIndex() {
  if (index) return index;
  const cache = path.join(AppPaths.Root, 'autoeq-index.md');
  let text = null;
  try { if (Date.now() - fs.statSync(cache).mtimeMs < 14 * 864e5) text = fs.readFileSync(cache, 'utf8'); } catch { }
  if (!text) { text = await getText(Base + 'INDEX.md'); fs.writeFileSync(cache, text); }
  const list = [];
  for (const raw of text.split('\n')) {
    const m = Line.exec(raw);
    if (!m) continue;
    const rest = m[3].trim();
    list.push({ name: m[1], path: decodeURIComponent(m[2].slice(2)), source: rest.toLowerCase().startsWith('by ') ? rest.slice(3) : rest });
  }
  return (index = list);
}

async function search(q) {
  const idx = await getIndex();
  if (!q || !q.trim()) return [];
  const terms = q.toLowerCase().split(' ').filter(Boolean);
  return idx.filter(e => terms.every(t => e.name.toLowerCase().includes(t))).sort((a, b) => a.name.length - b.name.length).slice(0, 40);
}

async function fetchPreset(p, name) {
  const encoded = p.split('/').map(encodeURIComponent).join('/');
  return getText(Base + encoded + '/' + encodeURIComponent(name + ' ParametricEQ.txt'));
}

module.exports = { search, fetch: fetchPreset };
