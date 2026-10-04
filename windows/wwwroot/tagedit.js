'use strict';
/* ═════════════════════════════ tag editor ═════════════════════════════
   Album page → 更多 → 編輯標籤…: the album's fields and every track's, edited in one table, filled from MusicBrainz /
   Apple Music if wanted, with a new cover; 儲存 writes the changed fields (and the cover) into the files
   (MainForm.SaveTags → TagWriter) and reads the album again. Nothing is written before 儲存. */
const TagEditor = {
  el: null,
  /** Album fields: one value for every track (a mixed one shows as a hint until it is typed over). */
  ALBUM: [['album', '專輯名稱'], ['albumArtist', '專輯演出者'], ['year', '年份'], ['genre', '類型']],
  /** Columns of the track table. */
  COLS: [['disc', '碟', 'num'], ['track', '曲號', 'num'], ['title', '標題'], ['artist', '演出者'], ['composer', '作曲']],
  NUMERIC: new Set(['year', 'track', 'disc']),

  async open(al) {
    if (this.el) return;
    let data;
    try { data = await Host.call('tags.load', { id: al.id }); }
    catch (e) { toast('無法讀取標籤：' + e.message, { error: true }); return; }
    if (!data || !data.tracks || !data.tracks.length) { toast('這張專輯沒有曲目'); return; }
    const str = v => v == null ? '' : String(v);
    const rows = data.tracks.map(t => {
      const orig = {};
      for (const k of ['title', 'artist', 'albumArtist', 'album', 'genre', 'composer']) orig[k] = str(t[k]);
      for (const k of ['year', 'track', 'disc']) orig[k] = t[k] ? String(t[k]) : '';
      return { id: t.id, file: t.file, path: t.path, dur: t.dur, codec: t.codec, writable: t.writable, orig, cur: { ...orig } };
    });
    this.s = { al, data, rows, sel: new Set(), cover: null, view: 'edit', search: null, release: null, saving: false };
    this.build();
  },

  /* ───────── shell ───────── */
  build() {
    const s = this.s;
    const scrim = h('div', { class: 'modal-scrim te-scrim' });
    const modal = h('div', { class: 'modal te' });
    scrim.append(modal);
    scrim.addEventListener('keydown', e => this.key(e));
    // keys while nothing in the editor has the focus (after a click on a row's handle) reach the document instead
    this.onDocKey = this.onDocKey || (e => {
      if (!this.el || ArtPicker.el || this.el.contains(e.target) || (Popover.el && Popover.el.contains(e.target))) return;
      if (Popover.el && e.key === 'Escape') { e.stopPropagation(); Popover.close(); return; }
      this.key(e);
    });
    document.addEventListener('keydown', this.onDocKey, true);
    this.head = h('h2');
    this.headSub = h('span', { class: 'te-sub' });
    modal.append(h('div', { class: 'modal-head' },
      h('div', { class: 'te-title' }, this.head, this.headSub),
      h('button', { class: 'icon-btn', title: '關閉 (Esc)', html: icon('x'), onclick: () => this.tryClose() })));
    this.body = h('div', { class: 'te-body' });
    this.foot = h('div', { class: 'te-foot' });
    modal.append(this.body, this.foot);
    document.body.append(scrim);
    this.el = scrim;
    OverlayHistory.push(this._close = fromPop => this.close(fromPop));
    YT.sync();
    this.offProgress = this.offProgress || (Host.on('tagsProgress', p => this.progress(p)), Host.on('fpProgress', p => this.identProgress(p)), true);
    this.render();
  },

  key(e) {
    if (e.key === 'F12' || e.key === 'F11') return;
    e.stopPropagation();   // typing here must not play / pause or jump around the app
    const typing = /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'checkbox';
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!typing && this.s.view === 'edit' && this.s.sel.size) { this.select(new Set()); return; }   // first drop the selection
      this.tryClose();
    }
    else if (e.key === 's' && e.ctrlKey) { e.preventDefault(); this.save(); }
    else if (e.key === 'a' && e.ctrlKey && !typing && this.s.view === 'edit') { e.preventDefault(); this.select(new Set(this.s.rows.map((_, i) => i))); }
  },

  render() {
    if (!this.el) return;
    const s = this.s;
    this.body.textContent = ''; this.foot.textContent = '';
    if (s.view === 'edit') this.renderEdit();
    else if (s.view === 'search') this.renderSearch();
    else if (s.view === 'rename') this.renderRename();
    else if (s.view === 'identify') this.renderIdentify();
    else this.renderRelease();
  },

  dirty() { return this.s && (this.s.cover || this.changes().length > 0 || this.renames().length > 0); },

  tryClose() {
    if (!this.el) return;
    if (ArtPicker.el) { ArtPicker.close(); return; }
    if (this.s.saving) return;
    if (this.s.view !== 'edit') { this.s.view = this.s.view === 'release' ? (this.s.releaseFrom || 'search') : 'edit'; this.render(); return; }
    if (this.dirty() && !(this.closeArmed && performance.now() - this.closeArmed < 4000)) {
      this.closeArmed = performance.now();
      toast('還有未儲存的修改。再按一次關閉就會放棄這些修改。');
      return;
    }
    this.close();
  },

  close(fromPop) {
    if (!this.el) return false;
    // the mouse back button: stay open while writing, and ask once before dropping unsaved changes
    if (fromPop === true && (this.s.saving || (this.dirty() && !(this.closeArmed && performance.now() - this.closeArmed < 4000)))) {
      OverlayHistory.push(this._close);
      if (!this.s.saving) { this.closeArmed = performance.now(); toast('還有未儲存的修改。再按一次返回就會放棄這些修改。'); }
      return false;
    }
    Popover.close();
    this.el.remove(); this.el = null; this.closeArmed = 0;
    document.removeEventListener('keydown', this.onDocKey, true);
    if (fromPop !== true) OverlayHistory.closed(this._close);
    YT.sync();
    return true;
  },

  /* ───────── editing ───────── */
  /** The value an album field shows: the tracks' common value, or null when they differ. */
  common(k) {
    const vals = new Set(this.scope().map(r => r.cur[k]));
    return vals.size === 1 ? [...vals][0] : null;
  },

  /** The tracks a change applies to: the selected ones, or all of them when none is selected. */
  scope() { const s = this.s; return s.sel.size ? s.rows.filter((_, i) => s.sel.has(i)) : s.rows; },
  scopeIdx() { const s = this.s; return s.rows.map((_, i) => i).filter(i => !s.sel.size || s.sel.has(i)); },
  scopeName() { return this.s.sel.size ? `選取的 ${this.s.sel.size} 首` : '全部'; },

  setAll(k, v) { for (const r of this.scope()) r.cur[k] = v; },

  /** The tracks the new cover goes into: those selected when it was chosen, else all. */
  coverRows() {
    const c = this.s.cover, ids = c && c.ids ? new Set(c.ids) : null;
    return this.s.rows.filter(r => r.writable && (!ids || ids.has(r.id)));
  },
  /** A cover change, for the tracks selected now (all when none is). */
  setCover(c) { if (c) c.ids = this.s.sel.size ? this.scope().map(r => r.id) : null; this.s.cover = c; },

  /* ───────── selection: which tracks the album fields, column tools, online data and cover apply to ───────── */
  select(set) {
    this.s.sel = set;
    if (!set.size) this.anchor = null;
    this.refresh();
  },

  updateSel() {
    const s = this.s;
    if (!this.table || !this.table.isConnected) return;
    $$('.te-row[data-i]', this.table).forEach(row => row.classList.toggle('sel', s.sel.has(+row.dataset.i)));
    const all = this.table.querySelector('.te-pick-all');
    if (all) { all.classList.toggle('on', s.sel.size > 0 && s.sel.size === s.rows.length); all.classList.toggle('some', s.sel.size > 0 && s.sel.size < s.rows.length); }
    const bar = this.selBar;
    if (!bar) return;
    bar.textContent = '';
    bar.classList.toggle('on', s.sel.size > 0);
    if (s.sel.size) bar.append(
      h('b', null, `已選 ${s.sel.size} 首`),
      h('span', null, '專輯欄位、整欄設定、自動編號、線上資料和封面只會套用到這些曲目'),
      h('button', { class: 'btn small ghost', onclick: () => this.select(new Set()) }, '清除選取'));
    else bar.append(h('span', null, '只想改其中幾首？在左邊的小方塊拖曳框選，或按住 Shift／Ctrl 點選。'));
  },

  /** Selecting rows: click / drag over the left handle (adds), the file name or length (replaces); Shift = a range, Ctrl = add. */
  pickStart(e) {
    if (e.button !== 0) return;
    const zone = e.target.closest('.te-pick, .te-file, .te-dur'), row = e.target.closest('.te-row[data-i]');
    if (!zone || !row) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const s = this.s, i = +row.dataset.i;
    const range = (a, b, set, remove) => { for (let k = Math.min(a, b); k <= Math.max(a, b); k++) remove ? set.delete(k) : set.add(k); return set; };
    if (e.shiftKey && this.anchor != null) {
      this.select(range(this.anchor, i, e.ctrlKey ? new Set(s.sel) : new Set()));
      return;
    }
    const additive = e.ctrlKey || zone.classList.contains('te-pick');
    const removing = additive && s.sel.has(i);
    const base = additive ? new Set(s.sel) : new Set();
    this.anchor = i;
    let last = i;
    this.select(range(i, i, new Set(base), removing));
    const move = ev => {
      const br = this.body.getBoundingClientRect();
      if (ev.clientY < br.top + 40) this.body.scrollTop -= 16;
      else if (ev.clientY > br.bottom - 40) this.body.scrollTop += 16;
      const el = document.elementFromPoint(Math.max(br.left + 4, Math.min(ev.clientX, br.right - 4)), ev.clientY);
      const r = el && el.closest('.te-row[data-i]');
      if (!r || !this.table.contains(r)) return;
      const j = +r.dataset.i;
      if (j !== last) { last = j; this.select(range(i, j, new Set(base), removing)); }
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  },

  /** [{ id, set }] of the tracks with changed fields. */
  changes() {
    const out = [];
    const totals = this.s.totals;
    const discs = new Map();
    if (totals) for (const r of this.s.rows) { const d = r.cur.disc || '1'; discs.set(d, (discs.get(d) || 0) + 1); }
    const discCount = totals ? Math.max(...this.s.rows.map(r => +r.cur.disc || 1)) : 0;
    const inScope = new Set(this.scope());
    for (const r of this.s.rows) {
      if (!r.writable) continue;
      const set = {};
      for (const k in r.cur) {
        const v = this.NUMERIC.has(k) ? r.cur[k].replace(/[^\d]/g, '') : r.cur[k].trim();
        if (v !== r.orig[k]) set[k] = v;
      }
      if (totals && inScope.has(r)) { set.trackTotal = String(discs.get(r.cur.disc || '1') || ''); set.discTotal = String(discCount); }
      if (Object.keys(set).length) out.push({ id: r.id, set });
    }
    return out;
  },

  /** Marks changed cells / album fields and updates the save button, without redrawing (keeps the focus). */
  refresh() {
    if (!this.el || this.s.view !== 'edit') return;
    const rows = this.s.rows;
    $$('.te-cell', this.body).forEach(inp => {
      const r = rows[+inp.dataset.i], k = inp.dataset.k;
      inp.classList.toggle('changed', inp.value.trim() !== r.orig[k]);
    });
    $$('.te-af', this.body).forEach(inp => {
      const k = inp.dataset.k, c = this.common(k);
      if (document.activeElement !== inp) {
        inp.value = c ?? '';
        inp.placeholder = c == null ? '（多個值，保留各曲原本的值）' : '';
      }
      inp.classList.toggle('changed', this.scope().some(r => r.cur[k] !== r.orig[k]));
    });
    $$('.te-file', this.body).forEach(el => this.drawFile(el, rows[+el.dataset.i]));
    this.updateSel();
    this.updateFoot();
  },

  updateFoot() {
    const n = this.changes().length, cover = this.s.cover, ren = this.renames();
    const coverIds = cover ? new Set(this.coverRows().map(r => r.id)) : new Set();
    const files = new Set([...this.changes().map(c => c.id), ...coverIds, ...ren.map(x => x.id)]).size;
    if (this.saveBtn) {
      this.saveBtn.disabled = !files || this.s.saving;
      this.saveBtn.innerHTML = icon('check') + `<span>${files ? `儲存到 ${files} 個檔案` : '沒有修改'}</span>`;
    }
    if (this.footInfo && !this.s.saving) {
      const parts = [];
      if (n) parts.push(`${n} 首有修改`);
      if (cover) parts.push((cover.mode === 'remove' ? '移除封面' : '更換封面') + (this.s.sel.size ? `（選取的 ${coverIds.size} 首）` : ''));
      if (ren.length) parts.push(`重新命名 ${ren.length} 個檔案`);
      this.footInfo.textContent = parts.length ? parts.join(' · ') + '。儲存後會直接寫入音樂檔案。' : '修改後按儲存，標籤會直接寫入音樂檔案。';
    }
  },

  renderEdit() {
    const s = this.s, al = s.al;
    this.head.textContent = '編輯標籤';
    this.headSub.textContent = al.title;
    const body = this.body;

    // cover + album fields
    const art = h('div', { class: 'te-art' });
    this.drawCover(art);
    const coverBtns = h('div', { class: 'te-art-btns' },
      h('button', { class: 'btn small', html: icon('image') + '更換', onclick: () => this.pickCover() }),
      s.cover
        ? h('button', { class: 'btn small ghost', title: '不更動檔案裡的封面', onclick: () => { s.cover = null; this.render(); } }, '復原')
        : h('button', { class: 'btn small ghost', title: '把封面從檔案中移除', onclick: () => { this.setCover({ mode: 'remove' }); this.render(); } }, '移除'));
    const fields = h('div', { class: 'te-fields' });
    for (const [k, label] of this.ALBUM) {
      const c = this.common(k);
      const inp = h('input', { class: 'inp te-af', 'data-k': k, value: c ?? '', placeholder: c == null ? '（多個值，保留各曲原本的值）' : '', spellcheck: 'false', inputmode: this.NUMERIC.has(k) ? 'numeric' : null });
      inp.oninput = () => { this.setAll(k, inp.value); this.refresh(); };
      inp.onblur = () => this.refresh();
      fields.append(h('label', { class: 'te-field' + (k === 'year' ? ' short' : '') }, h('span', null, label), inp));
    }
    const tools = h('div', { class: 'te-tools' },
      h('button', { class: 'btn small primary', html: icon('search') + '線上搜尋專輯資料', onclick: () => { s.view = 'search'; this.render(); } }),
      h('button', { class: 'btn small', html: icon('list') + '自動編號', title: '依目前順序，每張碟從 1 開始編號（有選取時只編選取的曲目）', onclick: () => this.renumber() }),
      h('button', { class: 'btn small', html: icon('note') + '從檔名取得標題', title: '「01 - 曲名.flac」→「曲名」', onclick: () => this.titlesFromFiles() }),
      h('button', { class: 'btn small', html: icon('headphones') + '聲紋辨識', title: '用聲音認出每首歌（AcoustID / MusicBrainz），有選取時只辨識選取的曲目', onclick: () => { s.view = 'identify'; this.render(); } }),
      h('button', { class: 'btn small', html: icon('folder') + '重新命名檔案', title: '依命名規則，用標籤改檔名（有選取時只改選取的曲目）', onclick: () => { s.view = 'rename'; this.render(); } }),
      h('button', { class: 'btn small ghost', html: icon('refresh') + '全部復原', onclick: () => { for (const r of s.rows) r.cur = { ...r.orig }; s.cover = null; s.rename = null; this.render(); } }));
    body.append(h('div', { class: 'te-top' }, h('div', { class: 'te-cover' }, art, coverBtns), h('div', { class: 'te-right' }, fields, tools)));

    // track table
    const table = h('div', { class: 'te-table' });
    const head = h('div', { class: 'te-row te-headrow' });
    head.append(h('button', { class: 'te-pick te-pick-all', title: '全選／全不選 (Ctrl+A)', onclick: () => this.select(s.sel.size === s.rows.length ? new Set() : new Set(s.rows.map((_, i) => i))) }));
    for (const [k, label, cls] of this.COLS)
      head.append(h('button', { class: 'te-h ' + (cls || '') + ' c-' + k, title: '整欄設定', onclick: e => this.columnMenu(k, label, e.currentTarget) }, label, h('span', { class: 'caret', html: icon('down') })));
    head.append(h('div', { class: 'te-h c-file' }, '檔案'), h('div', { class: 'te-h num c-dur' }, '長度'));
    table.append(head);
    s.rows.forEach((r, i) => {
      const row = h('div', { class: 'te-row' + (r.writable ? '' : ' ro'), 'data-i': i, title: r.writable ? '' : `這種格式（${r.codec}）不支援寫入` });
      row.append(h('div', { class: 'te-pick', title: '點選、拖曳框選，Shift 點選一段，Ctrl 點選多首' }));
      for (const [k, , cls] of this.COLS) {
        const inp = h('input', { class: 'te-cell ' + (cls || '') + ' c-' + k, 'data-i': i, 'data-k': k, value: r.cur[k], spellcheck: 'false', disabled: !r.writable, inputmode: cls === 'num' ? 'numeric' : null });
        inp.oninput = () => { r.cur[k] = inp.value; inp.classList.toggle('changed', inp.value.trim() !== r.orig[k]); if (s.rename) this.drawFile(row.querySelector('.te-file'), r); this.updateFoot(); if (k === 'disc') this.refreshAlbumFields(); };
        inp.onkeydown = e => this.cellKey(e, i, k);
        row.append(inp);
      }
      const file = h('div', { class: 'te-file c-file', 'data-i': i });
      this.drawFile(file, r);
      row.append(file, h('div', { class: 'te-dur num c-dur' }, fmtTime(r.dur)));
      table.append(row);
    });
    this.selBar = h('div', { class: 'te-selbar' });
    body.append(this.selBar, table);
    this.table = table;
    table.addEventListener('pointerdown', e => this.pickStart(e));

    // footer
    this.footInfo = h('div', { class: 'te-info' });
    const totals = h('label', { class: 'te-check', title: '每首寫入「共幾首」與「共幾張碟」（例如 3/12、1/2）' },
      h('input', { type: 'checkbox', checked: !!s.totals, onchange: e => { s.totals = e.target.checked; this.updateFoot(); } }), '寫入總曲數／總碟數');
    this.saveBtn = h('button', { class: 'btn primary', onclick: () => this.save() });
    this.foot.append(this.footInfo, totals, h('button', { class: 'btn ghost', onclick: () => this.tryClose() }, '取消'), this.saveBtn);
    this.refresh();
  },

  refreshAlbumFields() { this.refresh(); },

  /** Enter / ↑ ↓ move between rows of the same column, like a spreadsheet. */
  cellKey(e, i, k) {
    let to = null;
    if (e.key === 'ArrowDown' || e.key === 'Enter') to = i + (e.shiftKey && e.key === 'Enter' ? -1 : 1);
    else if (e.key === 'ArrowUp') to = i - 1;
    if (to == null) return;
    const next = this.body.querySelector(`.te-cell[data-i="${to}"][data-k="${k}"]`);
    if (next) { e.preventDefault(); next.focus(); next.select(); }
  },

  /** A column's header menu: one value for every track, and the column's helpers. */
  columnMenu(k, label, anchor) {
    const s = this.s;
    const c = this.common(k);
    const inp = h('input', { class: 'inp', value: c ?? '', placeholder: s.sel.size ? `選取曲目的${label}` : `所有曲目的${label}`, spellcheck: 'false' });
    const apply = () => { this.setAll(k, inp.value); Popover.close(); this.render(); };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') apply(); if (e.key === 'Escape') Popover.close(); };
    const box = h('div', { class: 'te-colpop' },
      h('div', { class: 'te-colpop-t' }, `整欄設定：${label}` + (s.sel.size ? `（選取的 ${s.sel.size} 首）` : '')),
      h('div', { class: 'te-colpop-row' }, inp, h('button', { class: 'btn small primary', onclick: apply }, s.sel.size ? '套用到選取' : '套用到全部')));
    const extra = [];
    if (k === 'track') extra.push([s.sel.size ? '自動編號（選取的曲目，每張碟從 1 開始）' : '自動編號（每張碟從 1 開始）', () => this.renumber()]);
    if (k === 'title') extra.push(['從檔名取得標題', () => this.titlesFromFiles()]);
    if (k === 'artist') { const aa = this.common('albumArtist'); if (aa) extra.push([`${s.sel.size ? '選取的' : '全部'}設為專輯演出者（${aa}）`, () => { this.setAll('artist', aa); this.render(); }]); }
    extra.push([s.sel.size ? '復原選取的曲目' : '復原這一欄', () => { for (const r of this.scope()) r.cur[k] = r.orig[k]; this.render(); }]);
    if (k !== 'disc' && k !== 'track') extra.push(['清空這一欄', () => { this.setAll(k, ''); this.render(); }]);
    const menuBox = h('div', { class: 'menu te-colpop-menu' });
    for (const [t, f] of extra) menuBox.append(h('button', { onclick: () => { Popover.close(); f(); }, html: `<span>${esc(t)}</span>` }));
    box.append(menuBox);
    Popover.show(box, anchor, { cls: 'te-pop' });
    setTimeout(() => { inp.focus(); inp.select(); }, 30);
  },

  renumber() {
    const seen = new Map();
    for (const r of this.scope()) {
      const d = r.cur.disc || '1';
      const n = (seen.get(d) || 0) + 1;
      seen.set(d, n);
      r.cur.track = String(n);
    }
    this.render();
    toast(this.s.sel.size ? `已為選取的 ${this.s.sel.size} 首重新編號` : '已依目前順序重新編號');
  },

  titlesFromFiles() {
    let n = 0;
    for (const r of this.scope()) {
      if (!r.writable) continue;
      let t = r.file.replace(/\.[^.]+$/, '');
      t = t.replace(/^\s*(?:(?:cd|disc|disk)\s*\d+\s*[-_. ]\s*)?\d{1,3}\s*(?:[-_.．、]\s*|\s+)/i, '').trim();
      if (t && t !== r.cur.title) { r.cur.title = t; n++; }
    }
    this.render();
    toast(n ? `已從檔名取得 ${n} 首的標題` : '標題已經和檔名一樣');
  },

  /* ───────── 聲紋辨識 (AcoustID) ───────── */
  fpById() { const r = this.s.ident && this.s.ident.result; return new Map((r ? r.tracks : []).map(t => [t.id, t])); },
  fpHas(releaseId) { return [...this.fpById().values()].some(t => t.on && t.on[releaseId]); },

  identProgress(p) {
    const id = this.s && this.s.ident;
    if (!id || !id.running || !this.el) return;
    if (p.stage === 'tool') { id.note = '準備聲紋元件…（第一次使用會下載約 1.5 MB）'; }
    else if (p.id) id.state.set(p.id, p);
    if (this.s.view === 'identify') this.drawIdent();
  },

  async runIdent() {
    const s = this.s;
    const ids = this.scope().map(r => r.id);
    s.ident = { ids, state: new Map(), result: null, running: true, error: null, note: '' };
    this.drawIdent();
    try { s.ident.result = await Host.call('tags.identify', { id: s.al.id, ids: s.sel.size ? ids : [] }); }
    catch (e) { s.ident.error = e.message; }
    s.ident.running = false;
    if (this.el && s.view === 'identify') this.render();
  },

  renderIdentify() {
    const s = this.s;
    this.head.textContent = '聲紋辨識';
    this.headSub.textContent = (s.sel.size ? `選取的 ${s.sel.size} 首` : `全部 ${s.rows.length} 首`) + ' · AcoustID / MusicBrainz';
    const back = h('button', { class: 'btn ghost', onclick: () => { s.view = 'edit'; this.render(); } }, '返回編輯');
    this.identBox = h('div', { class: 'te-ident' });
    this.body.append(this.identBox);
    this.identInfo = h('div', { class: 'te-info' });
    this.foot.append(this.identInfo, back);
    if (s.ident && s.ident.running) {
      this.foot.append(h('button', { class: 'btn ghost', onclick: () => Host.call('tags.identifyCancel') }, '停止'));
      this.drawIdent();
      return;
    }
    Host.call('acoustid.info').then(info => {
      if (!this.el || s.view !== 'identify') return;
      if (!info || !info.hasKey) { this.drawKeySetup(); return; }
      const same = s.ident && s.ident.result && s.ident.ids.join() === this.scope().map(r => r.id).join();
      if (!same) this.runIdent(); else this.drawIdent();
      this.foot.append(h('button', { class: 'btn', html: icon('refresh') + '重新辨識', onclick: () => this.runIdent() }));
    }).catch(e => { this.identBox.textContent = '無法開始：' + e.message; });
  },

  drawKeySetup() {
    const box = this.identBox;
    box.textContent = '';
    const inp = h('input', { class: 'inp te-pattern', placeholder: '貼上 AcoustID 的應用程式金鑰（API key）', spellcheck: 'false' });
    const save = async () => {
      const key = inp.value.trim();
      if (!key) { inp.focus(); return; }
      await Host.call('acoustid.key', { key });
      toast('已儲存 AcoustID 金鑰');
      this.render();
    };
    inp.onkeydown = e => { if (e.key === 'Enter') save(); };
    box.append(h('div', { class: 'te-setup' },
      h('b', null, '先設定 AcoustID 金鑰（只要一次）'),
      h('p', null, '聲紋辨識使用免費的 AcoustID 服務。用 MusicBrainz 帳號登入 AcoustID，建立一個「應用程式」（名稱填 MIKU 即可），把它給的 API key 貼在下面。'),
      h('div', { class: 'te-colpop-row' },
        h('button', { class: 'btn small', html: icon('link') + '開啟 AcoustID 申請頁', onclick: () => Host.call('openUrl', { url: 'https://acoustid.org/new-application' }) })),
      h('div', { class: 'te-colpop-row' }, inp, h('button', { class: 'btn small primary', onclick: save }, '儲存並開始'))));
    setTimeout(() => inp.focus(), 30);
  },

  drawIdent() {
    const s = this.s, id = s.ident, box = this.identBox;
    if (!box || !box.isConnected || !id) return;
    box.textContent = '';
    const rows = s.rows.filter(r => id.ids.includes(r.id));
    const by = this.fpById();
    let done = 0, found = 0;
    const list = h('div', { class: 'te-map' });
    for (const r of rows) {
      const st = id.result ? by.get(r.id) : id.state.get(r.id);
      const state = st ? (st.status || st.state) : 'wait';
      if (['ok', 'none', 'error'].includes(state)) done++;
      if (state === 'ok') found++;
      const label = { wait: '等待中', print: '計算聲紋…', lookup: '查詢中…', none: '找不到', error: '錯誤：' + (st && st.error || '') }[state];
      list.append(h('div', { class: 'te-map-row ' + (state === 'ok' ? '' : state === 'error' ? 'bad' : 'none') },
        h('span', { class: 'l', title: r.path }, r.file),
        h('span', { class: 'arr', html: icon('right') }),
        h('span', { class: 'r' + (state === 'ok' ? ' new' : '') }, state === 'ok' ? `${st.title}${st.artist ? ' — ' + st.artist : ''}` : label),
        h('span', { class: 'd num' }, state === 'ok' && st.score ? Math.round(st.score * 100) + '%' : '')));
    }
    if (this.identInfo) this.identInfo.textContent = id.running ? (id.note && !done ? id.note : `辨識中… ${done} / ${rows.length}`) : id.error ? '辨識失敗：' + id.error : `認出 ${found} / ${rows.length} 首`;
    if (id.result && id.result.releases && id.result.releases.length) {
      box.append(h('div', { class: 'te-map-bar' }, h('span', null, '可能的專輯（依對到的曲目數）'),
        h('button', { class: 'btn small', title: '不選專輯，只把每首認出的曲名和演出者填進去', onclick: () => this.applyIdentTitles() }, '只套用各首的曲名和演出者')));
      const rel = h('div', { class: 'te-results' });
      for (const r of id.result.releases.slice(0, 12)) {
        const img = new Image();
        img.onload = () => img.classList.add('ok');
        img.onerror = () => img.remove();
        img.src = `https://coverartarchive.org/release/${r.id}/front-250`;
        const facts = [r.date, r.country, r.format, r.tracks ? `${r.tracks} 首` : '', r.discs > 1 ? `${r.discs} 碟` : ''].filter(Boolean).join(' · ');
        rel.append(h('button', { class: 'te-hit', onclick: () => this.openRelease({ source: 'musicbrainz', id: r.id, title: r.title, artist: r.artist, tracks: r.tracks }) },
          h('div', { class: 'im' }, img),
          h('div', { class: 'tx' }, h('div', { class: 't' }, r.title || ''), h('div', { class: 'a' }, r.artist || ''), h('div', { class: 'f' }, facts)),
          h('div', { class: 'side' }, h('span', { class: 'src' }, 'MusicBrainz'), h('span', { class: r.matched === rows.length ? 'match' : 'mismatch' }, `對到 ${r.matched} / ${rows.length} 首`))));
      }
      box.append(rel);
    } else if (id.result) box.append(h('div', { class: 'te-empty' }, found ? '認出的歌沒有對應的專輯資料。' : 'AcoustID 的資料庫裡找不到這些歌。冷門或同人作品常常沒有收錄，可以改用「線上搜尋專輯資料」。'));
    box.append(h('div', { class: 'te-map-bar' }, h('span', null, '每首的辨識結果')), list);
  },

  applyIdentTitles() {
    const s = this.s, by = this.fpById();
    let n = 0;
    for (const r of s.rows) {
      const m = by.get(r.id);
      if (!m || m.status !== 'ok' || m.score < 0.6 || !s.ident.ids.includes(r.id)) continue;
      if (m.title) r.cur.title = m.title;
      if (m.artist) r.cur.artist = m.artist;
      n++;
    }
    s.view = 'edit'; this.render();
    toast(n ? `已套用 ${n} 首的曲名和演出者，確認後按「儲存」` : '沒有可靠的辨識結果可以套用');
  },

  /* ───────── renaming files from the tags ───────── */
  TOKENS: [['%track%', '曲號'], ['%disc%', '碟號'], ['%title%', '標題'], ['%artist%', '演出者'], ['%album%', '專輯'], ['%albumartist%', '專輯演出者'], ['%year%', '年份'], ['%genre%', '類型'], ['%composer%', '作曲'], ['%filename%', '原檔名']],
  PRESETS: ['%track% - %title%', '%track%. %title%', '%disc%-%track% %title%', '%track% - %artist% - %title%', '%artist% - %title%'],

  /** A file name (without extension) from the pattern and the track's current (edited) tags. */
  fileName(r, pattern) {
    const v = r.cur, pad = this.s.rows.length > 99 ? 3 : 2;
    const names = x => (x || '').split(';').map(y => y.trim()).filter(Boolean).join(', ');
    const tok = {
      track: v.track ? v.track.replace(/\D/g, '').padStart(pad, '0') : '', disc: (v.disc || '').replace(/\D/g, ''),
      title: v.title, artist: names(v.artist), album: v.album, albumartist: names(v.albumArtist), year: v.year,
      genre: names(v.genre), composer: names(v.composer), filename: r.file.replace(/\.[^.]+$/, ''),
    };
    let s = pattern.replace(/%([a-z]+)%/gi, (m, k) => (k = k.toLowerCase()) in tok ? (tok[k] || '').trim() : m);
    // characters Windows doesn't allow in a file name: their full-width forms
    const full = { '\\': '＼', '/': '／', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜' };
    s = s.replace(/[\\/:*?"<>|]/g, c => full[c]).replace(/[\x00-\x1f]/g, '').replace(/\s+/g, ' ');
    // separators left over from empty fields ("%track% - %title%" without a track number)
    s = s.replace(/^[\s\-_.・,]+/, '').replace(/[\s\-_,・]+$/, '').replace(/[. ]+$/, '');
    return [...s].slice(0, 150).join('');
  },

  /** Every track's file name afterwards, with what is wrong with it. pattern / ids: the rule and the tracks it is for. */
  renamePlan(pattern = this.s.rename && this.s.rename.pattern, ids = this.s.rename && this.s.rename.ids) {
    const s = this.s;
    if (!pattern) return [];
    const only = ids ? new Set(ids) : null;
    const plan = s.rows.map((r, i) => {
      const ext = (/\.[^.]+$/.exec(r.file) || [''])[0], base = r.file.slice(0, r.file.length - ext.length);
      const dir = r.path.slice(0, r.path.length - r.file.length).toLowerCase();
      if (only && !only.has(r.id)) return { i, r, id: r.id, name: base, ext, dir, changed: false };
      const name = this.fileName(r, pattern) || '';
      return { i, r, id: r.id, name, ext, dir, changed: name !== base, problem: name ? null : '檔名是空的', rule: true };
    });
    const count = new Map();
    for (const p of plan) { const k = p.dir + (p.name + p.ext).toLowerCase(); count.set(k, (count.get(k) || 0) + 1); }
    for (const p of plan) if (!p.problem && count.get(p.dir + (p.name + p.ext).toLowerCase()) > 1 && p.rule) p.problem = '和另一首同名';
    return plan;
  },

  /** [{ id, name }] for tags.save: the new file names (with extension). */
  renames() { return this.renamePlan().filter(p => p.changed).map(p => ({ id: p.id, name: p.name + p.ext })); },

  drawFile(el, r) {
    if (!el) return;
    const p = this.s.rename ? this.renamePlan().find(x => x.r === r) : null;
    el.textContent = p && p.changed ? p.name + p.ext : r.file;
    el.classList.toggle('renamed', !!(p && p.changed));
    el.classList.toggle('bad', !!(p && p.problem));
    el.title = p && p.changed ? `原檔名：${r.file}` + (p.problem ? `\n${p.problem}` : '') : r.path;
  },

  renderRename() {
    const s = this.s;
    this.head.textContent = '重新命名檔案';
    this.headSub.textContent = s.sel.size ? `選取的 ${s.sel.size} 首` : `全部 ${s.rows.length} 首`;
    const ids = s.sel.size ? this.scope().map(r => r.id) : null;
    const draft = s.renameDraft ?? (s.rename && s.rename.pattern) ?? uiPref('tagRename', '%track% - %title%');
    const inp = h('input', { class: 'inp te-pattern', value: draft, spellcheck: 'false', placeholder: '例如 %track% - %title%' });
    const preview = h('div', { class: 'te-map' });
    const info = h('div', { class: 'te-info' });
    const applyBtn = h('button', { class: 'btn primary', html: icon('check') + '套用' });
    const draw = () => {
      s.renameDraft = inp.value;
      const plan = this.renamePlan(inp.value, ids);
      preview.textContent = '';
      preview.append(h('div', { class: 'te-map-row head' }, h('span', null, '目前的檔名'), h('span'), h('span', null, '新的檔名'), h('span')));
      let changed = 0, bad = 0;
      for (const p of plan) {
        if (!p.rule) continue;
        if (p.changed) changed++;
        if (p.problem) bad++;
        preview.append(h('div', { class: 'te-map-row' + (p.problem ? ' bad' : '') + (p.changed ? '' : ' none') },
          h('span', { class: 'l', title: p.r.path }, p.r.file),
          h('span', { class: 'arr', html: icon('right') }),
          h('span', { class: 'r' + (p.changed ? ' new' : ''), title: p.name + p.ext }, p.changed ? p.name + p.ext : '（不變）'),
          h('span', { class: 'd' }, p.problem || '')));
      }
      info.textContent = bad ? `${bad} 個檔名有問題，請修改規則` : changed ? `會改 ${changed} 個檔案的名字（按「儲存」時才會改）` : '檔名都不會改變';
      applyBtn.disabled = !!bad || !inp.value.trim();
    };
    inp.oninput = draw;
    inp.onkeydown = e => { if (e.key === 'Enter' && !applyBtn.disabled) applyBtn.click(); };
    const insert = t => {
      const a = inp.selectionStart ?? inp.value.length, b = inp.selectionEnd ?? a;
      inp.value = inp.value.slice(0, a) + t + inp.value.slice(b);
      inp.focus(); inp.setSelectionRange(a + t.length, a + t.length);
      draw();
    };
    this.body.append(
      h('div', { class: 'te-rename' },
        h('label', { class: 'te-field' }, h('span', null, '命名規則'), inp),
        h('div', { class: 'te-chips' }, h('span', { class: 'lbl' }, '插入'),
          ...this.TOKENS.map(([t, label]) => h('button', { class: 'chip', title: t, onclick: () => insert(t) }, label))),
        h('div', { class: 'te-chips' }, h('span', { class: 'lbl' }, '常用'),
          ...this.PRESETS.map(p => h('button', { class: 'chip mono', onclick: () => { inp.value = p; draw(); } }, p))),
        h('div', { class: 'te-hint' }, '用的是編輯器裡目前的標籤（還沒儲存的修改也算）。%track% 會補零成 01、02…；檔名不能用的字元（\\ / : * ? " < > |）會換成全形；副檔名不變，同名的 .lrc 歌詞檔會一起改名。')),
      preview);
    applyBtn.onclick = () => {
      s.rename = { pattern: inp.value.trim(), ids };
      s.renameDraft = null;
      setUiPref('tagRename', s.rename.pattern);
      s.view = 'edit'; this.render();
      const n = this.renames().length;
      toast(n ? `已設定重新命名 ${n} 個檔案，按「儲存」時才會改名` : '檔名都不會改變');
    };
    this.foot.append(info, h('button', { class: 'btn ghost', onclick: () => { s.renameDraft = null; s.view = 'edit'; this.render(); } }, '返回編輯'));
    if (s.rename) this.foot.append(h('button', { class: 'btn ghost', onclick: () => { s.rename = null; s.renameDraft = null; s.view = 'edit'; this.render(); } }, '不要重新命名'));
    this.foot.append(applyBtn);
    draw();
    setTimeout(() => inp.focus(), 30);
  },

  /* ───────── cover ───────── */
  drawCover(box) {
    const s = this.s, al = s.al;
    box.textContent = '';
    box.className = 'te-art';
    if (s.cover && s.cover.mode === 'remove') {
      box.classList.add('none');
      box.append(h('div', { class: 'te-art-msg' }, s.cover.ids ? `儲存後移除選取的 ${s.cover.ids.length} 首的封面` : '儲存後移除封面'));
      return;
    }
    if (s.cover && s.cover.preview) {
      const img = new Image();
      img.onload = () => img.classList.add('ok');
      img.onerror = () => { box.textContent = ''; box.append(h('div', { class: 'te-art-msg' }, '無法預覽，儲存時會下載')); };
      img.src = s.cover.preview;
      box.append(img, h('div', { class: 'te-art-badge' }, s.cover.ids ? `新封面 · ${s.cover.ids.length} 首` : '新封面'));
      return;
    }
    const kind = al.loose && al.tracks[0] ? 't' : 'a', id = kind === 't' ? al.tracks[0].id : al.id;
    fillArt(box, kind, id, 150, al.title);
    if (s.data.artSource && s.data.artSource !== 'embedded')
      box.append(h('div', { class: 'te-art-badge dim', title: '這張封面不在音樂檔裡' }, { override: '只在 MIKU', folder: '資料夾圖片', online: '網路', none: '沒有封面' }[s.data.artSource] || ''));
  },

  /** The cover picker (the same search as 更換封面), choosing a picture for the files instead of applying it at once. */
  pickCover() {
    const s = this.s, al = s.al;
    const pick = c => { this.setCover(c); if (this.el && s.view === 'edit') this.render(); };
    ArtPicker.show({
      heading: `選擇要寫入檔案的封面 · ${al.title}`,
      query: `${searchArtist((al.artists || [al.artist]).join(';'))} ${al.title}`.trim(),
      searching: '搜尋中…（Apple Music、Deezer、MusicBrainz）',
      info: () => Promise.resolve({}),
      candidates: q => Host.call('art.candidates', { id: al.id, q, part: 'albums' }),
      more: q => Host.call('art.candidates', { id: al.id, q, part: 'songs' }),
      setUrl: url => { pick({ mode: 'set', url, preview: url }); return Promise.resolve(); },
      setData: data => { pick({ mode: 'set', data, preview: data }); return Promise.resolve(); },
      clear: () => Promise.resolve(),
      restoreLabel: '', restored: '', applied: '已選擇封面，按「儲存」後寫入檔案',
      after: () => { },
    });
  },

  /* ───────── online search ───────── */
  renderSearch() {
    const s = this.s, al = s.al;
    this.head.textContent = '線上搜尋專輯資料';
    this.headSub.textContent = 'MusicBrainz · Apple Music';
    const q = s.search || (s.search = {
      album: this.common('album') || al.title,
      artist: searchArtist(this.common('albumArtist') || (al.artists || []).join(';')),
      results: null, error: null,
    });
    const album = h('input', { class: 'inp', value: q.album, placeholder: '專輯名稱', spellcheck: 'false' });
    const artist = h('input', { class: 'inp', value: q.artist, placeholder: '演出者（可留空）', spellcheck: 'false' });
    const go = () => { q.album = album.value.trim(); q.artist = artist.value.trim(); this.runSearch(); };
    album.onkeydown = artist.onkeydown = e => { if (e.key === 'Enter') go(); };
    this.body.append(h('div', { class: 'te-search' },
      h('button', { class: 'icon-btn', title: '返回編輯', html: icon('left'), onclick: () => { s.view = 'edit'; this.render(); } }),
      album, artist, h('button', { class: 'btn small primary', html: icon('search') + '搜尋', onclick: go })));
    const list = h('div', { class: 'te-results' });
    this.body.append(list);
    this.resultsBox = list;
    this.drawResults();
    this.foot.append(h('div', { class: 'te-info' }, '選一張專輯，確認曲目對應後套用到編輯器（還不會寫入檔案）。'),
      h('button', { class: 'btn ghost', onclick: () => { s.view = 'edit'; this.render(); } }, '返回編輯'));
    if (!q.results && !q.loading) this.runSearch();
    setTimeout(() => album.focus(), 30);
  },

  async runSearch() {
    const s = this.s, q = s.search;
    q.loading = true; q.error = null; q.results = null;
    this.drawResults();
    const seq = this.searchSeq = (this.searchSeq || 0) + 1;
    try { q.results = await Host.call('tags.search', { id: s.al.id, album: q.album, artist: q.artist }) || []; }
    catch (e) { q.error = e.message; }
    if (seq !== this.searchSeq) return;
    q.loading = false;
    if (this.el && s.view === 'search') this.drawResults();
  },

  drawResults() {
    const list = this.resultsBox, q = this.s.search;
    if (!list || !list.isConnected) return;
    list.textContent = '';
    if (q.loading) { list.append(h('div', { class: 'te-empty' }, '搜尋中…')); return; }
    if (q.error) { list.append(h('div', { class: 'te-empty' }, '搜尋失敗：' + q.error)); return; }
    if (!q.results) return;
    if (!q.results.length) { list.append(h('div', { class: 'te-empty' }, '找不到結果。試試只用專輯名稱，或換個寫法（原文、羅馬拼音）。')); return; }
    const n = this.s.rows.length;
    for (const r of q.results) {
      const img = new Image();
      img.onload = () => img.classList.add('ok');
      if (r.thumb) img.src = r.thumb;
      const src = r.source === 'apple' ? `Apple Music ${(r.country || '').toUpperCase()}` : 'MusicBrainz';
      const facts = [r.date, r.tracks ? `${r.tracks} 首` : '', r.discs > 1 ? `${r.discs} 碟` : '', r.source === 'musicbrainz' ? r.format : '', r.source === 'musicbrainz' ? r.country : '', r.label]
        .filter(Boolean).join(' · ');
      const row = h('button', { class: 'te-hit', onclick: () => this.openRelease(r) },
        h('div', { class: 'im' }, img),
        h('div', { class: 'tx' },
          h('div', { class: 't' }, r.title || ''),
          h('div', { class: 'a' }, r.artist || ''),
          h('div', { class: 'f' }, facts)),
        h('div', { class: 'side' },
          h('span', { class: 'src ' + r.source }, src),
          r.tracks === n ? h('span', { class: 'match' }, `${n} 首相符`) : r.tracks ? h('span', { class: 'mismatch' }, `本機 ${n} 首`) : null));
      list.append(row);
    }
  },

  async openRelease(hit) {
    const s = this.s;
    s.releaseFrom = s.view === 'identify' ? 'identify' : 'search';
    s.view = 'release'; s.release = { hit, data: null, loading: true }; s.matchBy = null;
    this.render();
    try { s.release.data = await Host.call('tags.release', { source: hit.source, id: hit.id, country: hit.country }); }
    catch (e) { s.release.error = e.message; }
    s.release.loading = false;
    if (this.el && s.view === 'release' && s.release.hit === hit) this.render();
  },

  renderRelease() {
    const s = this.s, rel = s.release, d = rel.data, hit = rel.hit;
    this.head.textContent = hit.title || '專輯資料';
    this.headSub.textContent = hit.source === 'apple' ? `Apple Music ${(hit.country || '').toUpperCase()}` : 'MusicBrainz';
    const back = () => { s.view = s.releaseFrom || 'search'; this.render(); };
    this.foot.append(h('div', { class: 'te-info' }), h('button', { class: 'btn ghost', onclick: back }, '返回結果'));
    if (rel.loading) { this.body.append(h('div', { class: 'te-empty' }, '讀取曲目中…')); return; }
    if (rel.error || !d) { this.body.append(h('div', { class: 'te-empty' }, '讀取失敗：' + (rel.error || '沒有資料'))); return; }

    const opts = s.applyOpts || (s.applyOpts = { album: true, albumArtist: true, year: true, genre: true, title: true, artist: true, numbers: true, cover: true });
    const rows = s.rows;
    const img = new Image();
    img.onload = () => img.classList.add('ok');
    if (d.coverThumb) img.src = d.coverThumb;
    const facts = [d.date, d.genre, d.label, `${d.tracks.length} 首`].filter(Boolean).join(' · ');
    const check = (k, label, value) => h('label', { class: 'te-check' + (value ? '' : ' dis') },
      h('input', { type: 'checkbox', checked: !!(opts[k] && value), disabled: !value, onchange: e => { opts[k] = e.target.checked; } }),
      h('span', null, label), value && value !== true ? h('em', null, value) : null);
    this.body.append(h('div', { class: 'te-rel' },
      h('div', { class: 'te-rel-art' }, img),
      h('div', { class: 'te-rel-info' },
        h('div', { class: 't' }, d.title || ''), h('div', { class: 'a' }, d.artist || ''), h('div', { class: 'f' }, facts),
        h('div', { class: 'te-opts' },
          check('album', '專輯名稱', d.title), check('albumArtist', '專輯演出者', d.artist),
          check('year', '年份', d.year ? String(d.year) : ''), check('genre', '類型', d.genre),
          check('title', '曲名', d.tracks.length > 0), check('artist', '曲目演出者', d.tracks.length > 0),
          check('numbers', '曲號／碟號', d.tracks.length > 0), check('cover', '封面', !!d.cover)))));

    // which online track each local one gets: in order, or by length (bonus tracks, another edition's order)
    const hasDur = rows.some(r => r.dur > 0) && d.tracks.some(t => t.dur > 0);
    const fpOk = this.fpHas(rel.hit.id);
    if (!s.matchBy && fpOk) s.matchBy = 'audio';
    if (!s.matchBy) {
      // by length when that matches clearly more tracks than the order does (another edition, bonus tracks)
      const good = p => p.filter((j, i) => j >= 0 && (!(rows[i].dur > 0 && d.tracks[j].dur > 0) || Math.abs(rows[i].dur - d.tracks[j].dur) <= 3)).length;
      s.matchBy = hasDur && good(this.pairs(d.tracks, 'duration')) > good(this.pairs(d.tracks, 'order')) + 1 ? 'duration' : 'order';
    }
    const pairs = this.pairs(d.tracks, s.matchBy);
    const matched = pairs.filter(j => j >= 0).length, idx = this.scopeIdx();
    if (s.sel.size) this.body.append(h('div', { class: 'te-note' }, `只套用到選取的 ${s.sel.size} 首（專輯欄位與封面也是）。`));
    if (matched < idx.length || (!s.sel.size && rows.length !== d.tracks.length))
      this.body.append(h('div', { class: 'te-warn' }, `${s.sel.size ? `選取 ${idx.length} 首` : `本機 ${rows.length} 首`}，這張專輯 ${d.tracks.length} 首，對應到 ${matched} 首。請確認下面的對應是否正確。`));
    const mapHead = h('div', { class: 'te-map-bar' }, h('span', null, '曲目對應'));
    if (hasDur || fpOk) mapHead.append(seg([['order', '依順序'], ...(hasDur ? [['duration', '依長度']] : []), ...(fpOk ? [['audio', '依聲紋']] : [])], s.matchBy, v => { s.matchBy = v; this.render(); }));
    this.body.append(mapHead);
    const map = h('div', { class: 'te-map' },
      h('div', { class: 'te-map-row head' }, h('span', null, '本機檔案'), h('span'), h('span', null, '線上曲目'), h('span', { class: 'num' }, '長度差')));
    const multiDisc = d.tracks.some(x => x.disc > 1);
    let off = 0;
    idx.forEach(i => {
      const r = rows[i];
      const t = pairs[i] >= 0 ? d.tracks[pairs[i]] : null;
      const diff = t && r.dur > 0 && t.dur > 0 ? r.dur - t.dur : null;
      const bad = diff != null && Math.abs(diff) > 3;
      if (bad) off++;
      map.append(h('div', { class: 'te-map-row' + (bad ? ' bad' : '') + (!t ? ' none' : '') },
        h('span', { class: 'l', title: r.path }, `${r.cur.track || '·'}. ${r.cur.title || r.file}`),
        h('span', { class: 'arr', html: t ? icon('right') : '' }),
        h('span', { class: 'r' }, t ? `${multiDisc ? t.disc + '-' : ''}${t.no}. ${t.title}` + (t.artist && t.artist !== d.artist ? ` — ${t.artist}` : '') : '（不變更）'),
        h('span', { class: 'd num' }, diff == null ? '' : (diff > 0 ? '+' : '') + diff.toFixed(1) + 's')));
    });
    const unused = d.tracks.filter((_, j) => !pairs.includes(j));
    if (unused.length && !s.sel.size) map.append(h('div', { class: 'te-map-row none' }, h('span', { class: 'l' }, ''), h('span'),
      h('span', { class: 'r' }, `沒有對應的線上曲目：${unused.map(t => t.title).join('、')}`), h('span')));
    this.body.append(map);
    if (off) this.body.append(h('div', { class: 'te-warn' }, `有 ${off} 首長度差超過 3 秒，可能是不同版本或曲序不同` + (hasDur && s.matchBy === 'order' ? '，可以試試「依長度」對應。' : '。')));
    this.foot.firstChild.textContent = '套用後可以在編輯器裡再修改，按儲存才會寫入檔案。';
    this.foot.append(h('button', { class: 'btn primary', html: icon('check') + '套用到編輯器', onclick: () => this.applyRelease() }));
  },

  /** For each local track the index of its online track, or -1. By length: the closest within 3 s, each used once. */
  pairs(tracks, mode) {
    const rows = this.s.rows, idx = this.scopeIdx(), out = rows.map(() => -1);
    if (mode === 'audio') {
      // where AcoustID says each recording is on this release ("disc/no")
      const rid = this.s.release && this.s.release.hit.id, by = this.fpById();
      for (const i of idx) {
        const pos = by.get(rows[i].id)?.on?.[rid];
        if (!pos) continue;
        const [dn, tn] = pos.split('/').map(Number);
        const j = tracks.findIndex(t => (t.disc || 1) === dn && t.no === tn);
        if (j >= 0 && !out.includes(j)) out[i] = j;
      }
      return out;
    }
    if (mode !== 'duration') {
      // every track keeps its position; a selection out of an album with another track list takes the online tracks from the first
      const keep = idx.length === rows.length || rows.length === tracks.length;
      idx.forEach((i, k) => { const j = keep ? i : k; if (j < tracks.length) out[i] = j; });
      return out;
    }
    const cand = [];
    idx.forEach(i => tracks.forEach((t, j) => {
      const r = rows[i];
      if (r.dur > 0 && t.dur > 0 && Math.abs(r.dur - t.dur) <= 3) cand.push([Math.abs(r.dur - t.dur) + Math.abs(i - j) * 0.05, i, j]);
    }));
    cand.sort((x, y) => x[0] - y[0]);
    const used = new Set();
    for (const [, i, j] of cand) if (out[i] < 0 && !used.has(j)) { out[i] = j; used.add(j); }
    return out;
  },

  applyRelease() {
    const s = this.s, d = s.release.data, o = s.applyOpts;
    if (o.album && d.title) this.setAll('album', d.title);
    if (o.albumArtist && d.artist) this.setAll('albumArtist', d.artist);
    if (o.year && d.year) this.setAll('year', String(d.year));
    if (o.genre && d.genre) this.setAll('genre', d.genre);
    const pairs = this.pairs(d.tracks, s.matchBy || 'order');
    for (let i = 0; i < s.rows.length; i++) {
      const r = s.rows[i], t = d.tracks[pairs[i]];
      if (!t) continue;
      if (o.title && t.title) r.cur.title = t.title;
      if (o.artist && t.artist) r.cur.artist = t.artist;
      if (o.numbers) { r.cur.track = t.no ? String(t.no) : r.cur.track; r.cur.disc = t.disc ? String(t.disc) : r.cur.disc; }
    }
    if (o.numbers && d.tracks.some(t => t.disc > 1)) s.totals = true;
    if (o.cover && d.cover) this.setCover({ mode: 'set', url: d.cover, preview: d.coverThumb || d.cover });
    s.view = 'edit';
    this.render();
    toast('已套用到編輯器，確認後按「儲存」寫入檔案');
  },

  /* ───────── saving ───────── */
  progress(p) {
    if (!this.el || !this.s || !this.s.saving || !this.footInfo) return;
    this.footInfo.textContent = `寫入中… ${p.done} / ${p.total}　${p.file || ''}`;
  },

  async save() {
    const s = this.s;
    if (!this.el || s.saving || s.view !== 'edit') return;
    const tracks = this.changes(), rename = this.renames();
    if (!tracks.length && !s.cover && !rename.length) { toast('沒有修改'); return; }
    const clash = this.renamePlan().find(p => p.problem);
    if (clash) { toast(`檔名有問題：${clash.name}${clash.ext}（${clash.problem}）`, { error: true }); return; }
    const bad = tracks.flatMap(t => Object.entries(t.set)).find(([k, v]) => this.NUMERIC.has(k) && v && +v > (k === 'year' ? 9999 : 999));
    if (bad) { toast('數字不正確：' + bad[1], { error: true }); return; }
    s.saving = true;
    this.el.classList.add('saving');
    this.updateFoot();
    this.footInfo.textContent = '寫入中…';
    const cover = s.cover ? { mode: s.cover.mode, url: s.cover.url, data: s.cover.data, ids: s.cover.ids || undefined } : null;
    let r;
    try { r = await Host.call('tags.save', { id: s.al.id, tracks, cover, rename }); }
    catch (e) {
      s.saving = false;
      if (this.el) { this.el.classList.remove('saving'); this.updateFoot(); }
      toast('儲存失敗：' + e.message, { error: true });
      return;
    }
    s.saving = false;
    const failed = r.failed || [];
    if (failed.length) toast(`${failed.length} 個檔案沒有寫入：\n` + failed.slice(0, 6).map(f => `${f.file}：${f.error}`).join('\n') + (failed.length > 6 ? '\n…' : ''), { error: true, ms: 12000 });
    const done = [r.written ? `已寫入 ${r.written} 個檔案的標籤` : '', r.renamed ? `已改名 ${r.renamed} 個檔案` : ''].filter(Boolean);
    if (done.length) toast(done.join('，'));
    // closing the editor goes back one history entry (its overlay entry): the album page is redrawn after that
    const back = new Promise(res => {
      const once = () => { window.removeEventListener('popstate', once); res(); };
      window.addEventListener('popstate', once);
      setTimeout(once, 500);
    });
    this.close();
    await Lib.load();
    await back;
    App.trackKey = null;   // the track objects were rebuilt: the now-playing bar redraws with the new ones
    if (!r.albumId) { if (Router.cur.name === 'album') history.back(); return; }
    const hash = '#/album/' + r.albumId;
    if (!location.hash.startsWith('#/album/')) return;
    // the id changes with the album title: replace the page instead of adding a history entry
    if (location.hash !== hash) history.replaceState({ i: Router.idx }, '', hash);
    Router.render(true, 'none');
  },
};
