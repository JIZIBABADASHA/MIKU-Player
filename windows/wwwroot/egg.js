'use strict';
/* The logo's secret: click the MIKU wordmark in the sidebar and it goes into the press. A plate of data as wide as the
   window — hex words, bit streams, sample values, rates, meters — rises from the bottom, slowly, and nothing stops
   it. It meets the logo and keeps coming: the logo is squeezed against the top of the window, trembles, cracks piece
   by piece, and at last bursts; the plate draws back and the pieces come down and lie scattered on the floor of the
   window. They stay there until the logo's place is clicked again, when they rise, whirl and lock back together with a
   flash. Nothing is saved: a broken logo is whole again the next time MIKU starts. With 輕量化頁面 switched on there
   is no secret: a click on the logo does nothing. With reduced motion the logo only changes between broken and whole. */
/* The press has a voice, made here (Web Audio, no files): a rumble that grows as the plate rises, the logo groaning and
   ticking as it cracks, a boom with breaking glass when it bursts, and a rising swell into a chord when it is put back
   together. Silent while MIKU is muted.

   Where it is heard: normally through the system's output, live. But while MIKU plays in exclusive mode it holds the
   DAC alone and nothing else in the system can sound on it, so then the whole cue is rendered ahead (the same score,
   OfflineAudioContext, 48 kHz mono) and handed to the playback engine, which mixes it into what it sends the DAC
   (host "overlay.can" / "overlay.play"; a host without them, or an engine that cannot, leaves it to the live way). */
