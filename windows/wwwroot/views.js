'use strict';
/* ═════════════════════════════ virtualisation ═════════════════════════════ */
function vgrid(container, items, { minW = 178, gap = 22, extra = 64, render, kind = 'album', label }) {
  const content = $('#content');
  const wrap = h('div', { class: 'vgrid', 'data-kind': kind });
  container.append(wrap);
  let cols = 1, cw = minW, rowH = minW + extra + gap, nodes = new Map(), raf = 0;
  let laid = false;
  function layout() {
    const W = wrap.clientWidth;
    if (!W) return;
    // remember which item sits at the top so resizing the window keeps the same albums in view
    const top0 = wrap.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const anchorIdx = laid && -top0 > 0 ? Math.floor(-top0 / rowH) * cols : -1;
    const anchorFrac = laid && -top0 > 0 ? ((-top0) % rowH) / rowH : 0;
    const fixed = gridCols(kind);
    const newCols = fixed > 0 ? fixed : Math.max(2, Math.floor((W + gap) / (minW + gap)));
    const newCw = (W - gap * (newCols - 1)) / newCols;
    if (laid && newCols === cols && Math.abs(newCw - cw) < 0.5) return;
    cols = newCols; cw = newCw; rowH = cw + extra + gap;
    wrap.style.height = Math.ceil(items.length / cols) * rowH + 'px';
    // reposition existing cards instead of rebuilding them (no flicker)
    for (const [i, n] of nodes) {
      n.style.width = cw + 'px';
      n.style.transform = `translate(${(i % cols) * (cw + gap)}px, ${Math.floor(i / cols) * rowH}px)`;
    }
    if (anchorIdx >= 0) {
      const wrapTop = wrap.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
      content.scrollTop = wrapTop + (Math.floor(anchorIdx / cols) + anchorFrac) * rowH;
    }
    laid = true;
    update();
  }
  let firstPaint = true;
  function update() {
    raf = 0;
    const top = wrap.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const viewH = content.clientHeight;
    const first = Math.max(0, Math.floor(-top / rowH) - 2), last = Math.ceil((-top + viewH) / rowH) + 2;
    const from = first * cols, to = Math.min(items.length, last * cols);
    if (label) ScrollBubble.show(items[Math.min(items.length - 1, Math.max(0, Math.floor(-top / rowH) * cols))], label);
    for (const [i, n] of nodes) if (i < from || i >= to) { n.remove(); nodes.delete(i); }
    for (let i = from; i < to; i++) {
      if (nodes.has(i)) continue;
      const n = render(items[i], cw);
      n.style.width = cw + 'px';
      const pos = `translate(${(i % cols) * (cw + gap)}px, ${Math.floor(i / cols) * rowH}px)`;
      n.style.transform = pos;
      if (firstPaint && !Motion.quiet) { n.style.setProperty('--pos', pos); n.style.setProperty('--i', i - from); n.classList.add('pop-in'); n.addEventListener('animationend', () => n.classList.remove('pop-in'), { once: true }); }
      wrap.append(n);
      nodes.set(i, n);
    }
    if (nodes.size) firstPaint = false;
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  content.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => requestAnimationFrame(layout));
  ro.observe(wrap);
  const relayout = () => layout();
  window.addEventListener('gridcols', relayout);
  layout();
  return () => { content.removeEventListener('scroll', onScroll); window.removeEventListener('gridcols', relayout); ro.disconnect(); cancelAnimationFrame(raf); };
}

/* ── bubble next to the scrollbar while it is being dragged ── */
const ScrollBubble = {
  el: null, dragging: false,
  init() {
    const content = $('#content');
    this.el = h('div', { class: 'scroll-bubble' });
    document.body.append(this.el);
    content.addEventListener('pointerdown', e => {
      const r = content.getBoundingClientRect();
      if (e.clientX > r.right - 18) this.dragging = true;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; this.el.classList.remove('on'); });
  },
  show(item, label) {
    if (!this.dragging || !item) return;
    const content = $('#content'), r = content.getBoundingClientRect();
    const frac = content.scrollTop / Math.max(1, content.scrollHeight - content.clientHeight);
    this.el.textContent = label(item);
    this.el.style.top = (r.top + 70 + frac * (r.height - 120)) + 'px';
    this.el.style.left = (r.right - 30 - this.el.offsetWidth) + 'px';
    this.el.classList.add('on');
  },
};

