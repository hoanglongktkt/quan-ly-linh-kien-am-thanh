import { Product, Expense, SyncLog, Supplier, ImportTransaction } from './types';

export const INITIAL_PRODUCTS: Product[] = [];

export const INITIAL_EXPENSES: Expense[] = [
  {
    id: "exp-1",
    title: "Chi phí chạy Ads Shopee tháng 6",
    amount: 3500000,
    category: "advertising",
    date: "2026-06-30",
    notes: "Chạy chiến dịch siêu sale 6.6 và xả hàng tồn kho."
  },
  {
    id: "exp-2",
    title: "Mua túi bóng khí và hộp carton đóng hàng",
    amount: 1200000,
    category: "packaging",
    date: "2026-07-02",
    notes: "Đóng gói cho khoảng 400 đơn hàng gia dụng và mỹ phẩm."
  },
  {
    id: "exp-3",
    title: "Thuê kho chứa hàng quận Tân Bình",
    amount: 5000000,
    category: "warehouse",
    date: "2026-07-01",
    notes: "Thanh toán tiền nhà kho tháng 7/2026."
  },
  {
    id: "exp-4",
    title: "Thuê KOC live stream ra mắt áo thun Teelab",
    amount: 2500000,
    category: "advertising",
    date: "2026-07-04",
    notes: "Book 2 bạn KOC Tiktok dưới 100k followers live phân khúc áo thun."
  }
];

export const INITIAL_SYNC_LOGS: SyncLog[] = [
  {
    id: "log-1",
    timestamp: "2026-07-07T16:00:00",
    channel: "shopee",
    type: "stock_sync",
    status: "success",
    message: "Đồng bộ tồn kho tự động: 4 sản phẩm thành công."
  },
  {
    id: "log-2",
    timestamp: "2026-07-07T14:30:00",
    channel: "tiktok",
    type: "price_update",
    status: "success",
    message: "Cập nhật giá hàng loạt: Áo Thun Teelab thành công."
  },
  {
    id: "log-3",
    timestamp: "2026-07-07T11:00:00",
    channel: "shopee",
    type: "publish",
    status: "success",
    message: "Đăng bán sản phẩm mới 'Nồi Chiên Sunhouse 6L' thành công lên gian hàng Shopee."
  },
  {
    id: "log-4",
    timestamp: "2026-07-06T15:20:00",
    channel: "tiktok",
    type: "product_sync",
    status: "failed",
    message: "Lỗi kết nối API TikTok Shop: Mã lỗi 504 - Cổng kết nối quá hạn (Gateway Timeout)."
  }
];

export const INITIAL_SUPPLIERS: Supplier[] = [];

export const INITIAL_IMPORTS: ImportTransaction[] = [];
