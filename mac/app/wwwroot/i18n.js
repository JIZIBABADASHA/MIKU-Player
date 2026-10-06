'use strict';
/* ═════════════════════════════ interface language ═════════════════════════════
 * The page is written in Traditional Chinese; every UI string goes through T('…') or T`…${x}…`
 * and is looked up in I18N_DICT (i18n-dict.js) for 简体中文 / English / 日本語.
 * Template keys use {0} {1} … for the ${} values, so a translation can move them around.
 * The language is read synchronously (localStorage) so strings built while the scripts load are already
 * translated; App.start checks it against the saved setting / the installer's choice and reloads if needed.
 */
const I18N = (() => {
  const LANGS = [['zh-Hant', '繁體中文'], ['zh-Hans', '简体中文'], ['en', 'English'], ['ja', '日本語']];
  const ok = l => LANGS.some(x => x[0] === l);
  // a system / browser locale → one of ours
  const fromLocale = loc => {
    const l = String(loc || '').toLowerCase();
    if (l.startsWith('ja')) return 'ja';
    if (l.startsWith('zh')) return /hans|cn|sg|my/.test(l) && !/hant/.test(l) ? 'zh-Hans' : 'zh-Hant';
    if (l.startsWith('en')) return 'en';
    return l ? 'en' : 'zh-Hant';
  };
  let stored = null;
  try { stored = localStorage.getItem('miku.lang'); } catch (e) { }
  const lang = ok(stored) ? stored : fromLocale(navigator.language);
  const all = (typeof I18N_DICT !== 'undefined' && I18N_DICT) || {};
  const dict = all[lang] || null;

  // host (C# / Electron) messages: exact, "{0}" patterns, then known pieces inside the text
  let pats = null, pieces = null;
  const prepare = () => {
    if (pats) return;
    pats = []; pieces = [];
    for (const k of Object.keys(dict)) {
      if (/\{\d+\}/.test(k)) {
        const order = [];
        const src = k.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\d+)\\?\}/g, (m, i) => { order.push(+i); return '([\\s\\S]*?)'; });
        try { pats.push({ re: new RegExp('^' + src + '$'), order, tr: dict[k] }); } catch (e) { }
      } else if (k.length >= 2 && !/[<>|]/.test(k)) pieces.push(k);
    }
    pieces.sort((a, b) => b.length - a.length);
  };

  const T = (s, ...v) => {
    if (Array.isArray(s) && s.raw) {
      if (!dict) { let r = s[0]; for (let i = 0; i < v.length; i++) r += v[i] + s[i + 1]; return r; }
      let key = s[0];
      for (let i = 1; i < s.length; i++) key += '{' + (i - 1) + '}' + s[i];
      const tr = dict[key] != null ? dict[key] : key;
      return tr.replace(/\{(\d+)\}/g, (m, i) => i < v.length ? String(v[i]) : m);
    }
    if (!dict || s == null) return s;
    // T('專輯', 'nav'): the same Chinese word that needs another wording in a context (Albums vs Album)
    if (typeof v[0] === 'string' && dict[s + '|' + v[0]] != null) return dict[s + '|' + v[0]];
    const tr = dict[s];
    return tr != null ? tr : s;
  };
  /** A message made by the host (errors, signal notes, lyric sources …): translated as far as it's known. */
  T.msg = s => {
    if (!dict || typeof s !== 'string' || !s) return s;
    if (dict[s] != null) return dict[s];
    prepare();
    for (const p of pats) {
      const m = p.re.exec(s);
      if (m) { const vals = []; p.order.forEach((i, n) => vals[i] = m[n + 1]); return p.tr.replace(/\{(\d+)\}/g, (x, i) => vals[i] != null ? T.msg(vals[i]) : x); }
    }
    if (!/[㐀-鿿]/.test(s)) return s;
    let out = '', i = 0;
    while (i < s.length) {
      const k = pieces.find(p => s.startsWith(p, i));
      if (k) { out += dict[k]; i += k.length; } else out += s[i++];
    }
    return out;
  };

  /** The static page: text and labels written in index.html. */
  const translateDom = root => {
    if (!dict) return;
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walk.currentNode; n; n = walk.nextNode()) {
      if (n.nodeType === 3) {
        const t = n.nodeValue.trim();
        const nav = n.parentNode && n.parentNode.parentNode && n.parentNode.parentNode.dataset && n.parentNode.parentNode.dataset.r;
        const tr = t && (nav && dict[t + '|nav'] != null ? dict[t + '|nav'] : dict[t]);
        if (tr != null) n.nodeValue = n.nodeValue.replace(t, tr);
      } else if (n.tagName !== 'SCRIPT' && n.tagName !== 'STYLE') {
        for (const a of ['title', 'placeholder', 'aria-label', 'alt', 'data-tip']) {
          const v = n.getAttribute && n.getAttribute(a);
          if (v && dict[v] != null) n.setAttribute(a, dict[v]);
        }
      }
    }
  };

  document.documentElement.lang = lang;
  if (dict) {
    translateDom(document.body || document.documentElement);
    // labels drawn by CSS
    const css = [['.hero.album .cover::after', '查看封面'], ['.hero.artist .cover::after', '更換圖片']]
      .map(([sel, zh]) => `${sel}{content:${JSON.stringify(T(zh))}}`).join('\n');
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
  }

  const save = l => { try { localStorage.setItem('miku.lang', l); return localStorage.getItem('miku.lang') === l; } catch (e) { return false; } };

  return {
    lang, LANGS, ok, fromLocale, T,
    /** Switches the interface language (Settings → 其他 → 語言): saves it and reloads the page. */
    async set(l) {
      if (!ok(l)) return;
      await Host.call('ui', { key: 'lang', value: l });
      if (save(l) && l !== lang) location.reload();
    },
    /**
     * After the host's ready: the language saved in the settings, or the installer's choice when it's new
     * (a fresh install / reinstall asks for one), or the system's. Returns true when the page is reloading.
     */
    async sync(init) {
      const ui = (init.settings && init.settings.ui) || {};
      let want = ui.lang;
      const inst = init.installLang;
      if (ok(inst) && ui.langInstalled !== inst) {
        want = inst;
        ui.lang = ui.langInstalled = inst;
        await Host.call('ui', { key: 'lang', value: inst });
        await Host.call('ui', { key: 'langInstalled', value: inst });
      }
      if (!ok(want)) want = fromLocale(init.sysLang || navigator.language);
      if (want === lang) { save(lang); return false; }
      if (!save(want)) return false;   // no storage: stay as we are rather than reload forever
      location.reload();
      return true;
    },
  };
})();
const T = I18N.T;
