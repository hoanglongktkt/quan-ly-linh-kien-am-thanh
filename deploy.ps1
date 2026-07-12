# Deploy: git add → commit → push nhánh hiện tại
# Cách dùng: .\deploy.ps1 "Nội dung commit"
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Message
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Message)) {
  Write-Host 'Thieu message commit.' -ForegroundColor Red
  Write-Host 'Cach dung: .\deploy.ps1 "Noi dung commit"'
  exit 1
}

$branch = git branch --show-current
if ([string]::IsNullOrWhiteSpace($branch)) {
  Write-Host 'Khong xac dinh duoc nhanh git.' -ForegroundColor Red
  exit 1
}

Write-Host 'git add .'
git add .

$null = git diff --cached --quiet 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Khong co thay doi de commit.'
  exit 0
}

Write-Host "git commit -m `"$Message`""
git commit -m $Message

Write-Host "git push origin $branch"
git push origin $branch

Write-Host "Da push len origin/$branch" -ForegroundColor Green
