# Shopee webhook: điều chỉnh hàng đợi ngày 21/10/2026

## Phạm vi

Giảm thời gian chờ giữa các job, không tăng số worker hoặc mức song song gọi API.
Giữ khóa Mongo dùng chung giữa các Passenger process, chống trùng job, retry và khóa theo đơn.

| Tham số | Nhịp trước sửa | Mặc định mới | Giới hạn cho phép |
| --- | --- | --- | --- |
| Kiểm tra hàng đợi dự phòng | 8.000 ms | 3.000 ms | 2.000–30.000 ms |
| Job mỗi lượt lấy khóa | 5 | 8 | 1–10 |
| Nghỉ giữa hai job | 400 ms | 150 ms | 100–2.000 ms |

Webhook đã lưu vẫn đánh thức worker ngay. Bổ sung nhớ yêu cầu đánh thức khi worker đang bận,
và đánh thức ngay khi thêm job đồng bộ. Không tạo timer hoặc worker cho từng shop.
Cron nhiều shop được xếp thành job riêng cho từng shop, chống trùng từng shop;
webhook mới có thể được lấy trước shop tiếp theo. Một lượt đang xử lý trong một shop
hoặc đồng bộ thủ công lớn vẫn phải kết thúc trước khi xử lý job khác.

Coordinator chỉ đảm bảo hai index của nó một lần trên mỗi DB handle, thay vì gọi createIndex
hai lần trên mỗi nhịp kiểm tra. Không thêm compound index hay thay pool Mongo.

## Kiểm chứng

- Kiểm thử OMS: 14/14; bao gồm ưu tiên webhook giữa hai shop, chống trùng, retry,
  khóa dùng chung và cache khởi tạo index.
- Backend modules: 6/6.
- Operations/observability: 12/12.
- npm run build thành công. Còn cảnh báo frontend về kích thước bundle/import đã có.
- Mô phỏng 12 webhook với Mongo giả, không gọi API: nhịp cũ 4.520 ms;
  nhịp mới khoảng 1.750–1.780 ms. Chỉ đo tác động của pacing hàng đợi;
  không phải bằng chứng đơn Shopee thực tế nhanh hơn từng ấy.
- Không đo được production: truy cập HTTPS từ môi trường làm việc thất bại;
  thử kết nối Mongo bị dừng ở hạn chẩn đoán 20 giây. Chưa có số đo CPU/RAM cPanel.

## Triển khai cPanel

Gói bàn giao chỉ gồm backend biên dịch, công cụ đo độc lập và hướng dẫn này.
Backend là bản build từ cây mã hiện tại, bao gồm các sửa đang có sẵn trong workspace.
Không có .env, dữ liệu đơn, database hoặc token trong gói triển khai.

1. Giữ một bản sao server.cjs cũ để khôi phục.
2. Copy measure-shopee-queue.mjs vào thư mục ứng dụng và chạy trong môi trường Node
   của ứng dụng cPanel: `node measure-shopee-queue.mjs 15`.
   Lưu kết quả trước thay đổi. Script cần cùng MONGODB_URI và database với ứng dụng;
   nó đọc .env nếu có, hoặc biến môi trường đã thiết lập trong terminal.
3. Copy đè server.cjs mới vào Application root; Startup file vẫn là server.cjs.
4. Restart Node.js App. Không cần npm install, đổi .htaccess hay cập nhật Vercel cho bản sửa này.
5. Mặc định mới có sẵn trong mã. Nếu đã có các biến tương ứng trong cPanel, kiểm tra chúng:
   SHOPEE_WEBHOOK_DRAIN_INTERVAL_MS=3000,
   SHOPEE_WEBHOOK_BATCH_LIMIT=8,
   SHOPEE_WEBHOOK_JOB_GAP_MS=150.
6. Sau ít nhất 15 phút có phát sinh đơn, chạy lại `node measure-shopee-queue.mjs 15`.
   So sánh thời điểm có lượng đơn tương đương; xem CPU/RAM/Resource Usage trong cPanel,
   queue waiting, retry và thời gian chờ/xử lý. Không dùng cửa sổ chứa cả trước và sau restart
   để kết luận tốc độ đã cải thiện. Khi không có mẫu, số đo là null.

Script chỉ đọc, tối đa hai kết nối Mongo, truy vấn có thời hạn, tối đa 200 webhook gần nhất.
Không gọi Shopee, đọc payload khách hàng, tạo index hay thay đổi dữ liệu.
started_at mới có sau bản sửa; các bản ghi cũ thiếu mốc này không được tính vào
thời gian chờ/xử lý. firstOrderPersist có thể là đơn tối thiểu, chưa đủ chi tiết sản phẩm.
Tốc độ Shopee gửi webhook và độ trễ hiển thị ở trình duyệt không nằm trong phép đo này.

Log worker có dòng `[WebhookJobQueue] timing`: kind, outcome, queueWaitMs, processingMs.
queueWaitMs lớn trong lúc sync chạy cho biết đang phải chờ khóa; processingMs lớn
cần đối chiếu tiếp log API/Mongo, không tăng số worker một cách tự động.

Nếu tải tăng rõ, tăng SHOPEE_WEBHOOK_JOB_GAP_MS lên 400 và interval lên 8000,
batch xuống 5 rồi restart, hoặc khôi phục server.cjs cũ và restart.
Không chạy nhiều bản sao ứng dụng để cố tăng tốc.
