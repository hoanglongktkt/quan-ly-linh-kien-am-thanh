# Giám sát OMS Shopee trên cPanel

## Triển khai

Backend đã bundle: copy đè `server.cjs` và `dist/server.cjs`, sau đó Restart Node.js App. Các sửa đổi nguồn đã nằm trong hai file này, không cần compile TypeScript trên hosting. Nếu chạy audit trên hosting, copy thêm `scripts/audit-oms-indexes.mjs`, `modules/operations/indexAudit.js`, `config/db.js`.

Đặt `OPS_METRICS_TOKEN` là token ngẫu nhiên riêng ít nhất 32 ký tự trong Environment Variables cPanel. Tạo bằng `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Không commit token, không đặt trong `VITE_*`, giữ nguyên `.env` và dữ liệu OAuth trên hosting.

## API nội bộ

Hai endpoint đều yêu cầu header `Authorization: Bearer <OPS_METRICS_TOKEN>`:

- GET `/api/internal/ops/metrics?windowMinutes=60`: toàn hệ thống; thêm `shopId=123456` để xem riêng shop. `windowMinutes` là số nguyên 1–1440; shopId là chuỗi 1–20 chữ số để giữ ID uint64.
- GET `/api/internal/ops/health`: trạng thái/cảnh báo toàn hệ thống. Tùy chọn `shopId` lọc cảnh báo/shop; queue vẫn toàn hệ thống (`queueScope=all_shops`).

```sh
# Token lấy từ môi trường terminal, không đưa vào URL.
curl --silent --show-error \
  -H "Authorization: Bearer $OPS_METRICS_TOKEN" \
  'https://quanly.linhkienamthanh.net/api/internal/ops/metrics?windowMinutes=60'
curl --silent --show-error \
  -H "Authorization: Bearer $OPS_METRICS_TOKEN" \
  'https://quanly.linhkienamthanh.net/api/internal/ops/health'