const EggSound = {
  ctx: null, out: null,
  muted: () => typeof App !== 'undefined' && App.settings && App.settings.muted,
  /** Master level and a limiter in front of the output: the boom is loud, never clipped. Returns where to connect. */
  chain(c) {
    const out = c.createGain(), lim = c.createDynamicsCompressor(), trim = c.createGain();
    out.gain.value = .5; trim.gain.value = .8;
    lim.threshold.value = -10; lim.knee.value = 6; lim.ratio.value = 16; lim.attack.value = .002; lim.release.value = .25;
    out.connect(lim); lim.connect(trim); trim.connect(c.destination);
    return out;
  },
  noise(c, seconds) {
    const b = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const n = c.createBufferSource(); n.buffer = b; return n;
  },
  env(c, out, peak, at, attack, decay) {
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + attack); g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(out); return g;
  },
  /** The crush, from t: the plate rising (rise s), the press (press s) with its cracks (times from t), then the burst. */
  crush(c, out, t, { rise, press, cracks }) {
    const end = t + rise + press;
    // the plate coming: a low drone on a bed of rumble, swelling, harder under load, cut dead at the burst
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(.16, t + rise); g.gain.exponentialRampToValueAtTime(.42, end); g.gain.setTargetAtTime(0.0001, end, .03); g.connect(out);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(70, t); lp.frequency.linearRampToValueAtTime(150, t + rise); lp.frequency.linearRampToValueAtTime(420, end); lp.connect(g);
    const bed = this.noise(c, rise + press + .3); bed.connect(lp); bed.start(t); bed.stop(end + .2);
    const sub = c.createOscillator(); sub.type = 'sine'; sub.frequency.setValueAtTime(34, t); sub.frequency.linearRampToValueAtTime(46, t + rise); sub.frequency.linearRampToValueAtTime(58, end); sub.connect(g); sub.start(t); sub.stop(end + .2);
    // the logo under load: a groan that climbs, shaking faster and faster
    const groan = c.createOscillator(), gg = c.createGain(), gl = c.createBiquadFilter(), trem = c.createOscillator(), tg = c.createGain();
    groan.type = 'sawtooth'; groan.frequency.setValueAtTime(52, t + rise); groan.frequency.exponentialRampToValueAtTime(118, end);
    gl.type = 'bandpass'; gl.frequency.setValueAtTime(260, t + rise); gl.frequency.exponentialRampToValueAtTime(900, end); gl.Q.value = 3;
    gg.gain.setValueAtTime(0.0001, t + rise); gg.gain.exponentialRampToValueAtTime(.2, end); gg.gain.setTargetAtTime(0.0001, end, .03);
    trem.frequency.setValueAtTime(7, t + rise); trem.frequency.linearRampToValueAtTime(26, end); tg.gain.value = .12; trem.connect(tg); tg.connect(gg.gain);
    groan.connect(gl); gl.connect(gg); gg.connect(out);
    groan.start(t + rise); trem.start(t + rise); groan.stop(end + .2); trem.stop(end + .2);
    // the cracks: dry ticks, sharper as it goes
    cracks.forEach((at, k) => {
      const n = this.noise(c, .08), hp = c.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1800 + Math.random() * 2600;
      n.connect(hp); hp.connect(this.env(c, out, .22 * (.5 + k / cracks.length), t + at, .002, .05 + Math.random() * .05)); n.start(t + at); n.stop(t + at + .12);
    });
    // it gives way: a boom that drops through the floor, a blast of noise, and glass for as long as the pieces fly
    const shape = c.createWaveShaper(), curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) curve[i] = Math.tanh((i / 512 - 1) * 3.2);
    shape.curve = curve; shape.connect(this.env(c, out, 1, end, .004, 1.9));
    for (const [f0, f1, type, lvl] of [[150, 26, 'sine', 1], [96, 20, 'triangle', .6]]) {
      const o = c.createOscillator(), og = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, end); o.frequency.exponentialRampToValueAtTime(f1, end + .9); og.gain.value = lvl;
      o.connect(og); og.connect(shape); o.start(end); o.stop(end + 2.1);
    }
    const blast = this.noise(c, 1.4), bl = c.createBiquadFilter();
    bl.type = 'lowpass'; bl.frequency.setValueAtTime(5200, end); bl.frequency.exponentialRampToValueAtTime(120, end + 1.1);
    blast.connect(bl); bl.connect(this.env(c, out, .8, end, .003, 1.2)); blast.start(end); blast.stop(end + 1.5);
    const glass = this.noise(c, 1.6), hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 4200;
    glass.connect(hp); hp.connect(this.env(c, out, .3, end + .02, .01, 1.3)); glass.start(end); glass.stop(end + 1.6);
    for (let i = 0; i < 16; i++) {
      const at = end + .04 + Math.random() * 1.5, o = c.createOscillator();
      o.type = 'sine'; o.frequency.value = 2400 + Math.random() * 5200;
      o.connect(this.env(c, out, .07 + Math.random() * .07, at, .002, .12 + Math.random() * .2)); o.start(at); o.stop(at + .4);
    }
    return rise + press + 2.3;
  },
  /** Put back together: a swell that rises into a bright chord. */
  restore(c, out, t, { seconds }) {
    const n = this.noise(c, seconds + .2), bp = c.createBiquadFilter(), g = c.createGain();
    bp.type = 'bandpass'; bp.Q.value = 1.4; bp.frequency.setValueAtTime(240, t); bp.frequency.exponentialRampToValueAtTime(6400, t + seconds);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(.34, t + seconds * .92); g.gain.exponentialRampToValueAtTime(0.0001, t + seconds + .08); g.connect(out);
    n.connect(bp); bp.connect(g); n.start(t); n.stop(t + seconds + .2);
    [523.25, 783.99, 1046.5, 1567.98].forEach((f, i) => {
      const o = c.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f;
      o.connect(this.env(c, out, .16, t + seconds + i * .035, .006, 1.1)); o.start(t + seconds); o.stop(t + seconds + 1.4);
    });
    return seconds + 1.5;
  },
  /** The exclusive output is in use and its engine can mix a sound in. */
  async engineTakesIt() {
    if (typeof Host === 'undefined' || !Host.call) return false;
    try { return (await Promise.race([Host.call('overlay.can'), new Promise(r => setTimeout(() => r(false), 400))])) === true; }
    catch (e) { return false; }
  },
  /** The cue rendered ahead for the engine: 48 kHz mono, 16-bit, base64. */
  async render(kind, p) {
    const rate = 48000, length = Math.ceil(rate * (kind === 'crush' ? p.rise + p.press + 2.3 : p.seconds + 1.5));
    const c = new OfflineAudioContext(1, length, rate);
    this[kind](c, this.chain(c), 0, p);   // (rendered ahead: silence() replaces it in the engine)
    const d = (await c.startRendering()).getChannelData(0), pcm = new Int16Array(d.length);
    for (let i = 0; i < d.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(d[i] * 32767)));
    const bytes = new Uint8Array(pcm.buffer); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return { rate, pcm: btoa(bin) };
  },
  /** Everything that is sounding stops now (the now-playing page opened over it). */
  silence() {
    try { if (this.ctx) { this.ctx.close(); this.ctx = null; this.out = null; } } catch (e) { }
    if (this.viaEngine) { this.viaEngine = false; try { Host.call('overlay.play', { rate: 48000, pcm: btoa('\0\0\0\0\0\0\0\0') }).catch(() => {}); } catch (e) { } }
  },
  /**
   * Gets a cue ready; the caller starts it the moment the animation starts: `(await EggSound.prepare(…))()`.
   * kind 'crush' { rise, press, cracks } | 'restore' { seconds }.
   */
  async prepare(kind, p) {
    if (this.muted()) return () => {};
    try {
      if (await this.engineTakesIt()) {
        const cue = await this.render(kind, p);
        return () => { this.viaEngine = true; Host.call('overlay.play', cue).catch(() => {}); };
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!this.ctx) { this.ctx = new AC(); this.out = this.chain(this.ctx); }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return () => { this[kind](this.ctx, this.out, this.ctx.currentTime + .02, p); };
    } catch (e) { return () => {}; }
  },
};

