#!/usr/bin/env python3
"""
Brings the Windows UI (windows/wwwroot) over to the Mac build (mac/app/wwwroot).

The Mac build uses the same page; only a few things differ (⌘ shortcuts, the media URL scheme, Core Audio texts,
the output picker and the settings page). Those are applied here as exact text replacements, so a change on the
Windows side is brought over by running this again:

    python3 mac/build/sync_wwwroot.py

A replacement whose text is no longer found stops the script: look at what changed on the Windows side and update
the replacement below.

Mac-only files (never overwritten): settings.js, mac-bridge.js, mac-navigation.js. Windows' smooth.js is skipped because macOS
handles wheel scrolling natively. The output picker (the end of art.js, from `const shortDevice`) comes from
wwwroot-mac/outputs.js.
"""
import os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, '..', '..', 'windows', 'wwwroot'))
DST = os.path.normpath(os.path.join(HERE, '..', 'app', 'wwwroot'))
MAC = os.path.join(HERE, 'wwwroot-mac')

MAC_OWNED = {'settings.js', 'mac-bridge.js', 'mac-navigation.js'}
SKIP = {'mock.js', 'smooth.js'}  # Windows test helper and custom wheel scrolling

PATCHES = {
    'index.html': [
        ('<kbd>Ctrl F</kbd>', '<kbd>⌘F</kbd>'),
        ('<script src="core.js', '<script src="mac-bridge.js?v=macpower1"></script>\n<script src="mac-navigation.js?v=macswipe2"></script>\n<script src="core.js'),
        ('<script src="smooth.js?v=20261004s16"></script>\n', ''),
        ('<script src="core.js?v=20261007k1fs1-added1"></script>', '<script src="core.js?v=20261007k1fs1-added1-macpower3"></script>'),
        ('<script src="views.js?v=20261007cd7-l1w-cdnav1-added1"></script>', '<script src="views.js?v=20261007cd7-l1w-cdnav1-added1-macperf1"></script>'),
        ('<script src="settings.js?v=20261007k1"></script>', '<script src="settings.js?v=20261007k1-native-scroll1"></script>'),
    ],
    'core.js': [
        ("const MEDIA = 'https://media.miku';", "const MEDIA = 'miku-media://media';"),
        ("  img.dataset.kind = kind; img.dataset.id = id; img.dataset.size = size;",
         "  img.loading = box.classList.contains('art') ? 'lazy' : 'eager';\n  img.dataset.kind = kind; img.dataset.id = id; img.dataset.size = size;"),
        ("  watch(box) { box.dataset.dpr = this.dpr; this.ro.observe(box); },",
         "  watch(box) { box.dataset.dpr = this.dpr; this.ro.observe(box); },\n"
         "  release(root) {\n"
         "    const unwatch = box => { this.ro.unobserve(box); clearTimeout(box._sharpT); };\n"
         "    if (root.matches?.('[data-art][data-dpr]')) unwatch(root);\n"
         "    root.querySelectorAll?.('[data-art][data-dpr]').forEach(unwatch);\n"
         "  },"),
        ("    this.renderVolume();\n    this.renderSignal();",
         "    if (prev.volumeDb !== s.volumeDb || prev.muted !== s.muted || prev.volumeMode !== s.volumeMode) this.renderVolume();\n"
         "    const sg = s.signal;\n"
         "    const signalKey = [s.trackId, sg?.quality, sg?.dspActive, sg?.dsd, sg?.dsdLabel, sg?.sourceBits, sg?.sourceRate, sg?.codec, sg?.dop].join('|');\n"
         "    if (this.signalKey !== signalKey) { this.signalKey = signalKey; this.renderSignal(); }\n    this.frame();"),
        ("    requestAnimationFrame(t => this.frame(t));", "    this.frame();"),
        ("  lastSec: -1,\n  frame() {\n    // runs every frame for as long as the app is open: elements looked up once, and nothing is written while the\n    // position doesn't move (paused / stopped)",
         "  lastSec: -1, frameRaf: 0,\n  frame() {\n    cancelAnimationFrame(this.frameRaf);\n    this.frameRaf = 0;\n    // Paused progress is redrawn by state/seek events; a hidden page needs no visual loop at all.\n    if (document.hidden || this.uiVisible === false) return;"),
        ("    requestAnimationFrame(() => this.frame());\n  },\n\n  /* ── commands ── */",
         "    if (s.playing) this.frameRaf = requestAnimationFrame(() => this.frame());\n  },\n\n  /* ── commands ── */"),
        ("    this.seekTarget = pos; this.seekUntil = performance.now() + 2500;\n    Host.call('seek', { pos });",
         "    this.seekTarget = pos; this.seekUntil = performance.now() + 2500;\n    this.frame();\n    Host.call('seek', { pos });"),
        ("    r.cleanup = fn(view, r.arg) || null;\n    if (typeof attachRailNav === 'function') attachRailNav(view);",
         "    const cleanupView = fn(view, r.arg) || null;\n"
         "    const cleanupRails = typeof attachRailNav === 'function' ? attachRailNav(view) : null;\n"
         "    r.cleanup = () => { cleanupView && cleanupView(); cleanupRails && cleanupRails(); ArtSharp.release(view); };"),
        ("    body.textContent = '';\n    if (!ids.length)",
         "    ArtSharp.release(body);\n    body.textContent = '';\n    if (!ids.length)"),
        ("toast('找不到 FFmpeg，請在設定確認 FFmpeg 已安裝並加入 PATH。'",
         "toast('找不到 FFmpeg，部分格式（DSD、APE、AIFF…）將無法播放。可用 Homebrew 安裝：brew install ffmpeg'"),
        ("if (e.key === 'F12') { Host.call('devtools'); return; }",
         "if (e.key === 'F12' || (e.metaKey && e.altKey && e.key.toLowerCase() === 'i')) { Host.call('devtools'); return; }"),
        ("// mouse side buttons are handled natively by WebView2 (history back / forward)", "// mouse side buttons: handled in mac-bridge.js"),
        ("  const h = e => { if (e.type === 'keydown' && !/^(Arrow|Page|Home|End| )/.test(e.key)) return; off(); f(); };",
         "  const h = e => {\n"
         "    if (e.type === 'wheel' && (e.mikuPageSwipe || (!e.deltaX && !e.deltaY))) return;\n"
         "    if (e.type === 'keydown' && !/^(Arrow|Page|Home|End| )/.test(e.key)) return;\n"
         "    off(); f();\n"
         "  };"),
        ("'在檔案總管中顯示'", "'在 Finder 中顯示'"),
        ("'在檔案總管中顯示'", "'在 Finder 中顯示'"),
        ("high: '高品質'", "high: '無損'"),
        ("high: 'Windows 混音器會依系統格式處理音訊。改用獨佔模式可達到 Bit-perfect。'",
         "high: '無損音訊以 32-bit 浮點經 Core Audio 送到 DAC，取樣率與裝置相同、沒有 DSP 或數位音量處理。'"),
        ("      else if (sg.dsd) box.append(stage('DSD 轉 PCM', `${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${gainText}`, true));\n"
         "      else if (sg.resampled) box.append(stage('重新取樣', `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${bandwidthText}${gainText}`, true));",
         "      else if (sg.dsd) box.append(stage('DSD 轉 PCM', `${khz(App.settings.dsdPcmRate || 176400)} kHz · FFmpeg · 預留 1 dB`, true));\n"
         "      if (sg.resampled) box.append(stage('重新取樣', `${khz(sg.dsd ? (App.settings.dsdPcmRate || 176400) : sg.sourceRate)} → ${khz(sg.outputRate)} kHz · Core Audio`, true));"),
    ],
    'views.js': [
        ("for (const [i, n] of nodes) if (i < from || i >= to) { n.remove(); nodes.delete(i); }",
         "for (const [i, n] of nodes) if (i < from || i >= to) { ArtSharp.release(n); n.remove(); nodes.delete(i); }"),
        ("for (const [i, n] of nodes) if (i < first || i >= last) { n.remove(); nodes.delete(i); }",
         "for (const [i, n] of nodes) if (i < first || i >= last) { ArtSharp.release(n); n.remove(); nodes.delete(i); }"),
        ("  window.addEventListener('gridcols', onCols);\n  return box;",
         "  window.addEventListener('gridcols', onCols);\n  box._colsCleanup = () => window.removeEventListener('gridcols', onCols);\n  return box;"),
        ('''function sizeRail(r) {
  let seen = false;
  const apply = () => {
    // the home page is rebuilt on every visit: a rail that has left it stops listening (once it had been shown)
    if (!r.isConnected) { if (seen) { window.removeEventListener('gridcols', apply); ro.disconnect(); } return; }
    seen = true;''',
         '''function sizeRail(r) {
  const apply = () => {
    if (!r.isConnected) return;'''),
        ("  requestAnimationFrame(apply);\n  window.addEventListener('gridcols', apply);\n  const ro = new ResizeObserver(apply);\n  ro.observe(r);\n}",
         "  const raf = requestAnimationFrame(apply);\n  window.addEventListener('gridcols', apply);\n"
         "  const ro = new ResizeObserver(apply);\n  ro.observe(r);\n"
         "  r._sizeRailCleanup = () => { cancelAnimationFrame(raf); window.removeEventListener('gridcols', apply); ro.disconnect(); };\n}"),
        ("function attachRailNav(root) {\n  for (const r of root.querySelectorAll('.rail')) {",
         "function attachRailNav(root) {\n  const cleanups = [];\n"
         "  root.querySelectorAll('.seg').forEach(b => { if (b._colsCleanup) cleanups.push(b._colsCleanup); });\n"
         "  for (const r of root.querySelectorAll('.rail')) {\n"
         "    if (r._sizeRailCleanup) cleanups.push(r._sizeRailCleanup);"),
        ("    r.addEventListener('scroll', sync, { passive: true });\n    new ResizeObserver(sync).observe(r);\n    requestAnimationFrame(sync);\n  }\n}",
         "    r.addEventListener('scroll', sync, { passive: true });\n"
         "    const ro = new ResizeObserver(sync);\n    ro.observe(r);\n"
         "    const raf = requestAnimationFrame(sync);\n"
         "    cleanups.push(() => { r.removeEventListener('scroll', sync); ro.disconnect(); cancelAnimationFrame(raf); });\n"
         "  }\n  return () => cleanups.forEach(cleanup => cleanup());\n}"),
        ("      Host.call('yt.show', { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 });\n      YT.shown = true;",
         "      const bounds = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), window.devicePixelRatio || 1];\n"
         "      const key = bounds.join(',');\n"
         "      if (!YT.shown || YT.bounds !== key) Host.call('yt.show', { x: bounds[0], y: bounds[1], w: bounds[2], h: bounds[3], dpr: bounds[4] });\n"
         "      YT.bounds = key; YT.shown = true;"),
        ("    } else if (YT.shown) { Host.call('yt.hide'); YT.shown = false; }",
         "    } else if (YT.shown) { Host.call('yt.hide'); YT.shown = false; YT.bounds = null; }"),
        ("let shuffleSeed = null;",
         "let shuffleSeed = null;\n"
         "function randomOrder(list) {\n"
         "  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }\n"
         "  return list;\n}"),
        ("shuffleSeed = shuffleSeed || Lib.albums.map(a => [Math.random(), a]).sort((x, y) => x[0] - y[0]).map(x => x[1]);",
         "if (!shuffleSeed || shuffleSeed.length !== Lib.albums.length || !Lib.albums.includes(shuffleSeed[0])) shuffleSeed = randomOrder(Lib.albums.slice());"),
        ("artists.map(a => [Math.random(), a]).sort((x, y) => x[0] - y[0]).slice(0, 20).forEach(([, a]) => r.append(artistCard(a, 150)));",
         "randomOrder(artists.slice()).slice(0, 20).forEach(a => r.append(artistCard(a, 150)));"),
        ("每排顯示數量（Ctrl + 滾輪也可以調整）", "每排顯示數量（⌘ + 滾輪也可以調整）"),
        ("  if (!e.ctrlKey) return;\n  const grid", "  if (!e.ctrlKey && !e.metaKey) return;\n  const grid"),
    ],
    'art.js': [
        ("也可以直接按 Ctrl+V 貼上複製的圖片。", "也可以直接按 ⌘V 貼上複製的圖片。"),
    ],
    'tagedit.js': [
        ("else if (e.key === 's' && e.ctrlKey)", "else if (e.key === 's' && (e.ctrlKey || e.metaKey))"),
        ("else if (e.key === 'a' && e.ctrlKey && !typing", "else if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !typing"),
        ("按住 Shift／Ctrl 點選。", "按住 Shift／⌘ 點選。"),
        ("e.ctrlKey ? new Set(s.sel) : new Set()", "(e.ctrlKey || e.metaKey) ? new Set(s.sel) : new Set()"),
        ("const additive = e.ctrlKey ||", "const additive = e.ctrlKey || e.metaKey ||"),
        ("全選／全不選 (Ctrl+A)", "全選／全不選 (⌘A)"),
        ("Shift 點選一段，Ctrl 點選多首", "Shift 點選一段，⌘ 點選多首"),
    ],
}


