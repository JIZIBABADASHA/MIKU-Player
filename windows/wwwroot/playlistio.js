'use strict';
/* ═════════════════════════════ 匯入 / 匯出播放清單 ═════════════════════════════
   Import, with the button on the 播放清單 page (the host's own file dialog) or by dropping files anywhere on the window:
     m3u / m3u8 (also #EXTINF, #EXTART, #EXTALB, any code page or UTF-16), pls, xspf, jspf, Windows Media wpl / zpl / asx,
     Winamp b4s, iTunes / Apple Music library or playlist .xml, Apple Music's .txt export, csv / tsv (Exportify,
     TuneMyMusic, Soundiiz, spreadsheets), plain .txt lists ("Artist - Title" or file paths), cue sheets, foobar2000
     .fpl / .fplite, Audacious .audpl, PotPlayer .dpl, MPC-HC .mpcpl, Traktor .nml and rekordbox .xml.
   Each playlist in a file becomes a new playlist of the tracks of this computer's library it names. The host tells
   where the file is, so a relative entry (01 Song.flac, ..\Album\Song.flac) is found as the full path it means.
   An entry is matched by, in order:
     1. the same full path (file:// addresses and %20 escapes decoded; Windows and Mac paths alike);
     2. the same file name: one such track, else the one whose folders match the entry's the furthest back, else the
        one in a folder the playlist's other tracks are in;
     3. the same name with another extension (a .wav list for .flac files) in the same folder;
     4. the title and artist the list wrote down, nearest in length; then the same, leaving out (feat. …), [Remastered]
        and the like, and with any one of the artists in common.
   Entries whose files are on this computer but outside the library's folders: the toast offers to add those folders;
   once they are scanned the playlist is filled in. The rest are counted; their names can be copied.
   Export: the playlist as an .m3u8 (UTF-8) with #EXTINF lines and the full paths; the host asks where to save it. */
