'use strict';
/* ═════════════════════════════ 音樂庫 → 資料夾 ═════════════════════════════
 * The library by the folders on disk: library.json lists every folder once ("folders") and each track names its
 * folder (Lib: t.dir). Two ways to look at it, switched on the page (ui pref folderView):
 *   瀏覽 (browse): one folder at a time — its subfolders as cards (the covers of what they hold, fanned out), then its
 *                  songs as MIKU's own track rows; the path above leads up.
 *   樹狀 (tree):   the whole tree, folders opened and closed in place; "(n)" = what a folder holds (like foobar2000).
 * A folder plays everything under it, in the order shown. The top level is the library folders (Settings → 音樂庫);
 * files outside them hang under their drive. */
const Folders = {
  data: null, src: null, open: null, win: false,

  /** Windows paths compare without case. */
  key(p) { return this.win ? p.toLowerCase() : p; },
  sep() { return this.win ? '\\' : '/'; },

  /** The tree, built again whenever the library was loaded again. */
  get() {
    if (this.data && this.src === Lib.allTracks) return this.data;
    this.src = Lib.allTracks;
    const tracks = Lib.allTracks.filter(t => t.dir);
    this.win = tracks.some(t => /^[a-z]:[\\/]|^\\\\/i.test(t.dir));
    const sep = this.sep(), key = p => this.key(p);
    const strip = p => { p = String(p || '').trim(); while (p.length > 1 && /[\\/]$/.test(p) && !/^[a-z]:[\\/]$/i.test(p)) p = p.slice(0, -1); return p; };
    const join = (p, name) => /[\\/]$/.test(p) ? p + name : p + sep + name;
    const under = (k, rk) => k === rk || k.startsWith(/[\\/]$/.test(rk) ? rk : rk + sep);
    // the library folders, the longest first (a library folder inside another one stays its own top level)
    const libRoots = (App.settings.folders || []).map(strip).filter(Boolean).sort((a, b) => b.length - a.length);
    // a file outside them: its drive (D:\, \\server\share) or its first folder (/Volumes/Music)
    const topOf = d => {
      if (this.win) { const m = /^[a-z]:/i.exec(d) || /^\\\\[^\\]+\\[^\\]+/.exec(d); return m ? (m[0].length === 2 ? m[0] + '\\' : m[0]) : d; }
      const m = /^\/[^/]+/.exec(d); return m ? m[0] : '/';
    };
    const byDir = new Map();
    for (const t of tracks) { const l = byDir.get(t.dir); l ? l.push(t) : byDir.set(t.dir, [t]); }
    const byKey = new Map(), roots = [];
    const node = (path, name, parent) => {
      const k = key(path);
      let n = byKey.get(k);
      if (!n) {
        n = { name, path, parent, kids: [], tracks: [], count: 0, agg: null };
        byKey.set(k, n);
        (parent ? parent.kids : roots).push(n);
      }
      return n;
    };
    for (const [dir, list] of byDir) {
      const k = key(dir);
      const root = libRoots.find(r => under(k, key(r))) || topOf(dir);
      let n = node(root, root, null), p = root;
      for (const seg of dir.slice(root.length).split(/[\\/]+/).filter(Boolean)) { p = join(p, seg); n = node(p, seg, n); }
      n.tracks.push(...list);
    }
    const coll = Lib.collator;
    const byTrack = (a, b) => coll.compare(a.album?.title || '', b.album?.title || '') || (a.disc || 0) - (b.disc || 0) || (a.no || 0) - (b.no || 0) || coll.compare(a.title, b.title);
    const finish = n => {
      n.kids.sort((a, b) => coll.compare(a.name, b.name));
      n.tracks.sort(byTrack);
      n.count = n.tracks.length;
      for (const c of n.kids) n.count += finish(c);
      return n.count;
    };
    roots.sort((a, b) => coll.compare(a.path, b.path));
    roots.forEach(finish);
    return this.data = { roots, byKey };
  },

  /** Everything under a folder, in the order shown: its own songs, then each subfolder's. */
  collect(n) {
    const out = [];
    const walk = x => { for (const t of x.tracks) out.push(t); x.kids.forEach(walk); };
    walk(n);
    return out;
  },
  /** A library folder's short name (D:\Music → Music); its full path is shown beside it. */
  baseName(p) { return p.split(/[\\/]+/).filter(Boolean).pop() || p; },
  label(n) { return n.parent ? n.name : n.path; },
  href(n) { return '#/folders/' + encodeURIComponent(n.path); },

  menu(n, anchor, inTree) {
    const list = () => this.collect(n);
    const first = n.tracks[0] || list()[0];
    menu([
      inTree && { label: T('開啟'), icon: 'folder', run: () => this.openBrowse(n) },
      { label: T('播放'), icon: 'play', run: () => App.playTracks(list(), 0, false) },
      { label: T('隨機播放'), icon: 'shuffle', run: () => App.playTracks(list(), -1, true) },
      { label: T('下一首播放'), icon: 'next-up', run: () => { Host.call('queue.add', { ids: list().map(t => t.id), next: true }); toast(T('已排在下一首')); } },
      { label: T('加入播放佇列'), icon: 'queue', run: () => { const l = list(); Host.call('queue.add', { ids: l.map(t => t.id) }); toast(T`已加入 ${l.length} 首`); } },
      '-',
      // opens the folder itself ("reveal" with dir)
      first && { label: window.mikuHost ? T('在 Finder 中顯示') : T('在檔案總管中顯示'), icon: 'folder', run: () => Host.call('reveal', { id: first.id, dir: n.path }) },
    ], anchor);
  },
  openBrowse(n) {
    setUiPref('folderView', 'browse');
    if (location.hash === this.href(n)) Router.render(true, 'none'); else go(this.href(n));
  },
  playBtn(run) {
    return h('button', { class: 'icon-btn fplay', title: T('播放'), html: icon('play', true), onclick: e => { e.stopPropagation(); run(); } });
  },

  render(view, arg) {
    if (!Lib.hasFolders) {
      view.append(pageHead(T('資料夾', 'nav')), h('div', { class: 'empty', style: { minHeight: '50vh' } },
        h('div', { class: 'box' }, h('p', null, T('這份曲庫資料還沒有資料夾資訊，更新 MIKU 後重新開啟就會出現。')))));
      return;
    }
    const tree = this.get();
    if (!tree.roots.length) {
      view.append(pageHead(T('資料夾', 'nav')), h('div', { class: 'empty', style: { minHeight: '50vh' } }, h('div', { class: 'box' }, h('p', null, T('曲庫裡還沒有歌曲。')))));
      return;
    }
    let inner = null;
    const draw = first => {
      inner && inner(); inner = null;
      view.textContent = '';
      const mode = uiPref('folderView', 'browse') === 'tree' ? 'tree' : 'browse';
      const node = arg ? tree.byKey.get(this.key(arg)) || null : null;
      const switcher = seg([['browse', T('瀏覽')], ['tree', T('樹狀')]], mode, v => { setUiPref('folderView', v); $('#content').scrollTop = 0; draw(false); });
      inner = mode === 'tree' ? this.drawTree(view, tree, node, switcher, first) : this.drawBrowse(view, tree, node, switcher);
    };
    draw(true);
    return () => inner && inner();
  },

  /* ── 瀏覽: one folder ──
     The path above the title (所有資料夾 › MUSIC › …), then the subfolders as cards (the covers of the albums inside,
     fanned out; name, whose music it is, how much), then the folder's own songs as track rows like everywhere else in
     MIKU. Sorted by the buttons in the page head (ui prefs folderSort, folderSortDir). */
  drawBrowse(view, tree, node, switcher) {
    const at = node || (tree.roots.length === 1 ? tree.roots[0] : null);
    const kids = at ? at.kids : tree.roots;
    const songs = at ? at.tracks : [];
    const all = () => at ? this.collect(at) : tree.roots.flatMap(r => this.collect(r));
    const count = at ? at.count : tree.roots.reduce((s, r) => s + r.count, 0);
    // where you are: every folder above leads back up
    const chain = [];
    for (let p = at; p; p = p.parent) chain.unshift(p);
    const crumbs = h('nav', { class: 'fcrumbs' }, h('span', { class: 'ic', html: icon('folder') }));
    const steps = [{ label: T('所有資料夾'), href: '#/folders', title: '' }, ...chain.map(p => ({ label: p.parent ? p.name : this.baseName(p.path), href: this.href(p), title: p.path }))];
    steps.forEach((st, i) => {
      if (i) crumbs.append(h('span', { class: 'sep', html: icon('right') }));
      crumbs.append(i === steps.length - 1 ? h('span', { class: 'cur', title: st.title }, st.label) : h('a', { href: st.href, title: st.title }, st.label));
    });
    const title = at ? (at.parent ? at.name : this.baseName(at.path)) : T('所有資料夾');
    const sub = [kids.length ? T`${kids.length} 個資料夾` : '', T`${count} 首`].filter(Boolean).join(' · ');
    const sortNow = () => { const k = String(uiPref('folderSort', 'name')).split(':')[0]; return ['name', 'added', 'dur'].includes(k) ? k : 'name'; };
    const host = h('div', { class: 'fbrowse' });
    let stop = null;
    const draw = () => {
      stop && stop(); stop = null; host.textContent = '';
      const key = sortNow(), so = this.sorters();
      const fs = kids.slice().sort(so.dirs[key]), ts = songs.slice().sort(so.songs[key]);
      if (key === 'added') { fs.reverse(); ts.reverse(); }   // newest first
      if (dir.rev()) { fs.reverse(); ts.reverse(); }
      if (fs.length) host.append(h('div', { class: 'fshelf' }, fs.map(n => this.dirCard(n))));
      if (ts.length) {
        const list = h('div', { class: 'tracks' }, thead());
        host.append(list);
        stop = vlist(list, ts, 68, (t, i) => trackRow(t, i, ts, { art: true }));
      }
    };
    const dir = sortDir('folderSortDir', sortNow, () => draw());
    view.append(crumbs, pageHead(title, sub, [
      switcher,
      seg([['name', T('名稱')], ['added', T('最近加入')], ['dur', T('長度')]], sortNow(), v => { setUiPref('folderSort', v); dir.paint(); draw(); }),
      dir.el,
      h('button', { class: 'btn primary small', html: icon('play', true) + T('播放'), onclick: () => App.playTracks(all(), 0, false) }),
      h('button', { class: 'btn small', html: icon('shuffle') + T('隨機'), onclick: () => App.playTracks(all(), -1, true) }),
    ]));
    view.append(host);
    if (!kids.length && !songs.length) { host.append(h('div', { class: 'empty', style: { minHeight: '30vh' } }, h('div', { class: 'box' }, h('p', null, T('這個資料夾沒有歌曲。'))))); return null; }
    draw();
    return () => stop && stop();
  },
  /** Sorting: the cards and the songs, each by what was chosen. 名稱 keeps the songs in track order (their files are
   *  normally numbered that way); ties fall back to it too. */
  sorters() {
    const coll = Lib.collator, s = (a, b) => coll.compare(a || '', b || '');
    const order = (a, b) => (a.disc || 0) - (b.disc || 0) || (a.no || 0) - (b.no || 0) || s(a.title, b.title);
    const g = n => this.agg(n), byName = (a, b) => s(a.name, b.name);
    return {
      dirs: { name: byName, dur: (a, b) => g(a).dur - g(b).dur || byName(a, b), added: (a, b) => g(a).added - g(b).added || byName(a, b) },
      songs: { name: order, dur: (a, b) => a.dur - b.dur || order(a, b), added: (a, b) => (a.added || 0) - (b.added || 0) || order(a, b) },
    };
  },
  /** What a folder holds, for its card: total length, newest file, its artist / album / format when they are one, and
   *  up to three of its albums for the covers. */
  agg(n) {
    if (n.agg) return n.agg;
    let dur = 0, added = 0;
    const artists = new Set(), albums = new Set(), fmts = new Set();
    const walk = x => {
      for (const t of x.tracks) {
        dur += t.dur || 0;
        if ((t.added || 0) > added) added = t.added;
        if (t.album) { albums.add(t.album); artists.add(t.album.artist); }
        fmts.add(t.album?.q || fmtQuality(t.codec, t.rate, t.bits));
      }
      x.kids.forEach(walk);
    };
    walk(n);
    const one = set => set.size === 1 ? [...set][0] : null;
    return n.agg = {
      dur, added,
      artist: one(artists) ?? (artists.size ? T('多位演出者') : ''),
      album: one(albums)?.title ?? (albums.size ? T`${albums.size} 張專輯` : ''),
      fmt: one(fmts) ?? (fmts.size ? T('多種格式') : ''),
      albums: albums.size, covers: [...albums].slice(0, 3),
    };
  },
  /** A folder as a card: the covers of up to three albums inside, fanned out (a folder mark when it has none), its
   *  name, whose music it is (or how many albums), and how much it holds. */
  dirCard(n) {
    const a = this.agg(n);
    const stack = h('div', { class: 'ft-stack', 'data-n': a.covers.length });
    if (a.covers.length) a.covers.forEach((al, i) => { const b = artBox('ft-cv', ...albumArt(al), 96, al.title); b.style.setProperty('--k', i); stack.append(b); });
    else stack.append(h('div', { class: 'ft-cv ft-none', html: icon('folder') }));
    stack.append(h('button', { class: 'ft-play', title: T('播放'), html: icon('play', true), onclick: e => { e.stopPropagation(); App.playTracks(this.collect(n), 0, false); } }));
    const who = a.albums > 1 ? [a.artist, T`${a.albums} 張專輯`].filter(Boolean).join(' · ') : a.artist;
    const c = h('div', { class: 'ftile', title: n.path },
      stack,
      h('div', { class: 'ft-txt' },
        h('div', { class: 't1' }, this.label(n)),
        h('div', { class: 't2' }, who || ' '),
        h('div', { class: 't3 num' }, h('span', null, [n.kids.length ? T`${n.kids.length} 個資料夾` : '', T`${n.count} 首`, fmtTime(a.dur)].filter(Boolean).join(' · ')), a.fmt ? h('span', { class: 'ft-q' }, a.fmt) : null)));
    c.onclick = () => go(this.href(n));
    c.oncontextmenu = e => { e.preventDefault(); this.menu(n, { x: e.clientX, y: e.clientY }); };
    return c;
  },

  /* ── 樹狀: the whole tree ── */
  drawTree(view, tree, node, switcher, first) {
    if (!this.open) this.open = new Set(tree.roots.map(r => this.key(r.path)));   // the library folders start open
    const open = this.open;
    if (node) for (let p = node; p; p = p.parent) open.add(this.key(p.path));
    const total = tree.roots.reduce((s, r) => s + r.count, 0);
    view.append(pageHead(T('資料夾', 'nav'), T`${total} 首`, [
      switcher,
      h('button', { class: 'btn small', onclick: () => { open.clear(); tree.roots.forEach(r => open.add(this.key(r.path))); redraw(); } }, T('全部收合')),
    ]));
    const host = h('div', { class: 'ftree' });
    view.append(host);
    let rows = [], stop = null;
    const flatten = () => {
      rows = [];
      const walk = (n, d) => {
        rows.push({ n, d });
        if (!open.has(this.key(n.path))) return;
        for (const c of n.kids) walk(c, d + 1);
        n.tracks.forEach((t, i) => rows.push({ t, i, n, d: d + 1 }));
      };
      tree.roots.forEach(r => walk(r, 0));
    };
    const redraw = () => { stop && stop(); host.textContent = ''; flatten(); stop = vlist(host, rows, 34, x => x.t ? this.treeTrack(x) : this.treeFolder(x, open, redraw)); };
    redraw();
    // opened from a folder (瀏覽 → 樹狀): bring that folder into view once the page has been placed
    if (node && (first === false || Router.scrolls[location.hash] == null)) {
      const i = rows.findIndex(x => !x.t && x.n === node);
      if (i > 0) requestAnimationFrame(() => {
        const content = $('#content');
        const top = host.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
        content.scrollTop = Math.max(0, top + i * 34 - 140);
      });
    }
    return () => stop && stop();
  },
  treeFolder({ n, d }, open, redraw) {
    const k = this.key(n.path), isOpen = open.has(k);
    const r = h('div', { class: 'row trow fold' + (isOpen ? ' open' : ''), title: n.path },
      h('span', { class: 'chev', html: icon('right') }),
      h('span', { class: 'fi', html: icon('folder') }),
      h('span', { class: 'nm' }, this.label(n)),
      h('span', { class: 'ct num' }, `(${n.kids.length + n.tracks.length})`),
      h('span', { class: 'sp' }),
      this.playBtn(() => App.playTracks(this.collect(n), 0, false)));
    r.style.setProperty('--d', d);
    r.onclick = () => { isOpen ? open.delete(k) : open.add(k); redraw(); };
    r.oncontextmenu = e => { e.preventDefault(); this.menu(n, { x: e.clientX, y: e.clientY }, true); };
    return r;
  },
  treeTrack({ t, i, n, d }) {
    const r = h('div', { class: 'row trow trk', 'data-id': t.id },
      h('span', { class: 'chev' }),
      h('span', { class: 'fi', html: icon('note') }),
      h('span', { class: 'nm', title: t.title }, (t.no ? String(t.no).padStart(2, '0') + '. ' : '') + t.title),
      h('span', { class: 'sp' }),
      h('span', { class: 'fq' }, fmtQuality(t.codec, t.rate, t.bits)),
      h('span', { class: 'dur num' }, fmtTime(t.dur)),
      this.playBtn(() => App.playTracks(n.tracks, i)));
    r.style.setProperty('--d', d);
    r.onclick = () => { $$('.row.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); };
    r.ondblclick = () => App.playTracks(n.tracks, i);
    r.oncontextmenu = e => { e.preventDefault(); trackMenu(t, { x: e.clientX, y: e.clientY }, n.tracks); };
    return r;
  },
};
Views.folders = (view, arg) => Folders.render(view, arg);
