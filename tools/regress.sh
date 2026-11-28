#!/usr/bin/env bash
# Regression check before pushing / installing. See docs/REGRESSION.md.
#   tools/regress.sh [old-ref]      old-ref defaults to origin/main
#   QUICK=1  guards + Mac sync only (seconds, no browser)
#   FULL=1   every scenario and the default sizes (slow; only when shared layout changed)
#   OUT=dir  where results go (default /tmp/miku-regress)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
OLD="${1:-origin/main}"; OUT="${OUT:-/tmp/miku-regress}"; SWEEP="$ROOT/windows/tools/ui-sweep"
fail=0; mkdir -p "$OUT"

echo "== 1. guards (tools/guards.txt)"
python3 - "$ROOT" <<'PY' || fail=1
import re, sys, os
root = sys.argv[1]; bad = 0
for ln in open(os.path.join(root, 'tools/guards.txt'), encoding='utf-8'):
    if not ln.strip() or ln.lstrip().startswith('#'): continue
    gid, f, rx = [p.strip() for p in ln.split('|', 2)]
    p = os.path.join(root, f)
    ok = os.path.exists(p) and re.search(rx, open(p, encoding='utf-8', errors='replace').read())
    if not ok: bad += 1; print(f'  FAIL {gid}: /{rx}/ not in {f}')
print('  all guards present' if not bad else f'  {bad} guard(s) missing')
sys.exit(1 if bad else 0)
PY

# An extension checked out at another commit than the one main records: a build from here
# would not match what the next clean build ships (FLOW-6).
drift="$(git submodule status 2>/dev/null | grep '^+' || true)"
if [ -n "$drift" ]; then echo "  FAIL submodule differs from the commit recorded in the index (git add it, or check out the recorded one):"; echo "$drift" | sed 's/^/    /'; fail=1; fi

echo "== 2. Mac UI copy in sync (sync_wwwroot.py)"
python3 mac/build/sync_wwwroot.py >"$OUT/sync.log" 2>&1 || { echo "  FAIL sync_wwwroot.py: see $OUT/sync.log"; fail=1; }
if ! git diff --quiet -- mac/app/wwwroot || [ -n "$(git ls-files --others --exclude-standard mac/app/wwwroot)" ]; then
  echo "  mac/app/wwwroot changed after sync: commit it with the Windows change (FLOW-2)"; git status --short mac/app/wwwroot | head; fail=1
else echo "  in sync"; fi

if [ "${QUICK:-0}" = 1 ]; then echo; [ $fail = 0 ] && echo "PASS (quick)" || echo "FAIL"; exit $fail; fi

[ -d "$SWEEP/node_modules/playwright" ] || { echo "playwright missing: cd $SWEEP && npm i playwright && npx playwright install webkit"; exit 2; }
if [ "${FULL:-0}" = 1 ]; then ARGS=(); else
  ARGS=(--scen home,album,np,paused,nppaused,npmw,homemw,tracks,folders --sizes 1366x860,1100x700); fi

echo "== 3. layout checker on the new version"
node "$SWEEP/sweep.js" --root "$ROOT/windows/wwwroot" --out "$OUT/sweep" --engine webkit "${ARGS[@]}" >"$OUT/sweep.log" 2>&1
n=$(grep -cv '^\s*$' "$OUT/sweep/summary.txt" 2>/dev/null || echo 0)
echo "  $n line(s) in $OUT/sweep/summary.txt"; head -20 "$OUT/sweep/summary.txt" 2>/dev/null

echo "== 4. before / after against $OLD"
rm -rf "$OUT/old" "$OUT/A" "$OUT/A2" "$OUT/B" "$OUT/diff"; mkdir -p "$OUT/old"
if git archive "$OLD" windows/wwwroot | tar -x -C "$OUT/old"; then
  for r in "old/windows/wwwroot A" "old/windows/wwwroot A2"; do set -- $r
    node "$SWEEP/sweep.js" --root "$OUT/$1" --out "$OUT/$2" --engine webkit --shots png "${ARGS[@]}" >>"$OUT/sweep.log" 2>&1; done
  node "$SWEEP/sweep.js" --root "$ROOT/windows/wwwroot" --out "$OUT/B" --engine webkit --shots png "${ARGS[@]}" >>"$OUT/sweep.log" 2>&1
  python3 "$SWEEP/diff.py" "$OUT/A" "$OUT/A2" "$OUT/B" "$OUT/diff" && head -30 "$OUT/diff/summary.txt"
  echo "  look at $OUT/diff/sheet-*.png: every change listed must be one this commit meant to make"
else echo "  could not read $OLD (git fetch it first)"; fail=1; fi

echo; [ $fail = 0 ] && echo "guards + sync PASS; review steps 3 and 4 above" || echo "FAIL"; exit $fail
