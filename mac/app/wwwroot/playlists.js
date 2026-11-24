'use strict';
/* ═════════════════════════════ 播放清單 (the listener's own playlists) ═════════════════════════════
   A playlist is a name and a list of track ids, in order. The page keeps them (Playlists.list) and sends all of them
   to the host after each change (playlists.put); the host stores them with the settings and tells every page
   ('playlists'). Tracks whose files are gone stay in the list (they come back when the file does) but are not shown. */
const Playlists = {
  list: [],

  init(saved) {
    this.list = Array.isArray(saved) ? saved : [];
    Host.on('playlists', l => {
      this.list = Array.isArray(l) ? l : [];
      if (Router.cur.name === 'playlists' || Router.cur.name === 'playlist') Router.render(true, 'none');
    });
  },
  get(id) { return this.list.find(p => p.id === id) || null; },
  tracksOf(pl) { return pl.tracks.map(id => Lib.trackById.get(id)).filter(Boolean); },
  save() {
    Host.call('playlists.put', { list: this.list });
    if (Router.cur.name === 'playlists' || Router.cur.name === 'playlist') Router.render(true, 'none');
  },
  create(name, ids = []) {
    const now = Date.now();
    const pl = { id: 'pl' + now.toString(36) + Math.random().toString(36).slice(2, 6), name: name.trim() || T('播放清單'), tracks: ids.slice(), created: now, updated: now };
    this.list.push(pl);
    this.save();
    return pl;
  },
  /** Adds tracks at the end; ones already in it are left out (told in the toast). */
  add(pl, ids) {
    const have = new Set(pl.tracks);
    const fresh = [...new Set(ids)].filter(id => !have.has(id));
    if (fresh.length) { pl.tracks.push(...fresh); pl.updated = Date.now(); this.save(); }
    const skipped = ids.length - fresh.length;
    if (!fresh.length) toast(T`已經在「${pl.name}」裡了`);
    else toast(skipped > 0 ? T`已加入 ${fresh.length} 首到「${pl.name}」（${skipped} 首已經在裡面）` : T`已加入 ${fresh.length} 首到「${pl.name}」`);
  },
  removeAt(pl, id) {
    const i = pl.tracks.indexOf(id);
    if (i < 0) return;
    pl.tracks.splice(i, 1); pl.updated = Date.now(); this.save();
  },
  /** Moves a track to where another one is (drag in the playlist's page), or by steps (the row's menu). */
  move(pl, id, toId) {
    const from = pl.tracks.indexOf(id), to = pl.tracks.indexOf(toId);
    if (from < 0 || to < 0 || from === to) return;
    pl.tracks.splice(to, 0, pl.tracks.splice(from, 1)[0]);
    pl.updated = Date.now(); this.save();
  },
  rename(pl, name) { name = name.trim(); if (!name || name === pl.name) return; pl.name = name; pl.updated = Date.now(); this.save(); },
  remove(pl) {
    this.list = this.list.filter(p => p !== pl);
    this.save();
    if (Router.cur.name === 'playlist' && Router.cur.arg === pl.id) go('#/playlists');
  },

  /** A small box asking for a name (Electron has no prompt()). done(name) when the listener confirms one. */
  askName(anchor, title, initial, done) {
    const input = h('input', { class: 'pick-q', type: 'text', value: initial || '', placeholder: T('播放清單名稱'), spellcheck: 'false', maxlength: '80' });
    const ok = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } Popover.close(); done(v); };
    input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') ok(); else if (e.key === 'Escape') Popover.close(); };
    const box = h('div', { class: 'menu pick pl-name' }, h('div', { class: 'pl-name-t' }, title), input,
      h('div', { class: 'pl-name-b' },
        h('button', { class: 'btn small ghost', onclick: () => Popover.close() }, T('取消')),
        h('button', { class: 'btn small primary', onclick: ok }, T('確定'))));
    Popover.show(box, anchor, { cls: 'menu-pop' });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  },

  /** 加入播放清單…: pick one of the playlists, or make a new one with these tracks in it. */
  pick(ids, anchor) {
    ids = ids.filter(id => !isRemoteId(id));
    if (!ids.length) { toast(T('遠端音樂庫的歌曲不能加入播放清單')); return; }
    const NEW = {};
    const items = [{ label: T('＋ 新增播放清單…'), value: NEW }, ...this.list.map(pl => ({ label: pl.name, sub: T`${this.tracksOf(pl).length} 首`, value: pl }))];
    pickList(items, anchor, v => {
      if (v !== NEW) { this.add(v, ids); return; }
      // the picker has just closed: the name box opens where it was
      setTimeout(() => this.askName(anchor, T('新增播放清單'), '', name => { const pl = this.create(name, [...new Set(ids)]); toast(T`已建立「${pl.name}」（${pl.tracks.length} 首）`); }), 180);
    }, T('搜尋播放清單'));
  },

  menuItem(ids, anchor) { return { label: T('加入播放清單…'), icon: 'list', run: () => this.pick(ids, anchor) }; },

  /** Up to four covers of the playlist's first albums, as its picture. */
  mosaic(pl, size) {
    const box = h('div', { class: 'pl-art' });
    const seen = new Set(), arts = [];
    for (const t of this.tracksOf(pl)) {
      const [kind, id] = trackArt(t), key = kind + ':' + id;
      if (seen.has(key)) continue;
      seen.add(key); arts.push([kind, id, t.album?.title]);
      if (arts.length === 4) break;
    }
    if (!arts.length) { box.classList.add('none'); box.innerHTML = icon('list'); return box; }
    if (arts.length < 4) arts.length = 1;
    box.classList.toggle('four', arts.length === 4);
    for (const [kind, id, title] of arts) box.append(artBox('pl-art-i', kind, id, arts.length === 4 ? size / 2 : size, title));
    return box;
  },
};

