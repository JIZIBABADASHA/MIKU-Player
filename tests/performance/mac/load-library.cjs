'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const main = path.resolve(__dirname, '../../../mac/app/main');
function load(file, overrides) {
  const module = { exports: {} }, localRequire = createRequire(file);
  const requireWithStubs = name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name);
  new Function('require', 'module', 'exports', '__filename', '__dirname', fs.readFileSync(file, 'utf8'))(
    requireWithStubs, module, module.exports, file, path.dirname(file));
  return module.exports;
}

function loadLibrary(file = path.join(main, 'library.js')) {
  // Exercise real grouping, hashing, normalization and serialization without Electron or ffmpeg.
  const common = load(path.join(main, 'common.js'), { electron: { app: { getPath: () => __dirname } } });
  return load(path.resolve(file), { './common': common, './ffmpeg': {}, './tagreader': {} }).MusicLibrary;
}

function track(name, overrides = {}) {
  return {
    id: name, path: path.join('music', 'collection', name + '.flac'),
    title: name, artist: 'Artist', albumArtist: '', album: 'Album', genre: '',
    year: 0, trackNo: 0, discNo: 1, added: 1, duration: 180, codec: 'FLAC', sampleRate: 44100, bits: 16,
    ...overrides,
  };
}
module.exports = { loadLibrary, track };
