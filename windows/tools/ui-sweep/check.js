/* In-page layout checker. Returns a list of problems:
 *   clip     an interactive control partly cut off by a non-scrolling clipping ancestor or the window
 *   half     a line of text only partly visible (cut top/bottom)
 *   hcut     a line of text cut sideways without an ellipsis
 *   overlap  two things that must not overlap (now-playing info, play bar items, decorations over text, lyrics over info
 *            (timed lines and the untimed block alike), a theme's ornament in a corner of the bar over the times, a
 *            two-colour backdrop's seam through the player, a theme's printed label or strip of ornament along the
 *            top of now playing behind an extension's panel)
 *   cut      a row of lyrics cut at the side by the window or its box
 *   offscreen a key control outside the window
 *   touch    buttons of one row touching each other, a round button squashed out of shape, or lyrics flush against
 *            the player (less than 8px of air)
 *   orphan   a title's last line is a single character (or a stub) on its own; a timed lyric line ends in one
 *            character on a row of its own
 *   font     now playing carries a different font variable than the theme's own (a stale copy on a channel page)
 *   squeeze  the play bar dropped the song title although there is room for it
 *   blank    a song is playing and the play bar's title cannot be seen (empty, or left invisible by an entrance that
 *            was started again and has not run)
 *   short    a name that must be whole is cut with an ellipsis (a channel in MoodWave's wheel; an album's name cut to
 *            make room for an ornament in its row)
 * (text too faint to read is measured from the pixels of a screenshot: contrast.js, kind 'faint')
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
  // 1b. round and square buttons keep their shape (a flex row short of room squashes them into ovals)
  for (const e of document.querySelectorAll('#bar .icon-btn, #bar .playbtn, #np .np-ctrl > *, #np .np-top .icon-btn, #topbar .round-btn')) {
    if (skipRegion(e) || hidden(e)) continue;
    const w = e.offsetWidth, h = e.offsetHeight; if (w < 2 || h < 2) continue;
    if (Math.min(w, h) < 0.86 * Math.max(w, h)) add('touch', desc(e), 'squashed to ' + w + '×' + h);
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
      // not MoodWave's channel wheel: its channels are turned in 3D, so their lines measure shorter than they are
      info = (skipRegion(p) || hidden(p) || p.closest('.mc-wheel')) ? null : clipOf(p, true);
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
    // the page keeps the theme's own fonts whatever is playing: now playing must not carry a different title or text
    // font than the rest of the app (黑膠 and 木質 showed the title in Georgia on a MoodWave channel)
    for (const v of ['--font-display', '--font']) {
      const a = getComputedStyle(document.documentElement).getPropertyValue(v).trim(), b = getComputedStyle(npOn).getPropertyValue(v).trim();
      if (a && b && a !== b) add('font', '#np ' + v, 'differs from the theme\'s: ' + b.slice(0, 40) + ' / ' + a.slice(0, 40));
    }
    // a theme's small printed label in the top row (霓虹's "LIVE.FEED // SYNC") never runs behind an extension's panel
    // on the same page (MoodWave's wheel reaches the top corner in a short window)
    const extBits = [...document.querySelectorAll('#np-ext *')].filter(e => !hidden(e) && (e.matches('svg, img, button') || (!e.closest('svg') && (!e.firstElementChild || [...e.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())))) && parseFloat(getComputedStyle(e).opacity) > 0.1).map(e => [e, box(e)]).filter(([, b]) => b.width > 1 && b.height > 1);
    // (and a strip of ornament drawn along the top of the page: 黃金's bead garland, a pseudo-element of #np itself with
    // no text, at most 80px high)
    if (extBits.length) for (const host of [npOn, ...document.querySelectorAll('#np .np-top')]) for (const pe of ['::before', '::after']) {
      const cs = getComputedStyle(host, pe);
      if (!cs.content || cs.content === 'none' || cs.content === 'normal' || cs.display === 'none' || cs.visibility === 'hidden' || cs.position !== 'absolute' || +cs.opacity < 0.1) continue;
      const drawn = /^""/.test(cs.content);
      if (drawn ? (host !== npOn || cs.backgroundImage === 'none' || !(parseFloat(cs.height) <= 80)) : host === npOn) continue;
      const hr = host.getBoundingClientRect(), l = parseFloat(cs.left), w = parseFloat(cs.width), h = parseFloat(cs.height), t = parseFloat(cs.top);
      if (!isFinite(l) || !isFinite(t) || !(w > 0) || !(h > 0)) continue;
      const ty = new DOMMatrixReadOnly(cs.transform === 'none' ? '' : cs.transform).m42;
      const d = { left: hr.left + l, right: hr.left + l + w, top: hr.top + t + ty, bottom: hr.top + t + ty + h };
      for (const [e, b] of extBits) if (hit(d, b, 1)) { add('overlap', (host === npOn ? 'div#np' : desc(host)) + pe + ' ' + (drawn ? 'ornament strip' : cs.content.slice(0, 22)), 'runs behind ' + desc(e)); break; }
    }
    // a backdrop made of two flat colours (極簡平面 2): the line where they meet runs between the player and the
    // lyrics, never through the cover, the title, the seek bar or the buttons
    const wrapEl = document.querySelector('#np .np-wrap');
    if (wrapEl && !document.querySelector('#np.nolyrics')) {
      const cs = getComputedStyle(wrapEl, '::before');
      const m = cs.display !== 'none' && parseFloat(cs.opacity) > 0.05 && /linear-gradient\(90deg, (?:rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+) ((?:calc\([^,]*\)|[\d.]+(?:%|px))), (?:rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+) \1\)/i.exec(cs.backgroundImage);
      if (m) {
        const pr = document.createElement('div'); pr.style.cssText = 'position:absolute;left:0;top:0;height:0;pointer-events:none;width:' + m[1];
        wrapEl.appendChild(pr); const x = wrapEl.getBoundingClientRect().left + parseFloat(cs.left || 0) + pr.getBoundingClientRect().width; pr.remove();
        for (const p of parts) { const b = box(p); if (x > b.left + 2 && x < b.right - 2) add('overlap', 'backdrop seam × ' + desc(p), 'the colour boundary at ' + Math.round(x) + 'px runs through it (' + Math.round(b.left) + '…' + Math.round(b.right) + ')'); }
      }
    }
    // lyrics over the info column
    const lyr = document.querySelector('#lyrics');
    if (lyr && !hidden(lyr) && !document.querySelector('#np.nolyrics')) {
      const lb = lyr.getBoundingClientRect();
      const infos = parts.map(box);
      // timed lines, the untimed block (.ly-plain) and the "no lyrics" notice alike: never on the cover or the song's
      // info, and never flush against them either (8px of air when they sit side by side)
      for (const ln of lyr.querySelectorAll('.ly-line, .ly-plain, .ly-empty')) {
        if (hidden(ln)) continue;
        const rr = document.createRange(); rr.selectNodeContents(ln);
        const c = clipOf(ln, true);   // what of the line can be seen (the lyrics box clips the lines that scroll out)
        const seen = new Set(); let cut = false;
        for (const r0 of rr.getClientRects()) {
          const r = { left: Math.max(r0.left, c.L), right: Math.min(r0.right, c.R), top: Math.max(r0.top, c.T), bottom: Math.min(r0.bottom, c.B) };
          if (r.right - r.left < 2 || r.bottom - r.top < 2) continue;
          // a row that shows at all shows from its first character to its last: not cut by the window's edge or the box's side
          if (!cut && r0.width > 2 && (r0.left < Math.max(c.L, 0) - 1.5 || r0.right > Math.min(c.R, W) + 1.5)) { cut = true; add('cut', 'lyric line', 'text cut at the side (' + Math.round(r0.left) + '…' + Math.round(r0.right) + ' in ' + Math.round(Math.max(c.L, 0)) + '…' + Math.round(Math.min(c.R, W)) + ')'); }
          for (let i = 0; i < infos.length; i++) {
            if (seen.has(i)) continue;
            const b = infos[i];
            if (hit(r, b, 2)) { seen.add(i); add('overlap', 'lyric line × ' + desc(parts[i]), 'lyrics over info'); }
            else if (hit(r, { left: b.left - 8, right: b.right + 8, top: b.top, bottom: b.bottom }, 2)) { seen.add(i); add('touch', 'lyric line × ' + desc(parts[i]), 'lyrics ' + Math.round(Math.max(r.left - b.right, b.left - r.right)) + 'px from the player'); }
          }
        }
      }
    }
    // a timed lyric line never ends in one character on a row of its own: a phrase with no space in it that is longer
    // than the row used to break wherever the row ended (「流れてる街で立ち止ま／る」)
    for (const el of document.querySelectorAll('#np:not(.nolyrics) #lyrics .ly-line:not(.gap)')) {
      if (hidden(el)) continue;
      const nodes = [...el.childNodes].filter(n => !(n.nodeType === 1 && n.classList.contains('tr')));
      if (!nodes.length) continue;
      const rg = document.createRange(); rg.setStartBefore(nodes[0]); rg.setEndAfter(nodes[nodes.length - 1]);
      const rows = [];
      for (const q of [...rg.getClientRects()].filter(q => q.width >= 1).sort((a, b) => a.top - b.top)) {
        const last = rows[rows.length - 1];
        if (last && q.top - last.top < 0.5 * q.height) { last.left = Math.min(last.left, q.left); last.right = Math.max(last.right, q.right); }
        else rows.push({ top: q.top, left: q.left, right: q.right });
      }
      if (rows.length < 2) continue;
      const ws = rows.map(v => v.right - v.left), end = ws[ws.length - 1], max = Math.max(...ws);
      const fs = parseFloat(getComputedStyle(el).fontSize) * ((el.getBoundingClientRect().width / el.offsetWidth) || 1);
      if (end < 1.6 * fs && end < 0.3 * max) add('orphan', 'lyric line "' + nodes.map(n => n.textContent).join('').trim().slice(0, 14) + '"', 'its last row is ' + Math.round(end) + 'px of ' + Math.round(max) + 'px');
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
    // the row of buttons: none touching its neighbour (rings and shadows need air), none squashed
    const ctl = [...document.querySelectorAll('#np .np-ctrl > *')].filter(e => !hidden(e) && e.getBoundingClientRect().width > 1);
    for (let i = 1; i < ctl.length; i++) { const a = box(ctl[i - 1]), b = box(ctl[i]); if (b.left - a.right < 2 && hit({ ...a, right: a.right + 2 }, b, 0)) add('touch', desc(ctl[i - 1]) + ' × ' + desc(ctl[i]), 'gap ' + (b.left - a.right).toFixed(1) + 'px'); }
    // the seek knob travels the whole bar: wherever it is now, it must clear the times printed under the bar's ends
    const knob = document.querySelector('#np .np-seek .slider .knob'), sl = document.querySelector('#np .np-seek .slider');
    if (knob && sl && !hidden(knob)) {
      const kr = box(knob), sr = box(sl);
      for (const t of document.querySelectorAll('#np .np-seek .times > span')) {
        if (hidden(t)) continue; const tb = textBox(t) || box(t);
        if (kr.width > 1 && kr.top < tb.bottom - 1 && tb.top < kr.bottom - 1 && sr.left - kr.width / 2 < tb.right && tb.left < sr.right + kr.width / 2) add('overlap', 'seek knob × ' + desc(t), 'the knob covers the time at the end of the bar (' + (kr.bottom - tb.top).toFixed(1) + 'px)');
      }
    }
    // a two-line title never ends in a single character or a short stub
    const tt = document.querySelector('#np .np-title');
    if (tt && !hidden(tt)) {
      const rr = document.createRange(); rr.selectNodeContents(tt); const m = new Map();
      for (const q of rr.getClientRects()) { if (q.width < 1) continue; const k = Math.round(q.top); m.set(k, (m.get(k) || 0) + q.width); }
      const ws = [...m.values()];
      if (ws.length === 2 && ws[1] < 0.3 * ws[0] && ws[1] < 2.2 * parseFloat(getComputedStyle(tt).fontSize)) add('orphan', desc(tt), 'second line ' + Math.round(ws[1]) + 'px of ' + Math.round(ws[0]) + 'px');
    }
    // top buttons over the info
    for (const e of document.querySelectorAll('#np .np-top > *, #np .np-top .pill')) {
      if (hidden(e)) continue; const a = box(e); if (a.width < 2) continue;
      for (const p of parts) if (hit(a, box(p), 2)) add('overlap', desc(e) + ' × ' + desc(p), 'top button over info');
    }
  } else {
    // an album's name is never cut (two lines, then …) to make room for an ornament that shares its row (黑膠's turntable)
    const h1 = document.querySelector('.hero.album h1'), deck = document.querySelector('.hero.album .tt-deck');
    if (h1 && deck && !hidden(h1) && !hidden(deck) && deck.getBoundingClientRect().width > 1 && h1.scrollHeight > h1.clientHeight + 2)
      add('short', desc(h1), 'the album name is cut while the turntable takes ' + Math.round(deck.getBoundingClientRect().width) + 'px of its row');
    // an action button's label is whole: a button squeezed in a row keeps its size and cuts its own text instead
    for (const b of document.querySelectorAll('#view .btn')) {
      if (hidden(b) || b.clientWidth < 2) continue;
      if (b.scrollWidth > b.clientWidth + 2) add('clip', desc(b), 'the label is cut: ' + b.clientWidth + 'px of ' + b.scrollWidth + 'px');
    }
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
    // the bar gave up the song title (fit.js data-sq 8) with plenty of room left: something else made it give up
    const barEl = document.querySelector('#bar');
    if (barEl && !hidden(barEl) && /\b8\b/.test(barEl.dataset.sq || '')) {
      const used = [...barEl.querySelectorAll('.np-mini > *, .transport .btns > *, .right-tools > *')].filter(e => !hidden(e)).reduce((a, e) => a + e.getBoundingClientRect().width, 0);
      const free = barEl.getBoundingClientRect().width - used;
      if (free > 260) add('squeeze', 'div#bar', 'song title dropped with ' + Math.round(free) + 'px free');
    }
    // the bar says what is playing: with a song there its title can be seen, unless the bar itself gave it up for lack
    // of room (data-sq 8) or a narrow window's rule did (both: display none). The title's entrance (.swap: from
    // opacity 0) started again by a redraw of the same song left it invisible in stills taken on a busy machine.
    const bTxt = document.querySelector('#b-txt'), bTitle = document.querySelector('#b-title');
    if (barEl && !hidden(barEl) && bTxt && bTitle && typeof App !== 'undefined' && App.state && App.state.trackId && getComputedStyle(bTxt).display !== 'none') {
      let op = 1, vis = true;
      for (let a = bTitle; a && a !== barEl; a = a.parentElement) { const cs = getComputedStyle(a); op *= +cs.opacity; if (cs.visibility !== 'visible' || cs.display === 'none') vis = false; }
      const w = bTitle.getBoundingClientRect().width;
      if (!bTitle.textContent.trim()) add('blank', 'div#b-title', 'a song is playing and the bar shows no title');
      else if (!vis || op < 0.9 || w < 8) add('blank', 'div#b-title', 'the title on the bar cannot be seen (opacity ' + op.toFixed(2) + ', ' + Math.round(w) + 'px wide)');
    }
    // a theme's ornament in a corner of the bar (a pseudo-element: neon's label and barcode) over the times or the title:
    // in the two-row bar the total time sits right under the top right corner
    if (barEl && !hidden(barEl)) for (const ps of ['::before', '::after']) {
      const cs = getComputedStyle(barEl, ps);
      if (cs.content === 'none' || cs.display === 'none' || cs.position !== 'absolute' || +cs.opacity < 0.05) continue;
      const w = parseFloat(cs.width), h = parseFloat(cs.height), l = parseFloat(cs.left), t = parseFloat(cs.top);
      if (!(w > 0 && h > 0 && isFinite(l) && isFinite(t)) || w > 400 || h > 40) continue;   // an ornament, not a backdrop or an edge across the bar
      const br = barEl.getBoundingClientRect(), bc = getComputedStyle(barEl);
      const x = br.left + parseFloat(bc.borderLeftWidth) + l, y = br.top + parseFloat(bc.borderTopWidth) + t;
      const o = { left: x, top: y, right: x + w, bottom: y + h, width: w, height: h };
      for (const e of barEl.querySelectorAll('.seek .time, #b-title, #b-artist')) {
        if (hidden(e)) continue;
        const tb = textBox(e) || box(e);
        if (tb && hit(o, tb, 1)) add('overlap', 'div#bar' + ps + ' × ' + desc(e), 'bar ornament over text');
      }
    }
    // sidebar: the parts of one link never overlap (icon, label, badges)
    for (const a of document.querySelectorAll('#sidebar :is(a, button, .nav-item)')) {
      if (hidden(a)) continue;
      const kids = [...a.children].filter(k => !hidden(k) && k.getBoundingClientRect().width > 1);
      for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) if (hit(box(kids[i]), box(kids[j]), 1.5)) add('overlap', desc(kids[i]) + ' × ' + desc(kids[j]), 'sidebar link parts overlap');
    }
  }
  // MoodWave's channel wheel on now playing: every channel's name whole (it is set in the theme's font, and a wide one
  // cut "Shuffle All" to "Shuffle A…")
  if (npOn) for (const b of document.querySelectorAll('#np-ext .mc-rail-item:not(.far) .mc-rail-text b')) {
    if (hidden(b)) continue;
    if (b.scrollWidth > b.clientWidth + 1) add('short', desc(b), 'needs ' + b.scrollWidth + 'px, has ' + b.clientWidth + 'px');
  }
  return out;
})()
