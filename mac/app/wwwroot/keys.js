'use strict';
/* Keyboard shortcuts: default bindings + user overrides (localStorage miku.keys = {actionId: combo|''}).
 * A combo is "Ctrl+Alt+Shift+Meta+Key" (modifiers in that order; Key = e.key, letters upper-case, ' ' → Space).
 * App.bindKeys (core.js) calls Keys.handle(e); Settings → 快捷鍵 calls Keys.renderSettings(). */
const Keys = {
  IS_MAC: /Mac/i.test(navigator.platform || navigator.userAgent),
  STORE: 'miku.keys',
  recording: false,

  // [id, label, windows default, mac default, run, works while typing in a text box]
  ACTIONS: [
    ['playPause', '播放 / 暫停', 'Space', 'Space', () => App.toggle()],
    ['next', '下一首', 'Ctrl+N', 'Meta+N', () => Host.call('next')],
    ['prev', '上一首', 'Ctrl+P', 'Meta+P', () => Host.call('prev')],
    ['seekFwd', '快轉 5 秒', 'ArrowRight', 'ArrowRight', () => App.seek(Math.min(App.state.dur, App.pos + 5))],
    ['seekBack', '倒轉 5 秒', 'ArrowLeft', 'ArrowLeft', () => App.seek(Math.max(0, App.pos - 5))],
    ['seekFwdBig', '快轉 30 秒', 'Shift+ArrowRight', 'Shift+ArrowRight', () => App.seek(Math.min(App.state.dur, App.pos + 30))],
    ['seekBackBig', '倒轉 30 秒', 'Shift+ArrowLeft', 'Shift+ArrowLeft', () => App.seek(Math.max(0, App.pos - 30))],
    ['volUp', '音量 +1 dB', 'Ctrl+ArrowUp', 'Meta+ArrowUp', () => App.setVolume(App.state.volumeDb + 1, false)],
    ['volDown', '音量 −1 dB', 'Ctrl+ArrowDown', 'Meta+ArrowDown', () => App.setVolume(App.state.volumeDb - 1, false)],
    ['mute', '靜音', 'M', 'M', () => $('#b-mute').click()],
    ['nowPlaying', '正在播放', 'L', 'L', () => NowPlaying.toggle()],
    ['queue', '播放佇列', 'Q', 'Q', () => Drawer.toggle('queue')],
    ['dsp', 'DSP', 'D', 'D', () => Drawer.toggle('dsp')],
    ['search', '搜尋', 'Ctrl+F', 'Meta+F', () => { $('#q').focus(); $('#q').select(); }, true],
    ['fullscreen', '進入 / 離開全螢幕', 'F11', 'Ctrl+Meta+F', () => Host.call('fullscreen'), true],
    ['settings', '設定', 'Ctrl+,', 'Meta+,', () => { location.hash = '#/settings'; }, true],
    ['back', '上一頁', 'Alt+ArrowLeft', 'Meta+[', () => history.back()],
    ['forward', '下一頁', 'Alt+ArrowRight', 'Meta+]', () => history.forward()],
  ],

  overrides() { try { return JSON.parse(localStorage.getItem(this.STORE)) || {}; } catch { return {}; } },
  save(o) { try { localStorage.setItem(this.STORE, JSON.stringify(o)); } catch {} this._map = null; },
  def(a) { return this.IS_MAC ? a[3] : a[2]; },
  get(id) {
    const o = this.overrides(), a = this.ACTIONS.find(x => x[0] === id);
    return id in o ? o[id] : a ? this.def(a) : '';
  },
  set(id, combo) {
    const o = this.overrides();
    let taken = null;
    if (combo) for (const a of this.ACTIONS) if (a[0] !== id && this.get(a[0]) === combo) { o[a[0]] = ''; taken = a; }
    const a = this.ACTIONS.find(x => x[0] === id);
    if (a && combo === this.def(a)) delete o[id]; else o[id] = combo;
    this.save(o);
    return taken;
  },
  reset() { this.save({}); },
  isDefault() { return !Object.keys(this.overrides()).length; },

  /** "Ctrl+Shift+F" for a keydown, or null for a bare modifier press. */
  combo(e) {
    let k = e.key;
    if (!k || /^(Control|Shift|Alt|Meta|OS|AltGraph|CapsLock|Dead|Unidentified|Process)$/.test(k)) return null;
    if (k === ' ' || k === 'Spacebar') k = 'Space';
    else if (k.length === 1) k = k.toUpperCase();
    // shifted punctuation / letters: use the physical key so Shift+1 stays "Shift+1", not "Shift+!"
    if (e.shiftKey && e.code) {
      const m = /^(?:Digit(\d)|Key([A-Z]))$/.exec(e.code);
      if (m) k = m[1] || m[2];
    }
    if (e.altKey && e.code) { const m = /^(?:Digit(\d)|Key([A-Z]))$/.exec(e.code); if (m) k = m[1] || m[2]; }
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', k].filter(Boolean).join('+');
  },

  /** Run the bound action for a keydown; returns true when one ran. */
  handle(e, typing) {
    if (this.recording) return false;
    const c = this.combo(e);
    if (!c) return false;
    for (const a of this.ACTIONS) {
      if (this.get(a[0]) !== c) continue;
      // while typing, only chords (with Ctrl/Alt/Meta or an F-key) of "global" actions run
      if (typing && !(a[5] && (/^(Ctrl|Alt|Meta)\+/.test(c) || /^F\d+$/.test(c)))) return false;
      e.preventDefault();
      a[4]();
      return true;
    }
    return false;
  },

  /** Human-readable pieces of a combo for <kbd> chips. */
  pretty(c) {
    if (!c) return [];
    const MAC = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
    const WIN = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
    const KEY = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: T('空白鍵'), Escape: 'Esc',
      Enter: this.IS_MAC ? '↩' : 'Enter', Backspace: this.IS_MAC ? '⌫' : 'Backspace', Delete: this.IS_MAC ? '⌦' : 'Del',
      Tab: this.IS_MAC ? '⇥' : 'Tab', PageUp: 'PgUp', PageDown: 'PgDn' };
    const parts = c === '+' ? ['+'] : c.replace(/\+\+$/, '+PLUS').split('+').map(p => p === 'PLUS' ? '+' : p);
    return parts.map((p, i) => i < parts.length - 1 ? (this.IS_MAC ? MAC : WIN)[p] || p : KEY[p] || p);
  },
  chips(c) {
    const ps = this.pretty(c);
    return ps.length ? ps.map(p => h('kbd', null, p)) : [h('span', { class: 'kb-none' }, T('未設定'))];
  },

  /** Settings → 快捷鍵 tab. */
  renderSettings(section, field) {
    const sect = section(T('快捷鍵'), T('點一下按鍵組合，再按下新的按鍵即可更改。按 Esc 取消，Backspace 清除。'));
    const rows = h('div');
    sect.append(rows);
    let stop = null;
    // 進入 / 離開全螢幕: label follows the current state (html.fullscreen, set by App.syncFullscreen)
    const fsBtn = () => {
      const b = h('button', { class: 'btn small', onclick: () => App.fullscreen ? Host.call('fullscreen', { on: false }) : Host.call('fullscreen') });
      const sync = () => { b.textContent = App.fullscreen ? T('離開全螢幕') : T('進入全螢幕'); };
      sync();
      const mo = new MutationObserver(() => { if (!b.isConnected) return mo.disconnect(); sync(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return b;
    };
    const draw = () => {
      rows.replaceChildren(...this.ACTIONS.map(a => {
        const id = a[0], cur = this.get(id), changed = cur !== this.def(a);
        const btn = h('button', { class: 'kb-btn' + (changed ? ' changed' : ''), title: T('點一下以更改') }, ...this.chips(cur));
        btn.onclick = () => record(btn, id);
        const extra = id === 'fullscreen'
          ? fsBtn()
          : null;
        const undo = changed ? h('button', { class: 'icon-btn kb-undo', title: T('還原預設'), html: icon('refresh'), onclick: () => { this.set(id, this.def(a)); draw(); } }) : null;
        return field(T(a[1]), changed ? T`預設：${this.pretty(this.def(a)).join(this.IS_MAC ? '' : ' + ') || T('未設定')}` : null,
          h('div', { class: 'kb-ctl' }, extra, undo, btn));
      }));
    };
    const record = (btn, id) => {
      if (stop) stop();
      this.recording = true;
      btn.classList.add('rec');
      btn.replaceChildren(h('span', { class: 'kb-wait' }, T('按下新的按鍵…')));
      const onKey = e => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') return done();
        if (e.key === 'Backspace' || e.key === 'Delete') { if (!e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) { this.set(id, ''); return done(); } }
        const c = this.combo(e);
        if (!c) return;
        const taken = this.set(id, c);
        if (taken) toast(T`已從「${T(taken[1])}」移除這個按鍵`);
        done();
      };
      const onDown = e => { if (!btn.contains(e.target)) done(); };
      const done = () => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('blur', done);
        this.recording = false; stop = null;
        draw();
      };
      stop = done;
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => document.addEventListener('pointerdown', onDown, true));
      window.addEventListener('blur', done);
    };
    draw();
    const foot = h('div', { class: 'kb-foot' },
      h('small', null, T('Esc 一律用來關閉視窗 / 離開全螢幕，F12 開啟開發者工具，這兩個不能更改。')),
      h('button', { class: 'btn small ghost', onclick: () => { this.reset(); draw(); toast(T('已還原預設快捷鍵')); } }, T('全部還原預設')));
    sect.append(foot);
  },
};
