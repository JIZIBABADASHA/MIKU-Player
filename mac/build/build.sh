#!/bin/bash
# 在 Mac（或 Linux）上重新打包 MIKU：下載 Electron 與 FFmpeg，產生 dist/MIKU-<版本>-mac.pkg
set -euo pipefail
cd "$(dirname "$0")"
ELECTRON=v44.5.1
DL=./downloads
mkdir -p "$DL"
for a in arm64 x64; do
  f="$DL/electron-$ELECTRON-darwin-$a.zip"
  [ -f "$f" ] || curl -fL -o "$f" "https://github.com/electron/electron/releases/download/$ELECTRON/electron-$ELECTRON-darwin-$a.zip"
  for t in ffmpeg ffprobe; do
    g="$DL/$t-darwin-$a.gz"
    [ -f "$g" ] || curl -fL -o "$g" "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/$t-darwin-$a.gz"
  done
done
EXTRA=()
if [ "$(uname)" != "Darwin" ]; then
  # Linux 需要 rcodesign（ad-hoc 簽章）與 bomutils 的 mkbom
  command -v rcodesign >/dev/null && EXTRA+=(--rcodesign "$(command -v rcodesign)")
  command -v mkbom >/dev/null && EXTRA+=(--mkbom "$(command -v mkbom)")
fi
python3 make_pkg.py --electron-dir "$DL" --ffmpeg-dir "$DL" --out ../dist "${EXTRA[@]}"
echo "完成：$(ls ../dist/*.pkg)"
