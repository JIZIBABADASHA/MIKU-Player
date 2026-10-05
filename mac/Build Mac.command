#!/bin/bash
# Double-click in Finder: sync the Windows UI → download what's needed → build the Mac installer (dist folder)
cd "$(dirname "$0")" || exit 1

pause() { echo; read -r -n 1 -s -p "Press any key to close this window…"; echo; }
fail() { echo; echo "❌ $1"; pause; exit 1; }

echo "════════ MIKU Mac build ════════"
echo

# Xcode Command Line Tools (python3, codesign)
if ! xcode-select -p >/dev/null 2>&1; then
  echo "The Command Line Developer Tools are not installed yet. An install window will appear."
  echo "Click \"Install\", then double-click this file again when it's done."
  xcode-select --install >/dev/null 2>&1
  pause; exit 1
fi

echo "① Syncing the Windows UI…"
if ! python3 build/sync_wwwroot.py; then
  echo
  echo "⚠️  Sync failed (the Windows UI changed where a Mac-specific edit applies; build/sync_wwwroot.py needs updating)."
  echo "   Building with the Mac UI as it is."
fi
echo

echo "② Downloading components and packaging (about 400 MB the first time, reused afterwards)…"
bash build/build.sh || fail "Build failed. Please take a screenshot of the messages above."

echo
echo "✅ Done! The installer is in the mac/dist folder, which has been opened for you."
open dist
pause
