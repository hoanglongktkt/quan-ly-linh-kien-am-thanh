import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import OrderDraft from "../models/OrderDraft.js";

const text = (v, max = 1000) => String(v ?? "").trim().slice(0, max);
const DATE_INPUT = /^\d{4}-\d{2}-\d{2}$/;
function vietnamDateBoundary(value, end = false) {
  if (!value) return null;
  if (!DATE_INPUT.test(String(value))) throw new Error("Ngày lọc không hợp lệ. Dùng định dạng YYYY-MM-DD.");
  const [year, month, day] = String(value).split("-").map(Number);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  if (localDate.getUTCFullYear() !== year || localDate.getUTCMonth() !== month - 1 || localDate.getUTCDate() !== day) {
    throw new Error("Ngày lọc không tồn tại.");
  }
  if (end) localDate.setUTCDate(localDate.getUTCDate() + 1);
  return new Date(localDate.getTime() - 7 * 60 * 60 * 1000);
}
const money = (v) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new Error("Số tiền không hợp lệ.");
  return Math.round(n);
};
const publicDraft = (doc) => {
  const d = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const { _id, __v, result, ...rest } = d;
  return { ...rest, id: _id };
};
function ready(res) {
  if (mongoose.connection.readyState === 1) return true;
  res.status(503).json({ success: false, error: "Chưa kết nối cơ sở dữ liệu. Đơn nháp chưa được lưu, vui lòng thử lại." });
  return false;
}

export function normalizeDraft(body) {
  if (!["pos", "manual"].includes(body.kind)) throw new Error("Loại đơn nháp không hợp lệ.");
  const p = body.payload || {};
  if (!Array.isArray(p.items) || !p.items.length || p.items.length > 80) {
    throw new Error("Đơn nháp cần từ 1 đến 80 dòng sản phẩm.");
  }
  const payload = {};
  for (const k of ["customerName", "customerPhone", "customerAddress", "note", "carrier", "ghnShopId", "shopId", "carrierNotes", "shippingFeePayer", "addressMode"]) {
    if (p[k] != null) payload[k] = text(p[k]);
  }
  for (const k of ["shippingFee", "prepaidAmount", "orderDiscount", "packageWeight", "packageLength", "packageWidth", "packageHeight"]) {
    if (p[k] != null) payload[k] = money(p[k]);
  }
  for (const k of ["walk_in", "save_to_address_book", "allowInspect", "partialDelivery"]) {
    if (p[k] != null) payload[k] = p[k] === true;
  }
  if (p.shippingAddress && typeof p.shippingAddress === "object") {
    payload.shippingAddress = {};
    for (const k of ["name", "phone", "province", "provinceCode", "district", "districtCode", "ward", "wardCode", "street", "addressMode"]) {
      payload.shippingAddress[k] = text(p.shippingAddress[k]);
    }
  }
  payload.items = p.items.map((it) => {
    const quantity = Number(it.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1e6) throw new Error("Số lượng sản phẩm không hợp lệ.");
    if (!text(it.productId) || !text(it.productTitle)) throw new Error("Sản phẩm cần mã và tên.");
    return {
      productId: text(it.productId), productTitle: text(it.productTitle), sku: text(it.sku),
      productImage: text(it.productImage, 4000), quantity,
      price: money(it.price ?? it.sellingPrice), sellingPrice: money(it.price ?? it.sellingPrice),
      importPrice: money(it.importPrice), weightGrams: money(it.weightGrams ?? 100),
      isCustom: it.isCustom === true,
    };
  });
  const storeInfo = {};
  for (const k of ["storeName", "storePhone", "storeAddress", "logoUrl"]) storeInfo[k] = text(body.storeInfo?.[k], 4000);
  // The structured-address UI uses provinceName/wardName; keep its selection intact.
  const formState = {};
  if (body.formState?.shippingAddress) {
    formState.shippingAddress = {};
    for (const k of ["name", "phone", "provinceName", "provinceCode", "districtName", "districtCode", "wardName", "wardCode", "street", "addressMode"]) {
      formState.shippingAddress[k] = text(body.formState.shippingAddress[k]);
    }
    formState.shippingAddress.saveToAddressBook = body.formState.shippingAddress.saveToAddressBook === true;
  }
  return { kind: body.kind, payload, formState, storeInfo };
}

