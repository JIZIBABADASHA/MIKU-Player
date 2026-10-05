#!/bin/bash
# 在 Finder 裡雙擊這個檔案：同步 Windows 版介面 → 下載需要的元件 → 產生 Mac 安裝檔（dist 資料夾）
cd "$(dirname "$0")" || exit 1

pause() { echo; read -r -n 1 -s -p "按任意鍵關閉這個視窗…"; echo; }
fail() { echo; echo "❌ $1"; pause; exit 1; }

echo "════════ MIKU Mac 版編譯 ════════"
echo

# Xcode 命令列工具（python3、codesign）
if ! xcode-select -p >/dev/null 2>&1; then
  echo "這台 Mac 還沒有「命令列開發者工具」，接下來會跳出安裝視窗。"
  echo "請按「安裝」，裝好之後再雙擊這個檔案一次。"
  xcode-select --install >/dev/null 2>&1
  pause; exit 1
fi

echo "① 同步 Windows 版的介面…"
if ! python3 build/sync_wwwroot.py; then
  echo
  echo "⚠️  同步失敗（Windows 版介面改到了 Mac 專用修改的地方，需要更新 build/sync_wwwroot.py）。"
  echo "   這次先用 Mac 版現有的介面繼續編譯。"
fi
echo

echo "② 下載元件並打包（第一次約 400 MB，之後會重複使用）…"
bash build/build.sh || fail "編譯失敗，請把上面的訊息截圖。"

echo
echo "✅ 完成！安裝檔在 mac/dist 資料夾，已經幫你打開。"
open dist
pause
