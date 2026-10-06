'use strict';
/* ═════════════════════════════ DSP panel ═════════════════════════════ */
const BUILTIN_PRESETS = [
  { name: T('平直'), bands: [] },
  { name: T('低頻增強'), bands: [['LSC', 105, 4.5, 0.7], ['PK', 60, 1.5, 1.0]] },
  { name: T('溫暖'), bands: [['LSC', 150, 2.5, 0.7], ['HSC', 8000, -2.5, 0.7]] },
  { name: T('人聲清晰'), bands: [['PK', 250, -1.5, 1.0], ['PK', 2500, 2.0, 1.2], ['PK', 5000, 1.0, 1.5]] },
  { name: T('高頻柔和'), bands: [['PK', 6000, -2.0, 2.0], ['HSC', 10000, -2.5, 0.7]] },
  { name: T('V 型'), bands: [['LSC', 100, 4, 0.7], ['PK', 1000, -2, 0.8], ['HSC', 9000, 3.5, 0.7]] },
];
const CROSSFEED_PRESETS = [[T('預設'), 700, 4.5], ['Chu Moy', 700, 6.0], ['Jan Meier', 650, 9.5]];

/* RBJ biquad magnitude, mirrored from the engine for drawing */
function biquadMag(b, f, fs = 48000) {
  const fc = Math.min(Math.max(b.fc, 5), fs * 0.49), q = Math.max(b.q || 0.707, 0.05);
  const A = Math.pow(10, b.gain / 40), w = 2 * Math.PI * fc / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), sq = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  switch ((b.type || 'PK').toUpperCase()) {
    case 'LSC': case 'LS':
      b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
      a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; break;
    case 'HSC': case 'HS':
      b0 = A * ((A + 1) + (A - 1) * c + sq); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sq);
      a0 = (A + 1) - (A - 1) * c + sq; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sq; break;
    case 'LP': b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
    case 'HP': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
    default: b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * c; a2 = 1 - al / A;
  }
  const W = 2 * Math.PI * f / fs, c1 = Math.cos(W), s1 = Math.sin(W), c2 = Math.cos(2 * W), s2 = Math.sin(2 * W);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}
const isIdentity = b => !['LP', 'HP'].includes((b.type || '').toUpperCase()) && Math.abs(b.gain) < 1e-6;

/** Parses AutoEq / Equalizer APO "ParametricEQ.txt" text */
function parseParametric(text) {
  const bands = [];
  let preamp = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^Preamp:\s*([-+\d.]+)\s*dB/i);
    if (m) { preamp = parseFloat(m[1]); continue; }
    m = line.match(/^Filter\s*\d*:\s*(ON|OFF)\s+([A-Z]+)(?:\s+\d+dB)?\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+([-+\d.]+)\s*dB)?(?:\s+Q\s+([\d.]+))?/i);
    if (m) {
      let type = m[2].toUpperCase();
      if (type === 'LS' || type === 'LSC' || type === 'LSQ') type = 'LSC';
      else if (type === 'HS' || type === 'HSC' || type === 'HSQ') type = 'HSC';
      else if (type === 'LP' || type === 'LPQ') type = 'LP';
      else if (type === 'HP' || type === 'HPQ') type = 'HP';
      else type = 'PK';
      bands.push({ on: m[1].toUpperCase() === 'ON', type, fc: parseFloat(m[3]), gain: parseFloat(m[4] || '0'), q: parseFloat(m[5] || '0.707') });
    }
  }
  return { bands, preamp };
}
function toParametric(cfg) {
  const lines = [`Preamp: ${(cfg.preampDb || 0).toFixed(1)} dB`];
  cfg.bands.forEach((b, i) => lines.push(`Filter ${i + 1}: ${b.on ? 'ON' : 'OFF'} ${b.type} Fc ${Math.round(b.fc)} Hz Gain ${b.gain.toFixed(1)} dB Q ${b.q.toFixed(2)}`));
  return lines.join('\n');
}

