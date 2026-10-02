# MIKU Player

給高解析音樂收藏用的桌面播放器，支援 Windows 與 macOS。

## 下載

到 [Releases](../../releases) 下載最新版：

| 系統 | 檔案 | 需求 |
|---|---|---|
| Windows | `MIKU-Setup-<版本>.exe` | Windows 10 / 11（64 位元） |
| macOS | `MIKU-<版本>-mac.pkg` | macOS 12 以上，Apple Silicon 與 Intel 都可（安裝時自動選擇） |

> 安裝檔沒有付費的程式碼簽章。Windows 若出現 SmartScreen，按「其他資訊 → 仍要執行」；
> macOS 第一次打開安裝檔會被擋下，請到「系統設定 → 隱私權與安全性」按「強制打開」。

## 功能

- 曲庫：專輯 / 演出者 / 曲目瀏覽，自動抓封面（Apple Music、Deezer、MusicBrainz）與演出者照片
- 格式：FLAC、WAV、ALAC、AIFF、MP3、AAC、OGG、Opus、APE、WavPack、DSD（DSF / DFF）…
- 輸出：Windows 支援 WASAPI 獨佔 / 共享與 ASIO（bit-perfect、DoP、升頻）；macOS 使用 Core Audio
- DSP：參數等化器（含 AutoEq 耳機資料庫）、Crossfeed、平衡、ReplayGain，64-bit 運算
- 無縫播放、自動續播（佇列播完後隨機播放其他專輯或歌曲）
- 同步歌詞（本機 LRC、LRCLIB、網易雲音樂，附中文翻譯）
- 手機遙控：同一個 Wi-Fi 下用手機瀏覽器掃 QR code 就能控制
- YouTube Music 整合、多種介面主題

## 原始碼

```
windows/   Windows 版：C# (.NET 8) + WebView2 + NAudio
mac/       macOS 版：Electron（沿用同一套介面）
```

### 編譯 Windows 版

需要 .NET 8 SDK。在 `windows` 資料夾執行 `build.cmd`，程式會輸出到上一層的 `MIKU` 資料夾；
`make-installer.cmd` 會產生安裝檔（自動下載 FFmpeg 與 Inno Setup）。

### 編譯 macOS 版

在 Mac 上執行 `mac/build/build.sh`，會下載 Electron 與 FFmpeg 並產生 `dist/MIKU-<版本>-mac.pkg`。
詳見 [mac/README.md](mac/README.md)。

## 第三方元件

NAudio、TagLibSharp、Microsoft Edge WebView2、Electron、FFmpeg（LGPL 版）、OpenCC 字典資料、Inno Setup。
各元件依其授權條款使用。