const PlaylistIO = {
  EXT: /\.(m3u8?|pls|xspf|jspf|json|wpl|zpl|asx|wax|wvx|b4s|xml|nml|txt|csv|tsv|cue|fpl|fplite|audpl|dpl|mpcpl)$/i,
  ACCEPT: '.m3u,.m3u8,.pls,.xspf,.jspf,.json,.wpl,.zpl,.asx,.wax,.wvx,.b4s,.xml,.nml,.txt,.csv,.tsv,.cue,.fpl,.fplite,.audpl,.dpl,.mpcpl',
  SHOWN: 'm3u · m3u8 · pls · xspf · wpl · asx · iTunes xml · csv · txt · cue · fpl',
  AUDIO: /\.(mp3|mp2|flac|wav|wave|m4a|m4b|mp4|aac|alac|ogg|oga|opus|wma|ape|wv|aif|aiff|aifc|dsf|dff|mpc|tak|tta|caf|mka|webm|ac3|dts|mid|midi|w64|rf64)$/i,

  /** The 匯入播放清單 button: the host's dialog (it knows where the files are); a plain file picker where it has none. */
  async pick() {
    if (Host.real) {
      let got;
      try { got = await Host.call('playlists.open'); } catch (e) { console.warn('[playlist import] playlists.open', e); }
      if (got === null) return;   // cancelled
      if (Array.isArray(got)) {
        this.importItems(got.map(f => ({ name: f.name || String(f.path || '').split(/[\\/]/).pop(), path: f.path || null, size: +f.size || 0, error: f.error,
          bytes: typeof f.data === 'string' ? this.b64(f.data) : null })));
        return;
      }
    }
    const inp = h('input', { type: 'file', accept: this.ACCEPT, multiple: true });
    inp.onchange = () => { if (inp.files && inp.files.length) this.importFiles([...inp.files]); };
    inp.click();
  },

  b64(s) { const bin = atob(s), b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i); return b; },

  /** Files from a drop or the plain picker: where they are, asked of the host (Electron: webUtils; WebView2: the files
   *  sent along with a message). null where it can't tell; such a file's relative entries are matched by name. */
  async importFiles(files) {
    let paths = null;
    try {
      if (window.mikuHost && typeof window.mikuHost.pathOf === 'function') paths = files.map(f => window.mikuHost.pathOf(f) || null);
      else if (typeof Host.callWith === 'function') paths = await Host.callWith('playlists.paths', {}, files);
    } catch (e) { console.warn('[playlist import] paths', e); }
    if (!Array.isArray(paths) || paths.length !== files.length) paths = files.map(() => null);
    this.importItems(files.map((f, i) => ({ name: f.name, path: paths[i] || null, size: f.size, read: () => f.arrayBuffer() })));
  },

  async importItems(items) {
    const lists = items.filter(f => this.EXT.test(f.name || ''));
    if (!lists.length) { toast(T('只能匯入播放清單檔（m3u、m3u8、pls、xspf、wpl、csv、txt…）')); return; }
    const index = this.index(await this.rows());
    let last = null;
    for (const f of lists) {
      if (f.error) { toast(T`「${f.name}」無法讀取：${f.error}`, { error: true }); continue; }
      if (f.size > 50e6) { toast(T`「${f.name}」太大了，不像是播放清單`); continue; }
      let parsed = [];
      try { parsed = this.parse(f.name, f.bytes || new Uint8Array(await f.read())); } catch (e) { console.error('[playlist import]', f.name, e); }
      parsed = (parsed || []).filter(p => p && p.entries && p.entries.length);
      if (!parsed.length) { toast(T`「${f.name}」裡沒有歌曲`); continue; }
      const base = f.path ? this.parts(f.path) : null;
      if (base) { base.segs.pop(); base.orig.pop(); }
      const stem = f.name.replace(this.EXT, '');
      for (const p of parsed) {
        const pl = await this.importOne(p, base, index, parsed.length > 1 ? p.name || stem : p.name || stem);
        if (pl) last = pl;
      }
    }
    if (last) go('#/playlist/' + last.id);
  },

  async rows() {
    const rows = await Host.call('library.files', {}).catch(() => null);
    return Array.isArray(rows) ? rows : [];
  },

  /** One playlist of a file: made from the tracks found; then the files that are there but not in the library. */
  async importOne(p, base, index, name) {
    const r = this.resolve(index, p.entries, base);
    const pl = r.ids.length ? Playlists.create(this.uniqueName(name), r.ids) : null;
    const total = p.entries.length;
    if (r.missing.length) console.info(`[playlist import] ${name}: not in the library`, r.missing.map(m => this.label(m.e)));
    const outside = r.missing.length ? await this.outside(r.missing) : [];
    const msg = pl
      ? (r.missing.length ? T`已匯入「${pl.name}」：${r.ids.length} 首，${r.missing.length} 首在音樂庫裡找不到` : T`已匯入「${pl.name}」：${r.ids.length} 首`)
      : T`「${name}」裡的 ${total} 首歌都不在音樂庫裡`;
    const acts = [];
    if (outside.length) {
      acts.push({ label: T`加入 ${outside.length} 個資料夾到音樂庫`, run: () => this.addFolders(outside, p, base, name, pl) });
    }
    if (r.missing.length) acts.push({ label: T('複製找不到的歌曲'), run: () => this.copy(r.missing.map(m => this.label(m.e)).join('\n')) });
    if (outside.length) this.toastActs(msg + '\n' + T`其中有些歌曲在這台電腦上，但不在音樂庫的資料夾裡：\n${outside.join('\n')}`, acts, 30000);
    else this.toastActs(msg, acts, acts.length ? 9000 : 3200);
    return pl;
  },

  label(e) { return e.path || [e.artist, e.title].filter(Boolean).join(' - ') || '?'; },

  /** A toast with buttons (a click on one does it; elsewhere closes the toast). */
  toastActs(msg, acts, ms) {
    if (!acts.length) { toast(msg, { ms }); return; }
    const box = h('div', { class: 'pl-toast' }, h('div', null, msg),
      h('div', { class: 'pl-toast-b' }, ...acts.map(a => h('button', { class: 'btn small' + (a === acts[0] ? ' primary' : ' ghost'), onclick: () => a.run() }, a.label))));
    toast(box, { ms });
  },

  async copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand('copy'); } catch { } ta.remove();
    }
    toast(T('已複製'));
  },

  /** The folders of the missing entries' files that are on this computer, outside the library's folders. */
  async outside(missing) {
    const paths = [...new Set(missing.flatMap(m => m.cands.filter(c => c.abs).map(c => c.os)))].slice(0, 20000);
    if (!paths.length) return [];
    const got = await Host.call('playlists.check', { paths }).catch(() => null);
    if (!Array.isArray(got)) return [];
    const dirs = new Map();   // key → the folder as written
    paths.forEach((p, i) => {
      if (got[i] !== 2) return;
      const d = p.replace(/[\\/][^\\/]*$/, '');
      if (d) dirs.set(this.key(d), d);
    });
    let list = [...dirs.values()];
    if (list.length > 3) {
      // many album folders: the folder they are all in, unless that is a whole drive or someone's home
      const split = d => d.split(/[\\/]+/).filter(Boolean);
      let common = split(list[0]);
      for (const d of list.slice(1)) { const s = split(d); let n = 0; while (n < common.length && n < s.length && this.key(common[n]) === this.key(s[n])) n++; common = common.slice(0, n); }
      const low = common.map(this.key), win = /^[a-z]:$/.test(low[0] || '');
      const tooWide = win ? common.length < 2 || (low[1] === 'users' && common.length < 4)
        : common.length < 2 || ((low[0] === 'users' || low[0] === 'home') && common.length < 3) || (low[0] === 'volumes' && common.length < 2);
      if (!tooWide) {
        const sep = list[0].includes('\\') ? '\\' : '/';
        list = [(win || list[0].startsWith('\\\\') ? (list[0].startsWith('\\\\') ? '\\\\' : '') : '/') + common.join(sep)];
      } else list = list.slice(0, 20);
    }
    return list;
  },

  /** 加入資料夾到音樂庫: add them, wait for the scan, and fill the playlist in with what it found. */
  async addFolders(folders, p, base, name, pl) {
    try { await Host.call('folder.addPaths', { paths: folders }); } catch (e) { toast(T('無法加入資料夾'), { error: true }); return; }
    toast(T('正在掃描新加入的資料夾，完成後會把歌曲加進播放清單…'), { ms: 5000 });
    await this.waitScan();
    const r = this.resolve(this.index(await this.rows()), p.entries, base);
    if (!r.ids.length) { toast(T`「${name}」裡的歌曲還是找不到`); return; }
    let target = pl && Playlists.get(pl.id);
    if (target) {
      const have = new Set(r.ids);
      target.tracks = r.ids.concat(target.tracks.filter(id => !have.has(id)));   // the list's order; ones added by hand stay
      target.updated = Date.now(); Playlists.save();
    } else target = Playlists.create(this.uniqueName(name), r.ids);
    toast(r.missing.length ? T`已匯入「${target.name}」：${r.ids.length} 首，${r.missing.length} 首在音樂庫裡找不到` : T`已匯入「${target.name}」：${r.ids.length} 首`);
    go('#/playlist/' + target.id);
  },

  waitScan() {
    return new Promise(done => {
      let seen = false, finished = false;
      const end = () => { if (finished) return; finished = true; off(); clearTimeout(t1); clearTimeout(t2); setTimeout(done, 700); };
      const off = Host.on('scan', s => { if (s && s.scanning) seen = true; else if (seen) end(); });
      const t1 = setTimeout(() => { if (!seen) end(); }, 6000);   // nothing new to scan
      const t2 = setTimeout(end, 30 * 60e3);
    });
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

  /** [{ name, entries: [{ path, title, artist, album, dur }] }]: most files hold one playlist, iTunes / Traktor /
   *  rekordbox libraries several. */
  parse(fileName, bytes) {
    const ext = (/\.([^.]+)$/.exec(fileName) || [])[1]?.toLowerCase() || '';
    if (ext === 'fpl') return [this.parseFpl(bytes)];
    const text = this.decode(bytes, ['m3u8', 'xspf', 'jspf', 'json', 'fplite', 'audpl', 'nml'].includes(ext)).replace(/^\uFEFF/, '');
    const head = text.slice(0, 4000).trimStart();
    if (/^\[playlist\]/i.test(head) || ext === 'pls') return [this.parsePls(text)];
    if (head[0] === '{' || head[0] === '[') { const j = this.parseJson(text); if (j) return j; }
    if (head[0] === '<') return this.parseXml(text, ext);
    if (/^MPCPLAYLIST/i.test(head) || ext === 'mpcpl') return [this.parseMpc(text)];
    if (/^DAUMPLAYLIST/i.test(head) || ext === 'dpl') return [this.parseDpl(text)];
    if (ext === 'cue' || (/^\s*FILE\s+/mi.test(head) && /^\s*TRACK\s+\d+/mi.test(head))) return [this.parseCue(text)];
    if (ext === 'audpl' || /^uri=/m.test(head)) return [this.parseAudpl(text)];
    if (/^#EXTM3U/i.test(head) || ext === 'm3u' || ext === 'm3u8') return [this.parseM3u(text)];
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') { const t = this.parseTable(text); if (t) return [t]; return [this.parseLines(text)]; }
    return [this.parseM3u(text)];
  },

  /** Text in UTF-8 or UTF-16 (with or without its BOM); an older file in a legacy code page: the one that reads best. */
  decode(b, utf8) {
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
    // UTF-16 without a BOM: every other byte of plain text is a zero
    if (b.length >= 4) {
      let odd = 0, even = 0;
      const n = Math.min(b.length, 2000);
      for (let i = 0; i < n; i++) if (!b[i]) i % 2 ? odd++ : even++;
      if (odd > n / 4 && even < n / 50) return new TextDecoder('utf-16le').decode(b);
      if (even > n / 4 && odd < n / 50) return new TextDecoder('utf-16be').decode(b);
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { }
    if (utf8) return new TextDecoder('utf-8').decode(b);
    // the share of characters that make sense: ASCII, CJK, kana, hangul, Latin letters with accents
    const score = s => {
      let good = 0, bad = 0;
      for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c < 0x80 || (c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3040 && c <= 0x30FF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xC0 && c <= 0x17F) || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF01 && c <= 0xFF5E)) good++;
        else if (c === 0xFFFD || (c >= 0xE000 && c <= 0xF8FF) || (c >= 0x80 && c < 0xA0)) bad += 4;
        else bad++;
      }
      return good - bad;
    };
    let best = null, top = -Infinity;
    for (const enc of ['big5', 'shift_jis', 'gbk', 'euc-kr', 'windows-1252']) {
      try { const s = new TextDecoder(enc).decode(b), v = score(s); if (v > top) { best = s; top = v; } } catch { }
    }
    return best ?? new TextDecoder('utf-8').decode(b);
  },

  /** "Artist - Title" (#EXTINF, PLS Title=, a line of a text list) */
  splitTitle(s) {
    s = String(s || '').trim();
    const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(s);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: s };
  },

  /** A line of a list: a file (a path, or a name with an audio extension), else "Artist - Title". */
  lineEntry(s) {
    s = s.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^file:/i.test(s) || /[\\/]/.test(s) || this.AUDIO.test(s)) return { path: s };
    s = s.replace(/^\d{1,4}\s*[.)、:]\s*/, '');
    return s ? this.splitTitle(s) : null;
  },

  parseM3u(text) {
    const entries = [];
    let name = '', hint = null, album = '', artist = '';
    for (let line of text.split(/\r\n|\r|\n/)) {
      line = line.trim();
      if (!line) continue;
      if (line[0] === '#') {
        let m;
        if ((m = /^#EXTINF:\s*(-?[\d.]+)?([^,]*),(.*)$/i.exec(line))) {
          const attrs = m[2] || '', at = k => (new RegExp(`\\b${k}="([^"]*)"`, 'i').exec(attrs) || [])[1];
          hint = { dur: +m[1] > 0 ? +m[1] : 0, ...this.splitTitle(m[3]) };
          if (at('artist')) hint.artist = at('artist');
          if (at('title')) hint.title = at('title');
        }
        else if ((m = /^#PLAYLIST:(.*)$/i.exec(line))) name = m[1].trim();
        else if ((m = /^#EXTALB:(.*)$/i.exec(line))) album = m[1].trim();
        else if ((m = /^#EXTART:(.*)$/i.exec(line))) artist = m[1].trim();
        continue;
      }
      const e = { ...(this.lineEntry(line) || { path: line }) };
      if (hint) { Object.assign(e, hint); if (!e.path && this.lineEntry(line)?.path) e.path = line; }
      if (album && !e.album) e.album = album;
      if (artist && !e.artist) e.artist = artist;
      entries.push(e);
      hint = null; artist = '';
    }
    return { name, entries };
  },

  parseLines(text) {
    const entries = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (!line.trim() || /^\s*(#|\/\/|;)/.test(line)) continue;
      const e = this.lineEntry(line);
      if (e) entries.push(e);
    }
    return { name: '', entries };
  },

  parsePls(text) {
    const f = {}, t = {}, len = {};
    let name = '';
    for (const line of text.split(/\r\n|\r|\n/)) {
      const m = /^\s*(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line);
      if (!m) { const n = /^\s*(?:PlaylistName|X-GNOME-Title)\s*=\s*(.*)$/i.exec(line); if (n) name = n[1].trim(); continue; }
      ({ file: f, title: t, length: len })[m[1].toLowerCase()][+m[2]] = m[3].trim();
    }
    const entries = Object.keys({ ...f, ...t }).map(Number).sort((a, b) => a - b)
      .map(n => ({ path: f[n] || '', ...(t[n] ? this.splitTitle(t[n]) : {}), dur: +len[n] > 0 ? +len[n] : 0 }))
      .filter(e => e.path || e.title);
    return { name, entries };
  },

  /** A table with a header row: comma, semicolon or tab separated; the columns found by their names. null: not one. */
  parseTable(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const first = lines.find(l => l.trim()) || '';
    const count = c => first.split(c).length - 1;
    const sep = count('\t') ? '\t' : count(',') >= count(';') ? (count(',') ? ',' : null) : ';';
    if (!sep) return null;
    const rows = this.csv(text, sep).filter(r => r.some(c => c.trim()));
    if (rows.length < 2) return null;
    const head = rows[0].map(c => c.trim().toLowerCase().replace(/^\uFEFF/, ''));
    const col = names => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
    const ti = col(['name', 'title', 'track name', 'track', 'song', 'song name', 'track title', 'song title', '曲名', '歌名', '標題', '标题', '名稱', '名称', '歌曲', '歌曲名稱', '歌曲名称', 'タイトル', '名前']);
    const ai = col(['artist', 'artists', 'artist name', 'artist name(s)', 'artist(s)', 'artist names', 'performer', 'creator', 'album artist', '演出者', '歌手', '藝人', '艺人', '藝術家', '艺术家', '表演者', 'アーティスト']);
    const bi = col(['album', 'album name', 'album title', 'release', '專輯', '专辑', 'アルバム']);
    const di = col(['time', 'duration', 'duration (ms)', 'duration_ms', 'track duration (ms)', 'length', 'duration (s)', '時間', '时间', '時長', '时长', '長度', '长度', '再生時間']);
    const pi = col(['location', 'path', 'file', 'filename', 'file name', 'file path', 'filepath', 'url', 'uri', '位置', '路徑', '路径', '檔案', '文件', '場所']);
    if (ti < 0 && pi < 0) return null;
    const ms = di >= 0 && /ms/.test(head[di]);
    const dur = v => {
      v = String(v || '').trim();
      if (/^\d+(:\d{1,2}){1,2}$/.test(v)) return v.split(':').reduce((a, x) => a * 60 + +x, 0);
      const n = parseFloat(v);
      return !(n > 0) ? 0 : ms || n > 36000 ? n / 1000 : n;
    };
    const entries = rows.slice(1).map(r => {
      const g = i => i >= 0 ? String(r[i] || '').trim() : '';
      const e = { path: /^spotify:|^https?:/i.test(g(pi)) ? '' : g(pi), title: g(ti), artist: g(ai), album: g(bi), dur: di >= 0 ? dur(r[di]) : 0 };
      if (!e.artist && e.title && !e.path) Object.assign(e, this.splitTitle(e.title));
      return e;
    }).filter(e => e.path || e.title);
    return { name: '', entries };
  },

  csv(text, sep) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"' && cell === '') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  },

  parseCue(text) {
    const unq = s => s.trim().replace(/^"(.*)"$/, '$1');
    let album = '', albumArtist = '', file = '', cur = null, files = 0;
    const tracks = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      let m;
      if ((m = /^\s*FILE\s+(".*?"|\S+)/i.exec(line))) { file = unq(m[1]); files++; }
      else if ((m = /^\s*TRACK\s+\d+/i.exec(line))) { cur = { file, album }; tracks.push(cur); }
      else if ((m = /^\s*TITLE\s+(.*)$/i.exec(line))) { if (cur) cur.title = unq(m[1]); else album = unq(m[1]); }
      else if ((m = /^\s*PERFORMER\s+(.*)$/i.exec(line))) { if (cur) cur.artist = unq(m[1]); else albumArtist = unq(m[1]); }
    }
    const perTrack = files >= tracks.length;   // one file per track: those files; one file for all: the titles
    const entries = tracks.map(t => ({ path: perTrack ? t.file : '', title: t.title || '', artist: t.artist || albumArtist, album: t.album || album }))
      .filter(e => e.path || e.title);
    return { name: [albumArtist, album].filter(Boolean).join(' - '), entries };
  },

  parseAudpl(text) {
    const entries = [];
    let name = '', cur = null;
    const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
    for (const line of text.split(/\r\n|\r|\n/)) {
      const m = /^(\w+)=(.*)$/.exec(line);
      if (!m) continue;
      const k = m[1].toLowerCase(), v = m[2];
      if (k === 'uri') { cur = { path: v }; entries.push(cur); }
      else if (!cur) { if (k === 'title') name = dec(v); }
      else if (k === 'title') cur.title = dec(v);
      else if (k === 'artist') cur.artist = dec(v);
      else if (k === 'album') cur.album = dec(v);
      else if (k === 'length') cur.dur = (+v || 0) / 1000;
    }
    return { name, entries };
  },

  /** PotPlayer: "1*file*C:\…", "1*title*…", "1*duration2*ms". */
  parseDpl(text) {
    const by = new Map();
    for (const line of text.split(/\r\n|\r|\n/)) {
      const m = /^(\d+)\*(\w+)\*(.*)$/.exec(line);
      if (!m) continue;
      const e = by.get(+m[1]) || {}; by.set(+m[1], e);
      const k = m[2].toLowerCase();
      if (k === 'file') e.path = m[3].trim();
      else if (k === 'title') Object.assign(e, this.splitTitle(m[3]));
      else if (k === 'duration2') e.dur = (+m[3] || 0) / 1000;
    }
    return { name: '', entries: [...by.keys()].sort((a, b) => a - b).map(k => by.get(k)).filter(e => e.path || e.title) };
  },

  /** MPC-HC / MPC-BE: "1,filename,C:\…". */
  parseMpc(text) {
    const by = new Map();
    for (const line of text.split(/\r\n|\r|\n/)) {
      const m = /^(\d+),filename,(.*)$/i.exec(line);
      if (m) by.set(+m[1], { path: m[2].trim() });
    }
    return { name: '', entries: [...by.keys()].sort((a, b) => a - b).map(k => by.get(k)) };
  },

  /** JSPF (XSPF as JSON). */
  parseJson(text) {
    let j;
    try { j = JSON.parse(text); } catch { return null; }
    const pl = j && (j.playlist || j);
    const tracks = Array.isArray(pl) ? pl : pl && (pl.track || pl.tracks || pl.items);
    if (!Array.isArray(tracks)) return null;
    const one = v => Array.isArray(v) ? v[0] : v;
    const entries = tracks.map(t => ({
      path: String(one(t.location) || t.path || t.file || t.uri || ''), title: String(t.title || t.name || ''),
      artist: String(Array.isArray(t.artists) ? t.artists.map(a => a.name || a).join(', ') : t.creator || t.artist || ''),
      album: String(t.album?.name || t.album || ''), dur: (+t.duration || +t.duration_ms || 0) / 1000,
    })).map(e => (/^spotify:|^https?:/i.test(e.path) ? { ...e, path: '' } : e)).filter(e => e.path || e.title);
    return [{ name: String(pl.title || pl.name || ''), entries }];
  },

  /** XML playlists: told apart by their root element. */
  parseXml(text, ext) {
    let doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      // hand-written ASX / WPL often aren't well-formed XML (a bare &, tags in any case): read them leniently
      doc = new DOMParser().parseFromString(text.replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;'), 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
    }
    const lc = el => (el.localName || '').toLowerCase();
    const all = (root, name) => [...root.getElementsByTagName('*')].filter(el => lc(el) === name);
    const kid = (el, name) => { for (const c of el.children) if (lc(c) === name) return c; return null; };
    const txt = (el, name) => (kid(el, name)?.textContent || '').trim();
    const attr = (el, name) => { for (const a of el.attributes || []) if (a.name.toLowerCase() === name) return a.value; return ''; };
    const names = ['plist', 'playlist', 'smil', 'asx', 'winampxml', 'nml', 'dj_playlists'];
    let root = doc.documentElement;
    if (!names.includes(lc(root))) root = names.map(n => all(doc, n)[0]).find(Boolean) || root;
    const kind = lc(root);

    if (kind === 'plist') return this.parseItunes(root);

    if (kind === 'playlist' && (kid(root, 'tracklist') || all(root, 'track').length)) {   // XSPF
      const entries = all(root, 'track').map(tr => ({
        path: txt(tr, 'location'), title: txt(tr, 'title'), artist: txt(tr, 'creator'), album: txt(tr, 'album'), dur: (+txt(tr, 'duration') || 0) / 1000,
      })).filter(e => e.path || e.title);
      return [{ name: txt(root, 'title'), entries }];
    }

    if (kind === 'smil') {   // Windows Media Player .wpl / Zune .zpl
      const head = kid(root, 'head');
      const entries = all(root, 'media').map(m => ({
        path: attr(m, 'src'), title: attr(m, 'tracktitle'), artist: attr(m, 'trackartist'), album: attr(m, 'albumtitle'), dur: (+attr(m, 'duration') || 0) / 1000,
      })).filter(e => e.path || e.title);
      return [{ name: head ? txt(head, 'title') : '', entries }];
    }

    if (kind === 'asx') {   // .asx / .wax / .wvx
      const entries = [];
      for (const en of all(root, 'entry')) {
        const ref = kid(en, 'ref');
        const e = { path: ref ? attr(ref, 'href') : '', title: txt(en, 'title'), artist: txt(en, 'author') };
        if (e.path || e.title) entries.push(e);
      }
      for (const r of [...root.children].filter(c => lc(c) === 'ref')) entries.push({ path: attr(r, 'href') });
      return [{ name: txt(root, 'title'), entries }];
    }

    if (kind === 'winampxml' || all(root, 'entry').some(e => attr(e, 'playstring'))) {   // Winamp .b4s
      const pl = all(root, 'playlist')[0];
      const entries = all(root, 'entry').map(en => ({ path: attr(en, 'playstring'), ...this.splitTitle(txt(en, 'name')), dur: (+txt(en, 'length') || 0) / 1000 }))
        .filter(e => e.path || e.title);
      return [{ name: pl ? attr(pl, 'label') : '', entries }];
    }

    if (kind === 'nml') {   // Traktor: the collection's tracks; each playlist lists them by "Volume/:dir/:file"
      const info = new Map();
      for (const en of all(root, 'entry')) {
        const loc = kid(en, 'location');
        if (!loc) continue;
        info.set((attr(loc, 'volume') + attr(loc, 'dir') + attr(loc, 'file')).toLowerCase(), { title: attr(en, 'title'), artist: attr(en, 'artist'), album: kid(en, 'album') ? attr(kid(en, 'album'), 'title') : '' });
      }
      const path = key => {
        const s = key.split('/:').filter(Boolean);
        if (!s.length) return '';
        if (/^[A-Za-z]:$/.test(s[0])) return s.join('\\');
        return '/' + s.slice(1).join('/');   // macOS: the volume's name, then the folders
      };
      const out = [];
      for (const node of all(root, 'node')) {
        if (attr(node, 'type').toLowerCase() !== 'playlist') continue;
        const name = attr(node, 'name');
        if (/^_(loops|recordings|restore)/i.test(name)) continue;
        const entries = all(node, 'primarykey').map(k => { const key = attr(k, 'key'); return { path: path(key), ...(info.get(key.toLowerCase()) || {}) }; }).filter(e => e.path);
        if (entries.length) out.push({ name, entries });
      }
      return out;
    }

    if (kind === 'dj_playlists') {   // rekordbox
      const coll = all(root, 'collection')[0], byId = new Map(), byLoc = new Map();
      for (const t of coll ? [...coll.children].filter(c => lc(c) === 'track') : []) {
        const e = { path: attr(t, 'location'), title: attr(t, 'name'), artist: attr(t, 'artist'), album: attr(t, 'album'), dur: +attr(t, 'totaltime') || 0 };
        byId.set(attr(t, 'trackid'), e); byLoc.set(e.path, e);
      }
      const out = [];
      for (const node of all(root, 'node')) {
        if (attr(node, 'type') !== '1') continue;
        const entries = [...node.children].filter(c => lc(c) === 'track').map(t => byId.get(attr(t, 'key')) || byLoc.get(attr(t, 'key')) || (attr(t, 'key').includes('/') ? { path: attr(t, 'key') } : null)).filter(Boolean);
        if (entries.length) out.push({ name: attr(node, 'name'), entries });
      }
      return out;
    }

    // anything else: whatever its elements say a file is
    const entries = [];
    for (const el of root.getElementsByTagName('*')) {
      const p = attr(el, 'src') || attr(el, 'href') || attr(el, 'location') || (['location', 'path', 'file'].includes(lc(el)) && !el.children.length ? el.textContent.trim() : '');
      if (p && (this.AUDIO.test(p.replace(/[?#].*$/, '')) || /^file:/i.test(p))) entries.push({ path: p });
    }
    return [{ name: '', entries }];
  },

  /** iTunes / Apple Music: "Export Playlist…" or the whole library (Library.xml): its playlists, made of its tracks. */
  parseItunes(root) {
    const val = el => {
      if (!el) return null;
      switch (el.localName) {
        case 'dict': { const o = {}; const c = [...el.children]; for (let i = 0; i + 1 < c.length; i += 2) o[c[i].textContent] = val(c[i + 1]); return o; }
        case 'array': return [...el.children].map(val);
        case 'integer': case 'real': return +el.textContent;
        case 'true': return true;
        case 'false': return false;
        case 'data': return null;
        default: return el.textContent;
      }
    };
    const top = val(root.firstElementChild) || {};
    const tracks = top.Tracks || {};
    const track = id => {
      const t = tracks[id] || tracks[String(id)];
      return t && { path: t.Location || '', title: t.Name || '', artist: t.Artist || t['Album Artist'] || '', album: t.Album || '', dur: (+t['Total Time'] || 0) / 1000 };
    };
    const lists = (top.Playlists || []).filter(p => p && !p.Master && !p['Distinguished Kind'] && !p.Folder && Array.isArray(p['Playlist Items']));
    if (!lists.length) return [{ name: 'iTunes', entries: Object.keys(tracks).map(track).filter(Boolean) }];
    return lists.map(p => ({ name: p.Name || '', entries: p['Playlist Items'].map(i => track(i['Track ID'])).filter(e => e && (e.path || e.title)) }));
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

  /** A title without what one copy has and another hasn't: (feat. …), [Remastered 2011], " - Live", "- Radio Edit". */
  loose(s) {
    const t = String(s || '').normalize('NFKC').toLowerCase()
      .replace(/\s*[([【〔<][^)\]】〕>]*[)\]】〕>]/g, ' ')
      .replace(/\s+[-–—/]\s+.*\b(remaster(ed)?|version|ver|edit|mix|live|mono|stereo|bonus|demo|acoustic|instrumental|karaoke|off vocal|explicit|single|radio|deluxe)\b.*$/i, '')
      .replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, '');
    return this.text(t) || this.text(s);
  },

  /** The artists of "A, B & C feat. D" (each compared as in text()). */
  artists(s) {
    return new Set(String(s || '').normalize('NFKC').split(/\s*(?:[,;/、＆&×・]|\s(?:x|vs\.?|feat\.?|ft\.?|featuring|with|and|と)\s)\s*/i).map(this.text).filter(Boolean));
  },

  /** A path or a file:// address: its parts (lower case, and as written), whether it is a full path, and the path
   *  for the host. A relative path is taken from `base` (the playlist's folder) when that is known. null: not a file. */
  parts(raw, base) {
    let p = String(raw || '').trim().replace(/^"(.*)"$/, '$1');
    if (/^file:/i.test(p)) {
      let rest = p.slice(5);
      const url = rest.startsWith('///') || (rest.startsWith('//') && !rest.includes('\\') && /%[0-9a-f]{2}/i.test(rest)) || (!rest.includes('\\') && /%[0-9a-f]{2}/i.test(rest));
      rest = rest.replace(/^\/\/(localhost(?=\/))?/i, '');
      if (url) { try { rest = decodeURIComponent(rest); } catch { } }
      if (/^\/[A-Za-z]:/.test(rest)) rest = rest.slice(1);
      p = rest;
    } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) return null;   // http://, cdda://…
    else if (/^[^\\/:]+(:[^\\/:]+){2,}$/.test(p) && !/^[A-Za-z]:/.test(p)) p = p.split(':').slice(1).join('/');   // old Mac "Volume:Folder:File"
    if (!p) return null;
    const unc = /^(\\\\|\/\/)[^\\/]/.test(p), drive = /^[A-Za-z]:[\\/]/.test(p);
    let abs = drive || unc || /^[\\/]/.test(p);
    let orig = p.split(/[\\/]+/).filter(s => s && s !== '.');
    if (!abs && base) { orig = base.orig.concat(orig); abs = base.abs; }
    const out = [];
    for (const s of orig) if (s === '..') out.pop(); else out.push(s);
    if (!out.length) return null;
    const segs = out.map(this.key);
    const lead = base && !drive && !unc && !/^[\\/]/.test(p) ? base.lead : unc ? '\\\\' : drive ? '' : abs ? '/' : '';
    const win = lead === '\\\\' || /^[A-Za-z]:$/.test(out[0]);
    return {
      abs, segs, orig: out, lead,
      full: abs ? (lead === '/' ? '/' : lead === '\\\\' ? '//' : '') + segs.join('/') : null,
      os: abs ? lead + out.join(win ? '\\' : '/') : null,
    };
  },

  /** The ways an entry's path can be read: as written, and with %xx escapes undone (a relative path from a URL list). */
  cands(path, base) {
    if (!path) return [];
    const list = [], one = this.parts(path, base);
    if (one) list.push(one);
    if (!/^file:/i.test(path) && /%[0-9a-f]{2}/i.test(path)) {
      let d = null;
      try { d = decodeURIComponent(path); } catch { }
      const two = d && d !== path ? this.parts(d, base) : null;
      if (two) list.push(two);
    }
    return list;
  },

  index(rows) {
    const full = new Map(), byName = new Map(), byStem = new Map(), byTitle = new Map(), byTitleOnly = new Map(), byLoose = new Map(), dirOf = new Map();
    const push = (m, k, v) => { if (!k) return; const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const [id, path, title, artist, dur, album] of rows) {
      const p = this.parts(path);
      if (!p) continue;
      const t = { id, segs: p.segs, dir: p.segs.slice(0, -1).join('/'), dur: +dur || 0, artists: this.artists(artist), album: this.text(album) };
      dirOf.set(id, t.dir);
      if (p.full) full.set(p.full, id);
      const name = p.segs[p.segs.length - 1];
      push(byName, name, t); push(byStem, this.stem(name), t);
      const nt = this.text(title);
      if (nt) { push(byTitle, this.text(artist) + '\u0001' + nt, t); push(byTitleOnly, nt, t); push(byLoose, this.loose(title), t); }
    }
    return { full, byName, byStem, byTitle, byTitleOnly, byLoose, dirOf };
  },

  /** The library's track for each entry: a first pass, then one where the folders the list's tracks were found in
   *  settle the ties (two "01 Track 01.flac" files: the one in the album the rest of the list comes from). */
  resolve(ix, entries, base) {
    const items = entries.map(e => ({ e, cands: this.cands(e.path, base) }));
    const ctx = { dirs: new Map(), ix };
    const found = items.map(o => this.match(ix, o, null));
    found.forEach(id => { if (id) { const d = ix.dirOf.get(id); ctx.dirs.set(d, (ctx.dirs.get(d) || 0) + 1); } });
    items.forEach((o, i) => { if (!found[i]) found[i] = this.match(ix, o, ctx); });
    const ids = [], seen = new Set(), missing = [];
    items.forEach((o, i) => {
      const id = found[i];
      if (!id) missing.push(o);
      else if (!seen.has(id)) { seen.add(id); ids.push(id); }
    });
    return { ids, missing };
  },

  match(ix, o, ctx) {
    const e = o.e;
    for (const p of o.cands) if (p.full && ix.full.has(p.full)) return ix.full.get(p.full);
    for (const p of o.cands) {
      const name = p.segs[p.segs.length - 1];
      const id = this.byFolders(ix.byName.get(name), p.segs, e.dur, false, ctx) || this.byFolders(ix.byStem.get(this.stem(name)), p.segs, e.dur, true, ctx);
      if (id) return id;
    }
    let title = e.title, artist = e.artist;
    if (!title && o.cands.length) {
      // only a file name: "Artist - Title.mp3" or "01 Title.flac" may still name the song
      const st = this.stem(o.cands[0].orig[o.cands[0].orig.length - 1]).replace(/^\d{1,3}[\s.\-_]+/, '');
      ({ title, artist } = this.splitTitle(st));
    }
    if (!title) return null;
    return this.byTitle(ix, title, artist, e.album, e.dur, ctx);
  },

  byTitle(ix, title, artist, album, dur, ctx) {
    const nt = this.text(title);
    let id = null;
    if (artist) {
      id = this.byLength(ix.byTitle.get(this.text(artist) + '\u0001' + nt), dur, false)
        // "A - B" was the whole title, or the artist is written another way: the title alone, only when it is clear
        || this.byLength(ix.byTitleOnly.get(this.text(artist + ' - ' + title)), dur, true)
        || this.byLength(ix.byTitleOnly.get(nt), dur, true);
    } else id = this.byLength(ix.byTitleOnly.get(nt), dur, true);
    if (id) return id;
    // looser: the title without (feat. …) / [Remastered] / "- Live"…, and any one artist in common
    let list = ix.byLoose.get(this.loose(title));
    if (!list && !artist) { const s = this.splitTitle(title); if (s.artist) return this.byTitle(ix, s.title, s.artist, album, dur, ctx); }
    if (!list) return null;
    if (artist) {
      const want = this.artists(artist);
      const hit = list.filter(t => [...t.artists].some(a => want.has(a)));
      // the artist written another way (another script, a translation): only one song by that title, as long
      if (!hit.length) return dur > 0 && list.length === 1 && list[0].dur > 0 && Math.abs(list[0].dur - dur) < 3.5 ? list[0].id : null;
      list = hit;
    }
    if (album && list.length > 1) { const na = this.text(album), a = list.filter(t => t.album === na); if (a.length) list = a; }
    return this.byLength(list, dur, true) || this.byDirs(list, ctx);
  },

  /** Of the tracks with the entry's file name: the one whose folders match the entry's the furthest back. A name met
   *  with another extension (stemOnly) needs at least its folder to match. */
  byFolders(list, segs, dur, stemOnly, ctx) {
    if (!list || !list.length) return null;
    const depth = t => {
      let n = 0;
      for (let a = segs.length - 2, b = t.segs.length - 2; a >= 0 && b >= 0 && segs[a] === t.segs[b]; a--, b--) n++;
      return n;
    };
    let top = -1, best = [];
    for (const t of list) { const d = depth(t); if (d > top) { top = d; best = [t]; } else if (d === top) best.push(t); }
    if (stemOnly && top < 1) return null;
    if (best.length === 1) return top > 0 || list.length === 1 ? best[0].id : this.byLength(best, dur, true) || this.byDirs(best, ctx);
    return this.byLength(best, dur, top < 1) || this.byDirs(best, ctx);
  },

  /** Of tracks that fit equally well: the one in the folder most of the list's other tracks are in. */
  byDirs(list, ctx) {
    if (!ctx || !list || !list.length) return null;
    let top = 0, best = [];
    for (const t of list) { const n = ctx.dirs.get(t.dir) || 0; if (n > top) { top = n; best = [t]; } else if (n === top && n) best.push(t); }
    return best.length === 1 ? best[0].id : null;
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
      if (!hint) { hint = h('div', { class: 'pl-drop' }, h('div', null, T('放開以匯入播放清單'), h('small', null, this.SHOWN))); document.body.append(hint); }
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
if (typeof window !== 'undefined' && typeof addEventListener === 'function' && typeof document !== 'undefined') PlaylistIO.initDrop();
