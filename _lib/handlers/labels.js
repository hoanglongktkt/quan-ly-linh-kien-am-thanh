/**
 * Proxy PDF vận đơn từ cPanel — gom vào entry /api (1 serverless function).
 */
import { resolveCpanelBackend } from '../cpanelBackend.js';

function isPdfBuffer(buf) {
  return buf.length > 4 && buf.subarray(0, 4).toString() === '%PDF';
}

function extractFilename(routeFile, req) {
  let filePath = String(routeFile || '').replace(/^\/+/, '');
  if (!filePath) {
    const raw = req.query?.path;
    const fromQuery = Array.isArray(raw) ? raw.join('/') : String(raw || '');
    // path=labels/foo.pdf → foo.pdf
    filePath = fromQuery.replace(/^labels\/?/i, '').replace(/^\/+/, '');
  }
  if (!filePath) {
    const u = String(req.url || '');
    const m = u.match(/\/(?:api\/)?(?:labels|prints)\/([^?#]+)/i);
    if (m) filePath = decodeURIComponent(m[1]);
  }
  return filePath.split('/').pop() || filePath;
}

export async function handleLabelProxy(req, res, routeFile = '') {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const filename = extractFilename(routeFile, req);
  if (!filename || filename.includes('..') || !/\.pdf$/i.test(filename)) {
    return res.status(400).send('Invalid label path');
  }

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    return res.status(503).json({ error: backend.error, errorCode: 'BACKEND_CONFIG' });
  }

  const target = `${backend.url}/prints/${encodeURIComponent(filename)}`;

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
          : 'File vận đơn không hợp lệ (không phải PDF).',
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
