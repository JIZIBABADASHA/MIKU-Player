'use strict';
/* Now Playing：上方按鈕（歌詞來源／歌詞不對？／翻譯／歌詞）跟歌曲資訊疊到時，先把這些按鈕藏起來（收起鍵保留）。 */
(() => {
  const init = () => {
    const np = document.getElementById('np'); if (!np) return;
    const top = np.querySelector('.np-top'); if (!top) return;
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && a.width && b.width;
    let raf = 0;
    const check = () => {
      raf = 0;
      if (!np.classList.contains('on')) { np.classList.remove('top-crowded'); return; }
      // hidden buttons (visibility: hidden) keep their layout box, so they can be measured without un-hiding them
      const pills = [...top.querySelectorAll('.src, .ly-pick-wrap > .pill, #np-trans, #np-lyr')]
        .filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
      const info = [...np.querySelectorAll('.np-left .np-cover, .np-left .np-title, .np-left .np-artist, .np-left .np-badges, .np-left .np-seek, .np-left .np-ctrl')]
        .filter(e => e.offsetParent).map(e => e.getBoundingClientRect());
      const crowded = pills.some(p => info.some(i => hit(p, { left: i.left - 6, right: i.right + 6, top: i.top - 6, bottom: i.bottom + 6, width: i.width })));
      if (np.classList.contains('top-crowded') !== crowded) np.classList.toggle('top-crowded', crowded);
    };
    const later = (ms) => { setTimeout(() => { if (!raf) raf = requestAnimationFrame(check); }, ms); };
    const now = () => { if (!raf) raf = requestAnimationFrame(check); };
    addEventListener('resize', () => { now(); later(700); });
    // bar shown/hidden, Now Playing opened, lyrics toggled: check right away and again after the slide finishes
    new MutationObserver(() => { now(); later(350); later(750); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    // Now Playing's own classes (on, nolyrics, paused…) — ignoring our own top-crowded toggle, so this never feeds itself
    const key = () => np.className.replace(/\btop-crowded\b/, '').replace(/\bpaused\b/, '').trim();
    let last = key();
    new MutationObserver(() => { const k = key(); if (k === last) return; last = k; now(); later(750); })
      .observe(np, { attributes: true, attributeFilter: ['class'] });
    np.addEventListener('transitionend', e => { if (e.target.classList?.contains('np-wrap')) now(); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
