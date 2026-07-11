import { Product, Expense, SyncLog, Supplier, ImportTransaction } from './types';

export const INITIAL_PRODUCTS: Product[] = [
  {
    id: "prod-master-1",
    title: "MẠCH BLUTOOTH LIỀN CÔNG SUẤT 6V-24V 3116D2 80W 2 Kênh",
    sku: "mp3.80w",
    stock: 250,
    importPrice: 45000,
    sellingPrice: 89000,
    channels: ["shopee", "tiktok"],
    category: "Điện tử",
    shopeeId: "SP-546083",
    tiktokId: "TT-483583",
    status: "active",
    imageUrl: "https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    description: "Mạch khuếch đại âm thanh Bluetooth liền công suất 6V-24V sử dụng chip TPA3116D2 cho công suất ngõ ra cực đại 80W mỗi kênh. Thiết kế nhỏ gọn, tích hợp sẵn mô-đun nhận tín hiệu âm thanh Bluetooth 5.0 ổn định, giảm nhiễu tốt, dải điện áp đầu vào rộng tiện lợi cho các chế tác loa kéo mini, loa nghe nhạc gia đình.",
    lastSynced: "2026-07-07T12:00:00"
  },
  {
    id: "prod-1",
    title: "Nồi Chiên Không Dầu Sunhouse 6L SHD4026 Cao Cấp",
    sku: "SH-NCKD-6L",
    stock: 45,
    importPrice: 850000,
    sellingPrice: 1450000,
    channels: ["shopee", "tiktok", "woocommerce"],
    category: "Gia dụng",
    shopeeId: "SP-992813",
    tiktokId: "TT-773821",
    wooId: "WOO-1004",
    status: "active",
    imageUrl: "https://images.unsplash.com/photo-1621972750749-0fbb1abb7736?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    description: "Nồi chiên không dầu Sunhouse 6L SHD4026 sở hữu công nghệ Rapid Air tiên tiến, giúp giảm đến 80% chất béo trong thực phẩm. Thân vỏ nhựa PP cao cấp cách nhiệt tốt, khay chiên phủ lớp chống dính Whitford (Mỹ) bền bỉ và an toàn sức khỏe. Dung tích lớn phù hợp cho gia đình 4-6 người.",
    lastSynced: "2026-07-07T10:30:00"
  },
  {
    id: "prod-2",
    title: "Son Kem Lì Romand Juicy Lasting Tint Màu 23 Nucadamia",
    sku: "ROM-JLT-23",
    stock: 12,
    importPrice: 110000,
    sellingPrice: 195000,
    channels: ["shopee", "woocommerce"],
    category: "Mỹ phẩm",
    shopeeId: "SP-456321",
    wooId: "WOO-1002",
    status: "active",
    imageUrl: "https://images.unsplash.com/photo-1586495777744-4413f21062fa?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    description: "Son Tint bóng lì Romand Juicy Lasting Tint phiên bản thu đông với gam màu hạt dẻ ấm áp cực quyến rũ. Chất son tint bóng nhẹ tạo độ căng mọng cho đôi môi, độ bám màu cực tốt từ 4-6 tiếng và không làm khô môi.",
    lastSynced: "2026-07-07T11:15:00"
  },
  {
    id: "prod-3",
    title: "Áo Thun Cotton Unisex Oversize Local Brand Teelab",
    sku: "TL-TEE-OS-01",
    stock: 120,
    importPrice: 75000,
    sellingPrice: 169000,
    channels: ["shopee", "tiktok", "woocommerce"],
    category: "Thời trang",
    shopeeId: "SP-883210",
    tiktokId: "TT-223450",
    wooId: "WOO-1001",
    status: "active",
    imageUrl: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    description: "Áo thun Teelab chất liệu 100% Cotton 2 chiều co giãn cực tốt, độ dày vừa phải không bị xù lông. Hình in kỹ thuật số sắc nét, độ bền màu cao, phom dáng Unisex rộng rãi thích hợp cho cả nam và nữ mặc đi học, đi chơi.",
    lastSynced: "2026-07-07T09:45:00"
  },
  {
    id: "prod-4",
    title: "Bàn Phím Cơ Không Dây KTT Royal Axe R100 RGB",
    sku: "KB-RAXE-R100",
    stock: 4,
    importPrice: 1350000,
    sellingPrice: 2250000,
    channels: ["tiktok", "woocommerce"],
    category: "Điện tử",
    tiktokId: "TT-998213",
    wooId: "WOO-1003",
    status: "active",
    imageUrl: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    description: "Bàn phím cơ Royal Axe R100 thiết kế layout 98 phím gọn gàng, hỗ trợ 3 chế độ kết nối cực linh hoạt (Bluetooth, Wireless 2.4GHz, Type-C). Switch KTT cao cấp được pre-lubed mượt mà, hỗ trợ Hotswap 5-pin và lót sẵn foam tiêu âm dày dặn.",
    lastSynced: "2026-07-06T16:20:00"
  },
  {
    id: "prod-5",
    title: "Tai Nghe Chụp Tai Chống Ồn Baseus Bowie H1 Pro",
    sku: "BS-BOWIE-H1",
    stock: 0,
    importPrice: 420000,
    sellingPrice: 780000,
    channels: ["woocommerce"],
    category: "Điện tử",
    wooId: "WOO-1005",
    status: "out_of_stock",
    imageUrl: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3",
    description: "Tai nghe Baseus Bowie H1 Pro với công nghệ chống ồn chủ động Hybrid ANC lên đến -48dB, màng loa kép đồng trục cho âm thanh cực trung thực và chi tiết. Thời lượng pin trâu lên đến 80 giờ chơi nhạc liên tục giúp bạn thoải mái giải trí.",
    lastSynced: "2026-07-05T12:00:00"
  }
];

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
