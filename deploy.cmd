@echo off
setlocal
if "%~1"=="" (
  echo ❌ Thiếu message commit.
  echo    Cách dùng: deploy.cmd "Nội dung commit"
  exit /b 1
)

cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1" %*