const LogoEgg = {
  broken: false, busy: false, shards: null,
  calm: () => matchMedia('(prefers-reduced-motion: reduce)').matches || (typeof PageEffects !== 'undefined' && PageEffects.reduced('page')),
  /** The press plate: columns of data running up and down at their own pace, meters between them, a bright edge on top. */
  wall(width) {
    const hex = n => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.random() * 16 | 0]).join('');
    const bits = n => Array.from({ length: n }, () => Math.random() < .5 ? '0' : '1').join('');
    const pick = a => a[Math.random() * a.length | 0];
    const words = [
      () => '0x' + hex(6), () => bits(16), () => (Math.random() * 2 - 1).toFixed(6), () => pick(['44100', '48000', '88200', '96000', '176400', '192000', '352800', '705600', '2822400', '5644800']) + ' Hz',
      () => pick(['16', '24', '32']) + '-bit', () => 'FFT[' + (1 << (8 + (Math.random() * 6 | 0))) + ']', () => (-Math.random() * 96).toFixed(2) + ' dBFS', () => pick(['DSD64', 'DSD128', 'DoP 05/FA', 'PCM', 'FLAC', 'SYNC', 'LOCK', 'CRC ' + hex(4), 'Δ-Σ 8', 'TPDF', 'HOG', 'RING ' + hex(2)]),
      () => hex(2) + ' ' + hex(2) + ' ' + hex(2) + ' ' + hex(2), () => 'ch' + (Math.random() * 2 | 0) + ' ' + hex(8), () => '#' + String(Math.random() * 1e7 | 0).padStart(7, '0'),
    ];
    const el = document.createElement('div');
    el.className = 'egg-wall';
    const cols = Math.max(8, Math.round(width / 118));
    for (let c = 0; c < cols; c++) {
      if (c % 4 === 2) {   // a meter: bars that never rest
        const m = document.createElement('div'); m.className = 'egg-meter';
        for (let b = 0; b < 46; b++) { const i = document.createElement('i'); i.style.cssText = `animation-duration:${(.35 + Math.random() * .9).toFixed(2)}s;animation-delay:${(-Math.random()).toFixed(2)}s;--w:${(20 + Math.random() * 80).toFixed(0)}%`; m.append(i); }
        el.append(m); continue;
      }
      const col = document.createElement('div');
      col.className = 'egg-col' + (c % 5 === 0 ? ' pink' : c % 3 === 0 ? ' dim' : '');
      const lines = Array.from({ length: 70 }, () => pick(words)()).join('\n');
      const run = document.createElement('pre');
      run.textContent = lines + '\n' + lines;   // twice: the loop has no seam
      run.style.animationDuration = (9 + Math.random() * 16).toFixed(1) + 's';
      if (c % 2) run.style.animationDirection = 'reverse';
      col.append(run); el.append(col);
    }
    const edge = document.createElement('div'); edge.className = 'egg-edge';
    el.append(edge);
    return el;
  },
  init() {
    const brand = document.getElementById('brand');
    if (!brand || brand._egg) return;
    brand._egg = true;
    // 輕量化頁面 on: no secret at all (the logo is just the logo); a logo left in pieces is put back at once
    const off = () => typeof PageEffects !== 'undefined' && PageEffects.enabled;
    const sync = () => {
      brand.style.cursor = off() ? '' : 'pointer';
      if (off() && this.broken && !this.busy) { this.shards && this.shards.remove(); this.shards = null; this.broken = false; brand.classList.remove('egg-broken'); }
    };
    window.addEventListener('miku-effects-change', sync);
    sync();
    // The now-playing page takes the whole window and the player bar (the floor the pieces lie on) goes away: the pieces
    // would be left hanging over the page. The logo is put back, quietly, as the page opens.
    const np = document.getElementById('np');
    const mend = () => {
      if (!this.broken || !np || !np.classList.contains('on')) return;
      // also in the middle of it: the plate, the pieces, the shaking and the sound all go at once, nothing is left
      // over the page
      document.querySelectorAll('.egg-wall, .egg-shards, .egg-spark, .egg-ring').forEach(n => n.remove());
      const app = document.getElementById('app') || document.body;
      app.getAnimations().forEach(a => { try { a.cancel(); } catch (e) { } });
      EggSound.silence();
      this.shards = null; this.broken = false; this.halted = true; brand.classList.remove('egg-broken');
    };
    if (np) new MutationObserver(mend).observe(np, { attributes: true, attributeFilter: ['class'] });
    this.mend = mend;
    brand.addEventListener('click', () => {
      if (this.busy || off()) return;
      // the sidebar drew the logo again (another theme, a resize): it is whole
      if (this.broken && !(this.shards && this.shards.isConnected)) { this.broken = false; brand.classList.remove('egg-broken'); }
      this.broken ? this.revive(brand) : this.crush(brand);
    });
  },
  spark(x, y, n, colors, spread) {
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      s.className = 'egg-spark';
      const a = Math.random() * Math.PI * 2, d = spread * (.45 + Math.random() * .55), size = 4 + Math.random() * 7;
      s.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:${colors[i % colors.length]}`;
      document.body.append(s);
      s.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(-50% + ${Math.cos(a) * d}px), calc(-50% + ${Math.sin(a) * d + d * .35}px)) scale(.2) rotate(${Math.random() * 540}deg)`, opacity: 0 }],
        { duration: 520 + Math.random() * 480, easing: 'cubic-bezier(.1,.7,.3,1)' }).onfinish = () => s.remove();
    }
  },
  /** The floor the pieces land on: the top of the player bar. */
  floor() { const bar = document.getElementById('bar'); return (bar ? bar.getBoundingClientRect().top : innerHeight) - 5; },
  /** The logo cut into irregular triangles (a jittered grid), each a copy of the wordmark behind its own clip, in a
   *  layer over the page so the pieces can leave the sidebar. */
  shatter(logo) {
    const r = logo.getBoundingClientRect(), w = r.width, hgt = r.height;
    const cols = 9, rows = 4, pts = [];
    for (let y = 0; y <= rows; y++) for (let x = 0; x <= cols; x++) {
      const edge = y === 0 || y === rows || x === 0 || x === cols;
      pts.push([x * w / cols + (edge ? 0 : (Math.random() - .5) * w / cols * .75), y * hgt / rows + (edge ? 0 : (Math.random() - .5) * hgt / rows * .75)]);
    }
    const box = document.createElement('div');
    box.className = 'egg-shards';
    box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${w}px;height:${hgt}px`;
    const at = (y, x) => pts[y * (cols + 1) + x], floor = this.floor(), reach = Math.max(r.right + 40, innerWidth * .62);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const q = [at(y, x), at(y, x + 1), at(y + 1, x + 1), at(y + 1, x)];
      for (const tri of (y + x) % 2 ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [[q[0], q[1], q[3]], [q[1], q[2], q[3]]]) {
        const s = document.createElement('div');
        s.className = 'egg-shard';
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        s.style.clipPath = `polygon(${tri.map(p => `${p[0].toFixed(1)}px ${p[1].toFixed(1)}px`).join(',')})`;
        s.style.transformOrigin = `${cx.toFixed(1)}px ${cy.toFixed(1)}px`;
        s.append(logo.cloneNode(true));
        s._x = cx / w; s._y = cy / hgt; s._cx = cx; s._cy = cy;
        // strained: a crack's width out of place
        s._crack = `translate(${((Math.random() - .5) * 5).toFixed(1)}px, ${((Math.random() - .5) * 4).toFixed(1)}px) rotate(${((Math.random() - .5) * 7).toFixed(1)}deg)`;
        // where it lands: thrown out across the floor (some far), turned any way up
        const far = Math.random() < .3;
        const fx = Math.min(reach, Math.max(10, r.left + cx + (far ? 120 + Math.random() * (reach - r.left) : (Math.random() - .35) * 210)));
        s._dx = fx - (r.left + cx); s._dy = floor - Math.random() * 9 - (r.top + cy);
        s._rot = (Math.random() - .5) * 1400; s._up = 8 + Math.random() * 60; s._scale = .85 + Math.random() * .5;   // squeezed out sideways, hardly upwards
        s._rest = `translate(${s._dx.toFixed(1)}px, ${s._dy.toFixed(1)}px) rotate(${s._rot.toFixed(0)}deg) scale(${s._scale.toFixed(2)})`;
        box.append(s);
      }
    }
    document.body.append(box);
    return box;
  },
  /** Thrown up and out, down under its own weight, one bounce on the floor. `from`: where the piece is when it lets go
   *  (pressed flat), so nothing jumps back into shape first. */
  fall(s, from) {
    const frames = [];
    for (let k = 0; k <= 9; k++) {
      const t = k / 9, land = .82, u = Math.min(1, t / land);
      let y = -s._up * u + (s._dy + s._up) * u * u;                       // up first, then gravity
      if (t > land) { const b = (t - land) / (1 - land); y = s._dy - 26 * Math.sin(Math.PI * b) * (1 - b * .4); }
      frames.push({ offset: t, transform: `translate(${(s._dx * Math.min(1, t * 1.08)).toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(s._rot * Math.min(1, t * 1.1)).toFixed(0)}deg) scale(${(1 + (s._scale - 1) * t).toFixed(2)})` });
    }
    frames[frames.length - 1].transform = s._rest;
    if (from) {
      // flat when it lets go, and still flat as it shoots out sideways: it opens up only once it is well clear
      frames[0].transform = `translate(${from.x.toFixed(1)}px, ${from.y.toFixed(1)}px) scale(${from.sx}, ${from.sy.toFixed(3)})`;
      frames.splice(1, 0, { offset: .05, transform: `translate(${(from.x + s._dx * .1 + (s._x - .5) * 70).toFixed(1)}px, ${(from.y - 4).toFixed(1)}px) rotate(${(s._rot * .03).toFixed(0)}deg) scale(1, ${(from.sy * 2.2).toFixed(3)})` });
    }
    return frames;
  },
  async crush(brand) {
    const logo = brand.querySelector('svg.wm'); if (!logo) return;
    this.broken = true; this.halted = false;
    const box = this.shards = this.shatter(logo);
    const pieces = [...box.children];
    brand.classList.add('egg-broken');
    if (this.calm() || !logo.animate) { pieces.forEach(s => { s.style.transform = s._rest; }); return; }
    this.busy = true;
    const r = logo.getBoundingClientRect(), lx = r.left + r.width / 2, ly = r.top + r.height / 2;
    const app = document.getElementById('app') || document.body;
    const wait = t => new Promise(done => setTimeout(done, t));
    const shake = (amp, period) => app.animate([[0, 0], [1, -.8], [-.8, 1.1], [.7, .7], [-1, -.5], [0, 0]].map(([x, y]) => ({ transform: `translate(${x * amp}px, ${y * amp}px)` })), { duration: period, iterations: Infinity });
    // the plate: as wide as the window, rising from below it until its edge is under the logo
    const plate = this.wall(innerWidth);
    plate.classList.add('egg-press');
    plate.style.cssText = `left:0;top:${innerHeight}px;width:${innerWidth}px;height:${innerHeight}px`;
    document.body.append(plate);
    const reach = innerHeight - r.bottom - 3, gap = 7, squeeze = Math.max(4, r.bottom - gap - Math.max(0, r.top - 14));
    // the sound for the whole of it, ready before anything moves (in exclusive mode it is rendered ahead for the engine)
    const pressMs = 2600;
    const cracks = Array.from({ length: 22 }, () => 5.2 + pressMs / 1000 * (.12 + .86 * Math.pow(Math.random(), .7))).sort((a, b) => a - b);
    const sound = await EggSound.prepare('crush', { rise: 5.2, press: pressMs / 1000, cracks });
    const gone = () => { if (!this.halted) return false; this.busy = false; return true; };
    if (gone()) return;
    let rumble = shake(1, 170);
    sound();
    // 1. it rises, at one slow pace; the logo starts to tremble as it comes near
    const rise = plate.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-reach}px)` }], { duration: 5200, easing: 'linear', fill: 'forwards' });
    await wait(5200 - 1100);
    if (gone()) return;
    const tremble = box.animate([[0, 0], [1.2, -.8], [-1.2, .8], [.8, 1.2], [-.8, -1.2], [0, 0]].map(([x, y]) => ({ transform: `translate(${x}px, ${y}px)` })), { duration: 90, iterations: Infinity });
    try { await rise.finished; } catch { }
    if (gone()) return;
    // 2. contact, and it does not stop: slower now, against the logo's resistance, squeezing it flat against the top of
    //    the window; the pieces crack from the bottom up, chips fly, everything shakes harder
    tremble.cancel(); rumble.cancel(); rumble = shake(2.2, 110);
    plate.animate([{ transform: `translateY(${-reach}px)` }, { transform: `translateY(${-reach - squeeze}px)` }], { duration: pressMs, easing: 'cubic-bezier(.3,.5,.7,1)', fill: 'forwards' });
    const lift = -Math.min(r.top - 6, squeeze * .35), sx = 1.16, sy = gap / r.height;
    box.animate([{ transform: 'translateY(0) scale(1,1)' }, { transform: `translateY(${lift}px) scale(${sx}, ${sy.toFixed(3)})` }],
      { duration: pressMs, easing: 'cubic-bezier(.3,.5,.7,1)', fill: 'forwards' });
    pieces.forEach(s => s.animate([{ transform: 'none' }, { transform: s._crack }], { duration: 200, delay: (1 - s._y) * pressMs * .55 + Math.random() * 500, easing: 'ease-out', fill: 'both' }));
    for (let k = 1; k <= 4; k++) setTimeout(() => this.spark(r.left + Math.random() * r.width, r.bottom - k * r.height / 5, 5 + k * 2, ['#ffffff', '#39c5bb', '#e5307e'], 50 + k * 16), pressMs * k / 5);
    await wait(pressMs);
    if (gone()) return;
    // 3. it gives way: the pieces shoot out of the gap, the plate draws back, and they come down all over the floor
    rumble.cancel();
    box.classList.add('egg-out');
    // each piece lets go from where the press held it: the box's squeeze becomes the piece's own first position, so the
    // logo does not spring back into shape for a frame before it flies apart
    const pressed = s => ({ x: (s._cx - r.width / 2) * (sx - 1), y: s._cy * (sy - 1) + lift, sx, sy });
    pieces.forEach(s => { const q = pressed(s); s.getAnimations().forEach(a => a.cancel()); s.style.transform = `translate(${q.x.toFixed(1)}px, ${q.y.toFixed(1)}px) scale(${q.sx}, ${q.sy.toFixed(3)})`; });
    box.getAnimations().forEach(a => a.cancel());
    this.spark(lx, r.top + gap, 52, ['#39c5bb', '#e5307e', '#ffffff', '#1c1c20'], 250);
    app.animate([0, 16, -12, 9, -6, 3, 0].map(y => ({ transform: `translate(${y * .4}px, ${y}px)` })), { duration: 680, easing: 'ease-out' });
    const back = plate.animate([{ transform: `translateY(${-reach - squeeze}px)` }, { transform: `translateY(${-reach - squeeze}px)`, offset: .12 }, { transform: 'translateY(0)' }], { duration: 1900, easing: 'cubic-bezier(.6,0,.9,.5)', fill: 'forwards' });
    const falls = pieces.map(s => {
      return s.animate(this.fall(s, pressed(s)), { duration: 1250 + Math.random() * 750, delay: Math.random() * 90, easing: 'linear', fill: 'both' }).finished;
    });
    try { await Promise.all([...falls, back.finished]); } catch { }
    if (gone()) return;
    pieces.forEach(s => { s.style.transform = s._rest; });
    plate.remove();
    this.busy = false;
    this.mend && this.mend();   // (the now-playing page may have been opened meanwhile)
  },
  async revive(brand) {
    const box = this.shards, logo = brand.querySelector('svg.wm');
    this.broken = false; this.halted = false;
    const done = () => { box && box.remove(); this.shards = null; brand.classList.remove('egg-broken'); };
    if (!box || !logo || this.calm() || !logo.animate) { done(); return; }
    this.busy = true;
    const r = logo.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pieces = [...box.children];
    box.classList.add('egg-out');
    (await EggSound.prepare('restore', { seconds: 1.25 + pieces.length * .006 }))();
    // up off the floor in a whirl, then every piece home at once
    const all = pieces.map((s, i) => {
      const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
      return s.animate([
        { transform: s._rest, filter: 'brightness(1)' },
        { transform: `translate(${(s._dx * .55 + Math.cos(a) * d).toFixed(0)}px, ${(s._dy * .35 + Math.sin(a) * d - 30).toFixed(0)}px) rotate(${(Math.random() - .5) * 900}deg) scale(1.25)`, filter: 'brightness(2.2) drop-shadow(0 0 6px #39c5bb)', offset: .5 },
        { transform: 'translate(0,0) rotate(720deg) scale(1.08)', filter: 'brightness(1.7) drop-shadow(0 0 8px #e5307e)', offset: .88 },
        { transform: 'translate(0,0) rotate(720deg) scale(1)', filter: 'brightness(1)' },
      ], { duration: 1250, delay: i * 6, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'both' }).finished;
    });
    try { await Promise.all(all); } catch { }
    if (this.halted) { this.busy = false; return; }
    done();
    const ring = document.createElement('i');
    ring.className = 'egg-ring'; ring.style.cssText = `left:${cx}px;top:${cy}px`;
    document.body.append(ring);
    ring.animate([{ transform: 'translate(-50%,-50%) scale(.1)', opacity: .95 }, { transform: 'translate(-50%,-50%) scale(7)', opacity: 0 }], { duration: 700, easing: 'cubic-bezier(.1,.6,.2,1)' }).onfinish = () => ring.remove();
    this.spark(cx, cy, 34, ['#39c5bb', '#e5307e', '#ffffff', '#ffe66d'], 190);
    const pop = logo.animate([{ transform: 'scale(1.22)', filter: 'brightness(2) drop-shadow(0 0 16px #39c5bb)' }, { transform: 'scale(.96)', filter: 'brightness(1.2) drop-shadow(0 0 8px #e5307e)', offset: .6 }, { transform: 'scale(1)', filter: 'none' }],
      { duration: 420, easing: 'cubic-bezier(.2,.8,.3,1)' });
    try { await pop.finished; } catch { }
    this.busy = false;
  },
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => LogoEgg.init()); else LogoEgg.init();
