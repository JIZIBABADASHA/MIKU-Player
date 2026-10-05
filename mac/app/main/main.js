'use strict';
// MIKU for macOS — host process. Same UI and RPC protocol as the Windows build (MainForm.cs).
const { app, BrowserWindow, WebContentsView, protocol, net, ipcMain, dialog, shell, Menu, nativeTheme, session, screen, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');

app.setName('MIKU');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'ElasticOverscroll');

protocol.registerSchemesAsPrivileged([
  { scheme: 'miku', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'miku-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

if (!app.requestSingleInstanceLock()) { app.quit(); return; }

const { AppPaths, Log, Json, hash, cleanTranslation, clamp } = require('./common');
const { MusicLibrary } = require('./library');
const { ArtworkService } = require('./artwork');
const { LyricsService } = require('./lyrics');
const { AudioEngine } = require('./audio');
const { Player } = require('./player');
const { RemoteServer } = require('./remote');
const AutoEq = require('./autoeq');
const ff = require('./ffmpeg');
const TagWriter = require('./tagwriter');
const Metadata = require('./metadata');
const LyricAlign = require('./lyricalign');
const Converter = require('./converter');
const { FingerprintService } = require('./fingerprint');
const { resize } = require('./artwork');
const { getBytes } = require('./common');
const { nativeImage } = require('electron');

const Bg = '#0e0f13';
const WWW = path.join(__dirname, '..', 'wwwroot');
const ENGINE = path.join(__dirname, '..', 'engine');

AppPaths.ensure();
process.on('uncaughtException', e => Log.error('Fatal', e));
process.on('unhandledRejection', e => Log.error('Task', e));

// ───────────── settings ─────────────
const defaults = () => ({
  folders: [], outputMode: 'coreaudio', deviceId: null, asioDriver: null, bufferMs: 100, upsampling: 'off', fixedRate: 192000, dop: false,
  dsdPcmRate: 176400, gapless: true, replayGain: 'off', replayGainPreamp: 0, volumeMode: 'digital', volumeDb: -20, muted: false,
  dsp: { enabled: false, eqOn: true, preampDb: 0, autoPreamp: true, bands: [], presetName: '', crossfeed: { on: false, fc: 700, feed: 4.5 }, balance: 0, invert: false },
  presets: [], onlineArt: true, onlineLyrics: true, artistImages: true, lyricsTranslation: true,
  repeat: 'off', autoContinue: 'off', shuffle: false, queue: [], queueIndex: -1, resumePosition: 0, favorites: [], recent: [], searchHistory: [], artConfirmed: [],
  lyricOffsets: {}, ui: {}, acoustIdKey: null, remoteEnabled: true, remotePort: 8765, window: null, maximized: false,
});
const S = Object.assign(defaults(), Json.load(AppPaths.Settings, {}));
S.dsp = Object.assign(defaults().dsp, S.dsp || {});
if (!S.dsp.bands || !S.dsp.bands.length) S.dsp.bands = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f, i) => ({ on: true, type: i === 0 ? 'LSC' : i === 9 ? 'HSC' : 'PK', fc: f, gain: 0, q: 1 }));
if (S.volumeMode === 'hardware') S.volumeMode = 'digital';
S.outputMode = 'coreaudio';
const favs = () => new Set(S.favorites);
const setFav = (id, on) => { const f = favs(); if (on) f.add(id); else f.delete(id); S.favorites = [...f]; };

function saveSettings() { try { Json.saveAtomic(AppPaths.Settings, S); } catch (e) { Log.error('Save settings', e); } }
let saveTimer = null;
const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 1500); };

// ───────────── services ─────────────
const lib = new MusicLibrary(S);
const art = new ArtworkService(lib, S);
const lyrics = new LyricsService(S);
const engine = new AudioEngine(S);
const player = new Player(engine, lib, S);
const fp = new FingerprintService(S);
let lyricsJob = null, fpJob = null, tagsBusy = false;

// a file the tag editor rewrote is checked before it replaces the original: same audio stream, same length
TagWriter.setVerifier(async (orig, tmp) => {
  const [a, b] = await Promise.all([ff.probe(orig), ff.probe(tmp)]);
  const sa = (a.streams || []).find(x => x.codec_type === 'audio'), sb = (b.streams || []).find(x => x.codec_type === 'audio');
  const da = parseFloat((a.format || {}).duration) || 0, db = parseFloat((b.format || {}).duration) || 0;
  if (!sb || (sa && sa.codec_name !== sb.codec_name) || Math.abs(da - db) > 0.5) throw new Error('寫入後的檔案檢查失敗，原檔沒有被更動');
});

let win = null, ready = false, scanStarted = false, autoArtStarted = false, artJob = null, remote = null, remoteTick = 0, quitting = false;

