# MIKU-Player: rules for every session

## Before any change is pushed or installed
1. Read `docs/REGRESSION.md`. It lists every behaviour the user asked for. A change must not break any of them.
2. Run `tools/regress.sh` (or at least `QUICK=1 tools/regress.sh` for a change outside `windows/wwwroot`).
   It checks the guards, that the Mac UI copy is in sync, runs the ui-sweep layout checker, and diffs the screens
   against `origin/main`. Every change the diff lists must be one this commit meant to make.
3. Check by hand the REGRESSION.md items marked `manual` that the change could touch, on both platforms.

## When the user asks for something new
Append it to `docs/REGRESSION.md` in the right section (ID, what must hold, platforms, how to verify, date/commit)
in the same commit as the change. If the user says something "used to work", it is a regression: find the commit
that dropped it, restore it, and add a guard to `tools/guards.txt` or a check to the ui-sweep.

## Both platforms
`windows/wwwroot` is the source of the UI; after editing it run `python3 mac/build/sync_wwwroot.py` and commit
`mac/app/wwwroot` too. Native code is separate: `windows/Host`, `windows/Audio` (C#) and `mac/app/main` (Electron).
Every fix goes to both unless the problem only exists on one (say so).
