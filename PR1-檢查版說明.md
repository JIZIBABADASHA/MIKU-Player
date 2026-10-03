# PR #1 檢查版

版本：1.2.1+pr1.naudio.review.20261004，Windows x64。

以 PR #1 811ce2c 為基礎，合入 main 01aa1cc（PR #2）的衝突修正與本機共用功能。依最新要求，播放改回原本的 FFmpeg 解碼／NAudio 輸出核心；Rplay 程式、設定、DLL、建置相依與子模組均已移除。舊設定中的 Rplay 欄位會被忽略，其餘設定保留。

## 保留功能

- 歌詞候選選擇、手動選擇保留、錯誤歌詞清除、自動時間對齊、整個曲庫的歌詞搜尋／停止。
- 主題、黑膠／播放畫面等介面功能。
- 詳細訊號路徑、DSD／DoP 資訊、數位音量／量化／取樣率品質標示。
- FFmpeg 重取樣後、ReplayGain／DSP 前的峰值及超載樣本數。這是已解碼區段的統計；解碼器會預讀。保持原本 SoX 設定與 SRC 時 −1 dB 策略。
- YouTube 歌曲時間、Seek、進度平滑及 NAudio 輸出延遲補償、啟動曲目欄、YouTube 頁面、WAV 標籤修正。
- 原本 NAudio 的 WASAPI 獨佔／共享、ASIO 輸出。

此版尚未加入自寫 MIKU 後端、WAV／AIFF／FLAC 解碼器、sinc、原生輸出位元／事件驅動／TPDF 專屬設定；既有 FFmpeg 格式支援保留。

## 建置與檢查

使用 .NET 8 SDK，執行 build-review.ps1，或 publish windows/MIKU.csproj。

27 項整合檢查通過：RIFF INFO／ID3、引擎事件交接、編譯產物無 Rplay 及自寫核心、主程式直接使用 NAudio、舊 Rplay 設定相容、歌詞手動保留／清除、LRC 偏移、已知偏移自動對齊／靜音拒絕、FFmpeg 原樣 PCM 與 SRC 超載統計、量化飽和。12 個 Windows JavaScript 檔案語法檢查通過。

Release 編譯與 Windows x64 自包含發布成功，保留既有 WindowsBase／WebView2 WPF 組件版本警告。實體 DAC、真實 YouTube 頁面及線上歌詞 API 尚待實測。

## 後續自寫核心

MIKU-自寫核心-待合併.zip 已更新為此 NAudio 檢查版的基底，含四個核心檔案、12 個檔案的整合補丁、套用腳本與 SHA-256。套用後提供 FFmpeg／NAudio 與 MIKU 自寫核心兩個方案，不會重新加入 Rplay。檢查者改動同段程式後，先以套用腳本的 -CheckOnly 檢查，必要時人工合併。

此修正版以「PR #1 合入 main」的合併提交更新 PR 分支，保留合併歷史，供檢查後再決定是否合入 main。來源 ZIP 不含 .git、個人曲庫、設定、歌詞快取及 WebView 登入資料。
