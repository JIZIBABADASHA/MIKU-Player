'use strict';
/* ═════════════════════════════ settings ═════════════════════════════ */
const Settings = {
  async set(patch) {
    Object.assign(App.settings, patch);
    const s = await Host.call('settings', patch);
    if (s) App.settings = Object.assign(App.settings, s);
    if (window.Outputs) Outputs.label();
  },

  render(view) {
    view.append(pageHead('設定'));
    const root = h('div', { class: 'settings' });
    view.append(root);
    const s = App.settings;

    const field = (title, sub, ctl) => h('div', { class: 'field' }, h('div', { class: 'lbl' }, h('b', null, title), sub ? h('small', null, sub) : null), h('div', { class: 'ctl' }, ctl));
    const sw = (on, fn) => { const el = h('span', { class: 'switch' + (on ? ' on' : '') }); el.onclick = () => { const v = !el.classList.contains('on'); el.classList.toggle('on', v); fn(v); }; return el; };
    const select = (opts, val, fn) => { const el = h('select', { class: 'sel' }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val) }, l))); el.onchange = () => fn(el.value); return el; };
    const section = (title, hint) => { const el = h('div', { class: 'sect' }, h('h2', null, title), hint ? h('div', { class: 'hint' }, hint) : null); root.append(el); return el; };

    /* ── appearance ── */
    if (typeof Theme !== 'undefined') Theme.section(root);

    /* ── audio output ── */
    const out = section('音訊輸出', '獨佔模式可繞過 Windows 混音器；是否保持原始樣本，還取決於取樣率、DSP、音量與輸出格式。實際設定可查看訊號路徑。');
    if (!App.ffmpeg) out.append(h('div', { class: 'warn' }, '找不到 FFmpeg。請安裝 FFmpeg（例如 winget install Gyan.FFmpeg），或把 ffmpeg.exe 放在 MIKU.exe 旁邊。'));
    const usingRplay = (s.audioCore || 'miku') === 'rplay';
    let maxDsdField = null;   // Rplay's DSD limit, hidden in WASAPI shared mode with the other DSD settings
    const schemes = App.rplay ? [['miku', 'FFmpeg'], ['rplay', 'Rplay']] : [['miku', 'FFmpeg']];
    out.append(field('播放方案', '切換時會從目前位置繼續播放。',
      select(schemes, usingRplay ? 'rplay' : 'miku', async v => { await this.set({ audioCore: v }); Router.render(); })));
    if (usingRplay) {
      out.append(field('Rplay 相容模式', '修正模式使用 Rplay 的修正；原行為模式沿用作者研究中記錄的行為，供比對使用。',
        select([['fixed', '修正模式'], ['original', '原行為模式']], /origin/.test(s.rplayProfile || '') ? 'original' : 'fixed', v => this.set({ rplayProfile: v }))));
      out.append(field('最高 DSD 取樣率', '超過此上限的 DSD 會轉成 PCM。請依 DAC 與驅動實際支援的格式選擇。',
        select([[64, 'DSD64'], [128, 'DSD128'], [256, 'DSD256'], [512, 'DSD512']], s.rplayMaxDsd || 512, v => this.set({ rplayMaxDsd: +v }))));
      maxDsdField = out.lastChild;
    }
    const modeSeg = seg([['exclusive', 'WASAPI 獨佔'], ['shared', 'WASAPI 共享'], ['asio', 'ASIO']], s.outputMode, v => { this.set({ outputMode: v }); redrawDevices(); drawDsd(); applyMode(); });
    out.append(field('輸出模式', null, modeSeg));
    const devHost = h('div');
    out.append(devHost);
    const redrawDevices = async () => {
      devHost.textContent = '';
      devHost.append(field('輸出裝置', '讀取中…', h('div', { class: 'sk', style: { width: '260px', height: '36px' } })));
      const d = await Host.call('devices');
      devHost.textContent = '';
      if (!d) return;
      if (App.settings.outputMode === 'asio') {
        if (!d.asio.length) devHost.append(field('ASIO 驅動程式', '沒有找到已安裝的 ASIO 驅動程式。', null));
        else devHost.append(field('ASIO 驅動程式', 'DAC 廠商提供的 ASIO 驅動（例如 TOPPING USB Audio）。', select(d.asio.map(n => [n, n]), App.settings.asioDriver || d.asio[0], v => this.set({ asioDriver: v }))));
        return;
      }
      const opts = d.devices.map(x => [x.id, x.name + (x.isDefault ? '（預設）' : '')]);
      const cur = App.settings.deviceId || (d.devices.find(x => x.isDefault) || {}).id;
      const capsTxt = h('small', null, d.caps ? (App.settings.outputMode === 'shared' ? `系統混音格式 ${khz(d.caps.mixRate)} kHz · ${d.caps.mixChannels} 聲道` : '獨佔格式：' + d.caps.summary) : '');
      const fieldEl = h('div', { class: 'field' }, h('div', { class: 'lbl' }, h('b', null, '輸出裝置'), capsTxt),
        h('div', { class: 'ctl' },
          select(opts, cur, async v => { await this.set({ deviceId: v }); redrawDevices(); }),
          h('button', { class: 'icon-btn', title: '重新偵測支援格式', html: icon('refresh'), onclick: async () => { await Host.call('probe', { id: cur }); redrawDevices(); toast('已重新偵測裝置'); } })));
      devHost.append(fieldEl);
      if (d.caps && App.settings.outputMode === 'exclusive' && d.caps.rates.length) {
        const chips = h('div', { class: 'chips', style: { padding: '0 22px 14px' } });
        d.caps.rates.forEach(r => chips.append(h('span', { class: 'chip', title: (d.caps.formats[r] || []).join('、') }, khz(r) + ' kHz')));
        devHost.append(chips);
      }
      this.caps = d.caps;
    };
    redrawDevices();
    out.append(field('緩衝大小', '較大的緩衝更穩定；較小的緩衝反應更快。', (() => {
      const r = h('input', { class: 'range', type: 'range', min: 40, max: 500, step: 10, value: s.bufferMs });
      const v = h('span', { class: 'num muted', style: { width: '58px', textAlign: 'right' } }, s.bufferMs + ' ms');
      r.oninput = () => v.textContent = r.value + ' ms';
      r.onchange = () => this.set({ bufferMs: +r.value });
      return [r, v];
    })()));
    out.append(field(usingRplay ? 'Rplay 升頻' : 'FFmpeg 升頻', usingRplay ? '使用 Rplay 的重取樣處理；關閉時優先使用原始取樣率。' : '使用 SoX 高品質重新取樣。關閉時優先使用原始取樣率，實際取樣率請查看訊號路徑。', [
      select([['off', '關閉（原始取樣率）'], ['2x', '2 倍'], ['max', '同族最高取樣率'], ['fixed', '固定取樣率']], s.upsampling, v => { this.set({ upsampling: v }); fixedSel.style.display = v === 'fixed' ? '' : 'none'; }),
    ]));
    const fixedSel = select([44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000].map(r => [r, khz(r) + ' kHz']), s.fixedRate, v => this.set({ fixedRate: +v }));
    fixedSel.style.display = s.upsampling === 'fixed' ? '' : 'none';
    out.lastChild.querySelector('.ctl').append(fixedSel);
    const upField = out.lastChild;
    // DSD 播放方式: the choices depend on the output (and the core): ASIO with Rplay can send native DSD
    const dsdHost = h('div', { style: { display: 'contents' } });
    const drawDsd = () => {
      const mode = App.settings.outputMode, cur = App.settings;
      const pref = ['native', 'dop', 'pcm'].includes(cur.dsdMode) ? cur.dsdMode : (cur.dop ? 'dop' : 'native');
      const pcm = '轉成 PCM 播放，可以使用數位音量與 DSP';
      // each choice with its own description; only the chosen one's is shown
      let opts, value;
      if (mode === 'asio' && usingRplay) {
        opts = [['native', 'Native', '以 ASIO 原生 DSD 直接送到 DAC'], ['dop', 'DoP', '把 DSD 包在 24-bit PCM 裡送出，DAC 需支援 DoP'], ['pcm', 'PCM', pcm]];
        value = pref;
      } else if (mode === 'asio') {
        opts = [['pcm', 'PCM', 'MIKU 核心的 ASIO 輸出不支援 DSD 直送，DSD 會轉成 PCM 播放' + (App.rplay ? '；要用 Native 或 DoP，請把播放方案切換到 Rplay' : '')]];
        value = 'pcm';
      } else {
        opts = [['dop', 'DoP', '把 DSD 包在 24-bit PCM 裡送出，DAC 需支援 DoP，只在獨佔模式有效'], ['pcm', 'PCM', pcm]];
        value = pref === 'dop' ? 'dop' : 'pcm';
      }
      const desc = (opts.find(o => o[0] === value) || opts[0])[2];
      dsdHost.replaceChildren(field('DSD 播放方式', desc, select(opts.map(o => [o[0], o[1]]), value, v => { this.set({ dsdMode: v }); drawDsd(); })));
    };
    drawDsd();
    out.append(dsdHost);
    if (usingRplay) out.append(field('DSD 轉 PCM', '使用 Rplay 的轉換策略，再依輸出裝置支援的取樣率調整。', h('span', { class: 'muted' }, 'Rplay 自動選擇')));
    else out.append(field('DSD 轉 PCM 取樣率', 'DSD 播放方式選 PCM，或 DAC 不支援 DSD 直送時使用。', select([[88200, '88.2 kHz'], [176400, '176.4 kHz'], [352800, '352.8 kHz']], s.dsdPcmRate, v => this.set({ dsdPcmRate: +v }))));
    const dsdPcmField = out.lastChild;
    // WASAPI shared: Windows' mixer always converts to the system format, so upsampling and DSD settings do nothing there
    const sharedNote = field('升頻與 DSD', '共享模式由 Windows 混音器轉成系統格式輸出，升頻與 DSD 設定不會作用；要使用這些設定請改用獨佔模式或 ASIO。', null);
    out.append(sharedNote);
    const applyMode = () => {
      const shared = App.settings.outputMode === 'shared';
      for (const el of [upField, dsdHost, dsdPcmField, maxDsdField].filter(Boolean)) el.style.display = shared ? 'none' : (el === dsdHost ? 'contents' : '');
      sharedNote.style.display = shared ? '' : 'none';
    };
    applyMode();
    out.append(field('無縫播放', '同格式曲目之間沒有間隙（Live 專輯、古典樂）。', sw(s.gapless, v => this.set({ gapless: v }))));

    /* ── auto continue ── */
    const cont = section('自動續播', '播放佇列播完後不要停，繼續從曲庫隨機挑音樂來播。重複播放開啟時不會作用。');
    cont.append(field('佇列播完後', '隨機專輯：整張專輯從頭播完再換下一張；隨機歌曲：每次挑幾首不同專輯的歌。最近播過的會盡量避開。',
      select([['off', '停止播放'], ['albums', '隨機播放其他專輯'], ['tracks', '隨機播放其他歌曲']], s.autoContinue || 'off', v => this.set({ autoContinue: v }))));

    /* ── scrolling ── */
    if (window.SmoothScroll) {
      const sc = section('捲動');
      sc.append(field('滾輪一次捲動行數', '滑鼠滾輪每轉一格捲動的距離（1 行約 40 像素）。', (() => {
        const r = h('input', { class: 'range', type: 'range', min: 1, max: 15, step: 1, value: SmoothScroll.lines });
        const v = h('span', { class: 'num muted', style: { width: '58px', textAlign: 'right' } }, SmoothScroll.lines + ' 行');
        r.oninput = () => { v.textContent = r.value + ' 行'; SmoothScroll.lines = r.value; };
        return [r, v];
      })()));
    }

    /* ── volume ── */
    const vol = section('音量');
    vol.append(field('音量控制方式', '數位音量在 64-bit 運算中處理；硬體音量交給 DAC；固定音量不調整數位增益。是否原樣輸出仍取決於其餘訊號路徑。',
      select([['digital', '數位音量'], ['hardware', 'DAC 硬體音量'], ['fixed', '固定 0 dB（不調整數位增益）']], s.volumeMode, v => this.set({ volumeMode: v }))));
    vol.append(field('ReplayGain', '依標籤中的增益值讓曲目音量一致。', [
      select([['off', '關閉'], ['track', '依曲目'], ['album', '依專輯']], s.replayGain, v => this.set({ replayGain: v })),
    ]));

    /* ── library ── */
    const lib = section('曲庫', `${Lib.albums.length} 張專輯 · ${Lib.tracks.length} 首曲目`);
    const folderBox = h('div');
    const drawFolders = () => {
      folderBox.textContent = '';
      (App.settings.folders || []).forEach(p => folderBox.append(h('div', { class: 'folder' }, h('span', { html: icon('folder') }), h('span', { class: 'p', title: p }, p),
        h('button', { class: 'icon-btn', title: '移除', html: icon('trash'), onclick: async () => { App.settings.folders = await Host.call('folder.remove', { path: p }); drawFolders(); } }))));
    };
    drawFolders();
    lib.append(folderBox, h('div', { class: 'field' }, h('div', { class: 'lbl' }),
      h('div', { class: 'ctl' },
        h('button', { class: 'btn small', html: icon('plus') + '加入資料夾', onclick: async () => { const f = await Host.call('folder.add'); if (f) { App.settings.folders = f; drawFolders(); } } }),
        h('button', { class: 'btn small', html: icon('refresh') + '重新掃描', onclick: () => { Host.call('rescan'); toast('開始掃描曲庫'); } }),
        h('button', { class: 'btn small ghost', onclick: () => { Host.call('rescan', { full: true }); toast('開始完整掃描（重新讀取所有標籤）'); } }, '完整重掃'))));

    /* ── online ── */
    const on = section('線上服務', '只會傳送演出者、專輯與曲名，不會上傳音樂檔案。');
    on.append(field('自動補上專輯封面', '沒有封面的音樂會從 Apple Music、Deezer、MusicBrainz 搜尋高解析封面。', sw(s.onlineArt, v => this.set({ onlineArt: v }))));
    on.append(field('演出者照片', '從 Deezer 取得演出者照片。', sw(s.artistImages, v => this.set({ artistImages: v }))));
    on.append(field('線上歌詞', '沒有本機 LRC 時，從 LRCLIB 與網易雲音樂取得同步歌詞。', sw(s.onlineLyrics, v => this.set({ onlineLyrics: v }))));
    on.append(field('歌詞翻譯', '日文或英文歌曲顯示中文翻譯（如果有）。', sw(s.lyricsTranslation, v => this.set({ lyricsTranslation: v }))));
    const jobTxt = h('small', null, '一次搜尋所有缺少封面的專輯。');
    const jobBtn = h('button', { class: 'btn small', html: icon('image') + '開始搜尋' });
    let running = false;
    jobBtn.onclick = () => {
      if (running) { Host.call('art.cancel'); return; }
      running = true; jobBtn.innerHTML = '停止'; Host.call('art.fetchMissing');
    };
    Host.on('artJob', p => {
      if (!jobTxt.isConnected) return;
      if (p.done < 0) { running = false; jobBtn.innerHTML = icon('image') + '開始搜尋'; jobTxt.textContent = '搜尋完成。'; return; }
      jobTxt.textContent = `已檢查 ${p.done} / ${p.total} 張，找到 ${p.found} 張封面`;
    });
    on.append(field('補齊所有缺少的封面', jobTxt, jobBtn));
    const lyTxt = h('small', null, '一次為曲庫裡所有歌曲搜尋歌詞，已有歌詞的會略過。');
    const lyBtn = h('button', { class: 'btn small', html: icon('search') + '開始搜尋' });
    let lyRunning = false;
    lyBtn.onclick = () => {
      if (lyRunning) { Host.call('lyrics.cancel'); return; }
      if (!App.settings.onlineLyrics) { toast('請先開啟「線上歌詞」'); return; }
      lyRunning = true; lyBtn.innerHTML = '停止'; lyTxt.textContent = '準備中…'; Host.call('lyrics.fetchAll');
    };
    Host.on('lyricsJob', p => {
      if (!lyTxt.isConnected) return;
      if (p.done < 0) { lyRunning = false; lyBtn.innerHTML = icon('search') + '開始搜尋'; lyTxt.textContent += '（已結束）'; return; }
      lyTxt.textContent = `已檢查 ${p.done} / ${p.total} 首，${p.found} 首有歌詞`;
    });
    on.append(field('搜尋所有歌詞', lyTxt, lyBtn));

    /* ── phone remote ── */
    const rm = section('手機遙控', '手機和這台電腦連同一個 Wi-Fi，用瀏覽器打開下面的網址就能選歌、控制播放。聲音一樣從這台電腦的 DAC 播出。');
    const rmBox = h('div');
    rm.append(field('啟用手機遙控', '關閉後手機就無法連線。', sw(s.remoteEnabled !== false, async v => { await this.set({ remoteEnabled: v }); setTimeout(drawRemote, 300); })));
    rm.append(field('連接埠', '一般不用改；被其他程式占用時再換一個（1024–65535）。', (() => {
      const inp = h('input', { class: 'sel', type: 'number', min: 1024, max: 65535, value: s.remotePort || 8765, style: { width: '110px' } });
      inp.onchange = async () => { const v = Math.max(1024, Math.min(65535, +inp.value || 8765)); inp.value = v; await this.set({ remotePort: v }); setTimeout(drawRemote, 300); };
      return inp;
    })()));
    rm.append(rmBox);
    const drawRemote = async () => {
      const r = await Host.call('remote.info');
      rmBox.textContent = '';
      if (!r) return;
      if (r.enabled && !r.running) rmBox.append(h('div', { class: 'warn' }, '遙控伺服器沒有啟動：' + (r.error || '未知錯誤')));
      if (r.running) {
        // QR code for the selected address (several when the PC has more than one network)
        const qrBox = h('div', { style: { background: '#fff', borderRadius: '12px', padding: '6px', lineHeight: '0', flex: 'none' } });
        const urlList = h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' } });
        const pick = u => {
          try { qrBox.innerHTML = QR.svg(u, 168); } catch (e) { qrBox.textContent = ''; }
          urlList.querySelectorAll('button').forEach(b => b.style.opacity = b.dataset.u === u ? '1' : '.5');
        };
        r.urls.forEach(u => urlList.append(h('button', { 'data-u': u, style: { fontSize: '16px', fontWeight: '700', letterSpacing: '.02em', userSelect: 'text', cursor: 'pointer' }, onclick: () => pick(u) }, u)));
        if (r.urls.length > 1) urlList.append(h('small', { class: 'muted' }, '有多個網址時，點一下切換 QR code'));
        rmBox.append(h('div', { class: 'field' }, h('div', { class: 'lbl' }, h('b', null, '用手機掃描 QR code'),
          h('small', null, 'iPhone 用相機掃描，在 Safari 打開後按「分享 → 加入主畫面」就能像 App 一樣使用。第一次連線若 Windows 跳出防火牆提示，請勾選「私人網路」並允許。')),
          r.urls.length
            ? h('div', { class: 'ctl', style: { alignItems: 'center', gap: '18px' } }, urlList, qrBox)
            : h('div', { class: 'ctl' }, h('span', { class: 'muted' }, '找不到區域網路位址，請確認已連上 Wi-Fi 或有線網路。'))));
        if (r.urls.length) pick(r.urls[0]);
        if (r.code) rmBox.append(field('目前的配對碼', '手機上輸入這組數字完成配對（3 分鐘內有效）。', h('b', { style: { fontSize: '22px', letterSpacing: '.2em' } }, r.code)));
      }
      if (r.devices.length) {
        r.devices.forEach(d => rmBox.append(h('div', { class: 'folder' }, h('span', { html: icon('headphones') }),
          h('span', { class: 'p' }, `${d.name} · 最後連線 ${new Date(d.lastSeen).toLocaleString()}${d.lastIp ? ' · ' + d.lastIp : ''}`),
          h('button', { class: 'icon-btn', title: '取消配對', html: icon('trash'), onclick: async () => { await Host.call('remote.revoke', { id: d.id }); drawRemote(); } }))));
      } else if (r.running) rmBox.append(h('div', { class: 'hint', style: { padding: '0 22px 14px' } }, '還沒有配對的裝置。'));
    };
    drawRemote();
    Host.on('remoteChanged', () => { if (rmBox.isConnected) drawRemote(); });
    Host.on('remotePair', () => { if (rmBox.isConnected) drawRemote(); });

    /* ── about ── */
    const ab = section('關於');
    ab.append(field('MIKU', `版本 ${App.version || '1.0'} · FFmpeg ${App.ffmpeg ? '已就緒' : '未找到'}`, h('button', { class: 'btn small ghost', onclick: () => Host.call('devtools') }, '開發者工具')));
    ab.append(field('快捷鍵', '空白鍵 播放/暫停 · ←/→ 快轉 5 秒 · Ctrl+↑/↓ 音量 · L 歌詞 · Q 佇列 · D DSP · M 靜音 · Ctrl+F 搜尋', null));
  },
};
