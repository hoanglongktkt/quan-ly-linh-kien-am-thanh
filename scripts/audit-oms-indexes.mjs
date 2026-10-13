import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { auditOmsIndexes } from "../modules/operations/indexAudit.js";

// DNS/Atlas có thể treo trước timeout driver; giới hạn công cụ chỉ đọc trong 45 giây.
const deadline = setTimeout(() => {
  console.error("OMS index audit timed out; chưa có kết quả explain thực tế.");
  process.exit(1);
}, 45000);
deadline.unref();
try {
  // Không nhận cờ apply: công cụ này chỉ liệt kê index và chạy explain thật.
  if (process.argv.length > 2) throw new Error("invalid_arguments");
  await connectDB();
  const report = await auditOmsIndexes(mongoose.connection.db);
  console.log(JSON.stringify(report, null, 2));
  if (report.queries.some((query) => query.error)) process.exitCode = 1;
} catch {
  // Không in URI/mật khẩu trong lỗi kết nối Mongo.
  console.error("OMS index audit failed; kiểm tra cấu hình MongoDB và quyền đọc/explain.");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
  clearTimeout(deadline);
}
