'use strict';
/* MIKU phone remote — talks to the MIKU desktop app over the LAN (RemoteServer.cs). */

/* ═════════════════════════════ helpers ═════════════════════════════ */
const $ = s => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const ico = (n, f) => `<svg class="i${f ? ' f' : ''}"><use href="#i-${n}"/></svg>`;
const fmtTime = s => {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return (hh ? hh + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const fmtLong = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分鐘` : `${m} 分鐘`; };
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const khz = r => (r / 1000).toFixed(1).replace(/\.0$/, '');
const debounce = (f, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), ms); }; };
const collator = new Intl.Collator(['ja', 'zh-Hant', 'en'], { sensitivity: 'base', numeric: true });
function store(k, v) { try { if (v === undefined) return localStorage.getItem('miku.' + k); localStorage.setItem('miku.' + k, v); } catch { return null; } }

function toast(msg, err) {
  const el = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), err ? 5000 : 2600);
}

/** Calls fn on a long press (and suppresses the click that follows). */
function onLong(el, fn) {
  let t, x, y, fired = false;
  el.addEventListener('touchstart', e => { fired = false; x = e.touches[0].clientX; y = e.touches[0].clientY; t = setTimeout(() => { fired = true; if (navigator.vibrate) navigator.vibrate(10); fn(); }, 480); }, { passive: true });
  el.addEventListener('touchmove', e => { if (Math.abs(e.touches[0].clientX - x) + Math.abs(e.touches[0].clientY - y) > 10) clearTimeout(t); }, { passive: true });
  el.addEventListener('touchend', () => clearTimeout(t));
  el.addEventListener('click', e => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
  el.addEventListener('contextmenu', e => { e.preventDefault(); if (!fired) fn(); });
}

/* ═════════════════════════════ connection ═════════════════════════════ */
const Api = {
  token: store('token') || '',
  async req(path, opts = {}) {
    let r;
    try {
      r = await fetch(path, { ...opts, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Miku-Token': this.token, ...(opts.headers || {}) } });
    } catch (e) { App.setOnline(false); const err = new Error('無法連線到 MIKU'); err.offline = true; throw err; }
    if (r.status === 401) { this.token = ''; store('token', ''); Pair.show(); const err = new Error('unpaired'); err.unpaired = true; throw err; }
    return r;
  },
  async rpc(m, a = {}) {
    const r = await this.req('/api/rpc', { method: 'POST', body: JSON.stringify({ m, a }) });
    const j = await r.json();
    if (j.e) throw new Error(j.e);
    return j.r;
  },
  art(kind, id, size) {
    const s = Math.round(size * Math.min(window.devicePixelRatio || 2, 3));
    return `/media/art/${kind}/${encodeURIComponent(id)}?s=${s}&t=${this.token}`;
  },
};
/** RPC that reports failures as a toast instead of throwing. */
async function call(m, a = {}) {
  try { return await Api.rpc(m, a); }
  catch (e) { if (!e.unpaired) toast(e.message, true); return undefined; }
}

const Events = {
  es: null,
  start() {
    this.stop();
    const es = this.es = new EventSource('/api/events?t=' + encodeURIComponent(Api.token));
    es.onopen = () => App.setOnline(true);
    es.onmessage = e => { try { const m = JSON.parse(e.data); App.onEvent(m.ev, m.d); } catch (err) { console.error(err); } };
    es.onerror = () => {
      App.setOnline(false);
      if (es.readyState === 2) { this.es = null; setTimeout(() => App.reconnect(), 2000); }
    };
  },
  stop() { if (this.es) { this.es.close(); this.es = null; } },
};

/* ═════════════════════════════ library (cached in IndexedDB per revision) ═════════════════════════════ */
const DB = {
  db: null,
  open() {
    if (this.db) return this.db;
    return this.db = new Promise((res, rej) => {
      try {
        const r = indexedDB.open('miku-remote', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  },
  async get(k) {
    try { const db = await this.open(); return await new Promise(res => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); }
    catch { return null; }
  },
  async put(k, v) {
    try { const db = await this.open(); db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); } catch { }
  },
};

const Lib = {
  albums: [], tracks: [], artists: [], albumById: new Map(), trackById: new Map(), artistMap: new Map(), rev: null, sorted: {},
  async load(rev) {
    let text = null;
    const cached = await DB.get('lib');
    if (cached && cached.rev === rev && rev != null) text = cached.text;
    else {
      const r = await Api.req('/media/library.json');
      text = await r.text();
      DB.put('lib', { rev, text });
    }
    this.parse(JSON.parse(text));
    this.rev = rev;
  },
  parse(data) {
    const albums = [], albumById = new Map(), trackById = new Map(), tracks = [];
    for (const a of data.albums) {
      const al = { id: a[0], title: a[1], artist: a[2], year: a[3], genre: a[4], added: a[5], hasArt: !!a[6], loose: !!a[7], tracks: [], dur: 0 };
      albums.push(al); albumById.set(al.id, al);
    }
    for (const r of data.tracks) {
      const t = { id: r[0], title: r[1], artist: r[2], albumId: r[3], disc: r[4], no: r[5], dur: r[6], codec: r[7], rate: r[8], bits: r[9], year: r[10] };
      const al = albumById.get(t.albumId);
      t.album = al;
      if (al) { al.tracks.push(t); al.dur += t.dur; }
      tracks.push(t); trackById.set(t.id, t);
    }
    const artistMap = new Map();
    for (const al of albums) {
      al.s = norm(al.title + ' ' + al.artist);
      if (al.artist && al.artist !== 'Various Artists' && al.artist !== '未知演出者') {
        let ar = artistMap.get(al.artist);
        if (!ar) artistMap.set(al.artist, ar = { name: al.artist, albums: [], s: norm(al.artist) });
        ar.albums.push(al);
      }
    }
    for (const t of tracks) t.s = norm(t.title + ' ' + t.artist + ' ' + (t.album ? t.album.title : ''));
    Object.assign(this, { albums, tracks, albumById, trackById, artistMap, sorted: {}, artists: [...artistMap.values()].sort((a, b) => collator.compare(a.name, b.name)) });
  },
  albumsBy(sort) {
    const key = 'a:' + sort;
    if (this.sorted[key]) return this.sorted[key];
    const a = this.albums.slice();
    if (sort === 'title') a.sort((x, y) => collator.compare(x.title, y.title));
    else if (sort === 'artist') a.sort((x, y) => collator.compare(x.artist, y.artist) || (x.year || 0) - (y.year || 0));
    else if (sort === 'year') a.sort((x, y) => (y.year || 0) - (x.year || 0) || collator.compare(x.title, y.title));
    else a.sort((x, y) => y.added - x.added);
    return this.sorted[key] = a;
  },
  tracksBy(sort) {
    const key = 't:' + sort;
    if (this.sorted[key]) return this.sorted[key];
    const t = this.tracks.slice();
    const inAlbum = (x, y) => (x.disc - y.disc) || (x.no - y.no);
    if (sort === 'artist') t.sort((x, y) => collator.compare(x.artist, y.artist) || collator.compare(x.album?.title || '', y.album?.title || '') || inAlbum(x, y));
    else if (sort === 'album') t.sort((x, y) => collator.compare(x.album?.title || '', y.album?.title || '') || inAlbum(x, y));
    else if (sort === 'added') t.sort((x, y) => ((y.album?.added || 0) - (x.album?.added || 0)) || collator.compare(x.album?.title || '', y.album?.title || '') || inAlbum(x, y));
    else t.sort((x, y) => collator.compare(x.title, y.title));
    return this.sorted[key] = t;
  },
  artistAlbums(name) {
    const own = (this.artistMap.get(name)?.albums || []).slice().sort((a, b) => (b.year || 0) - (a.year || 0));
    const nn = norm(name);
    const appears = nn ? this.albums.filter(a => !own.includes(a) && a.tracks.some(t => norm(t.artist).includes(nn))) : [];
    return { own, appears };
  },
};

/* ═════════════════════════════ shared UI pieces ═════════════════════════════ */
function art(kind, id, size, label, cls = '') {
  const box = h('div', { class: 'art ' + cls, 'data-l': String(label || '').trim().slice(0, 1).toUpperCase() });
  if (id) {
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'lazy';
    img.alt = '';
    img.onload = () => img.classList.add('ok');
    img.onerror = () => img.remove();
    img.src = Api.art(kind, id, size);
    box.append(img);
  }
  return box;
}
const albumArt = (al, size, cls) => al?.loose ? art('t', al.tracks[0]?.id, size, al.title, cls) : art('a', al?.id, size, al?.title, cls);
const trackArt = (t, size, cls) => t.album?.loose ? art('t', t.id, size, t.title, cls) : art('a', t.albumId, size, t.album?.title || t.title, cls);
const ytImg = (url, s) => url ? url.replace(/=w\d+-h\d+/, `=w${s}-h${s}`).replace(/\/(?:hq|mq|sd)?default\.jpg/, '/hqdefault.jpg') : '';

function albumCard(al) {
  const a = albumArt(al, 170);
  a.dataset.album = al.id;
  const el = h('button', { class: 'card', onclick: () => openAlbum(al.id, a) },
    a, h('b', null, al.title), h('small', null, al.artist + (al.year ? ' · ' + al.year : '')));
  onLong(el, () => Menu.album(al));
  return el;
}

const eqIcon = () => h('span', { class: 'eq' }, h('i'), h('i'), h('i'));
function trackRow(t, opts = {}) {
  const left = opts.no != null
    ? h('span', { class: 'no' }, h('span', { class: 'n' }, opts.no || '·'), eqIcon())
    : trackArt(t, 44, 'sm');
  const row = h('div', { class: 'row', 'data-id': t.id, role: 'button', onclick: opts.onTap },
    left,
    h('div', { class: 't' }, h('b', null, t.title), h('small', null, opts.sub ?? [t.artist, t.album?.title].filter(Boolean).join(' · '))),
    h('span', { class: 'd' }, fmtTime(t.dur)),
    h('button', { class: 'ib', 'aria-label': '更多', html: ico('more'), onclick: e => { e.stopPropagation(); Menu.track(t, opts.menu); } }));
  onLong(row, () => Menu.track(t, opts.menu));
  return row;
}

/** Appends items in batches as the user scrolls, so long lists (30 000+ tracks) stay fast. */
function lazyList(container, items, render, batch = 60) {
  let i = 0;
  const sentinel = h('div', { class: 'more' });
  container.append(sentinel);
  const page = container.closest('.page');
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: page, rootMargin: '1200px 0px' });
  function more() {
    const frag = document.createDocumentFragment();
    const end = Math.min(items.length, i + batch);
    for (; i < end; i++) frag.append(render(items[i], i));
    container.insertBefore(frag, sentinel);
    if (i >= items.length) { io.disconnect(); sentinel.remove(); }
  }
  more();
  if (i < items.length) io.observe(sentinel);
  const stop = () => io.disconnect();
  if (page) (page._cleanup ||= []).push(stop);
  return { stop, ensure(n) { while (i < Math.min(n, items.length)) more(); } };
}

function play(ids, start = 0, shuffle) {
  if (!ids.length) return;
  call('play', { ids, start, shuffle: shuffle ?? !!App.queue.shuffle });
}

/* ═════════════════════════════ action sheet ═════════════════════════════ */
const Menu = {
  open(head, items) {
    const box = $('#sheet .sheetbox');
    box.textContent = '';
    if (head) box.append(head);
    for (const it of items) {
      if (!it) continue;
      box.append(h('button', { class: it.danger ? 'danger' : '', html: (it.icon ? ico(it.icon) : '') + `<span>${it.label}</span>`, onclick: () => { this.close(); it.run(); } }));
    }
    box.append(h('button', { class: 'cancel', onclick: () => this.close() }, '取消'));
    $('#sheet').hidden = false;
  },
  close() { $('#sheet').hidden = true; },
  head(artEl, title, sub) { return h('div', { class: 'sh' }, artEl, h('div', { class: 't' }, h('b', null, title), h('small', null, sub || ''))); },
  track(t, extra = []) {
    const fav = App.favs.has(t.id);
    this.open(this.head(trackArt(t, 44, 'sm'), t.title, [t.artist, t.album?.title].filter(Boolean).join(' · ')), [
      ...extra,
      { label: '下一首播放', icon: 'next-up', run: async () => { await call('queue.add', { ids: [t.id], next: true }); toast('已排在下一首'); } },
      { label: '加入播放佇列', icon: 'queue', run: async () => { await call('queue.add', { ids: [t.id], next: false }); toast('已加入佇列'); } },
      t.album && { label: '前往專輯', icon: 'album', run: () => { NP.close(); Nav.push({ v: 'album', id: t.albumId }); } },
      t.artist && { label: '前往演出者', icon: 'artist', run: () => { NP.close(); Nav.push({ v: 'artist', name: Lib.artistMap.has(t.album?.artist) ? t.album.artist : t.artist }); } },
      { label: fav ? '從我的最愛移除' : '加入我的最愛', icon: 'heart', run: () => App.setFav(t.id, !fav) },
    ]);
  },
  album(al) {
    const ids = al.tracks.map(t => t.id);
    this.open(this.head(albumArt(al, 44, 'sm'), al.title, al.artist), [
      { label: '播放', icon: 'play', run: () => play(ids, 0, false) },
      { label: '隨機播放', icon: 'shuffle', run: () => play(ids, -1, true) },
      { label: '下一首播放', icon: 'next-up', run: async () => { await call('queue.add', { ids, next: true }); toast('已排在下一首'); } },
      { label: '加入播放佇列', icon: 'queue', run: async () => { await call('queue.add', { ids, next: false }); toast(`已加入 ${ids.length} 首`); } },
      al.artist && Lib.artistMap.has(al.artist) && { label: '前往演出者', icon: 'artist', run: () => Nav.push({ v: 'artist', name: al.artist }) },
    ]);
  },
};
$('#sheet .sheetbg').onclick = () => Menu.close();

/* ═════════════════════════════ navigation ═════════════════════════════ */
const TabTitles = { home: 'MIKU', albums: '專輯', artists: '演出者', tracks: '曲目', queue: '播放佇列' };
const EASE = 'cubic-bezier(.2, .8, .2, 1)';
/**
 * Every page is its own layer (a scrolling .page element) that stays alive while it is in a tab's stack,
 * so tabs keep their scroll position and the previous page can be shown under an interactive swipe-back.
 */
const Nav = {
  tab: 'home',
  stacks: { home: [{ v: 'home' }], albums: [{ v: 'albums' }], artists: [{ v: 'artists' }], tracks: [{ v: 'tracks' }], queue: [{ v: 'queue' }] },
  busy: false,
  get stack() { return this.stacks[this.tab]; },
  get top() { const s = this.stack; return s[s.length - 1]; },
  get prev() { const s = this.stack; return s[s.length - 2]; },

  build(e) {
    const el = e.el = h('div', { class: 'page' });
    $('#view').append(el);
    (Views[e.v] || Views.home)(el, e);
  },
  rebuild(e) {
    if (!e?.el) return;
    const y = e.el.scrollTop;
    (e.el._cleanup || []).forEach(f => f()); e.el._cleanup = [];
    e.el.textContent = '';
    (Views[e.v] || Views.home)(e.el, e);
    e.el.scrollTop = y;
    if (e === this.top) this.header();
    App.markPlaying();
  },
  rebuildAll(names) {
    for (const s of Object.values(this.stacks)) for (const e of s) if (e.el && names.includes(e.v)) this.rebuild(e);
  },
  destroy(e) {
    if (!e?.el) return;
    (e.el._cleanup || []).forEach(f => f());
    e.el.remove();
    e.el = null;
  },
  header() {
    const t = this.top;
    $('#title').textContent = t.title || TabTitles[t.v] || '';
    $('#back').classList.toggle('hide', this.stack.length < 2);
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab));
  },
  /** Only the current tab's top page is visible. */
  show() {
    for (const [tab, s] of Object.entries(this.stacks))
      s.forEach((e, i) => { if (e.el) { e.el.hidden = !(tab === this.tab && i === s.length - 1); e.el.style.transform = ''; } });
    this.header();
    App.markPlaying();
  },
  start() {
    for (const [tab, st] of Object.entries(this.stacks)) { st.forEach(e => this.destroy(e)); this.stacks[tab] = [{ v: tab }]; }
    this.busy = false;
    this.build(this.top);
    this.show();
  },
  go(tab) {
    if (this.busy) return;
    if (tab === this.tab) {
      const s = this.stack;
      if (s.length > 1) { s.splice(1).forEach(e => this.destroy(e)); this.show(); }
      else this.top.el?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    this.tab = tab;
    if (!this.top.el) this.build(this.top);
    this.show();
  },
  /** how: 'slide' (iOS push) or 'fade' (used when an album cover flies into the new page). */
  async push(view, how = 'slide') {
    if (this.busy) return;
    const prev = this.top;
    const e = { ...view };
    this.stack.push(e);
    this.build(e);
    this.header();
    e.el.hidden = false;
    this.busy = true;
    try {
      if (how === 'fade') {
        await e.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' }).finished;
      } else {
        await Promise.all([
          e.el.animate([{ transform: 'translateX(100%)' }, { transform: 'translateX(0)' }], { duration: 380, easing: EASE }).finished,
          prev.el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-28%)' }], { duration: 380, easing: EASE }).finished,
        ]);
      }
    } catch { }
    prev.el.hidden = true;
    this.busy = false;
    App.markPlaying();
  },
  /** from: how far (px) a swipe already dragged the page. */
  async back(opts = {}) {
    if (this.busy || this.stack.length < 2) return;
    const cur = this.top, prev = this.prev;
    const W = window.innerWidth, from = opts.from || 0;
    this.busy = true;
    prev.el.hidden = false;
    prev.el.style.transform = '';
    cur.el.style.transform = '';
    // the album cover flies back onto its card (not after a swipe: there the page itself is being dragged away)
    const fly = cur.v === 'album' && !opts.swipe ? Flip.captureBack(cur.el, cur.id) : null;
    this.stack.pop();
    this.header();
    if (fly) Flip.playBack(fly, prev.el);
    const dur = Math.max(160, 340 * (1 - from / W));
    try {
      await Promise.all([
        cur.el.animate([{ transform: `translateX(${from}px)` }, { transform: 'translateX(100%)' }], { duration: dur, easing: EASE }).finished,
        prev.el.animate([{ transform: `translateX(${-0.28 * (W - from)}px)` }, { transform: 'translateX(0)' }], { duration: dur, easing: EASE }).finished,
      ]);
    } catch { }
    this.destroy(cur);
    this.busy = false;
    App.markPlaying();
  },
};
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => Nav.go(b.dataset.tab));
$('#back').onclick = () => Nav.back();
$('#searchBtn').onclick = () => { if (Nav.top.v !== 'search') Nav.push({ v: 'search', q: '' }); else Nav.top.el.querySelector('.filter')?.focus(); };

/* interactive swipe-from-the-left-edge to go back (like iOS) */
{
  const view = $('#view');
  let sw = null;
  view.addEventListener('touchstart', e => {
    if (Nav.busy || Nav.stack.length < 2 || e.touches.length > 1) return;
    const t = e.touches[0];
    if (t.clientX > 28) return;
    sw = { x0: t.clientX, y0: t.clientY, dx: 0, lock: null, started: false, last: [{ x: t.clientX, t: performance.now() }] };
  }, { passive: true });
  view.addEventListener('touchmove', e => {
    if (!sw) return;
    const t = e.touches[0], dx = t.clientX - sw.x0, dy = t.clientY - sw.y0;
    if (!sw.lock) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      sw.lock = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (sw.lock === 'v') { sw = null; return; }
    }
    e.preventDefault();
    const cur = Nav.top, prev = Nav.prev, W = window.innerWidth;
    if (!sw.started) { sw.started = true; prev.el.hidden = false; cur.el.classList.add('dragging'); prev.el.classList.add('dragging'); }
    sw.dx = Math.max(0, dx);
    cur.el.style.transform = `translateX(${sw.dx}px)`;
    prev.el.style.transform = `translateX(${-0.28 * (W - sw.dx)}px)`;
    sw.last.push({ x: t.clientX, t: performance.now() });
    if (sw.last.length > 5) sw.last.shift();
  }, { passive: false });
  const end = async () => {
    if (!sw) return;
    const s = sw; sw = null;
    if (!s.started) return;
    const cur = Nav.top, prev = Nav.prev, W = window.innerWidth;
    cur.el.classList.remove('dragging'); prev.el.classList.remove('dragging');
    const a = s.last[0], b = s.last[s.last.length - 1];
    const v = (b.x - a.x) / Math.max(1, b.t - a.t); // px per ms
    if (s.dx > W * 0.35 || (v > 0.45 && s.dx > 24)) { Nav.back({ from: s.dx, swipe: true }); return; }
    // not far enough: snap back
    Nav.busy = true;
    cur.el.style.transform = ''; prev.el.style.transform = '';
    try {
      await Promise.all([
        cur.el.animate([{ transform: `translateX(${s.dx}px)` }, { transform: 'translateX(0)' }], { duration: 220, easing: EASE }).finished,
        prev.el.animate([{ transform: `translateX(${-0.28 * (W - s.dx)}px)` }, { transform: 'translateX(-28%)' }], { duration: 220, easing: EASE }).finished,
      ]);
    } catch { }
    prev.el.hidden = true;
    Nav.busy = false;
  };
  view.addEventListener('touchend', end);
  view.addEventListener('touchcancel', end);
}

/* ═════════════════════════════ album cover flight (shared-element transition) ═════════════════════════════ */
function openAlbum(id, artEl) {
  Flip.capture(id, artEl);
  Nav.push({ v: 'album', id }, Flip.from ? 'fade' : 'slide');
}
const Flip = {
  from: null,
  ghost(src, r) {
    const g = h('div', { class: 'flip-ghost' }, h('img', { src }));
    Object.assign(g.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    document.body.append(g);
    return g;
  },
  capture(id, artEl) {
    const img = artEl && artEl.querySelector('img.ok');
    this.from = img ? { id, rect: artEl.getBoundingClientRect(), src: img.src } : null;
  },
  /** Card cover → album page header. */
  play(id, coverEl) {
    const f = this.from;
    this.from = null;
    if (!f || f.id !== id || !coverEl) return;
    const g = this.ghost(f.src, f.rect);
    coverEl.classList.add('flip-hide');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const t = coverEl.getBoundingClientRect();
      const sx = t.width / f.rect.width, sy = t.height / f.rect.height;
      g.style.transform = `translate(${t.left - f.rect.left}px, ${t.top - f.rect.top}px) scale(${sx}, ${sy})`;
      g.style.borderRadius = (12 / sx) + 'px';
      let done = false;
      const reveal = () => {
        if (done) return; done = true;
        coverEl.classList.remove('flip-hide');
        g.style.transition = 'opacity .25s'; g.style.opacity = 0;
        setTimeout(() => g.remove(), 280);
      };
      // keep the flying picture until the large cover has loaded, then cross-fade
      const whenCover = () => {
        const img = coverEl.querySelector('img');
        if (!img || img.classList.contains('ok')) return reveal();
        img.addEventListener('load', () => setTimeout(reveal, 30), { once: true });
        img.addEventListener('error', reveal, { once: true });
        setTimeout(reveal, 1500);
      };
      g.addEventListener('transitionend', whenCover, { once: true });
      setTimeout(whenCover, 600);
    }));
  },
  captureBack(pageEl, id) {
    const cover = pageEl.querySelector('.hero .art');
    const img = cover && cover.querySelector('img.ok');
    if (!img) return null;
    const r = cover.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return null; // scrolled away: just slide
    return { id, rect: r, src: img.src, cover };
  },
  /** Album page header → the card in the page we return to. */
  playBack(b, pageEl) {
    const target = [...pageEl.querySelectorAll(`[data-album="${CSS.escape(b.id)}"]`)].find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    });
    if (!target) return;
    const t = target.getBoundingClientRect(); // the returning page is already at its final position here
    const g = this.ghost(b.src, b.rect);
    g.style.borderRadius = '12px';
    b.cover.style.visibility = 'hidden';
    target.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const sx = t.width / b.rect.width, sy = t.height / b.rect.height;
      g.style.transform = `translate(${t.left - b.rect.left}px, ${t.top - b.rect.top}px) scale(${sx}, ${sy})`;
      g.style.borderRadius = (10 / sx) + 'px';
      let done = false;
      const fin = () => {
        if (done) return; done = true;
        target.style.visibility = '';
        g.style.transition = 'opacity .15s'; g.style.opacity = 0;
        setTimeout(() => g.remove(), 170);
      };
      g.addEventListener('transitionend', fin, { once: true });
      setTimeout(fin, 600);
    });
  },
};

/* ═════════════════════════════ views ═════════════════════════════ */
function filterBar(v, placeholder, sorts, onChange) {
  const inp = h('input', { class: 'filter', type: 'search', placeholder, value: v.q || '', enterkeyhint: 'search', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false' });
  inp.addEventListener('input', debounce(() => { v.q = inp.value; onChange(); }, 180));
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
  const bar = h('div', { class: 'bar' }, inp);
  if (sorts) {
    const sel = h('select', { class: 'sort' }, ...sorts.map(([k, l]) => h('option', { value: k, selected: k === v.sort }, l)));
    sel.onchange = () => { v.sort = sel.value; store('sort.' + v.v, sel.value); onChange(); };
    bar.append(sel);
  }
  return bar;
}

const Views = {
  home(el) {
    el.append(h('div', { class: 'homeNow' }), h('div', { class: 'homeYt' }));
    App.updateHome();
    const recent = Lib.albumsBy('added').slice(0, 24);
    if (recent.length) {
      el.append(h('div', { class: 'sec' }, h('h2', null, '最近加入'), h('button', { onclick: () => { Nav.stacks.albums.forEach(e => Nav.destroy(e)); Nav.stacks.albums = [{ v: 'albums', sort: 'added' }]; Nav.go('albums'); } }, '全部')));
      el.append(h('div', { class: 'hscroll' }, recent.map(albumCard)));
    }
    const favs = Lib.tracks.filter(t => App.favs.has(t.id));
    if (favs.length) {
      el.append(h('div', { class: 'sec' }, h('h2', null, '我的最愛'), h('button', { onclick: () => Nav.push({ v: 'favs' }) }, '全部')));
      const list = h('div');
      favs.slice(0, 6).forEach((t, i) => list.append(trackRow(t, { onTap: () => play(favs.map(x => x.id), i) })));
      el.append(list);
    }
    if (!App.randomPick) {
      const a = Lib.albums.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      App.randomPick = a.slice(0, 18);
    }
    if (App.randomPick.length) {
      el.append(h('div', { class: 'sec' }, h('h2', null, '隨機推薦'), h('button', { onclick: () => { App.randomPick = null; Nav.rebuild(Nav.top); } }, '換一批')));
      el.append(h('div', { class: 'hscroll' }, App.randomPick.map(albumCard)));
    }
    if (!Lib.albums.length) el.append(h('div', { class: 'empty' }, 'MIKU 的曲庫是空的，請先在電腦上加入音樂資料夾。'));
  },

  albums(el, v) {
    v.sort ??= store('sort.albums') || 'added';
    const grid = h('div', { class: 'grid' });
    let lz;
    const draw = () => {
      grid.textContent = '';
      lz?.stop();
      const q = norm(v.q);
      const list = q ? Lib.albumsBy(v.sort).filter(a => a.s.includes(q)) : Lib.albumsBy(v.sort);
      if (!list.length) grid.append(h('div', { class: 'empty', style: { gridColumn: '1/-1' } }, q ? '找不到符合的專輯' : '沒有專輯'));
      lz = lazyList(grid, list, albumCard, 36);
    };
    el.append(filterBar(v, `搜尋 ${Lib.albums.length} 張專輯`, [['added', '最近加入'], ['title', '名稱'], ['artist', '演出者'], ['year', '年份']], draw), grid);
    draw();
  },

  artists(el, v) {
    const list = h('div');
    let lz;
    const draw = () => {
      list.textContent = '';
      lz?.stop();
      const q = norm(v.q);
      const items = q ? Lib.artists.filter(a => a.s.includes(q)) : Lib.artists;
      if (!items.length) list.append(h('div', { class: 'empty' }, '找不到符合的演出者'));
      lz = lazyList(list, items, ar => h('div', { class: 'row', role: 'button', onclick: () => Nav.push({ v: 'artist', name: ar.name }) },
        art('r', ar.name, 44, ar.name, 'sm round'), h('div', { class: 't' }, h('b', null, ar.name), h('small', null, `${ar.albums.length} 張專輯`))), 60);
    };
    el.append(filterBar(v, `搜尋 ${Lib.artists.length} 位演出者`, null, draw), list);
    draw();
  },

  tracks(el, v) {
    v.sort ??= store('sort.tracks') || 'title';
    const list = h('div');
    let lz;
    const draw = () => {
      list.textContent = '';
      lz?.stop();
      const q = norm(v.q);
      const items = q ? Lib.tracksBy(v.sort).filter(t => t.s.includes(q)) : Lib.tracksBy(v.sort);
      if (!items.length) list.append(h('div', { class: 'empty' }, '找不到符合的曲目'));
      // tapping a song plays it and the following songs of this list (up to 500)
      lz = lazyList(list, items, (t, i) => trackRow(t, { onTap: () => play(items.slice(i, i + 500).map(x => x.id), 0) }), 60);
      App.markPlaying();
    };
    el.append(filterBar(v, `搜尋 ${Lib.tracks.length} 首曲目`, [['title', '曲名'], ['artist', '演出者'], ['album', '專輯'], ['added', '最近加入']], draw), list);
    draw();
  },

  album(el, v) {
    const al = Lib.albumById.get(v.id);
    if (!al) { el.append(h('div', { class: 'empty' }, '找不到這張專輯')); return; }
    v.title = al.title;
    const ids = al.tracks.map(t => t.id);
    const f = al.tracks[0];
    const q = f ? [f.codec, f.rate ? khz(f.rate) + ' kHz' : '', f.bits ? f.bits + '-bit' : ''].filter(Boolean).join(' ') : '';
    const cover = albumArt(al, 300);
    el.append(h('div', { class: 'hero' }, cover,
      h('h2', null, al.title),
      h('button', { class: 'by', onclick: () => Lib.artistMap.has(al.artist) && Nav.push({ v: 'artist', name: al.artist }) }, al.artist),
      h('div', { class: 'meta' }, [al.year || null, `${al.tracks.length} 首`, fmtLong(al.dur), q].filter(Boolean).join(' · '))));
    el.append(h('div', { class: 'acts' },
      h('button', { class: 'btn pri', html: ico('play', true) + '播放', onclick: () => play(ids, 0, false) }),
      h('button', { class: 'btn', html: ico('shuffle') + '隨機', onclick: () => play(ids, -1, true) }),
      h('button', { class: 'ib', html: ico('more'), onclick: () => Menu.album(al) })));
    const multi = new Set(al.tracks.map(t => t.disc)).size > 1;
    let disc = null;
    const list = h('div');
    al.tracks.forEach((t, i) => {
      if (multi && t.disc !== disc) { disc = t.disc; list.append(h('div', { class: 'disc' }, `Disc ${disc || 1}`)); }
      list.append(trackRow(t, { no: t.no || i + 1, sub: t.artist !== al.artist ? t.artist : '', onTap: () => play(ids, i) }));
    });
    el.append(list);
    Flip.play(al.id, cover);
  },

  artist(el, v) {
    v.title = v.name;
    const { own, appears } = Lib.artistAlbums(v.name);
    const all = own.flatMap(a => a.tracks.map(t => t.id));
    el.append(h('div', { class: 'hero' }, art('r', v.name, 200, v.name, 'round'), h('h2', null, v.name),
      h('div', { class: 'meta' }, `${own.length} 張專輯 · ${all.length} 首`)));
    if (all.length) el.append(h('div', { class: 'acts' },
      h('button', { class: 'btn pri', html: ico('play', true) + '播放', onclick: () => play(all, 0, false) }),
      h('button', { class: 'btn', html: ico('shuffle') + '隨機', onclick: () => play(all, -1, true) })));
    if (own.length) { el.append(h('div', { class: 'sec' }, h('h2', null, '專輯'))); el.append(h('div', { class: 'grid' }, own.map(albumCard))); }
    if (appears.length) { el.append(h('div', { class: 'sec' }, h('h2', null, '參與演出'))); el.append(h('div', { class: 'hscroll' }, appears.slice(0, 30).map(albumCard))); }
  },

  favs(el, v) {
    v.title = '我的最愛';
    const favs = Lib.tracks.filter(t => App.favs.has(t.id));
    if (!favs.length) { el.append(h('div', { class: 'empty' }, '還沒有加入任何最愛的歌曲')); return; }
    const ids = favs.map(t => t.id);
    el.append(h('div', { class: 'acts' },
      h('button', { class: 'btn pri', html: ico('play', true) + '播放', onclick: () => play(ids, 0, false) }),
      h('button', { class: 'btn', html: ico('shuffle') + '隨機', onclick: () => play(ids, -1, true) })));
    const list = h('div');
    el.append(list);
    lazyList(list, favs, (t, i) => trackRow(t, { onTap: () => play(ids, i) }));
  },

  search(el, v) {
    v.title = '搜尋';
    const out = h('div');
    const draw = () => {
      out.textContent = '';
      const q = norm(v.q);
      if (!q) { out.append(h('div', { class: 'empty' }, '輸入曲名、專輯或演出者')); return; }
      const ars = Lib.artists.filter(a => a.s.includes(q)).slice(0, 6);
      const als = Lib.albums.filter(a => a.s.includes(q)).slice(0, 24);
      const trs = Lib.tracks.filter(t => t.s.includes(q)).slice(0, 100);
      if (!ars.length && !als.length && !trs.length) { out.append(h('div', { class: 'empty' }, '沒有找到結果')); return; }
      if (ars.length) {
        out.append(h('div', { class: 'sec' }, h('h2', null, '演出者')));
        ars.forEach(ar => out.append(h('div', { class: 'row', role: 'button', onclick: () => Nav.push({ v: 'artist', name: ar.name }) },
          art('r', ar.name, 44, ar.name, 'sm round'), h('div', { class: 't' }, h('b', null, ar.name), h('small', null, `${ar.albums.length} 張專輯`)))));
      }
      if (als.length) { out.append(h('div', { class: 'sec' }, h('h2', null, '專輯'))); out.append(h('div', { class: 'hscroll' }, als.map(albumCard))); }
      if (trs.length) {
        out.append(h('div', { class: 'sec' }, h('h2', null, '曲目')));
        const ids = trs.map(t => t.id);
        trs.forEach((t, i) => out.append(trackRow(t, { onTap: () => play(ids, i) })));
      }
      App.markPlaying();
    };
    const bar = filterBar(v, '搜尋曲庫', null, draw);
    el.append(bar, out);
    draw();
    if (!v.q) setTimeout(() => bar.querySelector('input').focus(), 60);
  },

  queue(el) {
    const q = App.queue;
    const ids = q.ids || [];
    const live = App.state.trackId === 'yt-live';
    if (live) { el.append(h('div', { class: 'homeYt' })); App.updateHome(); }
    if (!ids.length) { el.append(h('div', { class: 'empty' }, '播放佇列是空的')); return; }
    const start = Math.max(0, q.index - 2);
    el.append(h('div', { class: 'qhead' }, h('span', null, `共 ${ids.length} 首${q.index >= 0 ? ` · 正在播放第 ${q.index + 1} 首` : ''}`),
      h('button', { onclick: async () => { await call('queue.clear'); toast('已清除待播歌曲'); } }, '清除待播')));
    if (start > 0) el.append(h('div', { class: 'disc' }, `已播放 ${start} 首`));
    const list = h('div', { class: 'qlist' });
    el.append(list);
    const items = ids.slice(start).map((id, k) => ({ id, qi: start + k }));
    lazyList(list, items, ({ id, qi }) => {
      const t = Lib.trackById.get(id) || { id, title: '（找不到曲目）', artist: '', dur: 0 };
      const row = trackRow(t, {
        onTap: () => call('queue.jump', { i: qi }),
        menu: [
          qi !== q.index && { label: '移到下一首播放', icon: 'next-up', run: () => call('queue.move', { from: qi, to: qi > q.index ? q.index + 1 : q.index }) },
          qi !== q.index && { label: '從佇列移除', icon: 'trash', danger: true, run: () => call('queue.remove', { i: qi }) },
        ],
      });
      row.classList.add('qrow');
      row.dataset.qi = qi;
      row.classList.toggle('past', qi < q.index);
      const grip = h('span', { class: 'grip', html: ico('grip') });
      grip.addEventListener('click', e => e.stopPropagation());
      row.prepend(grip);
      row.style.paddingLeft = '0';
      dragSort(grip, row, list);
      return row;
    }, 80);
    App.markPlaying();
  },
};

/** Drag a queue row by its handle; the move is sent to MIKU when released. */
function dragSort(grip, row, list) {
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const rows = [...list.querySelectorAll('.row')];
    const sc = list.closest('.page');
    const k = rows.indexOf(row), hgt = row.offsetHeight, y0 = e.clientY, s0 = sc.scrollTop;
    let target = k;
    row.classList.add('drag');
    const move = ev => {
      const edge = 90;
      if (ev.clientY > window.innerHeight - 150) sc.scrollTop += 10;
      else if (ev.clientY < edge + 40) sc.scrollTop -= 10;
      const dy = ev.clientY - y0 + (sc.scrollTop - s0);
      row.style.transform = `translateY(${dy}px)`;
      target = Math.max(0, Math.min(rows.length - 1, k + Math.round(dy / hgt)));
      rows.forEach((r, j) => {
        if (j === k) return;
        const sft = (k < j && j <= target) ? -hgt : (target <= j && j < k) ? hgt : 0;
        r.style.transform = sft ? `translateY(${sft}px)` : '';
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      rows.forEach(r => r.style.transform = '');
      row.classList.remove('drag');
      if (target !== k) {
        const from = +row.dataset.qi, to = +rows[target].dataset.qi;
        // show the new order right away; MIKU's queue event confirms it
        if (target > k) rows[target].after(row); else rows[target].before(row);
        call('queue.move', { from, to });
      }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  });
}

/* ═════════════════════════════ now playing ═════════════════════════════ */
const NP = {
  isOpen: false, lyricsOn: false, lyrics: null, lyricsFor: null, dragging: false, volDragging: false, artKey: null,
  open() { this.isOpen = true; $('#np').classList.add('open'); $('#np').setAttribute('aria-hidden', 'false'); this.update(true); },
  close() { this.isOpen = false; $('#np').classList.remove('open'); $('#np').setAttribute('aria-hidden', 'true'); },
  cur() {
    const s = App.state;
    if (s.trackId === 'yt-live') {
      const l = s.live || {};
      return { live: true, id: 'yt-live', title: l.title || 'YouTube Music', artist: l.artist || '', album: l.album || '', img: l.img };
    }
    const t = Lib.trackById.get(s.trackId);
    return t ? { t, id: t.id, title: t.title, artist: t.artist, album: t.album?.title || '' } : null;
  },
  update(force) {
    const s = App.state, c = this.cur();
    if (!this.isOpen && !force) return;
    if (!c) { $('#npTitle').textContent = '沒有播放中的歌曲'; $('#npSub').textContent = ''; return; }
    const key = c.live ? 'yt:' + c.img : c.id;
    if (key !== this.artKey) {
      this.artKey = key;
      const cover = $('#npCover');
      const fresh = c.live ? (() => {
        const b = h('div', { class: 'art', 'data-l': (c.title || '').slice(0, 1) });
        if (c.img) { const img = new Image(); img.onload = () => img.classList.add('ok'); img.onerror = () => img.remove(); img.src = ytImg(c.img, 900); b.append(img); }
        return b;
      })() : trackArt(c.t, 600);
      fresh.id = 'npCover';
      fresh.classList.add('npcover');
      cover.replaceWith(fresh);
      const bg = c.live ? ytImg(c.img, 200) : Api.art(c.t.album?.loose ? 't' : 'a', c.t.album?.loose ? c.t.id : c.t.albumId, 100);
      $('#npBg').style.backgroundImage = bg ? `url("${bg}")` : 'none';
      if (this.lyricsOn) this.loadLyrics();
    }
    $('#npCover').classList.toggle('paused', !s.playing);
    $('#npTitle').textContent = c.title;
    $('#npSub').textContent = [c.artist, c.album].filter(Boolean).join(' — ');
    $('#npSrc').textContent = c.live ? 'YOUTUBE MUSIC' : (c.album ? '來自「' + c.album + '」' : '正在播放');
    $('#npFav').hidden = !!c.live;
    $('#npFav').classList.toggle('on', !c.live && App.favs.has(c.id));
    $('#npToggle').innerHTML = ico(s.playing ? 'pause' : 'play', true);
    $('#npShuffle').classList.toggle('on', !!s.shuffle);
    $('#npRepeat').classList.toggle('on', s.repeat && s.repeat !== 'off');
    $('#npRepeat').classList.toggle('one', s.repeat === 'one');
    $('#npShuffle').style.visibility = $('#npRepeat').style.visibility = c.live ? 'hidden' : '';
    const fixed = s.volumeMode === 'fixed';
    $('#npVol').style.visibility = fixed ? 'hidden' : '';
    if (!this.volDragging) this.setVol(s.volumeDb, s.muted);
    const g = s.signal;
    let sig = '';
    if (g) {
      const src = g.dsd ? g.dsdLabel : [g.codec, g.sourceRate ? khz(g.sourceRate) + 'k' : '', g.sourceBits ? g.sourceBits + 'bit' : ''].filter(Boolean).join(' ');
      sig = src + (g.mode ? ' · ' + g.mode : '') + (g.resampled && g.outputRate ? ' → ' + khz(g.outputRate) + 'k' : '');
    }
    $('#npSig').textContent = sig;
    $('#npSig').classList.toggle('hi', !!g && !g.resampled && (g.sourceBits > 16 || g.sourceRate > 48000 || g.dsd));
    $('#npSig').title = g?.note || '';
  },
  setVol(db, muted) {
    const v = $('#vol');
    v.value = Math.max(-60, db ?? -20);
    v.style.setProperty('--p', ((+v.value + 60) / 60 * 100) + '%');
    $('#volTxt').textContent = muted ? '靜音' : (+v.value <= -60 ? '-∞' : (+v.value).toFixed(1) + ' dB');
    $('#npMute').innerHTML = ico(muted ? 'mute' : 'vol');
  },
  tick(pos, dur) {
    if (!this.isOpen) return;
    const sk = $('#seek');
    if (!this.dragging) {
      sk.max = Math.max(1, Math.round(dur * 10));
      sk.value = Math.round(pos * 10);
      sk.style.setProperty('--p', (dur > 0 ? Math.min(100, pos / dur * 100) : 0) + '%');
      $('#tPos').textContent = fmtTime(pos);
    }
    $('#tDur').textContent = fmtTime(dur);
    if (this.lyricsOn && this.lyrics?.synced) this.hiliteLyrics(pos);
  },
  async toggleLyrics() {
    this.lyricsOn = !this.lyricsOn;
    $('#npLyricsBtn').classList.toggle('on', this.lyricsOn);
    $('#npLyrics').hidden = !this.lyricsOn;
    $('#npCover').style.visibility = this.lyricsOn ? 'hidden' : '';
    if (this.lyricsOn) this.loadLyrics();
  },
  async loadLyrics() {
    const c = this.cur();
    const box = $('#npLyrics');
    $('#npCover').style.visibility = this.lyricsOn ? 'hidden' : '';
    if (!c) { box.innerHTML = '<p class="msg">沒有播放中的歌曲</p>'; return; }
    const key = c.live ? 'yt:' + c.title : c.id;
    if (this.lyricsFor === key && this.lyrics) return;
    this.lyricsFor = key; this.lyrics = null; this.lastLine = -1;
    box.innerHTML = '<p class="msg">讀取歌詞中…</p>';
    const r = await call(c.live ? 'lyricsLive' : 'lyrics', c.live ? {} : { id: c.id });
    if (this.lyricsFor !== key) return;
    this.lyrics = r || { lines: [] };
    box.textContent = '';
    if (r?.instrumental) { box.innerHTML = '<p class="msg">純音樂，請欣賞</p>'; return; }
    if (!r || !r.lines?.length) { box.innerHTML = '<p class="msg">找不到這首歌的歌詞</p>'; return; }
    r.lines.forEach((l, i) => {
      const p = h('p', { 'data-i': i }, l.text || '♪', l.trans ? h('small', null, l.trans) : null);
      if (r.synced) p.onclick = () => call('seek', { pos: Math.max(0, l.t - (r.offset || 0)) });
      box.append(p);
    });
    if (!r.synced) box.querySelectorAll('p').forEach(p => p.classList.add('on'));
  },
  hiliteLyrics(pos) {
    const r = this.lyrics;
    const t = pos + (r.offset || 0) + 0.15;
    let i = -1;
    for (let k = 0; k < r.lines.length; k++) { if (r.lines[k].t <= t) i = k; else break; }
    if (i === this.lastLine) return;
    this.lastLine = i;
    const box = $('#npLyrics');
    box.querySelectorAll('p.on').forEach(p => p.classList.remove('on'));
    const p = box.querySelector(`p[data-i="${i}"]`);
    if (p) { p.classList.add('on'); box.scrollTo({ top: p.offsetTop - box.clientHeight * 0.4, behavior: 'smooth' }); }
  },
};

$('#npClose').onclick = () => NP.close();
$('#npToggle').onclick = () => { App.state.playing = !App.state.playing; App.posBase = App.pos(); App.posAt = performance.now(); NP.update(); App.updateMini(); call('toggle'); };
$('#npNext').onclick = () => call('next');
$('#npPrev').onclick = () => call('prev');
$('#npShuffle').onclick = () => call('shuffle', { on: !App.state.shuffle });
$('#npRepeat').onclick = () => call('repeat', { mode: { off: 'all', all: 'one', one: 'off' }[App.state.repeat || 'off'] });
$('#npFav').onclick = () => { const c = NP.cur(); if (c && !c.live) App.setFav(c.id, !App.favs.has(c.id)); };
$('#npMore').onclick = () => { const c = NP.cur(); if (c?.t) Menu.track(c.t); };
$('#npLyricsBtn').onclick = () => NP.toggleLyrics();
$('#npQueueBtn').onclick = () => { NP.close(); Nav.go('queue'); };
{
  const sk = $('#seek');
  sk.addEventListener('input', () => {
    NP.dragging = true;
    sk.style.setProperty('--p', (sk.value / sk.max * 100) + '%');
    $('#tPos').textContent = fmtTime(sk.value / 10);
  });
  sk.addEventListener('change', () => {
    const pos = sk.value / 10;
    App.posBase = pos; App.posAt = performance.now();
    call('seek', { pos });
    setTimeout(() => NP.dragging = false, 400);
  });
  const vol = $('#vol');
  const sendVol = debounce(() => call('volume', { db: +vol.value, muted: false }), 90);
  vol.addEventListener('input', () => { NP.volDragging = true; NP.setVol(+vol.value, false); sendVol(); });
  vol.addEventListener('change', () => { call('volume', { db: +vol.value, muted: false }); setTimeout(() => NP.volDragging = false, 600); });
  $('#npMute').onclick = () => call('volume', { db: App.state.volumeDb, muted: !App.state.muted });
  // swipe the player down to close it
  const np = $('#np');
  let y0 = null, dy = 0;
  np.addEventListener('touchstart', e => {
    if (e.target.closest('input, .nplyrics:not([hidden])')) { y0 = null; return; }
    y0 = e.touches[0].clientY; dy = 0;
  }, { passive: true });
  np.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    if (dy > 8) { np.style.transition = 'none'; np.style.transform = `translateY(${dy}px)`; }
  }, { passive: true });
  np.addEventListener('touchend', () => {
    if (y0 == null) return;
    np.style.transition = ''; np.style.transform = '';
    if (dy > 110) NP.close();
    y0 = null;
  });
}

/* ═════════════════════════════ app ═════════════════════════════ */
const App = {
  state: {}, queue: { ids: [], index: -1 }, favs: new Set(), hello: null, posBase: 0, posAt: 0, online: true, booted: false,

  pos() {
    const s = this.state;
    let p = this.posBase + (s.playing ? (performance.now() - this.posAt) / 1000 : 0);
    if (s.dur > 0) p = Math.min(p, s.dur);
    return Math.max(0, p);
  },

  async boot() {
    if (!Api.token) { Pair.show(); return; }
    let hello;
    try { hello = await Api.rpc('hello'); }
    catch (e) { if (!e.unpaired) { this.setOnline(false); setTimeout(() => this.boot(), 3000); } return; }
    this.hello = hello;
    this.favs = new Set(hello.favorites || []);
    this.queue = hello.queue;
    this.setState(hello.state);
    $('#app').hidden = false;
    $('#view').innerHTML = '<div class="page"><div class="empty">讀取曲庫中…</div></div>';
    try { await Lib.load(hello.revision); } catch (e) { if (!e.unpaired) toast('讀取曲庫失敗：' + e.message, true); }
    this.booted = true;
    this.setOnline(true);
    Events.start();
    $('#view').textContent = '';
    Nav.start();
    requestAnimationFrame(t => this.frame(t));
  },

  async reconnect() {
    if (!this.booted || !Api.token) return;
    try {
      const hello = await Api.rpc('hello');
      this.hello = hello;
      this.favs = new Set(hello.favorites || []);
      this.queue = hello.queue;
      this.setState(hello.state);
      this.setOnline(true);
      if (hello.revision !== Lib.rev) { await Lib.load(hello.revision); Nav.rebuildAll(['home', 'albums', 'artists', 'tracks', 'queue']); }
      else Nav.rebuildAll(['queue']);
      if (!Events.es) Events.start();
    } catch (e) { if (!e.unpaired) setTimeout(() => this.reconnect(), 3000); }
  },

  setOnline(on) {
    this.online = on;
    $('#offline').hidden = on || !this.booted;
  },

  onEvent(ev, d) {
    if (ev === 'state') this.setState(d);
    else if (ev === 'queue') {
      this.queue = d;
      Nav.rebuildAll(['queue']);
    }
    else if (ev === 'error') toast(d.message, true);
    else if (ev === 'favs') { this.favs = new Set(d || []); NP.update(); }
    else if (ev === 'library') this.libraryChanged();
  },

  libraryChanged: debounce(async function () {
    try {
      const hello = await Api.rpc('hello');
      if (hello.revision === Lib.rev) return;
      await Lib.load(hello.revision);
      Nav.rebuildAll(['albums', 'artists', 'tracks', 'home']);
    } catch { }
  }, 4000),

  setState(s) {
    if (!s) return;
    const prev = this.state;
    this.state = s;
    // re-anchor the interpolated position only when it drifted (avoids jitter between updates)
    const drift = Math.abs(this.pos() - (s.pos || 0));
    if (prev.trackId !== s.trackId || prev.playing !== s.playing || drift > 0.6 || !this.posAt) { this.posBase = s.pos || 0; this.posAt = performance.now(); }
    if (prev.trackId !== s.trackId || prev.playing !== s.playing) this.markPlaying();
    this.updateMini();
    NP.update();
    if (prev.trackId !== s.trackId || prev.playing !== s.playing || (s.live && prev.live?.title !== s.live.title)) this.updateHome();
  },

  frame() {
    const s = this.state;
    const p = this.pos();
    const pct = s.dur > 0 ? Math.min(100, p / s.dur * 100) : 0;
    $('#mini .mprog i').style.width = pct + '%';
    NP.tick(p, s.dur || 0);
    requestAnimationFrame(t => this.frame(t));
  },

  updateMini() {
    const c = NP.cur();
    const mini = $('#mini');
    mini.hidden = !c;
    if (!c) return;
    const key = c.live ? 'yt:' + c.img : c.id;
    if (mini.dataset.key !== key) {
      mini.dataset.key = key;
      let a;
      if (c.live) { a = h('div', { class: 'art sm' }); if (c.img) { const img = new Image(); img.onload = () => img.classList.add('ok'); img.src = ytImg(c.img, 120); a.append(img); } }
      else a = trackArt(c.t, 44, 'sm');
      a.id = 'miniArt';
      $('#miniArt').replaceWith(a);
    }
    $('#miniTitle').textContent = c.title;
    $('#miniSub').textContent = c.live ? 'YouTube Music' + (c.artist ? ' · ' + c.artist : '') : c.artist;
    $('#miniToggle').innerHTML = ico(this.state.playing ? 'pause' : 'play', true);
  },

  updateHome() {
    document.querySelectorAll('.homeNow').forEach(now => {
      now.textContent = '';
      const c = NP.cur();
      if (c && !c.live) {
        now.append(h('div', { class: 'npcard', role: 'button', onclick: () => NP.open() },
          trackArt(c.t, 64),
          h('div', { class: 't' }, h('div', { class: 'lab' }, this.state.playing ? '正在播放' : '已暫停'), h('b', null, c.title), h('small', null, c.artist)),
          h('button', { class: 'ib', html: ico(this.state.playing ? 'pause' : 'play', true), onclick: e => { e.stopPropagation(); call('toggle'); } })));
      }
    });
    document.querySelectorAll('.homeYt').forEach(yt => {
      yt.textContent = '';
      if (this.hello?.yt || this.state.trackId === 'yt-live') {
        const live = this.state.trackId === 'yt-live';
        const l = this.state.live || {};
        yt.append(h('div', { class: 'ytcard', role: 'button', onclick: () => live && NP.open() },
          h('div', { class: 'yi', html: ico('play', true) }),
          h('div', { class: 't' }, h('b', null, live ? (l.title || 'YouTube Music') : 'YouTube Music'),
            h('small', null, live ? [l.artist, this.state.playing ? '播放中' : '已暫停'].filter(Boolean).join(' · ') : '繼續播放電腦上的 YouTube Music')),
          h('button', { class: 'ib', html: ico('prev', true), onclick: e => { e.stopPropagation(); call('yt.prev'); } }),
          h('button', { class: 'ib', html: ico(live && this.state.playing ? 'pause' : 'play', true), onclick: e => { e.stopPropagation(); call('yt.toggle'); } }),
          h('button', { class: 'ib', html: ico('next', true), onclick: e => { e.stopPropagation(); call('yt.next'); } })));
      }
    });
  },

  markPlaying() {
    const s = this.state;
    document.querySelectorAll('.qlist .row').forEach(r => {
      const cur = +r.dataset.qi === this.queue.index && s.trackId !== 'yt-live';
      r.classList.toggle('cur', cur);
      r.classList.toggle('playing', cur && !!s.playing);
    });
    document.querySelectorAll('#view .row[data-id]:not(.qrow)').forEach(r => {
      const cur = r.dataset.id === s.trackId;
      r.classList.toggle('cur', cur);
      r.classList.toggle('playing', cur && !!s.playing);
    });
  },

  async setFav(id, on) {
    on ? this.favs.add(id) : this.favs.delete(id);
    NP.update();
    await call('fav', { id, on });
    toast(on ? '已加入我的最愛' : '已從我的最愛移除');
  },
};

$('#mini').onclick = e => { if (!e.target.closest('button')) NP.open(); };
$('#miniToggle').onclick = () => { App.state.playing = !App.state.playing; App.posBase = App.pos(); App.posAt = performance.now(); App.updateMini(); call('toggle'); };
$('#miniNext').onclick = () => call('next');
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') App.reconnect(); });
window.addEventListener('pageshow', e => { if (e.persisted) App.reconnect(); });

/* ═════════════════════════════ pairing ═════════════════════════════ */
const Pair = {
  show() {
    Events.stop();
    App.booted = false;
    $('#app').hidden = true;
    NP.close();
    $('#pair').hidden = false;
    $('#pairStep2').hidden = true;
    $('#pairReq').hidden = false;
    $('#pairErr').textContent = '';
    const ua = navigator.userAgent;
    $('#pairName').value = store('name') || (/iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android 手機' : '瀏覽器');
  },
  async request() {
    $('#pairErr').textContent = '';
    const name = $('#pairName').value.trim() || '手機';
    store('name', name);
    try {
      const r = await fetch('/api/pair/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) throw new Error();
      $('#pairHint').textContent = '請輸入電腦上 MIKU 顯示的 4 位數配對碼（也可以在 MIKU 的「設定 → 手機遙控」看到）。';
      $('#pairReq').hidden = true;
      $('#pairStep2').hidden = false;
      $('#pairCode').value = '';
      $('#pairCode').focus();
    } catch { $('#pairErr').textContent = '無法連線到 MIKU，請確認電腦上的 MIKU 正在執行，且手機和電腦在同一個 Wi-Fi。'; }
  },
  async confirm() {
    const code = $('#pairCode').value.replace(/\D/g, '');
    if (code.length !== 4) return;
    $('#pairErr').textContent = '';
    try {
      const r = await fetch('/api/pair/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: store('name') || '手機' }) });
      const j = await r.json();
      if (!r.ok || !j.token) {
        $('#pairErr').textContent = j.e || '配對失敗';
        $('#pairCode').value = '';
        $('#pairCode').focus();
        return;
      }
      Api.token = j.token;
      store('token', j.token);
      $('#pair').hidden = true;
      App.boot();
    } catch { $('#pairErr').textContent = '無法連線到 MIKU'; }
  },
};
$('#pairReq').onclick = () => Pair.request();
$('#pairOk').onclick = () => Pair.confirm();
$('#pairAgain').onclick = () => Pair.request();
$('#pairCode').addEventListener('input', () => { if ($('#pairCode').value.replace(/\D/g, '').length === 4) Pair.confirm(); });

App.boot();
