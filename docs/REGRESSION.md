# MIKU 需求與回歸清單

使用者要過的每一個行為都列在這裡。**任何改動在推上 main、裝到 Windows / Mac 之前，都要對照這份清單**，
確定沒有把以前做好的東西弄壞。使用者提出新需求時，在對應的區塊加一行（含日期）。

- 平台：`W` = Windows，`M` = Mac，`W+M` = 兩邊都要（預設）。
- 驗證：`auto:<種類>` = `tools/regress.sh` 會自動抓（ui-sweep 的 check.js 種類、guards、diff）；`manual` = 要在實機上看。
- 來源：commit 或需求日期。找不到原始需求時以 commit 為準。

一鍵檢查：`tools/regress.sh [舊版 commit，預設 origin/main]`（說明在本文件最後）。

---

## 1. 播放列（底部）

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| BAR-1 | 播放鍵的三角形在按鈕中間（視覺上），暫停的兩條也在同一個位置，**修三角形不能動到暫停鍵** | W+M | auto:center + diff（要看 paused / nppaused 兩頁） | fe6f175, f6953e7, d369b53 (11-26) |
| BAR-2 | 點播放列上標題旁的空白處打開正在播放頁；只有點到標題 / 演出者文字才跳專輯 / 演出者頁 | W+M | auto:hit | fe6f175 |
| BAR-3 | 有空間時一定顯示歌名；MoodWave 頻道條滑入後歌名不會消失 | W+M | auto:squeeze, blank | d545e9a, edfb2cd |
| BAR-4 | 同一首歌重畫時，歌名不重播進場動畫（不閃） | W+M | auto:blank | edfb2cd |
| BAR-5 | 點播放列上的 MoodWave 頻道條，直接開正在播放頁 | W+M | manual | ec14c6c (10-24) |
| BAR-6 | 從全螢幕正在播放頁點播放列的標題 / 演出者，會離開全螢幕並打開該頁 | W+M | manual | b5b0214 |
| BAR-7 | 輸出裝置名稱與訊號標籤的字不被裁掉上下緣 | W+M | auto:half | 3c82961 |
| BAR-8 | 訊號標籤（Hi-Res / DSD / 升頻 / DSP / 有損）在 MoodWave 下保持原本顏色，看得出格式 | W+M | manual | c2e97e9 (10-23) |
| BAR-9 | 拖動進度條：放開後停在點的位置，直到引擎回報（最多 9 秒），不跳回去 | W+M | manual | 015cff2 |
| BAR-10 | 進度條時間提示在播放鍵上方、看得清楚（玻璃主題也一樣） | W+M | manual | 92deae8, ceba1a1 |
| BAR-11 | 封面 hover 放大後縮回，沒有最後往旁邊跳一下 | W+M | manual | 0bb6480 |
| BAR-12 | 隨機播放的圖示是重畫過的那一版 | W+M | auto:diff | 9d3b410 |
| BAR-13 | 播 MoodWave 頻道時換到字型不同的主題或改文字大小，播放列的頻道名稱不壓到旁邊的 👍 / 👎 | W+M | auto:guard `bar-band-refit` + manual | MoodWave 0a062f7 (11-25)；11-26 重建時 submodule 指在 e48b10a 而少了它，11-28 補回 |

