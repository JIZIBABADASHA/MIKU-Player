'use strict';
/* ═════════════════════════════ host bridge ═════════════════════════════ */
const MEDIA = 'https://media.miku';
const Host = (() => {
  let seq = 0;
  const pending = new Map();
  const listeners = {};
  const wv = window.chrome && window.chrome.webview;
  function deliver(msg) {
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.e ? p.reject(new Error(msg.e)) : p.resolve(msg.r);
    } else if (msg.ev) (listeners[msg.ev] || []).forEach(f => { try { f(msg.d); } catch (e) { console.error(e); } });
  }
  if (wv) wv.addEventListener('message', e => deliver(e.data));
  return {
    real: !!wv,
    call(m, a) {
      if (!wv) return window.Mock ? Mock.call(m, a, deliver) : Promise.resolve(null);
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        wv.postMessage(JSON.stringify({ id, m, a }));
      });
    },
    on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); },
    emit: deliver,
  };
})();

/* ═════════════════════════════ helpers ═════════════════════════════ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(k));
  return el;
}
const icon = (name, fill) => `<svg class="i${fill ? ' fill' : ''}"><use href="#i-${name}"/></svg>`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = s => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const fmtLong = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分鐘` : `${m} 分鐘`; };
const khz = r => (r / 1000).toFixed(r % 1000 ? 1 : 0).replace(/\.0$/, '');
function hashHue(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return Math.abs(x) % 360; }
function initials(s) {
  s = (s || '').trim();
  if (!s) return '♪';
  const words = s.split(/\s+/).filter(Boolean);
  if (/^[\x00-\x7f]/.test(s) && words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return [...s][0].toUpperCase();
}
function debounce(f, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; }
const norm = s => (s || '').normalize('NFKC').toLowerCase();

function fmtQuality(codec, rate, bits) {
  if (codec === 'DSF' || codec === 'DFF') return 'DSD' + Math.round(rate / 44100);
  if (['MP3', 'AAC', 'OGG', 'OPUS', 'WMA'].includes(codec)) return codec;
  if (!rate) return codec;
  return `${bits || 16}/${khz(rate)}`;
}
/** An album's format as shown on its page: "FLAC 24/96", "DSD128", "MP3". */
function qualityLabel(al) {
  const f = al.tracks[0];
  if (!f) return '';
  return f.codec === 'DSF' || f.codec === 'DFF' || al.q === f.codec ? al.q : `${f.codec} ${al.q}`;
}
/** Sort key for an album's versions, best first: DSD, then lossless by bits and rate, then lossy. */
function qualityRank(al) {
  const f = al.tracks[0];
  if (!f) return 0;
  if (f.codec === 'DSF' || f.codec === 'DFF') return 3e9 + f.rate;
  if (['MP3', 'AAC', 'OGG', 'OPUS', 'WMA'].includes(f.codec)) return f.rate || 0;
  return (f.bits || 16) * 1e7 + (f.rate || 0);
}
function qualityClass(codec, rate, bits) {
  if (codec === 'DSF' || codec === 'DFF') return 'dsd';
  if (bits > 16 || rate > 48000) return 'hi';
  return '';
}

/* ═════════════════════════════ toasts ═════════════════════════════ */
function toast(msg, opts = {}) {
  const el = h('div', { class: 'toast' + (opts.error ? ' err' : '') }, msg);
  $('#toasts').append(el);
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  setTimeout(kill, opts.ms || (opts.error ? 6500 : 3200));
  el.onclick = kill;
}

/* ═════════════════════════════ artwork ═════════════════════════════ */
const ArtVer = {};
/** ArtworkService.Rules: a picture cached by WebView2 under older rules isn't used. */
const ART_RULES = 2;
/** Changes counted in ArtVer start again at every start, while WebView2 keeps pictures cached for a day: make each start's URLs its own. */
const ART_BOOT = Date.now().toString(36);
function artUrl(kind, id, size) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const s = Math.round(size * dpr);
  const v = ArtVer[kind + id] || 0;
  return `${MEDIA}/art/${kind}/${encodeURIComponent(id)}?s=${s}&r=${ART_RULES}${v ? `&v=${ART_BOOT}.${v}` : ''}`;
}
/** Fills `box` with a placeholder and lazily fades the real image in on top. */
function fillArt(box, kind, id, size, label, opts = {}) {
  const src = id ? artUrl(kind, id, size) : null;
  // refreshing a box that already shows a picture: load the new one off-screen, then swap (no flash)
  const current = box.querySelector('img.ok');
  if (opts.swap && current && src) {
    const next = new Image();
    next.decoding = 'async';
    next.onload = () => { next.className = 'ok'; next.style.transition = 'none'; current.replaceWith(next); };
    next.src = src;
    return;
  }
  box.textContent = '';
  const hue = hashHue(label || id || '');
  box.style.background = `linear-gradient(135deg, hsl(${hue} var(--ph-s1) var(--ph-l1)), hsl(${(hue + 40) % 360} var(--ph-s2) var(--ph-l2)))`;
  const ph = h('div', { class: 'ph' });
  if (kind === 'r') ph.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-artist"/></svg>`;
  else ph.textContent = initials(label);
  box.append(ph);
  if (!id) return;
  const img = new Image();
  img.decoding = 'async';
  img.dataset.kind = kind; img.dataset.id = id; img.dataset.size = size;
  const t0 = performance.now();
  img.onload = () => {
    // cached pictures appear instantly; only slow loads fade in
    if (performance.now() - t0 < 120) img.style.transition = 'none';
    img.classList.add('ok'); ph.remove(); box.style.background = '';
  };
  img.onerror = () => img.remove();
  img.src = src;
  box.append(img);
}
Host.on('art', ({ kind, id }) => {
  const k = kind === 'album' ? 'a' : kind === 'track' ? 't' : 'r';
  ArtVer[k + id] = (ArtVer[k + id] || 0) + 1;
  // refresh any visible boxes showing this art
  document.querySelectorAll('[data-art]').forEach(box => {
    const [bk, bid] = box.dataset.art.split(':');
    if (bk === k && bid === id) fillArt(box, bk, bid, +box.dataset.size, box.dataset.label, { swap: true });
  });
  if (k === 'a' || k === 't') App.refreshNowArt(k, id);
});
/** Artwork for YouTube Music tracks (remote URL, upscaled when the CDN allows it). */
function bigYtImg(url, size) {
  if (!url) return '';
  return url.replace(/=w\d+-h\d+[^&?]*/, `=w${size}-h${size}-l90-rj`).replace(/\/(default|mqdefault|hqdefault)\.jpg/, '/maxresdefault.jpg');
}
function liveArt(box, url, size, label) {
  fillArt(box, 'a', null, size, label);
  if (!url) return;
  const ph = box.querySelector('.ph');
  const img = new Image();
  img.onload = () => { img.classList.add('ok'); ph && ph.remove(); box.style.background = ''; };
  img.onerror = () => { if (img.src !== url) img.src = url; else img.remove(); };
  img.src = bigYtImg(url, Math.round(size * (window.devicePixelRatio || 1)));
  box.append(img);
}
function artBox(cls, kind, id, size, label) {
  const box = h('div', { class: cls, 'data-art': `${kind}:${id}`, 'data-size': size, 'data-label': label || '' });
  fillArt(box, kind, id, size, label);
  return box;
}

/* ═════════════════════════════ library store ═════════════════════════════ */
/** Artist and genre tags: ';' separates several values ("ほぼ日P ;  初音ミク", "Niconico; Vocaloid"). */
const splitNames = s => (s || '').split(';').map(x => x.trim()).filter(Boolean);
/** Several values shown as one text. */
const joinNames = names => names.join(' / ');
const realArtist = n => n && n !== 'Various Artists' && n !== '未知演出者';
/** The artist page for a track: its album's artist (unless a compilation), else the track's first artist. */
const mainArtist = t => (t.album?.artists || []).find(realArtist) || t.artists?.[0] || t.artist;
/** Names as links to their artist pages, separated like joinNames. */
function artistLinks(names, before) {
  const out = [];
  names.forEach((n, i) => {
    if (i) out.push(' / ');
    out.push(realArtist(n) ? h('a', { onclick: () => { before && before(); go('#/artist/' + encodeURIComponent(n)); } }, n) : n);
  });
  return out;
}

