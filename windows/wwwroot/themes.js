'use strict';
/* ═════════════════════════════ themes ═════════════════════════════
 * A theme (data-theme on <html>) and, chosen on its own, its day or night version (data-mode="day" / "night").
 * Every theme has both: `native` is the one it was first made as (its plain [data-theme] rules in themes.css),
 * the other one is drawn over it with [data-theme]:where([data-mode]) rules. A setting saved before the modes
 * existed keeps its look: no mode saved → the theme's native one, and 未來・夜 ('night') is 未來 at night. */
const Theme = {
  list: [
    { id: 'miku',     name: T('未來'),     en: 'MIKU',     native: 'day',
      desc: { day: T('明亮水色、蔥綠為主、櫻桃粉點綴，深色播放列配蔥綠滾邊。'), night: T('帶綠的墨色夜空與星點，蔥綠像螢光棒一樣柔和發光。') } },
    { id: 'wood',     name: T('木質調'),   en: 'WALNUT',   native: 'night',
      desc: { day: T('淺橡木側板、亞麻白的房間；封面裝在木框裡，黃銅按鍵與撥動開關，襯線標題。'), night: T('胡桃木音響櫃：溫暖的深棕、木框封面、黃銅旋鈕與撥動開關，襯線標題。') } },
    { id: 'glass',    name: T('玻璃質感'), en: 'GLASS',    native: 'night',
      desc: { day: T('白色毛玻璃浮在粉彩晨光上，玻璃邊緣一道反光；深藍的字清楚好讀，背景隨專輯封面變色。'), night: T('懸浮的毛玻璃面板，邊緣一道亮光、層層分明；背景隨專輯封面流動變色。') } },
    { id: 'flat',     name: T('極簡平面 1'), en: 'MINIMAL 1', native: 'day',
      desc: { day: T('亮色、無陰影、直角。黑白為主，只用一種鈷藍。'), night: T('近黑、無陰影、直角。白字為主，只用一種鈷藍。') } },
    { id: 'flat2',    name: T('極簡平面 2'), en: 'MINIMAL 2', native: 'day',
      desc: { day: T('瑞士海報風：白紙黑字、超大粗體標題、直角無陰影，只用一種鈷藍。'), night: T('瑞士海報風的夜版：藍圖般的深鈷藍紙、純白的大字，直角無陰影，訊號橘標出選中的地方。') } },
    { id: 'neon',     name: T('霓虹賽博'), en: 'NEON',     native: 'night',
      desc: { day: T('白天的實驗室 HUD：淡紫白底配深靛色側欄，斜切角面板、酸性黃標籤與條碼小字，青、洋紅細線；歌詞與滑動的光帶著淡淡的光尾。'), night: T('下著細雨的霓虹城市夜晚：斜切角的 HUD 面板、酸性黃標籤與條碼小字，電光青和洋紅點亮選中的項目，歌詞與滑動的光都拖著霓虹光尾。') } },
    { id: 'washi',    name: T('和紙'),     en: 'WASHI',    native: 'day',
      desc: { day: T('米白紙紋、明朝體，藍染為主色、朱印點綴。'), night: T('藍染的夜色、月白色的字與明朝體，朱印點綴。') } },
    { id: 'vinyl',    name: T('黑膠'),     en: 'VINYL',    native: 'day',
      desc: { day: T('唱片行：鼠尾草綠的牆、松木綠側欄、焦橙與芥末黃；專輯是唱片封套，黑膠從旁邊露出來。'), night: T('關了燈的聆聽室：柔和的深松綠、奶油色的字、焦橙圓標，播放中的唱片會轉。') } },
    { id: 'sakura',   name: T('櫻花'),     en: 'SAKURA',   native: 'day',
      desc: { day: T('春天的櫻花：櫻花白的底、花瓣形的圓角，選中的地方別著一朵小櫻花，嫩葉綠點綴。'), night: T('夜櫻：帶紫的黃昏色、淡粉的花與燈籠暖黃的花心，字清楚明亮。') } },
    { id: 'terminal', name: T('終端機'),   en: 'TERMINAL', native: 'night',
      desc: { day: T('綠條紋的報表紙、側邊送紙孔，方框和 [ 方括號 ] 按鈕，選到的反白；歌詞像點陣印表機一樣一個字一個字印出來。'), night: T('1980 年代的單色映像管：圓角螢幕、掃描線、磷光綠的發光字，方框視窗與 $ 提示符號；歌詞唱到才一個字一個字打出來。') } },
    { id: 'pop',      name: T('普普'),     en: 'POP',      native: 'day',
      desc: { day: T('漫畫風：粗黑框、硬陰影與網點，紅黃藍三原色。'), night: T('漫畫的夜景：印刷深藍的底、黃色網點側欄、黑墨框與硬陰影，黃字紅影的標題，角落是粉紅網點。') } },
    { id: 'poster',   name: T('復古海報'), en: 'POSTER',   native: 'day',
      desc: { day: T('五〇年代卡通衛教短片：老膠片的顆粒與刮痕、膠卷側欄、折角紅緞帶與硬陰影大字，封面旁一顆爆炸星；換頁像放映機換片。'), night: T('戲院的夜場：深棕色的膠片、米色大字與朱紅緞帶，金色放射光在封面後面轉，膠片的顆粒和刮痕一直跳。') } },
    { id: 'luka',     name: T('黑金'),     en: 'BLACK GOLD', native: 'night',
      desc: { day: T('象牙白的紙面配黑漆側欄與播放列，金色的裝飾藝術放射扇形、雙金線細框與菱形，選中的是黑底金字。'), night: T('帶暖意的黑漆面板層層分明、象牙白的字，金色放射扇形、階梯角飾與雙金線細框，選中的是黑底金字。') } },
    { id: 'gold',     name: T('暴發戶黃金'), en: 'BLING',   native: 'day',
      desc: { day: T('整個介面都是金子：鏡面金牆、金箔亮片、鑲鑽的金菱格側欄、紅漆金字招牌、金磚播放列；到處亂閃金光，一按就噴出一大堆金幣。'), night: T('酒紅絲絨的夜，金子一樣多：金菱格側欄、金磚播放列、鍍金畫框與水晶吊燈；到處亂閃金光，一按就噴出一大堆金幣。') } },
  ],
  modes: [['day', T('日'), 'sun'], ['night', T('夜'), 'moon']],
  cur: null,
  mode: null,
  key: 'miku.theme',
  modeKey: 'miku.mode',

  /** A saved theme and mode → one that exists ('night' was 未來・夜 before themes had modes). */
  resolve(id, mode) {
    if (id === 'night') { id = 'miku'; if (!mode) mode = 'night'; }
    const t = this.list.find(t => t.id === id) || this.list[0];
    return [t.id, mode === 'day' || mode === 'night' ? mode : t.native];
  },

  /**
   * The current theme's own stylesheet (themes/<id>.css; the shared rules are in themes/common.css). Only one theme's
   * rules are loaded: with all fourteen in one sheet every element was matched against every theme's rules at each
   * style pass, about 3.6 times the style work while a list scrolled. Resolves once the theme's sheet is in use.
   */
  sheet(id) {
    const cur = document.getElementById('theme-css');
    if (cur && cur.dataset.theme === id) return cur.sheet || cur._ready ? Promise.resolve() : (cur._wait = cur._wait || new Promise(r => { cur.addEventListener('load', r, { once: true }); cur.addEventListener('error', r, { once: true }); }));
    if (this.loading && this.loading.id === id) return this.loading.p;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.theme = id;
    link.href = `themes/${id}.css?v=${window.MIKU_THEME_V || '1'}`;
    const p = new Promise(r => { link.onload = link.onerror = () => { link._ready = true; r(); }; });
    (cur || document.head.lastChild).after(link);
    this.loading = { id, p, link };
    return p.then(() => {
      if (this.loading && this.loading.link === link) this.loading = null;
      // the newest request wins: an older one that loads later leaves the sheet alone
      if (document.documentElement.dataset.theme !== id && this.want !== id) { link.remove(); return; }
      const old = document.getElementById('theme-css');
      link.id = 'theme-css';
      if (old && old !== link) old.remove();
    });
  },

  /** Applies a theme and mode (no saving to the app settings): at once when its sheet is loaded, else once it is. */
  set(id, mode) {
    [id, mode] = this.resolve(id, mode);
    this.want = id;
    const link = document.getElementById('theme-css');
    if (link && link.dataset.theme === id) return Promise.resolve(this.show(id, mode));
    return this.sheet(id).then(() => { if (this.want === id) this.show(id, mode); });
  },
  show(id, mode) {
    this.cur = id; this.mode = mode;
    const root = document.documentElement;
    root.dataset.theme = id;
    root.dataset.mode = mode;
    try { localStorage.setItem(this.key, id); localStorage.setItem(this.modeKey, mode); } catch (e) { }
    this.ambient();
    // canvases read colors from CSS — redraw them
    requestAnimationFrame(() => { try { typeof Dsp !== 'undefined' && Dsp.cfg && Dsp.drawGraph(); } catch (e) { } });
  },

  /** Switches theme and / or mode with a cross-fade and saves them to the app settings. */
  apply(id, mode) {
    [id, mode] = this.resolve(id || this.cur, mode || this.mode);
    if (id === this.cur && mode === this.mode) return;
    // the cards and the 日 / 夜 switch change together with the page: a view transition runs this a frame later
    const run = () => this.set(id, mode).then(() => this.paint());
    if (document.startViewTransition && !PageEffects.reduced('page') && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(run);
    else run();
    try { if (typeof App !== 'undefined' && App.settings) { setUiPref('theme', id); setUiPref('themeMode', mode); } } catch (e) { }
  },

  /** Early boot: last theme from local cache (avoids a flash), then the saved setting once the host is ready. */
  boot() {
    let id = 'miku', mode = null;
    try { id = localStorage.getItem(this.key) || id; mode = localStorage.getItem(this.modeKey); } catch (e) { }
    this.set(id, mode);
  },
  sync() {
    const ui = typeof App !== 'undefined' && App.settings && App.settings.ui;
    if (!ui || !ui.theme) return;
    const [id, mode] = this.resolve(ui.theme, ui.themeMode);
    if (id !== this.cur || mode !== this.mode) this.set(id, mode);
    // a setting from before the modes (or 未來・夜): saved the new way, so it reads the same everywhere from now on
    try { if (ui.theme !== id || ui.themeMode !== mode) { setUiPref('theme', id); setUiPref('themeMode', mode); } } catch (e) { }
  },

  /* glass theme: ambient layer that follows the now-playing artwork */
  ambient() {
    let bg = document.getElementById('theme-bg');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'theme-bg';
      bg.innerHTML = '<div class="art"></div><div class="orb o1"></div><div class="orb o2"></div><div class="orb o3"></div>';
      document.body.prepend(bg);
      const art = bg.firstChild;
      const copy = () => {
        const src = document.querySelector('#np .np-bg .layer.a');
        // the picture itself (the now-playing layer shows its own blurred copy: nowplaying.js BlurBake)
        const url = src && src.dataset.src;
        if (url) { BlurBake.set(art, url); art.classList.add('on'); }
        else art.classList.remove('on');
      };
      const watch = () => {
        const src = document.querySelector('#np .np-bg .layer.a');
        if (!src) return setTimeout(watch, 500);
        new MutationObserver(copy).observe(src, { attributes: true, attributeFilter: ['data-src'] });
        copy();
      };
      watch();
    }
  },

  /** The picker's families, in the order shown (a heading, then the names in two columns); a theme not listed here goes in the last one. */
  families: [
    [T('經典'), ['miku', 'glass', 'flat', 'flat2']],
    [T('質感'), ['wood', 'luka', 'washi', 'sakura']],
    [T('個性'), ['neon', 'terminal', 'pop', 'poster', 'vinyl', 'gold']],
  ],
  /** The theme the big preview shows while a name is hovered or focused (null: the current one). */
  peeking: null,

  /** The settings section, when it is shown: the chosen name, the 日 / 夜 switch, the swatches and the big preview. */
  paint() {
    const sect = document.querySelector('.sect.theme-sect');
    if (!sect) return;
    sect.querySelectorAll('.tp-opt').forEach(el => { const on = el.dataset.id === this.cur; el.classList.toggle('on', on); el.setAttribute('aria-pressed', on); });
    sect.querySelectorAll('.theme-mode button').forEach(b => b.classList.toggle('on', b.dataset.v === this.mode));
    sect.querySelectorAll('.tp-screen').forEach(el => { el.dataset.mode = this.mode; });
    this.paintStage();
  },
  /** The big preview and the lines under it: the hovered theme if there is one, else the current one. */
  paintStage() {
    const stage = document.querySelector('.sect.theme-sect .tp-stage');
    if (!stage) return;
    const id = this.peeking || this.cur;
    const t = this.list.find(t => t.id === id), m = this.modes.find(m => m[0] === this.mode);
    if (!t || !m) return;
    const screen = stage.querySelector('.tp-screen');
    screen.dataset.theme = id; screen.dataset.mode = this.mode;
    const peek = id !== this.cur;
    stage.classList.toggle('peek', peek);
    const cap = stage.querySelector('.tp-cap');
    cap.textContent = '';
    cap.append(h('div', { class: 'tp-cap-h' }, h('span', null, t.name), h('span', { class: 'tag' }, peek ? T('預覽') + '・' + m[1] : m[1])),
      h('div', { class: 'tp-cap-d' }, t.desc[this.mode]));
  },
  peek(id) {
    if (this.peeking === id) return;
    this.peeking = id;
    this.paintStage();
  },

  /** Settings page section: one big preview, the theme names in a few families beside it, and 日 / 夜 as a switch of its own. */
  section(root) {
    const mode = h('div', { class: 'seg theme-mode' });
    for (const [v, label, ic] of this.modes) {
      const b = h('button', { 'data-v': v, title: label, html: icon(ic) + `<span>${label}</span>` });
      b.onclick = () => this.apply(this.cur, v);
      mode.append(b);
    }
    const sect = h('div', { class: 'sect theme-sect' },
      h('div', { class: 'theme-head' },
        h('div', { class: 'tx' }, h('h2', null, T('外觀')), h('div', { class: 'hint' }, T('選擇主題，再選日或夜。切換後立即套用，並會記住你的選擇。'))),
        mode));
    // left: the big preview (a small drawing of the app in that theme) and its name and description
    const stage = h('div', { class: 'tp-stage', 'aria-live': 'polite' },
      h('div', { class: 'tp-frame', 'aria-hidden': 'true' }, h('div', { class: 'tp-screen', 'data-theme': this.cur, 'data-mode': this.mode, html: `
        <div class="tp-side"><i class="logo"></i><i class="on"></i><i></i><i></i><i></i><i></i></div>
        <div class="tp-main"><b></b><u></u><div class="tp-cards"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></div>
        <div class="tp-bar"><i class="art"></i><i class="heart"></i><span class="seek"></span><i class="play"></i></div>` })),
      h('div', { class: 'tp-cap' }));
    // right: each family, a heading and its names in two columns
    const rest = new Set(this.list.map(t => t.id));
    const fams = this.families.map(([name, ids]) => [name, ids.filter(id => rest.delete(id))]);
    fams[fams.length - 1][1].push(...rest);
    const list = h('div', { class: 'tp-list' });
    for (const [name, ids] of fams) {
      if (!ids.length) continue;
      const items = h('div', { class: 'tp-items' });
      for (const id of ids) {
        const t = this.list.find(t => t.id === id);
        const b = h('button', { class: 'tp-opt', 'data-id': t.id, title: t.name + ' · ' + t.en });
        b.innerHTML = `<span class="tp-sw tp-screen" data-theme="${t.id}" data-mode="${this.mode}" aria-hidden="true"><i class="s"></i><i class="b"></i><i class="a"></i></span>`
          + `<span class="tp-name">${t.name}</span>`;
        b.onclick = () => { this.apply(t.id, this.mode); this.peek(null); };
        b.onpointerenter = () => this.peek(t.id);
        b.onfocus = () => { if (b.matches(':focus-visible')) this.peek(t.id); };
        items.append(b);
      }
      list.append(h('div', { class: 'tp-fam', role: 'group', 'aria-label': name }, h('div', { class: 'tp-fam-h' }, name), items));
    }
    list.onpointerleave = () => this.peek(null);
    list.addEventListener('focusout', e => { if (!list.contains(e.relatedTarget)) this.peek(null); });
    sect.append(h('div', { class: 'theme-pick' }, h('div', { class: 'tp-wrap' }, stage, list)));
    root.append(sect);
    this.peeking = null;
    this.paint();
  },
};
Theme.boot();
