#!/bin/bash
# Double-click in Finder: the Mac installer with MIKU alone, as on a Release (the extension modules ship as their own zips)
export MIKU_NO_EXT=1
exec bash "$(dirname "$0")/Build Mac.command"
