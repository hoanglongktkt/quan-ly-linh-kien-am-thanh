# Shopee webhook — sửa luồng lưu đơn, bản 4

## Bằng chứng ngày 21/10/2026

Hai mẫu cPanel lúc 19:17 và 19:19 giờ Việt Nam:

- Thời gian xử lý trung vị của các mẫu đã kết thúc: 1.422 ms.
- Thời gian chờ trung vị: khoảng 9 phút 39 giây.
- Job đang chạy ở persist_detail 118.627 ms trên tổng 119.252 ms. Phần lớn
  thời gian của job này nằm trong luồng lưu chi tiết; chưa biết thao tác con cụ thể.
- 54 job sync đang chờ/thất bại; watermark thành công cuối lúc 12:15 giờ Việt Nam.
- Truy vấn claim dùng index, không quét collection; executionTimeMillis=0.

Không suy ra CPU/RAM hosting thiếu hay thừa từ một lần ping. Không dùng các mẫu
khác thời điểm/lượng đơn để kết luận tỷ lệ cải thiện tốc độ trên production.

## Thay đổi

1. Gộp yêu cầu tạo orders.json: mỗi process tối đa một lượt đọc Mongo đang chạy,
   tối đa một lượt khởi động mỗi 30 giây. Những yêu cầu đến trong lúc đang đọc
   được gộp thành một lượt đọc tiếp để lấy trạng thái mới nhất.
   Trước đây mỗi lần lưu có thể khởi động một lượt đọc tối đa 2.000 đơn, không gộp.
   MongoDB vẫn được ghi ngay; chỉ bản sao JSON phụ có thể cập nhật chậm hơn.
2. Hàng ghi Mongo của process vẫn tuần tự, nhưng ưu tiên webhook và đơn tối thiểu
   trước tác vụ nền đang CHỜ. Không ngắt tác vụ đang chạy, không tăng số kết nối.
   Lượt ghi webhook chưa bắt đầu sau 15 giây bị hủy khỏi hàng, không thể ghi muộn.
   Timeout tác vụ đang chạy không tự mở hàng ghi cho thao tác khác chạy chồng.
3. Dùng lại ánh xạ shop+đơn sang _id đã lưu, kiểm tra đúng chủ đơn bằng _id.
   Không cập nhật lại mapping hoặc tìm theo điều kiện OR rộng trên mọi lần lưu.
   Đơn chưa có mapping vẫn có bước tìm bản ghi cũ, giữ _id cũ và xử lý đua tạo mapping.
4. Khi đã có _id xác thực, đọc và cập nhật theo _id, giữ nguyên điều kiện watermark,
   cờ kho, trạng thái chuẩn bị/in, tracking và bảo vệ danh sách sản phẩm.
5. Đặt timeoutMS 12 giây ở driver cho từng thao tác identity, ghi đơn và metadata
   trong ngữ cảnh webhook. Không chỉ Promise.race để giả vờ tác vụ đã dừng.
   Đây không phải cam kết toàn bộ job xong trong 12 giây.
6. Gộp job cứu hộ cùng shop/cùng phạm vi đang hoạt động; không tạo thêm một job
   cứu hộ mới cho mỗi đơn lỗi. Không tự xóa/gộp hồi tố các job cũ đang có.
7. Ghi các bước con db_identity_map_read, db_identity_validate,
   db_write_queue_wait, db_order_existing, db_order_bulk_write, db_order_metadata,
   db_detail_preload và các bước hoàn tồn. Script đo thêm recentFailures.
   Job được claim bởi bản mới có worker_revision=4.

Các thay đổi giảm những nguồn tải và chờ đã xác định trong mã. Vẫn cần đo lại
trên cPanel để xác nhận nguồn chậm thật và khả năng giải phóng backlog cũ.

## Cài đặt

1. Giữ bản server.cjs đang chạy để có thể khôi phục.
2. Giải nén gói v4. Chép đè server.cjs và measure-shopee-queue.mjs vào Application root.
3. Restart Node.js App một lần. Không cần npm install, đổi Vercel hay sửa .env.
4. Sau khoảng 2 phút có phát sinh xử lý đơn, chạy:

   node measure-shopee-queue.mjs 15

5. Chạy lại sau khoảng 60 giây; gửi cả hai kết quả. DiagnosticVersion phải bằng 4.
   runningJobs.workerRevision hoặc lastSucceeded.worker_revision bằng 4 xác nhận
   worker mới đã thực sự xử lý job. Nếu chưa có job thì trường này có thể trống.

Theo dõi lastSucceeded tiến lên, failed có tăng hay không và bước đang chờ.
Queue giảm đơn thuần không đủ chứng minh đã đồng bộ đủ đơn. Summary theo cửa sổ
15 phút lọc createdAt của job, nên còn chứa dữ liệu trước restart trong thời gian đầu.

Nếu có sự cố, chép lại server.cjs đã giữ rồi restart. Không cần sửa dữ liệu đơn,
xóa khóa Mongo hoặc chạy lệnh dọn hàng đợi để cài bản này.
