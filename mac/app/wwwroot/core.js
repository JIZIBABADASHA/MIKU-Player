'use strict';
/* ═════════════════════════════ host bridge ═════════════════════════════ */
const MEDIA = 'miku-media://media';
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
      msg.e ? p.reject(new Error(T.msg(msg.e))) : p.resolve(msg.r);
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
/** Shows an icon in `el`, rebuilding its <svg> only when the icon changes (states arrive several times a second). */
function setIcon(el, name, fill) { const k = fill ? name + '+' : name; if (el._icon !== k || !el.firstChild) { el._icon = k; el.innerHTML = icon(name, fill); } }
/** Sets text only when it differs: an unchanged write still replaces the text node (and wakes every MutationObserver). */
function setText(el, s) { s = String(s); if (el.textContent !== s) el.textContent = s; }
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = s => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const fmtLong = s => { const m = Math.round(s / 60); return m >= 60 ? T`${Math.floor(m / 60)} 小時 ${m % 60} 分鐘` : T`${m} 分鐘`; };
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
    // swap only once the new picture is decoded, otherwise the box shows one empty frame (a visible flash)
    next.onload = () => (next.decode ? next.decode().catch(() => {}) : Promise.resolve()).then(() => {
      if (!current.isConnected) return;
      next.className = 'ok'; next.style.transition = 'none'; current.replaceWith(next);
    });
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
  img.loading = box.classList.contains('art') ? 'lazy' : 'eager';
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
  document.querySelectorAll(`[data-art="${CSS.escape(k + ':' + id)}"]`).forEach(box => fillArt(box, k, id, +box.dataset.size, box.dataset.label, { swap: true }));
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
/** A track's picture as [kind, id]: a loose track (no album tag) has its own, any other its album's. */
const trackArt = t => t.album?.loose ? ['t', t.id] : ['a', t.albumId];
/** An album's picture as [kind, id]: a folder of loose tracks shows its first track's. */
const albumArt = al => al.loose && al.tracks[0] ? ['t', al.tracks[0].id] : ['a', al.id];
function artBox(cls, kind, id, size, label) {
  const box = h('div', { class: cls, 'data-art': `${kind}:${id}`, 'data-size': size, 'data-label': label || '' });
  fillArt(box, kind, id, size, label);
  if (id) ArtSharp.watch(box);
  return box;
}

/**
 * Keeps artwork sharp at any size: when a box grows past the picture it loaded (window made bigger, fewer albums
 * per row, moved to a higher-DPI screen), a bigger picture is loaded off-screen and swapped in. Never downsizes.
 */
const ArtSharp = {
  dpr: window.devicePixelRatio || 1,
  ro: new ResizeObserver(es => { for (const e of es) ArtSharp.check(e.target, e.contentRect.width); }),
  watch(box) { box.dataset.dpr = this.dpr; this.ro.observe(box); },
  release(root) {
    const unwatch = box => { this.ro.unobserve(box); clearTimeout(box._sharpT); };
    if (root.matches?.('[data-art][data-dpr]')) unwatch(root);
    root.querySelectorAll?.('[data-art][data-dpr]').forEach(unwatch);
  },
  check(box, w) {
    if (!box.isConnected) { this.ro.unobserve(box); return; }
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    const have = (+box.dataset.size || 0) * (+box.dataset.dpr || 1);   // device pixels already loaded
    if (w * Math.min(dpr, 2.5) <= have * 1.08) return;
    // only upgrade a picture that is already showing: swapping a box whose first picture is still loading would
    // rebuild it (placeholder flash) and wipe the stand-in a flying cover animation put there
    const size = Math.ceil(w / 64) * 64;   // round up, so a slow drag-resize asks for few sizes
    if (!box.querySelector('img.ok')) {
      // first picture not shown yet (e.g. right after start): just ask for the right size instead — one load, no swap
      const pending = box.querySelector('img:not(.flip-under)');
      if (pending && !pending.complete) {
        const a = box.dataset.art, i = a.indexOf(':');
        box.dataset.size = size; box.dataset.dpr = Math.min(dpr, 2.5);
        pending.src = artUrl(a.slice(0, i), a.slice(i + 1), size);
      } else if (pending && !pending._sharpWait) {
        pending._sharpWait = true;
        pending.addEventListener('load', () => setTimeout(() => this.check(box, box.clientWidth), 50), { once: true });
      }
      return;
    }
    box.dataset.size = size;
    box.dataset.dpr = Math.min(dpr, 2.5);
    clearTimeout(box._sharpT);
    box._sharpT = setTimeout(() => {
      if (!box.isConnected || !box.querySelector('img.ok')) return;
      const a = box.dataset.art, i = a.indexOf(':');
      fillArt(box, a.slice(0, i), a.slice(i + 1), +box.dataset.size, box.dataset.label, { swap: true });
    }, 200);
  },
  onDpr() {
    const mq = matchMedia(`(resolution: ${this.dpr}dppx)`);
    mq.addEventListener('change', () => {
      this.dpr = window.devicePixelRatio || 1;
      document.querySelectorAll('[data-art][data-dpr]').forEach(b => this.check(b, b.clientWidth));
      this.onDpr();
    }, { once: true });
  },
};
ArtSharp.onDpr();

/* ═════════════════════════════ library store ═════════════════════════════ */
/** Artist and genre tags: ';' separates several values ("ほぼ日P ;  初音ミク", "Niconico; Vocaloid"). */
const splitNames = s => {
  // some files carry the same name many times (several tag blocks / taggers): keep each name once
  const seen = new Set(), out = [];
  for (const x of (s || '').split(';')) { const v = x.trim(), k = v.toLowerCase(); if (v && !seen.has(k)) { seen.add(k); out.push(v); } }
  return out;
};
/** Several values shown as one text. */
const joinNames = names => names.join(' / ');
const realArtist = n => n && n !== 'Various Artists' && n !== '未知演出者';
/** The artist to put in an online search: the first name only, without "(CV. …)" (ArtworkService.SearchArtist). */
const searchArtist = s => {
  const first = splitNames(s).find(realArtist) || '';
  const bare = first.replace(/\s*[(（\[【][^)）\]】]*[)）\]】]/g, '').trim() || first;
  return (bare.split(/\s*(?:,|、|&|＆|×|\/|／|\bfeat\.?(?=\s)|\bft\.|\bwith\b)\s*/i).find(p => p.trim()) || bare).trim();
};
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
    // the folders the files are in (音樂庫 → 資料夾, folders.js); a library written by an older MIKU has none
    const dirs = Array.isArray(data.folders) ? data.folders : null;
    for (const a of data.albums) {
      const artists = splitNames(a[2]);
      const al = { id: a[0], title: a[1], artist: joinNames(artists), artists, year: a[3], genre: joinNames(splitNames(a[4])), added: a[5], hasArt: !!a[6], loose: !!a[7], vg: a[8] || '', folder: a[9] || '', tracks: [], dur: 0 };
      albums.push(al); albumById.set(al.id, al);
    }
    for (const r of data.tracks) {
      const artists = splitNames(r[2]);
      const t = { id: r[0], title: r[1], artist: joinNames(artists), artists, albumId: r[3], disc: r[4], no: r[5], dur: r[6], codec: r[7], rate: r[8], bits: r[9], year: r[10], composer: joinNames(splitNames(r[11])) };
      const al = albumById.get(t.albumId);
      t.added = r[12] ?? al?.added ?? 0;
      t.dir = dirs ? dirs[r[13]] || '' : '';
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
      // A newly imported version brings the album forward even when a better version already exists.
      g[0].added = Math.max(...g.map(al => al.added));
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
    for (const t of tracks) { t.s = norm(t.title + ' ' + t.artist + ' ' + (t.album ? t.album.title : '')); t.na = norm(t.artist); }
    const shownTracks = tracks.filter(t => !t.album?.hidden);
    const coll = new Intl.Collator(['ja', 'zh-Hant', 'en'], { sensitivity: 'base', numeric: true });
    Object.assign(this, {
      // albums / tracks: what lists show (one version per album); allAlbums / allTracks: everything
      albums: shown, tracks: shownTracks, allAlbums: albums, allTracks: tracks, albumById, trackById, artistMap, loaded: true, collator: coll, hasFolders: !!dirs,
      artists: [...artistMap.values()].sort((a, b) => coll.compare(a.name, b.name)),
    });
    $('#c-albums').textContent = shown.length || '';
    $('#c-artists').textContent = this.artists.length || '';
    $('#c-tracks').textContent = shownTracks.length || '';
  },
  /**
   * An album's id changes with its title / folder (tags saved, files renamed or replaced, read again). Old → new is
   * remembered, so a page or a history entry with the old id (going back, a pop-up closing onto it) opens the new one.
   */
  aliases: new Map(),
  renamed(oldId, newId) {
    if (!oldId || !newId || oldId === newId) return;
    this.aliases.set(oldId, newId);
    for (const [k, v] of this.aliases) if (v === oldId) this.aliases.set(k, newId);   // a chain of edits
  },
  resolve(id) { let n = id, i = 0; while (!this.albumById.has(n) && this.aliases.has(n) && i++ < 20) n = this.aliases.get(n); return this.albumById.has(n) ? n : null; },
  artistAlbums(name) {
    const own = this.artistMap.get(name)?.albums || [];
    const nn = norm(name);
    const mine = new Set(own);
    const appears = this.albums.filter(a => !mine.has(a) && a.tracks.some(t => t.na.includes(nn)));
    return { own: own.slice().sort((a, b) => (b.year || 0) - (a.year || 0)), appears };
  },
};

/* ═════════════════════════════ app state ═════════════════════════════ */
/* ═════════════════════════════ extension modules ═════════════════════════════ */
/**
 * Optional modules (MIKU.Extensibility/README.md). MIKU lists them in init.extensions; their scripts call
 * MikuExt.register({ id, init(api) }) and are set up before the first page is drawn. A module that fails to load
 * is logged and left out.
 */
/**
 * The player bar's left part (a module's slot, the cover, the title and artist, the heart) as one when the slot
 * changes (entering a module's list, leaving it, or one of its lists after another): the group there stays (a copy
 * over it) until the new track's title and cover have come (a moment after the list, at most 0.3 s), then fades away
 * in place while the new one slides in from the bar's left edge as a whole, every element keeping its place in it.
 * The picture of the old group is taken when a list is asked for (prepare): MIKU sends the new track's title and
 * cover a moment before the list's source, and the group must not change before it goes.
 */
const BarSwap = {
  FADE: 180, PUSH: 460, WAIT: 300, EASE: 'cubic-bezier(.16,.84,.3,1)',   // out of the edge at once, settling gently
  cur: null, pending: null,

  /** A still picture of the bar's left part as it is now (without ids, so the bar's own updates never reach it). */
  snapshot() {
    const bar = $('#bar'), mini = bar && $('.np-mini', bar);
    if (!mini) return null;
    const br = bar.getBoundingClientRect(), r = mini.getBoundingClientRect();
    if (!r.width) return null;
    const old = mini.cloneNode(true);
    old.classList.add('bar-swap-old');             // as it looks now: the title's entrance (.swap) and the like do not play again (app.css)
    const real = [...mini.querySelectorAll('[id]')];
    [...old.querySelectorAll('[id]')].forEach((el, i) => {
      if (real[i] && getComputedStyle(real[i]).display === 'none') el.style.display = 'none';   // hidden by an id rule (a narrow window's heart)
      el.removeAttribute('id');
    });
    Object.assign(old.style, { position: 'absolute', left: (r.left - br.left - bar.clientLeft) + 'px', top: (r.top - br.top - bar.clientTop) + 'px',
      width: r.width + 'px', height: r.height + 'px', margin: '0', pointerEvents: 'none', zIndex: '2' });
    return { old, track: App.state && App.state.trackId, at: performance.now() };
  },

  /** A new list is asked for: the bar's left part as it is, kept for a swap if the slot then changes (for 2 s). */
  prepare() { this.pending = this.snapshot(); },

  /** Starts a swap: returns go(), to call once the new slot is drawn. Null when there is nothing to animate. */
  begin() {
    const bar = $('#bar'), mini = bar && $('.np-mini', bar);
    const shot = this.pending && performance.now() - this.pending.at < 2000 ? this.pending : null;
    this.pending = null;
    if (!mini || document.hidden || Motion.quiet || matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    this.stop();
    // the group as it was when the list was asked for (or as it is now), over the real one
    const pic = shot || this.snapshot();
    if (!pic) return null;
    const old = pic.old, track = pic.track, t0 = performance.now();
    mini.after(old);
    mini.style.opacity = '0';                      // the new group out of sight until it comes in
    const run = this.cur = { old, mini, anims: [], frame: 0, fading: 0 };
    return () => {
      const step = () => {
        if (this.cur !== run) return;
        const t = performance.now() - t0;
        const arrived = (App.state && App.state.trackId) !== track;
        // the old group stays until the new track is there; then it fades, and a third into that the new one comes
        if (!run.fading && !arrived && t < this.WAIT) { run.frame = requestAnimationFrame(step); return; }
        if (!run.fading) {
          run.fading = t;
          run.anims.push(old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: this.FADE, easing: 'ease-out', fill: 'forwards' }));
        }
        if (t - run.fading < this.FADE / 3) { run.frame = requestAnimationFrame(step); return; }
        setTimeout(() => old.remove(), this.FADE);
        // in from the bar's left edge: moved by its right end's distance from that edge, and cut off at the edge on
        // the way (keyframes along the path: the cut is exact, and both share the one easing)
        const nr = mini.getBoundingClientRect(), nb = bar.getBoundingClientRect();
        const off = nr.left - nb.left, d = off + nr.width;
        const frames = [];
        for (let k = 0; k <= 10; k++) {
          const q = 1 - k / 10;
          frames.push({ offset: k / 10, transform: `translateX(${-d * q}px)`, clipPath: `inset(0 0 0 ${Math.max(0, d * q - off)}px)`, opacity: Math.min(1, 0.15 + k / 6) });
        }
        mini.style.opacity = '';
        const a = mini.animate(frames, { duration: this.PUSH, easing: this.EASE });
        run.anims.push(a);
        a.onfinish = a.oncancel = () => { if (this.cur === run) this.cur = null; };
      };
      run.frame = requestAnimationFrame(step);
    };
  },

  /** A swap still running ends at once (another one starts). */
  stop() {
    const run = this.cur;
    if (!run) return;
    this.cur = null;
    cancelAnimationFrame(run.frame);
    run.old.remove();
    run.anims.forEach(a => a.cancel());
    run.mini.style.opacity = '';
  },
};

