#ifndef MyAppVersion
  #define MyAppVersion "0.7.1"
#endif
#define MyAppName "Reposit+"
#define MyAppExeName "RepositPlus.exe"
#define MyAppPublisher "Reposit+ Project"
#define PortableSource "..\..\out\RepositPlus-v" + MyAppVersion + "-Portable.exe"

[Setup]
AppId={{A4BF7D91-4C2E-47B0-A312-E171860F46EF}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\RepositPlus\App
UsePreviousAppDir=yes
CreateUninstallRegKey=yes
Uninstallable=yes
SetupLogging=yes
DefaultGroupName=Reposit+
DisableProgramGroupPage=yes
OutputDir=..\..\out
OutputBaseFilename=RepositPlus-v{#MyAppVersion}-Setup
SetupIconFile=..\assets\RepositPlus.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
LicenseFile=LICENSE.txt
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
CloseApplicationsFilter=RepositPlus.exe,RepositPlus-v*-Portable.exe
RestartApplications=no
AppMutex=RepositPlusDesktopApp
VersionInfoVersion={#MyAppVersion}.0
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=Instalador do Reposit+

[Languages]
Name: "brazilianportuguese"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Files]
; One self-contained application binary. No external runtime is installed.
Source: "{#PortableSource}"; DestDir: "{app}"; DestName: "{#MyAppExeName}"; Flags: ignoreversion

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; GroupDescription: "Atalhos adicionais:"; Flags: unchecked

[Icons]
Name: "{autoprograms}\Reposit+"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\Reposit+"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Classes\.reposit"; ValueType: string; ValueName: ""; ValueData: "RepositPlus.Backup"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\RepositPlus.Backup"; ValueType: string; ValueName: ""; ValueData: "Backup do Reposit+"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\RepositPlus.Backup\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"
Root: HKCU; Subkey: "Software\Classes\RepositPlus.Backup\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

[UninstallDelete]
Type: files; Name: "{app}\installed.flag"
Type: dirifempty; Name: "{app}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Abrir Reposit+"; Flags: nowait postinstall skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    SaveStringToFile(ExpandConstant('{app}\installed.flag'), 'installed', False);
end;
