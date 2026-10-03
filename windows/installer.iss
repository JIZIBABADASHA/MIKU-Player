; MIKU installer (Inno Setup 6). Built by make-installer.cmd — don't run this by hand.
#define AppVer "1.3.0"

[Setup]
AppId={{6B3E2A71-4C8D-4F0A-9E57-1D2C3B4A5F60}
AppName=MIKU
AppVersion={#AppVer}
AppVerName=MIKU {#AppVer}
AppPublisher=MIKU
DefaultDirName={localappdata}\Programs\MIKU
DefaultGroupName=MIKU
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\MIKU-Setup
OutputBaseFilename=MIKU-Setup-{#AppVer}
SetupIconFile=app.ico
UninstallDisplayIcon={app}\MIKU.exe
UninstallDisplayName=MIKU
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; close a running MIKU before files are replaced
AppMutex=MIKU.Player.SingleInstance
CloseApplications=yes

[Languages]
#ifexist "ChineseTraditional.isl"
Name: "zh"; MessagesFile: "ChineseTraditional.isl"
#endif
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\MIKU\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\MIKU"; Filename: "{app}\MIKU.exe"
Name: "{autodesktop}\MIKU"; Filename: "{app}\MIKU.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\MIKU.exe"; Description: "{cm:LaunchProgram,MIKU}"; Flags: nowait postinstall skipifsilent

[Code]
// MIKU's interface runs on Microsoft Edge WebView2. Windows 11 has it built in; on an older
// Windows 10 install it may be missing, so offer the official download page.
function HasWebView2(): Boolean;
var v: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) and (v <> '') and (v <> '0.0.0.0'));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var code: Integer;
begin
  if (CurStep = ssPostInstall) and (not WizardSilent) and (not HasWebView2()) then
    if MsgBox('這台電腦缺少 Microsoft Edge WebView2 執行環境，MIKU 需要它才能顯示介面。' + #13#10 +
              '要現在開啟微軟的下載頁面嗎？（安裝 Evergreen Bootstrapper 即可）', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, code);
end;
