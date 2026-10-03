'use strict';
/* ═════════════════════════════ themes ═════════════════════════════ */
const Theme = {
  list: [
    { id: 'miku',  name: '初音',     en: 'MIKU',     desc: '明亮水色、蔥綠為主、櫻桃粉點綴，深色播放列配蔥綠滾邊。' },
    { id: 'night', name: '初音・夜', en: 'NIGHT', desc: '帶綠的墨色夜空與星點，蔥綠像螢光棒一樣柔和發光。' },
    { id: 'wood',  name: '木質調',   en: 'WALNUT',   desc: '胡桃木紋、黃銅旋鈕與赤陶色，像老音響一樣溫暖。' },
    { id: 'glass', name: '玻璃質感', en: 'GLASS',    desc: '懸浮毛玻璃面板，背景隨專輯封面流動變色。' },
    { id: 'flat',  name: '極簡平面', en: 'MINIMAL',  desc: '亮色、無陰影、直角。黑白為主，只用一種鈷藍。' },
    { id: 'neon',  name: '霓虹賽博', en: 'NEON',     desc: '深夜網格、電光青與洋紅發光，等寬數字。' },
    { id: 'washi', name: '和紙',     en: 'WASHI',    desc: '米白紙紋、明朝體，藍染為主色、朱印點綴。' },
    { id: 'vinyl', name: '黑膠',     en: 'VINYL',    desc: '七〇年代音響：鼠尾草綠的房間、松木深綠側欄、焦橙與芥末黃。專輯是唱片封套，滑過會抽出黑膠；播放中的唱片會轉，暫停就停住。' },
  ],
  cur: null,
  key: 'miku.theme',

  /** Applies a theme instantly (no persistence). */
  set(id) {
    if (!this.list.some(t => t.id === id)) id = 'miku';
    this.cur = id;
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem(this.key, id); } catch (e) { }
    this.ambient();
    // canvases read colors from CSS — redraw them
    requestAnimationFrame(() => { try { typeof Dsp !== 'undefined' && Dsp.cfg && Dsp.drawGraph(); } catch (e) { } });
  },

  /** Switches theme with a cross-fade and saves it to the app settings. */
  apply(id) {
    if (id === this.cur) return;
    const run = () => this.set(id);
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(run);
    else run();
    try { if (typeof App !== 'undefined' && App.settings) setUiPref('theme', id); } catch (e) { }
    document.querySelectorAll('.tp').forEach(el => el.classList.toggle('on', el.dataset.id === id));
  },

  /** Early boot: last theme from local cache (avoids a flash), then the saved setting once the host is ready. */
  boot() {
    let id = 'miku';
    try { id = localStorage.getItem(this.key) || id; } catch (e) { }
    this.set(id);
  },
  sync() {
    const id = typeof App !== 'undefined' && App.settings && App.settings.ui && App.settings.ui.theme;
    if (id && id !== this.cur) this.set(id);
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
        const img = src && src.style.backgroundImage;
        if (img && img.startsWith('url')) { art.style.backgroundImage = img; art.classList.add('on'); }
        else art.classList.remove('on');
      };
      const watch = () => {
        const src = document.querySelector('#np .np-bg .layer.a');
        if (!src) return setTimeout(watch, 500);
        new MutationObserver(copy).observe(src, { attributes: true, attributeFilter: ['style'] });
        copy();
      };
      watch();
    }
  },

  /** Settings page section. */
  section(root) {
    const sect = h('div', { class: 'sect' }, h('h2', null, '外觀'), h('div', { class: 'hint' }, '選擇介面主題。切換後立即套用，並會記住你的選擇。'));
    const grid = h('div', { class: 'theme-grid' });
    for (const t of this.list) {
      const card = h('button', { class: 'tp' + (t.id === this.cur ? ' on' : ''), 'data-id': t.id, title: t.name });
      card.innerHTML = `
        <div class="tp-screen" data-theme="${t.id}">
          <div class="tp-side"><i class="logo"></i><i class="on"></i><i></i><i></i><i></i></div>
          <div class="tp-main"><b></b><div class="tp-cards"><i></i><i></i><i></i></div></div>
          <div class="tp-bar"><i class="art"></i><i class="heart"></i><span class="seek"></span><i class="play"></i></div>
        </div>
        <div class="tp-name"><b>${t.name}</b><small>${t.en}</small><span class="chk">${icon('check')}</span></div>
        <div class="tp-desc">${t.desc}</div>`;
      card.onclick = () => this.apply(t.id);
      grid.append(card);
    }
    sect.append(grid);
    root.append(sect);
  },
};
Theme.boot();