/* ── albums per row: 0 = automatic ── */
function gridCols(kind = 'album') { return +(uiPref(kind === 'artist' ? 'artistCols' : 'gridCols', '0')) || 0; }
function setGridCols(n, kind = 'album') {
  n = Math.max(0, Math.min(14, n));
  setUiPref(kind === 'artist' ? 'artistCols' : 'gridCols', String(n));
  window.dispatchEvent(new Event('gridcols'));
}
function colsControl(kind = 'album') {
  const label = h('span', { class: 'num', style: { minWidth: '62px', textAlign: 'center', fontSize: '13px', color: 'var(--text-2)', lineHeight: '30px' } });
  const cur = () => { const n = gridCols(kind); if (n) return n; const vg = $('.vgrid'); return vg ? Math.max(2, Math.floor((vg.clientWidth + 22) / (178 + 22))) : 6; };
  const draw = () => label.textContent = gridCols(kind) ? `每排 ${gridCols(kind)}` : '自動';
  const box = h('div', { class: 'seg', title: '每排顯示數量（Ctrl + 滾輪也可以調整）' },
    h('button', { onclick: () => { setGridCols(Math.max(2, cur() - 1), kind); draw(); } }, '−'),
    label,
    h('button', { onclick: () => { setGridCols(cur() + 1, kind); draw(); } }, '+'),
    h('button', { onclick: () => { setGridCols(0, kind); draw(); } }, '自動'));
  draw();
  window.addEventListener('gridcols', draw);
  return box;
}
// Ctrl + mouse wheel over a grid changes the number per row
document.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  const grid = e.target.closest && e.target.closest('.vgrid');
  if (!grid) return;
  e.preventDefault();
  const kind = grid.dataset.kind || 'album';
  const curN = gridCols(kind) || Math.max(2, Math.floor((grid.clientWidth + 22) / (178 + 22)));
  setGridCols(Math.max(2, curN + (e.deltaY > 0 ? 1 : -1)), kind);
}, { passive: false });

function vlist(container, items, rowH, render) {
  const content = $('#content');
  const wrap = h('div', { class: 'vlist', style: { height: items.length * rowH + 'px' } });
  container.append(wrap);
  const nodes = new Map();
  let raf = 0;
  function update() {
    raf = 0;
    const top = wrap.getBoundingClientRect().top - content.getBoundingClientRect().top;
    const first = Math.max(0, Math.floor(-top / rowH) - 8), last = Math.min(items.length, Math.ceil((-top + content.clientHeight) / rowH) + 8);
    for (const [i, n] of nodes) if (i < first || i >= last) { n.remove(); nodes.delete(i); }
    for (let i = first; i < last; i++) {
      if (nodes.has(i)) continue;
      const n = render(items[i], i);
      n.style.transform = `translateY(${i * rowH}px)`;
      wrap.append(n); nodes.set(i, n);
    }
    Views.markPlaying(wrap);
  }
  const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
  content.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(update); });
  ro.observe(content);
  update();
  return () => { content.removeEventListener('scroll', onScroll); ro.disconnect(); cancelAnimationFrame(raf); };
}

