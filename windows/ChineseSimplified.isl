; *** Inno Setup version 6.5.0+ Chinese Simplified messages ***
; MIKU: converted from ChineseTraditional.isl (Traditional → Simplified, mainland wording)
; Name: GoneTone, gonetone@reh.tw
;
; Based on translations by: Anbang LI, anbangli@outlook.com
; Based on translations by: Enfong Tsao, nelson22768384@gmail.com
; Based on 5.5.3+ translations by Samuel Lee, Email: 751555749@qq.com
; Translation based on network resource
;
; Note: When translating this text, do not add periods (.) to the end of
; messages that didn't have them already, because on those messages Inno
; Setup adds the periods automatically (appending a period would result in
; two periods being displayed).
;
; Submit webpage: https://jrsoftware.org/files/istrans/

[LangOptions]
; The following three entries are very important. Be sure to read and
; understand the '[LangOptions] section' topic in the help file.
LanguageName=简体中文
; About LanguageID, to reference link:
; https://docs.microsoft.com/en-us/openspecs/windows_protocols/ms-lcid/a9eac961-e77d-41a6-90a5-ce1a8b0cdb9c
LanguageID=$0804
; About CodePage, to reference link:
; https://docs.microsoft.com/en-us/windows/win32/intl/code-page-identifiers
LanguageCodePage=936
; If the language you are translating to requires special font faces or
; sizes, uncomment any of the following entries and change them accordingly.
DialogFontName=Microsoft YaHei UI
;DialogFontSize=9
;DialogFontBaseScaleWidth=7
;DialogFontBaseScaleHeight=15
WelcomeFontName=Microsoft YaHei UI
;WelcomeFontSize=14

[Messages]

; *** Application titles
SetupAppTitle=安装程序
SetupWindowTitle=%1 安装程序
UninstallAppTitle=卸载
UninstallAppFullTitle=卸载 %1

; *** Misc. common
InformationTitle=信息
ConfirmTitle=确认
ErrorTitle=错误

; *** SetupLdr messages
SetupLdrStartupMessage=这将会安装 %1。您想要继续吗？
LdrCannotCreateTemp=无法创建临时文件。安装程序将会结束
LdrCannotExecTemp=无法运行临时文件。安装程序将会结束
HelpTextNote=

; *** Startup error messages
LastErrorMessage=%1。%n%n错误 %2：%3
SetupFileMissing=安装文件夹中遗失文件 %1。请修正此问题或重新获取此软件。
SetupFileCorrupt=安装文件已经损毁。请重新获取此软件。
SetupFileCorruptOrWrongVer=安装文件已经损毁，或与安装程序的版本不符。请修正此问题或重新获取此软件。
InvalidParameter=某个无效的参数已传递至命令行：%n%n%1
SetupAlreadyRunning=安装程序已经在运行。
WindowsVersionNotSupported=这个程序并不支持当前在电脑所运行的 Windows 版本。
WindowsServicePackRequired=这个程序需要 %1 Service Pack %2 或更新。
NotOnThisPlatform=这个程序无法在 %1 运行。
OnlyOnThisPlatform=这个程序必须在 %1 运行。
OnlyOnTheseArchitectures=这个程序只能在专门为以下处理器架构而设计的 Windows 上安装：%n%n%1
WinVersionTooLowError=这个程序必须在 %1 版本 %2 或以上的系统运行。
WinVersionTooHighError=这个程序无法安装在 %1 版本 %2 或以上的系统。
AdminPrivilegesRequired=您必须以管理员身份登录以安装这个程序。
PowerUserPrivilegesRequired=您必须以管理员身份登录或 Power Users 群组的成员以安装这个程序。
SetupAppRunningError=安装程序检测到 %1 正在运行。%n%n请立即关闭它的所有运行个体，然后按 「确定」 继续，或按 「取消」 离开。
UninstallAppRunningError=卸载程序检测到 %1 正在运行。%n%n请立即关闭它的所有运行个体，然后按 「确定」 继续，或按 「取消」 离开。

