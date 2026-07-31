import { logShopeeRequest, respondShopeeOk } from '../shopeeCallbackUtil.js';

const LOG = '[Shopee Webhook]';

export async function handleShopeeWebhook(req, res) {
  logShopeeRequest(LOG, req);

  // Emergency: mọi method đều ACK 200 ngay — không 410/405 để tránh Live Push fail.
  if (req.method === 'OPTIONS' || req.method === 'GET') {
    return respondShopeeOk(res);
  }

  if (req.method === 'POST') {
    if (!res.headersSent) {
      res.status(200).json({ status: 'success' });
    }
    console.log(`${LOG} POST ACK 200 (edge/vercel) — prefer backend /api/webhook/shopee for full processing`);
    console.log(`${LOG} req.body (full):`, req.body);
    return;
  }

  return respondShopeeOk(res);
}
