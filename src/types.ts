export interface Product {
  id: string;
  title: string;
  sku: string;
  stock: number;
  importPrice: number;
  sellingPrice: number;
  wholesalePrice?: number;
  weight?: number;
  brand?: string;
  supplierId?: string;
  barcode?: string;
  /** Shopee medicine_id (uint64) — ngành Y tế/Dược phẩm; lưu String. */
  medicine_id?: string;
  stockMin?: number;
  stockMax?: number;
  channels: ('shopee' | 'tiktok' | 'woocommerce')[];
  category: string;
  unit?: string;
  shopeeId?: string;
  shopeeItemId?: string;
  shopeeModelId?: string;
  parentSku?: string;
  modelName?: string;
  /** Biến thể con (multi-SKU) — chỉ có trên Parent Product. */
  children?: Product[];
  /** @deprecated Dùng `children` — giữ để migrate dữ liệu cũ. */
  children_models?: Product[];
  tierLabels?: string[];
  avatarUrl?: string;
  tiktokId?: string;
  wooId?: string; // WooCommerce Product ID
  status: 'active' | 'draft' | 'out_of_stock';
  description: string;
  imageUrl?: string;
  lastSynced?: string;
}

/** Lấy danh sách biến thể con — ưu tiên `children`, fallback `children_models`. */
export function getProductChildren(p: Product): Product[] {
  if (Array.isArray(p.children) && p.children.length > 0) return p.children;
  if (Array.isArray(p.children_models) && p.children_models.length > 0) return p.children_models;
  return [];
}

export function hasProductVariants(p: Product): boolean {
  return getProductChildren(p).length > 0;
}

export interface BulkUpdatePayload {
  productIds: string[];
  stock?: { mode: 'set' | 'delta' | 'increase' | 'decrease'; value: number };
  price?: { mode: 'set' | 'percent_up' | 'percent_down' | 'fixed_up' | 'fixed_down'; value: number };
}

export interface BulkSaveProductUpdate {
  id: string;
  title?: string;
  sku?: string;
  stock?: number;
  sellingPrice?: number;
  wholesalePrice?: number;
  importPrice?: number;
  weight?: number;
  brand?: string;
  supplierId?: string;
  barcode?: string;
  stockMin?: number;
  stockMax?: number;
  unit?: string;
  status?: Product['status'];
}

export interface Expense {
  id: string;
  title: string;
  amount: number;
  category: 'advertising' | 'packaging' | 'fees' | 'shipping' | 'warehouse' | 'labor' | 'other';
  date: string;
  notes?: string;
}

/** Chi tiết phí sàn Shopee từ v2.payment.get_escrow_detail → order_income / income_details */
export interface ShopeeFees {
  /** Tổng tiền sản phẩm gốc (item_amount) */
  item_amount?: number;
  /** Mã giảm giá Shop — dùng khi tính fee base; không trừ Shopee voucher */
  voucher_from_seller?: number;
  commission_fee?: number;
  service_fee?: number;
  transaction_fee?: number;
  seller_transaction_fee?: number;
  credit_card_transaction_fee?: number;
  commission_fee_tax?: number;
  service_fee_tax?: number;
  transaction_fee_tax?: number;
  /** Tổng thuế (fee tax hoặc withholding VN) */
  total_tax?: number;
  withholding_vat_tax?: number;
  withholding_pit_tax?: number;
  withholding_cit_tax?: number;
  /** Doanh thu escrow từ Shopee */
  escrow_amount?: number;
  /** Tổng phụ phí (commission + service + transaction, chưa gồm thuế) */
  total_surcharge?: number;
  /** true khi dữ liệu phí chỉ là ước tính từ order detail hoặc tỷ lệ mặc định */
  is_estimated?: number;
  /** Tỷ lệ mặc định đã dùng khi Shopee chưa trả phí ước tính */
  default_fee_rate?: number;
  [key: string]: number | undefined;
}

