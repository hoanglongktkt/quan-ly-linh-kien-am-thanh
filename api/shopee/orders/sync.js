/**
 * POST /api/shopee/orders/sync — route riêng, timeout dài (đồng bộ Shopee có thể > 60s).
 */
import { proxyRequestToCpanel } from '../../lib/cpanelProxy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  return proxyRequestToCpanel(req, res, 'shopee/orders/sync', { timeoutMs: 120_000 });
}

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } },
  maxDuration: 300,
};