const MikuExt = {
  defs: {}, settings: {}, slots: {}, paths: {}, labels: {}, menus: {}, queueHeads: {}, slotKey: null, slotDef: null, slotSeq: 0, slotDrawn: false,
  /** MIKU swaps the bar's left part as a whole when a module's slot changes (BarSwap): modules leave their slot's own entrances and exits. */
  swapsBar: true,
  register(def) { if (def && def.id) this.defs[def.id] = def; },

  /**
   * What the bar's slot shows for a queue: its source (a module's list), or, while the queue goes on with a module's
   * Smart Playlist (「佇列播完後」 handed to it) and plays its part, { ext, smart: true }. Kept as queue.slotSource.
   */
  slotSource(q) {
    const c = q && q.continued;
    const src = q && q.source ? q.source : c && q.index >= c.from ? { ext: c.ext, smart: true } : null;
    if (q) q.slotSource = src;
    return src;
  },

  /** The modules' items for a context menu (addMenu): kind 'track' (t, list) or 'album' (al); after a separator. */
  menuItems(kind, ...args) {
    const items = [];
    for (const fn of this.menus[kind] || []) {
      try { for (const it of fn(...args) || []) if (it && it.label && it.run) items.push(it); }
      catch (e) { console.error('[ext] menu', e); }
    }
    return items.length ? ['-', ...items] : [];
  },

  async load(list) {
    for (const x of list || []) {
      try {
        for (const href of x.styles || []) document.head.append(h('link', { rel: 'stylesheet', href }));
        for (const src of x.scripts || []) {
          await new Promise((ok, fail) => document.head.append(h('script', { src, onload: ok, onerror: () => fail(new Error('cannot load ' + src)) })));
        }
        const def = this.defs[x.id];
        if (def && def.init) await def.init(this.api(x.id));
      } catch (e) { console.error('[ext]', x.id, e); }
    }
  },

  /**
   * While the queue was started by a module with a source: the module draws the player bar's slot (left of the
   * cover) and the now-playing page's slot, and <html data-ext-source="<id>"> lets its stylesheet restyle both.
   * Redrawn when the source changes; cleared when something else is played.
   */
  slot(source) {
    const def = source && source.ext && this.slots[source.ext];
    const key = def ? JSON.stringify(source) : null;
    if (key === this.slotKey) return;
    const prevSource = this.slotKey ? JSON.parse(this.slotKey) : null;
    this.slotKey = key;
    // a change after the page came up, or one a list asked for: the bar's left part goes and comes as a whole,
    // unless the module keeps it (its slot's swap(prev, next) says no: one of its lists after another it shows itself)
    const keep = def && prevSource && prevSource.ext === source.ext && def.swap && def.swap(prevSource, source) === false;
    if (keep) BarSwap.pending = null;
    const swap = !keep && (this.slotDrawn || BarSwap.pending) ? BarSwap.begin() : null;
    this.slotDrawn = true;
    const prev = this.slotDef;
    this.slotDef = def || null;
    const leaving = ++this.slotSeq;
    if (def) document.documentElement.dataset.extSource = source.ext;
    else delete document.documentElement.dataset.extSource;
    for (const [sel, fn] of [['#b-ext', def && def.bar], ['#np-ext', def && def.nowPlaying]]) {
      const el = $(sel);
      // leaving a module's list: its bar slot may play a way out (leaveBar, at most a second) before it is emptied;
      // not while the bar's left part is swapped as a whole
      if (!swap && !def && sel === '#b-ext' && prev && prev.leaveBar && !el.hidden) {
        let out;
        try { out = prev.leaveBar(el); } catch (e) { console.error('[ext]', e); }
        Promise.race([Promise.resolve(out), new Promise(r => setTimeout(r, 1000))]).then(() => {
          if (this.slotSeq === leaving) { el.textContent = ''; el.hidden = true; }
        });
        continue;
      }
      el.textContent = '';
      el.hidden = !fn;
      if (fn) try { fn(el, source); } catch (e) { console.error('[ext]', source.ext, e); }
    }
    if (swap) swap();
  },

  /** What a module gets: its own RPC and events, playback, and places in the sidebar, the router and the settings. */
  api(id) {
    return {
      id,
      rpc: (method, args) => Host.call(`ext.${id}.${method}`, args),
      on: (ev, f) => Host.on(`ext.${id}.${ev}`, f),
      /**
       * Play a list. opts.at: where the first track starts (seconds); opts.source: what made the list (any JSON
       * object), kept with the queue and handed to the module's playerSlot until something else is played.
       */
      play: (ids, shuffle = false, start = -1, opts = {}) => {
        BarSwap.prepare();                         // the bar's left part as it is, in case this list changes its slot
        return Host.call('play', { ids, shuffle, start, at: opts.at || 0, source: opts.source ? { ...opts.source, ext: id } : undefined });
      },
      /**
       * { bar(el, source), nowPlaying(el, source), leaveBar(el) }: draw the player bar's and the now-playing page's
       * slots while a list this module played with a source is the queue; leaveBar (optional) plays the bar slot's
       * way out when another list is played, and returns a promise (waited for up to a second).
       */
      playerSlot: def => { this.slots[id] = def; this.slotKey = null; this.slot(this.slotSource(App.queue)); },
      /** A sidebar link to #/<route>; after = the data-r of the link to follow (default: before the 系統 section). */
      addNav: ({ route, label, icon: svg, after }) => {
        const a = h('a', { href: '#/' + route, 'data-r': route, html: svg || '' }, h('span', null, label));
        const prev = after && $(`#nav a[data-r="${after}"]`);
        if (prev) prev.after(a);
        else { const labels = $$('#nav .nav-label'); labels.length ? labels[labels.length - 1].before(a) : $('#nav').append(a); }
        return a;
      },
      addRoute: (name, fn) => {
        if (Views[name]) throw new Error(`route "${name}" exists`);
        Views[name] = fn;
      },
      /**
       * A settings block: fn(host, { section, field, sw, select, core }). place: a tab (audio / library / look / other,
       * at its end), or 'core' (under 播放方案: the chosen core's own settings), 'dsd' (end of the DSD section),
       * 'about' (in 關於, after MIKU). core: the chosen playback core ({ id, name, … }).
       */
      addSettings: (tab, fn) => (this.settings[tab] = this.settings[tab] || []).push(fn),
      /** fn(box, signal, { stage, src, khz }): draw the signal path when this module's core reports one (SignalInfo.Custom). */
      signalPath: fn => { this.paths[id] = fn; },
      /**
       * fn() → a node: how the playback core `coreId` (a core this module provides) is shown in the 播放方案 menu, in
       * place of its name (a wordmark, …). The menu keeps the name for assistive technology.
       */
      coreLabel: (coreId, fn) => { this.labels['core:' + coreId] = fn; },
      /**
       * Items in a context menu: kind 'track' → fn(track, list) or 'album' → fn(album) returns [{ label, icon, run }]
       * (or nothing), shown after MIKU's play and queue items.
       */
      addMenu: (kind, fn) => (this.menus[kind] = this.menus[kind] || []).push(fn),
      /**
       * fn(el, source): a header at the top of the queue drawer (what made the list, what comes after it); source is
       * the queue's (any module's, or null). Drawn each time the queue is; leave el empty for none.
       */
      queueHead: fn => { this.queueHeads[id] = fn; },
      /** fn() → a node: this module's mark before 「… 已開啟」 under 佇列播完後 while its queue continuation is on. */
      continueMark: fn => { this.labels.continue = fn; },
    };
  },
};

const App = {
  settings: {}, state: {}, queue: { ids: [], index: -1 }, favs: new Set(),
  posBase: 0, posAt: 0, seeking: false, fullscreen: false, fullscreenHideTimer: 0, fullscreenPointerY: null,

  async start() {
    this.drawBrand();
    this.bindBar();
    this.bindKeys();
    this.bindFullscreenControls();
    Host.on('state', s => this.setState(s));
    Host.on('queue', q => { this.queue = q; Queue.render(); Views.markPlaying(); MikuExt.slot(MikuExt.slotSource(q)); });
    Host.on('error', e => toast(T.msg(e.message), { error: true }));
    // settings the host changed by itself (YouTube Music's own output mode switched in and out)
    Host.on('settings', s => { Object.assign(this.settings, s); if (typeof Outputs !== 'undefined') Outputs.label(); if (typeof YT !== 'undefined' && YT.drawOut) YT.drawOut(); });
    // phone remote: show the pairing code a phone asked for, and keep favourites in sync with it
    Host.on('remotePair', p => toast(T`「${p.name}」要求用手機遙控 MIKU，配對碼：${p.code}`, { ms: 180000 }));
    Host.on('remotePaired', p => toast(T`「${p.name}」已配對，可以用手機遙控了`));
    Host.on('favs', f => { this.favs = new Set(f || []); this.renderFav(); });
    Host.on('scan', p => this.scan(p));
    Host.on('fullscreen', ({ on }) => this.syncFullscreen(on));
    Host.on('library', async () => {
      const before = Lib.albums.length + ':' + Lib.tracks.length;
      const had = Lib.loaded ? Lib.allTracks.length : -1;
      await Lib.load();
      this.redrawTrack(); // the track objects were rebuilt: redraw the now-playing bar with the new ones
      // music copied into a library folder while MIKU is open (the host's folder watcher): say so; a scan shows its own progress
      const grew = had >= 0 ? Lib.allTracks.length - had : 0;
      if (grew > 0 && !this.scanning) toast(T`已加入 ${grew} 首新歌曲`);
      // during a scan only refresh pages that list the library, and do it silently
      if (before !== Lib.albums.length + ':' + Lib.tracks.length && ['home', 'albums', 'artists', 'tracks', 'folders'].includes(Router.cur.name)) Router.render(true, 'none');
    });
    const init = await Host.call('ready');
    this.settings = init.settings;
    if (await I18N.sync(init)) return;   // the interface language changed: the page reloads
    PageEffects.sync();
    NavPick.apply();
    if (typeof Theme !== 'undefined') Theme.sync();
    this.favs = new Set(init.settings.favorites || []);
    this.lastRecent = (init.settings.recent || [])[0] || null;
    this.queue = init.queue;
    this.ffmpeg = init.ffmpeg;
    this.loudness = init.loudness || null;   // a module that measures loudness: its name (ReplayGain, settings.js)
    this.continuation = init.continuation || null;   // a module that chooses what plays when the queue runs out: its name (settings.js)
    // the playback cores: MIKU's own and those of extension modules (Settings → 播放方案)
    this.cores = init.cores && init.cores.length ? init.cores : [{ id: 'miku', name: 'FFmpeg', dsdPcmRate: true }];
    this.version = init.version;
    this.scan(init.scan);
    await Lib.load();
    this.trackKey = null; // states received while the library was loading may have drawn an empty now-playing bar
    this.setState(init.state);
    this.renderFav();
    await MikuExt.load(init.extensions);   // extension modules, before the first page is drawn
    Outputs.refresh();
    ScrollBubble.init();
    Router.start();
    this.frame();
    if (!init.ffmpeg) toast(T('找不到 FFmpeg，請在設定確認 FFmpeg 已安裝並加入 PATH。'), { error: true, ms: 9000 });
  },

  drawBrand() {
    $('#brand').innerHTML = Brand.svg(34);
  },

  bindFullscreenControls() {
    // reveal: touch the top edge, or move upward inside the top band; stays while the pointer is
    // in the zone around the button (no gap between band and button); hides after a grace delay.
    const button = $('#fullscreen-exit');
    const EDGE = 6, BAND = 56, ZONE = 104, GRACE = 140;
    const clearHide = () => { clearTimeout(this.fullscreenHideTimer); this.fullscreenHideTimer = 0; };
    const show = () => { clearHide(); button.classList.add('is-visible'); };
    const hide = () => { clearHide(); button.classList.remove('is-visible'); };
    const scheduleHide = (delay = GRACE) => {
      if (this.fullscreenHideTimer) return;
      this.fullscreenHideTimer = setTimeout(() => {
        this.fullscreenHideTimer = 0;
        if (this.fullscreen && !button.matches(':hover')) button.classList.remove('is-visible');
      }, delay);
    };
    button.addEventListener('click', () => { hide(); Host.call('fullscreen', { on: false }); });
    button.addEventListener('pointerenter', clearHide);
    button.addEventListener('pointerleave', () => scheduleHide());
    document.addEventListener('pointermove', e => {
      const previousY = this.fullscreenPointerY;
      const y = this.fullscreenPointerY = e.clientY;
      if (!this.fullscreen) return;
      const shown = button.classList.contains('is-visible');
      if (y <= EDGE || (y <= BAND && previousY != null && y < previousY - 1)) show();
      else if (shown && y <= ZONE) clearHide();
      else if (shown) scheduleHide();
    }, { passive: true });
    document.addEventListener('pointerleave', () => {
      this.fullscreenPointerY = null;
      if (this.fullscreen) scheduleHide();
    });
    window.addEventListener('blur', hide);
  },

  syncFullscreen(on) {
    this.fullscreen = on;
    document.documentElement.classList.toggle('fullscreen', on);
    clearTimeout(this.fullscreenHideTimer);
    this.fullscreenHideTimer = 0;
    this.fullscreenPointerY = null;
    $('#fullscreen-exit').classList.remove('is-visible');
  },

  scan(p) {
    if (!p) return;
    this.scanning = !!p.scanning;
    const el = $('#sidefoot');
    if (p.scanning) {
      const pct = p.found ? Math.min(100, p.done / p.found * 100) : 0;
      el.innerHTML = T`<div class="scanline"><span class="txt">掃描曲庫</span><div class="bar"><i style="width:${pct}%"></i></div><span class="num">${p.done}/${p.found || '…'}</span></div>`;
    } else el.textContent = '';
  },

  /* ── state ── */
  setState(s) {
    const prev = this.state;
    // the first track of a module's Smart Playlist comes: the bar's left part as it is, before it shows that track
    // (the queue, which changes the slot, may come a moment later)
    const q = this.queue, c = q && q.continued;
    if (c && !q.source && prev && s.trackId !== prev.trackId && q.ids && s.trackId === q.ids[c.from]) BarSwap.prepare();
    this.state = s;
    // after a seek, ignore stale positions until the engine reports the new one
    const settling = this.seekUntil && performance.now() < this.seekUntil && Math.abs(s.pos - this.seekTarget) > 1.2;
    if (!settling) this.seekUntil = 0;
    if (!this.seeking && !settling) { this.posBase = s.pos; this.posAt = performance.now(); }
    const key = this.syncTrack(s);
    if (s.playing && s.meter && s.meter.resampleMeterAvailable === true && s.meter.resampleOverloads > 0 && this.overloadWarningTrack !== key) {
      this.overloadWarningTrack = key;
      toast(T('重取樣輸出峰值超過 0 dBFS。請在訊號路徑查看已解碼區段的量測，並自行調整數位音量或前級增益。'), { error: true, ms: 9000 });
    }
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
    const modes = s.shuffle + '|' + s.repeat;
    if (this.modesShown !== modes) for (const p of ['b', 'np']) {
      this.modesShown = modes;
      $(`#${p}-shuffle`).classList.toggle('on', !!s.shuffle);
      const rep = $(`#${p}-repeat`);
      rep.classList.toggle('on', s.repeat !== 'off');
      setIcon(rep, s.repeat === 'one' ? 'repeat1' : 'repeat');
    }
    if (prev.volumeDb !== s.volumeDb || prev.muted !== s.muted || prev.volumeMode !== s.volumeMode) this.renderVolume();
    const sg = s.signal;
    const signalKey = [s.trackId, sg?.quality, sg?.dspActive, sg?.dsd, sg?.dsdLabel, sg?.sourceBits, sg?.sourceRate, sg?.codec, sg?.dop, sg?.outputRate, sg?.outputFormat, sg?.physicalFormat, sg?.mode, sg?.device, sg?.replayGainDb, sg?.note].join('|');
    if (this.signalKey !== signalKey) { this.signalKey = signalKey; this.renderSignal(); }
    this.kick();
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
    else if (t) { const [kind, id] = trackArt(t); art.dataset.art = kind + ':' + id; art.dataset.size = 64; fillArt(art, kind, id, 64, t.album?.title); }
    else art.textContent = '';
    this.renderFav();
    document.title = t ? `${t.title} · ${t.artist} — MIKU` : 'MIKU';
    NowPlaying.trackChanged(t);
    Views.markPlaying();
  },

  /** Draws the now-playing bar when the state's track differs from the one drawn. Returns the track's key. */
  syncTrack(s) {
    const key = s.trackId + '|' + (s.live ? s.live.title + '|' + s.live.artist : '');
    if (this.trackKey !== key) { this.trackKey = key; this.trackChanged(); }
    // states arrive before the library has loaded at startup (library.json can take a moment): a local track that
    // isn't in Lib yet was drawn empty, so don't remember it as drawn and try again with the next state
    if (s.trackId && !s.live && !Lib.trackById.has(s.trackId)) this.trackKey = null;
    return key;
  },
  /** The library was loaded again (its track objects are new): draw the now-playing bar from them now. */
  redrawTrack() {
    this.trackKey = null;
    if (this.state.trackId !== undefined) this.syncTrack(this.state);
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
    setIcon(b, on ? 'heartf' : 'heart');
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
    const display = mode === 'fixed' ? 'none' : '';  // fixed (bit-perfect) volume: nothing to adjust, hide it
    if (vol.style.display !== display) vol.style.display = display;
    const db = s.volumeDb ?? -20;
    const x = s.muted ? 0 : dbToX(db);
    if (!this.volDrag) setSlider($('#b-volslider'), x);
    setText($('#b-db'), mode === 'fixed' ? '0 dB' : s.muted ? T('靜音') : (db <= -79.5 ? '−∞' : (db === 0 ? '0' : '−' + Math.abs(db).toFixed(1)) + ' dB'));
    const mute = $('#b-mute');
    setIcon(mute, s.muted || db <= -79.5 ? 'mute' : db < -30 ? 'vollow' : 'vol');
    const title = mode === 'fixed' ? T('固定音量（Bit-perfect）') : T('靜音 (M)');
    if (mute.title !== title) mute.title = title;
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
    // upsampling wears the badge of its own card (app.css .sig.upsample), like Hi-Res, DSD and DSP wear theirs
    const cls = 'sig' + (sg ? ' q-' + sigQuality(sg) : '') + sigShine(sg) + (sg && SigCard.kind(sg) === 'upsample' ? ' upsample' : '');
    if (el.className !== cls) el.className = cls;
    if (!sg) { setText($('#b-sigtxt'), this.state.trackId ? T('已停止') : T('未播放')); return; }
    const src = sg.dsd ? sg.dsdLabel : `${sg.sourceBits || ''}${sg.sourceBits ? '/' : ''}${khz(sg.sourceRate)}`;
    setText($('#b-sigtxt'), `${sg.codec} ${src}${sg.dop ? ' · DoP' : ''}`);
  },

  /* ── frame loop: progress bars & lyrics ── */
  lastSec: -1, frameRaf: 0, frameTimer: 0,
  /** Draw now unless the per-frame loop is already running (it draws the next frame anyway: no second style pass). */
  kick() { if (!(this.state.playing && this.frameRaf)) this.frame(); },
  frame() {
    cancelAnimationFrame(this.frameRaf); clearTimeout(this.frameTimer);
    this.frameRaf = this.frameTimer = 0;
    // Paused progress is redrawn by state/seek events; a hidden page needs no visual loop at all.
    if (document.hidden || this.uiVisible === false) return;
    const el = this.frameEls || (this.frameEls = {
      seek: $('#b-seek'), npSeek: $('#np-seek'), pos: $('#b-pos'), dur: $('#b-dur'), npPos: $('#np-pos'), npDur: $('#np-dur'),
    });
    const s = this.state, pos = this.pos, dur = s.dur || 0;
    const x = dur > 0 ? pos / dur : 0;
    if (!this.seeking) { setSlider(el.seek, x); if (NowPlaying.open) setSlider(el.npSeek, x); }
    const sec = Math.floor(pos);
    if (sec !== this.lastSec || this.durShown !== dur) {
      this.lastSec = sec; this.durShown = dur;
      el.pos.textContent = fmtTime(pos); el.dur.textContent = fmtTime(dur);
      el.npPos.textContent = fmtTime(pos); el.npDur.textContent = '−' + fmtTime(Math.max(0, dur - pos));
    }
    NowPlaying.tick(pos);
    if (!s.playing) return;
    // The next draw comes when something on screen changes: the progress bar by half a pixel, the time by a second,
    // the lyrics by a line. Only word-by-word lyrics are drawn every frame. (A draw per frame kept the page, the
    // compositor and the GPU process awake 60–120 times a second for changes nobody can see.)
    let wait = NowPlaying.nextTick(pos);
    if (wait <= 0) { this.frameRaf = requestAnimationFrame(() => this.frame()); return; }
    const bar = NowPlaying.open ? el.npSeek : el.seek, w = bar.offsetWidth;
    if (dur > 0 && w > 0) wait = Math.min(wait, dur / (w * 2));
    wait = Math.min(wait, sec + 1 - pos + .005);
    this.frameTimer = setTimeout(() => this.frame(), Math.max(33, Math.min(500, wait * 1000)));
  },

  /* ── commands ── */
  playTracks(list, start = 0, shuffle) {
    if (!list.length) return;
    BarSwap.prepare();                             // the bar's left part as it is, in case this list changes its slot
    const a = { ids: list.map(t => t.id), start };
    if (shuffle !== undefined) a.shuffle = shuffle;
    Host.call('play', a);
  },
  toggle() { Host.call('toggle'); },
  seek(pos) {
    this.posBase = pos; this.posAt = performance.now();
    this.seekTarget = pos; this.seekUntil = performance.now() + 2500;
    this.kick();
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
    // a click on an empty part of the bar (not a button, link, slider or the cover) raises the now-playing page too;
    // the press must also start there, so ending a seek/volume drag over the bar doesn't open it
    const barCtl = 'button, a, input, .slider, .vol, .np-ext, #b-title, #b-artist';
    let barDown = null;
    $('#bar').addEventListener('pointerdown', e => { barDown = e.target.closest(barCtl) ? null : e.target; });
    $('#bar').addEventListener('click', e => {
      const fromBlank = barDown && !e.target.closest(barCtl);
      barDown = null;
      if (!fromBlank || e.button !== 0 || String(getSelection()).trim()) return;
      if (!NowPlaying.open) NowPlaying.show();
      // over Now Playing (brought back with the 「顯示播放列」 handle): the same click puts the bar away again
      else if (window.BarPeek && BarPeek.on) BarPeek.hide();
    });
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
    // double-click the sidebar item of the page you're on (or its list, e.g. 專輯 from an album) to jump to the top
    $('#nav').addEventListener('dblclick', e => {
      const a = e.target.closest('a[data-r]');
      if (a && a.classList.contains('on')) { e.preventDefault(); scrollTop(content); }
    });
    content.addEventListener('scroll', () => $('#topbar').classList.toggle('solid', content.scrollTop > 8), { passive: true });
  },

  bindKeys() {
    // shortcuts are user-adjustable: keys.js (Settings → 快捷鍵); Esc and F12 are fixed
    document.addEventListener('keydown', e => {
      if (Keys.recording) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if (e.key === 'F12' || (e.metaKey && e.altKey && e.key.toLowerCase() === 'i')) { Host.call('devtools'); return; }
      if (e.key === 'Escape' && !typing) { if (CoverView.close()) return; if (ArtPicker.close()) return; if (Popover.close()) return; if (Drawer.open) return Drawer.close(); if (NowPlaying.open) return NowPlaying.hide(); if (this.fullscreen) return Host.call('fullscreen', { on: false }); return; }
      Keys.handle(e, typing);
    });
    // mouse side buttons: handled in mac-bridge.js
  },
};

