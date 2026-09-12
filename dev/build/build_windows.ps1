param(
    [ValidateSet("Portable", "Setup", "All")]
    [string]$Mode = "All"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Dev = Join-Path $Root "dev"
$BuildRoot = Join-Path $Dev ".build"
$Dist = Join-Path $BuildRoot "dist"
$Work = Join-Path $BuildRoot "work"
$Out = Join-Path $Dev "out"
Set-Location $Root

function Step([string]$Text) { Write-Host "`n[Reposit+] $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { throw $Text }
function Size-MB([string]$Path) {
    if (-not (Test-Path $Path)) { return 0 }
    return [math]::Round(((Get-Item $Path).Length / 1MB), 1)
}
function Find-Python {
    $venv = Join-Path $Dev ".venv-build\Scripts\python.exe"
    if (Test-Path $venv) { return $venv }
    Step "Criando ambiente isolado de desenvolvimento"
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        & $launcher.Source -3.12 -m venv (Join-Path $Dev ".venv-build")
        if ($LASTEXITCODE -ne 0) { & $launcher.Source -3 -m venv (Join-Path $Dev ".venv-build") }
    } else {
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $python) { Fail "Python 3.12+ é necessário SOMENTE para gerar builds no PC do desenvolvedor." }
        & $python.Source -m venv (Join-Path $Dev ".venv-build")
    }
    if (-not (Test-Path $venv)) { Fail "Não foi possível criar dev\.venv-build." }
    return $venv
}
function Find-Iscc {
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($candidate in @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LocalAppData\Programs\Inno Setup 6\ISCC.exe"
    )) { if ($candidate -and (Test-Path $candidate)) { return $candidate } }
    return $null
}
function Read-Version {
    $config = Get-Content (Join-Path $Root "reposit\backend\config.py") -Raw
    $match = [regex]::Match($config, 'APP_VERSION\s*=\s*"([^"]+)"')
    if (-not $match.Success) { Fail "APP_VERSION não encontrado em reposit\backend\config.py." }
    return $match.Groups[1].Value
}
function Write-VersionInfo([string]$Version) {
    $parts = @($Version.Split('.') | ForEach-Object { [int]$_ })
    while ($parts.Count -lt 4) { $parts += 0 }
    $v = "$($parts[0]), $($parts[1]), $($parts[2]), $($parts[3])"
    $text = @"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=($v), prodvers=($v), mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Reposit+ Project'),
      StringStruct('FileDescription', 'Reposit+ - workspace local-first para estudantes'),
      StringStruct('FileVersion', '$Version'),
      StringStruct('InternalName', 'RepositPlus'),
      StringStruct('OriginalFilename', 'RepositPlus.exe'),
      StringStruct('ProductName', 'Reposit+'),
      StringStruct('ProductVersion', '$Version')
    ])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@
    New-Item -ItemType Directory -Force -Path $BuildRoot | Out-Null
    Set-Content (Join-Path $BuildRoot "version_info.txt") $text -Encoding ASCII
}