/* ═════════════════════════════ building blocks ═════════════════════════════ */
function albumCard(al, size) {
  const kind = al.loose && al.tracks[0] ? 't' : 'a';
  const id = kind === 't' ? al.tracks[0].id : al.id;
  const art = artBox('art', kind, id, size || 200, al.title);
  art.dataset.album = al.id;
  const play = h('button', { class: 'play', title: '播放', html: icon('play', true), onclick: e => { e.stopPropagation(); App.playTracks(al.tracks, 0, false); } });
  art.append(play);
  const c = h('div', { class: 'card', onclick: () => { Flip.capture(al.id, art); go('#/album/' + al.id); } },
    art, h('div', { class: 't1', title: al.title }, al.title), h('div', { class: 't2' }, al.artist + (al.year ? ' · ' + al.year : '')));
  c.oncontextmenu = e => { e.preventDefault(); albumMenu(al, { x: e.clientX, y: e.clientY }); };
  // keep play button alive across art refreshes
  const obs = new MutationObserver(() => { if (!art.contains(play)) art.append(play); });
  obs.observe(art, { childList: true });
  return c;
}

function artistCard(ar, size) {
  const c = h('div', { class: 'card artist', onclick: () => go('#/artist/' + encodeURIComponent(ar.name)) },
    artBox('art', 'r', ar.name, size || 200, ar.name),
    h('div', { class: 't1' }, ar.name), h('div', { class: 't2' }, `${ar.albums.length} 張專輯`));
  return c;
}

