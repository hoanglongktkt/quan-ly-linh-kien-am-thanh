/**
 * POST orders/hydrate-tracking — Vercel local (cPanel cũ chưa có route).
 * Đọc tracking_no từ Mongo Atlas → PATCH vào orders.json trên cPanel.
 * Không cần deploy lại server.cjs trên cPanel.
 */
import mongoose from 'mongoose';
import { buildCpanelTarget } from '../cpanelProxy.js';
import { resolveCpanelBackend } from '../cpanelBackend.js';
import { fetchWithDiagnostics } from '../fetchDiagnostics.js';

function getMongoUri() {
  return String(process.env.MONGODB_URI || process.env.MONGO_URL || '').trim();
}

function usableTn(v) {
  const tn = String(v || '').trim();
  if (!tn || /^0FG/i.test(tn)) return '';
  return tn;
}

function inferCarrierFromTn(tn) {
  const k = String(tn || '').toUpperCase();
  if (/^GYA/.test(k) || /^GHN/.test(k)) return 'Giao Hàng Nhanh';
  if (/^SPX/.test(k)) return 'SPX Express';
  return '';
}

async function fetchJson(backendUrl, req, pathPart, init = {}, timeoutMs = 120000) {
  const target = buildCpanelTarget(backendUrl, pathPart, init.query || {});
  const headers = {
    Authorization: req.headers?.authorization || req.headers?.Authorization || '',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    ...(init.headers || {}),
  };
  const result = await fetchWithDiagnostics(
    '[Hydrate Tracking]',
    target,
    {
      method: init.method || 'GET',
      headers,
      body: init.body != null ? JSON.stringify(init.body) : undefined,
    },
    timeoutMs,
  );
  if (!result.ok) {
    throw new Error(result.error?.message || 'Không kết nối được backend cPanel.');
  }
  const text = await result.upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`cPanel trả non-JSON (${result.upstream.status}): ${text.slice(0, 180)}`);
  }
  if (!result.upstream.ok) {
    const err = new Error(data.error || data.message || `HTTP ${result.upstream.status}`);
    err.status = result.upstream.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function handleHydrateTracking(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const uri = getMongoUri();
  if (!uri) {
    return res.status(503).json({
      success: false,
      error: 'Thiếu MONGODB_URI trên Vercel — không hydrate được tracking từ Mongo.',
    });
  }

  const backend = resolveCpanelBackend();
  if (!backend.ok) {
    return res.status(503).json({ success: false, error: backend.error });
  }

  let conn = null;
  try {
    conn = await mongoose.createConnection(uri, {
      serverSelectionTimeoutMS: 12000,
      maxPoolSize: 2,
    }).asPromise();

    const col = conn.collection('orders');

    // Mirror top-level tracking_no → data.*
    const needMirror = await col
      .find({ tracking_no: { $exists: true, $nin: [null, ''] } })
      .project({ _id: 1, tracking_no: 1, 'data.tracking_no': 1, 'data.trackingNumber': 1 })
      .toArray();
    let mirrored = 0;
    for (const d of needMirror) {
      const tn = usableTn(d.tracking_no);
      if (!tn) continue;
      const dataTn = usableTn(d.data?.tracking_no || d.data?.trackingNumber);
      if (dataTn === tn) continue;
      await col.updateOne(
        { _id: d._id },
        { $set: { 'data.tracking_no': tn, 'data.trackingNumber': tn } },
      );
      mirrored += 1;
    }

    const docs = await col
      .find({ tracking_no: { $exists: true, $nin: [null, ''] } })
      .project({ orderSn: 1, tracking_no: 1, 'data.orderSn': 1 })
      .toArray();
    const map = new Map();
    for (const d of docs) {
      const sn = String(d.orderSn || d.data?.orderSn || '')
        .replace(/^shopee-/i, '')
        .trim();
      const tn = usableTn(d.tracking_no);
      if (sn && tn) map.set(sn, tn);
    }

    const ordersRaw = await fetchJson(backend.url, req, 'orders', {
      method: 'GET',
      query: { t: String(Date.now()) },
    });
    const orders = Array.isArray(ordersRaw) ? ordersRaw : ordersRaw.orders || [];

    let patched = 0;
    let already = 0;
    let failed = 0;
    const samples = [];

    for (const o of orders) {
      const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim();
      if (!sn) continue;
      const mongoTn = map.get(sn);
      if (!mongoTn) continue;
      const cur = usableTn(o.trackingNumber || o.tracking_no);
      if (cur) {
        already += 1;
        continue;
      }
      const id = o.id || `shopee-${sn}`;
      const carrier = inferCarrierFromTn(mongoTn);
      const patch = {
        tracking_no: mongoTn,
        trackingNumber: mongoTn,
      };
      if (carrier && !String(o.shipping_carrier || '').trim()) {
        patch.shipping_carrier = carrier;
      } else if (carrier && /^GYA/i.test(mongoTn)) {
        // Sửa nhãn SPX Express sai cho đơn GHN.
        const curCarrier = String(o.shipping_carrier || '').toLowerCase();
        if (!curCarrier || curCarrier.includes('spx')) {
          patch.shipping_carrier = carrier;
        }
      }
      try {
        await fetchJson(backend.url, req, `orders/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: patch,
        });
        patched += 1;
        if (samples.length < 12) samples.push({ sn, tn: mongoTn });
      } catch (err) {
        failed += 1;
        if (samples.length < 12) {
          samples.push({ sn, tn: mongoTn, error: err?.message || String(err) });
        }
      }
    }

    return res.status(200).json({
      success: true,
      source: 'vercel-mongo-to-cpanel-patch',
      mirrored,
      mongoWithTracking: map.size,
      ordersOnCpanel: orders.length,
      patched,
      already,
      failed,
      samples,
    });
  } catch (err) {
    console.error('[Hydrate Tracking]', err);
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  } finally {
    try {
      if (conn) await conn.close();
    } catch {
      /* ignore */
    }
  }
}