; *** Startup questions
PrivilegesRequiredOverrideTitle=选择安装程序安装模式
PrivilegesRequiredOverrideInstruction=选择安装模式
PrivilegesRequiredOverrideText1=可以为所有用户安装 %1 (需要管理员权限)，或是仅为您安装。
PrivilegesRequiredOverrideText2=可以仅为您安装 %1，或是为所有用户安装 (需要管理员权限)。
PrivilegesRequiredOverrideAllUsers=为所有用户安装 (&A)
PrivilegesRequiredOverrideAllUsersRecommended=为所有用户安装 (建议选项) (&A)
PrivilegesRequiredOverrideCurrentUser=仅为我安装 (&M)
PrivilegesRequiredOverrideCurrentUserRecommended=仅为我安装 (建议选项) (&M)

; *** Misc. errors
ErrorCreatingDir=安装程序无法创建文件夹「%1」
ErrorTooManyFilesInDir=无法在文件夹「%1」内创建文件，因为文件夹内有太多的文件。

; *** Setup common messages
ExitSetupTitle=结束安装程序
ExitSetupMessage=安装尚未完成。如果您现在结束安装程序，这个程序将不会被安装。%n%n您可以稍后再运行安装程序以完成安装。%n%n您现在要结束安装程序吗？
AboutSetupMenuItem=关于安装程序 (&A)...
AboutSetupTitle=关于安装程序
AboutSetupMessage=%1 版本 %2%n%3%n%n%1 网址：%n%4
AboutSetupNote=
TranslatorNote=

; *** Buttons
ButtonBack=< 上一步 (&B)
ButtonNext=下一步 (&N) >
ButtonInstall=安装 (&I)
ButtonOK=确定
ButtonCancel=取消
ButtonYes=是 (&Y)
ButtonYesToAll=全部皆是 (&A)
ButtonNo=否 (&N)
ButtonNoToAll=全部皆否 (&O)
ButtonFinish=完成 (&F)
ButtonBrowse=浏览 (&B)...
ButtonWizardBrowse=浏览 (&R)...
ButtonNewFolder=创建新文件夹 (&M)

; *** "Select Language" dialog messages
SelectLanguageTitle=选择安装语言
SelectLanguageLabel=选择在安装过程中使用的语言：

; *** Common wizard text
ClickNext=按 「下一步」 继续，或按 「取消」 结束安装程序。
BeveledLabel=
BrowseDialogTitle=浏览文件夹
BrowseDialogLabel=在下面的文件夹列表中选择一个文件夹，然后按 「确定」。
NewFolderName=新文件夹

; *** "Welcome" wizard page
WelcomeLabel1=欢迎使用 [name] 安装程序
WelcomeLabel2=这个安装程序将会安装 [name/ver] 到您的电脑。%n%n建议您在继续之前关闭所有其他的应用程序。

; *** "Password" wizard page
WizardPassword=密码
PasswordLabel1=这个安装程序具有密码保护。
PasswordLabel3=请输入密码，然后按 「下一步」 继续。密码是区分大小写的。
PasswordEditLabel=密码 (&P)：
IncorrectPassword=您输入的密码不正确，请重新输入。

; *** "License Agreement" wizard page
WizardLicense=许可协议
LicenseLabel=在继续安装之前请阅读以下重要信息。
LicenseLabel3=请阅读以下许可协议，您必须接受合约的各项条款才能继续安装。
LicenseAccepted=我同意 (&A)
LicenseNotAccepted=我不同意 (&D)

; *** "Information" wizard pages
WizardInfoBefore=信息
InfoBeforeLabel=在继续安装之前请阅读以下重要信息。
InfoBeforeClickLabel=当您准备好继续安装，请按 「下一步」。
WizardInfoAfter=信息
InfoAfterLabel=在继续安装之前请阅读以下重要信息。
InfoAfterClickLabel=当您准备好继续安装，请按 「下一步」。

; *** "User Information" wizard page
WizardUserInfo=用户信息
UserInfoDesc=请输入您的信息。
UserInfoName=用户名称 (&U)：
UserInfoOrg=组织 (&O)：
UserInfoSerial=序号 (&S)：
UserInfoNameRequired=您必须输入您的名称。

