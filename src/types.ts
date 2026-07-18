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

export interface Order {
  id: string;
  orderSn: string;
  channel: 'shopee' | 'tiktok' | 'woocommerce' | 'manual';
  shopId?: string; // ConnectedShop ID
  shopName?: string; // Cache shopName to display which shop
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  shippingAddress?: {
    province: string;
    provinceCode?: string;
    district: string;
    districtCode?: string;
    ward: string;
    wardCode?: string;
    street: string;
    fullAddress?: string;
  };
  carrier?: 'self' | 'ghn' | 'spx';
  totalAmount: number;
  revenue: number; // Net revenue after channel fees
  withholdingCitTax?: number;
  /** Mirror snake_case field from Shopee OpenAPI order_income.withholding_cit_tax */
  withholding_cit_tax?: number;
  escrowAmount?: number;
  partialCancel?: boolean;
  canPartialCancel?: boolean;
  status: 'pending_confirm' | 'unprocessed' | 'processed' | 'shipping' | 'cancelled' | 'return_pending' | 'return_received' | 'completed';
  date: string;
  trackingNumber?: string; // Carrier tracking (SPXVN..., GHN...) — mã trên phiếu giao / QR quét
  internalTrackingCode?: string; // Shopee sorting / first-mile (0FG...) — mã nội bộ sàn
  packageNumber?: string; // Shopee package_number, required by logistics APIs for split orders
  isPrepared?: boolean;
  isPrinted?: boolean;
  /** Trạng thái nội bộ: đã bàn giao cho bưu tá/ĐVVC, chưa quét nhập kho Shopee */
  isHandedOverToCarrier?: boolean;
  /** Mirror snake_case for DB / API */
  is_handed_over_to_carrier?: boolean;
  items: {
    productId: string;
    productTitle: string;
    productImage?: string;
    quantity: number;
    originalQuantity?: number;
    cancelledQty?: number;
    cancelRequestedQty?: number;
    price: number;
    modelId?: string;
    modelSku?: string;
    modelName?: string;
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
}

export interface ChannelSettings {
  shopeeConnected: boolean;
  shopeeShopId: string;
  shopeeApiKey: string;
  tiktokConnected: boolean;
  tiktokShopId: string;
  tiktokApiKey: string;
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
}
