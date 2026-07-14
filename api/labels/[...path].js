/**
 * Proxy PDF vận đơn từ cPanel qua /api/public/labels (Express) — tránh /labels/* bị LiteSpeed trả SPA HTML.
 */
import { resolveCpanelBackend } from '../lib/cpanelBackend.js';

function isPdfBuffer(buf) {
  return buf.length > 4 && buf.subarray(0, 4).toString() === '%PDF';
}

function extractLabelPath(req) {
  const raw = req.query.path;
  let filePath = Array.isArray(raw) ? raw.join('/') : String(raw || '').replace(/^\/+/, '');
  if (!filePath) {
    const u = String(req.url || '');
    const m = u.match(/\/(?:api\/)?labels\/([^?#]+)/i);
    if (m) filePath = decodeURIComponent(m[1]);
  }
  return filePath;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const filePath = extractLabelPath(req);
  if (!filePath || filePath.includes('..') || !/\.pdf$/i.test(filePath)) {
    return res.status(400).send('Invalid label path');
  }

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    return res.status(503).json({ error: backend.error, errorCode: 'BACKEND_CONFIG' });
  }

  const filename = filePath.split('/').pop() || filePath;
  const target = `${backend.url}/api/public/labels/${encodeURIComponent(filename)}`;

  try {
    const upstream = await fetch(target, { method: req.method });
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      console.error('[Labels Proxy] upstream fail', upstream.status, target, errText.slice(0, 120));
      return res.status(upstream.status).send(errText || 'Label file not found');
    }

    if (req.method === 'HEAD') {
      res.status(200);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      const len = upstream.headers.get('content-length');
      if (len) res.setHeader('Content-Length', len);
      return res.end();
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!isPdfBuffer(buf)) {
      const preview = buf.subarray(0, 120).toString('utf8');
      console.error('[Labels Proxy] Not PDF', { target, size: buf.length, preview: preview.slice(0, 80) });
      return res.status(502).type('text/plain').send(
        preview.trimStart().startsWith('<!')
          ? 'Backend trả HTML thay vì PDF — file vận đơn chưa sẵn sàng hoặc route sai.'
          : 'File vận đơn không hợp lệ (không phải PDF).'
      );
    }

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', 'no-store');
    console.log('[Labels Proxy] OK', filename, buf.length, 'bytes');
    return res.end(buf);
  } catch (err) {
    console.error('[Labels Proxy]', target, err);
    return res.status(502).json({
      error: 'Không lấy được file vận đơn từ backend',
      detail: err?.message || String(err),
    });
  }
}