/* volume curve: slider position is linear in dB over 60 dB, with a steeper tail to silence */
function xToDb(x) { return x <= 0 ? -80 : x < 0.1 ? -60 - (0.1 - x) * 200 : (x - 1) * (60 / 0.9); }
function dbToX(db) { return db <= -80 ? 0 : db < -60 ? 0.1 - (-60 - db) / 200 : 1 + db * 0.9 / 60; }

function scrollTop(el) {
  if (PageEffects.reduced('scroll')) { el.scrollTop = 0; return; }
  const from = el.scrollTop;
  if (from <= 0) return;
  const dur = Math.min(520, 220 + from / 40), t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 4);
  const step = now => {
    const t = Math.min(1, (now - t0) / dur);
    el.scrollTop = from * (1 - ease(t));
    if (PageEffects.reduced('scroll')) el.scrollTop = 0;
    else if (t < 1) requestAnimationFrame(step);
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
  if (el._x === x) return;
  el._x = x;
  const p = el._parts || (el._parts = [el.querySelector('.fill'), el.querySelector('.knob')]);
  p[0].style.transform = `scaleX(${x})`;
  p[1].style.left = (x * 100) + '%';
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

/** One item of a menu (its key, when given, marks it for items added later: albumMenu's CUE item). */
const menuButton = it => h('button', { 'data-key': it.key || null, onclick: () => { Popover.close(); it.run(); },
  html: icon(it.icon || 'note') + `<span>${esc(it.label)}</span>` });

/** A menu of items ('-' a line); it comes in fading only (menu-pop): items that moved under the pointer as it came in lost the click. */
function menu(items, anchor, opts = {}) {
  const box = h('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { box.append(h('hr')); continue; }
    if (!it) continue;
    box.append(menuButton(it));
  }
  Popover.show(box, anchor, { ...opts, cls: ((opts.cls || '') + ' menu-pop').trim() });
  return box;
}

function trackMenu(t, anchor, list) {
  menu([
    { label: T('播放'), icon: 'play', run: () => App.playTracks(list || [t], list ? list.indexOf(t) : 0) },
    { label: T('下一首播放'), icon: 'next-up', run: () => { Host.call('queue.add', { ids: [t.id], next: true }); toast(T('已排在下一首')); } },
    { label: T('加入播放佇列'), icon: 'queue', run: () => { Host.call('queue.add', { ids: [t.id] }); toast(T('已加入佇列')); } },
    ...MikuExt.menuItems('track', t, list),
    '-',
    { label: App.favs.has(t.id) ? T('從最愛移除') : T('加入我的最愛'), icon: 'heart', run: () => App.toggleFav(t.id) },
    { label: T('前往專輯'), icon: 'album', run: () => go('#/album/' + t.albumId) },
    ...artistItems(t.artists?.length ? t.artists : [t.artist]),
    '-',
    { label: T('轉換格式…'), icon: 'refresh', run: () => Convert.open({ album: null, tracks: [t] }) },
    { label: T('在檔案總管中顯示'), icon: 'folder', run: () => Host.call('reveal', { id: t.id }) },
  ], anchor);
}

/** The album's versions (other folders / formats) to switch to, from the format badge on its page. */
function versionMenu(al, anchor) {
  const vs = al.versions || [al];
  const artists = new Set(vs.map(v => v.artist));
  menu(vs.map(v => ({
    label: [qualityLabel(v), T`${v.tracks.length} 首`, v.folder, artists.size > 1 ? v.artist : ''].filter(Boolean).join(' · '),
    icon: v === al ? 'check' : 'album',
    run: () => { if (v !== al) go('#/album/' + v.id); },
  })), anchor);
}

/** "Go to artist" menu items: one per artist when there are several. */
function artistItems(names) {
  names = names.filter(Boolean);
  return names.map(n => ({ label: names.length > 1 ? T`前往演出者：${n}` : T('前往演出者'), icon: 'artist', run: () => go('#/artist/' + encodeURIComponent(n)) }));
}

/** An album's menu. On its own page (onPage) the page already has 播放 / 隨機 and the artist links: left out. */
async function albumMenu(al, anchor, onPage) {
  // 「按 CUE 標記切開…」 only when the album's folder has a CUE sheet for its big file. The menu does not wait for that
  // (a busy disk can take a while, and a menu that comes late comes as the click does): an answer within 80 ms is in
  // it, a later one adds the item to it then
  const cuePromise = Convert.cueFor(al);
  const cue = await Promise.race([cuePromise, new Promise(r => setTimeout(() => r(undefined), 80))]);
  const cueItem = c => ({ label: T`按 CUE 標記切開（${c.tracks.length} 首）…`, icon: 'list', run: () => Convert.open({ album: al, cue: c }) });
  const box = menu([
    !onPage && { label: T('播放'), icon: 'play', run: () => App.playTracks(al.tracks, 0, false) },
    !onPage && { label: T('隨機播放'), icon: 'shuffle', run: () => App.playTracks(al.tracks, -1, true) },
    { label: T('下一首播放'), icon: 'next-up', run: () => { Host.call('queue.add', { ids: al.tracks.map(t => t.id), next: true }); toast(T('已排在下一首')); } },
    { label: T('加入播放佇列'), icon: 'queue', run: () => { Host.call('queue.add', { ids: al.tracks.map(t => t.id) }); toast(T`已加入 ${al.tracks.length} 首`); } },
    ...MikuExt.menuItems('album', al),
    '-',
    ...(onPage ? [] : artistItems(al.artists.filter(realArtist))),
    // one entry: the cover view shows the picture and leads on to 更換封面 / 寫入音樂檔案
    { label: T('封面…'), icon: 'image', run: () => CoverView.open(al) },
    { label: T('編輯標籤…'), icon: 'list', run: () => TagEditor.open(al) },
    { key: 'convert', label: T('轉換格式…'), icon: 'refresh', run: () => Convert.open({ album: al, tracks: al.tracks }) },
    cue && cueItem(cue),
    { label: T('在檔案總管中顯示'), icon: 'folder', run: () => Host.call('reveal', { id: al.tracks[0]?.id }) },
    '-',
    { label: T('重新讀取專輯資訊'), icon: 'refresh', run: () => rereadAlbum(al) },
  ], anchor);
  if (cue === undefined) cuePromise.then(c => { if (c && box.isConnected) box.querySelector('[data-key="convert"]')?.after(menuButton(cueItem(c))); });
}

/** Read the album's tags again (after editing them in another program) and show the page with the new data. */
async function rereadAlbum(al) {
  toast(T('正在重新讀取專輯資訊…'));
  let r;
  try { r = await Host.call('album.reread', { id: al.id }); }
  catch (e) { toast(T('重新讀取失敗：') + e.message, { error: true }); return; }
  await Lib.load();
  App.redrawTrack();   // the track objects were rebuilt: the now-playing bar redraws with the new ones
  if (!r || !r.albumId) { toast(T('這張專輯的檔案已經不在了')); if (Router.cur.name === 'album') history.back(); return; }
  Lib.renamed(al.id, r.albumId);
  toast(T`已重新讀取 ${r.tracks} 首`);
  const hash = '#/album/' + r.albumId;
  if (location.hash.startsWith('#/album/')) {
    // the id changes with the album title: replace the page instead of adding a history entry
    if (location.hash !== hash) history.replaceState({ i: Router.idx }, '', hash);
    Router.render(true, 'none');
  }
}

/* ═════════════════════════════ signal path ═════════════════════════════ */
const QLabel = { bitperfect: 'Bit-perfect', enhanced: T('已處理'), high: T('無損'), low: T('有損來源') };
/** The badge's quality, the same rule for every playback core: a resampled or converted path (upsampling, DSD → PCM,
 *  PCM → DSD) is 已處理 even when a core reports it as bit-perfect. DSP on wins over everything: the card is DSP's
 *  alone (已處理, its slime, its backs), never mixed with the lossy warning or the upsampling face. */
const sigQuality = sg => sg.dspActive ? 'enhanced' : sg.quality === 'bitperfect' && sg.resampled ? 'enhanced' : sg.quality;
/**
 * The badge's extra shine, the same for every playback core. Bit-perfect: DSD sent as DSD glows (DSD), hi-res (above
 * 16-bit / 48 kHz) sparkles (Hi-Res), CD-quality WAV / FLAC keeps the plain bit-perfect ring. Resampled or converted
 * (upsampling, DSD → PCM, PCM → DSD): the plain 已處理 badge for now. DSP on, whatever else is going on: toxic slime.
 */
const sigShine = sg => {
  if (!sg) return '';
  if (sg.dspActive) return ' dsp';
  if (sg.resampled) return '';
  if (sigQuality(sg) !== 'bitperfect') return '';
  if (sg.dsd) return ' dsd';
  return (sg.sourceBits || 0) > 16 || (sg.sourceRate || 0) > 48000 ? ' hires' : '';
};
const QLead = {
  bitperfect: T('依目前訊號路徑設定，預期保持原始樣本數值。此標示未逐樣本驗證 DAC 端的資料。'),
  enhanced: T('訊號經過 DSP、重新取樣或數位音量處理（64-bit 浮點運算）。'),
  high: T('無損音訊以 Core Audio 輸出；此路徑未確認原始樣本數值。'),
  low: T('來源為有損壓縮格式：部分聲音資訊在壓縮時已被永久丟棄，無法還原。'),
};
/** One stage of the signal path card: its dot (pink when it changes the samples), label and value. */
const sigStage = (k, v, mod) => h('div', { class: 'stage' }, h('i', { class: 'd' + (mod ? ' mod' : '') }), h('div', null, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)));

/**
 * The signal path card's shared layout, for a core that reports SignalInfo.Path (or a module's own path through
 * drawPath): sections of stages in processing order, each one line; a stage with details, or whose line does not fit,
 * folds and opens on a click. pin: lines under the summary shown all the time (the decoder). A module may put its
 * mark after a section's title and on a pin (opts.mark); in a title the mark takes the stages' text colour.
 */
const SigPath = {
  draw(box, path, opts = {}) {
    const tx = s => typeof s === 'string' ? T.msg(s) : s;
    for (const sect of (path && path.sections) || []) {
      box.append(h('div', { class: 'sig-sect' }, tx(sect.title), sect.mark && opts.mark ? h('span', { class: 'sp-mark' }, opts.mark()) : null));
      for (const r of sect.rows || []) {
        const line = h('span', { class: 'sp-line' }, tx(r.v));
        const pins = (r.pin || []).map(p => h('div', { class: 'sp-pin' }, h('span', null, tx(p.k)),
          p.mark && opts.mark ? opts.mark() : h('span', { class: 'sp-pin-v' }, tx(p.v))));
        const more = (r.more || []).length ? h('div', { class: 'sp-more' }, ...r.more.map(x => h('div', null, tx(x)))) : null;
        const el = sigStage(tx(r.k), [line, ...pins, more].filter(Boolean), r.mod);
        el.classList.add('sp-row');
        const fold = () => {
          if (!more && line.scrollWidth <= line.clientWidth + 1) return;
          el.classList.add('sp-fold');
          // a folding stage is a control: opening it must not turn the signal card over
          el.onclick = e => { e.stopPropagation(); el.classList.toggle('sp-open'); };
        };
        if (more) fold(); else requestAnimationFrame(fold);   // a long line folds once it is laid out
        box.append(el);
      }
    }
    for (const n of (path && path.notes) || []) box.append(h('div', { class: 'note' }, tx(n)));
    // a mark in a title takes the stages' text colour, not the title's (read once the card is shown); the mark's own
    // style applies on top of it, as it does on a pin. Its children are put back in after the colour changes: Chromium
    // does not recompute a child's color-mix(currentColor ...) when the parent's colour changes later
    requestAnimationFrame(() => {
      const line = box.querySelector('.sp-line');
      const c = line && line.isConnected ? getComputedStyle(line).color : '';
      if (c) box.querySelectorAll('.sig-sect .sp-mark').forEach(m => { m.style.color = c; m.replaceChildren(...m.childNodes); });
    });
  },
};

