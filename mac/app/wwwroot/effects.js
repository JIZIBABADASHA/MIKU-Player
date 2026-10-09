'use strict';
/* Shared Windows / Mac appearance preferences. Audio settings are independent. */
const PageEffects = {
  kinds: ['signal', 'album', 'page', 'ambient', 'vinyl', 'blur', 'scroll'],
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
      ['album', '關閉專輯飛行效果', '專輯封面直接切換位置，黑膠取出與放回不再飛行。'],
      ['page', '關閉頁面與操作動畫', '直接切換頁面、主題、面板與歌詞位置，關閉按鈕漣漪和進場動畫。'],
      ['ambient', '關閉動態背景', '停止玻璃主題光球與播放頁背景的持續移動。'],
      ['vinyl', '關閉黑膠持續旋轉', '停止播放列、播放頁封面與專輯唱盤的持續旋轉。'],
      ['blur', '關閉背景模糊與玻璃效果', '移除大片封面模糊與面板毛玻璃，改用較簡單的背景。'],
      ['scroll', '關閉平滑捲動', '跳到頂端與列表捲動直接定位；Windows 滾輪不再使用慣性動畫。'],
    ];
    for (const [kind, label, hint] of rows) {
      if (kind === 'scroll' && this.nativeScroll) continue;   // Mac: always the system's own scrolling
      const title = T(label), row = field(title, T(hint), toggle('lite_' + kind, title));
      if (kind === 'vinyl') row.classList.add('lite-theme-vinyl');   // only shown while the 黑膠 theme is on (effects.css)
      details.append(row);
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
  frozen: new Set(), windowVisible: true, queued: false,
  get hidden() { return document.hidden || !this.windowVisible; },
  /** Batched: several triggers in one task cost one pass. */
  sync() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; this.run(); });
  },
  run() {
    if (!document.getAnimations) return;
    const hidden = this.hidden, paused = !!document.body && document.body.classList.contains('paused');
    const animations = new Set(document.getAnimations());
    for (const a of this.frozen) if (!animations.has(a)) this.frozen.delete(a);
    for (const a of animations) {
      if (!a.effect || a.effect.getTiming().iterations !== Infinity) continue;
      const el = a.effect.target;
      if (!(el instanceof Element)) continue;
      const np = el.closest('#np');
      const idle = hidden || (paused && el.closest(this.decorations)) || (np && !np.classList.contains('on'));
      if (idle && a.playState === 'running') { a.pause(); this.frozen.add(a); }
      else if (!idle && this.frozen.delete(a)) a.play();
    }
  },
  /** The host's view of the window (Mac: mac-bridge.js); document.hidden covers the rest. */
  setWindowVisible(visible) { this.windowVisible = visible !== false; this.sync(); },
  init() {
    document.addEventListener('visibilitychange', () => this.sync());
    document.addEventListener('animationstart', () => this.sync());
    const watch = () => {
      const observer = new MutationObserver(() => this.sync());
      observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
      const np = document.getElementById('np');
      if (np) observer.observe(np, { attributes: true, attributeFilter: ['class'] });
      this.sync();
    };
    if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch, { once: true });
  },
};
IdleFx.init();
