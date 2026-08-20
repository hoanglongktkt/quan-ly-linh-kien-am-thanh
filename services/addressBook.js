import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { resolveAppRoot } from "../utils/appPaths.js";
import AddressBook from "../models/AddressBook.js";

const FILE_PATH = path.join(resolveAppRoot(), "data", "address_book.json");
const MAX_ENTRIES = 200;

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

function normalizeEntry(entry) {
  const name = String(entry?.name || "").trim();
  const phone = String(entry?.phone || "").replace(/\D/g, "");
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
  return {
    id,
    name: String(o.name || "").trim(),
    phone: String(o.phone || "").replace(/\D/g, ""),
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
  };
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
    ...normalized,
  };
  const deduped = list.filter(
    (item) =>
      !(
        String(item.phone || "").replace(/\D/g, "") === next.phone &&
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
        },
      },
      { new: true, upsert: true },
    );
    await trimMongoBook();
    return toPublicEntry(saved);
  }

  return saveToJsonFile(normalized);
}
