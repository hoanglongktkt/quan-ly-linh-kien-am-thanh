import { resolveCpanelBackend } from '../_lib/cpanelBackend.js';
import { fetchWithDiagnostics } from '../_lib/fetchDiagnostics.js';

const LOG = '[Shopee Webhook Proxy]';
const MAX_BODY_BYTES = 1024 * 1024;

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Webhook body exceeds 1 MB'));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'OPTIONS') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send('success');
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).end();
  }

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    console.error(LOG, backend.error);
    return res.status(503).end();
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.warn(LOG, error?.message || error);
    return res.status(413).end();
  }

  const target = `${backend.url}/api/shopee/webhook`;
  const result = await fetchWithDiagnostics(
    LOG,
    target,
    {
      method: 'POST',
      headers: {
        Authorization: String(req.headers.authorization || ''),
        'Content-Type': String(req.headers['content-type'] || 'application/json'),
        'Content-Length': String(rawBody.length),
        'X-Forwarded-Host': String(req.headers.host || 'quanly.linhkienamthanh.net'),
        'X-Forwarded-Proto': 'https',
      },
      body: rawBody,
    },
    10_000,
  );

  if (!result.ok || !result.upstream) {
    return res.status(502).end();
  }

  const responseBody = await result.upstream.text();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(result.upstream.status).send(responseBody);
}

export const config = {
  api: { bodyParser: false },
  maxDuration: 10,
};
