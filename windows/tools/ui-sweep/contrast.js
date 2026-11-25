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
    // the ink: the text's own colour over the paper (thin strokes never reach their full colour in the pixels); for text
    // drawn another way (a gradient or picture clipped to the letters) the far ends of the pixels' range
    const cs = getComputedStyle(e), m = (cs.webkitTextFillColor || cs.color).match(/[\d.]+/g) || [], clip = (cs.webkitBackgroundClip || cs.backgroundClip || '').includes('text');
    let alpha = m.length > 3 ? +m[3] : 1; for (let a = e; a && a.nodeType === 1; a = a.parentElement) alpha *= +getComputedStyle(a).opacity;
    let ratio;
    if (m.length >= 3 && !(clip && alpha < .5) && alpha > .05) {
      const ink = [0, 1, 2].map(c => alpha * +m[c] + (1 - alpha) * paper[c]);
      ratio = cr(lum(ink), lum(paper));
      // big bold letters can fill most of the line box: then the median is the ink, and the paper is the other end
      if (ratio < 1.15) ratio = Math.max(cr(lum(ink), lum(pct(.03))), cr(lum(ink), lum(pct(.97))));
    } else ratio = Math.max(cr(lum(pct(.98)), lum(paper)), cr(lum(paper), lum(pct(.02))));
    if (ratio >= limit) continue;
    const key = desc(e); if (seen.has(key)) continue; seen.add(key);
    out.push({ el: key, ratio: +ratio.toFixed(2), text: t.slice(0, 16) });
  }
  return out;
}
