# MIKU for macOS

Windows 版 MIKU（C# + WebView2 + NAudio）移植到 macOS 的版本。介面（`app/wwwroot`）沿用 Windows 版，
後端改用 Electron（Node.js）重寫，播放引擎改用 Core Audio。

## 安裝

1. 到 GitHub 的 Releases 下載 `MIKU-<版本>-mac.pkg`，雙擊安裝。安裝程式會自動判斷是 Apple Silicon 還是 Intel Mac。
2. 這個安裝檔沒有 Apple 開發者簽章，第一次打開時 macOS 會擋下來：
   - 到「系統設定 → 隱私權與安全性」，往下找到被阻擋的安裝檔，按「強制打開」，或
   - 在「終端機」執行：`xattr -d com.apple.quarantine ~/Downloads/MIKU-*-mac.pkg` 再雙擊安裝。
3. 需要 macOS 12 Monterey 或更新版本。

## 和 Windows 版的差異

| 功能 | Windows 版 | Mac 版 |
|---|---|---|
| 輸出 | WASAPI 獨佔 / 共享、ASIO | Core Audio（32-bit 浮點），可選輸出裝置 |
| Bit-perfect / 自動切換取樣率 | 有 | 沒有：DAC 取樣率由「音訊 MIDI 設定」決定，設定頁有捷徑 |
| DoP 原生 DSD | 有 | 沒有：DSF/DFF 以 FFmpeg 轉成 PCM（88.2/176.4/352.8 kHz） |
| 升頻（SoX） | 有 | 沒有 |
| DAC 硬體音量 | 有 | 沒有（數位音量 / 固定 0 dB） |
| EQ、AutoEq、Crossfeed、平衡、反相、ReplayGain | 有 | 有（同一套 64-bit 演算法，跑在 AudioWorklet） |
| 無縫播放 | 有 | 有（預先載入下一首） |
| 曲庫、封面搜尋、歌詞（LRCLIB / 網易雲 + 簡轉繁）、手機遙控 | 有 | 有（資料格式相同） |
| YouTube Music | 聲音導入 MIKU 的 DSP | 內建面板直接播放，不經過 DSP |
| 媒體鍵 | 有 | 有（也會顯示在控制中心的「正在播放」） |

FLAC / WAV / MP3 / AAC / OGG / Opus 由 Chromium 直接解碼；ALAC、AIFF、APE、WavPack、TAK、TTA、WMA、DSD
由內建的 FFmpeg 無損解碼成 FLAC（暫存在 `~/Library/Caches/MIKU/Transcode`，上限約 3 GB）。

資料位置：設定、曲庫快取、封面、歌詞在 `~/Library/Application Support/MIKU`。

## 資料夾結構

```
app/
  main/        Electron 主程序（取代 C# 的 MainForm / Library / Artwork / Lyrics / RemoteServer / Player）
  engine/      播放引擎（隱藏視窗：<audio> → ReplayGain → DSP AudioWorklet → Core Audio）
  wwwroot/     介面（來自 Windows 版，已改成 Mac 快捷鍵與輸出設定；mac-bridge.js 提供 chrome.webview 相容層）
build/
  build.sh     下載 Electron 與 FFmpeg 後打包成 .pkg（Mac 或 Linux 都能跑）
  make_pkg.py  建立 MIKU.app（arm64 + x64）、ad-hoc 簽章、產生安裝檔
  MIKU.icns    App 圖示
```

## 自己重新打包

在 Mac 上：

```
cd mac/build && ./build.sh
```

產生的安裝檔在 `dist/`。開發時也可以直接執行：下載 Electron 後 `electron app`。
