; MIKU installer (Inno Setup 6). Built by make-installer.cmd — don't run this by hand.
#define AppVer "1.4.1"

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
; ask for the language first: it is the installer's language and MIKU's interface language (language.txt)
ShowLanguageDialog=yes
LanguageDetectionMethod=uilanguage

[Languages]
#ifexist "ChineseTraditional.isl"
Name: "zh"; MessagesFile: "ChineseTraditional.isl"
#endif
#ifexist "ChineseSimplified.isl"
Name: "zhs"; MessagesFile: "ChineseSimplified.isl"
#endif
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "ja"; MessagesFile: "compiler:Languages\Japanese.isl"

[Messages]
#ifexist "ChineseTraditional.isl"
zh.SelectLanguageTitle=選擇語言
zh.SelectLanguageLabel=選擇安裝程式與 MIKU 介面要使用的語言（之後可在 MIKU 的「設定 → 其他」更改）：
#endif
#ifexist "ChineseSimplified.isl"
zhs.SelectLanguageTitle=选择语言
zhs.SelectLanguageLabel=选择安装程序与 MIKU 界面要使用的语言（之后可在 MIKU 的「设置 → 其他」更改）：
#endif
en.SelectLanguageTitle=Select Language
en.SelectLanguageLabel=Select the language for the installer and for MIKU (you can change it later in MIKU under Settings → Other):
ja.SelectLanguageTitle=言語の選択
ja.SelectLanguageLabel=インストーラーと MIKU の表示言語を選んでください（あとで MIKU の「設定 → その他」で変更できます）：

[CustomMessages]
#ifexist "ChineseTraditional.isl"
zh.WebView2Missing=這台電腦缺少 Microsoft Edge WebView2 執行環境，MIKU 需要它才能顯示介面。%n要現在開啟微軟的下載頁面嗎？（安裝 Evergreen Bootstrapper 即可）
#endif
#ifexist "ChineseSimplified.isl"
zhs.WebView2Missing=这台电脑缺少 Microsoft Edge WebView2 运行时，MIKU 需要它才能显示界面。%n要现在打开微软的下载页面吗？（安装 Evergreen Bootstrapper 即可）
#endif
en.WebView2Missing=This computer is missing the Microsoft Edge WebView2 Runtime, which MIKU needs to show its interface.%nOpen Microsoft's download page now? (Installing the Evergreen Bootstrapper is enough.)
ja.WebView2Missing=このパソコンには、MIKU の画面表示に必要な Microsoft Edge WebView2 ランタイムがありません。%n今すぐ Microsoft のダウンロードページを開きますか？（Evergreen Bootstrapper をインストールするだけで OK です）

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "dist\MIKU\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\MIKU"; Filename: "{app}\MIKU.exe"
Name: "{autodesktop}\MIKU"; Filename: "{app}\MIKU.exe"; Tasks: desktopicon

[UninstallDelete]
Type: files; Name: "{app}\language.txt"

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

// The language picked in the installer becomes MIKU's interface language: MIKU reads language.txt next to
// MIKU.exe (Host/MainForm.cs InstallLang) and uses it until it is changed in 設定 → 其他 → 語言.
function MikuLang(): String;
begin
  if ActiveLanguage() = 'zhs' then Result := 'zh-Hans'
  else if ActiveLanguage() = 'en' then Result := 'en'
  else if ActiveLanguage() = 'ja' then Result := 'ja'
  else Result := 'zh-Hant';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var code: Integer;
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\language.txt'), MikuLang(), False);
  if (CurStep = ssPostInstall) and (not WizardSilent) and (not HasWebView2()) then
    if MsgBox(CustomMessage('WebView2Missing'), mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, code);
end;
