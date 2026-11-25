'use strict';
/* Shared Windows / Mac appearance preferences. Audio settings are independent. */
const PageEffects = {
  kinds: ['signal', 'card', 'album', 'page', 'ambient', 'vinyl', 'blur', 'scroll',
    'gold-coins', 'gold-shine', 'neon-rain', 'poster-film', 'poster-rays', 'terminal-crt', 'sakura-sway', 'glass-orbs'],
  /* Options that belong to one theme: shown in the settings only while that theme is on (effects.css), remembered like
     the rest, and on by default the first time 輕量化 is turned on. Each one names what it stops in that theme. */
  themeKinds: {
    vinyl: 'vinyl', 'gold-coins': 'gold', 'gold-shine': 'gold', 'neon-rain': 'neon', 'poster-film': 'poster',
    'poster-rays': 'poster', 'terminal-crt': 'terminal', 'sakura-sway': 'sakura', 'glass-orbs': 'glass',
  },
  prefs: {}, active: new Map(), cacheKey: 'miku.pageEffects',
  get enabled() { return this.prefs.lightweight === '1'; },
  /** Mac app: scrolling is left to macOS (trackpad momentum, its own wheel behaviour), so nothing is ever eased on top. */
  get nativeScroll() { return !!window.mikuHost; },
  reduced(kind) { return (kind === 'scroll' && this.nativeScroll) || (this.enabled && this.prefs['lite_' + kind] !== '0'); },

  boot() {
    try { this.prefs = JSON.parse(localStorage.getItem(this.cacheKey) || '{}') || {}; } catch { this.prefs = {}; }
    this.apply();
  },
  sync() {
    const ui = App.settings.ui || {};
    this.prefs = { lightweight: ui.lightweight === '1' ? '1' : '0' };
    for (const kind of this.kinds) this.prefs['lite_' + kind] = ui['lite_' + kind] === '0' ? '0' : '1';
    this.apply();
  },
  set(key, on) {
    const value = on ? '1' : '0';
    this.prefs[key] = value;
    setUiPref(key, value);
    this.apply();
  },
  apply() {
    const root = document.documentElement;
    root.classList.toggle('lightweight', this.enabled);
    for (const kind of this.kinds) {
      root.classList.toggle('lite-' + kind, this.reduced(kind));
      if (this.reduced(kind)) for (const stop of [...(this.active.get(kind) || [])]) stop();
    }
    try { localStorage.setItem(this.cacheKey, JSON.stringify(this.prefs)); } catch { }
    window.dispatchEvent(new Event('miku-effects-change'));
  },
  // A flight already in progress must finish cleanly when its switch is turned off.
  track(kind, stop) {
    if (this.reduced(kind)) { stop(); return () => {}; }
    const set = this.active.get(kind) || new Set(); this.active.set(kind, set);
    set.add(stop);
    return () => set.delete(stop);
  },

  section(section, field) {
    const box = section(T('輕量化頁面'), T('減少介面動畫與視覺效果，降低繪製負擔。只影響外觀，不會改動音訊或 Bit-perfect 設定。'));
    box.classList.add('lite-settings');
    const toggle = (key, title, changed) => {
      const on = key === 'lightweight' ? this.enabled : this.prefs[key] !== '0';
      const button = h('button', { type: 'button', class: 'switch' + (on ? ' on' : ''), role: 'switch',
        'aria-label': title, 'aria-checked': String(on), 'data-effect': key });
      // Space/Enter activate this control instead of the player's global shortcuts.
      button.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') e.stopPropagation(); });
      button.onclick = () => {
        const value = button.getAttribute('aria-checked') !== 'true';
        button.classList.toggle('on', value); button.setAttribute('aria-checked', String(value));
        this.set(key, value); changed && changed();
      };
      return button;
    };
    const details = h('div', { class: 'lite-options', hidden: !this.enabled, id: 'lite-options' });
    const masterTitle = T('啟用輕量化頁面');
    const master = toggle('lightweight', masterTitle, () => {
      details.hidden = !this.enabled; master.setAttribute('aria-expanded', String(this.enabled));
    });
    master.setAttribute('aria-controls', 'lite-options'); master.setAttribute('aria-expanded', String(this.enabled));
    const masterRow = field(masterTitle, T('開啟的細項會減少該效果，變更立即套用；關閉總開關會恢復原有效果，並保留細項選擇。'), master);
    masterRow.classList.add('lite-master');   // the master switch: a highlighted panel (effects.css)
    box.append(masterRow);
    const rows = [
      ['signal', '關閉音訊鏈路特效', '保留 Hi-Res、DSD、有損與 DSP 資訊，關閉右下角標示及訊號路徑的循環動畫。'],
      ['card', '關閉資訊卡翻轉', '在訊號路徑資訊卡的空白處按兩下時，不再翻到卡片背面。'],
      ['album', '關閉專輯飛行效果', '專輯封面直接切換位置，黑膠取出與放回不再飛行。'],
      ['page', '關閉頁面與操作動畫', '直接切換頁面、分頁、主題、面板與歌詞位置；關閉選項的滑動、每排數量變更時的重新排列、歌詞翻譯與清單的展開收合，以及按鈕的漣漪、按下回饋與進場動畫。'],
      ['ambient', '關閉動態背景', '停止播放頁背景的持續移動。'],
      ['vinyl', '關閉黑膠持續旋轉', '停止播放列、播放頁封面與專輯唱盤的持續旋轉。'],
      ['gold-coins', '關閉金幣雨與點擊閃光', '不再灑落金幣，按按鈕、換歌時也不冒出閃光（整個動畫畫布都不建立）。'],
      ['gold-shine', '關閉閃爍與流光', '停止標題、按鈕旁一閃一閃的星光，以及側欄、播放列和招牌上掃過的光。'],
      ['neon-rain', '關閉霓虹雨與光軌', '停止播放頁的雨、側欄流動的光、滑鼠拖出的光軌，以及切換時的殘影。'],
      ['poster-film', '關閉底片顆粒與晃動', '拿掉整頁跳動的底片顆粒，停止播放頁背景的晃動。'],
      ['poster-rays', '關閉放射光與指示動畫', '停止播放頁封面後面放射光的旋轉與脈動，以及側欄那隻手的擺動。'],
      ['terminal-crt', '關閉映像管閃爍與掃描線', '停止播放頁螢幕的閃爍、往下捲的掃描線，以及游標閃爍與逐字打字。'],
      ['sakura-sway', '關閉櫻花枝搖曳', '頁面角落的櫻花枝不再持續擺動。'],
      ['glass-orbs', '關閉流動光球', '背景三顆模糊光球停在原位，不再漂移。'],
      ['blur', '關閉背景模糊與玻璃效果', '移除大片封面模糊與面板毛玻璃，改用較簡單的背景。'],
      ['scroll', '關閉平滑捲動', '跳到頂端與列表捲動直接定位；Windows 滾輪不再使用慣性動畫。'],
    ];
    const themeNames = { vinyl: '黑膠', gold: '暴發戶黃金', neon: '霓虹賽博', poster: '復古海報', terminal: '終端機', sakura: '櫻花', glass: '玻璃質感' };
    for (const [kind, label, hint] of rows) {
      if (kind === 'scroll' && this.nativeScroll) continue;   // Mac: always the system's own scrolling
      if (this.themeKinds[kind]) continue;
      const title = T(label);
      details.append(field(title, T(hint), toggle('lite_' + kind, title)));
    }
    // then the current theme's own options, under its name (each group only shows while its theme is on, effects.css)
    for (const theme of Object.keys(themeNames)) {
      const own = rows.filter(r => this.themeKinds[r[0]] === theme);
      if (!own.length) continue;
      details.append(h('div', { class: 'lite-theme-row lite-theme-head', 'data-lite-theme': theme }, T`「${T(themeNames[theme])}」主題專屬`));
      for (const [kind, label, hint] of own) {
        const title = T(label), row = field(title, T(hint), toggle('lite_' + kind, title));
        row.classList.add('lite-theme-row'); row.dataset.liteTheme = theme;
        details.append(row);
      }
    }
    box.append(details);
  },
};
PageEffects.boot();

