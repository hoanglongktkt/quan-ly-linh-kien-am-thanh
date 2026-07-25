import { logShopeeRequest, respondShopeeOk } from '../shopeeCallbackUtil.js';

const LOG = '[Shopee Webhook]';

export async function handleShopeeWebhook(req, res) {
  logShopeeRequest(LOG, req);

  if (req.method === 'OPTIONS') {
    return respondShopeeOk(res);
  }

  if (req.method === 'GET') {
    respondShopeeOk(res);
    return;
  }

  if (req.method === 'POST') {
    return res.status(410).type('text/plain; charset=utf-8').send(
      'Webhook moved to /api/webhook/shopee on the backend.',
    );
  }

  res.status(405).end();
}
