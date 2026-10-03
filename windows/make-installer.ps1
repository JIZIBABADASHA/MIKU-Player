#Requires -Version 5.1
# Builds MIKU-Setup-<ver>.exe: self-contained MIKU + LGPL ffmpeg, packed with Inno Setup.
# Started by make-installer.cmd.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Src   = $PSScriptRoot
$Tools = Join-Path (Split-Path $Src -Parent) '.tools'
$Dist  = Join-Path $Src 'dist\MIKU'
$Log   = Join-Path $Src 'installer.log'
$Out   = Join-Path (Split-Path $Src -Parent) 'MIKU-Setup'
Set-Content -Path (Join-Path $Src 'installer-result.txt') -Value 'INSTALLER FAILED' -Encoding ASCII
Set-Content -Path $Log -Value "MIKU installer build $(Get-Date)" -Encoding UTF8
function Say($m) { Write-Host $m; Add-Content -Path $Log -Value $m -Encoding UTF8 }
# run a native tool, appending its output to the log (stderr must not abort the script)
function Run($exe, [string[]]$argv) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $exe @argv 2>&1 | ForEach-Object { "$_" } | Add-Content -Path $Log -Encoding UTF8
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    return $code
}
function Fail($m) { Say ''; Say "失敗：$m"; Say "詳細內容在 $Log"; exit 1 }
function Get($url, $file) { Say "    下載 $url"; Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing }

