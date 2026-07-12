# Deploy lên Vercel qua GitHub: add → commit → push nhánh hiện tại.
# Cách dùng: .\deploy.ps1 "Nội dung commit"
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Message
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Message)) {
  Write-Host '❌ Thiếu message commit.' -ForegroundColor Red
  Write-Host '   Cách dùng: .\deploy.ps1 "Nội dung commit"'
  exit 1
}

if (-not (Test-Path .git)) {
  Write-Host '❌ Không phải thư mục git.' -ForegroundColor Red
  exit 1
}

$branch = git branch --show-current 2>$null
if ([string]::IsNullOrWhiteSpace($branch)) {
  Write-Host '❌ Không xác định được nhánh (detached HEAD?).' -ForegroundColor Red
  exit 1
}

if ((Test-Path .env) -and -not (git check-ignore -q .env 2>$null; $?)) {
  Write-Host '❌ File .env không nằm trong .gitignore — dừng để tránh lộ secret.' -ForegroundColor Red
  exit 1
}

Write-Host '📦 git add .'
git add .

$staged = git diff --cached --quiet 2>$null; $hasChanges = -not $?
if (-not $hasChanges) {
  Write-Host '⚠️  Không có thay đổi để commit. Bỏ qua commit/push.'
  exit 0
}

Write-Host "📝 git commit -m `"$Message`""
git commit -m $Message

Write-Host "🚀 git push origin $branch"
git push origin $branch

Write-Host "✅ Đã push lên origin/$branch — Vercel sẽ tự deploy nếu repo đã liên kết." -ForegroundColor Green
