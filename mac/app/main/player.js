'use strict';
// Queue, shuffle and repeat on top of the audio engine (port of Player.cs)
const { EventEmitter } = require('events');

const shuffled = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

class Player extends EventEmitter {
  constructor(engine, lib, s) {
    super();
    this.engine = engine; this.lib = lib; this.s = s;
    this.queue = (s.queue || []).slice();
    this.index = Math.min(Math.max(s.queueIndex ?? -1, -1), this.queue.length - 1);
    this.unshuffled = null;
    this.failures = 0;
    engine.peekNext = () => this.peekNext();
    engine.on('trackStarted', t => this.onGapless(t));
    engine.on('ended', () => this.onEnded());
  }
  get current() { return this.index >= 0 && this.index < this.queue.length ? this.lib.getTrack(this.queue[this.index]) : null; }
  persist() { this.s.queue = this.queue.slice(); this.s.queueIndex = this.index; }
  changedQueue() { this.emit('queue'); }
  changedNow() { this.emit('now'); }

  peekNext() {
    if (!this.queue.length) return null;
    if (this.s.repeat === 'one') return this.current;
    let n = this.index + 1;
    if (n >= this.queue.length) { if (this.s.repeat !== 'all') return null; n = 0; }
    const t = this.lib.getTrack(this.queue[n]);
    // a CD track not yet copied off the disc can't be preloaded for gapless
    return t && t.codec === 'CD' && this.cd && !this.cd.isReady(t) ? null : t;
  }
  onGapless(t) {
    if (!(this.s.repeat === 'one' && this.current && this.current.id === t.id)) {
      const n = this.index + 1 < this.queue.length ? this.index + 1 : 0;
      if (n < this.queue.length && this.queue[n] === t.id) this.index = n;
      else { const i = this.queue.indexOf(t.id); if (i >= 0) this.index = i; }
    }
    this.failures = 0;
    this.persist(); this.changedNow(); this.changedQueue();
    this.ensureAutoNext();
  }
  onEnded() {
    this.ensureAutoNext();
    let next = null;
    if (this.queue.length) {
      if (this.s.repeat === 'one') next = this.current;
      else if (this.index + 1 < this.queue.length) { this.index++; next = this.current; }
      else if (this.s.repeat === 'all') { this.index = 0; next = this.current; }
    }
    this.persist();
    if (next) this.load(next, 0, true);
    else { this.s.resumePosition = 0; this.engine.stop(); this.engine.pausedAt = 0; }
    this.changedQueue(); this.changedNow();
  }

  async load(t, pos, play) {
    if (!t) return;
    this.changedNow();
    if (t.codec === 'CD' && this.cd) {
      // a track of the disc in the drive: copied into the cache first, playback starts once 20 s are there
      try { await this.cd.prepare(t); }
      catch (e) { this.engine.stop(); this.engine.emit('failed', `無法播放「${t.title}」：${e.message}`); this.changedNow(); return; }
      if (this.current !== t) return;   // something else was chosen meanwhile
    }
    await this.engine.load(t, pos, play);
    if (this.engine.isLoaded) { this.failures = 0; if (play) this.ensureAutoNext(); }
    else if (play && this.engine.track === t && ++this.failures < 3) {
      // unreadable file: move on rather than stalling the queue
      let next = null;
      if (this.index + 1 < this.queue.length) { this.index++; next = this.current; }
      if (next) { this.persist(); this.changedQueue(); await this.load(next, 0, true); }
    }
    this.changedNow();
  }

