/**
 * Proxy PDF vận đơn từ cPanel — tránh rewrite Vercel → quanly (frontend) gây 508 loop.
 */
import { resolveCpanelBackend } from '../lib/cpanelBackend.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = req.query.path;
  const filePath = Array.isArray(raw) ? raw.join('/') : String(raw || '').replace(/^\/+/, '');
  if (!filePath || filePath.includes('..')) {
    return res.status(400).send('Invalid label path');
  }

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    return res.status(503).json({ error: backend.error, errorCode: 'BACKEND_CONFIG' });
  }

  const target = `${backend.url}/labels/${filePath}`;
  try {
    const upstream = await fetch(target, { method: req.method });
    if (!upstream.ok) {
      return res.status(upstream.status).send('Label file not found');
    }

    const contentType = upstream.headers.get('content-type') || 'application/pdf';
    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'HEAD') return res.end();

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    console.error('[Labels Proxy]', target, err);
    return res.status(502).json({
      error: 'Không lấy được file vận đơn từ backend',
      detail: err?.message || String(err),
    });
  }
}