const Dsp = {
  sel: 0,
  get cfg() { return App.settings.dsp; },
  send: null,

  push() {
    if (!this.send) this.send = throttle(() => Host.call('dsp', this.cfg), 60);
    this.send();
    $('#dsp-master').classList.toggle('on', !!this.cfg.enabled);
  },

  render() {
    const cfg = this.cfg, body = $('#dsp-body');
    const master = $('#dsp-master');
    master.classList.toggle('on', !!cfg.enabled);
    master.onclick = () => { cfg.enabled = !cfg.enabled; this.push(); this.render(); };
    body.textContent = '';
    if (App.state.signal && App.state.signal.dop) body.append(h('div', { class: 'warn', style: { margin: '0 10px 12px' } }, T('目前以 DoP 輸出原生 DSD，DSP 不會作用在這首曲目。')));
    const off = !cfg.enabled ? ' off' : '';

    /* ── EQ card ── */
    const eq = h('div', { class: 'dsp-card' + off });
    const presetSel = h('select', { class: 'sel', style: { maxWidth: '220px' } });
    const allPresets = [...BUILTIN_PRESETS.map(p => ({ name: p.name, builtin: true, preampDb: 0, bands: p.bands.map(([type, fc, gain, q]) => ({ on: true, type, fc, gain, q })) })), ...(App.settings.presets || [])];
    presetSel.append(h('option', { value: '' }, cfg.presetName ? cfg.presetName : T('自訂')));
    allPresets.forEach((p, i) => presetSel.append(h('option', { value: i }, (p.builtin ? '' : '★ ') + p.name)));
    presetSel.onchange = () => {
      const p = allPresets[+presetSel.value];
      if (!p) return;
      cfg.bands = p.bands.map(b => ({ ...b }));
      if (!cfg.bands.length) cfg.bands = defaultBands();
      cfg.presetName = p.name;
      if (p.preampDb) { cfg.preampDb = p.preampDb; }
      cfg.enabled = true; cfg.eqOn = true;
      this.sel = 0; this.push(); this.render();
    };
    const eqSwitch = h('span', { class: 'switch' + (cfg.eqOn ? ' on' : ''), title: T('啟用 EQ'), onclick: () => { cfg.eqOn = !cfg.eqOn; this.push(); this.render(); } });
    eq.append(h('h3', null, T('參數等化器'), h('span', { class: 'grow' }), presetSel, eqSwitch));
    const graph = h('div', { class: 'eq-graph' }, h('canvas'));
    eq.append(graph);
    this.graph = graph;

    const tbl = h('table', { class: 'band-table' });
    cfg.bands.forEach((b, i) => {
      const inp = (val, step, fn, w) => { const x = h('input', { class: 'inp num', type: 'number', step, value: val, style: { width: w } }); x.onchange = () => { fn(parseFloat(x.value)); cfg.presetName = ''; this.push(); this.drawGraph(); }; return x; };
      const type = h('select', { class: 'sel' }, ...[['PK', T('峰值')], ['LSC', T('低架')], ['HSC', T('高架')], ['LP', T('低通')], ['HP', T('高通')]].map(([v, l]) => h('option', { value: v, selected: b.type === v }, l)));
      type.onchange = () => { b.type = type.value; cfg.presetName = ''; this.push(); this.drawGraph(); };
      const sw = h('span', { class: 'switch' + (b.on ? ' on' : ''), onclick: () => { b.on = !b.on; sw.classList.toggle('on', b.on); cfg.presetName = ''; this.push(); this.drawGraph(); } });
      const tr = h('tr', { class: i === this.sel ? 'sel' : '', onclick: () => { this.sel = i; $$('tr', tbl).forEach((r, k) => r.classList.toggle('sel', k === i)); this.drawGraph(); } },
        h('td', { class: 'n num' }, i + 1),
        h('td', { style: { width: '84px' } }, type),
        h('td', null, inp(Math.round(b.fc), 1, v => b.fc = Math.min(22000, Math.max(10, v || 1000)), '100%')),
        h('td', null, inp(b.gain.toFixed(1), 0.1, v => b.gain = Math.min(24, Math.max(-24, v || 0)), '100%')),
        h('td', null, inp(b.q.toFixed(2), 0.01, v => b.q = Math.min(20, Math.max(0.1, v || 0.7)), '100%')),
        h('td', { style: { width: '50px' } }, sw),
        h('td', { style: { width: '40px' } }, h('button', { class: 'icon-btn', title: T('刪除'), html: icon('trash'), onclick: e => { e.stopPropagation(); cfg.bands.splice(i, 1); this.sel = Math.max(0, this.sel - 1); cfg.presetName = ''; this.push(); this.render(); } })));
      tbl.append(tr);
    });
    const headRow = h('tr', { style: { color: 'var(--text-3)', fontSize: '12px' } }, h('td'), h('td', null, T('類型', 'filter')), h('td', null, T('頻率 Hz')), h('td', null, T('增益 dB')), h('td', null, 'Q'), h('td'), h('td'));
    tbl.prepend(headRow);
    eq.append(tbl);
    const preamp = h('input', { class: 'range', type: 'range', min: -24, max: 6, step: 0.1, value: cfg.preampDb || 0, disabled: cfg.autoPreamp });
    const preampVal = h('span', { class: 'v num', style: { width: 'auto', minWidth: '70px' } }, cfg.autoPreamp ? autoPreampText(cfg) : `${(cfg.preampDb || 0).toFixed(1)} dB`);
    preamp.oninput = () => { cfg.preampDb = +preamp.value; preampVal.textContent = `${cfg.preampDb.toFixed(1)} dB`; this.push(); };
    const autoSw = h('span', { class: 'switch' + (cfg.autoPreamp ? ' on' : ''), title: T('自動前級增益（防止削波）'), onclick: () => { cfg.autoPreamp = !cfg.autoPreamp; this.push(); this.render(); } });
    eq.append(h('div', { class: 'kv', style: { marginTop: '10px' } }, h('span', { class: 'k' }, T('前級增益')), preamp, preampVal, autoSw, h('small', { class: 'muted' }, T('自動防削波'))));
    eq.append(h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
      h('button', { class: 'btn small', html: icon('plus') + T('新增頻段'), onclick: () => { cfg.bands.push({ on: true, type: 'PK', fc: 1000, gain: 0, q: 1 }); this.sel = cfg.bands.length - 1; this.push(); this.render(); } }),
      h('button', { class: 'btn small', html: icon('check') + T('儲存預設'), onclick: () => this.savePreset() }),
      h('button', { class: 'btn small ghost', onclick: () => { cfg.bands = defaultBands(); cfg.presetName = ''; cfg.preampDb = 0; this.push(); this.render(); } }, T('重設')),
      h('button', { class: 'btn small ghost', onclick: () => this.importText() }, T('匯入 / 匯出文字'))));
    body.append(eq);

    /* ── crossfeed & balance ── */
    const cf = cfg.crossfeed;
    const cx = h('div', { class: 'dsp-card' + off });
    const cfSw = h('span', { class: 'switch' + (cf.on ? ' on' : ''), onclick: () => { cf.on = !cf.on; if (cf.on) cfg.enabled = true; this.push(); this.render(); } });
    cx.append(h('h3', null, 'Crossfeed', h('small', { class: 'muted', style: { fontWeight: 400 } }, T('模擬喇叭聆聽，減輕耳機的極端左右分離')), h('span', { class: 'grow' }), cfSw));
    const chips = h('div', { class: 'chips', style: { marginBottom: '6px' } });
    CROSSFEED_PRESETS.forEach(([n, fc, feed]) => chips.append(h('button', { class: 'chip' + (cf.fc === fc && cf.feed === feed ? ' on' : ''), onclick: () => { cf.fc = fc; cf.feed = feed; cf.on = true; cfg.enabled = true; this.push(); this.render(); } }, n)));
    cx.append(chips);
    const kv = (label, min, max, step, val, fmt, set) => {
      const r = h('input', { class: 'range', type: 'range', min, max, step, value: val });
      const v = h('span', { class: 'v num' }, fmt(val));
      r.oninput = () => { set(+r.value); v.textContent = fmt(+r.value); this.push(); };
      return h('div', { class: 'kv' }, h('span', { class: 'k' }, label), r, v);
    };
    cx.append(kv(T('截止頻率'), 300, 2000, 10, cf.fc, v => `${v} Hz`, v => cf.fc = v));
    cx.append(kv(T('交叉量'), 1, 15, 0.5, cf.feed, v => `${(+v).toFixed(1)} dB`, v => cf.feed = v));
    cx.append(kv(T('左右平衡'), -1, 1, 0.01, cfg.balance || 0, v => Math.abs(v) < 0.005 ? T('置中') : (v < 0 ? T`左 ${Math.round(-v * 100)}` : T`右 ${Math.round(v * 100)}`), v => cfg.balance = Math.abs(v) < 0.02 ? 0 : v));
    const inv = h('span', { class: 'switch' + (cfg.invert ? ' on' : ''), onclick: () => { cfg.invert = !cfg.invert; inv.classList.toggle('on', cfg.invert); this.push(); } });
    cx.append(h('div', { class: 'kv' }, h('span', { class: 'k' }, T('極性反轉')), h('span', { style: { flex: 1 } }), inv));
    body.append(cx);

    requestAnimationFrame(() => this.drawGraph());
  },

  async applyAutoEq(e) {
    try {
      const text = await Host.call('autoeq.get', { path: e.path, name: e.name });
      const p = parseParametric(text);
      if (!p.bands.length) throw new Error(T('檔案內沒有濾波器'));
      const cfg = this.cfg;
      cfg.bands = p.bands;
      if (p.preamp != null) { cfg.preampDb = p.preamp; cfg.autoPreamp = false; }
      cfg.presetName = e.name;
      cfg.enabled = true; cfg.eqOn = true;
      this.sel = 0;
      this.push(); this.render();
      toast(T`已套用 ${e.name} 的 AutoEq 校正`);
    } catch (err) { toast(T('下載 AutoEq 設定失敗：') + err.message, { error: true }); }
  },

  savePreset() {
    const name = prompt(T('預設名稱'), this.cfg.presetName || T('我的 EQ'));
    if (!name) return;
    const list = (App.settings.presets || []).filter(p => p.name !== name);
    list.push({ name, preampDb: this.cfg.autoPreamp ? 0 : this.cfg.preampDb, bands: this.cfg.bands.map(b => ({ ...b })) });
    App.settings.presets = list;
    this.cfg.presetName = name;
    Host.call('presets', list);
    this.push(); this.render();
    toast(T('已儲存預設「') + name + T('」'));
  },

  importText() {
    const ta = h('textarea', { class: 'inp', spellcheck: 'false' });
    ta.value = toParametric(this.cfg);
    const box = h('div', { style: { padding: '14px', width: '520px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, T('Equalizer APO / AutoEq 格式')),
      ta,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn small ghost', onclick: () => { navigator.clipboard.writeText(ta.value); toast(T('已複製')); } }, T('複製')),
        h('button', { class: 'btn small primary', onclick: () => {
          const p = parseParametric(ta.value);
          if (!p.bands.length) { toast(T('沒有讀到任何 Filter 行'), { error: true }); return; }
          Object.assign(this.cfg, { bands: p.bands, presetName: '', enabled: true, eqOn: true });
          if (p.preamp != null) { this.cfg.preampDb = p.preamp; this.cfg.autoPreamp = false; }
          Popover.close(); this.push(); this.render();
        } }, T('套用'))));
    Popover.show(box, $('#dsp .drawer-head'), { align: 'right' });
    ta.focus();
  },

  /* ── graph ── */
  /** Redraws the graph once in the next frame: a mouse reports moves far more often than the screen shows them. */
  graphSoon() {
    if (this.graphRaf) return;
    this.graphRaf = requestAnimationFrame(() => { this.graphRaf = 0; this.drawGraph(); });
  },
  drawGraph() {
    const g = this.graph;
    if (!g || !g.isConnected) return;
    const cv = g.querySelector('canvas'), dpr = devicePixelRatio || 1;
    const W = g.clientWidth, H = g.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const fMin = 20, fMax = 20000, dbR = 15;
    const fx = f => Math.log(f / fMin) / Math.log(fMax / fMin) * W;
    const xf = x => fMin * Math.pow(fMax / fMin, x / W);
    const dy = d => H / 2 - d / dbR * (H / 2 - 14);
    const css = getComputedStyle(document.documentElement), cv_ = n => css.getPropertyValue(n).trim();
    const ink = cv_('--ink') || '255,255,255', acc = cv_('--teal-rgb') || '57,197,187';
    ctx.font = '10.5px Segoe UI';
    ctx.lineWidth = 1;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = Math.round(fx(f)) + .5;
      ctx.strokeStyle = `rgba(${ink},.06)`; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.fillStyle = `rgba(${ink},.38)`; ctx.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, H - 5);
    }
    for (const d of [-12, -6, 0, 6, 12]) {
      const y = Math.round(dy(d)) + .5;
      ctx.strokeStyle = d === 0 ? `rgba(${ink},.16)` : `rgba(${ink},.06)`;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillStyle = `rgba(${ink},.38)`; ctx.fillText((d > 0 ? '+' : '') + d, 4, y - 3);
    }
    const cfg = this.cfg;
    const bands = cfg.eqOn ? cfg.bands.filter(b => b.on && !isIdentity(b)) : [];
    let maxDb = -99;
    const pts = [];
    for (let x = 0; x <= W; x += 2) {
      const f = xf(x);
      let m = 1;
      for (const b of bands) m *= biquadMag(b, f);
      const d = 20 * Math.log10(m);
      maxDb = Math.max(maxDb, d);
      pts.push([x, dy(d)]);
    }
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, `rgba(${acc},.32)`); grad.addColorStop(.5, `rgba(${acc},.06)`); grad.addColorStop(1, `rgba(${acc},.32)`);
    ctx.beginPath(); ctx.moveTo(0, dy(0));
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(W, dy(0)); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = cfg.enabled ? cv_('--teal') : cv_('--text-3'); ctx.lineWidth = 2.2; ctx.stroke();
    // handles: reuse nodes so an in-progress drag keeps its pointer capture
    let handles = [...g.querySelectorAll('.eq-handle')];
    if (handles.length !== cfg.bands.length) {
      handles.forEach(n => n.remove());
      handles = cfg.bands.map((b, i) => {
        const hd = h('div', { class: 'eq-handle' }, i + 1);
        hd.onpointerdown = e => {
          e.preventDefault();
          this.sel = i;
          hd.setPointerCapture(e.pointerId);
          const r = g.getBoundingClientRect();
          const mv = ev => {
            const b = this.cfg.bands[i];
            const x2 = Math.max(0, Math.min(r.width, ev.clientX - r.left)), y2 = Math.max(0, Math.min(r.height, ev.clientY - r.top));
            b.fc = Math.round(xf(x2));
            if (!['LP', 'HP'].includes(b.type)) b.gain = Math.max(-dbR, Math.min(dbR, Math.round(((r.height / 2 - y2) / (r.height / 2 - 14) * dbR) * 10) / 10));
            this.cfg.presetName = '';
            this.push(); this.graphSoon();
          };
          const up = () => { hd.removeEventListener('pointermove', mv); hd.removeEventListener('pointerup', up); this.render(); };
          hd.addEventListener('pointermove', mv);
          hd.addEventListener('pointerup', up);
        };
        hd.onwheel = e => { e.preventDefault(); const b = this.cfg.bands[i]; b.q = Math.max(0.1, Math.min(20, Math.round(b.q * (e.deltaY < 0 ? 1.1 : 1 / 1.1) * 100) / 100)); this.push(); this.graphSoon(); };
        g.append(hd);
        return hd;
      });
    }
    cfg.bands.forEach((b, i) => {
      const hd = handles[i];
      const x = fx(Math.min(fMax, Math.max(fMin, b.fc)));
      const yy = ['LP', 'HP'].includes(b.type) ? dy(0) : dy(Math.max(-dbR, Math.min(dbR, b.gain)));
      hd.className = 'eq-handle' + (i === this.sel ? ' sel' : '') + (b.on ? '' : ' off');
      hd.style.left = x + 'px'; hd.style.top = yy + 'px';
      hd.title = T`${b.type} ${Math.round(b.fc)} Hz ${b.gain.toFixed(1)} dB Q ${b.q.toFixed(2)}（滾輪調整 Q）`;
    });
    if (maxDb > 0.05 && !cfg.autoPreamp && (cfg.preampDb || 0) > -maxDb + 0.05) {
      ctx.fillStyle = cv_('--pink-text'); ctx.font = '11.5px Segoe UI';
      ctx.fillText(T`最大增益 +${maxDb.toFixed(1)} dB，建議前級 −${maxDb.toFixed(1)} dB 以免削波`, W - 330, 16);
    }
  },
};
/** Highest boost of the EQ curve in dB. */
function eqMaxDb(cfg) {
  const bands = cfg.eqOn ? cfg.bands.filter(b => b.on && !isIdentity(b)) : [];
  if (!bands.length) return 0;
  let max = -99;
  for (let i = 0; i <= 240; i++) {
    const f = 20 * Math.pow(1000, i / 240);
    let m = 1;
    for (const b of bands) m *= biquadMag(b, f);
    max = Math.max(max, 20 * Math.log10(m));
  }
  return Math.max(0, max);
}
/** Explains what automatic clipping protection does at the current volume. */
function autoPreampText(cfg) {
  const boost = eqMaxDb(cfg);
  const st = App.state;
  const vol = st.volumeMode === 'digital' && !st.muted ? (st.volumeDb ?? 0) : 0;
  const cut = Math.max(0, boost + 0.1 + vol);
  return boost < 0.05 ? T('自動') : cut < 0.05 ? T('自動 · 音量有足夠空間') : T`自動 · 音量上限 −${(boost + 0.1).toFixed(1)} dB`;
}
function defaultBands() {
  return [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((fc, i) => ({ on: true, type: i === 0 ? 'LSC' : i === 9 ? 'HSC' : 'PK', fc, gain: 0, q: 1 }));
}
