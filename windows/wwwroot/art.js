'use strict';
/* ═════════════════════════════ artwork picker ═════════════════════════════ */
const ArtPicker = {
  _searchResults: Host.on('artSearch', p => ArtPicker.onSearch && ArtPicker.onSearch(p)),
  searchSeq: 0,
  cancelSearch(notify = true) {
    const search = this.searchKey;
    this.searchKey = null; this.onSearch = null;
    clearTimeout(this.searchTimer); clearTimeout(this.slowTimer);
    if (notify && search) Host.call('art.searchCancel', { search }).catch(() => { });
  },
  /** Album cover (album page). */
  open(al) {
    this.show({
      heading: T`更換封面 · ${al.title}`,
      query: `${searchArtist((al.artists || [al.artist]).join(';'))} ${al.title}`.trim(),
      searching: T('搜尋中…（Apple Music、Deezer、MusicBrainz）'),
      info: () => Host.call('art.info', { id: al.id }),
      candidates: (q, search) => Host.call('art.candidates', { id: al.id, q, search }),
      setUrl: url => Host.call('art.setUrl', { id: al.id, url }),
      setData: data => Host.call('art.setData', { id: al.id, data }),
      clear: () => Host.call('art.clear', { id: al.id }),
      restoreLabel: T('還原原始封面'), restored: T('已還原原始封面'), applied: T('已更換封面'),
      after: () => App.refreshNowArt('a', al.id),
    });
  },
  /** Artist picture (artist page): Deezer artist photos and album covers, a URL or a picture of your own. */
  openArtist(name) {
    this.show({
      heading: T`更換演出者圖片 · ${name}`,
      query: name,
      searching: T('搜尋中…（Deezer 演出者照片、Apple Music／Deezer 專輯封面）'),
      info: () => Host.call('artistArt.info', { name }),
      candidates: (q, search) => Host.call('artistArt.candidates', { name, q, search }),
      setUrl: url => Host.call('artistArt.setUrl', { name, url }),
      setData: data => Host.call('artistArt.setData', { name, data }),
      clear: () => Host.call('artistArt.clear', { name }),
      restoreLabel: T('還原自動圖片'), restored: T('已還原自動取得的圖片'), applied: T('已更換演出者圖片'),
      after: () => { },
    });
  },
  show(o) {
    this.close();
    const scrim = h('div', { class: 'modal-scrim' });
    const modal = h('div', { class: 'modal' });
    scrim.append(modal);
    scrim.onclick = e => { if (e.target === scrim) this.close(); };
    const query = h('input', { class: 'inp', value: o.query, spellcheck: 'false' });
    const url = h('input', { class: 'inp', placeholder: T('貼上圖片網址（https://…jpg）'), spellcheck: 'false' });
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const grid = h('div', { class: 'cand-grid' });
    const status = h('div', { class: 'muted', style: { padding: '30px 0', textAlign: 'center' } });
    const body = h('div', { class: 'modal-body' }, status, grid);
    const restore = h('button', { class: 'btn small ghost', style: { display: 'none' }, onclick: async () => { await o.clear(); toast(o.restored); this.close(); } }, o.restoreLabel);
    modal.append(
      h('div', { class: 'modal-head' }, h('h2', null, o.heading), restore, h('button', { class: 'icon-btn', html: icon('x'), onclick: () => this.close() })),
      h('div', { class: 'modal-tools' }, query, h('button', { class: 'btn small primary', html: icon('search') + T('重新搜尋'), onclick: () => search(query.value) })),
      h('div', { class: 'modal-tools' }, url,
        h('button', { class: 'btn small', html: icon('link') + T('使用網址'), onclick: () => useUrl(url.value) }),
        h('button', { class: 'btn small', html: icon('image') + T('選擇圖片檔'), onclick: () => file.click() }), file),
      h('div', { class: 'modal-hint' }, T('點一張圖就會套用。也可以直接按 Ctrl+V 貼上複製的圖片。')),
      body);
    document.body.append(scrim);
    this.el = scrim;
    OverlayHistory.push(this._close = fromPop => this.close(fromPop));
    YT.sync();
    o.info().then(i => { if (i && i.source === 'override') restore.style.display = ''; }).catch(() => { });

    const done = () => { toast(o.applied); o.after(); if (this.el === scrim) this.close(); };
    const useUrl = async u => {
      u = (u || '').trim();
      if (!/^https?:\/\//i.test(u)) { toast(T('請貼上 http(s) 開頭的圖片網址'), { error: true }); return; }
      this.cancelSearch();
      status.textContent = T('下載圖片中…');
      try { await o.setUrl(u); done(); }
      catch (e) { status.textContent = ''; toast(T('無法使用這個網址：') + e.message, { error: true }); }
    };
    const useBlob = blob => {
      const fr = new FileReader();
      fr.onload = async () => {
        if (this.el !== scrim) return;
        this.cancelSearch();
        status.textContent = T('套用圖片中…');
        try { await o.setData(fr.result); done(); }
        catch (e) { status.textContent = ''; toast(T('無法使用這張圖片：') + e.message, { error: true }); }
      };
      fr.readAsDataURL(blob);
    };
    file.onchange = () => { if (file.files[0]) useBlob(file.files[0]); };
    url.onkeydown = e => { if (e.key === 'Enter') useUrl(url.value); };
    query.onkeydown = e => { if (e.key === 'Enter') search(query.value); };
    this.onPaste = e => {
      const items = [...(e.clipboardData?.items || [])];
      const img = items.find(i => i.type.startsWith('image/'));
      if (img) { e.preventDefault(); useBlob(img.getAsFile()); return; }
      const text = e.clipboardData?.getData('text') || '';
      if (/^https?:\/\/\S+$/i.test(text.trim()) && document.activeElement !== url && document.activeElement !== query) { e.preventDefault(); url.value = text.trim(); useUrl(text); }
    };
    document.addEventListener('paste', this.onPaste);

    const apply = async (c, card) => {
      this.cancelSearch();
      card && card.classList.add('busy');
      try { await o.setUrl(c.url); done(); }
      catch (e) { card && card.classList.remove('busy'); toast(T('下載失敗：') + e.message, { error: true }); }
    };
    const seen = new Set();
    const addCards = list => {
      const added = [];
      for (const c of list || []) {
        if (!c.url || seen.has(c.url) || seen.size >= 60) continue;
        seen.add(c.url);
        const img = new Image();
        img.onload = () => img.classList.add('ok');
        img.src = c.thumb;
        const size = h('span', { class: 'dim' }, c.size || '');
        const zoom = h('button', { class: 'cand-zoom', title: T('放大檢視'), html: icon('search') });
        const card = h('div', { class: 'cand', title: `${c.title || ''} — ${c.artist || ''}` },
          h('div', { class: 'im' }, img, zoom),
          h('div', { class: 't' }, c.title || ''),
          h('div', { class: 's' }, `${c.artist || ''}`),
          h('div', { class: 's' }, `${c.source} · `, size));
        c.sizeEl = size;
        zoom.onclick = e => { e.stopPropagation(); CoverView.preview(c, () => apply(c, card)); };
        card.onclick = () => apply(c, card);
        grid.append(card);
        added.push(c);
      }
      // the real pixel size, read from each picture's header ("1400×1400" instead of the requested 1600px)
      if (added.length) Host.call('art.dims', { urls: added.map(c => c.url) }).then(d => {
        for (const c of added) if (d && d[c.url]) { c.size = d[c.url]; c.sizeEl.textContent = d[c.url]; c.sizeEl.classList.add('real'); }
      }).catch(() => { });
    };
    const initialQuery = query.value;
    let lastQuery = null;
    const search = async q => {
      q = q.trim();
      if (this.el === scrim && this.searchKey && lastQuery === q) return;
      this.cancelSearch();
      lastQuery = q;
      const key = this.searchKey = 'art-' + Date.now() + '-' + ++this.searchSeq;
      const current = () => this.el === scrim && scrim.isConnected && this.searchKey === key;
      grid.textContent = ''; seen.clear();
      status.textContent = o.searching;
      const paint = (pending, timedOut = false) => {
        status.textContent = seen.size
          ? T`找到 ${seen.size} 張封面` + (pending ? T('，正在補充其他結果…') : timedOut ? T('；部分來源回應較慢，可以重新搜尋。') : '')
          : pending ? o.searching : timedOut ? T('搜尋逾時，請重新搜尋，或貼上圖片網址／選擇圖片檔。')
          : T('找不到結果，換個關鍵字試試，或貼上圖片網址／選擇圖片檔。');
      };
      this.onSearch = p => {
        if (!current() || p.search !== key) return;
        addCards(p.items || []);
        paint(true);
      };
      this.slowTimer = setTimeout(() => {
        if (current()) status.textContent = seen.size ? T`找到 ${seen.size} 張封面，其他來源回應較慢…` : T('搜尋來源回應較慢，仍在嘗試…');
      }, 6000);
      this.searchTimer = setTimeout(() => {
        if (!current()) return;
        paint(false, true);
        this.cancelSearch();
      }, 22000);
      try {
        const r = await o.candidates(q === initialQuery ? null : q, key);
        if (!current()) return;
        addCards(Array.isArray(r) ? r : r && r.items || []);
        paint(false, !!(r && r.timedOut));
      } catch (e) {
        if (current()) status.textContent = seen.size ? T`已保留 ${seen.size} 張封面；其他結果搜尋失敗，可以重新搜尋。` : T('搜尋失敗：') + e.message;
      } finally {
        if (current()) this.cancelSearch(false);
      }
    };
    search(query.value);
    setTimeout(() => query.focus(), 50);
  },
  close(fromPop) {
    if (!this.el) return false;
    this.cancelSearch();
    const back = this.back; this.back = null;
    document.removeEventListener('paste', this.onPaste);
    this.el.remove(); this.el = null;
    if (fromPop !== true) OverlayHistory.closed(this._close);
    YT.sync();
    if (fromPop === true && back) back();   // the mouse back button: back to the cover view it was opened from
    return true;
  },
};

/* ═════════════════════════════ cover view ═════════════════════════════
   The album page's cover, large (click on it): the picture, where it comes from and its size, and from there
   更換封面 / 編輯標籤. Also a candidate in the cover picker, before choosing it. */
const CoverView = {
  el: null,
  _progress: Host.on('tagsProgress', p => CoverView.onProgress && CoverView.onProgress(p)),
  show(build) {
    this.close();
    const img = new Image();
    img.className = 'cv-img';
    img.onload = () => img.classList.add('ok');
    const info = h('div', { class: 'cv-info' });
    const btns = h('div', { class: 'cv-btns' });
    const box = h('div', { class: 'cv-box' }, h('div', { class: 'cv-frame' }, img), info, btns);
    const scrim = h('div', { class: 'cv-scrim' }, box);
    scrim.onclick = e => { if (e.target === scrim || e.target.classList.contains('cv-frame')) this.close(); };
    document.body.append(scrim);
    this.el = scrim;
    OverlayHistory.push(this._close = fromPop => this.close(fromPop));
    YT.sync();
    build(img, info, btns);
  },
  /** The album page cover. */
  open(al) {
    const [kind, id] = albumArt(al);
    this.show((img, info, btns) => {
      // the shown size first (cached), then the large one
      img.src = artUrl(kind, id, 300);
      const big = new Image();
      big.onload = () => { if (img.isConnected) img.src = big.src; };
      big.src = artUrl(kind, id, Math.min(1600, Math.round(Math.min(innerWidth, innerHeight) * 0.8)));
      const src = h('span'), dims = h('span', { class: 'num' });
      info.append(h('b', null, al.title), h('div', { class: 'cv-sub' }, src, dims));
      const embed = h('button', { class: 'btn small', style: { display: 'none' }, html: icon('check') + T('<span>寫入音樂檔案</span>') });
      embed.onclick = () => this.embed(al, embed, src);
      Host.call('art.info', { id: al.id, dims: true }).then(i => {
        if (!i) return;
        src.textContent = { override: T('自訂封面（只在 MIKU）'), embedded: T('音樂檔內嵌封面'), folder: T('資料夾裡的圖片'), online: T('自動從網路找到'), none: T('沒有封面') }[i.source] || '';
        if (i.dims) dims.textContent = ' · ' + i.dims;
        // a picture that isn't in the music files yet: offer to embed it
        if (['override', 'online', 'folder'].includes(i.source)) { embed.style.display = ''; embed.title = T('把這張封面嵌入專輯的每個音樂檔，其他播放器也看得到'); }
      }).catch(() => { });
      btns.append(embed,
        // opened from here, the back button comes back here
        h('button', { class: 'btn small primary', html: icon('image') + T('更換封面'), onclick: () => { this.close(); ArtPicker.open(al); ArtPicker.back = () => this.open(al); } }),
        h('button', { class: 'btn small', html: icon('list') + T('編輯標籤'), onclick: () => { this.close(); TagEditor.back = { id: al.id, fn: () => this.open(al) }; TagEditor.open(al); } }),
        h('button', { class: 'btn small ghost', onclick: () => this.close() }, T('關閉')));
    });
  },
  /** Writes the picture the album shows now into its files (tags.save with cover "current"); asks once first. */
  async embed(al, btn, src) {
    const label = btn.querySelector('span');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.classList.add('primary');
      label.textContent = T`確定寫入 ${al.tracks.length} 個檔案？`;
      return;
    }
    btn.disabled = true;
    label.textContent = T('寫入中…');
    const off = p => { if (btn.isConnected) label.textContent = T`寫入中… ${p.done} / ${p.total}`; };
    this.onProgress = off;
    let r;
    try { r = await Host.call('tags.save', { id: al.id, tracks: [], cover: { mode: 'current' } }); }
    catch (e) { toast(T('寫入失敗：') + e.message, { error: true }); btn.disabled = false; delete btn.dataset.armed; btn.classList.remove('primary'); label.textContent = T('寫入音樂檔案'); return; }
    finally { this.onProgress = null; }
    const failed = r.failed || [];
    if (failed.length) toast(T`${failed.length} 個檔案沒有寫入：\n` + failed.slice(0, 6).map(f => T`${f.file}：${T.msg(f.error)}`).join('\n'), { error: true, ms: 12000 });
    if (r.written) toast(T`已把封面寫入 ${r.written} 個檔案`);
    btn.remove();
    if (src && src.isConnected && r.written) src.textContent = T('音樂檔內嵌封面');
    await Lib.load();
    App.trackKey = null;
  },

  /** A candidate of the cover picker: large, with its real size, and 使用這張. */
  preview(c, use) {
    this.show((img, info, btns) => {
      img.src = c.thumb;
      const big = new Image();
      const dims = h('span', { class: 'num' }, c.size || '');
      big.onload = () => { if (img.isConnected) { img.src = big.src; dims.textContent = `${big.naturalWidth}×${big.naturalHeight}`; } };
      big.src = c.url;
      info.append(h('b', null, c.title || ''), h('div', { class: 'cv-sub' }, [c.artist, c.source].filter(Boolean).join(' · ') + ' · ', dims));
      btns.append(
        h('button', { class: 'btn small primary', html: icon('check') + T('使用這張'), onclick: () => { this.close(); use(); } }),
        h('button', { class: 'btn small ghost', onclick: () => this.close() }, T('返回')));
    });
  },
  close(fromPop) {
    if (!this.el) return false;
    this.el.remove(); this.el = null;
    if (fromPop !== true) OverlayHistory.closed(this._close);
    YT.sync();
    return true;
  },
};