## 2. 正在播放頁（全螢幕）

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| NP-1 | 雙擊封面加入最愛：愛心出現在封面中央、正立，從封面擴散出兩圈淡淡的水波，到視窗邊 | W+M | manual | 6eb0207…3d6b7d1 (10-26) |
| NP-2 | 雙擊已是最愛的封面：移出最愛，愛心裂成兩半、停約半秒再落下變灰，全程約 2 秒 | W+M | manual | f16f2dc, 731e0e8, ff9f850, cb72636 |
| NP-3 | **MoodWave 電台或頻道（如「早晨」）播放中，在封面上左右滑 = 👍 / 👎**（Windows 滑鼠拖曳、Mac 觸控板雙指左右滑都要能用；頻道的票與輪盤旁的 👍 / 👎 相同） | W+M | auto:guard `mac-np-swipe` + `np-swipe-ch`（Extensions/MoodWave 須含頻道投票 coverVote，submodule 不可指回沒有它的版本）+ manual（Mac 觸控板，頻道播放中） | ec9bd54, 1732fea；MoodWave 0e96f14/e48b10a（submodule 現指 0a062f7）；11-26 Mac 消失：Mac 安裝檔用了沒有頻道投票的 MoodWave 5e7ec4b，回歸 |
| NP-4 | Mac：在正在播放頁雙指上滑把播放列拉上來、下滑放下 / 關閉；在歌詞上下滑仍是捲歌詞 | M | manual | 1732fea, mac-navigation.js |
| NP-5 | Windows：在正在播放頁滾輪可以升 / 降播放列；全螢幕下捲動可叫出控制 | W | manual | c1cbcf5 |
| NP-6 | 右上角歌詞按鈕打開 5 秒後淡出，滑到上方再出現 | W+M | manual | a590640 (11-12) |
| NP-7 | 歌詞翻譯按鈕顯示開 / 關狀態；翻譯展開收合是動畫，不重畫 | W+M | manual | d002b20, 1ed7e4b |
| NP-8 | 換歌時不殘留上一張專輯的封面 | W+M | manual | 1cb9a6d |
| NP-9 | 「歌詞時間」那列在每個主題都在歌詞下方自己的一條，不疊在別的東西上 | W+M | auto:overlap | eb1c933 |
| NP-10 | 播放頁的資訊、貼紙、歌詞彼此不重疊；按鈕不互碰；歌詞離播放器至少 8px | W+M | auto:overlap, touch | c9c3577 |
| NP-11 | 海報主題 NOW PLAYING 貼紙：在右上角順時針傾斜，跑到左上角時逆時針 | W+M | auto:tilt | 340ca13 |
| NP-12 | MoodWave 頻道模式下，播放頁用該主題的夜間配色（深底白字），字型仍是主題自己的 | W+M | auto:font | c5a51e1, 7903c28 |
| NP-13 | **打開正在播放頁時，封面一次就到最終大小**（任何主題、任何視窗大小 / 比例，不是先大再小、縮放好幾次）；封面仍不疊到歌詞、標題、資訊、進度列、按鈕 | W+M | auto:guard `np-fit-settled` + overlap；manual：縮放視窗後關掉再打開播放頁 | fit.js（11-27） |
| NP-13 | MoodWave 轉盤上的頻道名稱完整，不被「…」截斷（終端機等寬字也一樣） | W+M | auto:short | 6283d15 |
| NP-14 | 碎裂 / 資料流動畫播放時再點一下畫面可以取消 | W+M | manual | b54ec6d (10-24) |
| NP-15 | 窄視窗時 MoodWave 的滑動提示不蓋到封面 | W+M | manual | 1ed8ab5 |
| NP-16 | MoodWave 封面兩側的 👎 / 👍 滑動提示不壓到主題自己畫的框（例如終端機主題歌詞螢幕的外框） | W+M | auto:guard `np-hint-frame` + manual | MoodWave 0200732 (11-25)；11-26 重建時 submodule 指在 e48b10a 而少了它，11-28 補回 |

## 3. 歌詞

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| LY-1 | 換行時歌詞不上下跳、不閃 | W+M | manual | 70d1d70 (11-17), ac5e6db |
| LY-2 | 手動捲歌詞停在第一 / 最後一行（在淡出邊緣），停手後自己回到目前那句 | W+M | manual | 1047958, 49e98f2 |
| LY-3 | 一句歌詞不會只剩一個字單獨一行；無時間軸的歌詞不留單一短字一行 | W+M | auto:orphan | 8087f66, 9ea0829 |
| LY-4 | 捲出上緣的歌詞整句一起離開（終端機、普普卡片），不留半句 | W+M | auto:half | 9ea0829, d6dafa9 |
| LY-5 | 歌詞行內的 `[mm:ss.xx]` 逐字時間要被讀成時間軸，不能當文字顯示 | W+M | manual（用含逐字時間的 LRC） | 5f62e44 (11-26) |
| LY-10 | 終端機：歌曲開始前閃的方塊游標，就在第一句歌詞出現的位置（同一行高度、同一個起點），不能一上一下 | W+M | manual（終端機日 / 夜，前奏較長的歌） | 8caed68 (11-26) |
| LY-6 | 可以匯入 .lrc 檔，之後固定用那份 | W+M | manual | 2640e51 |
| LY-7 | 終端機主題歌曲開始時第一行是亮的；舊行淡出 | W+M | manual | dac3f42, edfb2cd |
| LY-8 | 黑膠主題歌詞沿唱片弧線排列，唱片逆時針轉 | W+M | auto:diff | a54ac6d, d811a52 |
| LY-9 | 每個主題的歌詞都讀得清楚 | W+M | auto:faint | 0673ea3 |

