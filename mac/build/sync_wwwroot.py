#!/usr/bin/env python3
"""
Brings the Windows UI (windows/wwwroot) over to the Mac build (mac/app/wwwroot).

The Mac build uses the same page; only a few things differ (⌘ shortcuts, the media URL scheme, Core Audio texts,
the output picker and the settings page). Those are applied here as exact text replacements, so a change on the
Windows side is brought over by running this again:

    python3 mac/build/sync_wwwroot.py

A replacement whose text is no longer found stops the script: look at what changed on the Windows side and update
the replacement below.

Mac-only files (never overwritten): settings.js, mac-bridge.js. The output picker (the end of art.js, from
`const shortDevice`) comes from wwwroot-mac/outputs.js.
"""
import os, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, '..', '..', 'windows', 'wwwroot'))
DST = os.path.normpath(os.path.join(HERE, '..', 'app', 'wwwroot'))
MAC = os.path.join(HERE, 'wwwroot-mac')

MAC_OWNED = {'settings.js', 'mac-bridge.js'}
SKIP = {'mock.js'}          # test helper of the Windows build

PATCHES = {
    'index.html': [
        ('<kbd>Ctrl F</kbd>', '<kbd>⌘F</kbd>'),
        ('<script src="core.js', '<script src="mac-bridge.js?v=mac2"></script>\n<script src="core.js'),
    ],
    'core.js': [
        ("const MEDIA = 'https://media.miku';", "const MEDIA = 'miku-media://media';"),
        ("toast('找不到 FFmpeg，請在設定確認 FFmpeg 已安裝並加入 PATH。'",
         "toast('找不到 FFmpeg，部分格式（DSD、APE、AIFF…）將無法播放。可用 Homebrew 安裝：brew install ffmpeg'"),
        ("if (e.ctrlKey && e.key.toLowerCase() === 'f')", "if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')"),
        ("if (e.key === 'F12') { Host.call('devtools'); return; }",
         "if (e.key === 'F12' || (e.metaKey && e.altKey && e.key.toLowerCase() === 'i')) { Host.call('devtools'); return; }"),
        ("e.key === 'ArrowUp' && e.ctrlKey)", "e.key === 'ArrowUp' && (e.ctrlKey || e.metaKey))"),
        ("e.key === 'ArrowDown' && e.ctrlKey)", "e.key === 'ArrowDown' && (e.ctrlKey || e.metaKey))"),
        ("else if (e.key.toLowerCase() === 'n' && e.ctrlKey) Host.call('next');",
         "else if (e.key.toLowerCase() === 'n' && (e.ctrlKey || e.metaKey)) Host.call('next');\n"
         "      else if (e.metaKey && e.key === '[') history.back();\n"
         "      else if (e.metaKey && e.key === ']') history.forward();"),
        ("// mouse side buttons are handled natively by WebView2 (history back / forward)", "// mouse side buttons: handled in mac-bridge.js"),
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