const Lib = {
  albums: [], tracks: [], albumById: new Map(), trackById: new Map(), artists: [], artistMap: new Map(), loaded: false,
  async load() {
    let data;
    try {
      data = Host.real ? await (await fetch(`${MEDIA}/library.json?r=${Date.now()}`)).json() : Mock.library();
    } catch (e) { console.error(e); data = { albums: [], tracks: [] }; }
    const albums = [], albumById = new Map(), trackById = new Map(), tracks = [];
    for (const a of data.albums) {
      const artists = splitNames(a[2]);
      const al = { id: a[0], title: a[1], artist: joinNames(artists), artists, year: a[3], genre: joinNames(splitNames(a[4])), added: a[5], hasArt: !!a[6], loose: !!a[7], vg: a[8] || '', folder: a[9] || '', tracks: [], dur: 0 };
      albums.push(al); albumById.set(al.id, al);
    }
    for (const r of data.tracks) {
      const artists = splitNames(r[2]);
      const t = { id: r[0], title: r[1], artist: joinNames(artists), artists, albumId: r[3], disc: r[4], no: r[5], dur: r[6], codec: r[7], rate: r[8], bits: r[9], year: r[10], composer: r[11] };
      const al = albumById.get(t.albumId);
      t.album = al;
      if (al) { al.tracks.push(t); al.dur += t.dur; }
      tracks.push(t); trackById.set(t.id, t);
    }
    for (const al of albums) {
      const f = al.tracks[0];
      al.q = f ? fmtQuality(f.codec, f.rate, f.bits) : '';
      al.qc = f ? qualityClass(f.codec, f.rate, f.bits) : '';
      al.versions = null; al.hidden = false;
      al.s = norm(al.title + ' ' + al.artist);
    }
    // the same album in several folders / formats (Library.GroupVersions): each knows the others, best first. Lists
    // show the album once, as its best version (that's the one opened); the others are reached from its version menu.
    const groups = new Map();
    for (const al of albums) if (al.vg) (groups.get(al.vg) || groups.set(al.vg, []).get(al.vg)).push(al);
    for (const g of groups.values()) {
      g.sort((x, y) => qualityRank(y) - qualityRank(x) || y.tracks.length - x.tracks.length);
      for (const al of g) { al.versions = g; al.hidden = al !== g[0]; }
    }
    const shown = albums.filter(al => !al.hidden);
    const artistMap = new Map();
    for (const al of shown) {
      // each of several album artists ("Various Artists ; 初音ミク") gets the album, and so do the artists of its other
      // versions, written otherwise ("kensuke ushio" / "牛尾憲輔")
      const names = new Set((al.versions || [al]).flatMap(v => v.artists).filter(realArtist));
      for (const name of names) {
        let ar = artistMap.get(name);
        if (!ar) artistMap.set(name, ar = { name, albums: [], s: norm(name) });
        ar.albums.push(al);
      }
    }
    for (const t of tracks) t.s = norm(t.title + ' ' + t.artist + ' ' + (t.album ? t.album.title : ''));
    const shownTracks = tracks.filter(t => !t.album?.hidden);
    const coll = new Intl.Collator(['ja', 'zh-Hant', 'en'], { sensitivity: 'base', numeric: true });
    Object.assign(this, {
      // albums / tracks: what lists show (one version per album); allAlbums / allTracks: everything
      albums: shown, tracks: shownTracks, allAlbums: albums, allTracks: tracks, albumById, trackById, artistMap, loaded: true, collator: coll,
      artists: [...artistMap.values()].sort((a, b) => coll.compare(a.name, b.name)),
    });
    $('#c-albums').textContent = shown.length || '';
    $('#c-artists').textContent = this.artists.length || '';
    $('#c-tracks').textContent = shownTracks.length || '';
  },
  artistAlbums(name) {
    const own = this.artistMap.get(name)?.albums || [];
    const nn = norm(name);
    const appears = this.albums.filter(a => !own.includes(a) && a.tracks.some(t => norm(t.artist).includes(nn)));
    return { own: own.slice().sort((a, b) => (b.year || 0) - (a.year || 0)), appears };
  },
};

