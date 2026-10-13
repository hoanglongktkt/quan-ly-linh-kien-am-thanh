# Giám sát OMS Shopee trên cPanel

## Triển khai

Copy `server.cjs` và `dist/server.cjs` đã build. Nếu chạy công cụ index độc lập, copy thêm `scripts/ensure-oms-indexes.mjs`, `modules/operations/mongoIndexes.js`, `config/db.js`, `utils/safeProductionLog.js`. Các dependency Mongo/dotenv đã có trong package.json. Restart Node.js App sau khi đặt biến môi trường.

Tạo token riêng bằng `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, đặt kết quả vào **OPS_METRICS_TOKEN** trong cPanel Environment Variables. Không commit token, không đặt trong `VITE_*`, không copy đè `.env` hoặc thư mục dữ liệu trên server.

## Gọi API

```sh
# Đặt OPS_METRICS_TOKEN vào môi trường terminal từ kho bí mật của bạn.
curl --fail --silent --show-error \
  -H "Authorization: Bearer $OPS_METRICS_TOKEN" \
  'https://quanly.linhkienamthanh.net/api/internal/ops/metrics?windowMinutes=60'

# Chỉ lấy số liệu của một shop; thay 123456 bằng shop_id thực tế.
curl --fail --silent --show-error \
  -H "Authorization: Bearer $OPS_METRICS_TOKEN" \
  'https://quanly.linhkienamthanh.net/api/internal/ops/metrics?shopId=123456&windowMinutes=60'