CJK = '[\u3400-\u9fff\uff00-\uffef]'


def ui_wrapped(code):
    """A replacement snippet as it reads after the UI strings were wrapped: '中文' → T('中文'), `…中文…` → T`…中文…`."""
    code = re.sub(r"(?<!T\()(?<![A-Za-z_$])'([^'\n]*" + CJK + r"[^'\n]*)'", r"T('\1')", code)
    parts = code.split('`')   # odd parts are template bodies (the snippets have no nested templates)
    for i in range(1, len(parts) - 1, 2):
        if re.search(CJK, parts[i]) and not re.search(r'[A-Za-z_$]$', parts[i - 1]): parts[i - 1] += 'T'
    return '`'.join(parts)


def main():
    if not os.path.isdir(SRC): sys.exit('missing ' + SRC)
    # everything is prepared first and written only when every replacement matched: a failed sync changes nothing
    plan = []
    for root, dirs, files in os.walk(SRC):
        rel = os.path.relpath(root, SRC)
        for f in files:
            r = os.path.normpath(os.path.join(rel, f))
            if r in SKIP or r in MAC_OWNED: continue
            src, dst = os.path.join(root, f), os.path.join(DST, r)
            if f.endswith(('.js', '.css', '.html', '.json')):
                text = open(src, encoding='utf-8', newline='').read().replace('\r\n', '\n')
                for old, new in PATCHES.get(r, []):
                    if old not in text and r.endswith('.js'):
                        # the UI strings are wrapped for i18n.js (T('…') / T`…`): match the wrapped form too
                        old, new = ui_wrapped(old), ui_wrapped(new)
                    if old not in text: sys.exit(f'{r}: text to replace not found:\n  {old[:120]}')
                    text = text.replace(old, new, 1)
                if r == 'art.js':
                    i = text.index('const shortDevice')
                    text = text[:i] + open(os.path.join(MAC, 'outputs.js'), encoding='utf-8').read()
                plan.append((r, dst, text, None))
            else:
                plan.append((r, dst, None, src))
    for r, dst, text, src in plan:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if text is not None: open(dst, 'w', encoding='utf-8', newline='\n').write(text)
        else: shutil.copyfile(src, dst)
    print(f'{len(plan)} files from {SRC} → {DST}')


if __name__ == '__main__':
    main()