## 4. 主題（15 個以上，每個都有日 / 夜）

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| TH-1 | 每個主題 × 日 / 夜 × 每頁 × 每個視窗大小：沒有被裁掉的按鈕、半行字、橫向截斷、重疊、跑出畫面 | W+M | auto:clip, half, hcut, overlap, offscreen | c9c3577 起 |
| TH-2 | 文字對比至少 2.05:1 | W+M | auto:faint | ui-sweep contrast.js |
| TH-3 | 和紙、未來回到使用者選的「先前版本」設計，不要再改回去 | W+M | auto:diff | 0c22d2d, c38b9b5 (11-24) |
| TH-4 | 主題選擇器：左邊一張大預覽、右邊名稱列表 | W+M | manual | 8539ad0 |
| TH-5 | 只載入目前主題的 CSS | W+M | manual | ba98a83 |
| TH-6 | 輕量模式：只顯示目前主題自己的特效選項 | W+M | manual | 89bf547 |
| TH-7 | 頁面標題前的主題符號（終端機的 `$`）對齊標題中線，MoodWave 標題也一樣 | W+M | auto:align | 1aa6d3e |
| TH-8 | 程式庫頁角落的主題裝飾（和紙月亮、霓虹線條）不碰到標題列按鈕或搜尋列 | W+M | auto:overlap | 49ca16f, b5d94e1 |
| TH-9 | 沒有「undefined」「NaN」等未填值顯示（設定 > 音訊的緩衝大小） | W+M | auto:junk | b5e4545 |
| TH-10 | 黑膠的唱盤在專輯名稱很長時讓位，名稱不被截 | W+M | auto:short | dac3f42 |
| TH-11 | 收合側邊欄時 logo 在邊界內；金色選取寶石不跑出畫面 | W+M | auto:clip | ac32a45 |

## 5. 側邊欄、頁面、捲動

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| UI-1 | 矮視窗時「設定」固定在側邊欄底部，不用捲就看得到；捲動時沒有一列疊到設定後面 | W+M | auto:offscreen, overlap | 340ca13 |
| UI-2 | 用滑鼠拖曳可以捲動頁面、清單、首頁橫列，放開有慣性，慢甩很快停 | W+M | auto:guard `dragscroll` + manual | 38dbf08, 5409650, 8c88c52 |
| UI-3 | 首頁橫列拖 / 滑時不會吸附到卡片 | W+M | manual | ffb68c9 |
| UI-4 | Mac：雙指滑動返回上一頁不會被吃掉 | M | manual | b941351 (11-24) |
| UI-5 | 專輯頁一律從最上面打開 | W+M | manual | 65ba54b |
| UI-6 | 專輯頁工具列：窄視窗時換到標題下方、整排在視窗內；寬時在標題右邊 | W+M | auto:clip | b5e4545 |
| UI-7 | 專輯大標題不裁掉下緣、不擠到演出者 | W+M | auto:half | ec7a8ed |
| UI-8 | 所有分段控制、開關、格狀切換都有動畫 | W+M | manual | 0c28143 |
| UI-9 | 選單：點選項靠下緣也有反應 | W+M | manual | 1a8e6be |
| UI-10 | 曲目清單播放中圖示、hover 播放鍵、金色硬幣皇冠都對齊編號 | W+M | auto:center | 07d74d7, f6953e7 |
| UI-11 | 封面確認按鈕在窄欄裡完整 | W+M | auto:clip | 7903c28 |
| UI-12 | MoodWave Smart Playlist 卡可點、無底線 | W+M | manual | 10-22 |
| UI-13 | 背景工作（寫標籤 / 封面、轉檔、批次搜尋）在側邊欄顯示進度卡，關掉對話框也繼續 | W+M | manual | b4a2c91 |

## 6. 曲庫、搜尋

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| LIB-1 | 用羅馬拼音、假名、漢字混拼音（「小sa」）搜得到日文名 | W+M | auto:guard `search-ja` + manual | 11e1154, c205528, 3efea51 |
| LIB-2 | 演出者用 、 ， 分開成各自的頁面；同一人的名字變體合併成一頁（月村手毬） | W+M | manual | e663ccd, 40e7597 |
| LIB-3 | 專輯可拖進演出者頁的「專輯」 | W+M | manual | 151c9c3, cadd2de |
| LIB-4 | 多碟（[Disc 1] / 子資料夾不同專輯演出者）合併成一張專輯 | W+M | manual | 14ca35c, 5b93143 |
| LIB-5 | 專輯可依資料夾排序 | W+M | manual | 51b9c7b |
| LIB-6 | 專輯格不顯示已被替換的舊封面 | W+M | manual | 6b9a4e8 |
| LIB-7 | 專輯版本切換時選中的版本有標示 | W+M | manual | 164456e |
| LIB-8 | 標籤編輯寫入的內容 foobar2000 讀起來一樣；保留 RIFF INFO | W+M | manual | aeb0b53, b76afac |
| LIB-9 | 播放清單匯入 m3u / m3u8 / pls / xspf / fpl 等 20+ 格式，用實際檔案位置、寬鬆比對；匯出 m3u8 | W+M | manual | cfd7ff4, 8b1778d |

