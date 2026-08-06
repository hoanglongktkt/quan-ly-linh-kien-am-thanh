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
  },
  {
    collection: "don_hoan_huy",
    versionKey: false,
    strict: false, // giữ field legacy (local_status, type, ...) nếu đã có trên Atlas
  },
);

DonHoanHuySchema.index({ orderSn: 1 }, { unique: true, name: "don_hoan_huy_orderSn_unique" });

const DonHoanHuy =
  mongoose.models.DonHoanHuy || mongoose.model("DonHoanHuy", DonHoanHuySchema);

export default DonHoanHuy;
