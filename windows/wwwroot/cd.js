'use strict';
/* ═════════════════════════════ audio CD ═════════════════════════════
   A disc in the drive: an album (id "cd-…") that isn't part of the library. The host tells what's in the drive
   (cd.info, event "cd"); the album and its tracks are put into Lib's maps (not its lists) after every Lib.load, so
   the album page, the player bar and the queue treat them like any other. 「抓取 CD」 rips with the host's secure
   reader (cd.rip, event "cdRip"): two reads compared, rereads, read offset, AccurateRip, then the chosen format. */
const Cd = {
  info: null,
  album: null,
  ripping: false,
  onRip: null,
  task: null,
  stopping: false,
  _init: (() => {
    Host.on('cd', d => Cd.update(d));
    Host.on('cdRip', p => Cd.onRip && Cd.onRip(p));
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const top = OverlayHistory.stack.at(-1);
      if (Cd.infoEl && top === Cd._closeInfo) { e.preventDefault(); e.stopImmediatePropagation(); Cd.closeInfo(); }
      else if (Cd.ripDialogOpen && top === Cd._close) { e.preventDefault(); e.stopImmediatePropagation(); Cd.close(); }
    }, true);
    return true;
  })(),

  async refresh() {
    try { this.update(await Host.call('cd.info')); } catch { this.update(null); }
  },

  update(info) {
    const had = this.album && this.album.id, hadTitle = this.album && this.album.title;
    this.info = info && info.disc ? info : null;
    this.inject();
    this.nav();
    this.drawInfo();
    const now = this.album && this.album.id;
    // the CD's page follows the disc: redraw when it changed (names arrived, another disc, ejected)
    if (Router.cur.name === 'cd' && (had !== now || hadTitle !== (this.album && this.album.title) || !this.ripDialogOpen)) Router.render(true, 'none');
    App.redrawTrack && App.redrawTrack();
  },

  /** The disc's album and tracks, in the shape Lib.load makes, into Lib's maps (the lists don't show it). */
  inject() {
    const old = this.album;
    if (old) { Lib.albumById.delete(old.id); for (const t of old.tracks) Lib.trackById.delete(t.id); }
    this.album = null;
    const d = this.info && this.info.disc;
    if (!d) return;
    const artists = splitNames(d.artist || '');
    const al = {
      id: d.id, title: d.title || T('音樂 CD'), artist: joinNames(artists), artists, year: d.year || 0, genre: '', added: 0, hasArt: !!d.cover,
      loose: false, vg: '', folder: '', tracks: [], dur: 0, versions: null, hidden: false, cd: true,
    };
    for (const x of d.tracks) {
      const ta = splitNames(x.artist || d.artist || '');
      const t = { id: x.id, title: x.title, artist: joinNames(ta), artists: ta, albumId: al.id, disc: 1, no: x.no, dur: x.dur, codec: 'CD', rate: 44100, bits: 16, year: al.year, composer: '', album: al };
      t.s = norm(t.title + ' ' + t.artist + ' ' + al.title); t.na = norm(t.artist);
      al.tracks.push(t); al.dur += t.dur;
      Lib.trackById.set(t.id, t);
    }
    al.q = fmtQuality('CD', 44100, 16); al.qc = qualityClass('CD', 44100, 16); al.s = norm(al.title + ' ' + al.artist);
    Lib.albumById.set(al.id, al);
    if (d.cover) ArtVer['a' + al.id] = d.coverVer || 1;
    this.album = al;
  },

  /** Keep the CD section in the sidebar even when the drive is empty. */
  nav() {
    const a = $('#nav a[data-r="cd"]'), label = $('#nav-cd-label');
    if (!a || !label) return;
    a.style.display = label.style.display = '';
    const sp = a.querySelector('span');
    if (sp) sp.textContent = this.album ? (this.album.title === T('音樂 CD') ? 'CD' : this.album.title) : 'CD';
    a.title = this.album ? `${this.info.disc.drive} ${this.album.title}` : T('未偵測到光碟');
    NavPill.move();
  },

  /* ───────── compare the metadata found for this disc ───────── */
  infoEl: null,
  infoBusy: false,

  infoDialog() {
    const d = this.info?.disc;
    if (!d || this.infoEl) return;
    this.infoDiscId = d.id; this.infoError = ''; this.infoMessage = '';
    this.infoReturnFocus = document.activeElement;
    const scrim = h('div', { class: 'modal-scrim' });
    const modal = h('div', { class: 'modal cd-info' });
    this.infoTitle = h('h2', null, T('查找 CD 資訊'));
    this.infoBody = h('div', { class: 'modal-body' });
    this.infoStatus = h('div', { class: 'cvt-status muted', role: 'status' });
    this.infoRefresh = h('button', { class: 'btn', html: icon('refresh') + T('重新查找'), onclick: () => this.findInfo() });
    const close = h('button', { class: 'icon-btn', title: T('關閉 (Esc)'), 'aria-label': T('關閉'), html: icon('x'), onclick: () => this.closeInfo() });
    this.infoClose = close;
    modal.append(h('div', { class: 'modal-head' }, this.infoTitle, close), this.infoBody,
      h('div', { class: 'cvt-foot' }, this.infoStatus, this.infoRefresh,
        h('button', { class: 'btn ghost', onclick: () => this.closeInfo() }, T('關閉'))));
    scrim.append(modal);
    scrim.addEventListener('keydown', e => { if (e.key !== 'F11' && e.key !== 'F12') e.stopPropagation(); });
    scrim.onclick = e => { if (e.target === scrim) this.closeInfo(); };
    this.infoEl = scrim; document.body.append(scrim);
    OverlayHistory.push(this._closeInfo = fromPop => this.closeInfo(fromPop));
    this.drawInfo(); YT.sync(); close.focus({ preventScroll: true });
    if (d.lookup !== 'pending' && !(d.releases || []).length) this.findInfo();
  },

  drawInfo() {
    if (!this.infoEl) return;
    const d = this.info?.disc, body = this.infoBody;
    const { scrollTop, scrollLeft } = body;
    const focused = body.contains(document.activeElement);
    body.textContent = '';
    if (!d || d.id !== this.infoDiscId) {
      body.append(h('div', { class: 'cd-info-empty muted' }, T('光碟已退出或變更，請重新開啟 CD 資訊。')));
      this.infoStatus.textContent = ''; this.infoRefresh.disabled = true;
      if (focused) this.infoClose.focus({ preventScroll: true });
      return;
    }
    this.infoTitle.textContent = T('查找 CD 資訊 · ') + (d.title || T('音樂 CD'));
    this.infoRefresh.disabled = this.infoBusy || d.lookup === 'pending';
    const releases = d.releases || [];
    const selected = releases.find(r => r.id === d.release);
    const current = { ...selected, id: d.release, title: d.title, artist: d.artist,
      date: selected?.date || (d.year ? String(d.year) : ''), tracks: d.tracks, current: true };
    const versions = [current, ...releases.filter(r => r.id !== d.release)];
    this.infoStatus.textContent = this.infoError || this.infoMessage || (d.lookup === 'pending' ? T('正在查找 CD 資訊…')
      : d.lookup === 'error' ? T('查找失敗，可按「重新查找」再試一次。')
      : releases.length ? T`MusicBrainz 找到 ${releases.length} 個版本` : T('MusicBrainz 沒有找到這張光碟的版本。'));
    body.append(h('p', { class: 'cd-info-note muted' }, versions.length > 1
      ? T('並排比較專輯與曲目資訊，確認後選用版本。有底色的欄位與目前資訊不同。')
      : d.lookup === 'pending' ? T('查找期間仍保留目前資訊。') : T('目前只有這份資訊，可重新查找其他版本。')));
    const head = h('tr', null, h('th', { scope: 'col' }, T('資訊')));
    versions.forEach((r, i) => head.append(h('th', { scope: 'col', class: r.current ? 'current' : '' },
      h('div', { class: 'cd-info-version' }, r.current ? T('目前使用') : T`版本 ${i}`),
      h('button', { class: 'btn small' + (r.current ? ' ghost' : ' primary'), disabled: r.current || this.infoBusy || d.lookup === 'pending',
        onclick: () => this.useInfo(r) }, r.current ? T('已選用') : T('選用此版本')))));
    const rows = h('tbody');
    for (const [key, label] of [['title', T('專輯')], ['artist', T('演出者')], ['date', T('發行日期')], ['country', T('地區')], ['label', T('唱片公司')]]) {
      rows.append(h('tr', null, h('th', { scope: 'row' }, label), ...versions.map(r => h('td',
        { class: r.current ? 'current' : (r[key] || '') !== (current[key] || '') ? 'different' : '' }, r[key] || '—'))));
    }
    const numbers = [...new Set(versions.flatMap(r => (r.tracks || []).map(t => t.no)))].sort((a, b) => a - b);
    const track = (r, no) => (r.tracks || []).find(t => t.no === no);
    for (const no of numbers) {
      const base = track(current, no);
      rows.append(h('tr', { class: 'cd-info-track' }, h('th', { scope: 'row' }, T`曲目 ${String(no).padStart(2, '0')}`),
        ...versions.map(r => {
          const t = track(r, no), artist = t?.artist || r.artist || '';
          const different = (t?.title || '') !== (base?.title || '') || artist !== (base?.artist || current.artist || '');
          return h('td', { class: r.current ? 'current' : different ? 'different' : '' },
            t ? h('div', { class: 'cd-info-song' }, h('b', null, t.title || '—'), h('small', null, artist)) : '—');
        })));
    }
    body.append(h('table', { class: 'cd-info-table', style: { minWidth: (88 + versions.length * 244) + 'px' } }, h('thead', null, head), rows));
    body.scrollTop = scrollTop; body.scrollLeft = scrollLeft;
    if (focused) this.infoClose.focus({ preventScroll: true });
  },

  async findInfo() {
    const disc = this.infoDiscId;
    if (this.infoBusy || !this.infoEl || this.info?.disc?.id !== disc || this.info.disc.lookup === 'pending') return;
    this.infoBusy = true; this.infoError = ''; this.infoMessage = T('正在查找 CD 資訊…'); this.drawInfo();
    try { this.update(await Host.call('cd.lookup', { disc })); }
    catch (e) { if (this.infoDiscId === disc) this.infoError = T('查找失敗：') + e.message; }
    finally { this.infoBusy = false; this.infoMessage = ''; this.drawInfo(); }
  },

  async useInfo(release) {
    const disc = this.infoDiscId;
    if (this.infoBusy || !this.infoEl || this.info?.disc?.id !== disc || this.info.disc.lookup === 'pending') return;
    this.infoBusy = true; this.infoError = ''; this.infoMessage = T('正在套用選定的資訊…'); this.drawInfo();
    try {
      this.update(await Host.call('cd.release', { id: release.id, disc }));
      if (this.info?.disc?.id === disc) this.infoMessage = T`已選用「${release.title}」`;
    } catch (e) { if (this.infoDiscId === disc) { this.infoError = T('套用失敗：') + e.message; this.infoMessage = ''; } }
    finally { this.infoBusy = false; this.drawInfo(); }
  },

  closeInfo(fromPop) {
    if (!this.infoEl) return false;
    this.infoEl.remove(); this.infoEl = null;
    if (fromPop !== true) OverlayHistory.closed(this._closeInfo);
    const focus = this.infoReturnFocus?.isConnected ? this.infoReturnFocus : $('#view .cd-info-launch');
    focus?.focus({ preventScroll: true }); YT.sync();
    return true;
  },

  eject() {
    if (this.ripping) { toast(T('正在抓取光碟，先停止再退出'), { error: true }); return; }
    Host.call('cd.eject');
    toast(T('退出光碟…'));
  },

  lookupText() {
    const d = this.info && this.info.disc;
    if (!d) return '';
    return { pending: T('正在 MusicBrainz 查這張光碟…'), none: T('MusicBrainz 找不到這張光碟，可以在抓取時自己填名稱'), error: T('查不到光碟資料（網路？）'), found: '' }[d.lookup] || '';
  },

  /* ───────── the rip dialog ───────── */
  el: null,
  ripDialogOpen: false,

  async ripDialog() {
    if (this.el) { this.show(); return; }
    if (this.opening) return;
    const d = this.info && this.info.disc;
    if (!d) { toast(T('光碟機裡沒有音樂 CD'), { error: true }); return; }
    this.opening = true;
    let info;
    try { info = await Convert.loadInfo(); }
    catch (e) { toast(T('無法開啟抓取設定：') + e.message, { error: true }); return; }
    finally { this.opening = false; }
    if (this.info?.disc?.id !== d.id) { toast(T('光碟已變更，請重新開啟抓取設定')); return; }
    if (!info.ffmpeg) { toast(T('找不到 FFmpeg，無法抓取。'), { error: true }); return; }
    const p = Convert.prefs();
    const saved = (() => { try { return JSON.parse(uiPref('cdRip', '{}')); } catch { return {}; } })();
    const st = {
      format: info.formats.some(f => f.id === (saved.format || 'flac') && f.ok) ? (saved.format || 'flac') : 'flac',
      flacLevel: saved.flacLevel ?? 8, mp3: saved.mp3 || p.mp3, aacKbps: saved.aacKbps || p.aacKbps, opusKbps: saved.opusKbps || p.opusKbps,
      bits: 'keep', rate: 'keep', cover: saved.cover ?? true,
      dir: saved.dir || p.dir || '', offset: d.offset ?? null, offsetAuto: true,
      album: d.title, artist: d.artist, year: d.year ? String(d.year) : '', genre: '',
      tracks: d.tracks.map(t => ({ no: t.no, id: t.id, title: t.title, artist: t.artist === d.artist ? '' : t.artist, dur: t.dur, on: true })),
    };
    const scrim = h('div', { class: 'modal-scrim' });
    const modal = h('div', { class: 'modal cvt cdrip' });
    scrim.append(modal);
    scrim.onclick = e => { if (e.target === scrim) this.close(); };
    const opts = h('div', { class: 'cvt-opts' });
    const list = h('div', { class: 'cvt-list cd-list' });
    const status = h('div', { class: 'cvt-status muted' });
    const go = h('button', { class: 'btn primary', html: icon('disc') + T('開始抓取') });
    const cancel = h('button', { class: 'btn ghost' }, T('取消'));
    const background = h('button', { class: 'btn primary', hidden: true, onclick: () => this.close() }, T('背景執行'));
    const close = h('button', { class: 'icon-btn', title: T('關閉 (Esc)'), 'aria-label': T('關閉'), html: icon('x'), onclick: () => this.close() });
    modal.append(
      h('div', { class: 'modal-head' }, h('h2', null, T('抓取 CD · ') + (d.title || T('音樂 CD'))), close),
      h('div', { class: 'modal-body' }, opts, list),
      h('div', { class: 'cvt-foot' }, status, cancel, go, background));
    this.el = scrim;
    this._close = fromPop => this.close(fromPop);
    this.show();

    const sel = (options, value, fn) => { const el = h('select', { class: 'sel' }, ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l))); el.onchange = () => { fn(el.value); draw(); }; return el; };
    const line = (label, ...ctl) => h('div', { class: 'cvt-line' }, h('span', { class: 'cvt-k' }, label), h('div', { class: 'cvt-v' }, ...ctl));
    const input = (value, fn, ph, cls) => { const i = h('input', { class: 'inp ' + (cls || ''), value: value || '', placeholder: ph || '' }); i.oninput = () => fn(i.value); return i; };
    const lossless = id => ['flac', 'alac', 'wav'].includes(id);
    const validOffset = () => st.offsetAuto || (Number.isInteger(st.offset) && st.offset >= -2147483648 && st.offset <= 2147483647);
    const updateGo = () => { go.disabled = !st.dir || !st.tracks.some(t => t.on) || !validOffset() || this.ripping; };
    const rows = new Map();
    const draw = () => {
      opts.textContent = '';
      // names
      opts.append(line(T('專輯'), input(st.album, v => st.album = v, T('專輯名稱')), input(st.artist, v => st.artist = v, T('專輯演出者'))));
      opts.append(line('', input(st.year, v => st.year = v, T('年份'), 'cd-year'), input(st.genre, v => st.genre = v, T('類型'), 'cd-genre'),
        h('small', { class: 'muted' }, this.lookupText() || (d.release ? T('名稱來自 MusicBrainz，可以直接修改') : ''))));
      // format, as 轉換格式
      const group = (kind, label) => {
        const seg = h('div', { class: 'seg' });
        for (const f of info.formats.filter(f => lossless(f.id) === (kind === 'lossless')))
          seg.append(h('button', { class: f.id === st.format ? 'on' : '', disabled: !f.ok, onclick: () => { st.format = f.id; draw(); } }, f.name));
        return h('div', { class: 'cvt-fmt ' + kind }, h('span', { class: 'cvt-fmt-tag' }, label), seg);
      };
      opts.append(line(T('格式'), group('lossless', T('無損')), group('lossy', T('有損'))));
      if (st.format === 'flac') opts.append(line(T('壓縮等級'), sel([0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => [n, n === 5 ? T('5（預設）') : n === 8 ? T('8（最小）') : n === 0 ? T('0（最快）') : String(n)]), st.flacLevel, v => st.flacLevel = +v),
        h('small', { class: 'muted' }, T('數字越大檔案越小、轉換越慢；音質都一樣（無損）'))));
      if (st.format === 'mp3') opts.append(line(T('品質'), sel([['v0', T('VBR V0（約 245 kbps）')], ['v2', T('VBR V2（約 190 kbps）')], ['320', 'CBR 320 kbps'], ['256', 'CBR 256 kbps'], ['192', 'CBR 192 kbps']], st.mp3, v => st.mp3 = v)));
      if (st.format === 'aac') opts.append(line(T('位元率'), sel([[320, '320 kbps'], [256, '256 kbps'], [192, '192 kbps'], [128, '128 kbps']], st.aacKbps, v => st.aacKbps = +v)));
      if (st.format === 'opus') opts.append(line(T('位元率'), sel([[256, '256 kbps'], [192, '192 kbps'], [160, '160 kbps'], [128, '128 kbps'], [96, '96 kbps']], st.opusKbps, v => st.opusKbps = +v)));
      if (['flac', 'alac', 'mp3', 'aac'].includes(st.format)) {
        const sw = h('span', { class: 'switch' + (st.cover ? ' on' : ''), onclick: () => { st.cover = !st.cover; sw.classList.toggle('on', st.cover); } });
        opts.append(line(T('封面'), sw, h('small', { class: 'muted' }, d.cover ? T('把專輯封面放進檔案') : T('這張光碟還沒有封面'))));
      }
      // where
      const path = h('span', { class: 'cvt-path num', title: st.dir }, st.dir || T('還沒選擇'));
      opts.append(line(T('資料夾'), path, h('button', { class: 'btn small', html: icon('folder') + T('瀏覽…'), onclick: async () => {
        const x = await Host.call('convert.pickFolder', { dir: st.dir }).catch(() => null);
        if (x) { st.dir = x; draw(); }
      } })));
      opts.append(line('', h('small', { class: 'muted' }, T('自動建立以專輯名稱命名的子資料夾'))));
      // read offset
      const offsetMode = seg([['auto', T('自動（建議）')], ['manual', T('手動設定')]], st.offsetAuto ? 'auto' : 'manual', mode => {
        st.offsetAuto = mode === 'auto';
        if (!st.offsetAuto && st.offset == null) st.offset = d.offset ?? 0;
        draw();
      });
      let offIn, validation;
      if (!st.offsetAuto) {
        offIn = h('input', { class: 'inp cd-offset num', type: 'number', value: st.offset ?? '', step: 1,
          min: -2147483648, max: 2147483647, required: true, 'aria-label': T('光碟機讀取校正值（取樣點）') });
        validation = h('small', { class: 'cd-offset-error', role: 'status' });
        const validate = () => {
          offIn.setAttribute('aria-invalid', !validOffset());
          validation.textContent = validOffset() ? '' : T('請填入整數，或選「自動（建議）」。');
          updateGo();
        };
        offIn.oninput = () => { st.offset = offIn.value === '' ? null : offIn.valueAsNumber; validate(); };
        validate();
      }
      const autoText = d.offset != null
        ? T`使用這台光碟機已記住的校正值（${d.offset > 0 ? '+' : ''}${d.offset} 個取樣點）`
        : T('嘗試自動找出並記住校正值，查不到時使用 0');
      opts.append(line(T('讀取校正'), offsetMode, st.offsetAuto ? h('small', { class: 'muted' }, autoText) : offIn,
        st.offsetAuto ? null : h('small', { class: 'muted' }, T('取樣點（samples）')), validation));
      opts.append(line('', h('small', { class: 'muted cd-offset-help' }, T('校正光碟機讀取音訊的位置；0 代表不額外修正。一般保留「自動（建議）」即可，只有知道光碟機的校正值時才需手動填寫。'))));
      opts.append(line('', h('small', { class: 'muted cvt-warn' }, T('安全模式：每一段讀兩次比對，不一樣就重讀到兩次相同為止；抓完跟 AccurateRip 資料庫比對，確認跟其他人抓到的一模一樣。比一般抓取慢一倍左右。'))));
      updateGo();
    };
    // the tracks: tick, title, artist
    const all = h('span', { class: 'switch on', title: T('全選／全不選'), onclick: () => { const on = !st.tracks.every(t => t.on); st.tracks.forEach(t => { t.on = on; rows.get(t.id).tick.classList.toggle('on', on); }); all.classList.toggle('on', on); draw(); } });
    list.append(h('div', { class: 'cd-head' }, all, h('span', null, T`${st.tracks.length} 首`)));
    for (const t of st.tracks) {
      const tick = h('span', { class: 'switch on', onclick: () => { t.on = !t.on; tick.classList.toggle('on', t.on); draw(); } });
      const bar = h('i');
      const state = h('span', { class: 'cvt-state' }, fmtTime(t.dur));
      const row = h('div', { class: 'cvt-row cd-row' }, tick, h('span', { class: 'cd-no num' }, String(t.no).padStart(2, '0')),
        input(t.title, v => t.title = v, T('曲名')), input(t.artist, v => t.artist = v, st.artist || T('演出者（空白＝專輯演出者）')), state, h('div', { class: 'cvt-bar' }, bar));
      rows.set(t.id, { row, bar, state, tick });
      list.append(row);
    }
    draw();

    cancel.onclick = () => this.ripping ? this.stopRip() : this.close();
    go.onclick = async () => {
      const chosen = st.tracks.filter(t => t.on);
      if (!st.dir || !chosen.length || !validOffset() || this.ripping) return;
      this.ripping = true;
      this.stopping = false; this.stopButton = cancel;
      go.disabled = true; go.hidden = true; background.hidden = false; cancel.textContent = T('停止');
      close.title = T('收起，在背景繼續抓取 (Esc)'); close.setAttribute('aria-label', T('在背景繼續抓取'));
      opts.classList.add('locked'); list.classList.add('locked');
      setUiPref('cdRip', JSON.stringify({ format: st.format, flacLevel: st.flacLevel, mp3: st.mp3, aacKbps: st.aacKbps, opusKbps: st.opusKbps, cover: st.cover, dir: st.dir }));
      this.task = { title: st.album || T('音樂 CD'), state: 'run', text: T('準備中…'), pct: 0 };
      this.createTask();
      const finished = new Set(), progress = new Map(chosen.map(t => [t.id, 0]));
      const setStatus = text => { status.textContent = text; this.task.text = text; this.syncTask(); };
      const phase = { read: T('讀取'), encode: T('轉換') };
      this.onRip = p => {
        if (p.state === 'ar') setStatus(p.found ? T('AccurateRip：資料庫裡有這張光碟') : T('AccurateRip：資料庫裡沒有這張光碟'));
        if (p.state === 'offset') setStatus(T('找出光碟機的讀取偏移…'));
        if (p.state === 'offsetDone') setStatus(p.offset != null ? T`讀取偏移 ${p.offset > 0 ? '+' : ''}${p.offset}` : T('讀取偏移未知（用 0）'));
        const r = rows.get(p.id);
        if (!r) return;
        if (p.state === 'read' || p.state === 'encode') {
          const fraction = Math.max(0, Math.min(1, p.pct || 0)), pct = Math.round(fraction * 100);
          r.row.className = 'cvt-row cd-row run'; r.bar.style.width = pct + '%';
          r.state.textContent = `${phase[p.state]} ${pct}%`;
          if (p.state === 'read' && p.pct >= 0.5) r.state.textContent = T`比對 ${pct}%`;
          if (progress.has(p.id)) progress.set(p.id, Math.max(progress.get(p.id), p.state === 'read' ? fraction * .9 : .9 + fraction * .1));
          this.task.text = T`第 ${st.tracks.find(t => t.id === p.id).no} 首 · ${r.state.textContent}\n（完成 ${finished.size} / ${chosen.length} 首）`;
        } else if (p.state === 'done') {
          finished.add(p.id); progress.set(p.id, 1);
          r.bar.style.width = '100%';
          r.row.className = 'cvt-row cd-row done ar-' + p.ar;
          r.state.textContent = p.ar === 'match' ? `✓ AccurateRip ${p.conf}` : p.ar === 'mismatch' ? T('✗ AccurateRip 不符') : T('完成（不在 AccurateRip）');
          r.state.title = T`重讀 ${p.rereads} 次，讀不到的磁區 ${p.errors} 個`;
          setStatus(T`完成 ${finished.size} / ${chosen.length} 首`);
        } else if (p.state === 'fail') {
          r.row.className = 'cvt-row cd-row fail'; r.state.textContent = T('失敗'); r.state.title = T.msg(p.error) || '';
          progress.set(p.id, 1); this.task.text = T`第 ${st.tracks.find(t => t.id === p.id).no} 首抓取失敗，繼續其他曲目`;
        }
        this.task.pct = Math.min(99, Math.round([...progress.values()].reduce((a, b) => a + b, 0) / chosen.length * 100));
        this.syncTask();
      };
      setStatus(T('準備中…'));
      let r, error;
      try {
        r = await Host.call('cd.rip', {
          opts: { format: st.format, flacLevel: st.flacLevel, mp3: st.mp3, aacKbps: st.aacKbps, opusKbps: st.opusKbps, bits: 'keep', rate: 'keep', cover: st.cover, albumFolder: true },
          dir: st.dir, tracks: chosen.map(t => t.no), offset: st.offsetAuto ? null : st.offset,
          meta: { album: st.album, artist: st.artist, year: st.year, genre: st.genre, tracks: st.tracks.map(t => ({ no: t.no, title: t.title, artist: t.artist || st.artist })) },
        });
      } catch (e) { error = T('抓取失敗：') + e.message; if (this.ripDialogOpen) toast(error, { error: true }); }
      this.onRip = null; this.ripping = false; this.stopping = false; this.stopButton = null;
      cancel.textContent = T('關閉'); cancel.disabled = false; background.hidden = true;
      close.title = T('關閉 (Esc)'); close.setAttribute('aria-label', T('關閉'));
      if (!r) { this.task.state = 'error'; setStatus(error || T('抓取失敗')); go.remove(); return; }
      this.task.state = r.cancelled ? 'stopped' : (r.failed || []).length ? 'error' : 'done';
      if (!r.cancelled) this.task.pct = 100;
      setStatus((r.cancelled ? T`已停止：完成 ${r.done} 首` : T`完成 ${r.done} / ${r.total} 首`) + (r.ar ? T`，AccurateRip 相符 ${r.arMatched} 首` : '') + ((r.failed || []).length ? T`，失敗 ${r.failed.length} 首` : ''));
      if (this.ripDialogOpen && (r.failed || []).length) toast(T`${r.failed.length} 首沒有完成：\n` + r.failed.map(f => T`第 ${f.no} 首：${T.msg(f.error)}`).join('\n'), { error: true, ms: 12000 });
      if (r.done && r.dir) go.replaceWith(h('button', { class: 'btn primary', html: icon('folder') + T('打開資料夾'), onclick: () => Host.call('convert.open', { path: r.dir }) }));
      else go.remove();
    };
  },

  /** Keep the same dialog and its progress when the job runs in the background. */
  show() {
    if (!this.el || this.ripDialogOpen) return;
    this.returnFocus = document.activeElement;
    document.body.append(this.el); this.ripDialogOpen = true;
    OverlayHistory.push(this._close);
    this.syncTask(); YT.sync();
    this.el.querySelector('.modal-head .icon-btn').focus({ preventScroll: true });
  },

  createTask() {
    const task = this.task;
    task.detail = h('span', { class: 'cd-task-detail' });
    task.action = h('button', { class: 'btn small ghost', onclick: () => this.ripping ? this.stopRip() : this.close() });
    task.bar = h('i');
    task.percent = h('span', { class: 'cd-task-percent' });
    task.open = h('button', { class: 'cd-task-open', onclick: () => this.show() },
      h('span', { class: 'cd-task-icon', html: icon('disc') }),
      h('span', { class: 'cd-task-copy' }, h('b', null, task.title), task.detail), task.percent);
    task.progress = h('div', { class: 'cd-task-bar', role: 'progressbar', 'aria-label': T('CD 抓取進度'), 'aria-valuemin': 0, 'aria-valuemax': 100 }, task.bar);
    task.el = h('div', { class: 'cd-task', role: 'region', 'aria-label': T('CD 抓取') },
      task.open, task.action, task.progress);
    $('#sidebar').append(task.el);
    this.syncTask();
  },

  syncTask() {
    const task = this.task;
    if (!task) return;
    task.el.hidden = this.ripDialogOpen;
    task.el.className = 'cd-task ' + task.state;
    task.detail.textContent = this.stopping ? T('正在停止…') : task.text;
    task.open.title = T`${task.title}\n${task.detail.textContent}\n查看抓取詳情`;
    task.open.setAttribute('aria-label', task.open.title);
    task.action.textContent = this.ripping ? (this.stopping ? T('停止中…') : T('停止')) : T('關閉');
    task.action.disabled = this.stopping;
    task.bar.style.width = task.pct + '%';
    task.percent.textContent = task.pct + '%';
    task.progress.setAttribute('aria-valuenow', task.pct);
  },

  async stopRip() {
    if (!this.ripping || this.stopping) return;
    this.stopping = true;
    this.stopButton.disabled = true; this.stopButton.textContent = T('停止中…');
    this.syncTask();
    try { await Host.call('cd.cancel'); }
    catch (e) {
      if (!this.ripping) return;
      this.stopping = false;
      this.stopButton.disabled = false; this.stopButton.textContent = T('停止');
      this.task.text = T('無法停止抓取：') + e.message;
      this.syncTask(); if (this.ripDialogOpen) toast(this.task.text, { error: true });
    }
  },

  close(fromPop) {
    if (!this.el) return false;
    const visible = this.ripDialogOpen;
    this.el.remove(); this.ripDialogOpen = false;
    if (visible && fromPop !== true) OverlayHistory.closed(this._close);
    if (this.ripping) this.syncTask();
    else { this.el = null; this.task?.el.remove(); this.task = null; }
    if (visible && this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    YT.sync();
    return true;
  },
};

// the disc's album goes back into Lib after every reload
(() => {
  const load = Lib.load.bind(Lib);
  Lib.load = async function () { await load(); Cd.inject(); };
})();

// what's in the drive when the page starts (a disc found before the page was ready was not announced)
setTimeout(() => Cd.refresh(), 800);
setTimeout(() => Cd.refresh(), 4000);
