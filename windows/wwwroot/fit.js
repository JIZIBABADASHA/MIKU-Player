'use strict';
/* Now Playing: make the left column always fit, in every theme and at every window size.
   1. fitInfo: the cover shrinks until cover + title + artist + badges + seek + controls fit between the top buttons and
      the bottom of the page with room to spare (the CSS sizes the cover from the window height alone, which cannot know
      a title that wraps to two lines, a long artist line, or the Mac's taller Japanese fonts). If even the smallest cover
      does not fit, the badges go, then the title and artist keep one line each.
   2. placeSticker: a theme's sticker on the cover (the poster's NOW PLAYING burst) sits on a corner of the cover where it
      covers no text and stays in the window.
   3. top-crowded: the top buttons (lyrics source, wrong lyrics?, translate, lyrics) hide while they would sit on the info
      (the collapse button stays).
   4. balanceTitle: a title printed on a card (the poster's title plaque) gets as much card above its letters as below,
      whatever font the system picks: a Mac's Japanese fonts sit higher in the line than Windows' or Linux's, which put
      the first line against the card's top edge.
   5. wrapTitle: a title that takes exactly two lines gets two lines of about the same length (never one character alone
      on the second line); on a card, the card closes up to the text.
   6. lyricsRoom: the lyric timing row (歌詞時間 − 0.0s + 自動, shown while the pointer is over the lyrics) gets its own
      strip under the lyrics, so it never sits on a line of lyrics, whatever size the window is and wherever a theme
      puts the row. */
