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
  const draw = () => label.textContent = gridCols(kind) ? T`每排 ${gridCols(kind)}` : T('自動');
  const box = h('div', { class: 'seg', title: T('每排顯示數量（⌘ + 滾輪也可以調整）') },
    h('button', { onclick: () => { setGridCols(Math.max(2, cur() - 1), kind); draw(); } }, '−'),
    label,
    h('button', { onclick: () => { setGridCols(cur() + 1, kind); draw(); } }, '+'),
    h('button', { onclick: () => { setGridCols(0, kind); draw(); } }, T('自動')));
  draw();
  // the page is rebuilt on every visit: stop listening once this control has left it
  const onCols = () => { if (box.isConnected) draw(); else window.removeEventListener('gridcols', onCols); };
  window.addEventListener('gridcols', onCols);
  return box;
}
// Ctrl + mouse wheel over a grid changes the number per row
document.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
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
  const art = artBox('art', ...albumArt(al), size || 200, al.title);
  art.dataset.album = al.id;
  const play = h('button', { class: 'play', title: T('播放'), html: icon('play', true), onclick: e => { e.stopPropagation(); App.playTracks(al.tracks, 0, false); } });
  art.append(play);
  const c = h('div', { class: 'card', onclick: () => {
    const open = () => { Flip.capture(al.id, art); go('#/album/' + al.id); };
    if (typeof Vinyl !== 'undefined' && Vinyl.pullOut(c, open)) return;   // VINYL: pull the record out of the sleeve first
    open();
  } },
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
    h('div', { class: 't1' }, ar.name), h('div', { class: 't2' }, T`${ar.albums.length} 張專輯`));
  return c;
}

