'use strict';
/* ═════════════════════════════ updates and extension modules ═════════════════════════════
 * 設定 → 其他 → 更新與擴充套件: MIKU's own updates and its extension modules from the GitHub Releases (the host's
 * update.* calls: windows/Host/Updater.cs, mac/app/main/updater.js). Shared by both settings pages.
 */
const Updates = {
  // the modules MIKU knows by name; another one shows its id
  known: {
    daphne: ['Daphne', '選用的播放內核，提供自己的音訊處理與播放設定。'],
    moodchannels: ['MoodWave', '依心情自動分台，佇列播完後接著放適合的歌。'],
  },
  toasted: null,

  /** The section in 設定 → 其他. */
  section(section, field, sw) {
    const up = section(T('更新與擴充套件'));
    up.append(field(T('自動更新'), T('啟動後與每 6 小時檢查 GitHub 上的新版 MIKU，並在背景下載；要安裝時再由你按下按鈕。'),
      sw(App.settings.autoUpdate !== false, v => Settings.set({ autoUpdate: v }))));
    const box = h('div');
    up.append(box);
    let last = null;
    const draw = info => { if (info) last = info; if (last && box.isConnected) this.draw(box, field, last); };
    Host.on('update', draw);
    Host.call('update.info').then(info => {
      draw(info);
      // the first look at this page: ask GitHub (the modules this version offers come from its Release)
      if (info && !info.checkedAt && !info.busy) Host.call('update.check').then(draw, () => { });
    }, () => { });
  },

  draw(box, field, i) {
    box.textContent = '';
    const busy = !!i.busy;
    const run = (m, a) => Host.call(m, a).then(info => info && this.draw(box, field, info), e => toast(e.message, { error: true }));
    const pct = i.progress != null ? ` ${Math.round(i.progress * 100)}%` : '';
    let status;
    if (i.busy === 'checking') status = T('正在檢查…');
    else if (i.busy === 'download') status = T('正在下載新版本…') + pct;
    else if (i.busy === 'module') status = T('正在下載擴充套件…') + pct;
    else if (i.busy === 'install') status = T('正在準備安裝…');
    else if (i.error) status = T.msg(i.error);
    else if (i.ready) status = T`新版本 ${i.latest} 已下載完成`;
    else if (i.missing) status = T`新版本 ${i.latest} 還沒有這個系統的安裝檔`;
    else if (i.newer) status = T`有新版本 ${i.latest}`;
    else if (i.checkedAt) status = T`已是最新版本 · 上次檢查 ${new Date(i.checkedAt).toLocaleString()}`;
    else status = T('尚未檢查');
    const btns = h('div', { style: { display: 'flex', gap: '8px' } });
    if (i.newer && !i.missing) btns.append(h('button', { class: 'btn small primary', disabled: busy, onclick: () => run('update.install', { lang: I18N.lang }) },
      App.platform === 'mac' ? T('安裝新版本') : T('安裝並重新啟動')));
    btns.append(h('button', { class: 'btn small ghost', disabled: busy, onclick: () => run('update.check') }, T('檢查更新')));
    box.append(field(T`MIKU ${i.version}`, h('small', { style: i.error && !busy ? { color: 'var(--pink-text)' } : null }, status), btns));
    if (i.newer && !i.missing && App.platform === 'mac')
      box.append(h('div', { class: 'hint', style: { padding: '0 22px 10px' } }, T('會開啟 macOS 的安裝程式並結束 MIKU；裝好後再打開 MIKU 即可。')));

    /* ── extension modules ── */
    box.append(h('div', { class: 'hint', style: { padding: '14px 22px 4px' } },
      T('擴充套件下載與這個 MIKU 版本一起編譯好的檔案，不需要自己編譯；安裝或移除在重新啟動 MIKU 後生效。')));
    if (!i.extensions.length) box.append(h('div', { class: 'hint', style: { padding: '0 22px 14px' } },
      i.checkedAt ? T('這個版本的 Release 沒有提供擴充套件。') : T('按「檢查更新」取得可安裝的擴充套件。')));
    for (const x of i.extensions) {
      const [name, desc] = this.known[x.id] || [x.id, ''];
      let state, act = [];
      const undo = h('button', { class: 'btn small ghost', disabled: busy, onclick: () => run('update.undo', { id: x.id }) }, T('復原'));
      const add = label => h('button', { class: 'btn small', disabled: busy, onclick: () => run('update.addModule', { id: x.id }) }, label);
      if (x.pending === 'remove') { state = T('重新啟動後移除'); act = [undo]; }
      else if (x.pending === 'install') { state = x.installed ? T('重新啟動後更新') : T('重新啟動後安裝'); act = [undo]; }
      else if (x.builtIn) state = T('已內建於這個 MIKU');
      else if (x.installed) {
        // built for another MIKU (installed before an update, or by an older installer): this version's may be needed
        const stale = x.build && x.build !== i.version;
        state = stale ? T`已安裝 · 為 MIKU ${x.build} 編譯，建議更新` : T('已安裝');
        if (stale && x.available) act.push(add(T('更新')));
        act.push(h('button', { class: 'btn small ghost', disabled: busy, onclick: () => run('update.removeModule', { id: x.id }) }, T('移除')));
      } else if (x.available) { state = T('未安裝'); act = [add(T('安裝'))]; }
      else state = T('這個版本沒有已編譯的檔案');
      box.append(field(name, desc ? [T(desc), h('br'), state] : state, h('div', { style: { display: 'flex', gap: '8px' } }, ...act)));
    }
    if (i.restart) box.append(field(T('重新啟動 MIKU'), T('套用擴充套件的變更。'),
      h('button', { class: 'btn small primary', disabled: busy, onclick: () => Host.call('update.restart') }, T('立即重新啟動'))));
  },
};

// a new MIKU downloaded in the background: said once, wherever the page is
Host.on('update', i => {
  if (!i || !i.ready || Updates.toasted === i.latest) return;
  Updates.toasted = i.latest;
  toast(T`MIKU ${i.latest} 已下載，可到「設定 → 其他」安裝`);
});
