# MIKU Player

給高解析音樂收藏用的桌面播放器，支援 Windows 與 macOS。
<img width="2149" height="1387" alt="miku-home-generic-1" src="https://github.com/user-attachments/assets/6821e9b3-3cc8-4d91-b395-6991afa408f9" />

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
- 輸出：Windows 支援 WASAPI 獨佔 / 共享與 ASIO（bit-perfect、DoP、升頻）；macOS 使用原生 Core Audio 獨佔 / 共享（獨佔可 bit-perfect，兩種模式都能自動匹配取樣率）
- DSP：參數等化器（可匯入 AutoEq / Equalizer APO 設定）、Crossfeed、平衡、ReplayGain，64-bit 運算
- 無縫播放、自動續播（佇列播完後隨機播放其他專輯或歌曲）
- 同步歌詞（本機 LRC、LRCLIB、網易雲音樂，附中文翻譯）
- 手機遙控：同一個 Wi-Fi 下用手機瀏覽器掃 QR code 就能控制
- YouTube Music 整合、多種介面主題
- 輕量化頁面：Windows / Mac 都可在「設定 → 外觀」開啟，分別減少音訊鏈路特效、專輯飛行、頁面動畫、動態背景、黑膠旋轉、玻璃模糊與平滑捲動。立即套用並記住細項；關閉後恢復原有效果。音訊設定保持不變。

## 原始碼

```
windows/             Windows 版：C# (.NET 8) + WebView2 + NAudio
mac/                 macOS 版：Electron（沿用同一套介面）
MIKU.Extensibility/  Windows 版的擴充模組介面
```

### 編譯 Windows 版

在 `windows` 資料夾執行 `build.cmd` 需要 .NET 8 SDK，程式會輸出到上一層的 `MIKU` 資料夾。
執行 `make-installer.cmd` 會自動準備 .NET 8 SDK（放在 repo 的 `.tools` 資料夾，不改動系統安裝）、下載 FFmpeg 與安裝 Inno Setup，再產生安裝檔。
產生的 MIKU 是獨立版，使用者不需要另外安裝 .NET；若電腦缺少 WebView2，安裝程式會提示開啟 Microsoft 的下載頁面。

### 擴充模組（Windows 版）

功能模組可以放在獨立的 repo，checkout 到 `Extensions/<名稱>/`（例如當作 git submodule）。編譯時會一起建置，
沒有的話照常編譯。寫法見 [MIKU.Extensibility/README.md](MIKU.Extensibility/README.md)。

[Daphne](https://github.com/cychang-ykc/Daphne) 播放內核以 git submodule 放在 `Extensions/Daphne`，clone 時一起取得：

```
git clone --recurse-submodules https://github.com/JIZIBABADASHA/MIKU-Player.git
```

已經 clone 過的話，執行 `git submodule update --init`（`make-installer.cmd` 會自動取得還沒下載的 submodule）。
一般的 clone 不會取得它，MIKU 照常編譯。
取得後編譯 MIKU 時會一起建置 Daphne 的 C++ 引擎：已安裝的 Visual Studio（C++ 桌面開發）與 CMake 3.25 以上會優先使用，
沒有的話第一次編譯會自動下載可攜式 MSVC、CMake 與 Ninja 到 `.tools`（不需要系統管理員權限，適用 Visual Studio Build Tools 授權）。
第一次編譯也會下載 FFmpeg 與 ASIO SDK。之後在設定 → 播放方案選 Daphne 即可使用。

Daphne 可以在任何 x64 CPU 上執行，不需要 AVX2 或 FMA3：CPU 兩者都有時，雙倍精度（double-double）運算會使用向量化的路徑；
沒有的話改用一般路徑，結果逐位元相同，只是比較慢（「雙倍精度摺積」約慢 2.5 倍，仍遠快於即時播放）。
不支援 FMA3 的較舊 CPU，FMA 會由 C 執行階段以軟體計算，速度明顯下降，建議不要開啟「雙倍精度摺積」。

Mac 版也使用同一份 `Extensions/Daphne`（Core Audio 輸出）：打包 Mac 版時，`mac/build/build.sh` 會執行它的
`miku/pack-mac.sh`，一起編譯並放進安裝檔，之後在設定 → 音訊 → 播放方案選 Daphne。詳見 `mac/README.md`。

[MoodWave](https://github.com/cychang-ykc/MoodWave) 以 git submodule 放在 `Extensions/MoodWave`：從音訊本身把曲庫分成
5 個時段與 8 種心情的頻道，加上歌曲電台與 Smart Playlist（佇列播完後依實際聽過的歌接續）。取得的方式同上；編譯 MIKU 時
會一起建置，只需要 .NET 8 SDK，第一次編譯會從 MoodWave 的 Releases 下載頻道模型。之後側欄會出現 MoodWave，
設定 → 曲庫可以開關它和進階 AI（進階 AI 的模型約 285 MB，開啟時才下載）。打包 Mac 版時同樣由它的 `miku/pack-mac.sh`
一起編譯，需要 Mac 上有 .NET 8 SDK 與 python3。MoodWave 採 PolyForm Noncommercial 1.0.0 授權，並另外授權 MIKU
隨 MIKU 散布（見它的 `LICENSE`）。

### 編譯 macOS 版

在 Finder 雙擊 `mac/Build Mac.command`（或在終端機執行 `bash mac/build/build.sh`），會下載 Electron、FFmpeg 與 fpcalc 並產生 `mac/dist/MIKU-<版本>-mac.pkg`。
詳見 [mac/README.md](mac/README.md)。

## 第三方元件

NAudio、TagLibSharp、Microsoft Edge WebView2、Electron、FFmpeg（LGPL 版）、OpenCC 字典資料、Inno Setup。
各元件依其授權條款使用。
