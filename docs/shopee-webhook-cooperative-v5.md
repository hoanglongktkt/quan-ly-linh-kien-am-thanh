# Bản 5: đồng bộ tự động nhường lượt cho webhook

## Bằng chứng

Hai mẫu v4 lúc 19:40 và 19:41 ngày 21/10/2026 giờ Việt Nam xác nhận worker v4
đã chạy và một lượt sync hoàn tất lúc 19:39:32 sau khoảng 25,6 giây.
Tuy nhiên, lượt sync cứu hộ tiếp theo giữ khóa chung từ 43 lên 122 giây.
Webhook mới nhận lúc 19:41:19 đang chờ trong khi lượt sync đó tiếp tục chạy.

Tăng priority chỉ tác động tới job chưa được lấy; không ngắt job đang chạy.
Vì vậy một worker có thể còn tài nguyên nhưng vẫn để đơn mới chờ phút.
Không có bằng chứng truy vấn claim chậm: các mẫu đều dùng index, khoảng 0 ms.
Mẫu webhook 235,6 giây đã kết thúc lúc 19:38, không phải lượt sync đang chạy.
Các thống kê cửa sổ 15 phút vẫn trộn job cũ và mới sau restart.

## Thay đổi

- Đồng bộ tự động/cứu hộ kiểm tra webhook đang chờ trước trang get_order_list,
  giữa các shop/lô chi tiết, trước khi lưu lô và giữa các lô đối soát đơn đang hoạt động.
- Khi cần nhường, kết thúc lượt xử lý tại điểm kiểm tra, giải phóng mutex pull,
  trả chính job sync về pending và giữ active_key/retry_count. Worker lấy webhook
  trước rồi chạy lại job sync từ mốc đồng bộ thành công gần nhất.
- Không ngắt một thao tác ghi đơn/hoàn tồn đang chạy. Không mở worker thứ hai.
  Các lô đã ghi được giữ lại; việc đọc/ghi lại dùng identity và watermark như trước.
- Lượt sync chưa hoàn tất do nhường không được nâng watermark. Bản ghi audit
  cho lần xử lý dở có thể ghi failed với metrics.yielded=true; job hàng đợi vẫn pending,
  không phải lỗi retry. Khi hết thời gian job, checkpoint/API kế tiếp chặn công việc cũ tiếp tục.
- Lượt tăng dần tự động/cứu hộ chỉ quét cửa sổ gần đây, không ghép thêm các đợt
  quét lịch sử CANCELLED/SHIPPED/COMPLETED/return và sửa gán shop nhiều ngày.
  Đối soát các đơn đang hoạt động của cron vẫn giữ nguyên. Đồng bộ đầy đủ/thủ công
  và tác vụ trả hàng riêng vẫn giữ đường quét lịch sử của chúng.
- HTTP trong lượt tự động: một attempt, tối đa 15 giây/request; lỗi thực sự dùng
  retry của hàng đợi. Driver deadline cho identity/ghi đơn/metadata và audit của
  lượt tự động được giới hạn. Đồng bộ đầy đủ/thủ công giữ HTTP retry cũ.
- Đồng bộ đầy đủ/nhanh thủ công và các job mode=task chưa dùng cơ chế nhường này.
  Không cam kết đơn hiển thị trong một số giây cố định khi API, Mongo hoặc tác vụ khác chậm.
- Ghi stage cho sync: api_get_order_list, api_get_order_detail, db_order_bulk_write,
  sync_read_active_orders, sync_check_webhooks, sync_audit_start... Không ghi URL ký/token.

## Kiểm chứng cục bộ

52 kiểm thử đạt, gồm nhường khi webhook đến giữa một lượt sync, chạy lại cùng job
không tăng retry, không chạy chồng, phát tín hiệu qua phân trang thật, chặn worker
đã hết thời gian gọi thêm API, HTTP body timeout và bảo toàn các cờ/sản phẩm đơn hàng.
TypeScript và build thành công. Các kiểm thử này không thay thế số đo cPanel thực tế.

## Cài đặt và đo

1. Giữ server.cjs hiện tại để khôi phục.
2. Chép đè server.cjs và measure-shopee-queue.mjs trong gói v5 vào Application root.
3. Restart Node.js App một lần; không cần npm install, sửa .env hoặc cập nhật Vercel.
4. Sau khoảng 2 phút, chạy `node measure-shopee-queue.mjs 15`, rồi chạy lại cách khoảng 60 giây.
5. DiagnosticVersion phải bằng 5; workerRevision/worker_revision của job mới phải bằng 5.
   currentWorkerProcessingMs chỉ tính webhook thành công do worker 5 xử lý, không tính
   các lượt thất bại/worker cũ. Nếu chưa có mẫu mới, số liệu sẽ null.

Để kiểm tra mục tiêu nhận đơn mới, cần một webhook mới phát sinh sau khi cài.
Nếu chỉ có backlog cũ, không thể kết luận độ trễ nhận đơn mới từ queueWait cũ.
Theo dõi thời điểm nhận/bắt đầu của webhook mới, lastSucceeded, watermark và lỗi mới.
Không xóa đơn, khóa hoặc backlog để áp dụng bản này. Có thể khôi phục server.cjs cũ rồi restart.
