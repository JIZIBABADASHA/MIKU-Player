'use strict';
/* ═════════════════════════════ background jobs ═════════════════════════════
   Work that takes a while goes on when its window is closed, and shows where it is in a card in the sidebar (under the
   menu, like the CD rip's): what it is, n / total and a bar, anywhere in the app. Several at once, each its own card.
   Done: the card says so and goes after a moment (and a toast); failed: it stays, red, with what went wrong, until
   closed. A click on the card goes to what it is about (the album, the convert window, the settings).

   Jobs      the cards
   TagJobs   writing tags / covers into an album's files (tags.save): the cover view's 寫入音樂檔案 and the tag
             editor's 儲存; several albums at once (the host writes a few files at a time over all of them)
   and the settings page's 補齊所有缺少的封面 / 搜尋所有歌詞 (artJob / lyricsJob), convert.js's 轉換格式 / CUE 分軌. */
const Jobs = {
  list: new Set(),
  batch: {},                // artJob / lyricsJob → the card of the one running (the settings page's buttons go by it)
  /**
   * A card: { title, art: [kind, id] | null, icon, open() — click, stop() — a 停止 button while running }.
   * Returns the job: set({ done, total, text }), finish(state 'done' | 'error' | 'stopped', text), remove().
   */
  add(o) {
    const job = { ...o, done: 0, total: 0, text: o.text || '', state: 'running' };
    const detail = h('span', { class: 'cd-task-detail' });
    const bar = h('i');
    const percent = h('span', { class: 'cd-task-percent' });
    const action = h('button', { class: 'btn small ghost', onclick: () => job.state === 'running' ? job.stop && job.stop() : job.remove() });
    const thumb = h('span', { class: 'cd-task-icon job-art' });
    const [kind, id] = o.art || [];
    if (id) thumb.append(h('img', { src: artUrl(kind, id, 44), alt: '' })); else thumb.innerHTML = icon(o.icon || 'list');
    const open = h('button', { class: 'cd-task-open', onclick: () => job.open && job.open() },
      thumb, h('span', { class: 'cd-task-copy' }, h('b', null, o.title), detail), percent);
    const progress = h('div', { class: 'cd-task-bar', role: 'progressbar', 'aria-label': o.title, 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar);
    const card = h('div', { class: 'cd-task job-task running', role: 'region', 'aria-label': o.title }, open, action, progress);
    // newest last, above the CD card (if any)
    const sb = $('#sidebar'), cd = sb.querySelector('.cd-task:not(.job-task)');
    sb.insertBefore(card, cd || null);
    const draw = () => {
      const pct = job.state === 'done' ? 100 : job.total ? Math.min(100, Math.round(job.done / job.total * 100)) : 0;
      card.className = 'cd-task job-task ' + job.state;
      detail.textContent = job.text;
      open.title = o.title + '\n' + job.text;
      open.setAttribute('aria-label', open.title);
      action.hidden = job.state === 'running' && !job.stop;
      action.textContent = job.state === 'running' ? (job.stopping ? T('停止中…') : T('停止')) : T('關閉');
      action.disabled = !!job.stopping && job.state === 'running';
      bar.style.width = pct + '%';
      percent.textContent = job.state === 'running' ? (job.total ? `${job.done}/${job.total}` : '…') : job.state === 'done' ? '✓' : '!';
      progress.setAttribute('aria-valuenow', pct);
    };
    job.set = patch => { if (job.state !== 'running') return job; Object.assign(job, patch); draw(); return job; };
    job.finish = (state, text) => {
      if (job.state !== 'running') return job;
      job.state = state; if (text != null) job.text = text;
      draw();
      if (state === 'done') setTimeout(() => job.remove(), 5000);
      return job;
    };
    job.remove = () => { card.remove(); this.list.delete(job); job.removed = true; };
    if (o.stop) job.stop = () => { if (job.stopping) return; job.stopping = true; draw(); o.stop(); };
    this.list.add(job);
    draw();
    return job;
  },
};

/** tags.save in the background: the cover view's 寫入音樂檔案 and the tag editor's 儲存. */
const TagJobs = {
  jobs: new Map(),          // album id → running job
  seq: 0,
  _progress: Host.on('tagsProgress', p => p && p.job && TagJobs.progress(p)),
  of(albumId) { return this.jobs.get(albumId) || null; },
  /**
   * Writes args ({ tracks, cover, rename }) into the album's files; kind: 'cover' | 'tags'. Resolves with tags.save's
   * result (after the library was read again), rejects on failure; either way told in a toast and the card.
   */
  start(al, args, kind) {
    if (this.of(al.id)) {
      toast(T`「${al.title}」正在寫入，請等它完成`, { error: true });
      return Promise.reject(new Error('busy'));
    }
    const what = kind === 'cover' ? T('寫入封面') : T('寫入標籤');
    const job = { id: 'tags' + (++this.seq) + '-' + Date.now().toString(36), albumId: al.id, title: al.title, state: 'running',
      done: 0, total: kind === 'cover' ? al.tracks.length : 0, written: 0, watchers: new Set(), what };
    job.card = Jobs.add({ title: al.title, art: albumArt(al), icon: 'list', text: what + '…',
      open: () => go('#/album/' + (Lib.resolve(job.albumId) || job.albumId)) });
    this.jobs.set(al.id, job);
    this.sync(job);
    return this.run(job, al, args);
  },
  async run(job, al, args) {
    let r;
    try { r = await Host.call('tags.save', { id: al.id, job: job.id, ...args }); }
    catch (e) {
      job.state = 'error';
      this.jobs.delete(job.albumId);
      job.card.finish('error', T('寫入失敗：') + T.msg(e.message));
      this.sync(job);
      toast(T`「${job.title}」寫入失敗：` + T.msg(e.message), { error: true });
      throw e;
    }
    const failed = r.failed || [];
    job.written = r.written || 0;
    job.state = failed.length ? 'error' : 'done';
    job.done = job.total;
    this.jobs.delete(job.albumId);
    if (r.albumId && r.albumId !== job.albumId) Lib.renamed(job.albumId, r.albumId);
    job.albumId = r.albumId || job.albumId;
    const doneText = [job.written ? T`已寫入 ${job.written} 個檔案` : '', r.renamed ? T`已改名 ${r.renamed} 個檔案` : ''].filter(Boolean).join(T('，'));
    job.card.finish(job.state, failed.length ? T`${failed.length} 個檔案沒有寫入` + (job.written ? T`（已寫入 ${job.written} 個）` : '') : doneText || T('完成'));
    this.sync(job);
    if (failed.length) toast(T`「${job.title}」：${failed.length} 個檔案沒有寫入：\n` + failed.slice(0, 6).map(f => T`${f.file}：${T.msg(f.error)}`).join('\n') + (failed.length > 6 ? '\n…' : ''), { error: true, ms: 12000 });
    if (doneText) toast(T`「${job.title}」：` + doneText);
    await this.reload();
    return r;
  },
  progress(p) {
    const job = [...this.jobs.values()].find(j => j.id === p.job);
    if (!job) return;
    job.total = p.total || job.total;
    job.done = Math.max(job.done, p.done || 0);   // (files are written several at a time: their reports can cross)
    this.sync(job);
  },
  sync(job) {
    if (job.state === 'running') job.card.set({ done: job.done, total: job.total, text: job.total ? `${job.what}… ${job.done} / ${job.total}` : job.what + '…' });
    for (const w of [...job.watchers]) if (!w()) job.watchers.delete(w);
  },
  /** The library read again once for any number of jobs finishing close together. */
  reload() {
    if (this.loading) { this.again = true; return this.loading; }
    return this.loading = (async () => {
      try { do { this.again = false; await Lib.load(); App.trackKey = null; } while (this.again); }
      catch { } finally { this.loading = null; }
    })();
  },
};

/* The settings page's batch searches go on when the page is left: a card for each while it runs. */
(() => {
  const openSettings = () => go('#/settings/library');
  const batch = (ev, title, iconName, text, stop) => {
    let job = null;
    Host.on(ev, p => {
      if (!p) return;
      if (p.done < 0) {
        if (job) job.finish('done');
        job = null; Jobs.batch[ev] = null; return;
      }
      if (!job || job.removed) job = Jobs.add({ title, icon: iconName, open: openSettings, stop: () => Host.call(stop) });
      job.set({ done: p.done, total: p.total, text: text(p) });
      Jobs.batch[ev] = job;
    });
  };
  batch('artJob', T('補齊所有缺少的封面'), 'image', p => T`已檢查 ${p.done} / ${p.total} 張，找到 ${p.found} 張封面`, 'art.cancel');
  batch('lyricsJob', T('搜尋所有歌詞'), 'search', p => T`已檢查 ${p.done} / ${p.total} 首，${p.found} 首有歌詞`, 'lyrics.cancel');
})();