/* ═════════════════════════════ app state ═════════════════════════════ */
const App = {
  settings: {}, state: {}, queue: { ids: [], index: -1 }, favs: new Set(),
  posBase: 0, posAt: 0, seeking: false,

  async start() {
    this.drawBrand();
    this.bindBar();
    this.bindKeys();
    Host.on('state', s => this.setState(s));
    Host.on('queue', q => { this.queue = q; Queue.render(); Views.markPlaying(); });
    Host.on('error', e => toast(e.message, { error: true }));
    // phone remote: show the pairing code a phone asked for, and keep favourites in sync with it
    Host.on('remotePair', p => toast(`「${p.name}」要求用手機遙控 MIKU，配對碼：${p.code}`, { ms: 180000 }));
    Host.on('remotePaired', p => toast(`「${p.name}」已配對，可以用手機遙控了`));
    Host.on('favs', f => { this.favs = new Set(f || []); this.renderFav(); });
    Host.on('scan', p => this.scan(p));
    Host.on('fullscreen', ({ on }) => { this.fullscreen = on; document.documentElement.classList.toggle('fullscreen', on); });
    Host.on('library', async () => {
      const before = Lib.albums.length + ':' + Lib.tracks.length;
      await Lib.load();
      this.trackKey = null; // the track objects were rebuilt: redraw the now-playing bar with the new ones
      // during a scan only refresh pages that list the library, and do it silently
      if (before !== Lib.albums.length + ':' + Lib.tracks.length && ['home', 'albums', 'artists', 'tracks'].includes(Router.cur.name)) Router.render(true, 'none');
    });
    const init = await Host.call('ready');
    this.settings = init.settings;
    if (typeof Theme !== 'undefined') Theme.sync();
    this.favs = new Set(init.settings.favorites || []);
    this.lastRecent = (init.settings.recent || [])[0] || null;
    this.queue = init.queue;
    this.ffmpeg = init.ffmpeg;
    this.rplay = !!init.rplay;
    this.rplayCommit = init.rplayCommit || '';
    this.version = init.version;
    this.scan(init.scan);
    await Lib.load();
    this.trackKey = null; // states received while the library was loading may have drawn an empty now-playing bar
    this.setState(init.state);
    this.renderFav();
    Outputs.refresh();
    ScrollBubble.init();
    Router.start();
    requestAnimationFrame(t => this.frame(t));
    if (!init.ffmpeg) toast('找不到 FFmpeg，請在設定確認 FFmpeg 已安裝並加入 PATH。', { error: true, ms: 9000 });
  },

  drawBrand() {
    $('#brand').innerHTML = Brand.svg(34);
  },

  scan(p) {
    if (!p) return;
    const el = $('#sidefoot');
    if (p.scanning) {
      const pct = p.found ? Math.min(100, p.done / p.found * 100) : 0;
      el.innerHTML = `<div class="scanline"><span class="txt">掃描曲庫</span><div class="bar"><i style="width:${pct}%"></i></div><span class="num">${p.done}/${p.found || '…'}</span></div>`;
    } else el.textContent = '';
  },

  /* ── state ── */
  setState(s) {
    const prev = this.state;
    this.state = s;
    // after a seek, ignore stale positions until the engine reports the new one
    const settling = this.seekUntil && performance.now() < this.seekUntil && Math.abs(s.pos - this.seekTarget) > 1.2;
    if (!settling) this.seekUntil = 0;
    if (!this.seeking && !settling) { this.posBase = s.pos; this.posAt = performance.now(); }
    const key = s.trackId + '|' + (s.live ? s.live.title + '|' + s.live.artist : '');
    if (this.trackKey !== key) { this.trackKey = key; this.trackChanged(); }
    if (s.playing && s.meter && s.meter.resampleMeterAvailable === true && s.meter.resampleOverloads > 0 && this.overloadWarningTrack !== key) {
      this.overloadWarningTrack = key;
      toast('重取樣輸出峰值超過 0 dBFS。請在訊號路徑查看已解碼區段的量測，並自行調整數位音量或前級增益。', { error: true, ms: 9000 });
    }
    // states arrive before the library has loaded at startup (library.json can take a moment): a local track that
    // isn't in Lib yet was drawn empty, so don't remember it as drawn and try again with the next state
    if (s.trackId && !s.live && !Lib.trackById.has(s.trackId)) this.trackKey = null;
    // 最近聆聽: a local track counts once it actually starts playing
    if (s.playing && s.trackId && !s.live && s.trackId !== 'yt-live' && this.lastRecent !== s.trackId) {
      this.lastRecent = s.trackId;
      this.addRecent(s.trackId);
    }
    if (prev.playing !== s.playing) {
      for (const id of ['#b-play', '#np-play']) {
        const b = $(id);
        b.innerHTML = icon(s.playing ? 'pause' : 'play', true);
        b.classList.remove('play-pulse'); void b.offsetWidth; b.classList.add('play-pulse');
      }
      document.body.classList.toggle('paused', !s.playing);
      $('#np').classList.toggle('paused', !s.playing && !!s.trackId);
    }
    for (const p of ['b', 'np']) {
      $(`#${p}-shuffle`).classList.toggle('on', !!s.shuffle);
      const rep = $(`#${p}-repeat`);
      rep.classList.toggle('on', s.repeat !== 'off');
      rep.innerHTML = icon(s.repeat === 'one' ? 'repeat1' : 'repeat');
    }
    this.renderVolume();
    this.renderSignal();
  },

  get pos() {
    const s = this.state;
    if (!s.playing || this.seeking) return this.posBase;
    return Math.min(s.dur || 0, this.posBase + (performance.now() - this.posAt) / 1000);
  },

  track() {
    const s = this.state;
    if (s.live) {
      const l = s.live;
      return { id: 'yt-live', live: true, title: l.title || 'YouTube Music', artist: l.artist || '', albumId: null,
        album: { title: l.album || '', artist: l.artist || '' }, codec: 'YouTube', rate: 48000, bits: 0, img: l.img || '' };
    }
    return Lib.trackById.get(s.trackId);
  },

  trackChanged() {
    const t = this.track();
    const txt = $('#b-txt');
    txt.classList.remove('swap'); void txt.offsetWidth; txt.classList.add('swap');
    $('#b-title').textContent = t ? t.title : '';
    $('#b-artist').textContent = t ? t.artist || t.album?.artist || '' : '';
    const art = $('#b-art');
    if (t && t.live) { delete art.dataset.art; liveArt(art, t.img, 160, t.title); }
    else if (t) { art.dataset.art = (t.album?.loose ? 't:' + t.id : 'a:' + t.albumId); art.dataset.size = 64; fillArt(art, t.album?.loose ? 't' : 'a', t.album?.loose ? t.id : t.albumId, 64, t.album?.title); }
    else art.textContent = '';
    this.renderFav();
    document.title = t ? `${t.title} · ${t.artist} — MIKU` : 'MIKU';
    NowPlaying.trackChanged(t);
    Views.markPlaying();
  },

  refreshNowArt(k, id) {
    const t = this.track();
    if (!t) return;
    if ((k === 'a' && t.albumId === id) || (k === 't' && t.id === id)) { this.trackChanged(); }
  },

  renderFav() {
    const t = this.track(), on = t && this.favs.has(t.id);
    const b = $('#b-fav');
    if (t && t.live) { b.style.visibility = 'hidden'; return; }
    b.classList.toggle('fav-on', !!on);
    b.innerHTML = icon(on ? 'heartf' : 'heart');
    b.style.visibility = t ? '' : 'hidden';
  },

  addRecent(id) {
    const r = (this.settings.recent || []).filter(x => x !== id);
    r.unshift(id);
    if (r.length > 200) r.length = 200;
    this.settings.recent = r;
    Host.call('recent.add', { id });
  },

  toggleFav(id) {
    const on = !this.favs.has(id);
    on ? this.favs.add(id) : this.favs.delete(id);
    Host.call('fav', { id, on });
    this.renderFav();
    if (Router.cur.name === 'favorites') Router.render(true);
    return on;
  },

  /* ── volume ── */
  renderVolume() {
    const s = this.state, mode = s.volumeMode;
    const vol = $('#b-vol');
    vol.classList.toggle('disabled', mode === 'fixed');
    vol.style.display = mode === 'fixed' ? 'none' : '';  // fixed (bit-perfect) volume: nothing to adjust, hide it
    const db = s.volumeDb ?? -20;
    const x = s.muted ? 0 : dbToX(db);
    if (!this.volDrag) setSlider($('#b-volslider'), x);
    $('#b-db').textContent = mode === 'fixed' ? '0 dB' : s.muted ? '靜音' : (db <= -79.5 ? '−∞' : (db === 0 ? '0' : '−' + Math.abs(db).toFixed(1)) + ' dB');
    $('#b-mute').innerHTML = icon(s.muted || db <= -79.5 ? 'mute' : db < -30 ? 'vollow' : 'vol');
    $('#b-mute').title = mode === 'fixed' ? '固定音量（Bit-perfect）' : '靜音 (M)';
  },
  setVolume(db, muted) {
    db = Math.max(-80, Math.min(0, Math.round(db * 2) / 2));
    this.state.volumeDb = db;
    if (muted !== undefined) this.state.muted = muted;
    this.renderVolume();
    this.sendVolume();
  },
  sendVolume: null,

  /* ── signal path badge ── */
  renderSignal() {
    const sg = this.state.signal, el = $('#b-sig');
    el.className = 'sig' + (sg ? ' q-' + sg.quality : '');
    if (!sg) { $('#b-sigtxt').textContent = this.state.trackId ? '已停止' : '未播放'; return; }
    const src = sg.dsd ? sg.dsdLabel : `${sg.sourceBits || ''}${sg.sourceBits ? '/' : ''}${khz(sg.sourceRate)}`;
    $('#b-sigtxt').textContent = `${sg.codec} ${src}${sg.dop ? ' · DoP' : ''}`;
  },

  /* ── frame loop: progress bars & lyrics ── */
  lastSec: -1,
  frame() {
    const s = this.state, pos = this.pos, dur = s.dur || 0;
    const x = dur > 0 ? pos / dur : 0;
    if (!this.seeking) { setSlider($('#b-seek'), x); if (NowPlaying.open) setSlider($('#np-seek'), x); }
    const sec = Math.floor(pos);
    if (sec !== this.lastSec || this.durShown !== dur) {
      this.lastSec = sec; this.durShown = dur;
      $('#b-pos').textContent = fmtTime(pos); $('#b-dur').textContent = fmtTime(dur);
      $('#np-pos').textContent = fmtTime(pos); $('#np-dur').textContent = '−' + fmtTime(Math.max(0, dur - pos));
    }
    NowPlaying.tick(pos);
    requestAnimationFrame(() => this.frame());
  },

  /* ── commands ── */
  playTracks(list, start = 0, shuffle) {
    if (!list.length) return;
    const a = { ids: list.map(t => t.id), start };
    if (shuffle !== undefined) a.shuffle = shuffle;
    Host.call('play', a);
  },
  toggle() { Host.call('toggle'); },
  seek(pos) {
    this.posBase = pos; this.posAt = performance.now();
    this.seekTarget = pos; this.seekUntil = performance.now() + 2500;
    Host.call('seek', { pos });
  },

  bindBar() {
    $('#b-play').onclick = () => this.toggle();
    $('#b-next').onclick = () => Host.call('next');
    $('#b-prev').onclick = () => Host.call('prev');
    $('#b-shuffle').onclick = () => Host.call('shuffle', { on: !this.state.shuffle });
    $('#b-repeat').onclick = () => Host.call('repeat', { mode: { off: 'all', all: 'one', one: 'off' }[this.state.repeat || 'off'] });
    $('#b-fav').onclick = () => { const t = this.track(); if (t) this.toggleFav(t.id); };
    $('#b-art').onclick = () => NowPlaying.show();
    $('#b-title').onclick = () => { const t = this.track(); if (t) go(t.live ? '#/ytmusic' : '#/album/' + t.albumId); };
    $('#b-artist').onclick = () => { const t = this.track(); if (t && t.live) return go('#/ytmusic'); if (t) go('#/artist/' + encodeURIComponent(mainArtist(t))); };
    $('#b-queue').onclick = () => Drawer.toggle('queue');
    $('#b-dsp').onclick = () => Drawer.toggle('dsp');
    $('#b-sig').onclick = e => SignalPop.toggle(e.currentTarget);
    $('#b-out').onclick = e => Outputs.toggle(e.currentTarget);
    $('#b-mute').onclick = () => { if (this.state.volumeMode !== 'fixed') this.setVolume(this.state.volumeDb, !this.state.muted); };

    const sendVol = throttle(() => Host.call('volume', { db: this.state.volumeDb, muted: this.state.muted }), 40);
    this.sendVolume = sendVol;
    slider($('#b-volslider'), {
      tip: x => x <= 0 ? '−∞' : xToDb(x).toFixed(1) + ' dB',
      start: () => { this.volDrag = true; },
      move: x => this.setVolume(x <= 0.001 ? -80 : xToDb(x), false),
      end: () => { this.volDrag = false; },
    });
    $('#b-vol').addEventListener('wheel', e => {
      e.preventDefault();
      if (this.state.volumeMode === 'fixed') return;
      this.setVolume((this.state.volumeDb ?? -20) + (e.deltaY < 0 ? 1 : -1), false);
    }, { passive: false });

    for (const id of ['#b-seek', '#np-seek']) {
      slider($(id), {
        tip: x => fmtTime(x * (this.state.dur || 0)),
        start: () => { this.seeking = true; },
        move: x => { this.posBase = x * (this.state.dur || 0); setSlider($('#b-seek'), x); setSlider($('#np-seek'), x); },
        end: x => { this.seeking = false; this.seek(x * (this.state.dur || 0)); },
      });
    }
    $('#np-play').onclick = () => this.toggle();
    $('#np-next').onclick = () => Host.call('next');
    $('#np-prev').onclick = () => Host.call('prev');
    $('#np-shuffle').onclick = () => $('#b-shuffle').click();
    $('#np-repeat').onclick = () => $('#b-repeat').click();
    $('#back').onclick = () => history.back();
    $('#fwd').onclick = () => history.forward();
    const q = $('#q');
    q.addEventListener('input', debounce(() => {
      const v = q.value.trim();
      if (v) go('#/search/' + encodeURIComponent(v), true);
      else if (Router.cur.name === 'search') history.back();
    }, 160));
    q.addEventListener('keydown', e => {
      if (e.key === 'Escape') { SearchHist.hide(); q.value = ''; q.blur(); if (Router.cur.name === 'search') history.back(); }
      else if (e.key === 'Enter') { const v = q.value.trim(); if (v) { SearchHist.add(v); SearchHist.hide(); } }
    });
    q.addEventListener('focus', () => { if (!q.value.trim()) SearchHist.show(); });
    q.addEventListener('input', () => { if (q.value.trim()) SearchHist.hide(); else SearchHist.show(); });
    q.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== q) SearchHist.hide(); }, 120));
    const content = $('#content');
    // double-click the top bar to jump back to the top (fast eased scroll, like macOS / iOS)
    $('#topbar').addEventListener('dblclick', e => {
      if (e.target.closest('input, button, .search')) return;
      scrollTop(content);
    });
    content.addEventListener('scroll', () => $('#topbar').classList.toggle('solid', content.scrollTop > 8), { passive: true });
  },

  bindKeys() {
    document.addEventListener('keydown', e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
      if (e.key === 'F12') { Host.call('devtools'); return; }
      if (e.key === 'F11') { e.preventDefault(); Host.call('fullscreen'); return; }
      if (typing) return;
      if (e.key === 'Escape') { if (ArtPicker.close()) return; if (Popover.close()) return; if (Drawer.open) return Drawer.close(); if (NowPlaying.open) return NowPlaying.hide(); if (this.fullscreen) return Host.call('fullscreen', { on: false }); }
      if (e.key === ' ') { e.preventDefault(); this.toggle(); }
      else if (e.key === 'ArrowRight' && !e.altKey) { e.preventDefault(); this.seek(Math.min(this.state.dur, this.pos + (e.shiftKey ? 30 : 5))); }
      else if (e.key === 'ArrowLeft' && !e.altKey) { e.preventDefault(); this.seek(Math.max(0, this.pos - (e.shiftKey ? 30 : 5))); }
      else if (e.key === 'ArrowUp' && e.ctrlKey) { e.preventDefault(); this.setVolume(this.state.volumeDb + 1, false); }
      else if (e.key === 'ArrowDown' && e.ctrlKey) { e.preventDefault(); this.setVolume(this.state.volumeDb - 1, false); }
      else if (e.key.toLowerCase() === 'l') NowPlaying.toggle();
      else if (e.key.toLowerCase() === 'q') Drawer.toggle('queue');
      else if (e.key.toLowerCase() === 'd') Drawer.toggle('dsp');
      else if (e.key.toLowerCase() === 'm') $('#b-mute').click();
      else if (e.key.toLowerCase() === 'n' && e.ctrlKey) Host.call('next');
      else if (e.altKey && e.key === 'ArrowLeft') history.back();
      else if (e.altKey && e.key === 'ArrowRight') history.forward();
    });
    // mouse side buttons are handled natively by WebView2 (history back / forward)
  },
};

