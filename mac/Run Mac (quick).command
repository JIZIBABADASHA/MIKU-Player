#!/bin/bash
# Double-click in Finder: start MIKU straight from this checkout to try a change, in a few seconds and without an
# installer (the Mac side of running the Windows build's exe). It takes the MIKU.app the last "Build Mac.command" made
# (build/work/root-<arch>/MIKU.app), puts the current page, main process and modules' scripts into it and opens it,
# with your own settings and library. Native parts (Core Audio helper, FFmpeg, the modules' helpers) stay as built:
# after a change to those, run "Build Mac.command" again.
cd "$(dirname "$0")" || exit 1

pause() { echo; read -r -n 1 -s -p "Press any key to close this window…"; echo; }
fail() { echo; echo "❌ $1"; pause; exit 1; }

arch=$(uname -m); [ "$arch" = arm64 ] || arch=x64
APP="build/work/root-$arch/MIKU.app"
[ -d "$APP" ] || fail "No built MIKU yet: double-click \"Build Mac.command\" once first."
RES="$APP/Contents/Resources"

echo "① Syncing the Windows UI…"
python3 build/sync_wwwroot.py || echo "⚠️  Sync failed; starting with the Mac UI as it is."

echo "② Updating the app…"
rsync -a --delete --exclude node_modules --exclude .DS_Store app/ "$RES/app/" || fail "Copying app/ failed."
# the modules' scripts and page parts (Extensions/<Name>/miku, as their pack-mac.sh lays them out)
for d in "$RES"/ext/*/; do
  id=$(basename "$d")
  for m in ../Extensions/*/miku; do
    grep -q "id: '$id'" "$m/extension.js" 2>/dev/null || continue
    cp "$m"/*.js "$d"
    rsync -a --delete -L "$m/web/" "${d}web/"
  done
done
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "⚠️  Re-signing failed; macOS may refuse to open it."

echo "③ Starting MIKU…"
# one MIKU at a time on the same settings: the installed one closes first
osascript -e 'tell application id "com.miku.player" to quit' >/dev/null 2>&1
osascript -e 'tell application "MIKU" to quit' >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq MIKU || pgrep -f "MIKU.app/Contents/MacOS" >/dev/null || break; sleep 0.5; done
# the page keeps scripts and styles by their URL (?v=…): an edit that kept its version would load the old file
rm -rf "$HOME/Library/Application Support/MIKU/Cache" "$HOME/Library/Application Support/MIKU/Code Cache"
open "$APP" || fail "MIKU did not start."
echo "✅ Started ($APP)."