const SignalPop = {
  toggle(anchor) {
    if (Popover.el && Popover.el.classList.contains('sigpop')) return Popover.close();
    // texts made by the host (output mode, format, notes …) in the interface language
    const sg0 = App.state.signal;
    const sg = sg0 && Object.assign({}, sg0, Object.fromEntries(['mode', 'outputFormat', 'decoder', 'quantization', 'dspSummary', 'note', 'resampler']
      .filter(k => typeof sg0[k] === 'string').map(k => [k, T.msg(sg0[k])])));
    const box = h('div');
    if (!sg) {
      box.append(h('h3', null, T('訊號路徑')), h('div', { class: 'lead' }, T('目前沒有播放中的曲目。')));
    } else {
      const shine = sigShine(sg);
      const q = sigQuality(sg);
      // upsampling wears its own face (app.css .up): the rate in big numerals and an engraved waveform under the title
      const up = SigCard.kind(sg) === 'upsample';
      box.className = 'q-' + q + shine + (up ? ' up' : '');
      box.append(h('h3', { html: `<i class="dot"></i>${QLabel[q]}${up ? ' · ' + T('升頻') : shine === ' hires' ? ' · Hi-Res' : shine === ' dsd' ? ' · DSD' : ''}` }));
      if (up) {
        const x = sg.outputRate / sg.sourceRate;
        box.append(h('div', { class: 'up-hero', html: `<span class="up-from">${esc(khz(sg.sourceRate))}</span><i class="up-arrow"></i><b class="up-to">${esc(sg.outputRate >= 1e6 ? (sg.outputRate / 1e6).toFixed(4).replace(/\.?0+$/, '') : khz(sg.outputRate))}</b><span class="up-unit">${sg.outputRate >= 1e6 ? 'MHz' : 'kHz'}</span><span class="up-x">×${+x.toFixed(2)}</span>` }), h('i', { class: 'up-wave', 'aria-hidden': 'true' }));
      }
      box.append(h('div', { class: 'lead' }, QLead[q]));
      const stage = sigStage;
      // a lossy source has no bit depth of its own (the decoder's word length is not the file's): codec and rate only
      const src = sg.dsd ? `${sg.codec} · ${sg.dsdLabel} · ${(sg.sourceRate / 1e6).toFixed(4).replace(/0+$/, '')} MHz` : `${sg.codec} · ${sg.sourceBits && !SigCard.lossy(sg) ? sg.sourceBits + '-bit / ' : ''}${khz(sg.sourceRate)} kHz`;
      // a module's core may draw its own path (SignalInfo.Custom, MikuExt signalPath)
      const custom = sg.custom && MikuExt.paths[sg.custom.ext];
      if (custom) { try { custom(box, sg, { stage, src, khz, drawPath: (path, o) => SigPath.draw(box, path, o) }); } catch (e) { console.error('[ext] signal path', e); } }
      else if (sg.path) {
        // the shared layout (the core describes its own stages), then the resampler's live peak when the core measures it
        SigPath.draw(box, sg.path);
        SignalPop.meterRows(box, sg);
      }
      else {
      box.append(stage(T('來源'), src, false));
      if (sg.decoder) box.append(stage(T('解碼器'), sg.decoder, false));
      const gain = sg.resamplerGainDb;
      const gainText = gain == null ? '' : Math.abs(gain) < 1e-9 ? T(' · 維持原音量') : ` · ${gain > 0 ? '+' : ''}${gain} dB`;
      const bandwidthText = sg.resamplerBandwidth ? T` · 頻寬 ${Math.round(sg.resamplerBandwidth * 100)}%` : '';
      if (sg.dsdDirect) box.append(stage('DSD', `${sg.dsdTransport === 'Dop' ? T('DoP 封裝') : sg.dsdTransport === 'Dcs' ? T('dCS 封裝') : T('DSD 原生直送')} → ${khz(sg.outputRate)} kHz`, false));
      else if (sg.dop) box.append(stage('DSD', T`DoP 封裝 → ${khz(sg.outputRate)} kHz`, false));
      else if (sg.dsd) box.append(stage(T('DSD 轉 PCM'), T`${khz(sg.dsdPcmRate || App.settings.dsdPcmRate || 176400)} kHz · FFmpeg · 預留 1 dB`, true));
      if (sg.resampled) box.append(stage(T('重新取樣'), `${khz(sg.dsd ? (sg.dsdPcmRate || App.settings.dsdPcmRate || 176400) : sg.sourceRate)} → ${khz(sg.outputRate)} kHz · ${sg.resampler || 'Core Audio'}`, true));
      if (sg.replayGainDb != null) box.append(stage('ReplayGain', `${sg.replayGainDb > 0 ? '+' : ''}${sg.replayGainDb.toFixed(1)} dB`, true));
      if (sg.dspActive && sg.dspSummary) box.append(stage('DSP', sg.dspSummary, true));
      const vm = sg.volumeMode;
      const db = App.state.volumeDb;
      box.append(stage(T('音量'), vm === 'digital' ? (Math.abs(db) < 1e-9 ? T('數位音量 · 0 dB（不處理）') : T`數位音量 · ${db.toFixed(1)} dB`) : vm === 'hardware' ? T`DAC 硬體音量 · ${db.toFixed(1)} dB` : vm === 'none' ? T('無（請使用 DAC 旋鈕）') : T('固定 0 dB'), vm === 'digital' && Math.abs(db) > 1e-9));
      box.append(stage(T('輸出'), `${sg.mode} · ${sg.device}`, false));
      box.append(stage(T('格式'), `${sg.outputFormat} / ${khz(sg.outputRate)} kHz`, false));
      if (sg.physicalFormat) box.append(stage(T('DAC 格式'), `${sg.physicalFormat} / ${khz(sg.outputRate)} kHz`, false));
      if (sg.mode && sg.mode.startsWith('WASAPI') && sg.eventDriven != null) box.append(stage(T('補充音訊方式'), sg.eventDriven ? T('事件驅動') : T('定時喚醒'), false));
      if (sg.quantization) box.append(stage(T('量化'), sg.quantization, false));
      if (!SignalPop.meterRows(box, sg) && sg.resampled) box.append(stage(T('重取樣峰值量測'), T('此播放內核未提供'), false));
      if (sg.note) box.append(h('div', { class: 'note' }, sg.note));
      }
    }
    const pop = Popover.show(box, anchor, { cls: 'sigpop', above: true, align: 'right' });
    if (pop && SigCard.eligible(sg)) SigCard.attach(pop, sg);
  },
  /** The resampler's peak while the track is resampled, when the core measures it; false when it does not. */
  meterRows(box, sg) {
    const meter = App.state.meter;
    if (!sg.resampled || !meter || meter.resampleMeterAvailable !== true) return false;
    const peak = Number(meter.resamplePeak || 0);
    const db = peak > 0 ? (20 * Math.log10(peak)).toFixed(2) + ' dBFS' : '−∞ dBFS';
    box.append(sigStage(T('重取樣輸出峰值'), db + T(' · 已解碼區段，ReplayGain／DSP 前'), peak > 1));
    box.append(h('div', { class: 'note' }, T('解碼會預讀音訊；此數值是目前曲目已解碼區段的累積峰值，不是 DAC 即時量測。')));
    if (meter.resampleOverloads > 0) box.append(h('div', { class: 'note' }, T`已有 ${meter.resampleOverloads.toLocaleString()} 個聲道樣本超過 0 dBFS；請自行調整數位音量或前級增益。`));
    return true;
  },
};

/* ═════════════ the signal card: every kind of signal has its own card back ═════════════
   Double-click a blank part of the signal card (not on its text, not on a control) and it turns over to a back made
   for that kind of signal; double-click anywhere on the back to turn it again. The card does not follow the pointer.
     upsample  升頻          black lacquer, gold filigree, a rosette and a faceted star (the original back)
     hires     Hi-Res        ivory pearl, champagne gold, a laurel wreath round the bit depth
     dsd       DSD           midnight indigo, platinum, a 1-bit pulse-density ring round an opal
     cd        Bit-perfect   CD-quality lossless, the everyday card: matte slate card stock, a thin border, a disc in line
     enhanced  已處理         graphite, polished copper, an engine-turned gear round a faceted hexagon
     dsp       DSP           the 2004 school slide: MS Paint shapes with googly eyes on magenta, rainbow WordArt
     shared    高品質         plum lacquer, rose gold, a watch dial and a compass rose
     lossy     有損來源        lossy, the cheap card: flat dull stock, the 8×8 blocks of the compression, a disc in coarse pixels
   The art is drawn here (SVG), its colours and textures come from app.css (.sigpop[data-back]). Reduced motion /
   輕量化「頁面與操作動畫」: the card turns without animation. 輕量化「資訊卡翻轉」: the card does not turn over at all
   (a card already on its back can still be turned to the front). */
