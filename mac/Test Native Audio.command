#!/bin/bash
# Double-click in Finder: compile the native Core Audio helper and run the audio checks.
# The hardware part plays silence only (all-zero samples) and puts every device back the way it was.
cd "$(dirname "$0")" || exit 1
mkdir -p build/backups
LOG="build/backups/native-test.log"
exec > >(tee "$LOG") 2>&1
pause() { echo; read -r -n 1 -s -p "Press any key to close this window…"; echo; }
fail() { echo; echo "❌ $1"; echo "RESULT: FAIL"; pause; exit 1; }
echo "════════ MIKU native audio check ════════"
date; sw_vers 2>/dev/null | tr '\n' ' '; echo; uname -m
ARCH=$([ "$(uname -m)" = arm64 ] && echo arm64 || echo x64)
echo
echo "① Compiling the Core Audio helper (arm64 + x64)…"
bash native/build.sh || fail "Compiling native/audio.mm failed"
HELPER="build/native/miku-audio-$ARCH"
echo
echo "② Helper self-test"
"$HELPER" --self-test || fail "Self-test failed"
echo
echo "③ Output devices"
"$HELPER" --devices | /usr/bin/python3 -c 'import json,sys
for d in json.load(sys.stdin)["devices"]:
    print("  -", d["name"], "|", d.get("transport"), "|", d["rate"], "Hz |", d["physicalFormat"], "| hog:", d["exclusiveSupported"], "| owner:", d["ownerPid"], "| DEFAULT" if d["isDefault"] else "")' || echo "  (could not list devices)"
echo
echo "③b Start / switch sequences that used to hang the output, on the USB DAC (silence only)"
DIAG_FF="build/work/root-$ARCH/MIKU.app/Contents/Resources/bin/ffmpeg"
DIAG_WAV="${TMPDIR:-/tmp}/miku-diag-silence.wav"
DAC=$("$HELPER" --devices | /usr/bin/python3 -c 'import json,sys
ds=[d for d in json.load(sys.stdin)["devices"] if not d["isDefault"] and d.get("transport")=="usb"]
print(ds[0]["name"] if ds else "")')
if [ -x "$DIAG_FF" ] && [ -n "$DAC" ]; then
  "$DIAG_FF" -v error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 8 -c:a pcm_s24le "$DIAG_WAV" </dev/null
  "$HELPER" --diag-engine "$DAC" "$PWD/$DIAG_FF" "$DIAG_WAV" </dev/null 2>&1 | grep -v '^{"'
else
  echo "  (skipped: no USB DAC or no FFmpeg yet)"
fi
ELECTRON="build/work/root-$ARCH/MIKU.app/Contents/MacOS/Electron"
if [ -x "$ELECTRON" ]; then NODE=(env ELECTRON_RUN_AS_NODE=1 "$ELECTRON")
elif command -v node >/dev/null; then NODE=(node)
else fail "No Node / Electron found (run Build Mac.command once first)"; fi
export MIKU_AUDIO_HELPER="$PWD/$HELPER"
[ -x "build/work/root-$ARCH/MIKU.app/Contents/Resources/bin/ffmpeg" ] && export MIKU_TEST_FFMPEG="$PWD/build/work/root-$ARCH/MIKU.app/Contents/Resources/bin/ffmpeg"
echo
echo "④ App-side checks (fake helper)"
"${NODE[@]}" tests/native-audio-events.js || fail "App-side checks failed"
echo
echo "⑤ Decoding, labels, DSP and hardware checks (silence only; connect your USB DAC first)"
"${NODE[@]}" tests/native-audio.js --hardware || fail "Native / hardware checks failed"
echo
echo "RESULT: PASS"
echo "✅ All checks passed. Next: double-click Build Mac.command to make the installer."
pause