/* Repeating decorations (signal badge, now-playing background, theme light, EQ bars, spinning covers) cost main-thread
   time every frame (they animate box-shadow, filters, backgrounds, offset paths). They freeze while nothing plays, while
   the page can't be seen (minimized: the host hides the WebView / reports the window hidden), and inside the closed
   now-playing panel. One-shot reveals, dialogs and loading feedback are never touched. Shared by Windows and Mac. */
const IdleFx = {
  decorations: '.sig, .sigpop, .np-bg, #theme-bg, .ly-dots, .np-mini .art, .np-cover, .eq',
  /* The player bar's signal badge loops for as long as music plays, and almost all of it is painted (glows, foils, a
     turning conic gradient): drawn at the display's rate it kept ~10 % of a core busy (more on a 120–160 Hz screen).
     Its loops are slow (seconds per cycle), so they are stepped at 24 fps instead. The open card (.sigpop) stays smooth.
     Glass's three blurred light orbs (#theme-bg) drift a few pixels a second (46–64 s a cycle, under 0.2 px a step at
     24 fps), but drawn at the display's rate each frame blurred and blended three window-sized layers again: on a 120 Hz
     Mac that kept the GPU process at about 55 % of a core while music played. They share the badge's clock, so the
     two together make 24 frames a second. */
  stepped: '#bar .sig, #theme-bg', fps: 24,
  frozen: new Set(), steps: new Map(), stepTimer: 0, windowVisible: true, queued: false,
  get hidden() { return document.hidden || !this.windowVisible; },
  /** The now-playing page is open all the way: the library behind it is covered. */
  get covers() { const np = document.getElementById('np'); return !!np && np.classList.contains('on') && document.documentElement.classList.contains('np-settled'); },
  /** Batched: several triggers in one task cost one pass. */
  sync() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.run(); });
  },
  run() {
    if (!document.getAnimations) return;
    const hidden = this.hidden, paused = !!document.body && document.body.classList.contains('paused');
    // The now-playing page, once it has opened all the way, covers the library behind it, and the player bar too
    // unless the bar was called back up (bar-peek): what loops there is not seen, and is not drawn (the bar's badge
    // alone cost 24 frames a second of the whole page, behind a page that hid it).
    const covered = this.covers, barGone = covered && !document.documentElement.classList.contains('bar-peek');
    const animations = new Set(document.getAnimations());
    for (const a of this.frozen) if (!animations.has(a)) this.frozen.delete(a);
    for (const a of this.steps.keys()) if (!animations.has(a)) this.steps.delete(a);
    for (const a of animations) {
      if (!a.effect || a.effect.getTiming().iterations !== Infinity) continue;
      const el = a.effect.target;
      if (!(el instanceof Element)) continue;
      const np = el.closest('#np');
      const idle = hidden || (paused && el.closest(this.decorations)) || (np && !np.classList.contains('on'))
        || (barGone && el.closest('#bar')) || (covered && el.closest('#main, #sidebar'));
      if (idle) {
        if (this.steps.delete(a)) this.frozen.add(a);   // already paused: it just stops being stepped
        else if (a.playState === 'running') { a.pause(); this.frozen.add(a); }
      } else if (el.closest(this.stepped)) {
        if (!this.steps.has(a) && (this.frozen.delete(a) || a.playState === 'running')) {
          a.pause();
          this.steps.set(a, performance.now() - (a.currentTime || 0));   // its clock: continues where it was
        }
      } else if (this.frozen.delete(a)) a.play();
    }
    this.clock();
  },
  /** The stepped animations' clock runs only while there is something to step. */
  clock() {
    if (this.steps.size && !this.stepTimer) {
      this.stepTimer = setInterval(() => {
        const now = performance.now();
        // The badge changed class and CSS cancelled the loop: setting a time would bring its look back. A cancelled
        // animation has no current time. (Asked for its playState instead, a CSS animation first brings the whole
        // page's style up to date: with a time set just before, that was a style pass per animation, every step,
        // 100–170 a second for a badge of four to seven loops.) Every time is read before any is set: in Electron's
        // Chromium (the Mac build) reading one after another's was set brought the style up to date as well, about
        // 125 style passes a second for four loops; read first, a step is one pass.
        for (const a of this.steps.keys()) if (a.currentTime === null) this.steps.delete(a);
        for (const [a, t0] of this.steps) { try { a.currentTime = now - t0; } catch (e) { this.steps.delete(a); } }
        // a draw that asked to go with a step (the progress bar: App.frame), from half a step before it is due
        if (this.due && now >= this.due.at - 500 / this.fps) { const f = this.due.fn; this.due = null; f(); }
        if (!this.steps.size) this.clock();
      }, 1000 / this.fps);
    } else if (!this.steps.size && this.stepTimer) {
      clearInterval(this.stepTimer); this.stepTimer = 0;
      if (this.due) { const d = this.due; this.due = null; setTimeout(d.fn, Math.max(0, d.at - performance.now())); }
    }
  },
  /** Runs fn with the step nearest `ms` from now, so its changes land in the same frame as the step's; false when no
   *  step clock runs (the caller keeps its own timer). One draw waits at a time: a later request replaces it. */
  due: null,
  onStep(fn, ms) {
    if (!this.stepTimer) return false;
    this.due = { fn, at: performance.now() + ms };
    return true;
  },
  /** The host's view of the window (Mac: mac-bridge.js); document.hidden covers the rest. */
  setWindowVisible(visible) { this.windowVisible = visible !== false; this.sync(); },
  init() {
    document.addEventListener('visibilitychange', () => this.sync());
    // A loop that starts is looked at only where one can be frozen or stepped: a decoration, the now-playing page, or
    // anything at all while the window is hidden. (Every card of a page that fades in starts an animation too: each of
    // them listed all the page's animations again.)
    const watched = this.decorations + ', #np';
    document.addEventListener('animationstart', e => { if (this.hidden || this.covers || (e.target.closest && e.target.closest(watched))) this.sync(); });
    const watch = () => {
      // only when what is looked at changes: paused / playing, the now-playing page open / closed (their classes are
      // written far more often than that, and a class written again unchanged still wakes an observer)
      const np = document.getElementById('np'), root = document.documentElement;
      const key = () => document.body.classList.contains('paused') + '|' + !!(np && np.classList.contains('on')) + '|' + root.classList.contains('np-settled') + '|' + root.classList.contains('bar-peek');
      let last = key();
      const observer = new MutationObserver(() => { const k = key(); if (k === last) return; last = k; this.sync(); });
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
      if (np) observer.observe(np, { attributes: true, attributeFilter: ['class'] });
      this.sync();
    };
    if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch, { once: true });
  },
};
IdleFx.init();
