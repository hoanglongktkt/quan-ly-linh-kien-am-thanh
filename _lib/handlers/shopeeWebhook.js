import { logShopeeRequest, respondShopeeOk } from '../shopeeCallbackUtil.js';

const LOG = '[Shopee Webhook]';

/**
 * Edge/Vercel stub — chỉ ACK 200.
 * Xử lý get_order_detail + UPSERT chạy trên backend Node: POST /api/webhook/shopee
 * (hoặc legacy /api/shopee/webhook). Cấu hình Push URL trỏ về server.cjs/cPanel.
 */
export async function handleShopeeWebhook(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS' || req.method === 'GET') {
    if (!res.headersSent) res.status(200).send('OK');
    return;
  }

  if (req.method === 'POST') {
    if (!res.headersSent) {
      res.status(200).send('OK');
    }
    console.log(
      `${LOG} POST ACK 200 (edge/vercel stub) — Push URL nên trỏ backend /api/webhook/shopee để get_order_detail + UPSERT`,
    );
    console.log(`${LOG} req.body (full):`, req.body);
    return;
  }

  return respondShopeeOk(res);
}