/** 播放清單: all of them. */
Views.playlists = function (view) {
  const add = h('button', { class: 'btn primary small', html: icon('plus') + T('新增播放清單') });
  add.onclick = () => Playlists.askName(add, T('新增播放清單'), '', name => { const pl = Playlists.create(name); go('#/playlist/' + pl.id); });
  view.append(pageHead(T('播放清單'), T`${Playlists.list.length} 個`, [add]));
  if (!Playlists.list.length) {
    view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' },
      h('p', null, T('還沒有播放清單。按「新增播放清單」，或在曲目、專輯上按右鍵選「加入播放清單…」。')))));
    return;
  }
  const grid = h('div', { class: 'pl-grid' });
  for (const pl of Playlists.list) {
    const tracks = Playlists.tracksOf(pl);
    const card = h('div', { class: 'pl-card', title: pl.name },
      Playlists.mosaic(pl, 220),
      h('div', { class: 'pl-t1' }, pl.name),
      h('div', { class: 'pl-t2 num' }, T`${tracks.length} 首` + (tracks.length ? ' · ' + fmtLong(tracks.reduce((s, t) => s + (t.dur || 0), 0)) : '')));
    card.onclick = () => go('#/playlist/' + pl.id);
    card.oncontextmenu = e => { e.preventDefault(); playlistMenu(pl, { x: e.clientX, y: e.clientY }); };
    grid.append(card);
  }
  view.append(grid);
};

function playlistMenu(pl, anchor) {
  const tracks = Playlists.tracksOf(pl);
  menu([
    tracks.length && { label: T('播放'), icon: 'play', run: () => App.playTracks(tracks, 0, false) },
    tracks.length && { label: T('隨機播放'), icon: 'shuffle', run: () => App.playTracks(tracks, -1, true) },
    tracks.length && { label: T('加入播放佇列'), icon: 'queue', run: () => { Host.call('queue.add', { ids: tracks.map(t => t.id) }); toast(T`已加入 ${tracks.length} 首`); } },
    tracks.length && '-',
    { label: T('重新命名…'), icon: 'note', run: () => setTimeout(() => Playlists.askName(anchor, T('重新命名播放清單'), pl.name, name => Playlists.rename(pl, name)), 180) },
    { label: T('刪除播放清單'), icon: 'trash', run: () => setTimeout(() => menu([
      { label: T`確定刪除「${pl.name}」`, icon: 'trash', run: () => { Playlists.remove(pl); toast(T`已刪除「${pl.name}」`); } },
      { label: T('取消'), icon: 'x', run: () => { } },
    ], anchor), 180) },
  ], anchor);
}

