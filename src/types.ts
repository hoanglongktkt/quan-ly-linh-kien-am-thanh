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
  tierLabels?: string[];
  avatarUrl?: string;
  tiktokId?: string;
  wooId?: string; // WooCommerce Product ID
  status: 'active' | 'draft' | 'out_of_stock';
  description: string;
  imageUrl?: string;
  lastSynced?: string;
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
  customerName: string;
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
  status: 'pending_confirm' | 'unprocessed' | 'processed' | 'shipping' | 'cancelled' | 'return_pending' | 'return_received' | 'completed';
  date: string;
  trackingNumber?: string;
  packageNumber?: string; // Shopee package_number, required by logistics APIs for split orders
  isPrepared?: boolean;
  isPrinted?: boolean;
  items: {
    productId: string;
    productTitle: string;
    productImage?: string;
    quantity: number;
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
