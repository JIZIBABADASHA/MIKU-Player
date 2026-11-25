/* In-page layout checker. Returns a list of problems:
 *   clip     an interactive control partly cut off by a non-scrolling clipping ancestor or the window
 *   half     a line of text only partly visible (cut top/bottom)
 *   hcut     a line of text cut sideways without an ellipsis
 *   overlap  two things that must not overlap (now-playing info, play bar items, decorations over text, lyrics over info)
 *   offscreen a key control outside the window
 */
(() => {
  const W = innerWidth, H = innerHeight, out = [], seen = new Set();
  const npOn = document.querySelector('#np.on');
  const desc = e => {
    if (!e) return '?';
    let s = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 2).map(c => '.' + c).join('');
    const p = e.parentElement; if (!e.id && p) s = (p.id ? '#' + p.id : p.classList[0] ? '.' + p.classList[0] : p.tagName.toLowerCase()) + '>' + s;
    const t = (e.textContent || e.title || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return t ? s + ' "' + t + '"' : s;
  };
  const add = (kind, a, detail) => { const k = kind + '|' + a + '|' + detail; if (seen.has(k)) return; seen.add(k); out.push({ kind, el: a, detail }); };
  const hidden = e => {
    for (let a = e; a && a.nodeType === 1; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || +cs.opacity < 0.05 || a.hidden) return true;
      if (a.inert) return true;
    }
    return false;
  };
  // in the bar while now playing covers it (the bar slides away), or under a page that is not the active one
  const skipRegion = e => {
    if (npOn && e.closest('#bar, #sidebar, #main, #topbar') && !e.closest('#np')) return true;
    if (!npOn && e.closest('#np')) return true;
    if (e.closest('.toast, .pop:not(.on), .drawer:not(.on), .ctx, .tip, .hover-tip, [aria-hidden="true"]')) return true;
    return false;
  };
  const clipOf = (e, inclusive) => {
    let L = -1e9, T = -1e9, R = 1e9, B = 1e9, scroll = false, ell = false, mask = false;
    for (let a = inclusive ? e : e.parentElement; a && a.nodeType === 1; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) ell = true;
      if ((cs.maskImage && cs.maskImage !== 'none') || (cs.webkitMaskImage && cs.webkitMaskImage !== 'none')) mask = true;
      const ox = cs.overflowX, oy = cs.overflowY;
      if (ox === 'visible' && oy === 'visible' && cs.contain.indexOf('paint') < 0) continue;
      const r = a.getBoundingClientRect();
      const sx = (ox === 'auto' || ox === 'scroll') || (ox === 'hidden' && a.scrollWidth > a.clientWidth + 2 && a.scrollLeft > 0);
      const sy = (oy === 'auto' || oy === 'scroll') || (oy === 'hidden' && a.scrollHeight > a.clientHeight + 2 && a.scrollTop > 0);
      if ((sx && a.scrollWidth > a.clientWidth + 1) || (sy && a.scrollHeight > a.clientHeight + 1)) scroll = true;
      const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0, bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
      if (ox !== 'visible' && !sx) { L = Math.max(L, r.left + bl); R = Math.min(R, r.right - br); }
      if (oy !== 'visible' && !sy) { T = Math.max(T, r.top + bt); B = Math.min(B, r.bottom - bb); }
      if (cs.position === 'fixed') break;
    }
    L = Math.max(L, 0); T = Math.max(T, 0); R = Math.min(R, W); B = Math.min(B, H);
    return { L, T, R, B, scroll, ell, mask };
  };
  const area = r => Math.max(0, r.R - r.L) * Math.max(0, r.B - r.T);
  const inter = (r, c) => ({ L: Math.max(r.left, c.L), T: Math.max(r.top, c.T), R: Math.min(r.right, c.R), B: Math.min(r.bottom, c.B) });

  // 1. controls cut off
  const ctl = document.querySelectorAll('button, a[href], [role="button"], input:not([type="hidden"]), select, .pill, .icon-btn, .sig, .out-btn, .chip, .seg > *, .nav-item');
  for (const e of ctl) {
    if (skipRegion(e) || hidden(e)) continue;
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
    const c = clipOf(e, false); if (c.scroll || c.mask) continue;
    const full = r.width * r.height, v = area(inter(r, c)), f = v / full;
    if (f > 0.02 && f < 0.97) add('clip', desc(e), Math.round(f * 100) + '% visible');
    if (f <= 0.02 && e.closest('#bar, .np-ctrl, .np-top, #topbar') && !e.closest('.mc-band')) add('offscreen', desc(e), 'not visible');
  }
  // 2. text lines cut (measured unrotated: a tilted card's bounding boxes would overlap its own clip edge)
  const tilted = [];
  for (const e of document.querySelectorAll('#np *, #bar *, #sidebar *, #main *, #topbar *')) {
    const cs = getComputedStyle(e);
    const rot = cs.rotate && cs.rotate !== 'none' && parseFloat(cs.rotate) !== 0;
    const m = cs.transform && cs.transform.startsWith('matrix(') ? cs.transform.slice(7, -1).split(',').map(Number) : null;
    const tr = m && Math.abs(m[1]) > 1e-4;
    if (rot || tr) { tilted.push([e, e.style.rotate, e.style.transform]); if (rot) e.style.setProperty('rotate', 'none', 'important'); if (tr) e.style.setProperty('transform', 'none', 'important'); }
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.trim() ? 1 : 2 });
  const rng = document.createRange();
  const parents = new Map();
  for (let n; (n = walker.nextNode());) {
    const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|TITLE|OPTION|TEXTAREA)$/.test(p.tagName)) continue;
    let info = parents.get(p);
    if (info === undefined) {
      info = (skipRegion(p) || hidden(p)) ? null : clipOf(p, true);
      if (info && (info.scroll || info.mask)) info = null;
      parents.set(p, info);
    }
    if (!info) continue;
    if (info.lh === undefined) { const l = parseFloat(getComputedStyle(p).lineHeight); info.lh = isFinite(l) ? l : 0; }
    rng.selectNodeContents(n);
    for (const r of rng.getClientRects()) {
      if (r.width < 2 || r.height < 4) continue;
      // the line box (font metrics taller than the line height overhang it; that overhang is mostly empty)
      const L = info.lh || r.height, lt = r.top + (r.height - L) / 2, lb = r.bottom - (r.height - L) / 2;
      const vt = Math.max(lt, info.T), vb = Math.min(lb, info.B), vl = Math.max(r.left, info.L), vr = Math.min(r.right, info.R);
      if (vb - vt <= 1 || vr - vl <= 0) continue;           // wholly hidden (clamped lines, scrolled away)
      const fv = (vb - vt) / L;
      if (fv < 0.85) add('half', desc(p), Math.round(fv * 100) + '% of a line visible (' + (vb - vt).toFixed(1) + 'px)');
      else if (!info.ell && (vr - vl) / r.width < 0.97 && r.width > 12) add('hcut', desc(p), Math.round((vr - vl) / r.width * 100) + '% of a line visible');
    }
  }
  for (const [e, r, t] of tilted) { e.style.rotate = r; e.style.transform = t; }
  // 3. overlaps
  const box = e => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const hit = (a, b, m = 1) => a.left < b.right - m && b.left < a.right - m && a.top < b.bottom - m && b.top < a.bottom - m;
  const textBox = e => { // the union of its text lines (not its padding)
    const rr = document.createRange(); rr.selectNodeContents(e); const rs = [...rr.getClientRects()].filter(r => r.width > 1);
    if (!rs.length) return null;
    const c = clipOf(e, true);
    const u = { left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)), right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)) };
    u.left = Math.max(u.left, c.L); u.right = Math.min(u.right, c.R); u.top = Math.max(u.top, c.T); u.bottom = Math.min(u.bottom, c.B);
    return u.right > u.left && u.bottom > u.top ? u : null;
  };
  if (npOn) {
    const parts = [...document.querySelectorAll('#np .np-cover, #np .np-title, #np .np-artist, #np .np-badges, #np .np-seek, #np .np-ctrl')].filter(e => !hidden(e) && e.getBoundingClientRect().width > 0);
    for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
      const a = box(parts[i]), b = box(parts[j]);
      if (hit(a, b, 2)) add('overlap', desc(parts[i]) + ' × ' + desc(parts[j]), 'info parts overlap');
    }
    // everything in the left column inside the window and above the bar (when the bar shows)
    const bar = document.querySelector('#bar'); const br = bar.getBoundingClientRect();
    const barTop = (br.top < H - 4 && !hidden(bar)) ? br.top : H;
    for (const e of parts) {
      const r = box(e);
      if (r.bottom > barTop + 1 || r.top < -1 || r.right > W + 1 || r.left < -1) add('offscreen', desc(e), `bottom ${Math.round(r.bottom)} > ${Math.round(barTop)} or outside`);
    }
    // text-bearing decorations (e.g. a NOW PLAYING sticker) over the title/artist/badges
    const texts = ['#np .np-title', '#np .np-artist', '#np .np-badges', '#np .np-ctrl', '#np .np-seek'].map(s => document.querySelector(s)).filter(e => e && !hidden(e));
    for (const host of document.querySelectorAll('#np .np-left, #np .np-cover, #np .np-info, #np .np-title, #np .np-wrap')) {
      for (const pe of ['::before', '::after']) {
        const cs = getComputedStyle(host, pe);
        if (!cs.content || cs.content === 'none' || cs.content === 'normal' || cs.content === '""' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
        const hr = host.getBoundingClientRect();
        const l = parseFloat(cs.left), t = parseFloat(cs.top), w = parseFloat(cs.width), h = parseFloat(cs.height);
        if (!isFinite(l) || !isFinite(t) || !(w > 0) || !(h > 0)) continue;
        // a round sticker: test its inscribed square-ish core (80%)
        const cx = hr.left + l + w / 2, cy = hr.top + t + h / 2, k = 0.4;
        const d = { left: cx - w * k, right: cx + w * k, top: cy - h * k, bottom: cy + h * k };
        for (const te of texts) { const tb = textBox(te) || box(te); if (tb && hit(d, tb, 1)) add('overlap', desc(host) + pe + ' ' + cs.content.slice(0, 16), 'covers ' + desc(te)); }
        if (d.right > W || d.top < 0 || d.left < 0) add('offscreen', desc(host) + pe, 'sticker outside the window');
      }
    }
    // lyrics over the info column
    const lyr = document.querySelector('#lyrics');
    if (lyr && !hidden(lyr) && !document.querySelector('#np.nolyrics')) {
      const lb = lyr.getBoundingClientRect();
      const infos = parts.map(box);
      for (const ln of lyr.querySelectorAll('.ly-line')) {
        if (hidden(ln)) continue;
        const rr = document.createRange(); rr.selectNodeContents(ln);
        const c = clipOf(ln, true);   // what of the line can be seen (the lyrics box clips the lines that scroll out)
        for (const r0 of rr.getClientRects()) {
          const r = { left: Math.max(r0.left, c.L), right: Math.min(r0.right, c.R), top: Math.max(r0.top, c.T), bottom: Math.min(r0.bottom, c.B) };
          if (r.right - r.left < 2 || r.bottom - r.top < 2) continue;
          for (let i = 0; i < infos.length; i++) if (hit(r, infos[i], 2)) add('overlap', 'lyric line × ' + desc(parts[i]), 'lyrics over info');
        }
      }
    }
    // the lyric timing row (歌詞時間 − 0.0s + 自動): it appears while the pointer is over the lyrics, so it counts as shown
    // even while it is faded out, and it never sits on a line of lyrics (timed lines or plain text)
    const off = document.querySelector('#np .ly-offset');
    if (lyr && off && !hidden(lyr) && !document.querySelector('#np.nolyrics') && !hidden(off.parentElement) && getComputedStyle(off).display !== 'none') {
      const o = off.getBoundingClientRect();
      if (o.width > 1 && o.height > 1) {
        for (const t of lyr.querySelectorAll('.ly-line, .ly-plain')) {
          if (hidden(t)) continue;
          const c = clipOf(t, true), rr = document.createRange(); rr.selectNodeContents(t);
          for (const r0 of rr.getClientRects()) {
            const r = { left: Math.max(r0.left, c.L), right: Math.min(r0.right, c.R), top: Math.max(r0.top, c.T), bottom: Math.min(r0.bottom, c.B) };
            if (r.right - r.left < 2 || r.bottom - r.top < 2) continue;
            if (hit(r, o, 1)) { add('overlap', 'lyric timing row × ' + desc(t), 'timing row over lyrics'); break; }
          }
        }
        if (o.right > W + 0.5 || o.left < -0.5 || o.bottom > H + 0.5 || o.top < -0.5) add('offscreen', 'lyric timing row', 'outside the window');
      }
    }
    // top buttons over the info
    for (const e of document.querySelectorAll('#np .np-top > *, #np .np-top .pill')) {
      if (hidden(e)) continue; const a = box(e); if (a.width < 2) continue;
      for (const p of parts) if (hit(a, box(p), 2)) add('overlap', desc(e) + ' × ' + desc(p), 'top button over info');
    }
  } else {
    // play bar: its pieces never overlap each other
    const items = [...document.querySelectorAll('#bar :is(button, .art, .t, .a, .slider, .times > span, .mc-band, .sig, .out-btn, .db)')].filter(e => !hidden(e) && e.getBoundingClientRect().width > 1);
    const ex = [...document.querySelectorAll('#bar #b-ext > *')].filter(e => !hidden(e));
    const all = items.concat(ex);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j]; if (a.contains(b) || b.contains(a)) continue;
      const ta = /^(T|A)$/.test(a.className) ? textBox(a) : box(a), tb = /^(T|A)$/.test(b.className) ? textBox(b) : box(b);
      if (ta && tb && hit(ta, tb, 1.5)) add('overlap', desc(a) + ' × ' + desc(b), 'bar items overlap');
    }
    for (const e of all) { const r = box(e); if (r.right > W + 0.5 || r.left < -0.5 || r.bottom > H + 0.5) add('offscreen', desc(e), 'bar item outside the window'); }
    // sidebar: the parts of one link never overlap (icon, label, badges)
    for (const a of document.querySelectorAll('#sidebar :is(a, button, .nav-item)')) {
      if (hidden(a)) continue;
      const kids = [...a.children].filter(k => !hidden(k) && k.getBoundingClientRect().width > 1);
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (hit(box(kids[i]), box(kids[j]), 1.5)) add('overlap', desc(kids[i]) + ' × ' + desc(kids[j]), 'sidebar link parts overlap');
    }
  }
  return out;
})()
