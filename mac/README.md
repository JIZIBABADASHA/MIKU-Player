# MIKU for macOS

Windows 版 MIKU（C# + WebView2 + NAudio）移植到 macOS 的版本。介面（`app/wwwroot`）沿用 Windows 版，
後端改用 Electron（Node.js）重寫；音訊輸出使用原生 Core Audio HAL，和 Windows 的 WASAPI 一樣分成共享與獨佔。

## 安裝

1. 到 GitHub 的 Releases 下載 `MIKU-<版本>-mac.pkg`，雙擊安裝。安裝程式會自動判斷是 Apple Silicon 還是 Intel Mac。
2. 這個安裝檔沒有 Apple 開發者簽章，第一次打開時 macOS 會擋下來：
   - 到「系統設定 → 隱私權與安全性」，往下找到被阻擋的安裝檔，按「強制打開」，或
   - 在「終端機」執行：`xattr -d com.apple.quarantine ~/Downloads/MIKU-*-mac.pkg` 再雙擊安裝。
3. 需要 macOS 12 Monterey 或更新版本。

## 和 Windows 版的差異

| 功能 | Windows 版 | Mac 版 |
|---|---|---|
| 輸出 | WASAPI 獨佔 / 共享、ASIO | 原生 Core Audio 獨佔 / 共享，可選輸出裝置 |
| Bit-perfect / 自動切換取樣率 | 有 | 有：獨佔模式可 bit-perfect（Hog Mode + 取樣率對齊 + DAC 整數格式）；共享與獨佔都可自動切換取樣率，DAC 不支援時改用最接近的取樣率並標示重新取樣 |
| DoP 原生 DSD | 有 | 沒有：DSF/DFF 以 FFmpeg 轉成 PCM（88.2/176.4/352.8 kHz） |
| 升頻（SoX） | 有 | 沒有 |
| DAC 硬體音量 | 有 | 沒有（數位音量 / 固定 0 dB） |
| EQ、AutoEq、Crossfeed、平衡、反相、ReplayGain | 有 | 有（64-bit 演算法，原生處理） |
| 無縫播放 | 有 | 有（同取樣率預先解碼並在同一個 HAL 緩衝內接上；跨取樣率需要 DAC 重新鎖定） |
| 曲庫、封面搜尋、歌詞（LRCLIB / 網易雲 + 簡轉繁）、手機遙控 | 有 | 有（資料格式相同） |
| YouTube Music | 聲音導入 MIKU 的 DSP | 內建面板直接播放，不經過 DSP |
| 媒體鍵 | 有 | 使用 macOS 媒體快捷鍵，需系統允許 |
| 編輯標籤、重新命名檔案、線上專輯資料、聲紋辨識（AcoustID） | 有（TagLib） | 有（內建寫入程式：FLAC、MP3、WAV、AIFF、DSF、M4A、OGG/Opus、APE、WavPack；fpcalc 內建於 App） |
| 專輯版本切換、演出者圖片自訂、歌詞候選／自動對齊 | 有 | 有 |

兩種模式都直接以內建的 FFmpeg 串流解碼 PCM，不需要先轉存整首歌。只有缺少原生元件的版本才退回 Chromium Web Audio
（FLAC / WAV / MP3 / AAC / OGG / Opus 直接解碼，其他格式先轉成 FLAC 暫存在 `~/Library/Caches/MIKU/Transcode`）。

## 輸出模式

| | 共享 | 獨佔 |
|---|---|---|
| 其他程式的聲音 | 可以同時播放（經過 macOS 混音器） | 由 MIKU 單獨使用 DAC（Hog Mode） |
| 自動匹配取樣率 | 把裝置切換到歌曲的取樣率；同一裝置上的其他程式也會跟著改變。關閉時依裝置目前的取樣率重新取樣 | 把 DAC 切換到歌曲的取樣率。關閉時維持取得 DAC 時的取樣率並重新取樣 |
| 樣本格式 | 寫入 HAL 的混音格式（32-bit 浮點），不更改 DAC 格式 | 寫入 32-bit 浮點；DAC 格式設為該取樣率下位元數最多的整數格式（至少等於來源） |
| Bit-perfect | 不標示（混音器可能與其他聲音混合） | 可以（條件見下） |
| 裝置不支援歌曲的取樣率 | 最接近的取樣率，標示重新取樣 | 最接近的取樣率，標示重新取樣 |
| 裝置不提供獨佔 | — | 改用共享模式並在訊號路徑標示原因 |