  // ───────────── commands ─────────────
  playList(ids, start, shuffle) {
    const list = (ids || []).filter(id => this.lib.getTrack(id));
    if (!list.length) return;
    const explicit = start >= 0;
    start = Math.min(Math.max(start, 0), list.length - 1);
    this.s.shuffle = shuffle;
    if (shuffle) {
      this.unshuffled = list.slice();
      const order = shuffled(list);
      if (explicit) { order.splice(order.indexOf(list[start]), 1); order.unshift(list[start]); }
      this.queue = order; this.index = 0;
    } else { this.unshuffled = null; this.queue = list; this.index = start; }
    this.engine.invalidateNext();
    this.persist(); this.changedQueue();
    return this.load(this.current, 0, true);
  }
  jumpTo(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
    return this.load(this.current, 0, true);
  }
  next() {
    if (!this.queue.length) return;
    if (this.index + 1 < this.queue.length) this.index++;
    else if (this.s.repeat !== 'off') this.index = 0;
    else return;
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
    return this.load(this.current, 0, this.engine.isPlaying || !this.engine.track);
  }
  previous() {
    if (this.engine.position > 3 && this.engine.track) return this.engine.seek(0);
    if (!this.queue.length) return;
    if (this.index > 0) this.index--;
    else if (this.s.repeat === 'all') this.index = this.queue.length - 1;
    else return this.engine.seek(0);
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
    return this.load(this.current, 0, this.engine.isPlaying || !this.engine.track);
  }
  toggle() {
    if (this.engine.isLoaded) { if (this.engine.isPlaying) this.engine.pause(); else this.engine.resume(); return; }
    const t = this.current;
    if (!t) return;
    const pos = this.s.resumePosition || 0;
    return this.load(t, pos, true);
  }
  seek(pos) {
    if (this.engine.isLoaded) return this.engine.seek(pos);
    this.s.resumePosition = pos;
    const t = this.current;
    return t ? this.load(t, pos, false) : undefined;
  }
  add(ids, playNext) {
    const valid = (ids || []).filter(id => this.lib.getTrack(id));
    if (playNext && this.index >= 0) this.queue.splice(this.index + 1, 0, ...valid); else this.queue.push(...valid);
    if (this.index < 0 && this.queue.length) this.index = 0;
    if (this.unshuffled) this.unshuffled.push(...valid);
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
  }
  remove(i) {
    if (i < 0 || i >= this.queue.length) return;
    const wasCurrent = i === this.index;
    const id = this.queue[i];
    this.queue.splice(i, 1);
    if (this.unshuffled) { const k = this.unshuffled.indexOf(id); if (k >= 0) this.unshuffled.splice(k, 1); }
    if (i < this.index) this.index--;
    if (this.index >= this.queue.length) this.index = this.queue.length - 1;
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
    if (wasCurrent) { const t = this.current; if (t) this.load(t, 0, this.engine.isPlaying); else this.engine.stop(); }
  }
  move(from, to) {
    if (from < 0 || from >= this.queue.length || to < 0 || to >= this.queue.length || from === to) return;
    const [id] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, id);
    if (this.index === from) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
  }
  clearUpcoming() {
    this.queue = this.index >= 0 && this.index < this.queue.length ? this.queue.slice(0, this.index + 1) : [];
    this.unshuffled = null;
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
  }
  setShuffle(on) {
    if (on === !!this.s.shuffle) return;
    this.s.shuffle = on;
    const cur = this.index >= 0 && this.index < this.queue.length ? this.queue[this.index] : null;
    if (on) {
      this.unshuffled = this.queue.slice();
      this.queue = this.queue.slice(0, this.index + 1).concat(shuffled(this.queue.slice(this.index + 1)));
    } else if (this.unshuffled) {
      this.queue = this.unshuffled; this.unshuffled = null;
      this.index = cur == null ? -1 : this.queue.indexOf(cur);
    }
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
  }
  setRepeat(mode) {
    this.s.repeat = mode === 'all' || mode === 'one' ? mode : 'off';
    this.engine.invalidateNext(); this.changedQueue();
    if (this.engine.isPlaying) this.ensureAutoNext();
  }
  /** Auto continue: when the last queued song is playing, add a random album or a few random songs. */
  ensureAutoNext() {
    const mode = this.s.autoContinue;
    if (mode !== 'albums' && mode !== 'tracks') return;
    if (this.s.repeat !== 'off') return;
    if (!this.queue.length || this.index < this.queue.length - 1) return;
    const cur = this.current;
    const recent = new Set([...(this.s.recent || []).slice(0, 150), ...this.queue.slice(-300)]);
    const albums = this.lib.albumList().filter(a => a.tracks.length);
    if (!albums.length) return;
    const pickOne = arr => arr[Math.floor(Math.random() * arr.length)];
    let add;
    if (mode === 'albums') {
      let others = albums.filter(a => !cur || a.id !== cur.albumId);
      if (!others.length) others = albums;
      const fresh = others.filter(a => !a.tracks.some(t => recent.has(t.id)));
      add = pickOne(fresh.length ? fresh : others).tracks.map(t => t.id);
    } else {
      const all = albums.flatMap(a => a.tracks).filter(t => !cur || t.id !== cur.id);
      if (!all.length) return;
      const fresh = all.filter(t => !recent.has(t.id));
      add = shuffled(fresh.length ? fresh : all).slice(0, 5).map(t => t.id);
    }
    this.queue.push(...add);
    if (this.unshuffled) this.unshuffled.push(...add);
    this.engine.invalidateNext(); this.persist(); this.changedQueue();
  }
  validate() {
    const cur = this.index >= 0 && this.index < this.queue.length ? this.queue[this.index] : null;
    this.queue = this.queue.filter(id => this.lib.getTrack(id));
    this.index = cur == null ? (this.queue.length ? 0 : -1) : Math.max(this.queue.indexOf(cur), this.queue.length ? 0 : -1);
    this.persist(); this.changedQueue();
  }
  /** Track ids follow their files' paths: renamed files get new ids in the queue. */
  renameIds(map) {
    const m = id => map.get(id) || id;
    this.queue = this.queue.map(m);
    if (this.unshuffled) this.unshuffled = this.unshuffled.map(m);
    this.persist();
  }
  /** Loads the current track again at `pos` (after its file was rewritten, e.g. new tags). */
  reload(pos, play) { this.engine.invalidateNext(); return this.load(this.current, pos, play); }
  saveState() { this.persist(); if (this.engine.track) this.s.resumePosition = this.engine.position; }
}

module.exports = { Player };