/* volume curve: slider position is linear in dB over 60 dB, with a steeper tail to silence */
function xToDb(x) { return x <= 0 ? -80 : x < 0.1 ? -60 - (0.1 - x) * 200 : (x - 1) * (60 / 0.9); }
function dbToX(db) { return db <= -80 ? 0 : db < -60 ? 0.1 - (-60 - db) / 200 : 1 + db * 0.9 / 60; }

function scrollTop(el) {
  const from = el.scrollTop;
  if (from <= 0) return;
  const dur = Math.min(520, 220 + from / 40), t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 4);
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    el.scrollTop = from * (1 - ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function throttle(f, ms) {
  let last = 0, t;
  return (...a) => {
    const now = Date.now();
    clearTimeout(t);
    if (now - last >= ms) { last = now; f(...a); }
    else t = setTimeout(() => { last = Date.now(); f(...a); }, ms - (now - last));
  };
}

/* ═════════════════════════════ slider ═════════════════════════════ */
function setSlider(el, x) {
  x = Math.max(0, Math.min(1, x || 0));
  el._x = x;
  el.querySelector('.fill').style.transform = `scaleX(${x})`;
  el.querySelector('.knob').style.left = (x * 100) + '%';
}
function slider(el, { start, move, end, tip }) {
  const tipEl = el.querySelector('.hover-tip');
  const at = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointermove', e => {
    if (!tip || !tipEl) return;
    const x = at(e);
    tipEl.textContent = tip(x);
    tipEl.style.left = (x * 100) + '%';
  });
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    el.classList.add('drag');
    start && start();
    const x = at(e); setSlider(el, x); move && move(x);
    const mv = ev => { const x = at(ev); setSlider(el, x); move && move(x); if (tip && tipEl) { tipEl.textContent = tip(x); tipEl.style.left = (x * 100) + '%'; } };
    const up = ev => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('drag');
      el.removeEventListener('pointermove', mv);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      end && end(at(ev));
    };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

/* ═════════════════════════════ popovers & menus ═════════════════════════════ */
/** The Rplay core's icon (shown only where the Rplay core is in use). */
const rplayIcon = (size = 18) => h('img', { class: 'rp-icon', src: 'img/rplay.png', width: size, height: size, alt: 'Rplay', draggable: 'false' });
/** The icon and the word "Rplay" as one rounded grey pill (the signal path popover's badge). */
const rplayBadge = (attrs = {}) => h('span', { class: 'rp-badge', ...attrs }, rplayIcon(18), 'Rplay');

const Popover = {
  el: null,
  show(content, anchor, opts = {}) {
    // a second click on the button that opened it closes it: the pointerdown (outside the popover) has just closed
    // it, so don't open it again from that click
    if (this.closedBy && this.closedBy === anchor && performance.now() - this.closedAt < 600) { this.closedBy = null; return null; }
    this.closedBy = null;
    this.close();
    const el = h('div', { class: 'pop ' + (opts.cls || '') }, content);
    document.body.append(el);
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x = opts.align === 'right' ? r.right - w : r.left;
    x = Math.max(8, Math.min(innerWidth - w - 8, x));
    el.style.left = x + 'px';
    // Pin the edge next to the anchor, so content that changes later (the output picker switching between ASIO and
    // WASAPI device lists) grows away from it instead of off the screen; it opens on the asked side unless the
    // content only fits on the other, and scrolls inside when it fits on neither.
    const spaceAbove = r.top - 10 - 8, spaceBelow = innerHeight - r.bottom - 6 - 8;
    const above = opts.above ? (hh <= spaceAbove || spaceAbove >= spaceBelow) : !(hh <= spaceBelow || spaceBelow >= spaceAbove);
    if (above) { el.style.bottom = (innerHeight - r.top + 10) + 'px'; el.style.maxHeight = Math.max(120, spaceAbove) + 'px'; }
    else { el.style.top = (r.bottom + 6) + 'px'; el.style.maxHeight = Math.max(120, spaceBelow) + 'px'; }
    el.style.overflowY = 'auto';
    this.el = el;
    YT.sync();
    setTimeout(() => {
      this.off = e => {
        if (el.contains(e.target)) return;
        if (anchor instanceof Element && anchor.contains(e.target)) { this.closedBy = anchor; this.closedAt = performance.now(); }
        this.close();
      };
      document.addEventListener('pointerdown', this.off, true);
    });
    return el;
  },
  close() {
    if (!this.el) return false;
    const el = this.el; this.el = null;
    document.removeEventListener('pointerdown', this.off, true);
    el.style.transition = 'opacity .15s'; el.style.opacity = 0;
    setTimeout(() => el.remove(), 150);
    YT.sync();
    return true;
  },
};

