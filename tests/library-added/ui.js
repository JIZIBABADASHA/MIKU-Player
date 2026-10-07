'use strict';
// node tests/library-added/ui.js — executes the production stores and track views with a small DOM stub.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
let checks = 0;
function equal(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
const payload = {
  albums: [
    ['collection', 'Collection', 'Test', 0, '', 900, 0, 0, '', ''],
    ['middle', 'Middle', 'Test', 0, '', 500, 0, 0, '', ''],
    ['best', 'Versions', 'Test', 0, '', 100, 0, 0, 'versions', ''],
    ['new-version', 'Versions', 'Test', 0, '', 800, 0, 0, 'versions', ''],
  ],
  tracks: [
    ['old', 'Old song', 'Test', 'collection', 1, 1, 1, 'WAV', 48000, 16, 0, '', 10],
    ['new', 'New song', 'Test', 'collection', 1, 2, 1, 'WAV', 48000, 16, 0, '', 900],
    ['middle-song', 'Middle song', 'Test', 'middle', 1, 1, 1, 'WAV', 48000, 16, 0, '', 500],
    ['best-song', 'Version song', 'Test', 'best', 1, 1, 1, 'FLAC', 96000, 24, 0, '', 100],
    ['new-version-song', 'Version song', 'Test', 'new-version', 1, 1, 1, 'MP3', 44100, 0, 0, '', 800],
  ],
};
function objectSource(code, name) {
  const start = code.indexOf(`const ${name} = {`), end = code.indexOf('\n};', start);
  assert.ok(start >= 0 && end >= 0, `${name} object must be found`);
  return code.slice(start, end + 4);
}
function node() { return { append() {}, textContent: '' }; }
(async () => {
  for (const folder of ['windows/wwwroot', 'mac/app/wwwroot']) {
    const core = fs.readFileSync(path.join(root, folder, 'core.js'), 'utf8');
    const views = fs.readFileSync(path.join(root, folder, 'views.js'), 'utf8');
    const helpers = core.slice(core.indexOf('const splitNames ='), core.indexOf('const Lib ='));
    const context = vm.createContext({
      Host: { real: false }, Mock: { library: () => structuredClone(payload) },
      norm: value => String(value || '').toLowerCase(), fmtQuality: () => '', qualityClass: () => '',
      qualityRank: album => album.tracks[0]?.bits || 0, $: node,
      T: (value, ...args) => Array.isArray(value) ? value.join('') + args.join('') : value,
      uiPref: (key, fallback) => key === 'trackSort' ? 'added' : fallback, setUiPref() {},
      h: node, thead: node, pageHead: node, seg: node, icon: () => '', App: {},
      sortDir: () => ({ rev: () => false, el: node() }),
      vlist: (_host, list) => { context.rendered = Array.from(list, t => t.id); return () => {}; },
    });
    vm.runInContext(helpers + objectSource(core, 'Lib') + '\nglobalThis.store = Lib;', context);
    await context.store.load();
    equal(context.store.trackById.get('old').added, 10, `${folder}: per-track timestamp is parsed`);
    equal(context.store.albumById.get('best').added, 800, `${folder}: importing a lower-quality version brings the visible album forward`);
    const start = views.indexOf('  tracks(view) {'), end = views.indexOf('  favorites(view) {', start);
    vm.runInContext('const Views = {' + views.slice(start, end) + '}; globalThis.views = Views;', context);
    context.views.tracks(node());
    equal(context.rendered, ['new', 'middle-song', 'best-song', 'old'], `${folder}: new songs sort ahead without promoting old album tracks`);
    context.Mock.library = () => ({ albums: payload.albums, tracks: payload.tracks.map(t => t.slice(0, 12)) });
    await context.store.load();
    equal(context.store.trackById.get('old').added, 900, `${folder}: old export payloads still work`);

    const remote = fs.readFileSync(path.join(root, folder, 'remote/app.js'), 'utf8');
    const remoteContext = vm.createContext({ norm: value => String(value || '').toLowerCase(), collator: new Intl.Collator() });
    vm.runInContext(objectSource(remote, 'Lib') + '\nglobalThis.store = Lib;', remoteContext);
    remoteContext.store.parse(structuredClone(payload));
    equal(Array.from(remoteContext.store.tracksBy('added'), t => t.id), ['new', 'new-version-song', 'middle-song', 'best-song', 'old'], `${folder}: phone sorts by each song's import time`);
    equal(remoteContext.store.albumsBy('added')[0].id, 'collection', `${folder}: phone album order uses import times`);
  }
  console.log(`Library import date UI: ${checks} checks passed.`);
})().catch(e => { console.error(e); process.exitCode = 1; });