## 7. 遠端音樂庫、手機

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| RM-1 | 任一台 MIKU 可播另一台的曲庫，邊下載邊播，斷線會重連不直接結束 | W+M | manual | 33f1053, 121b523, 8613d0c |
| RM-2 | 本地 / 遠端切換時（雙向）正在播放的資訊保留；切回本地後下一首遠端歌也保留 | W+M | manual | 2da4bee, bb10be1 |
| RM-3 | 本地 / 遠端開關文字置中，離線狀態是按鈕邊緣的小燈 | W+M | manual | a0b8e00 |
| RM-4 | 離線下載清單可收合，可排除專輯，可選存放資料夾 | W+M | manual | 4414049, aaac0a0 |
| RM-5 | 手機遙控可在手機上聽，也可透過 Tailscale 在外面聽 | W+M | manual | 8455bb3 |

## 8. 音訊、平台

| ID | 必須成立 | 平台 | 驗證 | 來源 |
|---|---|---|---|---|
| AU-1 | Mac：選獨佔時內建喇叭仍用共享模式播放 | M | manual | 0f2ca55 |
| AU-2 | Mac：在獨佔裝置上調音量時詢問是否切成共享（不要直接改硬體音量，那版已撤回） | M | manual | e7c2e88, 41d5bba |
| AU-3 | Bit-perfect 按鈕看起來是按鈕，文字是一般文字色 | W+M | manual | bc51023, e86ce69 |
| AU-4 | 長時間播放不變卡（記憶體 / CPU 平穩） | W+M | manual（soak） | e1a92d6 (11-19) |
| AU-5 | 緩衝大小可到 200 ms | W+M | manual | cb51b58 |
| AU-6 | **鍵盤的播放 / 暫停、下一首、上一首鍵控制 MIKU**：剛開 App 還沒播、暫停很久、換播放核心（Daphne）後都要有效；MIKU 在背景也有效。Mac 第一次會要求「輔助使用」權限 | W+M | auto:guard `media-keys-*` + manual（按三個鍵） | 11-26 使用者回報無效 |

## 9. 流程規則（每次改動都要）

| ID | 必須成立 |
|---|---|
| FLOW-1 | 每個修正 / 功能 Windows 和 Mac 都要做，除非問題真的只在一邊（要明講）。 |
| FLOW-2 | 改 `windows/wwwroot` 後一定跑 `python3 mac/build/sync_wwwroot.py`，Mac 那份一起 commit（`tools/regress.sh` 會檢查）。 |
| FLOW-3 | 推上 main 後同步更新 Windows（Remote Control 在使用者 PC 上 build）和 Mac（建 pkg、打開安裝程式讓使用者按）。 |
| FLOW-4 | 修一個地方前先跑 diff：只有想改的東西在畫面上變了（例如修三角形不能動到暫停鍵）。 |
| FLOW-5 | 使用者說「以前可以」就是回歸：找出哪個 commit 拿掉的，修回來，並在這份清單加一條自動檢查。 |
| FLOW-6 | `Extensions/` 底下的改動（MoodWave 等）只推到 fork 分支、或只把檔案寫進安裝目錄，都不算完成：同一次要把 MIKU-Player 的 submodule 指到那個 commit 並推上 main，否則下次重建就回到舊版（11-26 的封面左右滑、提示壓框就是這樣不見的）。`tools/regress.sh` 會檢查 submodule 取出的版本和 main 記的一致。 |

---

## 一鍵檢查：`tools/regress.sh`

```
tools/regress.sh               # 和 origin/main 比
tools/regress.sh 1aa6d3e       # 和指定 commit 比
QUICK=1 tools/regress.sh       # 只跑 guards + Mac 同步檢查（幾秒，不開瀏覽器）
```

依序做：

1. **guards**（`tools/guards.txt`）：清單上容易被誤刪的功能，檢查其程式碼還在 Windows 和 Mac 兩份裡。
2. **Mac 同步**：跑 `sync_wwwroot.py`，`mac/app/wwwroot` 若有差異就失敗。
3. **版面檢查**：ui-sweep 對新版跑預設情境，列出 check.js 的所有問題（`OUT/sweep/summary.txt`）。
4. **前後比對**：舊版跑兩次、新版一次，`diff.py` 列出畫面上所有改變的地方（`OUT/diff/summary.txt`、`sheet-*.png`）。
   改變的地方都必須是這次想改的；其他的就是回歸。

需要 node + playwright（`cd windows/tools/ui-sweep && npm i playwright && npx playwright install webkit`）和 python3 + Pillow。
省用量：一般改動跑預設（主要情境、兩個尺寸）就好，不要每次掃全部頁面；只有改到共用版面才加 `FULL=1`。
