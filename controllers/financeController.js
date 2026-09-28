import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import Escrow from "../models/Escrow.js";
import { resolveAppRoot } from "../utils/appPaths.js";
import { loadProductsFromStore } from "../src/db/mongoStore.ts";
import {
  getShopeeAccessTokenForApi,
  shopeeSign,
  SHOPEE_HOST,
  SHOPEE_PARTNER_ID,
} from "../services/shopee/auth.js";
import { shopeeFetchJsonWithRetry } from "../services/shopee/client.js";

/** Giới hạn cứng — chống rate limit Shopee và treo process cPanel. */
const SYNC_API_MAX = 25;
const SYNC_CANDIDATE_LIMIT = 200;
const SYNC_DELAY_MS = 450;
const SYNC_TIME_BUDGET_MS = 50_000;
const DISPUTE_MIN_VND = 2000;
const FRESH_SYNC_MS = 6 * 60 * 60 * 1000;

let syncInFlight = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundVnd(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function posVnd(raw) {
  return Math.max(0, roundVnd(raw));
}

function mongoReady() {
  return mongoose.connection.readyState === 1 && Boolean(mongoose.connection.db);
}

function parseVnDayStart(ymd) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseVnDayEnd(ymd) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T23:59:59.999+07:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function loadShopNameMap() {
  const map = new Map();
  try {
    const file = path.join(resolveAppRoot(), "data", "channel_settings.json");
    if (!fs.existsSync(file)) return map;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const shops = Array.isArray(parsed?.shops) ? parsed.shops : [];
    for (const shop of shops) {
      const id = String(shop?.shopId || "").trim();
      if (!id) continue;
      map.set(id, String(shop?.shopName || "").trim());
    }
  } catch (err) {
    console.warn("[Finance] Không đọc được tên shop:", err?.message || err);
  }
  return map;
}

function readImportPrice(row) {
  if (!row || typeof row !== "object") return 0;
  const candidates = [row.importPrice, row.import_price, row.last_import_price, row.cost_price];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return 0;
}

function indexCatalog(products) {
  const bySku = new Map();
  const byModel = new Map();
  const byItem = new Map();
  const visit = (row) => {
    if (!row || typeof row !== "object") return;
    const price = readImportPrice(row);
    const sku = String(row.sku || row.modelSku || "").trim().toLowerCase();
    const modelId = String(row.shopeeModelId || row.modelId || "").trim();
    const itemId = String(row.shopeeItemId || row.productId || row.id || "").trim();
    if (sku && price > 0 && !bySku.has(sku)) bySku.set(sku, price);
    if (modelId && modelId !== "0" && price > 0 && !byModel.has(modelId)) byModel.set(modelId, price);
    if (itemId && price > 0 && !byItem.has(itemId)) byItem.set(itemId, price);
    const children = []
      .concat(Array.isArray(row.children) ? row.children : [])
      .concat(Array.isArray(row.children_models) ? row.children_models : []);
    for (let i = 0; i < children.length; i += 1) visit(children[i]);
  };
  const list = Array.isArray(products) ? products : [];
  for (let i = 0; i < list.length; i += 1) visit(list[i]);
  return { bySku, byModel, byItem };
}

function lineActualCost(item, catalog) {
  const qty = Math.max(0, Number(item?.quantity ?? item?.qty) || 0);
  if (qty <= 0) return 0;
  let unit = readImportPrice(item);
  if (unit <= 0 && catalog) {
    const sku = String(item?.modelSku || item?.sku || "").trim().toLowerCase();
    const modelId = String(item?.modelId || "").trim();
    const itemId = String(item?.productId || item?.item_id || "").trim();
    if (sku && catalog.bySku.has(sku)) unit = catalog.bySku.get(sku);
    else if (modelId && modelId !== "0" && catalog.byModel.has(modelId)) unit = catalog.byModel.get(modelId);
    else if (itemId && catalog.byItem.has(itemId)) unit = catalog.byItem.get(itemId);
  }
  const line = qty * Math.max(0, unit || 0);
  return Number.isFinite(line) ? Math.round(line) : 0;
}

function orderActualCost(data, catalog) {
  const items = Array.isArray(data?.items) ? data.items : [];
  let total = 0;
  for (let i = 0; i < items.length; i += 1) {
    total += lineActualCost(items[i], catalog);
  }
  return total;
}

function incomeOf(payload) {
  const root = payload?.response ?? payload ?? {};
  return root?.order_income || root?.orderIncome || root?.income_details || {};
}

function sellerShippingCost(income) {
  const finalShip = roundVnd(income?.final_shipping_fee);
  if (finalShip < 0) return Math.abs(finalShip);
  const actual = posVnd(income?.actual_shipping_fee);
  const buyerPaid = posVnd(income?.buyer_paid_shipping_fee);
  const rebate = posVnd(income?.shopee_shipping_rebate);
  const discount3pl = posVnd(income?.shipping_fee_discount_from_3pl);
  const sellerDiscount = posVnd(income?.seller_shipping_discount);
  return Math.max(0, actual - buyerPaid - rebate - discount3pl + sellerDiscount);
}

function taxTotal(income) {
  return (
    posVnd(income?.commission_fee_tax) +
    posVnd(income?.service_fee_tax) +
    posVnd(income?.transaction_fee_tax) +
    posVnd(income?.withholding_vat_tax) +
    posVnd(income?.withholding_pit_tax) +
    posVnd(income?.withholding_cit_tax) +
    posVnd(income?.escrow_tax) +
    posVnd(income?.withholding_tax)
  );
}

/**
 * Dòng tiền dự kiến = tiền hàng (gốc − giảm shop) − phí sàn − ship seller − thuế.
 * Lệch so với escrow_amount (tiền thực về ví) → cờ is_disputed.
 */
function buildFinanceRow(income, fallbackTotal) {
  const commission =
    posVnd(income?.commission_fee) +
    posVnd(income?.seller_transaction_fee || income?.credit_card_transaction_fee) +
    posVnd(income?.order_ams_commission_fee);
  const serviceFee = posVnd(income?.service_fee);
  const shippingFee = sellerShippingCost(income);
  const tax = taxTotal(income);
  const original = posVnd(
    income?.original_cost_of_goods_sold ||
      income?.cost_of_goods_sold ||
      income?.original_price ||
      income?.order_original_price,
  );
  const sellerDiscount = posVnd(income?.seller_discount || income?.order_seller_discount);
  const voucherSeller = posVnd(income?.voucher_from_seller);
  const coin = posVnd(income?.seller_coin_cash_back);
  const buyerTotal = posVnd(income?.buyer_total_amount || income?.buyer_paid_amount);
  const totalAmount = buyerTotal || posVnd(fallbackTotal) || Math.max(0, original - sellerDiscount);
  const goodsBase = original > 0 ? Math.max(0, original - sellerDiscount) : totalAmount;
  const expected = Math.round(goodsBase - voucherSeller - commission - serviceFee - shippingFee - tax - coin);
  const payout = roundVnd(income?.escrow_amount ?? income?.escrow_amount_after_adjustment);
  const delta = payout - expected;
  const tolerance = Math.max(DISPUTE_MIN_VND, Math.round(Math.abs(expected) * 0.015));

  let status = "Đã đối soát";
  let isDisputed = false;
  let reason = "";
  if (!(payout > 0)) {
    status = "Chưa về ví";
    isDisputed = true;
    reason = "Đơn hoàn thành nhưng chưa có tiền escrow về ví Shopee";
  } else if (Math.abs(delta) > tolerance) {
    status = "Lệch tiền";
    isDisputed = true;
    const gap = Math.abs(delta).toLocaleString("vi-VN");
    reason = delta < 0
      ? `Thiếu khoảng ${gap} đ so với dòng tiền dự kiến`
      : `Thừa khoảng ${gap} đ so với dòng tiền dự kiến`;
  }

  return {
    total_amount: totalAmount,
    shopee_commission: commission,
    service_fee: serviceFee,
    shipping_fee: shippingFee,
    withholding_tax: tax,
    payout_amount: Math.max(0, payout),
    expected_payout: expected,
    delta,
    status,
    is_disputed: isDisputed,
    dispute_reason: reason,
  };
}

function orderDateOf(doc, data) {
  const raw = doc?.create_time || data?.date || data?.createdAt || null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fetchEscrowDetail(shopId, accessToken, orderSn) {
  const apiPath = "/api/v2/payment/get_escrow_detail";
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(apiPath, timestamp, accessToken, shopId);
  const params = new URLSearchParams({
    partner_id: SHOPEE_PARTNER_ID,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: String(shopId),
    sign,
    order_sn: String(orderSn),
  });
  const url = `${SHOPEE_HOST}${apiPath}?${params.toString()}`;
  const { json } = await shopeeFetchJsonWithRetry(
    url,
    `finance get_escrow_detail shop_id=${shopId} order_sn=${orderSn}`,
  );
  return json;
}

function buildListFilter(query) {
  const filter = {};
  const shopId = String(query.shop_id || query.shopId || "").trim();
  if (shopId) filter.shop_id = shopId;

  const from = parseVnDayStart(query.from);
  const to = parseVnDayEnd(query.to);
  if (from || to) {
    filter.order_date = {};
    if (from) filter.order_date.$gte = from;
    if (to) filter.order_date.$lte = to;
  }

  const status = String(query.status || "").trim();
  const disputed = String(query.disputed || "").trim();
  if (disputed === "1" || disputed === "true") {
    filter.manual_verified = { $ne: true };
    filter.$or = [
      { is_disputed: true },
      { status: { $in: ["Lệch tiền", "Chưa về ví"] } },
    ];
  } else if (status === "Đã đối soát" || status === "Lệch tiền" || status === "Chưa về ví") {
    filter.status = status;
  }
  return filter;
}

/** GET /api/finance/reconciliation */
export async function listReconciliation(req, res) {
  try {
    if (!mongoReady()) {
      return res.status(503).json({ error: "MongoDB chưa sẵn sàng" });
    }
    const filter = buildListFilter(req.query || {});
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const skip = Math.max(0, Number(req.query.skip) || 0);

    const [summaryRows, rows] = await Promise.all([
      Escrow.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            total_amount: { $sum: "$total_amount" },
            shopee_commission: { $sum: "$shopee_commission" },
            service_fee: { $sum: "$service_fee" },
            shipping_fee: { $sum: "$shipping_fee" },
            withholding_tax: { $sum: "$withholding_tax" },
            payout_amount: { $sum: "$payout_amount" },
            actual_cost: { $sum: "$actual_cost" },
            net_profit: { $sum: "$net_profit" },
            order_count: { $sum: 1 },
            disputed_count: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$is_disputed", true] },
                      { $ne: ["$manual_verified", true] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]).option({ maxTimeMS: 12000 }),
      Escrow.find(filter)
        .sort({ order_date: -1, ordersn: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .maxTimeMS(12000),
    ]);

    const summary = summaryRows[0] || {
      total_amount: 0,
      shopee_commission: 0,
      service_fee: 0,
      shipping_fee: 0,
      withholding_tax: 0,
      payout_amount: 0,
      actual_cost: 0,
      net_profit: 0,
      order_count: 0,
      disputed_count: 0,
    };
    delete summary._id;
    summary.shopee_fees = roundVnd(
      Number(summary.shopee_commission || 0) +
        Number(summary.service_fee || 0) +
        Number(summary.shipping_fee || 0) +
        Number(summary.withholding_tax || 0),
    );

    return res.json({
      summary,
      rows,
      limit,
      skip,
    });
  } catch (err) {
    console.error("[Finance] list reconciliation:", err?.message || err);
    return res.status(500).json({ error: "Không tải được dữ liệu đối soát" });
  }
}

const VERIFY_MAX = 200;

/** PATCH /api/finance/reconciliation/verify — ghi nhận đã kiểm tra tay, không gọi Shopee. */
export async function verifyReconciliation(req, res) {
  try {
    if (!mongoReady()) {
      return res.status(503).json({ error: "MongoDB chưa sẵn sàng" });
    }
    const raw = req.body?.orderSns ?? req.body?.ordersns ?? [];
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: "orderSns phải là mảng mã đơn." });
    }

    const orderSns = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i += 1) {
      if (orderSns.length >= VERIFY_MAX) break;
      const sn = String(raw[i] || "").trim();
      if (!sn || sn.length > 64 || seen.has(sn)) continue;
      seen.add(sn);
      orderSns.push(sn);
    }
    if (orderSns.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách mã đơn." });
    }

    const result = await Escrow.updateMany(
      { ordersn: { $in: orderSns } },
      { $set: { manual_verified: true } },
    ).maxTimeMS(12000);

    return res.json({
      ok: true,
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0,
    });
  } catch (err) {
    console.error("[Finance] verify reconciliation:", err?.message || err);
    return res.status(500).json({ error: "Không xác nhận được đơn đã kiểm tra" });
  }
}

