import { logShopeeRequest, respondShopeeOk, forwardToCpanel } from '../shopeeCallbackUtil.js';

const LOG = '[Shopee Webhook]';

export async function handleShopeeWebhook(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS') {
    return respondShopeeOk(res);
  }

  if (req.method === 'POST' || req.method === 'GET') {
    respondShopeeOk(res);
    if (req.method === 'POST') {
      setImmediate(() => {
        forwardToCpanel(LOG, '/api/shopee/webhook', req).catch(() => {});
      });
    }
    return;
  }

  res.status(405).end();
}
