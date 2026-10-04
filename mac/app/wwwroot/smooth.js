/* MIKU — smooth wheel scrolling (ease-out, with a little momentum on fast spins).
   Mouse wheel notches are animated; touchpads / precision scrolling are left native. */
(() => {
  const OMEGA = 12;            // spring stiffness; smaller = longer silky glide, larger = snappier
  const BOOST_MAX = 2.0;      // speed-up multiplier when spinning the wheel fast
  const LINE_PX = 40;         // one "line" of scrolling
  let lines = 3;              // lines per wheel notch (user setting)
  try { lines = Math.min(15, Math.max(1, +localStorage.getItem('miku.scrollLines') || 3)); } catch (e) {}
  let enabled = true;
  try { localStorage.removeItem('miku.smoothScroll'); } catch (e) {}
  window.SmoothScroll = { get enabled() { return enabled; }, set enabled(v) { enabled = !!v; if (!enabled) stopAll(); try { localStorage.setItem('miku.smoothScroll', enabled ? '1' : '0'); } catch (e) {} },
    get lines() { return lines; }, set lines(v) { lines = Math.min(15, Math.max(1, Math.round(+v) || 3)); try { localStorage.setItem('miku.scrollLines', lines); } catch (e) {} } };
  const states = new WeakMap();
  const active = new Set();
  function stopAll() {
    for (const s of active) { cancelAnimationFrame(s.raf); s.raf = 0; s.vel = 0; s.pos = s.target = s.el.scrollTop; }
    active.clear();
  }

  function scroller(t) {
    for (let el = t; el && el !== document.documentElement; el = el.parentElement) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') return el;
    }
    return null;
  }

  function isMouseWheel(e) {
    if (e.deltaMode === 1 || e.deltaMode === 2) return true;          // line / page units
    return !e.deltaX;                                   // any vertical wheel input (some mice send small or high-res deltas)
  }

  function tick(el, s, now) {
    // someone else moved it (router restore, scroll-to-top, scrollbar drag) → follow them
    if (Math.abs(el.scrollTop - s.set) > 2) { s.pos = s.target = el.scrollTop; s.vel = 0; s.raf = 0; return; }
    const dt = Math.min(0.032, (now - s.last) / 1000); s.last = now;
    // critically damped spring: eases in, glides, settles without overshoot
    const x = s.target - s.pos;
    s.vel += (OMEGA * OMEGA * x - 2 * OMEGA * s.vel) * dt;
    s.pos += s.vel * dt;
    if (Math.abs(s.target - s.pos) < 1 && Math.abs(s.vel) < 40) { s.pos = s.target; s.vel = 0; }
    el.scrollTop = s.pos; s.set = el.scrollTop;
    if (s.pos !== s.target && el.scrollTop === s.set) s.raf = requestAnimationFrame(t => tick(el, s, t));
    else { s.raf = 0; s.vel = 0; s.pos = s.target = el.scrollTop; }
  }

  addEventListener('wheel', e => {
    if (e.defaultPrevented || e.ctrlKey || e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (!isMouseWheel(e)) return;
    const el = scroller(e.target);
    if (!el) return;
    e.preventDefault();

    let s = states.get(el);
    const now = performance.now();
    if (!s) { s = { pos: el.scrollTop, target: el.scrollTop, set: el.scrollTop, el, raf: 0, vel: 0, last: now, lastWheel: 0, boost: 1 }; states.set(el, s); }
    if (!s.raf) { s.pos = s.target = s.set = el.scrollTop; s.vel = 0; s.last = now; }

    // convert to wheel notches (Windows: 100px per notch; line mode: 3 lines per notch), then apply the user's lines-per-notch
    const notches = e.deltaMode === 2 ? e.deltaY * el.clientHeight / (lines * LINE_PX) : e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
    let dy = notches * lines * LINE_PX;
    if (!enabled) {                                                   // plain scrolling: jump straight there, still honouring lines-per-notch
      el.scrollTop += dy;
      return;
    }
    // momentum: quick successive notches in the same direction accelerate
    const gap = now - s.lastWheel; s.lastWheel = now;
    const sameDir = Math.sign(dy) === Math.sign(s.target - s.pos) || s.target === s.pos;
    s.boost = gap < 120 && sameDir ? Math.min(BOOST_MAX, s.boost * 1.25) : 1;
    if (!sameDir) { s.target = s.pos; s.vel *= 0.2; }                                   // reversing: stop at once

    const max = el.scrollHeight - el.clientHeight;
    s.target = Math.max(0, Math.min(max, s.target + dy * s.boost));
    if (!s.raf) s.raf = requestAnimationFrame(t => tick(el, s, t));
    active.add(s);
  }, { passive: false });

  // rendering tweaks so the animation stays at full frame rate
  const st = document.createElement('style');
  st.textContent = `
    #content { will-change: scroll-position; }
    html.is-scrolling .card:hover .art { transform: none; box-shadow: 0 1px 0 rgba(var(--ink), .04) inset; }
    html.is-scrolling .card:hover .play { opacity: 0; }
    html.is-scrolling .card .art, html.is-scrolling .card .play { transition: none; }
    .card .art { contain: layout paint; }
    html.is-scrolling #topbar.solid { backdrop-filter: none; background: rgba(var(--bg-rgb), .94); }
  `;
  document.head.appendChild(st);
  let idle = 0;
  const unlock = () => { clearTimeout(idle); document.documentElement.classList.remove('is-scrolling'); };
  // the moment the mouse moves or clicks, cards are clickable again (no waiting for the glide to finish)
  // pressing the mouse stops the glide on the spot, so the album under the cursor is the one that gets clicked
  addEventListener('pointerdown', () => { stopAll(); unlock(); }, { capture: true, passive: true });
  const scrolling = () => {
    document.documentElement.classList.add('is-scrolling');
    clearTimeout(idle);
    idle = setTimeout(unlock, 90);
  };
  addEventListener('scroll', scrolling, { capture: true, passive: true });
  console.log("[MIKU] smooth wheel on");
})();
