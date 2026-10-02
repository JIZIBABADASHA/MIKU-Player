@echo off
chcp 65001 >nul
title MIKU 自動編譯
cd /d "%~dp0"
echo 這個視窗會自動編譯 Claude 傳來的修正，請保持開啟。
:loop
if exist rebuild.flag (
  del rebuild.flag
  echo [%time%] 編譯中...
  call build.cmd
  type build-result.txt
)
timeout /t 2 /nobreak >nul
goto loop