### 播放架構

原生元件（`native/audio.mm`）把「解碼」和「輸出裝置」分開：

- **Deck**：每首歌一個。FFmpeg 解碼成輸出取樣率的 signed 32-bit PCM，放進約 2 秒的無鎖環形緩衝。Deck 屬於播放器，不屬於裝置。
- **Output**：目前開啟的 Core Audio 裝置（共享或獨佔）。音訊 callback 只從 Deck 取樣本寫進 HAL 緩衝，不配置記憶體、不等待、不呼叫 Foundation。

因此：

- **切換輸出裝置不會重新載入歌曲**：已解碼的緩衝留著，新裝置和舊裝置取樣率相同時從下一個樣本接續；不同時在同一位置以新取樣率重開解碼。新裝置開始播放後才還原舊裝置（取樣率、DAC 格式、釋放 Hog），中斷只有開啟新裝置所需的時間。
  還原時舊裝置仍以靜音運作，等 DAC 重新鎖定後才停止並釋放 Hog：macOS 上若對「已停止且被獨佔」的裝置改取樣率再釋放，同一個程序之後啟動該裝置會卡約 7 秒，而且啟動後完全沒有音訊（這就是先前切來切去後沒聲音的原因）。
- **拖曳進度、同取樣率換歌**：裝置持續運作，只替換 Deck，不停止 DAC、不重新鎖定；舊的聲音一直播到新的準備好為止。
- **換取樣率**：裝置不停止，在運作中直接改取樣率（DAC 重新鎖定，依 DAC 約 0.1～1 秒靜音），不先停再開。獨佔中的裝置只在運作時才改取樣率或 DAC 格式。
- **暫停**：裝置以靜音繼續運作，按播放立即接續、不重新鎖定；暫停 30 秒後才真正停止輸出（獨佔仍保留）。
- **無縫播放**：同取樣率的下一首預先解碼，在同一個 HAL 緩衝內接上；跨取樣率時 DAC 重新鎖定。
- **EQ / DSP 調整**：新的處理參數以原子方式替換，不中斷輸出。

### 切換與拔除裝置

- 在 MIKU 選擇輸出裝置或切換共享／獨佔：保持原本的位置與播放／暫停狀態。
- 輸出裝置設為「系統預設」時，共享模式下系統輸出改變（例如在控制中心選了耳機、接上新的 DAC）會把播放移到新裝置。
- 獨佔時 macOS 會把系統輸出從被 MIKU 獨佔的 DAC 移到別的裝置（例如 MacBook 揚聲器），其他程式的聲音會從那裡出來。這不是使用者換了輸出，
  所以 MIKU 留在原本的 DAC；「系統預設」在 MIKU 的選單裡仍然代表 MIKU 取得的那台裝置（MIKU 放開後 macOS 沒把系統輸出移回來時也一樣），訊號路徑會說明其他程式的聲音去了哪裡。
  獨佔期間要換裝置請用 MIKU 的輸出選單。
- 拔除正在使用的裝置：停在原位置暫停並顯示提示，不會突然改從喇叭播出；按播放就在目前可用的輸出（選定的裝置或系統預設）從原位置繼續。
- 選定的 DAC 不在時改用系統輸出並在訊號路徑標示；DAC 接回後自動切回，位置不變。
- 共享模式下其他程式改了裝置的取樣率時，MIKU 在原位置以新的取樣率繼續（不和其他程式搶）；下一首再套用自動匹配。
- 另一個程式取得裝置獨佔時，停在原位置暫停並顯示提示。
- 原生音訊元件若意外結束，會自動重新啟動並從原位置繼續。裝置啟動卡住、或正在播放的裝置超過約 4 秒沒有呼叫音訊 callback 時，元件會先還原裝置再自行重新啟動（新的程序能正常啟動音訊），從原位置繼續。

