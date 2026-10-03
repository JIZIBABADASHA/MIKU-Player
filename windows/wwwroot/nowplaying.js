'use strict';
/* ═════════════════════════════ now playing & lyrics ═════════════════════════════ */
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
    $('#np-trans').onclick = () => { this.showTrans = !this.showTrans; setUiPref('npTrans', this.showTrans ? '1' : '0'); this.renderLyrics(); };
    $('#ly-minus').onclick = () => this.nudge(-0.1);
    $('#ly-plus').onclick = () => this.nudge(0.1);
    $('#ly-auto').onclick = async () => {
      const ly = this.ly, b = $('#ly-auto');
      if (!ly || !ly.synced || b.disabled) return;
      b.disabled = true; b.textContent = '分析中…';
      try {
        const r = await Host.call('lyrics.autoAlign', { id: ly.id });
        if (this.ly !== ly) return;
        if (r && r.ok) {
          ly.offset = r.offset;
          $('#ly-off').textContent = (ly.offset >= 0 ? '+' : '') + ly.offset.toFixed(1) + 's';
          this.active = -2; this.layoutLines(true);
          toast(`已自動對齊（${ly.offset >= 0 ? '+' : ''}${ly.offset.toFixed(1)} 秒）`);
        } else toast((r && r.reason) || '自動對齊失敗');
      } catch { toast('自動對齊失敗'); }
      finally { b.disabled = false; b.textContent = '自動'; }
    };
    $('#np-cand').onclick = e => { e.stopPropagation(); this.togglePicker(); };
    document.addEventListener('click', e => { const p = $('#ly-pick'); if (!p.hidden && !p.contains(e.target)) p.hidden = true; });
    const box = $('#lyrics');
    box.addEventListener('wheel', e => {
      if (!this.ly || !this.ly.synced) return;
      e.preventDefault();
      this.manualOffset += e.deltaY;
      this.manualUntil = performance.now() + 2600;
      this.layoutLines(true);
    }, { passive: false });
    new ResizeObserver(() => { if (this.open) this.measure(); }).observe(box);
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
    requestAnimationFrame(() => this.measure());
  },
  hide(fromPop) {
    if (!this.open) return;
    this.open = false;
    $('#np').classList.remove('on');
    if (!fromPop) OverlayHistory.closed(this._close);
    setTimeout(() => YT.sync(), 500);
  },
  toggle() { this.open ? this.hide() : this.show(); },

  applyLayout() {
    const has = this.showLyrics && this.ly && (this.ly.lines.length > 0);
    $('#np').classList.toggle('nolyrics', !has);
    $('#np-lyr').classList.toggle('on', this.showLyrics);
    const hasTrans = this.ly && this.ly.lines.some(l => l.trans);
    $('#np-trans').style.display = hasTrans && this.showLyrics ? '' : 'none';
    $('#np-trans').classList.toggle('on', this.showTrans);
    $('#np-src').textContent = this.showLyrics && this.ly && this.ly.source ? '歌詞來源：' + this.ly.source : '';
    if (has) requestAnimationFrame(() => this.measure());
  },

  trackChanged(t) {
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
      this.ly = { id: r.id || id, synced: r.synced, lines: (r.lines || []).map(l => ({ t: l.t, text: l.text, trans: l.trans, words: l.words })), offset: r.offset || 0, source: r.source, instrumental: r.instrumental };
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
    if (this.cands && this.cands.length && !this.ly.lines.length) { b.textContent = `可能的歌詞 (${this.cands.length})`; b.classList.add('on'); }
    else if (this.ly.lines.length) { b.textContent = '歌詞不對？'; b.classList.remove('on'); }
    else { b.textContent = '找歌詞'; b.classList.remove('on'); }
    b.style.display = '';
  },
  async loadCands(id, open) {
    const p = $('#ly-pick');
    if (open) { p.hidden = false; p.replaceChildren(h('div', { class: 'ly-pick-msg' }, '搜尋中…')); }
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
      const diff = c.diff === 0 ? '長度相同' : (c.diff > 0 ? '長 ' : '短 ') + Math.abs(c.diff).toFixed(1) + ' 秒';
      const warn = Math.abs(c.diff) > 3 ? ' warn' : '';
      return h('button', { class: 'ly-cand', onclick: async () => {
        p.hidden = true;
        const r = await Host.call('lyrics.apply', { id, key: c.key }).catch(() => null);
        if (!r) { toast('無法下載這份歌詞'); return; }
        if (App.state.trackId !== id) return;
        this.ly = { id: r.id, synced: r.synced, lines: (r.lines || []).map(l => ({ t: l.t, text: l.text, trans: l.trans, words: l.words })), offset: r.offset || 0, source: r.source + '（手動選擇）', instrumental: r.instrumental };
        this.active = -2; this.renderLyrics(); this.applyLayout(); this.updateCandBtn(App.track());
        toast('已套用，之後會固定使用這份歌詞');
      } },
        h('div', { class: 'c1' }, c.title || '?', h('span', { class: 'tag' }, c.source)),
        h('div', { class: 'c2' }, [c.artist, c.album].filter(Boolean).join(' · ')),
        h('div', { class: 'c3' + warn }, `${fmt(c.duration)} · ${diff}` + (c.synced ? ' · 同步' : ' · 純文字')));
    });
    p.replaceChildren(
      h('div', { class: 'ly-pick-head' }, '選擇正確的歌詞'),
      ...(rows.length ? rows : [h('div', { class: 'ly-pick-msg' }, '找不到其他候選。')]),
      h('div', { class: 'ly-pick-foot' },
        h('button', { class: 'btn small ghost', onclick: async () => {
          p.hidden = true;
          await Host.call('lyrics.clear', { id });
          if (App.state.trackId !== id) return;
          this.ly = { id, synced: false, lines: [], offset: 0, source: '已標記為錯誤' };
          this.renderLyrics(); this.applyLayout(); this.updateCandBtn(App.track());
          toast('已回報，這首歌不再自動顯示錯誤的歌詞');
        } }, '都不對，不要顯示歌詞')));
  },

  /* paints cover, background and text for the current track */
  paint() {
    const t = App.track();
    if (!t) return;
    const kind = t.live ? 'y' : t.album?.loose ? 't' : 'a', id = t.live ? t.img : kind === 't' ? t.id : t.albumId;
    const cover = $('#np-cover');
    if (cover.dataset.cur !== kind + id || cover.dataset.v !== String(ArtVer[kind + id] || 0)) {
      cover.dataset.cur = kind + id;
      cover.dataset.v = String(ArtVer[kind + id] || 0);
      const old = cover.querySelector('img.ok');
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        img.classList.add('ok');
        cover.querySelectorAll('.ph').forEach(p => p.remove());
        if (old) setTimeout(() => old.remove(), 700);
      };
      img.onerror = () => { if (!old) fillArt(cover, kind, null, 0, t.album?.title); img.remove(); };
      img.src = t.live ? bigYtImg(t.img, 1200) : artUrl(kind, id, 900);
      cover.append(img);
      // background: small image, heavy blur — cheap and smooth
      const bgA = $('.np-bg .layer.a'), bgB = $('.np-bg .layer.b');
      const small = new Image();
      small.onload = () => {
        for (const l of [bgA, bgB]) { l.classList.remove('on'); }
        setTimeout(() => {
          bgA.style.backgroundImage = bgB.style.backgroundImage = `url("${small.src}")`;
          bgA.classList.add('on'); bgB.classList.add('on');
        }, 260);
      };
      small.onerror = () => { const hue = hashHue(t.album?.title || t.title); bgA.style.backgroundImage = `linear-gradient(135deg, hsl(${hue} 50% 30%), hsl(${(hue + 60) % 360} 50% 18%))`; bgA.classList.add('on'); bgB.classList.remove('on'); };
      small.src = t.live ? bigYtImg(t.img, 120) : artUrl(kind, id, 64);
    }
    $('#np-title').textContent = t.title;
    const artist = t.live ? [h('a', { onclick: () => { this.hide(); go('#/ytmusic'); } }, t.artist || '')]
      : artistLinks(t.artists?.length ? t.artists : [t.artist || ''], () => this.hide());
    const album = h('a', { onclick: () => { this.hide(); go(t.live ? '#/ytmusic' : '#/album/' + t.albumId); } }, t.album?.title || '');
    $('#np-artist').replaceChildren(...artist, ' — ', album);
    const b = $('#np-badges');
    b.textContent = '';
    b.append(h('span', { class: 'badge' }, t.codec));
    if (!t.live) b.append(h('span', { class: 'badge' }, fmtQuality(t.codec, t.rate, t.bits)));
    if (t.year) b.append(h('span', { class: 'badge' }, t.year));
  },

  /* ── lyrics ── */
  renderLyrics() {
    const box = $('#lyrics');
    box.textContent = '';
    this.lines = []; this.tops = []; this.active = -2;
    const ly = this.ly;
    if (!ly) return;
    if (ly.instrumental) { box.append(h('div', { class: 'ly-empty' }, '純音樂，請欣賞')); return; }
    if (!ly.lines.length) { box.append(h('div', { class: 'ly-empty' }, '找不到歌詞')); return; }
    if (!ly.synced) {
      box.append(h('div', { class: 'ly-plain' }, ly.lines.map(l => l.text).join('\n')));
      return;
    }
    ly.lines.forEach((l, i) => {
      const el = h('div', { class: 'ly-line' + (l.text ? '' : ' gap') });
      if (!l.text) el.innerHTML = '<div class="ly-dots"><i></i><i></i><i></i></div>';
      else if (l.words && l.words.length) {
        l.words.forEach(w => el.append(h('span', { class: 'w' }, w.w)));
      } else el.append(l.text);
      if (l.trans && this.showTrans) el.append(h('span', { class: 'tr' }, l.trans));
      el.onclick = () => App.seek(Math.max(0, l.t - (ly.offset || 0) + 0.01));
      box.append(el);
      this.lines.push(el);
    });
    $('#ly-off').textContent = (ly.offset >= 0 ? '+' : '') + (ly.offset || 0).toFixed(1) + 's';
    requestAnimationFrame(() => this.measure());
  },

  measure() {
    if (!this.lines.length) return;
    const box = $('#lyrics');
    // natural flow positions computed once; lines are then moved with transforms only
    let y = 0;
    this.tops = this.lines.map(el => { const top = y; y += el.offsetHeight + 6; return top; });
    this.heights = this.lines.map(el => el.offsetHeight);
    this.boxH = box.clientHeight;
    this.layoutLines(false, true);
  },

  layoutLines(manual, instant) {
    if (!this.tops.length) return;
    const a = Math.max(0, this.active);
    const anchor = this.boxH * 0.36;
    let scroll = this.tops[a] + (this.heights[a] || 0) / 2 - anchor;
    if (performance.now() < this.manualUntil) scroll += this.manualOffset;
    this.lines.forEach((el, i) => {
      const d = i - a;
      const dist = Math.abs(d);
      // the active line moves first, neighbours follow with a short cascade
      const delay = manual || instant || d <= 0 ? 0 : Math.min(dist, 7) * 26;
      el.style.transitionDelay = `${delay}ms, 0ms, 0ms, 0ms`;
      if (instant) el.style.transitionDuration = '0s';
      el.style.transform = `translateY(${this.tops[i] - scroll}px) scale(${i === this.active ? 1 : 0.965})`;
      el.style.filter = i === this.active || performance.now() < this.manualUntil ? 'none' : `blur(${Math.min(dist * 0.7, 3.2)}px)`;
      el.classList.toggle('on', i === this.active);
      if (instant) { void el.offsetWidth; el.style.transitionDuration = ''; }
    });
  },

  tick(pos) {
    if (!this.open || !this.ly || !this.ly.synced || !this.lines.length) return;
    const p = pos + (this.ly.offset || 0);
    const L = this.ly.lines;
    // binary search for the last line that started
    let lo = 0, hi = L.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= p + 0.15) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (performance.now() >= this.manualUntil && this.manualOffset) { this.manualOffset = 0; this.layoutLines(); }
    if (idx !== this.active) { this.active = idx; this.layoutLines(); }
    // word-by-word fill for enhanced LRC
    if (idx >= 0 && L[idx].words) {
      const words = L[idx].words, spans = this.lines[idx].querySelectorAll('.w');
      const lineEnd = idx + 1 < L.length ? L[idx + 1].t : words[words.length - 1].t + 1.5;
      for (let k = 0; k < spans.length; k++) {
        const ws = words[k].t, we = k + 1 < words.length ? words[k + 1].t : lineEnd;
        const f = Math.max(0, Math.min(1, (p - ws) / Math.max(0.05, we - ws)));
        spans[k].style.setProperty('--p', (f * 100).toFixed(1) + '%');
      }
    }
  },

  nudge(d) {
    if (!this.ly) return;
    this.ly.offset = Math.round(((this.ly.offset || 0) + d) * 10) / 10;
    $('#ly-off').textContent = (this.ly.offset >= 0 ? '+' : '') + this.ly.offset.toFixed(1) + 's';
    Host.call('lyricsOffset', { id: this.ly.id, offset: this.ly.offset });
  },
};
NowPlaying.init();