const SigCard = {
  eligible: sg => !!sg,
  calm: () => matchMedia('(prefers-reduced-motion: reduce)').matches || PageEffects.reduced('page'),
  n: 0,
  lossy: sg => !!sg.lossy || sg.quality === 'low' || /^(mp[123]|aac|he-?aac|ogg|vorbis|opus|wma|ac-?3|e-?ac-?3|dts|mpc|musepack|speex|amr)\b/i.test(String(sg.codec || '').trim()),
  /** Which back: the same split as the badge (quality + shine), with upsampling kept apart from other processing. */
  kind(sg) {
    // DSP on comes first, whatever the source or the path (lossy, upsampled …): DSP's backs only, nothing mixed in
    if (sg.dspActive) return 'dsp';
    // a lossy source is lossy whatever else is done to it (upsampling): it never gets a fancy card
    if (this.lossy(sg)) return 'lossy';
    if (sg.resampled) return !sg.dsd && sg.outputRate > sg.sourceRate ? 'upsample' : 'enhanced';
    const shine = sigShine(sg).trim(), q = sigQuality(sg);
    if (shine === 'dsp') return 'dsp';
    if (q === 'bitperfect') return shine === 'dsd' ? 'dsd' : shine === 'hires' ? 'hires' : 'cd';
    return q === 'high' ? 'shared' : q === 'low' ? 'lossy' : 'enhanced';
  },
  attach(pop, sg) {
    const kind = this.kind(sg);
    const back = h('div', { class: 'sig-back', 'aria-hidden': 'true', html: this.art(sg, kind) });
    pop.classList.add('sig-card');
    // the card sits on whole pixels and on its own layer all the time (app.css .sig-card): when a turn ends nothing is
    // redrawn, so its text and art don't twitch by a fraction of a pixel as the 3D turn hands back to the flat page
    for (const k of ['left', 'top', 'bottom']) if (pop.style[k]) pop.style[k] = Math.round(parseFloat(pop.style[k])) + 'px';
    pop.dataset.back = kind;
    pop.append(back);
    if (kind === 'dsp') pop.dataset.ugly = back.querySelector('.sb-u').dataset.u;
    let turning = false, flipped = false, scroll = 0;
    // The back is not shown (display: none) until the card is turned: once the card is open it is laid out, hidden, its
    // loops held (app.css .sb-warm), so the turn only has to show it. (The GPU's first drawing of a back: prime below.)
    const warm = () => { if (back.isConnected && !flipped) back.classList.add('sb-warm'); };
    setTimeout(() => (window.requestIdleCallback || (f => setTimeout(f, 0)))(warm, { timeout: 400 }), 450);
    const tf = (turn = 0, lift = 0) => `perspective(1400px) translateZ(${lift}px) rotateY(${turn}deg)`;
    // blank: not on a control and not on a glyph of text (the empty part of a line, the gaps between rows, the padding)
    const onText = (x, y) => {
      const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
      const n = r && r.startContainer;
      if (!n || n.nodeType !== 3 || !pop.contains(n)) return false;
      const g = document.createRange();
      for (const o of [r.startOffset - 1, r.startOffset]) {
        if (o < 0 || o >= n.length) continue;
        g.setStart(n, o); g.setEnd(n, o + 1);
        for (const b of g.getClientRects()) if (x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 1 && y <= b.bottom + 1) return true;
      }
      return false;
    };
    const blank = e => flipped || (!PageEffects.reduced('card') && !e.target.closest('a, button, input, select, textarea, summary, label, .sp-fold') && !onText(e.clientX, e.clientY));
    // the second press of a double-click would select a word next to the blank spot: not on the card's blank parts
    pop.addEventListener('mousedown', e => { if (e.detail > 1 && e.button === 0 && blank(e)) e.preventDefault(); });
    pop.addEventListener('dblclick', e => {
      if (e.button !== 0 || turning || !blank(e)) return;
      e.preventDefault();
      const s = getSelection(); if (s && !String(s).trim()) s.removeAllRanges();
      turn();
    });
    const turn = async () => {
      const to = !flipped;
      const swap = () => {
        if (to) { scroll = pop.scrollTop; pop.scrollTop = 0; pop.style.overflowY = 'hidden'; }
        // DSP: a different ugly back every time it is turned over
        if (to && kind === 'dsp') { back.innerHTML = this.art(sg, kind); pop.dataset.ugly = back.querySelector('.sb-u').dataset.u; }
        back.classList.toggle('sb-warm', !to);   // shown: its loops run; turned away: kept ready for the next turn
        pop.classList.toggle('sig-flipped', to);
        if (!to) { pop.style.overflowY = 'auto'; pop.scrollTop = scroll; }
        flipped = to;
        if (to) this.shine(back);
      };
      if (this.calm() || !pop.animate) { swap(); return; }
      turning = true;
      // first half: the face turns away (and darkens) as the card lifts; the other face comes round already lit
      const away = pop.animate([
        { transform: tf(), filter: 'brightness(1)' },
        { transform: tf(90, 30), filter: 'brightness(.55)' },
      ], { duration: 150, easing: 'cubic-bezier(.45, 0, .85, .5)', fill: 'forwards' });
      try { await away.finished; } catch { turning = false; return; }
      swap();
      // the other face comes round and stops square: no overshoot, so nothing on it sways as it lands
      // it reaches exactly flat a little before the end and holds there, so the last frames already look like the card
      // at rest (an easing tail would leave it a hair off flat, slightly soft, then sharp the moment the turn ends)
      const back2 = pop.animate([
        { transform: tf(-90, 30), filter: `brightness(${to ? 1.3 : 1.2})`, easing: 'cubic-bezier(.15, .6, .25, 1)' },
        { transform: 'none', filter: 'none', offset: .8 },
        { transform: 'none', filter: 'none' },
      ], { duration: 300 });
      away.cancel();
      try { await back2.finished; } catch { }
      turning = false;
    };
  },
  /**
   * The first turn of a session stalled for a quarter of a second in the frame where the card is edge-on: the GPU
   * compiled the shaders for the backs' metals, conic gradients, glows and blends the first time one was drawn (a trace:
   * one raster flush of ~110 ms). Drawing them on the card when it opens only moved the stall under the card's own
   * shimmer, so once per session, a few seconds after start-up while the page is idle, the backs are drawn once, all but
   * invisibly (app.css .sb-primer): every kind but DSP's (a new one at every turn), each with its own palette and
   * patterns.
   */
  prime() {
    if (this.primedAll || this.calm() || PageEffects.reduced('card')) return;
    if (document.hidden) { document.addEventListener('visibilitychange', () => this.prime(), { once: true }); return; }
    this.primedAll = true;
    const sg = { codec: 'FLAC', sourceBits: 16, sourceRate: 44100, dspSummary: '', dsdLabel: 'DSD64' };
    const host = h('div', { class: 'sb-primer', 'aria-hidden': 'true' });
    for (const kind of ['upsample', 'hires', 'dsd', 'enhanced', 'shared', 'cd', 'lossy'])
      host.append(h('div', { class: 'sigpop sig-card sig-flipped', 'data-back': kind }, h('div', { class: 'sig-back', html: this.art(sg, kind) })));
    document.body.append(host);
    setTimeout(() => host.remove(), 1500);
  },
  /** The one-shot light that runs over the back as it lands. */
  shine(back) { back.classList.remove('sb-land'); void back.offsetWidth; back.classList.add('sb-land'); },

  /** Each back's metal and stones. metal: the 9 stops of the metal gradient (dark → bright → dark …, polished);
   *  A / B / L: the metal's mid, light and lightest tone, D: the dark engraving line, K: the medallion's well,
   *  disc: the medallion field (centre → edge), gem: a stone (light, mid, deep), hi / lo: lit and shaded facets. */
  pal: {
    upsample: { metal: ['#5a3d0c', '#c89b40', '#fff3c6', '#d9a944', '#7d5714', '#e6bf62', '#fff8dc', '#c4932f', '#6a4810'], A: '#c99a3e', B: '#e9c46a', L: '#fff3c6', D: '#3a2707', K: '#0b0803', disc: ['#2c210c', '#120d05', '#050402'], gem: ['#fff', '#ffeaa8', '#a7741f'], hi: ['#fffbe8', '#e9c060'], lo: ['#b07c22', '#4e340a'], petal: ['#fff3c8', '#f0cd73', '#b9862c', '#5c3f0d'] },
    hires: { metal: ['#6b4a1a', '#c9a35a', '#fff6dc', '#e2bf74', '#8c6526', '#efd28e', '#fffaea', '#c99d4c', '#74521c'], A: '#b8914a', B: '#d8b46a', L: '#fff6dc', D: '#5a3d12', K: '#fbf4e6', disc: ['#fffdf7', '#f6ecd8', '#e3d0a8'], gem: ['#fff', '#ffe9b0', '#b8862b'], hi: ['#fffdf0', '#efd08a'], lo: ['#c19443', '#6e4c16'], petal: ['#fff8e2', '#f2d892', '#c9a052', '#7a5820'] },
    dsd: { metal: ['#3d3f58', '#a9adc8', '#ffffff', '#d6d9ef', '#6f7394', '#e4e2f7', '#ffffff', '#b3b2d6', '#4a4a6a'], A: '#a7abd0', B: '#d4d6f2', L: '#ffffff', D: '#1c1d3c', K: '#07071c', disc: ['#262666', '#11113a', '#05051a'], gem: ['#fff', '#e6dcff', '#6d62c9'], hi: ['#ffffff', '#cfd2f0'], lo: ['#8a8db4', '#2e3052'], petal: ['#ffffff', '#dfe0f6', '#9fa3cc', '#3d3f62'] },
    cd: { metal: ['#3a4452', '#a8b4c4', '#ffffff', '#cfd8e4', '#66727f', '#dfe6ee', '#ffffff', '#a9b6c6', '#46505e'], A: '#9fb0c6', B: '#d2dcea', L: '#ffffff', D: '#0d1c33', K: '#040b18', disc: ['#173a6c', '#0b1d3b', '#040a17'], gem: ['#eaf4ff', '#4f93e6', '#0b2a6b'], hi: ['#e9f3ff', '#5c9ef0'], lo: ['#2257b8', '#071d4c'], petal: ['#ffffff', '#dbe4ef', '#98a8bc', '#3c4756'] },
    enhanced: { metal: ['#4a1f0e', '#b8653a', '#ffe0c8', '#d98a5a', '#7a3518', '#e8a57c', '#fff0e2', '#c06f42', '#5a2810'], A: '#c27a50', B: '#e8a57c', L: '#ffe8d6', D: '#2a1007', K: '#0a0909', disc: ['#2e2c2b', '#161515', '#070707'], gem: ['#fff', '#ffc9a6', '#a14a22'], hi: ['#fff1e4', '#e39a6c'], lo: ['#a8552c', '#4a1d0b'], petal: ['#ffeadb', '#efb08a', '#b8653a', '#5a2810'] },
    dsp: { metal: ['#3f300f', '#a8893f', '#f6ecc4', '#c8aa5a', '#6b5420', '#d8c27a', '#fbf3d6', '#a88a3e', '#4a3912'], A: '#b39a52', B: '#d8c27a', L: '#fbf3d6', D: '#1c1a08', K: '#03100c', disc: ['#11453a', '#08241d', '#03100c'], gem: ['#e9fff4', '#33c48a', '#0a4a33'], hi: ['#e9fff2', '#56d39e'], lo: ['#1f8a5e', '#06331f'], petal: ['#fbf3d6', '#e0cc8a', '#a8893f', '#4a3912'] },
    shared: { metal: ['#5a2a26', '#c48478', '#fff0ea', '#e0a698', '#8a4a42', '#efc0b2', '#fff6f2', '#c98a7e', '#643230'], A: '#c98f84', B: '#e9b6a8', L: '#fff0ea', D: '#2c1013', K: '#0c0509', disc: ['#3c1f31', '#1c0e18', '#0a050a'], gem: ['#fff', '#f6b6c4', '#8a3a4c'], hi: ['#fff4f0', '#eab0a2'], lo: ['#b0685c', '#521f1c'], petal: ['#fff3ee', '#ecbcae', '#c48478', '#5a2a26'] },
    lossy: { metal: ['#2e2a2e', '#9c959c', '#f8f4f6', '#c9c2c8', '#5e575e', '#dad4da', '#ffffff', '#a59ea6', '#3a353a'], A: '#a8a0a8', B: '#d6d0d6', L: '#ffffff', D: '#1a0a0e', K: '#0e0306', disc: ['#4c1020', '#24070e', '#0d0205'], gem: ['#ffe6ea', '#e0244a', '#4e0412'], hi: ['#ff9aae', '#d8203f'], lo: ['#8e0c26', '#3a020c'], petal: ['#ffffff', '#ddd6dc', '#9c959c', '#3a353a'] },
  },
  /** The engraved words over and under the medallion. */
  words(sg, kind) {
    const bits = sg.sourceBits ? sg.sourceBits + '-bit · ' : '';
    const mhz = r => (r / 1e6).toFixed(4).replace(/\.?0+$/, '');
    // the source as it is: codec, bit depth (only when the file has one), rate
    const src = [String(sg.codec || '').toUpperCase(), sg.sourceBits ? sg.sourceBits + '-bit' : '', khz(sg.sourceRate) + ' kHz'].filter(Boolean).join(' · ');
    switch (kind) {
      case 'upsample': return ['UPSAMPLED', sg.outputRate >= 1e6 ? `${khz(sg.sourceRate)} kHz → ${mhz(sg.outputRate)} MHz` : `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz`];
      case 'hires': return ['HIGH-RESOLUTION', src];
      case 'dsd': return ['DIRECT STREAM DIGITAL', `${sg.dsdLabel || 'DSD'} · ${mhz(sg.sourceRate)} MHz`];
      case 'cd': return ['LOSSLESS', src];
      case 'dsp': return ['', src];
      case 'shared': return ['SYSTEM MIXER', sg.outputRate && sg.outputRate !== sg.sourceRate ? `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz` : src];
      case 'lossy': return ['LOSSY', `${String(sg.codec || '').toUpperCase()} · ${khz(sg.sourceRate)} kHz`.replace(/^ · /, '')];
      default: return ['PROCESSED', sg.dsd ? `DSD → ${khz(sg.outputRate)} kHz` : sg.outputRate && sg.outputRate !== sg.sourceRate ? `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz` : src];
    }
  },

  /** The back: lacquer and its pattern, a metal frame with beading, filigree corners and crests, a diamond lattice,
   *  a medallion drawn for the kind (inside a turning bezel), the engraved words, glints. */
  /** DSP's backs: seven ways to look terrible, a different one every time the card is turned over. */
  uglyLast: -1,
  ugly(sg, cap) {
    const n = 7;
    let u = Math.floor(Math.random() * n);
    if (u === this.uglyLast) u = (u + 1 + Math.floor(Math.random() * (n - 1))) % n;
    this.uglyLast = u;
    const items = String(sg.dspSummary || 'EQ').split(/\s*·\s*/).filter(Boolean).slice(0, 3);
    const eye = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><ellipse rx="7" ry="9" fill="#fff" stroke="#1a1aff" stroke-width="1.2"/><ellipse cx="2" cy="2" rx="3.6" ry="4.4" fill="#111"/><ellipse rx="7" ry="9" transform="translate(13 -2)" fill="#fff" stroke="#1a1aff" stroke-width="1.2"/><ellipse cx="15" cy="1" rx="3.6" ry="4.4" fill="#111"/></g>`;
    const angry = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><circle r="30" fill="#ffd21f" stroke="#c98a00" stroke-width="2"/><path d="M-20 -14L-4 -6M20 -14L4 -6" stroke="#5a2a00" stroke-width="5" stroke-linecap="round"/><ellipse cx="-10" cy="0" rx="4" ry="5" fill="#3a1a00"/><ellipse cx="10" cy="0" rx="4" ry="5" fill="#3a1a00"/><rect x="-15" y="10" width="30" height="11" rx="4" fill="#fff" stroke="#5a2a00" stroke-width="2"/><path d="M-15 15.5H15M-7 10V21M0 10V21M7 10V21" stroke="#5a2a00" stroke-width="1.2"/></g>`;
    const goofy = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s}) rotate(-14)"><circle r="30" fill="#ffd21f" stroke="#c98a00" stroke-width="2"/><ellipse cx="-11" cy="-6" rx="8" ry="10" fill="#fff" stroke="#333"/><ellipse cx="11" cy="-8" rx="6" ry="7" fill="#fff" stroke="#333"/><circle cx="-8" cy="-3" r="3.5"/><circle cx="13" cy="-9" r="2.6"/><path d="M-14 13Q2 26 16 10" fill="#7a1010" stroke="#333" stroke-width="1.5"/><path d="M-6 19Q2 25 8 18" fill="#ff6b8a"/></g>`;
    const c = `<div class="sb-cap"><b>${esc(cap)}</b></div>`;
    const v = [
      // 0 · MS Paint on magenta
      () => `<svg class="sb-paint" viewBox="0 0 360 470" preserveAspectRatio="none">
        <path d="M362 330L333 345L357 367L326 370L337 400L310 390L307 422L291 396L275 422L273 390L246 400L257 370L226 367L250 345L222 330L250 315L226 293L257 290L246 260L273 270L275 238L291 264L307 238L310 270L337 260L326 290L357 293L333 315Z" fill="#00ff22" stroke="#3030ff" stroke-width="1.5"/>${eye(270, 318, 1.1)}<path d="M262 350Q292 372 318 334" fill="none" stroke="#ff1010" stroke-width="5" stroke-linecap="round"/>
        <path d="M158 395C158 360 128 335 110 345C90 335 60 360 64 395C56 430 92 450 110 444C132 452 166 428 158 395Z" fill="#ffff00" stroke="#3030ff" stroke-width="1.5"/>${eye(118, 385, .9)}<path d="M110 372Q128 362 146 372" fill="none" stroke="#9900cc" stroke-width="3"/>
        <path d="M-20 300C40 250 120 210 210 150L160 205L240 140L180 214L250 170C170 250 80 320 20 350C-10 365 -30 330 -20 300Z" fill="#ff0000" stroke="#3030ff" stroke-width="1.5"/>${eye(-2, 318, .9)}
        <path d="M58 8L48 90L20 70L46 100L30 170L58 112L84 168L66 102L104 92L64 86Z" fill="#0000ff" stroke="#ff00ff"/>${eye(48, 46, .7)}
        <path d="M218 52c-12 0-20-14-8-22c-2-14 16-20 24-10c8-12 30-8 30 6c14-2 20 16 8 22c6 12-10 22-20 14c-8 10-28 8-30-2c-14 2-18-10-4-8z" fill="#fff"/>${eye(226, 36, .6)}<ellipse cx="252" cy="44" rx="5" ry="3" fill="#e00"/>
        <ellipse cx="204" cy="250" rx="15" ry="24" fill="#000" stroke="#3030ff" transform="rotate(14 204 250)"/>${angry(300, 92)}
      </svg><div class="sb-wordart"><span>EQ</span><span>ON!!!</span></div>${c}`,
      // 1 · the table of contents (titled 狗屎): a sunset, chrome WordArt, a staircase of green bullets
      () => `<div class="u-title">狗 屎</div><svg class="sb-paint" viewBox="0 0 360 470" preserveAspectRatio="none">${angry(196, 150, 1.05)}
        <rect x="26" y="150" width="120" height="170" fill="#4a4a5a"/><path d="M40 320C40 250 60 200 86 196C112 200 132 250 132 320Z" fill="#2a2a34"/><circle cx="86" cy="182" r="26" fill="#c08a64"/><path d="M60 175Q86 150 112 175" fill="#222"/>
        <rect x="170" y="200" width="70" height="120" fill="#3a5a8a"/><path d="M178 320L186 230L206 214L226 236L234 320Z" fill="#334"/></svg>
        <ul class="u-steps">${[...items, '影響與評價', '作者QA'].map(t => `<li>${esc(t)}</li>`).join('')}</ul>${c}`,
      // 2 · the red biography slide: yellow WordArt, every line on its own highlighter box
      () => `<i class="u-rays"></i><div class="u-title u-bling">★訊號介紹★</div>${[[8, 14, 0, 22], [86, 8, .4, 18], [16, 74, .8, 14], [78, 70, .25, 26], [50, -6, .6, 16], [96, 46, 1, 12]].map(([x, y, d, s]) => `<i class="u-spark" style="left:${x}%;top:${y + 20}px;animation-delay:-${d}s;font-size:${s}px">✦</i>`).join('')}<ul class="u-boxes"><li>格式：${esc(sg.codec || '?')}</li><li>取樣率：${esc(khz(sg.sourceRate))} kHz</li>${sg.sourceBits && !this.lossy(sg) ? `<li>位元深度：${sg.sourceBits}-bit</li>` : ''}${items.map(t => `<li>處理：${esc(t)}</li>`).join('')}<li>EQ究極無敵宇宙霹靂強</li></ul>
        <svg class="sb-paint" viewBox="0 0 360 470" preserveAspectRatio="none">${goofy(300, 70, 1.1)}<g transform="translate(36 340)"><rect width="76" height="96" fill="#fff" stroke="#999"/><circle cx="38" cy="34" r="18" fill="#f2d2b0" stroke="#555"/><path d="M14 92Q38 50 62 92" fill="#e67a20"/><path d="M20 28Q38 4 56 28" fill="none" stroke="#555" stroke-width="3"/></g><g transform="translate(250 330)">${[0, 1, 2, 3, 4].map(i => `<path d="M${i * 18} 80Q${i * 18 + 6} ${40 - i * 6} ${i * 18 + 12} 80" fill="none" stroke="#333" stroke-width="${3 + i * .6}" stroke-linecap="round"/><circle cx="${i * 18 + 6}" cy="${34 - i * 6}" r="${4 + i}" fill="#333"/>`).join('')}</g></svg>${c}`,
      // 3 · the chemistry title slide: a letter-by-letter rainbow title on mint, clip art
      () => `<div class="u-rainbow">${(i => 'EQ: The Study of Sound'.split(' ').map(w => `<b>${[...w].map(ch => `<span style="color:${['#ff2a2a', '#ff9a00', '#e6d000', '#22c422', '#00b4ff', '#3a3aff', '#c400ff'][i++ % 7]}">${esc(ch)}</span>`).join('')}</b>`).join(' '))(0)}</div>
        <svg class="sb-paint" viewBox="0 0 360 470" preserveAspectRatio="none">
          <g transform="translate(34 120)" fill="none" stroke="#111" stroke-width="2"><path d="M20 30L40 18L62 30V54L40 66L20 54Z"/><path d="M62 30L84 18L106 30M62 54L84 66V90M40 66V90"/><circle cx="12" cy="66" r="7" fill="#999" stroke="none"/></g>
          <g transform="translate(220 100)"><rect width="110" height="110" fill="#123"/>${[['#3af', 20], ['#f3a', 48], ['#ff3', 76]].map(([col, x]) => `<path d="M${x} 30V60L${x - 16} 100H${x + 16}L${x} 60V30Z" fill="${col}" stroke="#fff" stroke-width="1.5" opacity=".9"/>`).join('')}</g>
          <g transform="translate(120 260)"><path d="M60 0L72 40L112 30L84 60L120 90L76 86L72 130L52 94L14 116L32 76L0 50L42 46Z" fill="#ff7a00"/><path d="M60 26L66 50L90 46L74 64L94 82L68 80L64 104L52 84L30 96L42 72L22 58L48 56Z" fill="#ffe14a"/></g>
          <g transform="translate(0 222) rotate(-4 180 20)"><path d="${[0, 1, 2, 3, 4].map(i => `M6 ${i * 7}H354`).join('')}" stroke="#222" stroke-width="1.2"/>
            <text x="4" y="34" font-size="50" font-family="'Segoe UI Symbol', 'Noto Music', serif" fill="#c400ff" stroke="#000" stroke-width=".6">𝄞</text>
            ${[[70, 21, '#ff2a2a'], [104, 10, '#ff9a00'], [138, 24, '#22c422'], [172, 3, '#00b4ff'], [206, 17, '#3a3aff'], [240, 7, '#ff2a2a'], [274, 28, '#e6b800'], [308, 14, '#c400ff']].map(([x, y, col], i) => `<ellipse cx="${x}" cy="${y}" rx="6.5" ry="4.6" transform="rotate(-22 ${x} ${y})" fill="${col}" stroke="#000"/><path d="M${x + 5.8} ${y - 1}V${y - 26}${i % 2 ? `q6 6 10 12` : ''}" stroke="#000" stroke-width="1.6" fill="none"/>`).join('')}</g>
          ${[['♪', 238, 92, '#ff2a2a', 26, -18], ['♫', 284, 70, '#22c422', 30, 12], ['♪', 318, 96, '#3a3aff', 22, 24], ['♫', 34, 112, '#ff9a00', 28, -10], ['♪', 300, 300, '#c400ff', 34, 16], ['♫', 76, 420, '#00b4ff', 30, -20], ['♬', 250, 430, '#ff2a2a', 30, 8]].map(([g, x, y, col, s, r]) => `<text x="${x}" y="${y}" font-size="${s}" fill="${col}" stroke="#000" stroke-width=".8" transform="rotate(${r} ${x} ${y})" font-family="'Segoe UI Symbol', Arial, sans-serif">${g}</text>`).join('')}
          <g transform="translate(28 300)"><rect width="64" height="92" rx="4" fill="#7a4a1e" stroke="#000" stroke-width="2"/><circle cx="32" cy="26" r="13" fill="#222" stroke="#999" stroke-width="2"/><circle cx="32" cy="26" r="4" fill="#666"/><circle cx="32" cy="64" r="20" fill="#222" stroke="#999" stroke-width="2"/><circle cx="32" cy="64" r="7" fill="#666"/>
            <path d="M74 44Q84 64 74 84M84 36Q100 64 84 92M94 28Q116 64 94 100" fill="none" stroke="#ff00ff" stroke-width="3" stroke-linecap="round"/></g></svg>${c}`,
      // 4 · GeoCities: stars, a marquee, a blinking NEW!, under construction, a hit counter
      () => `<div class="u-marquee"><span>★ Welcome to my EQ page!!! ★ 最佳瀏覽解析度 800×600 ★ 請簽我的留言板 ★</span></div>
        <div class="u-new">NEW!</div><div class="u-tape">UNDER CONSTRUCTION</div>
        <div class="u-counter">你是第 <b>000${Math.floor(Math.random() * 9000 + 1000)}</b> 位訪客</div>${c}`,
      // 5 · Windows 95, an error dialog and its copies all the way down
      () => `${[0, 1, 2, 3].map(i => `<div class="u-win" style="left:${18 + i * 16}px;top:${40 + i * 30}px"><div class="u-bar"><span>eq.exe</span><i>×</i></div><div class="u-body"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#e00" stroke="#600"/><path d="M10 10L22 22M22 10L10 22" stroke="#fff" stroke-width="3.5"/></svg><p>EQ 已停止運作。<br>你的耳朵將被關閉。</p></div><div class="u-btns"><u>確定</u><u>取消</u></div></div>`).join('')}
        <div class="u-task"><u>開始</u><span>${esc(cap)}</span></div>`,
      // 6 · the sludge
      () => `<svg class="sb-drip" viewBox="0 0 360 120" preserveAspectRatio="none"><path d="M0 0H360V22C352 22 350 34 344 34S338 18 330 18C318 18 322 64 312 64S304 24 296 24C286 24 290 40 280 40S270 20 262 20C250 20 256 92 244 92S234 26 224 26C214 26 218 46 208 46S198 18 188 18C176 18 182 58 170 58S160 24 150 24C140 24 144 36 134 36S124 20 114 20C102 20 108 78 96 78S86 28 76 28C66 28 70 42 60 42S50 18 40 18C28 18 34 54 22 54S12 22 0 22Z"/></svg>
        ${[[22, 66, 14], [71, 74, 9], [80, 38, 6], [12, 40, 7], [58, 86, 18]].map(([x, y, r]) => `<i class="sb-bub" style="left:${x}%;top:${y}%;--r:${r}px"></i>`).join('')}
        <div class="u-eq"><svg viewBox="0 0 90 70" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 61.5Q30 59 52 62.3T88 60.4" stroke-width="2.2"/><path d="${[9, 16, 23, 14, 6, 11, 19, 8].map((h2, i) => { const x = 8 + i * 10 + (i % 3) - 1; return `M${x} ${60 + (i % 2) * 1.5}L${x + (i % 2 ? 1.5 : -1)} ${60 - h2 * 1.6}`; }).join('')}" stroke-width="5.5" opacity=".85"/><path d="M4 34C14 22 19 44 30 26S47 12 55 33S72 49 86 18" stroke-width="2.4" stroke-dasharray="7 2 1 3"/></svg></div>
        <div class="u-sludge-t">EQ ON</div>${c}`,
    ];
    return `<div class="sb-u" data-u="${u}">${v[u]()}</div>`;
  },
  /** The plain backs. CD-quality lossless, the everyday card: card stock, a thin printed border, a disc drawn in one
   *  line. Lossy, the cheap card: no border at all, the compression's 8×8 blocks showing, the disc in coarse pixels.
   *  DSP, the 2004 slide: magenta MS Paint shapes with googly eyes, an angry face, rainbow WordArt, a highlighter box. */
  plain(sg, kind) {
    const [motto, cap] = this.words(sg, kind);
    let mark, extra = '';
    if (kind === 'dsp') return `<div class="sb-bg"></div>${this.ugly(sg, cap)}`;
    if (kind === 'lossy') {
      let px = '';
      for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
        const d = Math.hypot(x - 5.5, y - 5.5);
        if ((d > 3 && d < 5.9) || d < .9) px += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
      mark = `<svg class="sb-pdisc" viewBox="0 0 12 12" shape-rendering="crispEdges" fill="currentColor">${px}</svg>`;
    } else {
      mark = `<svg class="sb-pdisc" viewBox="0 0 100 100" fill="none" stroke="currentColor">
      <circle cx="50" cy="50" r="44" stroke-width="1.6"/>
      <path d="M50 18A32 32 0 0 1 82 50M50 26A24 24 0 0 1 74 50" stroke-width=".9" opacity=".55" stroke-linecap="round"/>
      <circle cx="50" cy="50" r="13" stroke-width="1.2"/><circle cx="50" cy="50" r="4" stroke-width="1.2"/>
    </svg>`;
    }
    return `<div class="sb-bg"></div>${extra}${kind === 'cd' ? '<i class="sb-pframe"></i>' : ''}${mark ? `<div class="sb-pmark">${mark}</div>` : ''}
      ${motto ? `<div class="sb-motto"><span>${esc(motto)}</span></div>` : ''}<div class="sb-cap"><b>${esc(cap)}</b></div>`;
  },
  art(sg, kind) {
    if (kind === 'cd' || kind === 'lossy' || kind === 'dsp') return this.plain(sg, kind);
    const P = this.pal[kind] || this.pal.enhanced;
    const id = 'sbk' + (++this.n), f = v => +v.toFixed(2);
    const pt = (r, a) => `${f(100 + r * Math.sin(a))} ${f(100 - r * Math.cos(a))}`;
    const xy = (r, a) => [100 + r * Math.sin(a), 100 - r * Math.cos(a)];
    const each = (n, fn, rot = 0) => Array.from({ length: n }, (_, i) => fn(rot + i * 2 * Math.PI / n, i)).join('');
    const lens = (n, r0, r1, w, rot) => each(n, a => { const m = (r0 + r1) / 2; return `M${pt(r0, a)}Q${pt(m, a + w)} ${pt(r1, a)}Q${pt(m, a - w)} ${pt(r0, a)}Z`; }, rot);
    // a leaf between two points, bulging w to each side
    const leaf = ([x0, y0], [x1, y1], w) => {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, nx = -dy / l * w, ny = dx / l * w;
      return `M${f(x0)} ${f(y0)}Q${f(mx + nx)} ${f(my + ny)} ${f(x1)} ${f(y1)}Q${f(mx - nx)} ${f(my - ny)} ${f(x0)} ${f(y0)}Z`;
    };
    // engine-turned rings: r(θ) = R + A·sin(kθ)
    const wave = (R, A, k, ph) => { let d = ''; for (let i = 0; i <= 180; i++) { const a = i / 180 * 2 * Math.PI; d += (i ? 'L' : 'M') + pt(R + A * Math.sin(k * a + ph), a); } return d + 'Z'; };
    const offs = [0, .14, .24, .34, .48, .6, .7, .8, 1];
    const metal = P.metal.map((c, i) => `<stop offset="${offs[i]}" stop-color="${c}"/>`).join('');
    const grad3 = (g, id2, extra = '') => `<radialGradient id="${id2}" ${extra}><stop offset="0" stop-color="${g[0]}"/><stop offset=".45" stop-color="${g[1]}"/><stop offset="1" stop-color="${g[2]}"/></radialGradient>`;
    const P8 = Math.PI / 8;
    // a faceted star of n points, alternating long and short, lit on one side of each point
    const star = (n, R1, R2, r0) => each(n, (a, i) => {
      const R = i % 2 ? R2 : R1, h2 = Math.PI / n;
      return `<path d="M100 100L${pt(r0, a - h2)}L${pt(R, a)}Z" fill="url(#${id}hi)"/><path d="M100 100L${pt(R, a)}L${pt(r0, a + h2)}Z" fill="url(#${id}lo)"/>`;
    });
    const defs = `<svg class="sb-defs" width="0" height="0" aria-hidden="true"><defs>
      <linearGradient id="${id}c" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="80" y2="80">${metal}</linearGradient>
      <linearGradient id="${id}k" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="140" y2="36">${metal}</linearGradient>
      <linearGradient id="${id}m" gradientUnits="userSpaceOnUse" x1="18" y1="18" x2="182" y2="182">${metal}</linearGradient>
      <radialGradient id="${id}p" gradientUnits="userSpaceOnUse" cx="100" cy="100" r="84"><stop offset="0" stop-color="${P.petal[0]}"/><stop offset=".45" stop-color="${P.petal[1]}"/><stop offset=".75" stop-color="${P.petal[2]}"/><stop offset="1" stop-color="${P.petal[3]}"/></radialGradient>
      <radialGradient id="${id}d" gradientUnits="userSpaceOnUse" cx="100" cy="92" r="92"><stop offset="0" stop-color="${P.disc[0]}"/><stop offset=".6" stop-color="${P.disc[1]}"/><stop offset="1" stop-color="${P.disc[2]}"/></radialGradient>
      <linearGradient id="${id}hi" gradientUnits="userSpaceOnUse" x1="66" y1="66" x2="134" y2="134"><stop offset="0" stop-color="${P.hi[0]}"/><stop offset="1" stop-color="${P.hi[1]}"/></linearGradient>
      <linearGradient id="${id}lo" gradientUnits="userSpaceOnUse" x1="66" y1="66" x2="134" y2="134"><stop offset="0" stop-color="${P.lo[0]}"/><stop offset="1" stop-color="${P.lo[1]}"/></linearGradient>
      ${grad3(P.gem, id + 'j')}
      ${grad3(P.gem, id + 'g', 'cx=".38" cy=".32" r=".75"')}
      <radialGradient id="${id}x"><stop offset="0" stop-color="${P.K}"/><stop offset=".7" stop-color="${P.K}" stop-opacity=".95"/><stop offset="1" stop-color="${P.K}" stop-opacity="0"/></radialGradient>
      <symbol id="${id}corner" viewBox="0 0 80 80">
        <g id="${id}half">
          <g fill="none" stroke="url(#${id}c)" stroke-linecap="round">
            <path stroke-width="1.6" d="M8 4.5C20 4.5 30 3 41 6.5C51 9.5 55 16.5 50 20.5C45.5 24 40.5 19.5 44 16.2C46 14.5 48.5 16 47.6 18"/>
            <path stroke-width=".8" d="M22 4C27 .8 34 .6 38 2.6"/>
            <path stroke-width=".8" d="M41 6.5C52 6 62 5 73.5 6.2"/>
          </g>
          <g fill="url(#${id}c)">
            <circle cx="75.5" cy="6.3" r="1.4"/>
            <path d="M15 6.5C22 11.5 30 12.5 36 10C30 8.2 22 7.4 15 6.5Z"/>
            <path d="M50 20.5C52.5 26 51 30.5 47 33C46.8 28.5 48 24 50 20.5Z"/>
            <path d="M21 20C25 14.5 31 13 36 14.5C31.5 17.5 26.5 19.5 21 20Z"/>
            <circle cx="33" cy="16.5" r="1.2"/>
          </g>
        </g>
        <use href="#${id}half" transform="matrix(0 1 1 0 0 0)"/>
        <path fill="none" stroke="url(#${id}c)" stroke-width="1" d="M3 26C3 13 13 3 26 3"/>
        <g fill="url(#${id}c)">
          <path d="M5 5C12 7.5 15.5 11 17 17C11 15.5 7.5 12 5 5Z"/>
          <path d="M18 18C27 21 33 27 36 36C27 33 21 27 18 18Z"/>
          <circle cx="39.6" cy="39.6" r="2.3"/><circle cx="44.2" cy="44.2" r="1.2"/>
        </g>
        <path stroke="${P.D}" stroke-width=".7" stroke-linecap="round" d="M21 21L32.5 32.5"/>
      </symbol>
      <symbol id="${id}crest" viewBox="0 0 140 36">
        <ellipse cx="70" cy="13" rx="36" ry="11" fill="url(#${id}x)"/>
        <g id="${id}wing">
          <g fill="none" stroke="url(#${id}k)" stroke-linecap="round">
            <path stroke-width="1.5" d="M77 13C85 7 96 6.5 103 11C108.5 14.5 106.5 21.5 101 21C96.8 20.6 96.5 15.8 100.3 15.6C102.3 15.5 103 17.4 101.8 18.4"/>
            <path stroke-width=".8" d="M103 11C112 8.5 122 8 133.5 9"/>
            <path stroke-width=".75" d="M87 6.2C91 3 97 2.6 101 4.2"/>
          </g>
          <g fill="url(#${id}k)">
            <path d="M80 15C86 19.5 92 20.5 97 18.8C92 16.2 86 15 80 15Z"/>
            <circle cx="135.4" cy="9.1" r="1.3"/><circle cx="82.5" cy="13.5" r="1.1"/><circle cx="113" cy="13.5" r=".9"/>
          </g>
        </g>
        <use href="#${id}wing" transform="matrix(-1 0 0 1 140 0)"/>
        <path fill="none" stroke="url(#${id}k)" stroke-width=".8" stroke-linecap="round" d="M62 4.5Q70 -1 78 4.5M70 23V27"/>
        <path fill="${P.hi[0]}" d="M70 4L63 13.5H70Z"/><path fill="${P.hi[1]}" d="M70 4L77 13.5H70Z"/>
        <path fill="${P.lo[1]}" d="M63 13.5L70 23V13.5Z"/><path fill="${P.lo[0]}" d="M77 13.5L70 23V13.5Z"/>
        <circle cx="70" cy="29.6" r="2.1" fill="url(#${id}j)"/>
      </symbol>
    </defs></svg>`;
    const serif = 'font-family="Georgia, \'Times New Roman\', serif"';
    const motif = {
      // the original: a sixteen-petal rosette, an eight-petal flower, a faceted star
      upsample: () => `
        <path d="${lens(16, 40, 75, .12, Math.PI / 16)}" fill="url(#${id}p)" opacity=".38"/>
        <path d="${lens(16, 44, 79, .19, 0)}" fill="url(#${id}p)" stroke="${P.D}" stroke-width=".6"/>
        <path d="${each(16, a => `M${pt(49, a)}L${pt(72, a)}`)}" stroke="${P.D}" stroke-width=".7" stroke-linecap="round" opacity=".9"/>
        <g fill="${P.B}">${each(16, a => { const [x, y] = xy(41, a); return `<circle cx="${f(x)}" cy="${f(y)}" r="1.25"/>`; }, Math.PI / 16)}</g>
        <path d="${lens(8, 15, 50, .34, P8)}" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".6"/>
        <path d="${each(8, a => `M${pt(20, a)}L${pt(43, a)}`, P8)}" stroke="${P.D}" stroke-width=".6" stroke-linecap="round" opacity=".8"/>
        <circle cx="100" cy="100" r="21" fill="${P.K}" stroke="url(#${id}m)" stroke-width="1.4"/>
        <g stroke="${P.D}" stroke-width=".35" stroke-linejoin="round">${star(8, 34, 23, 7.5)}</g>
        <circle cx="100" cy="100" r="4.3" fill="url(#${id}j)"/>`,
      // a laurel wreath tied at the foot, round a pearl cartouche with the bit depth
      hires: () => {
        // one branch from the foot up one side: a stem, pairs of leaves along it pointing to the tip, a berry at the end
        const branch = s => {
          const R = 62, a0 = Math.PI - .34, a1 = .3, n = 9;
          let leaves = '';
          for (let i = 0; i < n; i++) {
            const a = s * (a0 - (a0 - a1) * (i + .5) / n), len = 15 - i * .55, tilt = s * .26;
            const base = xy(R, a);
            leaves += `<path d="${leaf(base, xy(R + len, a - tilt), 4.6)}" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".45"/>`;
            leaves += `<path d="${leaf(base, xy(R - len * .9, a - tilt * 1.1), 4.2)}" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".45"/>`;
          }
          const tip = xy(R, s * (a1 - .06));
          return `<path d="M${pt(R, s * a0)}A${R} ${R} 0 0 ${s > 0 ? 0 : 1} ${pt(R, s * a1)}" fill="none" stroke="url(#${id}m)" stroke-width="2.2" stroke-linecap="round"/>${leaves}<circle cx="${f(tip[0])}" cy="${f(tip[1])}" r="2.6" fill="url(#${id}j)" stroke="${P.D}" stroke-width=".4"/>`;
        };
        const bits = sg.sourceBits || 24;
        return `
        <g fill="none" stroke="${P.A}" stroke-width=".4" opacity=".5">${[78, 82].map((R, i) => `<path d="${wave(R, 1.2, 36, i * 1.6)}"/>`).join('')}</g>
        ${branch(1)}${branch(-1)}
        <path d="M100 161.5C94 156 86 157 88 162.5C90 167 96 164 100 161.5ZM100 161.5C106 156 114 157 112 162.5C110 167 104 164 100 161.5ZM100 161.5L94 172M100 161.5L106 172" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".5" stroke-linejoin="round"/>
        <circle cx="100" cy="161.5" r="3" fill="url(#${id}j)" stroke="${P.D}" stroke-width=".4"/>
        <circle cx="100" cy="100" r="40" fill="${P.K}" stroke="url(#${id}m)" stroke-width="2.2"/>
        <circle cx="100" cy="100" r="35.5" fill="none" stroke="${P.A}" stroke-width="1.6" stroke-dasharray="0 4.65" stroke-linecap="round"/>
        <circle cx="100" cy="100" r="31.5" fill="none" stroke="url(#${id}m)" stroke-width=".6"/>
        <text x="100" y="84.5" text-anchor="middle" ${serif} font-size="6.4" letter-spacing="2.2" fill="${P.D}">HI · RES</text>
        <text x="100" y="113" text-anchor="middle" ${serif} font-size="32" font-weight="700" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".5">${bits}</text>
        <text x="100" y="124.5" text-anchor="middle" ${serif} font-size="6.4" letter-spacing="3" fill="${P.D}">BIT</text>`;
      },
      // a 1-bit pulse-density ring (a first-order sigma-delta of a slow sine), an opal ring, the stream's name
      dsd: () => {
        let acc = 0, ticks = '';
        for (let i = 0; i < 128; i++) {
          const a = i / 128 * 2 * Math.PI, x = .82 * Math.sin(3 * a);
          const y = acc + x >= 0 ? 1 : -1; acc += x - y;
          ticks += y > 0 ? `M${pt(53, a)}L${pt(76, a)}` : `M${pt(73, a)}L${pt(76, a)}`;
        }
        const label = String(sg.dsdLabel || 'DSD').replace(/^DSD/i, '') || '';
        return `
        <path d="${ticks}" stroke="url(#${id}m)" stroke-width="1.5" stroke-linecap="round"/>
        <circle cx="100" cy="100" r="79" fill="none" stroke="url(#${id}m)" stroke-width=".7"/>
        <circle cx="100" cy="100" r="49" fill="none" stroke="url(#${id}m)" stroke-width="1.2"/>
        <circle cx="100" cy="100" r="44" fill="url(#${id}d)" stroke="${P.A}" stroke-width=".5" opacity=".9"/>
        <circle cx="100" cy="100" r="25" fill="${P.K}" stroke="url(#${id}m)" stroke-width="1.6"/>
        <text x="100" y="${label ? 101 : 106}" text-anchor="middle" ${serif} font-size="14" font-weight="700" letter-spacing="1.2" fill="url(#${id}m)">DSD</text>
        ${label ? `<text x="100" y="113" text-anchor="middle" ${serif} font-size="7.5" letter-spacing="1.5" fill="${P.B}">${esc(label)}</text>` : ''}`;
      },
      // a pressed disc: grooves, a clamping ring, a sapphire star in the hub
      cd: () => `
        <g fill="none" stroke="${P.B}">${Array.from({ length: 16 }, (_, i) => `<circle cx="100" cy="100" r="${f(32 + i * 2.85)}" stroke-width="${i % 4 ? .3 : .55}" opacity="${i % 4 ? .32 : .6}"/>`).join('')}</g>
        <circle cx="100" cy="100" r="78.5" fill="none" stroke="url(#${id}m)" stroke-width="1.4"/>
        <circle cx="100" cy="100" r="30" fill="${P.K}" stroke="url(#${id}m)" stroke-width="2.2"/>
        <circle cx="100" cy="100" r="25.5" fill="none" stroke="${P.A}" stroke-width="1.4" stroke-dasharray="0 4" stroke-linecap="round"/>
        <g stroke="${P.D}" stroke-width=".35" stroke-linejoin="round">${star(8, 22, 14, 5)}</g>
        <circle cx="100" cy="100" r="3.6" fill="url(#${id}j)"/>`,
      // an engine-turned gear, a faceted hexagon
      enhanced: () => {
        let g = '';
        for (let i = 0; i < 24; i++) {
          const a = i / 24 * 2 * Math.PI, w = Math.PI / 24;
          g += `${i ? 'L' : 'M'}${pt(68, a - w)}L${pt(77, a - w * .55)}L${pt(77, a + w * .55)}L${pt(68, a + w)}`;
        }
        const hex = each(6, (a, i) => `<path d="M100 100L${pt(24, a)}L${pt(24, a + Math.PI / 3)}Z" fill="url(#${id}${i % 2 ? 'lo' : 'hi'})"/>`);
        return `
        <path d="${g}Z" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".6"/>
        <circle cx="100" cy="100" r="65" fill="url(#${id}d)" stroke="${P.D}" stroke-width=".8"/>
        <g fill="none" stroke="${P.B}" stroke-width=".45" opacity=".5">${[30, 36, 42, 48, 54, 60].map((R, i) => `<path d="${wave(R, 1.6, 18, i * .9)}"/>`).join('')}</g>
        <path d="${each(6, a => `M${pt(28, a)}L${pt(63, a)}`, Math.PI / 6)}" stroke="url(#${id}m)" stroke-width="2" stroke-linecap="round"/>
        <circle cx="100" cy="100" r="27" fill="${P.K}" stroke="url(#${id}m)" stroke-width="1.5"/>
        <g stroke="${P.D}" stroke-width=".35" stroke-linejoin="round">${hex}</g>
        <circle cx="100" cy="100" r="5" fill="url(#${id}j)"/>`;
      },
      // a radial EQ: bars following a gentle curve, an eight-petal flower, an emerald cabochon
      dsp: () => {
        const eq = a => { const t = a / (2 * Math.PI); return .5 + .35 * Math.sin(t * 4 * Math.PI + .6) * Math.cos(t * 2 * Math.PI) + .15 * Math.sin(t * 10 * Math.PI); };
        const bars = each(40, a => `M${pt(47, a)}L${pt(51 + 25 * eq(a), a)}`);
        return `
        <path d="${bars}" stroke="url(#${id}m)" stroke-width="3" stroke-linecap="round"/>
        <circle cx="100" cy="100" r="79" fill="none" stroke="url(#${id}m)" stroke-width=".7"/>
        <circle cx="100" cy="100" r="44" fill="none" stroke="url(#${id}m)" stroke-width="1.4"/>
        <path d="${lens(8, 14, 41, .3, P8)}" fill="url(#${id}m)" stroke="${P.D}" stroke-width=".6"/>
        <circle cx="100" cy="100" r="17" fill="${P.K}" stroke="url(#${id}m)" stroke-width="1.6"/>
        <circle cx="100" cy="100" r="13.5" fill="url(#${id}g)" stroke="${P.D}" stroke-width=".5"/>
        <ellipse cx="96" cy="94.5" rx="5" ry="3" fill="#fff" opacity=".55" transform="rotate(-30 96 94.5)"/>`;
      },
      // a watch dial and a compass rose
      shared: () => {
        const ticks = each(60, (a, i) => `M${pt(i % 5 ? 73 : 69, a)}L${pt(77, a)}`);
        const rose = (n, R, r0, rot) => each(n, a => `<path d="M100 100L${pt(r0, a - Math.PI / n)}L${pt(R, a)}Z" fill="url(#${id}hi)"/><path d="M100 100L${pt(R, a)}L${pt(r0, a + Math.PI / n)}Z" fill="url(#${id}lo)"/>`, rot);
        return `
        <path d="${ticks}" stroke="url(#${id}m)" stroke-width="1.2" stroke-linecap="round"/>
        <g fill="${P.B}">${each(12, a => { const [x, y] = xy(63.5, a); return `<circle cx="${f(x)}" cy="${f(y)}" r="1.5"/>`; })}</g>
        <circle cx="100" cy="100" r="58" fill="none" stroke="url(#${id}m)" stroke-width=".9"/>
        <circle cx="100" cy="100" r="40" fill="none" stroke="${P.A}" stroke-width=".5" opacity=".7"/>
        <g stroke="${P.D}" stroke-width=".35" stroke-linejoin="round">${rose(4, 40, 8, Math.PI / 4)}${rose(4, 55, 9, 0)}</g>
        <circle cx="100" cy="100" r="10" fill="${P.K}" stroke="url(#${id}m)" stroke-width="1.4"/>
        <circle cx="100" cy="100" r="6.5" fill="url(#${id}g)"/>`;
      },
      // a brilliant-cut ruby in a ring of petals
      lossy: () => {
        const th = i => i * Math.PI / 4 + P8, ph = i => th(i) + P8;
        const T = i => xy(21, th(i)), V = i => xy(44, th(i)), W = i => xy(44, ph(i)), S = i => xy(33, ph(i));
        const tri = (a, b, c, fill) => `<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}L${f(c[0])} ${f(c[1])}Z" fill="${fill}"/>`;
        let gem = '';
        for (let i = 0; i < 8; i++) {
          gem += tri(T(i), T(i + 1), S(i), `url(#${id}${i % 2 ? 'lo' : 'hi'})`);
          gem += tri(T(i + 1), S(i), W(i), `url(#${id}${i % 2 ? 'hi' : 'lo'})`) + tri(T(i), S(i), W(i), `url(#${id}${i % 2 ? 'hi' : 'lo'})`);
          gem += tri(T(i), V(i), W(i - 1 < 0 ? 7 : i - 1), `url(#${id}${i % 2 ? 'lo' : 'hi'})`) + tri(T(i), V(i), W(i), `url(#${id}${i % 2 ? 'hi' : 'lo'})`);
        }
        const table = Array.from({ length: 8 }, (_, i) => T(i).map(f).join(' ')).join('L');
        return `
        <path d="${lens(12, 50, 78, .2, 0)}" fill="url(#${id}p)" stroke="${P.D}" stroke-width=".6"/>
        <path d="${each(12, a => `M${pt(54, a)}L${pt(73, a)}`)}" stroke="${P.D}" stroke-width=".6" stroke-linecap="round"/>
        <g fill="${P.B}">${each(12, a => { const [x, y] = xy(52, a); return `<circle cx="${f(x)}" cy="${f(y)}" r="1.2"/>`; }, Math.PI / 12)}</g>
        <circle cx="100" cy="100" r="47.5" fill="${P.K}" stroke="url(#${id}m)" stroke-width="2"/>
        <g stroke="${P.D}" stroke-width=".4" stroke-linejoin="round">${gem}</g>
        <path d="M${table}Z" fill="url(#${id}g)" stroke="#ffd0da" stroke-width=".5" stroke-opacity=".6"/>
        <path d="M${table}Z" fill="#fff" opacity=".12"/>
        <circle cx="100" cy="100" r="44" fill="none" stroke="url(#${id}m)" stroke-width="1"/>`;
      },
    };
    const medal = `<svg class="sb-rose" viewBox="0 0 200 200">
      <circle cx="100" cy="100" r="88" fill="url(#${id}d)"/>
      <g fill="none" stroke="${P.A}" stroke-width=".45" opacity=".42">${[30, 37, 44, 51, 58, 65, 72].map((R, i) => `<path d="${wave(R, 1.8, 24, i * 1.1)}"/>`).join('')}</g>
      <circle cx="100" cy="100" r="88" fill="none" stroke="url(#${id}m)" stroke-width="2.4"/>
      <circle cx="100" cy="100" r="82.6" fill="none" stroke="${P.B}" stroke-width="2.3" stroke-dasharray="0 6.49" stroke-linecap="round"/>
      <circle cx="100" cy="100" r="78" fill="none" stroke="url(#${id}m)" stroke-width=".9"/>
      ${(motif[kind] || motif.enhanced)()}
    </svg>`;
    const bezel = `<svg class="sb-ring" viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="97" stroke="${P.A}" stroke-width=".6" opacity=".8"/>
      <circle cx="100" cy="100" r="93.6" stroke="${P.B}" stroke-width="2.6" stroke-dasharray=".7 3.2" opacity=".85"/>
      <circle cx="100" cy="100" r="90.4" stroke="${P.A}" stroke-width=".5" opacity=".6"/>
      ${each(4, (a, i) => `<path d="M100 1.8L103.2 6.6L100 11.4L96.8 6.6Z" fill="${P.metal[3]}" stroke="${P.L}" stroke-width=".4" transform="rotate(${i * 90} 100 100)"/><circle cx="100" cy="6.6" r="1.3" fill="${P.B}" transform="rotate(${i * 90 + 45} 100 100)"/>`)}
    </svg>`;
    const corner = c => `<svg class="sb-corner ${c}" viewBox="0 0 80 80"><use href="#${id}corner"/></svg>`;
    const crest = c => `<svg class="sb-crest ${c}" viewBox="0 0 140 36"><use href="#${id}crest"/></svg>`;
    // glints sit on the metal: [left, top, delay s, size]
    const glints = [
      ['58px', '58px', 0, 1], ['calc(100% - 95px)', '23px', -2.5, .7], ['35px', 'calc(100% - 65px)', -1.6, .85],
      ['calc(100% - 58px)', 'calc(100% - 58px)', -3, 1], ['50%', '18px', -2, 1.15], ['50%', 'calc(100% - 18px)', -.9, .9],
      ['50%', '50%', -3.3, 1.5], ['calc(50% + var(--m) * .26)', 'calc(50% - var(--m) * .3)', -1.4, .7],
      ['calc(50% - var(--m) * .3)', 'calc(50% + var(--m) * .22)', -2.3, .6], ['16px', '50%', -.6, .8],
      ['calc(100% - 16px)', '50%', -2.7, .8], ['30%', '7px', -1.7, .6], ['calc(100% - 7px)', '72%', -.3, .55],
    ].map(([x, y, d, s]) => `<i class="sb-gl" style="left:${x};top:${y};animation-delay:${d}s;--s:${s}"></i>`).join('');
    const [motto, cap] = this.words(sg, kind);
    return defs + `<div class="sb-bg"></div><div class="sb-rays"></div><i class="sb-dust a"></i><i class="sb-dust b"></i>
      <svg class="sb-lattice" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="${P.A}">
        <polygon points="50,0 100,50 50,100 0,50" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".5"/>
        <polygon points="50,6 94,50 50,94 6,50" stroke-width=".6" vector-effect="non-scaling-stroke" opacity=".26"/>
      </svg>
      <i class="sb-frame"></i><i class="sb-beads"></i><i class="sb-frame2"></i>
      ${corner('tl')}${corner('tr')}${corner('bl')}${corner('br')}${crest('t')}${crest('b')}
      <i class="sb-node l"></i><i class="sb-node r"></i>
      <div class="sb-medal"><i class="sb-glow"></i>${medal}<i class="sb-iris"></i>${bezel}</div>
      <div class="sb-motto"><span>${esc(motto)}</span></div>
      <div class="sb-cap"><b>${esc(cap)}</b></div>
      <i class="sb-sheen"></i>${glints}<i class="sb-burst"></i><i class="sb-flash"></i>`;
  },
};
// a few seconds after start-up, when the page is idle: the GPU learns to draw the card backs before the first turn
addEventListener('load', () => setTimeout(() => (window.requestIdleCallback || (f => setTimeout(f, 0)))(() => SigCard.prime(), { timeout: 4000 }), 3000));

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
  stack: [], ignore: 0, pending: null, waiting: [],
  push(close) {
    this.stack.push(close);
    // A previous layer is still going back asynchronously. Add its replacement only after that popstate.
    if (this.ignore > 0) { this.waiting.push(close); return; }
    history.pushState({ i: Router.idx, overlay: true }, '', location.hash);
  },
  closed(close) {
    const i = this.stack.lastIndexOf(close);
    if (i < 0) return;
    this.stack.splice(i, 1);
    const queued = this.waiting.lastIndexOf(close);
    if (queued >= 0) { this.waiting.splice(queued, 1); return; }
    this.ignore++;
    history.back();
  },
  restorePage() {
    // Closing a layer must retain the displayed page, even if its album id has changed.
    const r = Router.cur;
    const id = r.name === 'album' ? Lib.resolve(r.arg) : null;
    const hash = id ? '#/album/' + id : r.key;
    if (hash && location.hash !== hash) history.replaceState({ ...history.state, i: Router.idx }, '', hash);
  },
  /** Returns true when the popstate was consumed by an overlay. */
  onPop() {
    if (this.ignore > 0) {
      this.ignore--;
      if (!this.ignore) {
        this.restorePage();
        for (const close of this.waiting.splice(0)) {
          if (this.stack.includes(close)) history.pushState({ i: Router.idx, overlay: true }, '', location.hash);
        }
        if (this.pending) { const [hash, rep] = this.pending; this.pending = null; setTimeout(() => go(hash, rep)); }
      }
      return true;
    }
    const close = this.stack.pop();
    if (close) { this.restorePage(); close(true); return true; }
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
    ArtSharp.release(body);
    body.textContent = '';
    if (!ids.length) { body.append(h('div', { class: 'muted', style: { padding: '40px 12px', textAlign: 'center' } }, T('佇列是空的'))); return; }
    // the modules' headers (MikuExt queueHead): what made the list, what comes after it
    for (const [id, fn] of Object.entries(MikuExt.queueHeads)) {
      const el = h('div', { class: 'qext', 'data-ext': id });
      try { fn(el, App.queue.source || null); } catch (e) { console.error('[ext] queue', id, e); }
      if (el.childNodes.length) body.append(el);
    }
    const row = (id, i) => {
      const t = Lib.trackById.get(id);
      if (!t) return null;
      const r = h('div', { class: 'qrow' + (i === index ? ' cur' : '') + (i < index ? ' past' : ''), draggable: 'true', 'data-i': i },
        artBox('thumb', ...trackArt(t), 48, t.album?.title),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, t.artist)),
        h('button', { class: 'icon-btn x', title: T('移除'), html: icon('x'), onclick: e => { e.stopPropagation(); Host.call('queue.remove', { i }); } }));
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
      body.append(h('div', { class: 'qsec' }, T('正在播放')));
      body.append(row(ids[index], index));
    }
    const upcoming = ids.slice(index + 1);
    body.append(h('div', { class: 'qsec' }, T`接下來 · ${upcoming.length} 首`, upcoming.length ? h('button', { onclick: () => Host.call('queue.clear') }, T('清除')) : null));
    // render a window to keep huge queues snappy
    upcoming.slice(0, 300).forEach((id, k) => body.append(row(id, index + 1 + k)));
    if (upcoming.length > 300) body.append(h('div', { class: 'muted', style: { padding: '10px' } }, T`還有 ${upcoming.length - 300} 首…`));
    if (index > 0) {
      body.append(h('div', { class: 'qsec' }, T('已播放')));
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
      h('div', { class: 'sh-head' }, h('span', null, T('最近搜尋')), h('a', { onclick: () => this.clear() }, T('清除全部'))));
    // keep focus in the search box while clicking inside the list
    el.addEventListener('mousedown', e => e.preventDefault());
    for (const q of items.slice(0, 10)) {
      el.append(h('div', { class: 'sh-row' },
        h('button', { class: 'sh-q', html: icon('clock') + `<span>${esc(q)}</span>`, onclick: () => this.run(q) }),
        h('button', { class: 'sh-x', title: T('移除'), html: icon('x'), onclick: e => { e.stopPropagation(); this.remove(q); } })));
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
    if (PageEffects.reduced('page') && dir !== 'flip') dir = 'none';
    Motion.quiet = dir === 'none' || PageEffects.reduced('page');
    if (dir !== 'none' && (!keepScroll || !same)) view.classList.add('enter-' + dir);
    const fn = Views[r.name] || Views.home;
    const cleanupView = fn(view, r.arg) || null;
    const cleanupRails = typeof attachRailNav === 'function' ? attachRailNav(view) : null;
    r.cleanup = () => { cleanupView && cleanupView(); cleanupRails && cleanupRails(); ArtSharp.release(view); };
    const y = keepScroll && same ? this.scrolls[r.key] : (this.scrolls[r.key] || 0);
    content.scrollTop = y || 0;
    content.dispatchEvent(new Event('scroll'));
    requestAnimationFrame(() => { Motion.quiet = PageEffects.reduced('page'); });
    if (Flip.back && r.name !== 'album') Flip.playBack();
    Views.markPlaying();
  },
};

