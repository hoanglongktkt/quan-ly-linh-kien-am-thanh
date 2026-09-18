import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { resolveAppRoot } from "../utils/appPaths.js";
import AddressBook from "../models/AddressBook.js";

const FILE_PATH = path.join(resolveAppRoot(), "data", "address_book.json");
const MAX_ENTRIES = 200;
const RANKING_MAX = 500;

function readBook() {
  try {
    if (!fs.existsSync(FILE_PATH)) return [];
    const raw = fs.readFileSync(FILE_PATH, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeBook(list) {
  const dir = path.dirname(FILE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE_PATH, JSON.stringify(list, null, 2), "utf-8");
}

function mongoReady() {
  return mongoose.connection?.readyState === 1;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeEntry(entry) {
  const name = String(entry?.name || "").trim();
  const phone = normalizePhone(entry?.phone);
  const street = String(entry?.street || entry?.address || "").trim();
  const province = String(entry?.province || entry?.provinceName || "").trim();
  const provinceName = String(entry?.provinceName || entry?.province || "").trim();
  const provinceCode = String(entry?.provinceCode || "").trim();
  const district = String(entry?.district || entry?.districtName || "").trim();
  const districtName = String(entry?.districtName || entry?.district || "").trim();
  const districtCode = String(entry?.districtCode || "").trim();
  const ward = String(entry?.ward || entry?.wardName || "").trim();
  const wardName = String(entry?.wardName || entry?.ward || "").trim();
  const wardCode = String(entry?.wardCode || "").trim();
  const fullAddress = String(
    entry?.fullAddress ||
      [street, wardName || ward, districtName || district, provinceName || province]
        .filter(Boolean)
        .join(", "),
  ).trim();
  const addressMode = entry?.addressMode === "old3" ? "old3" : "new2";
  return {
    name,
    phone,
    street,
    address: street,
    province,
    provinceName,
    provinceCode,
    district,
    districtName,
    districtCode,
    ward,
    wardName,
    wardCode,
    fullAddress,
    addressMode,
  };
}

function toPublicEntry(doc) {
  const o = doc && typeof doc.toObject === "function" ? doc.toObject() : doc || {};
  const id = String(o.id || o._id || "");
  const street = String(o.street || o.address || "").trim();
  const lastPurchase = o.last_purchase_date ? new Date(o.last_purchase_date) : null;
  return {
    id,
    name: String(o.name || "").trim(),
    phone: normalizePhone(o.phone),
    street,
    address: street,
    province: String(o.province || o.provinceName || "").trim(),
    provinceName: String(o.provinceName || o.province || "").trim(),
    provinceCode: String(o.provinceCode || "").trim(),
    district: String(o.district || o.districtName || "").trim(),
    districtName: String(o.districtName || o.district || "").trim(),
    districtCode: String(o.districtCode || "").trim(),
    ward: String(o.ward || o.wardName || "").trim(),
    wardName: String(o.wardName || o.ward || "").trim(),
    wardCode: String(o.wardCode || "").trim(),
    fullAddress: String(o.fullAddress || "").trim(),
    addressMode: o.addressMode === "old3" ? "old3" : "new2",
    savedAt: o.savedAt ? new Date(o.savedAt).toISOString() : new Date().toISOString(),
    total_orders: Math.max(0, Math.round(Number(o.total_orders) || 0)),
    total_spent: Math.max(0, Math.round(Number(o.total_spent) || 0)),
    last_purchase_date: lastPurchase && !Number.isNaN(lastPurchase.getTime())
      ? lastPurchase.toISOString()
      : null,
  };
}

function matchesPurchasePeriod(entry, month, year) {
  if (!year) return true;
  const raw = entry?.last_purchase_date;
  if (!raw) return false;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return false;
  if (d.getFullYear() !== year) return false;
  if (month >= 1 && month <= 12 && d.getMonth() + 1 !== month) return false;
  return true;
}

function buildPurchaseDateFilter(month, year) {
  if (!year || !Number.isFinite(year)) return null;
  if (month >= 1 && month <= 12) {
    const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
    const end = new Date(year, month, 1, 0, 0, 0, 0);
    return { $gte: start, $lt: end };
  }
  const start = new Date(year, 0, 1, 0, 0, 0, 0);
  const end = new Date(year + 1, 0, 1, 0, 0, 0, 0);
  return { $gte: start, $lt: end };
}

async function trimMongoBook() {
  const extra = await AddressBook.find({})
    .sort({ savedAt: -1 })
    .skip(MAX_ENTRIES)
    .select("_id")
    .limit(80)
    .lean();
  if (!extra.length) return;
  const ids = extra.map((row) => row._id);
  await AddressBook.deleteMany({ _id: { $in: ids } });
}

function saveToJsonFile(normalized) {
  const list = readBook();
  const next = {
    id: `addr-${Date.now()}`,
    savedAt: new Date().toISOString(),
    total_orders: 0,
    total_spent: 0,
    last_purchase_date: null,
    ...normalized,
  };
  const deduped = list.filter(
    (item) =>
      !(
        normalizePhone(item.phone) === next.phone &&
        item.street === next.street &&
        String(item.wardCode || "") === next.wardCode
      ),
  );
  const merged = [next, ...deduped].slice(0, MAX_ENTRIES);
  writeBook(merged);
  return next;
}

export async function listAddressBookEntries() {
  if (mongoReady()) {
    const rows = await AddressBook.find({}).sort({ savedAt: -1 }).limit(MAX_ENTRIES).lean();
    return rows.map(toPublicEntry);
  }
  return readBook().map(toPublicEntry);
}

/**
 * VIP ranking — sort total_spent DESC, optional filter theo tháng/năm mua cuối.
 */
export async function listAddressBookRanking(options = {}) {
  const year = options.year != null && options.year !== "" ? Number(options.year) : null;
  const month = options.month != null && options.month !== "" ? Number(options.month) : null;
  const limit = Math.min(
    RANKING_MAX,
    Math.max(1, Math.round(Number(options.limit) || RANKING_MAX)),
  );
  const y = Number.isFinite(year) && year >= 2000 && year <= 2100 ? year : null;
  const m = Number.isFinite(month) && month >= 1 && month <= 12 ? month : null;

  if (mongoReady()) {
    const filter = {};
    const dateRange = buildPurchaseDateFilter(m, y);
    if (dateRange) {
      filter.last_purchase_date = dateRange;
    }
    const rows = await AddressBook.find(filter)
      .sort({ total_spent: -1, total_orders: -1, last_purchase_date: -1 })
      .limit(limit)
      .lean();
    return rows.map(toPublicEntry);
  }

  const list = readBook()
    .map(toPublicEntry)
    .filter((row) => matchesPurchasePeriod(row, m, y))
    .sort((a, b) => {
      const spentDiff = (b.total_spent || 0) - (a.total_spent || 0);
      if (spentDiff !== 0) return spentDiff;
      return (b.total_orders || 0) - (a.total_orders || 0);
    })
    .slice(0, limit);
  return list;
}

export async function saveAddressBookEntry(entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized.phone && !normalized.name) {
    throw new Error("Thiếu tên hoặc số điện thoại để lưu sổ địa chỉ.");
  }

  if (mongoReady()) {
    const filter = {
      phone: normalized.phone,
      street: normalized.street,
      wardCode: normalized.wardCode,
    };
    const saved = await AddressBook.findOneAndUpdate(
      filter,
      {
        $set: {
          ...normalized,
          savedAt: new Date(),
        },
        $setOnInsert: {
          id: `addr-${Date.now()}`,
          total_orders: 0,
          total_spent: 0,
          last_purchase_date: null,
        },
      },
      { new: true, upsert: true },
    );
    await trimMongoBook();
    return toPublicEntry(saved);
  }

  return saveToJsonFile(normalized);
}

/**
 * UPSERT loyalty theo SĐT sau khi tạo đơn POS thành công.
 * Có SĐT mới ghi sổ — bỏ qua khách không để số.
 */
export async function upsertLoyaltyFromPurchase({
  name = "",
  phone = "",
  address = "",
  fullAddress = "",
  totalAmount = 0,
} = {}) {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) return null;

  const amount = Math.max(0, Math.round(Number(totalAmount) || 0));
  const displayName = String(name || "").trim();
  const street = String(address || fullAddress || "").trim();
  const resolvedFull =
    String(fullAddress || address || "").trim() || street;
  const now = new Date();

  if (mongoReady()) {
    const existing = await AddressBook.findOne({ phone: phoneNorm })
      .sort({ total_spent: -1, savedAt: -1 });

    if (existing) {
      existing.total_orders = Math.max(0, Math.round(Number(existing.total_orders) || 0)) + 1;
      existing.total_spent = Math.max(0, Math.round(Number(existing.total_spent) || 0)) + amount;
      existing.last_purchase_date = now;
      existing.savedAt = now;
      if (displayName) existing.name = displayName;
      if (street && street !== "Mua tại cửa hàng") {
        existing.street = street;
        existing.address = street;
        existing.fullAddress = resolvedFull;
      }
      await existing.save();
      return toPublicEntry(existing);
    }

    const created = await AddressBook.create({
      id: `addr-${Date.now()}`,
      name: displayName || "Khách POS",
      phone: phoneNorm,
      street: street === "Mua tại cửa hàng" ? "" : street,
      address: street === "Mua tại cửa hàng" ? "" : street,
      fullAddress: resolvedFull === "Mua tại cửa hàng" ? "" : resolvedFull,
      province: "",
      provinceName: "",
      provinceCode: "",
      district: "",
      districtName: "",
      districtCode: "",
      ward: "",
      wardName: "",
      wardCode: "",
      addressMode: "new2",
      savedAt: now,
      total_orders: 1,
      total_spent: amount,
      last_purchase_date: now,
    });
    await trimMongoBook();
    return toPublicEntry(created);
  }

  const list = readBook();
  const idx = list.findIndex((item) => normalizePhone(item.phone) === phoneNorm);
  if (idx >= 0) {
    const cur = list[idx];
    const updated = {
      ...cur,
      name: displayName || cur.name || "Khách POS",
      phone: phoneNorm,
      total_orders: Math.max(0, Math.round(Number(cur.total_orders) || 0)) + 1,
      total_spent: Math.max(0, Math.round(Number(cur.total_spent) || 0)) + amount,
      last_purchase_date: now.toISOString(),
      savedAt: now.toISOString(),
    };
    if (street && street !== "Mua tại cửa hàng") {
      updated.street = street;
      updated.address = street;
      updated.fullAddress = resolvedFull;
    }
    list[idx] = updated;
    writeBook(list.slice(0, MAX_ENTRIES));
    return toPublicEntry(updated);
  }

  const next = {
    id: `addr-${Date.now()}`,
    name: displayName || "Khách POS",
    phone: phoneNorm,
    street: street === "Mua tại cửa hàng" ? "" : street,
    address: street === "Mua tại cửa hàng" ? "" : street,
    fullAddress: resolvedFull === "Mua tại cửa hàng" ? "" : resolvedFull,
    province: "",
    provinceName: "",
    provinceCode: "",
    district: "",
    districtName: "",
    districtCode: "",
    ward: "",
    wardName: "",
    wardCode: "",
    addressMode: "new2",
    savedAt: now.toISOString(),
    total_orders: 1,
    total_spent: amount,
    last_purchase_date: now.toISOString(),
  };
  writeBook([next, ...list].slice(0, MAX_ENTRIES));
  return toPublicEntry(next);
}