```

GET `/api/internal/ops/metrics`: chỉ chấp nhận token vận hành riêng. Không cấu hình token đủ 32 ký tự: 503; token sai: 401; query sai: 400; DB hoặc truy vấn lỗi: 503. `windowMinutes` từ 1 đến 1440, `shopId` là chuỗi 1–20 chữ số. Không trả payload, thông tin khách, token, URL ký request hay thông báo lỗi thô. Kết quả cache 15 giây trong mỗi process; `generatedAt` là thời điểm đo.

- `queue.depth`: số job pending + running + failed đang chờ retry, tại thời điểm truy vấn, không giới hạn theo cửa sổ. `queue.byState` và `oldestAgeMs` giúp phát hiện tồn đọng. Có `shopId` thì queue cũng lọc theo shop.
- `shops[].webhookToOrderLatencyMs`: số mẫu, trung bình và lớn nhất, tính từ HTTP tiếp nhận webhook đến lần ghi đơn thành công đầu tiên. Bao gồm thời gian đọc body, chờ queue và retry. Chỉ job có đủ hai mốc mới được tính; chưa có mẫu trả `null`, không trả 0 giả. Nếu worker chết trước khi lưu metadata, mẫu đó có thể thiếu.
- `retryAttempts`: số lần worker thực sự claim lại job failed. `jobFailures` dùng `retry_count` hiện có, là số lần xử lý thất bại. Cả hai là số tích lũy của những job được tạo trong cửa sổ, không phải số sự kiện retry phát sinh trong cửa sổ. `legacyRetryJobs` cho biết job lịch sử thiếu bộ đếm retry mới.
- `apiErrors`: số **lần gọi API thất bại**, kể cả từng lần retry, được lưu bền trên Mongo và gộp theo phút/shop/loại lỗi. HTTP >=400, lỗi mạng/timeout được ghi từ `fetchWithTimeout`; lỗi Shopee trong HTTP thành công và lỗi JSON được ghi từ hai wrapper GET/POST dùng chung. Lời gọi HTTP bên ngoài các hàm này chưa thuộc phạm vi đo. Mỗi lần lỗi chỉ đếm một loại. Cửa sổ lỗi căn xuống đầu phút; `apiErrorSince` cho biết mốc thực tế. Lỗi ghi telemetry được bỏ qua để không làm hỏng đơn.
- Job legacy chưa bổ sung shop và job sync nhiều shop nằm ở `unattributed`; API không có shop_id nằm ở `unknown`. Bộ đếm mới chỉ đầy đủ từ sau triển khai, không tái tạo lịch sử bị thiếu. `truncated=true` khi vượt giới hạn 200 nhóm job hoặc 800 nhóm lỗi; không dùng kết quả đó để kết luận tổng hệ thống.

## Index và TTL

```sh
# In toàn bộ câu lệnh MongoDB createIndex, không kết nối DB.
node scripts/ensure-oms-indexes.mjs
# Kiểm tra index đang có trên DB cấu hình trong MONGODB_URI.
node scripts/ensure-oms-indexes.mjs --check
# Tạo index còn thiếu và sửa TTL bằng collMod, không drop index.
node scripts/ensure-oms-indexes.mjs --apply
# Tùy chọn: bổ sung shop và thời điểm kết thúc cho job lịch sử.
node scripts/ensure-oms-indexes.mjs --apply --backfill-jobs
```

Ví dụ lệnh trực tiếp trong mongosh (đúng database OMS):

```js
// Lookup theo shop + đơn và lọc trạng thái + thời gian cập nhật.
db.orders.createIndex({shopId: 1, orderSn: 1}, {name: 'orders_shop_order'});
db.orders.createIndex({shopId: 1, status: 1, last_shopee_update_at: -1}, {name: 'orders_shop_status_update'});
// Worker lấy job ưu tiên trước, sau đó theo thời điểm chạy.
db.webhook_jobs.createIndex({state: 1, priority: -1, next_run_at: 1, _id: 1}, {name: 'webhook_jobs_claim'});
db.channel_listings.createIndex({platform: 1, status: 1, _id: 1}, {name: 'listings_platform_status'});
db.channel_listings.createIndex({platform: 1, sku: 1}, {name: 'listings_platform_sku'});
// TTL chỉ áp dụng log/job đã kết thúc, không áp dụng đơn hàng hoặc listing.
db.webhook_jobs.createIndex({finished_at: 1}, {name: 'webhook_jobs_ttl', expireAfterSeconds: 2592000});
db.ops_api_errors.createIndex({expires_at: 1}, {name: 'ops_api_errors_ttl', expireAfterSeconds: 0});
db.order_events.createIndex({occurred_at: 1}, {name: 'order_events_ttl', expireAfterSeconds: 1209600});
db.sync_jobs.createIndex({finished_at: 1}, {name: 'sync_jobs_ttl', expireAfterSeconds: 1209600});
// Nếu TTL cũ đã tồn tại khác thời hạn, sửa tại chỗ (dùng tên index hiện có).
db.runCommand({collMod: 'order_events', index: {name: 'order_events_ttl', expireAfterSeconds: 1209600}});
```

`orders` đã có unique `orderSn`, nhiều compound index theo shop/raw trạng thái và `last_shopee_update_at`; giữ nguyên tính duy nhất và cách upsert hiện tại. `update_time` của Shopee được chuẩn hóa thành **last_shopee_update_at (BSON Date)**, không tạo index trên trường `update_time` chưa có ở top-level. `channel_listings` hiện lookup qua `channelId`, `sku` và `_id` (đã có index); chưa lưu shopId riêng nên không thêm index shopId rỗng.

Ứng dụng tự bổ sung index khi khởi động; nếu tài khoản Mongo không có quyền quản lý index, dùng tài khoản vận hành chạy script rồi kiểm tra lại. Script có thể chạy lặp, giữ nguyên index hiện có; không dùng `syncIndexes` để xóa hàng loạt. Khi chạy các lệnh mongosh thủ công, kiểm tra `getIndexes()` để tránh tạo cùng key dưới tên khác; script tự nhận diện trường hợp này.

TTL mặc định: `order_events` 14 ngày; `sync_jobs` 14 ngày tính từ `finished_at`; `webhook_jobs` 30 ngày tính từ `finished_at`; `ops_api_errors` 14 ngày. Ba biến `ORDER_EVENT_TTL_SECONDS`, `SYNC_JOB_TTL_SECONDS`, `OPS_API_ERROR_TTL_SECONDS` nhận số giây nguyên từ 86400 đến 31536000. Thay TTL log API chỉ ảnh hưởng bucket mới vì bucket cũ giữ `expires_at` đã ghi. Job pending/running/failed chưa kết thúc không có `finished_at` và không bị TTL xóa. Backfill terminal job lịch sử có thể khiến job quá 30 ngày bị TTL xóa; bỏ tùy chọn này nếu còn cần xem lịch sử cũ. Không bịa mốc latency cho job legacy.

MongoDB TTL cần trường BSON Date và chạy nền nên không xóa đúng từng giây. Việc giảm TTL có thể khiến log quá hạn hiện có được xóa ngay trong lượt TTL tiếp theo. Tài liệu: [MongoDB TTL indexes](https://www.mongodb.com/docs/v8.0/core/index-ttl/).

## Xác nhận truy vấn thực tế

```js
// Thay bằng shop/đơn thật; kiểm tra winningPlan có IXSCAN và số document đã đọc.
db.orders.find({shopId: '123456', orderSn: 'ORDER_SN_THAT'}).explain('executionStats');
db.orders.find({shopId: '123456', status: 'shipping'})
  .sort({last_shopee_update_at: -1}).limit(50).explain('executionStats');
db.webhook_jobs.find({state: 'pending', next_run_at: {$lte: new Date()}})
  .sort({priority: -1, next_run_at: 1, _id: 1}).limit(1).explain('executionStats');
db.channel_listings.find({platform: 'shopee', status: 'active'})
  .sort({_id: 1}).limit(50).explain('executionStats');
```

Index cần được đánh giá với bộ lọc và dữ liệu thật; không ép hint để che việc optimizer chọn sai. Truy vấn cố ý đọc tất cả listing không thể biến thành đọc ít dữ liệu chỉ bằng thêm index. Không kết nối Atlas thật trong kiểm thử local; sau triển khai cần kiểm tra index và explain trên database vận hành. `--check` trả mã thoát 1 nếu thiếu index hoặc TTL lệch cấu hình.

Kiểm tra local: build production, bộ kiểm thử API/telemetry và bộ kiểm thử webhook/hàng đợi. Kiểm tra kiểu dữ liệu toàn dự án còn ba lỗi có sẵn trong `src/components/OrderManager.tsx`; phần backend mới không còn lỗi kiểu dữ liệu sau kiểm tra.