/** One playlist: its tracks in order; drag a row to move it, right-click to take it out. */
Views.playlist = function (view, id) {
  const pl = Playlists.get(id);
  if (!pl) { view.append(pageHead(T('播放清單'), null), h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' }, h('p', null, T('找不到這個播放清單。'))))); return; }
  const list = Playlists.tracksOf(pl);
  const more = h('button', { class: 'btn small', html: icon('more'), title: T('更多') });
  more.onclick = () => playlistMenu(pl, more);
  view.append(pageHead(pl.name, T`${list.length} 首` + (list.length ? ' · ' + fmtLong(list.reduce((s, t) => s + (t.dur || 0), 0)) : ''), [
    list.length ? h('button', { class: 'btn primary small', html: icon('play', true) + T('播放'), onclick: () => App.playTracks(list, 0, false) }) : null,
    list.length ? h('button', { class: 'btn small', html: icon('shuffle') + T('隨機'), onclick: () => App.playTracks(list, -1, true) }) : null,
    more,
  ].filter(Boolean)));
  if (!list.length) {
    view.append(h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' },
      h('p', null, T('這個播放清單還是空的。在曲目或專輯上按右鍵，選「加入播放清單…」。')))));
    return;
  }
  const host = h('div', { class: 'tracks pl-tracks' }, thead());
  list.forEach((t, i) => {
    const r = trackRow(t, i, list, { art: true });
    r.oncontextmenu = e => {
      e.preventDefault();
      const anchor = { x: e.clientX, y: e.clientY };
      menu([
        { label: T('播放'), icon: 'play', run: () => App.playTracks(list, i) },
        { label: T('下一首播放'), icon: 'next-up', run: () => { Host.call('queue.add', { ids: [t.id], next: true }); toast(T('已排在下一首')); } },
        { label: T('加入播放佇列'), icon: 'queue', run: () => { Host.call('queue.add', { ids: [t.id] }); toast(T('已加入佇列')); } },
        '-',
        i > 0 && { label: T('往上移'), icon: 'left', run: () => Playlists.move(pl, t.id, list[i - 1].id) },
        i < list.length - 1 && { label: T('往下移'), icon: 'right', run: () => Playlists.move(pl, t.id, list[i + 1].id) },
        { label: T('從這個播放清單移除'), icon: 'x', run: () => Playlists.removeAt(pl, t.id) },
        '-',
        { label: T('加入其他播放清單…'), icon: 'list', run: () => Playlists.pick([t.id], anchor) },
        { label: T('前往專輯'), icon: 'album', run: () => go('#/album/' + t.albumId) },
      ], anchor);
    };
    // drag a row onto another to move it there
    r.draggable = true;
    r.ondragstart = e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-miku-pl', t.id); r.classList.add('pl-drag'); };
    r.ondragend = () => { r.classList.remove('pl-drag'); host.querySelectorAll('.pl-over').forEach(x => x.classList.remove('pl-over')); };
    r.ondragover = e => { if (![...e.dataTransfer.types].includes('text/x-miku-pl')) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; r.classList.add('pl-over'); };
    r.ondragleave = () => r.classList.remove('pl-over');
    r.ondrop = e => { e.preventDefault(); const from = e.dataTransfer.getData('text/x-miku-pl'); if (from && from !== t.id) Playlists.move(pl, from, t.id); };
    host.append(r);
  });
  view.append(host);
};
