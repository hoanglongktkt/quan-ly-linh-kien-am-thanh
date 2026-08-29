/**
 * System / one-shot maintenance endpoints (cPanel — không cần terminal).
 */
import { isMongoReady, ensureScannerIndexesInStore } from "../src/db/mongoStore.ts";

/**
 * GET /api/system/setup-indexes
 * Đồng bộ compound index scanner trên collection orders (OrderModel.syncIndexes).
 * Truy cập trình duyệt: https://your-domain/api/system/setup-indexes
 * Sau khi chạy xong — xóa route này để bảo mật.
 */
export async function setupScannerIndexes(_req, res) {
  try {
    if (!isMongoReady()) {
      return res.status(503).json({
        success: false,
        error: "mongodb_not_ready",
        message:
          "MongoDB chưa kết nối. Kiểm tra MONGODB_URI trong .env rồi restart Node trên cPanel.",
      });
    }

    const result = await ensureScannerIndexesInStore();

    return res.status(result.success ? 200 : 207).json({
      success: result.success,
      message: result.success
        ? "Đã tạo/đồng bộ index scanner thành công trên collection orders."
        : "syncIndexes đã chạy nhưng một số index scanner chưa thấy — xem chi tiết scannerIndexes.",
      syncResult: result.syncResult,
      scannerIndexes: result.scannerIndexes,
      lookupIndexes: result.lookupIndexes,
      totalIndexes: result.totalIndexes,
      allIndexNames: result.allIndexNames,
      ranAt: new Date().toISOString(),
      hint: "Sau khi index OK, hãy xóa route GET /api/system/setup-indexes khỏi server để bảo mật.",
    });
  } catch (error) {
    console.error("[Setup Scanner Indexes] API error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "setup_indexes_failed",
      message: error?.message || "Không thể tạo index MongoDB.",
    });
  }
}