/* ═════════════════════════════ motion helpers ═════════════════════════════ */
const Motion = {
  _quiet: false,
  get quiet() { return this._quiet || PageEffects.reduced('page'); },
  set quiet(value) { this._quiet = value; },
};
/** Sliding highlight behind the active sidebar item. */
const NavPill = {
  el: null,
  /** instant: follow a layout change (window size, zoom, text size, the sidebar folding to icons) in place; only a
   *  change of page slides it. Sliding there let it trail behind with its new size over the wrong item. */
  move(instant) {
    const nav = $('#nav');
    if (!this.el) { this.el = h('div', { class: 'nav-pill' }); nav.prepend(this.el); this.el.style.transition = 'none'; requestAnimationFrame(() => this.el.style.transition = ''); }
    NavEdges.sync();
    const a = $('#nav a.on');
    if (!a || !a.offsetParent) { this.el.style.opacity = 0; return; }   // none, or hidden from the sidebar (NavPick)
    if (instant) this.el.style.transition = 'none';
    this.el.style.opacity = 1;
    this.el.style.transform = `translateY(${a.offsetTop}px)`;
    this.el.style.left = a.offsetLeft + 'px';
    this.el.style.width = a.offsetWidth + 'px';
    this.el.style.height = a.offsetHeight + 'px';   // follows the item (text size setting)
    this.el.style.right = 'auto';
    if (instant) { void this.el.offsetWidth; this.el.style.transition = ''; }
  },
};
/** The sidebar list scrolls without a scrollbar (a 14 px bar squeezed the folded 52 px column: the icons jumped
 *  sideways and the highlight shrank to a square whenever a short window made the list overflow). Instead the
 *  edge with more items behind it fades out (app.css .nav.fade-t / .fade-b). */
