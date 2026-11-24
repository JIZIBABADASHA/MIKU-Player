'use strict';
/* ═════════════════════════════ 匯入 / 匯出播放清單 ═════════════════════════════
   Import: m3u / m3u8, pls, xspf, and foobar2000's .fpl / .fplite, picked with the button on the 播放清單 page or dropped
   anywhere on the window. Each one becomes a new playlist of the tracks of this computer's library it names. The file's
   own folder is not known to the page (a dropped or picked file has no path), so an entry is matched by what it says:
     1. the same full path;
     2. the same file name: one such track, else the one whose folders match the entry's the furthest back (Artist\Album);
     3. the same name with another extension (a .wav list for .flac files) in the same folder;
     4. the title and artist the list wrote down (#EXTINF, Title=, <title>), nearest in length.
   Entries that match nothing are counted and listed in the console.
   Export: the playlist as an .m3u8 (UTF-8) with #EXTINF lines and the full paths; the host asks where to save it. */
const PlaylistIO = {
  EXT: /\.(m3u8?|pls|xspf|fpl|fplite)$/i,
  ACCEPT: '.m3u,.m3u8,.pls,.xspf,.fpl,.fplite',

  /** The 匯入播放清單 button: one or more playlist files. */
  pick() {
    const inp = h('input', { type: 'file', accept: this.ACCEPT, multiple: true });
    inp.onchange = () => { if (inp.files && inp.files.length) this.importFiles([...inp.files]); };
    inp.click();
  },

  async importFiles(files) {
    const lists = files.filter(f => this.EXT.test(f.name));
    if (!lists.length) { toast(T('只能匯入播放清單檔（m3u、m3u8、pls、xspf、fpl）')); return; }
    const rows = await Host.call('library.files', {}).catch(() => null);
    if (!Array.isArray(rows) || !rows.length) { toast(T('音樂庫裡還沒有歌曲，沒有東西可以對應')); return; }
    const index = this.index(rows);
    let last = null;
    for (const f of lists) {
      if (f.size > 50e6) { toast(T`「${f.name}」太大了，不像是播放清單`); continue; }
      let parsed = null;
      try { parsed = this.parse(f.name, new Uint8Array(await f.arrayBuffer())); } catch (e) { console.error('[playlist import]', e); }
      if (!parsed || !parsed.entries.length) { toast(T`「${f.name}」裡沒有歌曲`); continue; }
      const ids = [], seen = new Set(), missing = [];
      for (const e of parsed.entries) {
        const id = this.match(index, e);
        if (!id) missing.push(e.path || [e.artist, e.title].filter(Boolean).join(' - ') || '?');
        else if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
      if (missing.length) console.info(`[playlist import] ${f.name}: not in the library`, missing);
      if (!ids.length) { toast(T`「${f.name}」裡的 ${parsed.entries.length} 首歌都不在音樂庫裡`); continue; }
      const pl = Playlists.create(this.uniqueName(parsed.name || f.name.replace(this.EXT, '')), ids);
      last = pl;
      toast(missing.length ? T`已匯入「${pl.name}」：${ids.length} 首，${missing.length} 首在音樂庫裡找不到` : T`已匯入「${pl.name}」：${ids.length} 首`);
    }
    if (last) go('#/playlist/' + last.id);
  },

  /** The playlist as an .m3u8: #EXTINF (length, "Artist - Title") and the full path of each track on this computer. */
  async export(pl) {
    const rows = await Host.call('library.files', { ids: pl.tracks }).catch(() => null);
    const byId = new Map((Array.isArray(rows) ? rows : []).map(r => [r[0], r]));
    const one = s => String(s || '').replace(/[\r\n]+/g, ' ').trim();
    const lines = ['#EXTM3U', '#PLAYLIST:' + one(pl.name)];
    let n = 0;
    for (const id of pl.tracks) {
      const r = byId.get(id);
      if (!r || !r[1]) continue;
      const [, path, title, artist, dur] = r;
      lines.push(`#EXTINF:${Math.round(dur) || -1},${[one(artist), one(title)].filter(Boolean).join(' - ')}`, path);
      n++;
    }
    if (!n) { toast(T('這個播放清單裡沒有這台電腦上的歌曲可以匯出')); return; }
    let file = null;
    try { file = await Host.call('playlists.saveFile', { name: pl.name, text: lines.join('\r\n') + '\r\n' }); }
    catch (e) { console.error('[playlist export]', e); toast(T('匯出失敗')); return; }
    if (!file) return;   // cancelled
    const left = pl.tracks.length - n, shown = String(file).split(/[\\/]/).pop();
    toast(left > 0 ? T`已匯出 ${n} 首到 ${shown}（${left} 首找不到檔案）` : T`已匯出 ${n} 首到 ${shown}`);
  },

  uniqueName(name) {
    name = String(name || '').trim() || T('播放清單');
    const taken = new Set(Playlists.list.map(p => p.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
  },

  // ───────────── reading the formats ─────────────

  /** { name, entries: [{ path, title, artist, dur }] } */
  parse(fileName, bytes) {
    const ext = (/\.([^.]+)$/.exec(fileName) || [])[1]?.toLowerCase() || '';
    if (ext === 'fpl') return this.parseFpl(bytes);
    const text = this.decode(bytes, ext === 'm3u8' || ext === 'xspf' || ext === 'fplite');
    if (ext === 'pls' || /^\s*\[playlist\]/i.test(text)) return this.parsePls(text);
    if (ext === 'xspf' || /^\s*(<\?xml[^>]*>\s*)?<playlist\b/i.test(text)) return this.parseXspf(text);
    return this.parseM3u(text);
  },

  /** Text in UTF-8 (or UTF-16 with its BOM); an older .m3u in a legacy code page: the one that decodes cleanest. */
  decode(b, utf8) {
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { }
    if (utf8) return new TextDecoder('utf-8').decode(b);
    let best = null, bad = Infinity;
    for (const enc of ['big5', 'shift_jis', 'gbk']) {
      try {
        const s = new TextDecoder(enc).decode(b), n = (s.match(/�/g) || []).length;
        if (n < bad) { best = s; bad = n; }
      } catch { }
    }
    return best ?? new TextDecoder('utf-8').decode(b);
  },

  /** "Artist - Title" (#EXTINF, PLS Title=) */
  splitTitle(s) {
    s = String(s || '').trim();
    const i = s.indexOf(' - ');
    return i > 0 ? { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() } : { title: s };
  },

  parseM3u(text) {
    const entries = [];
    let name = '', hint = null;
    for (let line of text.split(/\r\n|\r|\n/)) {
      line = line.trim();
      if (!line) continue;
      if (line[0] === '#') {
        let m;
        if ((m = /^#EXTINF:\s*(-?[\d.]+)[^,]*,(.*)$/i.exec(line))) hint = { dur: +m[1] > 0 ? +m[1] : 0, ...this.splitTitle(m[2]) };
        else if ((m = /^#PLAYLIST:(.*)$/i.exec(line))) name = m[1].trim();
        continue;
      }
      entries.push({ path: line, ...(hint || {}) });
      hint = null;
    }
    return { name, entries };
  },

  parsePls(text) {
    const f = {}, t = {}, len = {};
    for (const line of text.split(/\r\n|\r|\n/)) {
      const m = /^\s*(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line);
      if (!m) continue;
      ({ file: f, title: t, length: len })[m[1].toLowerCase()][+m[2]] = m[3].trim();
    }
    const entries = Object.keys(f).map(Number).sort((a, b) => a - b)
      .map(n => ({ path: f[n], ...(t[n] ? this.splitTitle(t[n]) : {}), dur: +len[n] > 0 ? +len[n] : 0 }));
    return { name: '', entries };
  },

  parseXspf(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const kid = (el, tag) => { for (const c of el.children) if (c.localName === tag) return c.textContent.trim(); return ''; };
    const root = doc.documentElement;
    if (!root || root.localName !== 'playlist') return { name: '', entries: [] };
    const entries = [...doc.getElementsByTagNameNS('*', 'track')].map(tr => ({
      path: kid(tr, 'location'), title: kid(tr, 'title'), artist: kid(tr, 'creator'), dur: (+kid(tr, 'duration') || 0) / 1000,
    })).filter(e => e.path || e.title);
    return { name: kid(root, 'title'), entries };
  },

  /** foobar2000's own playlist (.fpl): a binary file; its tracks' locations are the "file://…" strings in it, in order. */
  parseFpl(b) {
    const entries = [], dec = new TextDecoder('utf-8'), tag = [0x66, 0x69, 0x6C, 0x65, 0x3A, 0x2F, 0x2F];   // file://
    let last = null;
    for (let i = 0; i + tag.length < b.length; i++) {
      if (b[i] !== 0x66) continue;
      let k = 1;
      while (k < tag.length && b[i + k] === tag[k]) k++;
      if (k < tag.length) continue;
      let j = i + tag.length;
      while (j < b.length && b[j] >= 0x20) j++;
      const s = dec.decode(b.subarray(i, j));
      if (s !== last) entries.push({ path: s });   // the same location twice in a row: one string read twice
      last = s;
      i = j;
    }
    return { name: '', entries };
  },

  // ───────────── finding the tracks ─────────────

  key: s => String(s || '').normalize('NFC').toLowerCase(),
  /** Titles and artists compared without case, width, spaces and punctuation ("Ａ, B" = "a;b"). */
  text: s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''),
  stem: name => name.replace(/\.[^.]*$/, ''),

  /** A path or a file:// address: its parts (lower case), and the whole of it when it is a full path. null: not a file. */
  parts(p) {
    p = String(p || '').trim();
    if (/^file:/i.test(p)) {
      let rest = p.slice(5);
      const url = rest.startsWith('///') || (rest.startsWith('//') && !rest.includes('\\') && /%[0-9a-f]{2}/i.test(rest));
      rest = rest.replace(/^\/\/(localhost(?=\/))?/i, '');
      if (url) { try { rest = decodeURIComponent(rest); } catch { } }
      if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
      p = rest;
    } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) return null;   // http://, cdda://…
    if (!p) return null;
    const abs = /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]/.test(p);
    const segs = p.split(/[\\/]+/).filter(s => s && s !== '.' && s !== '..').map(this.key);
    if (!segs.length) return null;
    return { abs, segs, full: abs ? (/^[\\/]/.test(p) && !/^[A-Za-z]:/.test(p) ? '/' : '') + segs.join('/') : null };
  },

  index(rows) {
    const full = new Map(), byName = new Map(), byStem = new Map(), byTitle = new Map(), byTitleOnly = new Map();
    const push = (m, k, v) => { if (!k) return; const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const [id, path, title, artist, dur] of rows) {
      const p = this.parts(path);
      if (!p) continue;
      const t = { id, segs: p.segs, dur: +dur || 0 };
      if (p.full) full.set(p.full, id);
      const name = p.segs[p.segs.length - 1];
      push(byName, name, t); push(byStem, this.stem(name), t);
      const nt = this.text(title);
      if (nt) { push(byTitle, this.text(artist) + '\u0001' + nt, t); push(byTitleOnly, nt, t); }
    }
    return { full, byName, byStem, byTitle, byTitleOnly };
  },

  match(ix, e) {
    const p = e.path ? this.parts(e.path) : null;
    if (p) {
      if (p.full && ix.full.has(p.full)) return ix.full.get(p.full);
      const name = p.segs[p.segs.length - 1];
      const id = this.byFolders(ix.byName.get(name), p.segs, e.dur, false) || this.byFolders(ix.byStem.get(this.stem(name)), p.segs, e.dur, true);
      if (id) return id;
    }
    if (!e.title) return null;
    const nt = this.text(e.title);
    if (e.artist) {
      const id = this.byLength(ix.byTitle.get(this.text(e.artist) + '\u0001' + nt), e.dur, false)
        // "A - B" was the whole title, or the artist is written another way: the title alone, only when it is clear
        || this.byLength(ix.byTitleOnly.get(this.text(e.artist + ' - ' + e.title)), e.dur, true)
        || this.byLength(ix.byTitleOnly.get(nt), e.dur, true);
      return id;
    }
    return this.byLength(ix.byTitleOnly.get(nt), e.dur, true);
  },

  /** Of the tracks with the entry's file name: the one whose folders match the entry's the furthest back. A name met
   *  with another extension (stemOnly) needs at least its folder to match. */
  byFolders(list, segs, dur, stemOnly) {
    if (!list || !list.length) return null;
    const depth = t => {
      let n = 0;
      for (let a = segs.length - 2, b = t.segs.length - 2; a >= 0 && b >= 0 && segs[a] === t.segs[b]; a--, b--) n++;
      return n;
    };
    let top = -1, best = [];
    for (const t of list) { const d = depth(t); if (d > top) { top = d; best = [t]; } else if (d === top) best.push(t); }
    if (stemOnly && top < 1) return null;
    if (best.length === 1) return top > 0 || list.length === 1 ? best[0].id : this.byLength(best, dur, true);
    return this.byLength(best, dur, top < 1);
  },

  /** Of tracks that fit equally well: the one nearest the entry's length (within 3 s). strict: none when it can't tell. */
  byLength(list, dur, strict) {
    if (!list || !list.length) return null;
    if (dur > 0) {
      let best = null, gap = 3.5;
      for (const t of list) if (t.dur > 0 && Math.abs(t.dur - dur) < gap) { gap = Math.abs(t.dur - dur); best = t; }
      if (best) return best.id;
      if (list.length === 1 && list[0].dur > 0 && Math.abs(list[0].dur - dur) > 10) return null;   // a different recording
    }
    return list.length === 1 || !strict ? list[0].id : null;
  },

  /** Dropping playlist files anywhere on the window imports them (other dropped files are not opened by the page). */
  initDrop() {
    const files = e => [...(e.dataTransfer?.types || [])].includes('Files');
    let hint = null, hideT = 0;
    const hide = () => { clearTimeout(hideT); hint?.classList.remove('on'); };
    // first (capture): a file dragged over a queue or playlist row is not one of their own row drags
    addEventListener('dragover', e => {
      if (!files(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      if (!hint) { hint = h('div', { class: 'pl-drop' }, h('div', null, T('放開以匯入播放清單'), h('small', null, 'm3u · m3u8 · pls · xspf · fpl'))); document.body.append(hint); }
      hint.classList.add('on');
      clearTimeout(hideT); hideT = setTimeout(hide, 250);   // no dragleave to count on: gone when the drags stop coming
    }, true);
    addEventListener('drop', e => {
      if (!files(e)) return;
      e.preventDefault(); e.stopPropagation();
      hide();
      this.importFiles([...e.dataTransfer.files]);
    }, true);
  },
};
PlaylistIO.initDrop();
