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
const MikuExt = {
  defs: {}, settings: {}, slots: {}, paths: {}, slotKey: null, slotDef: null, slotSeq: 0,
  register(def) { if (def && def.id) this.defs[def.id] = def; },

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
    this.slotKey = key;
    const prev = this.slotDef;
    this.slotDef = def || null;
    const leaving = ++this.slotSeq;
    if (def) document.documentElement.dataset.extSource = source.ext;
    else delete document.documentElement.dataset.extSource;
    for (const [sel, fn] of [['#b-ext', def && def.bar], ['#np-ext', def && def.nowPlaying]]) {
      const el = $(sel);
      // leaving a module's list: its bar slot may play a way out (leaveBar, at most a second) before it is emptied
      if (!def && sel === '#b-ext' && prev && prev.leaveBar && !el.hidden) {
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
      play: (ids, shuffle = false, start = -1, opts = {}) =>
        Host.call('play', { ids, shuffle, start, at: opts.at || 0, source: opts.source ? { ...opts.source, ext: id } : undefined }),
      /**
       * { bar(el, source), nowPlaying(el, source), leaveBar(el) }: draw the player bar's and the now-playing page's
       * slots while a list this module played with a source is the queue; leaveBar (optional) plays the bar slot's
       * way out when another list is played, and returns a promise (waited for up to a second).
       */
      playerSlot: def => { this.slots[id] = def; this.slotKey = null; this.slot(App.queue && App.queue.source); },
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
    Host.on('queue', q => { this.queue = q; Queue.render(); Views.markPlaying(); MikuExt.slot(q.source); });
    Host.on('error', e => toast(T.msg(e.message), { error: true }));
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
    const cls = 'sig' + (sg ? ' q-' + sigQuality(sg) : '') + sigShine(sg);
    if (el.className !== cls) el.className = cls;
    if (!sg) { setText($('#b-sigtxt'), this.state.trackId ? T('已停止') : T('未播放')); return; }
    const src = sg.dsd ? sg.dsdLabel : `${sg.sourceBits || ''}${sg.sourceBits ? '/' : ''}${khz(sg.sourceRate)}`;
    setText($('#b-sigtxt'), `${sg.codec} ${src}${sg.dop ? ' · DoP' : ''}`);
  },

  /* ── frame loop: progress bars & lyrics ── */
  lastSec: -1, frameRaf: 0,
  /** Draw now unless the playing loop is already running (it draws the next frame anyway: no second style pass). */
  kick() { if (!(this.state.playing && this.frameRaf)) this.frame(); },
  frame() {
    cancelAnimationFrame(this.frameRaf);
    this.frameRaf = 0;
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
    if (s.playing) this.frameRaf = requestAnimationFrame(() => this.frame());
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
      if (e.key === 'F12') { Host.call('devtools'); return; }
      if (e.key === 'Escape' && !typing) { if (CoverView.close()) return; if (ArtPicker.close()) return; if (Popover.close()) return; if (Drawer.open) return Drawer.close(); if (NowPlaying.open) return NowPlaying.hide(); if (this.fullscreen) return Host.call('fullscreen', { on: false }); return; }
      Keys.handle(e, typing);
    });
    // mouse side buttons are handled natively by WebView2 (history back / forward)
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
    { label: T('播放'), icon: 'play', run: () => App.playTracks(list || [t], list ? list.indexOf(t) : 0) },
    { label: T('下一首播放'), icon: 'next-up', run: () => { Host.call('queue.add', { ids: [t.id], next: true }); toast(T('已排在下一首')); } },
    { label: T('加入播放佇列'), icon: 'queue', run: () => { Host.call('queue.add', { ids: [t.id] }); toast(T('已加入佇列')); } },
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
  const cue = await Convert.cueFor(al);  // 「按 CUE 標記切開…」 only when the album's folder has a CUE sheet for its big file
  menu([
    !onPage && { label: T('播放'), icon: 'play', run: () => App.playTracks(al.tracks, 0, false) },
    !onPage && { label: T('隨機播放'), icon: 'shuffle', run: () => App.playTracks(al.tracks, -1, true) },
    { label: T('下一首播放'), icon: 'next-up', run: () => { Host.call('queue.add', { ids: al.tracks.map(t => t.id), next: true }); toast(T('已排在下一首')); } },
    { label: T('加入播放佇列'), icon: 'queue', run: () => { Host.call('queue.add', { ids: al.tracks.map(t => t.id) }); toast(T`已加入 ${al.tracks.length} 首`); } },
    '-',
    ...(onPage ? [] : artistItems(al.artists.filter(realArtist))),
    // one entry: the cover view shows the picture and leads on to 更換封面 / 寫入音樂檔案
    { label: T('封面…'), icon: 'image', run: () => CoverView.open(al) },
    { label: T('編輯標籤…'), icon: 'list', run: () => TagEditor.open(al) },
    { label: T('轉換格式…'), icon: 'refresh', run: () => Convert.open({ album: al, tracks: al.tracks }) },
    cue && { label: T`按 CUE 標記切開（${cue.tracks.length} 首）…`, icon: 'list', run: () => Convert.open({ album: al, cue }) },
    { label: T('在檔案總管中顯示'), icon: 'folder', run: () => Host.call('reveal', { id: al.tracks[0]?.id }) },
    '-',
    { label: T('重新讀取專輯資訊'), icon: 'refresh', run: () => rereadAlbum(al) },
  ], anchor);
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
const QLabel = { bitperfect: 'Bit-perfect', enhanced: T('已處理'), high: T('高品質'), low: T('有損來源') };
/** The badge's quality, the same rule for every playback core: a resampled or converted path (upsampling, DSD → PCM,
 *  PCM → DSD) is 已處理 even when a core reports it as bit-perfect. */
const sigQuality = sg => sg.quality === 'bitperfect' && sg.resampled ? 'enhanced' : sg.quality;
/**
 * The badge's extra shine, the same for every playback core. Bit-perfect: DSD sent as DSD glows (DSD), hi-res (above
 * 16-bit / 48 kHz) sparkles (Hi-Res), CD-quality WAV / FLAC keeps the plain bit-perfect ring. Resampled or converted
 * (upsampling, DSD → PCM, PCM → DSD): the plain 已處理 badge for now. DSP on without resampling: toxic slime.
 */
const sigShine = sg => {
  if (!sg || sg.resampled) return '';
  if (sg.dspActive) return ' dsp';
  if (sigQuality(sg) !== 'bitperfect') return '';
  if (sg.dsd) return ' dsd';
  return (sg.sourceBits || 0) > 16 || (sg.sourceRate || 0) > 48000 ? ' hires' : '';
};
const QLead = {
  bitperfect: T('依目前訊號路徑設定，預期保持原始樣本數值。此標示未逐樣本驗證 DAC 端的資料。'),
  enhanced: T('訊號經過 DSP、重新取樣或數位音量處理（64-bit 浮點運算）。'),
  high: T('Windows 混音器會依系統格式處理音訊。改用獨佔模式可達到 Bit-perfect。'),
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
          // opening a stage is not a click on the card (an upsampled track's card turns over on a click)
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
      box.className = 'q-' + q + shine;
      box.append(h('h3', { html: `<i class="dot"></i>${QLabel[q]}${shine === ' hires' ? ' · Hi-Res' : shine === ' dsd' ? ' · DSD' : ''}` }), h('div', { class: 'lead' }, QLead[q]));
      const stage = sigStage;
      const src = sg.dsd ? `${sg.codec} · ${sg.dsdLabel} · ${(sg.sourceRate / 1e6).toFixed(4).replace(/0+$/, '')} MHz` : `${sg.codec} · ${sg.sourceBits ? sg.sourceBits + '-bit / ' : ''}${khz(sg.sourceRate)} kHz`;
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
      else if (sg.dsd) box.append(stage(T('DSD 轉 PCM'), `${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${gainText}`, true));
      else if (sg.resampled) box.append(stage(T('重新取樣'), `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${bandwidthText}${gainText}`, true));
      if (sg.replayGainDb != null) box.append(stage('ReplayGain', `${sg.replayGainDb > 0 ? '+' : ''}${sg.replayGainDb.toFixed(1)} dB`, true));
      if (sg.dspActive && sg.dspSummary) box.append(stage('DSP', sg.dspSummary, true));
      const vm = sg.volumeMode;
      const db = App.state.volumeDb;
      box.append(stage(T('音量'), vm === 'digital' ? (Math.abs(db) < 1e-9 ? T('數位音量 · 0 dB（不處理）') : T`數位音量 · ${db.toFixed(1)} dB`) : vm === 'hardware' ? T`DAC 硬體音量 · ${db.toFixed(1)} dB` : vm === 'none' ? T('無（請使用 DAC 旋鈕）') : T('固定 0 dB'), vm === 'digital' && Math.abs(db) > 1e-9));
      box.append(stage(T('輸出'), `${sg.mode} · ${sg.device}`, false));
      box.append(stage(T('格式'), `${sg.outputFormat} / ${khz(sg.outputRate)} kHz`, false));
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

/* ═════════════ the upsampling card: it leans under the pointer and turns over to a black-and-gold back ═════════════
   While the track is upsampled, the signal card reacts to the pointer like a real card: the side under the pointer
   sinks in, a soft glare follows it, a press pushes it a little deeper. A click turns it over to a black lacquer back
   with gold filigree, an engraved medallion and glints; another click turns it back. The art is drawn here (SVG),
   styled in app.css (.sig-back). Reduced motion / 輕量化「頁面與操作動畫」: no lean, the card turns without animation. */
const SigCard = {
  eligible: sg => !!(sg && sg.resampled && !sg.dsd && sg.outputRate > sg.sourceRate),
  calm: () => matchMedia('(prefers-reduced-motion: reduce)').matches || PageEffects.reduced('page'),
  n: 0,
  attach(pop, sg) {
    const back = h('div', { class: 'sig-back', 'aria-hidden': 'true', html: this.art(sg) });
    const glare = h('i', { class: 'sig-glare' });
    pop.classList.add('sig-card');
    pop.append(back, glare);
    // lean: eased toward the target every frame; x / y in degrees, z in px (negative = pressed in)
    const cur = { x: 0, y: 0, z: 0 }, aim = { x: 0, y: 0, z: 0 };
    let lean = null, raf = 0, last = 0, over = false, pressed = false, turning = false, flipped = false, down = null, scroll = 0;
    const tf = (o, turn = 0, lift = 0) => `perspective(1400px) translateZ(${(o.z + lift).toFixed(2)}px) rotateX(${o.x.toFixed(3)}deg) rotateY(${(o.y + turn).toFixed(3)}deg)`;
    // the lean is a held script animation: it wins over the card's own CSS entrance animations (fill: both), and the
    // turn's animations (newer) win over it while they run
    const apply = () => {
      if (!cur.x && !cur.y && !cur.z) { if (lean) { lean.cancel(); lean = null; } return; }
      const k = [{ transform: tf(cur) }, { transform: tf(cur) }];
      if (lean) lean.effect.setKeyframes(k);
      else { lean = pop.animate(k, { duration: 1, fill: 'forwards' }); lean.persist && lean.persist(); }
    };
    const step = now => {
      raf = 0;
      if (turning) return;
      const dt = last ? Math.min(64, now - last) : 16.7; last = now;
      const k = 1 - Math.pow(0.8, dt / 16.7);
      let moving = false;
      for (const a of ['x', 'y', 'z']) {
        cur[a] += (aim[a] - cur[a]) * k;
        if (Math.abs(aim[a] - cur[a]) < 0.01) cur[a] = aim[a]; else moving = true;
      }
      apply();
      if (moving) raf = requestAnimationFrame(step); else last = 0;
    };
    const kick = () => { if (!raf && !turning) raf = requestAnimationFrame(step); };
    const track = e => {
      // offset* ignore the card's own transform, so the lean doesn't feed back into the pointer position
      const nx = Math.max(-1, Math.min(1, (e.clientX - pop.offsetLeft) / pop.offsetWidth * 2 - 1));
      const ny = Math.max(-1, Math.min(1, (e.clientY - pop.offsetTop) / pop.offsetHeight * 2 - 1));
      aim.y = nx * 7; aim.x = -ny * 5; aim.z = pressed ? -18 : -7;
      pop.style.setProperty('--gx', ((nx + 1) * 50).toFixed(1) + '%');
      pop.style.setProperty('--gy', ((ny + 1) * 50).toFixed(1) + '%');
      kick();
    };
    const rest = () => { over = pressed = false; pop.classList.remove('sig-hover'); aim.x = aim.y = aim.z = 0; kick(); };
    pop.addEventListener('pointerenter', e => { if (e.pointerType === 'touch' || this.calm()) return; over = true; pop.classList.add('sig-hover'); track(e); });
    pop.addEventListener('pointermove', e => { if (over) track(e); });
    pop.addEventListener('pointerleave', rest);
    pop.addEventListener('pointerdown', e => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
      if (down && over) { pressed = true; track(e); }
    });
    pop.addEventListener('pointerup', e => { if (pressed) { pressed = false; if (over) track(e); } });
    pop.addEventListener('scroll', () => { glare.style.top = pop.scrollTop + 'px'; }, { passive: true });
    pop.addEventListener('click', e => {
      const d = down; down = null;
      if (!d || e.button !== 0 || turning) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 8) return;   // a drag: selecting text, scrolling
      if (!flipped && (e.target.closest('a, button, input, select, textarea, summary, label') || String(getSelection()).trim())) return;
      turn();
    });
    const turn = async () => {
      const to = !flipped;
      const swap = () => {
        if (to) { scroll = pop.scrollTop; pop.scrollTop = 0; pop.style.overflowY = 'hidden'; }
        pop.classList.toggle('sig-flipped', to);
        if (!to) { pop.style.overflowY = 'auto'; pop.scrollTop = scroll; }
        glare.style.top = pop.scrollTop + 'px';
        flipped = to;
        if (to) this.shine(back);
      };
      if (this.calm() || !pop.animate) { swap(); return; }
      turning = true; cancelAnimationFrame(raf); raf = 0; last = 0;
      // first half: the face turns away (and darkens) as the card lifts; the other face comes round already lit
      const away = pop.animate([
        { transform: tf(cur), filter: 'brightness(1)' },
        { transform: tf(cur, 90, 30), filter: 'brightness(.55)' },
      ], { duration: 150, easing: 'cubic-bezier(.45, 0, .85, .5)', fill: 'forwards' });
      try { await away.finished; } catch { turning = false; return; }
      swap();
      const back2 = pop.animate([
        { transform: tf(cur, -90, 30), filter: `brightness(${to ? 1.45 : 1.25})` },
        { transform: tf(cur, 6, 4), filter: 'brightness(1.08)', offset: 0.72 },
        { transform: tf(cur), filter: 'brightness(1)' },
      ], { duration: 290, easing: 'cubic-bezier(.2, .7, .3, 1)' });
      away.cancel();
      try { await back2.finished; } catch { }
      turning = false;
      apply(); kick();
    };
  },
  /** The one-shot light that runs over the back as it lands. */
  shine(back) { back.classList.remove('sb-land'); void back.offsetWidth; back.classList.add('sb-land'); },

  /** The back: lacquer, a damask field, a gold frame with beading, filigree corners and crests, a diamond lattice,
   *  an engraved medallion (a turning bezel round a rosette and a faceted star), the rate, glints. */
  art(sg) {
    const id = 'sbk' + (++this.n), f = v => +v.toFixed(2);
    const pt = (r, a) => `${f(100 + r * Math.sin(a))} ${f(100 - r * Math.cos(a))}`;
    const each = (n, fn, rot = 0) => Array.from({ length: n }, (_, i) => fn(rot + i * 2 * Math.PI / n, i)).join('');
    const lens = (n, r0, r1, w, rot) => each(n, a => { const m = (r0 + r1) / 2; return `M${pt(r0, a)}Q${pt(m, a + w)} ${pt(r1, a)}Q${pt(m, a - w)} ${pt(r0, a)}Z`; }, rot);
    // engine-turned rings: r(θ) = R + A·sin(kθ)
    const wave = (R, A, k, ph) => { let d = ''; for (let i = 0; i <= 180; i++) { const a = i / 180 * 2 * Math.PI; d += (i ? 'L' : 'M') + pt(R + A * Math.sin(k * a + ph), a); } return d + 'Z'; };
    const gold = '<stop offset="0" stop-color="#5a3d0c"/><stop offset=".14" stop-color="#c89b40"/><stop offset=".24" stop-color="#fff3c6"/><stop offset=".34" stop-color="#d9a944"/><stop offset=".48" stop-color="#7d5714"/><stop offset=".6" stop-color="#e6bf62"/><stop offset=".7" stop-color="#fff8dc"/><stop offset=".8" stop-color="#c4932f"/><stop offset="1" stop-color="#6a4810"/>';
    const P8 = Math.PI / 8;
    const star = each(8, (a, i) => {
      const R = i % 2 ? 23 : 34;
      return `<path d="M100 100L${pt(7.5, a - P8)}L${pt(R, a)}Z" fill="url(#${id}hi)"/><path d="M100 100L${pt(R, a)}L${pt(7.5, a + P8)}Z" fill="url(#${id}lo)"/>`;
    });
    const defs = `<svg class="sb-defs" width="0" height="0" aria-hidden="true"><defs>
      <linearGradient id="${id}c" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="80" y2="80">${gold}</linearGradient>
      <linearGradient id="${id}k" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="140" y2="36">${gold}</linearGradient>
      <linearGradient id="${id}m" gradientUnits="userSpaceOnUse" x1="18" y1="18" x2="182" y2="182">${gold}</linearGradient>
      <radialGradient id="${id}p" gradientUnits="userSpaceOnUse" cx="100" cy="100" r="84"><stop offset="0" stop-color="#fff3c8"/><stop offset=".45" stop-color="#f0cd73"/><stop offset=".75" stop-color="#b9862c"/><stop offset="1" stop-color="#5c3f0d"/></radialGradient>
      <radialGradient id="${id}d" gradientUnits="userSpaceOnUse" cx="100" cy="92" r="92"><stop offset="0" stop-color="#2c210c"/><stop offset=".6" stop-color="#120d05"/><stop offset="1" stop-color="#050402"/></radialGradient>
      <linearGradient id="${id}hi" gradientUnits="userSpaceOnUse" x1="66" y1="66" x2="134" y2="134"><stop offset="0" stop-color="#fffbe8"/><stop offset="1" stop-color="#e9c060"/></linearGradient>
      <linearGradient id="${id}lo" gradientUnits="userSpaceOnUse" x1="66" y1="66" x2="134" y2="134"><stop offset="0" stop-color="#b07c22"/><stop offset="1" stop-color="#4e340a"/></linearGradient>
      <radialGradient id="${id}j"><stop offset="0" stop-color="#fff"/><stop offset=".45" stop-color="#ffeaa8"/><stop offset="1" stop-color="#a7741f"/></radialGradient>
      <radialGradient id="${id}x"><stop offset="0" stop-color="#060504"/><stop offset=".7" stop-color="#060504" stop-opacity=".95"/><stop offset="1" stop-color="#060504" stop-opacity="0"/></radialGradient>
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
        <path stroke="#2a1c05" stroke-width=".7" stroke-linecap="round" d="M21 21L32.5 32.5"/>
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
        <path fill="#fff6d4" d="M70 4L63 13.5H70Z"/><path fill="#e4b856" d="M70 4L77 13.5H70Z"/>
        <path fill="#9b6c1d" d="M63 13.5L70 23V13.5Z"/><path fill="#c18e32" d="M77 13.5L70 23V13.5Z"/>
        <circle cx="70" cy="29.6" r="2.1" fill="url(#${id}j)"/>
      </symbol>
    </defs></svg>`;
    const medal = `<svg class="sb-rose" viewBox="0 0 200 200">
      <circle cx="100" cy="100" r="88" fill="url(#${id}d)"/>
      <g fill="none" stroke="#d1a24a" stroke-width=".45" opacity=".42">${[30, 37, 44, 51, 58, 65, 72].map((R, i) => `<path d="${wave(R, 1.8, 24, i * 1.1)}"/>`).join('')}</g>
      <circle cx="100" cy="100" r="88" fill="none" stroke="url(#${id}m)" stroke-width="2.4"/>
      <circle cx="100" cy="100" r="82.6" fill="none" stroke="#e9c46a" stroke-width="2.3" stroke-dasharray="0 6.49" stroke-linecap="round"/>
      <circle cx="100" cy="100" r="78" fill="none" stroke="url(#${id}m)" stroke-width=".9"/>
      <path d="${lens(16, 40, 75, .12, Math.PI / 16)}" fill="url(#${id}p)" opacity=".38"/>
      <path d="${lens(16, 44, 79, .19, 0)}" fill="url(#${id}p)" stroke="#3a2707" stroke-width=".6"/>
      <path d="${each(16, a => `M${pt(49, a)}L${pt(72, a)}`)}" stroke="#4a320b" stroke-width=".7" stroke-linecap="round"/>
      <g fill="#f1cf7a">${each(16, a => { const [x, y] = pt(41, a).split(' '); return `<circle cx="${x}" cy="${y}" r="1.25"/>`; }, Math.PI / 16)}</g>
      <path d="${lens(8, 15, 50, .34, P8)}" fill="url(#${id}m)" stroke="#3a2707" stroke-width=".6"/>
      <path d="${each(8, a => `M${pt(20, a)}L${pt(43, a)}`, P8)}" stroke="#4a320b" stroke-width=".6" stroke-linecap="round" opacity=".8"/>
      <circle cx="100" cy="100" r="21" fill="#0b0803" stroke="url(#${id}m)" stroke-width="1.4"/>
      <g stroke="#2a1c05" stroke-width=".35" stroke-linejoin="round">${star}</g>
      <circle cx="100" cy="100" r="4.3" fill="url(#${id}j)"/>
    </svg>`;
    const bezel = `<svg class="sb-ring" viewBox="0 0 200 200" fill="none">
      <circle cx="100" cy="100" r="97" stroke="#c99a3e" stroke-width=".6" opacity=".8"/>
      <circle cx="100" cy="100" r="93.6" stroke="#e9c46a" stroke-width="2.6" stroke-dasharray=".7 3.2" opacity=".85"/>
      <circle cx="100" cy="100" r="90.4" stroke="#c99a3e" stroke-width=".5" opacity=".6"/>
      ${each(4, (a, i) => `<path d="M100 1.8L103.2 6.6L100 11.4L96.8 6.6Z" fill="#d9a944" stroke="#fff3c6" stroke-width=".4" transform="rotate(${i * 90} 100 100)"/><circle cx="100" cy="6.6" r="1.3" fill="#e9c46a" transform="rotate(${i * 90 + 45} 100 100)"/>`)}
    </svg>`;
    const corner = c => `<svg class="sb-corner ${c}" viewBox="0 0 80 80"><use href="#${id}corner"/></svg>`;
    const crest = c => `<svg class="sb-crest ${c}" viewBox="0 0 140 36"><use href="#${id}crest"/></svg>`;
    // glints sit on the gold: [left, top, delay s, size]
    const glints = [
      ['58px', '58px', 0, 1], ['calc(100% - 95px)', '23px', -2.5, .7], ['35px', 'calc(100% - 65px)', -1.6, .85],
      ['calc(100% - 58px)', 'calc(100% - 58px)', -3, 1], ['50%', '18px', -2, 1.15], ['50%', 'calc(100% - 18px)', -.9, .9],
      ['50%', '50%', -3.3, 1.5], ['calc(50% + var(--m) * .26)', 'calc(50% - var(--m) * .3)', -1.4, .7],
      ['calc(50% - var(--m) * .3)', 'calc(50% + var(--m) * .22)', -2.3, .6], ['16px', '50%', -.6, .8],
      ['calc(100% - 16px)', '50%', -2.7, .8], ['30%', '7px', -1.7, .6], ['calc(100% - 7px)', '72%', -.3, .55],
    ].map(([x, y, d, s]) => `<i class="sb-gl" style="left:${x};top:${y};animation-delay:${d}s;--s:${s}"></i>`).join('');
    const rate = `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz`;
    return defs + `<div class="sb-bg"></div><div class="sb-rays"></div><i class="sb-dust a"></i><i class="sb-dust b"></i>
      <svg class="sb-lattice" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" stroke="#c99a3e">
        <polygon points="50,0 100,50 50,100 0,50" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".5"/>
        <polygon points="50,6 94,50 50,94 6,50" stroke-width=".6" vector-effect="non-scaling-stroke" opacity=".26"/>
      </svg>
      <i class="sb-frame"></i><i class="sb-beads"></i><i class="sb-frame2"></i>
      ${corner('tl')}${corner('tr')}${corner('bl')}${corner('br')}${crest('t')}${crest('b')}
      <i class="sb-node l"></i><i class="sb-node r"></i>
      <div class="sb-medal"><i class="sb-glow"></i>${medal}${bezel}</div>
      <div class="sb-cap"><b>${esc(rate)}</b></div>
      <i class="sb-sheen"></i><i class="sb-spec"></i>${glints}<i class="sb-burst"></i><i class="sb-flash"></i>`;
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
  const wild = typeof Blast !== 'undefined' && Blast.on;
  requestAnimationFrame(() => {
    let anim = null, untrack = () => {};
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
    const finishNow = () => { if (anim) anim.cancel(); el.style.transition = 'none'; el.style.transform = ''; end(); };
    const stop = onUserScroll(finishNow);
    untrack = PageEffects.track('album', finishNow);
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
  const wild = typeof Blast !== 'undefined' && Blast.on;
  requestAnimationFrame(() => {
    let anim = null, untrack = () => {};
    if (wild) {
      const start = wrap.style.transform, tm = Blast.flightTiming();
      wrap.style.transform = 'none';
      const kf = Blast.flight(b.rect.left - t.left, b.rect.top - t.top, b.rect.width / t.width, b.rect.height / t.height);
      kf[0] = { transform: start };
      anim = wrap.animate(kf, tm);
      anim.onfinish = () => end();
      setTimeout(() => end(), tm.duration + 200);
    } else {
      wrap.style.transition = 'transform .5s cubic-bezier(.2,.8,.2,1)';
      wrap.style.transform = 'none';
    }
    let finished = false;
    const end = () => {
      if (finished) return; finished = true;
      stop(); untrack(); if (anim) anim.cancel();
      target.style.visibility = '';
      if (card) card.classList.remove('flip-dest');
      requestAnimationFrame(() => clip.remove());
    };
    const stop = onUserScroll(end);
    untrack = PageEffects.track('album', end);
    if (!wild) {
      wrap.addEventListener('transitionend', e => { if (e.target === wrap) end(); });
      setTimeout(end, 650);
    }
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