```

Token sai: 401; token chưa đủ mạnh hoặc DB chưa kết nối: 503; query sai: 400. Metrics cache 15 giây/process, tối đa hai truy vấn khác nhau đồng thời; vượt giới hạn trả 429/Retry-After. Aggregate giới hạn 5 giây, không dùng disk spill. Không trả payload đơn, thông tin khách, token, URL có chữ ký hoặc lỗi DB thô.

## Chỉ số

- `summary.webhookToOrderLatencyMs`: số mẫu và trung bình có trọng số toàn hệ thống. `shops[].webhookToOrderLatencyMs` có thêm giá trị lớn nhất theo shop. Tính từ lúc HTTP nhận webhook đến lần lưu đơn Mongo thành công đầu tiên, gồm chờ queue/retry. Không có mẫu trả null; worker chết trước khi lưu metadata có thể làm thiếu mẫu.
- `queue.depth`: pending + running + failed chờ retry, gồm job sync. `queue.waiting` chỉ pending + failed; `byState`/`oldestAgeMs` giúp đánh giá tồn đọng.
- `summary.retryAttempts` và `shops[].retryAttempts`: số lần thực sự chạy lại của job tạo trong cửa sổ. `jobFailures` là số lần xử lý lỗi. `legacyRetryJobs` báo lịch sử thiếu bộ đếm mới; không bịa dữ liệu quá khứ.
- `shops[].apiErrors`/`apiErrorsByCategory`: số lần API lỗi theo shop, gồm từng lần retry, gộp theo phút: http/network/application/parse. Chỉ đo request đi qua client Shopee dùng chung. Cửa sổ lỗi căn xuống phút, xem `apiErrorSince`.
- `shops[].lastSuccessfulSyncAt`: watermark incremental thành công gần nhất, kể cả shop không có job mới. `summary.lastSuccessfulSyncAt` lấy mốc mới nhất giữa watermark và job sync thành công trong cửa sổ; `lastSyncJobSucceededAt` cho biết riêng mốc job sync. Job sync nhiều shop có thể nằm ở `unattributed`.
- `lastWebhookAt`/`lastJobSucceededAt` tại metrics dựa trên job tạo trong cửa sổ. Health giữ mốc webhook cũ trong snapshot để cửa sổ trượt không làm mất lịch sử đã quan sát.
- `truncated=true` nếu vượt 200 nhóm job/watermark hoặc 800 nhóm lỗi. Khi đó tổng có thể thiếu; health cảnh báo `metrics_incomplete`.

## Health và cảnh báo

Monitor chạy mỗi phút khi Node đang hoạt động. Snapshot `ops_health_state` dùng khóa CAS theo `_id` cho các Passenger dùng chung một mẫu/phút, không cần thêm index. Mỗi lượt thành công gồm một claim và một lần lưu snapshot nhỏ. Health không đọc log API không cần thiết; timer không giữ process sống khi Node dừng.

- `queue_growing`: queue tăng qua ít nhất 3 khoảng kiểm tra liên tiếp, không có job hoàn tất mới.
- `queue_stalled`: còn job nhưng không có job thành công trong ngưỡng (mặc định 5 phút). Dead-letter không coi là thành công. Bỏ lỡ hơn 3 phút sẽ khởi động lại chuỗi mẫu để tránh suy đoán sai.
- `token_expiring`/`token_expired`/`token_missing`: kiểm tra từng shop từ `obtained_at + expire_in`; cảnh báo sớm 30 phút. Thiếu metadata: `token_expiry_unknown`. Chỉ trả thời hạn và boolean có refresh token; monitor không thay đổi logic OAuth.
- `watermark_stalled`/`watermark_missing`: chưa có watermark incremental thành công mới trong 30 phút. Shop mới có khoảng chờ từ lúc theo dõi. Sync thủ công không che cảnh báo watermark.
- `webhook_silent`: chưa nhận **webhook đơn đã enqueue** trong 60 phút. Push loại khác hoặc payload không enqueue không thuộc chỉ số; vẫn giữ chính sách xác thực của router webhook hiện tại. Shop mới có khoảng chờ từ lúc theo dõi; shop ít đơn có thể tăng ngưỡng hoặc tắt cảnh báo.

Ngưỡng trong Environment Variables cPanel (phút, số nguyên 1–1440): `OPS_QUEUE_STALL_MINUTES=5`, `OPS_TOKEN_WARNING_MINUTES=30`, `OPS_WATERMARK_STALL_MINUTES=30`. `OPS_WEBHOOK_EXPECTED_MINUTES=60` nhận thêm 0 để tắt cảnh báo im lặng. Cấu hình sai dùng mặc định.

Health trả `ok`, `warning`, `critical`, `unknown`; critical/unknown trả HTTP 503. Snapshot quá 2 phút là stale/unknown. Lỗi đo không trả trạng thái khỏe. Log `[OMS Health]` chỉ ghi khi danh sách cảnh báo thay đổi. Cần công cụ giám sát ngoài gọi health mỗi phút để phát hiện Node tắt/spin-down; timer trong app không thể báo khi app hoàn toàn dừng. Cảnh báo hiện trả qua API và log.

## Chính sách index

Không tạo compound mới trong đợt này. `orders`/`channel_listings` tắt autoIndex. Boot và endpoint setup scanner chỉ kiểm tra, không gọi syncIndexes để thêm/xóa. Giữ nguyên index hiện có. `webhook_jobs` chỉ giữ hai unique index đơn cần thiết trên `jobId`/`active_key` cho idempotency/dedupe; không tự tạo compound hoặc index đo lường trước đây.

`ensureMongoIndex` chặn compound chưa tồn tại. `ensureOperationalIndexes` preflight toàn bộ trước khi thực hiện để tránh tạo một phần rồi mới từ chối. `scripts/ensure-oms-indexes.mjs --apply` không tự thêm compound chưa rà soát. Danh sách index trong module là gợi ý lịch sử, không phải chỉ dẫn áp dụng hàng loạt. Không dùng script scanner/optimize cũ để tạo hàng loạt.

```sh
# Chỉ đọc index và chạy explain('executionStats') trên DB đã cấu hình.
# Mỗi explain tối đa 3 giây; tổng công cụ 45 giây; không ghi/xóa dữ liệu.
node scripts/audit-oms-indexes.mjs
```

Audit dùng filter claim worker, queue, cửa sổ webhook, lookup upsert orders, shop/status, listing _id/channelId/sku. Lấy định danh mẫu từ DB nhưng không in chúng. Collection rỗng báo skipped; explain timeout/lỗi có thông báo và exit code 1.

`explain()` đo kế hoạch đọc và số bản ghi đã quét, không chứng minh index mới không làm chậm write/upsert. Mỗi index cần duy trì khi ghi: trước khi đề xuất compound, replay insert/upsert trên staging với dữ liệu/tải đại diện; so sánh throughput, p95/p99, CPU/I/O và thời gian lock trước/sau. Tham khảo [MongoDB explain](https://www.mongodb.com/docs/v8.0/reference/explain-results/) và [MongoDB write performance](https://www.mongodb.com/docs/v8.0/core/write-performance/).

Audit thực tế ngày 13/10/2026 trên DB cấu hình local: upsert lookup orders dùng index, đọc 1 document/1 key; shop/status đọc 70 document để trả 50. Worker/queue dùng `webhook_jobs_state_next_run`. Cửa sổ webhook COLLSCAN đọc 6.619 document để trả 15, khoảng 7 ms. `channel_listings` rỗng nên chưa đánh giá query với dữ liệu đại diện. Đây là snapshot, không phải benchmark write; chưa thêm index vào MongoDB trong phiên thực hiện.

TTL hiện hữu giữ nguyên: log mặc định 14 ngày; webhook_jobs 30 ngày nếu đã có TTL finished_at. Không tự backfill hoặc tạo TTL queue trong đợt này; job chưa kết thúc không bị TTL xóa.

Kiểm tra local: `npm run test:operations`, `npm run test:backend-modules`, `npm run build`.

`npm run lint` còn 3 lỗi frontend có sẵn ở `src/components/OrderManager.tsx` (5673, 5779, 6270); không sửa frontend trong đợt backend này. Build production và 16 kiểm thử vận hành/webhook đã đạt.

## File nguồn backend thay đổi (đã bundle trong server.cjs)

- `server.ts`
- `routes/operationsRoutes.js`
- `modules/operations/metrics.js`
- `modules/operations/health.js` (mới)
- `modules/operations/mongoIndexes.js`
- `modules/operations/indexAudit.js` (mới, công cụ audit riêng)
- `models/WebhookJob.js`
- `src/db/mongoStore.ts`
- `scripts/audit-oms-indexes.mjs` (mới)
- `scripts/ensure-oms-indexes.mjs`
- `scripts/test-operations.mjs`
- `scripts/test-observability.mjs` (mới)
- `package.json` (chỉ cập nhật lệnh kiểm thử)
- `.env.example` (ngưỡng cấu hình mẫu, không copy đè .env server)

Nguồn thay đổi không cần copy từng file khi Passenger dùng startup `server.cjs`; bắt buộc copy hai bundle `server.cjs`/`dist/server.cjs`. Các file audit độc lập cần copy riêng nếu chạy công cụ trên hosting.
