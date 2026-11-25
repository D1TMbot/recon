; Recon installer (Inno Setup 6). Built by scripts\release.ps1:
;   ISCC /DAppVersion=1.2.0 /DSourceDir=<staged app> /DOutDir=<dist> scripts\recon.iss
; Installs per user (no admin), bundles Node.js in {app}\runtime, adds Start
; menu / desktop shortcuts and a normal uninstaller. User data stays in
; %APPDATA%\Recon and is kept on uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{A7659965-C90D-4F69-B80E-C1AE4CFDB2A7}
AppName=Recon
AppVersion={#AppVersion}
AppVerName=Recon {#AppVersion}
AppPublisher=Recon
AppPublisherURL=https://github.com/D1TMbot/recon
AppSupportURL=https://github.com/D1TMbot/recon
DefaultDirName={localappdata}\Programs\Recon
DefaultGroupName=Recon
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=Recon-Setup
SetupIconFile={#SourceDir}\recon-logo.ico
UninstallDisplayIcon={app}\recon-logo.ico
UninstallDisplayName=Recon
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "setup.ps1,Install Recon.cmd,Start Recon.cmd"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{autoprograms}\Recon"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -Command ""Set-Location -LiteralPath '{app}'; & '{app}\runtime\node.exe' server\index.js --open"""; WorkingDir: "{app}"; IconFilename: "{app}\recon-logo.ico"; Comment: "Recon - Rust companion"; Flags: runminimized
Name: "{autodesktop}\Recon"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -Command ""Set-Location -LiteralPath '{app}'; & '{app}\runtime\node.exe' server\index.js --open"""; WorkingDir: "{app}"; IconFilename: "{app}\recon-logo.ico"; Comment: "Recon - Rust companion"; Flags: runminimized; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Add a Recon shortcut to the desktop"; GroupDescription: "Shortcuts:"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -Command ""Set-Location -LiteralPath '{app}'; & '{app}\runtime\node.exe' server\index.js --open"""; WorkingDir: "{app}"; Description: "Open Recon now"; Flags: postinstall nowait skipifsilent runhidden

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -Command ""Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq '{app}\runtime\node.exe' }} | Stop-Process -Force"""; Flags: runhidden; RunOnceId: "StopRecon"

[Code]
// Close a running Recon before installing over it, so its files can be replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ''*\Programs\Recon\runtime\node.exe'' } | Stop-Process -Force"',
    '', SW_HIDE, ewWaitUntilTerminated, Code);
  Result := '';
end;
