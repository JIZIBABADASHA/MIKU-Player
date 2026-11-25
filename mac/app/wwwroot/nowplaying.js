'use strict';
/* ═════════════════════════════ now playing & lyrics ═════════════════════════════ */
/** Lyrics as the page keeps them, from a lyrics RPC result. */
const lyricsOf = (r, id, source) => ({ id: r.id || id, synced: r.synced, lines: (r.lines || []).map(l => ({ t: l.t, text: l.text, trans: l.trans, words: l.words })), offset: r.offset || 0, source, instrumental: r.instrumental });
const fmtOffset = o => (o >= 0 ? '+' : '') + (o || 0).toFixed(1) + 's';

/**
 * The now-playing backdrop (and Glass's ambient picture) blurred once per picture instead of at every frame.
 * Drawn with a CSS filter, the window-sized layers were blurred again whenever anything over them moved (the turning
 * layer .b, the lyrics, the progress): the GPU blurred about 5 million pixels per frame, 20 million on a Retina
 * screen, and the page fell to a few frames a second while the lyrics scrolled. The same filter (the theme's own
 * --np-filter) is now drawn into a small picture, its blur scaled to that size, and the layer shows the picture
 * unfiltered (app.css .baked). A picture that can't be read (no CORS: some online covers) keeps the CSS filter.
 */
const BlurBake = {
  els: new Set(),
  bitmaps: new Map(),   // url → decoded picture (the last few)
  /** Shows `url` in `el`, then swaps in its blurred version. */
  set(el, url) {
    el.dataset.src = url;
    this.els.add(el);
    if (el._baked) { URL.revokeObjectURL(el._baked); el._baked = null; }
    el.classList.remove('baked');
    el.style.backgroundImage = `url("${url}")`;
    return this.bake(el);
  },
  /** Shows a CSS background that isn't a picture (a gradient placeholder): nothing to bake. */
  plain(el, css) {
    delete el.dataset.src;
    el._job = null;
    if (el._baked) { URL.revokeObjectURL(el._baked); el._baked = null; }
    el.classList.remove('baked');
    el.style.backgroundImage = css;
  },
  async bitmap(url) {
    let b = this.bitmaps.get(url);
    if (!b) {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error('art ' + r.status);
      // decoded from a blob of our own: a picture drawn from it doesn't taint the canvas
      const local = URL.createObjectURL(await r.blob());
      try { b = new Image(); b.src = local; await b.decode(); } finally { URL.revokeObjectURL(local); }
      this.bitmaps.set(url, b);
      while (this.bitmaps.size > 4) this.bitmaps.delete(this.bitmaps.keys().next().value);
    }
    return b;
  },
  async bake(el) {
    const url = el.dataset.src;
    if (!url) return;
    const job = el._job = {};
    try {
      const bmp = await this.bitmap(url);
      if (el._job !== job) return;
      // the filter as the theme gives it now (read with the baked look off)
      const was = el.classList.contains('baked');
      if (was) el.classList.remove('baked');
      const filter = getComputedStyle(el).filter, w = el.offsetWidth, ht = el.offsetHeight;
      if (!w || !ht || !filter || filter === 'none') { if (was) el.classList.add('baked'); return; }   // not shown in this theme
      const k = Math.min(1, 360 / Math.max(w, ht));
      const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(ht * k));
      const c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      const g = c.getContext('2d');
      g.filter = filter.replace(/blur\(([\d.]+)px\)/g, (_, r) => `blur(${(+r * k).toFixed(2)}px)`);
      const bw = bmp.naturalWidth || 1, bh = bmp.naturalHeight || 1, s = Math.max(cw / bw, ch / bh), dw = bw * s, dh = bh * s;
      g.drawImage(bmp, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      const blob = await new Promise(r => c.toBlob(r));
      if (el._job !== job || !blob) return;
      if (el._baked) URL.revokeObjectURL(el._baked);
      el._baked = URL.createObjectURL(blob);
      el.style.backgroundImage = `url("${el._baked}")`;
      el.classList.add('baked');
    } catch (e) {
      // left as it was: the CSS filter draws it
      if (el._job === job) el.classList.remove('baked');
    }
  },
  /** The theme or its mode changed: its filter may differ. */
  rebake() { for (const el of this.els) if (el.isConnected && el.dataset.src) this.set(el, el.dataset.src); },
};
{
  let t = 0;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => BlurBake.rebake(), 30); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
}

