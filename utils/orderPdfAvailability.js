/**
 * Kiểm tra PDF vận đơn trên ổ đĩa — chỉ dùng luồng in, không gọi trong list orders.
 */
import fs from "fs";
import path from "path";
import { PDF_DIR } from "./appPaths.js";

/** Trạng thái PDF phải phản ánh file thật trên ổ đĩa, không chỉ cờ Mongo cũ. */
export function hasOrderPdfOnDisk(order) {
  const filenames = new Set();
  const addFilename = (raw) => {
    if (!raw) return;
    let value = String(raw).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* giữ nguyên giá trị nếu URL encode không hợp lệ */
    }
    const fromUrl = value.match(/\/api\/public\/labels\/([^/?#]+)/i)?.[1];
    const filename = path.basename(fromUrl || value);
    if (/\.pdf$/i.test(filename)) filenames.add(filename);
  };

  addFilename(order?.pdfFilename);
  addFilename(order?.data?.pdfFilename);
  addFilename(order?.labelUrl);
  addFilename(order?.pdfUrl);
  addFilename(order?.waybill_url);
  addFilename(order?.data?.labelUrl);
  addFilename(order?.data?.pdfUrl);
  addFilename(order?.data?.waybill_url);

  const orderSn = String(order?.orderSn || order?.id || "")
    .replace(/^shopee-/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "");
  if (orderSn) {
    filenames.add(`order_${orderSn}.pdf`);
    filenames.add(`${orderSn}.pdf`);
  }

  for (const filename of filenames) {
    if (fs.existsSync(path.join(PDF_DIR, filename))) return true;
  }
  return false;
}

export function attachPdfAvailability(orders) {
  if (!Array.isArray(orders)) return [];
  return orders.map((order) => ({
    ...order,
    hasPdf: hasOrderPdfOnDisk(order),
  }));
}