try {
    $Version = Read-Version
    $PortableExe = Join-Path $Out "RepositPlus-v$Version-Portable.exe"
    $SetupExe = Join-Path $Out "RepositPlus-v$Version-Setup.exe"

    Remove-Item $BuildRoot -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $BuildRoot, $Dist, $Work, $Out | Out-Null
    Remove-Item (Join-Path $Out "*") -Force -ErrorAction SilentlyContinue
    Write-VersionInfo $Version

    $Python = Find-Python
    Step "Instalando dependências de build (somente no ambiente dev)"
    & $Python -m pip install --disable-pip-version-check -r (Join-Path $Dev "requirements-build.txt")
    if ($LASTEXITCODE -ne 0) { Fail "pip falhou com código $LASTEXITCODE." }

    Step "Validando dependências do runtime Windows"
    & $Python -m pip check
    if ($LASTEXITCODE -ne 0) { Fail "Há dependências Python inconsistentes no ambiente de build." }
    & $Python -c "import fastapi, uvicorn, webview, keyboard, clr; import webview.platforms.winforms, webview.platforms.edgechromium; print('Runtime Windows OK')"
    if ($LASTEXITCODE -ne 0) { Fail "O runtime Windows/pywebview não pôde ser importado antes da build." }

    Step "Validando ícones nativos do Windows"
    Write-Host "[Reposit+] Segoe Fluent Icons / Segoe MDL2 Assets: nenhum download necessário."

    # Extrair um ZIP por cima de uma árvore antiga não remove arquivos que deixaram
    # de existir na versão nova. Limpamos somente artefatos de código/build obsoletos
    # dentro do repositório; dados do usuário em AppData nunca são tocados aqui.
    Step "Limpando artefatos legados de versões anteriores"
    $LegacyPaths = @(
        (Join-Path $Root "reposit\frontend\assets\icons8"),
        (Join-Path $Root "dev\vendor_icons8.py"),
        (Join-Path $Root "reposit\backend\email_service.py"),
        (Join-Path $Root "reposit\backend\p2p.py"),
        (Join-Path $Root "reposit\backend\discovery.py"),
        (Join-Path $Root "dev\tests\test_email_service.py")
    )
    foreach ($legacy in $LegacyPaths) {
        if (Test-Path $legacy) {
            Remove-Item $legacy -Recurse -Force -ErrorAction Stop
            Write-Host "[Reposit+] Removido legado: $legacy" -ForegroundColor DarkGray
        }
    }

    # Evita que bytecode/cache antigo confunda testes ou empacotamento ao reutilizar
    # a mesma pasta de desenvolvimento entre versões.
    Get-ChildItem $Root -Directory -Filter "__pycache__" -Recurse -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Root ".pytest_cache") -Recurse -Force -ErrorAction SilentlyContinue

    Step "Rodando testes"
    & $Python -m pytest -q (Join-Path $Dev "tests")
    if ($LASTEXITCODE -ne 0) { Fail "Os testes falharam. Build cancelada." }

    Step "Gerando executável standalone ONEFILE"
    $args = @('-m','PyInstaller','--noconfirm','--clean','--distpath',$Dist,'--workpath',$Work)
    $upx = Get-Command upx.exe -ErrorAction SilentlyContinue
    if ($upx) {
        $args += @('--upx-dir',(Split-Path $upx.Source -Parent))
        Write-Host "[Reposit+] UPX ativo."
    } else {
        Write-Host "[Reposit+] UPX não encontrado; a build continua, só pode ficar alguns MB maior." -ForegroundColor DarkYellow
    }
    $args += (Join-Path $Dev "build\RepositPlus.spec")
    & $Python @args
    if ($LASTEXITCODE -ne 0) { Fail "PyInstaller falhou com código $LASTEXITCODE." }

    $BuiltExe = Join-Path $Dist "RepositPlus.exe"
    if (-not (Test-Path $BuiltExe)) { Fail "PyInstaller não gerou RepositPlus.exe." }

    Step "Testando o executável empacotado"
    & $BuiltExe --self-test
    if ($LASTEXITCODE -ne 0) { Fail "O executável standalone falhou no self-test (código $LASTEXITCODE)." }

    Copy-Item $BuiltExe $PortableExe -Force

    if ($Mode -in @('Setup','All')) {
        Step "Gerando Setup real (sem Python no PC de destino)"
        $Iscc = Find-Iscc
        if (-not $Iscc) { Fail "Inno Setup 6 não encontrado. Ele só é necessário na máquina do desenvolvedor." }
        $InstallerScript = Join-Path $Dev "build\installer\RepositPlus.iss"
        $InstallerLicense = Join-Path $Dev "build\installer\LICENSE.txt"
        if (-not (Test-Path $InstallerScript)) { Fail "Script do Inno Setup não encontrado: $InstallerScript" }
        if (-not (Test-Path $InstallerLicense)) { Fail "Licença do instalador não encontrada: $InstallerLicense" }
        & $Iscc "/DMyAppVersion=$Version" $InstallerScript
        if ($LASTEXITCODE -ne 0) { Fail "Inno Setup falhou com código $LASTEXITCODE." }
        if (-not (Test-Path $SetupExe)) { Fail "Setup esperado não foi gerado: $SetupExe" }
    }

    if ($Mode -eq 'Setup') { Remove-Item $PortableExe -Force }
    if ($Mode -eq 'Portable') { Remove-Item $SetupExe -Force -ErrorAction SilentlyContinue }

    Step "Gerando SHA-256"
    $files = Get-ChildItem $Out -File -Filter '*.exe' | Sort-Object Name
    $hashLines = foreach ($file in $files) {
        "$((Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($file.Name)"
    }
    $hashLines | Set-Content (Join-Path $Out 'SHA256SUMS.txt') -Encoding ASCII

    Write-Host "`n[Reposit+] Build concluída. O usuário final recebe somente:" -ForegroundColor Green
    Get-ChildItem $Out -File | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}} | Format-Table -AutoSize
    if (Test-Path $PortableExe) {
        $mb = Size-MB $PortableExe
        if ($mb -gt 55) { Write-Host "[AVISO] Portable acima da meta de ~50 MB: $mb MB." -ForegroundColor Yellow }
    }
    exit 0
}
catch {
    Write-Host "`n[ERRO DE BUILD] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Detalhes: $($_.ScriptStackTrace)" -ForegroundColor DarkGray
    exit 1
}
