#!/usr/bin/env node
/**
 * Kiểm tra kết nối Shopee API — chạy trên máy local (đọc .env) hoặc qua Vercel proxy.
 *
 * Local backend (.env trên cPanel clone):
 *   node scripts/test-shopee-connection.mjs
 *   node scripts/test-shopee-connection.mjs --shop-id 4127421
 *
 * Qua Vercel → cPanel proxy (cần JWT đăng nhập):
 *   node scripts/test-shopee-connection.mjs --via https://quanly.linhkienamthanh.net --token YOUR_JWT
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function parseArgs(argv) {
  const out = { shopId: '', via: '', token: '' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shop-id' && argv[i + 1]) out.shopId = argv[++i];
    else if (a === '--via' && argv[i + 1]) out.via = argv[++i].replace(/\/$/, '');
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i];
  }
  return out;
}

function log(title, msg, extra) {
  console.log(`\n[${title}] ${msg}`);
  if (extra !== undefined) console.log(typeof extra === 'string' ? extra : JSON.stringify(extra, null, 2));
}

function isPartnerConfigValid(partnerId, partnerKey) {
  return /^\d+$/.test(String(partnerId || '')) && String(partnerKey || '').length > 0 && !/CHUA_CO|YOUR_LIVE/i.test(partnerKey);
}

function shopeeSign(partnerId, partnerKey, apiPath, timestamp, accessToken, shopId) {
  const base = accessToken && shopId
    ? `${partnerId}${apiPath}${timestamp}${accessToken}${shopId}`
    : `${partnerId}${apiPath}${timestamp}`;
  return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
}

function loadTokens() {
  const p = path.join(root, 'data', 'shopee_tokens.json');
  if (!fs.existsSync(p)) return { path: p, tokens: {} };
  try {
    return { path: p, tokens: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch {
    return { path: p, tokens: {} };
  }
}

async function testViaRemote(baseUrl, token, shopId) {
  log('MODE', `Gọi remote ${baseUrl}/api/shopee/diagnostics qua Vercel/proxy`);
  if (!token) {
    log('LOI', 'Thiếu --token (JWT admin sau khi đăng nhập). Không thể gọi API bảo vệ.');
    process.exit(1);
  }
  const qs = shopId ? `?shop_id=${encodeURIComponent(shopId)}` : '';
  const url = `${baseUrl}/api/shopee/diagnostics${qs}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      log('LOI', 'Sai URL / proxy — server trả HTML thay vì JSON', text.slice(0, 300));
      log('GOI_Y', 'Kiểm tra CPANEL_BACKEND_URL trên Vercel trỏ subdomain cPanel (không loop domain Vercel).');
      process.exit(1);
    }
    log('HTTP', `${res.status}`, json);
    if (!json.success) process.exit(1);
    log('KET_QUA', 'Kết nối Shopee OK qua backend remote.');
    return;
  } catch (err) {
    if (err.name === 'AbortError') log('LOI', 'TIMEOUT — không nhận phản hồi từ backend trong 15s');
    else log('LOI', 'NETWORK_ERROR', err.message);
    process.exit(1);
  }
}

async function testLocal(shopIdArg) {
  loadDotEnv();
  const SHOPEE_HOST = 'https://partner.shopeemobile.com';
  const partnerId = process.env.SHOPEE_PARTNER_ID || '';
  const partnerKey = process.env.SHOPEE_PARTNER_KEY || '';

  log('BUOC_1', 'Kiểm tra biến môi trường Partner (file .env local hoặc cPanel)');
  console.log({
    SHOPEE_ENV: process.env.SHOPEE_ENV || 'live',
    SHOPEE_HOST,
    SHOPEE_PARTNER_ID: partnerId || '(RONG)',
    SHOPEE_PARTNER_KEY: partnerKey ? `${partnerKey.slice(0, 4)}…` : '(RONG)',
    SHOP_ID: shopIdArg || '(tu shopee_tokens.json)',
  });

  if (!isPartnerConfigValid(partnerId, partnerKey)) {
    log('LOI', 'MISSING_PARTNER_CONFIG — Sai/thiếu SHOPEE_PARTNER_ID hoặc SHOPEE_PARTNER_KEY');
    log('GOI_Y', 'Cấu hình trên cPanel (.env hoặc Setup Node.js App → Environment), KHÔNG chỉ Vercel.');
    process.exit(1);
  }
  log('OK', 'Partner config hợp lệ');

  const { path: tokensPath, tokens } = loadTokens();
  const shopIds = Object.keys(tokens);
  log('BUOC_2', `Token OAuth trong ${tokensPath}`, { shopIds });

  if (shopIds.length === 0) {
    log('LOI', 'MISSING_OAUTH_TOKEN — Chưa OAuth shop. Vào Cài đặt → kết nối Shopee lại.');
    process.exit(1);
  }

  const shopId = shopIdArg || shopIds[0];
  const record = tokens[shopId];
  if (!record?.access_token) {
    log('LOI', `INVALID_TOKEN — Không có token cho shop_id=${shopId}`);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = now - record.obtained_at >= record.expire_in - 60;
  log('BUOC_3', `Token shop_id=${shopId}`, {
    expired,
    obtained_at: record.obtained_at,
    expire_in: record.expire_in,
  });

  let accessToken = record.access_token;
  if (expired) {
    log('CANH_BAO', 'Token có thể hết hạn — script không refresh; backend sẽ tự refresh khi chạy server.');
  }

  log('BUOC_4', `Ping Shopee API (${SHOPEE_HOST})…`);
  const apiPath = '/api/v2/shop/get_shop_info';
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(partnerId, partnerKey, apiPath, timestamp, accessToken, shopId);
  const url = `${SHOPEE_HOST}${apiPath}?partner_id=${partnerId}&timestamp=${timestamp}&access_token=${accessToken}&shop_id=${shopId}&sign=${sign}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    const json = await res.json();
    console.log('Shopee response:', JSON.stringify(json, null, 2));

    if (json.error) {
      const e = String(json.error).toLowerCase();
      if (/invalid.*token|error_auth/.test(e)) log('LOI', 'INVALID_TOKEN — Token hết hạn hoặc sai. OAuth lại shop.');
      else if (/error_param|sign/.test(e)) log('LOI', 'MISSING_PARTNER_CONFIG — Sai Partner ID/Key hoặc chữ ký');
      else log('LOI', `SHOPEE_API_ERROR — ${json.error}: ${json.message || ''}`);
      process.exit(1);
    }

    log('KET_QUA', 'OK — Kết nối Shopee Live API thành công.');
  } catch (err) {
    if (err.name === 'AbortError') log('LOI', 'TIMEOUT — Shopee không phản hồi trong 12 giây');
    else log('LOI', 'NETWORK_ERROR', err.message);
    process.exit(1);
  }
}

const args = parseArgs(process.argv);
if (args.via) {
  await testViaRemote(args.via, args.token, args.shopId);
} else {
  await testLocal(args.shopId);
}
