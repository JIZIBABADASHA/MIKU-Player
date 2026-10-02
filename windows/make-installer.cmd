@echo off
rem Builds the MIKU installer. All the work is done by make-installer.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-installer.ps1"
echo.
pause
