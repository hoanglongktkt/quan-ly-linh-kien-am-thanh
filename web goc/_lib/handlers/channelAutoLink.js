/**
 * Liên kết tự động theo SKU — proxy thẳng sang cPanel.
 * Backend tự đọc Database (không cần body.listings) — tránh lỗi "Thiếu mảng listings".
 */
import { proxyRequestToCpanel, resolveProxyTimeoutMs } from '../cpanelProxy.js';

export async function handleChannelAutoLink(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method Not Allowed' });
  }

  try {
    // Đảm bảo body không vô tình làm router nghĩ đây là PUT mapping-products.
    // Endpoint đích tự query channel_listings.json + products.json.
    const timeoutMs = resolveProxyTimeoutMs('shopee/channel-products/auto-link');
    return proxyRequestToCpanel(req, res, 'shopee/channel-products/auto-link', { timeoutMs });
  } catch (err) {
    console.error('[AutoLink]', err);
    return res.status(500).json({
      success: false,
      message: err?.message || 'Liên kết tự động thất bại',
      details: String(err),
    });
  }
}