; *** "Select Destination Location" wizard page
WizardSelectDir=选择目的文件夹
SelectDirDesc=选择安装程序安装 [name] 的位置。
SelectDirLabel3=安装程序将会把 [name] 安装到下面的文件夹。
SelectDirBrowseLabel=按 「下一步」 继续，如果您想选择另一个文件夹，请按 「浏览」。
DiskSpaceGBLabel=最少需要 [gb] GB 可用磁盘空间。
DiskSpaceMBLabel=最少需要 [mb] MB 可用磁盘空间。
CannotInstallToNetworkDrive=安装程序无法安装于网络驱动器。
CannotInstallToUNCPath=安装程序无法安装于 UNC 路径。
InvalidPath=您必须输入完整的路径名称及驱动器代码，例如：%n%nC:\App%n%n或是 UNC 路径格式：%n%n\\服务器\共享文件夹
InvalidDrive=您选中的驱动器或 UNC 共享不存在或无法访问，请另外选择。
DiskSpaceWarningTitle=磁盘空间不足
DiskSpaceWarning=安装程序需要至少 %1 KB 的可用空间，您所选中的磁盘只有 %2 KB 可用空间。%n%n您仍要继续安装吗？
DirNameTooLong=文件夹名称或路径太长。
InvalidDirName=文件夹名称不正确。
BadDirName32=文件夹名称不得包含以下字符：%n%n%1
DirExistsTitle=文件夹已经存在
DirExists=文件夹：%n%n%1%n%n已经存在。仍要安装到该文件夹吗？
DirDoesntExistTitle=文件夹不存在
DirDoesntExist=文件夹：%n%n%1%n%n不存在。要创建该文件夹吗？

; *** "Select Components" wizard page
WizardSelectComponents=选择组件
SelectComponentsDesc=选择将会被安装的组件。
SelectComponentsLabel2=选择您想要安装的组件；清除您不想安装的组件。当您准备好继续安装，请按 「下一步」。
FullInstallation=完整安装
; if possible don't translate 'Compact' as 'Minimal' (I mean 'Minimal' in your language)
CompactInstallation=精简安装
CustomInstallation=自定义安装
NoUninstallWarningTitle=组件已存在
NoUninstallWarning=安装程序检测到以下组件已经安装在您的电脑上：%n%n%1%n%n取消选择这些组件将不会移除它们。%n%n您仍然要继续吗？
ComponentSize1=%1 KB
ComponentSize2=%1 MB
ComponentsDiskSpaceGBLabel=当前的选择需要至少 [gb] GB 磁盘空间。
ComponentsDiskSpaceMBLabel=当前的选择需要至少 [mb] MB 磁盘空间。

; *** "Select Additional Tasks" wizard page
WizardSelectTasks=选择附加工作
SelectTasksDesc=选择要运行的附加工作。
SelectTasksLabel2=选择安装程序在安装 [name] 时要运行的附加工作，然后按 「下一步」。

; *** "Select Start Menu Folder" wizard page
WizardSelectProgramGroup=选择「开始」菜单的文件夹
SelectStartMenuFolderDesc=选择安装程序创建程序的快捷方式的位置。
SelectStartMenuFolderLabel3=安装程序将会把程序的快捷方式创建在下面的「开始」菜单文件夹。
SelectStartMenuFolderBrowseLabel=按 「下一步」 继续，如果您想选择另一个文件夹，请按 「浏览」。
MustEnterGroupName=您必须输入一个文件夹的名称。
GroupNameTooLong=文件夹名称或路径太长。
InvalidGroupName=文件夹名称不正确。
BadGroupName=文件夹名称不得包含下列字符：%n%n%1
NoProgramGroupCheck2=不要在「开始」菜单中创建文件夹 (&D)

