#!/bin/bash
# 在 Mac（或 Linux）上重新打包 MIKU：下載 Electron、FFmpeg 與 fpcalc，產生 dist/MIKU-<版本>-mac.pkg
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
# Chromaprint fpcalc (macOS universal) for the tag editor's 聲紋辨識
FP="$DL/chromaprint-fpcalc-1.5.1-macos-universal.tar.gz"
[ -f "$FP" ] || curl -fL -o "$FP" "https://github.com/acoustid/chromaprint/releases/download/v1.5.1/chromaprint-fpcalc-1.5.1-macos-universal.tar.gz"
echo "d4d8faff4b5f7c558d9be053da47804f9501eaa6c2f87906a9f040f38d61c860  $FP" | shasum -a 256 -c - >/dev/null 2>&1 || echo "d4d8faff4b5f7c558d9be053da47804f9501eaa6c2f87906a9f040f38d61c860  $FP" | sha256sum -c -
tar xzf "$FP" -C "$DL"
EXTRA=(--fpcalc "$DL/chromaprint-fpcalc-1.5.1-macos-universal/fpcalc")
if [ "$(uname)" = "Darwin" ]; then
  bash ../native/build.sh
elif [ ! -f native/miku-audio-arm64 ] || [ ! -f native/miku-audio-x64 ]; then
  echo "原生 Core Audio 元件需要在 Mac 編譯；請先提供 build/native/miku-audio-{arm64,x64}。" >&2
  exit 1
fi
if [ "$(uname)" != "Darwin" ]; then
  # Linux 需要 rcodesign（ad-hoc 簽章）與 bomutils 的 mkbom
  command -v rcodesign >/dev/null && EXTRA+=(--rcodesign "$(command -v rcodesign)")
  command -v mkbom >/dev/null && EXTRA+=(--mkbom "$(command -v mkbom)")
fi
python3 make_pkg.py --electron-dir "$DL" --ffmpeg-dir "$DL" --out ../dist "${EXTRA[@]}"
echo "完成：$(ls ../dist/*.pkg)"
