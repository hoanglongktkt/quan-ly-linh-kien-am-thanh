# Backend theo miền nghiệp vụ

Đợt bóc tách này bắt đầu từ webhook. Giữ nguyên tên hàm, named export/type export,
đường dẫn import cũ, collection MongoDB, thứ tự ACK và cơ chế khóa worker.
Các file cũ là lớp chuyển tiếp tới cùng implementation, không nhân đôi timer/model.

## Cấu trúc đã tạo

```text
modules/
  webhooks/
    shopeeWebhookHandler.ts   # Router và tiếp nhận/enqueue sự kiện
    shopeeSignature.ts        # Xác thực HMAC, từ src/webhooks
    request.ts               # Raw body, ACK, header, URL xác thực
    payload.ts               # Parse, chuẩn hóa envelope, khóa job
    pushData.ts              # Đọc data/status, bóc từ server.ts
    stats.ts                 # Thống kê webhook dùng chung với health
  jobs/
    index.js                 # Interface chung, giữ hai cơ chế queue hiện có
    webhookJobQueue.js       # Mongo queue cho webhook, sync và task/backfill
    labelPdfQueue.js         # Bộ đệm PDF và đăng ký downloader hiện có
    keepAliveScheduler.js    # Lịch tự ping Passenger
  shopee-sync/
    client.js                # HTTP, retry và giới hạn nhịp gọi API hiện có
    orderSyncService.js      # Đăng ký worker và điều phối sync
    syncOrchestrator.js      # Khóa toàn cục, heartbeat và watermark Mongo
    scheduler.js             # Export tương thích cho cron/index.js
    schedulers/
      orders.js              # Incremental sync và đối soát giao ĐVVC
      returns.js             # Đồng bộ yêu cầu hoàn
      backfill.js            # Bù READY_TO_SHIP
  orders/
    ordersService.js         # Persistence, cleanup, tra cứu và giao ĐVVC
    lookupService.js         # Index, lookup ID/mã đơn và dedupe request
    orderIdentity.js         # Identity Mongo theo shop + mã đơn
    orderWorkLock.js         # Khóa theo đơn
    repositoryValues.ts     # Chuẩn hóa watermark/mã vận đơn từ mongoStore
    scanCode.ts              # Chuẩn hóa mã quét từ mongoStore
    warehouseState.ts        # State machine kho/giao ĐVVC, dùng chung FE/BE
    cancelReturnState.ts     # Phân loại hủy/hoàn, dùng chung FE/BE
  logistics/
    logisticsConfig.js       # Cấu hình GHN/SPX, giữ nguồn dữ liệu cũ
    tracking.ts              # Kiểm tra/hiển thị mã vận đơn
    handover.ts              # Quy tắc bàn giao và điều kiện trạng thái
    pdfQueue.js              # Dùng cùng queue PDF trong modules/jobs
    pdfCleanupScheduler.js   # Dọn PDF theo lịch cũ
    ghnStatusScheduler.js    # Đồng bộ trạng thái GHN theo lịch cũ
```

Các file chuyển tiếp được giữ tại `src/webhooks/`, `src/utils/orderTracking.ts`,
`src/utils/orderHandover.ts`, `src/utils/orderWarehouseStatus.ts`,
`src/utils/shopeeCancelReturnClassify.ts`, `services/webhookJobQueue.js`,
`services/logisticsConfig.js`, `services/orders.js`, `services/shopee/client.js`,
`services/orderSync/{orderIdentity,orderWorkLock,orderSyncService,syncOrchestrator,labelPdfQueue}.js`
và `cron/index.js`.

## Phạm vi còn giữ nguyên

Đây là bước đầu của refactor, chưa tách hết backend. `src/db/mongoStore.ts` vẫn
sở hữu connection/model và phần repository Mongo lớn; chỉ các helper thuần đã được
bóc ra. `server.ts` vẫn giữ chuẩn hóa đơn đầy đủ, xử lý trạng thái Shopee, API tracking,
tải/gộp PDF và các route cần nhiều dependency. Biên bản bàn giao chưa chuyển module.
Shopee auth/chat/catalog vẫn ở `services/shopee/`. Không tạo queue bền vững mới cho
PDF hoặc thay bộ đệm RAM hiện tại. Tách tiếp các phần này cần regression theo từng
luồng trước khi đổi ranh giới dependency.

## Kiểm tra sau khi tách

1. `node --test scripts/test-oms-queue-safety.mjs`: Mongo giả kiểm tra khóa, ưu tiên,
   chống trùng, retry, watermark và identity; không ghi Mongo thật.
2. `npm run test:backend-modules`: bundle test vào thư mục tạm của dự án rồi kiểm tra
   compatibility, payload uint64, lookup và webhook HTTP local. Mongo được mock;
   kiểm tra ACK trước khi ghi xong, enqueue và fallback khi queue lỗi.
3. `npm run build`: tạo `dist/` và `server.cjs` cho cPanel.
4. `npm run lint`: trước refactor có 3 lỗi ở `src/components/OrderManager.tsx`
   (5673, 5779, 6270); sau refactor vẫn chỉ có ba lỗi đó.
5. Sau khi copy bản build lên cPanel, restart Node.js App. Mở `/api/health`, kiểm tra
   GET `/api/shopee/webhook` trả `OK`; theo dõi một webhook đơn thật đã có sẵn, một
   lần đồng bộ và in PDF của đơn thử. Kiểm tra không tạo job/đơn trùng, tab đơn giữ
   đúng trạng thái, worker không chạy song song và PDF vẫn tải/in được.

Build và test local không thay thế kiểm chứng Shopee/Mongo/cPanel thực tế.
Kết quả local: build thành công, 8 kiểm tra OMS và 4 kiểm tra module đều qua.
Đối chiếu AST với mã gốc xác nhận 196 hàm giữ nguyên tham số/thân hàm; bốn phép
cập nhật index trong ordersService chuyển qua getOrderLookupIndex tương đương.
Hành vi HMAC không hợp lệ vẫn tiếp tục xử lý như trước; thay chính sách này cần
một thay đổi bảo mật riêng, không gộp vào refactor giữ nguyên nghiệp vụ.

## Copy lên cPanel

- `server.cjs` → thư mục gốc ứng dụng Node.
- `dist/` → thư mục `dist/` của ứng dụng (bao gồm `dist/server.cjs.map`).
- Với cấu hình webroot dùng `assets/` như script deploy hiện có: copy thêm
  `dist/assets/*` → `assets/` tại webroot.
- Không copy đè `.env`, `data/` hoặc `storage/`.

Backend đã bundle trong `server.cjs`; không cần upload các thư mục module nguồn
khi cPanel chạy file này.