function menu(items, anchor, opts) {
  const box = h('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { box.append(h('hr')); continue; }
    if (!it) continue;
    box.append(h('button', { onclick: () => { Popover.close(); it.run(); }, html: icon(it.icon || 'note') + `<span>${esc(it.label)}</span>` }));
  }
  Popover.show(box, anchor, opts);
}

function trackMenu(t, anchor, list) {
  menu([
    { label: '播放', icon: 'play', run: () => App.playTracks(list || [t], list ? list.indexOf(t) : 0) },
    { label: '下一首播放', icon: 'next-up', run: () => { Host.call('queue.add', { ids: [t.id], next: true }); toast('已排在下一首'); } },
    { label: '加入播放佇列', icon: 'queue', run: () => { Host.call('queue.add', { ids: [t.id] }); toast('已加入佇列'); } },
    '-',
    { label: App.favs.has(t.id) ? '從最愛移除' : '加入我的最愛', icon: 'heart', run: () => App.toggleFav(t.id) },
    { label: '前往專輯', icon: 'album', run: () => go('#/album/' + t.albumId) },
    ...artistItems(t.artists?.length ? t.artists : [t.artist]),
    '-',
    { label: '在檔案總管中顯示', icon: 'folder', run: () => Host.call('reveal', { id: t.id }) },
  ], anchor);
}

/** The album's versions (other folders / formats) to switch to, from the format badge on its page. */
function versionMenu(al, anchor) {
  const vs = al.versions || [al];
  const artists = new Set(vs.map(v => v.artist));
  menu(vs.map(v => ({
    label: [qualityLabel(v), `${v.tracks.length} 首`, v.folder, artists.size > 1 ? v.artist : ''].filter(Boolean).join(' · '),
    icon: v === al ? 'check' : 'album',
    run: () => { if (v !== al) go('#/album/' + v.id); },
  })), anchor);
}

/** "Go to artist" menu items: one per artist when there are several. */
function artistItems(names) {
  names = names.filter(Boolean);
  return names.map(n => ({ label: names.length > 1 ? `前往演出者：${n}` : '前往演出者', icon: 'artist', run: () => go('#/artist/' + encodeURIComponent(n)) }));
}

function albumMenu(al, anchor) {
  menu([
    { label: '播放', icon: 'play', run: () => App.playTracks(al.tracks, 0, false) },
    { label: '隨機播放', icon: 'shuffle', run: () => App.playTracks(al.tracks, -1, true) },
    { label: '下一首播放', icon: 'next-up', run: () => { Host.call('queue.add', { ids: al.tracks.map(t => t.id), next: true }); toast('已排在下一首'); } },
    { label: '加入播放佇列', icon: 'queue', run: () => { Host.call('queue.add', { ids: al.tracks.map(t => t.id) }); toast(`已加入 ${al.tracks.length} 首`); } },
    '-',
    ...artistItems(al.artists.filter(realArtist)),
    { label: '更換封面…', icon: 'image', run: () => ArtPicker.open(al) },
    { label: '在檔案總管中顯示', icon: 'folder', run: () => Host.call('reveal', { id: al.tracks[0]?.id }) },
    '-',
    { label: '重新讀取專輯資訊', icon: 'refresh', run: () => rereadAlbum(al) },
  ], anchor);
}

/** Read the album's tags again (after editing them in another program) and show the page with the new data. */
async function rereadAlbum(al) {
  toast('正在重新讀取專輯資訊…');
  let r;
  try { r = await Host.call('album.reread', { id: al.id }); }
  catch (e) { toast('重新讀取失敗：' + e.message, { error: true }); return; }
  await Lib.load();
  App.trackKey = null;   // the track objects were rebuilt: the now-playing bar redraws with the new ones
  if (!r || !r.albumId) { toast('這張專輯的檔案已經不在了'); if (Router.cur.name === 'album') history.back(); return; }
  toast(`已重新讀取 ${r.tracks} 首`);
  const hash = '#/album/' + r.albumId;
  if (location.hash.startsWith('#/album/')) {
    // the id changes with the album title: replace the page instead of adding a history entry
    if (location.hash !== hash) history.replaceState({ i: Router.idx }, '', hash);
    Router.render(true, 'none');
  }
}

