/**
 * Vercel — Shopee Push / Webhook
 * URL: https://<domain>/api/shopee/webhook
 */
import { logShopeeRequest, respondShopeeOk, forwardToCpanel } from '../lib/shopeeCallbackUtil.js';

export default async function handler(req, res) {
  logShopeeRequest('Webhook', req);

  if (req.method === 'OPTIONS') {
    return respondShopeeOk(res);
  }

  if (req.method === 'POST' || req.method === 'GET') {
    respondShopeeOk(res);
    if (req.method === 'POST') {
      setImmediate(() => {
        forwardToCpanel('/api/shopee/webhook', req).catch(() => {});
      });
    }
    return;
  }

  res.status(405).end();
}

export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};