(() => {
  const init = () => {
    const np = document.getElementById('np'); if (!np) return;
    const top = np.querySelector('.np-top'); if (!top) return;
    const wrap = np.querySelector('.np-wrap'), left = np.querySelector('.np-left'), cover = document.getElementById('np-cover');
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && a.width && b.width;
    const shown = e => e && e.offsetParent && getComputedStyle(e).visibility !== 'hidden';
    const PARTS = '.np-left .np-cover, .np-left .np-title, .np-left .np-artist, .np-left .np-badges, .np-left .np-seek, .np-left .np-ctrl';
    const union = els => {
      const rs = els.map(e => e.getBoundingClientRect()).filter(r => r.width && r.height);
      if (!rs.length) return null;
      return { left: Math.min(...rs.map(r => r.left)), right: Math.max(...rs.map(r => r.right)), top: Math.min(...rs.map(r => r.top)), bottom: Math.max(...rs.map(r => r.bottom)) };
    };
    const setFit = v => { if ((np.dataset.fit || '') !== v) { if (v) np.dataset.fit = v; else delete np.dataset.fit; } };
    const fitInfo = () => {
      if (!wrap || !left || !cover) return;
      np.style.removeProperty('--np-cover-max'); setFit('');
      const room = () => {
        const wr = wrap.getBoundingClientRect(), cs = getComputedStyle(wrap);
        let t = wr.top + parseFloat(cs.paddingTop), b = wr.bottom - parseFloat(cs.paddingBottom);
        b = Math.min(b, innerHeight - 12);
        const bar = document.getElementById('bar'), br = bar && bar.getBoundingClientRect();
        if (br && br.top < innerHeight - 2 && br.height && getComputedStyle(bar).visibility !== 'hidden') b = Math.min(b, br.top - 10);
        // the collapse button and the other top buttons, where they are above the column
        const col = left.getBoundingClientRect();
        for (const e of top.querySelectorAll('#np-close, .pill, .src')) {
          if (!shown(e)) continue; const r = e.getBoundingClientRect();
          if (r.width && r.left < col.right && col.left < r.right) t = Math.max(t, r.bottom + 10);
        }
        t = Math.max(t, 8);
        return { t, b };
      };
      const over = () => {
        const parts = [...np.querySelectorAll(PARTS)].filter(shown);
        const u = union(parts); if (!u) return 0;
        const r = room();
        const oT = Math.max(0, r.t - u.top), oB = Math.max(0, u.bottom - r.b);
        // the column is centred: shrinking by d moves each end by d/2, so a one-sided overflow needs twice as much
        return oT && oB ? oT + oB : 2 * (oT + oB);
      };
      let ex = over(); if (ex <= 0.5) return;
      const side = () => { const t = np.querySelector('.np-left .np-title'); return t && t.getBoundingClientRect().left >= cover.getBoundingClientRect().right - 1; };
      const min = side() ? 72 : 120;
      let w = cover.offsetWidth;
      for (let i = 0; i < 8 && ex > 0.5 && w > min; i++) {
        w = Math.max(min, Math.floor(w - ex - 2));
        np.style.setProperty('--np-cover-max', w + 'px');
        ex = over();
      }
      if (ex > 0.5) { setFit('tight'); ex = over(); }
      if (ex > 0.5) { setFit('tight tighter'); }
    };
    const placeSticker = () => {
      if (!left || !cover) return;
      // the cover where the layout puts it, not where a transform shows it at this moment (it shrinks a little while
      // paused, with a spring): the sticker belongs to the cover's place, which does not move
      const lr = left.getBoundingClientRect();
      const cr = cover.offsetParent === left
        ? (({ x, y, w, h }) => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h }))({ x: lr.left + left.clientLeft + cover.offsetLeft, y: lr.top + left.clientTop + cover.offsetTop, w: cover.offsetWidth, h: cover.offsetHeight })
        : cover.getBoundingClientRect();
      if (!cr.width) return;
      left.style.setProperty('--np-cv-l', (cr.left - lr.left).toFixed(1) + 'px');
      left.style.setProperty('--np-cv-t', (cr.top - lr.top).toFixed(1) + 'px');
      left.style.setProperty('--np-cv-w', cr.width.toFixed(1) + 'px');
      // back to the default spot first (an earlier 'off' hides it, and it must be measured where the theme puts it)
      left.style.removeProperty('--np-st-x'); left.style.removeProperty('--np-st-y'); delete left.dataset.st;
      const ps = getComputedStyle(left, '::before');
      if (!ps.content || ps.content === 'none' || ps.content === 'normal' || ps.content === '""' || ps.position !== 'absolute' || ps.display === 'none') return;
      const st = parseFloat(getComputedStyle(left, '::before').width) || 0; if (!st) return;
      const avoid = [...np.querySelectorAll('.np-left .np-title, .np-left .np-artist, .np-left .np-badges, .np-left .np-seek, .np-left .np-ctrl, .np-top #np-close, .np-top .pill, .np-top .src, #np-ext > *')]
        .filter(shown).map(e => e.getBoundingClientRect()).filter(r => r.width);
      const lyr = np.querySelector('.np-right'); if (lyr && shown(lyr) && !np.classList.contains('nolyrics')) avoid.push(lyr.getBoundingClientRect());
      // sticker spots: its centre near a cover corner, sticking out a little; its whole box plus 4px stays off the text
      const spots = [[cr.right - .14 * st, cr.top + .2 * st], [cr.left + .14 * st, cr.top + .2 * st], [cr.right - .14 * st, cr.bottom - .2 * st], [cr.left + .14 * st, cr.bottom - .2 * st]];
      for (const [i, [cx, cy]] of spots.entries()) {
        const k = .5 * st + 4, d = { left: cx - k, right: cx + k, top: cy - k, bottom: cy + k, width: 2 * k };
        if (d.left < 4 || d.top < 4 || d.right > innerWidth - 4 || d.bottom > innerHeight - 4) continue;
        if (avoid.some(r => hit(d, r))) continue;
        left.style.setProperty('--np-st-x', (cx - st / 2 - lr.left).toFixed(1) + 'px');
        left.style.setProperty('--np-st-y', (cy - st / 2 - lr.top).toFixed(1) + 'px');
        left.dataset.st = i % 2 ? 'l' : 'r';   // which side of the cover: a theme can tilt it the other way on the left
        return;
      }
      left.dataset.st = 'off';   // nowhere free: leave it out rather than cover the title
    };
    // Two lines: data-lines="2" switches on text-wrap: balance (responsive.css). Longer titles, cut after two lines with
    // an ellipsis, keep filling their lines (balancing them would show less of the title). --np-t-w: the wider of the
    // two balanced lines, for a card (--np-t-card: 1) to close up to.
    const titleLines = () => {
      const r = document.createRange(); r.selectNodeContents(titleEl); const m = new Map();
      for (const q of r.getClientRects()) { if (q.width < 1) continue; const k = Math.round(q.top), v = m.get(k); m.set(k, v ? [Math.min(v[0], q.left), Math.max(v[1], q.right)] : [q.left, q.right]); }
      return [...m.values()];
    };
    const titleEl = np.querySelector('.np-title');
    const wrapTitle = () => {
      if (!titleEl) return;
      if (titleEl.dataset.lines) delete titleEl.dataset.lines;
      titleEl.style.removeProperty('--np-t-w');
      if (!titleEl.offsetHeight || !titleEl.textContent.trim()) return;
      const rot = titleEl.style.rotate; titleEl.style.rotate = 'none';
      if (titleLines().length === 2) {
        titleEl.dataset.lines = '2';
        if (getComputedStyle(titleEl).getPropertyValue('--np-t-card').trim() === '1') {
          const ls = titleLines(), r = titleEl.getBoundingClientRect();
          if (ls.length === 2 && r.width) titleEl.style.setProperty('--np-t-w', (Math.ceil(Math.max(...ls.map(([a, b]) => b - a)) * titleEl.offsetWidth / r.width) + 1) + 'px');
        }
      }
      titleEl.style.rotate = rot;
    };
    // The theme opts in with --np-t-card: 1 and draws the card's top and bottom edges from --np-t-bt / --np-t-bb. The
    // letters are measured on a canvas in the title's own font (the same fallback fonts as the page) and placed on the
    // line by a zero-size marker on the first line's baseline. Latin descenders (g, p, y) don't count: for Latin it is the
    // baseline that should sit in the middle, for Chinese and Japanese the whole character.
    const title = np.querySelector('.np-title'), pen = document.createElement('canvas').getContext('2d');
    const mark = document.createElement('span');
    mark.style.cssText = 'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline';
    const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g;
    const balanceTitle = () => {
      if (!title) return;
      title.style.removeProperty('--np-t-bt'); title.style.removeProperty('--np-t-bb');
      const cs = getComputedStyle(title), txt = title.textContent.trim();
      if (cs.getPropertyValue('--np-t-card').trim() !== '1' || !txt || !title.offsetHeight) return;
      const fs = parseFloat(cs.fontSize), lh = parseFloat(cs.lineHeight);
      if (!(fs > 0 && lh > 0)) return;
      pen.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      if ('lang' in pen) pen.lang = (title.closest('[lang]') || document.documentElement).lang || 'inherit';
      const up = pen.measureText(txt).actualBoundingBoxAscent;
      const cjk = (txt.match(CJK) || []).join('');
      const down = cjk ? Math.max(0, pen.measureText(cjk).actualBoundingBoxDescent) : 0;
      // (the card is tilted a little: measured straight, then tilted back, in the same frame, so nothing is drawn)
      const rot = title.style.rotate; title.style.rotate = 'none';
      title.prepend(mark);
      const r = title.getBoundingClientRect(), base = mark.getBoundingClientRect().top;
      mark.remove(); title.style.rotate = rot;
      if (!r.height) return;
      const k = title.offsetHeight / r.height;   // an ancestor scaled (zooming in): back to CSS pixels
      const bt = parseFloat(cs.borderTopWidth) || 0, bb = parseFloat(cs.borderBottomWidth) || 0;
      const lines = Math.max(1, Math.round(title.clientHeight / lh));
      const b1 = (base - r.top) * k;                                     // first baseline, from the card's top
      const above = b1 - bt - up;                                        // room above the letters, inside the edge
      const below = title.offsetHeight - bb - (b1 + (lines - 1) * lh) - down;   // and below the last line's
      const min = .06 * fs, d = below - above;
      if (Math.abs(d) < 1) return;
      title.style.setProperty('--np-t-bt', (min + Math.max(0, d)).toFixed(2) + 'px');
      title.style.setProperty('--np-t-bb', (min + Math.max(0, -d)).toFixed(2) + 'px');
    };
    // The row is measured where the theme puts it (it is absolute in the lyrics column, so the strip does not move it) and
    // the column keeps that much plus 8px free at its bottom (--ly-off-room, a bottom padding in responsive.css).
    const right = np.querySelector('.np-right'), lyOff = np.querySelector('.ly-offset');
    const lyricsRoom = () => {
      if (!right || !lyOff) return;
      let room = 0;
      if (!np.classList.contains('nolyrics') && getComputedStyle(lyOff).display !== 'none') {
        const rr = right.getBoundingClientRect(), o = lyOff.getBoundingClientRect();
        if (rr.height && o.height) {
          const k = right.offsetHeight / rr.height;   // an ancestor scaled: back to CSS pixels
          room = Math.ceil((rr.bottom - o.top) * k - (parseFloat(getComputedStyle(right).borderBottomWidth) || 0)) + 8;
        }
      }
      const v = room > 0 ? room + 'px' : '';
      if (right.style.getPropertyValue('--ly-off-room') === v) return;
      if (v) right.style.setProperty('--ly-off-room', v); else right.style.removeProperty('--ly-off-room');
    };
    let raf = 0, waits = 0;
    const check = () => {
      raf = 0;
      // still sliding in: measure once it is in place (at most ~2 s of waiting, whatever a theme does to #np)
      if (np.classList.contains('on') && getComputedStyle(np).transform !== 'none' && waits < 10) { waits++; later(200); return; }
      waits = 0;
      // (removed only when it is there: writing a class, even an unchanged one, wakes every observer of #np's class)
      if (!np.classList.contains('on')) { if (np.classList.contains('top-crowded')) np.classList.remove('top-crowded'); return; }
      lyricsRoom();
      wrapTitle();
      balanceTitle();
      fitInfo();
      // hidden buttons (visibility: hidden) keep their layout box, so they can be measured without un-hiding them
      const pills = [...top.querySelectorAll('.src, .ly-pick-wrap > .pill, #np-trans, #np-lyr')]
        .filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
      const info = [...np.querySelectorAll(PARTS)]
        .filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
      const crowded = pills.some(p => info.some(i => hit(p, { left: i.left - 6, right: i.right + 6, top: i.top - 6, bottom: i.bottom + 6, width: i.width })));
      if (np.classList.contains('top-crowded') !== crowded) np.classList.toggle('top-crowded', crowded);
      placeSticker();
    };
    const later = (ms) => { setTimeout(() => { if (!raf) raf = requestAnimationFrame(check); }, ms); };
    const now = () => { if (!raf) raf = requestAnimationFrame(check); };
    addEventListener('resize', () => { now(); later(700); });
    // bar shown/hidden, Now Playing opened, lyrics toggled: check right away and again after the slide finishes.
    // Only for a class that moves things: is-scrolling comes and goes with every scroll and moves nothing (it started
    // three measurements of this page per scroll event, for a page that is usually not even open).
    const rootKey = () => document.documentElement.className.replace(/\bis-scrolling\b/, '').replace(/\s+/g, ' ').trim();
    let lastRoot = rootKey();
    new MutationObserver(() => { const k = rootKey(); if (k === lastRoot) return; lastRoot = k; if (!np.classList.contains('on')) return; now(); later(350); later(750); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    // theme or mode changed: sizes, fonts and the sticker all change
    new MutationObserver(() => { if (np.classList.contains('on')) { now(); later(400); } })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode', 'data-ext-source'] });
    // Now Playing's own classes (on, nolyrics, paused…) — ignoring our own top-crowded toggle, so this never feeds itself
    const key = () => np.className.replace(/\btop-crowded\b|\btop-idle\b/g, '').replace(/\bpaused\b/, '').trim();
    let last = key();
    new MutationObserver(() => { const k = key(); if (k === last) return; last = k; now(); later(750); })
      .observe(np, { attributes: true, attributeFilter: ['class'] });
    // another song: a longer title or artist line, other badges
    for (const id of ['np-title', 'np-artist', 'np-badges']) {
      const e = document.getElementById(id);
      // (balanceTitle's own marker, put in and taken out again, is not another song)
      if (e) new MutationObserver(recs => {
        if (recs.every(r => r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(n => n === mark))) return;
        if (np.classList.contains('on')) { now(); later(300); }
      }).observe(e, { childList: true, characterData: true, subtree: true });
    }
    // the lyrics arriving after the song, or plain text instead of timed lines: the timing row comes or goes with them
    const lyBox = document.getElementById('lyrics');
    const lyKind = () => !lyBox ? '' : lyBox.querySelector('.ly-plain') ? 'plain' : lyBox.querySelector('.ly-empty') ? 'empty' : lyBox.querySelector('.ly-line') ? 'timed' : '';
    let lastLy = lyKind();
    if (lyBox) new MutationObserver(() => { const k = lyKind(); if (k === lastLy) return; lastLy = k; if (np.classList.contains('on')) now(); })
      .observe(lyBox, { childList: true });
    // anything else that changes the cover's, the column's or the title's size (a MoodWave mode, a theme's own rule, a
    // lyrics column coming or going): measured again, so the sticker and the cover never keep an old window's size
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => { if (np.classList.contains('on')) now(); });
      for (const e of [cover, left, np.querySelector('.np-title')]) if (e) ro.observe(e);
    }
    // fonts arriving change the text's height
    if (document.fonts) document.fonts.addEventListener('loadingdone', () => { if (np.classList.contains('on')) now(); });
    np.addEventListener('transitionend', e => { if (e.target.classList?.contains('np-wrap')) now(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

/* The player bar: nothing in it may overlap or be cut off, whatever the window width, the extension's band on the left
   (MoodWave's channel, whose width follows the channel's name), the song title or the output device's name.
   When something collides, it gets more compact one step at a time (data-sq on #bar, cumulative):
   1 the dB number and the format chip's text go   2 the output chip shows only its icon   3 a shorter volume slider
   4 the title may get narrower   5 the volume slider goes (the mute button stays; the wheel still sets the volume)
   6 the favourite button goes (as in a narrow window)   7 tighter gaps between the buttons
   8 the title and artist go (the cover stays; as in a very narrow window)   9 the DSP button goes (D still opens it) */
(() => {
  const init = () => {
    const bar = document.getElementById('bar'); if (!bar) return;
    const MAX = 9;
    // not the picture of the old left part that MIKU keeps over the bar while it swaps it (core.js BarSwap): it lies
    // exactly on the real one
    const leaves = () => [...bar.querySelectorAll('.np-mini:not(.bar-swap-old) > *, .transport .btns > *, .right-tools > *:not(.tool-sep), .right-tools .vol > :not(.db):not(.hover-tip), .seek')]
      .filter(e => e.offsetParent && getComputedStyle(e).visibility !== 'hidden' && !e.classList.contains('vol'));
    // Where a part will be once it has come in: the bar's left part slides in from the edge when a module's band comes
    // or goes (BarSwap), and measured on the way it was outside the bar, so the bar got as compact as it can and
    // stayed so (no title, half the bar empty) until the window was resized.
    const group = e => { while (e.parentElement && e.parentElement !== bar) e = e.parentElement; return e; };
    const settled = () => { const dx = new Map(); return e => {
      const r = e.getBoundingClientRect(), g = group(e); let x = dx.get(g);
      if (x === undefined) { const t = getComputedStyle(g).transform; x = t && t !== 'none' ? new DOMMatrixReadOnly(t).m41 : 0; dx.set(g, x); }
      return x ? { left: r.left - x, right: r.right - x, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : r; }; };
    const collide = () => {
      const br = bar.getBoundingClientRect(), cs = getComputedStyle(bar);
      const L = br.left + parseFloat(cs.paddingLeft) - 1, R = br.right - parseFloat(cs.paddingRight) + 1;
      const at = settled();
      const rs = leaves().map(e => [e, at(e)]).filter(([, r]) => r.width > 1);
      for (const [, r] of rs) if (r.left < L || r.right > R) return true;
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const [a, ra] = rs[i], [b, rb] = rs[j];
        if (a.contains(b) || b.contains(a)) continue;
        if (!(ra.left < rb.right - 1 && rb.left < ra.right - 1)) continue;
        // side by side in one row and running into each other: that is what getting narrower fixes. Something tall in
        // the lower row that reaches a few pixels into the seek bar's row above is not (it once emptied the whole bar)
        const v = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (v > 1 && v > .3 * Math.min(ra.height, rb.height)) return true;
      }
      return false;
    };
    const set = n => { const v = n ? Array.from({ length: n }, (_, i) => i + 1).join(' ') : ''; if ((bar.dataset.sq || '') !== v) { if (v) bar.dataset.sq = v; else delete bar.dataset.sq; } };
    let raf = 0, busy = false, again = 0, tries = 0;
    const moving = new WeakSet();
    const fit = recheck => {
      raf = 0; busy = true;
      let n = 0; set(0);
      while (n < MAX && collide()) set(++n);
      busy = false;
      // once more when a part of the bar has finished moving (a swap, an entrance), and, when the bar came out compact,
      // twice more a moment later (then no more): what made it so may have been passing, and nothing here changes size
      // when it has gone
      for (const a of bar.getAnimations({ subtree: true })) {
        const e = a.effect, el = e && e.target;
        if (moving.has(a) || !el || (el !== bar && el.parentElement !== bar) || !isFinite(e.getComputedTiming().endTime)) continue;
        moving.add(a); a.finished.then(now, now);
      }
      clearTimeout(again);
      if (recheck !== true) tries = 0;
      if (n && tries < 2) again = setTimeout(() => { tries++; fit(true); }, tries ? 3000 : 900);
    };
    const now = () => { if (!busy && !raf) raf = requestAnimationFrame(() => fit()); };
    addEventListener('resize', now);
    new MutationObserver(now).observe(bar, { childList: true });   // the swap's picture put over the bar, and taken away
    const ro = new ResizeObserver(now);
    for (const id of ['bar', 'b-ext', 'b-out', 'b-sig', 'b-title', 'b-artist']) { const e = document.getElementById(id); if (e) ro.observe(e); }
    if (document.fonts) document.fonts.addEventListener('loadingdone', now);
    now();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
