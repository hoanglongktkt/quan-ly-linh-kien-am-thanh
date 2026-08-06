import mongoose from "mongoose";

/**
 * SSOT duy nhất cho collection `don_hoan_huy` — đơn hủy/hoàn đã quét.
 * Mọi đọc/ghi (scanController, mongoStore upsert/load/exists, scan-bg, scan-bulk)
 * phải dùng model này — không định nghĩa schema trùng ở nơi khác.
 * TTL 14 ngày (1.209.600 giây) trên scannedAt.
 * NOTE: TTL ĐÃ BỊ VÔ HIỆU HÓA — xóa thủ công qua API /api/orders/batch-delete.
 */
const DonHoanHuySchema = new mongoose.Schema(
  {
    orderSn: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    status: {
      type: String,
      default: "scanned",
      trim: true,
    },
    scannedAt: {
      type: Date,
      default: Date.now,
      // TTL removed — xóa thủ công bằng API
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
    /** Shopee shop_id — String (uint64-safe), không lưu Number */
    shopId: {
      type: String,
      default: null,
      trim: true,
    },
    tracking_no: {
      type: String,
      default: null,
      trim: true,
    },
    return_tracking_no: {
      type: String,
      default: null,
      trim: true,
    },
    scan_code: {
      type: String,
      default: null,
      trim: true,
    },
    type: {
      type: String,
      default: null,
      trim: true,
    },
    local_status: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    collection: "don_hoan_huy",
    versionKey: false,
    strict: false, // giữ field legacy (local_status, type, ...) nếu đã có trên Atlas
  },
);

DonHoanHuySchema.index({ orderSn: 1 }, { unique: true, name: "don_hoan_huy_orderSn_unique" });
DonHoanHuySchema.index({ tracking_no: 1 }, { name: "don_hoan_huy_tracking_no" });
DonHoanHuySchema.index({ return_tracking_no: 1 }, { name: "don_hoan_huy_return_tracking_no" });
DonHoanHuySchema.index({ scan_code: 1 }, { name: "don_hoan_huy_scan_code" });
DonHoanHuySchema.index({ scannedAt: -1 }, { name: "don_hoan_huy_scannedAt" });
DonHoanHuySchema.index({ type: 1 }, { name: "don_hoan_huy_type" });
DonHoanHuySchema.index({ local_status: 1 }, { name: "don_hoan_huy_local_status" });

const DonHoanHuy =
  mongoose.models.DonHoanHuy || mongoose.model("DonHoanHuy", DonHoanHuySchema);

export default DonHoanHuy;