const NavEdges = {
  sync() {
    const n = $('#nav'); if (!n) return;
    const top = n.scrollTop > 1, bottom = n.scrollTop + n.clientHeight < n.scrollHeight - 1;
    if (n.classList.contains('fade-t') !== top) n.classList.toggle('fade-t', top);
    if (n.classList.contains('fade-b') !== bottom) n.classList.toggle('fade-b', bottom);
  },
};
window.addEventListener('resize', () => NavPill.move(true));
$('#nav').addEventListener('scroll', () => NavEdges.sync(), { passive: true });
// A clicked sidebar link keeps the keyboard focus. When the window comes back after a keyboard action (Alt+Tab, a
// shortcut), Chromium re-shows that focus as a keyboard focus ring round the highlighted item. The highlight already
// marks the page, so a mouse click (detail > 0; Enter from the keyboard is 0) lets the focus go.
$('#nav').addEventListener('click', e => { const a = e.target.closest('a'); if (a && e.detail > 0) a.blur(); });

/** Which links of the 音樂庫 section the sidebar shows: the button on the section's label (or a right-click on one of
 *  its links, also when the sidebar is folded to icons) opens a list to tick. Kept in the ui pref navHidden (routes,
 *  comma-separated); links that modules add later (SensMe …) can be hidden the same way. */
