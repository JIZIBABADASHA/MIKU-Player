/* Sidebar: drag a link up or down to reorder it within its own section (音樂庫 / CD / 系統 ...).
   Links never leave their section. The order is kept per section in localStorage ("miku.navOrder") and is
   re-applied when extension modules add their links later (SensMe, ...). */
(() => {
  'use strict';
  const KEY = 'miku.navOrder';
  const nav = document.getElementById('nav');
  if (!nav) return;

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = o => { try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) { } };

  /** The sections: [{ key, label, links }] split at each .nav-label (the links before the first label are "top"). */
  function sections() {
    const out = []; let cur = { key: 'top', label: null, links: [] }; out.push(cur);
    for (const el of nav.children) {
      if (el.classList.contains('nav-label')) { cur = { key: el.id || el.textContent.trim(), label: el, links: [] }; out.push(cur); }
      else if (el.tagName === 'A' && el.dataset.r) cur.links.push(el);
    }
    return out;
  }

  let applying = false;
  const pill = () => { if (typeof NavPill !== 'undefined' && NavPill.el) NavPill.move(); };
  /** Put each section's links in the saved order; links the saved order does not know keep their own slots. */
  function apply() {
    const saved = load();
    applying = true;
    for (const s of sections()) {
      const order = saved[s.key];
      if (!order || s.links.length < 2) continue;
      const known = s.links.filter(a => order.includes(a.dataset.r)).sort((a, b) => order.indexOf(a.dataset.r) - order.indexOf(b.dataset.r));
      let k = 0;
      const want = s.links.map(a => order.includes(a.dataset.r) ? known[k++] : a);
      if (want.every((a, i) => a === s.links[i])) continue;
      let after = s.label || null;
      for (const a of want) {
        if (after) { if (after.nextElementSibling !== a) after.after(a); }
        else if (nav.firstElementChild !== a) nav.prepend(a);
        after = a;
      }
    }
    applying = false;
    requestAnimationFrame(pill);
  }

  function remember(sec) {
    const saved = load();
    saved[sec.key] = [...nav.children].filter(el => sec.links.includes(el)).map(a => a.dataset.r);
    save(saved);
  }

  // ── dragging ──
  const visible = a => a.offsetParent !== null && getComputedStyle(a).display !== 'none';
  let drag = null, swallowClick = false;

  nav.addEventListener('dragstart', e => { if (e.target.closest && e.target.closest('#nav a')) e.preventDefault(); });

  nav.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const a = e.target.closest('#nav > a[data-r]');
    if (!a) return;
    const sec = sections().find(s => s.links.includes(a));
    if (!sec || sec.links.filter(visible).length < 2) return;
    drag = { a, sec, id: e.pointerId, y0: e.clientY, on: false };
  });

  function start() {
    const { a } = drag;
    drag.on = true;
    drag.links = drag.sec.links.filter(visible);
    const first = drag.links[0], last = drag.links[drag.links.length - 1];
    drag.min = first.offsetTop; drag.max = last.offsetTop + last.offsetHeight;   // the section's span: never leave it
    drag.grab = drag.y0 - a.getBoundingClientRect().top;
    a.classList.add('nav-drag');
    nav.classList.add('nav-dragging');
    try { a.setPointerCapture(drag.id); } catch (e) { }
  }

  /** Move the others with a FLIP slide after a DOM reorder. */
  function flip(links, before) {
    if (PageEffects.reduced('page')) return;
    for (const el of links) {
      if (el === drag.a) continue;
      const dy = before.get(el) - el.offsetTop;
      if (!dy) continue;
      el.style.transition = 'none'; el.style.transform = `translateY(${dy}px)`;
      el.offsetWidth;
      el.style.transition = 'transform .22s cubic-bezier(.2, .8, .2, 1)'; el.style.transform = '';
    }
  }

  function follow(clientY) {
    const { a, links } = drag;
    const navTop = nav.getBoundingClientRect().top - nav.scrollTop;
    let top = clientY - drag.grab - navTop;                       // where the dragged link's top should be (nav coords)
    top = Math.max(drag.min - 1, Math.min(drag.max - a.offsetHeight + 1, top));   // 1 px past the ends so the first / last slot is reachable
    const mid = top + a.offsetHeight / 2;
    const dom = [...nav.children].filter(el => links.includes(el));
    const others = dom.filter(l => l !== a);
    const want = others.filter(l => l.offsetTop + l.offsetHeight / 2 < mid).length;   // the slot among the others
    if (want !== dom.indexOf(a)) {
      const before = new Map(links.map(l => [l, l.offsetTop]));
      applying = true;
      if (want === 0) others[0].before(a); else others[want - 1].after(a);
      applying = false;
      flip(links, before);
      pill();
    }
    a.style.transition = 'none';
    a.style.transform = `translateY(${top - a.offsetTop}px)`;
  }

  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.on) { if (Math.abs(e.clientY - drag.y0) < 5) return; start(); }
    e.preventDefault();
    follow(e.clientY);
  }, { passive: false });

  function end(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    if (!d.on) return;
    swallowClick = true; setTimeout(() => swallowClick = false, 0);
    const { a } = d;
    a.style.transition = 'transform .24s cubic-bezier(.2, .8, .2, 1)';
    a.style.transform = '';
    const done = () => { a.classList.remove('nav-drag'); a.style.transition = ''; nav.classList.remove('nav-dragging'); };
    a.addEventListener('transitionend', done, { once: true }); setTimeout(done, 300);
    remember(d.sec);
    pill();
  }
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // the click that ends a drag must not open the page
  nav.addEventListener('click', e => { if (swallowClick) { e.preventDefault(); e.stopImmediatePropagation(); swallowClick = false; } }, true);

  // ── keep the saved order when links are added later ──
  new MutationObserver(() => { if (!applying && !drag) apply(); }).observe(nav, { childList: true });
  apply();
})();
