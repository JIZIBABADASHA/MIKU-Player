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
  - `addNav`、`addRoute`、`addSettings`
  - `on`、`rpc`、`play`
  - `play(ids, shuffle, start, { at, source })`：`at` 是第一首開始的秒數；`source` 是任意 JSON 物件，表示「這個佇列是誰產生的」，會跟著佇列保存，直到改播別的東西
  - `playerSlot({ bar, nowPlaying })`：當目前佇列是本模組帶 `source` 播放的，播放列封面左側與全螢幕播放頁各有一個區塊，由 `bar(el, source)`、`nowPlaying(el, source)` 繪製；同時 `<html>` 會有 `data-ext-source="<id>"`，模組的樣式表可以據此改變播放列與播放頁的外觀。改播別的東西時全部還原
- 模組啟動失敗或拋出例外時，只會寫進 log，不影響 MIKU 本體
