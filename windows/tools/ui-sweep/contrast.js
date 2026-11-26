/* In-page text contrast check, from the pixels of a screenshot of this very page (so it sees what the eye sees: gradients,
 * pictures, textures, overlays; no guessing from CSS). For each visible piece of text in the controls, the page furniture
 * and the now-playing column: the line's pixels are split into paper (the median) and ink (the far end of the range), and
 * their WCAG contrast ratio is returned when it is below `limit`. Paper: the median pixel of the line. Ink: the text's
 * own colour laid over that paper.
 *   (async (b64, limit) => [...])  →  [{ el, ratio, text }] */
async (b64, limit) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(img, 0, 0);
  const k = img.width / innerWidth;
  const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
  const npOn = document.querySelector('#np.on');
  const hidden = e => { for (let a = e; a && a.nodeType === 1; a = a.parentElement) { const cs = getComputedStyle(a); if (cs.display === 'none' || cs.visibility !== 'visible' || +cs.opacity < .05 || a.hidden || a.inert) return true; } return false; };
  const skip = e => (npOn ? !e.closest('#np') : !!e.closest('#np')) || e.closest('.toast, .pop:not(.on), .drawer:not(.on), .ctx, .tip, .hover-tip, [aria-hidden="true"], :disabled, .off, .ly-line:not(.on), .ly-plain, .past, .ly-offset');
  const desc = e => { let s = e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + [...e.classList].slice(0, 2).map(c => '.' + c).join(''); const p = e.parentElement; if (!e.id && p) s = (p.id ? '#' + p.id : p.classList[0] ? '.' + p.classList[0] : p.tagName.toLowerCase()) + '>' + s; return s; };
  const out = [], seen = new Set();
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.nodeValue.trim(); if (!t) continue;
    const e = n.parentElement; if (!e || skip(e) || hidden(e)) continue;
    if (parseFloat(getComputedStyle(e).fontSize) < 9) continue;
    const r = document.createRange(); r.selectNodeContents(n);
    const q = [...r.getClientRects()].find(x => x.width >= 6 && x.height >= 6); if (!q) continue;
    const L = Math.max(0, Math.floor(q.left)), T = Math.max(0, Math.floor(q.top)), R = Math.min(innerWidth, Math.ceil(q.right)), B = Math.min(innerHeight, Math.ceil(q.bottom));
    if (R - L < 6 || B - T < 6) continue;
    // on top there (not under a card, a menu, another page)
    const top = document.elementFromPoint((L + R) / 2, (T + B) / 2); if (!top || !(top === e || e.contains(top) || top.contains(e))) continue;
    const d = cx.getImageData(Math.round(L * k), Math.round(T * k), Math.max(1, Math.round((R - L) * k)), Math.max(1, Math.round((B - T) * k))).data;
    const N = d.length / 4, ch = [0, 1, 2].map(c => { const a = new Uint8Array(N); for (let i = 0; i < N; i++) a[i] = d[4 * i + c]; return a.sort(); });
    const pct = p => ch.map(a => a[Math.min(N - 1, Math.floor(p * N))]);
    const lum = ([r, g, b]) => .2126 * f(r) + .7152 * f(g) + .0722 * f(b);
    const cr = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const paper = pct(.5);
    // dense letters (bold 瀏覽 at 13px) cover more than half of their line box, and then the median pixel is a blend of ink
    // and paper that reads far too close to the ink (cream on red measured 1.9:1). The top and bottom rows of the line box
    // are above and below every stroke: when they are one flat colour, that colour is the paper
    const wpx = Math.max(1, Math.round((R - L) * k)), hpx = N / wpx, rows = Math.max(1, Math.round(k));
    let edges = [];
    if (hpx >= 8 * rows) {
      for (const y0 of [0, hpx - rows]) {   // the top row and the bottom row, each on its own: a descender may reach one of them
        const ec = [0, 1, 2].map(c => { const a = new Uint8Array(rows * wpx); for (let y = 0; y < rows; y++) for (let x = 0; x < wpx; x++) a[y * wpx + x] = d[4 * ((y0 + y) * wpx + x) + c]; return a.sort(); });
        const ep = v => ec.map(a => a[Math.min(a.length - 1, Math.floor(v * a.length))]);
        if (cr(lum(ep(.08)), lum(ep(.92))) < 1.1) edges.push(ep(.5));
      }
      // not when those rows lie outside the fill the text sits on (a tight chip lower than its own line box)
      for (let a = e; edges.length && a && a.nodeType === 1; a = a.parentElement) {
        const c = getComputedStyle(a), bm = c.backgroundColor.match(/[\d.]+/g) || [];
        if (c.backgroundImage === 'none' && !(bm.length > 3 ? +bm[3] > .02 : bm.length === 3)) continue;
        const hb = a.getBoundingClientRect(); if (q.top < hb.top - .5 || q.bottom > hb.bottom + .5) edges = [];
        break;
      }
    }
    // the ink: the text's own colour over the paper (thin strokes never reach their full colour in the pixels); for text
    // drawn another way (a gradient or picture clipped to the letters) the far ends of the pixels' range
    const cs = getComputedStyle(e), m = (cs.webkitTextFillColor || cs.color).match(/[\d.]+/g) || [], clip = (cs.webkitBackgroundClip || cs.backgroundClip || '').includes('text');
    let alpha = m.length > 3 ? +m[3] : 1; for (let a = e; a && a.nodeType === 1; a = a.parentElement) alpha *= +getComputedStyle(a).opacity;
    let ratio;
    if (m.length >= 3 && !(clip && alpha < .5) && alpha > .05) {
      const ink = [0, 1, 2].map(c => alpha * +m[c] + (1 - alpha) * paper[c]);
      ratio = cr(lum(ink), lum(paper));
      if (edges.length) {   // of two flat rows that differ, the one nearer the ink counts
        const r2 = Math.min(...edges.map(g => cr(lum([0, 1, 2].map(c => alpha * +m[c] + (1 - alpha) * g[c])), lum(g))));
        if (r2 > ratio) ratio = r2;
      }
      // big bold letters can fill most of the line box: then the median is the ink, and the paper is the other end
      if (ratio < 1.15) ratio = Math.max(cr(lum(ink), lum(pct(.03))), cr(lum(ink), lum(pct(.97))));
    } else ratio = Math.max(cr(lum(pct(.98)), lum(paper)), cr(lum(paper), lum(pct(.02))));
    if (ratio >= limit) continue;
    const key = desc(e); if (seen.has(key)) continue; seen.add(key);
    out.push({ el: key, ratio: +ratio.toFixed(2), text: t.slice(0, 16) });
  }
  return out;
}
