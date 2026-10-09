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

# Mac suffixes added to the cache-busting ?v= of these scripts (whatever version the Windows side is on)
VERSION_SUFFIX = {'core.js': '-macpower3-nativeaudio1', 'views.js': '-macperf1', 'settings.js': '-native-scroll1-nativeaudio2-lite1',
                  'art.js': '-macaudio2', 'i18n-dict.js': '-macaudio2'}

PATCHES = {
    'index.html': [
        ('<kbd>Ctrl F</kbd>', '<kbd>⌘F</kbd>'),
        ('<script src="core.js', '<script src="mac-bridge.js?v=macpower1"></script>\n<script src="mac-navigation.js?v=macswipe2"></script>\n<script src="core.js'),
        ('<script src="smooth.js?v=20261004s16-lite1"></script>\n', ''),
    ],
    'core.js': [
        ("const MEDIA = 'https://media.miku';", "const MEDIA = 'miku-media://media';"),
        # (lazy art, ArtSharp.release, the play-only progress loop and render de-duplication now live in the Windows source)
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
         "high: '無損音訊以 Core Audio 輸出；此路徑未確認原始樣本數值。'"),
        ("      box.append(stage(T('格式'), `${sg.outputFormat} / ${khz(sg.outputRate)} kHz`, false));",
         "      box.append(stage(T('格式'), `${sg.outputFormat} / ${khz(sg.outputRate)} kHz`, false));\n"
         "      if (sg.physicalFormat) box.append(stage(T('DAC 格式'), `${sg.physicalFormat} / ${khz(sg.outputRate)} kHz`, false));"),
        ("      else if (sg.dsd) box.append(stage('DSD 轉 PCM', `${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${gainText}`, true));\n"
         "      else if (sg.resampled) box.append(stage('重新取樣', `${khz(sg.sourceRate)} → ${khz(sg.outputRate)} kHz · ${sg.resampler || 'FFmpeg / SoX'}${bandwidthText}${gainText}`, true));",
         "      else if (sg.dsd) box.append(stage('DSD 轉 PCM', `${khz(sg.dsdPcmRate || App.settings.dsdPcmRate || 176400)} kHz · FFmpeg · 預留 1 dB`, true));\n"
         "      if (sg.resampled) box.append(stage('重新取樣', `${khz(sg.dsd ? (sg.dsdPcmRate || App.settings.dsdPcmRate || 176400) : sg.sourceRate)} → ${khz(sg.outputRate)} kHz · ${sg.resampler || 'Core Audio'}`, true));"),
    ],
    'views.js': [
        # (memory / listener cleanups and the shuffle helpers now live in the Windows source itself)
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
                if r == 'index.html':
                    for js, suffix in VERSION_SUFFIX.items():
                        text, n = re.subn(r'(<script src="' + re.escape(js) + r'\?v=)([^"]*)(")',
                                          lambda m: m.group(1) + m.group(2).replace(suffix, '') + suffix + m.group(3), text, count=1)
                        if not n: sys.exit(f'index.html: <script src="{js}?v=…"> not found')
                if r == 'art.js':
                    i = text.index('const shortDevice')
                    text = text[:i] + open(os.path.join(MAC, 'outputs.js'), encoding='utf-8').read()
                if r == 'i18n-dict.js':
                    text += '\n' + open(os.path.join(MAC, 'audio-i18n.js'), encoding='utf-8').read()
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
