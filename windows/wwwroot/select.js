/* MIKU custom dropdown: replaces the native (unstylable) popup of every select.sel
   with a themed menu. The native <select> stays in the DOM (hidden) as the source of
   truth, so existing .value / onchange code keeps working unchanged. */
(() => {
  const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CHEV = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  let openMenu = null;

  // an option's text, with its picture first when it has one (<option data-icon="img/…">),
  // both inside a pill when the option names one (<option data-pill="class">)
  const fill = (el, o) => {
    el.textContent = '';
    if (!o) return;
    let at = el;
    if (o.dataset.pill) { at = document.createElement('span'); at.className = o.dataset.pill; el.append(at); }
    if (o.dataset.icon) {
      const img = document.createElement('img');
      img.className = 'msel-ico'; img.src = o.dataset.icon; img.alt = ''; img.draggable = false;
      at.append(img);
    }
    at.append(o.textContent);
  };

  const sync = sel => {
    const w = sel._msel; if (!w) return;
    const o = sel.options[sel.selectedIndex];
    fill(w.label, o);
    w.btn.disabled = sel.disabled;
  };

  const close = () => {
    if (!openMenu) return;
    const { menu, sel } = openMenu;
    sel._msel.root.classList.remove('open');
    sel._msel.btn.setAttribute('aria-expanded', 'false');
    menu.classList.remove('show');
    setTimeout(() => menu.remove(), 160);
    openMenu = null;
  };

  const choose = (sel, i) => {
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    sync(sel); close(); sel._msel.btn.focus();
  };

  const open = sel => {
    if (openMenu && openMenu.sel === sel) return close();
    close();
    const w = sel._msel;
    const menu = document.createElement('div');
    menu.className = 'msel-menu'; menu.setAttribute('role', 'listbox');
    let active = sel.selectedIndex;
    const items = [...sel.options].map((o, i) => {
      const it = document.createElement('div');
      it.className = 'msel-opt' + (i === sel.selectedIndex ? ' on' : '') + (o.disabled ? ' dis' : '');
      it.setAttribute('role', 'option');
      it.setAttribute('aria-selected', i === sel.selectedIndex);
      it.innerHTML = '<span class="msel-txt"></span><span class="msel-ck">' + CHECK + '</span>';
      fill(it.firstChild, o);
      it.onmouseenter = () => setActive(i);
      it.onmousedown = e => e.preventDefault();
      it.onclick = () => { if (!o.disabled) choose(sel, i); };
      menu.append(it); return it;
    });
    const setActive = i => { items.forEach((x, k) => x.classList.toggle('act', k === i)); active = i; items[i] && items[i].scrollIntoView({ block: 'nearest' }); };
    document.body.append(menu);
    // position
    const r = w.btn.getBoundingClientRect();
    menu.style.minWidth = r.width + 'px';
    const mh = Math.min(menu.scrollHeight, 320);
    const below = innerHeight - r.bottom - 12;
    const up = below < mh && r.top > below;
    menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = (up ? r.top - mh - 6 : r.bottom + 6) + 'px';
    menu.classList.toggle('up', up);
    requestAnimationFrame(() => menu.classList.add('show'));
    w.root.classList.add('open'); w.btn.setAttribute('aria-expanded', 'true');
    if (items[active]) items[active].scrollIntoView({ block: 'nearest' });
    openMenu = { menu, sel, items, get active() { return active; }, setActive };
  };

  const enhance = sel => {
    if (sel._msel || sel.multiple) return;
    const root = document.createElement('span');
    root.className = 'msel';
    if (sel.style.maxWidth) root.style.maxWidth = sel.style.maxWidth;
    if (sel.style.width) root.style.width = sel.style.width;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'msel-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span'); label.className = 'msel-label';
    const chev = document.createElement('span'); chev.className = 'msel-chev'; chev.innerHTML = CHEV;
    btn.append(label, chev);
    sel.parentNode.insertBefore(root, sel);
    root.append(sel, btn);
    sel.classList.add('msel-native'); sel.tabIndex = -1;
    sel._msel = { root, btn, label };
    btn.onclick = e => { e.stopPropagation(); open(sel); };
    btn.onkeydown = e => {
      const m = openMenu && openMenu.sel === sel ? openMenu : null;
      const n = sel.options.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        if (m) m.setActive(Math.max(0, Math.min(n - 1, m.active + d)));
        else open(sel);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (m) choose(sel, m.active); else open(sel);
      } else if (e.key === 'Escape' && m) { e.preventDefault(); close(); }
      else if (e.key === 'Tab') close();
    };
    sel.addEventListener('change', () => sync(sel));
    new MutationObserver(() => sync(sel)).observe(sel, { childList: true, subtree: true, attributes: true, characterData: true });
    sync(sel);
  };

  // keep label in sync when code sets .value / .selectedIndex programmatically
  const P = HTMLSelectElement.prototype;
  ['value', 'selectedIndex'].forEach(k => {
    const d = Object.getOwnPropertyDescriptor(P, k);
    Object.defineProperty(P, k, { configurable: true, enumerable: d.enumerable, get: d.get, set(v) { d.set.call(this, v); if (this._msel) sync(this); } });
  });

  const scan = n => {
    if (!(n instanceof Element)) return;
    if (n.matches('select.sel')) enhance(n);
    n.querySelectorAll && n.querySelectorAll('select.sel').forEach(enhance);
  };
  const start = () => {
    scan(document.body);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(scan))).observe(document.body, { childList: true, subtree: true });
  };
  document.addEventListener('mousedown', e => { if (openMenu && !openMenu.menu.contains(e.target) && !openMenu.sel._msel.root.contains(e.target)) close(); }, true);
  addEventListener('resize', close);
  document.addEventListener('scroll', e => { if (openMenu && !openMenu.menu.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) close(); });
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();

