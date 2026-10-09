#!/bin/bash
# No Electron ABI dependency: the Core Audio engine is a separate, universal-capable executable.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../build/native
for arch in arm64 x86_64; do
  name="$arch"
  [ "$arch" != x86_64 ] || name=x64
  xcrun clang++ -std=c++17 -O2 -Wall -Wextra -Werror -fobjc-arc -pthread \
    -arch "$arch" -mmacosx-version-min=12.0 \
    -framework Foundation -framework CoreAudio \
    audio.mm -o "../build/native/miku-audio-$name"
done