function trackRow(t, i, list, opts = {}) {
  const n = h('div', { class: 'n num' },
    h('span', null, opts.number ?? t.no ?? i + 1),
    h('div', { class: 'pi', html: icon('play', true) }),
    h('div', { class: 'eq', html: '<i></i><i></i><i></i>' }));
  if (opts.art) n.replaceChildren(artBox('thumb', t.album?.loose ? 't' : 'a', t.album?.loose ? t.id : t.albumId, 40, t.album?.title), h('div', { class: 'eq', html: '<i></i><i></i><i></i>' }));
  const alCell = h('div', { class: 'al' });
  if (opts.album !== false && t.album) alCell.append(h('a', { onclick: e => { e.stopPropagation(); go('#/album/' + t.albumId); } }, t.album.title));
  else if (opts.album === false) alCell.textContent = t.composer || '';
  const fav = h('button', { class: 'icon-btn more' + (App.favs.has(t.id) ? ' fav-on' : ''), html: icon(App.favs.has(t.id) ? 'heartf' : 'heart'), title: '最愛' });
  fav.onclick = e => { e.stopPropagation(); const on = App.toggleFav(t.id); fav.classList.toggle('fav-on', on); fav.innerHTML = icon(on ? 'heartf' : 'heart'); };
  if (App.favs.has(t.id)) fav.style.opacity = 1;
  const r = h('div', { class: 'row', 'data-id': t.id },
    n,
    h('div', { class: 'tt' }, h('div', { title: t.title }, t.title), h('div', { class: 'a' }, t.artist || '')),
    alCell,
    h('div', { class: 'fmt' }, fmtQuality(t.codec, t.rate, t.bits)),
    h('div', { class: 'd num' }, fmtTime(t.dur)),
    fav);
  r.ondblclick = () => App.playTracks(list, list.indexOf(t));
  n.onclick = e => { e.stopPropagation(); App.playTracks(list, list.indexOf(t)); };
  r.onclick = () => { $$('.row.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); };
  r.oncontextmenu = e => { e.preventDefault(); trackMenu(t, { x: e.clientX, y: e.clientY }, list); };
  return r;
}

function thead(albumLabel = '專輯') {
  return h('div', { class: 'thead' }, h('div', { style: { textAlign: 'center' } }, '#'), h('div', null, '標題'), h('div', null, albumLabel), h('div', { class: 'fmt' }, '格式'), h('div', { style: { textAlign: 'right' } }, '時間'), h('div'));
}

function heroBg(kind, id) {
  const bg = h('div', { class: 'hero-bg' });
  const img = new Image();
  img.onload = () => { bg.style.backgroundImage = `url("${img.src}")`; };
  img.src = artUrl(kind, id, 128);
  return bg;
}

function pageHead(title, sub, tools) {
  return h('div', { class: 'page-head' }, h('h1', null, title), sub != null ? h('div', { class: 'sub num' }, sub) : null, tools ? h('div', { class: 'tools' }, tools) : null);
}

function seg(options, value, onchange) {
  const box = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    const b = h('button', { class: v === value ? 'on' : '' }, label);
    b.onclick = () => { $$('button', box).forEach(x => x.classList.remove('on')); b.classList.add('on'); onchange(v); };
    box.append(b);
  }
  return box;
}

const uiPref = (k, d) => (App.settings.ui && App.settings.ui[k]) || d;
function setUiPref(k, v) { (App.settings.ui = App.settings.ui || {})[k] = v; Host.call('ui', { key: k, value: v }); }

/* rails (home page) use the same albums-per-row setting */
function sizeRail(r) {
  const apply = () => {
    const n = gridCols('album');
    if (!n) { r.style.gridAutoColumns = ''; return; }
    const W = r.clientWidth - 72;
    if (W > 0) r.style.gridAutoColumns = Math.floor((W - 22 * (n - 1)) / n) + 'px';
  };
  requestAnimationFrame(apply);
  window.addEventListener('gridcols', apply);
  new ResizeObserver(apply).observe(r);
}

/* Horizontal rails: ‹ › buttons in the header (the scrollbar is hidden and a mouse wheel scrolls the page),
   plus a soft fade on the edge that still has more cards. Attached to every .rail after a view renders. */
function attachRailNav(root) {
  for (const r of root.querySelectorAll('.rail')) {
    if (r.dataset.nav) continue;
    r.dataset.nav = '1';
    let head = r.previousElementSibling;
    if (!head || !head.classList.contains('rail-head')) continue;
    const prev = h('button', { class: 'round-btn rail-btn', title: '向左', html: icon('left') });
    const next = h('button', { class: 'round-btn rail-btn', title: '向右', html: icon('right') });
    const step = dir => r.scrollBy({ left: dir * Math.max(200, r.clientWidth * 0.85), behavior: 'smooth' });
    prev.onclick = () => step(-1);
    next.onclick = () => step(1);
    const nav = h('div', { class: 'rail-nav' }, prev, next);
    head.append(nav);
    const sync = () => {
      const max = r.scrollWidth - r.clientWidth;
      const atStart = r.scrollLeft <= 2, atEnd = r.scrollLeft >= max - 2;
      nav.style.visibility = max > 4 ? '' : 'hidden';
      prev.disabled = atStart; next.disabled = atEnd;
      r.classList.toggle('more-l', !atStart && max > 4);
      r.classList.toggle('more-r', !atEnd && max > 4);
    };
    r.addEventListener('scroll', sync, { passive: true });
    new ResizeObserver(sync).observe(r);
    requestAnimationFrame(sync);
  }
}

/* YouTube Music lives in a native panel over the content area; hide it whenever something overlays it. */
const YT = {
  frame: null, shown: false,
  sync() {
    const f = YT.frame;
    const visible = !!(f && f.isConnected && !NowPlaying.open && !Drawer.open && !Popover.el && !(window.ArtPicker && ArtPicker.el));
    if (visible) {
      const r = f.getBoundingClientRect();
      Host.call('yt.show', { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 });
      YT.shown = true;
    } else if (YT.shown) { Host.call('yt.hide'); YT.shown = false; }
  },
};
window.addEventListener('resize', () => YT.sync());

/* ═════════════════════════════ views ═════════════════════════════ */
let shuffleSeed = null;
const Views = {
  markPlaying(root = document) {
    const id = App.state.trackId;
    $$('.row.playing', root).forEach(r => { if (r.dataset.id !== id) r.classList.remove('playing'); });
    if (id) $$(`.row[data-id="${id}"]`, root).forEach(r => r.classList.add('playing'));
  },

  home(view) {
    if (!App.settings.folders || App.settings.folders.length === 0) return Views.onboarding(view);
    if (!Lib.albums.length) {
      view.append(h('div', { class: 'empty' }, h('div', { class: 'box' }, h('h2', null, '正在建立曲庫'), h('p', null, '第一次掃描大型曲庫需要幾分鐘，完成後會自動顯示。'))));
      return;
    }
    shuffleSeed = shuffleSeed || Lib.albums.map(a => [Math.random(), a]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const rail = (title, albums, link) => {
      if (!albums.length) return;
      const [label, act] = typeof link === 'string' ? ['顯示全部', () => go(link)] : (link || []);
      view.append(h('div', { class: 'rail-head' }, h('h2', null, title), act ? h('a', { onclick: act }, label) : null));
      const r = h('div', { class: 'rail' });
      sizeRail(r);
      albums.forEach((a, k) => { const c = albumCard(a, 176); if (k < 10) { c.classList.add('stagger'); c.style.setProperty('--i', k); } r.append(c); });
      view.append(r);
    };
    view.append(h('div', { style: { height: '8px' } }));
    const recentTracks = (App.settings.recent || []).map(id => Lib.trackById.get(id)).filter(Boolean);
    rail('最近聆聽', [...new Set(recentTracks.map(t => t.album).filter(Boolean))].slice(0, 24), '#/recent');
    rail('最近加入', Lib.albums.slice().sort((a, b) => b.added - a.added).slice(0, 24), '#/albums');
    const favAlbums = [...new Set([...App.favs].map(id => Lib.trackById.get(id)?.album).filter(Boolean))].slice(0, 24);
    rail('我的最愛', favAlbums, '#/favorites');
    rail('高解析度', shuffleSeed.filter(a => a.qc).slice(0, 24), ['顯示全部', () => { setUiPref('albumFilter', 'hires'); go('#/albums'); }]);
    rail('隨機探索', shuffleSeed.filter(a => !a.qc).slice(0, 24), ['換一批', () => { shuffleSeed = null; Router.render(true, 'none'); }]);
    const artists = Lib.artists.filter(a => a.albums.length > 1);
    if (artists.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, '演出者'), h('a', { onclick: () => go('#/artists') }, '顯示全部')));
      const r = h('div', { class: 'rail', style: { gridAutoColumns: '150px' } });
      artists.map(a => [Math.random(), a]).sort((x, y) => x[0] - y[0]).slice(0, 20).forEach(([, a]) => r.append(artistCard(a, 150)));
      view.append(r);
    }
  },

  onboarding(view) {
    const box = h('div', { class: 'box' });
    box.innerHTML = `<div style="display:flex;justify-content:center;gap:16px;align-items:center">${Brand.svg(70)}</div>`;
    box.append(h('h2', null, '加入音樂資料夾'), h('p', null, '選擇存放音樂的資料夾，MIKU 會讀取標籤並建立曲庫。音樂檔案不會被修改。'));
    box.append(h('button', { class: 'btn primary', html: icon('folder') + '選擇資料夾', onclick: async () => { const f = await Host.call('folder.add'); if (f) { App.settings.folders = f; Router.render(); } } }));
    const chips = h('div', { class: 'chips' });
    box.append(chips);
    Host.call('suggestFolders').then(list => (list || []).forEach(p => chips.append(h('button', {
      class: 'chip', html: icon('folder') + esc(p),
      onclick: async () => { const f = await Host.call('folder.addPath', { path: p }); App.settings.folders = f; Router.render(); },
    }))));
    view.append(h('div', { class: 'empty' }, box));
  },

  albums(view) {
    let sort = uiPref('albumSort', 'added'), filter = uiPref('albumFilter', 'all');
    const coll = Lib.collator;
    const sorters = {
      added: (a, b) => b.added - a.added,
      artist: (a, b) => coll.compare(a.artist, b.artist) || (a.year - b.year) || coll.compare(a.title, b.title),
      title: (a, b) => coll.compare(a.title, b.title),
      year: (a, b) => (b.year || 0) - (a.year || 0) || coll.compare(a.artist, b.artist),
    };
    let cleanup;
    const host = h('div');
    const draw = () => {
      cleanup && cleanup();
      host.textContent = '';
      let list = Lib.albums.filter(a => filter === 'all' || (filter === 'hires' ? a.qc === 'hi' : filter === 'dsd' ? a.qc === 'dsd' : true));
      list.sort(sorters[sort]);
      head.querySelector('.sub').textContent = `${list.length} 張`;
      const firstChar = s => { const c = [...(s || '').trim()][0] || '#'; return /[a-z]/i.test(c) ? c.toUpperCase() : c; };
      const labels = {
        added: a => { const d = new Date((a.added - 62135596800) * 1000); return isNaN(d) ? '' : `${d.getFullYear()} / ${d.getMonth() + 1}`; },
        artist: a => firstChar(a.artist), title: a => firstChar(a.title), year: a => a.year || '—',
      };
      cleanup = vgrid(host, list, { render: albumCard, label: labels[sort] });
    };
    const head = pageHead('專輯', '', [
      seg([['all', '全部'], ['hires', 'Hi-Res'], ['dsd', 'DSD']], filter, v => { filter = v; setUiPref('albumFilter', v); draw(); }),
      seg([['added', '最近加入'], ['artist', '演出者'], ['title', '名稱'], ['year', '年份']], sort, v => { sort = v; setUiPref('albumSort', v); draw(); }),
      colsControl('album'),
    ]);
    view.append(head, host);
    draw();
    return () => cleanup && cleanup();
  },

  album(view, id) {
    const al = Lib.albumById.get(id);
    if (!al) { view.append(h('div', { class: 'empty' }, '找不到這張專輯')); return; }
    const kind = al.loose && al.tracks[0] ? 't' : 'a', artId = kind === 't' ? al.tracks[0].id : al.id;
    const f = al.tracks[0] || {};
    const discs = new Set(al.tracks.map(t => t.disc)).size;
    const cover = artBox('cover', kind, artId, 300, al.title);
    cover.onclick = () => ArtPicker.open(al);
    const meta = h('div', { class: 'meta' },
        h('div', { class: 'kind' }, al.loose ? '資料夾' : '專輯'),
        h('h1', { title: al.title }, al.title),
        h('div', { class: 'by' }, h('a', { onclick: () => go('#/artist/' + encodeURIComponent(al.artist)) }, al.artist)),
        h('div', { class: 'facts num' },
          al.year ? h('span', null, al.year) : null,
          h('span', null, `${al.tracks.length} 首 · ${fmtLong(al.dur)}`),
          al.genre ? h('span', null, '· ' + al.genre) : null,
          h('span', { class: 'badge ' + al.qc }, (f.codec === 'DSF' || f.codec === 'DFF') ? al.q : `${f.codec} ${al.q}`)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', html: icon('play', true) + '播放', onclick: () => App.playTracks(al.tracks, 0, false) }),
          h('button', { class: 'btn', html: icon('shuffle') + '隨機', onclick: () => App.playTracks(al.tracks, -1, true) }),
          h('button', { class: 'icon-btn', title: '更多', html: icon('more'), onclick: e => albumMenu(al, e.currentTarget) })));
    const hero = h('div', { class: 'hero album' }, heroBg(kind, artId), cover, meta);
    view.append(hero);
    Flip.play(al.id, cover);
    artNote(al, meta);
    const list = h('div', { class: 'tracks' }, thead('作曲'));
    let lastDisc = null;
    al.tracks.forEach((t, i) => {
      if (discs > 1 && t.disc !== lastDisc) { lastDisc = t.disc; list.append(h('div', { class: 'disc' }, `DISC ${t.disc}`)); }
      const row = trackRow(t, i, al.tracks, { album: false });
      if (i < 24 && !Motion.quiet) { row.classList.add('stagger'); row.style.setProperty('--i', i + 3); }
      list.append(row);
    });
    view.append(list);
    // more by this artist
    const more = (Lib.artistMap.get(al.artist)?.albums || []).filter(a => a !== al);
    if (more.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, `更多 ${al.artist} 的作品`)));
      const r = h('div', { class: 'rail' });
      more.slice(0, 20).forEach(a => r.append(albumCard(a, 176)));
      view.append(r);
    }
  },

  artists(view) {
    view.append(pageHead('演出者', `${Lib.artists.length} 位`, [colsControl('artist')]));
    const host = h('div');
    view.append(host);
    return vgrid(host, Lib.artists, { minW: 160, extra: 50, render: artistCard, kind: 'artist', label: a => ([...a.name.trim()][0] || '#').toUpperCase() });
  },

  artist(view, name) {
    const { own, appears } = Lib.artistAlbums(name);
    const all = own.concat(appears);
    const first = own[0] || appears[0];
    const tracks = own.flatMap(a => a.tracks);
    const hero = h('div', { class: 'hero artist' },
      first ? heroBg('a', first.id) : null,
      artBox('cover', 'r', name, 260, name),
      h('div', { class: 'meta' },
        h('div', { class: 'kind' }, '演出者'),
        h('h1', null, name),
        h('div', { class: 'facts' }, `${own.length} 張專輯 · ${tracks.length} 首`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', html: icon('play', true) + '播放', onclick: () => App.playTracks(tracks.length ? tracks : all.flatMap(a => a.tracks), 0, false) }),
          h('button', { class: 'btn', html: icon('shuffle') + '隨機', onclick: () => App.playTracks(tracks.length ? tracks : all.flatMap(a => a.tracks), -1, true) }))));
    view.append(hero);
    const section = (title, albums) => {
      if (!albums.length) return;
      view.append(h('div', { class: 'rail-head' }, h('h2', null, title)));
      const host = h('div');
      view.append(host);
      return vgrid(host, albums, { render: albumCard });
    };
    const c1 = section('專輯', own), c2 = section('參與作品', appears);
    return () => { c1 && c1(); c2 && c2(); };
  },

  tracks(view) {
    let sort = uiPref('trackSort', 'artist');
    const coll = Lib.collator;
    let cleanup;
    const host = h('div', { class: 'tracks' });
    const draw = () => {
      cleanup && cleanup();
      host.textContent = '';
      host.append(thead());
      const list = Lib.tracks.slice();
      if (sort === 'title') list.sort((a, b) => coll.compare(a.title, b.title));
      else if (sort === 'added') list.sort((a, b) => (b.album?.added || 0) - (a.album?.added || 0) || a.disc - b.disc || a.no - b.no);
      else list.sort((a, b) => coll.compare(a.album?.artist || '', b.album?.artist || '') || coll.compare(a.album?.title || '', b.album?.title || '') || a.disc - b.disc || a.no - b.no);
      cleanup = vlist(host, list, 68, (t, i) => trackRow(t, i, list, { art: true }));
    };
    view.append(pageHead('曲目', `${Lib.tracks.length} 首`, [
      seg([['artist', '演出者'], ['title', '標題'], ['added', '最近加入']], sort, v => { sort = v; setUiPref('trackSort', v); draw(); }),
      h('button', { class: 'btn small', html: icon('shuffle') + '全部隨機', onclick: () => App.playTracks(Lib.tracks, -1, true) }),
    ]), host);
    draw();
    return () => cleanup && cleanup();
  },

  favorites(view) {
    const list = [...App.favs].map(id => Lib.trackById.get(id)).filter(Boolean);
    view.append(pageHead('我的最愛', `${list.length} 首`, list.length ? [
      h('button', { class: 'btn primary small', html: icon('play', true) + '播放', onclick: () => App.playTracks(list, 0, false) }),
      h('button', { class: 'btn small', html: icon('shuffle') + '隨機', onclick: () => App.playTracks(list, -1, true) }),
    ] : null));
    if (!list.length) { view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' }, h('p', null, '在曲目旁按愛心，就會收藏到這裡。')))); return; }
    const host = h('div', { class: 'tracks' }, thead());
    list.forEach((t, i) => host.append(trackRow(t, i, list, { art: true })));
    view.append(host);
  },

  recent(view) {
    const list = (App.settings.recent || []).map(id => Lib.trackById.get(id)).filter(Boolean);
    view.append(pageHead('最近聆聽', `${list.length} 首`, list.length ? [
      h('button', { class: 'btn primary small', html: icon('play', true) + '播放', onclick: () => App.playTracks(list, 0, false) }),
      h('button', { class: 'btn small', html: icon('trash') + '清除紀錄', onclick: () => { App.settings.recent = []; App.lastRecent = null; Host.call('recent.clear'); Router.render(true); } }),
    ] : null));
    if (!list.length) { view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' }, h('p', null, '播放過的曲目會出現在這裡。')))); return; }
    const host = h('div', { class: 'tracks' }, thead());
    list.forEach((t, i) => host.append(trackRow(t, i, list, { art: true })));
    view.append(host);
  },

  search(view, q) {
    $('#q').value = q;
    // clicking a result (album, artist, track) means this search was useful: keep it in the history.
    // #view is reused by every page, so the listener must be removed when this page goes away.
    const keep = e => { if (e.target.closest('.card, .row, a, button')) SearchHist.add(q); };
    view.addEventListener('click', keep, true);
    const cleanup = () => view.removeEventListener('click', keep, true);
    const terms = norm(q).split(/\s+/).filter(Boolean);
    const match = s => terms.every(t => s.includes(t));
    const artists = Lib.artists.filter(a => match(a.s)).slice(0, 10);
    const albums = Lib.albums.filter(a => match(a.s)).slice(0, 18);
    const tracks = Lib.tracks.filter(t => match(t.s)).slice(0, 80);
    view.append(pageHead(`「${q}」`, `${artists.length + albums.length + tracks.length ? '' : '沒有符合的結果'}`));
    if (artists.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, '演出者')));
      const r = h('div', { class: 'rail', style: { gridAutoColumns: '150px' } });
      artists.forEach(a => r.append(artistCard(a, 150)));
      view.append(r);
    }
    if (albums.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, '專輯')));
      const r = h('div', { class: 'rail' });
      albums.forEach(a => r.append(albumCard(a, 176)));
      view.append(r);
    }
    if (tracks.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, '曲目')));
      const host = h('div', { class: 'tracks' });
      tracks.forEach((t, i) => host.append(trackRow(t, i, tracks, { art: true })));
      view.append(host);
    }
    return cleanup;
  },

  settings(view) { return Settings.render(view); },

  ytmusic(view) {
    const nav = to => Host.call('yt.nav', { to });
    const bar = h('div', { class: 'yt-bar' },
      h('button', { class: 'round-btn', title: '上一頁', html: icon('left'), onclick: () => nav('back') }),
      h('button', { class: 'round-btn', title: '下一頁', html: icon('right'), onclick: () => nav('forward') }),
      h('button', { class: 'round-btn', title: '重新整理', html: icon('refresh'), onclick: () => nav('reload') }),
      h('span', { class: 'yt-title' }, 'YouTube Music'),
      h('button', { class: 'chip', html: icon('home') + '首頁', onclick: () => nav('home') }),
      h('button', { class: 'chip', html: icon('heart') + '喜歡的音樂', onclick: () => nav('liked') }),
      h('button', { class: 'chip', html: icon('album') + '音樂庫', onclick: () => nav('library') }));
    const frame = h('div', { class: 'yt-frame' }, h('div', { class: 'muted' }, '載入 YouTube Music…'));
    view.append(bar, frame);
    view.classList.add('yt-view');
    YT.frame = frame;
    const ro = new ResizeObserver(() => YT.sync());
    ro.observe(frame);
    YT.sync();
    return () => { ro.disconnect(); YT.frame = null; view.classList.remove('yt-view'); YT.sync(); };
  },
};
