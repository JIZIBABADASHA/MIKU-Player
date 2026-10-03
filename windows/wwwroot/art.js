'use strict';
/* ═════════════════════════════ artwork picker ═════════════════════════════ */
const ArtPicker = {
  /** Album cover (album page). */
  open(al) {
    this.show({
      heading: `更換封面 · ${al.title}`,
      query: `${al.artist === 'Various Artists' ? '' : al.artist} ${al.title}`.trim(),
      searching: '搜尋中…（Apple Music、Deezer、MusicBrainz）',
      info: () => Host.call('art.info', { id: al.id }),
      candidates: q => Host.call('art.candidates', { id: al.id, q }),
      setUrl: url => Host.call('art.setUrl', { id: al.id, url }),
      setData: data => Host.call('art.setData', { id: al.id, data }),
      clear: () => Host.call('art.clear', { id: al.id }),
      restoreLabel: '還原原始封面', restored: '已還原原始封面', applied: '已更換封面',
      after: () => App.refreshNowArt('a', al.id),
    });
  },
  /** Artist picture (artist page): Deezer artist photos and album covers, a URL or a picture of your own. */
  openArtist(name) {
    this.show({
      heading: `更換演出者圖片 · ${name}`,
      query: name,
      searching: '搜尋中…（Deezer 演出者照片、Apple Music／Deezer 專輯封面）',
      info: () => Host.call('artistArt.info', { name }),
      candidates: q => Host.call('artistArt.candidates', { name, q }),
      setUrl: url => Host.call('artistArt.setUrl', { name, url }),
      setData: data => Host.call('artistArt.setData', { name, data }),
      clear: () => Host.call('artistArt.clear', { name }),
      restoreLabel: '還原自動圖片', restored: '已還原自動取得的圖片', applied: '已更換演出者圖片',
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
    const url = h('input', { class: 'inp', placeholder: '貼上圖片網址（https://…jpg）', spellcheck: 'false' });
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const grid = h('div', { class: 'cand-grid' });
    const status = h('div', { class: 'muted', style: { padding: '30px 0', textAlign: 'center' } });
    const body = h('div', { class: 'modal-body' }, status, grid);
    const restore = h('button', { class: 'btn small ghost', style: { display: 'none' }, onclick: async () => { await o.clear(); toast(o.restored); this.close(); } }, o.restoreLabel);
    modal.append(
      h('div', { class: 'modal-head' }, h('h2', null, o.heading), restore, h('button', { class: 'icon-btn', html: icon('x'), onclick: () => this.close() })),
      h('div', { class: 'modal-tools' }, query, h('button', { class: 'btn small primary', html: icon('search') + '重新搜尋', onclick: () => search(query.value) })),
      h('div', { class: 'modal-tools' }, url,
        h('button', { class: 'btn small', html: icon('link') + '使用網址', onclick: () => useUrl(url.value) }),
        h('button', { class: 'btn small', html: icon('image') + '選擇圖片檔', onclick: () => file.click() }), file),
      h('div', { class: 'modal-hint' }, '點一張圖就會套用。也可以直接按 Ctrl+V 貼上複製的圖片。'),
      body);
    document.body.append(scrim);
    this.el = scrim;
    OverlayHistory.push(this._close = fromPop => this.close(fromPop));
    YT.sync();
    o.info().then(i => { if (i && i.source === 'override') restore.style.display = ''; }).catch(() => { });

    const done = () => { toast(o.applied); o.after(); this.close(); };
    const useUrl = async u => {
      u = (u || '').trim();
      if (!/^https?:\/\//i.test(u)) { toast('請貼上 http(s) 開頭的圖片網址', { error: true }); return; }
      status.textContent = '下載圖片中…';
      try { await o.setUrl(u); done(); }
      catch (e) { status.textContent = ''; toast('無法使用這個網址：' + e.message, { error: true }); }
    };
    const useBlob = blob => {
      const fr = new FileReader();
      fr.onload = async () => {
        status.textContent = '套用圖片中…';
        try { await o.setData(fr.result); done(); }
        catch (e) { status.textContent = ''; toast('無法使用這張圖片：' + e.message, { error: true }); }
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

    const search = async q => {
      grid.textContent = '';
      status.textContent = o.searching;
      let list = [];
      try { list = await o.candidates(q === this.firstQuery ? null : q); }
      catch (e) { status.textContent = '搜尋失敗：' + e.message; return; }
      if (!this.el) return;
      status.textContent = list && list.length ? '' : '找不到結果，換個關鍵字試試，或貼上圖片網址 / 圖片。';
      (list || []).forEach(c => {
        const img = new Image();
        img.onload = () => img.classList.add('ok');
        img.src = c.thumb;
        const card = h('div', { class: 'cand', title: `${c.title || ''} — ${c.artist || ''}` },
          h('div', { class: 'im' }, img),
          h('div', { class: 't' }, c.title || ''),
          h('div', { class: 's' }, `${c.artist || ''}`),
          h('div', { class: 's' }, `${c.source} · ${c.size}`));
        card.onclick = async () => {
          card.classList.add('busy');
          try { await o.setUrl(c.url); done(); }
          catch (e) { card.classList.remove('busy'); toast('下載失敗：' + e.message, { error: true }); }
        };
        grid.append(card);
      });
    };
    this.firstQuery = query.value;
    search(query.value);
    setTimeout(() => query.focus(), 50);
  },
  close(fromPop) {
    if (!this.el) return false;
    document.removeEventListener('paste', this.onPaste);
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
    note = h('div', { class: 'art-note' }, '封面是自動從網路找到的，正確嗎？',
      h('button', { class: 'btn small primary', html: icon('check') + '正確', onclick: () => { Host.call('art.confirm', { id: al.id }); note.remove(); } }),
      h('button', { class: 'btn small', onclick: async () => { await Host.call('art.reject', { id: al.id }); note.remove(); ArtPicker.open(al); } }, '不對，換一張'));
  } else if (info.source === 'none') {
    note = h('div', { class: 'art-note' }, '這張專輯還沒有封面',
      h('button', { class: 'btn small primary', html: icon('search') + '搜尋封面', onclick: () => ArtPicker.open(al) }));
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
    let name = '輸出';
    if (s.outputMode === 'asio') name = s.asioDriver || (d && d.asio[0]) || 'ASIO';
    else if (d) {
      const dev = d.devices.find(x => x.id === s.deviceId) || d.devices.find(x => x.isDefault);
      if (dev) name = shortDevice(dev.name);
    }
    $('#b-outname').textContent = name;
    $('#b-out').title = '輸出：' + name + '（' + ({ exclusive: 'WASAPI 獨佔', shared: 'WASAPI 共享', asio: 'ASIO' }[s.outputMode] || '') + '）';
  },
  async toggle(anchor) {
    if (Popover.el && Popover.el.classList.contains('outpop')) return Popover.close();
    const box = h('div');
    const draw = () => {
      box.textContent = '';
      const s = App.settings, d = this.data || { devices: [], asio: [] };
      box.append(h('h3', { html: icon('speaker') + '輸出裝置' }));
      box.append(seg([['exclusive', '獨佔'], ['shared', '共享'], ['asio', 'ASIO']], s.outputMode, async v => { await Settings.set({ outputMode: v }); this.label(); draw(); }));
      if (s.outputMode === 'asio') {
        if (!d.asio.length) box.append(h('div', { class: 'muted', style: { padding: '8px' } }, '沒有找到 ASIO 驅動程式'));
        d.asio.forEach(n => {
          const on = (s.asioDriver || d.asio[0]) === n;
          box.append(h('button', { class: 'outrow' + (on ? ' on' : ''), onclick: async () => { await Settings.set({ asioDriver: n }); this.label(); Popover.close(); toast('已切換到 ' + n); } },
            h('span', { html: icon('speaker') }), h('span', { class: 'nm' }, h('b', null, n), h('small', null, 'ASIO'))));
        });
      } else {
        const cur = s.deviceId || (d.devices.find(x => x.isDefault) || {}).id;
        d.devices.forEach(x => {
          const on = x.id === cur;
          const sub = on && d.caps ? (s.outputMode === 'shared' ? `系統格式 ${khz(d.caps.mixRate)} kHz` : d.caps.summary) : (x.isDefault ? 'Windows 預設' : '');
          box.append(h('button', { class: 'outrow' + (on ? ' on' : ''), onclick: async () => {
            Popover.close();
            await Settings.set({ deviceId: x.id });
            toast('已切換到 ' + shortDevice(x.name));
            this.refresh();
          } }, h('span', { html: icon('speaker') }), h('span', { class: 'nm' }, h('b', null, shortDevice(x.name)), h('small', null, sub))));
        });
      }
    };
    draw();
    Popover.show(box, anchor, { cls: 'outpop', above: true, align: 'right' });
    await this.refresh();
    if (Popover.el && Popover.el.contains(box)) draw();
  },
};
