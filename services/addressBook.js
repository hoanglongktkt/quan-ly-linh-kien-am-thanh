import fs from "fs";
import path from "path";
import { resolveAppRoot } from "../utils/appPaths.js";

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

export function saveAddressBookEntry(entry) {
  const list = readBook();
  const phone = String(entry?.phone || "").replace(/\D/g, "");
  const next = {
    id: `addr-${Date.now()}`,
    savedAt: new Date().toISOString(),
    name: String(entry?.name || "").trim(),
    phone,
    province: String(entry?.province || "").trim(),
    provinceCode: String(entry?.provinceCode || "").trim(),
    district: String(entry?.district || "").trim(),
    districtCode: String(entry?.districtCode || "").trim(),
    ward: String(entry?.ward || "").trim(),
    wardCode: String(entry?.wardCode || "").trim(),
    street: String(entry?.street || "").trim(),
    fullAddress: String(entry?.fullAddress || "").trim(),
  };
  const deduped = list.filter(
    (item) =>
      !(
        String(item.phone || "").replace(/\D/g, "") === phone &&
        item.street === next.street &&
        item.wardCode === next.wardCode
      ),
  );
  const merged = [next, ...deduped].slice(0, MAX_ENTRIES);
  writeBook(merged);
  return next;
}
