/**
 * Vercel Serverless — Shopee Webhook / Callback
 * URL: https://<ten-mien-vercel>/api/shopee/callback
 *
 * Shopee yêu cầu phản hồi 200 OK trong ~3 giây — luôn trả lời ngay, không xử lý nặng trước.
 */

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    console.log('[Shopee Callback] GET', JSON.stringify(req.query || {}));
    return res.status(200).json({ received: true, ok: true });
  }

  if (req.method === 'POST') {
    console.log('[Shopee Callback] POST', JSON.stringify(req.body || {}));
    return res.status(200).json({ received: true });
  }

  res.setHeader('Allow', 'GET, POST, OPTIONS');
  return res.status(405).json({ error: 'Method not allowed' });
};
