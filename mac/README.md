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
| 編輯標籤、重新命名檔案、線上專輯資料、聲紋辨識（AcoustID） | 有（TagLib） | 有（內建寫入程式：FLAC、MP3、WAV、AIFF、DSF、M4A、OGG/Opus、APE、WavPack；fpcalc 內建於 App） |
| 專輯版本切換、演出者圖片自訂、歌詞候選／自動對齊 | 有 | 有 |

FLAC / WAV / MP3 / AAC / OGG / Opus 由 Chromium 直接解碼；ALAC、AIFF、APE、WavPack、TAK、TTA、WMA、DSD
由內建的 FFmpeg 無損解碼成 FLAC（暫存在 `~/Library/Caches/MIKU/Transcode`，上限約 3 GB）。

資料位置：設定、曲庫快取、封面、歌詞在 `~/Library/Application Support/MIKU`。

## 資料夾結構

```
Build Mac.command  在 Finder 雙擊就會同步介面、下載元件並產生安裝檔（dist/）
app/
  main/        Electron 主程序（取代 C# 的 MainForm / Library / Artwork / Lyrics / RemoteServer / Player）
  engine/      播放引擎（隱藏視窗：<audio> → ReplayGain → DSP AudioWorklet → Core Audio）
  wwwroot/     介面（來自 Windows 版，已改成 Mac 快捷鍵與輸出設定；mac-bridge.js 提供 chrome.webview 相容層）
build/
  build.sh     下載 Electron、FFmpeg 與 fpcalc 後打包成 .pkg（Mac 或 Linux 都能跑）
  sync_wwwroot.py  把 Windows 版介面（windows/wwwroot）同步過來，套用 Mac 專屬的修改（⌘ 快捷鍵、Core Audio 文字等）
  wwwroot-mac/ Mac 版自己的輸出裝置選單（art.js 結尾）
  make_pkg.py  建立 MIKU.app（arm64 + x64）、ad-hoc 簽章、產生安裝檔（Mac 上用系統的 mkbom，Linux 上用 bomutils）
  MIKU.icns    App 圖示
```

## 同步 Windows 版的介面

Windows 版介面有修改時，執行 `python3 mac/build/sync_wwwroot.py`。`settings.js` 和 `mac-bridge.js` 是 Mac 版自己的檔案，不會被覆蓋。
新的後端 RPC 要在 `app/main/main.js` 另外實作。

## 自己編譯（最簡單的方法）

1. 在 Finder 打開 `mac` 資料夾，雙擊 **`Build Mac.command`**。
2. 第一次如果跳出「命令列開發者工具」的安裝視窗，按「安裝」，裝好後再雙擊一次。
3. 等它跑完（第一次要下載約 400 MB，之後會重複使用），裝好的安裝檔會出現在 `mac/dist`，資料夾會自動打開。

它會依序：同步 Windows 版介面（`build/sync_wwwroot.py`）→ 下載 Electron、FFmpeg、fpcalc → 打包成 `dist/MIKU-<版本>-mac.pkg`。
版本號在 `app/package.json` 的 `version`。

> 從 GitHub 網頁下載 ZIP 解壓的話，第一次雙擊可能被 macOS 擋下：在檔案上按右鍵 →「打開」即可。用 `git clone` 取得的不會有這個問題。

## 用終端機重新打包

在 Mac 上：

```
cd mac/build && bash build.sh
```

產生的安裝檔在 `dist/`。開發時也可以直接執行：下載 Electron 後 `electron app`。