; *** "Ready to Install" wizard page
WizardReady=准备安装
ReadyLabel1=安装程序将开始安装 [name] 到您的电脑中。
ReadyLabel2a=按下 「安装」 继续安装，或按 「上一步」 重新查看或设置各选项的内容。
ReadyLabel2b=按下 「安装」 继续安装。
ReadyMemoUserInfo=用户信息：
ReadyMemoDir=目的文件夹：
ReadyMemoType=安装类型：
ReadyMemoComponents=选择的组件：
ReadyMemoGroup=「开始」菜单文件夹：
ReadyMemoTasks=附加工作：

; *** TDownloadWizardPage wizard page and DownloadTemporaryFile
DownloadingLabel2=正在下载文件...
ButtonStopDownload=停止下载 (&S)
StopDownload=您确定要停止下载吗？
ErrorDownloadAborted=已停止下载。
ErrorDownloadFailed=下载失败：%1 %2。
ErrorDownloadSizeFailed=获取文件大小失败：%1 %2。
ErrorProgress=进度无效：%1 / %2。
ErrorFileSize=文件大小无效：必须为 %1，收到 %2。

; *** TExtractionWizardPage wizard page and ExtractArchive
ExtractingLabel=正在解压缩文件...
ButtonStopExtraction=停止解压缩 (&S)
StopExtraction=您确定要停止解压缩吗？
ErrorExtractionAborted=解压缩已中止。
ErrorExtractionFailed=解压缩失败：%1

; *** Archive extraction failure details
ArchiveIncorrectPassword=压缩文件密码不正确。
ArchiveIsCorrupted=压缩文件已损毁。
ArchiveUnsupportedFormat=不支持的压缩文件格式。

; *** "Preparing to Install" wizard page
WizardPreparing=准备安装程序
PreparingDesc=安装程序准备将 [name] 安装到您的电脑上。
PreviousInstallNotCompleted=先前的安装／卸载尚未完成，您必须重新启动电脑以完成该安装。%n%n在重新启动电脑之后，请再次运行安装程序以完成 [name] 的安装。
CannotContinue=安装程序无法继续。请按 「取消」 离开。
ApplicationsFound=下面的应用程序正在使用安装程序所需要更新的文件。建议您允许安装程序自动关闭这些应用程序。
ApplicationsFound2=下面的应用程序正在使用安装程序所需要更新的文件。建议您允许安装程序自动关闭这些应用程序。当安装过程结束后，安装程序将会尝试重新启动这些应用程序。
CloseApplications=自动关闭应用程序 (&A)
DontCloseApplications=不要关闭应用程序 (&D)
ErrorCloseApplications=安装程序无法自动关闭所有应用程序。建议您在继续前先关闭所有正在使用安装程序所需更新文件的应用程序。
PrepareToInstallNeedsRestart=安装程序必须重新启动您的电脑。重新启动后，请再次运行安装程序以完成 [name] 的安装。%n%n您想要现在重新启动电脑吗？

; *** "Installing" wizard page
WizardInstalling=正在安装
InstallingLabel=请稍候，安装程序正在将 [name] 安装到您的电脑上。

; *** "Setup Completed" wizard page
FinishedHeadingLabel=正在完成 [name] 安装程序
FinishedLabelNoIcons=安装程序已经将 [name] 安装在您的电脑上。
FinishedLabel=安装程序已经将 [name] 安装在您的电脑中，您可以选择程序的快捷方式来运行该应用程序。
ClickFinish=按 「完成」 以结束安装程序。
FinishedRestartLabel=要完成 [name] 的安装，安装程序必须重新启动您的电脑。您想要现在重新启动电脑吗？
FinishedRestartMessage=要完成 [name] 的安装，安装程序必须重新启动您的电脑。%n%n您想要现在重新启动电脑吗？
ShowReadmeCheck=是，我要阅读自述文件
YesRadio=是，立即重新启动电脑 (&Y)
NoRadio=否，我稍后重新启动电脑 (&N)
; used for example as 'Run MyProg.exe'
RunEntryExec=运行 %1
; used for example as 'View Readme.txt'
RunEntryShellExec=查看 %1

