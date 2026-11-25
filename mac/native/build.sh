#!/bin/bash
# No Electron ABI dependency: the Core Audio engine is a separate, universal-capable executable.
# Built with the default SDK; when that fails (Command Line Tools whose clang is older than the newest SDK they hold,
# as on some macOS 11 machines) every other installed macOS SDK is tried, newest first.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../build/native
build() {   # <arch> <out> [sdk]
  xcrun ${3:+--sdk "$3"} clang++ -std=c++17 -O2 -Wall -Wextra -Werror -fobjc-arc -pthread \
    -arch "$1" -mmacosx-version-min=12.0 \
    -framework Foundation -framework CoreAudio \
    audio.mm -o "$2"
}
DEV="$(xcode-select -p 2>/dev/null || true)"
SDKS=()
for d in "$DEV/SDKs" "$DEV/Platforms/MacOSX.platform/Developer/SDKs"; do
  [ -d "$d" ] || continue
  while IFS= read -r s; do SDKS+=("$s"); done < <(ls -d "$d"/MacOSX[0-9]*.sdk 2>/dev/null | sort -r)
done
LOG=$(mktemp)
for arch in arm64 x86_64; do
  name="$arch"
  [ "$arch" != x86_64 ] || name=x64
  out="../build/native/miku-audio-$name"
  build "$arch" "$out" 2>"$LOG" && continue
  ok=
  for s in ${SDKS[@]+"${SDKS[@]}"}; do
    if build "$arch" "$out" "$s" 2>>"$LOG"; then
      echo "miku-audio ($name): built with $(basename "$s"); the default SDK does not build with this clang"
      ok=1; break
    fi
  done
  [ -n "$ok" ] || { cat "$LOG" >&2; rm -f "$LOG"; echo "miku-audio ($name) did not build with any installed macOS SDK" >&2; exit 1; }
done
rm -f "$LOG"
