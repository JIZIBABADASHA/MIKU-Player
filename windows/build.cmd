@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "DOTNET=%~dp0..\.tools\dotnet\dotnet.exe"
if not exist "%DOTNET%" set "DOTNET=dotnet"
set DOTNET_CLI_TELEMETRY_OPTOUT=1
set DOTNET_NOLOGO=1
set DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
echo Building MIKU...
taskkill /im MIKU.exe >nul 2>&1
timeout /t 3 /nobreak >nul
taskkill /im MIKU.exe /f >nul 2>&1
"%DOTNET%" publish MIKU.csproj -c Release -r win-x64 --self-contained false -o "%~dp0..\MIKU" -p:DebugType=none > build.log 2>&1
if errorlevel 1 (
  echo BUILD FAILED > build-result.txt
  echo 編譯失敗，詳細內容在 build.log
) else (
  echo BUILD OK > build-result.txt
  rem remove developer-only leftovers from the program folder
  if exist "%~dp0..\MIKU\debug" rd /s /q "%~dp0..\MIKU\debug"
  del /q "%~dp0..\MIKU\*.xml" 2>nul
  del /q "%~dp0..\MIKU\*.pdb" 2>nul
  del /q "%~dp0..\MIKU\wwwroot\mock.js" 2>nul
  del /q "%~dp0..\MIKU\Microsoft.Web.WebView2.Wpf.dll" 2>nul
  echo 完成！程式在 ..\MIKU\MIKU.exe
)