// ───────────── YouTube Music panel ─────────────
let yt = null, ytMeta = {}, ytActive = false, ytPlaying = false;
const ChromeUA = () => app.userAgentFallback.replace(/\s*(Electron|MIKU|miku)\/\S+/g, '');
function ensureYt() {
  if (yt) return yt;
  yt = new WebContentsView({ webPreferences: { partition: 'persist:ytmusic', preload: path.join(__dirname, 'ytm-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  yt.setBackgroundColor('#030303');
  yt.setVisible(false);
  win.contentView.addChildView(yt);
  const wc = yt.webContents;
  wc.setUserAgent(ChromeUA());
  wc.setWindowOpenHandler(({ url }) => {
    const h = new URL(url).hostname;
    if (/(youtube|google|gstatic)\.com$/.test(h)) wc.loadURL(url); else openExternal(url);
    return { action: 'deny' };
  });
  wc.loadURL('https://music.youtube.com/');
  return yt;
}
ipcMain.on('ytm', (e, m) => {
  if (!yt || e.sender !== yt.webContents) return;
  if (m.k === 'play') {
    ytActive = true; ytPlaying = true;
    if (engine.isPlaying) { player.saveState(); engine.pause(); }
    applyYtVolume();
    postSoon('state');
  } else if (m.k === 'pause') { ytPlaying = false; postSoon('state'); }
  else if (m.k === 'meta') {
    const changed = m.title !== ytMeta.title || m.by !== ytMeta.by;
    ytMeta = m; ytPlaying = m.p;
    if (changed && ytActive) postSoon('state');
  }
});
const liveActive = () => ytActive && !!yt;
const ytScript = js => yt ? yt.webContents.executeJavaScript(js, true).catch(() => { }) : Promise.resolve();
const ytClick = sel => ytScript(`(document.querySelector('ytmusic-player-bar ${sel}') || { click(){} }).click()`);
function pauseYt() { if (yt && ytPlaying) ytScript("document.querySelectorAll('video,audio').forEach(v => v.pause())"); }
function applyYtVolume() {
  if (!yt) return;
  const v = S.muted ? 0 : S.volumeMode === 'digital' ? Math.pow(10, clamp(S.volumeDb, -80, 0) / 20) : 1;
  ytScript(`document.querySelectorAll('video,audio').forEach(v => v.volume = ${v.toFixed(4)})`);
}

// ───────────── engine / player events ─────────────
engine.on('changed', () => { postSoon('state'); if (engine.isPlaying && ytActive) { ytActive = false; pauseYt(); } });
engine.on('loading', () => { if (ytActive) { ytActive = false; pauseYt(); } });
engine.on('failed', msg => post('error', { message: msg }));
engine.on('media', m => {
  if (liveActive()) {
    if (m.action === 'nexttrack') ytClick('.next-button'); else if (m.action === 'previoustrack') ytClick('.previous-button'); else ytClick('.play-pause-button');
    return;
  }
  if (m.action === 'play' || m.action === 'pause') player.toggle();
  else if (m.action === 'nexttrack') player.next();
  else if (m.action === 'previoustrack') player.previous();
  else if (m.action === 'stop') engine.pause();
  else if (m.action === 'seekto') player.seek(m.pos);
});
engine.on('devicechange', () => post('devicesChanged', {}));
player.on('now', () => postSoon('state'));
player.on('queue', () => postSoon('queue'));
lib.on('progress', p => {
  post('scan', p);
  if (!p.scanning && !autoArtStarted && S.onlineArt && lib.count > 0) {
    autoArtStarted = true;
    const ac = artJob = new AbortController();
    art.fetchAllMissing(null, ac.signal, false).catch(() => { });
  }
});
lib.on('changed', () => { player.validate(); post('library', { revision: lib.revision }); });
art.on('updated', (kind, id) => post('art', { kind, id }));

// keep the Mac awake enough to keep playing (display may sleep)
let psb = null;
setInterval(() => {
  const want = engine.isPlaying;
  if (want && psb == null) psb = powerSaveBlocker.start('prevent-app-suspension');
  else if (!want && psb != null) { powerSaveBlocker.stop(psb); psb = null; }
}, 2000);

// ───────────── messaging ─────────────
const RemoteEvents = new Set(['state', 'queue', 'error', 'library', 'favs']);
let lastTick = null, lastTickAt = 0;   // the last periodic state sent to the page
function post(ev, d, tick = false) {
  let json = null;
  if (remote && RemoteEvents.has(ev) && remote.hasClients && (!tick || ++remoteTick % 3 === 0)) {
    try { remote.broadcast(json = JSON.stringify({ ev, d })); } catch (e) { Log.error('Remote broadcast', e); }
  }
  if (!ready || !win || win.isDestroyed()) return;
  if (tick) {
    // paused / stopped: the periodic state is the same every time; don't make the page parse and redraw it 5×/s
    // (a change is posted at once by postSoon, and the same state still goes out once a second)
    const s = JSON.stringify(d), now = Date.now();
    if (s === lastTick && now - lastTickAt < 1000) return;
    lastTick = s; lastTickAt = now;
  }
  win.webContents.send('host', { ev, d });
}
const pending = new Set();
function postSoon(what) {
  if (pending.has(what)) return;
  pending.add(what);
  setTimeout(() => { pending.delete(what); if (what === 'state') post('state', state()); else if (what === 'queue') post('queue', queueDto()); }, 30);
}
setInterval(() => { if (ready || (remote && remote.hasClients)) post('state', state(), true); }, 200);

ipcMain.on('host', async (e, raw) => {
  if (!win || e.sender !== win.webContents) return;
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  let r = null, err = null;
  try { r = await handleRpc(msg.m, msg.a || {}); } catch (ex) { err = ex.message; Log.error('RPC ' + msg.m, ex); }
  if (msg.id && win && !win.isDestroyed()) win.webContents.send('host', { id: msg.id, r: r === undefined ? null : r, e: err });
});

function state() {
  const m = engine.meter();
  if (liveActive()) {
    const parts = (ytMeta.by || '').split('•').map(s => s.trim()).filter(Boolean);
    return {
      trackId: 'yt-live', playing: ytPlaying, loaded: true, pos: ytMeta.t || 0, dur: ytMeta.d || 0, index: player.index,
      volumeDb: S.volumeDb, muted: S.muted, volumeMode: S.volumeMode, repeat: S.repeat, shuffle: S.shuffle,
      signal: { codec: 'YouTube', sourceRate: 48000, sourceBits: 0, dsd: false, lossy: true, resampled: false, outputRate: engine.st.rate || 48000, outputFormat: '32-bit 浮點', outputBits: 32, mode: 'Core Audio', device: engine.deviceName(), dspActive: false, volumeMode: S.volumeMode, quality: 'low', note: 'YouTube Music 由內建瀏覽器直接播放，不經過 MIKU 的 DSP。' },
      live: { title: ytMeta.title || '', artist: parts[0] || '', album: parts[1] || '', img: ytMeta.img || '' },
      meter: { l: 0, r: 0, clips: 0, underruns: 0 },
    };
  }
  const t = engine.track || player.current;
  return {
    trackId: t ? t.id : null, playing: engine.isPlaying, loaded: engine.isLoaded,
    pos: engine.isLoaded ? engine.position : (engine.track == null ? (S.resumePosition || 0) : engine.position),
    dur: t ? t.duration : 0, index: player.index, volumeDb: S.volumeDb, muted: S.muted, volumeMode: S.volumeMode,
    repeat: S.repeat, shuffle: S.shuffle, signal: engine.signal, meter: m,
  };
}
const queueDto = () => ({ ids: player.queue.slice(), index: player.index, shuffle: S.shuffle, repeat: S.repeat });
const init = () => ({ settings: S, version: app.getVersion(), ffmpeg: ff.Ffmpeg.available, asio: [], scan: lib.progress, state: state(), queue: queueDto(), platform: 'mac' });

function lyricsDto(t, r) {
  return { id: t.id, source: r.source, synced: r.synced, instrumental: !!r.instrumental, lines: r.lines.map(l => ({ ...l, trans: cleanTranslation(l.trans) })), offset: S.lyricOffsets[t.id] || 0 };
}
const dataBytes = d => { d = String(d || ''); const c = d.indexOf(','); if (c >= 0 && d.startsWith('data:')) d = d.slice(c + 1); return Buffer.from(d, 'base64'); };

// ───────────── tag editor ─────────────
function tagsDto(albumId) {
  const al = lib.getAlbum(albumId);
  if (!al) throw new Error('找不到這張專輯');
  return {
    id: al.id, folder: al.folder, loose: al.loose, artSource: art.sourceOf(al.id),
    tracks: al.tracks.map(t => ({
      id: t.id, file: path.basename(t.path), path: t.path, title: t.title, artist: t.artist, albumArtist: t.albumArtist, album: t.album,
      genre: t.genre, composer: t.composer, year: t.year, track: t.trackNo, disc: t.discNo, dur: Math.round(t.duration * 100) / 100,
      codec: t.codec, hasPic: !!t.hasPic, writable: TagWriter.canWrite(t.path),
    })),
  };
}

/** The cover to embed: JPEG / PNG up to 1600 px and 2.5 MB as they are, anything else as a JPEG of at most 1600 px. */
function prepareCover(bytes) {
  if (!bytes || bytes.length < 500) throw new Error('圖片太小或無效');
  const jpeg = bytes[0] === 0xFF && bytes[1] === 0xD8, png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const img = nativeImage.createFromBuffer(bytes);
  if (img.isEmpty()) throw new Error('無法讀取這張圖片（請用 JPEG 或 PNG）');
  const { width: w, height: h } = img.getSize();
  if (w < 50 || h < 50) throw new Error('圖片太小');
  if ((jpeg || png) && Math.max(w, h) <= 1600 && bytes.length <= 2500000) return { data: bytes, mime: jpeg ? 'image/jpeg' : 'image/png' };
  const out = resize(bytes, Math.min(1600, Math.max(w, h)));
  if (!out || out[0] !== 0xFF || out[1] !== 0xD8) throw new Error('無法轉換這張圖片');
  return { data: out, mime: 'image/jpeg' };
}

const BadName = /[\/:*?"<>|\x00-\x1F]/;
async function saveTags(a) {
  if (tagsBusy) throw new Error('正在儲存標籤，請稍候');
  if (lib.progress.scanning) throw new Error('媒體庫正在掃描，請等掃描完成後再儲存');
  const albumId = a.id;
  const album = lib.getAlbum(albumId);
  if (!album) throw new Error('找不到這張專輯');
  const edits = new Map();
  for (const e of Array.isArray(a.tracks) ? a.tracks : []) {
    if (!e || !e.id || !e.set || typeof e.set !== 'object') continue;
    const d = {};
    for (const [k, v] of Object.entries(e.set)) if (TagWriter.Fields.includes(k)) d[k] = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
    if (Object.keys(d).length) edits.set(e.id, d);
  }
  let cover = null, removeCover = false, coverIds = null;
  const cv = a.cover;
  if (cv && typeof cv === 'object') {
    if (Array.isArray(cv.ids) && cv.ids.length) coverIds = new Set(cv.ids);
    if (cv.mode === 'remove') removeCover = true;
    else if (cv.mode === 'current') {
      const bytes = await art.currentPicture(albumId);
      if (!bytes) throw new Error('這張專輯沒有封面可以寫入');
      cover = prepareCover(bytes);
    } else if (cv.mode === 'set') {
      let bytes;
      if (cv.data) bytes = dataBytes(cv.data);
      else if (cv.url && /^https?:\/\//i.test(cv.url)) { try { bytes = await getBytes(cv.url); } catch (e) { throw new Error('封面下載失敗：' + e.message); } }
      else throw new Error('封面圖片無效');
      cover = prepareCover(bytes);
    }
  }
  const coverChanged = !!cover || removeCover;
  const renames = new Map();
  for (const e of Array.isArray(a.rename) ? a.rename : []) {
    const t = e && e.id ? lib.getTrack(e.id) : null;
    let name = e && typeof e.name === 'string' ? e.name.trim() : '';
    if (!t || t.albumId !== albumId || !name) continue;
    if (BadName.test(name) || name === '.' || name === '..' || name.startsWith('.')) throw new Error('檔名含有不能用的字元：' + name);
    const ext = path.extname(t.path);
    if (!name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
    if (name !== path.basename(t.path)) renames.set(t.id, name);
  }
  const coverFor = t => coverChanged && (!coverIds || coverIds.has(t.id));
  const targets = album.tracks.filter(t => edits.has(t.id) || coverFor(t) || renames.has(t.id));
  const wholeAlbumCover = coverChanged && album.tracks.every(coverFor);
  if (!targets.length) return { albumId, tracks: album.tracks.length, written: 0, failed: [] };

  tagsBusy = true;
  try {
    const paths = new Set(targets.map(t => t.path.toLowerCase()));
    const cur = engine.track;
    const touchesCurrent = !!(cur && paths.has(cur.path.toLowerCase()) && player.current && player.current.id === cur.id);
    let wasPlaying = false, pos = 0;
    if (touchesCurrent) { wasPlaying = engine.isPlaying; pos = engine.position; engine.stop(); await new Promise(r => setTimeout(r, 250)); }
    else engine.invalidateNext();
    try {
      const failed = [];
      let done = 0, written = 0;
      for (const t of targets) {
        try {
          const withCover = coverFor(t);
          if (withCover || edits.has(t.id)) { await TagWriter.write(t.path, edits.get(t.id) || {}, withCover ? cover : null, withCover && removeCover); written++; }
        } catch (e) {
          const msg = e.code === 'EACCES' || e.code === 'EPERM' ? '沒有寫入權限' : e.code === 'EBUSY' ? '檔案正在被其他程式使用' : e.message;
          failed.push({ file: path.basename(t.path), error: msg });
          Log.error('Write tags ' + t.path, e);
        }
        done++;
        post('tagsProgress', { done, total: targets.length, file: path.basename(t.path) });
      }
      Log.info(`Tags written: ${album.title} — ${written}/${targets.length} files` + (coverChanged ? (removeCover ? ', cover removed' : ', cover embedded') : ''));
      const moved = renames.size ? renameFiles(album.tracks.filter(t => renames.has(t.id)).map(t => [t, renames.get(t.id)]), failed) : {};
      if (Object.keys(moved).length) moveTrackIds(moved);
      if (wholeAlbumCover && failed.length < targets.length) { art.dropStoredArt(albumId); S.artConfirmed = S.artConfirmed.filter(x => x !== albumId); saveSoon(); }
      const r = await lib.rereadAlbum(albumId, moved);
      if (!wholeAlbumCover) art.moveStoredArt(albumId, r.albumId);
      return { albumId: r.albumId, tracks: r.tracks, written, renamed: Object.keys(moved).length, failed };
    } finally {
      if (touchesCurrent) { try { await player.reload(pos, wasPlaying); } catch (e) { Log.error('Resume after tags', e); } }
    }
  } finally { tagsBusy = false; }
}

/** Renames files in their folders, through temporary names (so names can be swapped); lyrics files go along. */
function renameFiles(list, failed) {
  const moved = {};
  const leaving = new Set(list.map(([t]) => t.path.toLowerCase()));
  const taken = new Set(), plan = [];
  for (const [t, name] of list) {
    const to = path.join(path.dirname(t.path), name);
    const same = to.toLowerCase() === t.path.toLowerCase();
    if (taken.has(to.toLowerCase())) { failed.push({ file: path.basename(t.path), error: '和另一首的新檔名相同' }); continue; }
    taken.add(to.toLowerCase());
    if (!same && fs.existsSync(to) && !leaving.has(to.toLowerCase())) { failed.push({ file: path.basename(t.path), error: '已經有同名的檔案：' + name }); continue; }
    plan.push({ from: t.path, to, tmp: t.path + '.miku-rename-' + Math.random().toString(16).slice(2, 10) });
  }
  const parked = [];
  for (const p of plan) {
    try { fs.renameSync(p.from, p.tmp); parked.push(p); }
    catch (e) { failed.push({ file: path.basename(p.from), error: '沒有改名：' + e.message }); Log.error('Rename ' + p.from, e); }
  }
  for (const p of parked) {
    try {
      fs.renameSync(p.tmp, p.to);
      moved[p.from] = p.to;
      const base = s => s.slice(0, s.length - path.extname(s).length);
      for (const ext of ['.lrc', '.LRC', '.txt']) {
        const side = base(p.from) + ext, sideTo = base(p.to) + ext;
        try { if (fs.existsSync(side) && !fs.existsSync(sideTo)) fs.renameSync(side, sideTo); } catch (e) { Log.error('Rename lyrics ' + side, e); }
      }
    } catch (e) {
      try { fs.renameSync(p.tmp, p.from); } catch (e2) { Log.error('Rename back ' + p.tmp, e2); }
      failed.push({ file: path.basename(p.from), error: '沒有改名：' + e.message });
    }
  }
  Log.info(`Renamed ${Object.keys(moved).length}/${list.length} files`);
  return moved;
}

/** Track ids come from paths: favourites, recent plays, lyric offsets, the lyrics cache and the queue follow renamed files. */
// ───────────── 轉換格式 / CUE 分軌 (converter.js; the same as Windows' MainForm.ConvertJob) ─────────────
let convertJob = null;
const isUnder = (p, folder) => { const f = path.resolve(folder) + path.sep; return path.resolve(p).toLowerCase().startsWith(f.toLowerCase()) || path.resolve(p).toLowerCase() === path.resolve(folder).toLowerCase(); };

async function convertJobRun(a, cue) {
  if (convertJob) throw new Error('正在轉換其他檔案，請稍候');
  if (!ff.Ffmpeg.path) throw new Error('找不到 FFmpeg，無法轉換格式');
  const o = Converter.options(a.opts);
  const ext = Converter.ext(o.format);
  const replace = a.mode === 'replace';
  const dir = typeof a.dir === 'string' ? a.dir : '';
  if (!replace && (!dir || !fs.existsSync(dir))) throw new Error('請先選擇要放檔案的資料夾');
  if (replace && lib.progress.scanning) throw new Error('媒體庫正在掃描，請等掃描完成後再轉換');

  const jobs = [];
  if (!cue) {
    for (const id of L(a, 'ids')) { const t = lib.getTrack(id); if (t && t.codec !== 'YouTube') jobs.push({ id: t.id, src: t, start: 0, length: 0, meta: null, name: path.basename(t.path).replace(/\.[^.]*$/, '') }); }
  } else {
    const or = (x, y) => (x && String(x).trim()) ? x : y;
    for (const ct of cue.tracks) {
      const src = ct.source;
      const meta = {
        title: or(ct.title, 'Track ' + ct.no), artist: or(ct.performer, or(cue.performer, src.artist)), album: or(cue.title, src.album),
        album_artist: or(cue.performer, src.albumArtist), composer: or(ct.songwriter, cue.songwriter), genre: or(cue.genre, src.genre),
        date: or(cue.date, src.year > 0 ? String(src.year) : ''), track: `${ct.no}/${cue.tracks.length}`, disc: src.discNo > 0 ? String(src.discNo) : '',
      };
      jobs.push({ id: 'c' + ct.no, src, start: ct.start, length: ct.length, meta, name: `${String(ct.no).padStart(2, '0')} ${meta.title}` });
    }
  }
  if (!jobs.length) return { done: 0, failed: [], cancelled: false };

  const failed = [], reserved = new Set(), items = [], outFolders = new Set();
  const exists = p => fs.existsSync(p);
  for (const j of jobs) {
    const stem = Converter.safeName(j.name);
    if (replace) {
      const folder = path.dirname(j.src.path);
      const final = cue ? path.join(folder, stem + ext) : j.src.path.replace(/\.[^./]*$/, '') + ext;
      const same = !cue && final.toLowerCase() === j.src.path.toLowerCase();
      if (!same && (exists(final) || reserved.has(final.toLowerCase()))) {
        failed.push({ file: path.basename(final), error: '已經有同名的檔案' });
        post('convertProgress', { id: j.id, state: 'skip', error: '已經有同名的檔案' });
        continue;
      }
      reserved.add(final.toLowerCase());
      items.push({ ...j, target: same ? path.join(folder, stem + '.miku-new' + ext) : final, final });
    } else {
      let folder = dir;
      if (o.albumFolder) {
        const al = lib.getAlbum(j.src.albumId);
        const name = cue && cue.title ? cue.title : !al ? j.src.album : al.loose ? path.basename(al.folder) : al.title;
        folder = path.join(dir, Converter.safeName(name && name.trim() ? name : '未知專輯'));
        outFolders.add(folder);
        if (!cue && al && new Set(al.tracks.map(t => t.discNo)).size > 1) folder = path.join(folder, 'Disc ' + j.src.discNo);
      }
      let target = path.join(folder, stem + ext);
      for (let n = 2; exists(target) || reserved.has(target.toLowerCase()); n++) target = path.join(folder, `${stem} (${n})${ext}`);
      reserved.add(target.toLowerCase());
      items.push({ ...j, target, final: target });
    }
  }

  const ac = convertJob = new AbortController();
  try {
    const converted = [];
    let done = 0;
    const workers = Math.max(1, Math.min(4, Math.floor(require('os').cpus().length / 2)));
    const queue = items.slice();
    await Promise.all(Array.from({ length: workers }, async () => {
      for (let it; (it = queue.shift());) {
        if (ac.signal.aborted) { post('convertProgress', { id: it.id, state: 'skip', error: '已停止' }); continue; }
        post('convertProgress', { id: it.id, state: 'run', pct: 0 });
        try {
          let pic = null;
          if (o.cover) { pic = await ff.picture(it.src.path); if (!pic) pic = await art.currentPicture(it.src.albumId).catch(() => null); }
          fs.mkdirSync(path.dirname(it.target), { recursive: true });
          let last = 0;
          await Converter.convert(it.src, it.target, o, S.dsdPcmRate || 176400, pic, x => {
            const pct = Math.floor(x * 100);
            if (pct !== last) { last = pct; post('convertProgress', { id: it.id, state: 'run', pct: x }); }
          }, ac.signal, { start: it.start, length: it.length, meta: it.meta });
          converted.push(it);
          if (!replace) { done++; post('convertProgress', { id: it.id, state: 'done' }); }
        } catch (e) {
          if (e.cancelled || ac.signal.aborted) { post('convertProgress', { id: it.id, state: 'skip', error: '已停止' }); continue; }
          Log.error('Convert ' + it.src.path, e);
          failed.push({ file: path.basename(it.target), error: e.message });
          post('convertProgress', { id: it.id, state: 'fail', error: e.message });
        }
      }
    }));
    Log.info(`Converted ${converted.length}/${items.length} → ${o.format}${cue ? ' (CUE)' : ''}${replace ? ' (replace)' : ' → ' + dir}`);

    let albumId = null;
    if (replace && converted.length) {
      // the originals go to the Trash; a track that is playing is stopped first
      const leaving = new Set(converted.map(i => i.src.path.toLowerCase()));
      const cur = engine.track;
      const touches = !!(cur && cur.codec !== 'YouTube' && leaving.has(cur.path.toLowerCase()));
      let wasPlaying = false, pos = 0;
      if (touches) { wasPlaying = engine.isPlaying; pos = engine.position; engine.stop(); await new Promise(r => setTimeout(r, 250)); }
      else engine.invalidateNext();
      const moved = {};
      const albums = [...new Set(converted.map(i => i.src.albumId))];
      if (cue) {
        if (converted.length === jobs.length) {
          for (const src of new Set(converted.map(i => i.src))) { try { await shell.trashItem(src.path); } catch (e) { failed.push({ file: path.basename(src.path), error: e.message }); } }
          try { await shell.trashItem(cue.path); } catch (e) { failed.push({ file: path.basename(cue.path), error: e.message }); }
        } else failed.push({ file: path.basename(cue.path), error: '有曲目沒有切出來，原本的檔案保留' });
        for (const it of converted) { done++; post('convertProgress', { id: it.id, state: 'done' }); }
      } else {
        for (const it of converted) {
          try {
            await shell.trashItem(it.src.path);
            if (it.target.toLowerCase() !== it.final.toLowerCase()) fs.renameSync(it.target, it.final);
            else moved[it.src.path] = it.final;
            done++;
            post('convertProgress', { id: it.id, state: 'done' });
          } catch (e) {
            if (fs.existsSync(it.src.path)) { try { fs.unlinkSync(it.target); } catch { } }
            failed.push({ file: path.basename(it.src.path), error: e.message });
            post('convertProgress', { id: it.id, state: 'fail', error: e.message });
            Log.error('Convert replace ' + it.src.path, e);
          }
        }
      }
      if (Object.keys(moved).length) moveTrackIds(moved);
      for (const id of albums) { try { await lib.rereadAlbum(id, moved); } catch (e) { Log.error('Reread after convert', e); } }
      for (const it of converted) { const t = lib.getTrack(hash(it.final.toLowerCase())); if (t) { albumId = t.albumId; break; } }
      if (touches && !cue) { try { await player.reload(pos, wasPlaying); } catch (e) { Log.error('Resume after convert', e); } }
    } else if (!replace && converted.length && S.folders.some(f => isUnder(dir, f))) lib.startScan();
    return { done, failed, cancelled: ac.signal.aborted, dir: replace ? null : outFolders.size === 1 ? [...outFolders][0] : dir, albumId };
  } finally { convertJob = null; }
}

function moveTrackIds(moved) {
  const map = new Map(Object.entries(moved).map(([a, b]) => [hash(a.toLowerCase()), hash(b.toLowerCase())]));
  for (const [from, to] of map) {
    if (from === to) continue;
    if (S.favorites.includes(from)) S.favorites = S.favorites.map(x => x === from ? to : x);
    S.recent = S.recent.map(x => x === from ? to : x);
    if (from in S.lyricOffsets) { S.lyricOffsets[to] = S.lyricOffsets[from]; delete S.lyricOffsets[from]; }
    try { const c = LyricsService.cacheFile(from), c2 = LyricsService.cacheFile(to); if (fs.existsSync(c) && !fs.existsSync(c2)) fs.renameSync(c, c2); } catch { }
  }
  player.renameIds(map);
  saveSoon();
  post('favs', S.favorites);
}

function openExternal(u) { if (u && /^https?:\/\//.test(u)) shell.openExternal(u).catch(() => { }); }

async function mediaAsync(p, query) {
  const size = clamp(parseInt(query && query.get('s'), 10) || 600, 16, 2000);
  let data = null, type = 'image/jpeg', cache = 'max-age=86400';
  if (p === '/library.json') { data = lib.exportJson(); type = 'application/json; charset=utf-8'; cache = 'no-store'; }
  else if (p.startsWith('/art/a/')) data = await art.albumAsync(decodeURIComponent(p.slice(7)), size);
  else if (p.startsWith('/art/t/')) data = await art.trackAsync(decodeURIComponent(p.slice(7)), size);
  else if (p.startsWith('/art/r/')) data = await art.artistAsync(decodeURIComponent(p.slice(7)), size);
  return { data, type, cache };
}

async function devicesDto() {
  const list = await engine.listDevices();
  const cur = list.find(d => d.id === S.deviceId) || list.find(d => d.isDefault);
  const rate = engine.st.rate || 48000;
  const caps = cur ? { id: cur.id, name: cur.name, mixRate: rate, mixChannels: 2, hardwareVolume: false, summary: `Core Audio · 目前 ${rate / 1000} kHz`, rates: [], formats: {} } : null;
  return { devices: list, caps, asio: [] };
}

const OutputKeys = new Set(['deviceId', 'bufferMs', 'dsdPcmRate', 'replayGain', 'replayGainPreamp', 'gapless']);
const Protected = new Set(['queue', 'folders', 'favorites', 'recent', 'searchHistory', 'acoustIdKey']);
async function applySettings(patch) {
  let device = false, volume = false, rg = false, rem = false;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in S) || Protected.has(k)) continue;
    if (JSON.stringify(S[k]) === JSON.stringify(v)) continue;
    S[k] = v;
    if (k === 'deviceId') device = true;
    if (k === 'volumeMode' || k === 'muted' || k === 'volumeDb') volume = true;
    if (k === 'replayGain' || k === 'replayGainPreamp') rg = true;
    if (k === 'remoteEnabled' || k === 'remotePort') rem = true;
    if (k === 'autoContinue' && engine.isPlaying) player.ensureAutoNext();
    if (k === 'gapless' && !v) engine.invalidateNext();
    if (k === 'dsdPcmRate' && engine.track) engine.invalidateNext();
  }
  if (S.volumeMode === 'hardware') S.volumeMode = 'digital';
  saveSoon();
  if (rem) await startRemote();
  if (device) { await engine.setDevice(S.deviceId); postSoon('state'); }
  if (volume) { engine.applyVolume(); applyYtVolume(); }
  if (rg) engine.applyReplayGain();
  return S;
}

const L = (a, n) => Array.isArray(a[n]) ? a[n].filter(x => typeof x === 'string') : [];
const N = (a, n, d = 0) => typeof a[n] === 'number' ? a[n] : d;

async function handleRpc(m, a) {
  switch (m) {
    case 'ready':
      ready = true;
      if (!scanStarted && S.folders.length) { scanStarted = true; lib.startScan(); }
      return init();
    case 'init': return init();
    case 'state': return state();
    case 'queue': return queueDto();
    case 'play': await player.playList(L(a, 'ids'), N(a, 'start', -1), typeof a.shuffle === 'boolean' ? a.shuffle : S.shuffle); return null;
    case 'toggle':
      if (liveActive()) { await ytClick('.play-pause-button'); return null; }
      await player.toggle(); return null;
    case 'next':
      if (liveActive()) { await ytClick('.next-button'); return null; }
      await player.next(); return null;
    case 'prev':
      if (liveActive()) { await ytClick('.previous-button'); return null; }
      await player.previous(); return null;
    case 'seek':
      if (liveActive()) { await ytScript(`(() => { const v = document.querySelector('video'); if (v) v.currentTime = ${Number(N(a, 'pos'))}; })()`); return null; }
      await player.seek(N(a, 'pos')); return null;
    case 'lyricsLive': {
      if (!ytMeta.title) return null;
      const parts = (ytMeta.by || '').split('•').map(s => s.trim()).filter(Boolean);
      const artist = parts.length ? parts[0].replace(' 和 ', ' ').replace(' & ', ' ') : '';
      const t = { id: 'yt-' + hash(ytMeta.title + '|' + artist), title: ytMeta.title, artist, album: parts[1] || '', duration: ytMeta.d || 0, codec: 'YouTube' };
      const r = await lyrics.get(t);
      return { id: t.id, source: r.source, synced: r.synced, instrumental: r.instrumental, lines: r.lines.map(l => ({ ...l, trans: cleanTranslation(l.trans) })), offset: S.lyricOffsets[t.id] || 0 };
    }
    case 'stop': S.resumePosition = engine.position; engine.stop(); return null;
    case 'volume':
      S.volumeDb = clamp(N(a, 'db', S.volumeDb), -80, 0);
      if ('muted' in a) S.muted = a.muted === true;
      engine.applyVolume(); applyYtVolume(); saveSoon(); postSoon('state');
      return null;
    case 'shuffle': player.setShuffle(a.on === true); saveSoon(); return null;
    case 'repeat': player.setRepeat(a.mode); saveSoon(); return null;
    case 'queue.add': player.add(L(a, 'ids'), a.next === true); return null;
    case 'queue.remove': player.remove(N(a, 'i')); return null;
    case 'queue.move': player.move(N(a, 'from'), N(a, 'to')); return null;
    case 'queue.jump': await player.jumpTo(N(a, 'i')); return null;
    case 'queue.clear': player.clearUpcoming(); return null;
    case 'settings': return applySettings(a);
    case 'dsp': S.dsp = Object.assign(defaults().dsp, a || {}); engine.applyDsp(); saveSoon(); return null;
    case 'presets': S.presets = Array.isArray(a) ? a : []; saveSoon(); return null;
    case 'devices': return devicesDto();
    case 'probe': return (await devicesDto()).caps;
    case 'folder.add': {
      const r = await dialog.showOpenDialog(win, { title: '選擇音樂資料夾', properties: ['openDirectory'], buttonLabel: '加入' });
      if (r.canceled || !r.filePaths.length) return null;
      const p = r.filePaths[0];
      if (!S.folders.some(f => f.toLowerCase() === p.toLowerCase())) S.folders.push(p);
      saveSettings(); lib.startScan();
      return S.folders;
    }
    case 'folder.addPath': {
      const p = a.path;
      if (p && fs.existsSync(p) && !S.folders.some(f => f.toLowerCase() === p.toLowerCase())) S.folders.push(p);
      saveSettings(); lib.startScan();
      return S.folders;
    }
    case 'folder.remove':
      S.folders = S.folders.filter(f => f.toLowerCase() !== String(a.path || '').toLowerCase());
      saveSettings(); lib.startScan();
      return S.folders;
    case 'rescan': lib.startScan(a.full === true); return null;
    case 'suggestFolders': {
      const home = app.getPath('home');
      const c = [app.getPath('music'), path.join(home, 'Music', 'Music', 'Media.localized', 'Music'), path.join(home, 'Music', 'iTunes', 'iTunes Media', 'Music')];
      try { for (const v of fs.readdirSync('/Volumes')) { for (const n of ['Music', 'MUSIC', '音樂']) c.push(path.join('/Volumes', v, n)); } } catch { }
      return [...new Set(c)].filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
    }
    case 'lyrics': {
      const t = lib.getTrack(a.id);
      if (!t) return null;
      const r = await lyrics.get(t, a.refresh === true);
      return lyricsDto(t, r);
    }
    case 'lyrics.candidates': { const t = lib.getTrack(a.id); return t ? lyrics.candidates(t) : null; }
    case 'lyrics.apply': {
      const t = lib.getTrack(a.id);
      if (!t) return null;
      const r = await lyrics.apply(t, String(a.key || ''));
      return r ? lyricsDto(t, r) : null;
    }
    case 'lyrics.clear': { const t = lib.getTrack(a.id); if (t) lyrics.clear(t); return null; }
    case 'lyrics.autoAlign': {
      const t = lib.getTrack(a.id);
      if (!t) return null;
      const ly = await lyrics.get(t);
      if (!ly.synced || ly.lines.length < 4) return { ok: false, reason: '這首歌沒有同步歌詞' };
      const r = await LyricAlign.estimate(t, ly.lines.filter(l => l.text.length).map(l => l.t)).catch(e => { Log.error('Align', e); return null; });
      if (!r) return { ok: false, reason: '無法分析這首歌的音訊' };
      if (!r.ok) return { ok: false, reason: '分析結果不夠可靠，請手動調整', offset: r.offset, confidence: r.confidence };
      S.lyricOffsets[t.id] = r.offset; saveSoon();
      return { ok: true, offset: r.offset, confidence: r.confidence };
    }
    case 'lyrics.fetchAll': {
      if (lyricsJob) lyricsJob.abort();
      const ac = lyricsJob = new AbortController();
      lyrics.fetchAll(lib.allTracks, p => post('lyricsJob', p), ac.signal).catch(e => Log.info('Lyrics job: ' + e.message)).finally(() => post('lyricsJob', { done: -1 }));
      return null;
    }
    case 'lyrics.cancel': if (lyricsJob) lyricsJob.abort(); return null;
    case 'album.reread': return lib.rereadAlbum(a.id);
    case 'tags.load': return tagsDto(a.id);
    case 'tags.search': return Metadata.search(a.album, a.artist, lib.getAlbum(a.id), L(a, 'sources'));
    case 'tags.release': return Metadata.get(a.source, a.id, a.country);
    case 'tags.save': return saveTags(a);
    case 'convert.info': return Converter.info('垃圾桶');
    case 'convert.pickFolder': {
      const r = await dialog.showOpenDialog(win, { title: '選擇轉換後的檔案要放的資料夾', properties: ['openDirectory', 'createDirectory'], buttonLabel: '選擇', defaultPath: a.dir && fs.existsSync(a.dir) ? a.dir : undefined });
      return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
    }
    case 'convert.start': return convertJobRun(a, null);
    case 'convert.cancel': if (convertJob) convertJob.abort(); return null;
    case 'convert.open': if (a.path && fs.existsSync(a.path)) await shell.openPath(a.path); return null;
    case 'cue.info': {
      const cue = Converter.cueForAlbum(lib.getAlbum(a.id));
      return cue ? { cue: cue.path, cueName: path.basename(cue.path), tracks: cue.tracks.map(t => ({ no: t.no, title: t.title, performer: t.performer, dur: Math.round(t.length * 100) / 100 })) } : null;
    }
    case 'cue.split': {
      const al = lib.getAlbum(a.id);
      if (!al) throw new Error('找不到這張專輯');
      const cue = Converter.cueForAlbum(al);
      if (!cue) throw new Error('找不到這張專輯的 CUE 標記');
      return convertJobRun(a, cue);
    }
    case 'acoustid.info': return { hasKey: fp.hasKey, hasTool: !!fp.fpcalcPath };
    case 'acoustid.key': S.acoustIdKey = String(a.key || '').trim(); saveSettings(); return { hasKey: fp.hasKey };
    case 'tags.identify': {
      const al = lib.getAlbum(a.id);
      if (!al) throw new Error('找不到這張專輯');
      const ids = new Set(L(a, 'ids'));
      const list = al.tracks.filter(t => !ids.size || ids.has(t.id));
      if (fpJob) fpJob.abort();
      const ac = fpJob = new AbortController();
      try { return await fp.identify(list, p => post('fpProgress', p), ac.signal); }
      catch (e) { if (ac.signal.aborted) return null; throw e; }
    }
    case 'tags.identifyCancel': if (fpJob) fpJob.abort(); return null;
    case 'artistArt.info': return { source: art.artistSourceOf(a.name) };
    case 'artistArt.candidates': return art.artistCandidates(a.name, a.q);
    case 'artistArt.setUrl': return art.setArtistOverrideFromUrl(a.name, a.url);
    case 'artistArt.setData': return art.setArtistOverride(a.name, dataBytes(a.data));
    case 'artistArt.clear': art.clearArtistOverride(a.name); return null;
    case 'art.dims': return art.dimensions(L(a, 'urls'));
    case 'fullscreen': {
      const on = typeof a.on === 'boolean' ? a.on : !win.isFullScreen();
      win.setFullScreen(on);
      return on;
    }
    case 'lyricsOffset': S.lyricOffsets[a.id] = N(a, 'offset'); saveSoon(); return null;
    case 'fav': setFav(a.id, a.on === true); saveSoon(); post('favs', S.favorites); return null;
    case 'recent.add': {
      if (!a.id) return null;
      S.recent = [a.id, ...S.recent.filter(x => x !== a.id)].slice(0, 200); saveSoon(); return null;
    }
    case 'recent.clear': S.recent = []; saveSoon(); return null;
    case 'search.add': {
      const q = String(a.q || '').trim();
      if (!q) return null;
      S.searchHistory = [q, ...S.searchHistory.filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 20); saveSoon(); return null;
    }
    case 'search.remove': S.searchHistory = S.searchHistory.filter(x => x.toLowerCase() !== String(a.q || '').toLowerCase()); saveSoon(); return null;
    case 'search.clear': S.searchHistory = []; saveSoon(); return null;
    case 'art.retry': art.retryAlbum(a.id); return null;
    case 'art.info': return { source: art.sourceOf(a.id), confirmed: S.artConfirmed.includes(a.id), dims: a.dims === true ? await art.sourceDims(a.id) : null };
    case 'art.candidates': return art.candidates(a.id, a.q, a.part || null);
    case 'art.setUrl':
      await art.setOverrideFromUrl(a.id, a.url);
      if (!S.artConfirmed.includes(a.id)) S.artConfirmed.push(a.id); saveSoon(); return true;
    case 'art.setData': {
      art.setOverride(a.id, dataBytes(a.data));
      if (!S.artConfirmed.includes(a.id)) S.artConfirmed.push(a.id); saveSoon(); return true;
    }
    case 'art.clear': art.clearOverride(a.id); S.artConfirmed = S.artConfirmed.filter(x => x !== a.id); saveSoon(); return null;
    case 'art.confirm': if (!S.artConfirmed.includes(a.id)) S.artConfirmed.push(a.id); saveSoon(); return null;
    case 'art.reject': art.rejectOnline(a.id); S.artConfirmed = S.artConfirmed.filter(x => x !== a.id); saveSoon(); return null;
    case 'art.fetchMissing': {
      if (artJob) artJob.abort();
      const ac = artJob = new AbortController();
      art.fetchAllMissing(p => post('artJob', p), ac.signal).catch(() => { }).finally(() => post('artJob', { done: -1 }));
      return null;
    }
    case 'art.cancel': if (artJob) artJob.abort(); return null;
    case 'track': {
      const t = lib.getTrack(a.id);
      if (!t) return null;
      const { albumId, hasPic, mtime, ...rest } = t;
      return rest;
    }
    case 'reveal': { const t = lib.getTrack(a.id); if (t) shell.showItemInFolder(t.path); return null; }
    case 'autoeq.search': return AutoEq.search(a.q);
    case 'autoeq.get': return AutoEq.fetch(a.path, a.name);
    case 'yt.show': {
      const v = ensureYt();
      v.setBounds({ x: Math.round(N(a, 'x')), y: Math.round(N(a, 'y')), width: Math.round(N(a, 'w')), height: Math.round(N(a, 'h')) });
      v.setVisible(true);
      return null;
    }
    case 'yt.hide': if (yt) yt.setVisible(false); return null;
    case 'yt.nav':
      if (yt) {
        const wc = yt.webContents, h = wc.navigationHistory;
        switch (a.to) {
          case 'back': if (h.canGoBack()) h.goBack(); break;
          case 'forward': if (h.canGoForward()) h.goForward(); break;
          case 'reload': wc.reload(); break;
          case 'liked': wc.loadURL('https://music.youtube.com/playlist?list=LM'); break;
          case 'library': wc.loadURL('https://music.youtube.com/library'); break;
          default: wc.loadURL('https://music.youtube.com/');
        }
      }
      return null;
    case 'devtools': win.webContents.openDevTools({ mode: 'detach' }); return null;
    case 'remote.info': return remoteInfo();
    case 'remote.revoke': if (remote) remote.revoke(a.id); return remoteInfo();
    case 'quit': setTimeout(() => app.quit(), 10); return null;
    case 'openUrl': openExternal(a.url); return null;
    case 'openAudioMidi': {
      for (const p of ['/System/Applications/Utilities/Audio MIDI Setup.app', '/Applications/Utilities/Audio MIDI Setup.app'])
        if (fs.existsSync(p)) { await shell.openPath(p); break; }
      return null;
    }
    case 'ui': S.ui[a.key] = a.value; saveSoon(); return null;
  }
  throw new Error('Unknown method ' + m);
}

// ───────────── phone remote ─────────────
const RemoteAllowed = new Set(['state', 'queue', 'play', 'toggle', 'next', 'prev', 'seek', 'volume', 'shuffle', 'repeat',
  'queue.add', 'queue.remove', 'queue.move', 'queue.jump', 'queue.clear', 'track', 'lyrics', 'lyricsLive']);
function remoteInfo() {
  return {
    enabled: S.remoteEnabled, port: S.remotePort, running: !!(remote && remote.running), error: remote ? remote.lastError : null,
    urls: remote && remote.running ? remote.urls() : [], devices: remote ? remote.deviceList() : [], code: remote ? remote.pendingCode : null,
  };
}
async function remoteRpc(m, a) {
  switch (m) {
    case 'hello':
      return { app: 'MIKU', version: app.getVersion(), state: state(), queue: queueDto(), favorites: S.favorites, revision: lib.revision, yt: !!yt, device: engine.deviceName() };
    case 'fav': setFav(a.id, a.on === true); saveSoon(); post('favs', S.favorites); return null;
    case 'yt.toggle': case 'yt.next': case 'yt.prev':
      if (!yt) throw new Error('YouTube Music 還沒開啟，請先在 Mac 上的 MIKU 打開一次 YouTube Music。');
      await ytClick(m === 'yt.toggle' ? '.play-pause-button' : m === 'yt.next' ? '.next-button' : '.previous-button');
      return null;
  }
  if (!RemoteAllowed.has(m)) throw new Error('遙控不支援這個操作：' + m);
  return handleRpc(m, a);
}
async function startRemote() {
  if (!remote) remote = new RemoteServer(remoteRpc, mediaAsync,
    (name, code) => post('remotePair', { name, code }),
    name => { post('remotePaired', { name }); post('remoteChanged', remoteInfo()); });
  remote.stop();
  if (S.remoteEnabled) await remote.start(clamp(S.remotePort || 8765, 1024, 65535));
  post('remoteChanged', remoteInfo());
}

// ───────────── protocols ─────────────
const AudioTypes = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg' };
const cors = { 'Access-Control-Allow-Origin': '*' };

async function serveFile(file, req, type) {
  const st = await fs.promises.stat(file);
  const size = st.size;
  const range = req.headers.get('range');
  const headers = { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  let start = 0, end = size - 1, status = 200;
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m) {
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - parseInt(m[2], 10)); }
    else { start = parseInt(m[1] || '0', 10); if (m[2]) end = Math.min(size - 1, parseInt(m[2], 10)); }
    if (start >= size) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  const stream = Readable.toWeb(fs.createReadStream(file, { start, end, highWaterMark: 256 * 1024 }));
  return new Response(stream, { status, headers });
}

function registerProtocols() {
  protocol.handle('miku', async req => {
    const u = new URL(req.url);
    const base = u.hostname === 'engine' ? ENGINE : WWW;
    const file = path.normalize(path.join(base, decodeURIComponent(u.pathname)));
    if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  protocol.handle('miku-media', async req => {
    const u = new URL(req.url);
    const p = u.pathname;
    try {
      if (p.startsWith('/play/')) {
        const t = lib.getTrack(decodeURIComponent(p.slice(6)));
        if (!t) return new Response('not found', { status: 404, headers: cors });
        if (u.searchParams.get('tx')) {
          const file = await ff.transcode(t, S.dsdPcmRate || 176400);
          return serveFile(file, req, 'audio/flac');
        }
        return serveFile(t.path, req, AudioTypes[path.extname(t.path).toLowerCase()] || 'application/octet-stream');
      }
      const { data, type, cache } = await mediaAsync(p, u.searchParams);
      if (!data) return new Response(null, { status: 404, headers: { ...cors, 'Cache-Control': 'no-store' } });
      return new Response(data, { status: 200, headers: { ...cors, 'Content-Type': type, 'Cache-Control': cache } });
    } catch (e) {
      Log.error('Resource ' + req.url, e);
      return new Response(String(e.message || e), { status: 500, headers: cors });
    }
  });
}

// ───────────── window ─────────────
function restoreBounds() {
  const w = S.window;
  if (Array.isArray(w) && w.length === 4 && w[2] > 300) {
    const r = { x: w[0], y: w[1], width: w[2], height: w[3] };
    if (screen.getAllDisplays().some(d => { const a = d.workArea; return r.x < a.x + a.width && r.x + r.width > a.x && r.y < a.y + a.height && r.y + r.height > a.y; })) return r;
  }
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1480, wa.width - 80), height = Math.min(940, wa.height - 60);
  return { x: wa.x + Math.round((wa.width - width) / 2), y: wa.y + Math.round((wa.height - height) / 2), width, height };
}

function createWindow() {
  win = new BrowserWindow({
    ...restoreBounds(), minWidth: 980, minHeight: 640, title: 'MIKU', backgroundColor: Bg, show: false,
    webPreferences: { preload: path.join(__dirname, 'main-preload.js'), contextIsolation: true, sandbox: true, spellcheck: false, backgroundThrottling: false },
  });
  if (S.maximized) win.maximize();
  win.on('enter-full-screen', () => post('fullscreen', { on: true }));
  win.on('leave-full-screen', () => post('fullscreen', { on: false }));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('miku://app/')) { e.preventDefault(); openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    // keep page zoom fixed like the Windows build
    if (input.meta && ['=', '-', '0', '+'].includes(input.key)) e.preventDefault();
  });
  win.on('close', e => {
    saveWindow();
    if (!quitting) { e.preventDefault(); if (win.isFullScreen()) { win.once('leave-full-screen', () => win.hide()); win.setFullScreen(false); } else win.hide(); }
  });
  win.loadURL('miku://app/index.html');
}
function saveWindow() {
  if (!win || win.isDestroyed()) return;
  S.maximized = win.isMaximized();
  const b = win.getNormalBounds();
  S.window = [b.x, b.y, b.width, b.height];
}

function buildMenu() {
  const ctl = (label, accelerator, fn) => ({ label, accelerator, click: fn });
  const tmpl = [
    { label: 'MIKU', submenu: [
      { role: 'about', label: '關於 MIKU' }, { type: 'separator' },
      ctl('設定…', 'Cmd+,', () => { showWin(); win.webContents.executeJavaScript("location.hash = '#/settings'").catch(() => { }); }),
      { type: 'separator' }, { role: 'services', label: '服務' }, { type: 'separator' },
      { role: 'hide', label: '隱藏 MIKU' }, { role: 'hideOthers', label: '隱藏其他' }, { role: 'unhide', label: '顯示全部' },
      { type: 'separator' }, { role: 'quit', label: '結束 MIKU' },
    ] },
    { label: '編輯', submenu: [
      { role: 'undo', label: '還原' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪下' }, { role: 'copy', label: '拷貝' }, { role: 'paste', label: '貼上' }, { role: 'selectAll', label: '全選' },
    ] },
    { label: '控制', submenu: [
      ctl('播放／暫停', undefined, () => handleRpc('toggle', {})),
      ctl('下一首', undefined, () => handleRpc('next', {})),
      ctl('上一首', undefined, () => handleRpc('prev', {})),
      { type: 'separator' },
      ctl('提高音量', undefined, () => handleRpc('volume', { db: S.volumeDb + 1 })),
      ctl('降低音量', undefined, () => handleRpc('volume', { db: S.volumeDb - 1 })),
    ] },
    { label: '顯示', submenu: [
      { role: 'togglefullscreen', label: '全螢幕' },
      ctl('開發者工具', 'Alt+Cmd+I', () => win.webContents.openDevTools({ mode: 'detach' })),
    ] },
    { role: 'windowMenu', label: '視窗', submenu: [{ role: 'minimize', label: '縮到最小' }, { role: 'zoom', label: '縮放' }, { type: 'separator' }, ctl('MIKU', 'Cmd+1', () => showWin())] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tmpl));
}
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

app.on('second-instance', showWin);
app.on('activate', showWin);
app.on('before-quit', () => {
  quitting = true;
  try { player.saveState(); saveWindow(); saveSettings(); } catch (e) { Log.error('Quit', e); }
  try { remote && remote.stop(); } catch { }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.whenReady().then(async () => {
  Log.info('Start ' + app.getVersion() + ' (' + process.arch + ')');
  nativeTheme.themeSource = 'dark';
  app.setAboutPanelOptions({ applicationName: 'MIKU', applicationVersion: app.getVersion(), copyright: 'MIKU Music Player for macOS' });
  // device labels for the output list and setSinkId
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'speaker-selection', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen'].includes(perm)));
  registerProtocols();
  buildMenu();
  lib.load();
  createWindow();
  engine.start();
  startRemote().catch(e => Log.error('Remote', e));
});
