# Đóng gói deploy cPanel — chạy trên Windows (PowerShell)
# Tạo cpanel-deploy.zip với frontend MỚI + server.cjs, xóa file assets cũ trong zip

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$buildId = (Get-Date -Format "yyyyMMdd-HHmmss")
$env:VITE_BUILD_ID = $buildId

Write-Host "==> Build ID: $buildId"
Write-Host "==> npm run build (local compile → dist/server.cjs + root server.cjs)"
npm run build

$staging = Join-Path $root "cpanel-deploy-staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$staging\dist", "$staging\assets", "$staging\data" -Force | Out-Null

Copy-Item -Recurse -Force "dist\*" "$staging\dist\"
Copy-Item -Force "dist\server.cjs" "$staging\server.cjs"
Copy-Item -Recurse -Force "dist\assets\*" "$staging\assets\"
Copy-Item -Force ".htaccess" "$staging\.htaccess"
# MongoDB Atlas — không đóng gói DB file; cấu hình MONGODB_URI trên cPanel
New-Item -ItemType Directory -Path "$staging\data" -Force | Out-Null
"KHONG ghi de shopee_tokens.json tren server " | Set-Content -Path "$staging\data\.gitkeep" -Encoding UTF8

@"
DEPLOY cPanel — Build Local, Deploy JS — $buildId
================================
1) Build LOCAL: npm run build
   → dist/server.cjs (Node backend đã biên dịch)
   → dist/index.html + dist/assets/* (frontend)
   → server.cjs (bản copy ở root cho Passenger)

2) Application startup file trên cPanel:
   → server.cjs
   (KHÔNG dùng tsx / server.ts)

3) Trên hosting chỉ cần: npm install --omit=dev
   (không cài esbuild/tsx/vite — tránh SIGABRT)

4) Restart Node.js App trên cPanel.
"@ | Set-Content -Path "$staging\HUONG-DAN-DEPLOY.txt" -Encoding UTF8

$zip = Join-Path $root "cpanel-deploy.zip"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path "$staging\*" -DestinationPath $zip -Force
Remove-Item $staging -Recurse -Force

$html = Get-Content "dist\index.html" -Raw
Write-Host ""
Write-Host "==> Xong: $zip"
Write-Host "==> index.html tham chieu:"
Write-Host $html
