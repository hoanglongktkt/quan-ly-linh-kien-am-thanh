# Giới hạn xác nhận và in đơn trên cPanel

Cấu hình tham chiếu: ảnh cPanel ngày 22/10/2026, RAM 3 GB,
Number of Processes 120, Entry Processes 80. Các số đang sử dụng trong ảnh
chỉ là một thời điểm; không dùng chúng để suy ra tải cực đại an toàn.

## Mức mặc định

| Công việc | Giới hạn trong mỗi Node process |
| --- | --- |
| HTTP Shopee (cả xác nhận, đồng bộ, tracking, PDF) | 3, giữ chỗ đến khi đọc xong body |
| Đơn đang xác nhận | 2 |
| Lô chuẩn bị PDF chưa có cache | 1, từng shop một |
| Bổ sung dữ liệu / tải PDF trong lô | 1 |
| Ghép và lưu PDF | 1, tối đa 2 lô chờ ghép |
| Tổng buffer đầu vào mỗi lần ghép | 64 MiB |
| Lô xác nhận đang chạy và chờ | 10; quá giới hạn trả HTTP 429 |
| Số đơn mỗi yêu cầu xác nhận / in gộp | 500 |

`utils/workGate.js` sở hữu các giới hạn chung. Hàng đợi HTTP có tối đa 200
yêu cầu chờ, hàng đợi PDF tối đa 40 lô, bảng tác vụ PDF tối đa 1.000 mã đơn.
Không tự nhả chỗ khi tác vụ còn chạy. Hủy yêu cầu đang chờ HTTP sẽ gỡ nó
khỏi hàng đợi. Deadline HTTP bao gồm thời gian chờ cấp chỗ.

Các đường tải PDF nền, silent-prefetch, in gộp, get-pdf và download-pdf
dùng chung bộ chống trùng theo mã đơn. Một người đọc ngắt kết nối không hủy
việc tạo PDF mà người đọc khác đang chờ. Công việc còn trong hàng đợi được
kiểm tra deadline trước khi bắt đầu. PDF đã có cache được đọc trực tiếp,
không phải chờ một lô khác đang chờ Shopee tạo mã.

Tải PDF nền gom theo shop thay vì tạo từng đơn. Lỗi thiếu package mới sinh
vẫn có bước thử lại trong deadline. Giữ dữ liệu nhiều kiện và thứ tự in theo
mảng mã đơn giao diện gửi lên. Không đặt isPrinted khi chỉ tải nền.
Giao diện chờ trạng thái job kết thúc sau bước lưu Mongo, tránh tải lại quá sớm.

## Kiểm tra

Chạy các lệnh từ thư mục dự án (Windows dùng `npm.cmd`):

```text
node --test scripts/test-logistics-limits.mjs scripts/test-webhook-http.mjs scripts/test-oms-queue-safety.mjs
npm.cmd run test:backend-modules
npm.cmd run lint
npm.cmd run build
```

Kiểm thử dùng API giả lập/HTTP loopback, không xác nhận đơn Shopee thật.
Kiểm thử bao gồm nhiều bên gọi chung giới hạn, đầy hàng đợi, hủy khi chờ,
lỗi và thử lại, PDF chồng lấn, hủy một bên đọc, giữ thứ tự in, cache không bị
chặn bởi lô chậm, giữ chỗ HTTP đến hết body và các hồi quy webhook.

## Áp dụng

Build tạo `server.cjs` đã đóng gói các module mới; cPanel đang dùng file này
chỉ cần thay file và restart ứng dụng. Không cần cài thêm npm package.
Thay đổi giao diện cần triển khai frontend qua quy trình hiện có.
Chưa tự đẩy Git, Vercel hay thay file cPanel trong lần sửa này.

Sau áp dụng, thử lô nhỏ 5–10 đơn, sau đó lô sử dụng bình thường. Theo dõi
thời gian xác nhận, thời gian có PDF, CPU/RAM và faults trong Resource Usage.
So sánh cùng cỡ lô, tránh tăng giới hạn chỉ vì một ảnh chụp đang ít tải.
Giới hạn là theo process, không phải khóa phân tán giữa nhiều Passenger process
hoặc nhiều máy chủ; cần kiểm tra số process ứng dụng thực tế nếu vận hành nhiều instance.
Đây là mức khởi đầu thận trọng, không phải bảo đảm Node không bao giờ bị quá tải.