資料位置：設定、曲庫快取、封面、歌詞在 `~/Library/Application Support/MIKU`。

## Mac Bit-perfect

1. 到「設定 → 音訊」，按「套用 Bit-perfect 設定」。這會停止播放，選擇原生獨佔、自動匹配取樣率、固定 0 dB，並關閉 DSP / ReplayGain。
2. 選擇實際連接的 USB DAC。再次播放前，先把 DAC 的實體音量調低；固定 0 dB 是原始數位音量。
3. 播放 FLAC、ALAC、WAV 等整數 PCM 無損音樂，訊號路徑會列出實際取樣率、HAL 輸出格式與 DAC 格式。

做法和 Audirvana、Roon 在 macOS 上相同：

- 取得 Hog Mode 獨佔，DAC 取樣率切換成歌曲的取樣率。
- DAC 格式設為該取樣率下位元數最多的整數格式（例如 24-bit 或 32-bit）；原本的格式位元數已經足夠時不更改（不會多一次重新鎖定）。
- FFmpeg 解碼為 signed 32-bit PCM（16 / 24-bit 只補零）。unity gain 時不做任何運算，直接換成 32-bit 浮點交給 HAL。32-bit 浮點有 24-bit 有效位數，能精確表示每一個 16 / 24-bit 整數樣本，HAL 換回 DAC 的整數格式時也是精確的，所以 DAC 收到的就是原始樣本。`miku-audio --self-test` 會逐一驗證這條路徑（16 / 24-bit → 浮點 → 16 / 24 / 32-bit DAC 格式）。

先前的版本要求 HAL 提供「整數非混音格式」，但現在 Apple 的 USB 音訊驅動多半不提供，所以幾乎無法標示 Bit-perfect，而且在獨佔中切換這種格式會讓部分 DAC 拒絕載入下一首。現在不再修改 HAL 的虛擬格式。

顯示 Bit-perfect 的條件：獨佔成功、無損整數來源、裝置取樣率與歌曲相同、DAC 格式位元數不少於來源（32-bit 整數來源超過浮點路徑的 24-bit，不標示）、DSP / ReplayGain 關閉、unity gain、沒有緩衝不足，而且不是藍牙、AirPlay（會重新編碼）或內建喇叭（有系統音效處理）。標示依據回讀的 HAL / DAC 設定與軟體訊號路徑；未逐樣本量測 DAC 端的資料。

DAC 不支援歌曲的取樣率時改用最接近的取樣率並標示重新取樣（不標示 Bit-perfect）；DAC 被其他程序獨佔時停止並顯示該程式名稱。停止、播放 YouTube 或退出時釋放獨佔；一般暫停時 DAC 以靜音繼續運作 30 秒（按播放立即接續），之後停止輸出但仍保留獨佔；播完最後一首 5 秒後停止輸出。釋放時還原該次取得裝置前的取樣率與 DAC 格式。

### 測試

- `node mac/tests/native-audio-events.js`：用假的原生元件驗證 App 端（切換輸出不重新載入、拔除暫停／繼續、跟隨系統輸出、失敗回報、元件重啟）。不需要 DAC。
- `node mac/tests/native-audio.js`：原生元件自我測試、逐位元組解碼比對、訊號標示、DSP 與既有實作一致。
- `node mac/tests/native-audio.js --hardware`：接上 USB DAC（或設定 `MIKU_TEST_DAC=<名稱的一部分>`），只播放靜音，驗證各取樣率的獨佔設定（並確認音訊確實在走）、播放中換取樣率、拖曳進度、暫停／繼續（含剛換完取樣率時）、播放中切換裝置、跟隨系統輸出不來回切換、共享模式，以及每個裝置都還原。

## 輕量化頁面

在「設定 → 外觀」開啟「啟用輕量化頁面」，再依需要調整七個項目：音訊鏈路特效、專輯飛行、頁面與操作動畫、動態背景、黑膠持續旋轉、背景模糊與玻璃效果，以及平滑捲動。細項開啟表示減少對應效果。Windows 與 Mac 使用相同設定；Mac 保留原生滾輪捲動，Windows 可停用滾輪慣性動畫。