/* Now Playing：滑鼠移到底部浮出小箭頭，點下去讓播放列浮回來（再點一次收回） */
(() => {
  const init = () => {
    const np = document.getElementById('np'); if (!np) return;
    const root = document.documentElement;
    const btn = document.createElement('button');
    btn.id = 'bar-peek'; btn.type = 'button'; btn.title = '顯示播放列';
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';
    document.body.append(btn);
    btn.onclick = () => {
      const on = root.classList.toggle('bar-peek');
      btn.title = on ? '隱藏播放列' : '顯示播放列';
    };
    document.addEventListener('mousemove', e => {
      if (!np.classList.contains('on')) return;
      // show early (well above the screen edge) so reaching for it doesn't pop up the auto-hide taskbar
      const barH = (document.getElementById('bar') || {}).offsetHeight || 88;
      const zone = root.classList.contains('bar-peek') ? barH + 150 : 170;
      btn.classList.toggle('show', innerHeight - e.clientY < zone);
    });
    document.addEventListener('mouseleave', () => btn.classList.remove('show'));
    let settleT = 0; init.wasOn = np.classList.contains('on');
    new MutationObserver(() => {
      const isOn = np.classList.contains('on');
      if (isOn === init.wasOn) return; init.wasOn = isOn;
      clearTimeout(settleT);
      if (isOn) settleT = setTimeout(() => root.classList.add('np-settled'), 1400);
      else {
        root.classList.remove('np-settled');
        // closing: keep the bar on top while it rises first, then the page slides down behind it
        root.classList.add('np-closing');
        clearTimeout(init.closeT); init.closeT = setTimeout(() => root.classList.remove('np-closing'), 750);
      }
      if (!np.classList.contains('on')) { root.classList.remove('bar-peek'); btn.classList.remove('show'); btn.title = '顯示播放列'; }
    }).observe(np, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

/* Now Playing：切換歌詞時，左側封面用 FLIP 平滑滑到新位置（避免先閃到右邊再往左跑） */
(() => {
  const init = () => {
    const np = document.getElementById('np'); if (!np) return;
    const left = np.querySelector('.np-left'); if (!left) return;
    let last = null, had = np.classList.contains('nolyrics'), anim = null;
    const wrapEl = np.querySelector('.np-wrap') || np;
    // measure relative to .np-wrap so its own translateY (bar lift / settle) never leaks into the FLIP
    const rel = () => { const a = left.getBoundingClientRect(), w = wrapEl.getBoundingClientRect(); const c = left.querySelector('.np-cover'); return { left: a.left - w.left, top: a.top - w.top, width: c ? c.getBoundingClientRect().width : a.width }; };
    const snap = () => { if (np.classList.contains('on') && !anim) last = rel(); };
    new MutationObserver(() => {
      const has = np.classList.contains('nolyrics');
      if (has === had) { requestAnimationFrame(snap); return; }
      had = has;
      const from = last;
      if (anim) { anim.cancel(); anim = null; }
      const to = rel();
      if (from && np.classList.contains('on') && to.width) {
        const dx = from.left - to.left, dy = from.top - to.top, s = from.width / to.width;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          anim = left.animate([
            { transform: `translate(${dx}px, ${dy}px) scale(${s})`, transformOrigin: '0 0' },
            { transform: 'none', transformOrigin: '0 0' }
          ], { duration: 650, easing: 'cubic-bezier(.32,.72,0,1)' });
          anim.onfinish = () => { anim = null; snap(); };
        }
      }
      last = to;
    }).observe(np, { attributes: true, attributeFilter: ['class'] });
    addEventListener('resize', () => requestAnimationFrame(snap));
    setInterval(snap, 1000);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
