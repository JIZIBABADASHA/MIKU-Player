@echo off
rem Builds the MIKU installer with MIKU alone, as on a Release (the extension modules ship as their own zips).
set MIKU_NO_EXT=1
call "%~dp0make-installer.cmd"