預設關閉。變更立即生效，並儲存在 UI 偏好；關閉主開關會恢復原有效果，同時保留細項選擇。Hi-Res、DSD、有損、DSP 與實際訊號路徑仍可查看；不會修改輸出模式、取樣率、DSP、音量或 Bit-perfect 設定。

`electron mac/tests/lightweight-ui.js` 使用隔離的 Mac 主程式與 Windows 介面預覽，驗證效果開關、持續動畫停止、專輯飛行清理、面板開關、主題顯示及偏好重載。Windows 的原生程式與安裝包仍需在 Windows 建置及測試。

## 資料夾結構

```
Build Mac.command  在 Finder 雙擊就會同步介面、下載元件並產生安裝檔（dist/）
app/
  main/        Electron 主程序（取代 C# 的 MainForm / Library / Artwork / Lyrics / RemoteServer / Player）
  engine/      備用播放引擎（缺少原生元件時：隱藏視窗 <audio> → ReplayGain → DSP AudioWorklet → Core Audio）
  wwwroot/     介面（來自 Windows 版，已改成 Mac 快捷鍵與輸出設定；mac-bridge.js 提供 chrome.webview 相容層）
native/
  audio.mm     原生 Core Audio 輸出：解碼（Deck）與裝置（Output）分離、共享 / 獨佔（Hog Mode）、取樣率與 DAC 格式、
               裝置切換／拔除／跟隨系統輸出、PCM 解碼與 DSP；JSON IPC，音訊 callback 不等待或配置記憶體
  build.sh     以 macOS SDK 編譯獨立 arm64 / x64 元件，不依賴 Electron Node ABI
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

它會依序：同步 Windows 版介面（`build/sync_wwwroot.py`）→ 下載 Electron、FFmpeg、fpcalc → 編譯原生 Core Audio 元件 → 打包成 `dist/MIKU-<版本>-mac.pkg`。
版本號在 `app/package.json` 的 `version`。

> 從 GitHub 網頁下載 ZIP 解壓的話，第一次雙擊可能被 macOS 擋下：在檔案上按右鍵 →「打開」即可。用 `git clone` 取得的不會有這個問題。

## 用終端機重新打包

在 Mac 上：

```
cd mac/build && bash build.sh
```

產生的安裝檔在 `dist/`。開發時也可以直接執行：下載 Electron 後 `electron app`。

Linux 打包時需先提供由 Mac 編譯的 `build/native/miku-audio-arm64` 和 `miku-audio-x64`；`make_pkg.py --native-dir` 可指定它們的位置。

驗證方式見上面「Mac Bit-perfect → 測試」。`electron mac/tests/native-audio-ui.js` 使用隔離設定驗證真實 UI、換歌與 YouTube 切換（設定 `MIKU_TEST_DAC` 指定 DAC）。執行 GUI 測試應使用未打包的官方 Electron，而不是已包含 MIKU 的 app。

## 音訊測試

- `node mac/tests/native-audio-events.js`：不需要 DAC。以模擬的原生元件驗證 App 端：切換輸出／模式不重新載入歌曲、切換失敗的提示、
  拖曳進度在原生元件內完成、拔除裝置後暫停在原位置並可繼續、原生元件自行移動輸出時同步狀態、載入中切換、預先載入不重複探測、
  無縫接續，以及原生元件異常結束後自動重啟。
- `node mac/tests/native-audio.js [--hardware]`：原生自我測試（含浮點路徑逐值驗證）、解碼與 DSP 一致性；加上 `--hardware` 用實際的 USB DAC
  （`MIKU_TEST_DAC=<名稱>` 可指定）播放靜音，實測各取樣率的獨佔、換歌、拖曳、播放中切換裝置、跟隨系統輸出、不支援取樣率的退回、
  共享模式與每個裝置的還原。
- `electron mac/tests/native-audio-ui.js`：整個 App 的 Bit-perfect 設定、無縫播放、暫停／拖曳、增益與 DSP 標示、YouTube 釋放 DAC 與共享模式。