/* ═════════════════════════════ signal path ═════════════════════════════ */
const QLabel = { bitperfect: 'Bit-perfect', enhanced: '已處理', high: '高品質', low: '有損來源' };
const QLead = {
  bitperfect: '依目前訊號路徑設定，預期保持原始樣本數值。此標示未逐樣本驗證 DAC 端的資料。',
  enhanced: '訊號經過 DSP、重新取樣或數位音量處理（64-bit 浮點運算）。',
  high: 'Windows 混音器會依系統格式處理音訊。改用獨佔模式可達到 Bit-perfect。',
  low: '來源為有損壓縮格式。',
};
const SignalPop = {
  toggle(anchor) {
    if (Popover.el && Popover.el.classList.contains('sigpop')) return Popover.close();
    const sg = App.state.signal;
    const box = h('div');
    if (!sg) {
      box.append(h('h3', null, '訊號路徑'), h('div', { class: 'lead' }, '目前沒有播放中的曲目。'));
    } else {
      box.className = 'q-' + sg.quality;
      box.append(h('h3', { html: `<i class="dot"></i>${QLabel[sg.quality]}` }), h('div', { class: 'lead' }, QLead[sg.quality]));
      const stage = (k, v, mod) => h('div', { class: 'stage' }, h('i', { class: 'd' + (mod ? ' mod' : '') }), h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)));
      const src = sg.dsd ? `${sg.codec} · ${sg.dsdLabel} · ${(sg.sourceRate / 1e6).toFixed(4).replace(/0+$/, '')} MHz` : `${sg.codec} · ${sg.sourceBits ? sg.sourceBits + '-bit / ' : ''}${khz(sg.sourceRate)} kHz`;
      if (sg.rplay) this.drawRplay(box, sg, stage, src);
      else {
      box.append(stage('來源', src, false));
      if (sg.decoder) box.append(stage('解碼器', sg.decoder, false));
      const gain = sg.resamplerGainDb;
      const gainText = gain == null ? '' : Math.abs(gain) < 1e-9 ? ' · 維持原音量' : ` · ${gain > 0 ? '+' : ''}${gain} dB`;
      const bandwidthText = sg.resamplerBandwidth ? ` · 頻寬 ${Math.round(sg.resamplerBandwidth * 100)}%` : '';
      if (sg.dsdDirect) box.append(stage('DSD', `${sg.dsdTransport === 'Dop' ? 'DoP 封裝' : sg.dsdTransport === 'Dcs' ? 'dCS 封裝' : 'DSD 原生直送'} → ${khz(sg.outputRate)} kHz`, false));
      else if (sg.dop) box.append(stage('DSD', `DoP 封裝 → ${khz(sg.outputRate)} kHz`, false));
      else if (sg.dsd) box.append(stage('DSD 轉 PCM', `${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${gainText}`, true));
      else if (sg.resampled) box.append(stage('重新取樣', `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${bandwidthText}${gainText}`, true));
      if (sg.replayGainDb != null) box.append(stage('ReplayGain', `${sg.replayGainDb > 0 ? '+' : ''}${sg.replayGainDb.toFixed(1)} dB`, true));
      if (sg.dspActive && sg.dspSummary) box.append(stage('DSP', sg.dspSummary, true));
      const vm = sg.volumeMode;
      const db = App.state.volumeDb;
      box.append(stage('音量', vm === 'digital' ? (Math.abs(db) < 1e-9 ? '數位音量 · 0 dB（不處理）' : `數位音量 · ${db.toFixed(1)} dB`) : vm === 'hardware' ? `DAC 硬體音量 · ${db.toFixed(1)} dB` : vm === 'none' ? '無（請使用 DAC 旋鈕）' : '固定 0 dB', vm === 'digital' && Math.abs(db) > 1e-9));
      box.append(stage('輸出', `${sg.mode} · ${sg.device}`, false));
      box.append(stage('格式', `${sg.outputFormat} / ${khz(sg.outputRate)} kHz`, false));
      if (sg.mode && sg.mode.startsWith('WASAPI') && sg.eventDriven != null) box.append(stage('補充音訊方式', sg.eventDriven ? '事件驅動' : '定時喚醒', false));
      if (sg.quantization) box.append(stage('量化', sg.quantization, false));
      const meter = App.state.meter;
      if (sg.resampled && meter && meter.resampleMeterAvailable === true) {
        const peak = Number(meter.resamplePeak || 0);
        const db = peak > 0 ? (20 * Math.log10(peak)).toFixed(2) + ' dBFS' : '−∞ dBFS';
        box.append(stage('重取樣輸出峰值', db + ' · 已解碼區段，ReplayGain／DSP 前', peak > 1));
        box.append(h('div', { class: 'note' }, '解碼會預讀音訊；此數值是目前曲目已解碼區段的累積峰值，不是 DAC 即時量測。'));
        if (meter.resampleOverloads > 0) box.append(h('div', { class: 'note' }, `已有 ${meter.resampleOverloads.toLocaleString()} 個聲道樣本超過 0 dBFS；請自行調整數位音量或前級增益。`));
      } else if (sg.resampled) box.append(stage('重取樣峰值量測', '此播放內核未提供', false));
      if (sg.note) box.append(h('div', { class: 'note' }, sg.note));
      }
    }
    Popover.show(box, anchor, { cls: 'sigpop', above: true, align: 'right' });
  },
  /** The Rplay core's layout: decoder, then what the Core and the output side (輸出端) each do; the MIKU core keeps the one above. */
  drawRplay(box, sg, stage, src) {
    const rp = sg.rplay;
    box.append(stage('來源', src, false));
    const own = /^Rplay\s*/.exec(rp.decoder || '');   // decoded by Rplay itself
    box.append(stage('解碼', own ? [rplayBadge(), rp.decoder.slice(own[0].length)] : rp.decoder, false));
    box.append(h('div', { class: 'sig-sect' }, 'Core', rplayBadge()));
    (rp.core || []).forEach(r => box.append(stage(r.k, r.v, r.mod)));
    box.append(h('div', { class: 'sig-sect' }, '輸出端'));
    if (rp.dsd) box.append(stage('DSD 傳送', rp.dsd, false));
    const dsp = sg.dspActive && sg.dspSummary;
    if (dsp) box.append(stage('DSP', sg.dspSummary, true));
    const vm = sg.volumeMode, db = App.state.volumeDb;
    box.append(stage('音量', vm === 'digital' ? (Math.abs(db) < 1e-9 ? '數位音量 · 0 dB（不處理）' : `數位音量 · ${db.toFixed(1)} dB`) : vm === 'hardware' ? `DAC 硬體音量 · ${db.toFixed(1)} dB` : vm === 'none' ? '無（請使用 DAC 旋鈕）' : '固定 0 dB', vm === 'digital' && Math.abs(db) > 1e-9));
    // MIKU's DSP / digital volume change the samples on the output side, which then dithers them to the device's bits
    const touched = !sg.dsdDirect && (dsp || (vm === 'digital' && Math.abs(db) > 1e-9));
    if (touched && rp.deviceValidBits < 32) box.append(stage('量化', `TPDF 抖動 → ${rp.deviceValidBits}-bit（裝置有效位元）`, true));
    box.append(stage('輸出', `${sg.mode} · ${sg.device}`, false));
    box.append(stage('裝置格式', rp.deviceFormat, false));
    (rp.notes || []).forEach(n => box.append(h('div', { class: 'note' }, n)));
    if (rp.details) box.append(h('details', { class: 'sig-details' }, h('summary', null, '技術細節'), h('div', null, rp.details)));
  },
};

/* ═════════════════════════════ drawers ═════════════════════════════ */
const Drawer = {
  open: null,
  toggle(id) { this.open === id ? this.close() : this.show(id); },
  show(id) {
    if (this.open) $('#' + this.open).classList.remove('on');
    else OverlayHistory.push(this._close = fromPop => this.close(fromPop));
    this.open = id;
    $('#' + id).classList.add('on');
    $('#scrim').classList.add('on');
    if (id === 'queue') Queue.render(true);
    if (id === 'dsp') Dsp.render();
    YT.sync();
    $('#b-queue').classList.toggle('on', id === 'queue');
    $('#b-dsp').classList.toggle('on', id === 'dsp');
  },
  close(fromPop) {
    if (!this.open) return;
    $('#' + this.open).classList.remove('on');
    $('#scrim').classList.remove('on');
    this.open = null;
    if (fromPop !== true) OverlayHistory.closed(this._close);
    $('#b-queue').classList.remove('on'); $('#b-dsp').classList.remove('on');
    YT.sync();
  },
};
$('#scrim').onclick = () => Drawer.close();

/**
 * Full-screen layers (now playing, drawers, artwork picker) get their own history entry,
 * so the mouse back button / Alt+← closes the layer instead of navigating the page behind it.
 */
const OverlayHistory = {
  stack: [], ignore: 0, pending: null,
  push(close) {
    this.stack.push(close);
    history.pushState({ i: Router.idx, overlay: true }, '', location.hash);
  },
  closed(close) {
    const i = this.stack.lastIndexOf(close);
    if (i < 0) return;
    this.stack.splice(i, 1);
    this.ignore++;
    history.back();
  },
  /** Returns true when the popstate was consumed by an overlay. */
  onPop() {
    if (this.ignore > 0) {
      this.ignore--;
      if (!this.ignore && this.pending) { const [hash, rep] = this.pending; this.pending = null; setTimeout(() => go(hash, rep)); }
      return true;
    }
    const close = this.stack.pop();
    if (close) { close(true); return true; }
    return false;
  },
};
$$('[data-close]').forEach(b => b.onclick = () => Drawer.close());

/* ═════════════════════════════ queue ═════════════════════════════ */
const Queue = {
  render(scroll) {
    if (Drawer.open !== 'queue') return;
    const body = $('#queue-body');
    const { ids, index } = App.queue;
    body.textContent = '';
    if (!ids.length) { body.append(h('div', { class: 'muted', style: { padding: '40px 12px', textAlign: 'center' } }, '佇列是空的')); return; }
    const row = (id, i) => {
      const t = Lib.trackById.get(id);
      if (!t) return null;
      const r = h('div', { class: 'qrow' + (i === index ? ' cur' : '') + (i < index ? ' past' : ''), draggable: 'true', 'data-i': i },
        artBox('thumb', t.album?.loose ? 't' : 'a', t.album?.loose ? t.id : t.albumId, 48, t.album?.title),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, t.artist)),
        h('button', { class: 'icon-btn x', title: '移除', html: icon('x'), onclick: e => { e.stopPropagation(); Host.call('queue.remove', { i }); } }));
      r.ondblclick = () => Host.call('queue.jump', { i });
      r.oncontextmenu = e => { e.preventDefault(); trackMenu(t, { x: e.clientX, y: e.clientY }); };
      r.ondragstart = e => { e.dataTransfer.setData('text/plain', i); r.classList.add('dragging'); };
      r.ondragend = () => r.classList.remove('dragging');
      r.ondragover = e => { e.preventDefault(); r.classList.add('drop-above'); };
      r.ondragleave = () => r.classList.remove('drop-above');
      r.ondrop = e => { e.preventDefault(); r.classList.remove('drop-above'); const from = +e.dataTransfer.getData('text/plain'); if (from !== i) Host.call('queue.move', { from, to: from < i ? i - 1 : i }); };
      return r;
    };
    if (index >= 0) {
      body.append(h('div', { class: 'qsec' }, '正在播放'));
      body.append(row(ids[index], index));
    }
    const upcoming = ids.slice(index + 1);
    body.append(h('div', { class: 'qsec' }, `接下來 · ${upcoming.length} 首`, upcoming.length ? h('button', { onclick: () => Host.call('queue.clear') }, '清除') : null));
    // render a window to keep huge queues snappy
    upcoming.slice(0, 300).forEach((id, k) => body.append(row(id, index + 1 + k)));
    if (upcoming.length > 300) body.append(h('div', { class: 'muted', style: { padding: '10px' } }, `還有 ${upcoming.length - 300} 首…`));
    if (index > 0) {
      body.append(h('div', { class: 'qsec' }, '已播放'));
      ids.slice(Math.max(0, index - 50), index).forEach((id, k) => body.append(row(id, Math.max(0, index - 50) + k)));
    }
    if (scroll) body.scrollTop = 0;
  },
};