const NowPlaying = {
  open: false,
  showLyrics: true,
  showTrans: true,
  ly: null,          // { id, synced, lines, offset, source }
  lines: [],         // DOM nodes
  tops: [],          // layout positions
  active: -2,
  manualUntil: 0,
  manualOffset: 0,

  init() {
    $('#np-close').onclick = () => this.hide();
    $('#np-lyr').onclick = () => { this.showLyrics = !this.showLyrics; setUiPref('npLyrics', this.showLyrics ? '1' : '0'); this.applyLayout(); };
    $('#np-trans').onclick = () => { this.showTrans = !this.showTrans; setUiPref('npTrans', this.showTrans ? '1' : '0'); this.syncTrans(); };
    $('#ly-minus').onclick = () => this.nudge(-0.1);
    $('#ly-plus').onclick = () => this.nudge(0.1);
    $('#ly-auto').onclick = async () => {
      const ly = this.ly, b = $('#ly-auto');
      if (!ly || !ly.synced || b.disabled) return;
      b.disabled = true; b.textContent = T('分析中…');
      try {
        const r = await Host.call('lyrics.autoAlign', { id: ly.id });
        if (this.ly !== ly) return;
        if (r && r.ok) {
          ly.offset = r.offset;
          $('#ly-off').textContent = fmtOffset(ly.offset);
          this.active = -2; this.layoutLines(true);
          toast(T`已自動對齊（${ly.offset >= 0 ? '+' : ''}${ly.offset.toFixed(1)} 秒）`);
        } else toast((r && T.msg(r.reason)) || T('自動對齊失敗'));
      } catch { toast(T('自動對齊失敗')); }
      finally { b.disabled = false; b.textContent = T('自動'); }
    };
    // a double-click on the cover adds the track to the favourites, or takes a favourite out: a heart pops on the cover,
    // or shrinks away
    $('#np-cover').addEventListener('dblclick', e => {
      e.preventDefault();
      getSelection()?.removeAllRanges();
      const t = App.track();
      if (!t || t.live) return;
      this.heartPop(App.toggleFav(t.id));
    });
    $('#np-cand').onclick = e => { e.stopPropagation(); this.togglePicker(); };
    document.addEventListener('click', e => { const p = $('#ly-pick'); if (!p.hidden && !p.contains(e.target)) p.hidden = true; });
    const box = $('#lyrics');
    box.addEventListener('wheel', e => {
      if (!this.ly || !this.ly.synced) return;
      e.preventDefault();
      this.manualOffset = this.clampScroll(this.manualOffset + e.deltaY);
      this.manualUntil = performance.now() + 2600;
      this.layoutLines(true);
      // glide back to the current line after a pause in scrolling (also when paused: tick() may not run then)
      clearTimeout(this._back);
      this._back = setTimeout(() => this.unscroll(), 2650);
    }, { passive: false });
    new ResizeObserver(() => { if (this.open) this.measure(); }).observe(box);
    // another theme or mode can space the lines differently (--ly-gap / --ly-anchor / --ly-start): measured again
    new MutationObserver(() => { if (this.open) this.measure(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-mode'] });
    // 輕量化的「模糊」turned on or off: the lines not being sung blur again, or turn sharp
    addEventListener('miku-effects-change', () => { if (this.open) this.layoutLines(); });
    // the top-right lyrics buttons show for 5 s after Now Playing opens, then fade; hovering the top bar brings them back
    const top = $('#np .np-top');
    top.addEventListener('mouseenter', () => this.wakeTop(false));
    top.addEventListener('mouseleave', () => this.wakeTop(true));
    top.addEventListener('focusin', () => this.wakeTop(false));
  },
  /** Shows the top-right buttons; with `idle`, hides them again after 5 s (not while the lyric picker is open or the mouse is over them). */
  wakeTop(idle) {
    clearTimeout(this._topIdle);
    $('#np').classList.remove('top-idle');
    if (!idle) return;
    this._topIdle = setTimeout(() => {
      const top = $('#np .np-top');
      if (!this.open) return;
      if (top.matches(':hover') || !$('#ly-pick').hidden) return this.wakeTop(true);   // still in use: wait another 5 s
      $('#np').classList.add('top-idle');
    }, 5000);
  },

  show() {
    if (!App.state.trackId) return;
    this.showLyrics = uiPref('npLyrics', '1') === '1';
    this.showTrans = uiPref('npTrans', '1') === '1';
    if (this.open) return;
    this.open = true;
    $('#np').classList.add('on');
    OverlayHistory.push(this._close = fromPop => this.hide(fromPop));
    YT.sync();
    this.applyLayout();
    this.paint();
    this.wakeTop(true);
    requestAnimationFrame(() => { this.measure(); App.frame(); });   // the page's own progress bar and lyrics, now
  },
  hide(fromPop) {
    if (!this.open) return;
    this.open = false;
    $('#np').classList.remove('on');
    clearTimeout(this._topIdle);
    this._tyEl = null;   // 終端機: opened again, the current line is set up again for where the song is by then (typeLine)
    if (!fromPop) OverlayHistory.closed(this._close);
    setTimeout(() => YT.sync(), 500);
  },
  toggle() { this.open ? this.hide() : this.show(); },

  // 翻譯 is a toggle: lit like the selected 歌詞 button while translations show
  syncTrans() {
    const b = $('#np-trans');
    b.classList.toggle('on', this.showTrans);
    b.setAttribute('aria-pressed', this.showTrans ? 'true' : 'false');
    // translations are always in the lines and only fold open / shut (app.css): no redraw, so nothing flashes, and the
    // ResizeObserver re-measures as they fold, keeping the current line where it is
    $('#lyrics').classList.toggle('ly-notr', !this.showTrans);
  },

  applyLayout() {
    const has = this.showLyrics && this.ly && (this.ly.lines.length > 0);
    $('#np').classList.toggle('nolyrics', !has);
    $('#np-lyr').classList.toggle('on', this.showLyrics);
    const hasTrans = this.ly && this.ly.lines.some(l => l.trans);
    $('#np-trans').style.display = hasTrans && this.showLyrics ? '' : 'none';
    this.syncTrans();
    $('#np-src').textContent = this.showLyrics && this.ly && this.ly.source ? T('歌詞來源：') + T.msg(this.ly.source) : '';
    if (has) requestAnimationFrame(() => this.measure());
  },

  trackChanged(t) {
    // the same song drawn again (its cover arrived or changed, the library was read again, an album re-read): only its
    // cover and text are painted again. Clearing and fetching its lyrics again made them vanish and come back, the list
    // starting over from the top, while the song simply went on playing.
    const key = t ? (t.live ? 'yt-live|' + t.title : t.id) : null;
    if (key && key === this._lyFor && this.ly) { this.paint(); return; }
    this._lyFor = key;
    this.ly = null;
    this.cands = null; $('#ly-pick').hidden = true; $('#np-cand').style.display = 'none';
    this.active = -2;
    this.renderLyrics();
    this.paint();
    if (!t) { this.hide(); return; }
    const id = t.live ? 'yt-live|' + t.title : t.id;
    Host.call(t.live ? 'lyricsLive' : 'lyrics', { id: t.id }).then(r => {
      if (!r) return;
      if (t.live) { const cur = App.track(); if (!cur || !cur.live || cur.title !== t.title) return; }
      else if (App.state.trackId !== id) return;
      this.ly = lyricsOf(r, id, r.source);
      this.renderLyrics();
      this.applyLayout();
      this.cands = null;
      this.updateCandBtn(t);
      // nothing found with strict matching: look for looser matches the user can choose from
      if (!t.live && !this.ly.lines.length && !this.ly.instrumental && App.settings.onlineLyrics && this.ly.source !== '已標記為錯誤')
        this.loadCands(t.id, false);
    }).catch(() => {});
  },

  /* ── manual lyric choice / report wrong lyrics ── */
  cands: null,
  updateCandBtn(t) {
    const b = $('#np-cand');
    if (!t || t.live || !this.ly) { b.style.display = 'none'; return; }
    if (this.cands && this.cands.length && !this.ly.lines.length) { b.textContent = T`可能的歌詞 (${this.cands.length})`; b.classList.add('on'); }
    else if (this.ly.lines.length) { b.textContent = T('歌詞不對？'); b.classList.remove('on'); }
    else { b.textContent = T('找歌詞'); b.classList.remove('on'); }
    b.style.display = '';
  },
  async loadCands(id, open) {
    const p = $('#ly-pick');
    if (open) { p.hidden = false; p.replaceChildren(h('div', { class: 'ly-pick-msg' }, T('搜尋中…'))); }
    let list = [];
    try { list = await Host.call('lyrics.candidates', { id }) || []; } catch { }
    if (App.state.trackId !== id) return;
    this.cands = list;
    this.updateCandBtn(App.track());
    if (!p.hidden) this.drawPicker();
  },
  togglePicker() {
    const p = $('#ly-pick');
    if (!p.hidden) { p.hidden = true; return; }
    const id = App.state.trackId;
    if (this.cands) { p.hidden = false; this.drawPicker(); } else this.loadCands(id, true);
  },
  drawPicker() {
    const p = $('#ly-pick'), id = App.state.trackId;
    const fmt = s => s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '?';
    const rows = (this.cands || []).map(c => {
      const diff = c.diff === 0 ? T('長度相同') : (c.diff > 0 ? T('長 ') : T('短 ')) + Math.abs(c.diff).toFixed(1) + T(' 秒');
      const warn = Math.abs(c.diff) > 3 ? ' warn' : '';
      return h('button', { class: 'ly-cand', onclick: async () => {
        p.hidden = true;
        const r = await Host.call('lyrics.apply', { id, key: c.key }).catch(() => null);
        if (!r) { toast(T('無法下載這份歌詞')); return; }
        if (App.state.trackId !== id) return;
        this.ly = lyricsOf(r, r.id, r.source + T('（手動選擇）'));
        this.active = -2; this.renderLyrics(); this.applyLayout(); this.updateCandBtn(App.track());
        toast(T('已套用，之後會固定使用這份歌詞'));
      } },
        h('div', { class: 'c1' }, c.title || '?', h('span', { class: 'tag' }, T.msg(c.source))),
        h('div', { class: 'c2' }, [c.artist, c.album].filter(Boolean).join(' · ')),
        h('div', { class: 'c3' + warn }, `${fmt(c.duration)} · ${diff}` + (c.synced ? T(' · 同步') : T(' · 純文字'))));
    });
    p.replaceChildren(
      h('div', { class: 'ly-pick-head' }, T('選擇正確的歌詞')),
      ...(rows.length ? rows : [h('div', { class: 'ly-pick-msg' }, T('找不到其他候選。'))]),
      h('div', { class: 'ly-pick-foot' },
        h('button', { class: 'btn small ghost', title: T('用自己的 .lrc 歌詞檔（例如 foobar2000 用的），之後會固定使用這份歌詞'), onclick: () => { p.hidden = true; this.importLrc(id); } }, T('匯入 LRC 檔…')),
        h('button', { class: 'btn small ghost', onclick: async () => {
          p.hidden = true;
          await Host.call('lyrics.clear', { id });
          if (App.state.trackId !== id) return;
          this.ly = { id, synced: false, lines: [], offset: 0, source: '已標記為錯誤' };
          this.renderLyrics(); this.applyLayout(); this.updateCandBtn(App.track());
          toast(T('已回報，這首歌不再自動顯示錯誤的歌詞'));
        } }, T('都不對，不要顯示歌詞'))));
  },

  /** 匯入 LRC 檔: the listener picks a .lrc (or .txt) file; it becomes this track's lyrics from now on. */
  importLrc(id) {
    const inp = h('input', { type: 'file', accept: '.lrc,.txt,text/plain' });
    inp.onchange = async () => {
      const f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 2e6) { toast(T('這個檔案太大，不像是歌詞檔')); return; }
      const text = await readLyricsFile(f);
      const r = await Host.call('lyrics.import', { id, text }).catch(() => null);
      if (!r) { toast(T('這個檔案裡沒有歌詞')); return; }
      if (App.state.trackId !== id) { toast(T('已匯入歌詞')); return; }
      this.ly = lyricsOf(r, r.id, r.source);
      this.active = -2; this.renderLyrics(); this.applyLayout(); this.updateCandBtn(App.track());
      toast(r.synced ? T('已匯入同步歌詞，之後會固定使用這份歌詞') : T('已匯入歌詞（沒有時間標記，不會同步捲動）'));
    };
    inp.click();
  },

  /** The heart in the middle of the cover after a double-click: popping in (on) or shrinking away (off). */
  heartPop(on) {
    const cover = $('#np-cover');
    cover.querySelector('.np-heart')?.remove();
    // taken out: the heart breaks in two, the halves falling apart (np-heart-l / -r)
    const heart = '<svg class="i"><use href="#i-heartf"/></svg>';
    const el = h('div', { class: 'np-heart' + (on ? '' : ' off'), html: on ? heart : `<i class="l">${heart}</i><i class="r">${heart}</i>` });
    cover.append(el);
    setTimeout(() => el.remove(), 1600);
    if (on) this.ripple(cover);
  },

  /**
   * Added to the favourites: the cover gives under the double-click and springs back, and as it does two thin soft
   * rings, as from a drop on water, leave from just around it and slowly spread out past the window's edges (app.css
   * np-ripple; in a layer of their own between the background and .np-wrap).
   */
  ripple(cover) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || PageEffects.reduced('page')) return;
    const np = $('#np');
    let layer = np.querySelector('.np-ripples');
    if (!layer) np.insertBefore(layer = h('div', { class: 'np-ripples' }), np.querySelector('.np-wrap'));
    // the press: in, then a little past its size and back (scale: apart from the paused cover's transform)
    cover.animate([{ scale: 1 }, { scale: .96, offset: .3 }, { scale: 1.03, offset: .7 }, { scale: 1 }], { duration: 350, easing: 'ease-out' });
    const r = cover.getBoundingClientRect(), p = np.getBoundingClientRect();
    // a ring's full size: past the window's farthest corner from the cover; it starts just around the cover's edge, its band
    // (--np-ripple-band, of its radius) about 7 px wide at the end
    const x = r.left + r.width / 2 - p.left, y = r.top + r.height / 2 - p.top;
    const size = 2 * Math.hypot(Math.max(x, p.width - x), Math.max(y, p.height - y)) + 40;
    [.85, .55].forEach((strength, i) => {
      const ring = h('div', { class: 'np-ripple' });
      Object.assign(ring.style, { left: x - size / 2 + 'px', top: y - size / 2 + 'px', width: size + 'px', height: size + 'px',
        animationDelay: 150 + i * 400 + 'ms' });   // the first as the cover springs back out
      ring.style.setProperty('--np-ripple', strength);
      ring.style.setProperty('--np-ripple-from', (1.05 * r.width / size).toFixed(4));
      ring.style.setProperty('--np-ripple-band', (1400 / size).toFixed(3) + '%');
      ring.addEventListener('animationend', () => ring.remove());
      layer.append(ring);
    });
  },

  /* paints cover, background and text for the current track */
  paint() {
    const t = App.track();
    if (!t) return;
    const kind = t.live ? 'y' : t.album?.loose ? 't' : 'a', id = t.live ? t.img : kind === 't' ? t.id : t.albumId;
    const cover = $('#np-cover');
    if (cover.dataset.cur !== kind + id || cover.dataset.v !== String(ArtVer[kind + id] || 0)) {
      const changed = cover.dataset.cur !== kind + id;
      cover.dataset.cur = kind + id;
      cover.dataset.v = String(ArtVer[kind + id] || 0);
      const current = () => cover.dataset.cur === kind + id;
      // The previous cover, and these handlers, are let go as soon as they have done their work. Kept, each cover's
      // load handler held the cover before it, which held the one before that: every album played since the start
      // stayed in memory at full size, for as long as the app ran.
      let old = cover.querySelector('img.ok');
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        img.onload = img.onerror = null;
        img.classList.add('ok');
        cover.querySelectorAll('.ph').forEach(p => p.remove());
        const was = old; old = null;
        if (was) setTimeout(() => was.remove(), 700);
      };
      // no picture for this album: its placeholder replaces whatever is shown (also the previous album's cover), unless
      // another track has been painted meanwhile
      img.onerror = () => { img.onload = img.onerror = null; old = null; if (current()) fillArt(cover, kind, null, 0, t.album?.title); else img.remove(); };
      img.src = t.live ? bigYtImg(t.img, 1200) : artUrl(kind, id, 900);
      cover.append(img);
      // background: small image, heavy blur — cheap and smooth
      const bgA = $('.np-bg .layer.a'), bgB = $('.np-bg .layer.b');
      const small = new Image();
      let bgDone = false;
      small.onload = () => {
        small.onload = small.onerror = null;
        bgDone = true;
        if (!current()) return;
        for (const l of [bgA, bgB]) { l.classList.remove('on'); }
        setTimeout(() => {
          if (!current()) return;
          BlurBake.set(bgA, small.src); BlurBake.set(bgB, small.src);
          bgA.classList.add('on'); bgB.classList.add('on');
        }, 260);
      };
      const bgPlaceholder = () => { const hue = hashHue(t.album?.title || t.title); BlurBake.plain(bgA, `linear-gradient(135deg, hsl(${hue} 50% 30%), hsl(${(hue + 60) % 360} 50% 18%))`); bgA.classList.add('on'); bgB.classList.remove('on'); };
      small.onerror = () => { small.onload = small.onerror = null; bgDone = true; if (current()) bgPlaceholder(); };
      small.src = t.live ? bigYtImg(t.img, 120) : artUrl(kind, id, 64);
      // another album whose picture is not there at once (still being read from the files or looked up online): show its
      // placeholder rather than keep the previous album's cover; the picture fades in over it when it comes
      if (changed) setTimeout(() => {
        if (!current()) return;
        if (img.isConnected && !img.classList.contains('ok')) { fillArt(cover, kind, null, 0, t.album?.title); cover.append(img); }
        if (!bgDone) bgPlaceholder();
      }, 200);
    }
    $('#np-title').textContent = t.title;
    const artist = t.live ? [h('a', { onclick: () => { this.hide(); go('#/ytmusic'); } }, t.artist || '')]
      : artistLinks(t.artists?.length ? t.artists : [t.artist || ''], () => this.hide());
    const album = h('a', { onclick: () => { this.hide(); go(t.live ? '#/ytmusic' : '#/album/' + t.albumId); } }, t.album?.title || '');
    $('#np-artist').replaceChildren(...artist, ' — ', album);
    const b = $('#np-badges');
    b.textContent = '';
    b.append(h('span', { class: 'badge' }, t.codec));
    // lossy files: fmtQuality gives the codec back (MP3), which showed as MP3 MP3; show the bit rate or sample rate instead
    const q = t.live ? '' : fmtQuality(t.codec, t.rate, t.bits);
    const q2 = q && q !== t.codec ? q : t.live ? '' : t.bitrate ? t.bitrate + ' kbps' : t.rate ? khz(t.rate) + ' kHz' : '';
    if (q2) b.append(h('span', { class: 'badge' }, q2));
    if (t.year) b.append(h('span', { class: 'badge' }, t.year));
  },

  /* ── lyrics ── */
  renderLyrics() {
    const box = $('#lyrics');
    box.textContent = '';
    box.classList.toggle('ly-notr', !this.showTrans);   // set before the lines exist, so they open already folded
    this._ro?.disconnect();
    this.lines = []; this.tops = []; this.active = -2;
    const ly = this.ly;
    if (!ly) return;
    if (ly.instrumental) { box.append(h('div', { class: 'ly-empty' }, T('純音樂，請欣賞'))); return; }
    if (!ly.lines.length) { box.append(h('div', { class: 'ly-empty' }, T('找不到歌詞'))); return; }
    if (!ly.synced) {
      box.append(h('div', { class: 'ly-plain' }, ly.lines.map(l => l.text).join('\n')));
      return;
    }
    ly.lines.forEach((l, i) => {
      const el = h('div', { class: 'ly-line' + (l.text ? '' : ' gap') });
      // the line's start as [mm:ss]: only the 終端機 theme shows it (a gutter of timestamps, like a log); kept on every
      // line in every theme, so switching to 終端機 while the lyrics are open shows it at once
      const ts = Math.max(0, Math.floor(l.t || 0));
      el.dataset.ts = String(Math.floor(ts / 60)).padStart(2, '0') + ':' + String(ts % 60).padStart(2, '0');
      if (!l.text) el.innerHTML = '<div class="ly-dots"><i></i><i></i><i></i></div>';
      else if (l.words && l.words.length) {
        l.words.forEach(w => el.append(h('span', { class: 'w' }, w.w)));
      } else el.append(l.text);
      if (l.trans) el.append(h('span', { class: 'tr' }, h('span', {}, l.trans)));
      el.onclick = () => {
        App.seek(Math.max(0, l.t - (ly.offset || 0) + 0.01));
        // the clicked line becomes current right away and the list returns to its normal place
        clearTimeout(this._back);
        this.manualOffset = 0; this.manualUntil = 0;
        this.active = i;
        this._hold = performance.now() + 500;   // until the seek is reported back
        this.layoutLines();
      };
      box.append(el);
      this.lines.push(el);
    });
    $('#ly-off').textContent = fmtOffset(ly.offset);
    // re-measure whenever the box or any line changes size (window resize, lyrics column animating in, text size
    // setting, late web fonts, view opened while hidden): stale positions put the active line off-centre and
    // made lines overlap, so a click could land on a different line than the one you see
    this._ro?.disconnect();
    this._ro = new ResizeObserver(() => {
      cancelAnimationFrame(this._mf);
      this._mf = requestAnimationFrame(() => this.measure());
    });
    this._ro.observe(box);
    this.lines.forEach(el => this._ro.observe(el));
  },

  measure() {
    if (!this.lines.length) return;
    const box = $('#lyrics');
    if (!box.clientHeight) return;   // hidden: measured again once it has a size
    // a theme can give the lines more room and pick where the current line sits, in CSS on #lyrics: --ly-gap (px between
    // lines, 16 if unset), --ly-anchor (the current line's middle, as a fraction of the box height, .43 if unset) and
    // --ly-start (at the start of a song the first line sits this far down instead of at the anchor, so the box is not
    // half empty; unset: off)
    const cs = getComputedStyle(box), num = (k, d) => { const v = parseFloat(cs.getPropertyValue(k)); return Number.isFinite(v) ? v : d; };
    this.gap = num('--ly-gap', 16); this.anchor = num('--ly-anchor', 0.43); this.start = num('--ly-start', NaN);
    // --ly-blur: how strongly the lines not being sung blur (1 = the usual, 0 = sharp); the theme sets it on #lyrics
    this.blurK = num('--ly-blur', 1);
    this.fitLines(num('--ly-fit', 0) > 0);
    // natural flow positions computed once; lines are then moved with transforms only
    let y = 0;
    this.heights = this.lines.map(el => el.offsetHeight);
    this.tops = this.heights.map(height => { const top = y; y += height + this.gap; return top; });
    this.boxH = box.clientHeight;
    this.layoutLines(false, true);
  },

  /**
   * --ly-fit: 1 on #lyrics, for a theme that draws every line as its own box (普普): a line that wraps onto more rows
   * (balanced: text-wrap in app.css) gets a box as wide as its longest row, not as wide as the column, so a box is never
   * half empty. The translation counts while it shows (its text only: its box is a grid as wide as the column). All
   * widths are read first, then set, so this is one layout.
   */
  fitLines(on) {
    if (!on && !this._fitted) return;
    this.lines.forEach(el => { el.style.width = ''; });
    this._fitted = on;
    if (!on) return;
    const r = document.createRange(), notr = $('#lyrics').classList.contains('ly-notr');
    const widths = this.lines.map(el => {
      const w = el.offsetWidth;
      if (!w || el.classList.contains('gap')) return 0;
      const box = el.getBoundingClientRect(), s = box.width / w || 1, tr = el.querySelector(':scope > .tr');
      let right = 0;
      const take = () => { for (const q of r.getClientRects()) if (q.width) right = Math.max(right, (q.right - box.left) / s); };
      if (tr) { if (tr.previousSibling) { r.setStart(el, 0); r.setEndBefore(tr); take(); } if (!notr) { const tw = document.createTreeWalker(tr, NodeFilter.SHOW_TEXT); for (let t; (t = tw.nextNode());) { r.selectNodeContents(t); take(); } } }
      else { r.selectNodeContents(el); take(); }
      const cs = getComputedStyle(el), need = Math.ceil(right + parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth) + 1);
      return right && need < w - 2 ? need : 0;
    });
    this.lines.forEach((el, i) => { if (widths[i]) el.style.width = widths[i] + 'px'; });
  },

  /** Scroll that puts line i where the current line sits. */
  scrollTo(i) {
    const s = this.tops[i] + (this.heights[i] || 0) / 2 - this.boxH * (this.anchor ?? 0.43);   // a little above the middle (0.36 had the eyes looking up)
    return Number.isFinite(this.start) ? Math.max(s, this.tops[0] - this.boxH * this.start) : s;
  },

  /** A hand-scroll offset that stops once the first line is just under the box's faded top edge, or the last line just
   *  above its faded bottom edge (.lyrics mask: 13% / 80%), so the lyrics can't be pulled away into a blank page.
   *  Never tighter than where the current line already puts them. */
  clampScroll(off) {
    const n = this.tops.length;
    if (!n) return 0;
    const base = this.scrollTo(Math.max(0, this.active));
    const lo = Math.min(base, this.tops[0] - this.boxH * 0.13);
    const hi = Math.max(base, this.tops[n - 1] + (this.heights[n - 1] || 0) - this.boxH * 0.8);
    return Math.min(hi - base, Math.max(lo - base, off));
  },

  layoutLines(manual, instant) {
    if (!this.tops.length) return;
    const a = Math.max(0, this.active);
    let scroll = this.scrollTo(a);
    const scrolling = performance.now() < this.manualUntil;
    if (scrolling) scroll += this.clampScroll(this.manualOffset);   // the current line may have moved on mid-scroll
    // Scrolling by hand on Mac (or with smooth scrolling turned off): the lines follow the trackpad / wheel directly,
    // without an eased transition on top of the system's own momentum. Gliding back to the current line still eases.
    const box = $('#lyrics');
    box.classList.toggle('ly-direct', !!manual && PageEffects.reduced('scroll'));
    // 終端機: every line at full size, like rows of text on a screen or a printout (the others shrink the lines not sung)
    const theme = document.documentElement.dataset.theme, small = theme === 'terminal' ? 1 : 0.965;
    // the line being sung is the sharpest; the others blur a little, more the further away (lightweight blur: none)
    const k = PageEffects.reduced('blur') ? 0 : (this.blurK ?? 1);
    this.lines.forEach((el, i) => {
      const d = i - a;
      const dist = Math.abs(d);
      // the active line moves first, neighbours follow with a short cascade
      const delay = manual || instant || d <= 0 ? 0 : Math.min(dist, 7) * 26;
      el.style.transitionDelay = `${delay}ms, 0ms, 0ms, 0ms`;
      if (instant) el.style.transitionDuration = '0s';
      el.style.transform = `translateY(${this.tops[i] - scroll}px) scale(${i === this.active ? 1 : small})`;
      el.style.filter = i === this.active || scrolling || !k ? 'none' : `blur(${(Math.min(0.3 + dist * 0.5, 2.4) * k).toFixed(2)}px)`;
      el.classList.toggle('on', i === this.active);
    });
    const cur = this.lines[this.active] || null;
    if (cur !== this._tyEl || theme !== this._tyTheme) { this._tyEl = cur; this._tyTheme = theme; if (cur && theme === 'terminal') this.typeLine(cur, this.active); }
    // a theme's own effects can follow the lyrics: 'miku-lyric-line' fires once each time another line becomes the current one
    if (cur !== this._evLine) { this._evLine = cur; if (cur) window.dispatchEvent(new CustomEvent('miku-lyric-line', { detail: { el: cur, index: this.active, manual: !!manual } })); }
    // Commit all instant positions together; reading after each line forced one layout per lyric line.
    if (instant) { void box.offsetWidth; this.lines.forEach(el => { el.style.transitionDuration = ''; }); }
  },

  unscroll() {
    clearTimeout(this._back);
    if (!this.manualOffset && !this.manualUntil) return;
    this.manualOffset = 0; this.manualUntil = 0;
    this.layoutLines();
  },

  /**
   * 終端機 theme only: the line that just became current types out like a terminal, character by character, with a
   * block cursor that blinks once it is done (themes.css, sig/terminal.css: .tm-ty, .tm-c, .tm-cur). The characters are
   * wrapped in spans once, the first time the line is current; from then on the browser does the typing (one CSS
   * animation per character, delays from --i), so nothing runs per frame here. The typing ends by about 60 % of the
   * time until the next line and within 2.8 s, never slower than 60 ms per cell (a CJK character is two cells: about
   * 8 a second, a Latin letter 16): short lines type at a reading pace, long ones faster. Opened, seeked or clicked
   * into the middle of a line, it starts where it would be by now (--ty-skip), so a seek never replays a line from the
   * start. Lightweight mode (ambient) or reduced motion: the line
   * shows whole, with a cursor that does not blink.
   */
  typeLine(el, i) {
    const L = this.ly && this.ly.lines, l = L && L[i];
    if (!l || !l.text) return;   // a pause between lines (.gap): its dots
    if (!el._cur) {
      el._cur = h('span', { class: 'tm-cur', 'aria-hidden': 'true' });
      el.insertBefore(el._cur, el.querySelector(':scope > .tr'));
    }
    const still = PageEffects.reduced('ambient') || matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.classList.toggle('tm-ty', !still);
    if (still) return;
    if (!el._cells) {
      // each character (grapheme) in a span: --i = cells typed before it, --w = 2 for a wide (CJK) character
      const wide = /[\u1100-\u115F\u2E80-\u303E\u3041-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
      const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
      let cells = 0;
      const split = node => {
        for (const n of [...node.childNodes]) {
          if (n.nodeType === 3) {
            const frag = document.createDocumentFragment();
            for (const g of seg ? Array.from(seg.segment(n.data), s => s.segment) : Array.from(n.data)) {
              const c = document.createElement('span'), w = wide.test(g) ? 2 : 1;
              c.className = 'tm-c'; c.textContent = g;
              c.style.setProperty('--i', cells);
              if (w !== 1) c.style.setProperty('--w', w);
              cells += w; frag.append(c);
            }
            n.replaceWith(frag);
          } else if (n.nodeType === 1 && n.classList.contains('w')) split(n);   // word-by-word lyrics: inside each word
        }
      };
      split(el);
      el._cells = Math.max(1, cells);
    }
    const next = L[i + 1];
    const gap = next ? Math.max(0.3, next.t - l.t) : 4;
    const total = Math.min(0.62 * gap, el._cells * 0.06, 2.8);
    const skip = Math.max(0, App.pos + (this.ly.offset || 0) - l.t);
    el.style.setProperty('--ty-u', (total / el._cells).toFixed(4) + 's');
    el.style.setProperty('--ty-total', total.toFixed(3) + 's');
    el.style.setProperty('--ty-skip', skip.toFixed(3) + 's');
  },

  tick(pos) {
    if (!this.open || !this.ly || !this.ly.synced || !this.lines.length) return;
    const p = pos + (this.ly.offset || 0);
    const L = this.ly.lines;
    // binary search for the last line that started
    let lo = 0, hi = L.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= p + 0.15) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    // The engine reports where the sound card has got to five times a second, in steps, and every report resets the clock
    // this counts on from (App.setState); a report a little behind the page's own count put the position back a few
    // hundredths of a second. Right at a line change that marked the previous line again, then this one again, over and
    // over: the whole list jumped up and down and the blur flashed. Going back a line now takes a real step back (a
    // seek, a click on a line, or the position more than 0.6 s before this line's start).
    if (idx === this.active - 1 && this.active >= 0 && p + 0.15 > L[this.active].t - 0.6) idx = this.active;
    if (performance.now() >= this.manualUntil && this.manualOffset) { this.manualOffset = 0; this.layoutLines(); }
    if (idx !== this.active && !(performance.now() < this._hold)) { this.active = idx; this.layoutLines(); }
    // word-by-word fill for enhanced LRC
    if (idx >= 0 && L[idx].words) {
      const line = this.lines[idx];
      const words = L[idx].words, spans = line._w || (line._w = line.querySelectorAll('.w'));
      const lineEnd = idx + 1 < L.length ? L[idx + 1].t : words[words.length - 1].t + 1.5;
      for (let k = 0; k < spans.length; k++) {
        const ws = words[k].t, we = k + 1 < words.length ? words[k + 1].t : lineEnd;
        const f = Math.max(0, Math.min(1, (p - ws) / Math.max(0.05, we - ws)));
        const v = (f * 100).toFixed(1) + '%';
        if (spans[k]._p !== v) { spans[k]._p = v; spans[k].style.setProperty('--p', v); }
      }
    }
  },

  /** Seconds until tick() has something to draw; 0 = every frame (the word-by-word fill of the line being sung). */
  nextTick(pos) {
    if (!this.open || !this.ly || !this.ly.synced || !this.lines.length) return Infinity;
    const L = this.ly.lines, p = pos + (this.ly.offset || 0), now = performance.now();
    if (this.active < -1) return 0.02;   // lyrics just drawn: no line marked yet
    if (this.active >= 0 && L[this.active] && L[this.active].words) return 0;
    const next = L[this.active + 1];
    let wait = next ? Math.max(0.02, next.t - 0.15 - p) : Infinity;
    // a manual scroll or a hold that ends by itself
    for (const until of [this.manualOffset ? this.manualUntil : 0, this._hold || 0]) if (until > now) wait = Math.min(wait, (until - now) / 1000 + 0.01);
    return wait;
  },

  nudge(d) {
    if (!this.ly) return;
    this.ly.offset = Math.round(((this.ly.offset || 0) + d) * 10) / 10;
    $('#ly-off').textContent = fmtOffset(this.ly.offset);
    Host.call('lyricsOffset', { id: this.ly.id, offset: this.ly.offset });
  },
};
NowPlaying.init();

/** Reads a lyrics file chosen by the listener: UTF-8 / UTF-16 (BOM), else the legacy encodings old .lrc files use (Shift-JIS, Big5, GBK). */
async function readLyricsFile(f) {
  const b = new Uint8Array(await f.arrayBuffer());
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { }
  // not UTF-8: the legacy encoding that decodes with the fewest replacement characters
  let best = null, bad = Infinity;
  for (const enc of ['shift_jis', 'big5', 'gbk']) {
    try {
      const s = new TextDecoder(enc).decode(b), n = (s.match(/\uFFFD/g) || []).length;
      if (n < bad) { best = s; bad = n; }
    } catch { }
  }
  return best ?? new TextDecoder('utf-8').decode(b);
}