export async function listOrderDrafts(req, res) {
  if (!ready(res)) return;
  const page = Math.max(1, Math.min(100000, Math.floor(Number(req.query.page) || 1)));
  const limit = 30;
  const q = text(req.query.q, 100);
  const sortBy = ["createdAt", "updatedAt"].includes(req.query.sortBy) ? req.query.sortBy : "createdAt";
  const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;
  let createdFrom;
  let createdTo;
  try {
    createdFrom = vietnamDateBoundary(req.query.createdFrom);
    createdTo = vietnamDateBoundary(req.query.createdTo, true);
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
  if (createdFrom && createdTo && createdFrom >= createdTo) {
    return res.status(400).json({ success: false, error: "Khoảng ngày lọc không hợp lệ." });
  }
  const filter = { state: "draft" };
  if (createdFrom || createdTo) {
    filter.createdAt = {};
    if (createdFrom) filter.createdAt.$gte = createdFrom;
    if (createdTo) filter.createdAt.$lt = createdTo;
  }
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = ["number", "payload.customerName", "payload.customerPhone", "payload.items.productTitle", "payload.items.sku"].map((k) => ({ [k]: re }));
  }
  const sort = { [sortBy]: sortOrder, _id: sortOrder };
  const [rows, total] = await Promise.all([
    OrderDraft.find(filter).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    OrderDraft.countDocuments(filter),
  ]);
  return res.json({ success: true, drafts: rows.map(publicDraft), total, page, limit, sortBy, sortOrder: sortOrder === 1 ? "asc" : "desc" });
}

export async function saveOrderDraft(req, res) {
  if (!ready(res)) return;
  let data;
  try { data = normalizeDraft(req.body || {}); }
  catch (error) { return res.status(400).json({ success: false, error: error.message }); }
  const id = text(req.params.id || req.body.id || randomUUID(), 100);
  if (!/^[a-zA-Z0-9-]{10,100}$/.test(id)) return res.status(400).json({ success: false, error: "Mã nháp không hợp lệ." });
  try {
    if (!req.params.id) {
      const doc = await OrderDraft.create({ ...data, _id: id, number: `BG-${id.slice(0, 8).toUpperCase()}`, state: "draft", version: 1 });
      return res.json({ success: true, draft: publicDraft(doc) });
    }
    const doc = await OrderDraft.findOneAndUpdate(
      { _id: id, state: "draft", version: Number(req.body.version), kind: data.kind },
      { $set: data, $inc: { version: 1 } }, { new: true, runValidators: true },
    ).lean();
    if (!doc) return res.status(409).json({ success: false, error: "Đơn nháp đã thay đổi hoặc đã chuyển thành đơn chính thức. Hãy mở lại từ tab Đơn nháp." });
    return res.json({ success: true, draft: publicDraft(doc) });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, error: "Đơn nháp đã được lưu. Hãy mở lại từ tab Đơn nháp để tiếp tục." });
    throw error;
  }
}

export async function deleteOrderDraft(req, res) {
  if (!ready(res)) return;
  const result = await OrderDraft.deleteOne({ _id: req.params.id, state: "draft", version: Number(req.query.version) });
  if (!result.deletedCount) return res.status(409).json({ success: false, error: "Đơn nháp đã thay đổi. Vui lòng tải lại danh sách." });
  return res.json({ success: true });
}

// Atomically reserve a draft before invoking the existing checkout. Repeated clicks,
// multiple browser tabs and retries after a lost response cannot create a second sale.
export function withOrderDraft(handler, kind, model = OrderDraft) {
  return async (req, res) => {
    if (!req.body?.draftId) return handler(req, res);
    if (!ready(res)) return;
    const id = text(req.body.draftId, 100);
    const version = Number(req.body.draftVersion);
    const claimed = await model.findOneAndUpdate(
      { _id: id, state: "draft", kind, version },
      { $set: { state: "converting" } }, { new: true },
    ).lean();
    if (!claimed) {
      const previous = await model.findById(id).lean();
      if (previous?.state === "converted" && previous.kind === kind && previous.result) {
        return res.json({ ...previous.result, draftReplay: true });
      }
      return res.status(409).json({ success: false, error: "Đơn nháp đã thay đổi hoặc đang được tạo đơn. Hãy tải lại danh sách đơn để kiểm tra trước khi thao tác tiếp." });
    }
    const originalJson = res.json.bind(res);
    let responseTask;
    res.json = (body) => {
      if (responseTask) return res;
      const status = res.statusCode;
      responseTask = (async () => {
        try {
          if (body?.success === true && body.order?.id) {
            const updated = await model.updateOne({ _id: id, state: "converting" }, { $set: { state: "converted", result: body } });
            if (updated.matchedCount !== 1) throw new Error("draft_conversion_state_lost");
          } else if (status < 500) {
            await model.updateOne({ _id: id, state: "converting" }, { $set: { state: "draft" } });
          }
          // On uncertain server failures keep the reservation, preventing duplicate
          // stock deductions / carrier orders. Do not silently retry a checkout.
          res.status(status);
          originalJson(body);
        } catch (error) {
          console.error("[Order draft] finalize:", error.message);
          res.status(503);
          originalJson({ success: false, error: "Chưa xác minh được kết quả tạo đơn. Hãy kiểm tra danh sách đơn chính thức trước khi tạo lại." });
        }
      })();
      return res;
    };
    try {
      await handler(req, res);
      if (responseTask) await responseTask;
    } finally {
      res.json = originalJson;
    }
  };
}
