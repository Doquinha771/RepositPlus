@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
set "MODE=%~1"
if "%MODE%"=="" set "MODE=All"
if /I "%MODE%"=="portable" set "MODE=Portable"
if /I "%MODE%"=="setup" set "MODE=Setup"
if /I "%MODE%"=="all" set "MODE=All"

echo [Reposit+] Build %MODE%
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build\build_windows.ps1" -Mode "%MODE%"
if errorlevel 1 (
  echo.
  echo A build falhou. A janela vai ficar aberta para voce ler o erro.
  pause
  exit /b 1
)
exit /b 0
