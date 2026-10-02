import mongoose from "mongoose";
import { updateCustomerAddressByKey } from "../services/addressBook.js";

const ORDER_LIMIT = 40;
const PHONE_FIELDS = [
  "customerPhone",
  "data.customerPhone",
  "data.customer_phone",
  "data.recipient_address.phone",
  "data.recipient_address.phone_number",
  "data.billing.phone",
  "data.shipping.phone",
];

function phoneMatch(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 8) return null;
  const tail = digits.slice(-9);
  const exact = new Set([digits]);
  if (digits.startsWith("84") && digits.length >= 11) exact.add(`0${digits.slice(2)}`);
  if (digits.startsWith("0") && digits.length >= 10) exact.add(`84${digits.slice(1)}`);
  return { tail, exact: [...exact] };
}

function orderDateIso(doc) {
  const data = doc?.data && typeof doc.data === "object" ? doc.data : {};
  const raw = doc?.create_time || doc?.createdAt || data.create_time || data.date || null;
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  if (typeof raw === "number") {
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function productSummary(data) {
  const items =
    Array.isArray(data?.items) && data.items.length
      ? data.items
      : Array.isArray(data?.item_list)
        ? data.item_list
        : [];
  const names = [];
  const cap = Math.min(items.length, 8);
  for (let i = 0; i < cap; i += 1) {
    const row = items[i] || {};
    const name = String(
      row.item_name || row.productTitle || row.name || row.model_name || "Sản phẩm",
    ).trim();
    const qty = Math.max(
      1,
      Math.round(Number(row.model_quantity_purchased ?? row.quantity ?? row.qty ?? 1) || 1),
    );
    names.push(qty > 1 ? `${name} x${qty}` : name);
  }
  return names.join(", ") || "—";
}

function orderTotal(doc) {
  const data = doc?.data && typeof doc.data === "object" ? doc.data : {};
  const n = Number(
    data.total_amount ?? data.totalAmount ?? data.revenue ?? data.total ?? data.cod_amount ?? doc?.cod_amount ?? 0,
  );
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

/** PUT /api/customers/:id — body: { address, phone? } */
export async function updateCustomerAddress(req, res) {
  try {
    const entry = await updateCustomerAddressByKey({
      id: req.params?.id,
      phone: req.body?.phone,
      address: req.body?.address,
    });
    return res.json({ success: true, entry, message: "Đã cập nhật địa chỉ" });
  } catch (error) {
    console.error("[customers update]", error);
    const status = Number(error?.status) || 500;
    return res.status(status).json({
      success: false,
      error: error?.message || "Cập nhật địa chỉ thất bại",
    });
  }
}

/** GET /api/customers/:phone/orders */
export async function getCustomerOrderHistory(req, res) {
  try {
    if (mongoose.connection?.readyState !== 1) {
      return res.status(503).json({
        success: false,
        error: "Cơ sở dữ liệu chưa sẵn sàng",
        orders: [],
      });
    }
    const match = phoneMatch(req.params?.phone || req.query?.phone);
    if (!match) {
      return res.status(400).json({
        success: false,
        error: "Số điện thoại không hợp lệ",
        orders: [],
      });
    }
    const safeTail = match.tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const suffix = { $regex: `${safeTail}$` };
    const or = [];
    for (let i = 0; i < PHONE_FIELDS.length; i += 1) {
      const field = PHONE_FIELDS[i];
      or.push({ [field]: { $in: match.exact } });
      or.push({ [field]: suffix });
    }

    const rows = await mongoose.connection
      .collection("orders")
      .find(
        { $or: or },
        {
          projection: {
            orderSn: 1,
            create_time: 1,
            createdAt: 1,
            status: 1,
            shopee_order_status: 1,
            cod_amount: 1,
            "data.order_sn": 1,
            "data.orderSn": 1,
            "data.create_time": 1,
            "data.date": 1,
            "data.status": 1,
            "data.total_amount": 1,
            "data.totalAmount": 1,
            "data.revenue": 1,
            "data.total": 1,
            "data.cod_amount": 1,
            "data.items.item_name": 1,
            "data.items.productTitle": 1,
            "data.items.name": 1,
            "data.items.model_name": 1,
            "data.items.quantity": 1,
            "data.items.qty": 1,
            "data.item_list.item_name": 1,
            "data.item_list.model_name": 1,
            "data.item_list.model_quantity_purchased": 1,
          },
        },
      )
      .sort({ create_time: -1, createdAt: -1 })
      .limit(ORDER_LIMIT)
      .maxTimeMS(8000)
      .toArray();

    const orders = [];
    for (let i = 0; i < rows.length; i += 1) {
      const doc = rows[i];
      const data = doc?.data && typeof doc.data === "object" ? doc.data : {};
      orders.push({
        orderSn: String(doc.orderSn || data.order_sn || data.orderSn || "").trim() || "—",
        date: orderDateIso(doc),
        products: productSummary(data),
        total: orderTotal(doc),
        status: String(doc.shopee_order_status || doc.status || data.status || "").trim() || "—",
      });
    }

    return res.json({ success: true, orders });
  } catch (error) {
    console.error("[customers orders]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không tải được lịch sử đơn hàng",
      orders: [],
    });
  }
}
