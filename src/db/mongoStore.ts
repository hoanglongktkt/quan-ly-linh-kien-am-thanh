/**
 * MongoDB Atlas — Single Source of Truth.
 * Mọi đọc: await Model.find({})
 * Mọi ghi: await insertMany / findOneAndUpdate / deleteMany
 * KHÔNG dùng mảng in-memory làm nguồn dữ liệu.
 */
import mongoose, { Schema, type Model } from "mongoose";
import fs from "fs";
import path from "path";
import {
  connectDB as connectMongoShared,
  getMongoUri,
  reconnectDB,
} from "../../config/db.js";
import DonHoanHuyModelImport from "../../models/DonHoanHuy.js";
import { stringifyShopeeIdsDeep, toShopeeId } from "../../services/shopee/jsonBig.js";
import {
  isProductsDiskMode,
  setProductsDiskAppRoot,
  getProductsDiskPath,
  readProductsFromDisk,
  saveProductsToDisk,
  upsertProductsToDisk,
  deleteProductsByIdsFromDisk,
  countProductsOnDisk,
  loadProductsPageFromDisk,
  loadProductByIdFromDisk,
  loadProductsByIdsFromDisk,
  searchProductsFromDisk,
  applyImportStockAndPriceOnDisk,
  inheritShopeeLinkFromParent,
} from "./productsDiskStore.ts";
import {
  setChannelListingsDiskAppRoot,
  getChannelListingsDiskPath,
  readChannelListingsFromDisk,
  saveChannelListingsToDisk,
  upsertChannelListingsToDisk,
  upsertChannelListingToDisk,
  countChannelListingsOnDisk,
  deleteAllChannelListingsFromDisk,
} from "./channelListingsDiskStore.ts";
import {
  buildAccentFlexibleRegex,
  normalizeProductSearchText,
} from "../utils/productSearch.ts";
import {
  isCarrierTrackingCode,
  isShopeeInternalTrackingCode,
} from "../utils/orderTracking.ts";
import {
  classifyShopeeCancelReturnKind,
  isShopeeRtsLogistics,
  isUnshippedShopeeCancel,
  resolveShopeeSubStatus,
} from "../utils/shopeeCancelReturnClassify.ts";
import { calculateProfitWithSystemFees } from "../utils/profitCalculator.ts";
import type { SystemFee } from "../types";

export { isProductsDiskMode, getProductsDiskPath, setProductsDiskAppRoot, inheritShopeeLinkFromParent };
export { getChannelListingsDiskPath };

export type LocalInventoryCache = {
  updatedAt: string;
  products: any[];
  listings: any[];
};

type ProductDoc = {
  _id: string;
  sku?: string | null;
  /** Shopee medicine_id (uint64) — lưu String tránh mất precision. */
  medicine_id?: string | null;
  data: any;
};

type ListingDoc = {
  _id: string;
  channelId?: string | null;
  platform?: string | null;
  sku?: string | null;
  status?: string | null;
  linkedProductId?: string | null;
  data: any;
};

type MetaDoc = {
  _id: string;
  value: string;
};

type OrderDoc = {
  _id: string;
  orderSn?: string | null;
  /** Trạng thái UI local (processed/shipping/...) — KHÔNG thay thế shopee_order_status */
  status?: string | null;
  /** Raw Shopee order_status — SSOT (READY_TO_SHIP / SHIPPED / ...) */
  shopee_order_status?: string | null;
  shopId?: string | null;
  /** Mã vận đơn (SPXVN / GHN / ...) — top-level để query & force update */
  tracking_no?: string | null;
  trackingNumber?: string | null;
  /** Mã vận đơn chiều hoàn */
  return_tracking_no?: string | null;
  returnTrackingNumber?: string | null;
    return_sn?: string | null;
    is_return?: boolean | null;
    shopee_cancel_return_kind?: string | null;
    is_rts?: boolean | null;
    sub_status?: string | null;
  /** Cờ YCTH mới — FE poll toast, ACK sẽ tắt */
  return_alert_pending?: boolean;
  return_alert_at?: Date | null;
  /** Shopee package_number (OFG...) — cốt lõi in vận đơn / logistics */
  packageNumber?: string | null;
  /** Tên ĐVVC từ Shopee */
  shipping_carrier?: string | null;
  /** Flag bẫy lỗi: đơn đang chờ Shopee kiểm tra — default false */
  is_pending_shopee_check?: boolean;
  /**
   * Cờ nội bộ: đã bàn giao ĐVVC (QR / nút Bàn giao).
   * CHỈ ghi bởi API bàn giao — sync Shopee chỉ $setOnInsert.
   */
  is_handed_over?: boolean;
  isPrinted?: boolean;
  /** PDF đã lưu sẵn (BG) — khác isPrinted (user đã in ra giấy). */
  hasPdf?: boolean;
  /** URL PDF vận đơn nội bộ đã cache (ERP) */
  waybill_url?: string | null;
  isPrepared?: boolean;
  /** Thời điểm bản trạng thái Shopee cuối cùng được xác minh. */
  last_synced_at?: Date | null;
  last_shopee_update_at?: Date | null;
  /** Thời điểm tạo đơn (Date) — $match list/counter, compound index với shopId. */
  create_time?: Date | null;
  sync_state?: string | null;
  /** Nguồn đơn: woocommerce / shopee / tiktok */
  channel?: string | null;
  source?: string | null;
  /** Thông tin khách — WooCommerce (giao hàng ngoài) */
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerAddress?: string | null;
  billing?: any;
  shipping?: any;
  data: any;
};

type OrderEventDoc = {
  _id: string;
  orderSn: string;
  shopId?: string | null;
  source: string;
  previous_status?: string | null;
  next_status?: string | null;
  previous_shopee_status?: string | null;
  next_shopee_status?: string | null;
  logistics_status?: string | null;
  occurred_at: Date;
  payload?: any;
};

type SyncJobDoc = {
  _id: string;
  type: string;
  state: "queued" | "running" | "succeeded" | "failed";
  started_at?: Date | null;
  finished_at?: Date | null;
  metrics?: any;
  error?: string | null;
  requested_by?: string | null;
};

/** TTL mặc định 14 ngày (1.209.600 giây) — Atlas Free 512MB dễ đầy vì order_events. */
const ORDER_EVENT_TTL_SECONDS = Math.max(
  24 * 60 * 60,
  Number(process.env.ORDER_EVENT_TTL_SECONDS || 14 * 24 * 60 * 60),
);
const SYNC_JOB_TTL_SECONDS = Math.max(
  24 * 60 * 60,
  Number(process.env.SYNC_JOB_TTL_SECONDS || 14 * 24 * 60 * 60),
);

const ProductSchema = new Schema<ProductDoc>(
  {
    _id: { type: String, required: true },
    sku: { type: String, default: null, index: true },
    // Shopee OpenAPI medicine_id (uint64) — String bắt buộc (không Number).
    medicine_id: { type: String, default: null, index: true },
    // data.* giữ Mixed nhưng Shopee uint64 IDs (shopeeItemId/shopeeModelId/item_id/model_id/promotion_id/activity_id)
    // BẮT BUỘC là String — sanitize bằng stringifyShopeeIdsDeep trước khi ghi.
    data: { type: Schema.Types.Mixed, required: true },
  },
  { collection: "products", versionKey: false }
);

// Index phục vụ search Kho Gốc (SKU / tên) — syncIndexes lúc boot
ProductSchema.index({ "data.sku": 1 });
ProductSchema.index({ "data.title": 1 });
ProductSchema.index({ "data.children.sku": 1 });
ProductSchema.index({ "data.children_models.sku": 1 });
// Hỗ trợ Dashboard: query tồn kho thấp có $lt + sort — tránh COLLSCAN khi catalog lớn.
ProductSchema.index({ "data.stock": 1 });

const ChannelListingSchema = new Schema<ListingDoc>(
  {
    _id: { type: String, required: true },
    channelId: { type: String, default: null, index: true },
    platform: { type: String, default: null, index: true },
    sku: { type: String, default: null, index: true },
    status: { type: String, default: null, index: true },
    linkedProductId: { type: String, default: null, index: true },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { collection: "channel_listings", versionKey: false }
);

const MetaSchema = new Schema<MetaDoc>(
  {
    _id: { type: String, required: true },
    value: { type: String, required: true },
  },
  { collection: "meta", versionKey: false }
);

const OrderSchema = new Schema<OrderDoc>(
  {
    _id: { type: String, required: true },
    // Unique index khai báo riêng bên dưới (orderSn_unique) — KHÔNG dùng index: true để tránh trùng orderSn_1.
    orderSn: { type: String, default: null },
    status: { type: String, default: null, index: true },
    /** Raw Shopee — bắt buộc lưu khi sync (READY_TO_SHIP / SHIPPED / ...) */
    shopee_order_status: { type: String, default: null, index: true },
    /** Shopee shop_id — luôn String (uint64-safe) */
    shopId: { type: String, default: null, index: true },
    tracking_no: { type: String, default: null, index: true },
    /** Alias camelCase — lookup scan exact $eq (cùng giá trị tracking_no) */
    trackingNumber: { type: String, default: null, index: true },
    /** Mã vận đơn chiều hoàn — quét barcode return */
    return_tracking_no: { type: String, default: null, index: true },
    /** Alias camelCase — lookup scan exact $eq (cùng giá trị return_tracking_no) */
    returnTrackingNumber: { type: String, default: null, index: true },
    /** Mã yêu cầu trả hàng / hoàn tiền Shopee (return_sn) — luôn String */
    return_sn: { type: String, default: null },
    /** Cờ đơn từ get_return_list — không gắn cho đơn hủy thường */
    is_return: { type: Boolean, default: false },
    /** refund_return | cancelled | failed_delivery — SSOT đếm sub-tab */
    shopee_cancel_return_kind: { type: String, default: null, index: true },
    is_rts: { type: Boolean, default: false, index: true },
    sub_status: { type: String, default: null, index: true },
    /** YCTH mới chưa toast trên UI */
    return_alert_pending: { type: Boolean, default: false, index: true },
    return_alert_at: { type: Date, default: null },
    /** Shopee package_number (OFG...) — bắt buộc cho create_shipping_document / logistics */
    packageNumber: { type: String, default: null, index: true },
    shipping_carrier: { type: String, default: null, index: true },
    is_pending_shopee_check: { type: Boolean, default: false, index: true },
    /** Cờ nội bộ — chỉ $setOnInsert khi sync; QR/bàn giao mới $set true */
    is_handed_over: { type: Boolean, default: false, index: true },
    /** Cờ in vận đơn nội bộ — chỉ $setOnInsert khi sync; API in user mới $set true */
    // Index kép hasPdf+isPrinted khai báo riêng — bỏ index đơn lẻ.
    isPrinted: { type: Boolean, default: false },
    /** Thời điểm user bấm In thành công — vĩnh viễn, sync Shopee KHÔNG ghi đè. */
    printedAt: { type: Date, default: null },
    /** PDF đã tải sẵn vào kho nội bộ — BG worker; KHÔNG đồng nghĩa đã in giấy */
    hasPdf: { type: Boolean, default: false },
    /** URL PDF vận đơn nội bộ (ERP cache) — BG worker ghi sau xác nhận */
    waybill_url: { type: String, default: null },
    isPrepared: { type: Boolean, default: false },
    last_synced_at: { type: Date, default: null, index: true },
    /** Tương đương Shopee update_time — index giảm dần phục vụ quét đơn mới. */
    last_shopee_update_at: { type: Date, default: null },
    create_time: { type: Date, default: null, index: true },
    sync_state: { type: String, default: "verified", index: true },
    /** Nguồn đơn: woocommerce / shopee / tiktok */
    channel: { type: String, default: null, index: true },
    source: { type: String, default: null },
    /** Thông tin khách — WooCommerce (giao hàng ngoài). Shopee ẩn → null. */
    customerName: { type: String, default: null },
    customerPhone: { type: String, default: null },
    customerEmail: { type: String, default: null },
    customerAddress: { type: String, default: null },
    billing: { type: Schema.Types.Mixed, default: null },
    shipping: { type: Schema.Types.Mixed, default: null },
    // data.items[].productId / modelId / item_id… = String (Shopee uint64)
    data: { type: Schema.Types.Mixed, required: true },
  },
  { collection: "orders", versionKey: false }
);

// `order_sn` của Shopee là định danh toàn cục. Enforce uniqueness ở database để
// bulk upsert/lookup là O(log n) và webhook trùng không tạo thêm document. Partial
// filter giữ các record legacy chưa có orderSn ngoài unique constraint.
OrderSchema.index(
  { orderSn: 1 },
  {
    unique: true,
    partialFilterExpression: { orderSn: { $type: "string" } },
    name: "orderSn_unique",
  },
);
// Luồng in ấn / BG PDF: lọc hasPdf + isPrinted cùng lúc (thay index đơn lẻ).
OrderSchema.index({ hasPdf: 1, isPrinted: 1 });
// Quét đơn mới theo chiều giảm dần (Shopee update_time → last_shopee_update_at).
OrderSchema.index({ last_shopee_update_at: -1 });
OrderSchema.index({ shopId: 1, create_time: -1 }, { name: "shopId_1_create_time_-1" });
OrderSchema.index({ shopId: 1, last_shopee_update_at: -1 }, { name: "shopId_1_last_shopee_update_at_-1" });
// Giữ compound index cho các truy vấn theo shop trong luồng reconciliation.
OrderSchema.index({ orderSn: 1, shopId: 1 });
// Lookup / quét theo package_number (OFG...).
OrderSchema.index({ packageNumber: 1 });
OrderSchema.index({ "data.packageNumber": 1 });
OrderSchema.index({ "data.package_number": 1 });
// Quét kiện hoàn theo return_tracking_no (barcode chiều về).
OrderSchema.index({ "data.return_tracking_no": 1 });
OrderSchema.index({ "data.returnTrackingNumber": 1 });
// Hỗ trợ Dashboard aggregation lọc theo ngày / doanh thu mà không quét toàn bộ collection.
OrderSchema.index({ "data.date": 1 });
OrderSchema.index({ status: 1, "data.date": 1 });
OrderSchema.index({ shopId: 1, shopee_order_status: 1, last_synced_at: 1 });
// ESR cho danh sách theo shop/trạng thái, sau đó sort đơn mới nhất.
OrderSchema.index({ shopId: 1, shopee_order_status: 1, "data.date": -1, _id: -1 });
OrderSchema.index({ shopId: 1, status: 1, "data.date": -1, _id: -1 });
// Khớp trực tiếp với truy vấn danh sách đơn mới nhất, tránh MongoDB phải sort lại
// toàn bộ collection sau mỗi lần làm mới.
OrderSchema.index({ "data.date": -1, _id: -1 });
// Quét ĐVVC / lookup — tracking trong data (barcode VĐ).
OrderSchema.index({ "data.tracking_no": 1 });
OrderSchema.index({ "data.trackingNumber": 1 });
OrderSchema.index({ "data.orderSn": 1 });
OrderSchema.index({ "data.order_sn": 1 });
OrderSchema.index({ "data.internalTrackingCode": 1 });
OrderSchema.index({ return_sn: 1 });
OrderSchema.index({ "data.return_sn": 1 });
OrderSchema.index({ shopee_cancel_return_kind: 1, "data.date": -1 });
OrderSchema.index({ "data.shopee_cancel_return_kind": 1, "data.date": -1 });

const OrderEventSchema = new Schema<OrderEventDoc>(
  {
    _id: { type: String, required: true },
    orderSn: { type: String, required: true, index: true },
    shopId: { type: String, default: null, index: true },
    source: { type: String, required: true, index: true },
    previous_status: { type: String, default: null },
    next_status: { type: String, default: null },
    previous_shopee_status: { type: String, default: null },
    next_shopee_status: { type: String, default: null },
    logistics_status: { type: String, default: null },
    occurred_at: { type: Date, required: true, index: true },
    payload: { type: Schema.Types.Mixed, default: null },
  },
  { collection: "order_events", versionKey: false }
);
OrderEventSchema.index({ orderSn: 1, occurred_at: -1 });
OrderEventSchema.index(
  { occurred_at: 1 },
  { expireAfterSeconds: ORDER_EVENT_TTL_SECONDS, name: "order_events_ttl" },
);

const SyncJobSchema = new Schema<SyncJobDoc>(
  {
    _id: { type: String, required: true },
    type: { type: String, required: true, index: true },
    state: { type: String, required: true, index: true },
    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null },
    metrics: { type: Schema.Types.Mixed, default: {} },
    error: { type: String, default: null },
    requested_by: { type: String, default: null },
  },
  { collection: "sync_jobs", versionKey: false }
);
SyncJobSchema.index({ type: 1, started_at: -1 });
// finished_at null cho job đang chạy, nên TTL không thể xóa job chưa hoàn tất.
SyncJobSchema.index(
  { finished_at: 1 },
  { expireAfterSeconds: SYNC_JOB_TTL_SECONDS, name: "sync_jobs_ttl" },
);

/** Tab "Đã nhận đơn hủy, đơn hoàn" — type + model SSOT từ models/DonHoanHuy.js. */
type DonHoanHuyDoc = {
  _id?: string;
  orderSn: string;
  status: string;
  scannedAt: Date;
  note?: string;
  shopId?: string | null;
  type?: "cancelled" | "return";
  local_status?: "CANCELLED_STORED" | "RETURN_RECEIVED";
  createdAt?: Date;
  tracking_no?: string | null;
  return_tracking_no?: string | null;
  shopee_order_status?: string | null;
  shopName?: string | null;
  scan_code?: string | null;
  source?: string | null;
  data?: any;
};

let ProductModel: Model<ProductDoc>;
let ChannelListingModel: Model<ListingDoc>;
let MetaModel: Model<MetaDoc>;
let OrderModel: Model<OrderDoc>;
let OrderEventModel: Model<OrderEventDoc>;
let SyncJobModel: Model<SyncJobDoc>;
let DonHoanHuyModel: Model<DonHoanHuyDoc>;

let mongoReady = false;
let appRootResolved = "";
/** Serialize writes to avoid concurrent replace races. */
let writeChain: Promise<void> = Promise.resolve();

function ensureModels(): void {
  ProductModel =
    (mongoose.models.Product as Model<ProductDoc>) ||
    mongoose.model<ProductDoc>("Product", ProductSchema);
  ChannelListingModel =
    (mongoose.models.ChannelListing as Model<ListingDoc>) ||
    mongoose.model<ListingDoc>("ChannelListing", ChannelListingSchema);
  MetaModel =
    (mongoose.models.AppMeta as Model<MetaDoc>) ||
    mongoose.model<MetaDoc>("AppMeta", MetaSchema);
  OrderModel =
    (mongoose.models.Order as Model<OrderDoc>) ||
    mongoose.model<OrderDoc>("Order", OrderSchema);
  OrderEventModel =
    (mongoose.models.OrderEvent as Model<OrderEventDoc>) ||
    mongoose.model<OrderEventDoc>("OrderEvent", OrderEventSchema);
  SyncJobModel =
    (mongoose.models.SyncJob as Model<SyncJobDoc>) ||
    mongoose.model<SyncJobDoc>("SyncJob", SyncJobSchema);
  // SSOT: schema chỉ định nghĩa tại models/DonHoanHuy.js
  DonHoanHuyModel =
    (mongoose.models.DonHoanHuy as Model<DonHoanHuyDoc>) ||
    (DonHoanHuyModelImport as Model<DonHoanHuyDoc>);
}

function requireMongo(): void {
  if (!isMongoReady()) {
    throw new Error("Chưa kết nối được Database, vui lòng kiểm tra App Logs");
  }
  ensureModels();
}

function toProductDocs(products: any[]): ProductDoc[] {
  const out: ProductDoc[] = [];
  for (const p of products) {
    if (!p || typeof p !== "object") continue;
    const id = String(p.id || "").trim();
    if (!id) continue;
    const data = stringifyShopeeIdsDeep(p);
    // Ép tường minh các field ID Shopee sang String trước khi ghi Mongo.
    if (data.shopeeItemId != null) data.shopeeItemId = toShopeeId(data.shopeeItemId) || String(data.shopeeItemId);
    if (data.shopeeModelId != null) data.shopeeModelId = toShopeeId(data.shopeeModelId) || String(data.shopeeModelId);
    if (data.shopeeId != null) data.shopeeId = String(data.shopeeId);
    if (data.medicine_id != null && data.medicine_id !== "") {
      data.medicine_id = toShopeeId(data.medicine_id) || String(data.medicine_id);
    }
    out.push({
      _id: id,
      sku: data.sku != null ? String(data.sku) : null,
      medicine_id:
        data.medicine_id != null && data.medicine_id !== ""
          ? String(data.medicine_id)
          : null,
      data,
    });
  }
  return out;
}

function toListingDocs(rows: any[]): ListingDoc[] {
  const out: ListingDoc[] = [];
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const id = String(r.id || "").trim();
    if (!id) continue;
    const data = stringifyShopeeIdsDeep(r);
    out.push({
      _id: id,
      channelId: data.channelId != null ? String(data.channelId) : null,
      platform: data.platform != null ? String(data.platform) : null,
      sku: data.sku != null ? String(data.sku) : null,
      status: data.status != null ? String(data.status) : null,
      linkedProductId: data.linkedProductId != null ? String(data.linkedProductId) : null,
      data,
    });
  }
  return out;
}

function docsToProducts(
  docs: Array<{ _id?: any; data?: any; sku?: string | null; medicine_id?: string | null }>,
): any[] {
  const out: any[] = [];
  for (const d of docs) {
    if (!d?.data || typeof d.data !== "object") continue;
    const data = { ...d.data };
    if (!data.id && d._id != null) data.id = String(d._id);
    if ((data.sku == null || data.sku === "") && d.sku != null) data.sku = String(d.sku);
    if (
      (data.medicine_id == null || data.medicine_id === "") &&
      d.medicine_id != null &&
      d.medicine_id !== ""
    ) {
      data.medicine_id = String(d.medicine_id);
    }
    out.push(data);
  }
  return out;
}

function docsToListings(docs: Array<{ data?: any }>): any[] {
  const out: any[] = [];
  for (const d of docs) {
    if (d?.data && typeof d.data === "object") out.push(d.data);
  }
  return out;
}

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  const next = writeChain.then(task);
  writeChain = next.catch((err) => {
    console.error("[MongoDB] Write chain error:", err);
  });
  return next;
}

/** Không để một bulkWrite treo khóa tiến trình ship/print vô hạn trên cPanel. */
function withWriteTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isMongoReady(): boolean {
  return mongoReady && mongoose.connection.readyState === 1;
}

/**
 * Sau lỗi "connection N to host:27017 timed out" — đóng pool cũ và nối lại.
 * Trả true nếu readyState === 1 sau reconnect.
 */
export async function recoverMongoConnection(reason = "timeout"): Promise<boolean> {
  console.warn(`[MongoDB] recoverMongoConnection (${reason}) — reconnecting...`);
  mongoReady = false;
  try {
    await reconnectDB();
    mongoReady = mongoose.connection.readyState === 1;
    if (mongoReady) {
      console.log("[MongoDB] recoverMongoConnection OK");
      return true;
    }
  } catch (err: any) {
    console.error(
      "[MongoDB] recoverMongoConnection FAILED:",
      err?.message || err,
    );
  }
  mongoReady = false;
  return false;
}

export function getMongoUriMasked(): string {
  const uri = getMongoUri();
  if (!uri) return "(missing MONGODB_URI)";
  return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}

export function setStoreAppRoot(appRoot: string): void {
  appRootResolved = appRoot;
}

/**
 * Kết nối MongoDB Atlas ngay khi boot.
 * KHÔNG throw / KHÔNG process.exit — failure chỉ log, app vẫn chạy.
 * @returns true nếu kết nối OK
 */
export async function initMongo(appRoot?: string): Promise<boolean> {
  if (appRoot) appRootResolved = appRoot;
  if (!appRootResolved) appRootResolved = process.cwd();
  setProductsDiskAppRoot(appRootResolved);
  setChannelListingsDiskAppRoot(appRootResolved);

  if (isProductsDiskMode()) {
    console.log(
      `[Products] STORAGE=disk — Kho Gốc: ${getProductsDiskPath()} | Mapping: ${getChannelListingsDiskPath()} (không ghi Mongo products/listings)`,
    );
  }

  const uri = getMongoUri();
  console.log(`[MongoDB] Boot — APP_ROOT=${appRootResolved}`);
  console.log(`[MongoDB] Boot — URI=${getMongoUriMasked()}`);

  if (!uri) {
    mongoReady = false;
    console.error(
      "LỖI MONGODB STARTUP:",
      "thiếu MONGODB_URI / MONGO_URL trong .env hoặc Environment Variables."
    );
    return isProductsDiskMode();
  }

  try {
    ensureModels();
    // SSOT singleton: luôn await connectDB (mutex nội bộ) — không bỏ qua khi readyState=2.
    await connectMongoShared();
    try {
      fs.writeFileSync(
        path.join(appRootResolved, "db_status.txt"),
        "KET_NOI_THANH_CONG_LUC: " + new Date().toISOString()
      );
    } catch {
      /* ignore write status file */
    }

    mongoReady = mongoose.connection.readyState === 1;
    if (!mongoReady) {
      console.error(
        "LỖI MONGODB STARTUP:",
        `mongoose readyState=${mongoose.connection.readyState} (expect 1)`
      );
      return isProductsDiskMode();
    }

    const [productCount, listingCount] = await Promise.all([
      ProductModel.countDocuments(),
      ChannelListingModel.countDocuments(),
    ]);

    console.log("MongoDB Connected Successfully");
    console.log(
      `[MongoDB] Connected Successfully — ${getMongoUriMasked()} | products(mongo)=${productCount} | channel_listings(mongo)=${listingCount}` +
        (isProductsDiskMode()
          ? ` | warehouse=DISK products=${countProductsOnDisk()} listings=${countChannelListingsOnDisk()}`
          : " | warehouse=Mongo products+listings"),
    );

    if (!isProductsDiskMode()) {
      try {
        await ProductModel.syncIndexes();
        console.log("[MongoDB] Product indexes synced (sku, data.sku, text title/sku, children.sku)");
      } catch (idxErr) {
        console.warn("[MongoDB] syncIndexes products:", idxErr);
      }
    } else {
      try {
        await maybeMigrateMongoProductsToDisk(productCount);
      } catch (migErr: any) {
        console.warn("[Products Disk] migrate Mongo→disk:", migErr?.message || migErr);
      }
      try {
        await maybeMigrateMongoListingsToDisk(listingCount);
      } catch (migErr: any) {
        console.warn("[Listings Disk] migrate Mongo→disk:", migErr?.message || migErr);
      }
      try {
        await maybeDropMongoListingsWhenDiskReady(
          await ChannelListingModel.countDocuments().catch(() => listingCount),
        );
      } catch (dropErr: any) {
        console.warn("[Listings Disk] drop Mongo leftover:", dropErr?.message || dropErr);
      }
    }

    try {
      await OrderModel.syncIndexes();
      console.log(
        "[MongoDB] Order indexes synced (orderSn_unique, hasPdf+isPrinted, last_shopee_update_at:-1, …)",
      );
    } catch (idxErr) {
      console.warn("[MongoDB] syncIndexes orders:", idxErr);
    }

    // TTL + dọn ngay order_events/sync_jobs (Atlas Free 512MB — không chờ TTL monitor).
    try {
      const ttl = await ensureRetentionTtlIndexes();
      console.log(
        `[MongoDB] TTL ready order_events=${ttl.orderEventsTtlSeconds}s sync_jobs=${ttl.syncJobsTtlSeconds}s` +
          ` (recreated=${ttl.recreated.join(",") || "none"})`,
      );
    } catch (ttlErr: any) {
      console.warn("[MongoDB] ensureRetentionTtlIndexes:", ttlErr?.message || ttlErr);
    }
    void purgeMongoTempCollections({ orderEventDays: 14, syncJobDays: 14 })
      .then((r) => {
        console.log(
          `[MongoDB] Temp cleanup boot: order_events_deleted=${r.orderEventsDeleted}` +
            ` sync_jobs_deleted=${r.syncJobsDeleted} before_events=${r.orderEventsBefore}`,
        );
      })
      .catch((err: any) =>
        console.warn("[MongoDB] Temp cleanup boot failed:", err?.message || err),
      );

    // One-time migrate từ JSON local nếu Atlas trống (chỉ khi Kho Gốc vẫn dùng Mongo).
    if (!isProductsDiskMode() && productCount === 0 && listingCount === 0) {
      try {
        await maybeMigrateJsonFallbackToMongo();
      } catch (migrateErr: unknown) {
        const msg = migrateErr instanceof Error ? migrateErr.message : String(migrateErr);
        console.error("LỖI MONGODB STARTUP:", `migrate fallback failed: ${msg}`);
      }
    }
    return true;
  } catch (err: unknown) {
    mongoReady = false;
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "undefined";
    fs.writeFileSync(
      path.join(appRootResolved, "db_status.txt"),
      "LOI_KET_NOI: " + msg + " | CODE: " + code
    );
    console.error("LỖI MONGODB STARTUP:", msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    return isProductsDiskMode();
  }
}

/** Xuất collection products Mongo → data/products.json khi disk còn trống. */
async function maybeMigrateMongoProductsToDisk(mongoProductCount: number): Promise<void> {
  if (!isProductsDiskMode()) return;
  const existing = readProductsFromDisk();
  if (existing.length > 0) {
    console.log(`[Products Disk] Đã có ${existing.length} SP trên đĩa — bỏ qua migrate.`);
    return;
  }
  if (!mongoReady || mongoProductCount <= 0) {
    console.log("[Products Disk] Disk trống và Mongo không có products — bắt đầu kho trống trên đĩa.");
    return;
  }
  console.log(`[Products Disk] Migrating ${mongoProductCount} products Mongo → disk...`);
  const docs = await ProductModel.find({}).lean();
  const products = docsToProducts(docs as any[]);
  await saveProductsToDisk(products);
  const drop =
    String(process.env.PRODUCTS_DROP_MONGO_AFTER_MIGRATE || "1").trim() !== "0";
  if (drop) {
    try {
      const del = await ProductModel.deleteMany({});
      console.log(
        `[Products Disk] Đã xóa products trên Mongo để giải phóng Atlas — deleted=${del.deletedCount || 0}`,
      );
    } catch (err: any) {
      console.warn(
        "[Products Disk] Không xóa được products trên Mongo (có thể Atlas chặn ghi):",
        err?.message || err,
      );
    }
  }
}

/** Xuất channel_listings Mongo → data/channel_listings.json khi disk còn trống. */
async function maybeMigrateMongoListingsToDisk(mongoListingCount: number): Promise<void> {
  if (!isProductsDiskMode()) return;
  const existing = readChannelListingsFromDisk();
  if (existing.length > 0) {
    console.log(`[Listings Disk] Đã có ${existing.length} mapping trên đĩa — bỏ qua migrate.`);
    return;
  }
  if (!mongoReady || mongoListingCount <= 0) {
    console.log("[Listings Disk] Disk trống và Mongo không có listings — bắt đầu mapping trống trên đĩa.");
    return;
  }
  console.log(`[Listings Disk] Migrating ${mongoListingCount} channel_listings Mongo → disk...`);
  const docs = await ChannelListingModel.find({}).lean();
  const listings = docsToListings(docs as any[]);
  await saveChannelListingsToDisk(listings);
  const drop =
    String(process.env.LISTINGS_DROP_MONGO_AFTER_MIGRATE || process.env.PRODUCTS_DROP_MONGO_AFTER_MIGRATE || "1").trim() !==
    "0";
  if (drop) {
    try {
      const del = await ChannelListingModel.deleteMany({});
      console.log(
        `[Listings Disk] Đã xóa channel_listings trên Mongo để giải phóng Atlas — deleted=${del.deletedCount || 0}`,
      );
    } catch (err: any) {
      console.warn(
        "[Listings Disk] Không xóa được listings trên Mongo (có thể Atlas chặn ghi):",
        err?.message || err,
      );
    }
  }
}

/** Disk đã là SSOT — cố gắng xóa collection Mongo còn sót để giải phóng Atlas. */
async function maybeDropMongoListingsWhenDiskReady(mongoListingCount: number): Promise<void> {
  if (!isProductsDiskMode() || !mongoReady || mongoListingCount <= 0) return;
  if (countChannelListingsOnDisk() <= 0) return;
  const drop =
    String(process.env.LISTINGS_DROP_MONGO_AFTER_MIGRATE || process.env.PRODUCTS_DROP_MONGO_AFTER_MIGRATE || "1").trim() !==
    "0";
  if (!drop) return;
  try {
    const del = await ChannelListingModel.deleteMany({});
    console.log(
      `[Listings Disk] Drop Mongo listings (disk SSOT) — deleted=${del.deletedCount || 0}`,
    );
  } catch (err: any) {
    console.warn("[Listings Disk] Drop Mongo listings (disk SSOT) failed:", err?.message || err);
  }
}

async function maybeMigrateJsonFallbackToMongo(): Promise<void> {
  const productsPath = path.join(appRootResolved, "data", "products.json");
  const listingsPath = path.join(appRootResolved, "data", "channel_listings.json");
  let products: any[] = [];
  let listings: any[] = [];
  try {
    if (fs.existsSync(productsPath)) {
      const parsed = JSON.parse(fs.readFileSync(productsPath, "utf-8"));
      products = Array.isArray(parsed) ? parsed : [];
    }
    if (fs.existsSync(listingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(listingsPath, "utf-8"));
      listings = Array.isArray(parsed) ? parsed : [];
    }
  } catch (err) {
    console.warn("[MongoDB] Không đọc được JSON fallback để migrate:", err);
    return;
  }
  if (products.length === 0 && listings.length === 0) return;
  console.log(
    `[MongoDB] Atlas trống — migrate JSON → Mongo products=${products.length} listings=${listings.length}`
  );
  await saveProductsToStoreAsync(products);
  await saveChannelListingsToStoreAsync(listings);
}

/** Đọc products — disk (hosting) hoặc Mongo. */
export async function loadProductsFromStore(): Promise<any[]> {
  if (isProductsDiskMode()) return readProductsFromDisk();
  requireMongo();
  const docs = await ProductModel.find({}).lean();
  return docsToProducts(docs);
}

/** Filter $regex (i) cho phân trang + count Kho Gốc theo tên/SKU (hỗ trợ bỏ dấu). */
function buildProductListSearchFilter(search: string): Record<string, unknown> {
  const regex = buildAccentFlexibleRegex(search);
  if (!regex) return {};
  return {
    $or: [
      { sku: regex },
      { name: regex },
      { title: regex },
      { "data.sku": regex },
      { "data.name": regex },
      { "data.title": regex },
      { "data.modelName": regex },
      { "data.barcode": regex },
      { "data.children.sku": regex },
      { "data.children.title": regex },
      { "data.children.name": regex },
      { "data.children.modelName": regex },
      { "data.children_models.sku": regex },
      { "data.children_models.title": regex },
      { "data.children_models.modelName": regex },
      { "data.children_models.name": regex },
    ],
  };
}

/** Phân trang kho gốc — luôn skip/limit, cấm find({}) toàn catalog khi dùng Mongo. */
export async function loadProductsPageFromStore(
  page = 1,
  pageSize = 50,
  search = "",
): Promise<{ products: any[]; total: number; page: number; pageSize: number; totalPages: number; hasMore: boolean }> {
  if (isProductsDiskMode()) return loadProductsPageFromDisk(page, pageSize, search);
  requireMongo();
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.min(50, Math.max(1, Math.floor(Number(pageSize) || 50)));
  const q = normalizeProductSearchText(search);
  const filter = buildProductListSearchFilter(search);
  const hasSearch = !!q && Object.keys(filter).length > 0;
  // cPanel/Mongo chậm: cho đến 30s mỗi query trang; không bao giờ fallback load hết kho.
  const COUNT_MAX_MS = 15_000;
  const PAGE_MAX_MS = 30_000;

  let total = 0;
  try {
    total = await ProductModel.countDocuments(filter).maxTimeMS(COUNT_MAX_MS);
  } catch (countErr) {
    console.warn(
      "[MongoDB] countDocuments chậm/lỗi — dùng estimatedDocumentCount:",
      countErr instanceof Error ? countErr.message : countErr,
    );
    // estimatedDocumentCount không áp dụng filter search — chỉ dùng khi không search.
    if (hasSearch) throw countErr;
    total = await ProductModel.estimatedDocumentCount().maxTimeMS(COUNT_MAX_MS);
  }

  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / safeSize) || 1);
  const currentPage = Math.min(safePage, totalPages);
  const docs = await ProductModel.find(filter)
    .sort({ _id: 1 })
    .skip((currentPage - 1) * safeSize)
    .limit(safeSize)
    .maxTimeMS(PAGE_MAX_MS)
    .lean();

  if (hasSearch) {
    console.log("[MongoSearch] loadProductsPageFromStore", {
      q,
      total,
      page: currentPage,
      hits: docs.length,
    });
  }

  return {
    products: docsToProducts(docs),
    total,
    page: currentPage,
    pageSize: safeSize,
    totalPages,
    hasMore: currentPage < totalPages,
  };
}

/** Đọc 1 product theo id nội bộ / shopeeItemId — không quét toàn bộ catalog (Mongo). */
export async function loadProductByIdFromStore(productId: string): Promise<any | null> {
  if (isProductsDiskMode()) return loadProductByIdFromDisk(productId);
  requireMongo();
  const id = String(productId || "").trim();
  if (!id) return null;

  const direct = await ProductModel.findById(id).lean();
  if (direct?.data && typeof direct.data === "object") return direct.data;

  const byItem = await ProductModel.findOne({ "data.shopeeItemId": id }).lean();
  if (byItem?.data && typeof byItem.data === "object") return byItem.data;

  const byChild = await ProductModel.findOne({ "data.children.id": id }).lean();
  if (byChild?.data && typeof byChild.data === "object") {
    const children = Array.isArray(byChild.data.children) ? byChild.data.children : [];
    const child = children.find((c: any) => String(c?.id || "").trim() === id);
    if (child) return inheritShopeeLinkFromParent(child, byChild.data);
  }

  // Biến thể lưu trong children_models (search flatten dùng field này)
  const byChildModel = await ProductModel.findOne({ "data.children_models.id": id }).lean();
  if (byChildModel?.data && typeof byChildModel.data === "object") {
    const models = Array.isArray(byChildModel.data.children_models)
      ? byChildModel.data.children_models
      : [];
    const child = models.find((c: any) => String(c?.id || "").trim() === id);
    if (child) {
      return inheritShopeeLinkFromParent(child, byChildModel.data);
    }
  }

  const byModel = await ProductModel.findOne({ "data.shopeeModelId": id }).lean();
  if (byModel?.data && typeof byModel.data === "object") return byModel.data;

  return null;
}

/** Chỉ kéo products liên quan tới danh sách id / shopeeItemId. */
export async function loadProductsByIdsFromStore(
  productIds: string[],
  shopeeItemIds: string[] = [],
): Promise<any[]> {
  if (isProductsDiskMode()) return loadProductsByIdsFromDisk(productIds, shopeeItemIds);
  requireMongo();
  const ids = [...new Set(productIds.map((v) => String(v || "").trim()).filter(Boolean))];
  const itemIds = [...new Set(shopeeItemIds.map((v) => String(v || "").trim()).filter(Boolean))];
  if (ids.length === 0 && itemIds.length === 0) return [];

  const orClauses: Record<string, unknown>[] = [];
  if (ids.length > 0) {
    orClauses.push({ _id: { $in: ids } });
    orClauses.push({ "data.id": { $in: ids } });
    orClauses.push({ sku: { $in: ids } });
  }
  if (itemIds.length > 0) {
    orClauses.push({ "data.shopeeItemId": { $in: itemIds } });
    orClauses.push({ "data.shopeeModelId": { $in: itemIds } });
    const parentIds = itemIds.map((itemId) => `shopee-item-${itemId}`);
    orClauses.push({ _id: { $in: parentIds } });
  }

  const docs = await ProductModel.find(orClauses.length === 1 ? orClauses[0] : { $or: orClauses })
    .maxTimeMS(6000)
    .lean();
  return docsToProducts(docs);
}

/** Chỉ trả field nhẹ cho UI search — không kèm description HTML. */
function toSearchLeanRow(row: any): any {
  const id = String(row?.id || "").trim();
  const sku = String(row?.sku || "").trim();
  const title = String(row?.title || row?.name || "").trim();
  const image = row?.avatarUrl || row?.imageUrl || row?.image || "";
  const stock = Math.max(0, Math.round(Number(row?.stock ?? row?.current_stock) || 0));
  const importPrice = Math.max(0, Math.round(Number(row?.importPrice ?? row?.last_import_price) || 0));
  return {
    id,
    sku,
    title,
    name: title,
    image,
    imageUrl: image,
    avatarUrl: image,
    stock,
    current_stock: stock,
    importPrice,
    last_import_price: importPrice,
    sellingPrice: Math.max(0, Math.round(Number(row?.sellingPrice) || 0)),
    modelName: row?.modelName || undefined,
    tierLabels: Array.isArray(row?.tierLabels) ? row.tierLabels : undefined,
    status: row?.status || "active",
  };
}

/**
 * Tìm sản phẩm Kho Gốc — disk hoặc Mongo. Không gọi Shopee.
 * Ưu tiên exact SKU → prefix SKU → regex tên. Trả field lean.
 */
export async function searchProductsFromStore(
  query: string,
  limit = 40,
): Promise<any[]> {
  const q = String(query || "").trim();
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
  const parentFetchLimit = Math.min(120, Math.max(safeLimit * 2, 40));
  const qLower = normalizeProductSearchText(q);

  let docs: Array<{ _id?: any; data?: any; sku?: string | null }> = [];

  if (isProductsDiskMode()) {
    const parents = searchProductsFromDisk(q, parentFetchLimit);
    docs = parents.map((p) => ({ _id: p.id, sku: p.sku, data: p }));
    console.log("[DiskSearch] KhoGoc products", {
      q,
      parentHits: docs.length,
      sampleSkus: docs.slice(0, 5).map((d) => d?.sku || d?.data?.sku),
    });
  } else {
  requireMongo();

  if (!q) {
    docs = await ProductModel.find({}, { sku: 1, data: 1 })
      .sort({ _id: 1 })
      .limit(parentFetchLimit)
      .lean();
  } else {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactSku = new RegExp(`^${escaped}$`, "i");
    const prefixSku = new RegExp(`^${escaped}`, "i");
    const contains = { $regex: escaped, $options: "i" as const };

    // 1) Exact SKU trước (nhanh nhất, dùng index)
    docs = await ProductModel.find(
      {
        $or: [
          { sku: exactSku },
          { "data.sku": exactSku },
          { "data.children.sku": exactSku },
          { "data.children_models.sku": exactSku },
          { "data.barcode": exactSku },
        ],
      },
      { sku: 1, data: 1 },
    )
      .limit(parentFetchLimit)
      .maxTimeMS(15_000)
      .lean();

    // 2) Prefix SKU nếu chưa đủ
    if (docs.length < safeLimit) {
      const more = await ProductModel.find(
        {
          $or: [
            { sku: prefixSku },
            { "data.sku": prefixSku },
            { "data.children.sku": prefixSku },
            { "data.children_models.sku": prefixSku },
          ],
        },
        { sku: 1, data: 1 },
      )
        .limit(parentFetchLimit)
        .maxTimeMS(15_000)
        .lean();
      const seenIds = new Set(docs.map((d) => String(d._id)));
      for (const d of more) {
        const key = String(d._id);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        docs.push(d);
      }
    }

    // 3) Tên / SKU / name trên toàn collection (không giới hạn page 1), cap limit UI
    if (docs.length < safeLimit) {
      const nameFilter = buildProductListSearchFilter(q);
      const moreFilter =
        Object.keys(nameFilter).length > 0
          ? nameFilter
          : {
              $or: [
                { name: contains },
                { title: contains },
                { "data.name": contains },
                { "data.title": contains },
                { "data.modelName": contains },
                { "data.children.name": contains },
                { "data.children.title": contains },
                { "data.children_models.name": contains },
                { "data.children_models.title": contains },
              ],
            };
      const more = await ProductModel.find(moreFilter, { sku: 1, data: 1 })
        .limit(parentFetchLimit)
        .maxTimeMS(15_000)
        .lean();
      const seenIds = new Set(docs.map((d) => String(d._id)));
      for (const d of more) {
        const key = String(d._id);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        docs.push(d);
      }
    }

    console.log("[MongoSearch] KhoGoc products", {
      q,
      parentHits: docs.length,
      sampleSkus: docs.slice(0, 5).map((d) => d?.sku || d?.data?.sku),
    });
  }
  }

  const parents = docsToProducts(docs);
  const flat: any[] = [];
  const seen = new Set<string>();

  const resolveId = (row: any, fallbackDocId = ""): string =>
    String(row?.id || row?._id || fallbackDocId || "").trim();

  const matchesQuery = (row: any, extra = ""): boolean => {
    if (!q) return true;
    const hay = normalizeProductSearchText(
      [
        row?.sku,
        row?.barcode,
        row?.title,
        row?.name,
        row?.modelName,
        ...(Array.isArray(row?.tierLabels) ? row.tierLabels : []),
        extra,
      ]
        .map((v) => String(v ?? ""))
        .join(" "),
    );
    return hay.includes(qLower);
  };

  const pushRow = (row: any) => {
    const lean = toSearchLeanRow(row);
    if (!lean.id || seen.has(lean.id)) return;
    seen.add(lean.id);
    flat.push(lean);
  };

  for (const p of parents) {
    const parentId = resolveId(p);
    const children = Array.isArray(p?.children) && p.children.length
      ? p.children
      : Array.isArray(p?.children_models)
        ? p.children_models
        : [];

    if (children.length > 0) {
      let childMatched = 0;
      for (const c of children) {
        if (!matchesQuery(c, `${p.title || ""} ${p.sku || ""}`)) continue;
        const childId = resolveId(c);
        if (!childId) continue;
        pushRow({
          ...c,
          id: childId,
          title: c.title || c.name || p.title,
          sku: c.sku || "",
          imageUrl: c.imageUrl || c.image || p.imageUrl,
          avatarUrl: c.avatarUrl || p.avatarUrl,
          stock: c.stock ?? 0,
          importPrice: c.importPrice ?? p.importPrice ?? 0,
        });
        childMatched += 1;
      }
      if (childMatched === 0 && matchesQuery(p) && parentId) pushRow({ ...p, id: parentId });
    } else if (matchesQuery(p) && parentId) {
      pushRow({ ...p, id: parentId });
    }
  }

  if (q) {
    flat.sort((a, b) => {
      const aSku = String(a.sku || "").toLowerCase();
      const bSku = String(b.sku || "").toLowerCase();
      const rank = (sku: string) => (sku === qLower ? 0 : sku.startsWith(qLower) ? 1 : sku.includes(qLower) ? 2 : 3);
      return rank(aSku) - rank(bSku);
    });
  }

  return flat.slice(0, safeLimit);
}

type ApplyImportResult = {
  product: any;
  oldStock: number;
  newStock: number;
  oldImportPrice: number;
  newImportPrice: number;
  target: "parent" | "child";
  parentId?: string;
  warehouse: "KhoGoc";
  collection: "products";
};

/**
 * Cộng tồn + ghi đè importPrice trên Kho Gốc (collection `products`).
 * Hỗ trợ tìm theo id / sku / biến thể. Bọc Mongo transaction khi replica-set hỗ trợ.
 */
export async function applyImportStockAndPriceToStore(
  productId: string,
  quantityDelta: number,
  importPrice: number,
  opts?: { skuHint?: string },
): Promise<any> {
  const result = await applyImportStockAndPriceToMainWarehouse(productId, quantityDelta, importPrice, opts);
  return result.product;
}

export async function applyImportStockAndPriceToMainWarehouse(
  productId: string,
  quantityDelta: number,
  importPrice: number,
  opts?: { skuHint?: string },
): Promise<ApplyImportResult> {
  if (isProductsDiskMode()) {
    return applyImportStockAndPriceOnDisk(productId, quantityDelta, importPrice, opts);
  }
  requireMongo();
  const id = String(productId || "").trim();
  const skuHint = String(opts?.skuHint || "").trim();
  if (!id && !skuHint) throw new Error("Thiếu productId/sku để cập nhật Kho Gốc");
  // Cho phép delta âm (rollback). Tồn cuối luôn >= 0.
  const qty = Math.round(Number(quantityDelta) || 0);
  const price = Math.max(0, Math.round(Number(importPrice) || 0));

  const findParentDoc = async () => {
    const or: Record<string, unknown>[] = [];
    if (id) {
      or.push({ _id: id });
      or.push({ "data.id": id });
      or.push({ "data.children.id": id });
      or.push({ "data.children_models.id": id });
      or.push({ "data.shopeeModelId": id });
      or.push({ "data.children.shopeeModelId": id });
      or.push({ "data.children_models.shopeeModelId": id });
    }
    if (skuHint) {
      or.push({ sku: skuHint });
      or.push({ "data.sku": skuHint });
      or.push({ "data.children.sku": skuHint });
      or.push({ "data.children_models.sku": skuHint });
    }
    if (or.length === 0) return null;
    return ProductModel.findOne(or.length === 1 ? or[0] : { $or: or }).lean();
  };

  const parentDoc = await findParentDoc();
  if (!parentDoc?.data || typeof parentDoc.data !== "object") {
    throw new Error(
      `Không tìm thấy sản phẩm trong Kho Gốc (collection products). id=${id || "—"} sku=${skuHint || "—"}`,
    );
  }

  const parentId = String(parentDoc._id);
  const parentData = { ...parentDoc.data, id: parentDoc.data.id || parentId };
  const childKey: "children" | "children_models" | null =
    Array.isArray(parentData.children) && parentData.children.length
      ? "children"
      : Array.isArray(parentData.children_models) && parentData.children_models.length
        ? "children_models"
        : null;

  let mode: "parent" | "child" = "parent";
  let childIdx = -1;

  if (childKey) {
    const children = parentData[childKey] as any[];
    childIdx = children.findIndex((c) => {
      const cid = String(c?.id || c?.shopeeModelId || "").trim();
      const csku = String(c?.sku || "").trim();
      return (id && cid === id) || (skuHint && csku === skuHint);
    });
    // Parent có biến thể nhưng chọn đúng parent id + không khớp child → nếu có skuHint khớp child thì ưu tiên child
    if (childIdx < 0 && skuHint) {
      childIdx = children.findIndex((c) => String(c?.sku || "").trim().toLowerCase() === skuHint.toLowerCase());
    }
    if (childIdx >= 0) mode = "child";
  }

  const runUpdate = async (session?: mongoose.ClientSession): Promise<ApplyImportResult> => {
    if (mode === "child" && childKey) {
      const children = [...(parentData[childKey] as any[])];
      const beforeChild = children[childIdx];
      const oldStock = Math.max(0, Math.round(Number(beforeChild.stock) || 0));
      const oldImportPrice = Math.max(0, Math.round(Number(beforeChild.importPrice) || 0));
      const newStock = Math.max(0, oldStock + qty);
      const mergedChild = {
        ...beforeChild,
        id: beforeChild.id || id,
        stock: newStock,
        importPrice: price,
        status:
          newStock <= 0 && beforeChild.status !== "draft"
            ? "out_of_stock"
            : beforeChild.status === "out_of_stock"
              ? "active"
              : beforeChild.status,
        lastSynced: new Date().toISOString(),
      };
      children[childIdx] = mergedChild;
      const totalStock = children.reduce(
        (s, c) => s + Math.max(0, Math.round(Number(c.stock) || 0)),
        0,
      );
      const mergedParent = {
        ...parentData,
        id: parentId,
        [childKey]: children,
        stock: totalStock,
        lastSynced: new Date().toISOString(),
      };
      await ProductModel.findByIdAndUpdate(
        parentId,
        {
          $set: {
            data: mergedParent,
            sku: mergedParent.sku != null ? String(mergedParent.sku) : null,
          },
        },
        { new: true, session: session || undefined },
      );
      console.log("[Import/KhoGoc] UPDATED child", {
        collection: "products",
        parentId,
        childId: mergedChild.id,
        sku: mergedChild.sku,
        oldStock,
        newStock,
        oldImportPrice,
        newImportPrice: price,
      });
      return {
        product: mergedChild,
        oldStock,
        newStock,
        oldImportPrice,
        newImportPrice: price,
        target: "child",
        parentId,
        warehouse: "KhoGoc",
        collection: "products",
      };
    }

    const oldStock = Math.max(0, Math.round(Number(parentData.stock) || 0));
    const oldImportPrice = Math.max(0, Math.round(Number(parentData.importPrice) || 0));
    const newStock = Math.max(0, oldStock + qty);
    const merged = {
      ...parentData,
      id: parentId,
      stock: newStock,
      importPrice: price,
      status:
        newStock <= 0 && parentData.status !== "draft"
          ? "out_of_stock"
          : parentData.status === "out_of_stock"
            ? "active"
            : parentData.status,
      lastSynced: new Date().toISOString(),
    };
    await ProductModel.findByIdAndUpdate(
      parentId,
      { $set: { data: merged, sku: merged.sku != null ? String(merged.sku) : null } },
      { new: true, session: session || undefined },
    );
    console.log("[Import/KhoGoc] UPDATED parent", {
      collection: "products",
      productId: parentId,
      sku: merged.sku,
      oldStock,
      newStock,
      oldImportPrice,
      newImportPrice: price,
    });
    return {
      product: merged,
      oldStock,
      newStock,
      oldImportPrice,
      newImportPrice: price,
      target: "parent",
      warehouse: "KhoGoc",
      collection: "products",
    };
  };

  // Transaction khi Mongo hỗ trợ (replica set / Atlas). Standalone → chạy trực tiếp.
  try {
    const session = await mongoose.startSession();
    try {
      let out!: ApplyImportResult;
      await session.withTransaction(async () => {
        out = await runUpdate(session);
      });
      return out;
    } finally {
      session.endSession();
    }
  } catch (txErr) {
    const msg = txErr instanceof Error ? txErr.message : String(txErr);
    if (/transaction|replica|Transaction numbers/i.test(msg)) {
      console.warn("[Import/KhoGoc] Transaction không khả dụng, chạy update trực tiếp:", msg);
      return runUpdate();
    }
    throw txErr;
  }
}

/** Đọc channel_listings — disk (PRODUCTS_STORAGE=disk) hoặc Mongo. */
export async function loadChannelListingsFromStore(): Promise<any[]> {
  if (isProductsDiskMode()) return readChannelListingsFromDisk();
  requireMongo();
  const docs = await ChannelListingModel.find({}).lean();
  return docsToListings(docs);
}

export async function countProducts(): Promise<number> {
  if (isProductsDiskMode()) return countProductsOnDisk();
  requireMongo();
  return ProductModel.countDocuments();
}

export async function countChannelListings(): Promise<number> {
  if (isProductsDiskMode()) return countChannelListingsOnDisk();
  requireMongo();
  return ChannelListingModel.countDocuments();
}

export async function buildLocalInventoryCacheFromStore(): Promise<LocalInventoryCache> {
  const [products, listings] = await Promise.all([
    loadProductsFromStore(),
    loadChannelListingsFromStore(),
  ]);
  return {
    updatedAt: new Date().toISOString(),
    products,
    listings,
  };
}

/** Alias: luôn query Mongo (không cache). */
export async function reloadCachesFromDb(): Promise<LocalInventoryCache> {
  return buildLocalInventoryCacheFromStore();
}

async function setMeta(key: string, value: string): Promise<void> {
  requireMongo();
  await MetaModel.findByIdAndUpdate(key, { value }, { upsert: true });
}

/** Cấu hình GHN/SPX do user lưu ở Cài đặt — collection `meta`, _id = logistics_config. */
const LOGISTICS_CONFIG_META_KEY = "logistics_config";

export async function loadLogisticsSettingsFromStore(): Promise<Record<string, any> | null> {
  if (!isMongoReady()) return null;
  ensureModels();
  let raw: unknown = null;
  try {
    const doc = await MetaModel.findById(LOGISTICS_CONFIG_META_KEY).lean();
    raw = doc && typeof doc === "object" ? (doc as { value?: unknown }).value : null;
  } catch (err: any) {
    console.warn("[Logistics] meta.findById failed:", err?.message || err);
  }
  if (raw == null || raw === "") {
    try {
      const native = await mongoose.connection.db
        ?.collection("meta")
        .findOne({ _id: LOGISTICS_CONFIG_META_KEY });
      if (native && typeof native === "object") {
        raw = (native as { value?: unknown }).value ?? native;
      }
    } catch (err: any) {
      console.warn("[Logistics] meta native query failed:", err?.message || err);
    }
  }
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

export async function saveLogisticsSettingsToStore(config: Record<string, any>): Promise<void> {
  requireMongo();
  await setMeta(LOGISTICS_CONFIG_META_KEY, JSON.stringify(config || {}));
}

/** Ghi đè toàn bộ products chỉ cho thao tác quản trị/migration đã xác nhận. */
export async function saveProductsToStoreAsync(products: any[]): Promise<void> {
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  if (isProductsDiskMode()) {
    await saveProductsToDisk(list);
    return;
  }
  requireMongo();
  const docs = toProductDocs(list);

  // deleteMany + insertMany trong 1 enqueueWrite (không transaction, không $nin).
  // Tránh xóa nhầm catalog khi payload thiếu id / bulkWrite lỗi giữa chừng.
  await enqueueWrite(async () => {
    await ProductModel.deleteMany({});
    if (docs.length > 0) {
      await ProductModel.insertMany(docs, { ordered: false });
    }
    await setMeta("products_updated_at", new Date().toISOString());
    console.log(`[MongoDB] insertMany products — ${docs.length} dòng`);
  });
}

/** Upsert theo id — dùng cho thêm/sửa/sync để không tạo khoảng trống toàn collection. */
export async function upsertProductsToStoreAsync(products: any[]): Promise<number> {
  if (isProductsDiskMode()) return upsertProductsToDisk(products);
  requireMongo();
  const docs = toProductDocs(Array.isArray(products) ? products : []);
  if (docs.length === 0) return 0;
  await enqueueWrite(async () => {
    await ProductModel.bulkWrite(
      docs.map((doc) => ({
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { sku: doc.sku ?? null, data: doc.data } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    await setMeta("products_updated_at", new Date().toISOString());
  });
  return docs.length;
}

/** Xóa có chủ đích theo id, không dùng để reset kho trong luồng đồng bộ. */
export async function deleteProductsByIdsFromStore(ids: string[]): Promise<number> {
  if (isProductsDiskMode()) return deleteProductsByIdsFromDisk(ids);
  requireMongo();
  const safeIds = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (safeIds.length === 0) return 0;
  let deleted = 0;
  await enqueueWrite(async () => {
    const result = await ProductModel.deleteMany({ _id: { $in: safeIds } });
    deleted = Number(result.deletedCount || 0);
    await setMeta("products_updated_at", new Date().toISOString());
  });
  return deleted;
}

/** Ghi đè toàn bộ channel_listings — disk hoặc Mongo deleteMany + insertMany. */
export async function saveChannelListingsToStoreAsync(rows: any[]): Promise<void> {
  const list = Array.isArray(rows)
    ? rows.filter((r) => r != null && typeof r === "object")
    : [];
  if (isProductsDiskMode()) {
    await saveChannelListingsToDisk(list);
    return;
  }
  requireMongo();
  const docs = toListingDocs(list);

  await enqueueWrite(async () => {
    await ChannelListingModel.deleteMany({});
    if (docs.length > 0) {
      await ChannelListingModel.insertMany(docs, { ordered: false });
    }
    await setMeta("listings_updated_at", new Date().toISOString());
    console.log(`[MongoDB] insertMany channel_listings — ${docs.length} dòng`);
  });
}

/** Upsert 1 listing — disk hoặc findByIdAndUpdate. */
export async function upsertChannelListingToStore(row: any): Promise<any> {
  if (isProductsDiskMode()) return upsertChannelListingToDisk(row);
  requireMongo();
  if (!row || typeof row !== "object") {
    throw new Error("upsertChannelListing: row không hợp lệ");
  }
  const id = String(row.id || "").trim();
  if (!id) throw new Error("upsertChannelListing: thiếu id");

  await ChannelListingModel.findByIdAndUpdate(
    id,
    {
      _id: id,
      channelId: row?.channelId != null ? String(row.channelId) : null,
      platform: row?.platform != null ? String(row.platform) : null,
      sku: row?.sku != null ? String(row.sku) : null,
      status: row?.status != null ? String(row.status) : null,
      linkedProductId: row?.linkedProductId != null ? String(row.linkedProductId) : null,
      data: row,
    },
    { upsert: true, new: true }
  );
  await setMeta("listings_updated_at", new Date().toISOString());
  console.log(`[MongoDB] findByIdAndUpdate channel_listings id=${id}`);
  return row;
}

/**
 * Upsert lô channel_listings — disk hoặc bulkWrite Mongo.
 */
export async function bulkUpsertChannelListingsToStore(rows: any[]): Promise<number> {
  if (isProductsDiskMode()) return upsertChannelListingsToDisk(rows);
  requireMongo();
  const list = Array.isArray(rows)
    ? rows.filter((r) => r != null && typeof r === "object")
    : [];
  const ops = [];
  for (const row of list) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: {
          $set: {
            _id: id,
            channelId: row?.channelId != null ? String(row.channelId) : null,
            platform: row?.platform != null ? String(row.platform) : null,
            sku: row?.sku != null ? String(row.sku) : null,
            status: row?.status != null ? String(row.status) : null,
            linkedProductId:
              row?.linkedProductId != null ? String(row.linkedProductId) : null,
            data: row,
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length === 0) return 0;

  await enqueueWrite(async () => {
    const result = await ChannelListingModel.bulkWrite(ops as any, { ordered: false });
    await setMeta("listings_updated_at", new Date().toISOString());
    console.log(
      `[MongoDB] bulkWrite channel_listings — ops=${ops.length} upserted=${result.upsertedCount || 0} modified=${result.modifiedCount || 0} matched=${result.matchedCount || 0}`
    );
  });
  return ops.length;
}

export async function deleteAllProductsFromStore(): Promise<void> {
  if (isProductsDiskMode()) {
    await saveProductsToDisk([]);
    return;
  }
  requireMongo();
  await ProductModel.deleteMany({});
  await setMeta("products_updated_at", new Date().toISOString());
}

export async function deleteAllChannelListingsFromStore(): Promise<void> {
  if (isProductsDiskMode()) {
    await deleteAllChannelListingsFromDisk();
    return;
  }
  requireMongo();
  await ChannelListingModel.deleteMany({});
  await setMeta("listings_updated_at", new Date().toISOString());
}

/**
 * Cờ nội bộ — CẤM đưa vào `$set` khi sync Shopee.
 * Chỉ khởi tạo qua `$setOnInsert` khi INSERT.
 */
const INTERNAL_FLAG_KEYS = new Set([
  "is_handed_over",
  "isPrinted",
  "printedAt",
  "printed_at",
  "hasPdf",
  "readyToPrint",
  "isPrepared",
  "isHandedOverToCarrier",
  "is_handed_over_to_carrier",
  "is_handed_over_to_courier",
  "local_status",
  "localStatus",
  "internal_status",
  "scanFlag",
  "handedOverAt",
  "handed_over_source",
  "handedOverSource",
  "localStatusAt",
  "local_status_updated_at",
  "is_local_return_archived",
  "is_return_received",
  "local_return_status",
  "return_received_at",
  "warehouse_return_received",
  "isWarehouseReturnReceived",
  "stock_restored",
  "stock_restored_at",
  "labelUrl",
  "pdfUrl",
  "pdfFilename",
  "waybill_url",
  "_clear_return_sn",
  "_clear_cancelled_return",
]);

/** Path Mongo bị cấm $set khi sync Shopee — cờ kho nhân viên đã xác nhận. */
const WAREHOUSE_PROTECTED_SET_KEYS = [
  "local_status",
  "data.local_status",
  "localStatus",
  "data.localStatus",
  "internal_status",
  "data.internal_status",
  "scanFlag",
  "data.scanFlag",
  "localStatusAt",
  "data.localStatusAt",
  "local_status_updated_at",
  "data.local_status_updated_at",
  "is_return_received",
  "data.is_return_received",
  "local_return_status",
  "data.local_return_status",
  "return_received_at",
  "data.return_received_at",
  "warehouse_return_received",
  "data.warehouse_return_received",
  "isWarehouseReturnReceived",
  "data.isWarehouseReturnReceived",
  "is_local_return_archived",
  "data.is_local_return_archived",
] as const;

function stripWarehouseProtectedKeysFromSet($set: Record<string, unknown>): void {
  for (const key of WAREHOUSE_PROTECTED_SET_KEYS) {
    delete $set[key];
  }
}

function readExistingWarehouseLock(doc: any): {
  locked: boolean;
  local: string;
} {
  const data = doc?.data && typeof doc.data === "object" ? doc.data : {};
  const local = String(
    data.local_status ||
      data.localStatus ||
      data.internal_status ||
      data.scanFlag ||
      data.local_return_status ||
      "",
  ).toUpperCase();
  const flag =
    data.is_return_received === true ||
    data.warehouse_return_received === true ||
    data.isWarehouseReturnReceived === true ||
    local === "RETURN_RECEIVED" ||
    local === "CANCELLED_STORED";
  return { locked: flag, local };
}

/** Parse Shopee unix (giây/ms) hoặc ISO/Date → Date hợp lệ. */
function coerceShopeeWatermarkDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 0 && value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const ms = n > 0 && n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Upsert đơn Shopee → Mongo:
 * - `$set` = data gốc Shopee (shopee_order_status, tracking_no, shipping_carrier, …)
 * - `$setOnInsert` = is_handed_over / isPrinted / isPrepared = false
 * - KHÔNG `$set: { data: whole }` (tránh document mỏng / mất field)
 * - CẤM đưa cờ nội bộ vào `$set`
 */
export async function bulkUpsertOrdersToStore(orders: any[]): Promise<number> {
  requireMongo();
  const list = Array.isArray(orders)
    ? orders.filter((o) => o != null && typeof o === "object")
    : [];
  if (list.length === 0) return 0;

  const pendingWrites: Array<{
    op: any;
    event: OrderEventDoc | null;
    orderSn: string;
    id: string;
    updateAt: Date | null;
    forceShopId: boolean;
  }> = [];
  for (const order of list) {
    const id = String(order.id || "").trim();
    const orderSn = String(order.orderSn || order.order_sn || "").trim();
    if (!id && !orderSn) continue;
    const _id = id || `shopee-${orderSn}`;

    const rawStatus = String(
      order.shopee_order_status || order.order_status || "",
    )
      .trim()
      .toUpperCase();
    if (!rawStatus) {
      console.warn(
        `[MongoDB] upsert THIẾU shopee_order_status — order_sn=${orderSn || _id} (vẫn lưu các field khác)`,
      );
    }
    const pendingFlag = order.is_pending_shopee_check === true;
    const tnRaw = String(order.tracking_no || order.trackingNumber || "").trim();
    const usableTn = tnRaw && !/^0FG/i.test(tnRaw) ? tnRaw : null;
    const carrier = String(
      order.shipping_carrier || order.checkout_shipping_carrier || order.carrier || "",
    ).trim();

    // shop_id — chỉ $set khi INSERT / shopId đang trống, hoặc luồng đã xác thực chủ đơn
    // (get_order_detail thành công / webhook payload / remap). CẤM luồng quét rác ghi đè.
    const shopIdStr = order.shopId != null ? String(order.shopId).trim() : "";
    const forceShopId =
      order._shop_owner_verified === true || order._force_shop_id === true;

    // ——— $set: CHỈ field Shopee / vận chuyển — CẤM cờ nội bộ ———
    // KHÔNG ghi status ảo "processed" vào shopee_order_status — chỉ raw Shopee.
    const channelStr = order.channel != null ? String(order.channel).trim() : "shopee";
    const $set: Record<string, unknown> = {
      orderSn: orderSn || null,
      // Root channel — dùng cho orderTabFilter("web_orders") / multi-channel.
      channel: channelStr,
      is_pending_shopee_check: pendingFlag,
      last_synced_at: new Date(),
      sync_state: String(order.sync_state || "verified"),
      "data.id": _id,
      "data.channel": channelStr,
      "data.orderSn": orderSn || null,
      "data.order_sn": orderSn || null,
      "data.is_pending_shopee_check": pendingFlag,
      "data.last_synced_at": new Date().toISOString(),
      "data.sync_state": String(order.sync_state || "verified"),
    };
    let incomingUpdateAt: Date | null = coerceShopeeWatermarkDate(
      order.last_shopee_update_at ??
        order.update_time ??
        order.updateTime ??
        order.create_time ??
        order.date,
    );
    if (incomingUpdateAt) {
      $set.last_shopee_update_at = incomingUpdateAt;
      $set["data.last_shopee_update_at"] = incomingUpdateAt.toISOString();
      $set.create_time = incomingUpdateAt;
    }
    // $set shopId: document mới / shopId trống sẽ được vá. Document đã có shopId khác
    // chỉ ghi đè khi forceShopId (chủ đơn đã xác thực). Xem vòng existing bên dưới.
    if (shopIdStr) {
      $set.shopId = shopIdStr;
      $set["data.shopId"] = shopIdStr;
    }

    // BẮT BUỘC lưu raw Shopee ở ROOT (READY_TO_SHIP / SHIPPED / PROCESSED / ...)
    if (rawStatus) {
      $set.shopee_order_status = rawStatus;
      $set["data.shopee_order_status"] = rawStatus;
    }

    // Khi Shopee → SHIPPED/COMPLETED/CANCEL: clear is_handed_over (cờ nội bộ hết tác dụng).
    const leftPickupPhase =
      rawStatus === "SHIPPED" ||
      rawStatus === "TO_CONFIRM_RECEIVE" ||
      rawStatus === "COMPLETED" ||
      rawStatus === "CANCELLED" ||
      rawStatus === "IN_CANCEL" ||
      rawStatus === "TO_RETURN";
    if (leftPickupPhase) {
      // Chỉ gỡ cờ ĐVVC. CẤM reset local_status kho (RETURN_RECEIVED / CANCELLED_STORED).
      $set.is_handed_over = false;
      $set["data.is_handed_over"] = false;
      $set["data.isHandedOverToCarrier"] = false;
      $set["data.is_handed_over_to_carrier"] = false;
      $set["data.is_handed_over_to_courier"] = false;
      $set["data.handed_over_source"] = null;
      $set["data.handedOverSource"] = null;
    }

    // BẮT BUỘC: raw Shopee thắng status local stale (shipping kẹt sau khi đã giao xong).
    const forceShipping =
      rawStatus === "SHIPPED" || rawStatus === "TO_CONFIRM_RECEIVE";
    const forceCompleted = rawStatus === "COMPLETED";
    const forceCancelled = rawStatus === "CANCELLED" || rawStatus === "IN_CANCEL";
    const forceToReturn = rawStatus === "TO_RETURN";
    if (forceShipping) {
      $set.status = "shipping";
      $set["data.status"] = "shipping";
      console.log(
        `[MongoDB] FORCE shipping order_sn=${orderSn || _id}` +
          ` raw=${rawStatus} shopId=${shopIdStr || "-"} clear_is_handed_over=true`,
      );
    } else if (forceCompleted) {
      $set.status = "completed";
      $set["data.status"] = "completed";
      console.log(
        `[MongoDB] FORCE completed order_sn=${orderSn || _id}` +
          ` raw=${rawStatus} shopId=${shopIdStr || "-"}`,
      );
    } else if (forceCancelled) {
      $set.status = "cancelled";
      $set["data.status"] = "cancelled";
    } else if (forceToReturn) {
      const incomingLocal = String(order.status || "").trim();
      if (incomingLocal === "return_received") {
        $set.status = "return_received";
        $set["data.status"] = "return_received";
      } else {
        $set.status = "return_pending";
        $set["data.status"] = "return_pending";
      }
    }

    // status local chỉ là helper UI — không thay shopee_order_status
    if (
      !forceShipping &&
      !forceCompleted &&
      !forceCancelled &&
      !forceToReturn &&
      order.status != null &&
      String(order.status).trim()
    ) {
      const st = String(order.status).trim();
      $set.status = st;
      $set["data.status"] = st;
    }

    if (order.shopName != null) $set["data.shopName"] = String(order.shopName);

    // BẢO TOÀN tracking_no + shipping_carrier thật từ Shopee
    // Chỉ GHI khi có mã thật — tuyệt đối không $set rỗng/null (tránh mất mã khi hủy/hoàn).
    if (usableTn) {
      $set.tracking_no = usableTn;
      $set.trackingNumber = usableTn;
      $set["data.tracking_no"] = usableTn;
      $set["data.trackingNumber"] = usableTn;
    }

    if (carrier) {
      $set.shipping_carrier = carrier;
      $set["data.shipping_carrier"] = carrier;
      if (order.checkout_shipping_carrier) {
        $set["data.checkout_shipping_carrier"] = String(order.checkout_shipping_carrier);
      }
    }

    const pkgNum = String(
      order.packageNumber || order.package_number || "",
    ).trim();
    if (pkgNum) {
      $set.packageNumber = pkgNum;
      $set["data.packageNumber"] = pkgNum;
      $set["data.package_number"] = pkgNum;
    }

    const outboundTn = String(order.tracking_no || order.trackingNumber || "")
      .trim()
      .toUpperCase();
    const returnTn = String(
      order.return_tracking_no || order.returnTrackingNumber || "",
    )
      .trim()
      .toUpperCase();
    const returnStatusUp = String(order.return_status || "").trim().toUpperCase();
    if (
      returnTn &&
      !/^0FG/i.test(returnTn) &&
      returnTn !== outboundTn &&
      returnStatusUp !== "CANCELLED" &&
      order._clear_cancelled_return !== true
    ) {
      $set.return_tracking_no = returnTn;
      $set.returnTrackingNumber = returnTn;
      $set["data.return_tracking_no"] = returnTn;
      $set["data.returnTrackingNumber"] = returnTn;
    }
    // Mã YCTH (return_sn) + order_sn — luôn String (uint64-safe / alphanumeric).
    const returnSnStr = String(order.return_sn || "").trim();
    const $unset: Record<string, 1> = {};
    if (forceShopId) {
      $unset.shopee_not_found = 1;
      $unset["data.shopee_not_found"] = 1;
      $unset["data.shopee_not_found_at"] = 1;
      $unset["data.shopee_not_found_reason"] = 1;
    }
    const clearCancelledReturn = order._clear_cancelled_return === true;
    const clearReturnSn =
      order._clear_return_sn === true ||
      clearCancelledReturn ||
      (order.is_return === false &&
        !returnSnStr &&
        isUnshippedShopeeCancel(order));
    if (clearReturnSn) {
      $unset.return_sn = 1;
      $unset["data.return_sn"] = 1;
      $set.is_return = false;
      $set["data.is_return"] = false;
      if (clearCancelledReturn) {
        $unset.return_tracking_no = 1;
        $unset.returnTrackingNumber = 1;
        $unset["data.return_tracking_no"] = 1;
        $unset["data.returnTrackingNumber"] = 1;
        $unset.return_status = 1;
        $unset["data.return_status"] = 1;
        $unset.shopee_cancel_return_kind = 1;
        $unset["data.shopee_cancel_return_kind"] = 1;
        if (String(order.sub_status || "").toUpperCase() !== "RTS") {
          $unset.sub_status = 1;
          $unset["data.sub_status"] = 1;
        }
      }
    } else if (returnSnStr) {
      $set.return_sn = returnSnStr;
      $set["data.return_sn"] = returnSnStr;
    }
    if (order.is_return === true) {
      $set.is_return = true;
      $set["data.is_return"] = true;
    } else if (order.is_return === false) {
      $set.is_return = false;
      $set["data.is_return"] = false;
    }
    const cancelKind = String(order.shopee_cancel_return_kind || "").trim();
    if (
      !clearCancelledReturn &&
      (cancelKind === "refund_return" ||
        cancelKind === "cancelled" ||
        cancelKind === "failed_delivery")
    ) {
      $set.shopee_cancel_return_kind = cancelKind;
      $set["data.shopee_cancel_return_kind"] = cancelKind;
    }
    const subStatus = String(order.sub_status || "").trim().toUpperCase();
    const derivedSub =
      cancelKind === "cancelled"
        ? "CANCELLED"
        : cancelKind === "failed_delivery"
          ? "RTS"
          : cancelKind === "refund_return"
            ? "RETURN"
            : subStatus;
    if (
      !clearCancelledReturn &&
      (derivedSub === "RTS" || derivedSub === "CANCELLED" || derivedSub === "RETURN")
    ) {
      $set.sub_status = derivedSub;
      $set["data.sub_status"] = derivedSub;
    }
    if (cancelKind === "cancelled") {
      $set.is_rts = false;
      $set["data.is_rts"] = false;
      $set.is_return = false;
      $set["data.is_return"] = false;
      $unset.is_return_received = 1;
      $unset["data.is_return_received"] = 1;
      $unset.local_return_status = 1;
      $unset["data.local_return_status"] = 1;
      $unset.warehouse_return_received = 1;
      $unset["data.warehouse_return_received"] = 1;
      $unset.isWarehouseReturnReceived = 1;
      $unset["data.isWarehouseReturnReceived"] = 1;
    } else if (cancelKind === "failed_delivery") {
      $set.is_rts = true;
      $set["data.is_rts"] = true;
    } else if (
      order.is_rts === false ||
      cancelKind === "refund_return"
    ) {
      $set.is_rts = false;
      $set["data.is_rts"] = false;
    } else if (order.is_rts === true) {
      $set.is_rts = true;
      $set["data.is_rts"] = true;
    }
    if (order.return_alert_pending === true) {
      $set.return_alert_pending = true;
      $set["data.return_alert_pending"] = true;
      const alertAt = order.return_alert_at
        ? new Date(String(order.return_alert_at))
        : new Date();
      $set.return_alert_at = Number.isNaN(alertAt.getTime()) ? new Date() : alertAt;
      $set["data.return_alert_at"] = (
        Number.isNaN(alertAt.getTime()) ? new Date() : alertAt
      ).toISOString();
    }
    // Push fallback có thể chỉ chứa orderSn/status. Không để `items: []` hoặc
    // `totalAmount: 0` ghi đè snapshot chi tiết đã lấy trước đó.
    if (Array.isArray(order.items) && order.items.length > 0) {
      const safeItems = stringifyShopeeIdsDeep(order.items);
      $set["data.items"] = safeItems;
      const sample = safeItems[0] || {};
      for (const k of ["item_id", "model_id", "productId", "modelId", "shopeeItemId", "shopeeModelId", "activity_id", "promotion_id"]) {
        const v = (sample as any)?.[k];
        if (v == null) continue;
        if (typeof v === "number" && !Number.isSafeInteger(v)) {
          console.warn(
            `[MongoDB][uint64] order_sn=${orderSn} items[0].${k}=${v} vượt Safe Integer`,
          );
        }
      }
    }
    if (order.date != null) {
      $set["data.date"] = order.date;
      const created = new Date(String(order.date));
      if (!Number.isNaN(created.getTime())) $set.create_time = created;
    }
    if (Number(order.totalAmount) > 0) $set["data.totalAmount"] = order.totalAmount;
    if (order.fulfillment_type != null) {
      $set["data.fulfillment_type"] = order.fulfillment_type;
    }
    if (order.ship_method != null) $set["data.ship_method"] = order.ship_method;
    if (order.logistics_status != null) {
      $set["data.logistics_status"] = order.logistics_status;
    }
    if (Number(order.return_create_time) > 0) {
      $set.return_create_time = Number(order.return_create_time);
      $set["data.return_create_time"] = Number(order.return_create_time);
    }
    if (Number(order.return_update_time) > 0) {
      $set.return_update_time = Number(order.return_update_time);
      $set["data.return_update_time"] = Number(order.return_update_time);
    }

    // Field tracking — không bao giờ ghi đè bằng chuỗi rỗng / null từ sync hủy/hoàn.
    const TRACKING_PRESERVE_KEYS = new Set([
      "tracking_no",
      "trackingNumber",
      "return_tracking_no",
      "returnTrackingNumber",
      "shopee_tracking_number",
      "internalTrackingCode",
      "packageNumber",
      "package_number",
    ]);

    // Field Shopee còn lại → data.* (bỏ cờ nội bộ — tránh đè true→false)
    for (const [key, value] of Object.entries(order)) {
      if (key === "id" || key === "_id") continue;
      if (INTERNAL_FLAG_KEYS.has(key)) continue;
      if (key === "return_sn" && (clearReturnSn || !String(value || "").trim())) continue;
      if (value === undefined || value === null) continue;
      if (key === "items" && Array.isArray(value) && value.length === 0) continue;
      if (key === "totalAmount" && Number(value) <= 0) continue;
      if (TRACKING_PRESERVE_KEYS.has(key)) {
        const s = String(value).trim();
        if (!s || /^0FG/i.test(s)) continue;
      }
      $set[`data.${key}`] = value;
    }
    stripWarehouseProtectedKeysFromSet($set);

    // ── WooCommerce + đơn ngoại sàn: GHI ĐÈ TƯỜNG MINH customer info ──────────
    // Chạy SAU generic loop để đè lên data.* — đảm bảo re-sync vá record rỗng.
    // FE resolveWooCustomerInfo đọc: order.customerName / order.billing / order.shipping
    // (hydrateOrderFromMongoDoc: ...data + root override)
    if (channelStr === "woocommerce" || channelStr === "manual") {
      const cName = String(
        order.customerName || order.customer_name || "",
      ).trim();
      const cPhone = String(
        order.customerPhone || order.customer_phone || "",
      ).trim();
      const cAddr = String(
        order.customerAddress || order.customer_address || "",
      ).trim();
      const cEmail = String(
        order.customerEmail || order.customer_email || "",
      ).trim();

      // Luôn $set — re-sync ghi đè record rỗng cũ (kể cả placeholder "Khách WooCommerce")
      $set.customerName = cName;
      $set["data.customerName"] = cName;
      $set["data.customer_name"] = cName;

      $set.customerPhone = cPhone;
      $set["data.customerPhone"] = cPhone;
      $set["data.customer_phone"] = cPhone;

      $set.customerAddress = cAddr;
      $set["data.customerAddress"] = cAddr;
      $set["data.customer_address"] = cAddr;

      $set.customerEmail = cEmail;
      $set["data.customerEmail"] = cEmail;
      $set["data.customer_email"] = cEmail;

      // billing / shipping objects — full replace (đè rỗng)
      if (order.billing && typeof order.billing === "object") {
        $set.billing = order.billing;
        $set["data.billing"] = order.billing;
      }
      if (order.shipping && typeof order.shipping === "object") {
        $set.shipping = order.shipping;
        $set["data.shipping"] = order.shipping;
      }
      if (order.billingAddress != null) {
        $set["data.billingAddress"] = order.billingAddress;
      }
      if (order.shippingAddress != null) {
        $set["data.shippingAddress"] = order.shippingAddress;
      }

      $set.source = channelStr === "manual" ? "external" : "woocommerce";
      $set["data.source"] = $set.source;
      $set.channel = channelStr;
      $set["data.channel"] = channelStr;

      if (channelStr === "manual") {
        const provider = String(order.provider || order.carrier || "").trim();
        if (provider) {
          $set["data.carrier"] = provider;
          $set["data.provider"] = provider;
        }
        if (order.external_status) {
          $set["data.external_status"] = String(order.external_status);
        }
        if (order.ghnShopId || order.ghn_shop_id) {
          $set["data.ghnShopId"] = String(order.ghnShopId || order.ghn_shop_id);
        }
        if (order.ghn_status) {
          $set["data.ghn_status"] = String(order.ghn_status);
        }
        if (order.ghn_synced_at) {
          $set["data.ghn_synced_at"] = String(order.ghn_synced_at);
        }
        if (order.cod_amount != null || Number(order.totalAmount) > 0) {
          $set["data.cod_amount"] = Number(order.cod_amount ?? order.totalAmount) || 0;
        }
        if (order.status) {
          $set.status = String(order.status);
          $set["data.status"] = String(order.status);
        }
      }

      console.log(
        `[MongoDB] ${channelStr.toUpperCase()} UPSERT customer — orderSn=${orderSn} name="${cName}" phone="${cPhone}" addr="${cAddr.slice(0, 40)}"`,
      );
    }

    // ——— $setOnInsert: cờ nội bộ CHỈ khi INSERT (không đè khi sync lại) ———
    // QUAN TRỌNG: MongoDB CẤM cùng path xuất hiện ở cả $set và $setOnInsert
    // → lỗi "Updating the path 'is_handed_over' would create a conflict".
    // Khi SHIPPED đã $set clear flags → phải gỡ các key trùng khỏi $setOnInsert.
    const insertWatermark = incomingUpdateAt || new Date();
    const $setOnInsertRaw: Record<string, unknown> = {
      _id,
      is_handed_over: false,
      isPrinted: false,
      hasPdf: false,
      isPrepared: false,
      last_shopee_update_at: insertWatermark,
      create_time: insertWatermark,
      "data.last_shopee_update_at": insertWatermark.toISOString(),
      "data.is_handed_over": false,
      "data.isPrinted": false,
      "data.hasPdf": false,
      "data.isPrepared": false,
      "data.isHandedOverToCarrier": false,
      "data.is_handed_over_to_carrier": false,
      "data.is_handed_over_to_courier": false,
      "data.local_status": "NONE",
      "data.localStatus": "NONE",
      "data.internal_status": "NONE",
    };
    const $setOnInsert: Record<string, unknown> = {};
    for (const [k, v] of Object.entries($setOnInsertRaw)) {
      if (Object.prototype.hasOwnProperty.call($set, k)) continue;
      $setOnInsert[k] = v;
    }

    console.log("Dữ liệu chuẩn bị lưu DB (upsert $set + $setOnInsert):", {
      _id,
      orderSn,
      shopee_order_status: rawStatus || null,
      status_local: order.status || null,
      tracking_no: usableTn,
      packageNumber: pkgNum || null,
      shipping_carrier: carrier || null,
      forceShipping,
      forceCompleted,
      setKeys_handed: Object.keys($set).filter((k) => /handed|local_status|internal_status/i.test(k)),
      setOnInsert_keys: Object.keys($setOnInsert),
    });

    // Khớp theo orderSn toàn cục — KHÔNG lọc shopId.
    // Filter cũ `buildOrderCompoundFilter(..., shopId)` bỏ qua document gắn nhầm
    // AuDIO↔LKAT → upsert tạo bản mới → E11000 unique orderSn → shopId sai kẹt mãi.
    const snKey = orderSn || String(_id).replace(/^shopee-/i, "");
    const filter = {
      $or: [{ orderSn: snKey }, { _id }, { "data.orderSn": snKey }],
    };

    // order_events đã bỏ — không ghi log rác vào Atlas Free.
    pendingWrites.push({
      op: {
        updateOne: {
          filter,
          update: {
            $set,
            $setOnInsert,
            ...(Object.keys($unset).length ? { $unset } : {}),
          },
          upsert: true,
        },
      },
      event: null,
      orderSn,
      id: _id,
      updateAt: incomingUpdateAt,
      forceShopId,
    });
  }
  if (pendingWrites.length === 0) return 0;

  try {
    await enqueueWrite(async () => {
      try {
        // enqueueWrite serializes this process; the conditional filter below is still
        // required so an out-of-order retry/webhook cannot win at MongoDB level.
        const ids = pendingWrites.map((item) => item.id);
        const orderSns = pendingWrites.map((item) => item.orderSn).filter(Boolean);
        const existing = await OrderModel.find({
          $or: [{ _id: { $in: ids } }, { orderSn: { $in: orderSns } }, { "data.orderSn": { $in: orderSns } }],
        })
          .select({
            _id: 1,
            orderSn: 1,
            "data.orderSn": 1,
            shopId: 1,
            "data.shopId": 1,
            last_shopee_update_at: 1,
            status: 1,
            "data.status": 1,
            "data.local_status": 1,
            "data.localStatus": 1,
            "data.internal_status": 1,
            "data.scanFlag": 1,
            "data.is_return_received": 1,
            "data.local_return_status": 1,
            "data.warehouse_return_received": 1,
            "data.isWarehouseReturnReceived": 1,
            return_alert_pending: 1,
            "data.return_alert_pending": 1,
            return_sn: 1,
            "data.return_sn": 1,
          })
          .lean();
        const existingByKey = new Map<string, any>();
        for (const row of existing) {
          for (const key of [row._id, row.orderSn, row.data?.orderSn]) {
            if (key) existingByKey.set(String(key), row);
          }
        }
        const accepted = pendingWrites.filter((item) => {
          const current = existingByKey.get(item.id) || existingByKey.get(item.orderSn);
          if (!current || !item.updateAt) return true;
          const currentAt = current.last_shopee_update_at ? new Date(current.last_shopee_update_at) : null;
          // Cho lệch ≤ 15 phút: webhook fallback now()/push timestamp vs get_order_detail update_time.
          const STALE_SKEW_MS = 15 * 60 * 1000;
          if (
            currentAt &&
            !Number.isNaN(currentAt.getTime()) &&
            currentAt.getTime() - item.updateAt.getTime() > STALE_SKEW_MS
          ) {
            console.warn(
              `[MongoDB] STALE Shopee snapshot ignored order_sn=${item.orderSn || item.id} ` +
                `incoming=${item.updateAt.toISOString()} stored=${currentAt.toISOString()}`,
            );
            return false;
          }
          if (current) {
            const identityFilter = item.op.updateOne.filter;
            const watermarkCeil = new Date(item.updateAt.getTime() + STALE_SKEW_MS);
            item.op.updateOne.filter = {
              $and: [
                identityFilter,
                {
                  $or: [
                    { last_shopee_update_at: null },
                    { last_shopee_update_at: { $exists: false } },
                    { last_shopee_update_at: { $lte: watermarkCeil } },
                  ],
                },
              ],
            };
            item.op.updateOne.upsert = false;
          }
          return true;
        });
        for (const item of accepted) {
          const current = existingByKey.get(item.id) || existingByKey.get(item.orderSn);
          const $set = item.op?.updateOne?.update?.$set as Record<string, unknown> | undefined;
          const $setOnInsert = item.op?.updateOne?.update?.$setOnInsert as
            | Record<string, unknown>
            | undefined;
          if (!$set) continue;
          stripWarehouseProtectedKeysFromSet($set);
          if (current && $set.last_shopee_update_at == null && !current.last_shopee_update_at) {
            const backfillAt = item.updateAt || new Date();
            $set.last_shopee_update_at = backfillAt;
            $set["data.last_shopee_update_at"] = backfillAt.toISOString();
          }
          if (current) {
            const existingShop = String(current.shopId || current.data?.shopId || "").trim();
            const incomingShop = String($set.shopId || $set["data.shopId"] || "").trim();
            if (existingShop && incomingShop && existingShop !== incomingShop && !item.forceShopId) {
              delete $set.shopId;
              delete $set["data.shopId"];
              console.error(
                `[MongoDB] KEEP shop_id=${existingShop} — skip overwrite incoming=${incomingShop}` +
                  ` order_sn=${item.orderSn || item.id} (luồng chưa xác thực chủ đơn)`,
              );
            }
            const alreadyAcked =
              current.return_alert_pending === false ||
              current.data?.return_alert_pending === false;
            const alreadyHadReturn = Boolean(
              String(current.return_sn || current.data?.return_sn || "").trim(),
            );
            if (alreadyAcked || alreadyHadReturn) {
              delete $set.return_alert_pending;
              delete $set["data.return_alert_pending"];
              delete $set.return_alert_at;
              delete $set["data.return_alert_at"];
            }
          }
          if (!current) continue;
          const lock = readExistingWarehouseLock(current);
          if (lock.locked) {
            $set["data.local_status"] = lock.local;
            $set["data.localStatus"] = lock.local;
            $set["data.internal_status"] = lock.local;
            $set["data.scanFlag"] = lock.local;
            if (lock.local === "RETURN_RECEIVED") {
              $set.status = "return_received";
              $set["data.status"] = "return_received";
              $set["data.is_return_received"] = true;
              $set["data.local_return_status"] = "RETURN_RECEIVED";
            }
            if ($setOnInsert) {
              for (const key of WAREHOUSE_PROTECTED_SET_KEYS) delete $setOnInsert[key];
            }
          } else {
            const existingLocal = String(current?.data?.local_status || "").toUpperCase();
            const incomingRaw = String(
              $set.shopee_order_status || $set["data.shopee_order_status"] || "",
            ).toUpperCase();
            const leftPickup =
              incomingRaw === "SHIPPED" ||
              incomingRaw === "TO_CONFIRM_RECEIVE" ||
              incomingRaw === "COMPLETED" ||
              incomingRaw === "CANCELLED" ||
              incomingRaw === "IN_CANCEL" ||
              incomingRaw === "TO_RETURN";
            if (leftPickup && existingLocal === "HANDED_OVER") {
              $set["data.local_status"] = "NONE";
              $set["data.localStatus"] = "NONE";
              $set["data.internal_status"] = "NONE";
              if ($setOnInsert) {
                delete $setOnInsert["data.local_status"];
                delete $setOnInsert["data.localStatus"];
                delete $setOnInsert["data.internal_status"];
              }
            }
          }
        }
        const ops = accepted.map((item) => item.op);
        if (ops.length === 0) return;
        const result = await OrderModel.bulkWrite(ops as any, { ordered: false });
        await setMeta("orders_updated_at", new Date().toISOString());
        // Không ghi order_events (đã loại bỏ để tránh đầy Atlas Free).
        console.log(
          `[DB UPDATED] bulkWrite orders — upserted=${result.upsertedCount || 0} modified=${result.modifiedCount || 0} matched=${result.matchedCount || 0}` +
            ` writeErrors=${(result as any).hasWriteErrors?.() ? (result as any).getWriteErrors?.()?.length || "?" : 0}`,
        );
        if (typeof (result as any).getWriteErrors === "function") {
          const writeErrors = (result as any).getWriteErrors() || [];
          for (const we of writeErrors.slice(0, 10)) {
            console.error(
              "[MongoDB] bulkWrite WRITE ERROR:",
              we?.code,
              we?.errmsg || we?.err?.message || we,
            );
          }
        }
      } catch (bulkErr: any) {
        // ordered:false vẫn có thể throw khi có writeErrors — log chi tiết từng lỗi.
        console.error(
          "[MongoDB] bulkUpsertOrdersToStore bulkWrite FAILED:",
          bulkErr?.message || bulkErr,
          bulkErr?.stack || "",
        );
        const writeErrors = bulkErr?.writeErrors || bulkErr?.result?.getWriteErrors?.() || [];
        for (const we of (Array.isArray(writeErrors) ? writeErrors : []).slice(0, 15)) {
          console.error(
            "[MongoDB] upsert WRITE ERROR detail:",
            JSON.stringify({
              code: we?.code,
              index: we?.index,
              errmsg: we?.errmsg || we?.err?.message,
              op: we?.op ? { filter: we.op.q || we.op.filter, orderSn: we.op?.u?.["$set"]?.orderSn } : undefined,
            }),
          );
        }
        if (bulkErr?.errorLabels) {
          console.error("[MongoDB] errorLabels:", bulkErr.errorLabels);
        }
        throw bulkErr;
      }
    });
  } catch (err: any) {
    console.error(
      "[MongoDB] bulkUpsertOrdersToStore OUTER FAILED — orders dropped from this batch:",
      err?.name,
      err?.message || err,
      "sample orderSn=",
      list.slice(0, 5).map((o) => o?.orderSn || o?.order_sn || o?.id),
    );
    throw err;
  }
  return pendingWrites.length;
}

/**
 * Sau ship_order: ĐÚNG 1 lệnh bulkWrite, chỉ update các order_sn bị ảnh hưởng.
 * Không find({}) toàn bảng, không sync Shopee.
 */
export async function bulkUpdateShippedOrdersBySn(
  patches: Array<{
    orderSn: string;
    shopId?: string;
    status?: string;
    shopee_order_status?: string;
    ship_method?: string;
    fulfillment_type?: string;
    tracking_no?: string;
    isPrepared?: boolean;
    isPrinted?: boolean;
    hasPdf?: boolean;
    shopeeSyncPending?: boolean;
    shopeeSyncError?: string | null;
    labelUrl?: string;
    pdfFilename?: string;
  }>,
): Promise<number> {
  if (!isMongoReady()) return 0;
  requireMongo();
  const list = Array.isArray(patches) ? patches.filter((p) => p && String(p.orderSn || "").trim()) : [];
  if (list.length === 0) return 0;

  const ops = list.map((p) => {
    const sn = String(p.orderSn || "").replace(/^shopee-/i, "").trim();
    const _id = `shopee-${sn}`;
    const shopIdStr = p.shopId != null ? String(p.shopId).trim() : "";
    const $set: Record<string, unknown> = {
      orderSn: sn,
      "data.orderSn": sn,
      "data.order_sn": sn,
    };
    if (p.status != null) {
      $set.status = String(p.status);
      $set["data.status"] = String(p.status);
    }
    if (p.shopee_order_status) {
      const raw = String(p.shopee_order_status).trim().toUpperCase();
      $set.shopee_order_status = raw;
      $set["data.shopee_order_status"] = raw;
      if (
        raw === "SHIPPED" ||
        raw === "TO_CONFIRM_RECEIVE" ||
        raw === "COMPLETED" ||
        raw === "CANCELLED" ||
        raw === "IN_CANCEL" ||
        raw === "TO_RETURN"
      ) {
        $set.is_handed_over = false;
        $set["data.is_handed_over"] = false;
        $set["data.isHandedOverToCarrier"] = false;
        $set["data.is_handed_over_to_carrier"] = false;
        $set["data.is_handed_over_to_courier"] = false;
        $set["data.local_status"] = "NONE";
        $set["data.localStatus"] = "NONE";
        $set["data.internal_status"] = "NONE";
      }
      // BẮT BUỘC: raw Shopee thắng status local (SHIPPED→shipping, COMPLETED→completed).
      if (raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") {
        $set.status = "shipping";
        $set["data.status"] = "shipping";
      } else if (raw === "COMPLETED") {
        $set.status = "completed";
        $set["data.status"] = "completed";
      } else if (raw === "CANCELLED" || raw === "IN_CANCEL") {
        $set.status = "cancelled";
        $set["data.status"] = "cancelled";
      } else if (raw === "TO_RETURN" && String($set.status || p.status || "") !== "return_received") {
        $set.status = "return_pending";
        $set["data.status"] = "return_pending";
      }
    }
    if (p.ship_method != null) $set["data.ship_method"] = p.ship_method;
    if (p.fulfillment_type != null) $set["data.fulfillment_type"] = p.fulfillment_type;
    if (p.isPrepared != null) {
      $set.isPrepared = Boolean(p.isPrepared);
      $set["data.isPrepared"] = Boolean(p.isPrepared);
    }
    if (p.isPrinted != null) {
      $set.isPrinted = Boolean(p.isPrinted);
      $set["data.isPrinted"] = Boolean(p.isPrinted);
    }
    if (p.hasPdf != null) {
      const ready = Boolean(p.hasPdf);
      $set.hasPdf = ready;
      $set["data.hasPdf"] = ready;
      $set["data.readyToPrint"] = ready;
    }
    if (p.shopeeSyncPending != null) $set["data.shopeeSyncPending"] = Boolean(p.shopeeSyncPending);
    if (p.shopeeSyncError !== undefined) {
      $set["data.shopeeSyncError"] = p.shopeeSyncError || null;
    }
    const tn = String(p.tracking_no || "").trim();
    if (tn && !/^0FG/i.test(tn)) {
      $set.tracking_no = tn;
      $set["data.tracking_no"] = tn;
      $set["data.trackingNumber"] = tn;
    }
    if (p.labelUrl) {
      $set["data.labelUrl"] = String(p.labelUrl);
      $set["data.pdfUrl"] = String(p.labelUrl);
    }
    if (p.pdfFilename) $set["data.pdfFilename"] = String(p.pdfFilename);
    if (shopIdStr) {
      $set.shopId = shopIdStr;
      $set["data.shopId"] = shopIdStr;
    }
    return {
      updateOne: {
        filter: buildOrderCompoundFilter(sn, _id, shopIdStr || null),
        update: { $set },
        upsert: false,
      },
    };
  });

  await withWriteTimeout(
    enqueueWrite(async () => {
      const result = await OrderModel.bulkWrite(ops as any, {
        ordered: false,
        maxTimeMS: 8_000,
      });
      console.log(
        `[Ship Persist] bulkWrite ONE shot — ops=${ops.length} modified=${result.modifiedCount || 0} matched=${result.matchedCount || 0}`,
      );
    }),
    "ship_persist",
  );
  invalidateTabCountCache();
  return ops.length;
}

/** shopId Mongo: khớp cả String và Number (AuDIO 831052930 hay bị lưu Number). */
function shopIdTypeVariants(shopId: string): Array<string | number> {
  const shopKey = String(shopId || "").trim();
  const variants: Array<string | number> = [shopKey];
  const asNum = Number(shopKey);
  if (Number.isFinite(asNum) && String(asNum) === shopKey) variants.push(asNum);
  return variants;
}

/**
 * Filter ghép (Compound Filter) BẮT BUỘC cho mọi thao tác update/upsert đơn hàng:
 * luôn định danh theo orderSn/_id/data.orderSn VÀ, khi biết shopId, chỉ khớp đúng
 * shop đó (string HOẶC number — document cũ có thể lưu Number) hoặc record cũ
 * chưa gán shopId (để `$set` backfill, không tạo bản ghi rác).
 */
function buildOrderCompoundFilter(
  sn: string,
  _id: string,
  shopId?: string | null,
): Record<string, unknown> {
  const identity = { $or: [{ orderSn: sn }, { _id }, { "data.orderSn": sn }] };
  const shopIdStr = shopId != null ? String(shopId).trim() : "";
  if (!shopIdStr) return identity;
  const shopVariants: Record<string, unknown>[] = [
    { shopId: shopIdStr },
    { "data.shopId": shopIdStr },
    { shopId: null },
    { shopId: { $exists: false } },
  ];
  const asNum = Number(shopIdStr);
  if (Number.isFinite(asNum) && String(asNum) === shopIdStr) {
    shopVariants.push({ shopId: asNum }, { "data.shopId": asNum });
  }
  return {
    $and: [identity, { $or: shopVariants }],
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 11000 || /E11000|duplicate key/i.test(String(e?.message || err || ""));
}

/**
 * API bàn giao / quét QR — CHỈ `$set: { is_handed_over: true }`.
 * Filter CHỈ theo orderSn / _id — KHÔNG lọc shopId (tránh E11000 khi doc gắn nhầm shop).
 * shopId (nếu có) chỉ `$set` backfill, không dùng để find.
 */
export async function markOrderHandedOverInStore(
  orderSn: string,
  meta?: {
    source?: string;
    handedOverAt?: string;
    shopId?: string;
  },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  if (!sn) return false;
  const _id = `shopee-${sn}`;
  const now = meta?.handedOverAt || new Date().toISOString();
  const source = meta?.source || "manual_button";
  const shopIdStr = meta?.shopId != null ? String(meta.shopId).trim() : "";

  const $set: Record<string, unknown> = {
    is_handed_over: true,
    "data.is_handed_over": true,
    "data.isHandedOverToCarrier": true,
    "data.is_handed_over_to_carrier": true,
    "data.is_handed_over_to_courier": true,
    "data.local_status": "HANDED_OVER",
    "data.localStatus": "HANDED_OVER",
    "data.internal_status": "HANDED_OVER",
    "data.handedOverAt": now,
    "data.handed_over_source": source,
    "data.handedOverSource": source,
    "data.localStatusAt": now,
    "data.local_status_updated_at": now,
  };
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }
  // Không đưa `_id` vào $setOnInsert — xung đột khi upsert $or / doc đã tồn tại.
  const $setOnInsert: Record<string, unknown> = {
    orderSn: sn,
    "data.id": _id,
    "data.orderSn": sn,
    "data.channel": "shopee",
  };
  const identityFilter = {
    $or: [{ orderSn: sn }, { _id }, { "data.orderSn": sn }],
  };

  const writeExisting = async () =>
    OrderModel.findOneAndUpdate(identityFilter, { $set }, { new: true });

  try {
    const updated = await writeExisting();
    if (updated) {
      const raw = String(
        (updated as any).shopee_order_status || (updated as any).data?.shopee_order_status || "",
      ).toUpperCase();
      const st = String((updated as any).status || (updated as any).data?.status || "").trim();
      const tn = String(
        (updated as any).tracking_no ||
          (updated as any).trackingNumber ||
          (updated as any).data?.tracking_no ||
          (updated as any).data?.trackingNumber ||
          "",
      ).trim();
      if (tn && !/^0FG/i.test(tn) && isLaggingPendingConfirmPair(raw, st)) {
        await OrderModel.updateOne(identityFilter, { $set: { ...LAGGING_PENDING_PROMOTE_SET } });
        console.log(
          `[MongoDB] markOrderHandedOver promote PROCESSED order_sn=${sn} (raw was ${raw || st})`,
        );
      }
      console.log(
        `[MongoDB] markOrderHandedOver UPDATE is_handed_over=true order_sn=${sn} shopId=${shopIdStr || "-"} ok=true`,
      );
      return true;
    }
    const inserted = await OrderModel.findOneAndUpdate(
      { _id },
      { $set, $setOnInsert },
      { new: true, upsert: true },
    );
    console.log(
      `[MongoDB] markOrderHandedOver UPSERT is_handed_over=true order_sn=${sn} shopId=${shopIdStr || "-"} ok=${Boolean(inserted)}`,
    );
    return Boolean(inserted);
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      try {
        const retry = await writeExisting();
        console.log(
          `[MongoDB] markOrderHandedOver E11000-retry order_sn=${sn} ok=${Boolean(retry)}`,
        );
        return Boolean(retry);
      } catch (retryErr) {
        console.error(
          "[MongoDB] markOrderHandedOver E11000 retry failed:",
          (retryErr as Error)?.message || retryErr,
        );
        throw retryErr;
      }
    }
    console.error("[MongoDB] markOrderHandedOver failed:", (err as Error)?.message || err);
    throw err;
  }
}

/**
 * Ghi cờ isPrinted — CHỈ khi user bấm In thành công (hoặc reset Chưa in).
 * Không dùng cho background chuẩn bị PDF.
 * Hot path: updateMany theo index orderSn/_id, KHÔNG xếp hàng enqueueWrite
 * (tránh bị bulk sync chặn 20s), KHÔNG upsert thiếu trong request.
 */
export async function markOrdersPrintedInStore(
  orderSns: string[],
  isPrinted: boolean,
  meta?: {
    shopId?: string;
    labelUrl?: string;
    pdfUrl?: string;
    waybill_url?: string;
    pdfFilename?: string;
  },
): Promise<number> {
  if (!isMongoReady()) return 0;
  requireMongo();
  const sns = [
    ...new Set(
      (Array.isArray(orderSns) ? orderSns : [])
        .map((s) => String(s || "").replace(/^shopee-/i, "").trim())
        .filter(Boolean),
    ),
  ];
  if (sns.length === 0) return 0;

  const printed = Boolean(isPrinted);
  const shopIdStr = meta?.shopId != null ? String(meta.shopId).trim() : "";
  const labelUrl = String(meta?.labelUrl || meta?.pdfUrl || meta?.waybill_url || "").trim();
  const pdfFilename = String(meta?.pdfFilename || "").trim();
  const ids = sns.map((sn) => `shopee-${sn}`);

  const now = new Date();
  const $set: Record<string, unknown> = {
    isPrinted: printed,
    "data.isPrinted": printed,
  };
  // User in thành công → chắc chắn đã có PDF; reset "Chưa in" vẫn giữ hasPdf nếu còn file.
  if (printed) {
    $set.printedAt = now;
    $set["data.printedAt"] = now;
    $set["data.printed_at"] = now;
    $set.hasPdf = true;
    $set["data.hasPdf"] = true;
    $set["data.readyToPrint"] = true;
    if (labelUrl) {
      $set.waybill_url = labelUrl;
      $set["data.waybill_url"] = labelUrl;
      $set["data.labelUrl"] = labelUrl;
      $set["data.pdfUrl"] = labelUrl;
    }
    if (pdfFilename) $set["data.pdfFilename"] = pdfFilename;
  } else {
    // Reset "Chưa in" → xóa timestamp in
    $set.printedAt = null;
    $set["data.printedAt"] = null;
    $set["data.printed_at"] = null;
  }
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }

  // Chỉ field có index (orderSn_unique + _id) — tránh $or data.orderSn scan collection.
  const filter: Record<string, unknown> = {
    $or: [{ orderSn: { $in: sns } }, { _id: { $in: ids } }],
  };

  const result = await OrderModel.updateMany(filter, { $set }, {
    maxTimeMS: 4_000,
  } as any);
  const matched = Number(result?.matchedCount || result?.n || 0);
  const modified = Number(result?.modifiedCount || result?.nModified || 0);
  console.log(
    `[MongoDB] markOrdersPrintedInStore isPrinted=${printed} sns=${sns.length}` +
      ` matched=${matched} modified=${modified}`,
  );

  // Upsert đơn thiếu — chạy ngầm, không chặn API.
  if (matched < sns.length) {
    const missingFilter = filter;
    const missingSet = $set;
    setImmediate(() => {
      void (async () => {
        try {
          const existing = await OrderModel.find(missingFilter)
            .select({ orderSn: 1, _id: 1 })
            .lean()
            .maxTimeMS(5_000);
          const have = new Set<string>();
          for (const d of existing as any[]) {
            const sn = String(d?.orderSn || String(d?._id || "").replace(/^shopee-/i, "")).trim();
            if (sn) have.add(sn);
          }
          const missing = sns.filter((sn) => !have.has(sn));
          if (missing.length === 0) return;
          const ops = missing.map((sn) => {
            const _id = `shopee-${sn}`;
            return {
              updateOne: {
                filter: { _id },
                update: {
                  $set: { ...missingSet, orderSn: sn, "data.orderSn": sn },
                  $setOnInsert: {
                    _id,
                    "data.id": _id,
                    "data.channel": "shopee",
                  },
                },
                upsert: true,
              },
            };
          });
          const up = await OrderModel.bulkWrite(ops as any, {
            ordered: false,
            maxTimeMS: 8_000,
          });
          console.log(
            `[MongoDB] markOrdersPrintedInStore bg-upsert missing=${missing.length}` +
              ` upserted=${up.upsertedCount || 0}`,
          );
        } catch (err: any) {
          console.warn(
            "[MongoDB] markOrdersPrintedInStore bg-upsert skipped:",
            err?.message || err,
          );
        }
      })();
    });
  }
  return matched || sns.length;
}

/**
 * BG worker lưu PDF xong → hasPdf/readyToPrint = true.
 * Tuyệt đối KHÔNG set isPrinted.
 */
export async function markOrdersHasPdfInStore(
  orderSns: string[],
  meta?: {
    shopId?: string;
    labelUrl?: string;
    pdfUrl?: string;
    waybill_url?: string;
    pdfFilename?: string;
  },
): Promise<number> {
  if (!isMongoReady()) return 0;
  requireMongo();
  const sns = [
    ...new Set(
      (Array.isArray(orderSns) ? orderSns : [])
        .map((s) => String(s || "").replace(/^shopee-/i, "").trim())
        .filter(Boolean),
    ),
  ];
  if (sns.length === 0) return 0;

  const shopIdStr = meta?.shopId != null ? String(meta.shopId).trim() : "";
  const labelUrl = String(
    meta?.labelUrl || meta?.pdfUrl || meta?.waybill_url || "",
  ).trim();
  const pdfFilename = String(meta?.pdfFilename || "").trim();

  const ops = sns.map((sn) => {
    const _id = `shopee-${sn}`;
    const $set: Record<string, unknown> = {
      hasPdf: true,
      "data.hasPdf": true,
      "data.readyToPrint": true,
    };
    if (labelUrl) {
      $set.waybill_url = labelUrl;
      $set["data.waybill_url"] = labelUrl;
      $set["data.labelUrl"] = labelUrl;
      $set["data.pdfUrl"] = labelUrl;
    }
    if (pdfFilename) $set["data.pdfFilename"] = pdfFilename;
    if (shopIdStr) {
      $set.shopId = shopIdStr;
      $set["data.shopId"] = shopIdStr;
    }
    return {
      updateOne: {
        filter: buildOrderCompoundFilter(sn, _id, shopIdStr || null),
        update: {
          $set,
          $setOnInsert: {
            _id,
            orderSn: sn,
            isPrinted: false,
            "data.isPrinted": false,
            "data.id": _id,
            "data.orderSn": sn,
            "data.channel": "shopee",
          },
        },
        upsert: true,
      },
    };
  });

  await withWriteTimeout(
    enqueueWrite(async () => {
      const result = await OrderModel.bulkWrite(ops as any, {
        ordered: false,
        maxTimeMS: 8_000,
      });
      console.log(
        `[MongoDB] markOrdersHasPdfInStore sns=${sns.length}` +
          ` modified=${result.modifiedCount || 0} upserted=${result.upsertedCount || 0}`,
      );
    }),
    "mark_has_pdf",
  );
  return sns.length;
}

/**
 * Ghi cờ kho nội bộ CANCELLED_STORED / RETURN_RECEIVED / NONE — atomic $set.
 * Dùng sau quét QR (scan-bulk-update). KHÔNG dùng bulkUpsert (bỏ qua INTERNAL_FLAG_KEYS).
 */
export async function markOrderLocalStatusInStore(
  orderSn: string,
  localStatus: "CANCELLED_STORED" | "RETURN_RECEIVED" | "NONE",
  meta?: {
    shopId?: string;
    clearHandedOver?: boolean;
    status?: string;
    stockRestored?: boolean;
    stockRestoredAt?: string;
  },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  if (!sn) return false;
  const _id = `shopee-${sn}`;
  const now = new Date().toISOString();
  const shopIdStr = meta?.shopId != null ? String(meta.shopId).trim() : "";
  const status = String(localStatus || "").toUpperCase();
  if (status !== "CANCELLED_STORED" && status !== "RETURN_RECEIVED" && status !== "NONE") {
    return false;
  }

  const $set: Record<string, unknown> = {
    "data.local_status": status,
    "data.localStatus": status,
    "data.internal_status": status,
    "data.scanFlag": status,
    "data.localStatusAt": now,
    "data.local_status_updated_at": now,
    "data.is_local_return_archived": false,
  };
  if (meta?.clearHandedOver || status === "CANCELLED_STORED" || status === "RETURN_RECEIVED") {
    $set.is_handed_over = false;
    $set["data.is_handed_over"] = false;
    $set["data.isHandedOverToCarrier"] = false;
    $set["data.is_handed_over_to_carrier"] = false;
    $set["data.is_handed_over_to_courier"] = false;
  }
  if (meta?.stockRestored) {
    const restoredAt = String(meta.stockRestoredAt || now);
    $set["data.stock_restored"] = true;
    $set["data.stock_restored_at"] = restoredAt;
  }
  const $unset: Record<string, 1> = {};
  if (status === "RETURN_RECEIVED") {
    $set.status = "return_received";
    $set["data.status"] = "return_received";
  } else if (status === "CANCELLED_STORED") {
    $set.is_rts = false;
    $set["data.is_rts"] = false;
    $set.is_return = false;
    $set["data.is_return"] = false;
    $set.sub_status = "CANCELLED";
    $set["data.sub_status"] = "CANCELLED";
    $unset.is_return_received = 1;
    $unset["data.is_return_received"] = 1;
    $unset.local_return_status = 1;
    $unset["data.local_return_status"] = 1;
    $unset.warehouse_return_received = 1;
    $unset["data.warehouse_return_received"] = 1;
    $unset.isWarehouseReturnReceived = 1;
    $unset["data.isWarehouseReturnReceived"] = 1;
    if (meta?.status) {
      $set.status = String(meta.status);
      $set["data.status"] = String(meta.status);
    }
  } else if (meta?.status) {
    $set.status = String(meta.status);
    $set["data.status"] = String(meta.status);
  }
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }

  const result = await OrderModel.findOneAndUpdate(
    buildOrderCompoundFilter(sn, _id, shopIdStr),
    {
      $set,
      ...(Object.keys($unset).length ? { $unset } : {}),
      $setOnInsert: {
        _id,
        orderSn: sn,
        "data.id": _id,
        "data.orderSn": sn,
        "data.channel": "shopee",
      },
    },
    { new: true, upsert: true },
  );
  console.log(
    `[MongoDB] findOneAndUpdate markOrderLocalStatus=${status} order_sn=${sn} shopId=${shopIdStr || "-"} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

/** YCTH mới chưa ACK — phục vụ poll toast khi RAM queue trống (restart). */
export async function listPendingReturnAlertsFromStore(): Promise<
  Array<{
    id: string;
    orderSn: string;
    returnSn: string;
    returnTrackingNumber: string;
    shopId: string;
    createdAt: string;
  }>
> {
  if (!isMongoReady()) return [];
  requireMongo();
  try {
    const docs = await OrderModel.find({
      $or: [{ return_alert_pending: true }, { "data.return_alert_pending": true }],
    })
      .select({
        orderSn: 1,
        shopId: 1,
        return_sn: 1,
        return_tracking_no: 1,
        returnTrackingNumber: 1,
        return_alert_at: 1,
        "data.return_sn": 1,
        "data.return_tracking_no": 1,
        "data.returnTrackingNumber": 1,
        "data.return_alert_at": 1,
      })
      .sort({ return_alert_at: -1 })
      .limit(30)
      .lean();
    return (docs || [])
      .map((d: any) => {
        const sn = String(d?.orderSn || d?.data?.orderSn || "").trim();
        if (!sn) return null;
        const rtn = String(
          d?.return_tracking_no ||
            d?.returnTrackingNumber ||
            d?.data?.return_tracking_no ||
            d?.data?.returnTrackingNumber ||
            "",
        ).trim();
        const at = d?.return_alert_at || d?.data?.return_alert_at;
        return {
          id: `rr-${sn}`,
          orderSn: sn,
          returnSn: String(d?.return_sn || d?.data?.return_sn || "").trim(),
          returnTrackingNumber: rtn,
          shopId: String(d?.shopId || d?.data?.shopId || "").trim(),
          createdAt: at ? new Date(at).toISOString() : new Date().toISOString(),
        };
      })
      .filter(Boolean) as Array<{
      id: string;
      orderSn: string;
      returnSn: string;
      returnTrackingNumber: string;
      shopId: string;
      createdAt: string;
    }>;
  } catch (err: any) {
    console.warn("[ReturnAlert] listPendingReturnAlertsFromStore:", err?.message || err);
    return [];
  }
}

/** ACK toast YCTH — tắt cờ return_alert_pending. */
export async function ackReturnAlertsInStore(orderSns: string[]): Promise<number> {
  if (!isMongoReady()) return 0;
  requireMongo();
  const sns = [
    ...new Set(
      (Array.isArray(orderSns) ? orderSns : [])
        .map((v) => String(v || "").replace(/^shopee-/i, "").replace(/^rr-/, "").replace(/-\d{10,}$/, "").trim())
        .filter(Boolean),
    ),
  ];
  if (!sns.length) return 0;
  try {
    const result = await OrderModel.updateMany(
      {
        $or: [
          { orderSn: { $in: sns } },
          { "data.orderSn": { $in: sns } },
          { _id: { $in: sns.map((s) => `shopee-${s}`) } },
        ],
      },
      {
        $set: {
          return_alert_pending: false,
          "data.return_alert_pending": false,
        },
      },
    );
    return Number(result?.modifiedCount || 0);
  } catch (err: any) {
    console.warn("[ReturnAlert] ackReturnAlertsInStore:", err?.message || err);
    return 0;
  }
}

/** Cưỡng bức update flag is_pending_shopee_check theo order_sn (JSON sync caller + Mongo). */
export async function updateOrderPendingShopeeCheckInStore(
  orderSn: string,
  isPending: boolean,
  patch?: Record<string, unknown>,
  shopId?: string,
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").trim();
  if (!sn) return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = shopId != null ? String(shopId).trim() : "";
  const $set: Record<string, unknown> = {
    is_pending_shopee_check: isPending,
    "data.is_pending_shopee_check": isPending,
  };
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      $set[k] = v;
      $set[`data.${k}`] = v;
    }
  }
  const $setOnInsert: Record<string, unknown> = {
    _id,
    orderSn: sn,
    "data.id": _id,
    "data.orderSn": sn,
    "data.channel": "shopee",
  };
  const result = await OrderModel.findOneAndUpdate(
    buildOrderCompoundFilter(sn, _id, shopIdStr),
    { $set, $setOnInsert },
    { new: true, upsert: true },
  );
  console.log(
    `[MongoDB] findOneAndUpdate is_pending_shopee_check=${isPending} order_sn=${sn} shopId=${shopIdStr || "-"} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

const LAGGING_PENDING_RAW = [
  "UNPAID",
  "PENDING",
  "IN_REVIEW",
  "FRAUD_CHECK",
  "INVOICE_PENDING",
] as const;
const LAGGING_PENDING_LOCAL = ["pending_confirm", "pending_verification"] as const;
const TERMINAL_SHOPEE_RAW = [
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "COMPLETED",
  "CANCELLED",
  "IN_CANCEL",
  "TO_RETURN",
] as const;

function isLaggingPendingConfirmPair(raw: string, status: string): boolean {
  const r = String(raw || "").toUpperCase();
  const st = String(status || "").trim();
  if ((TERMINAL_SHOPEE_RAW as readonly string[]).includes(r)) return false;
  if (st === "shipping" || st === "completed" || st === "cancelled") return false;
  if ((LAGGING_PENDING_RAW as readonly string[]).includes(r)) return true;
  if ((LAGGING_PENDING_LOCAL as readonly string[]).includes(st)) return true;
  if (!r && (st === "pending_confirm" || st === "pending_verification")) return true;
  return false;
}

/** UNPAID/PENDING/pending_confirm + mã VĐ thật → PROCESSED (root + data). */
function applyLaggingPendingPromotionToSet(
  $set: Record<string, unknown>,
  extra?: { status?: string; shopee_order_status?: string },
): boolean {
  const raw = String(
    $set.shopee_order_status || extra?.shopee_order_status || "",
  ).toUpperCase();
  const st = String($set.status || extra?.status || "").trim();
  if (!isLaggingPendingConfirmPair(raw, st)) return false;
  $set.shopee_order_status = "PROCESSED";
  $set["data.shopee_order_status"] = "PROCESSED";
  $set.status = "processed";
  $set["data.status"] = "processed";
  $set.isPrepared = true;
  $set["data.isPrepared"] = true;
  $set.is_pending_shopee_check = false;
  $set["data.is_pending_shopee_check"] = false;
  return true;
}

const LAGGING_PENDING_PROMOTE_SET: Record<string, unknown> = {
  shopee_order_status: "PROCESSED",
  "data.shopee_order_status": "PROCESSED",
  status: "processed",
  "data.status": "processed",
  isPrepared: true,
  "data.isPrepared": true,
  is_pending_shopee_check: false,
  "data.is_pending_shopee_check": false,
};

function laggingPendingConfirmMongoFilter(): Record<string, unknown> {
  return {
    $and: [
      {
        shopee_order_status: {
          $nin: [...TERMINAL_SHOPEE_RAW, "READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"],
        },
      },
      {
        $or: [
          { shopee_order_status: { $in: [...LAGGING_PENDING_RAW, null, ""] } },
          { status: { $in: [...LAGGING_PENDING_LOCAL] } },
          { "data.shopee_order_status": { $in: [...LAGGING_PENDING_RAW, null, ""] } },
          { "data.status": { $in: [...LAGGING_PENDING_LOCAL] } },
        ],
      },
    ],
  };
}

/** findOneAndUpdate tracking_no / trackingNumber (+ status heal) vào Mongo theo order_sn. */
export async function updateOrderTrackingInStore(
  orderSn: string,
  trackingNo: string,
  extra?: {
    internalTrackingCode?: string;
    packageNumber?: string;
    status?: string;
    isPrepared?: boolean;
    shopee_order_status?: string;
    is_pending_shopee_check?: boolean;
    shopId?: string;
    return_tracking_no?: string;
    returnTrackingNumber?: string;
  },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").trim();
  const tn = String(trackingNo || "").trim();
  const rtnRaw = String(extra?.return_tracking_no || extra?.returnTrackingNumber || "")
    .trim()
    .toUpperCase();
  const rtn = rtnRaw && rtnRaw.length >= 4 && !/^0FG/i.test(rtnRaw) ? rtnRaw : "";
  if (!sn || (!tn && !rtn)) return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = extra?.shopId != null ? String(extra.shopId).trim() : "";
  const $set: Record<string, unknown> = {};
  const hasOutboundTn = Boolean(tn && !/^0FG/i.test(tn));
  if (hasOutboundTn) {
    $set.tracking_no = tn;
    $set.trackingNumber = tn;
    $set["data.tracking_no"] = tn;
    $set["data.trackingNumber"] = tn;
  }
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }
  if (extra?.internalTrackingCode) {
    $set["data.internalTrackingCode"] = extra.internalTrackingCode;
  }
  if (extra?.packageNumber) {
    const pkg = String(extra.packageNumber).trim();
    if (pkg) {
      $set.packageNumber = pkg;
      $set["data.packageNumber"] = pkg;
      $set["data.package_number"] = pkg;
    }
  }
  if (rtn && rtn !== String(tn || "").trim().toUpperCase()) {
    $set.return_tracking_no = rtn;
    $set.returnTrackingNumber = rtn;
    $set["data.return_tracking_no"] = rtn;
    $set["data.returnTrackingNumber"] = rtn;
  }
  if (extra?.status != null) {
    $set.status = String(extra.status);
    $set["data.status"] = String(extra.status);
  }
  if (extra?.isPrepared != null) {
    $set.isPrepared = extra.isPrepared;
    $set["data.isPrepared"] = extra.isPrepared;
  }
  if (extra?.shopee_order_status != null) {
    const rawIn = String(extra.shopee_order_status).toUpperCase();
    $set.shopee_order_status = rawIn;
    $set["data.shopee_order_status"] = rawIn;
  }
  if (extra?.is_pending_shopee_check != null) {
    $set.is_pending_shopee_check = extra.is_pending_shopee_check;
    $set["data.is_pending_shopee_check"] = extra.is_pending_shopee_check;
  }
  // Có mã VĐ outbound + đang kẹt Chờ xác nhận → BẮT BUỘC promote PROCESSED (root + data).
  if (hasOutboundTn) {
    applyLaggingPendingPromotionToSet($set, extra);
  }
  if (Object.keys($set).length === 0) return false;
  const $setOnInsert: Record<string, unknown> = {
    _id,
    orderSn: sn,
    "data.id": _id,
    "data.orderSn": sn,
    "data.channel": "shopee",
  };
  const identity = buildOrderCompoundFilter(sn, _id, shopIdStr);
  const result = await OrderModel.findOneAndUpdate(
    identity,
    { $set, $setOnInsert },
    { new: true, upsert: true },
  );
  // Extra có thể thiếu raw — đối soát DB: UNPAID/pending_confirm + tracking → PROCESSED.
  if (hasOutboundTn && result) {
    try {
      await OrderModel.updateOne(
        { $and: [identity, laggingPendingConfirmMongoFilter()] },
        { $set: { ...LAGGING_PENDING_PROMOTE_SET } },
      );
    } catch (promoErr) {
      console.warn(
        `[MongoDB] tracking promote PROCESSED failed order_sn=${sn}:`,
        (promoErr as Error)?.message || promoErr,
      );
    }
  }
  console.log(
    `[MongoDB] findOneAndUpdate tracking_no=${tn} order_sn=${sn} shopId=${shopIdStr || "-"} status=${$set.status || extra?.status || "-"} raw=${$set.shopee_order_status || extra?.shopee_order_status || "-"} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

/**
 * Chỉ $set mã chiều hoàn (+ return_sn/return_status logistics).
 * CẤM đụng is_return_received / local_return_status / cờ kho.
 */
export async function updateReturnTrackingOnlyInStore(
  orderSn: string,
  returnTrackingNo: string,
  extra?: {
    shopId?: string;
    return_sn?: string;
    return_status?: string;
  },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  const rtn = String(returnTrackingNo || "").trim().toUpperCase();
  if (!sn || !rtn || rtn.length < 4 || /^0FG/i.test(rtn)) return false;
  if (String(extra?.return_status || "").trim().toUpperCase() === "CANCELLED") return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = extra?.shopId != null ? String(extra.shopId).trim() : "";
  const $set: Record<string, unknown> = {
    return_tracking_no: rtn,
    returnTrackingNumber: rtn,
    "data.return_tracking_no": rtn,
    "data.returnTrackingNumber": rtn,
  };
  const returnSn = String(extra?.return_sn || "").trim();
  if (returnSn) {
    $set.return_sn = returnSn;
    $set["data.return_sn"] = returnSn;
  }
  const returnStatus = String(extra?.return_status || "").trim();
  if (returnStatus) {
    $set.return_status = returnStatus;
    $set["data.return_status"] = returnStatus;
  }
  stripWarehouseProtectedKeysFromSet($set);
  delete $set.is_return_received;
  delete $set["data.is_return_received"];
  delete $set.local_return_status;
  delete $set["data.local_return_status"];
  const result = await OrderModel.findOneAndUpdate(
    buildOrderCompoundFilter(sn, _id, shopIdStr),
    { $set },
    { new: true, upsert: false },
  );
  console.log(
    `[MongoDB] return_tracking_only order_sn=${sn} shopId=${shopIdStr || "-"} rtn=${rtn} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

/**
 * YCTH CANCELLED trên đơn đã giao — $unset leftover return_sn / mã hoàn / cờ hoàn.
 */
export async function clearCancelledDeliveredReturnInStore(
  orderSn: string,
  shopId?: string,
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  if (!sn) return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = shopId != null ? String(shopId).trim() : "";
  const $unset: Record<string, 1> = {
    return_sn: 1,
    "data.return_sn": 1,
    return_tracking_no: 1,
    returnTrackingNumber: 1,
    "data.return_tracking_no": 1,
    "data.returnTrackingNumber": 1,
    return_status: 1,
    "data.return_status": 1,
    shopee_cancel_return_kind: 1,
    "data.shopee_cancel_return_kind": 1,
    sub_status: 1,
    "data.sub_status": 1,
  };
  const $set: Record<string, unknown> = {
    is_return: false,
    "data.is_return": false,
  };
  const result = await OrderModel.findOneAndUpdate(
    buildOrderCompoundFilter(sn, _id, shopIdStr),
    { $set, $unset },
    { new: true, upsert: false },
  );
  console.log(
    `[MongoDB] clear_cancelled_return order_sn=${sn} shopId=${shopIdStr || "-"} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

/**
 * Job bù mã GHN — bulkWrite $set tracking_no thẳng DB.
 * Không lọc Regex kén chọn (chữ cái / lệch hãng). Chỉ bỏ mã nội bộ 0FG.
 * Không đụng last_shopee_update_at (tránh watermark nuốt mất mã vừa lấy).
 */
export async function bulkSetTrackingNumbersInStore(
  items: Array<{
    orderSn: string;
    trackingNo: string;
    packageNumber?: string;
    shopId?: string;
  }>,
): Promise<{ matched: number; modified: number }> {
  if (!isMongoReady()) return { matched: 0, modified: 0 };
  requireMongo();
  const ops: any[] = [];
  for (const item of items) {
    const sn = String(item?.orderSn || "").replace(/^shopee-/i, "").trim();
    const tn = String(item?.trackingNo || "").trim();
    if (!sn || !tn || /^0FG/i.test(tn)) continue;
    const _id = `shopee-${sn}`;
    const shopIdStr = item?.shopId != null ? String(item.shopId).trim() : "";
    const identity = {
      $or: [{ orderSn: sn }, { "data.orderSn": sn }, { _id }],
    };
    const $set: Record<string, unknown> = {
      tracking_no: tn,
      trackingNumber: tn,
      "data.tracking_no": tn,
      "data.trackingNumber": tn,
    };
    const pkg = String(item?.packageNumber || "").trim();
    if (pkg) {
      $set.packageNumber = pkg;
      $set["data.packageNumber"] = pkg;
      $set["data.package_number"] = pkg;
    }
    if (shopIdStr) {
      $set.shopId = shopIdStr;
      $set["data.shopId"] = shopIdStr;
    }
    ops.push({
      updateOne: {
        filter: identity,
        update: { $set },
        upsert: false,
      },
    });
    // Promote riêng: chỉ khi doc đang UNPAID/PENDING/pending_confirm — không đụng SHIPPED.
    ops.push({
      updateOne: {
        filter: { $and: [identity, laggingPendingConfirmMongoFilter()] },
        update: { $set: { ...LAGGING_PENDING_PROMOTE_SET } },
        upsert: false,
      },
    });
  }
  if (ops.length === 0) return { matched: 0, modified: 0 };
  let matched = 0;
  let modified = 0;
  await enqueueWrite(async () => {
    const result = await withWriteTimeout(
      OrderModel.bulkWrite(ops, { ordered: false }),
      "bulkSetTrackingNumbersInStore",
      20_000,
    );
    matched = Number((result as any).matchedCount ?? (result as any).nMatched ?? 0);
    modified = Number((result as any).modifiedCount ?? (result as any).nModified ?? 0);
    console.log(
      `[GHN Backfill] bulkWrite $set tracking_no ops=${ops.length} matched=${matched} modified=${modified}`,
    );
  });
  return { matched, modified };
}

/**
 * Force ghi đè shopId + shopName theo order_sn (sửa tay đơn gắn nhầm shop).
 */
export async function forceUpdateOrderShopIdInStore(
  orderSn: string,
  shopId: string,
  shopName: string,
): Promise<{ ok: boolean; matched: boolean; modified: boolean; orderSn: string }> {
  if (!isMongoReady()) {
    return { ok: false, matched: false, modified: false, orderSn: String(orderSn || "") };
  }
  requireMongo();
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  const sid = String(shopId || "").trim();
  const name = String(shopName || "").trim();
  if (!sn || !sid) {
    return { ok: false, matched: false, modified: false, orderSn: sn };
  }
  const _id = `shopee-${sn}`;
  const filter = {
    $or: [{ orderSn: sn }, { "data.orderSn": sn }, { "data.order_sn": sn }, { _id }],
  };
  const $set: Record<string, unknown> = {
    shopId: sid,
    "data.shopId": sid,
    "data.shopName": name || `Shop ${sid}`,
    last_synced_at: new Date(),
    "data.last_synced_at": new Date().toISOString(),
  };
  const result = await OrderModel.findOneAndUpdate(
    filter,
    { $set },
    { new: true, maxTimeMS: 15_000 },
  );
  const matched = Boolean(result);
  console.log(
    `[MongoDB] forceUpdateOrderShopId order_sn=${sn} → shopId=${sid} (${name}) ok=${matched}`,
  );
  return { ok: matched, matched, modified: matched, orderSn: sn };
}

/**
 * Force ghi đè shopId + shopName — tìm theo order_sn HOẶC tracking_no.
 */
export async function forceUpdateOrderShopIdByCodeInStore(
  code: string,
  shopId: string,
  shopName: string,
): Promise<{
  ok: boolean;
  matched: boolean;
  modified: boolean;
  code: string;
  matchedBy?: string;
}> {
  if (!isMongoReady()) {
    return { ok: false, matched: false, modified: false, code: String(code || "") };
  }
  requireMongo();
  const raw = String(code || "").replace(/^shopee-/i, "").trim();
  const sid = String(shopId || "").trim();
  const name = String(shopName || "").trim();
  if (!raw || !sid) {
    return { ok: false, matched: false, modified: false, code: raw };
  }
  const _id = `shopee-${raw}`;
  const filter = {
    $or: [
      { orderSn: raw },
      { "data.orderSn": raw },
      { "data.order_sn": raw },
      { _id },
      { tracking_no: raw },
      { "data.tracking_no": raw },
      { "data.trackingNumber": raw },
    ],
  };
  const $set: Record<string, unknown> = {
    shopId: sid,
    "data.shopId": sid,
    "data.shopName": name || `Shop ${sid}`,
    last_synced_at: new Date(),
    "data.last_synced_at": new Date().toISOString(),
  };
  const result = await OrderModel.findOneAndUpdate(
    filter,
    { $set },
    { new: true, maxTimeMS: 15_000 },
  );
  const matched = Boolean(result);
  let matchedBy = "none";
  if (result) {
    const doc: any = result;
    if (String(doc.orderSn || doc.data?.orderSn || "") === raw) matchedBy = "order_sn";
    else if (
      String(doc.tracking_no || doc.data?.tracking_no || doc.data?.trackingNumber || "") === raw
    ) {
      matchedBy = "tracking_no";
    } else matchedBy = "document";
  }
  console.log(
    `[MongoDB] forceUpdateOrderShopIdByCode code=${raw} → shopId=${sid} (${name}) ok=${matched} by=${matchedBy}`,
  );
  return { ok: matched, matched, modified: matched, code: raw, matchedBy };
}

/**
 * Ghi package_number (+ tracking nếu có) vào Mongo — dùng khi enrich in đơn
 * lấy được package_number nhưng chưa có tracking_no.
 */
export async function updateOrderPackageNumberInStore(
  orderSn: string,
  packageNumber: string,
  extra?: {
    trackingNo?: string;
    internalTrackingCode?: string;
    status?: string;
    isPrepared?: boolean;
    shopee_order_status?: string;
    shopId?: string;
  },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").trim();
  const pkg = String(packageNumber || "").trim();
  if (!sn || !pkg) return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = extra?.shopId != null ? String(extra.shopId).trim() : "";
  const $set: Record<string, unknown> = {
    packageNumber: pkg,
    "data.packageNumber": pkg,
    "data.package_number": pkg,
  };
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }
  const tn = String(extra?.trackingNo || "").trim();
  if (tn && !/^0FG/i.test(tn)) {
    $set.tracking_no = tn;
    $set["data.tracking_no"] = tn;
    $set["data.trackingNumber"] = tn;
  }
  if (extra?.internalTrackingCode) {
    $set["data.internalTrackingCode"] = extra.internalTrackingCode;
  }
  if (extra?.status != null) {
    $set.status = String(extra.status);
    $set["data.status"] = String(extra.status);
  }
  if (extra?.isPrepared != null) {
    $set["data.isPrepared"] = extra.isPrepared;
  }
  if (extra?.shopee_order_status != null) {
    $set.shopee_order_status = String(extra.shopee_order_status);
    $set["data.shopee_order_status"] = String(extra.shopee_order_status);
  }
  const $setOnInsert: Record<string, unknown> = {
    _id,
    orderSn: sn,
    "data.id": _id,
    "data.orderSn": sn,
    "data.channel": "shopee",
  };
  const result = await OrderModel.findOneAndUpdate(
    buildOrderCompoundFilter(sn, _id, shopIdStr),
    { $set, $setOnInsert },
    { new: true, upsert: true },
  );
  console.log(
    `[MongoDB] findOneAndUpdate packageNumber=${pkg} order_sn=${sn} shopId=${shopIdStr || "-"} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

/** Xóa đơn theo id / orderSn khỏi collection orders (Mongo). */
export async function deleteOrdersFromStore(
  idsOrSns: string[],
): Promise<number> {
  if (!isMongoReady()) return 0;
  requireMongo();
  const keys = [...new Set(idsOrSns.map((k) => String(k || "").trim()).filter(Boolean))];
  if (keys.length === 0) return 0;
  const idList = keys.flatMap((k) => (k.startsWith("shopee-") ? [k] : [k, `shopee-${k}`]));
  const snList = keys.map((k) => k.replace(/^shopee-/i, "")).filter(Boolean);
  const result = await OrderModel.deleteMany({
    $or: [{ _id: { $in: idList } }, { orderSn: { $in: snList } }, { "data.orderSn": { $in: snList } }],
  });
  console.log(
    `[MongoDB] deleteMany orders — deleted=${result.deletedCount || 0} keys=${keys.length}`,
  );
  return Number(result.deletedCount || 0);
}

/** Xóa mọi đơn Mongo có cờ ĐÃ GIAO CHO ĐVVC (HANDED_OVER). */
export async function deleteHandedOverOrdersFromStore(): Promise<{
  deleted: number;
  sns: string[];
}> {
  if (!isMongoReady()) return { deleted: 0, sns: [] };
  requireMongo();
  const filter = {
    $or: [
      { is_handed_over: true },
      { "data.is_handed_over": true },
      { "data.local_status": { $regex: /^HANDED_OVER$/i } },
      { "data.localStatus": { $regex: /^HANDED_OVER$/i } },
      { "data.isHandedOverToCarrier": { $in: [true, "true", 1, "1"] } },
      { "data.is_handed_over_to_carrier": { $in: [true, "true", 1, "1"] } },
      { local_status: { $regex: /^HANDED_OVER$/i } },
      { is_handed_over_to_carrier: { $in: [true, "true", 1, "1"] } },
      { isHandedOverToCarrier: { $in: [true, "true", 1, "1"] } },
      { status: "handed_over" },
      { "data.status": "handed_over" },
    ],
  };
  const docs = await OrderModel.find(filter)
    .select({ _id: 1, orderSn: 1, "data.orderSn": 1 })
    .lean();
  const sns = [
    ...new Set(
      docs
        .map((d: any) =>
          String(d?.orderSn || d?.data?.orderSn || d?._id || "").trim(),
        )
        .filter(Boolean),
    ),
  ];
  // deleteMany — không deleteOne / không LIMIT
  const result = await OrderModel.deleteMany(filter);
  const deleted = Number(result.deletedCount || 0);
  console.log(`Deleted count: ${deleted}`);
  console.log(
    `[MongoDB] deleteHandedOver deleteMany — deleted=${deleted} matched=${docs.length} sns=${sns.join(",") || "(none)"}`,
  );
  return { deleted, sns };
}

/**
 * TRƯỚC ĐÂY: Shopee get_order_detail "not found" → đánh CANCELLED local.
 * ĐÃ TẮT: API lỗi (sai shop_id / token / not found) ≠ đơn hủy — giữ nguyên status DB.
 */
export async function markOrdersCancelledAsShopeeNotFoundInStore(
  orderSns: string[],
  opts?: { shopId?: string; reason?: string },
): Promise<{ matched: number; modified: number; sns: string[] }> {
  const sns = [
    ...new Set(
      (orderSns || [])
        .map((sn) => String(sn || "").replace(/^shopee-/i, "").trim())
        .filter(Boolean),
    ),
  ];
  const shopIdStr = opts?.shopId != null ? String(opts.shopId).trim() : "";
  const reason = String(opts?.reason || "shopee_get_order_detail_not_found").slice(0, 200);
  console.error(
    `[MongoDB] SKIP CANCELLED on API error shop=${shopIdStr || "-"} n=${sns.length}` +
      ` sns=${sns.slice(0, 8).join(",")}${sns.length > 8 ? "…" : ""} reason=${reason}` +
      ` — giữ nguyên trạng thái cũ`,
  );
  return { matched: 0, modified: 0, sns };
}

/**
 * Đơn bị đánh CANCELLED vì get_order_detail fail (cờ shopee_not_found) — ứng viên remap shop.
 */
export async function findWrongShopCancelledCandidatesFromStore(opts?: {
  limit?: number;
  lookbackDays?: number;
}): Promise<Array<{ orderSn: string; shopId: string }>> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit = Math.max(1, Math.min(40, Number(opts?.limit) || 20));
  const lookbackDays = Math.max(1, Math.min(30, Number(opts?.lookbackDays) || 14));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const docs = await OrderModel.find({
    $and: [
      {
        $or: [
          { channel: "shopee" },
          { "data.channel": "shopee" },
          { channel: { $exists: false } },
        ],
      },
      {
        $or: [
          { "data.shopee_not_found": true },
          { shopee_not_found: true },
          { "data.shopee_not_found_reason": { $exists: true, $nin: [null, ""] } },
        ],
      },
      {
        $or: [
          { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } },
          { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL"] } },
          { status: "cancelled" },
          { "data.status": "cancelled" },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: sinceIso } },
          { last_shopee_update_at: { $gte: since } },
          { last_synced_at: { $gte: since } },
          { "data.shopee_not_found_at": { $gte: sinceIso } },
        ],
      },
    ],
  })
    .select({ orderSn: 1, shopId: 1, "data.orderSn": 1, "data.shopId": 1 })
    .sort({ last_synced_at: -1, _id: -1 })
    .limit(limit)
    .maxTimeMS(8000)
    .lean();
  const out: Array<{ orderSn: string; shopId: string }> = [];
  const seen = new Set<string>();
  for (const doc of docs || []) {
    const sn = String(doc?.orderSn || doc?.data?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (!sn || seen.has(sn)) continue;
    seen.add(sn);
    out.push({
      orderSn: sn,
      shopId: String(doc?.shopId || doc?.data?.shopId || "").trim(),
    });
  }
  return out;
}

/**
 * Đơn CANCELLED/IN_CANCEL 30 ngày gần đây mà data.items rỗng — ứng viên backfill get_order_detail.
 * Giới hạn cứng limit + maxTimeMS (chống vòng lặp).
 */
export async function findCancelledEmptyItemsFromStore(opts?: {
  limit?: number;
  lookbackDays?: number;
}): Promise<Array<{ orderSn: string; shopId: string }>> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit = Math.max(1, Math.min(80, Number(opts?.limit) || 40));
  const lookbackDays = Math.max(1, Math.min(30, Number(opts?.lookbackDays) || 30));
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const docs = await OrderModel.find({
    $and: [
      {
        $or: [
          { channel: "shopee" },
          { "data.channel": "shopee" },
          { channel: { $exists: false } },
        ],
      },
      {
        $or: [
          { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } },
          { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL"] } },
          { status: "cancelled" },
          { "data.status": "cancelled" },
        ],
      },
      {
        $or: [
          { "data.items": { $exists: false } },
          { "data.items": { $size: 0 } },
          { "data.items": null },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: sinceIso } },
          { last_shopee_update_at: { $gte: since } },
          { last_synced_at: { $gte: since } },
        ],
      },
    ],
  })
    .select({ orderSn: 1, shopId: 1, "data.orderSn": 1, "data.shopId": 1 })
    .sort({ last_shopee_update_at: -1, _id: -1 })
    .limit(limit)
    .maxTimeMS(8000)
    .lean();
  const out: Array<{ orderSn: string; shopId: string }> = [];
  const seen = new Set<string>();
  for (const doc of docs || []) {
    const sn = String(doc?.orderSn || doc?.data?.orderSn || "")
      .replace(/^shopee-/i, "")
      .trim();
    if (!sn || seen.has(sn)) continue;
    seen.add(sn);
    out.push({
      orderSn: sn,
      shopId: String(doc?.shopId || doc?.data?.shopId || "").trim(),
    });
  }
  return out;
}

/** Chỉ ghi data.items — CẤM đụng cờ kho. */
export async function patchOrderItemsOnlyInStore(
  orderSn: string,
  items: any[],
  opts?: { shopId?: string },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").replace(/^shopee-/i, "").trim();
  const list = Array.isArray(items) ? items : [];
  if (!sn || list.length === 0) return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = opts?.shopId != null ? String(opts.shopId).trim() : "";
  const safeItems = stringifyShopeeIdsDeep(list);
  const $set: Record<string, unknown> = {
    "data.items": safeItems,
    last_synced_at: new Date(),
    "data.last_synced_at": new Date().toISOString(),
  };
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }
  const result = await OrderModel.updateOne(
    buildOrderCompoundFilter(sn, _id, shopIdStr || null),
    { $set },
    { maxTimeMS: 8_000 },
  );
  return Number((result as any).modifiedCount ?? (result as any).nModified ?? 0) > 0
    || Number((result as any).matchedCount ?? (result as any).n ?? 0) > 0;
}

/**
 * Migration one-shot: đơn đã SHIPPED (hoặc hoàn tất/hủy) mà còn is_handed_over=true
 * → clear cờ nội bộ (tránh kẹt tab "Đã giao ĐVVC").
 */
export async function clearHandedOverFlagsForShippedOrders(): Promise<{
  matched: number;
  modified: number;
}> {
  if (!isMongoReady()) return { matched: 0, modified: 0 };
  requireMongo();
  const filter = {
    $and: [
      {
        $or: [
          { is_handed_over: true },
          { "data.is_handed_over": true },
          { "data.isHandedOverToCarrier": true },
          { "data.is_handed_over_to_carrier": true },
          { "data.is_handed_over_to_courier": true },
          { "data.local_status": "HANDED_OVER" },
          { "data.localStatus": "HANDED_OVER" },
          { "data.internal_status": "HANDED_OVER" },
        ],
      },
      {
        $or: [
          { shopee_order_status: { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
          { "data.shopee_order_status": { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
          { status: { $in: ["shipping", "completed", "cancelled", "return_pending", "return_received"] } },
          { "data.status": { $in: ["shipping", "completed", "cancelled", "return_pending", "return_received"] } },
        ],
      },
    ],
  };
  const $set = {
    is_handed_over: false,
    "data.is_handed_over": false,
    "data.isHandedOverToCarrier": false,
    "data.is_handed_over_to_carrier": false,
    "data.is_handed_over_to_courier": false,
    "data.handed_over_source": null,
    "data.handedOverSource": null,
  };
  const result = await OrderModel.updateMany(filter, { $set }, { maxTimeMS: 30_000 });
  const matched = Number((result as any).matchedCount ?? (result as any).n ?? 0);
  const modified = Number((result as any).modifiedCount ?? (result as any).nModified ?? 0);
  console.log(
    `[MongoDB] clearHandedOverFlagsForShippedOrders — matched=${matched} modified=${modified}`,
  );
  return { matched, modified };
}

/**
 * One-shot: đơn kẹt Chờ xác nhận (UNPAID/PENDING/pending_confirm) nhưng ĐÃ có tracking_no
 * → promote PROCESSED ở root + data để nhảy tab Đã xử lý.
 */
export async function healLaggingPendingConfirmWithTrackingInStore(): Promise<{
  matched: number;
  modified: number;
}> {
  if (!isMongoReady()) return { matched: 0, modified: 0 };
  requireMongo();
  const filter = {
    $and: [
      laggingPendingConfirmMongoFilter(),
      {
        $or: [
          { tracking_no: { $regex: /^(?!0FG).+$/i } },
          { trackingNumber: { $regex: /^(?!0FG).+$/i } },
          { "data.tracking_no": { $regex: /^(?!0FG).+$/i } },
          { "data.trackingNumber": { $regex: /^(?!0FG).+$/i } },
        ],
      },
    ],
  };
  const result = await OrderModel.updateMany(filter, { $set: { ...LAGGING_PENDING_PROMOTE_SET } }, {
    maxTimeMS: 30_000,
  } as any);
  const matched = Number((result as any).matchedCount ?? (result as any).n ?? 0);
  const modified = Number((result as any).modifiedCount ?? (result as any).nModified ?? 0);
  console.log(
    `[MongoDB] healLaggingPendingConfirmWithTracking — matched=${matched} modified=${modified}`,
  );
  return { matched, modified };
}

/**
 * Xóa đơn đã đóng quá hạn retention (giải phóng dung lượng Atlas).
 * - Hủy/hoàn đã lưu / archived: > cancelReturnDays (mặc định 14)
 * - Hoàn tất / đang giao cũ / ĐVVC: > closedDays (mặc định 30)
 * Không đụng đơn đang chờ lấy / chờ xác nhận.
 */
export async function deleteClosedOrdersByRetention(opts?: {
  cancelReturnDays?: number;
  closedDays?: number;
  dryRun?: boolean;
  limit?: number;
}): Promise<{
  deleted: number;
  sns: string[];
  scanned: number;
  dryRun: boolean;
  cancelReturnMatched: number;
  closedMatched: number;
}> {
  if (!isMongoReady()) {
    return {
      deleted: 0,
      sns: [],
      scanned: 0,
      dryRun: Boolean(opts?.dryRun),
      cancelReturnMatched: 0,
      closedMatched: 0,
    };
  }
  requireMongo();

  const cancelReturnDays = Math.max(1, Math.floor(opts?.cancelReturnDays ?? 14));
  const closedDays = Math.max(1, Math.floor(opts?.closedDays ?? 30));
  const dryRun = Boolean(opts?.dryRun);
  const limit = Math.min(
    5000,
    Math.max(1, Math.floor(opts?.limit ?? 3000)),
  );
  const cancelCutoff = Date.now() - cancelReturnDays * 24 * 60 * 60 * 1000;
  const closedCutoff = Date.now() - closedDays * 24 * 60 * 60 * 1000;

  const parseTs = (raw: unknown): number => {
    if (raw == null || raw === "") return 0;
    if (typeof raw === "number") {
      return raw < 1e12 ? raw * 1000 : raw;
    }
    if (raw instanceof Date) return raw.getTime();
    const ms = Date.parse(String(raw));
    return Number.isFinite(ms) ? ms : 0;
  };

  const orderAgeMs = (d: any): number => {
    const data = d?.data && typeof d.data === "object" ? d.data : {};
    const candidates = [
      data.local_status_updated_at,
      data.localStatusAt,
      data.handedOverAt,
      d.local_status_updated_at,
      data.date,
      d.date,
      data.update_time,
      d.update_time,
      d.last_synced_at,
      data.last_synced_at,
    ];
    let best = 0;
    for (const c of candidates) {
      const t = parseTs(c);
      if (t > best) best = t;
    }
    return best;
  };

  const localOf = (d: any): string =>
    String(d?.data?.local_status || d?.data?.localStatus || d?.local_status || "")
      .trim()
      .toUpperCase();
  const statusOf = (d: any): string =>
    String(d?.status || d?.data?.status || "")
      .trim()
      .toLowerCase();
  const rawOf = (d: any): string =>
    String(d?.shopee_order_status || d?.data?.shopee_order_status || "")
      .trim()
      .toUpperCase();

  const isProtectedLive = (d: any): boolean => {
    const local = localOf(d);
    if (
      local === "CANCELLED_STORED" ||
      local === "RETURN_RECEIVED" ||
      d?.data?.is_local_return_archived === true ||
      d?.is_local_return_archived === true
    ) {
      return false;
    }
    const raw = rawOf(d);
    if (["CANCELLED", "IN_CANCEL", "TO_RETURN", "COMPLETED", "SHIPPED", "TO_CONFIRM_RECEIVE"].includes(raw)) {
      return false;
    }
    const st = statusOf(d);
    if (["cancelled", "return_received", "return_pending", "completed", "shipping", "handed_over"].includes(st)) {
      return false;
    }
    if (local === "HANDED_OVER" || d?.is_handed_over === true || d?.data?.is_handed_over === true) {
      return false;
    }
    // Đơn đang vận hành: chờ xác nhận / chờ lấy hàng.
    if (["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED", "UNPAID", "PENDING"].includes(raw)) return true;
    if (["unprocessed", "processed", "pending_confirm", "pending_verification"].includes(st)) return true;
    return false;
  };

  const isCancelReturnClosed = (d: any): boolean => {
    const local = localOf(d);
    if (local === "CANCELLED_STORED" || local === "RETURN_RECEIVED") return true;
    if (d?.data?.is_local_return_archived === true || d?.is_local_return_archived === true) return true;
    const st = statusOf(d);
    if (st === "cancelled" || st === "return_received" || st === "return_pending") return true;
    const raw = rawOf(d);
    return raw === "CANCELLED" || raw === "IN_CANCEL" || raw === "TO_RETURN";
  };

  const isTerminalClosed = (d: any): boolean => {
    if (isCancelReturnClosed(d)) return false;
    const local = localOf(d);
    if (local === "HANDED_OVER") return true;
    if (d?.is_handed_over === true || d?.data?.is_handed_over === true) return true;
    const st = statusOf(d);
    if (st === "completed" || st === "shipping" || st === "handed_over") return true;
    const raw = rawOf(d);
    return raw === "COMPLETED" || raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE";
  };

  const filter = {
    $or: [
      { status: { $in: ["cancelled", "return_received", "return_pending", "completed", "shipping", "handed_over"] } },
      {
        shopee_order_status: {
          $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN", "COMPLETED", "SHIPPED", "TO_CONFIRM_RECEIVE"],
        },
      },
      { "data.local_status": { $in: ["CANCELLED_STORED", "RETURN_RECEIVED", "HANDED_OVER"] } },
      { "data.localStatus": { $in: ["CANCELLED_STORED", "RETURN_RECEIVED", "HANDED_OVER"] } },
      { "data.is_local_return_archived": true },
      { is_handed_over: true },
      { "data.is_handed_over": true },
    ],
  };

  let docs: any[] = [];
  try {
    docs = await OrderModel.find(filter)
      .select({
        _id: 1,
        orderSn: 1,
        status: 1,
        shopee_order_status: 1,
        is_handed_over: 1,
        local_status: 1,
        last_synced_at: 1,
        "data.orderSn": 1,
        "data.status": 1,
        "data.date": 1,
        "data.update_time": 1,
        "data.local_status": 1,
        "data.localStatus": 1,
        "data.local_status_updated_at": 1,
        "data.localStatusAt": 1,
        "data.handedOverAt": 1,
        "data.is_handed_over": 1,
        "data.is_local_return_archived": 1,
        "data.shopee_order_status": 1,
        "data.last_synced_at": 1,
      })
      .limit(limit)
      .maxTimeMS(20_000)
      .lean();
  } catch (err: any) {
    console.warn("[MongoDB] deleteClosedOrdersByRetention find failed:", err?.message || err);
    throw err;
  }

  const toDeleteKeys: string[] = [];
  const sns: string[] = [];
  let cancelReturnMatched = 0;
  let closedMatched = 0;

  for (const d of docs) {
    if (isProtectedLive(d)) continue;
    const age = orderAgeMs(d);
    if (!age) continue;
    let matched = false;
    if (isCancelReturnClosed(d) && age < cancelCutoff) {
      cancelReturnMatched += 1;
      matched = true;
    } else if (isTerminalClosed(d) && age < closedCutoff) {
      closedMatched += 1;
      matched = true;
    }
    if (!matched) continue;
    const sn = String(d?.orderSn || d?.data?.orderSn || "").trim();
    const id = String(d?._id || "").trim();
    if (sn) {
      sns.push(sn);
      toDeleteKeys.push(sn);
    }
    if (id) toDeleteKeys.push(id);
  }

  if (dryRun || toDeleteKeys.length === 0) {
    console.log(
      `[MongoDB] retention dryRun=${dryRun} scanned=${docs.length} cancelReturn=${cancelReturnMatched} closed=${closedMatched} wouldDelete=${sns.length}`,
    );
    return {
      deleted: 0,
      sns: [...new Set(sns)],
      scanned: docs.length,
      dryRun,
      cancelReturnMatched,
      closedMatched,
    };
  }

  const deleted = await deleteOrdersFromStore(toDeleteKeys);
  console.log(
    `[MongoDB] retention deleted=${deleted} cancelReturn=${cancelReturnMatched} closed=${closedMatched} scanned=${docs.length}`,
  );
  return {
    deleted,
    sns: [...new Set(sns)],
    scanned: docs.length,
    dryRun: false,
    cancelReturnMatched,
    closedMatched,
  };
}

/**
 * Map orderSn → tracking_no từ Mongo (top-level + data).
 * Dùng để hydrate orders.json / API khi mã đã sync Mongo nhưng JSON local còn trống.
 */
export async function loadOrderTrackingMapFromStore(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!isMongoReady()) return map;
  requireMongo();
  const docs = await OrderModel.find({
    $or: [
      { tracking_no: { $exists: true, $nin: [null, ""] } },
      { "data.tracking_no": { $exists: true, $nin: [null, ""] } },
      { "data.trackingNumber": { $exists: true, $nin: [null, ""] } },
    ],
  })
    .select({
      orderSn: 1,
      tracking_no: 1,
      "data.orderSn": 1,
      "data.tracking_no": 1,
      "data.trackingNumber": 1,
    })
    .lean();

  for (const d of docs as any[]) {
    const sn = String(d?.orderSn || d?.data?.orderSn || d?._id || "")
      .replace(/^shopee-/i, "")
      .trim();
    const tn = String(
      d?.tracking_no || d?.data?.tracking_no || d?.data?.trackingNumber || "",
    ).trim();
    if (!sn || !tn || /^0FG/i.test(tn)) continue;
    map.set(sn, tn);
  }
  return map;
}

/**
 * Đồng bộ tracking_no top-level → data.tracking_no / data.trackingNumber (Mongo).
 * Script sync cũ đôi khi chỉ ghi top-level → UI/API đọc data bị trống.
 */
export async function mirrorTopLevelTrackingIntoData(): Promise<number> {
  if (!isMongoReady()) return 0;
  requireMongo();
  const docs = await OrderModel.find({
    tracking_no: { $exists: true, $nin: [null, ""] },
  })
    .select({ _id: 1, tracking_no: 1, "data.tracking_no": 1, "data.trackingNumber": 1 })
    .lean();

  const ops = [];
  for (const d of docs as any[]) {
    const tn = String(d?.tracking_no || "").trim();
    if (!tn || /^0FG/i.test(tn)) continue;
    const dataTn = String(d?.data?.tracking_no || d?.data?.trackingNumber || "").trim();
    if (dataTn === tn) continue;
    ops.push({
      updateOne: {
        filter: { _id: d._id },
        update: {
          $set: {
            "data.tracking_no": tn,
            "data.trackingNumber": tn,
          },
        },
      },
    });
  }
  if (ops.length === 0) return 0;
  const result = await OrderModel.bulkWrite(ops as any, { ordered: false });
  console.log(
    `[MongoDB] mirrorTopLevelTrackingIntoData — modified=${result.modifiedCount || 0} ops=${ops.length}`,
  );
  return ops.length;
}

/** Chuẩn hóa mã súng quét: trim + UPPER — exact $eq, không regex. */
export function normalizeScannedCode(raw: unknown): string {
  return String(raw || "")
    .trim()
    .toUpperCase();
}

function stripScannedSeparators(code: string): string {
  return String(code || "").replace(/[\s\-_#./\\|:;,]+/g, "");
}

function pushScanFieldVariants(
  $or: Record<string, string>[],
  field: string,
  variants: string[],
): void {
  for (const v of variants) {
    if (v) $or.push({ [field]: v });
  }
}

/** $or exact $eq trên trackingNumber / returnTrackingNumber / packageNumber / orderSn (+ alias snake_case đã lưu). */
function buildExactScanOrFilter(rawCode: string): Record<string, unknown> | null {
  const scannedCode = normalizeScannedCode(rawCode);
  if (!scannedCode) return null;
  const stripped = stripScannedSeparators(scannedCode);
  const variants = [...new Set([scannedCode, stripped].filter(Boolean))];
  const $or: Record<string, string>[] = [];
  for (const code of variants) {
    pushScanFieldVariants($or, "trackingNumber", [code]);
    pushScanFieldVariants($or, "tracking_no", [code]);
    pushScanFieldVariants($or, "data.trackingNumber", [code]);
    pushScanFieldVariants($or, "data.tracking_no", [code]);
    pushScanFieldVariants($or, "returnTrackingNumber", [code]);
    pushScanFieldVariants($or, "return_tracking_no", [code]);
    pushScanFieldVariants($or, "data.returnTrackingNumber", [code]);
    pushScanFieldVariants($or, "data.return_tracking_no", [code]);
    pushScanFieldVariants($or, "packageNumber", [code]);
    pushScanFieldVariants($or, "data.packageNumber", [code]);
    pushScanFieldVariants($or, "data.package_number", [code]);
    pushScanFieldVariants($or, "orderSn", [code]);
    pushScanFieldVariants($or, "data.orderSn", [code]);
    pushScanFieldVariants($or, "data.order_sn", [code]);
    pushScanFieldVariants($or, "return_sn", [code]);
    pushScanFieldVariants($or, "data.return_sn", [code]);
    pushScanFieldVariants($or, "data.internalTrackingCode", [code]);
    const orderSn = code.replace(/^SHOPEE-/, "");
    if (orderSn && orderSn !== code) {
      $or.push({ orderSn }, { "data.orderSn": orderSn }, { "data.order_sn": orderSn });
      $or.push({ _id: `shopee-${orderSn}` });
    } else {
      $or.push({ _id: `shopee-${code}` });
    }
  }
  return $or.length ? { $or } : null;
}

const SCAN_LOOKUP_MAX_MS = 2_500;

/** Đọc cờ isPrinted — ưu tiên top-level, fallback data.isPrinted (khớp badge/lọc UI). */
function readPrintedFlag(top: unknown, nested: unknown): boolean {
  const pick = (v: unknown): boolean | null => {
    if (v === true || v === 1) return true;
    if (v === false || v === 0) return false;
    if (v == null) return null;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true" || s === "1" || s === "yes") return true;
      if (s === "false" || s === "0" || s === "no" || s === "") return false;
    }
    return null;
  };
  const fromTop = pick(top);
  if (fromTop != null) return fromTop;
  return pick(nested) === true;
}

/** Map Shopee `item_list` → `items` UI khi `data.items` bị gọt / rỗng. */
function mapShopeeItemListForPrint(rawList: unknown): any[] {
  if (!Array.isArray(rawList) || rawList.length === 0) return [];
  const out: any[] = [];
  for (const it of rawList) {
    if (!it || typeof it !== "object") continue;
    const row = it as Record<string, unknown>;
    const imgInfo =
      row.image_info && typeof row.image_info === "object"
        ? (row.image_info as Record<string, unknown>)
        : {};
    const qty = Math.max(
      0,
      Number(row.model_quantity_purchased ?? row.quantity ?? row.qty) || 0,
    );
    out.push({
      productId: String(row.item_id ?? row.productId ?? row.item_sku ?? ""),
      productTitle: String(
        row.item_name ?? row.productTitle ?? row.name ?? row.model_name ?? "",
      ),
      productImage: String(
        imgInfo.image_url ?? row.productImage ?? row.image_url ?? row.image ?? "",
      ).trim() || undefined,
      quantity: qty,
      price: Number(row.model_discounted_price ?? row.item_price ?? row.price) || 0,
      originalPrice: Number(row.model_original_price ?? row.originalPrice) || undefined,
      modelId: row.model_id != null ? String(row.model_id) : undefined,
      modelSku: row.model_sku != null ? String(row.model_sku) : undefined,
      modelName: row.model_name != null ? String(row.model_name) : undefined,
    });
  }
  return out;
}

function recipientAddressFromData(data: any): {
  name: string;
  phone: string;
  address: string;
} {
  const addr =
    data?.recipient_address && typeof data.recipient_address === "object"
      ? data.recipient_address
      : {};
  const name = String(addr.name || addr.recipient_name || "").trim();
  const phone = String(addr.phone || addr.phone_number || "").trim();
  const address = [
    addr.full_address,
    addr.address,
    addr.district,
    addr.city,
    addr.state,
    addr.zipcode,
    addr.country,
  ]
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .join(", ");
  return { name, phone, address };
}

function hydrateOrderFromMongoDoc(d: any): any | null {
  if (!d) return null;
  const data = d?.data && typeof d.data === "object" ? { ...d.data } : {};
  const sn = String(d?.orderSn || data.orderSn || String(d?._id || "").replace(/^shopee-/i, "")).trim();
  if (!sn && !d?._id) return null;
  // Outbound TN — KHÔNG fallback return_tracking_no (mã chiều hoàn giữ riêng).
  const pkgList0 =
    Array.isArray(data.package_list) && data.package_list[0] && typeof data.package_list[0] === "object"
      ? (data.package_list[0] as Record<string, unknown>)
      : {};
  const tn = String(
    d?.tracking_no ||
      d?.trackingNumber ||
      data.tracking_no ||
      data.trackingNumber ||
      data.shopee_tracking_number ||
      pkgList0.tracking_number ||
      pkgList0.tracking_no ||
      pkgList0.trackingNumber ||
      "",
  ).trim();
  const returnTnRaw = String(
    d?.return_tracking_no ||
      d?.returnTrackingNumber ||
      data.return_tracking_no ||
      data.returnTrackingNumber ||
      "",
  )
    .trim()
    .toUpperCase();
  const returnTn = returnTnRaw && returnTnRaw !== tn.toUpperCase() ? returnTnRaw : "";
  const returnSnHydrated = String(d?.return_sn || data.return_sn || "").trim();
  const pkg = String(
    d?.packageNumber ||
      data.packageNumber ||
      data.package_number ||
      d?.package_number ||
      "",
  ).trim();
  const rawStatus = String(d?.shopee_order_status || data.shopee_order_status || "")
    .trim()
    .toUpperCase();
  const carrier = String(
    d?.shipping_carrier || data.shipping_carrier || data.checkout_shipping_carrier || "",
  ).trim();
  // SHIPPED+ → cờ bàn giao nội bộ hết tác dụng (tránh kẹt tab Đã giao ĐVVC).
  const leftHandoverPhase =
    rawStatus === "SHIPPED" ||
    rawStatus === "TO_CONFIRM_RECEIVE" ||
    rawStatus === "COMPLETED" ||
    rawStatus === "CANCELLED" ||
    rawStatus === "IN_CANCEL" ||
    rawStatus === "TO_RETURN" ||
    d?.status === "shipping" ||
    d?.status === "completed" ||
    data.status === "shipping" ||
    data.status === "completed";
  const handed = leftHandoverPhase
    ? false
    : d?.is_handed_over === true ||
      data.is_handed_over === true ||
      data.isHandedOverToCarrier === true ||
      data.is_handed_over_to_carrier === true ||
      data.is_handed_over_to_courier === true ||
      String(data.local_status || data.localStatus || data.internal_status || "").toUpperCase() ===
        "HANDED_OVER";
  const localRaw = String(
    data.local_status || data.localStatus || data.internal_status || "",
  ).toUpperCase();
  const localStored =
    localRaw === "CANCELLED_STORED" || localRaw === "RETURN_RECEIVED"
      ? localRaw
      : handed
        ? "HANDED_OVER"
        : localRaw === "NONE" || localRaw === "HANDED_OVER"
          ? leftHandoverPhase
            ? "NONE"
            : localRaw
          : "";
  // Customer — root / data.* / Shopee recipient_address (In Đơn)
  const recipient = recipientAddressFromData(data);
  const customerNameHydrated = String(
    d?.customerName ||
      data.customerName ||
      data.customer_name ||
      data.buyer_username ||
      recipient.name ||
      "",
  ).trim();
  const customerPhoneHydrated = String(
    d?.customerPhone ||
      data.customerPhone ||
      data.customer_phone ||
      recipient.phone ||
      "",
  ).trim();
  const customerAddressHydrated = String(
    d?.customerAddress ||
      data.customerAddress ||
      data.customer_address ||
      recipient.address ||
      "",
  ).trim();
  const customerEmailHydrated = String(
    d?.customerEmail ||
      data.customerEmail ||
      data.customer_email ||
      "",
  ).trim();
  const billingHydrated =
    (d?.billing && typeof d.billing === "object" ? d.billing : null) ||
    (data.billing && typeof data.billing === "object" ? data.billing : null) ||
    undefined;
  const shippingHydrated =
    (d?.shipping && typeof d.shipping === "object" && !Array.isArray(d.shipping)
      ? d.shipping
      : null) ||
    (data.shipping && typeof data.shipping === "object" && !Array.isArray(data.shipping)
      ? data.shipping
      : null) ||
    undefined;

  const channelHydrated = String(d?.channel || data.channel || "").trim();
  const shopIdHydrated =
    d?.shopId != null && String(d.shopId).trim()
      ? d.shopId
      : data.shopId != null && String(data.shopId).trim()
        ? data.shopId
        : data.shop_id != null && String(data.shop_id).trim()
          ? data.shop_id
          : d?.shop_id;
  const hydrated: any = {
    ...data,
    id: data.id || d._id || (sn ? `shopee-${sn}` : undefined),
    orderSn: sn || data.orderSn || data.order_sn,
    order_sn: sn || data.order_sn || data.orderSn,
    status: d?.status != null ? d.status : data.status,
    shopee_order_status: rawStatus || data.shopee_order_status || undefined,
    channel: channelHydrated || undefined,
    shopId: shopIdHydrated,
    shop_id: shopIdHydrated,
    shopName: d?.shopName || data.shopName || data.shop_name || undefined,
    fulfillment_type: d?.fulfillment_type || data.fulfillment_type || undefined,
    ship_method: d?.ship_method || data.ship_method || undefined,
    pickup_info: d?.pickup_info || data.pickup_info || undefined,
    items: Array.isArray(data.items) && data.items.length > 0
      ? data.items
      : mapShopeeItemListForPrint(data.item_list),
    item_list: Array.isArray(data.item_list) ? data.item_list : undefined,
    package_list: Array.isArray(data.package_list) ? data.package_list : undefined,
    recipient_address: data.recipient_address || undefined,
    buyer_username: data.buyer_username || undefined,
    barcode: d?.barcode || data.barcode || undefined,
    note: d?.note || data.note || undefined,
    scan_code: d?.scan_code || data.scan_code || undefined,
    internalTrackingCode:
      d?.internalTrackingCode || data.internalTrackingCode || undefined,
    // Customer — luôn surface root cho FE (camelCase + snake_case)
    customerName: customerNameHydrated || data.customerName || undefined,
    customerPhone: customerPhoneHydrated || data.customerPhone || undefined,
    customerAddress: customerAddressHydrated || data.customerAddress || undefined,
    customerEmail: customerEmailHydrated || data.customerEmail || undefined,
    customer_name: customerNameHydrated || data.customer_name || undefined,
    customer_phone: customerPhoneHydrated || data.customer_phone || undefined,
    customer_address: customerAddressHydrated || data.customer_address || undefined,
    billing: billingHydrated || data.billing || undefined,
    shipping: shippingHydrated || data.shipping || undefined,
    carrier: data.carrier || d?.carrier || undefined,
    provider: data.provider || data.carrier || undefined,
    external_status: data.external_status || undefined,
    ghnShopId: data.ghnShopId || data.ghn_shop_id || undefined,
    ghn_status: data.ghn_status || undefined,
    ghn_synced_at: data.ghn_synced_at || undefined,
    cod_amount: data.cod_amount != null ? data.cod_amount : undefined,
    tracking_no: tn || undefined,
    trackingNumber: tn || undefined,
    return_tracking_no: returnTn || undefined,
    returnTrackingNumber: returnTn || undefined,
    return_sn: returnSnHydrated || data.return_sn || undefined,
    is_return: d?.is_return === true || data.is_return === true,
    packageNumber: pkg || undefined,
    package_number: pkg || undefined,
    shipping_carrier: carrier || data.shipping_carrier || undefined,
    checkout_shipping_carrier:
      d?.checkout_shipping_carrier || data.checkout_shipping_carrier || undefined,
    is_pending_shopee_check:
      d?.is_pending_shopee_check != null
        ? Boolean(d.is_pending_shopee_check)
        : Boolean(data.is_pending_shopee_check),
    is_handed_over: handed,
    isHandedOverToCarrier: handed,
    is_handed_over_to_carrier: handed,
    is_handed_over_to_courier: handed,
    isPrinted: readPrintedFlag(d?.isPrinted, data.isPrinted),
    hasPdf: (() => {
      const pdfHint = String(
        d?.waybill_url ||
          d?.labelUrl ||
          d?.pdfUrl ||
          d?.pdfFilename ||
          data.waybill_url ||
          data.labelUrl ||
          data.pdfUrl ||
          data.pdfFilename ||
          "",
      ).trim();
      return (
        d?.hasPdf === true ||
        data.hasPdf === true ||
        d?.readyToPrint === true ||
        data.readyToPrint === true ||
        Boolean(pdfHint)
      );
    })(),
    readyToPrint: (() => {
      const pdfHint = String(
        d?.waybill_url ||
          d?.labelUrl ||
          d?.pdfUrl ||
          d?.pdfFilename ||
          data.waybill_url ||
          data.labelUrl ||
          data.pdfUrl ||
          data.pdfFilename ||
          "",
      ).trim();
      return (
        d?.readyToPrint === true ||
        data.readyToPrint === true ||
        d?.hasPdf === true ||
        data.hasPdf === true ||
        Boolean(pdfHint)
      );
    })(),
    isPrepared: d?.isPrepared != null ? Boolean(d.isPrepared) : Boolean(data.isPrepared),
    waybill_url:
      d?.waybill_url || data.waybill_url || data.labelUrl || data.pdfUrl || undefined,
    labelUrl:
      d?.labelUrl || data.labelUrl || data.pdfUrl || data.waybill_url || d?.waybill_url || undefined,
    pdfUrl: d?.pdfUrl || data.pdfUrl || data.labelUrl || data.waybill_url || undefined,
    pdfFilename: d?.pdfFilename || data.pdfFilename || undefined,
    ...(localStored
      ? {
          local_status: localStored,
          localStatus: localStored,
          internal_status: localStored,
        }
      : {}),
  };
  if (isUnshippedShopeeCancel(hydrated)) {
    delete hydrated.return_sn;
    hydrated.is_return = false;
  }
  const cancelKind = classifyShopeeCancelReturnKind(hydrated);
  if (cancelKind) {
    hydrated.shopee_cancel_return_kind = cancelKind;
    const sub = resolveShopeeSubStatus(cancelKind);
    if (sub) hydrated.sub_status = sub;
    hydrated.is_rts = cancelKind === "failed_delivery";
    hydrated.is_return = cancelKind === "refund_return";
    // Chỉ gỡ leftover return_sn của hủy chưa giao — RTS/YCTH giữ return_sn để kéo mã hoàn.
    if (cancelKind === "cancelled" && isUnshippedShopeeCancel(hydrated)) {
      delete hydrated.return_sn;
    }
  }
  const hydrateTn = String(hydrated.tracking_no || hydrated.trackingNumber || tn || "").trim();
  const hydrateRaw = String(hydrated.shopee_order_status || "").toUpperCase();
  const hydrateSt = String(hydrated.status || "");
  if (
    hydrateTn &&
    hydrateTn !== "0" &&
    !/^0FG/i.test(hydrateTn) &&
    isLaggingPendingConfirmPair(hydrateRaw, hydrateSt)
  ) {
    hydrated.shopee_order_status = "PROCESSED";
    hydrated.status = "processed";
    hydrated.isPrepared = true;
    hydrated.is_pending_shopee_check = false;
  }
  return hydrated;
}

/**
 * Lookup 1 đơn theo mã quét — exact $eq trên index, KHÔNG regex, KHÔNG Shopee.
 */
export async function findOrderByScanCodeInStore(rawCode: string): Promise<any | null> {
  if (!isMongoReady()) return null;
  requireMongo();
  const scannedCode = normalizeScannedCode(rawCode);
  if (!scannedCode) return null;
  const filter = buildExactScanOrFilter(scannedCode);
  if (!filter) return null;

  try {
    const doc = await OrderModel.findOne(filter).maxTimeMS(SCAN_LOOKUP_MAX_MS).lean();
    return hydrateOrderFromMongoDoc(doc);
  } catch (err: any) {
    console.warn("[MongoDB] findOrderByScanCodeInStore failed:", err?.message || err);
    return null;
  }
}

/** Đọc đơn từ Mongo — ưu tiên top-level shopee_order_status / tracking / carrier.
 *  `limit` (vd: 50) = shallow fetch nhanh cho FE cache merge; bỏ limit = full dump.
 *  `orderSns` / `ids` = chỉ lấy đơn cần thiết (ship-order scoped load). */
export async function loadOrdersFromStore(opts?: {
  limit?: number;
  orderSns?: string[];
  ids?: string[];
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit =
    typeof opts?.limit === "number" && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(Math.floor(opts.limit), 5000)
      : undefined;
  const snList = Array.isArray(opts?.orderSns)
    ? [
        ...new Set(
          opts!.orderSns
            .map((s) => String(s || "").replace(/^shopee-/i, "").trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const idList = Array.isArray(opts?.ids)
    ? [...new Set(opts!.ids.map((s) => String(s || "").trim()).filter(Boolean))]
    : [];
  const filter: Record<string, unknown> = {};
  if (snList.length > 0 || idList.length > 0) {
    const or: Record<string, unknown>[] = [];
    if (snList.length > 0) {
      or.push({ orderSn: { $in: snList } });
      or.push({ "data.orderSn": { $in: snList } });
      or.push({ _id: { $in: snList.map((sn) => `shopee-${sn}`) } });
    }
    if (idList.length > 0) {
      or.push({ _id: { $in: idList } });
      or.push({ "data.id": { $in: idList } });
    }
    filter.$or = or;
  }
  let docs: any[];
  try {
    let q = OrderModel.find(filter).sort({ "data.date": -1, _id: -1 }).maxTimeMS(15_000);
    if (limit) q = q.limit(limit);
    docs = await q.lean();
  } catch (err: any) {
    // Webhook 100% có thể đẩy khối lượng ghi lớn hơn trước, khiến query có sort
    // đôi khi vượt maxTimeMS/giới hạn bộ nhớ sort. KHÔNG để cả trang Quản lý đơn
    // hàng trắng trơn — thử lại KHÔNG sort (Mongo trả theo _id insertion order),
    // sort lại phía Node cho phần dữ liệu vẫn lấy được.
    console.warn(
      "[MongoDB] loadOrdersFromStore sorted query failed, retry unsorted:",
      err?.message || err,
    );
    let q = OrderModel.find(filter).maxTimeMS(15_000);
    if (limit) q = q.limit(limit);
    docs = await q.lean();
    docs.sort((a: any, b: any) => {
      const da = String(a?.data?.date || "");
      const db = String(b?.data?.date || "");
      if (da !== db) return da < db ? 1 : -1;
      return String(b?._id || "").localeCompare(String(a?._id || ""));
    });
    if (limit) docs = docs.slice(0, limit);
  }
  const out: any[] = [];
  for (const d of docs as any[]) {
    const order = hydrateOrderFromMongoDoc(d);
    if (order) out.push(order);
  }
  return out;
}

const GHN_OPEN_SYNC_TERMINAL_EXT = ["cancelled", "delivered", "rts"];
const GHN_OPEN_SYNC_TERMINAL_SHOPEE = [
  "EXTERNAL_CANCELLED",
  "EXTERNAL_DELIVERED",
  "EXTERNAL_RTS",
];
const GHN_OPEN_SYNC_TERMINAL_GHN = [
  "cancel",
  "cancelled",
  "canceled",
  "delivered",
  "returned",
];

/**
 * Đơn ngoại sàn GHN còn mở (Đã tạo đơn / Đang lấy / Đang giao) — cron sync trạng thái.
 * Bỏ đơn đã hủy, giao thành công, RTS/trả hàng. Limit bắt buộc, không full-scan.
 */
export async function findOpenGhnExternalOrdersFromStore(opts?: {
  limit?: number;
  lookbackDays?: number;
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit = Math.min(Math.max(1, Math.floor(Number(opts?.limit) || 25)), 40);
  const lookbackDays = Math.min(
    Math.max(7, Math.floor(Number(opts?.lookbackDays) || 90)),
    180,
  );
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const filter: Record<string, unknown> = {
    $and: [
      { $or: [{ channel: "manual" }, { "data.channel": "manual" }] },
      {
        $or: [
          { "data.provider": { $regex: /^ghn$/i } },
          { "data.carrier": { $regex: /^ghn$/i } },
        ],
      },
      {
        $or: [
          { tracking_no: { $exists: true, $nin: [null, "", "0"] } },
          { trackingNumber: { $exists: true, $nin: [null, "", "0"] } },
          { "data.tracking_no": { $exists: true, $nin: [null, "", "0"] } },
          { "data.trackingNumber": { $exists: true, $nin: [null, "", "0"] } },
        ],
      },
      {
        $nor: [
          { "data.external_status": { $in: GHN_OPEN_SYNC_TERMINAL_EXT } },
          { "data.ghn_status": { $in: GHN_OPEN_SYNC_TERMINAL_GHN } },
          { shopee_order_status: { $in: GHN_OPEN_SYNC_TERMINAL_SHOPEE } },
          { "data.shopee_order_status": { $in: GHN_OPEN_SYNC_TERMINAL_SHOPEE } },
        ],
      },
      {
        $or: [
          { create_time: { $gte: cutoff } },
          { "data.date": { $gte: cutoffIso } },
          { "data.create_time": { $gte: cutoffIso } },
          { create_time: { $exists: false } },
          { create_time: null },
        ],
      },
    ],
  };

  try {
    const docs = await OrderModel.find(filter)
      .sort({ "data.ghn_synced_at": 1, create_time: 1, _id: 1 })
      .limit(limit)
      .maxTimeMS(8_000)
      .lean();
    const out: any[] = [];
    for (let i = 0; i < docs.length; i += 1) {
      const order = hydrateOrderFromMongoDoc(docs[i]);
      if (!order) continue;
      const tn = String(order.tracking_no || order.trackingNumber || "").trim();
      if (!tn || tn === "0" || /^0FG/i.test(tn)) continue;
      const provider = String(order.provider || order.carrier || "").toLowerCase();
      if (provider !== "ghn") continue;
      const ext = String(order.external_status || "").toLowerCase();
      const ghn = String(order.ghn_status || "").toLowerCase();
      const raw = String(order.shopee_order_status || "").toUpperCase();
      if (GHN_OPEN_SYNC_TERMINAL_EXT.includes(ext)) continue;
      if (GHN_OPEN_SYNC_TERMINAL_GHN.includes(ghn)) continue;
      if (GHN_OPEN_SYNC_TERMINAL_SHOPEE.includes(raw)) continue;
      out.push(order);
    }
    return out.slice(0, limit);
  } catch (err: any) {
    console.warn(
      "[MongoDB] findOpenGhnExternalOrdersFromStore failed:",
      err?.message || err,
    );
    return [];
  }
}

/**
 * Candidate cho scheduler bù mã vận đơn — filter Mongo + limit, không full-scan collection.
 * Cooldown (`data.tracking_enrich_cooldown_until`) loại đơn vừa CLEAR / reverse_logistics / thiếu mã.
 */
export async function loadShopeeTrackingEnrichCandidatesFromStore(opts: {
  lookbackMs: number;
  limit: number;
  localStatuses: string[];
  shopeeStatuses: string[];
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit = Math.min(Math.max(1, Math.floor(Number(opts.limit) || 40)), 200);
  const lookbackMs = Math.max(60_000, Number(opts.lookbackMs) || 14 * 24 * 60 * 60 * 1000);
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();
  const nowIso = new Date().toISOString();
  const localStatuses = (opts.localStatuses || []).map((s) => String(s)).filter(Boolean);
  const shopeeStatuses = (opts.shopeeStatuses || []).map((s) => String(s).toUpperCase()).filter(Boolean);

  const trackingEmpty = {
    $or: [
      { tracking_no: null },
      { tracking_no: "" },
      { tracking_no: { $exists: false } },
      { tracking_no: { $regex: /^0FG/i } },
      { "data.tracking_no": null },
      { "data.tracking_no": "" },
      { "data.trackingNumber": null },
      { "data.trackingNumber": "" },
    ],
  };
  const returnMissing = {
    $and: [
      {
        $or: [
          { "data.return_sn": { $exists: true, $nin: [null, ""] } },
          { return_sn: { $exists: true, $nin: [null, ""] } },
          { shopee_order_status: { $in: ["TO_RETURN", "IN_CANCEL", "CANCELLED"] } },
          { status: { $in: ["return_pending", "return_received", "cancelled"] } },
        ],
      },
      {
        $or: [
          { return_tracking_no: { $exists: false } },
          { return_tracking_no: null },
          { return_tracking_no: "" },
          { "data.return_tracking_no": { $exists: false } },
          { "data.return_tracking_no": null },
          { "data.return_tracking_no": "" },
          {
            $expr: {
              $let: {
                vars: {
                  rtn: {
                    $toUpper: {
                      $ifNull: [
                        "$return_tracking_no",
                        { $ifNull: ["$data.return_tracking_no", ""] },
                      ],
                    },
                  },
                  out: {
                    $toUpper: {
                      $ifNull: ["$tracking_no", { $ifNull: ["$data.tracking_no", ""] }],
                    },
                  },
                },
                in: {
                  $and: [
                    { $gt: [{ $strLenCP: "$$rtn" }, 0] },
                    { $gt: [{ $strLenCP: "$$out" }, 0] },
                    { $eq: ["$$rtn", "$$out"] },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
  };
  const statusMatch = {
    $or: [
      ...(localStatuses.length ? [{ status: { $in: localStatuses } }] : []),
      ...(shopeeStatuses.length ? [{ shopee_order_status: { $in: shopeeStatuses } }] : []),
      { "data.return_sn": { $exists: true, $nin: [null, ""] } },
    ],
  };
  const cooldownOk = {
    $or: [
      { "data.tracking_enrich_cooldown_until": { $exists: false } },
      { "data.tracking_enrich_cooldown_until": null },
      { "data.tracking_enrich_cooldown_until": "" },
      { "data.tracking_enrich_cooldown_until": { $lte: nowIso } },
    ],
  };

  const filter: Record<string, unknown> = {
    $and: [
      {
        $or: [
          { "data.channel": "shopee" },
          { "data.channel": { $exists: false } },
          { "data.channel": null },
          { "data.channel": "" },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: cutoffIso } },
          { last_synced_at: { $gte: new Date(Date.now() - lookbackMs) } },
        ],
      },
      statusMatch,
      cooldownOk,
      { $or: [{ $and: [trackingEmpty, statusMatch] }, returnMissing] },
    ],
  };

  let docs: any[];
  try {
    docs = await OrderModel.find(filter)
      .select({ _id: 1 })
      .sort({ "data.date": -1, _id: -1 })
      .limit(limit)
      .maxTimeMS(8_000)
      .lean();
  } catch (err: any) {
    console.warn(
      "[MongoDB] loadShopeeTrackingEnrichCandidatesFromStore failed:",
      err?.message || err,
    );
    return [];
  }
  if (!docs.length) return [];
  return loadOrdersFromStore({ ids: docs.map((d) => String(d._id)) });
}

/**
 * Job bù mã GHN — READY_TO_SHIP / PROCESSED / RETRY_SHIP có tracking_no rỗng/null.
 * AND cả root + data (tránh $or lỏng lấy nhầm đơn đã có mã).
 */
export async function loadGhnBackfillCandidatesFromStore(opts?: {
  lookbackMs?: number;
  limit?: number;
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit = Math.min(Math.max(1, Math.floor(Number(opts?.limit) || 40)), 200);
  const lookbackMs = Math.max(
    60_000,
    Number(opts?.lookbackMs) || 14 * 24 * 60 * 60 * 1000,
  );
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();
  const cutoffDate = new Date(Date.now() - lookbackMs);
  const pickupStatuses = ["READY_TO_SHIP", "PROCESSED", "RETRY_SHIP"];
  const localStatuses = ["unprocessed", "processed"];
  const trackingEmpty = {
    $and: [
      {
        $or: [
          { tracking_no: null },
          { tracking_no: "" },
          { tracking_no: { $exists: false } },
          { tracking_no: { $regex: /^0FG/i } },
        ],
      },
      {
        $or: [
          { "data.tracking_no": null },
          { "data.tracking_no": "" },
          { "data.tracking_no": { $exists: false } },
          { "data.tracking_no": { $regex: /^0FG/i } },
        ],
      },
      {
        $or: [
          { "data.trackingNumber": null },
          { "data.trackingNumber": "" },
          { "data.trackingNumber": { $exists: false } },
          { "data.trackingNumber": { $regex: /^0FG/i } },
        ],
      },
    ],
  };
  const filter: Record<string, unknown> = {
    $and: [
      {
        $or: [
          { "data.channel": "shopee" },
          { "data.channel": { $exists: false } },
          { "data.channel": null },
          { "data.channel": "" },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: cutoffIso } },
          { last_synced_at: { $gte: cutoffDate } },
        ],
      },
      {
        $or: [
          { shopee_order_status: { $in: pickupStatuses } },
          { "data.shopee_order_status": { $in: pickupStatuses } },
          { status: { $in: localStatuses } },
          { "data.status": { $in: localStatuses } },
        ],
      },
      trackingEmpty,
    ],
  };
  let docs: any[];
  try {
    docs = await OrderModel.find(filter)
      .select({ _id: 1 })
      .sort({ "data.date": -1, _id: -1 })
      .limit(limit)
      .maxTimeMS(8_000)
      .lean();
  } catch (err: any) {
    console.warn(
      "[GHN Backfill] loadGhnBackfillCandidatesFromStore failed:",
      err?.message || err,
    );
    return [];
  }
  if (!docs.length) return [];
  return loadOrdersFromStore({ ids: docs.map((d) => String(d._id)) });
}

/**
 * Quét đơn Hủy/Hoàn thiếu mã vận đơn (tracking_no + return_tracking_no đều rỗng).
 * Dùng cho heal 1 lần — KHÔNG lọc cooldown (ép fetch lại data cũ bị ghi null).
 */
export async function loadCancelReturnMissingTrackingFromStore(opts?: {
  lookbackMs?: number;
  limit?: number;
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const limit = Math.min(Math.max(1, Math.floor(Number(opts?.limit) || 200)), 500);
  const lookbackMs = Math.max(
    24 * 60 * 60 * 1000,
    Number(opts?.lookbackMs) || 60 * 24 * 60 * 60 * 1000,
  );
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();

  const trackingEmpty = {
    $and: [
      {
        $or: [
          { tracking_no: null },
          { tracking_no: "" },
          { tracking_no: { $exists: false } },
          { tracking_no: { $regex: /^0FG/i } },
        ],
      },
      {
        $or: [
          { "data.tracking_no": null },
          { "data.tracking_no": "" },
          { "data.tracking_no": { $exists: false } },
          { "data.trackingNumber": null },
          { "data.trackingNumber": "" },
          { "data.trackingNumber": { $exists: false } },
        ],
      },
    ],
  };
  const returnEmpty = {
    $or: [
      { "data.return_tracking_no": { $exists: false } },
      { "data.return_tracking_no": null },
      { "data.return_tracking_no": "" },
    ],
  };
  const cancelReturnStatus = {
    $or: [
      { status: { $in: ["cancelled", "return_pending", "return_received"] } },
      { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
      { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
      { "data.return_sn": { $exists: true, $nin: [null, ""] } },
      {
        "data.shopee_cancel_return_kind": {
          $in: ["cancelled", "refund_return", "failed_delivery"],
        },
      },
    ],
  };

  const filter: Record<string, unknown> = {
    $and: [
      {
        $or: [
          { "data.channel": "shopee" },
          { "data.channel": { $exists: false } },
          { "data.channel": null },
          { "data.channel": "" },
        ],
      },
      {
        $or: [
          { "data.date": { $gte: cutoffIso } },
          { last_synced_at: { $gte: new Date(Date.now() - lookbackMs) } },
        ],
      },
      cancelReturnStatus,
      trackingEmpty,
      returnEmpty,
    ],
  };

  let docs: any[];
  try {
    docs = await OrderModel.find(filter)
      .select({ _id: 1 })
      .sort({ "data.date": -1, _id: -1 })
      .limit(limit)
      .maxTimeMS(12_000)
      .lean();
  } catch (err: any) {
    console.warn(
      "[MongoDB] loadCancelReturnMissingTrackingFromStore failed:",
      err?.message || err,
    );
    return [];
  }
  if (!docs.length) return [];
  console.log(
    `[MongoDB] heal-tracking-cancelled candidates=${docs.length} lookbackDays=${Math.round(lookbackMs / 86400000)}`,
  );
  return loadOrdersFromStore({ ids: docs.map((d) => String(d._id)) });
}

function emptyReturnTrackingClause(): Record<string, unknown> {
  return {
    $and: [
      {
        $or: [
          { return_tracking_no: { $exists: false } },
          { return_tracking_no: null },
          { return_tracking_no: "" },
        ],
      },
      {
        $or: [
          { "data.return_tracking_no": { $exists: false } },
          { "data.return_tracking_no": null },
          { "data.return_tracking_no": "" },
        ],
      },
    ],
  };
}

function hasReturnSnClause(): Record<string, unknown> {
  return {
    $or: [
      { return_sn: { $exists: true, $nin: [null, ""] } },
      { "data.return_sn": { $exists: true, $nin: [null, ""] } },
    ],
  };
}

function returnTrackingLookbackClause(lookbackMs: number): Record<string, unknown> {
  const cutoffIso = new Date(Date.now() - lookbackMs).toISOString();
  const cutoffDate = new Date(Date.now() - lookbackMs);
  const cutoffUnix = Math.floor((Date.now() - lookbackMs) / 1000);
  return {
    $or: [
      { "data.date": { $gte: cutoffIso } },
      { "data.date": { $gte: cutoffDate } },
      { last_synced_at: { $gte: cutoffDate } },
      { createdAt: { $gte: cutoffDate } },
      { updatedAt: { $gte: cutoffDate } },
      { return_create_time: { $gte: cutoffUnix } },
      { return_update_time: { $gte: cutoffUnix } },
      { "data.return_create_time": { $gte: cutoffUnix } },
      { "data.return_update_time": { $gte: cutoffUnix } },
    ],
  };
}

/**
 * P1: đơn đã có return_sn nhưng mã hoàn trống.
 * Query nhẹ, CẤM $expr/$toUpper (COLLSCAN CPU 100%). Hard .limit(30).
 */
export async function loadReturnTrackingPendingFromStore(opts?: {
  lookbackMs?: number;
  limit?: number;
  shopId?: string;
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const HARD_LIMIT = 30;
  const limit = Math.min(HARD_LIMIT, Math.max(1, Math.floor(Number(opts?.limit) || HARD_LIMIT)));
  const lookbackMs = Math.min(
    30 * 24 * 60 * 60 * 1000,
    Math.max(24 * 60 * 60 * 1000, Number(opts?.lookbackMs) || 30 * 24 * 60 * 60 * 1000),
  );
  const shopKey = String(opts?.shopId || "").trim();

  const filter: Record<string, unknown> = {
    $and: [
      hasReturnSnClause(),
      emptyReturnTrackingClause(),
      returnTrackingLookbackClause(lookbackMs),
      ...(shopKey
        ? [
            {
              $or: [
                { shopId: { $in: shopIdTypeVariants(shopKey) } },
                { "data.shopId": { $in: shopIdTypeVariants(shopKey) } },
              ],
            },
          ]
        : []),
    ],
  };

  let docs: any[];
  try {
    docs = await OrderModel.find(filter)
      .select({ _id: 1 })
      .sort({ last_synced_at: -1, _id: -1 })
      .limit(limit)
      .maxTimeMS(5_000)
      .lean();
  } catch (err: any) {
    console.warn(
      "[MongoDB] loadReturnTrackingPendingFromStore failed:",
      err?.message || err,
    );
    return [];
  }
  if (!docs.length) return [];
  console.log(
    `[MongoDB] return-tracking-pending shop=${shopKey || "*"} candidates=${docs.length} lookbackDays=${Math.round(lookbackMs / 86400000)} cap=${limit}`,
  );
  return loadOrdersFromStore({
    ids: docs.map((d) => String(d._id)).slice(0, HARD_LIMIT),
    limit: HARD_LIMIT,
  });
}

/**
 * Backfill 30 ngày: Hàng Hoàn / RTS thiếu return_tracking_no.
 * Hard limit + không $expr (tránh COLLSCAN CPU).
 */
export async function loadMissingReturnTrackingBackfillFromStore(opts?: {
  lookbackMs?: number;
  limit?: number;
  shopId?: string;
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const HARD_LIMIT = 80;
  const limit = Math.min(HARD_LIMIT, Math.max(1, Math.floor(Number(opts?.limit) || HARD_LIMIT)));
  const lookbackMs = Math.min(
    30 * 24 * 60 * 60 * 1000,
    Math.max(24 * 60 * 60 * 1000, Number(opts?.lookbackMs) || 30 * 24 * 60 * 60 * 1000),
  );
  const shopKey = String(opts?.shopId || "").trim();

  const filter: Record<string, unknown> = {
    $and: [
      hasReturnSnClause(),
      emptyReturnTrackingClause(),
      returnTrackingLookbackClause(lookbackMs),
      ...(shopKey
        ? [
            {
              $or: [
                { shopId: { $in: shopIdTypeVariants(shopKey) } },
                { "data.shopId": { $in: shopIdTypeVariants(shopKey) } },
              ],
            },
          ]
        : []),
    ],
  };

  let docs: any[];
  try {
    docs = await OrderModel.find(filter)
      .select({ _id: 1 })
      .sort({ last_synced_at: -1, _id: -1 })
      .limit(limit)
      .maxTimeMS(8_000)
      .lean();
  } catch (err: any) {
    console.warn(
      "[MongoDB] loadMissingReturnTrackingBackfillFromStore failed:",
      err?.message || err,
    );
    return [];
  }
  if (!docs.length) return [];
  console.log(
    `[MongoDB] return-tracking-backfill shop=${shopKey || "*"} candidates=${docs.length} cap=${limit}`,
  );
  return loadOrdersFromStore({
    ids: docs.map((d) => String(d._id)).slice(0, HARD_LIMIT),
    limit: HARD_LIMIT,
  });
}

export type OrdersPageQuery = {
  page?: number;
  pageSize?: number;
  tab?: string;
  shopId?: string;
  /** Nhiều shop — filter `$in` (ưu tiên hơn shopId đơn khi length > 1). */
  shopIds?: string[];
  carrier?: string;
  query?: string;
  /** `printed` | `unprinted` — lọc theo cờ isPrinted trong Mongo (không gọi Shopee). */
  printStatus?: string;
  /** Bỏ countDocuments phụ (badge) — bắt buộc khi load priority tabs trên cPanel. */
  skipCounts?: boolean;
  /** Sub-tab Hủy/Hoàn: refund_return | cancelled | failed_delivery */
  kind?: string;
  /** Lọc theo thời gian tạo đơn (ISO / YYYY-MM-DD). */
  startDate?: string;
  endDate?: string;
};

const DEFAULT_ORDER_DATE_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const RETURN_TAB_DATE_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ORDER_DATE_SPAN_MS = 3 * 365 * 24 * 60 * 60 * 1000;

function parseDateBound(raw: unknown, endOfDay: boolean): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse startDate/endDate. forceDefault=true → fallback 30 ngày gần nhất. */
export function parseOrderListDateRange(opts?: {
  startDate?: string | Date | null;
  endDate?: string | Date | null;
  forceDefault?: boolean;
  lookbackMs?: number;
}): { start: Date; end: Date } | null {
  let start = parseDateBound(opts?.startDate, false);
  let end = parseDateBound(opts?.endDate, true);
  if (!start && !end && !opts?.forceDefault) return null;
  if (!end) {
    end = new Date();
    end.setHours(23, 59, 59, 999);
  }
  if (!start) {
    const lookback = Math.max(
      DEFAULT_ORDER_DATE_LOOKBACK_MS,
      Number(opts?.lookbackMs) || DEFAULT_ORDER_DATE_LOOKBACK_MS,
    );
    start = new Date(end.getTime() - lookback);
    start.setHours(0, 0, 0, 0);
  }
  if (start.getTime() > end.getTime()) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  if (end.getTime() - start.getTime() > MAX_ORDER_DATE_SPAN_MS) {
    start = new Date(end.getTime() - MAX_ORDER_DATE_SPAN_MS);
    start.setHours(0, 0, 0, 0);
  }
  return { start, end };
}

/** Mongo filter 1 trường Date có index — CẤM $or đa field / data.date ISO. */
export function buildOrderCreatedAtMongoFilter(range: {
  start: Date;
  end: Date;
}): Record<string, unknown> {
  return { last_shopee_update_at: { $gte: range.start, $lte: range.end } };
}

/** Cùng 1 trường Date với list thường — không $or last_shopee_update_at + data.date. */
export function buildCancelReturnActivityDateFilter(range: {
  start: Date;
  end: Date;
}): Record<string, unknown> {
  return buildOrderCreatedAtMongoFilter(range);
}

/** Build Mongo filter cho 1 hoặc nhiều shopId (string + number variants). */
export function buildShopIdMongoFilter(
  shopId?: string | null,
  shopIds?: string[] | null,
): Record<string, unknown> | null {
  const multi = Array.isArray(shopIds)
    ? [
        ...new Set(
          shopIds
            .map((s) => String(s || "").trim())
            .filter((s) => s && s !== "all"),
        ),
      ]
    : [];
  if (multi.length > 1) {
    // shopId luôn String + index { shopId: 1 }. CẤM $or 4 nhánh ($in str/num × shopId/data.shopId)
    // — planner COLLSCAN → treo refresh/counter khi chọn nhiều gian hàng.
    return { shopId: { $in: multi } };
  }
  const single =
    multi.length === 1
      ? multi[0]
      : shopId && String(shopId).trim() && String(shopId).trim() !== "all"
        ? String(shopId).trim()
        : "";
  if (!single) return null;
  return { shopId: single };
}

/** Terminal / thoát pool chờ lấy hàng — khớp isShopeeCancelledLike + shipping/completed. */
const ORDER_TAB_LEFT_PICKUP_RAW = [
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "COMPLETED",
  "CANCELLED",
  "IN_CANCEL",
  "TO_RETURN",
] as const;

/** Có mã VĐ thật — CẤM $nin trần (Mongo $nin khớp cả document THIẾU field). */
const ORDER_TAB_TRACKING_PRESENT: Record<string, unknown> = {
  tracking_no: { $exists: true, $nin: [null, "", "0"] },
};

/** Chưa có mã VĐ (thiếu field / null / rỗng / "0") — đơn đã thanh toán lọt tab Chưa xử lý. */
const ORDER_TAB_TRACKING_ABSENT: Record<string, unknown> = {
  $or: [{ tracking_no: { $exists: false } }, { tracking_no: { $in: [null, "", "0"] } }],
};

const ORDER_TAB_DROPOFF_PREPARED: Record<string, unknown> = {
  isPrepared: true,
};

const ORDER_TAB_NOT_HANDED_OVER: Record<string, unknown> = {
  is_handed_over: { $ne: true },
};

const ORDER_TAB_IS_HANDED_OVER: Record<string, unknown> = {
  $or: [
    { is_handed_over: true },
    { is_handed_over: { $in: [true, "true", 1, "1"] } },
    { "data.is_handed_over": true },
    { "data.is_handed_over": { $in: [true, "true", 1, "1"] } },
    { "data.isHandedOverToCarrier": true },
    { "data.isHandedOverToCarrier": { $in: [true, "true", 1, "1"] } },
    { "data.is_handed_over_to_carrier": true },
    { "data.is_handed_over_to_carrier": { $in: [true, "true", 1, "1"] } },
    { "data.is_handed_over_to_courier": true },
    { "data.is_handed_over_to_courier": { $in: [true, "true", 1, "1"] } },
    { "data.local_status": "HANDED_OVER" },
    { "data.localStatus": "HANDED_OVER" },
    { "data.internal_status": "HANDED_OVER" },
  ],
};

/** TO_SHIP (Shopee) = còn chờ lấy — READY_TO_SHIP | RETRY_SHIP | PROCESSED. */
const ORDER_TAB_TO_SHIP_RAW = ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] as const;

/** Đang giao trên Shopee — loại tuyệt đối khỏi Đã xử lý / Đã giao ĐVVC. */
const ORDER_TAB_SHIPPED_RAW = ["SHIPPED", "TO_CONFIRM_RECEIVE"] as const;

/** Trạng thái kết thúc — CẤM đếm vào tab Đang giao. */
/**
 * Đơn ĐANG GIAO: SHIPPED / TO_CONFIRM_RECEIVE (top-level, đã index).
 * Fallback status=shipping khi thiếu raw — đơn web/manual.
 */
const ORDER_TAB_IS_SHIPPED: Record<string, unknown> = {
  $and: [
    {
      $or: [
        { shopee_order_status: { $in: [...ORDER_TAB_SHIPPED_RAW] } },
        {
          status: "shipping",
          shopee_order_status: { $in: [null, ""] },
        },
      ],
    },
    { is_rts: { $ne: true } },
    { shopee_cancel_return_kind: { $ne: "failed_delivery" } },
    { status: { $nin: ["completed", "cancelled", "return_pending", "return_received"] } },
  ],
};

/**
 * Đơn còn TO_SHIP (chưa SHIPPED) — tab Đã xử lý / Đã giao ĐVVC / Chờ lấy hàng.
 * Gồm cả raw UNPAID/PENDING + đã có tracking_no (lag Seller Center).
 */
const ORDER_TAB_IS_TO_SHIP: Record<string, unknown> = {
  $and: [
    {
      $or: [
        { shopee_order_status: { $in: [...ORDER_TAB_TO_SHIP_RAW] } },
        {
          $and: [
            {
              shopee_order_status: {
                $in: ["UNPAID", "PENDING", "IN_REVIEW", "FRAUD_CHECK", "INVOICE_PENDING", null, ""],
              },
            },
            {
              $or: [
                { tracking_no: { $regex: /^(?!0FG).+$/i } },
                { trackingNumber: { $regex: /^(?!0FG).+$/i } },
                { "data.tracking_no": { $regex: /^(?!0FG).+$/i } },
                { "data.trackingNumber": { $regex: /^(?!0FG).+$/i } },
              ],
            },
          ],
        },
      ],
    },
    {
      status: {
        $nin: ["shipping", "completed", "cancelled", "return_pending", "return_received"],
      },
    },
    { channel: { $nin: ["woocommerce", "manual"] } },
  ],
};

/** Cờ bàn giao top-level — list/count (healing vẫn dùng ORDER_TAB_IS_HANDED_OVER đầy đủ). */
const ORDER_TAB_FAST_HANDED_OVER: Record<string, unknown> = {
  is_handed_over: true,
};

/**
 * SSOT Mongo filter theo tab — 3 tab vận hành LOẠI TRỪ LẪN NHAU:
 *  - processed         = TO_SHIP + is_handed_over ≠ true (+ đã xử lý)
 *  - handed_over_carrier = TO_SHIP + is_handed_over = true  (CẤM SHIPPED)
 *  - shipping          = SHIPPED (bỏ qua is_handed_over)
 */
export function orderTabFilter(tab?: string): Record<string, unknown> {
  const key = String(tab || "").trim().toLowerCase();
  switch (key) {
    case "shipping":
    case "shipped":
    case "dang-giao":
      // Chỉ SHIPPED/TO_CONFIRM_RECEIVE — loại COMPLETED/CANCELLED/TO_RETURN/RTS.
      return ORDER_TAB_IS_SHIPPED;
    case "completed":
      return { $or: [{ status: "completed" }, { shopee_order_status: "COMPLETED" }] };
    case "cancelled":
      return { $or: [{ status: "cancelled" }, { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } }] };
    case "return_pending":
    case "return-pending":
      return { status: "return_pending" };
    case "processed":
    case "da-xu-ly":
    case "processed_pickup":
      // TO_SHIP + chưa bàn giao + đã xử lý (PROCESSED / có mã VĐ / isPrepared).
      return {
        $and: [
          ORDER_TAB_IS_TO_SHIP,
          ORDER_TAB_NOT_HANDED_OVER,
          {
            $or: [
              { shopee_order_status: "PROCESSED" },
              ORDER_TAB_TRACKING_PRESENT,
              ORDER_TAB_DROPOFF_PREPARED,
              { status: "processed" },
            ],
          },
        ],
      };
    case "unprocessed":
    case "chua-xu-ly":
    case "ready_to_ship":
    case "cho-lay-hang":
      // TO_SHIP + chưa xử lý + chưa bàn giao + chưa có mã VĐ — loại SHIPPED tuyệt đối.
      // Loại đơn Woo / ngoại sàn (tab riêng) để không lẫn Shopee.
      return {
        $and: [
          ORDER_TAB_IS_TO_SHIP,
          ORDER_TAB_NOT_HANDED_OVER,
          ORDER_TAB_TRACKING_ABSENT,
          { isPrepared: { $ne: true } },
          { channel: { $nin: ["woocommerce", "manual"] } },
          {
            $or: [
              { shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP"] } },
              {
                status: "unprocessed",
                shopee_order_status: { $in: [null, ""] },
              },
            ],
          },
        ],
      };
    case "pending_confirm":
    case "pending_verification":
    case "cho-xac-nhan":
      return {
        $and: [
          {
            $or: [
              { status: { $in: ["pending_confirm", "pending_verification"] } },
              {
                shopee_order_status: {
                  $in: ["UNPAID", "PENDING", "IN_REVIEW", "FRAUD_CHECK", "INVOICE_PENDING"],
                },
              },
            ],
          },
          {
            shopee_order_status: {
              $nin: [
                "READY_TO_SHIP",
                "RETRY_SHIP",
                "PROCESSED",
                ...ORDER_TAB_LEFT_PICKUP_RAW,
              ],
            },
          },
          {
            status: {
              $nin: [
                "unprocessed",
                "processed",
                "shipping",
                "completed",
                "cancelled",
                "return_pending",
                "return_received",
              ],
            },
          },
          // Đã có mã VĐ outbound (không phải 0FG) → tuyệt đối không còn Chờ xác nhận.
          {
            $nor: [
              { tracking_no: { $regex: /^(?!0FG).+$/i } },
              { trackingNumber: { $regex: /^(?!0FG).+$/i } },
              { "data.tracking_no": { $regex: /^(?!0FG).+$/i } },
              { "data.trackingNumber": { $regex: /^(?!0FG).+$/i } },
            ],
          },
        ],
      };
    case "handed_over_carrier":
      // TO_SHIP + is_handed_over=true — CẤM lấy SHIPPED vào tab này.
      return {
        $and: [ORDER_TAB_IS_TO_SHIP, ORDER_TAB_FAST_HANDED_OVER],
      };
    case "return_requests":
    case "return-requests":
    case "yeu-cau-tra-hang":
    case "yeu_cau_tra_hang":
      return {
        $or: [
          { return_sn: { $type: "string", $nin: [""] } },
          { return_tracking_no: { $type: "string", $nin: [""] } },
          { shopee_order_status: "TO_RETURN" },
          { status: { $in: ["return_pending", "return_received"] } },
          { shopee_cancel_return_kind: "refund_return" },
          { is_return: true },
        ],
      };
    case "cancel_returns":
    case "cancel-returns":
    case "don-huy-hoan":
    case "don_huy_hoan":
    case "cancelled_returned":
    case "cancelled-returned":
    case "cancelled_returns":
    case "huy-hoan":
    case "huy_hoan":
      return {
        $or: [
          { status: { $in: ["cancelled", "return_pending", "return_received"] } },
          { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
          { shopee_cancel_return_kind: { $in: ["cancelled", "refund_return", "failed_delivery"] } },
          { sub_status: "RTS" },
          { is_rts: true },
          { is_return: true },
          { return_sn: { $type: "string", $nin: [""] } },
        ],
      };
    case "stale":
      return {
        channel: "shopee",
        shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] },
        last_synced_at: { $lt: new Date(Date.now() - 15 * 60 * 1000) },
      };
    case "web_orders":
    case "woocommerce":
      return { channel: "woocommerce" };
    case "external_orders":
    case "don-ngoai-san":
    case "manual":
    case "don_ngoai_san":
      return { channel: "manual" };
    default:
      return {};
  }
}

export type CancelReturnCounters = {
  total: number;
  returned: number;
  cancelled: number;
  rts: number;
};

export const EMPTY_CANCEL_RETURN_COUNTERS: CancelReturnCounters = {
  total: 0,
  returned: 0,
  cancelled: 0,
  rts: 0,
};

function cancelReturnRtsInner(): Record<string, unknown> {
  return {
    $or: [
      { is_rts: true },
      { sub_status: "RTS" },
      { shopee_cancel_return_kind: "failed_delivery" },
    ],
  };
}

function cancelReturnReturnedInner(): Record<string, unknown> {
  return {
    $or: [
      { is_return: true },
      { shopee_cancel_return_kind: "refund_return" },
      { return_sn: { $type: "string", $nin: [""] } },
    ],
  };
}

function cancelReturnCancelledStatusInner(): Record<string, unknown> {
  return {
    $or: [
      { status: "cancelled" },
      { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } },
      { shopee_cancel_return_kind: "cancelled" },
    ],
  };
}

/** Filter sub-tab Hủy/Hoàn: returned | cancelled | rts. Rỗng = cả nhóm. */
export function orderCancelReturnKindFilter(kind?: string | null): Record<string, unknown> {
  const base = orderTabFilter("cancel_returns");
  const k = String(kind || "").trim().toLowerCase();
  if (!k || k === "all") return base;
  const rts = cancelReturnRtsInner();
  const returned = cancelReturnReturnedInner();
  if (k === "refund_return" || k === "returned" || k === "return") {
    return { $and: [base, returned] };
  }
  if (k === "failed_delivery" || k === "rts") {
    return { $and: [base, rts] };
  }
  if (k === "cancelled" || k === "cancel") {
    return {
      $and: [base, cancelReturnCancelledStatusInner(), { $nor: [returned, rts] }],
    };
  }
  return base;
}

export function parseCancelReturnKindParam(raw?: string | null): string {
  const k = String(raw || "").trim().toLowerCase();
  if (k === "refund_return" || k === "returned" || k === "return") return "refund_return";
  if (k === "failed_delivery" || k === "rts") return "failed_delivery";
  if (k === "cancelled" || k === "cancel") return "cancelled";
  return "";
}

const TAB_COUNT_CACHE_MS = 15_000;
let tabCountCache: { key: string; expiresAt: number; value: Record<string, number> } | null =
  null;

/** Xóa cache badge ngay khi có đơn mới — tránh detector đọc số cũ 15s. */
export function invalidateTabCountCache(): void {
  tabCountCache = null;
}
const dhhCountCache: { key: string; n: number } = { key: "", n: 0 };

function tabCountCacheKey(opts?: {
  shopId?: string;
  shopIds?: string[];
  startDate?: string;
  endDate?: string;
}): string {
  const ids = Array.isArray(opts?.shopIds) ? opts.shopIds.map(String).join(",") : "";
  return `${ids}|${opts?.shopId || ""}|${opts?.startDate || ""}|${opts?.endDate || ""}`;
}

function facetN(row: Record<string, unknown> | undefined, key: string): number {
  const arr = row?.[key];
  if (!Array.isArray(arr) || !arr[0] || typeof arr[0] !== "object") return 0;
  return Number((arr[0] as { n?: number }).n) || 0;
}

function buildCounterMatch(opts?: {
  shopId?: string;
  shopIds?: string[];
  startDate?: string;
  endDate?: string;
}): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [];
  const shopFilter = buildShopIdMongoFilter(opts?.shopId, opts?.shopIds);
  if (shopFilter) parts.push(shopFilter);
  const dateRange = parseOrderListDateRange({
    startDate: opts?.startDate,
    endDate: opts?.endDate,
    forceDefault: true,
  });
  if (dateRange) parts.push(buildOrderCreatedAtMongoFilter(dateRange));
  if (parts.length === 0) return {};
  if (parts.length === 1) return parts[0];
  return { $and: parts };
}

function shopTimeIndexHint(hasShop: boolean): Record<string, 1 | -1> {
  return hasShop
    ? { shopId: 1, last_shopee_update_at: -1 }
    : { last_shopee_update_at: -1 };
}

const FACET_TO_SHIP = ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"];
const FACET_SHIPPED = ["SHIPPED", "TO_CONFIRM_RECEIVE"];
const FACET_PENDING = ["UNPAID", "PENDING", "IN_REVIEW", "FRAUD_CHECK", "INVOICE_PENDING"];
const FACET_CANCEL = ["CANCELLED", "IN_CANCEL", "TO_RETURN"];

/**
 * 3 tab kho gộp cho "Những sản phẩm có trong đơn":
 * Chờ xác nhận + Đơn chưa xử lý + Chờ lấy hàng (Đã xử lý).
 * $in trên status / shopee_order_status (đã index) — CẤM $or data.*.
 */
const FULFILLMENT_LOCAL_STATUSES = [
  "pending_confirm",
  "pending_verification",
  "unprocessed",
  "processed",
] as const;
const FULFILLMENT_SHOPEE_STATUSES = [...FACET_PENDING, ...FACET_TO_SHIP] as const;
const FULFILLMENT_EXCLUDE_LOCAL = [
  "cancelled",
  "return_pending",
  "return_received",
  "shipping",
  "completed",
] as const;
const FULFILLMENT_EXCLUDE_SHOPEE = [...FACET_SHIPPED, ...FACET_CANCEL, "COMPLETED"] as const;

/** $match gộp 3 tab kho — loại Hủy/Hoàn/Đang giao/Đã giao/Đã bàn giao ĐVVC. */
export function fulfillmentProductsMatch(): Record<string, unknown> {
  return {
    $and: [
      {
        $or: [
          { status: { $in: [...FULFILLMENT_LOCAL_STATUSES] } },
          { shopee_order_status: { $in: [...FULFILLMENT_SHOPEE_STATUSES] } },
        ],
      },
      { status: { $nin: [...FULFILLMENT_EXCLUDE_LOCAL] } },
      { shopee_order_status: { $nin: [...FULFILLMENT_EXCLUDE_SHOPEE] } },
      { is_handed_over: { $ne: true } },
      { is_rts: { $ne: true } },
    ],
  };
}

/** $project vài field top-level — $facet không copy blob `data`. */
function buildTabFlagProjectStage(): Record<string, unknown> {
  return {
    $project: {
      _id: 0,
      s: "$shopee_order_status",
      st: "$status",
      ho: "$is_handed_over",
      ch: "$channel",
      kind: "$shopee_cancel_return_kind",
      rts: "$is_rts",
      ret: "$is_return",
    },
  };
}

function facetStatusIn(values: string[]): Record<string, unknown>[] {
  return [{ $match: { s: { $in: values } } }, { $count: "n" }];
}

function facetEq(field: string, value: unknown): Record<string, unknown>[] {
  return [{ $match: { [field]: value } }, { $count: "n" }];
}

/** Điều kiện tab SAU $match shop+time — equality/in trên field đã index, không $or data.*. */
function tabIndexFilter(tab?: string, kind?: string): Record<string, unknown> {
  const key = String(tab || "").trim().toLowerCase();
  const k = String(kind || "").trim().toLowerCase();
  switch (key) {
    case "shipping":
    case "shipped":
    case "dang-giao":
      return { shopee_order_status: { $in: [...FACET_SHIPPED] } };
    case "unprocessed":
    case "chua-xu-ly":
    case "ready_to_ship":
    case "cho-lay-hang":
      return {
        shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP"] },
        is_handed_over: { $ne: true },
        isPrepared: { $ne: true },
        channel: { $nin: ["woocommerce", "manual"] },
        $or: [{ tracking_no: { $exists: false } }, { tracking_no: { $in: [null, "", "0"] } }],
      };
    case "processed":
    case "da-xu-ly":
    case "processed_pickup":
      // Khớp orderTabFilter: PROCESSED / có mã VĐ / isPrepared / status processed.
      // CẤM chỉ match PROCESSED — đơn vừa xác nhận thường còn READY_TO_SHIP + tracking.
      return {
        shopee_order_status: { $in: [...FACET_TO_SHIP] },
        is_handed_over: { $ne: true },
        $or: [
          { shopee_order_status: "PROCESSED" },
          { tracking_no: { $exists: true, $nin: [null, "", "0"] } },
          { isPrepared: true },
          { status: "processed" },
        ],
      };
    case "handed_over_carrier":
      return {
        shopee_order_status: { $in: [...FACET_TO_SHIP] },
        is_handed_over: true,
      };
    case "pending_confirm":
    case "pending_verification":
    case "cho-xac-nhan":
      return { shopee_order_status: { $in: [...FACET_PENDING] } };
    case "order_products":
    case "products-summary":
    case "fulfillment_products":
      return fulfillmentProductsMatch();
    case "web_orders":
    case "woocommerce":
      return { channel: "woocommerce" };
    case "external_orders":
    case "don-ngoai-san":
    case "manual":
    case "don_ngoai_san":
      return { channel: "manual" };
    case "return_pending":
    case "return-pending":
      return { status: "return_pending" };
    case "return_requests":
    case "return-requests":
    case "yeu-cau-tra-hang":
    case "yeu_cau_tra_hang":
      return { shopee_order_status: "TO_RETURN" };
    case "cancel_returns":
    case "cancel-returns":
    case "don-huy-hoan":
    case "cancelled_returned":
    case "huy-hoan":
      if (k === "refund_return" || k === "returned") {
        return { shopee_cancel_return_kind: "refund_return" };
      }
      if (k === "cancelled" || k === "cancel") {
        return { shopee_cancel_return_kind: "cancelled" };
      }
      if (k === "failed_delivery" || k === "rts") {
        return { shopee_cancel_return_kind: "failed_delivery" };
      }
      return { shopee_order_status: { $in: [...FACET_CANCEL] } };
    default:
      return {};
  }
}

/** Field list/UI + In Đơn + Bulk Confirm — CẤM `data: 1` (blob Shopee đầy đủ). */
const ORDER_LIST_UI_PROJECTION: Record<string, 1> = {
  _id: 1,
  orderSn: 1,
  order_sn: 1,
  status: 1,
  shopee_order_status: 1,
  shopId: 1,
  shop_id: 1,
  shopName: 1,
  shop_name: 1,
  tracking_no: 1,
  trackingNumber: 1,
  return_tracking_no: 1,
  returnTrackingNumber: 1,
  return_sn: 1,
  is_return: 1,
  shipping_carrier: 1,
  checkout_shipping_carrier: 1,
  packageNumber: 1,
  package_number: 1,
  internalTrackingCode: 1,
  is_handed_over: 1,
  isPrinted: 1,
  printedAt: 1,
  printed_at: 1,
  hasPdf: 1,
  readyToPrint: 1,
  isPrepared: 1,
  barcode: 1,
  scan_code: 1,
  note: 1,
  waybill_url: 1,
  labelUrl: 1,
  pdfUrl: 1,
  pdfFilename: 1,
  channel: 1,
  fulfillment_type: 1,
  ship_method: 1,
  pickup_info: 1,
  logistics_channel_id: 1,
  shipping_type: 1,
  customerName: 1,
  customerPhone: 1,
  customerAddress: 1,
  customerEmail: 1,
  billing: 1,
  shipping: 1,
  "data.carrier": 1,
  "data.provider": 1,
  "data.external_status": 1,
  "data.ghnShopId": 1,
  "data.ghn_status": 1,
  "data.ghn_synced_at": 1,
  "data.cod_amount": 1,
  "data.shippingAddress": 1,
  shopee_cancel_return_kind: 1,
  is_rts: 1,
  sub_status: 1,
  last_shopee_update_at: 1,
  last_synced_at: 1,
  create_time: 1,
  "data.id": 1,
  "data.status": 1,
  "data.orderSn": 1,
  "data.order_sn": 1,
  "data.channel": 1,
  "data.shopId": 1,
  "data.shop_id": 1,
  "data.shopName": 1,
  "data.shop_name": 1,
  "data.items": 1,
  "data.item_list": 1,
  "data.date": 1,
  "data.totalAmount": 1,
  "data.recipient_address": 1,
  "data.buyer_username": 1,
  "data.barcode": 1,
  "data.note": 1,
  "data.scan_code": 1,
  "data.package_list": 1,
  "data.package_number": 1,
  "data.packageNumber": 1,
  "data.tracking_no": 1,
  "data.trackingNumber": 1,
  "data.shopee_tracking_number": 1,
  "data.internalTrackingCode": 1,
  "data.labelUrl": 1,
  "data.pdfUrl": 1,
  "data.pdfFilename": 1,
  "data.waybill_url": 1,
  "data.hasPdf": 1,
  "data.readyToPrint": 1,
  "data.isPrinted": 1,
  "data.printedAt": 1,
  "data.printed_at": 1,
  "data.isPrepared": 1,
  "data.is_handed_over": 1,
  "data.isHandedOverToCarrier": 1,
  "data.is_handed_over_to_carrier": 1,
  "data.is_handed_over_to_courier": 1,
  "data.shopee_order_status": 1,
  "data.create_time": 1,
  "data.createTime": 1,
  "data.escrowAmount": 1,
  "data.shipping_carrier": 1,
  "data.checkout_shipping_carrier": 1,
  "data.fulfillment_type": 1,
  "data.ship_method": 1,
  "data.pickup_info": 1,
  "data.pickup": 1,
  "data.logistics_channel_id": 1,
  "data.shipping_type": 1,
};

function facetAnd(match: Record<string, unknown>): Record<string, unknown>[] {
  return [{ $match: match }, { $count: "n" }];
}

function peekCachedTabTotal(
  opts: { shopId?: string; shopIds?: string[]; startDate?: string; endDate?: string } | undefined,
  tab: string,
  kind: string,
): number {
  if (!tabCountCache || tabCountCache.expiresAt <= Date.now()) return 0;
  if (tabCountCache.key !== tabCountCacheKey(opts)) return 0;
  const c = tabCountCache.value;
  const t = String(tab || "").trim().toLowerCase();
  if (!t || t === "all") return Number(c.all) || 0;
  if (
    t === "cancel_returns" ||
    t === "cancel-returns" ||
    t === "cancelled_returned" ||
    t === "huy-hoan" ||
    t === "don-huy-hoan"
  ) {
    if (kind === "refund_return") return Number(c.cancel_returns_returned) || 0;
    if (kind === "cancelled") return Number(c.cancel_returns_cancelled) || 0;
    if (kind === "failed_delivery") return Number(c.cancel_returns_rts) || 0;
    return Number(c.cancel_returns) || 0;
  }
  return Number(c[t]) || 0;
}

/** Đếm global 4 nhóm Hủy/Hoàn — lấy từ aggregation $facet chung. */
export async function countCancelReturnCountersFromStore(opts?: {
  shopId?: string;
  shopIds?: string[];
  startDate?: string;
  endDate?: string;
}): Promise<CancelReturnCounters> {
  const counts = await countOrdersByTabsFromStore(opts);
  return {
    total: Number(counts.cancel_returns) || 0,
    returned: Number(counts.cancel_returns_returned) || 0,
    cancelled: Number(counts.cancel_returns_cancelled) || 0,
    rts: Number(counts.cancel_returns_rts) || 0,
  };
}

/**
 * Tái phân loại Hủy / RTS / Return 30 ngày — batch + sleep, không while(true).
 */
export async function reclassifyCancelReturnsInStore(opts?: {
  lookbackMs?: number;
  limit?: number;
}): Promise<{ scanned: number; updated: number; pages: number }> {
  const empty = { scanned: 0, updated: 0, pages: 0 };
  try {
    requireMongo();
    const lookbackMs = Math.max(
      24 * 60 * 60 * 1000,
      Math.min(30 * 24 * 60 * 60 * 1000, Number(opts?.lookbackMs) || 30 * 24 * 60 * 60 * 1000),
    );
    const hardLimit = Math.max(1, Math.min(4000, Math.floor(Number(opts?.limit) || 2000)));
    const pageSize = 50;
    const maxPages = Math.ceil(hardLimit / pageSize);
    const since = new Date(Date.now() - lookbackMs);
    const sinceIso = since.toISOString();
    const filter = {
      $and: [
        orderTabFilter("cancel_returns"),
        {
          $or: [
            { "data.date": { $gte: sinceIso } },
            { last_synced_at: { $gte: since } },
            { last_shopee_update_at: { $gte: since } },
          ],
        },
      ],
    };
    let scanned = 0;
    let updated = 0;
    for (let page = 0; page < maxPages; page += 1) {
      if (scanned >= hardLimit) break;
      const docs = await OrderModel.find(filter)
        .sort({ "data.date": -1, _id: -1 })
        .skip(page * pageSize)
        .limit(pageSize)
        .maxTimeMS(8000)
        .lean();
      if (!docs.length) break;
      const ops: any[] = [];
      for (const doc of docs as any[]) {
        if (scanned >= hardLimit) break;
        scanned += 1;
        const order = hydrateOrderFromMongoDoc(doc);
        if (!order) continue;
        const kind = classifyShopeeCancelReturnKind(order);
        if (!kind) continue;
        const sub = resolveShopeeSubStatus(kind);
        const clearReturn = kind === "cancelled" && isUnshippedShopeeCancel(order);
        const prevKind = String(
          doc?.shopee_cancel_return_kind || doc?.data?.shopee_cancel_return_kind || "",
        ).trim();
        const prevReturn = String(doc?.return_sn || doc?.data?.return_sn || "").trim();
        const prevRts = doc?.is_rts === true || doc?.data?.is_rts === true;
        const needWrite =
          prevKind !== kind ||
          prevRts !== (kind === "failed_delivery") ||
          (clearReturn && Boolean(prevReturn)) ||
          Boolean(doc?.is_return) !== (kind === "refund_return");
        if (!needWrite) continue;
        const $set: Record<string, unknown> = {
          shopee_cancel_return_kind: kind,
          "data.shopee_cancel_return_kind": kind,
          is_return: kind === "refund_return",
          "data.is_return": kind === "refund_return",
          is_rts: kind === "failed_delivery",
          "data.is_rts": kind === "failed_delivery",
        };
        if (sub) {
          $set.sub_status = sub;
          $set["data.sub_status"] = sub;
        }
        const $unset: Record<string, 1> = {};
        if (kind === "cancelled") {
          $unset.is_return_received = 1;
          $unset["data.is_return_received"] = 1;
          $unset.local_return_status = 1;
          $unset["data.local_return_status"] = 1;
          $unset.warehouse_return_received = 1;
          $unset["data.warehouse_return_received"] = 1;
          $unset.isWarehouseReturnReceived = 1;
          $unset["data.isWarehouseReturnReceived"] = 1;
        }
        if (clearReturn) {
          $unset.return_sn = 1;
          $unset["data.return_sn"] = 1;
        }
        ops.push({
          updateOne: {
            filter: { _id: doc._id },
            update: {
              $set,
              ...(Object.keys($unset).length ? { $unset } : {}),
            },
          },
        });
        updated += 1;
      }
      if (ops.length) {
        await OrderModel.bulkWrite(ops, { ordered: false });
      }
      if (docs.length < pageSize) break;
      await new Promise((r) => setTimeout(r, 80));
    }
    console.log(
      `[MongoDB] reclassifyCancelReturns scanned=${scanned} updated=${updated} pages<=${maxPages}`,
    );
    return { scanned, updated, pages: maxPages };
  } catch (err: any) {
    console.error(
      "[MongoDB] reclassifyCancelReturnsInStore FATAL:",
      err?.message || err,
    );
    return empty;
  }
}

/**
 * Targeted Healing: đơn Shopee còn TO_SHIP cần dò get_order_detail.
 * - Đã quét mã (is_handed_over=true) — luồng cũ
 * - HOẶC READY_TO_SHIP / RETRY_SHIP / PROCESSED (chưa quét mã, tab Đã xử lý)
 * Loại đơn đã rời pickup (SHIPPED+) — không tốn API; clearHandedOverFlags xử lý cờ thừa.
 */
export async function loadAllHandedOverShopeeOrdersFromStore(opts?: {
  shopIds?: string[];
}): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const toShipStatuses = [...ORDER_TAB_TO_SHIP_RAW];
  const leftPickup = [...ORDER_TAB_LEFT_PICKUP_RAW];
  const and: Record<string, unknown>[] = [
    {
      $or: [
        { channel: "shopee" },
        { "data.channel": "shopee" },
      ],
    },
    {
      $or: [
        ORDER_TAB_IS_HANDED_OVER,
        { shopee_order_status: { $in: toShipStatuses } },
        { "data.shopee_order_status": { $in: toShipStatuses } },
        { status: { $in: ["processed", "unprocessed"] } },
      ],
    },
    { shopee_order_status: { $nin: leftPickup } },
    {
      $or: [
        { "data.shopee_order_status": { $exists: false } },
        { "data.shopee_order_status": { $in: [null, ""] } },
        { "data.shopee_order_status": { $nin: leftPickup } },
      ],
    },
    {
      status: {
        $nin: ["shipping", "completed", "cancelled", "return_pending", "return_received"],
      },
    },
  ];
  const shopFilter = buildShopIdMongoFilter(undefined, opts?.shopIds);
  if (shopFilter) and.push(shopFilter);

  const docs = await OrderModel.find({ $and: and })
    .sort({ "data.handedOverAt": 1, "data.date": 1, _id: 1 })
    .maxTimeMS(30_000)
    .lean();
  const orders: any[] = [];
  for (const doc of docs as any[]) {
    const order = hydrateOrderFromMongoDoc(doc);
    if (order) orders.push(order);
  }
  console.log(
    `[MongoDB] Targeted Healing candidates=${orders.length}` +
      ` (handed_over + READY_TO_SHIP/PROCESSED)` +
      `${opts?.shopIds?.length ? ` shops=${opts.shopIds.join(",")}` : ""}`,
  );
  return orders;
}

const CLEANUP_SHIPPED_QUERY_CAP = 4000;
const CLEANUP_SHIPPED_WRITE_BATCH = 100;
const ANCIENT_SHIPPED_DAYS_DEFAULT = 15;
const ANCIENT_SHIPPED_BATCH = 200;
const ANCIENT_SHIPPED_MAX_BATCHES = 25;
const ANCIENT_SHIPPED_DELAY_MS = 80;
const SHOPEE_TERMINAL_RAW = new Set([
  "COMPLETED",
  "CANCELLED",
  "IN_CANCEL",
  "TO_RETURN",
]);

export type StuckShippedOrderKey = {
  orderSn: string;
  shopId: string;
  createdAtMs?: number;
};

function parseStuckShippedCreatedAtMs(d: any): number {
  const nested = d?.data && typeof d.data === "object" ? d.data : {};
  const candidates = [
    nested.create_time,
    nested.date,
    d?.create_time,
    nested.createdAt,
    nested.created_at,
    d?.createdAt,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = candidates[i];
    if (raw == null || raw === "") continue;
    if (raw instanceof Date) {
      const t = raw.getTime();
      if (Number.isFinite(t) && t > 0) return t;
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      return raw < 1e12 ? Math.floor(raw * 1000) : Math.floor(raw);
    }
    const s = String(raw).trim();
    if (!s) continue;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) {
        return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
      }
    }
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function buildForceCompletedMongoSet(now: Date): Record<string, unknown> {
  const iso = now.toISOString();
  return {
    status: "completed",
    shopee_order_status: "COMPLETED",
    is_pending_shopee_check: false,
    last_synced_at: now,
    is_handed_over: false,
    "data.status": "completed",
    "data.shopee_order_status": "COMPLETED",
    "data.is_pending_shopee_check": false,
    "data.last_synced_at": iso,
    "data.is_handed_over": false,
    "data.isHandedOverToCarrier": false,
    "data.is_handed_over_to_carrier": false,
    "data.is_handed_over_to_courier": false,
    "data.local_status": "NONE",
    "data.localStatus": "NONE",
    "data.internal_status": "NONE",
  };
}

/** Đơn SHIPPED có create_time / data.date cũ hơn cutoff — không gọi Shopee. */
function buildAncientShippedDateFilter(cutoff: Date): Record<string, unknown> {
  const cutoffIso = cutoff.toISOString();
  const cutoffUnix = Math.floor(cutoff.getTime() / 1000);
  const cutoffMs = cutoff.getTime();
  return {
    $or: [
      { "data.date": { $lte: cutoffIso } },
      { "data.date": { $lte: cutoff } },
      { "data.create_time": { $gt: 0, $lte: cutoffUnix } },
      { "data.create_time": { $gte: 1e12, $lte: cutoffMs } },
      { create_time: { $lte: cutoff } },
      { create_time: { $gt: 0, $lte: cutoffUnix } },
      { create_time: { $gte: 1e12, $lte: cutoffMs } },
    ],
  };
}

/**
 * Ép đơn kẹt tab Đang giao cũ hơn N ngày → COMPLETED (updateMany theo lô).
 * Không gọi Shopee API. Không đụng tab khác.
 */
export async function forceCompleteAncientShippedOrdersFromStore(opts?: {
  shopIds?: string[];
  olderThanDays?: number;
}): Promise<{ matched: number; modified: number; batches: number; cutoffIso: string }> {
  const empty = { matched: 0, modified: 0, batches: 0, cutoffIso: "" };
  if (!isMongoReady()) return empty;
  requireMongo();
  const days = Math.min(
    30,
    Math.max(7, Math.floor(Number(opts?.olderThanDays) || ANCIENT_SHIPPED_DAYS_DEFAULT)),
  );
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const and: Record<string, unknown>[] = [
    orderTabFilter("shipping"),
    buildAncientShippedDateFilter(cutoff),
  ];
  const shopFilter = buildShopIdMongoFilter(undefined, opts?.shopIds);
  if (shopFilter) and.push(shopFilter);
  const filter = { $and: and };
  const $set = buildForceCompletedMongoSet(new Date());
  let matched = 0;
  let modified = 0;
  let batches = 0;
  for (let i = 0; i < ANCIENT_SHIPPED_MAX_BATCHES; i += 1) {
    const docs = await OrderModel.find(filter)
      .select({ _id: 1 })
      .limit(ANCIENT_SHIPPED_BATCH)
      .maxTimeMS(20_000)
      .lean();
    if (!Array.isArray(docs) || docs.length === 0) break;
    batches += 1;
    const ids = docs.map((d: any) => d._id).filter(Boolean);
    if (ids.length === 0) break;
    try {
      await withWriteTimeout(
        enqueueWrite(async () => {
          const result = await OrderModel.updateMany(
            { _id: { $in: ids } },
            { $set },
            { maxTimeMS: 8_000 },
          );
          matched += Number((result as any)?.matchedCount || 0);
          modified += Number((result as any)?.modifiedCount || 0);
        }),
        "cleanup_shipped_ancient",
      );
    } catch (err: any) {
      console.warn(
        "[MongoDB] forceCompleteAncientShipped batch failed:",
        err?.message || err,
      );
      break;
    }
    if (docs.length < ANCIENT_SHIPPED_BATCH) break;
    await new Promise((r) => setTimeout(r, ANCIENT_SHIPPED_DELAY_MS));
  }
  console.log(
    `[MongoDB] forceCompleteAncientShipped days=${days} cutoff=${cutoff.toISOString()}` +
      ` batches=${batches} matched=${matched} modified=${modified}` +
      `${opts?.shopIds?.length ? ` shops=${opts.shopIds.join(",")}` : ""}`,
  );
  return { matched, modified, batches, cutoffIso: cutoff.toISOString() };
}

/** Lean keys của tab Đang giao — kèm create_time để tách đơn cổ / đơn mới. */
export async function loadStuckShippedOrderKeysFromStore(opts?: {
  shopIds?: string[];
  limit?: number;
}): Promise<StuckShippedOrderKey[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const cap = Math.min(
    Math.max(1, Math.floor(Number(opts?.limit) || CLEANUP_SHIPPED_QUERY_CAP)),
    CLEANUP_SHIPPED_QUERY_CAP,
  );
  const and: Record<string, unknown>[] = [orderTabFilter("shipping")];
  const shopFilter = buildShopIdMongoFilter(undefined, opts?.shopIds);
  if (shopFilter) and.push(shopFilter);
  const filter = and.length === 1 ? and[0] : { $and: and };
  const docs = await OrderModel.find(filter)
    .select({
      orderSn: 1,
      shopId: 1,
      create_time: 1,
      createdAt: 1,
      "data.shopId": 1,
      "data.orderSn": 1,
      "data.create_time": 1,
      "data.date": 1,
      "data.createdAt": 1,
    })
    .limit(cap)
    .maxTimeMS(30_000)
    .lean();
  const out: StuckShippedOrderKey[] = [];
  const seen = new Set<string>();
  for (const d of docs as any[]) {
    const orderSn = String(
      d?.orderSn || d?.data?.orderSn || String(d?._id || "").replace(/^shopee-/i, ""),
    )
      .replace(/^shopee-/i, "")
      .trim();
    if (!orderSn || seen.has(orderSn)) continue;
    seen.add(orderSn);
    out.push({
      orderSn,
      shopId: String(d?.shopId || d?.data?.shopId || "").trim(),
      createdAtMs: parseStuckShippedCreatedAtMs(d),
    });
  }
  console.log(
    `[MongoDB] stuck SHIPPED keys=${out.length} cap=${cap}` +
      `${opts?.shopIds?.length ? ` shops=${opts.shopIds.join(",")}` : ""}`,
  );
  return out;
}

function localStatusFromShopeeTerminal(raw: string): {
  status: string;
  kind?: string;
  isReturn?: boolean;
} {
  if (raw === "COMPLETED") return { status: "completed" };
  if (raw === "CANCELLED" || raw === "IN_CANCEL") {
    return { status: "cancelled", kind: "cancelled" };
  }
  return { status: "return_pending", kind: "refund_return", isReturn: true };
}

/**
 * Ghi đè status Mongo khi Shopee đã COMPLETED / CANCELLED / IN_CANCEL / TO_RETURN.
 * Chỉ $set field trạng thái — không upsert, không đụng tab khác.
 */
export async function bulkHealTerminalStatusesFromShopee(
  patches: Array<{
    orderSn: string;
    shopId?: string;
    shopee_order_status: string;
  }>,
): Promise<{ matched: number; modified: number; written: number }> {
  if (!isMongoReady()) return { matched: 0, modified: 0, written: 0 };
  requireMongo();
  const list = (Array.isArray(patches) ? patches : [])
    .map((p) => ({
      orderSn: String(p?.orderSn || "")
        .replace(/^shopee-/i, "")
        .trim(),
      shopId: String(p?.shopId || "").trim(),
      raw: String(p?.shopee_order_status || "")
        .trim()
        .toUpperCase(),
    }))
    .filter((p) => p.orderSn && SHOPEE_TERMINAL_RAW.has(p.raw));
  if (list.length === 0) return { matched: 0, modified: 0, written: 0 };

  let matched = 0;
  let modified = 0;
  let written = 0;
  const now = new Date();
  const maxBatches = Math.ceil(CLEANUP_SHIPPED_QUERY_CAP / CLEANUP_SHIPPED_WRITE_BATCH);
  for (let i = 0; i < list.length && i / CLEANUP_SHIPPED_WRITE_BATCH < maxBatches; i += CLEANUP_SHIPPED_WRITE_BATCH) {
    const chunk = list.slice(i, i + CLEANUP_SHIPPED_WRITE_BATCH);
    const ops = chunk.map((p) => {
      const mapped = localStatusFromShopeeTerminal(p.raw);
      const _id = `shopee-${p.orderSn}`;
      const $set: Record<string, unknown> = {
        orderSn: p.orderSn,
        status: mapped.status,
        shopee_order_status: p.raw,
        is_pending_shopee_check: false,
        last_synced_at: now,
        is_handed_over: false,
        "data.orderSn": p.orderSn,
        "data.order_sn": p.orderSn,
        "data.status": mapped.status,
        "data.shopee_order_status": p.raw,
        "data.is_pending_shopee_check": false,
        "data.last_synced_at": now.toISOString(),
        "data.is_handed_over": false,
        "data.isHandedOverToCarrier": false,
        "data.is_handed_over_to_carrier": false,
        "data.is_handed_over_to_courier": false,
        "data.local_status": "NONE",
        "data.localStatus": "NONE",
        "data.internal_status": "NONE",
      };
      if (mapped.kind) {
        $set.shopee_cancel_return_kind = mapped.kind;
        $set["data.shopee_cancel_return_kind"] = mapped.kind;
      }
      if (mapped.isReturn) {
        $set.is_return = true;
        $set["data.is_return"] = true;
      }
      if (p.shopId) {
        $set.shopId = p.shopId;
        $set["data.shopId"] = p.shopId;
      }
      return {
        updateOne: {
          filter: buildOrderCompoundFilter(p.orderSn, _id, p.shopId || null),
          update: { $set },
          upsert: false,
        },
      };
    });
    try {
      await withWriteTimeout(
        enqueueWrite(async () => {
          const result = await OrderModel.bulkWrite(ops as any, {
            ordered: false,
            maxTimeMS: 8_000,
          });
          matched += Number(result.matchedCount || 0);
          modified += Number(result.modifiedCount || 0);
        }),
        "cleanup_shipped_heal",
      );
      written += ops.length;
    } catch (err: any) {
      console.warn(
        "[MongoDB] bulkHealTerminalStatuses batch failed:",
        err?.message || err,
      );
    }
    if (i + CLEANUP_SHIPPED_WRITE_BATCH < list.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  console.log(
    `[MongoDB] bulkHealTerminalStatuses written=${written} matched=${matched} modified=${modified}`,
  );
  return { matched, modified, written };
}

/** Đếm lại badge/tab từ Mongo countDocuments — không có collection counters ảo. */
export async function recalculateOrderTabCountsFromStore(opts?: {
  shopId?: string;
  shopIds?: string[];
}): Promise<Record<string, number>> {
  return countOrdersByTabsFromStore(opts);
}

/**
 * Khi refresh shallow (limit), vẫn phải kéo đủ đơn thuộc các tab vận hành
 * (Chưa xử lý / Đã xử lý / Chờ xác nhận / Đã giao ĐVVC) — tránh badge=4 mà list=0
 * vì 50 đơn mới nhất toàn SHIPPED/COMPLETED.
 *
 * CẤM Promise.all đa tab: mỗi queryOrdersPageFromStore trước đây còn Promise.all
 * ~7 countDocuments → 5 tab × 7 = ~35 query song song → cagefs_enter: Unable to fork.
 */
export async function loadPriorityTabOrdersFromStore(opts?: {
  perTabLimit?: number;
  shopId?: string;
  shopIds?: string[];
}): Promise<any[]> {
  try {
    requireMongo();
    const perTab = Math.max(
      2000,
      Math.min(5000, Math.floor(Number(opts?.perTabLimit) || 2000)),
    );
    const tabs = [
      "unprocessed",
      "processed",
      "pending_confirm",
      "handed_over_carrier",
      "shipping",
    ] as const;
    const tabRowCounts: number[] = [];
    const byId = new Map<string, any>();
    for (const tab of tabs) {
      try {
        const page = await queryOrdersPageFromStore({
          page: 1,
          pageSize: perTab,
          tab,
          shopId: opts?.shopId || "",
          shopIds: opts?.shopIds,
          skipCounts: true,
        });
        const rows = page?.rows || [];
        tabRowCounts.push(rows.length);
        for (const row of rows) {
          const id = String(row?.id || row?.orderSn || "").trim();
          if (id) byId.set(id, row);
        }
      } catch (err: any) {
        tabRowCounts.push(0);
        console.warn(
          `[MongoDB] loadPriorityTabOrders tab=${tab} failed:`,
          err?.message || err,
        );
      }
      // Nhường event loop / tránh spike nproc CageFS giữa các tab.
      await new Promise((r) => setTimeout(r, 30));
    }
    const merged = [...byId.values()];
    console.log(
      `[MongoDB] loadPriorityTabOrders merged=${merged.length}` +
        ` tabs=${tabs.map((t, i) => `${t}:${tabRowCounts[i] || 0}`).join(",")}`,
    );
    return merged;
  } catch (err: any) {
    console.error(
      "[MongoDB] loadPriorityTabOrders FATAL:",
      err?.message || err,
    );
    return [];
  }
}

/** Đếm 1 filter — fail-soft (0) để 1 tab lỗi không kéo sập CageFS. */
async function safeCountDocuments(
  filter: Record<string, unknown>,
  maxTimeMS = 6000,
): Promise<number> {
  try {
    return Number(await OrderModel.countDocuments(filter).maxTimeMS(maxTimeMS)) || 0;
  } catch (err: any) {
    console.warn(
      "[MongoDB] safeCountDocuments failed:",
      err?.message || err,
    );
    return 0;
  }
}

/** Badge ≡ GET /api/orders?tab= — dùng orderTabFilter, không dùng $facet rút gọn. */
async function countOperationalTabsFromStore(
  match: Record<string, unknown>,
): Promise<Partial<Record<string, number>>> {
  const tabs = [
    "pending_confirm",
    "unprocessed",
    "processed",
    "handed_over_carrier",
    "shipping",
  ] as const;
  const out: Partial<Record<string, number>> = {};
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const tabFilter = orderTabFilter(tab);
    const combined =
      Object.keys(match).length === 0 ? tabFilter : { $and: [match, tabFilter] };
    out[tab] = await safeCountDocuments(combined);
    if (i < tabs.length - 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return out;
}

/** Đếm số đơn theo tab — MỘT aggregate: $match ngày → $project cờ → $facet. */
export async function countOrdersByTabsFromStore(opts?: {
  shopId?: string;
  shopIds?: string[];
  startDate?: string;
  endDate?: string;
}): Promise<Record<string, number>> {
  const empty: Record<string, number> = {
    all: 0,
    pending_confirm: 0,
    unprocessed: 0,
    processed: 0,
    shipping: 0,
    handed_over_carrier: 0,
    return_pending: 0,
    return_requests: 0,
    cancel_returns: 0,
    received_cancel_returns: 0,
    web_orders: 0,
    external_orders: 0,
  };
  try {
    requireMongo();
    const cacheKey = tabCountCacheKey(opts);
    const now = Date.now();
    if (tabCountCache && tabCountCache.key === cacheKey && tabCountCache.expiresAt > now) {
      return tabCountCache.value;
    }
    const match = buildCounterMatch(opts);
    const hasShop = Boolean(buildShopIdMongoFilter(opts?.shopId, opts?.shopIds));
    const pipeline = [
      { $match: match },
      buildTabFlagProjectStage(),
      {
        $facet: {
          all: [{ $count: "n" }],
          pending_confirm: facetStatusIn([...FACET_PENDING]),
          unprocessed: facetAnd({
            s: { $in: ["READY_TO_SHIP", "RETRY_SHIP"] },
            ho: { $ne: true },
          }),
          processed: facetAnd({ s: "PROCESSED", ho: { $ne: true } }),
          shipping: facetStatusIn([...FACET_SHIPPED]),
          handed_over_carrier: facetAnd({
            s: { $in: [...FACET_TO_SHIP] },
            ho: true,
          }),
          return_pending: facetEq("st", "return_pending"),
          return_requests: facetEq("s", "TO_RETURN"),
          web_orders: facetEq("ch", "woocommerce"),
          external_orders: facetEq("ch", "manual"),
          cancel_returns: facetStatusIn([...FACET_CANCEL]),
          cancel_returns_returned: facetEq("kind", "refund_return"),
          cancel_returns_cancelled: facetEq("kind", "cancelled"),
          cancel_returns_rts: facetEq("kind", "failed_delivery"),
        },
      },
    ];
    let aggRows: any[] = [];
    try {
      aggRows = await OrderModel.aggregate(pipeline as any[]).option({
        maxTimeMS: 4000,
        hint: shopTimeIndexHint(hasShop),
      });
    } catch (hintErr: any) {
      console.warn(
        "[MongoDB] countOrdersByTabsFromStore hint skipped:",
        hintErr?.message || hintErr,
      );
      aggRows = await OrderModel.aggregate(pipeline as any[]).option({ maxTimeMS: 6000 });
    }
    const row = (aggRows?.[0] || {}) as Record<string, unknown>;
    const counts: Record<string, number> = { ...empty };
    counts.all = facetN(row, "all");
    counts.pending_confirm = facetN(row, "pending_confirm");
    counts.unprocessed = facetN(row, "unprocessed");
    counts.processed = facetN(row, "processed");
    counts.shipping = facetN(row, "shipping");
    counts.handed_over_carrier = facetN(row, "handed_over_carrier");
    counts.return_pending = facetN(row, "return_pending");
    counts.return_requests = facetN(row, "return_requests");
    counts.web_orders = facetN(row, "web_orders");
    counts.external_orders = facetN(row, "external_orders");
    try {
      const shopFilter = buildShopIdMongoFilter(opts?.shopId, opts?.shopIds);
      if (shopFilter) {
        const dateRange = parseOrderListDateRange({
          startDate: opts?.startDate,
          endDate: opts?.endDate,
          forceDefault: true,
        });
        const extMatch: Record<string, unknown> = { channel: "manual" };
        if (dateRange) Object.assign(extMatch, buildOrderCreatedAtMongoFilter(dateRange));
        counts.external_orders = await OrderModel.countDocuments(extMatch).maxTimeMS(3000);
      }
    } catch (extErr: any) {
      console.warn("[MongoDB] external_orders count:", extErr?.message || extErr);
    }
    counts.cancel_returns = facetN(row, "cancel_returns");
    counts.cancel_returns_returned = facetN(row, "cancel_returns_returned");
    counts.cancel_returns_cancelled = facetN(row, "cancel_returns_cancelled");
    counts.cancel_returns_rts = facetN(row, "cancel_returns_rts");
    counts.refund_return = counts.cancel_returns_returned;
    counts.cancelled = counts.cancel_returns_cancelled;
    counts.failed_delivery = counts.cancel_returns_rts;
    counts.received_cancel_returns =
      dhhCountCache.key === cacheKey ? dhhCountCache.n : dhhCountCache.n;
    try {
      const opCounts = await countOperationalTabsFromStore(match);
      Object.assign(counts, opCounts);
    } catch (opErr: any) {
      console.warn(
        "[MongoDB] countOperationalTabsFromStore:",
        opErr?.message || opErr,
      );
    }
    tabCountCache = { key: cacheKey, expiresAt: now + TAB_COUNT_CACHE_MS, value: counts };
    const dhhShop = buildShopIdMongoFilter(opts?.shopId, opts?.shopIds) || {};
    void DonHoanHuyModel.countDocuments(dhhShop)
      .maxTimeMS(2000)
      .then((n: number) => {
        dhhCountCache.key = cacheKey;
        dhhCountCache.n = Number(n) || 0;
      })
      .catch(() => {});
    return counts;
  } catch (err: any) {
    console.error(
      "[MongoDB] countOrdersByTabsFromStore FATAL:",
      err?.message || err,
    );
    return empty;
  }
}

/** Danh sách đơn phân trang từ MongoDB; frontend không cần tải toàn bộ collection để lọc. */
export async function queryOrdersPageFromStore(opts?: OrdersPageQuery): Promise<{
  rows: any[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
  counts: Record<string, number>;
  counters: CancelReturnCounters;
}> {
  const empty = {
    rows: [] as any[],
    total: 0,
    page: 1,
    pageSize: 50,
    totalPages: 1,
    hasMore: false,
    counts: {} as Record<string, number>,
    counters: { ...EMPTY_CANCEL_RETURN_COUNTERS },
  };
  try {
    requireMongo();
    const page = Math.max(1, Math.floor(Number(opts?.page) || 1));
    // Mặc định 50/trang; cho phép tới 5000 khi caller gửi pageSize lớn (quét mã / đối soát).
    const pageSize = Math.max(
      1,
      Math.min(5000, Math.floor(Number(opts?.pageSize) || 50)),
    );
    const skipCounts = Boolean(opts?.skipCounts);
    const search = String(opts?.query || "").trim();
    const requestedTab = String(opts?.tab || "").trim().toLowerCase();
    const kind = parseCancelReturnKindParam(opts?.kind);
    const isCancelReturnsTab =
      requestedTab === "cancel_returns" ||
      requestedTab === "cancel-returns" ||
      requestedTab === "cancelled_returned" ||
      requestedTab === "huy-hoan" ||
      requestedTab === "don-huy-hoan";
    const isReturnRequestsTab =
      requestedTab === "return_requests" ||
      requestedTab === "return-requests" ||
      requestedTab === "yeu-cau-tra-hang" ||
      requestedTab === "yeu_cau_tra_hang";
    const isExternalOrdersTab =
      requestedTab === "external_orders" ||
      requestedTab === "don-ngoai-san" ||
      requestedTab === "manual" ||
      requestedTab === "don_ngoai_san";
    const shopFilter = isExternalOrdersTab
      ? null
      : buildShopIdMongoFilter(opts?.shopId, opts?.shopIds);
    const firstMatch: Record<string, unknown> = {};
    if (shopFilter) Object.assign(firstMatch, shopFilter);
    if (!search) {
      const dateRange = parseOrderListDateRange({
        startDate: opts?.startDate,
        endDate: opts?.endDate,
        forceDefault: true,
        lookbackMs:
          isCancelReturnsTab || isReturnRequestsTab
            ? RETURN_TAB_DATE_LOOKBACK_MS
            : DEFAULT_ORDER_DATE_LOOKBACK_MS,
      });
      if (dateRange) Object.assign(firstMatch, buildOrderCreatedAtMongoFilter(dateRange));
    }
    const pipeline: Record<string, unknown>[] = [];
    if (Object.keys(firstMatch).length) pipeline.push({ $match: firstMatch });
    if (!search && requestedTab && requestedTab !== "all") {
      const tabFilter = tabIndexFilter(requestedTab, kind);
      if (Object.keys(tabFilter).length) {
        pipeline.push({ $match: tabFilter });
      } else {
        console.warn(
          `[MongoDB] queryOrdersPageFromStore unknown tab=${requestedTab} — không count toàn DB`,
        );
      }
    }
    if (!search && opts?.carrier && opts.carrier !== "all") {
      pipeline.push({ $match: { shipping_carrier: String(opts.carrier) } });
    }
    const printStatus = String(opts?.printStatus || "").trim().toLowerCase();
    if (printStatus === "printed" || printStatus === "da-in" || printStatus === "true") {
      pipeline.push({ $match: { isPrinted: true } });
    } else if (
      printStatus === "unprinted" ||
      printStatus === "chua-in" ||
      printStatus === "false" ||
      printStatus === "not_printed"
    ) {
      pipeline.push({ $match: { isPrinted: { $ne: true } } });
    }
    if (search) {
      // Partial match (case-insensitive contains) — khớp chuỗi con như FE `.includes()`.
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const contains = { $regex: escaped, $options: "i" as const };
      pipeline.push({
        $match: {
          $or: [
            { orderSn: contains },
            { tracking_no: contains },
            { trackingNumber: contains },
            { return_sn: contains },
            { return_tracking_no: contains },
            { returnTrackingNumber: contains },
            { packageNumber: contains },
            { customerName: contains },
            { customerPhone: contains },
            { customerEmail: contains },
            { "data.buyer_username": contains },
            { "data.customerName": contains },
            { "data.customer_name": contains },
            { "data.items.productTitle": contains },
            { "data.items.name": contains },
            { "data.items.modelName": contains },
            { "data.items.modelSku": contains },
            { "data.internalTrackingCode": contains },
            { internalTrackingCode: contains },
          ],
        },
      });
    }
    pipeline.push(
      { $sort: { last_shopee_update_at: -1 } },
      { $skip: (page - 1) * pageSize },
      { $limit: pageSize },
      { $project: ORDER_LIST_UI_PROJECTION },
    );

    let docs: any[] = [];
    try {
      const listHint = search ? undefined : shopTimeIndexHint(Boolean(shopFilter));
      try {
        docs = await OrderModel.aggregate(pipeline as any[]).option({
          maxTimeMS: 4000,
          ...(listHint ? { hint: listHint } : {}),
        });
      } catch {
        docs = await OrderModel.aggregate(pipeline as any[]).option({ maxTimeMS: 4000 });
      }
    } catch (findErr: any) {
      console.error(
        "[MongoDB] queryOrdersPageFromStore find failed:",
        findErr?.message || findErr,
      );
      return { ...empty, page, pageSize };
    }

    const cachedTotal = peekCachedTabTotal(
      {
        shopId: opts?.shopId,
        shopIds: opts?.shopIds,
        startDate: opts?.startDate,
        endDate: opts?.endDate,
      },
      requestedTab,
      kind,
    );
    const total =
      cachedTotal > 0
        ? cachedTotal
        : (page - 1) * pageSize + docs.length + (docs.length === pageSize ? 1 : 0);
    console.log(
      `[MongoDB] queryOrdersPageFromStore tab=${requestedTab || "(none)"} rows=${docs.length} total=${total}`,
    );
    const rows = (docs as any[])
      .map((doc) => hydrateOrderFromMongoDoc(doc))
      .filter(Boolean);

    const counts: Record<string, number> = {};
    const counters = { ...EMPTY_CANCEL_RETURN_COUNTERS };
    if (!skipCounts) {
      const tabCounts = await countOrdersByTabsFromStore({
        shopId: opts?.shopId,
        shopIds: opts?.shopIds,
        startDate: opts?.startDate,
        endDate: opts?.endDate,
      });
      Object.assign(counts, tabCounts);
      counters.total = Number(tabCounts.cancel_returns) || 0;
      counters.returned = Number(tabCounts.cancel_returns_returned) || 0;
      counters.cancelled = Number(tabCounts.cancel_returns_cancelled) || 0;
      counters.rts = Number(tabCounts.cancel_returns_rts) || 0;
    }

    const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / pageSize) || 1);
    return {
      rows,
      total,
      page,
      pageSize,
      totalPages,
      hasMore: page * pageSize < total,
      counts,
      counters,
    };
  } catch (err: any) {
    console.error(
      "[MongoDB] queryOrdersPageFromStore FATAL:",
      err?.message || err,
    );
    return empty;
  }
}

export type FulfillmentAggregatedProduct = {
  groupKey: string;
  productId: string;
  modelId: string;
  baseTitle: string;
  modelName?: string;
  variationName?: string;
  variationSku: string;
  productImage?: string;
  totalQuantity: number;
};

/**
 * Tổng hợp sản phẩm từ 3 tab kho (Chờ xác nhận + Chưa xử lý + Đã xử lý).
 * $match $in trên field đã index → $unwind item → $group cộng dồn số lượng.
 */
export async function aggregateFulfillmentProductsFromStore(opts?: {
  shopId?: string;
  shopIds?: string[];
  startDate?: string;
  endDate?: string;
}): Promise<FulfillmentAggregatedProduct[]> {
  if (!isMongoReady()) return [];
  requireMongo();

  const shopFilter = buildShopIdMongoFilter(opts?.shopId, opts?.shopIds);
  const dateRange = parseOrderListDateRange({
    startDate: opts?.startDate,
    endDate: opts?.endDate,
    forceDefault: true,
    lookbackMs: DEFAULT_ORDER_DATE_LOOKBACK_MS,
  });
  const firstMatch: Record<string, unknown> = {};
  if (shopFilter) Object.assign(firstMatch, shopFilter);
  if (dateRange) Object.assign(firstMatch, buildOrderCreatedAtMongoFilter(dateRange));
  Object.assign(firstMatch, fulfillmentProductsMatch());

  const pipeline: Record<string, unknown>[] = [
    { $match: firstMatch },
    { $limit: 20000 },
    {
      $addFields: {
        _lines: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$data.items", []] } }, 0] },
            "$data.items",
            { $ifNull: ["$data.item_list", []] },
          ],
        },
      },
    },
    { $unwind: { path: "$_lines", preserveNullAndEmptyArrays: false } },
    {
      $addFields: {
        _qty: {
          $convert: {
            input: {
              $ifNull: ["$_lines.quantity", "$_lines.model_quantity_purchased"],
            },
            to: "double",
            onError: 0,
            onNull: 0,
          },
        },
        _productId: {
          $convert: {
            input: { $ifNull: ["$_lines.productId", "$_lines.item_id"] },
            to: "string",
            onError: "unknown",
            onNull: "unknown",
          },
        },
        _modelId: {
          $convert: {
            input: { $ifNull: ["$_lines.modelId", "$_lines.model_id"] },
            to: "string",
            onError: "0",
            onNull: "0",
          },
        },
        _modelName: {
          $ifNull: [
            "$_lines.modelName",
            { $ifNull: ["$_lines.model_name", "$_lines.variation_name"] },
          ],
        },
        _sku: {
          $ifNull: [
            "$_lines.modelSku",
            {
              $ifNull: [
                "$_lines.model_sku",
                { $ifNull: ["$_lines.item_sku", "$_lines.sku"] },
              ],
            },
          ],
        },
        _title: {
          $ifNull: ["$_lines.productTitle", "$_lines.item_name"],
        },
        _image: {
          $ifNull: [
            "$_lines.productImage",
            {
              $ifNull: [
                "$_lines.image_info.image_url",
                { $arrayElemAt: ["$_lines.image_info.image_url_list", 0] },
              ],
            },
          ],
        },
      },
    },
    { $match: { _qty: { $gt: 0 } } },
    {
      $group: {
        _id: {
          productId: "$_productId",
          modelId: "$_modelId",
          modelName: { $ifNull: ["$_modelName", ""] },
        },
        totalQuantity: { $sum: "$_qty" },
        baseTitle: { $first: "$_title" },
        productImage: { $first: "$_image" },
        variationSku: { $first: "$_sku" },
      },
    },
    { $sort: { totalQuantity: -1 } },
    { $limit: 2000 },
    {
      $project: {
        _id: 0,
        productId: { $ifNull: ["$_id.productId", "unknown"] },
        modelId: { $ifNull: ["$_id.modelId", "0"] },
        baseTitle: { $ifNull: ["$baseTitle", "Sản phẩm không tên"] },
        modelName: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$_id.modelName", ""] } }, 0] },
            "$_id.modelName",
            "$$REMOVE",
          ],
        },
        variationName: {
          $cond: [
            { $gt: [{ $strLenCP: { $ifNull: ["$_id.modelName", ""] } }, 0] },
            "$_id.modelName",
            "$$REMOVE",
          ],
        },
        variationSku: {
          $ifNull: [
            {
              $cond: [
                {
                  $gt: [
                    { $strLenCP: { $trim: { input: { $ifNull: ["$variationSku", ""] } } } },
                    0,
                  ],
                },
                "$variationSku",
                null,
              ],
            },
            "Không có SKU",
          ],
        },
        productImage: 1,
        totalQuantity: 1,
        groupKey: {
          $concat: [
            { $ifNull: ["$_id.productId", "unknown"] },
            "_",
            {
              $cond: [
                {
                  $and: [
                    { $ne: ["$_id.modelId", "0"] },
                    { $ne: ["$_id.modelId", ""] },
                  ],
                },
                { $ifNull: ["$_id.modelId", "0"] },
                {
                  $cond: [
                    { $gt: [{ $strLenCP: { $ifNull: ["$_id.modelName", ""] } }, 0] },
                    { $ifNull: ["$_id.modelName", "unknown"] },
                    "unknown",
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  ];

  try {
    const hint = shopTimeIndexHint(Boolean(shopFilter));
    let rows: any[] = [];
    try {
      rows = await OrderModel.aggregate(pipeline as any[]).option({
        maxTimeMS: 6000,
        hint,
      });
    } catch {
      rows = await OrderModel.aggregate(pipeline as any[]).option({ maxTimeMS: 6000 });
    }
    const out: FulfillmentAggregatedProduct[] = [];
    const n = Math.min(rows.length, 2000);
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const qty = Number(row?.totalQuantity) || 0;
      if (qty <= 0) continue;
      out.push({
        groupKey: String(row?.groupKey || `${row?.productId || "unknown"}_unknown`),
        productId: String(row?.productId || "unknown"),
        modelId: String(row?.modelId || "0"),
        baseTitle: String(row?.baseTitle || "Sản phẩm không tên"),
        modelName: row?.modelName ? String(row.modelName) : undefined,
        variationName: row?.variationName ? String(row.variationName) : undefined,
        variationSku: String(row?.variationSku || "Không có SKU"),
        productImage: row?.productImage ? String(row.productImage) : undefined,
        totalQuantity: qty,
      });
    }
    console.log(
      `[MongoDB] aggregateFulfillmentProductsFromStore rows=${out.length}` +
        ` shop=${opts?.shopId || (opts?.shopIds || []).join(",") || "(all)"}`,
    );
    return out;
  } catch (err: any) {
    console.error(
      "[MongoDB] aggregateFulfillmentProductsFromStore failed:",
      err?.message || err,
    );
    return [];
  }
}

export async function createSyncJob(
  type: string,
  requestedBy?: string,
): Promise<{ id: string; state: SyncJobDoc["state"] }> {
  requireMongo();
  const id = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await SyncJobModel.create({
    _id: id,
    type,
    state: "running",
    started_at: new Date(),
    metrics: {},
    requested_by: requestedBy || null,
  });
  return { id, state: "running" };
}

export async function finishSyncJob(
  id: string,
  state: "succeeded" | "failed",
  metrics?: Record<string, unknown>,
  error?: string,
): Promise<void> {
  if (!id || !isMongoReady()) return;
  requireMongo();
  await SyncJobModel.updateOne(
    { _id: id },
    {
      $set: {
        state,
        finished_at: new Date(),
        metrics: metrics || {},
        error: error || null,
      },
    },
  );
}

export async function getSyncJob(id: string): Promise<any | null> {
  if (!id || !isMongoReady()) return null;
  requireMongo();
  return SyncJobModel.findById(id).lean();
}

export async function loadOrderEvents(orderSn: string, limit = 50): Promise<any[]> {
  if (!orderSn || !isMongoReady()) return [];
  requireMongo();
  return OrderEventModel.find({ orderSn: String(orderSn).trim() })
    .sort({ occurred_at: -1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .lean();
}

/** Phân loại lỗi Mongo ghi DB — trả message rõ cho FE. */
export function describeMongoWriteError(err: unknown): string {
  const anyErr = err as { message?: string; code?: number | string; codeName?: string; name?: string };
  const msg = String(anyErr?.message || err || "");
  const code = String(anyErr?.code ?? anyErr?.codeName ?? "");
  const name = String(anyErr?.name || "");
  const blob = `${msg} ${name} ${code}`;
  if (
    /server selection|ServerSelectionError|timed out after|timed out|timeout|maxTimeMS|ExceededTimeLimit|MongoServerSelectionError|MongoNetworkTimeoutError|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ETIMEOUT|MongoNetworkError|topology was destroyed|connection.*closed|connection \d+ to .+ timed out|27017|mongodb_not_ready|Chưa kết nối được Database|pool destroyed/i.test(
      blob,
    )
  ) {
    return "Lỗi kết nối MongoDB (timeout tới máy chủ DB). Kiểm tra mạng/firewall/IP whitelist rồi thử lại.";
  }
  if (/quota|space|exceeded|8000|AtlasError/i.test(msg + code) || code === "8000") {
    return "Quota MongoDB chưa nhả đủ dung lượng (Atlas Over space quota). Hãy dọn order_events hoặc nâng gói.";
  }
  if (
    /not authorized|Unauthorized|authentication failed|bad auth|insufficient.*privilege/i.test(msg) ||
    code === "13" ||
    code === "18"
  ) {
    return "Sai quyền tài khoản DB — cần user ReadWrite (không dùng tài khoản chỉ đọc như dev_test).";
  }
  if (/duplicate key|E11000/i.test(msg)) {
    return "Trùng mã đơn trong don_hoan_huy (đã lưu trước đó).";
  }
  return msg || "Lỗi ghi MongoDB không xác định.";
}

export function isMongoConnectionError(err: unknown): boolean {
  const msg = describeMongoWriteError(err);
  return msg.startsWith("Lỗi kết nối MongoDB");
}

function donHoanHuyDocToOrder(doc: any): any {
  const looksLikeTracking = (code: string) =>
    /^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(String(code || "").trim());

  const base = doc?.data && typeof doc.data === "object" ? { ...doc.data } : {};
  let sn = String(doc?.orderSn || "").replace(/^shopee-/i, "").trim();
  const dataSn = String(base.orderSn || base.order_sn || "")
    .replace(/^shopee-/i, "")
    .trim();
  // Bản ghi lỗi cũ: top-level orderSn = mã VĐ — ưu tiên orderSn thật trong data.
  if (looksLikeTracking(sn) && dataSn && !looksLikeTracking(dataSn)) {
    sn = dataSn;
  }
  if (!sn && dataSn) sn = dataSn;

  const statusRaw = String(doc?.status || "").toLowerCase();
  const local =
    String(doc?.local_status || "").toUpperCase() === "RETURN_RECEIVED" ||
    statusRaw === "return_received" ||
    doc?.type === "return"
      ? "RETURN_RECEIVED"
      : "CANCELLED_STORED";
  const status =
    local === "RETURN_RECEIVED"
      ? "return_received"
      : statusRaw || "cancelled";
  const scannedAt = doc?.scannedAt
    ? new Date(doc.scannedAt).toISOString()
    : doc?.createdAt
      ? new Date(doc.createdAt).toISOString()
      : new Date().toISOString();
  const items = Array.isArray(base.items)
    ? base.items
    : Array.isArray(doc?.items)
      ? doc.items
      : [];

  const note = String(doc?.note || base.note || "").trim();
  const scanCodeRaw = String(
    doc?.scan_code || base.scan_code || (note.startsWith("scan:") ? note.slice(5) : ""),
  ).trim();
  const scanFallback =
    scanCodeRaw &&
    scanCodeRaw !== sn &&
    !isShopeeInternalTrackingCode(scanCodeRaw) &&
    isCarrierTrackingCode(scanCodeRaw)
      ? scanCodeRaw
      : "";

  const tn =
    String(
      doc?.tracking_no ||
        base.tracking_no ||
        base.trackingNumber ||
        scanFallback ||
        "",
    ).trim() || undefined;
  const rtn =
    String(
      doc?.return_tracking_no ||
        base.return_tracking_no ||
        (local === "RETURN_RECEIVED" ? scanFallback : "") ||
        "",
    ).trim() || undefined;

  return {
    ...base,
    id: base.id || (sn ? `shopee-${sn}` : undefined),
    orderSn: sn,
    shopId: doc?.shopId != null ? doc.shopId : base.shopId,
    shopName: doc?.shopName || base.shopName,
    status,
    note: doc?.note || "",
    scan_code: scanCodeRaw || undefined,
    shopee_order_status: doc?.shopee_order_status || base.shopee_order_status,
    tracking_no: tn,
    trackingNumber: tn,
    return_tracking_no: rtn,
    items,
    local_status: local,
    localStatus: local,
    internal_status: local,
    local_status_updated_at: scannedAt,
    localStatusAt: scannedAt,
    is_local_return_archived: false,
    channel: base.channel || "shopee",
    don_hoan_huy: true,
    scannedAt,
    shopee_cancel_return_kind:
      local === "RETURN_RECEIVED"
        ? "refund_return"
        : base.shopee_cancel_return_kind || "cancelled",
  };
}

/** Đọc toàn bộ tab Đã nhận hủy/hoàn từ collection don_hoan_huy. */
export async function loadDonHoanHuyAsOrders(limit = 2000): Promise<any[]> {
  if (!isMongoReady()) return [];
  requireMongo();
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit) || 2000));
  const docs = await DonHoanHuyModel.find({})
    .sort({ scannedAt: -1 })
    .limit(safeLimit)
    .maxTimeMS(5000)
    .lean();
  return (docs || [])
    .map(donHoanHuyDocToOrder)
    .filter((o) => {
      const sn = String(o?.orderSn || "").trim();
      if (!sn) return false;
      // Ẩn bản ghi giả cũ (orderSn = mã VĐ).
      if (/^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(sn)) {
        return false;
      }
      return true;
    });
}

export async function existsDonHoanHuy(orderSn: string): Promise<boolean> {
  if (!orderSn || !isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn).replace(/^shopee-/i, "").trim();
  if (!sn) return false;
  const hit = await DonHoanHuyModel.findOne({ orderSn: sn })
    .select({ _id: 1 })
    .maxTimeMS(5000)
    .lean();
  return Boolean(hit);
}

/** 1 query `$in` — tránh N lần findOne khi quét hàng loạt. */
export async function existsDonHoanHuyMany(
  orderSns: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!isMongoReady()) return out;
  requireMongo();
  const sns = [
    ...new Set(
      (Array.isArray(orderSns) ? orderSns : [])
        .map((s) => String(s || "").replace(/^shopee-/i, "").trim())
        .filter(Boolean),
    ),
  ];
  if (!sns.length) return out;
  const docs = await DonHoanHuyModel.find({ orderSn: { $in: sns } })
    .select({ orderSn: 1 })
    .maxTimeMS(5000)
    .lean();
  for (const d of docs || []) {
    const sn = String((d as any)?.orderSn || "").trim();
    if (sn) out.add(sn);
  }
  return out;
}

type DonHoanHuyUpsertPayload = {
  sn: string;
  $set: Record<string, unknown>;
  scannedAt: Date;
};

function buildDonHoanHuyUpsertPayload(
  order: any,
  opts?: {
    type?: "cancelled" | "return";
    scanCode?: string;
    source?: string;
    scannedAt?: string | Date;
  },
): { ok: true; payload: DonHoanHuyUpsertPayload } | { ok: false; orderSn: string; error: string } {
  const sn = String(order?.orderSn || order?.order_sn || "")
    .replace(/^shopee-/i, "")
    .trim();
  if (!sn) {
    return { ok: false, orderSn: "", error: "Thiếu orderSn — không ghi được don_hoan_huy." };
  }
  if (/^(SPX(VN)?|GHN|GYA|GHTK|JNT|JT|NINJA|VTP|VNPOST|BEST|LEX)/i.test(sn)) {
    return {
      ok: false,
      orderSn: sn,
      error: "orderSn không hợp lệ (đang là mã vận đơn). Cần resolve đơn Shopee trước khi lưu.",
    };
  }
  if (!Array.isArray(order?.items) || order.items.length === 0) {
    return {
      ok: false,
      orderSn: sn,
      error: "Thiếu danh sách sản phẩm (items) — không lưu đơn rỗng vào don_hoan_huy.",
    };
  }

  const inferredReturn =
    opts?.type === "return" ||
    String(order?.local_status || order?.localStatus || "").toUpperCase() === "RETURN_RECEIVED" ||
    String(order?.status || "") === "return_received" ||
    String(order?.status || "") === "return_pending" ||
    String(order?.shopee_order_status || "").toUpperCase() === "TO_RETURN";
  const type: "cancelled" | "return" = inferredReturn ? "return" : "cancelled";
  const local_status = type === "return" ? "RETURN_RECEIVED" : "CANCELLED_STORED";
  const now = opts?.scannedAt ? new Date(opts.scannedAt) : new Date();
  const scannedAt = Number.isNaN(now.getTime()) ? new Date() : now;

  const scanCode = String(opts?.scanCode || "").trim();
  const usableScan =
    scanCode &&
    scanCode !== sn &&
    !isShopeeInternalTrackingCode(scanCode) &&
    isCarrierTrackingCode(scanCode)
      ? scanCode
      : "";

  let tn = String(order?.tracking_no || order?.trackingNumber || "").trim();
  if ((!tn || isShopeeInternalTrackingCode(tn)) && usableScan) tn = usableScan;
  if (tn && isShopeeInternalTrackingCode(tn)) tn = "";

  let rtn = String(order?.return_tracking_no || "").trim();
  if ((!rtn || isShopeeInternalTrackingCode(rtn)) && type === "return" && usableScan) {
    rtn = usableScan;
  }
  if (!rtn && type === "cancelled" && tn && !isShopeeInternalTrackingCode(tn)) {
    rtn = tn;
  }
  if (rtn && isShopeeInternalTrackingCode(rtn)) rtn = "";

  const $set: Record<string, unknown> = {
    orderSn: sn,
    status: type === "return" ? "return_received" : "cancelled",
    scannedAt,
    shopId: order?.shopId != null ? String(order.shopId) : null,
    type,
    local_status,
    shopee_order_status: order?.shopee_order_status
      ? String(order.shopee_order_status)
      : null,
    shopName: order?.shopName != null ? String(order.shopName) : null,
    source: opts?.source || "qr_scan",
    data: {
      id: order?.id || `shopee-${sn}`,
      orderSn: sn,
      items: Array.isArray(order?.items) ? order.items.slice(0, 20) : [],
      date: order?.date || null,
      totalAmount: order?.totalAmount ?? null,
      channel: order?.channel || "shopee",
      shipping_carrier: order?.shipping_carrier || null,
      packageNumber: order?.packageNumber || null,
      ...(tn ? { tracking_no: tn, trackingNumber: tn } : {}),
      ...(rtn ? { return_tracking_no: rtn } : {}),
      ...(scanCode ? { scan_code: scanCode } : {}),
    },
  };
  if (tn) $set.tracking_no = tn;
  if (rtn) $set.return_tracking_no = rtn;
  if (scanCode) {
    $set.scan_code = scanCode;
    $set.note = `scan:${scanCode}`;
  }

  return { ok: true, payload: { sn, $set, scannedAt } };
}

/**
 * Upsert đơn hủy/hoàn vào collection don_hoan_huy (SSOT cho tab).
 * TTL 14 ngày tự xóa theo scannedAt. maxTimeMS 5s — fail nhanh.
 */
export async function upsertDonHoanHuy(
  order: any,
  opts?: {
    type?: "cancelled" | "return";
    scanCode?: string;
    source?: string;
    scannedAt?: string | Date;
  },
): Promise<{ ok: boolean; orderSn: string; error?: string }> {
  try {
    requireMongo();
  } catch (readyErr) {
    console.error("[MongoDB] upsertDonHoanHuy requireMongo:", readyErr);
    return { ok: false, orderSn: "", error: "Lỗi kết nối MongoDB" };
  }

  const built = buildDonHoanHuyUpsertPayload(order, opts);
  if (!built.ok) {
    return { ok: false, orderSn: built.orderSn, error: built.error };
  }

  const { sn, $set, scannedAt } = built.payload;
  const DON_HOAN_HUY_MAX_MS = 5000;

  try {
    const writePromise = DonHoanHuyModel.findOneAndUpdate(
      { orderSn: sn },
      {
        $set,
        $setOnInsert: {
          createdAt: scannedAt,
        },
      },
      { upsert: true, new: true, maxTimeMS: DON_HOAN_HUY_MAX_MS },
    );

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("MongoDB maxTimeMS/serverSelection timeout 5000ms")),
        DON_HOAN_HUY_MAX_MS + 500,
      );
    });

    await Promise.race([writePromise, timeoutPromise]);
    console.log(
      `[MongoDB] upsert don_hoan_huy ok order_sn=${sn} type=${$set.type} local_status=${$set.local_status}`,
    );
    return { ok: true, orderSn: sn };
  } catch (err) {
    console.error("[MongoDB] upsert don_hoan_huy FAIL order_sn=" + sn + ":", err);
    const detail = describeMongoWriteError(err);
    return {
      ok: false,
      orderSn: sn,
      error: isMongoConnectionError(err) ? "Lỗi kết nối MongoDB" : detail,
    };
  }
}

/** 1 lần bulkWrite — cấm await findOneAndUpdate từng đơn trong vòng lặp. */
export async function upsertDonHoanHuyBatch(
  rows: Array<{ order: any; type?: "cancelled" | "return"; scanCode?: string; source?: string }>,
): Promise<{ ok: number; failed: number; errors: string[] }> {
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];

  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: 0, failed: 0, errors: [] };
  }

  try {
    requireMongo();
  } catch (readyErr) {
    console.error("[MongoDB] upsertDonHoanHuyBatch requireMongo:", readyErr);
    return {
      ok: 0,
      failed: rows.length,
      errors: ["Lỗi kết nối MongoDB"],
    };
  }

  const ops: any[] = [];
  const opSns: string[] = [];

  for (const row of rows) {
    const built = buildDonHoanHuyUpsertPayload(row.order, {
      type: row.type,
      scanCode: row.scanCode,
      source: row.source,
    });
    if (!built.ok) {
      failed += 1;
      if (built.error) errors.push(`#${built.orderSn || "?"}: ${built.error}`);
      continue;
    }
    const { sn, $set, scannedAt } = built.payload;
    ops.push({
      updateOne: {
        filter: { orderSn: sn },
        update: {
          $set,
          $setOnInsert: { createdAt: scannedAt },
        },
        upsert: true,
      },
    });
    opSns.push(sn);
  }

  if (ops.length === 0) {
    return { ok, failed, errors };
  }

  const DHH_BULK_CHUNK = 250;
  const DHH_BULK_DELAY_MS = 40;
  try {
    let upserted = 0;
    let modified = 0;
    let matched = 0;
    for (let i = 0; i < ops.length; i += DHH_BULK_CHUNK) {
      const chunk = ops.slice(i, i + DHH_BULK_CHUNK);
      const result = await withWriteTimeout(
        DonHoanHuyModel.bulkWrite(chunk, { ordered: false }),
        "don_hoan_huy_bulkWrite",
        12_000,
      );
      upserted += result.upsertedCount || 0;
      modified += result.modifiedCount || 0;
      matched += result.matchedCount || 0;
      if (i + DHH_BULK_CHUNK < ops.length) {
        await new Promise((r) => setTimeout(r, DHH_BULK_DELAY_MS));
      }
    }
    ok = opSns.length;
    console.log(
      `[MongoDB] bulkWrite don_hoan_huy ONE shot — ops=${ops.length}` +
        ` upserted=${upserted} modified=${modified} matched=${matched}`,
    );
  } catch (err: any) {
    // ordered:false — một phần có thể đã ghi; đếm writeErrors.
    const writeErrors = Array.isArray(err?.writeErrors) ? err.writeErrors : [];
    const errCount = writeErrors.length || (err ? 1 : 0);
    const succeeded = Math.max(0, ops.length - errCount);
    ok += succeeded;
    failed += errCount;
    if (writeErrors.length) {
      for (const we of writeErrors.slice(0, 10)) {
        const idx = typeof we?.index === "number" ? we.index : -1;
        const sn = idx >= 0 ? opSns[idx] : "?";
        errors.push(`#${sn}: ${we?.errmsg || we?.message || "bulkWrite error"}`);
      }
    } else {
      const detail = describeMongoWriteError(err);
      errors.push(isMongoConnectionError(err) ? "Lỗi kết nối MongoDB" : detail);
      console.error("[MongoDB] bulkWrite don_hoan_huy FAIL:", err);
    }
    if (ok === 0 && failed === 0) {
      failed = rows.length;
    }
  }

  return { ok, failed, errors };
}

/**
 * Ghi cờ HANDED_OVER / CANCELLED_STORED / RETURN_RECEIVED hàng loạt — 1 bulkWrite.
 */
export async function markOrdersScanFlagsBatch(
  rows: Array<{
    orderSn: string;
    localStatus: "HANDED_OVER" | "CANCELLED_STORED" | "RETURN_RECEIVED";
    shopId?: string;
    handedOverAt?: string;
    source?: string;
    stockRestored?: boolean;
    stockRestoredAt?: string;
  }>,
): Promise<number> {
  if (!isMongoReady() || !Array.isArray(rows) || rows.length === 0) return 0;
  requireMongo();

  const ops: any[] = [];
  const nowIso = new Date().toISOString();

  for (const row of rows) {
    const sn = String(row?.orderSn || "").replace(/^shopee-/i, "").trim();
    if (!sn) continue;
    const _id = `shopee-${sn}`;
    const shopIdStr = row?.shopId != null ? String(row.shopId).trim() : "";
    const status = String(row.localStatus || "").toUpperCase();

    if (status === "HANDED_OVER") {
      const handedAt = row.handedOverAt || nowIso;
      const source = row.source || "qr_scan";
      const $set: Record<string, unknown> = {
        is_handed_over: true,
        "data.is_handed_over": true,
        "data.isHandedOverToCarrier": true,
        "data.is_handed_over_to_carrier": true,
        "data.is_handed_over_to_courier": true,
        "data.local_status": "HANDED_OVER",
        "data.localStatus": "HANDED_OVER",
        "data.internal_status": "HANDED_OVER",
        "data.handedOverAt": handedAt,
        "data.handed_over_source": source,
        "data.handedOverSource": source,
        "data.localStatusAt": handedAt,
        "data.local_status_updated_at": handedAt,
      };
      if (shopIdStr) {
        $set.shopId = shopIdStr;
        $set["data.shopId"] = shopIdStr;
      }
      ops.push({
        updateOne: {
          filter: buildOrderCompoundFilter(sn, _id, shopIdStr),
          update: {
            $set,
            $setOnInsert: {
              _id,
              orderSn: sn,
              "data.id": _id,
              "data.orderSn": sn,
              "data.channel": "shopee",
            },
          },
          upsert: true,
        },
      });
      continue;
    }

    if (status !== "CANCELLED_STORED" && status !== "RETURN_RECEIVED") continue;

    const $set: Record<string, unknown> = {
      "data.local_status": status,
      "data.localStatus": status,
      "data.internal_status": status,
      "data.localStatusAt": nowIso,
      "data.local_status_updated_at": nowIso,
      "data.is_local_return_archived": false,
      is_handed_over: false,
      "data.is_handed_over": false,
      "data.isHandedOverToCarrier": false,
      "data.is_handed_over_to_carrier": false,
      "data.is_handed_over_to_courier": false,
    };
    if (row.stockRestored) {
      const restoredAt = String(row.stockRestoredAt || nowIso);
      $set["data.stock_restored"] = true;
      $set["data.stock_restored_at"] = restoredAt;
    }
    if (status === "RETURN_RECEIVED") {
      $set.status = "return_received";
      $set["data.status"] = "return_received";
    } else {
      $set.status = "cancelled";
      $set["data.status"] = "cancelled";
    }
    if (shopIdStr) {
      $set.shopId = shopIdStr;
      $set["data.shopId"] = shopIdStr;
    }
    ops.push({
      updateOne: {
        filter: buildOrderCompoundFilter(sn, _id, shopIdStr),
        update: {
          $set,
          $setOnInsert: {
            _id,
            orderSn: sn,
            "data.id": _id,
            "data.orderSn": sn,
            "data.channel": "shopee",
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length === 0) return 0;
  const FLAG_BULK_CHUNK = 250;
  const FLAG_BULK_DELAY_MS = 40;
  let modified = 0;
  let upserted = 0;
  for (let i = 0; i < ops.length; i += FLAG_BULK_CHUNK) {
    const chunk = ops.slice(i, i + FLAG_BULK_CHUNK);
    const result = await withWriteTimeout(
      OrderModel.bulkWrite(chunk, { ordered: false }),
      "markOrdersScanFlags_bulkWrite",
      12_000,
    );
    modified += result.modifiedCount || 0;
    upserted += result.upsertedCount || 0;
    if (i + FLAG_BULK_CHUNK < ops.length) {
      await new Promise((r) => setTimeout(r, FLAG_BULK_DELAY_MS));
    }
  }
  console.log(
    `[MongoDB] bulkWrite markOrdersScanFlags — ops=${ops.length}` +
      ` modified=${modified} upserted=${upserted}`,
  );
  return ops.length;
}

export type ScannerSyncRow = {
  order_id: string;
  tracking_code: string;
  return_waybill: string;
  status: string;
  logistics_status?: string;
  shopee_cancel_return_kind?: string;
  is_rts?: boolean;
};

/** Derive status gọn cho máy quét. */
function deriveScannerSyncStatus(d: any): string {
  const data = d?.data && typeof d.data === "object" ? d.data : {};
  const raw = String(d?.shopee_order_status || data.shopee_order_status || "")
    .trim()
    .toUpperCase();
  const st = String(d?.status || data.status || "")
    .trim()
    .toLowerCase();
  const logistics = String(d?.logistics_status || data.logistics_status || "")
    .trim()
    .toUpperCase();
  const cancelKind = String(
    d?.shopee_cancel_return_kind || data.shopee_cancel_return_kind || "",
  ).trim();
  const isRts = d?.is_rts === true || data.is_rts === true;
  const handed =
    d?.is_handed_over === true ||
    data.is_handed_over === true ||
    data.isHandedOverToCarrier === true ||
    data.is_handed_over_to_carrier === true;

  if (
    st === "return_received" ||
    st === "return_pending" ||
    raw === "TO_RETURN" ||
    Boolean(String(d?.return_sn || data.return_sn || "").trim())
  ) {
    return st === "return_received" ? "return_received" : "return_pending";
  }
  if (
    cancelKind === "failed_delivery" ||
    isRts ||
    (logistics && isShopeeRtsLogistics(logistics))
  ) {
    return "rts";
  }
  if (st === "cancelled" || raw === "CANCELLED" || raw === "IN_CANCEL") {
    return "cancelled";
  }
  if (st === "shipping" || raw === "SHIPPED" || raw === "TO_CONFIRM_RECEIVE") {
    return "shipping";
  }
  if (handed) return "handed_over";
  if (st === "processed" || raw === "PROCESSED") return "processed";
  return st || "processed";
}

/**
 * Sync siêu tốc cho Barcode Scanner — chỉ 4 field, không hydrate items.
 * Pool: Đã xử lý + Đã giao ĐVVC + Đang giao + YCTH + Đơn hủy.
 */
export async function listScannerSyncRowsFromStore(): Promise<ScannerSyncRow[]> {
  if (!isMongoReady()) return [];
  requireMongo();

  const filter = {
    $or: [
      orderTabFilter("unprocessed"),
      orderTabFilter("processed"),
      orderTabFilter("pending_confirm"),
      orderTabFilter("handed_over_carrier"),
      orderTabFilter("shipping"),
      orderTabFilter("return_requests"),
      orderTabFilter("cancelled"),
      orderTabFilter("cancel_returns"),
    ],
  };

  const docs = await OrderModel.find(filter)
    .select({
      _id: 1,
      orderSn: 1,
      status: 1,
      shopee_order_status: 1,
      tracking_no: 1,
      trackingNumber: 1,
      return_tracking_no: 1,
      returnTrackingNumber: 1,
      is_handed_over: 1,
      logistics_status: 1,
      shopee_cancel_return_kind: 1,
      is_rts: 1,
      "data.orderSn": 1,
      "data.status": 1,
      "data.shopee_order_status": 1,
      "data.tracking_no": 1,
      "data.trackingNumber": 1,
      "data.return_tracking_no": 1,
      "data.returnTrackingNumber": 1,
      "data.is_handed_over": 1,
      "data.isHandedOverToCarrier": 1,
      "data.is_handed_over_to_carrier": 1,
      "data.return_sn": 1,
      "data.logistics_status": 1,
      "data.shopee_cancel_return_kind": 1,
      "data.is_rts": 1,
      return_sn: 1,
    })
    .limit(20000)
    .lean()
    .maxTimeMS(15_000);

  const rows: ScannerSyncRow[] = [];
  for (const d of docs as any[]) {
    const data = d?.data && typeof d.data === "object" ? d.data : {};
    const orderId = String(
      d?.orderSn || data.orderSn || String(d?._id || "").replace(/^shopee-/i, ""),
    ).trim();
    if (!orderId) continue;
    const tracking = String(
      d?.tracking_no || d?.trackingNumber || data.tracking_no || data.trackingNumber || "",
    ).trim();
    const returnWb = String(
      d?.return_tracking_no ||
        d?.returnTrackingNumber ||
        data.return_tracking_no ||
        data.returnTrackingNumber ||
        "",
    ).trim();
    rows.push({
      order_id: orderId,
      tracking_code: tracking,
      return_waybill: returnWb,
      status: deriveScannerSyncStatus(d),
      logistics_status: String(
        d?.logistics_status || data.logistics_status || "",
      ).trim() || undefined,
      shopee_cancel_return_kind: String(
        d?.shopee_cancel_return_kind || data.shopee_cancel_return_kind || "",
      ).trim() || undefined,
      is_rts: d?.is_rts === true || data.is_rts === true || undefined,
    });
  }
  return rows;
}

const SCAN_BATCH_IN_SIZE = 300;
const SCAN_BATCH_DELAY_MS = 40;

function collectHydratedOrderScanKeys(order: any): string[] {
  const keys: string[] = [];
  const add = (v: unknown) => {
    const n = normalizeScannedCode(v);
    if (!n) return;
    keys.push(n);
    const stripped = stripScannedSeparators(n);
    if (stripped && stripped !== n) keys.push(stripped);
  };
  add(order?.orderSn);
  add(order?.order_sn);
  add(order?.tracking_no);
  add(order?.trackingNumber);
  add(order?.return_tracking_no);
  add(order?.returnTrackingNumber);
  add(order?.packageNumber);
  add(order?.package_number);
  add(order?.internalTrackingCode);
  add(order?.return_sn);
  add(String(order?.id || "").replace(/^shopee-/i, ""));
  return keys;
}

function buildScanCodesInFilter(chunk: string[]): Record<string, unknown> | null {
  const variants = new Set<string>();
  const ids: string[] = [];
  const sns: string[] = [];
  for (const code of chunk) {
    const scanned = normalizeScannedCode(code);
    if (!scanned) continue;
    variants.add(scanned);
    const stripped = stripScannedSeparators(scanned);
    if (stripped) variants.add(stripped);
    const sn = scanned.replace(/^SHOPEE-/, "");
    if (sn) sns.push(sn);
    ids.push(scanned.startsWith("SHOPEE-") ? `shopee-${sn}` : `shopee-${scanned}`);
    ids.push(scanned);
  }
  const codes = [...variants];
  const snList = [...new Set(sns.filter(Boolean))];
  if (codes.length === 0 && snList.length === 0) return null;
  return {
    $or: [
      { orderSn: { $in: snList } },
      { tracking_no: { $in: codes } },
      { trackingNumber: { $in: codes } },
      { return_tracking_no: { $in: codes } },
      { returnTrackingNumber: { $in: codes } },
      { packageNumber: { $in: codes } },
      { return_sn: { $in: codes } },
      { "data.orderSn": { $in: snList } },
      { "data.order_sn": { $in: snList } },
      { "data.tracking_no": { $in: codes } },
      { "data.trackingNumber": { $in: codes } },
      { "data.return_tracking_no": { $in: codes } },
      { "data.returnTrackingNumber": { $in: codes } },
      { "data.packageNumber": { $in: codes } },
      { "data.package_number": { $in: codes } },
      { "data.internalTrackingCode": { $in: codes } },
      { "data.return_sn": { $in: codes } },
      { _id: { $in: [...new Set(ids)] } },
    ],
  };
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Lookup N mã quét — ĐÚNG 1 (hoặc vài chunk) find `$in` trên index. CẤM N lần findOne. */
export async function findOrdersByScanCodesInStore(
  rawCodes: string[],
): Promise<Map<string, any>> {
  const result = new Map<string, any>();
  if (!isMongoReady() || !Array.isArray(rawCodes) || rawCodes.length === 0) {
    return result;
  }
  requireMongo();

  const uniqueCodes: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawCodes) {
    const scanned = normalizeScannedCode(raw);
    if (!scanned || seen.has(scanned)) continue;
    seen.add(scanned);
    uniqueCodes.push(scanned);
  }
  if (uniqueCodes.length === 0) return result;

  const byScanKey = new Map<string, any>();
  const ingestDocs = (docs: any[]) => {
    for (const doc of docs || []) {
      const order = hydrateOrderFromMongoDoc(doc);
      if (!order) continue;
      for (const k of collectHydratedOrderScanKeys(order)) {
        if (k && !byScanKey.has(k)) byScanKey.set(k, order);
      }
    }
  };

  for (let i = 0; i < uniqueCodes.length; i += SCAN_BATCH_IN_SIZE) {
    const chunk = uniqueCodes.slice(i, i + SCAN_BATCH_IN_SIZE);
    const filter = buildScanCodesInFilter(chunk);
    if (!filter) continue;
    try {
      const docs = await withWriteTimeout(
        OrderModel.find(filter)
          .limit(Math.min(Math.max(chunk.length * 3, 50), 2000))
          .maxTimeMS(8000)
          .lean()
          .exec(),
        "scan_codes_in_lookup",
        9000,
      );
      ingestDocs(docs as any[]);
    } catch (err: any) {
      console.warn(
        "[MongoDB] findOrdersByScanCodesInStore chunk fail:",
        err?.message || err,
      );
    }
    if (i + SCAN_BATCH_IN_SIZE < uniqueCodes.length) {
      await sleepMs(SCAN_BATCH_DELAY_MS);
    }
  }

  for (const raw of rawCodes) {
    const scanned = normalizeScannedCode(raw);
    if (!scanned) continue;
    const stripped = stripScannedSeparators(scanned);
    const found = byScanKey.get(scanned) || (stripped ? byScanKey.get(stripped) : undefined);
    if (found) {
      result.set(raw, found);
      result.set(scanned, found);
    }
  }

  console.log(
    `[MongoDB] findOrdersByScanCodesInStore codes=${uniqueCodes.length} hits=${result.size} $in (no per-code findOne)`,
  );
  return result;
}

/** Gộp bản ghi don_hoan_huy vào list orders (để tab FE lọc local_status vẫn thấy). */
export async function mergeDonHoanHuyIntoOrders(orders: any[]): Promise<any[]> {
  if (!isMongoReady()) return orders;
  try {
    requireMongo();
    const dhh = await loadDonHoanHuyAsOrders(3000);
    if (!dhh.length) return orders;
    const list = Array.isArray(orders) ? [...orders] : [];
    const bySn = new Map<string, number>();
    list.forEach((o, i) => {
      const sn = String(o?.orderSn || "").replace(/^shopee-/i, "").trim();
      if (sn) bySn.set(sn, i);
    });
    const pickTn = (...vals: unknown[]) => {
      for (const v of vals) {
        const t = String(v || "").trim();
        if (t && !isShopeeInternalTrackingCode(t)) return t;
      }
      return "";
    };
    for (const row of dhh) {
      const sn = String(row.orderSn || "").replace(/^shopee-/i, "").trim();
      if (!sn) continue;
      const idx = bySn.get(sn);
      if (idx !== undefined) {
        const cur = list[idx];
        const tn = pickTn(
          row.tracking_no,
          row.trackingNumber,
          cur.tracking_no,
          cur.trackingNumber,
        );
        const rtn = pickTn(row.return_tracking_no, cur.return_tracking_no);
        list[idx] = {
          ...cur,
          ...row,
          items: cur.items?.length ? cur.items : row.items,
          tracking_no: tn || cur.tracking_no || row.tracking_no,
          trackingNumber: tn || cur.trackingNumber || row.trackingNumber,
          return_tracking_no: rtn || cur.return_tracking_no || row.return_tracking_no,
          local_status: row.local_status,
          localStatus: row.local_status,
          internal_status: row.local_status,
          is_local_return_archived: false,
        };
      } else {
        bySn.set(sn, list.length);
        list.unshift(row);
      }
    }
    return list;
  } catch (err: any) {
    console.warn("[MongoDB] mergeDonHoanHuyIntoOrders:", err?.message || err);
    return orders;
  }
}

/**
 * Đảm bảo TTL Index trên order_events.occurred_at và sync_jobs.finished_at.
 * Nếu index cũ lệch expireAfterSeconds → drop + tạo lại (Mongo không cho sửa TTL tại chỗ).
 */
export async function ensureRetentionTtlIndexes(): Promise<{
  orderEventsTtlSeconds: number;
  syncJobsTtlSeconds: number;
  recreated: string[];
}> {
  requireMongo();
  const recreated: string[] = [];

  const ensureTtl = async (
    model: Model<any>,
    indexName: string,
    key: Record<string, 1 | -1>,
    expireAfterSeconds: number,
  ) => {
    const coll = model.collection;
    const existing = await coll.indexes();
    const hit = existing.find((idx: any) => idx?.name === indexName);
    const currentTtl = hit?.expireAfterSeconds;
    if (hit && Number(currentTtl) === Number(expireAfterSeconds)) {
      return;
    }
    if (hit) {
      try {
        await coll.dropIndex(indexName);
        console.log(
          `[MongoDB] Dropped TTL index ${indexName} (old expireAfterSeconds=${currentTtl})`,
        );
      } catch (dropErr: any) {
        // Index không tồn tại / đang build — thử tiếp create.
        console.warn(`[MongoDB] dropIndex ${indexName}:`, dropErr?.message || dropErr);
      }
    }
    await coll.createIndex(key, {
      name: indexName,
      expireAfterSeconds,
      background: true,
    } as any);
    recreated.push(indexName);
    console.log(
      `[MongoDB] Created TTL index ${indexName} expireAfterSeconds=${expireAfterSeconds}`,
    );
  };

  await ensureTtl(
    OrderEventModel,
    "order_events_ttl",
    { occurred_at: 1 },
    ORDER_EVENT_TTL_SECONDS,
  );
  await ensureTtl(
    SyncJobModel,
    "sync_jobs_ttl",
    { finished_at: 1 },
    SYNC_JOB_TTL_SECONDS,
  );
  // don_hoan_huy TTL: schema scannedAt.expires = 1209600 (Mongoose tự tạo index)

  return {
    orderEventsTtlSeconds: ORDER_EVENT_TTL_SECONDS,
    syncJobsTtlSeconds: SYNC_JOB_TTL_SECONDS,
    recreated,
  };
}

/** Xóa order_events cũ hơn N ngày (mặc định 14) — batch để tránh timeout Atlas. */
export async function purgeOrderEventsOlderThan(
  days = 14,
  opts?: { batchSize?: number; maxBatches?: number },
): Promise<{ deleted: number; cutoffIso: string; before: number; after: number }> {
  requireMongo();
  const safeDays = Number.isFinite(days) && days > 0 ? days : 14;
  const batchSize = Math.max(500, Math.min(10_000, Math.floor(opts?.batchSize || 5000)));
  const maxBatches = Math.max(1, Math.min(500, Math.floor(opts?.maxBatches || 200)));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const before = await OrderEventModel.countDocuments().catch(() => 0);

  let deleted = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await OrderEventModel.find({ occurred_at: { $lt: cutoff } })
      .select({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (!rows.length) break;
    const ids = rows.map((r: any) => r._id);
    const result = await OrderEventModel.deleteMany({ _id: { $in: ids } });
    const n = Number(result.deletedCount || 0);
    deleted += n;
    if (n < batchSize) break;
  }

  const after = await OrderEventModel.countDocuments().catch(() => Math.max(0, before - deleted));
  console.log(
    `[MongoDB] purgeOrderEventsOlderThan days=${safeDays} deleted=${deleted} before=${before} after=${after} cutoff=${cutoff.toISOString()}`,
  );
  return { deleted, cutoffIso: cutoff.toISOString(), before, after };
}

/** Xóa sync_jobs đã kết thúc cũ hơn N ngày (finished_at). */
export async function purgeSyncJobsOlderThan(
  days = 14,
  opts?: { batchSize?: number; maxBatches?: number },
): Promise<{ deleted: number; cutoffIso: string; before: number; after: number }> {
  requireMongo();
  const safeDays = Number.isFinite(days) && days > 0 ? days : 14;
  const batchSize = Math.max(500, Math.min(10_000, Math.floor(opts?.batchSize || 5000)));
  const maxBatches = Math.max(1, Math.min(200, Math.floor(opts?.maxBatches || 100)));
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const before = await SyncJobModel.countDocuments().catch(() => 0);

  let deleted = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const rows = await SyncJobModel.find({
      finished_at: { $type: "date", $lt: cutoff },
      state: { $in: ["succeeded", "failed"] },
    })
      .select({ _id: 1 })
      .limit(batchSize)
      .lean();
    if (!rows.length) break;
    const ids = rows.map((r: any) => r._id);
    const result = await SyncJobModel.deleteMany({ _id: { $in: ids } });
    const n = Number(result.deletedCount || 0);
    deleted += n;
    if (n < batchSize) break;
  }

  const after = await SyncJobModel.countDocuments().catch(() => Math.max(0, before - deleted));
  console.log(
    `[MongoDB] purgeSyncJobsOlderThan days=${safeDays} deleted=${deleted} before=${before} after=${after}`,
  );
  return { deleted, cutoffIso: cutoff.toISOString(), before, after };
}

/**
 * Dọn collection tạm trên Atlas Free.
 * order_events đã NGỪNG ghi — xóa toàn bộ để giải phóng dung lượng.
 * sync_jobs: chỉ xóa job đã kết thúc >14 ngày.
 */
export async function purgeMongoTempCollections(opts?: {
  orderEventDays?: number;
  syncJobDays?: number;
  ensureTtl?: boolean;
}): Promise<{
  orderEventsDeleted: number;
  syncJobsDeleted: number;
  orderEventsBefore: number;
  orderEventsAfter: number;
  syncJobsBefore: number;
  syncJobsAfter: number;
  ttl?: Awaited<ReturnType<typeof ensureRetentionTtlIndexes>>;
  note: string;
}> {
  requireMongo();
  const syncJobDays = opts?.syncJobDays ?? 14;
  let ttl: Awaited<ReturnType<typeof ensureRetentionTtlIndexes>> | undefined;
  if (opts?.ensureTtl !== false) {
    try {
      ttl = await ensureRetentionTtlIndexes();
    } catch (err: any) {
      console.warn("[MongoDB] ensureRetentionTtlIndexes in purge:", err?.message || err);
    }
  }

  const orderEventsBefore = await OrderEventModel.countDocuments().catch(() => 0);
  let orderEventsDeleted = 0;
  if (orderEventsBefore > 0) {
    try {
      await OrderEventModel.collection.drop();
      orderEventsDeleted = orderEventsBefore;
      console.log(
        `[MongoDB] Dropped collection order_events entirely (was ${orderEventsBefore} docs)`,
      );
    } catch (dropErr: any) {
      const msg = String(dropErr?.message || dropErr || "");
      if (!/ns not found|NamespaceNotFound/i.test(msg)) {
        console.warn("[MongoDB] drop order_events failed, fallback deleteMany:", msg);
        try {
          const r = await OrderEventModel.deleteMany({});
          orderEventsDeleted = Number(r.deletedCount || 0);
        } catch (delErr: any) {
          console.warn("[MongoDB] deleteMany order_events failed:", delErr?.message || delErr);
        }
      }
    }
  }
  const orderEventsAfter = await OrderEventModel.countDocuments().catch(() => 0);

  const jobs = await purgeSyncJobsOlderThan(syncJobDays);

  return {
    orderEventsDeleted,
    syncJobsDeleted: jobs.deleted,
    orderEventsBefore,
    orderEventsAfter,
    syncJobsBefore: jobs.before,
    syncJobsAfter: jobs.after,
    ttl,
    note:
      "Đã xóa order_events (ngừng ghi log). sync_jobs TTL 14d. don_hoan_huy TTL 14d riêng.",
  };
}

export type DashboardLiteProduct = {
  id: string;
  title: string;
  sku: string;
  stock: number;
  image: string | null;
};

/**
 * Tồn kho thấp CHỈ dùng cho Dashboard.
 * - Disk (`PRODUCTS_STORAGE=disk`): đọc `data/products.json`, flatten Parent→Child, lọc + sort + limit trong Node.
 * - Mongo: aggregate CÓ ĐIỀU KIỆN + LIMIT + SORT (không `find({})` rồi lọc cả kho).
 * - Ép stock về số; coalesce `stock` / `current_stock` vì một số bản ghi chỉ có alias.
 * - Flatten `children` / `children_models` để báo đúng SKU biến thể (không chỉ stock parent đã cộng gộp).
 */
export async function getLowStockProductsFromStore(
  threshold: number,
  limit = 50,
): Promise<DashboardLiteProduct[]> {
  const safeThreshold = Math.max(1, Math.floor(Number(threshold) || 5));
  const safeLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
  /** Trần thu thập trước khi sort — chống treo CPU khi catalog cực lớn. */
  const MAX_COLLECT = Math.max(safeLimit * 20, 500);

  if (isProductsDiskMode()) {
    const products = readProductsFromDisk();
    const flat: DashboardLiteProduct[] = [];
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (!p || typeof p !== "object") continue;
      const children =
        Array.isArray(p.children) && p.children.length > 0
          ? p.children
          : Array.isArray(p.children_models) && p.children_models.length > 0
            ? p.children_models
            : null;
      const rows = children && children.length > 0 ? children : [p];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const id = String(row.id || (children ? "" : p.id) || "").trim();
        if (!id) continue;
        const stock = Math.max(0, Math.round(Number(row.stock ?? row.current_stock) || 0));
        if (stock >= safeThreshold) continue;
        const image =
          row.avatarUrl || row.imageUrl || p.avatarUrl || p.imageUrl || null;
        flat.push({
          id,
          title: String(
            row.title || row.name || row.modelName || p.title || p.name || row.sku || id,
          ),
          sku: String(row.sku || ""),
          stock,
          image: image ? String(image) : null,
        });
        if (flat.length >= MAX_COLLECT) break;
      }
      if (flat.length >= MAX_COLLECT) break;
    }
    return flat
      .sort((a, b) => a.stock - b.stock || a.sku.localeCompare(b.sku))
      .slice(0, safeLimit);
  }

  requireMongo();

  const toStockNum = (primary: string, fallback: string) => ({
    $max: [
      0,
      {
        $convert: {
          input: { $ifNull: [primary, { $ifNull: [fallback, 0] }] },
          to: "double",
          onError: 0,
          onNull: 0,
        },
      },
    ],
  });

  const docs = await ProductModel.aggregate([
    {
      $addFields: {
        _children: {
          $cond: [
            { $gt: [{ $size: { $ifNull: ["$data.children", []] } }, 0] },
            { $ifNull: ["$data.children", []] },
            {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$data.children_models", []] } }, 0] },
                { $ifNull: ["$data.children_models", []] },
                [],
              ],
            },
          ],
        },
      },
    },
    {
      $project: {
        rows: {
          $cond: [
            { $gt: [{ $size: "$_children" }, 0] },
            {
              $map: {
                input: "$_children",
                as: "c",
                in: {
                  id: { $toString: { $ifNull: ["$$c.id", ""] } },
                  title: {
                    $ifNull: [
                      "$$c.title",
                      {
                        $ifNull: [
                          "$$c.name",
                          {
                            $ifNull: [
                              "$$c.modelName",
                              { $ifNull: ["$data.title", { $ifNull: ["$data.name", ""] }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                  sku: { $ifNull: ["$$c.sku", ""] },
                  stock: toStockNum("$$c.stock", "$$c.current_stock"),
                  image: {
                    $ifNull: [
                      "$$c.avatarUrl",
                      {
                        $ifNull: [
                          "$$c.imageUrl",
                          { $ifNull: ["$data.avatarUrl", { $ifNull: ["$data.imageUrl", null] }] },
                        ],
                      },
                    ],
                  },
                },
              },
            },
            [
              {
                id: {
                  $toString: { $ifNull: ["$data.id", { $ifNull: ["$_id", ""] }] },
                },
                title: {
                  $ifNull: ["$data.title", { $ifNull: ["$data.name", { $ifNull: ["$data.id", ""] }] }],
                },
                sku: { $ifNull: ["$data.sku", { $ifNull: ["$sku", ""] }] },
                stock: toStockNum("$data.stock", "$data.current_stock"),
                image: {
                  $ifNull: ["$data.avatarUrl", { $ifNull: ["$data.imageUrl", null] }],
                },
              },
            ],
          ],
        },
      },
    },
    { $unwind: "$rows" },
    { $replaceRoot: { newRoot: "$rows" } },
    {
      $match: {
        id: { $nin: ["", null] },
        stock: { $lt: safeThreshold, $gte: 0 },
      },
    },
    { $sort: { stock: 1, sku: 1 } },
    { $limit: safeLimit },
  ])
    .option({ maxTimeMS: 8000 })
    .exec();

  return (docs as any[]).map((d) => ({
    id: String(d?.id || ""),
    title: String(d?.title || d?.sku || d?.id || ""),
    sku: String(d?.sku || ""),
    stock: Math.max(0, Math.round(Number(d?.stock) || 0)),
    image: d?.image ? String(d.image) : null,
  }));
}

export type DashboardStatsResult = {
  totalOrdersInDb: number;
  dashboardOrdersCount: number;
  ordersInRangeCount: number;
  revenue: number;
  profit: number;
  newOrders: number;
  returns: number;
  cancelled: number;
  pendingOrders: {
    pendingApproval: number;
    pendingPayment: number;
    pendingPack: number;
    pendingPickup: number;
    shipping: number;
    returnPending: number;
  };
  dailyRevenue: Array<{ date: string; amount: number; profit: number }>;
  topProducts: Array<{ productId: string; quantitySold: number; title: string | null; image: string | null }>;
};

/** Giá nhập 1 dòng hàng: importPrice / import_price / last_import_price / cost_price. */
const DASHBOARD_ITEM_UNIT_IMPORT_EXPR = {
  $max: [
    0,
    { $convert: { input: { $ifNull: ["$$this.importPrice", 0] }, to: "double", onError: 0, onNull: 0 } },
    { $convert: { input: { $ifNull: ["$$this.import_price", 0] }, to: "double", onError: 0, onNull: 0 } },
    { $convert: { input: { $ifNull: ["$$this.last_import_price", 0] }, to: "double", onError: 0, onNull: 0 } },
    { $convert: { input: { $ifNull: ["$$this.cost_price", 0] }, to: "double", onError: 0, onNull: 0 } },
  ],
};

const DASHBOARD_IMPORT_COST_EXPR = {
  $reduce: {
    input: { $ifNull: ["$data.items", []] },
    initialValue: 0,
    in: {
      $add: [
        "$$value",
        {
          $multiply: [
            { $max: [0, { $convert: { input: { $ifNull: ["$$this.quantity", 0] }, to: "double", onError: 0, onNull: 0 } }] },
            DASHBOARD_ITEM_UNIT_IMPORT_EXPR,
          ],
        },
      ],
    },
  },
};

const MAX_DASHBOARD_PROFIT_DAYS = 400;

function toSafeMoney(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Số liệu Dashboard tính TOÀN BỘ bằng MongoDB Aggregation ($facet, 1 round-trip) —
 * KHÔNG kéo hết đơn hàng về Node rồi for/map thủ công như trước.
 * Đọc thẳng collection `orders` — CHÍNH collection mà Webhook Shopee ghi vào
 * (bulkUpsertOrdersToStore/updateOrderTrackingInStore) — không còn qua orders.json
 * cũ nên dữ liệu luôn khớp thực tế và không bị treo do file JSON phình to.
 *
 * pendingOrders (Chờ đóng gói / Chờ lấy hàng / …) ĐẾM BẰNG cùng `orderTabFilter`
 * với GET /api/orders?tab=… và OrderManager — số ô tổng quan = số đơn trong list.
 */
export async function getDashboardStatsFromStore(
  rangeStartKey: string,
  rangeEndKey: string,
  systemFees: SystemFee[] = [],
): Promise<DashboardStatsResult> {
  requireMongo();

  // Tương đương isDashboardOrder(order) phía Node cũ: loại đơn test rỗng có
  // orderSn bắt đầu "260709" và không có tiền/không có items.
  const isDashboardOrderMatch = {
    $expr: {
      $not: {
        $and: [
          { $lte: [{ $ifNull: ["$data.totalAmount", 0] }, 0] },
          { $eq: [{ $size: { $ifNull: ["$data.items", []] } }, 0] },
          { $regexMatch: { input: { $ifNull: ["$orderSn", ""] }, regex: "^260709" } },
        ],
      },
    },
  };

  const withDashboard = (tabFilter: Record<string, unknown>) => {
    const parts = Object.keys(tabFilter).length
      ? [isDashboardOrderMatch, tabFilter]
      : [isDashboardOrderMatch];
    return parts.length === 1 ? parts[0] : { $and: parts };
  };

  const [totalOrdersInDb, facetResult, pendingApproval, pendingPayment, pendingPack, pendingPickup, shipping, returnPending] =
    await Promise.all([
      OrderModel.estimatedDocumentCount().maxTimeMS(3000),
      OrderModel.aggregate([
        { $match: isDashboardOrderMatch },
        {
          $addFields: {
            // So khớp theo NGÀY (10 ký tự đầu ISO) — đúng hành vi isDateInRange cũ.
            _dateKey: { $substrCP: [{ $ifNull: ["$data.date", ""] }, 0, 10] },
          },
        },
        {
          $facet: {
            dashboardOrdersCount: [{ $count: "count" }],
            kpi: [
              { $match: { _dateKey: { $gte: rangeStartKey, $lte: rangeEndKey } } },
              {
                $group: {
                  _id: null,
                  ordersInRangeCount: { $sum: 1 },
                  revenue: {
                    $sum: {
                      $cond: [
                        {
                          $and: [
                            { $ne: ["$status", "cancelled"] },
                            { $gt: [{ $ifNull: ["$data.totalAmount", 0] }, 0] },
                          ],
                        },
                        "$data.totalAmount",
                        0,
                      ],
                    },
                  },
                  newOrders: {
                    $sum: {
                      $cond: [
                        { $in: ["$status", ["pending_confirm", "pending_verification", "unprocessed"]] },
                        1,
                        0,
                      ],
                    },
                  },
                  returns: {
                    $sum: { $cond: [{ $in: ["$status", ["return_pending", "return_received"]] }, 1, 0] },
                  },
                  cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
                },
              },
            ],
            dailyRevenue: [
              { $match: { _dateKey: { $gte: rangeStartKey, $lte: rangeEndKey } } },
              { $match: { status: { $ne: "cancelled" }, "data.totalAmount": { $gt: 0 } } },
              {
                $addFields: {
                  _importCost: {
                    $cond: [
                      { $isArray: "$data.items" },
                      DASHBOARD_IMPORT_COST_EXPR,
                      0,
                    ],
                  },
                },
              },
              {
                $group: {
                  _id: "$_dateKey",
                  amount: {
                    $sum: {
                      $convert: { input: { $ifNull: ["$data.totalAmount", 0] }, to: "double", onError: 0, onNull: 0 },
                    },
                  },
                  importCost: {
                    $sum: {
                      $convert: { input: { $ifNull: ["$_importCost", 0] }, to: "double", onError: 0, onNull: 0 },
                    },
                  },
                },
              },
              { $project: { _id: 0, date: "$_id", amount: 1, importCost: 1 } },
            ],
            topProducts: [
              { $match: { _dateKey: { $gte: rangeStartKey, $lte: rangeEndKey } } },
              { $match: { status: { $ne: "cancelled" }, "data.totalAmount": { $gt: 0 } } },
              { $unwind: "$data.items" },
              {
                $group: {
                  _id: "$data.items.productId",
                  quantitySold: { $sum: { $ifNull: ["$data.items.quantity", 0] } },
                  title: { $first: "$data.items.productTitle" },
                  image: { $first: "$data.items.productImage" },
                },
              },
              { $match: { _id: { $nin: [null, ""] } } },
              { $sort: { quantitySold: -1 } },
              { $limit: 5 },
            ],
          },
        },
      ])
        // maxTimeMS THẤP HƠN timeout phía Node (8000ms ở server.ts) — đảm bảo MongoDB
        // tự huỷ operation TRƯỚC, giải phóng connection về pool thay vì query vẫn chạy
        // ngầm sau khi Node đã "bỏ cuộc" (nguyên nhân chính gây dồn ứ connection/process).
        .option({ maxTimeMS: 6000 })
        .exec(),
      // Cùng orderTabFilter với list đơn — pendingPack=unprocessed, pendingPickup=processed.
      OrderModel.countDocuments(withDashboard(orderTabFilter("pending_confirm"))).maxTimeMS(6000),
      OrderModel.countDocuments(
        withDashboard({
          $and: [orderTabFilter("pending_confirm"), { "data.channel": "manual" }],
        }),
      ).maxTimeMS(6000),
      OrderModel.countDocuments(withDashboard(orderTabFilter("unprocessed"))).maxTimeMS(6000),
      OrderModel.countDocuments(withDashboard(orderTabFilter("processed"))).maxTimeMS(6000),
      // Live countDocuments tab Đang giao — KHÔNG dùng cache/counters ảo.
      OrderModel.countDocuments(withDashboard(orderTabFilter("shipping"))).maxTimeMS(6000),
      OrderModel.countDocuments(withDashboard(orderTabFilter("return_pending"))).maxTimeMS(6000),
    ]);

  const facet = facetResult?.[0] || {};
  const kpi = facet.kpi?.[0] || {};
  const dailyRows: Array<{ date?: string; amount?: number; importCost?: number }> = Array.isArray(
    facet.dailyRevenue,
  )
    ? facet.dailyRevenue
    : [];

  let totalProfit = 0;
  const dailyLimit = Math.min(dailyRows.length, MAX_DASHBOARD_PROFIT_DAYS);
  const dailyRevenue: Array<{ date: string; amount: number; profit: number }> = [];
  for (let i = 0; i < dailyLimit; i++) {
    const row = dailyRows[i];
    const amount = toSafeMoney(row?.amount) || 0;
    const importCost = toSafeMoney(row?.importCost) || 0;
    const calculatedProfit = calculateProfitWithSystemFees(amount, importCost, systemFees);
    const profit = Number.isFinite(Number(calculatedProfit)) ? Number(calculatedProfit) : 0;
    totalProfit += profit || 0;
    dailyRevenue.push({
      date: String(row?.date || ""),
      amount,
      profit: profit || 0,
    });
  }

  return {
    totalOrdersInDb,
    dashboardOrdersCount: facet.dashboardOrdersCount?.[0]?.count || 0,
    ordersInRangeCount: kpi.ordersInRangeCount || 0,
    revenue: toSafeMoney(kpi.revenue) || 0,
    profit: Number.isFinite(totalProfit) ? totalProfit : 0,
    newOrders: kpi.newOrders || 0,
    returns: kpi.returns || 0,
    cancelled: kpi.cancelled || 0,
    pendingOrders: {
      pendingApproval: Number(pendingApproval) || 0,
      pendingPayment: Number(pendingPayment) || 0,
      pendingPack: Number(pendingPack) || 0,
      pendingPickup: Number(pendingPickup) || 0,
      shipping: Number(shipping) || 0,
      returnPending: Number(returnPending) || 0,
    },
    dailyRevenue,
    topProducts: Array.isArray(facet.topProducts)
      ? facet.topProducts.map((row: any) => ({
          productId: String(row._id || ""),
          quantitySold: Number(row.quantitySold) || 0,
          title: row.title ? String(row.title) : null,
          image: row.image ? String(row.image) : null,
        }))
      : [],
  };
}

export async function flushDbWrites(): Promise<void> {
  await writeChain;
}

export async function seedStoreFromArrays(
  products: any[],
  listings: any[]
): Promise<void> {
  await saveProductsToStoreAsync(products);
  await saveChannelListingsToStoreAsync(listings);
}