/* ═════════════════════════════ brand ═════════════════════════════ */
const Brand = {
  // Original MIKU wordmark v3: heavy rounded letters, the "I" is a little necktie, playhead timeline underneath.
  svg(height = 30) {
    const w = Math.round(height * 290 / 114);
    return `<svg class="wm" width="${w}" height="${height}" viewBox="-8 -8 290 114" aria-label="MIKU">
      <g fill="none" style="stroke:var(--brand-ink)" stroke-width="13" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 62V4L31 40L60 4V62"/><path d="M140 2V62M182 2L148 34M161 23L186 62"/><path d="M222 2V38a25 25 0 0 0 50 0V2"/>
      </g>
      <g stroke-linejoin="round" stroke-width="5">
        <path d="M100 17L95 17L89 49L100 63L111 49L105 17Z" style="fill:var(--teal);stroke:var(--teal)"/>
        <path d="M93.5 33L106 26M91.5 45L108.5 36" style="stroke:var(--tie-stripe, rgba(255,255,255,.55))" stroke-width="3" stroke-linecap="round" fill="none"/>
        <path d="M92 1H108L105 13H95Z" style="fill:var(--pink);stroke:var(--pink)"/>
      </g>
      <path d="M2 92H272" style="stroke:var(--brand-track)" stroke-width="6" stroke-linecap="round"/>
      <path d="M2 92H196" style="stroke:var(--teal)" stroke-width="6" stroke-linecap="round"/>
      <circle cx="196" cy="92" r="10" style="fill:var(--pink)"/><circle cx="196" cy="92" r="4" fill="#fff"/>
    </svg>`;
  },
};

/* ═════════════════════════════ search history ═════════════════════════════ */
const SearchHist = {
  el: null,
  list() { return App.settings.searchHistory || (App.settings.searchHistory = []); },
  add(q) {
    q = (q || '').trim();
    if (!q) return;
    const l = this.list().filter(x => x.toLowerCase() !== q.toLowerCase());
    l.unshift(q);
    if (l.length > 20) l.length = 20;
    App.settings.searchHistory = l;
    Host.call('search.add', { q });
  },
  remove(q) {
    App.settings.searchHistory = this.list().filter(x => x !== q);
    Host.call('search.remove', { q });
    this.list().length ? this.show() : this.hide();
  },
  clear() { App.settings.searchHistory = []; Host.call('search.clear'); this.hide(); },
  run(q) {
    const input = $('#q');
    input.value = q;
    this.add(q);
    this.hide();
    input.blur();
    go('#/search/' + encodeURIComponent(q), true);
  },
  show() {
    this.hide();
    const items = this.list();
    if (!items.length) return;
    const box = $('.search');
    const r = box.getBoundingClientRect();
    const el = h('div', { class: 'pop menu search-hist', style: { left: r.left + 'px', top: r.bottom + 6 + 'px', width: r.width + 'px' } },
      h('div', { class: 'sh-head' }, h('span', null, '最近搜尋'), h('a', { onclick: () => this.clear() }, '清除全部')));
    // keep focus in the search box while clicking inside the list
    el.addEventListener('mousedown', e => e.preventDefault());
    for (const q of items.slice(0, 10)) {
      el.append(h('div', { class: 'sh-row' },
        h('button', { class: 'sh-q', html: icon('clock') + `<span>${esc(q)}</span>`, onclick: () => this.run(q) }),
        h('button', { class: 'sh-x', title: '移除', html: icon('x'), onclick: e => { e.stopPropagation(); this.remove(q); } })));
    }
    document.body.append(el);
    this.el = el;
  },
  hide() { if (this.el) { this.el.remove(); this.el = null; } },
};
window.addEventListener('resize', () => SearchHist.hide());

/* ═════════════════════════════ router ═════════════════════════════ */
function go(hash, replace) {
  if (OverlayHistory.ignore > 0) { OverlayHistory.pending = [hash, replace]; return; }
  if (location.hash === hash) return;
  if (replace && Router.cur.name === 'search') { history.replaceState({ i: Router.idx }, '', hash); Router.render(false, 'fade'); return; }
  history.pushState({ i: ++Router.idx }, '', hash);
  Router.render(false, 'fwd');
}
const Router = {
  cur: { name: '' }, scrolls: {}, idx: 0,
  start() {
    window.addEventListener('popstate', e => {
      if (OverlayHistory.onPop()) return;
      let dir = 'fade';
      if (e.state && typeof e.state.i === 'number') { dir = e.state.i < this.idx ? 'back' : 'fwd'; this.idx = e.state.i; }
      else { this.idx++; history.replaceState({ i: this.idx }, '', location.hash); }   // sidebar link
      this.render(false, dir);
    });
    if (!location.hash) history.replaceState({ i: 0 }, '', '#/home');
    else history.replaceState({ i: 0 }, '', location.hash);
    this.render(false, 'fade');
  },
  parse() {
    const parts = location.hash.replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'home', arg: parts.slice(1).map(decodeURIComponent).join('/') };
  },
  render(keepScroll, dir = 'fade') {
    // VINYL theme: put the record back in its sleeve before leaving the album page
    if (!keepScroll && this.cur.name === 'album' && typeof Vinyl !== 'undefined' && Vinyl.beforeLeave(() => this.render(keepScroll, dir))) return;
    const content = $('#content');
    // leaving an album page: remember its cover so it can fly back into the grid
    if (this.cur.name === 'album' && !keepScroll) Flip.captureBack(this.cur.arg, $('.hero.album .cover'));
    if (this.cur.key) this.scrolls[this.cur.key] = content.scrollTop;
    const r = this.parse();
    r.key = location.hash;
    const same = this.cur.key === r.key;
    this.cur.cleanup && this.cur.cleanup();
    this.cur = r;
    $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.r === r.name || (r.name === 'album' && a.dataset.r === 'albums') || (r.name === 'artist' && a.dataset.r === 'artists')));
    NavPill.move();
    if (r.name !== 'search' && document.activeElement !== $('#q')) $('#q').value = '';
    const view = $('#view');
    view.textContent = '';
    view.classList.remove('enter', 'enter-fwd', 'enter-back', 'enter-fade', 'enter-flip');
    void view.offsetWidth;
    // a cover is flying: never fade the element it lands on (a fading parent is what made it flash)
    if (Flip.from && r.name === 'album' && Flip.from.id === r.arg) dir = 'flip';
    else if (Flip.back && r.name !== 'album') dir = 'none';
    Motion.quiet = dir === 'none';
    if (dir !== 'none' && (!keepScroll || !same)) view.classList.add('enter-' + dir);
    const fn = Views[r.name] || Views.home;
    r.cleanup = fn(view, r.arg) || null;
    if (typeof attachRailNav === 'function') attachRailNav(view);
    const y = keepScroll && same ? this.scrolls[r.key] : (this.scrolls[r.key] || 0);
    content.scrollTop = y || 0;
    content.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(() => { Motion.quiet = false; });
    if (Flip.back && r.name !== 'album') Flip.playBack();
    Views.markPlaying();
  },
};

/* ═════════════════════════════ motion helpers ═════════════════════════════ */
const Motion = { quiet: false };
/** Sliding highlight behind the active sidebar item. */
const NavPill = {
  el: null,
  move() {
    const nav = $('#nav');
    if (!this.el) { this.el = h('div', { class: 'nav-pill' }); nav.prepend(this.el); this.el.style.transition = 'none'; requestAnimationFrame(() => this.el.style.transition = ''); }
    const a = $('#nav a.on');
    if (!a) { this.el.style.opacity = 0; return; }
    this.el.style.opacity = 1;
    this.el.style.transform = `translateY(${a.offsetTop}px)`;
    this.el.style.left = a.offsetLeft + 'px';
    this.el.style.width = a.offsetWidth + 'px';
    this.el.style.right = 'auto';
  },
};
window.addEventListener('resize', () => NavPill.move());

/** Calls `f` once as soon as the user starts scrolling (wheel, touch, keys, scrollbar). Returns an unsubscribe function. */
function onUserScroll(f) {
  const evs = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const h = e => { if (e.type === 'keydown' && !/^(Arrow|Page|Home|End| )/.test(e.key)) return; off(); f(); };
  const off = () => evs.forEach(ev => window.removeEventListener(ev, h, true));
  evs.forEach(ev => window.addEventListener(ev, h, { capture: true, passive: true }));
  return off;
}