/** Banner on the album page asking to confirm an automatically found cover. */
async function artNote(al, meta) {
  let info;
  try { info = await Host.call('art.info', { id: al.id }); } catch { return; }
  if (!info || !meta.isConnected) return;
  let note = null;
  if (info.source === 'online' && !info.confirmed) {
    note = h('div', { class: 'art-note' }, T('封面是自動從網路找到的，正確嗎？'),
      h('button', { class: 'btn small primary', html: icon('check') + T('正確'), onclick: () => { Host.call('art.confirm', { id: al.id }); note.remove(); } }),
      h('button', { class: 'btn small', onclick: async () => { await Host.call('art.reject', { id: al.id }); note.remove(); ArtPicker.open(al); } }, T('不對，換一張')));
  } else if (info.source === 'none') {
    note = h('div', { class: 'art-note' }, T('這張專輯還沒有封面'),
      h('button', { class: 'btn small primary', html: icon('search') + T('搜尋封面'), onclick: () => ArtPicker.open(al) }));
  }
  if (note) meta.append(note);
}

/* ═════════════════════════════ output switcher ═════════════════════════════ */
const shortDevice = n => { const m = /^[^(（]+[(（](.+)[)）]\s*$/.exec(n || ''); return (m ? m[1] : n || '').trim(); };
const Outputs = {
  data: null,
  async refresh() {
    try { this.data = await Host.call('devices'); } catch { }
    this.label();
  },
  label() {
    const s = App.settings, d = this.data;
    let name = T('輸出');
    if (s.outputMode === 'asio') name = s.asioDriver || (d && d.asio[0]) || 'ASIO';
    else if (d) {
      const dev = d.devices.find(x => x.id === s.deviceId) || d.devices.find(x => x.isDefault);
      if (dev) name = shortDevice(dev.name);
    }
    $('#b-outname').textContent = name;
    $('#b-out').title = T('輸出：') + name + T('（') + ({ exclusive: T('WASAPI 獨佔'), shared: T('WASAPI 共享'), asio: 'ASIO' }[s.outputMode] || '') + T('）');
  },
  /** A device was connected / removed or the system output changed: refresh the picker and the settings page. */
  changed() {
    clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => {
      this.refresh();
      if (typeof Settings !== 'undefined' && Settings.redrawDevices) Settings.redrawDevices();
    }, 400);
  },
  async toggle(anchor) {
    if (Popover.el && Popover.el.classList.contains('outpop')) return Popover.close();
    const box = h('div');
    // A tab switches the output mode at once (keeping the device), like the setting on the settings page. Only the
    // ASIO tab without any installed driver just shows that there is nothing to switch to.
    let mode = App.settings.outputMode;
    const modeName = { exclusive: T('WASAPI 獨佔'), shared: T('WASAPI 共享'), asio: 'ASIO' };
    const pick = async (patch, name) => {
      Popover.close();
      await Settings.set({ outputMode: mode, ...patch });
      this.label();
      toast(T('已切換到 ') + name + T('（') + modeName[mode] + T('）'));
      this.refresh();
    };
    const switchMode = async v => {
      mode = v;
      const d = this.data || { devices: [], asio: [] };
      if (v === App.settings.outputMode || (v === 'asio' && !d.asio.length)) { draw(); return; }
      await Settings.set({ outputMode: v });
      this.label();
      toast(T('已切換到 ') + modeName[v]);
      await this.refresh();
      if (Popover.el && Popover.el.contains(box)) draw();
    };
    const draw = () => {
      box.textContent = '';
      const s = App.settings, d = this.data || { devices: [], asio: [] };
      const current = mode === s.outputMode;   // the tab of the mode in use: its device is marked
      box.append(h('h3', { html: icon('speaker') + T('輸出裝置') }));
      box.append(seg([['exclusive', T('獨佔')], ['shared', T('共享')], ['asio', 'ASIO']], mode, v => { switchMode(v); }));
      if (mode === 'asio') {
        if (!d.asio.length) box.append(h('div', { class: 'muted', style: { padding: '8px' } }, T('沒有找到 ASIO 驅動程式')));
        d.asio.forEach(n => {
          const on = current && (s.asioDriver || d.asio[0]) === n;
          box.append(h('button', { class: 'outrow' + (on ? ' on' : ''), onclick: () => pick({ asioDriver: n }, n) },
            h('span', { html: icon('speaker') }), h('span', { class: 'nm' }, h('b', null, n), h('small', null, 'ASIO'))));
        });
      } else {
        const cur = s.deviceId || (d.devices.find(x => x.isDefault) || {}).id;
        // 獨佔 lists only devices that take exclusive streams (the one in use stays, marked, if it doesn't)
        const list = mode === 'exclusive' ? d.devices.filter(x => x.exclusive !== false || (current && x.id === cur)) : d.devices;
        if (mode === 'exclusive' && !list.length) box.append(h('div', { class: 'muted', style: { padding: '8px' } }, T('沒有支援獨佔模式的裝置')));
        list.forEach(x => {
          const on = current && x.id === cur;
          const noExcl = mode === 'exclusive' && x.exclusive === false;
          const sub = noExcl ? T('不支援獨佔，以共享模式播放')
            : on && d.caps ? (mode === 'shared' ? T`系統格式 ${khz(d.caps.mixRate)} kHz` : T.msg(d.caps.summary)) : (x.isDefault ? T('Windows 預設') : '');
          box.append(h('button', { class: 'outrow' + (on ? ' on' : ''), onclick: () => pick({ deviceId: x.id }, shortDevice(x.name)) },
            h('span', { html: icon('speaker') }), h('span', { class: 'nm' }, h('b', null, shortDevice(x.name)), h('small', null, sub))));
        });
      }
    };
    draw();
    Popover.show(box, anchor, { cls: 'outpop', above: true, align: 'right' });
    await this.refresh();
    if (Popover.el && Popover.el.contains(box)) draw();
  },
};
Host.on('devicesChanged', () => Outputs.changed());