try {
    # ── 1. self-contained publish ─────────────────────────────
    Say '[1/4] 編譯 MIKU（獨立版，對方不需要安裝 .NET）...'
    $dotnet = Join-Path $Tools 'dotnet\dotnet.exe'
    if (-not (Test-Path $dotnet)) { $dotnet = 'dotnet' }
    # the .NET runtime alone can't build: make sure an SDK is there, with a clear message instead of "編譯失敗"
    $sdks = ''
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $sdks = (& $dotnet --list-sdks 2>$null | Out-String).Trim() } catch { }
    $ErrorActionPreference = $old
    if (-not $sdks) { Fail "找不到 .NET SDK（只有執行環境無法編譯）。請安裝 .NET 8 SDK（winget install Microsoft.DotNet.SDK.8），或把可攜版 SDK 放在 $Tools\dotnet" }
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'; $env:DOTNET_NOLOGO = '1'
    if (Test-Path (Join-Path $Src 'dist')) { Remove-Item (Join-Path $Src 'dist') -Recurse -Force }
    $code = Run $dotnet @('publish', (Join-Path $Src 'MIKU.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true',
        '-o', $Dist, '-p:DebugType=none', '-p:PublishReferencesDocumentationFiles=false')
    if ($code -ne 0) { Fail '編譯失敗' }
    foreach ($p in 'debug', 'wwwroot\mock.js', 'Microsoft.Web.WebView2.Wpf.dll') {
        $f = Join-Path $Dist $p; if (Test-Path $f) { Remove-Item $f -Recurse -Force }
    }
    Get-ChildItem $Dist -Filter *.xml | Remove-Item -Force
    Get-ChildItem $Dist -Filter *.pdb | Remove-Item -Force

    # ── 2. ffmpeg (LGPL build) ─────────────────────────────
    Say '[2/4] 準備 ffmpeg（LGPL 版）...'
    $ff = Join-Path $Tools 'ffmpeg'
    New-Item -ItemType Directory -Force -Path $ff | Out-Null
    if (-not (Test-Path (Join-Path $ff 'ffmpeg.exe'))) {
        try {
            $zip = Join-Path $env:TEMP 'miku-ffmpeg.zip'; $tmp = Join-Path $env:TEMP 'miku-ffmpeg'
            Get 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip' $zip
            if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
            Expand-Archive $zip $tmp -Force
            foreach ($n in 'ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt') {
                Get-ChildItem $tmp -Recurse -Filter $n | Select-Object -First 1 | Copy-Item -Destination $ff
            }
            Remove-Item $zip, $tmp -Recurse -Force
        } catch {
            Say "    下載失敗（$($_.Exception.Message)），改用這台電腦上已安裝的 ffmpeg"
            foreach ($n in 'ffmpeg', 'ffprobe') {
                $c = Get-Command $n -ErrorAction SilentlyContinue
                if ($c) { Copy-Item $c.Source -Destination $ff }
            }
        }
    }
    if (-not (Test-Path (Join-Path $ff 'ffmpeg.exe'))) { Fail '找不到 ffmpeg（下載失敗，這台電腦也沒有安裝）' }
    $dff = Join-Path $Dist 'ffmpeg'
    New-Item -ItemType Directory -Force -Path $dff | Out-Null
    Get-ChildItem $ff -File | Copy-Item -Destination $dff

    # ── 3. Inno Setup ─────────────────────────────
    Say '[3/4] 準備 Inno Setup...'
    $iscc = @(
        (Join-Path $Tools 'inno\ISCC.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $iscc) {
        $dir = Join-Path $Tools 'inno'
        $is = Join-Path $env:TEMP 'miku-innosetup.exe'
        function IsExe($f) {
            if (-not (Test-Path $f) -or (Get-Item $f).Length -lt 1MB) { return $false }
            $h = [IO.File]::ReadAllBytes($f)[0..1]; return ($h[0] -eq 0x4D -and $h[1] -eq 0x5A)   # "MZ"
        }
        try {
            # official release on GitHub (the website's download.php can hand back a web page instead of the exe)
            $rel = Invoke-RestMethod 'https://api.github.com/repos/jrsoftware/issrc/releases/latest' -UseBasicParsing
            $asset = $rel.assets | Where-Object { $_.name -match '^innosetup-[\d.]+\.exe$' } | Select-Object -First 1
            if (-not $asset) { throw 'GitHub release has no installer asset' }
            Get $asset.browser_download_url $is
        } catch { Say "    GitHub 下載失敗：$($_.Exception.Message)" }
        if (-not (IsExe $is)) {
            try { Get 'https://jrsoftware.org/download.php/is.exe?site=1' $is } catch { Say "    官網下載失敗：$($_.Exception.Message)" }
        }
        if (IsExe $is) {
            Unblock-File $is
            Start-Sleep -Seconds 2   # let antivirus finish scanning the new file
            $p = Start-Process $is -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/NOICONS', "/DIR=`"$dir`"" -Wait -PassThru
            Say "    Inno Setup 安裝結束（代碼 $($p.ExitCode)）"
            Remove-Item $is -Force -ErrorAction SilentlyContinue
        }
        $iscc = Join-Path $dir 'ISCC.exe'
        if (-not (Test-Path $iscc) -and (Get-Command winget -ErrorAction SilentlyContinue)) {
            Say '    改用 winget 安裝 Inno Setup...'
            Run 'winget' @('install', '--id', 'JRSoftware.InnoSetup', '-e', '--scope', 'user', '--silent', '--accept-package-agreements', '--accept-source-agreements') | Out-Null
            $iscc = @((Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')) |
                Where-Object { Test-Path $_ } | Select-Object -First 1
        }
        if (-not $iscc -or -not (Test-Path $iscc)) { Fail '無法安裝 Inno Setup（可以手動到 https://jrsoftware.org/isdl.php 安裝後再執行一次）' }
    }
    $isl = Join-Path $Src 'ChineseTraditional.isl'
    if (-not (Test-Path $isl)) {
        # Inno Setup 6.5 moved Chinese Traditional from Unofficial to the official languages: try the new place first
        foreach ($u in 'https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/ChineseTraditional.isl',
                       'https://raw.githubusercontent.com/jrsoftware/issrc/main/Files/Languages/Unofficial/ChineseTraditional.isl') {
            try { Get $u $isl; break } catch { if (Test-Path $isl) { Remove-Item $isl -Force } }
        }
        if (-not (Test-Path $isl)) { Say '    中文語系檔下載失敗，安裝程式改用英文介面' }
    }

    # ── 4. pack ─────────────────────────────
    Say '[4/4] 產生安裝檔...'
    Push-Location $Src
    $code = Run $iscc @('/Q', (Join-Path $Src 'installer.iss'))
    Pop-Location
    if ($code -ne 0) { Fail '產生安裝檔失敗' }
    $exe = Get-ChildItem $Out -Filter 'MIKU-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Set-Content -Path (Join-Path $Src 'installer-result.txt') -Value 'INSTALLER OK' -Encoding ASCII
    Say ''
    Say "完成！安裝檔：$($exe.FullName)（$([math]::Round($exe.Length / 1MB)) MB）"
    Start-Process explorer.exe "/select,`"$($exe.FullName)`""
}
catch {
    Add-Content -Path $Log -Value ($_ | Out-String) -Encoding UTF8
    Fail $_.Exception.Message
}