/** Shared-element transition: the clicked album cover flies into the album page header.
 *  No copy is made and nothing is swapped at the end: the REAL destination element is moved
 *  (FLIP: start where the source was, transform back to its own place). Under the destination's
 *  <img> we lay the already-loaded small picture, so it is visible from the first frame and the
 *  full-size image simply appears on top of an identical picture. Nothing can flash. */
function flipInto(el, from, src) {
  const t = el.getBoundingClientRect();
  if (!t.width || !from.width) return;
  let under = null;
  if (src) {
    under = h('img', { class: 'flip-under', src });
    el.prepend(under);
  }
  const dx = from.left - t.left, dy = from.top - t.top, sx = from.width / t.width, sy = from.height / t.height;
  Object.assign(el.style, { transition: 'none', transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, zIndex: 60, position: el.style.position || '' });
  // z-index only works inside the nearest stacking context: lift every positioned ancestor (card, grid row…)
  // up to the scroller as well, otherwise neighbouring cards painted later cover the flying cover
  const lifted = [];
  for (let p = el.parentElement; p && p.id !== 'content' && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.position !== 'static' || cs.transform !== 'none' || cs.zIndex !== 'auto' || +cs.opacity < 1) {
      lifted.push([p, p.style.zIndex, p.style.position]);
      if (cs.position === 'static') p.style.position = 'relative';
      p.style.zIndex = 60;
    }
  }
  void el.offsetWidth;
  const wild = typeof Blast !== 'undefined' && Blast.on;
  requestAnimationFrame(() => {
    let anim = null;
    if (wild) {
      // BLAST theme: a random, different crazy trajectory every time
      el.style.transform = '';
      const tm = Blast.flightTiming();
      anim = el.animate(Blast.flight(dx, dy, sx, sy), tm);
      anim.onfinish = () => end();
      setTimeout(() => end(), tm.duration + 200);
    } else {
      el.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)';
      el.style.transform = '';
    }
    let finished = false;
    const end = () => {
      if (finished) return; finished = true;
      stop();
      Object.assign(el.style, { transition: '', transformOrigin: '', zIndex: '' });
      lifted.forEach(([p, z, pos]) => { p.style.zIndex = z; p.style.position = pos; });
      if (under) {
        // drop the stand-in only once the real picture is fully shown on top of it
        const img = [...el.querySelectorAll('img')].find(i => i !== under);
        const drop = () => under.remove();
        if (!img) return;
        if (img.classList.contains('ok')) setTimeout(drop, 600);
        else { img.addEventListener('load', () => setTimeout(drop, 600), { once: true }); setTimeout(drop, 3000); }
      }
    };
    const stop = onUserScroll(() => { if (anim) anim.cancel(); el.style.transition = 'none'; el.style.transform = ''; end(); });
    if (!wild) {
      el.addEventListener('transitionend', e => { if (e.target === el && e.propertyName === 'transform') end(); });
      setTimeout(end, 650);
    }
  });
}
/** Flying back into a list: the card sits deep inside grid rows / rails with their own stacking and
 *  clipping, so instead of moving it in place we fly an exact clone of it (wrapped in .card so every theme
 *  rule still matches) on top of the whole page, then show the real card and drop the clone in the same frame. */
function flyBackClone(target, b) {
  const t = target.getBoundingClientRect();
  if (!t.width) return;
  const clone = target.cloneNode(true);
  clone.querySelectorAll('.play, .flip-under').forEach(n => n.remove());
  let img = clone.querySelector('img');
  if (!img) { img = h('img'); clone.append(img); }
  if (!img.classList.contains('ok')) { img.src = b.src; img.classList.add('ok'); }
  img.style.transition = 'none';
  Object.assign(clone.style, { width: t.width + 'px', height: t.height + 'px', margin: 0, transition: 'none', transform: 'none', animation: 'none' });
  const card = target.closest('.card');
  const wrap = h('div', { class: (card ? card.className : 'card') + ' flip-fly' }, clone);
  wrap.classList.remove('pop-in', 'playing');
  // clip the flight to the content area so the cover never flies over the player bar / sidebar
  const cr = ($('#content') || document.body).getBoundingClientRect();
  const clip = h('div', { class: 'flip-clip' });
  Object.assign(clip.style, { position: 'fixed', left: cr.left + 'px', top: cr.top + 'px', width: cr.width + 'px', height: cr.height + 'px', overflow: 'hidden', zIndex: 30, pointerEvents: 'none' });
  Object.assign(wrap.style, { position: 'absolute', left: (t.left - cr.left) + 'px', top: (t.top - cr.top) + 'px', width: t.width + 'px', margin: 0, zIndex: 1,
    pointerEvents: 'none', transformOrigin: '0 0', animation: 'none',
    transform: `translate(${b.rect.left - t.left}px, ${b.rect.top - t.top}px) scale(${b.rect.width / t.width}, ${b.rect.height / t.height})` });
  clip.append(wrap); document.body.append(clip);
  target.style.visibility = 'hidden';
  if (card) card.classList.add('flip-dest');                 // VINYL: the record travels inside the flying sleeve, not ahead of it
  const ti = target.querySelector('img'); if (ti) ti.style.transition = 'none';
  void wrap.offsetWidth;
  const wild = typeof Blast !== 'undefined' && Blast.on;
  requestAnimationFrame(() => {
    if (wild) {
      const start = wrap.style.transform, tm = Blast.flightTiming();
      wrap.style.transform = 'none';
      const kf = Blast.flight(b.rect.left - t.left, b.rect.top - t.top, b.rect.width / t.width, b.rect.height / t.height);
      kf[0] = { transform: start };
      const an = wrap.animate(kf, tm);
      an.onfinish = () => end();
      setTimeout(() => end(), tm.duration + 200);
    } else {
      wrap.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)';
      wrap.style.transform = 'none';
    }
    let finished = false;
    const end = () => {
      if (finished) return; finished = true;
      stop();
      target.style.visibility = '';
      if (card) card.classList.remove('flip-dest');
      requestAnimationFrame(() => clip.remove());
    };
    const stop = onUserScroll(end);
    if (!wild) {
      wrap.addEventListener('transitionend', e => { if (e.target === wrap) end(); });
      setTimeout(end, 650);
    }
  });
}
const Flip = {
  from: null,
  capture(id, artEl) {
    const img = artEl && artEl.querySelector('img.ok');
    this.from = img ? { id, rect: artEl.getBoundingClientRect(), src: img.src } : null;
  },
  back: null,
  captureBack(id, coverEl) {
    const img = coverEl && coverEl.querySelector('img.ok');
    this.back = img ? { id, rect: coverEl.getBoundingClientRect(), src: img.src } : null;
  },
  /** Fly the album page cover back onto its card in the list we returned to. */
  playBack() {
    const b = this.back;
    this.back = null;
    if (!b) return;
    // the album grid is virtualised: its cards are created a frame or two after the view, so wait for ours
    let tries = 0;
    const find = () => {
      const content = $('#content').getBoundingClientRect();
      const target = [...document.querySelectorAll(`[data-album="${CSS.escape(b.id)}"]`)].find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.bottom > content.top && r.top < content.bottom;
      });
      if (!target) { if (++tries < 20) requestAnimationFrame(find); return; }
      const card = target.closest('.card');
      if (card) { card.classList.remove('pop-in'); card.style.animation = 'none'; }
      flyBackClone(target, b);
    };
    requestAnimationFrame(find);
  },
  play(id, coverEl) {
    const f = this.from;
    this.from = null;
    if (!f || f.id !== id || !coverEl) return;
    // the router resets the scroll position right after the view is built; measure only after that,
    // otherwise the start point is off by the old scroll distance (the cover came "from below")
    Promise.resolve().then(() => flipInto(coverEl, f.rect, f.src));
  },
};

/** Material-style ripple on anything clickable. */
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('.btn, .icon-btn, .round-btn, .chip, .seg button, .sig, .out-btn, .playbtn, .outrow, .menu button');
  if (!el || e.button !== 0) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const rp = h('span', { class: 'ripple', style: { width: size + 'px', height: size + 'px', left: (e.clientX - r.left - size / 2) + 'px', top: (e.clientY - r.top - size / 2) + 'px' } });
  el.append(rp);
  setTimeout(() => rp.remove(), 600);
}, true);
