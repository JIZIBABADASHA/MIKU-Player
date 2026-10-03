[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'artifacts\MIKU-PR1-檢查版'))
$ErrorActionPreference = 'Stop'
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw '請先安裝 .NET 8 SDK，才能從原始碼建置。' }
& dotnet publish (Join-Path $PSScriptRoot 'windows\MIKU.csproj') -c Release -r win-x64 --self-contained true -p:DebugType=None -p:DebugSymbols=false -o $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw '建置失敗；請檢查上方編譯訊息。' }
Write-Output "建置完成：$OutputDirectory"
