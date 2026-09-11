/**
 * POST orders/hydrate-tracking — mirror tracking_no → data.* bằng 1 lần bulkWrite.
 * CẤM PATCH HTTP từng đơn / updateOne trong vòng lặp.
 */
import mongoose from 'mongoose';
import { connectDB, getMongoUri } from '../../config/db.js';

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

export async function handleHydrateTracking(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const uri = getMongoUri();
  if (!uri) {
    return res.status(503).json({
      success: false,
      error: 'Thiếu MONGODB_URI — không hydrate được tracking từ Mongo.',
    });
  }

  try {
    await connectDB();
    const col = mongoose.connection.collection('orders');

    const docs = await col
      .find({ tracking_no: { $exists: true, $nin: [null, ''] } })
      .project({
        _id: 1,
        orderSn: 1,
        tracking_no: 1,
        trackingNumber: 1,
        shipping_carrier: 1,
        'data.orderSn': 1,
        'data.tracking_no': 1,
        'data.trackingNumber': 1,
        'data.shipping_carrier': 1,
      })
      .limit(2000)
      .maxTimeMS(15_000)
      .toArray();

    const ops = [];
    const samples = [];
    let already = 0;
    for (const d of docs) {
      const tn = usableTn(d.tracking_no || d.trackingNumber);
      if (!tn) continue;
      const dataTn = usableTn(d.data?.tracking_no || d.data?.trackingNumber);
      const existingCarrier = String(d.shipping_carrier || d.data?.shipping_carrier || '').trim();
      const carrier = inferCarrierFromTn(tn);
      const $set = {};
      if (dataTn !== tn) {
        $set['data.tracking_no'] = tn;
        $set['data.trackingNumber'] = tn;
        $set.trackingNumber = tn;
        $set.tracking_no = tn;
      }
      if (carrier && !existingCarrier) {
        $set.shipping_carrier = carrier;
        $set['data.shipping_carrier'] = carrier;
      } else if (carrier && /^GYA/i.test(tn)) {
        const curCarrier = existingCarrier.toLowerCase();
        if (!curCarrier || curCarrier.includes('spx')) {
          $set.shipping_carrier = carrier;
          $set['data.shipping_carrier'] = carrier;
        }
      }
      if (!Object.keys($set).length) {
        already += 1;
        continue;
      }
      ops.push({
        updateOne: {
          filter: { _id: d._id },
          update: { $set },
        },
      });
      if (samples.length < 12) {
        samples.push({
          sn: String(d.orderSn || d.data?.orderSn || '').replace(/^shopee-/i, '').trim(),
          tn,
        });
      }
    }

    let patched = 0;
    if (ops.length) {
      const result = await col.bulkWrite(ops, { ordered: false });
      patched = Number(result.modifiedCount || 0) + Number(result.upsertedCount || 0);
    }

    return res.status(200).json({
      success: true,
      source: 'mongo-bulkWrite',
      mirrored: patched,
      mongoWithTracking: docs.length,
      ordersOnCpanel: docs.length,
      patched,
      already,
      failed: 0,
      samples,
    });
  } catch (err) {
    console.error('[Hydrate Tracking]', err);
    return res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
}
