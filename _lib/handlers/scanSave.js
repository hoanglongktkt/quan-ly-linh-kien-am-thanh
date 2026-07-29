/**
 * Vercel — POST /api/scan/save & GET /api/scan/don-hoan-huy
 * Gọi thẳng MVC controller (Mongo Atlas).
 */
export async function handleScanSave(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  try {
    const { connectDB, isDBReady } = await import('../../config/db.js');
    const { saveScanOrders } = await import('../../controllers/scanController.js');
    if (!isDBReady()) await connectDB();
    return saveScanOrders(req, res);
  } catch (err) {
    console.error('[Vercel scan/save]', err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: err?.message || 'Không lưu được đơn quét.',
      });
    }
  }
}

export async function handleScanDonHoanHuy(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }
  try {
    const { connectDB, isDBReady } = await import('../../config/db.js');
    const { listDonHoanHuy } = await import('../../controllers/scanController.js');
    if (!isDBReady()) await connectDB();
    return listDonHoanHuy(req, res);
  } catch (err) {
    console.error('[Vercel scan/don-hoan-huy]', err);
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        message: err?.message || 'Không lấy được danh sách đơn hoàn hủy.',
        data: [],
      });
    }
  }
}