function trackRow(t, i, list, opts = {}) {
  const n = h('div', { class: 'n num' },
    h('span', null, opts.number ?? t.no ?? i + 1),
    h('div', { class: 'pi', html: icon('play', true) }),
    h('div', { class: 'eq', html: '<i></i><i></i><i></i>' }));
  if (opts.art) n.replaceChildren(artBox('thumb', ...trackArt(t), 40, t.album?.title), h('div', { class: 'eq', html: '<i></i><i></i><i></i>' }));
  const alCell = h('div', { class: 'al' });
  if (opts.album !== false && t.album) alCell.append(h('a', { onclick: e => { e.stopPropagation(); go('#/album/' + t.albumId); } }, t.album.title));
  else if (opts.album === false) alCell.textContent = t.composer || '';
  const fav = h('button', { class: 'icon-btn more' + (App.favs.has(t.id) ? ' fav-on' : ''), html: icon(App.favs.has(t.id) ? 'heartf' : 'heart'), title: T('最愛') });
  fav.onclick = e => { e.stopPropagation(); const on = App.toggleFav(t.id); fav.classList.toggle('fav-on', on); fav.innerHTML = icon(on ? 'heartf' : 'heart'); };
  if (App.favs.has(t.id)) fav.style.opacity = 1;
  const r = h('div', { class: 'row', 'data-id': t.id },
    n,
    h('div', { class: 'tt' }, h('div', { title: t.title }, t.title), h('div', { class: 'a' }, t.artist || '')),
    alCell,
    h('div', { class: 'fmt' }, fmtQuality(t.codec, t.rate, t.bits)),
    h('div', { class: 'd num' }, fmtTime(t.dur)),
    fav);
  const at = () => list[i] === t ? i : list.indexOf(t);
  r.ondblclick = () => App.playTracks(list, at());
  n.onclick = e => { e.stopPropagation(); App.playTracks(list, at()); };
  r.onclick = () => { $$('.row.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); };
  r.oncontextmenu = e => { e.preventDefault(); trackMenu(t, { x: e.clientX, y: e.clientY }, list); };
  return r;
}

function thead(albumLabel = T('專輯')) {
  return h('div', { class: 'thead' }, h('div', { style: { textAlign: 'center' } }, '#'), h('div', null, T('標題')), h('div', null, albumLabel), h('div', { class: 'fmt' }, T('格式')), h('div', { style: { textAlign: 'right' } }, T('時間')), h('div'));
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
    const b = h('button', { class: v === value ? 'on' : '', 'data-label': typeof label === 'string' ? label : null }, label);   // data-label: app.css keeps the bold width reserved
    b.onclick = () => { $$('button', box).forEach(x => x.classList.remove('on')); b.classList.add('on'); onchange(v); };
    box.append(b);
  }
  return box;
}

const uiPref = (k, d) => (App.settings.ui && App.settings.ui[k]) || d;

/**
 * The sort direction beside a sort selector: says which way the list runs for the sort chosen
 * (新→舊 / 舊→新 for dates, A→Z / Z→A for names); a click turns it round. rev() is read when drawing.
 */
function sortDir(key, sortNow, ondraw) {
  const words = { added: [T('新→舊'), T('舊→新')], year: [T('新→舊'), T('舊→新')] };
  const b = h('button', { class: 'btn small sortdir', title: T('反向排列') });
  const all = [T('新→舊'), T('舊→新'), 'A→Z', 'Z→A'];   // every label stacked in one cell, so the button never changes width
  const paint = () => { const w = words[sortNow()] || ['A→Z', 'Z→A']; const cur = w[uiPref(key, '') === 'rev' ? 1 : 0]; b.innerHTML = icon('down') + `<span class="sd-w"><span>${cur}</span>${all.filter(x => x !== cur).map(x => `<i aria-hidden="true">${x}</i>`).join('')}</span>`; b.classList.toggle('rev', uiPref(key, '') === 'rev'); };
  b.onclick = () => { setUiPref(key, uiPref(key, '') === 'rev' ? 'fwd' : 'rev'); paint(); ondraw(); };
  paint();
  return { el: b, paint, rev: () => uiPref(key, '') === 'rev' };
}
function setUiPref(k, v) { (App.settings.ui = App.settings.ui || {})[k] = v; Host.call('ui', { key: k, value: v }); }

/* rails (home page) use the same albums-per-row setting */
function sizeRail(r) {
  let seen = false;
  const apply = () => {
    // the home page is rebuilt on every visit: a rail that has left it stops listening (once it had been shown)
    if (!r.isConnected) { if (seen) { window.removeEventListener('gridcols', apply); ro.disconnect(); } return; }
    seen = true;
    const n = gridCols('album');
    if (!n) { r.style.gridAutoColumns = ''; return; }
    const W = r.clientWidth - 72;
    if (W > 0) r.style.gridAutoColumns = Math.floor((W - 22 * (n - 1)) / n) + 'px';
  };
  requestAnimationFrame(apply);
  window.addEventListener('gridcols', apply);
  const ro = new ResizeObserver(apply);
  ro.observe(r);
}

/* Horizontal rails: ‹ › buttons in the header (the scrollbar is hidden and a mouse wheel scrolls the page),
   plus a soft fade on the edge that still has more cards. Attached to every .rail after a view renders. */
function attachRailNav(root) {
  for (const r of root.querySelectorAll('.rail')) {
    if (r.dataset.nav) continue;
    r.dataset.nav = '1';
    let head = r.previousElementSibling;
    if (!head || !head.classList.contains('rail-head')) continue;
    const prev = h('button', { class: 'round-btn rail-btn', title: T('向左'), html: icon('left') });
    const next = h('button', { class: 'round-btn rail-btn', title: T('向右'), html: icon('right') });
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
    const visible = !!(f && f.isConnected && !NowPlaying.open && !Drawer.open && !Popover.el && !document.querySelector('.modal-scrim') && !(window.ArtPicker && ArtPicker.el) && !(window.CoverView && CoverView.el));
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
      view.append(h('div', { class: 'empty' }, h('div', { class: 'box' }, h('h2', null, T('正在建立曲庫')), h('p', null, T('第一次掃描大型曲庫需要幾分鐘，完成後會自動顯示。')))));
      return;
    }
    shuffleSeed = shuffleSeed || Lib.albums.map(a => [Math.random(), a]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const rail = (title, albums, link) => {
      if (!albums.length) return;
      const [label, act] = typeof link === 'string' ? [T('顯示全部'), () => go(link)] : (link || []);
      view.append(h('div', { class: 'rail-head' }, h('h2', null, title), act ? h('a', { onclick: act }, label) : null));
      const r = h('div', { class: 'rail' });
      sizeRail(r);
      albums.forEach((a, k) => { const c = albumCard(a, 176); if (k < 10) { c.classList.add('stagger'); c.style.setProperty('--i', k); } r.append(c); });
      view.append(r);
    };
    view.append(h('div', { style: { height: '8px' } }));
    const recentTracks = (App.settings.recent || []).map(id => Lib.trackById.get(id)).filter(Boolean);
    // an album played in several versions (FLAC and DSD…) shows once, as its best version, like the album lists
    rail(T('最近聆聽'), [...new Set(recentTracks.map(t => t.album && (t.album.versions ? t.album.versions[0] : t.album)).filter(Boolean))].slice(0, 24), '#/recent');
    rail(T('最近加入'), Lib.albums.slice().sort((a, b) => b.added - a.added).slice(0, 24), '#/albums');
    const favAlbums = [...new Set([...App.favs].map(id => Lib.trackById.get(id)?.album).filter(Boolean))].slice(0, 24);
    rail(T('我的最愛'), favAlbums, '#/favorites');
    rail(T('高解析度'), shuffleSeed.filter(a => a.qc).slice(0, 24), [T('顯示全部'), () => { setUiPref('albumFilter', 'hires'); go('#/albums'); }]);
    rail(T('隨機探索'), shuffleSeed.filter(a => !a.qc).slice(0, 24), [T('換一批'), () => { shuffleSeed = null; Router.render(true, 'none'); }]);
    const artists = Lib.artists.filter(a => a.albums.length > 1);
    if (artists.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, T('演出者', 'nav')), h('a', { onclick: () => go('#/artists') }, T('顯示全部'))));
      const r = h('div', { class: 'rail', style: { gridAutoColumns: '150px' } });
      artists.map(a => [Math.random(), a]).sort((x, y) => x[0] - y[0]).slice(0, 20).forEach(([, a]) => r.append(artistCard(a, 150)));
      view.append(r);
    }
  },

  onboarding(view) {
    const box = h('div', { class: 'box' });
    box.innerHTML = `<div style="display:flex;justify-content:center;gap:16px;align-items:center">${Brand.svg(70)}</div>`;
    box.append(h('h2', null, T('加入音樂資料夾')), h('p', null, T('選擇存放音樂的資料夾，MIKU 會讀取標籤並建立曲庫。除非你用「編輯標籤」修改，音樂檔案不會被更動。')));
    box.append(h('button', { class: 'btn primary', html: icon('folder') + T('選擇資料夾'), onclick: async () => { const f = await Host.call('folder.add'); if (f) { App.settings.folders = f; Router.render(); } } }));
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
      if (dir.rev()) list.reverse();
      head.querySelector('.sub').textContent = T`${list.length} 張`;
      const firstChar = s => { const c = [...(s || '').trim()][0] || '#'; return /[a-z]/i.test(c) ? c.toUpperCase() : c; };
      const labels = {
        added: a => { const d = new Date((a.added - 62135596800) * 1000); return isNaN(d) ? '' : `${d.getFullYear()} / ${d.getMonth() + 1}`; },
        artist: a => firstChar(a.artist), title: a => firstChar(a.title), year: a => a.year || '—',
      };
      cleanup = vgrid(host, list, { render: albumCard, label: labels[sort] });
    };
    const dir = sortDir('albumSortDir', () => sort, () => draw());
    const head = pageHead(T('專輯', 'nav'), '', [
      seg([['all', T('全部')], ['hires', 'Hi-Res'], ['dsd', 'DSD']], filter, v => { filter = v; setUiPref('albumFilter', v); draw(); }),
      seg([['added', T('最近加入')], ['artist', T('演出者')], ['title', T('名稱')], ['year', T('年份')]], sort, v => { sort = v; setUiPref('albumSort', v); dir.paint(); draw(); }),
      dir.el,
      colsControl('album'),
    ]);
    view.append(head, host);
    draw();
    return () => cleanup && cleanup();
  },

  album(view, id) {
    let al = Lib.albumById.get(id);
    if (!al) {
      // the album was changed and got a new id (tags saved, files renamed…): show it under its new address
      const now = Lib.resolve(id);
      if (now) { history.replaceState(history.state, '', '#/album/' + now); al = Lib.albumById.get(now); }
    }
    if (!al) { view.append(h('div', { class: 'empty' }, T('找不到這張專輯'))); return; }
    const [kind, artId] = albumArt(al);
    const f = al.tracks[0] || {};
    const discs = new Set(al.tracks.map(t => t.disc)).size;
    const cover = artBox('cover', kind, artId, 300, al.title);
    if (!al.cd) cover.onclick = () => CoverView.open(al);
    const meta = h('div', { class: 'meta' },
        h('div', { class: 'kind' }, al.cd ? T`音樂 CD · ${Cd.info.disc.drive}` : al.loose ? T('資料夾') : T('專輯')),
        h('h1', { title: al.title }, al.title),
        h('div', { class: 'by' }, ...artistLinks(al.artists.length ? al.artists : [al.artist])),
        h('div', { class: 'facts num' },
          al.year ? h('span', null, al.year) : null,
          h('span', null, T`${al.tracks.length} 首 · ${fmtLong(al.dur)}`),
          al.genre ? h('span', null, '· ' + al.genre) : null,
          al.versions
            ? h('button', { class: 'badge ver ' + al.qc, title: T`這張專輯有 ${al.versions.length} 個版本，點一下切換`, onclick: e => versionMenu(al, e.currentTarget) },
              qualityLabel(al), h('span', { class: 'ver-n' }, T`${al.versions.length} 個版本`), h('span', { class: 'caret', html: icon('down') }))
            : h('span', { class: 'badge ' + al.qc }, qualityLabel(al))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', html: icon('play', true) + T('播放'), onclick: () => App.playTracks(al.tracks, 0, false) }),
          h('button', { class: 'btn', html: icon('shuffle') + T('隨機'), onclick: () => App.playTracks(al.tracks, -1, true) }),
          al.cd ? h('button', { class: 'btn', html: icon('disc') + T('抓取 CD'), onclick: () => Cd.ripDialog() }) : null,
          al.cd ? h('button', { class: 'btn cd-info-launch', html: icon('search') + T('查找 CD 資訊'), onclick: () => Cd.infoDialog() }) : null,
          al.cd ? h('button', { class: 'icon-btn', title: T('退出光碟'), html: icon('eject'), onclick: () => Cd.eject() }) : null,
          !al.cd ? h('button', { class: 'icon-btn', title: T('更多'), html: icon('more'), onclick: e => albumMenu(al, e.currentTarget, true) }) : null),
        al.cd && Cd.lookupText() ? h('div', { class: 'art-note' }, Cd.lookupText()) : null);
    const hero = h('div', { class: 'hero album' }, heroBg(kind, artId), cover, meta);
    view.append(hero);
    if (typeof Vinyl !== 'undefined') Vinyl.mount(hero, cover, al);
    Flip.play(al.id, cover);
    if (!al.cd) {
      artNote(al, meta);
      Convert.cueFor(al);  // look for a CUE sheet now, so the 「⋯」 menu opens without waiting
    }
    const list = h('div', { class: 'tracks' }, thead(T('作曲')));
    let lastDisc = null;
    al.tracks.forEach((t, i) => {
      if (discs > 1 && t.disc !== lastDisc) { lastDisc = t.disc; list.append(h('div', { class: 'disc' }, `DISC ${t.disc}`)); }
      const row = trackRow(t, i, al.tracks, { album: false });
      if (i < 24 && !Motion.quiet) { row.classList.add('stagger'); row.style.setProperty('--i', i + 3); }
      list.append(row);
    });
    view.append(list);
    // more by this artist (each of them when there are several)
    for (const name of al.artists.filter(realArtist).slice(0, 3)) {
      const more = (Lib.artistMap.get(name)?.albums || []).filter(a => a !== al && !(al.versions || []).includes(a));
      if (!more.length) continue;
      view.append(h('div', { class: 'rail-head' }, h('h2', null, T`更多 ${name} 的作品`)));
      const r = h('div', { class: 'rail' });
      more.slice(0, 20).forEach(a => r.append(albumCard(a, 176)));
      view.append(r);
    }
  },

  artists(view) {
    view.append(pageHead(T('演出者', 'nav'), T`${Lib.artists.length} 位`, [colsControl('artist')]));
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
      Object.assign(artBox('cover', 'r', name, 260, name), { onclick: () => ArtPicker.openArtist(name) }),
      h('div', { class: 'meta' },
        h('div', { class: 'kind' }, T('演出者')),
        h('h1', null, name),
        h('div', { class: 'facts' }, T`${own.length} 張專輯 · ${tracks.length} 首`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', html: icon('play', true) + T('播放'), onclick: () => App.playTracks(tracks.length ? tracks : all.flatMap(a => a.tracks), 0, false) }),
          h('button', { class: 'btn', html: icon('shuffle') + T('隨機'), onclick: () => App.playTracks(tracks.length ? tracks : all.flatMap(a => a.tracks), -1, true) }))));
    view.append(hero);
    const section = (title, albums) => {
      if (!albums.length) return;
      view.append(h('div', { class: 'rail-head' }, h('h2', null, title)));
      const host = h('div');
      view.append(host);
      return vgrid(host, albums, { render: albumCard });
    };
    const c1 = section(T('專輯', 'nav'), own), c2 = section(T('參與作品'), appears);
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
      if (dir.rev()) list.reverse();
      cleanup = vlist(host, list, 68, (t, i) => trackRow(t, i, list, { art: true }));
    };
    const dir = sortDir('trackSortDir', () => sort, () => draw());
    view.append(pageHead(T('曲目', 'nav'), T`${Lib.tracks.length} 首`, [
      seg([['artist', T('演出者')], ['title', T('標題')], ['added', T('最近加入')]], sort, v => { sort = v; setUiPref('trackSort', v); dir.paint(); draw(); }),
      dir.el,
      h('button', { class: 'btn small', html: icon('shuffle') + T('全部隨機'), onclick: () => App.playTracks(Lib.tracks, -1, true) }),
    ]), host);
    draw();
    return () => cleanup && cleanup();
  },

  favorites(view) {
    const list = [...App.favs].map(id => Lib.trackById.get(id)).filter(Boolean);
    view.append(pageHead(T('我的最愛'), T`${list.length} 首`, list.length ? [
      h('button', { class: 'btn primary small', html: icon('play', true) + T('播放'), onclick: () => App.playTracks(list, 0, false) }),
      h('button', { class: 'btn small', html: icon('shuffle') + T('隨機'), onclick: () => App.playTracks(list, -1, true) }),
    ] : null));
    if (!list.length) { view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' }, h('p', null, T('在曲目旁按愛心，就會收藏到這裡。'))))); return; }
    const host = h('div', { class: 'tracks' }, thead());
    list.forEach((t, i) => host.append(trackRow(t, i, list, { art: true })));
    view.append(host);
  },

  /** The audio CD in the drive (cd.js): its album page, with 抓取 CD. */
  cd(view) {
    if (!Cd.album) {
      view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } },
        h('div', { class: 'box' }, h('h2', null, T('未偵測到光碟')), h('p', null, T('放入音樂 CD 後會顯示在這裡。')))));
      return;
    }
    return Views.album(view, Cd.album.id);
  },

  recent(view) {
    const list = (App.settings.recent || []).map(id => Lib.trackById.get(id)).filter(Boolean);
    // 以曲目: every track played, newest first; 以專輯: the albums they come from, in the order last played
    const albums = [...new Set(list.map(t => t.album && (t.album.versions ? t.album.versions[0] : t.album)).filter(Boolean))];
    let by = uiPref('recentBy', 'track'), cleanup;
    const host = h('div');
    const sub = () => by === 'album' ? T`${albums.length} 張專輯` : T`${list.length} 首`;
    const draw = () => {
      cleanup && cleanup(); cleanup = null;
      host.textContent = '';
      head.querySelector('.sub').textContent = sub();
      if (by === 'album') { cleanup = vgrid(host, albums, { render: albumCard }); return; }
      const t = h('div', { class: 'tracks' }, thead());
      list.forEach((x, i) => t.append(trackRow(x, i, list, { art: true })));
      host.append(t);
    };
    const head = pageHead(T('最近聆聽'), sub(), list.length ? [
      seg([['track', T('以曲目')], ['album', T('以專輯')]], by, v => { by = v; setUiPref('recentBy', v); draw(); }),
      h('button', { class: 'btn primary small', html: icon('play', true) + T('播放'), onclick: () => App.playTracks(list, 0, false) }),
      h('button', { class: 'btn small', html: icon('trash') + T('清除紀錄'), onclick: () => { App.settings.recent = []; App.lastRecent = null; Host.call('recent.clear'); Router.render(true); } }),
    ] : null);
    view.append(head);
    if (!list.length) { view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' }, h('p', null, T('播放過的曲目會出現在這裡。'))))); return; }
    view.append(host);
    draw();
    return () => cleanup && cleanup();
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
    view.append(pageHead(T`「${q}」`, `${artists.length + albums.length + tracks.length ? '' : T('沒有符合的結果')}`));
    if (artists.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, T('演出者', 'nav'))));
      const r = h('div', { class: 'rail', style: { gridAutoColumns: '150px' } });
      artists.forEach(a => r.append(artistCard(a, 150)));
      view.append(r);
    }
    if (albums.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, T('專輯', 'nav'))));
      const r = h('div', { class: 'rail' });
      albums.forEach(a => r.append(albumCard(a, 176)));
      view.append(r);
    }
    if (tracks.length) {
      view.append(h('div', { class: 'rail-head' }, h('h2', null, T('曲目', 'nav'))));
      const host = h('div', { class: 'tracks' });
      tracks.forEach((t, i) => host.append(trackRow(t, i, tracks, { art: true })));
      view.append(host);
    }
    return cleanup;
  },

  settings(view, tab) { return Settings.render(view, tab); },

  ytmusic(view) {
    const nav = to => Host.call('yt.nav', { to });
    const bar = h('div', { class: 'yt-bar' },
      h('button', { class: 'round-btn', title: T('上一頁'), html: icon('left'), onclick: () => nav('back') }),
      h('button', { class: 'round-btn', title: T('下一頁'), html: icon('right'), onclick: () => nav('forward') }),
      h('button', { class: 'round-btn', title: T('重新整理'), html: icon('refresh'), onclick: () => nav('reload') }),
      h('span', { class: 'yt-title' }, 'YouTube Music'),
      h('button', { class: 'chip', html: icon('home') + T('首頁'), onclick: () => nav('home') }),
      h('button', { class: 'chip', html: icon('heart') + T('喜歡的音樂'), onclick: () => nav('liked') }),
      h('button', { class: 'chip', html: icon('album') + T('音樂庫'), onclick: () => nav('library') }));
    const frame = h('div', { class: 'yt-frame' }, h('div', { class: 'muted' }, T('載入 YouTube Music…')));
    view.append(bar, frame);
    view.classList.add('yt-view');
    // the library search bar has nothing to do with YouTube Music: hide the top bar and let the page move up into its place
    $('#main').classList.add('yt-mode');
    YT.frame = frame;
    const ro = new ResizeObserver(() => YT.sync());
    ro.observe(frame);
    YT.sync();
    return () => { ro.disconnect(); YT.frame = null; view.classList.remove('yt-view'); $('#main').classList.remove('yt-mode'); YT.sync(); };
  },
};
