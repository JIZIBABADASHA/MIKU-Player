'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { loadLibrary, track } = require('./load-library.cjs');
const MusicLibrary = loadLibrary();
function build(tracks, art = {}) { const lib = new MusicLibrary({}); lib.build(tracks, art); return lib; }

test('track ordering keeps disc, track number and locale-aware filename precedence', () => {
  const tracks = ['Zebra', 'éclair', 'Eclair', '阿', 'apple', 'Álbum'].map(n => track(n));
  tracks.push(track('first', { discNo: 0, trackNo: 9 }), track('last', { discNo: 2, trackNo: 1 }));
  const expected = tracks.slice().sort((x, y) => (x.discNo - y.discNo) || (x.trackNo - y.trackNo) ||
    path.basename(x.path).localeCompare(path.basename(y.path), undefined, { sensitivity: 'base' }));
  assert.deepEqual(build(tracks).albumList()[0].tracks.map(t => t.id), expected.map(t => t.id));
});

test('album metadata preserves majority ties, first genre, oldest year and newest addition', () => {
  const album = build([
    track('04', { albumArtist: 'Beta', year: 2024, genre: 'Rock', added: 30 }),
    track('01', { albumArtist: 'Alpha', year: 0, genre: ' ', added: 10 }),
    track('03', { albumArtist: 'Alpha', year: 1998, genre: 'Jazz', added: 20 }),
    track('02', { albumArtist: 'Beta', year: 2001, genre: 'Pop', added: 50 }),
  ]).albumList()[0];
  assert.equal(album.artist, 'Alpha');
  assert.equal(album.genre, 'Pop');
  assert.equal(album.year, 1998);
  assert.equal(album.added, 50);
});

test('artist fallback preserves case variants, compilations, loose folders and blank metadata', () => {
  assert.equal(build([track('01', { artist: 'ARTIST' }), track('02', { artist: 'Artist' })]).albumList()[0].artist, 'Artist');
  assert.equal(build([track('01', { artist: 'A' }), track('02', { artist: 'B' })]).albumList()[0].artist, 'Various Artists');
  assert.equal(build([track('01', { artist: 'A', album: '' }), track('02', { artist: 'B', album: '' }), track('03', { artist: 'B', album: '' })]).albumList()[0].artist, 'B');
  const blank = build([track('01', { artist: '', albumArtist: ' ', added: 0 })]).albumList()[0];
  assert.equal(blank.artist, '未知演出者'); assert.equal(blank.year, 0); assert.equal(blank.added, 0); assert.equal(blank.genre, '');
});

test('normalized album titles share an album and keep original presentation and artwork', () => {
  const a = track('01', { album: 'Ａlbum!' }), b = track('02', { album: 'album' });
  const dir = path.dirname(a.path), lib = build([a, b], { [dir]: 'cover.jpg' });
  assert.equal(lib.albumList().length, 1);
  assert.equal(a.albumId, b.albumId);
  assert.equal(lib.albumList()[0].title, 'Ａlbum!');
  assert.equal(lib.albumList()[0].artPath, 'cover.jpg');
  const exported = lib.exportJson();
  assert.strictEqual(lib.exportJson(), exported);
  assert.equal(JSON.parse(exported).tracks.length, 2);
});

test('sibling discs and alternate formats retain their grouping', () => {
  const tracks = [
    track('a', { path: path.join('music', 'box', 'one', 'a.flac'), discNo: 1 }),
    track('b', { path: path.join('music', 'box', 'two', 'b.flac'), discNo: 2 }),
    track('c', { path: path.join('music', 'other', 'c.flac'), discNo: 1 }),
    track('d', { path: path.join('music', 'other', 'd.flac'), discNo: 2 }),
  ];
  const lib = build(tracks), albums = lib.albumList();
  assert.equal(albums.length, 2);
  assert.equal(tracks[0].albumId, tracks[1].albumId);
  assert.ok(albums[0].versionGroup);
  assert.equal(albums[0].versionGroup, albums[1].versionGroup);
});

test('a 150,000-track loose folder builds without exceeding JavaScript argument limits', () => {
  const tracks = Array.from({ length: 150000 }, (_, i) => track(String(i), { album: '', trackNo: i, year: 2000 + i % 20, added: i }));
  const lib = build(tracks), album = lib.albumList()[0];
  assert.equal(lib.count, tracks.length);
  assert.equal(album.tracks.length, tracks.length);
  assert.equal(album.year, 2000);
  assert.equal(album.added, tracks.length - 1);
});
