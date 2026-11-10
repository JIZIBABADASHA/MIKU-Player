'use strict';
/* 遠端音樂庫 (Windows and Mac). The library of MIKU on another computer (e.g. a Windows PC at home) (Library/RemoteLibrary.cs, mac main/remote-library.js): pairing and options in
 * 設定 → 曲庫, a 這台電腦 / 遠端 switch under 音樂庫 in the sidebar, 離線下載 in an album's menu, and the progress
 * of a song being copied over before it plays. */
const RemoteLib = {
  info: null,

  async init() {
    Host.on('remoteLib', i => this.update(i));
    try { this.update(await Host.call('remoteLib.info')); } catch (e) { console.error('[remoteLib]', e); }
    // an album of the other computer: keep it on this one / remove it again
    (MikuExt.menus.album = MikuExt.menus.album || []).push(al => {
      const i = this.info;
      if (!i || !i.paired || !this.isRemote(al)) return [];
      const ids = new Set(i.offlineIds), have = al.tracks.filter(t => ids.has(t.id)).length;
      const items = [];
      if (have < al.tracks.length) items.push({ label: have ? T`下載其餘 ${al.tracks.length - have} 首到這台電腦` : T('下載到這台電腦（離線聽）'), icon: 'down', run: () => this.download(al) });
      if (have) items.push({ label: T('移除離線下載'), icon: 'trash', run: () => this.remove(al) });
      return items;
    });
  },

  isRemote(al) { return !!(this.info && this.info.active && al && !al.cd); },

  async download(al) {
    try {
      const r = await Host.call('remoteLib.download', { id: al.id });
      toast(r && r.queued ? T`開始下載「${al.title}」（${r.queued} 首）` : T`「${al.title}」已經在這台電腦上了`);
    } catch (e) { toast(T.msg(e.message), { error: true }); }
  },
  async remove(al) {
    await Host.call('remoteLib.removeOffline', { id: al.id });
    toast(T`已移除「${al.title}」的離線下載`);
  },

  update(i) {
    const was = this.info;
    this.info = i;
    if (!i) return;
    this.drawSwitch();
    this.drawLoading();
    if (was && was.downloading && !i.downloading) toast(i.error && /下載失敗/.test(i.error) ? T.msg(i.error) : T('離線下載完成'), { error: !!(i.error && /下載失敗/.test(i.error)) });
    if (this.box && this.box.isConnected) this.drawSettings();
  },

  /* ── sidebar: 這台電腦 / 遠端 ── */
  drawSwitch() {
    const i = this.info;
    let el = $('#rl-src');
    if (!i.paired) { if (el) el.remove(); return; }
    if (!el) {
      const label = [...document.querySelectorAll('#nav .nav-label')].find(x => !x.id);   // 音樂庫
      if (!label) return;
      el = h('div', { id: 'rl-src', class: 'rl-src' },
        h('button', { 'data-v': 'mac', onclick: () => this.setActive(false) }, T('這台電腦')),
        h('button', { 'data-v': 'pc', onclick: () => this.setActive(true) }, T('遠端')));
      label.after(el);
    }
    el.querySelector('[data-v="mac"]').classList.toggle('on', !i.active);
    const pc = el.querySelector('[data-v="pc"]');
    pc.classList.toggle('on', i.active);
    pc.classList.toggle('off', !i.online);
    pc.title = i.online ? T('遠端電腦上的音樂庫') : T('遠端電腦目前連不上：只能播放已下載的歌');
  },
  async setActive(on) {
    if (!!this.info.active === on) return;
    this.update(await Host.call('remoteLib.active', { on }));
    toast(on ? (this.info.online ? T('正在顯示遠端電腦上的音樂庫') : T('遠端電腦目前連不上，只能播放已下載到這台電腦的歌')) : T('正在顯示這台電腦的音樂庫'));
  },

  /* ── a song being copied over before it plays ── */
  drawLoading() {
    const l = this.info.loading;
    let el = $('#rl-loading');
    if (!l || !l.total && !l.got) { if (el) { el.classList.add('out'); setTimeout(() => el.remove(), 260); el.id = ''; } return; }
    if (!el) { el = h('div', { id: 'rl-loading', class: 'toast rl-loading' }); $('#toasts').append(el); }
    const mb = n => (n / 1048576).toFixed(n > 104857600 ? 0 : 1);
    el.textContent = l.total ? T`正在從遠端取得「${l.title}」… ${Math.floor(l.got * 100 / l.total)}%（${mb(l.got)} / ${mb(l.total)} MB）`
      : T`正在從遠端取得「${l.title}」… ${mb(l.got)} MB`;
  },

  /* ── 設定 → 曲庫 ── */
  section(section, field, sw, select) {
    const sect = section(T('遠端音樂庫'), T('連到另一台電腦上的 MIKU，瀏覽並播放它的音樂庫。歌由這台電腦的 MIKU 播放，音質設定和 Bit-perfect 都照常運作。兩台都安裝 Tailscale 並登入同一個帳號，出門在外也能用。'));
    this.box = h('div');
    this.parts = { section, field, sw, select };
    sect.append(this.box);
    this.drawSettings();
    Host.call('remoteLib.info').then(i => this.update(i)).catch(() => { });
  },

  drawSettings() {
    const { field, sw, select } = this.parts, i = this.info, box = this.box;
    if (!i) return;
    const focus = document.activeElement && box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (focus) return;   // don't redraw under the cursor (a progress update while a code is typed)
    box.textContent = '';
    const gb = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB';
    const err = msg => box.append(h('div', { class: 'warn' }, T.msg(msg)));

    if (!i.paired) {
      const url = h('input', { class: 'sel', placeholder: '100.x.x.x:8765', value: i.url ? i.url.replace(/^http:\/\//, '') : '', style: { width: '220px' } });
      const code = h('input', { class: 'sel', placeholder: '0000', inputmode: 'numeric', maxlength: 4, style: { width: '90px', letterSpacing: '.2em' } });
      const status = h('small', { class: 'muted' });
      const ask = h('button', { class: 'btn small', onclick: async () => {
        ask.disabled = true; status.textContent = T('連線中…');
        try { await Host.call('remoteLib.pair', { url: url.value }); status.textContent = T('另一台電腦的 MIKU 會跳出 4 位數配對碼，請在右邊輸入。'); codeRow.style.display = ''; code.focus(); }
        catch (e) { status.textContent = T.msg(e.message); }
        ask.disabled = false;
      } }, T('取得配對碼'));
      const ok = h('button', { class: 'btn small', onclick: async () => {
        ok.disabled = true;
        try { const r = await Host.call('remoteLib.confirm', { code: code.value }); this.update(r); toast(T`配對完成，共 ${r.albums} 張專輯`); }
        catch (e) { status.textContent = T.msg(e.message); ok.disabled = false; }
      } }, T('配對'));
      code.onkeydown = e => { if (e.key === 'Enter') ok.click(); };
      url.onkeydown = e => { if (e.key === 'Enter') ask.click(); };
      box.append(field(T('另一台 MIKU 的網址'), T('在另一台電腦的 MIKU 打開 設定 → 其他 → 手機遙控，抄下網址（外出用請選 100. 開頭的 Tailscale 網址）。第一次配對請在家裡的網路或 Tailscale 內進行。'),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' } }, url, ask)));
      const codeRow = field(T('配對碼'), null, h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, code, ok));
      codeRow.style.display = i.pairing ? '' : 'none';
      box.append(codeRow, h('div', { class: 'hint', style: { padding: '0 22px 14px' } }, status));
      if (i.error) err(i.error);
      return;
    }

    box.append(field(T('連線的 MIKU'), i.online ? T`已連線 · ${i.url.replace(/^http:\/\//, '')} · ${i.albums} 張專輯 · ${i.tracks} 首`
        : T`目前連不上 ${i.url.replace(/^http:\/\//, '')}（電腦要開著、MIKU 在執行、Tailscale 已連線）。已下載的歌照樣能播。`,
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', { class: 'btn small ghost', html: icon('refresh') + T('重新整理'), onclick: async () => { this.update(await Host.call('remoteLib.refresh')); } }),
        h('button', { class: 'btn small ghost', onclick: async () => { this.update(await Host.call('remoteLib.unpair')); } }, T('取消配對')))));
    box.append(field(T('顯示遠端的音樂庫'), T('開啟時，專輯、演出者、曲目和資料夾顯示另一台電腦上的歌；也可以用側邊欄「音樂庫」下面的切換。'),
      sw(i.active, v => this.setActive(v))));
    box.append(field(T('播放音質'), T('原始檔：和另一台電腦上的檔案完全一樣（無損、Hi-Res、DSD 都保留）。省流量：由另一台電腦用 FFmpeg 轉成 MP3 再傳過來，適合手機網路分享；本來就是 MP3 / AAC 的歌照原樣傳。'),
      select([['orig', T('原始檔')], ['320', T('省流量 · 320 kbps')], ['192', T('更省 · 192 kbps')]], i.quality, async v => this.update(await Host.call('remoteLib.set', { quality: v })))));
    box.append(field(T('暫存空間'), T`聽過的歌會暫存在這台電腦，再聽就不用重新下載，超過上限時先清掉最久沒聽的。目前使用 ${gb(i.cacheBytes)}。`,
      h('div', { style: { display: 'flex', gap: '8px' } },
        select([[2, '2 GB'], [5, '5 GB'], [10, '10 GB'], [20, '20 GB'], [50, '50 GB']], i.cacheGB, async v => this.update(await Host.call('remoteLib.set', { cacheGB: +v }))),
        h('button', { class: 'btn small ghost', onclick: async () => { this.update(await Host.call('remoteLib.clearCache')); toast(T('已清除暫存')); } }, T('清除')))));
    const dl = i.downloading;
    box.append(field(T('離線下載'), dl ? T`正在下載「${dl.title}」（${dl.done + 1} / ${dl.total}）`
        : i.offline.length ? T`${i.offline.length} 張專輯 · ${gb(i.offlineBytes)}，沒有網路也能聽。` : T('在專輯上按右鍵（或 ⋯ 按鈕）選「下載到這台電腦」，出門沒有網路也能聽。下載的是原始檔。'), null));
    for (const a of i.offline) box.append(h('div', { class: 'folder' }, h('span', { html: icon('album') }),
      h('span', { class: 'p', title: a.title }, `${a.title} · ${a.artist}`, h('small', { class: 'muted', style: { marginLeft: '8px' } }, a.have < a.count ? T`${a.have} / ${a.count} 首 · ${gb(a.bytes)}` : gb(a.bytes))),
      h('button', { class: 'icon-btn', title: T('移除離線下載'), html: icon('trash'), onclick: async () => { this.update(await Host.call('remoteLib.removeOffline', { id: a.id })); } })));
    if (i.error && !i.online) err(i.error);
  },
};

document.head.append(h('style', null, `
.rl-src { display: flex; gap: 2px; margin: 0 10px 6px; padding: 2px; border-radius: 9px; background: var(--surface-2, rgba(255,255,255,.06)); }
.rl-src button { flex: 1; font-size: 12px; padding: 4px 6px; border-radius: 7px; color: var(--text-2); white-space: nowrap; }
.rl-src button:hover { color: var(--text-hi); }
.rl-src button.on { background: var(--teal, #39c5bb); color: #fff; font-weight: 600; }
.rl-src button.off::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 5px; border-radius: 50%; background: #e0a030; vertical-align: middle; }
@media (max-width: 1180px) { .rl-src { display: none; } }
`));

document.addEventListener('DOMContentLoaded', () => {
  // after MIKU's own start (core.js App.init: Host is ready once the page asked for 'ready')
  const go = () => (typeof App !== 'undefined' && App.settings ? RemoteLib.init() : setTimeout(go, 200));
  go();
}, { once: true });