; *** "Setup Needs the Next Disk" stuff
ChangeDiskTitle=安装程序需要下一张磁盘
SelectDiskLabel2=请插入磁盘 %1，然后按 「确定」。%n%n如果文件不在以下所显示的文件夹之中，请输入正确的路径或按 「浏览」 选中。
PathLabel=路径 (&P)：
FileNotInDir2=文件「%1」无法在「%2」找到。请插入正确的磁盘或选择其他的文件夹。
SelectDirectoryLabel=请指定下一张磁盘的位置。

; *** Installation phase messages
SetupAborted=安装没有完成。%n%n请更正问题后再次运行安装程序。
AbortRetryIgnoreSelectAction=选择操作
AbortRetryIgnoreRetry=重试 (&T)
AbortRetryIgnoreIgnore=跳过错误并继续 (&I)
AbortRetryIgnoreCancel=取消安装
RetryCancelSelectAction=选择操作
RetryCancelRetry=重试 (&T)
RetryCancelCancel=取消

; *** Installation status messages
StatusClosingApplications=正在关闭应用程序...
StatusCreateDirs=正在创建文件夹...
StatusExtractFiles=正在解压缩文件...
StatusDownloadFiles=正在下载文件...
StatusCreateIcons=正在创建快捷方式...
StatusCreateIniEntries=正在创建 INI 项目...
StatusCreateRegistryEntries=正在创建注册表项...
StatusRegisterFiles=正在注册文件...
StatusSavingUninstall=正在保存卸载信息...
StatusRunProgram=正在完成安装...
StatusRestartingApplications=正在重新启动应用程序...
StatusRollback=正在撤销变更...

; *** Misc. errors
ErrorInternal2=内部错误：%1。
ErrorFunctionFailedNoCode=%1 失败。
ErrorFunctionFailed=%1 失败；代码 %2。
ErrorFunctionFailedWithMessage=%1 失败；代码 %2。%n%3
ErrorExecutingProgram=无法运行文件：%n%1

; *** Registry errors
ErrorRegOpenKey=无法打开注册表键：%n%1\%2
ErrorRegCreateKey=无法创建注册表键：%n%1\%2
ErrorRegWriteKey=无法变更注册表键：%n%1\%2

; *** INI errors
ErrorIniEntry=在文件「%1」创建 INI 项目错误。

; *** File copying errors
FileAbortRetryIgnoreSkipNotRecommended=跳过这个文件 (不建议) (&S)
FileAbortRetryIgnoreIgnoreNotRecommended=跳过错误并继续 (不建议) (&I)
SourceDoesntExist=来源文件「%1」不存在。
SourceIsCorrupted=来源文件已经损毁。
SourceVerificationFailed=来源文件验证失败：%1
VerificationSignatureDoesntExist=签名档「%1」不存在。
VerificationSignatureInvalid=签名档「%1」无效。
VerificationKeyNotFound=签名档「%1」使用了未知密钥。
VerificationFileNameIncorrect=文件名称不正确。
VerificationFileTagIncorrect=文件标签不正确。
VerificationFileSizeIncorrect=文件大小不正确。
VerificationFileHashIncorrect=文件哈希值不正确。
ExistingFileReadOnly2=无法替换现有文件，因为文件已标示为只读。
ExistingFileReadOnlyRetry=移除只读属性并重试 (&R)
ExistingFileReadOnlyKeepExisting=保留现有文件 (&K)
ErrorReadingExistingDest=读取现有文件时发生错误：
FileExistsSelectAction=选择操作
FileExists2=文件已存在。
FileExistsOverwriteExisting=覆盖现有文件 (&O)
FileExistsKeepExisting=保留现有文件 (&K)
FileExistsOverwriteOrKeepAll=对下次冲突运行相同操作 (&D)
ExistingFileNewerSelectAction=选择操作
ExistingFileNewer2=现有文件比安装程序尝试安装的文件还新。
ExistingFileNewerOverwriteExisting=覆盖现有文件 (&O)
ExistingFileNewerKeepExisting=保留现有文件 (&K) (建议选项)
ExistingFileNewerOverwriteOrKeepAll=对下次冲突运行相同操作 (&D)
ErrorChangingAttr=在变更现有文件的属性时发生错误：
ErrorCreatingTemp=在目的文件夹中创建文件时发生错误：
ErrorReadingSource=读取来源文件时发生错误：
ErrorCopying=复制文件时发生错误：
ErrorDownloading=下载文件时发生错误：
ErrorExtracting=解压缩压缩文件时发生错误：
ErrorReplacingExistingFile=替换现有文件时发生错误：
ErrorRestartReplace=重新启动电脑后替换文件失败：
ErrorRenamingTemp=在目的文件夹变更文件名称时发生错误：
ErrorRegisterServer=无法注册 DLL/OCX 文件：%1
ErrorRegSvr32Failed=RegSvr32 失败；结束代码 %1。
ErrorRegisterTypeLib=无法注册类型库：%1

