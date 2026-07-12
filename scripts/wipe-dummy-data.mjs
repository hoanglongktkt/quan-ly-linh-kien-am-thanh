#!/usr/bin/env node
/**
 * Xóa sạch dữ liệu ảo (products, orders, bảng liên quan) trên backend cPanel.
 * Database = file JSON trong thư mục data/ (KHÔNG dùng SQL/MongoDB).
 *
 * Chạy trên cPanel (SSH hoặc Terminal):
 *   cd ~/quanly.linhkienamthanh.net && node scripts/wipe-dummy-data.mjs
 *
 * Hoặc local:
 *   npm run wipe:dummy-data
 */
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');

/** File cần wipe — items/variants/images nằm trong orders.json & products.json */
const WIPE_FILES = [
  'products.json',
  'orders.json',
  'imports.json',
  'multi_channel_listings.json',
  'product_listings.json',
  'suppliers.json',
  'expenses.json',
];

/** Giữ lại token OAuth Shopee thật */
const PRESERVE_FILES = new Set(['shopee_tokens.json']);

const MARKERS_TO_REMOVE = ['.expenses-cleared-v2'];

const withBackup = process.argv.includes('--backup');

function wipeFile(filename) {
  if (PRESERVE_FILES.has(filename)) {
    console.log(`⏭  Bỏ qua (giữ nguyên): ${filename}`);
    return { file: filename, skipped: true };
  }

  const filePath = path.join(DATA_DIR, filename);
  fs.mkdirSync(DATA_DIR, { recursive: true });

  let previousCount = 0;
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      const parsed = raw ? JSON.parse(raw) : [];
      previousCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      previousCount = -1;
    }

    if (withBackup) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = `${filePath}.bak-${stamp}`;
      fs.copyFileSync(filePath, backupPath);
      console.log(`📦 Backup: ${path.basename(backupPath)}`);
    }
  }

  fs.writeFileSync(filePath, '[]\n', 'utf8');
  console.log(`✅ Đã xóa: ${filename} (trước đó: ${previousCount >= 0 ? previousCount : '?'} bản ghi)`);
  return { file: filename, previousCount, wiped: true };
}

console.log('=== WIPE DUMMY DATA ===');
console.log('Thư mục:', DATA_DIR);
console.log('');

const results = WIPE_FILES.map(wipeFile);

for (const marker of MARKERS_TO_REMOVE) {
  const markerPath = path.join(DATA_DIR, marker);
  if (fs.existsSync(markerPath)) {
    fs.unlinkSync(markerPath);
    console.log(`🗑  Đã xóa marker: ${marker}`);
  }
}

console.log('');
console.log('=== HOÀN TẤT ===');
console.log('ID: Hệ thống dùng chuỗi (prod-..., shopee-...) — không có AUTO_INCREMENT SQL.');
console.log('     Sau khi wipe, sản phẩm/đơn mới sẽ có ID mới tự sinh.');
console.log('');
console.log('⚠️  Trên trình duyệt, mở Console (F12) và chạy:');
console.log("     ['omni_products','omni_orders','omni_logs','omni_channel_listings'].forEach(k=>localStorage.removeItem(k));location.reload();");
console.log('');
console.log(JSON.stringify({ ok: true, results }, null, 2));
