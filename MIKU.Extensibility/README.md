# 擴充模組（Extensions）

MIKU 可以載入額外的功能模組。模組放在自己的 repo，checkout 到 MIKU repo 底下的 `Extensions/<名稱>/`
（例如當作 git submodule）。有模組就會一起編譯；沒有的話 MIKU 照常編譯，看起來和沒有擴充機制時一樣。

## 模組的結構

```
Extensions/<名稱>/
  src/<專案>/<專案>.Extension.csproj    C# 類別庫（net8.0），實作 IMikuExtension
```

`*.Extension.csproj` 要做兩件事：

1. 參考 `MIKU.Extensibility`（不複製 DLL：`<Private>false</Private>`），並實作 `IMikuExtension`
2. 提供一個名為 `MikuDeploy` 的 MSBuild target，把模組需要的檔案複製到 `$(MikuOutDir)ext\<id>\`（`MikuOutDir` 是 MIKU 的輸出資料夾，結尾有 `\`）：
   - 模組的 DLL 與相依檔
   - 網頁檔放在 `web\`，網址是 `https://ext.miku/<id>/web/…`

MIKU 編譯（build）與發佈（publish）時，都會對每個模組執行 `MikuDeploy`。

## 執行時

- 啟動時，MIKU 從 `ext\*\` 載入有實作 `IMikuExtension` 的 DLL（各自獨立的 AssemblyLoadContext），並呼叫 `Start`
- 頁面呼叫 `ext.<id>.<method>` 會轉給模組的 `HandleRpc`；模組用 `host.Post` 送出的事件，在頁面上叫 `ext.<id>.<事件>`
- 模組在 `web\manifest.json` 列出要載入的檔案：`{ "scripts": ["x.js"], "styles": ["x.css"] }`。頁面啟動時會在顯示畫面前載入
- 網頁端用 `MikuExt.register({ id, init(api) { … } })` 註冊。`api` 提供：
  - `addNav`、`addRoute`
  - `addSettings(place, fn)`：`fn(host, { section, field, sw, select, core })`。`place` 是分頁（`audio` / `library` / `look` / `other`，加在最後），或 `core`（「播放方案」下方：目前內核自己的設定）、`dsd`（DSD 區塊最後）、`about`（關於，MIKU 那一列之後）；`core` 是目前選的播放內核
  - `on`、`rpc`、`play`
  - `play(ids, shuffle, start, { at, source })`：`at` 是第一首開始的秒數；`source` 是任意 JSON 物件，表示「這個佇列是誰產生的」，會跟著佇列保存，直到改播別的東西
  - `playerSlot({ bar, nowPlaying, leaveBar })`：當目前佇列是本模組帶 `source` 播放的，播放列封面左側與全螢幕播放頁各有一個區塊，由 `bar(el, source)`、`nowPlaying(el, source)` 繪製；同時 `<html>` 會有 `data-ext-source="<id>"`，模組的樣式表可以據此改變播放列與播放頁的外觀。改播別的東西時全部還原；`leaveBar(el)`（可省略）可在播放列區塊收起前播放離場動畫，回傳 Promise，最多等 1 秒
    - 播放列區塊換內容時（進入模組的清單、離開、或換成模組的另一個清單），MIKU 會把播放列左側（模組區塊、封面、歌名、歌手、愛心）當成一整組：舊的一組原地淡出，新的一組從播放列左緣整組推進來（等新歌的資訊到了才推，最多 0.3 秒）。`MikuExt.swapsBar` 為 true 時表示 MIKU 會這樣做，模組的區塊就不用自己做進場和離場動畫（`leaveBar` 在這時不會被呼叫）。模組可以在 `playerSlot` 加 `swap(prev, next)`：從自己的一個清單換到另一個時（`prev`、`next` 都是本模組的 source），回傳 false 就不整組換，由模組自己的區塊處理（例如頻道之間的切換）
  - `signalPath(fn)`：本模組的播放內核回報自己的訊號路徑時（`SignalInfo.Custom`，帶 `ext` 成員），由 `fn(box, signal, { stage, src, khz })` 畫出訊號路徑彈窗
  - `coreLabel(coreId, fn)`：本模組提供的播放內核在「播放方案」選單中的顯示方式：`fn()` 回傳一個節點（例如字標），取代內核名稱顯示在選單按鈕與選項中；原生選項仍保留名稱文字（輔助技術使用）
  - `addMenu(kind, fn)`：在右鍵選單加項目，排在 MIKU 的播放與佇列項目之後。`kind` 是 `track`（`fn(track, list)`）或 `album`（`fn(album)`），回傳 `[{ label, icon, run }]`，不加就回傳空的
  - `queueHead(fn)`：播放佇列抽屜最上方的標題區塊，`fn(el, source)`，`source` 是目前佇列的 source（任何模組的，或 null）。每次佇列重畫時呼叫；不需要時讓 `el` 保持空白
  - `queueRow(fn)`：播放佇列抽屜裡「接下來」每一列右側的區塊，取代 MIKU 的移除按鈕。`fn(el, { id, i, index, source })`：`id` 是那首歌，`i` 是它在佇列中的位置，`index` 是正在播放的位置，`source` 是那一列播放時的 source（佇列的 source；佇列交給模組的 Smart Playlist 接續時，從接續處開始是 `{ ext, smart: true }`）。每次佇列重畫時呼叫；`el` 保持空白就顯示 MIKU 的移除按鈕
  - `continueMark(fn)`：`fn()` 回傳一個節點（例如模組的圖示），「佇列播完後」交給模組時，顯示在「… 已開啟」前面

## 播放內核

模組也可以提供播放內核：`IMikuExtension` 同時實作 `Miku.Audio.IAudioCoreProvider`（`windows/Audio/AudioCores.cs`），設定的「播放方案」就會列出它。

- `CoreId` / `CoreName`：`Settings.AudioCore` 的值與顯示名稱；`Info`（`AudioCoreInfo`）告訴設定頁它的能力（ASIO 能否直送 DSD、是否使用「DSD 轉 PCM 取樣率」、升頻的說明文字）
- `CreateEngine(settings, ui)` 回傳實作 `IAudioEngine` 的引擎；選用的 `LiveLatency`、`AsioRates` 讓 MIKU 使用內核自己的延遲與 ASIO 取樣率
- 播放內核需要使用 MIKU 自己的型別，所以模組要參考 MIKU 的組件（`$(MikuOutDir)MIKU.dll`，`Private=false`）；MIKU 旁邊已有的組件（MIKU、NAudio…）一律使用 MIKU 那一份，型別才會一致
- MIKU 啟動時先用自己的內核；模組載入後，若設定選的是模組的內核，就自動切換過去。模組不在時維持 MIKU 自己的內核

## 播放紀錄與佇列

- `IExtensionHost.TrackPlayed`：每首開始播放的歌離開時通知一次（`ExtPlayed`：播了幾秒、總長、是不是聽到一半就換掉（`Skipped`）、是不是按了停止或關閉 MIKU（`Stopped`）、是不是按「上一首」退回前一首（`Back`，這時 `Skipped` 是 false；舊版 MIKU 沒有 `Back`，退回會算成 `Skipped`）、當時佇列的 `source`）
- `RecentlyPlayed`（最近播過的歌，最新的在前，最多 200 首）、`Enqueue(ids, next)`（加到佇列最後，或下一首）、`QueueSource`（目前佇列是誰產生的）
- 舊版 MIKU 沒有這些成員：模組在舊版上呼叫會丟 `MissingMethodException`，要自己接住

## 佇列播完後

模組同時實作 `IQueueContinuation`，就可以接手「佇列播完後」：模組在自己的設定裡把 MIKU 的 `autoContinue` 設成 `similar` 來開啟（MIKU 的「佇列播完後」選單這時會變灰，說明改成「`ContinueName` 已開啟」，選單顯示關閉後會恢復的選擇：網頁偏好 `autoContinuePrev`）。開啟後，播到佇列最後一首時，MIKU 會呼叫 `Continue`（帶著佇列到目前為止最後 50 首、佇列的 `source`、`Chosen = true`），把回傳的歌加到佇列後面；模組沒有回傳任何歌時，改加幾首隨機的歌。目前佇列是模組自己帶 `source` 播的（例如它的電台）時，不管這個設定怎麼選，都會問模組（`Chosen = false`），模組的清單可以自己接下去。重複播放開啟時都不會作用。

- 模組啟動失敗或拋出例外時，只會寫進 log，不影響 MIKU 本體