const NavPick = {
  hidden() { return new Set(String(typeof uiPref === 'function' ? uiPref('navHidden', '') : '').split(',').filter(Boolean)); },
  /** The section's label: the one above 專輯, wherever the links were dragged to. */
  label() { let el = $('#nav a[data-r="albums"]'); while (el && !el.classList.contains('nav-label')) el = el.previousElementSibling; return el; },
  links() {
    const out = [];
    for (let el = this.label()?.nextElementSibling; el && !el.classList.contains('nav-label'); el = el.nextElementSibling)
      if (el.tagName === 'A' && el.dataset.r) out.push(el);
    return out;
  },
  apply() {
    const label = this.label();
    if (label && !label.querySelector('.nav-edit')) {
      // icon only: the label's text is what navdrag.js keeps the section's order under
      const b = h('button', { class: 'nav-edit', type: 'button', title: T('自訂顯示項目'), 'aria-label': T('自訂顯示項目'), html: icon('sliders') });
      b.onclick = e => { e.preventDefault(); e.stopPropagation(); this.open(b); };
      label.append(b);
    }
    const off = this.hidden();
    for (const a of this.links()) if (a.classList.contains('nav-off') !== off.has(a.dataset.r)) a.classList.toggle('nav-off', off.has(a.dataset.r));
    if (NavPill.el) NavPill.move(true);
  },
  open(anchor) {
    if (Popover.el && Popover.el.classList.contains('navpick')) return Popover.close();
    const off = this.hidden();
    const box = h('div', null, h('div', { class: 'np-h' }, T('在側欄顯示')));
    for (const a of this.links()) {
      const r = a.dataset.r;
      const pic = a.querySelector('svg, img');
      const row = h('button', { class: 'np-row' + (off.has(r) ? '' : ' on'), type: 'button', role: 'menuitemcheckbox', 'aria-checked': String(!off.has(r)) },
        h('span', { class: 'np-box', html: icon('check') }),
        pic ? pic.cloneNode(true) : null,
        h('span', { class: 'np-t' }, a.querySelector('span')?.textContent || r));
      row.onclick = () => {
        const s = this.hidden();
        s.has(r) ? s.delete(r) : s.add(r);
        setUiPref('navHidden', [...s].join(','));
        row.classList.toggle('on', !s.has(r)); row.setAttribute('aria-checked', String(!s.has(r)));
        this.apply();
      };
      box.append(row);
    }
    box.append(h('div', { class: 'np-foot' }, T('拖曳側欄項目可以調整順序。')));
    Popover.show(box, anchor, { cls: 'navpick' });
  },
};
$('#nav').addEventListener('contextmenu', e => {
  const a = e.target.closest('#nav > a[data-r]');
  if (!a || !NavPick.links().includes(a)) return;
  e.preventDefault();
  NavPick.open({ x: e.clientX, y: e.clientY });
});
// links added later by modules: hidden as chosen
new MutationObserver(() => NavPick.apply()).observe($('#nav'), { childList: true });
// the list's own box changes size without a window resize too (the player bar turning two-row, the brand, fonts)
if (window.ResizeObserver) new ResizeObserver(() => { if (NavPill.el) NavPill.move(true); else NavEdges.sync(); }).observe($('#nav'));

/** Calls `f` once as soon as the user starts scrolling (wheel, touch, keys, scrollbar). Returns an unsubscribe function. */
function onUserScroll(f) {
  const evs = ['wheel', 'touchmove', 'keydown', 'pointerdown'];
  const h = e => {
    if (e.type === 'wheel' && (e.mikuPageSwipe || (!e.deltaX && !e.deltaY))) return;
    if (e.type === 'keydown' && !/^(Arrow|Page|Home|End| )/.test(e.key)) return;
    off(); f();
  };
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
  if (PageEffects.reduced('album')) return;
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
  requestAnimationFrame(() => {
    let untrack = () => {};
    el.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)';
    el.style.transform = '';
    let finished = false;
    const end = () => {
      if (finished) return; finished = true;
      stop(); untrack();
      Object.assign(el.style, { transition: '', transform: '', transformOrigin: '', zIndex: '' });
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
    const finishNow = () => { el.style.transition = 'none'; el.style.transform = ''; end(); };
    const stop = onUserScroll(finishNow);
    untrack = PageEffects.track('album', finishNow);
    el.addEventListener('transitionend', e => { if (e.target === el && e.propertyName === 'transform') end(); });
    setTimeout(end, 650);
  });
}
/** Flying back into a list: the card sits deep inside grid rows / rails with their own stacking and
 *  clipping, so instead of moving it in place we fly an exact clone of it (wrapped in .card so every theme
 *  rule still matches) on top of the whole page, then show the real card and drop the clone in the same frame. */
function flyBackClone(target, b) {
  if (PageEffects.reduced('album')) return;
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
  // clip the flight to the content area so the cover never flies over the player bar / sidebar, nor over the top bar
  // (it floats over the top of the content area: the clone is above it, the real card goes under it)
  const cr = ($('#content') || document.body).getBoundingClientRect();
  const bar = $('#topbar'), br = bar && bar.offsetParent ? bar.getBoundingClientRect() : null;
  const top = br && br.height ? Math.min(cr.bottom, Math.max(cr.top, br.bottom)) : cr.top;
  const clip = h('div', { class: 'flip-clip' });
  Object.assign(clip.style, { position: 'fixed', left: cr.left + 'px', top: top + 'px', width: cr.width + 'px', height: (cr.bottom - top) + 'px', overflow: 'hidden', zIndex: 30, pointerEvents: 'none' });
  Object.assign(wrap.style, { position: 'absolute', left: (t.left - cr.left) + 'px', top: (t.top - top) + 'px', width: t.width + 'px', margin: 0, zIndex: 1,
    pointerEvents: 'none', transformOrigin: '0 0', animation: 'none',
    transform: `translate(${b.rect.left - t.left}px, ${b.rect.top - t.top}px) scale(${b.rect.width / t.width}, ${b.rect.height / t.height})` });
  clip.append(wrap); document.body.append(clip);
  target.style.visibility = 'hidden';
  if (card) card.classList.add('flip-dest');                 // VINYL: the record travels inside the flying sleeve, not ahead of it
  const ti = target.querySelector('img'); if (ti) ti.style.transition = 'none';
  void wrap.offsetWidth;
  requestAnimationFrame(() => {
    let untrack = () => {};
    wrap.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)';
    wrap.style.transform = 'none';
    let finished = false;
    const end = () => {
      if (finished) return; finished = true;
      stop(); untrack();
      target.style.visibility = '';
      if (card) card.classList.remove('flip-dest');
      requestAnimationFrame(() => clip.remove());
    };
    const stop = onUserScroll(end);
    untrack = PageEffects.track('album', end);
    wrap.addEventListener('transitionend', e => { if (e.target === wrap) end(); });
    setTimeout(end, 650);
  });
}
const Flip = {
  from: null,
  capture(id, artEl) {
    if (PageEffects.reduced('album')) { this.from = null; return; }
    const img = artEl && artEl.querySelector('img.ok');
    this.from = img ? { id, rect: artEl.getBoundingClientRect(), src: img.src } : null;
  },
  back: null,
  captureBack(id, coverEl) {
    if (PageEffects.reduced('album')) { this.back = null; return; }
    const img = coverEl && coverEl.querySelector('img.ok');
    this.back = img ? { id, rect: coverEl.getBoundingClientRect(), src: img.src } : null;
  },
  /** Fly the album page cover back onto its card in the list we returned to. */
  playBack() {
    const b = this.back;
    this.back = null;
    if (!b || PageEffects.reduced('album')) return;
    // the album grid is virtualised: its cards are created a frame or two after the view, so wait for ours
    let tries = 0;
    const find = () => {
      const content = $('#content').getBoundingClientRect();
      const target = [...document.querySelectorAll(`[data-album="${CSS.escape(b.id)}"]`)].find(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.bottom > content.top && r.top < content.bottom;
      });
      if (PageEffects.reduced('album')) return;
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
    if (!f || f.id !== id || !coverEl || PageEffects.reduced('album')) return;
    // the router resets the scroll position right after the view is built; measure only after that,
    // otherwise the start point is off by the old scroll distance (the cover came "from below")
    Promise.resolve().then(() => flipInto(coverEl, f.rect, f.src));
  },
};

/** Material-style ripple on anything clickable. */
document.addEventListener('pointerdown', e => {
  if (PageEffects.reduced('page') || (PageEffects.reduced('signal') && e.target.closest('.sig'))) return;
  const el = e.target.closest('.btn, .icon-btn, .round-btn, .chip, .seg button, .sig, .out-btn, .playbtn, .outrow, .menu button');
  if (!el || e.button !== 0) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2.2;
  const rp = h('span', { class: 'ripple', style: { width: size + 'px', height: size + 'px', left: (e.clientX - r.left - size / 2) + 'px', top: (e.clientY - r.top - size / 2) + 'px' } });
  el.append(rp);
  setTimeout(() => rp.remove(), 600);
}, true);