export interface SystemFee {
  id: string;
  name: string;
  calculationType: 'percentage' | 'fixed';
  value: number;
  active: boolean;
}

export interface AppliedSystemFee {
  id: string;
  name: string;
  amount: number;
  calculationType: SystemFee['calculationType'];
  value: number;
}

export interface OrderCustomCostItem {
  id: string;
  label: string;
  amount: number;
}

export interface Order {
  id: string;
  orderSn: string;
  channel: 'shopee' | 'tiktok' | 'woocommerce' | 'manual';
  shopId?: string; // ConnectedShop ID
  shopName?: string; // Cache shopName to display which shop
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  /** WooCommerce raw order id (số) */
  wooOrderId?: string;
  wooOrderNumber?: string;
  wooStatus?: string;
  billingAddress?: string;
  shippingAddress?: string | {
    province: string;
    provinceCode?: string;
    district: string;
    districtCode?: string;
    ward: string;
    wardCode?: string;
    street: string;
    fullAddress?: string;
  };
  billing?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    email?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  shipping?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  carrier?: 'self' | 'ghn' | 'spx';
  /** Tên ĐVVC từ Shopee (shipping_carrier / package_list) — VD: SPX Express, Giao Hàng Nhanh */
  shipping_carrier?: string;
  /** Tên kênh giao khi mask (checkout_shipping_carrier) — VD: Nhanh, Hỏa Tốc */
  checkout_shipping_carrier?: string;
  /** ID kênh logistics Shopee (package_list.logistics_channel_id) */
  logistics_channel_id?: number;
  /** Loại/dịch vụ giao (nếu có) — Instant / Hỏa Tốc */
  shipping_type?: string;
  /** Trạng thái logistics Shopee (package_list.logistics_status) — dùng phân loại giao thất bại */
  logistics_status?: string;
  totalAmount: number;
  /** Tổng tiền sản phẩm gốc từ get_escrow_detail (item_amount) */
  item_amount?: number;
  revenue: number; // escrow_amount − custom_costs (chỉ khi đã đối soát Shopee)
  /** Chi phí tự nhập của kho sỉ (đóng gói, v.v.) — tổng các dòng custom_cost_items */
  custom_costs?: number;
  /** Chi tiết chi phí tự nhập (hộp, băng keo...) */
  custom_cost_items?: OrderCustomCostItem[];
  /** true khi đã lấy được dữ liệu get_escrow_detail */
  escrow_synced?: boolean;
  /** Nguồn số liệu tài chính: dữ liệu ước tính hoặc escrow đối soát chính thức */
  finance_source?: 'estimated_api' | 'estimated_default' | 'escrow';
  withholdingCitTax?: number;
  /** Mirror snake_case field from Shopee OpenAPI order_income.withholding_cit_tax */
  withholding_cit_tax?: number;
  escrowAmount?: number;
  /** Chi tiết phí sàn từ get_escrow_detail */
  shopee_fees?: ShopeeFees;
  /** Các phí hệ thống đã dùng cho số liệu ước tính trước khi có escrow */
  estimated_fee_items?: AppliedSystemFee[];
  partialCancel?: boolean;
  canPartialCancel?: boolean;
  /** Mã trạng thái gốc từ API Shopee */
  shopee_order_status?: string;
  status: 'pending_verification' | 'pending_confirm' | 'unprocessed' | 'processed' | 'shipping' | 'cancelled' | 'return_pending' | 'return_received' | 'completed';
  date: string;
  trackingNumber?: string; // Carrier tracking (SPXVN..., GHN...) — mã trên phiếu giao / QR quét
  /** Mirror snake_case từ Shopee / DB */
  tracking_no?: string;
  /** Phương thức giao: pickup (bưu tá lấy) | dropoff (gửi tại bưu cục) — không phụ thuộc pickup_time */
  fulfillment_type?: 'pickup' | 'dropoff' | string;
  ship_method?: 'pickup' | 'dropoff' | string;
  shipping_method?: string;
  /** Mã vận đơn chiều hoàn từ v2.returns.get_return_detail / get_reverse_tracking_info */
  return_tracking_no?: string;
  /** Alias camelCase — lookup scan exact $eq (cùng giá trị return_tracking_no) */
  returnTrackingNumber?: string;
  /** Mã yêu cầu trả hàng/hoàn tiền Shopee */
  return_sn?: string;
  /** Trạng thái return Shopee: REQUESTED | PROCESSING | ACCEPTED | COMPLETED | ... */
  return_status?: string;
  /** Số tiền hoàn (refund_amount từ get_return_detail) */
  refund_amount?: number;
  /** Lý do trả hàng (reason code Shopee) */
  return_reason?: string;
  /** Lý do chi tiết buyer nhập (text_reason) */
  text_reason?: string;
  /** 0 Normal RR, 1 In-transit RR, 2 Return-on-the-Spot (vẫn là Return/Refund) */
  return_refund_request_type?: number;
  /** Phân loại tab Hủy/Hoàn khớp Seller Center */
  shopee_cancel_return_kind?: 'refund_return' | 'cancelled' | 'failed_delivery';
  /** RTS = giao không thành công; CANCELLED = đơn hủy; RETURN = trả hàng hoàn tiền */
  sub_status?: 'RTS' | 'CANCELLED' | 'RETURN' | string;
  /** Cờ RTS từ backend (giao hàng không thành công) */
  is_rts?: boolean;
  /** Cờ đơn từ get_return_list (có return_sn) — không gắn cho đơn hủy thường */
  is_return?: boolean;
  /** get_order_detail.cancel_reason */
  cancel_reason?: string;
  buyer_cancel_reason?: string;
  cancel_by?: string;
  internalTrackingCode?: string; // Shopee sorting / first-mile (0FG...) — mã nội bộ sàn
  packageNumber?: string; // Shopee package_number, required by logistics APIs for split orders
  /** Flag nội bộ: đơn bị Shopee giữ (pending verification) — đưa vào tab kiểm tra */
  is_pending_shopee_check?: boolean;
  isPrepared?: boolean;
  /** PDF vận đơn đã lưu sẵn trong kho nội bộ (BG worker) — khác isPrinted. */
  hasPdf?: boolean;
  readyToPrint?: boolean;
  isPrinted?: boolean;
  /** URL PDF vận đơn đã tạo (in nhanh qua window.open, không gọi lại API). */
  labelUrl?: string;
  pdfUrl?: string;
  /** Alias ERP — URL PDF nội bộ đã cache (đồng bộ với labelUrl). */
  waybill_url?: string;
  pdfFilename?: string;
  /**
   * Canonical cờ nội bộ: đã bàn giao ĐVVC (QR / nút Bàn giao).
   * default false — sync Shopee không được ghi đè.
   */
  is_handed_over?: boolean;
  /** @deprecated alias → is_handed_over */
  isHandedOverToCarrier?: boolean;
  /** @deprecated alias → is_handed_over */
  is_handed_over_to_carrier?: boolean;
  /** @deprecated alias → is_handed_over */
  is_handed_over_to_courier?: boolean;
  /**
   * Cờ trạng thái nội bộ kho (chỉ DB local — không gọi Shopee):
   * NONE | HANDED_OVER | CANCELLED_STORED | RETURN_RECEIVED
   */
  local_status?: 'NONE' | 'HANDED_OVER' | 'CANCELLED_STORED' | 'RETURN_RECEIVED' | null;
  localStatus?: 'NONE' | 'HANDED_OVER' | 'CANCELLED_STORED' | 'RETURN_RECEIVED' | null;
  /** Alias = local_status */
  internal_status?: 'NONE' | 'HANDED_OVER' | 'CANCELLED_STORED' | 'RETURN_RECEIVED' | null;
  /** Cờ quét kho (alias local_status) */
  scanFlag?: string;
  /** Thời điểm cập nhật local_status (ISO) — dùng retention 14 ngày */
  local_status_updated_at?: string;
  localStatusAt?: string;
  /** Đã đưa ra khỏi tab đối soát hủy/hoàn sau 14 ngày (không xóa đơn) */
  is_local_return_archived?: boolean;
  /** Bản ghi thuộc collection don_hoan_huy (tab Đã nhận hủy/hoàn) */
  don_hoan_huy?: boolean;
  scannedAt?: string;
  handedOverAt?: string;
  handed_over_source?: 'qr_scan' | 'manual_button' | string | null;
  handedOverSource?: 'qr_scan' | 'manual_button' | string | null;
  /** Mã giảm giá Shop (voucher_from_seller) — KHÔNG gồm Shopee Voucher */
  seller_voucher?: number;
  items: {
    productId: string;
    productTitle: string;
    productImage?: string;
    quantity: number;
    originalQuantity?: number;
    cancelledQty?: number;
    cancelRequestedQty?: number;
    cancelled?: boolean;
    price: number;
    /** Giá gốc listing (model_original_price) trước mã giảm giá Shop */
    originalPrice?: number;
    modelId?: string;
    modelSku?: string;
    modelName?: string;
    /** Chỉ số lựa chọn tier Shopee, dùng khi GetOrderDetail trả về tier_index. */
    tierIndex?: number[];
  }[];
}

