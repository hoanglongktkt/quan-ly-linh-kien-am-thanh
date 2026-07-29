/**
 * Vercel — POST /api/scan/save & GET /api/scan/don-hoan-huy
 *
 * Ưu tiên proxy sang cPanel (có MONGODB_URI).
 * Fallback: nối Mongo trực tiếp nếu Vercel đã set MONGODB_URI / MONGO_URL.
 */
import { proxyRequestToCpanel } from '../cpanelProxy.js';

function hasMongoUri() {
  return Boolean(
    String(
      process.env.MONGODB_URI ||
        process.env.MONGO_URL ||
        process.env.MONGO_URI ||
        '',
    ).trim(),
  );
}

async function tryLocalController(handlerName, req, res) {
  const { connectDB, isDBReady, getMongoUri } = await import('../../config/db.js');
  if (!getMongoUri()) {
    throw new Error('Thiếu MONGODB_URI / MONGO_URL trong biến môi trường.');
  }
  if (!isDBReady()) {
    await connectDB();
  }
  const ctrl = await import('../../controllers/scanController.js');
  return ctrl[handlerName](req, res);
}

export async function handleScanSave(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    // Vercel mặc định proxy → cPanel (nơi đã cấu hình Mongo).
    if (process.env.VERCEL || !hasMongoUri()) {
      return proxyRequestToCpanel(req, res, 'scan/save', { timeoutMs: 60_000 });
    }
    return await tryLocalController('saveScanOrders', req, res);
  } catch (err) {
    console.error('[Vercel scan/save]', err);
    // Proxy / local fail — thử hướng còn lại một lần.
    try {
      if (hasMongoUri()) {
        return await tryLocalController('saveScanOrders', req, res);
      }
      return proxyRequestToCpanel(req, res, 'scan/save', { timeoutMs: 60_000 });
    } catch (err2) {
      console.error('[Vercel scan/save] fallback failed:', err2);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            err2?.message ||
            err?.message ||
            'Không lưu được đơn quét. Kiểm tra MONGODB_URI trên Vercel hoặc cPanel backend.',
        });
      }
    }
  }
}

export async function handleScanDonHoanHuy(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    if (process.env.VERCEL || !hasMongoUri()) {
      return proxyRequestToCpanel(req, res, 'scan/don-hoan-huy', {
        timeoutMs: 30_000,
      });
    }
    return await tryLocalController('listDonHoanHuy', req, res);
  } catch (err) {
    console.error('[Vercel scan/don-hoan-huy]', err);
    try {
      if (hasMongoUri()) {
        return await tryLocalController('listDonHoanHuy', req, res);
      }
      return proxyRequestToCpanel(req, res, 'scan/don-hoan-huy', {
        timeoutMs: 30_000,
      });
    } catch (err2) {
      console.error('[Vercel scan/don-hoan-huy] fallback failed:', err2);
      if (!res.headersSent) {
        return res.status(500).json({
          success: false,
          message:
            err2?.message ||
            err?.message ||
            'Không lấy được danh sách đơn hoàn hủy.',
          data: [],
        });
      }
    }
  }
}
