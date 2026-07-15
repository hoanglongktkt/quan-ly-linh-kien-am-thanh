# Đóng gói deploy cPanel — chạy trên Windows (PowerShell)
# Tạo cpanel-deploy.zip với frontend MỚI + server.cjs, xóa file assets cũ trong zip

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$buildId = (Get-Date -Format "yyyyMMdd-HHmmss")
$env:VITE_BUILD_ID = $buildId

Write-Host "==> Build ID: $buildId"
Write-Host "==> npm run build:cpanel"
npm run build:cpanel

Copy-Item -Force "dist\server.cjs" "server.cjs"

$staging = Join-Path $root "cpanel-deploy-staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$staging\dist", "$staging\assets", "$staging\data" -Force | Out-Null

Copy-Item -Recurse -Force "dist\*" "$staging\dist\"
Copy-Item -Force "dist\server.cjs" "$staging\server.cjs"
Copy-Item -Recurse -Force "dist\assets\*" "$staging\assets\"
Copy-Item -Force ".htaccess" "$staging\.htaccess"
# Local Cache Master — luôn kèm file local_inventory.json khi deploy
New-Item -ItemType Directory -Path "$staging\data" -Force | Out-Null
if (Test-Path "data\local_inventory.json") {
  Copy-Item -Force "data\local_inventory.json" "$staging\data\local_inventory.json"
} else {
  node scripts/init-local-inventory.mjs
  Copy-Item -Force "data\local_inventory.json" "$staging\data\local_inventory.json"
}
"KHONG ghi de shopee_tokens.json tren server " | Set-Content -Path "$staging\data\.gitkeep" -Encoding UTF8

@"
DEPLOY cPanel — Build $buildId
================================
TRƯỚC KHI GIẢI NÉN trên hosting, XÓA các file JS/CSS cũ trong:
  /home/yrkrhmtl/quanly.linhkienamthanh.net/assets/

Sau đó giải nén zip vào thư mục quanly.linhkienamthanh.net (Ghi đè).
Restart Node.js App trên cPanel.

LƯU Ý: Domain quanly.linhkienamthanh.net hiện trỏ Vercel (frontend).
Upload cPanel KHÔNG đổi giao diện trên domain đó.
Để cập nhật UI trên domain: git push → Vercel Redeploy.
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