export interface ConnectedShop {
  id: string;
  platform: 'shopee' | 'tiktok' | 'woocommerce';
  shopId: string;
  shopName: string;
  apiKey: string;
  apiSecret?: string; // For WooCommerce Customer Secret
  wooUrl?: string; // For WooCommerce Website URL
  connected: boolean;
  lastSynced?: string;
  /** Trạng thái token thật từ backend: online | expired | missing */
  connection_status?: 'online' | 'expired' | 'missing';
  connection_message?: string;
  token_expires_at?: number | null;
}

export interface ChannelSettings {
  shopeeConnected: boolean;
  shopeeShopId: string;
  shopeeApiKey: string;
  tiktokConnected: boolean;
  tiktokShopId: string;
  tiktokApiKey: string;
  /** Phí Shopee dự phòng (%) khi API chưa trả estimated income */
  shopeeDefaultFeeRate?: number;
  /** Chi phí đóng gói/vận hành tự động áp dụng cho mỗi đơn */
  packagingCostPerOrder?: number;
  /** Danh sách phí động dùng để ước tính khi Shopee chưa đối soát escrow */
  systemFees?: SystemFee[];
  woocommerceConnected?: boolean;
  woocommerceUrl?: string;
  woocommerceConsumerKey?: string;
  woocommerceConsumerSecret?: string;
  shops?: ConnectedShop[];
}

export interface SyncLog {
  id: string;
  timestamp: string;
  channel: 'shopee' | 'tiktok' | 'woocommerce' | 'manual' | 'all' | 'ghn' | 'spx';
  type: 'product_sync' | 'price_update' | 'stock_sync' | 'publish';
  status: 'success' | 'failed' | 'running';
  message: string;
}

export interface Supplier {
  id: string;
  name: string;
  supplierCode: string;
  totalOrderValue: number;
  totalPaid: number;
  totalDebt: number;
  status: 'active' | 'inactive';
}

export interface ImportTransaction {
  id: string;
  supplierId: string;
  supplierName: string;
  date: string;
  productId: string;
  productTitle: string;
  productSku: string;
  quantity: number;
  oldImportPrice: number;
  newImportPrice: number;
  importCost?: number;
  totalAmount: number;
  paidAmount: number;
  status: 'fully_paid' | 'partial' | 'unpaid';
  notes?: string;
  warehouseId?: string;
  createdAt?: string;
}