/** POST /api/finance/sync-escrow — chỉ đọc orders, chỉ ghi collection escrows. */
export async function syncEscrow(req, res) {
  if (syncInFlight) {
    return res.status(409).json({ error: "Đang đồng bộ đối soát, vui lòng đợi lần chạy hiện tại xong." });
  }
  syncInFlight = true;
  const started = Date.now();
  try {
    if (!mongoReady()) {
      return res.status(503).json({ error: "MongoDB chưa sẵn sàng" });
    }
    if (!SHOPEE_PARTNER_ID) {
      return res.status(400).json({ error: "Thiếu SHOPEE_PARTNER_ID — không gọi được Shopee." });
    }

    const body = req.body || {};
    const shopId = String(body.shop_id || body.shopId || "").trim();
    const force = body.force === true || body.force === "1" || body.force === 1;
    const from = parseVnDayStart(body.from);
    const to = parseVnDayEnd(body.to);

    const and = [
      {
        $or: [
          { shopee_order_status: "COMPLETED" },
          { "data.shopee_order_status": "COMPLETED" },
        ],
      },
    ];
    if (shopId) and.push({ shopId });
    if (from || to) {
      const dateRange = {};
      const strRange = {};
      if (from) {
        dateRange.$gte = from;
        strRange.$gte = from.toISOString();
      }
      if (to) {
        dateRange.$lte = to;
        strRange.$lte = to.toISOString();
      }
      and.push({ $or: [{ create_time: dateRange }, { "data.date": strRange }] });
    }

    const ordersCol = mongoose.connection.db.collection("orders");
    const candidates = await ordersCol
      .find({ $and: and })
      .project({
        orderSn: 1,
        shopId: 1,
        create_time: 1,
        "data.orderSn": 1,
        "data.order_sn": 1,
        "data.shopId": 1,
        "data.shopName": 1,
        "data.totalAmount": 1,
        "data.date": 1,
        "data.items": 1,
      })
      .sort({ create_time: -1 })
      .limit(SYNC_CANDIDATE_LIMIT)
      .maxTimeMS(12000)
      .toArray();

    const shopNames = loadShopNameMap();
    let catalog = indexCatalog([]);
    try {
      const products = await loadProductsFromStore();
      catalog = indexCatalog(products);
    } catch (err) {
      console.warn("[Finance] Không đọc kho để tính giá vốn:", err?.message || err);
    }

    const sns = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const data = candidates[i]?.data || {};
      const sn = String(candidates[i]?.orderSn || data.orderSn || data.order_sn || "").trim();
      if (sn) sns.push(sn);
      if (sns.length >= SYNC_CANDIDATE_LIMIT) break;
    }

    const freshKeys = new Set();
    if (!force && sns.length > 0) {
      const existing = await Escrow.find({
        ordersn: { $in: sns },
        status: "Đã đối soát",
        is_disputed: false,
        payout_amount: { $gt: 0 },
        synced_at: { $gte: new Date(Date.now() - FRESH_SYNC_MS) },
      })
        .select("ordersn shop_id")
        .limit(SYNC_CANDIDATE_LIMIT)
        .lean();
      for (const row of existing) {
        freshKeys.add(`${row.shop_id}:${row.ordersn}`);
      }
    }

    const tokenByShop = new Map();
    let synced = 0;
    let skipped = 0;
    let failed = 0;
    let disputed = 0;
    let stoppedReason = "";
    const errors = [];

    for (let i = 0; i < candidates.length; i += 1) {
      if (synced >= SYNC_API_MAX) {
        stoppedReason = `Đã gọi Shopee đủ ${SYNC_API_MAX} đơn trong một lượt. Bấm đồng bộ tiếp để lấy đơn còn lại.`;
        break;
      }
      if (Date.now() - started > SYNC_TIME_BUDGET_MS) {
        stoppedReason = "Hết thời gian một lượt đồng bộ để tránh treo server. Bấm đồng bộ tiếp.";
        break;
      }

      const doc = candidates[i];
      const data = doc?.data || {};
      const ordersn = String(doc?.orderSn || data.orderSn || data.order_sn || "").trim();
      const rowShop = String(doc?.shopId || data.shopId || "").trim();
      if (!ordersn || !rowShop) {
        skipped += 1;
        continue;
      }
      if (freshKeys.has(`${rowShop}:${ordersn}`)) {
        skipped += 1;
        continue;
      }

      let tokenPack = tokenByShop.get(rowShop);
      if (tokenPack === undefined) {
        try {
          tokenPack = await getShopeeAccessTokenForApi(rowShop);
        } catch (err) {
          tokenPack = null;
          console.warn(`[Finance] token shop ${rowShop}:`, err?.message || err);
        }
        tokenByShop.set(rowShop, tokenPack || null);
      }
      if (!tokenPack?.token) {
        if (!tokenByShop.get(`miss:${rowShop}`)) {
          tokenByShop.set(`miss:${rowShop}`, true);
          failed += 1;
          if (errors.length < 8) errors.push(`Shop ${rowShop}: chưa có access token`);
        }
        continue;
      }

      try {
        const json = await fetchEscrowDetail(rowShop, tokenPack.token, ordersn);
        const errText = `${json?.error || ""} ${json?.message || ""}`;
        if (/rate|limit|too many|request_frequency/i.test(errText)) {
          stoppedReason = "Shopee giới hạn tần suất. Đã dừng lượt này, thử lại sau ít phút.";
          break;
        }

        const fallbackTotal = Number(data.totalAmount || 0);
        const finance = json?.error
          ? {
              total_amount: posVnd(fallbackTotal),
              shopee_commission: 0,
              service_fee: 0,
              shipping_fee: 0,
              withholding_tax: 0,
              payout_amount: 0,
              expected_payout: 0,
              delta: 0,
              status: "Chưa về ví",
              is_disputed: true,
              dispute_reason: String(json.message || json.error || "Shopee chưa trả escrow"),
            }
          : buildFinanceRow(incomeOf(json), fallbackTotal);

        const actualCost = orderActualCost(data, catalog);
        const payout = Math.max(0, roundVnd(finance.payout_amount));
        const netProfit = payout - actualCost;
        const shopName = String(data.shopName || shopNames.get(rowShop) || `Shop ${rowShop}`);

        await Escrow.updateOne(
          { ordersn, shop_id: rowShop },
          {
            $set: {
              ordersn,
              shop_id: rowShop,
              shop_name: shopName,
              order_date: orderDateOf(doc, data),
              total_amount: finance.total_amount,
              shopee_commission: finance.shopee_commission,
              service_fee: finance.service_fee,
              shipping_fee: finance.shipping_fee,
              withholding_tax: finance.withholding_tax,
              payout_amount: payout,
              expected_payout: finance.expected_payout,
              delta: finance.delta,
              actual_cost: actualCost,
              net_profit: netProfit,
              status: finance.status,
              is_disputed: Boolean(finance.is_disputed),
              dispute_reason: finance.dispute_reason || "",
              synced_at: new Date(),
            },
          },
          { upsert: true },
        );
        synced += 1;
        if (finance.is_disputed) disputed += 1;
      } catch (err) {
        failed += 1;
        if (errors.length < 8) errors.push(`${ordersn}: ${err?.message || "lỗi escrow"}`);
        console.warn(`[Finance] escrow ${ordersn}:`, err?.message || err);
      }

      if (synced < SYNC_API_MAX && Date.now() - started < SYNC_TIME_BUDGET_MS) {
        await sleep(SYNC_DELAY_MS);
      }
    }

    const baseMessage =
      stoppedReason ||
      (synced === 0 && skipped > 0
        ? `Không có đơn mới cần gọi Shopee (${skipped} đơn đã đối soát gần đây hoặc thiếu mã).`
        : `Đã đối soát ${synced} đơn hoàn thành.`);
    const message = errors.length ? `${baseMessage} ${errors.slice(0, 3).join(" · ")}` : baseMessage;

    return res.json({
      ok: true,
      scanned: candidates.length,
      synced,
      skipped,
      failed,
      disputed,
      message,
      errors,
    });
  } catch (err) {
    console.error("[Finance] sync escrow:", err?.message || err);
    return res.status(500).json({ error: "Đồng bộ đối soát thất bại" });
  } finally {
    syncInFlight = false;
  }
}