; *** Uninstall display name markings
; used for example as 'My Program (32-bit)'
UninstallDisplayNameMark=%1 (%2)
; used for example as 'My Program (32-bit, All users)'
UninstallDisplayNameMarks=%1 (%2, %3)
UninstallDisplayNameMark32Bit=32 位
UninstallDisplayNameMark64Bit=64 位
UninstallDisplayNameMarkAllUsers=所有用户
UninstallDisplayNameMarkCurrentUser=当前用户

; *** Post-installation errors
ErrorOpeningReadme=打开自述文件时发生错误。
ErrorRestartingComputer=安装程序无法重新启动电脑，请自行重新启动。

; *** Uninstaller messages
UninstallNotFound=文件「%1」不存在，无法卸载。
UninstallOpenError=无法打开文件「%1」，无法卸载
UninstallUnsupportedVer=这个版本的卸载程序无法识别卸载日志文件「%1」之格式，无法卸载。
UninstallUnknownEntry=卸载日志文件中发现未知的记录 (%1)。
ConfirmUninstall=您确定要完全移除 %1 及其所有组件吗？
UninstallOnlyOnWin64=这个程序只能在 64 位的 Windows 上卸载。
OnlyAdminCanUninstall=这个程序要具备管理员权限的用户方可卸载。
UninstallStatusLabel=正在从您的电脑移除 %1 中，请稍候。
UninstalledAll=%1 已经成功从您的电脑中移除。
UninstalledMost=%1 卸载完成。%n%n某些项目无法移除，您可以自行移除这些项目。
UninstalledAndNeedsRestart=要完成 %1 的卸载，您必须重新启动电脑。%n%n您想要现在重新启动电脑吗？
UninstallDataCorrupted=文件「%1」已经损毁，无法卸载。

; *** Uninstallation phase messages
ConfirmDeleteSharedFileTitle=移除共享文件
ConfirmDeleteSharedFile2=系统显示下列共享文件已不再被任何程序所使用，您要移除此共享文件吗？%n%n倘若您移除了以上文件但仍有程序需要使用它，可能造成这些程序无法正常运行，因此您若无法确定请选择 「否」。保留此文件在您的系统中不会造成任何损害。
SharedFileNameLabel=文件名称：
SharedFileLocationLabel=位置：
WizardUninstalling=卸载状态
StatusUninstalling=正在卸载 %1...

; *** Shutdown block reasons
ShutdownBlockReasonInstallingApp=正在安装 %1。
ShutdownBlockReasonUninstallingApp=正在卸载 %1。

; The custom messages below aren't used by Setup itself, but if you make
; use of them in your scripts, you'll want to translate them.

[CustomMessages]

NameAndVersion=%1 版本 %2
AdditionalIcons=附加快捷方式：
CreateDesktopIcon=创建桌面快捷方式 (&D)
CreateQuickLaunchIcon=创建快速启动快捷方式 (&Q)
ProgramOnTheWeb=%1 的网站
UninstallProgram=卸载 %1
LaunchProgram=启动 %1
AssocFileExtension=将 %1 与文件扩展名 %2 产生关联 (&A)
AssocingFileExtension=正在将 %1 与文件扩展名 %2 产生关联...
AutoStartProgramGroupDescription=启动：
AutoStartProgram=自动启动 %1
AddonHostProgramNotFound=%1 无法在您所选的文件夹中找到。%n%n您是否还要继续？