'use strict';
// node mac/tests/library-added.js — real filesystem, isolated profile, mocked ffprobe/Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miku-library-added-'));
let now = Date.UTC(2026, 9, 7, 12), checks = 0;
const Clock = class extends Date { static now() { return now; } };
function check(ok, message) { assert.ok(ok, message); checks++; }
function loadModule(file, overrides) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: id => Object.hasOwn(overrides, id) ? overrides[id] : require(id),
    module, exports: module.exports, __dirname: path.dirname(file), Buffer, Date: Clock, setTimeout, setImmediate,
  }, { filename: file });
  return module.exports;
}
const main = path.resolve(__dirname, '../app/main');
const common = loadModule(path.join(main, 'common.js'), { electron: { app: { getPath: () => root } } });
const { AppPaths, hash, msToTicks } = common;
const { MusicLibrary } = loadModule(path.join(main, 'library.js'), {
  './common': common,
  './ffmpeg': { probe: async file => ({
    streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 }],
    format: { duration: '1', tags: { title: path.basename(file), album: 'Collection', artist: 'Test' } },
  }) },
});
const music = path.join(root, 'music'), offline = path.join(root, 'offline');
fs.mkdirSync(music);
const id = file => hash(file.toLowerCase());
const find = (lib, file) => lib.getTrack(id(file));
function file(name, year) {
  const f = path.join(music, name), modified = new Date(Date.UTC(year, 0, 1));
  fs.writeFileSync(f, 'audio fixture'); fs.utimesSync(f, modified, modified);
  return f;
}
(async () => {
  const oldPath = file('01 old.wav', 2024), oldMtime = msToTicks(fs.statSync(oldPath).mtimeMs);
  const offlinePath = path.join(offline, 'future.wav');
  fs.writeFileSync(AppPaths.Library, JSON.stringify({ tracks: [
    { path: oldPath, id: id(oldPath), title: 'Old', album: 'Collection', artist: 'Test', discNo: 1, trackNo: 1, size: fs.statSync(oldPath).size, mtime: oldMtime },
    { path: offlinePath, id: id(offlinePath), album: 'Offline', mtime: msToTicks(Date.UTC(2099, 0, 1)) },
  ], folderArt: {} }));
  const settings = { folders: [music, offline] }, lib = new MusicLibrary(settings);
  lib.load(); await lib.saveQueue;
  const originalAdded = find(lib, oldPath).added, offlineAdded = find(lib, offlinePath).added;
  check(originalAdded === oldMtime, 'legacy historical ordering is migrated');
  check(offlineAdded === msToTicks(now), 'future modification dates are clamped');
  check(JSON.parse(fs.readFileSync(AppPaths.Library)).tracks.every(t => t.added > 0), 'migration is saved without a scan');

  now += 200; // Within the same second: the export must not truncate import times.
  const freshPath = file('02 fresh.wav', 2000);
  await lib.scan(false, lib.scanToken);
  const freshAdded = find(lib, freshPath).added;
  check(freshAdded === msToTicks(now) && freshAdded > originalAdded, 'newly imported old files use actual import time');
  check(find(lib, oldPath).added === originalAdded, 'unchanged files keep their import time');
  check(lib.albumList().sort((a, b) => b.added - a.added)[0].id === find(lib, freshPath).albumId, 'new song brings its existing album forward');
  let data = JSON.parse(lib.exportJson());
  check(data.tracks.find(r => r[0] === id(freshPath))[12] > data.tracks.find(r => r[0] === id(oldPath))[12], 'track export has individual import times');
  check(data.albums.find(r => r[0] === find(lib, freshPath).albumId)[5] > data.albums.find(r => r[0] === find(lib, offlinePath).albumId)[5], 'subsecond import order survives export');

  now += 200;
  fs.utimesSync(oldPath, new Date(now), new Date(Date.UTC(2098, 0, 1)));
  await lib.scan(false, lib.scanToken);
  check(find(lib, oldPath).added === originalAdded, 'modified files keep their import time');
  await lib.scan(true, lib.scanToken);
  check(find(lib, oldPath).added === originalAdded && find(lib, freshPath).added === freshAdded, 'full scans keep import times');
  await lib.rereadAlbum(find(lib, oldPath).albumId);
  check(find(lib, oldPath).added === originalAdded && find(lib, freshPath).added === freshAdded, 'tag rereads keep import times');

  const renamed = path.join(music, '03 renamed.wav'), albumId = find(lib, oldPath).albumId;
  fs.renameSync(oldPath, renamed);
  await lib.rereadAlbum(albumId, { [oldPath]: renamed });
  check(find(lib, renamed).added === originalAdded, 'renaming keeps the original import time');
  now += 200;
  const lastPath = file('04 new during reread.wav', 1990);
  await lib.rereadAlbum(find(lib, renamed).albumId);
  check(find(lib, lastPath).added > freshAdded, 'a new song discovered during reread is newest');

  const restarted = new MusicLibrary(settings); restarted.load();
  check(find(restarted, renamed).added === originalAdded && find(restarted, freshPath).added === freshAdded, 'restart keeps import times');
  check(find(restarted, offlinePath).added === offlineAdded, 'offline tracks keep import times');
  console.log(`macOS library import dates: ${checks} checks passed.`);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
