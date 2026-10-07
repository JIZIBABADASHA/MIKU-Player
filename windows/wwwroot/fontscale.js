'use strict';
/* Text size (Settings → 外觀 → 字體大小). The stylesheets size text in px, so instead of zooming the whole UI
 * every px font-size / line-height in the page's stylesheets is rewritten once to calc(<px> * var(--fs, 1)).
 * Only text grows; layout widths, icons and paddings stay. Stored in localStorage miku.fontScale (1 = 100%).
 * Loaded in <head> right after the stylesheets, so the saved size is applied before the first paint. */
const FontScale = {
  KEY: 'miku.fontScale',
  MIN: 0.85, MAX: 1.3, STEP: 0.05,
  _done: new WeakSet(),
  _watching: false,

  get value() {
    let v = 1;
    try { v = parseFloat(localStorage.getItem(this.KEY)) || 1; } catch {}
    return Math.min(this.MAX, Math.max(this.MIN, v));
  },

  set(v) {
    v = Math.round(Math.min(this.MAX, Math.max(this.MIN, +v || 1)) * 100) / 100;
    try { v === 1 ? localStorage.removeItem(this.KEY) : localStorage.setItem(this.KEY, String(v)); } catch {}
    this.apply(v);
    // layout measured in JS (sidebar highlight, etc.) re-measures on resize
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  },

  apply(v = this.value) {
    // nothing is rewritten until a size other than 100% is used once
    if (v !== 1) this.patchAll();
    document.documentElement.style.setProperty('--fs', String(v));
  },

  patchAll() {
    for (const sheet of document.styleSheets) this.patchSheet(sheet);
    if (this._watching) return;
    this._watching = true;
    // stylesheets added later (themes, extensions, injected <style>)
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeName === 'STYLE' && n.sheet) this.patchSheet(n.sheet);
        else if (n.nodeName === 'LINK' && /stylesheet/i.test(n.rel)) {
          if (n.sheet) this.patchSheet(n.sheet);
          n.addEventListener('load', () => n.sheet && this.patchSheet(n.sheet), { once: true });
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  },

  patchSheet(sheet) {
    if (this._done.has(sheet)) return;
    let rules;
    try { rules = sheet.cssRules; } catch { return; }   // cross-origin
    this._done.add(sheet);
    this.patchRules(rules);
  },

  patchRules(rules) {
    for (const r of rules) {
      if (r.style) {
        // a `font:` shorthand with var() keeps its longhands unresolved: rewrite the size (and px line-height) in it (px or clamp()/min()/max())
        const font = r.style.getPropertyValue('font');
        if (font && font.includes('var(')) {
          const nf = font.replace(/(^|\s)(\d*\.?\d+px|(?:clamp|min|max)\([^()]*px[^()]*\))(?:\/(\d*\.?\d+px))?(?=\s|\/|$)/, (m, sp, size, lh) =>
            `${sp}calc(${size} * var(--fs, 1))` + (lh ? `/calc(${lh} * var(--fs, 1))` : ''));
          if (nf !== font) r.style.setProperty('font', nf, r.style.getPropertyPriority('font'));
        }
        for (const p of ['font-size', 'line-height']) {
          const v = r.style.getPropertyValue(p).trim();
          if (/\dpx/.test(v) && !v.includes('var(')) r.style.setProperty(p, `calc(${v} * var(--fs, 1))`, r.style.getPropertyPriority(p));
        }
      }
      if (r.cssRules && r.cssRules.length) this.patchRules(r.cssRules);   // @media, @supports, nesting
      if (r.styleSheet) this.patchSheet(r.styleSheet);                    // @import
    }
  },

  /** Settings → 外觀 */
  section(section, field) {
    const sect = section(T('字體大小'), T('只放大或縮小文字，版面寬度和圖示維持原樣。'));
    const pct = v => Math.round(v * 100) + '%';
    const r = h('input', { class: 'range', type: 'range', min: this.MIN, max: this.MAX, step: this.STEP, value: this.value });
    const v = h('span', { class: 'num muted', style: { width: '52px', textAlign: 'right' } }, pct(this.value));
    const reset = h('button', { class: 'btn small ghost', style: { visibility: this.value === 1 ? 'hidden' : '' } }, T('重設'));
    const update = x => { v.textContent = pct(x); reset.style.visibility = x === 1 ? 'hidden' : ''; };
    r.oninput = () => { const x = Math.round(+r.value * 100) / 100; update(x); this.set(x); };
    reset.onclick = () => { r.value = 1; update(1); this.set(1); };
    sect.append(field(T('文字大小'), T('預設 100%。'), [reset, r, v]));
  },
};
FontScale.apply();
