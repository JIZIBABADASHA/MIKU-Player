'use strict';
/* ═════════════════════════════ 轉換格式 / CUE 分軌 ═════════════════════════════
   Album / track menu 「轉換格式…」: FLAC, ALAC, WAV, MP3, AAC, Opus with FFmpeg, tags and cover carried over.
   An album whose folder has a CUE sheet for one big file can be split into its tracks (the album page's note).
   Where the files go: replace the originals (they go to the trash, the library uses the new files) or a folder;
   the default and the CUE note are chosen in 設定 → 曲庫 → 格式轉換. */
const Convert = {
  info: null,
  el: null,
  _progress: Host.on('convertProgress', p => Convert.onProgress && Convert.onProgress(p)),

  async loadInfo() {
    if (!this.info) this.info = await Host.call('convert.info').catch(() => null) || { ffmpeg: false, formats: [] };
    return this.info;
  },
  /** The choices last used in the dialog: { out: folder | replace, dir, format, flacLevel, mp3, aacKbps, opusKbps, bits, rate, cover, albumFolder } */
  prefs() { try { return Object.assign(this.defaults(), JSON.parse(uiPref('convert', '{}'))); } catch { return this.defaults(); } },
  defaults() { return { out: 'ask', dir: '', format: 'flac', flacLevel: 5, mp3: 'v0', aacKbps: 256, opusKbps: 160, bits: 'keep', rate: 'keep', cover: true, albumFolder: true }; },
  save(patch) { setUiPref('convert', JSON.stringify(Object.assign(this.prefs(), patch))); },

  trashName() { return (this.info && this.info.trash) || (/Mac/.test(navigator.platform) ? T('垃圾桶') : T('資源回收筒')); },

  /** The album's CUE sheet (for one big file), or null. Cached per album; gives up after a moment so a menu never waits long. */
  cues: new Map(),
  cueFor(al) {
    if (!al || !al.tracks.length) return Promise.resolve(null);
    let p = this.cues.get(al.id);
    if (!p) {
      p = Host.call('cue.info', { id: al.id }).then(c => c && c.tracks && c.tracks.length >= 2 ? c : null).catch(() => null);
      this.cues.set(al.id, p);
    }
    return Promise.race([p, new Promise(r => setTimeout(() => r(null), 600))]);
  },

  /** The dialog. { album, tracks } converts tracks; { album, cue } splits the album's big file by its CUE sheet. */
  async open({ album, tracks, cue }) {
    this.close();
    const info = await this.loadInfo();
    if (!info.ffmpeg) { toast(T('找不到 FFmpeg，無法轉換格式。'), { error: true }); return; }
    const p = this.prefs();
    const items = cue ? cue.tracks.map(c => ({ id: 'c' + c.no, title: c.title || `Track ${c.no}`, sub: [c.performer, fmtTime(c.dur || 0)].filter(Boolean).join(' · ') }))
      : tracks.map(t => ({ id: t.id, title: t.title, sub: [t.artist, fmtQuality(t.codec, t.rate, t.bits)].filter(Boolean).join(' · ') }));
    const st = { format: info.formats.some(f => f.id === p.format && f.ok) ? p.format : (info.formats.find(f => f.ok) || {}).id,
      flacLevel: p.flacLevel, mp3: p.mp3, aacKbps: p.aacKbps, opusKbps: p.opusKbps, bits: p.bits, rate: p.rate, cover: p.cover, albumFolder: p.albumFolder,
      out: p.out === 'replace' ? 'replace' : 'folder', dir: p.dir || '' };
    if (cue && p.out !== 'replace') st.out = 'folder';

    const scrim = h('div', { class: 'modal-scrim' });
    const modal = h('div', { class: 'modal cvt' });
    scrim.append(modal);
    scrim.onclick = e => { if (e.target === scrim && !this.busy) this.close(); };
    const opts = h('div', { class: 'cvt-opts' });
    const list = h('div', { class: 'cvt-list' });
    const status = h('div', { class: 'cvt-status muted' });
    const go = h('button', { class: 'btn primary', html: icon('check') + (cue ? T('開始切開') : T('開始轉換')) });
    const cancel = h('button', { class: 'btn ghost' }, T('取消'));
    modal.append(
      h('div', { class: 'modal-head' }, h('h2', null, (cue ? T('按 CUE 標記切開 · ') : T('轉換格式 · ')) + (album ? album.title : items[0].title)), h('button', { class: 'icon-btn', html: icon('x'), onclick: () => this.busy ? Host.call('convert.cancel') : this.close() })),
      h('div', { class: 'modal-body' }, opts, h('div', { class: 'cvt-sub' }, cue ? T`${items.length} 首（來自 ${cue.cueName}）` : T`${items.length} 首`), list),
      h('div', { class: 'cvt-foot' }, status, cancel, go));
    document.body.append(scrim);
    this.el = scrim;
    OverlayHistory.push(this._close = fromPop => this.close(fromPop));
    YT.sync();

    const rows = new Map();
    for (const it of items) {
      const bar = h('i');
      const state = h('span', { class: 'cvt-state' });
      const row = h('div', { class: 'cvt-row' }, h('div', { class: 'cvt-t' }, h('b', null, it.title), h('small', null, it.sub)), state, h('div', { class: 'cvt-bar' }, bar));
      rows.set(it.id, { row, bar, state });
      list.append(row);
    }

    const segOf = (options, value, fn) => seg(options, value, v => { fn(v); draw(); });
    const sel = (options, value, fn) => { const el = h('select', { class: 'sel' }, ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l))); el.onchange = () => { fn(el.value); draw(); }; return el; };
    const line = (label, ...ctl) => h('div', { class: 'cvt-line' }, h('span', { class: 'cvt-k' }, label), h('div', { class: 'cvt-v' }, ...ctl));
    const lossless = (id = st.format) => ['flac', 'alac', 'wav'].includes(id);
    const draw = () => {
      opts.textContent = '';
      // two groups, so lossless and lossy can be told apart at a glance
      const group = (kind, label, tip) => {
        const seg = h('div', { class: 'seg' });
        for (const f of info.formats.filter(f => lossless(f.id) === (kind === 'lossless')))
          seg.append(h('button', { class: f.id === st.format ? 'on' : '', title: f.ok ? tip : T('這個 FFmpeg 沒有這種編碼器'), disabled: !f.ok, onclick: () => { st.format = f.id; draw(); } }, f.name));
        return h('div', { class: 'cvt-fmt ' + kind }, h('span', { class: 'cvt-fmt-tag' }, label), seg);
      };
      opts.append(line(T('格式'), group('lossless', T('無損'), T('無損：音質和原檔完全相同')), group('lossy', T('有損'), T('有損：檔案小很多，但會丟掉部分聲音資訊'))));
      if (st.format === 'flac') opts.append(line(T('壓縮等級'), sel([0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, n === 5 ? T('5（預設）') : n === 8 ? T('8（最小）') : n === 0 ? T('0（最快）') : String(n)]), st.flacLevel, v => st.flacLevel = +v),
        h('small', { class: 'muted' }, T('數字越大檔案越小、轉換越慢；音質都一樣（無損）'))));
      if (st.format === 'mp3') opts.append(line(T('品質'), sel([['v0', T('VBR V0（約 245 kbps）')], ['v2', T('VBR V2（約 190 kbps）')], ['320', 'CBR 320 kbps'], ['256', 'CBR 256 kbps'], ['192', 'CBR 192 kbps']], st.mp3, v => st.mp3 = v)));
      if (st.format === 'aac') opts.append(line(T('位元率'), sel([[320, '320 kbps'], [256, '256 kbps'], [192, '192 kbps'], [128, '128 kbps']], st.aacKbps, v => st.aacKbps = +v)));
      if (st.format === 'opus') opts.append(line(T('位元率'), sel([[256, '256 kbps'], [192, '192 kbps'], [160, '160 kbps'], [128, '128 kbps'], [96, '96 kbps']], st.opusKbps, v => st.opusKbps = +v)));
      if (lossless()) opts.append(line(T('位元深度'), sel([['keep', T('與原檔相同')], ['16', T('16-bit（降低時加抖動）')], ['24', '24-bit']], st.bits, v => st.bits = v)));
      opts.append(line(T('取樣率'), sel([['keep', T('與原檔相同')], [44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz']], st.rate, v => st.rate = String(v))));
      if (['flac', 'alac', 'mp3', 'aac'].includes(st.format)) {
        const sw = h('span', { class: 'switch' + (st.cover ? ' on' : ''), onclick: () => { st.cover = !st.cover; sw.classList.toggle('on', st.cover); } });
        opts.append(line(T('封面'), sw, h('small', { class: 'muted' }, T('把專輯封面放進新檔案'))));
      }
      opts.append(line(T('放到'), segOf([['replace', T('取代原本的檔案')], ['folder', T('另存到資料夾')]], st.out, v => st.out = v)));
      if (st.out === 'folder') {
        const path = h('span', { class: 'cvt-path num', title: st.dir }, st.dir || T('還沒選擇'));
        const albumSw = h('span', { class: 'switch' + (st.albumFolder ? ' on' : ''), onclick: () => { st.albumFolder = !st.albumFolder; albumSw.classList.toggle('on', st.albumFolder); } });
        opts.append(line(T('資料夾'), path, h('button', { class: 'btn small', html: icon('folder') + T('瀏覽…'), onclick: async () => {
          const d = await Host.call('convert.pickFolder', { dir: st.dir }).catch(() => null);
          if (d) { st.dir = d; draw(); }
        } })));
        opts.append(line('', albumSw, h('small', { class: 'muted' }, T('在資料夾裡為每張專輯另建一個子資料夾（以專輯名稱命名）'))));
      } else opts.append(line('', h('small', { class: 'muted cvt-warn' }, T`新檔案放在原本的位置，原本的${cue ? T('大檔案和 .cue') : T('檔案', 'orig')}移到${this.trashName()}（可以還原）。曲庫、最愛、播放紀錄會跟著換成新檔案。`)));
      go.disabled = !st.format || (st.out === 'folder' && !st.dir);
    };
    draw();

    cancel.onclick = () => this.busy ? Host.call('convert.cancel') : this.close();
    go.onclick = async () => {
      this.busy = true;
      go.disabled = true; cancel.textContent = T('停止');
      opts.classList.add('locked');
      const { out, dir, ...o } = st;
      this.save({ out, dir, format: o.format, flacLevel: o.flacLevel, mp3: o.mp3, aacKbps: o.aacKbps, opusKbps: o.opusKbps, bits: o.bits, rate: o.rate, cover: o.cover, albumFolder: o.albumFolder });
      let done = 0;
      this.onProgress = p => {
        const r = rows.get(p.id);
        if (!r) return;
        if (p.state === 'run') { r.bar.style.width = Math.round((p.pct || 0) * 100) + '%'; r.state.textContent = Math.round((p.pct || 0) * 100) + '%'; r.row.className = 'cvt-row run'; }
        else if (p.state === 'done') { r.bar.style.width = '100%'; r.state.textContent = T('完成'); r.row.className = 'cvt-row done'; done++; status.textContent = `${done} / ${items.length}`; }
        else if (p.state === 'fail') { r.state.textContent = T('失敗'); r.state.title = T.msg(p.error) || ''; r.row.className = 'cvt-row fail'; }
        else if (p.state === 'skip') { r.state.textContent = T('略過'); r.state.title = T.msg(p.error) || ''; r.row.className = 'cvt-row skip'; }
      };
      status.textContent = T('轉換中…');
      let r;
      try {
        r = cue ? await Host.call('cue.split', { id: album.id, opts: o, mode: out, dir })
          : await Host.call('convert.start', { ids: tracks.map(t => t.id), opts: o, mode: out, dir });
      } catch (e) { toast((cue ? T('切開失敗：') : T('轉換失敗：')) + e.message, { error: true }); r = null; }
      this.onProgress = null; this.busy = false;
      this.cues.clear();  // files changed: look for CUE sheets again
      cancel.textContent = T('關閉');
      if (!r) { status.textContent = ''; return; }
      const failed = r.failed || [];
      status.textContent = r.cancelled ? T`已停止：完成 ${r.done} 首` : T`完成 ${r.done} 首` + (failed.length ? T`，${failed.length} 首失敗` : '');
      if (failed.length) toast(T`${failed.length} 個檔案沒有完成：\n` + failed.slice(0, 6).map(f => T`${f.file}：${T.msg(f.error)}`).join('\n'), { error: true, ms: 12000 });
      // finished: the start button gives way to one that shows where the files are
      const showBtn = (label, run) => h('button', { class: 'btn primary', html: icon('folder') + label, onclick: run });
      if (!r.done) go.remove();
      else if (r.dir) go.replaceWith(showBtn(T('打開資料夾'), () => Host.call('convert.open', { path: r.dir })));
      if (out === 'replace' && r.done) {
        await Lib.load();
        App.redrawTrack();
        // the new files sit where the old ones were: show that folder (the album's tracks have new ids now)
        const al = r.albumId && Lib.albumById.get(r.albumId);
        const tid = al && al.tracks[0] ? al.tracks[0].id : null;
        if (tid) go.replaceWith(showBtn(/Mac/.test(navigator.platform) ? T('在 Finder 中顯示') : T('在檔案總管中顯示'), () => Host.call('reveal', { id: tid })));
        else go.remove();
        if (album && r.albumId) Lib.renamed(album.id, r.albumId);
        if (Router.cur.name === 'album' && r.albumId) {
          const hash = '#/album/' + r.albumId;
          if (location.hash !== hash) history.replaceState({ i: Router.idx }, '', hash);
          Router.render(true, 'none');
        }
      }
    };
  },

  close(fromPop) {
    if (!this.el) return false;
    if (this.busy) { Host.call('convert.cancel'); return true; }
    this.el.remove(); this.el = null;
    if (fromPop !== true) OverlayHistory.closed(this._close);
    YT.sync();
    return true;
  },
};
