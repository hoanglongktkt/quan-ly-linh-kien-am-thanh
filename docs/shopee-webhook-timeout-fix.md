# Sửa timeout và đường xử lý webhook — bản 3, ngày 21/10/2026

## Bằng chứng từ cPanel

Hai mẫu lúc 08:11 và 08:13 giờ Việt Nam cho thấy truy vấn claim dùng IXSCAN,
không COLLSCAN, đọc khoảng 76–77 document, executionTimeMillis=0.
Thiếu index đúng tên/cấu hình mong đợi chưa giải thích được độ trễ hàng phút này.

Job webhook bắt đầu 01:09:27 UTC; job kế tiếp bắt đầu 01:13:27 UTC,
đồng thời số failed tăng. Điều này rất khớp với ngưỡng timeout job 4 phút.
Heartbeat vẫn tiến, vì vậy khóa không bị bỏ quên. Chưa xác định được bước cụ thể
đang chờ trên production chỉ bằng hai mẫu này.

lastSucceeded vẫn là 01:05:24 UTC ở cả hai mẫu. Các summary theo cửa sổ 15 phút
lọc bằng createdAt của job; job tạo từ trước cửa sổ vẫn có thể đang được xử lý,
nên null không chứng minh worker đã ngừng hoàn toàn.

## Thay đổi

- Deadline HTTP bao gồm cả đọc body sau khi nhận header; hủy request thực tế khi
  hết hạn. Áp dụng text/json/arrayBuffer/blob/formData/bytes, gồm phản hồi OAuth.
- Trong worker webhook: tối đa 15 giây mỗi request HTTP, một lần gọi ở tầng HTTP;
  lỗi được trả về hàng đợi retry. Đồng bộ thông thường giữ cơ chế HTTP retry cũ.
  Đây không phải giới hạn 15 giây cho toàn bộ job hoặc các thao tác Mongo.
- Đường lấy chi tiết dành cho webhook không tự fallback gọi lại từng đơn,
  dò shop khác, hoặc retry rate limit trong cùng lượt. Token không hợp lệ vẫn
  có một lần refresh/retry được kiểm soát ở controller.
- Nếu lấy chi tiết lỗi: lưu đơn tối thiểu, không kéo thêm tracking/escrow ở
  shallow fallback. Chi tiết và dữ liệu bổ sung sẽ được retry/đồng bộ sau.
- Webhook nhận trong 2 phút gần nhất được lấy trước backlog cũ. Vẫn có khóa chung
  và claim nguyên tử, không tăng số worker. Job đang chạy vẫn phải kết thúc trước.
- Log stage_start/stage_end và lưu bước đang chạy vào heartbeat khoảng 30 giây/lần.
  File đo v3 hiển thị processingStage và stageAgeMs để phân biệt load_order,
  resolve_auth, refresh_auth, fetch_order_detail, persist_detail, persist_shallow,
  persist_push, fetch_tracking và return_fallback.

Không tạo index mới, không tăng pool Mongo, không thay đổi dữ liệu đơn bằng script đo.
Các thay đổi này sửa những đường chờ dài đã tìm thấy trong mã; hiệu quả thực tế
và bước chậm còn lại cần xác nhận bằng mẫu mới từ cPanel.

## Cài trên cPanel

1. Giữ một bản server.cjs đang chạy để khôi phục nếu cần.
2. Giải nén gói mới; copy đè hai file server.cjs và measure-shopee-queue.mjs
   vào cùng thư mục ứng dụng trên cPanel.
3. Restart Node.js App một lần. Không cần cài thêm npm package hoặc đổi Vercel.
4. Sau khoảng 2 phút, chạy `node measure-shopee-queue.mjs 15`.
   Chạy thêm một lần cách khoảng 60 giây và gửi hai kết quả.
5. Nếu có lỗi: đối chiếu log stage_start mà chưa có stage_end, cùng processingStage
   trong runningJobs. Không chỉ nhìn queue giảm: lastSucceeded cần tiến và failed
   không tăng liên tục. Các job chờ/retry có thể bị cơ chế dọn backlog cũ xử lý.

Nếu cần khôi phục, chép lại server.cjs đã giữ và restart; công cụ đo chỉ đọc vẫn dùng được.
