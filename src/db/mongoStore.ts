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
  isPrepared?: boolean;
  /** Thời điểm bản trạng thái Shopee cuối cùng được xác minh. */
  last_synced_at?: Date | null;
  last_shopee_update_at?: Date | null;
  sync_state?: string | null;
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
    orderSn: { type: String, default: null, index: true },
    status: { type: String, default: null, index: true },
    /** Raw Shopee — bắt buộc lưu khi sync (READY_TO_SHIP / SHIPPED / ...) */
    shopee_order_status: { type: String, default: null, index: true },
    shopId: { type: String, default: null, index: true },
    tracking_no: { type: String, default: null, index: true },
    shipping_carrier: { type: String, default: null, index: true },
    is_pending_shopee_check: { type: Boolean, default: false, index: true },
    /** Cờ nội bộ — chỉ $setOnInsert khi sync; QR/bàn giao mới $set true */
    is_handed_over: { type: Boolean, default: false, index: true },
    /** Cờ in vận đơn nội bộ — chỉ $setOnInsert khi sync; API in mới $set true */
    isPrinted: { type: Boolean, default: false, index: true },
    isPrepared: { type: Boolean, default: false },
    last_synced_at: { type: Date, default: null, index: true },
    last_shopee_update_at: { type: Date, default: null },
    sync_state: { type: String, default: "verified", index: true },
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
// Giữ compound index cho các truy vấn theo shop trong luồng reconciliation.
OrderSchema.index({ orderSn: 1, shopId: 1 });
// Quét kiện hoàn theo return_tracking_no (barcode chiều về).
OrderSchema.index({ "data.return_tracking_no": 1 });
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
    out.push({
      _id: id,
      sku: p.sku != null ? String(p.sku) : null,
      data: p,
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
    out.push({
      _id: id,
      channelId: r.channelId != null ? String(r.channelId) : null,
      platform: r.platform != null ? String(r.platform) : null,
      sku: r.sku != null ? String(r.sku) : null,
      status: r.status != null ? String(r.status) : null,
      linkedProductId: r.linkedProductId != null ? String(r.linkedProductId) : null,
      data: r,
    });
  }
  return out;
}

function docsToProducts(docs: Array<{ _id?: any; data?: any; sku?: string | null }>): any[] {
  const out: any[] = [];
  for (const d of docs) {
    if (!d?.data || typeof d.data !== "object") continue;
    const data = { ...d.data };
    if (!data.id && d._id != null) data.id = String(d._id);
    if ((data.sku == null || data.sku === "") && d.sku != null) data.sku = String(d.sku);
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
      console.log("[MongoDB] Order indexes synced (orderSn, shopId, orderSn+shopId compound)");
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
  const qLower = q.toLowerCase();

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
        .lean();
      const seenIds = new Set(docs.map((d) => String(d._id)));
      for (const d of more) {
        const key = String(d._id);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        docs.push(d);
      }
    }

    // 3) Tên / model chứa từ khóa (hạn chế limit)
    if (docs.length < safeLimit) {
      const more = await ProductModel.find(
        {
          $or: [
            { "data.title": contains },
            { "data.modelName": contains },
            { "data.children.title": contains },
            { "data.children_models.title": contains },
          ],
        },
        { sku: 1, data: 1 },
      )
        .limit(parentFetchLimit)
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
    const hay = [
      row?.sku,
      row?.barcode,
      row?.title,
      row?.name,
      row?.modelName,
      ...(Array.isArray(row?.tierLabels) ? row.tierLabels : []),
      extra,
    ]
      .map((v) => String(v ?? "").toLowerCase())
      .join(" ");
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
  "isPrepared",
  "isHandedOverToCarrier",
  "is_handed_over_to_carrier",
  "is_handed_over_to_courier",
  "local_status",
  "localStatus",
  "internal_status",
  "handedOverAt",
  "handed_over_source",
  "handedOverSource",
  "localStatusAt",
  "local_status_updated_at",
  "is_local_return_archived",
  "stock_restored",
  "stock_restored_at",
]);

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

    // shop_id — BẮT BUỘC phải có để multi-shop hoạt động đúng.
    // Auto-patch: Luôn force set shopId khi có trong payload để vá các document cũ bị null.
    const shopIdStr = order.shopId != null ? String(order.shopId).trim() : "";

    // ——— $set: CHỈ field Shopee / vận chuyển — CẤM cờ nội bộ ———
    // KHÔNG ghi status ảo "processed" vào shopee_order_status — chỉ raw Shopee.
    const $set: Record<string, unknown> = {
      orderSn: orderSn || null,
      is_pending_shopee_check: pendingFlag,
      last_synced_at: new Date(),
      sync_state: String(order.sync_state || "verified"),
      "data.id": _id,
      "data.channel": order.channel != null ? String(order.channel) : "shopee",
      "data.orderSn": orderSn || null,
      "data.order_sn": orderSn || null,
      "data.is_pending_shopee_check": pendingFlag,
      "data.last_synced_at": new Date().toISOString(),
      "data.sync_state": String(order.sync_state || "verified"),
    };
    let incomingUpdateAt: Date | null = null;
    if (order.last_shopee_update_at != null) {
      const updateAt = new Date(String(order.last_shopee_update_at));
      if (!Number.isNaN(updateAt.getTime())) {
        incomingUpdateAt = updateAt;
        $set.last_shopee_update_at = updateAt;
        $set["data.last_shopee_update_at"] = updateAt.toISOString();
      }
    }
    // BẮT BUỘC: Luôn force set shopId khi có để patch old documents với shopId null/thiếu.
    if (shopIdStr) {
      $set.shopId = shopIdStr;
      $set["data.shopId"] = shopIdStr;
    }

    // BẮT BUỘC lưu raw Shopee ở ROOT (READY_TO_SHIP / SHIPPED / PROCESSED / ...)
    if (rawStatus) {
      $set.shopee_order_status = rawStatus;
      $set["data.shopee_order_status"] = rawStatus;
    }

    // status local chỉ là helper UI — không thay shopee_order_status
    if (order.status != null && String(order.status).trim()) {
      $set.status = String(order.status);
      $set["data.status"] = String(order.status);
    }

    if (order.shopName != null) $set["data.shopName"] = String(order.shopName);

    // BẢO TOÀN tracking_no + shipping_carrier thật từ Shopee
    if (usableTn) {
      $set.tracking_no = usableTn;
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

    if (order.packageNumber != null && String(order.packageNumber).trim()) {
      $set["data.packageNumber"] = String(order.packageNumber);
    }
    // Push fallback có thể chỉ chứa orderSn/status. Không để `items: []` hoặc
    // `totalAmount: 0` ghi đè snapshot chi tiết đã lấy trước đó.
    if (Array.isArray(order.items) && order.items.length > 0) {
      $set["data.items"] = order.items;
    }
    if (order.date != null) $set["data.date"] = order.date;
    if (Number(order.totalAmount) > 0) $set["data.totalAmount"] = order.totalAmount;
    if (order.fulfillment_type != null) {
      $set["data.fulfillment_type"] = order.fulfillment_type;
    }
    if (order.ship_method != null) $set["data.ship_method"] = order.ship_method;
    if (order.logistics_status != null) {
      $set["data.logistics_status"] = order.logistics_status;
    }

    // Field Shopee còn lại → data.* (bỏ cờ nội bộ — tránh đè true→false)
    for (const [key, value] of Object.entries(order)) {
      if (key === "id" || key === "_id") continue;
      if (INTERNAL_FLAG_KEYS.has(key)) continue;
      if (value === undefined) continue;
      if (key === "items" && Array.isArray(value) && value.length === 0) continue;
      if (key === "totalAmount" && Number(value) <= 0) continue;
      $set[`data.${key}`] = value;
    }

    // ——— $setOnInsert: cờ nội bộ CHỈ khi INSERT (không đè khi sync lại) ———
    const $setOnInsert: Record<string, unknown> = {
      _id,
      is_handed_over: false,
      isPrinted: false,
      isPrepared: false,
      "data.is_handed_over": false,
      "data.isPrinted": false,
      "data.isPrepared": false,
      "data.isHandedOverToCarrier": false,
      "data.is_handed_over_to_carrier": false,
      "data.is_handed_over_to_courier": false,
      "data.local_status": "NONE",
      "data.localStatus": "NONE",
      "data.internal_status": "NONE",
    };

    console.log("Dữ liệu chuẩn bị lưu DB (upsert $set + $setOnInsert):", {
      _id,
      orderSn,
      shopee_order_status: rawStatus || null,
      status_local: order.status || null,
      tracking_no: usableTn,
      shipping_carrier: carrier || null,
      setOnInsert_flags: "is_handed_over/isPrinted/isPrepared=false",
    });

    // Dùng cùng compound filter với markOrderHandedOver — khớp orderSn/_id/data.orderSn
    // + shopId string|number|null. Filter cũ `{ orderSn, $or:[shopIdStr...] }` dễ trượt
    // khi document lưu shopId dạng Number → bulkWrite upsert fail (E11000) và status
    // CANCELLED không bao giờ ghi đè bản pending_confirm cũ.
    const filter = buildOrderCompoundFilter(orderSn || String(_id).replace(/^shopee-/i, ""), _id, shopIdStr || null);

    // order_events đã bỏ — không ghi log rác vào Atlas Free.
    pendingWrites.push({
      op: {
        updateOne: {
          filter,
          update: {
            $set,
            $setOnInsert,
          },
          upsert: true,
        },
      },
      event: null,
      orderSn,
      id: _id,
      updateAt: incomingUpdateAt,
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
          .select({ _id: 1, orderSn: 1, "data.orderSn": 1, last_shopee_update_at: 1 })
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
          if (currentAt && !Number.isNaN(currentAt.getTime()) && currentAt > item.updateAt) {
            console.warn(
              `[MongoDB] STALE Shopee snapshot ignored order_sn=${item.orderSn || item.id} ` +
                `incoming=${item.updateAt.toISOString()} stored=${currentAt.toISOString()}`,
            );
            return false;
          }
          if (current) {
            const identityFilter = item.op.updateOne.filter;
            item.op.updateOne.filter = {
              $and: [
                identityFilter,
                {
                  $or: [
                    { last_shopee_update_at: null },
                    { last_shopee_update_at: { $exists: false } },
                    { last_shopee_update_at: { $lte: item.updateAt } },
                  ],
                },
              ],
            };
            item.op.updateOne.upsert = false;
          }
          return true;
        });
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
    if (p.labelUrl) $set["data.labelUrl"] = String(p.labelUrl);
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
  return ops.length;
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

/**
 * API bàn giao / quét QR — CHỈ `$set: { is_handed_over: true }`.
 * Không gọi Shopee, không đụng field khác.
 * `findOneAndUpdate` + upsert:true đảm bảo atomic — race condition webhook/quét QR
 * đồng thời không thể lưu đè mất dữ liệu.
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
    // Alias legacy — đồng bộ đọc cũ
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
    `[MongoDB] findOneAndUpdate markOrderHandedOver is_handed_over=true order_sn=${sn} shopId=${shopIdStr || "-"} ok=${Boolean(result)}`,
  );
  return Boolean(result);
}

/**
 * Ghi cờ isPrinted — KHÔNG dùng bulkUpsert (INTERNAL_FLAG_KEYS bỏ isPrinted).
 * Gọi sau khi lấy PDF vận đơn Shopee thành công, hoặc khi user reset "Chưa in".
 */
export async function markOrdersPrintedInStore(
  orderSns: string[],
  isPrinted: boolean,
  meta?: {
    shopId?: string;
    labelUrl?: string;
    pdfUrl?: string;
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
  const labelUrl = String(meta?.labelUrl || meta?.pdfUrl || "").trim();
  const pdfFilename = String(meta?.pdfFilename || "").trim();

  const ops = sns.map((sn) => {
    const _id = `shopee-${sn}`;
    const $set: Record<string, unknown> = {
      isPrinted: printed,
      "data.isPrinted": printed,
    };
    if (printed && labelUrl) {
      $set["data.labelUrl"] = labelUrl;
      $set["data.pdfUrl"] = labelUrl;
    }
    if (printed && pdfFilename) $set["data.pdfFilename"] = pdfFilename;
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
        `[MongoDB] markOrdersPrintedInStore isPrinted=${printed} sns=${sns.length}` +
          ` modified=${result.modifiedCount || 0} upserted=${result.upsertedCount || 0}`,
      );
    }),
    "mark_printed",
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
  if (status === "RETURN_RECEIVED") {
    $set.status = "return_received";
    $set["data.status"] = "return_received";
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
  },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").trim();
  const tn = String(trackingNo || "").trim();
  if (!sn || !tn) return false;
  const _id = `shopee-${sn}`;
  const shopIdStr = extra?.shopId != null ? String(extra.shopId).trim() : "";
  const $set: Record<string, unknown> = {
    tracking_no: tn,
    "data.tracking_no": tn,
    "data.trackingNumber": tn,
  };
  if (shopIdStr) {
    $set.shopId = shopIdStr;
    $set["data.shopId"] = shopIdStr;
  }
  if (extra?.internalTrackingCode) {
    $set["data.internalTrackingCode"] = extra.internalTrackingCode;
  }
  if (extra?.packageNumber) {
    $set["data.packageNumber"] = extra.packageNumber;
  }
  if (extra?.status != null) {
    $set.status = String(extra.status);
    $set["data.status"] = String(extra.status);
  }
  if (extra?.isPrepared != null) {
    $set["data.isPrepared"] = extra.isPrepared;
  }
  if (extra?.shopee_order_status != null) {
    $set["data.shopee_order_status"] = String(extra.shopee_order_status);
  }
  if (extra?.is_pending_shopee_check != null) {
    $set.is_pending_shopee_check = extra.is_pending_shopee_check;
    $set["data.is_pending_shopee_check"] = extra.is_pending_shopee_check;
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
    `[MongoDB] findOneAndUpdate tracking_no=${tn} order_sn=${sn} shopId=${shopIdStr || "-"} status=${extra?.status || "-"} ok=${Boolean(result)}`,
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

/** Biến thể mã quét để match Mongo (raw / UPPER / lower / bỏ ký tự tách). */
function buildScanKeyVariantsForMongo(rawKeys: string[]): string[] {
  const out = new Set<string>();
  for (const raw of rawKeys) {
    const text = String(raw || "").trim();
    if (!text) continue;
    const upper = text.toUpperCase();
    const lower = text.toLowerCase();
    const strippedUpper = upper.replace(/[\s\-_#./\\|:;,]+/g, "");
    const strippedLower = lower.replace(/[\s\-_#./\\|:;,]+/g, "");
    for (const v of [
      text,
      upper,
      lower,
      strippedUpper,
      strippedLower,
      text.replace(/^shopee-/i, ""),
      strippedUpper.replace(/^SHOPEE/, ""),
      strippedLower.replace(/^shopee/, ""),
    ]) {
      if (v && v.length >= 4) out.add(v);
    }
  }
  return [...out];
}

function hydrateOrderFromMongoDoc(d: any): any | null {
  if (!d) return null;
  const data = d?.data && typeof d.data === "object" ? { ...d.data } : {};
  const sn = String(d?.orderSn || data.orderSn || String(d?._id || "").replace(/^shopee-/i, "")).trim();
  if (!sn && !d?._id) return null;
  const tn = String(d?.tracking_no || data.tracking_no || data.trackingNumber || "").trim();
  const rawStatus = String(d?.shopee_order_status || data.shopee_order_status || "")
    .trim()
    .toUpperCase();
  const carrier = String(
    d?.shipping_carrier || data.shipping_carrier || data.checkout_shipping_carrier || "",
  ).trim();
  const handed =
    d?.is_handed_over === true ||
    data.is_handed_over === true ||
    data.isHandedOverToCarrier === true ||
    data.is_handed_over_to_carrier === true ||
    data.is_handed_over_to_courier === true ||
    String(data.local_status || data.localStatus || data.internal_status || "").toUpperCase() === "HANDED_OVER";
  const localRaw = String(
    data.local_status || data.localStatus || data.internal_status || "",
  ).toUpperCase();
  const localStored =
    localRaw === "CANCELLED_STORED" || localRaw === "RETURN_RECEIVED"
      ? localRaw
      : handed
        ? "HANDED_OVER"
        : localRaw === "NONE" || localRaw === "HANDED_OVER"
          ? localRaw
          : "";
  return {
    ...data,
    id: data.id || d._id || (sn ? `shopee-${sn}` : undefined),
    orderSn: sn || data.orderSn,
    status: d?.status != null ? d.status : data.status,
    shopee_order_status: rawStatus || data.shopee_order_status || undefined,
    shopId: d?.shopId != null ? d.shopId : data.shopId,
    tracking_no: tn || undefined,
    trackingNumber: tn || undefined,
    shipping_carrier: carrier || data.shipping_carrier || undefined,
    is_pending_shopee_check:
      d?.is_pending_shopee_check != null
        ? Boolean(d.is_pending_shopee_check)
        : Boolean(data.is_pending_shopee_check),
    is_handed_over: handed,
    isHandedOverToCarrier: handed,
    is_handed_over_to_carrier: handed,
    is_handed_over_to_courier: handed,
    isPrinted: d?.isPrinted != null ? Boolean(d.isPrinted) : Boolean(data.isPrinted),
    isPrepared: d?.isPrepared != null ? Boolean(d.isPrepared) : Boolean(data.isPrepared),
    ...(localStored
      ? {
          local_status: localStored,
          localStatus: localStored,
          internal_status: localStored,
        }
      : {}),
  };
}

/**
 * Lookup 1 đơn theo mã quét (tracking / orderSn / package / internal) — dùng index Mongo,
 * KHÔNG full-scan collection. Phục vụ /api/orders/lookup trên mobile.
 */
export async function findOrderByScanCodeInStore(rawCode: string): Promise<any | null> {
  if (!isMongoReady()) return null;
  requireMongo();
  const text = String(rawCode || "").trim();
  if (!text) return null;

  const seedKeys = [text, text.replace(/^#+/, "")];
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      for (const p of [
        "tracking",
        "tracking_no",
        "tracking_number",
        "tn",
        "order_sn",
        "ordersn",
        "order",
        "order_id",
        "package_number",
        "code",
        "sn",
      ]) {
        const v = url.searchParams.get(p);
        if (v) seedKeys.push(v);
      }
      for (const part of url.pathname.split("/")) {
        if (part) seedKeys.push(part);
      }
    } catch {
      /* ignore */
    }
  }
  const keys = buildScanKeyVariantsForMongo(seedKeys);
  if (keys.length === 0) return null;

  const idKeys = keys.flatMap((k) => {
    const sn = k.replace(/^SHOPEE-/i, "").replace(/^shopee-/i, "");
    return sn ? [`shopee-${sn}`, sn] : [k];
  });
  const uniqueIds = [...new Set(idKeys)];

  const filter = {
    $or: [
      { tracking_no: { $in: keys } },
      { orderSn: { $in: keys } },
      { _id: { $in: uniqueIds } },
      { "data.tracking_no": { $in: keys } },
      { "data.trackingNumber": { $in: keys } },
      { "data.return_tracking_no": { $in: keys } },
      { "data.internalTrackingCode": { $in: keys } },
      { "data.packageNumber": { $in: keys } },
      { "data.orderSn": { $in: keys } },
      { "data.order_sn": { $in: keys } },
    ],
  };

  try {
    let doc = await OrderModel.findOne(filter).maxTimeMS(4_000).lean();
    if (!doc) {
      // Case-insensitive / suffix fallback — QR casing lệch DB hoặc cắt prefix.
      const primary =
        keys.find((k) => k.length >= 8 && /[A-Za-z0-9]{8,}/.test(k)) ||
        keys.find((k) => k.length >= 8) ||
        keys[0];
      if (primary && primary.length >= 4) {
        const escaped = primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const rxExact = new RegExp(`^${escaped}$`, "i");
        const rxSuffix =
          primary.length >= 10 ? new RegExp(`${escaped}$`, "i") : null;
        const fieldMatchers = [
          { tracking_no: rxExact },
          { orderSn: rxExact },
          { "data.tracking_no": rxExact },
          { "data.trackingNumber": rxExact },
          { "data.return_tracking_no": rxExact },
          { "data.internalTrackingCode": rxExact },
          { "data.packageNumber": rxExact },
          { "data.orderSn": rxExact },
          { "data.order_sn": rxExact },
          ...(rxSuffix
            ? [
                { tracking_no: rxSuffix },
                { "data.tracking_no": rxSuffix },
                { "data.trackingNumber": rxSuffix },
                { "data.return_tracking_no": rxSuffix },
                { "data.internalTrackingCode": rxSuffix },
                { orderSn: rxSuffix },
              ]
            : []),
        ];
        doc = await OrderModel.findOne({ $or: fieldMatchers })
          .maxTimeMS(3_000)
          .lean();
      }
    }
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
          { shopee_order_status: { $in: ["TO_RETURN", "IN_CANCEL", "CANCELLED"] } },
          { status: { $in: ["return_pending", "return_received", "cancelled"] } },
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

export type OrdersPageQuery = {
  page?: number;
  pageSize?: number;
  tab?: string;
  shopId?: string;
  carrier?: string;
  query?: string;
  /** `printed` | `unprinted` — lọc theo cờ isPrinted trong Mongo (không gọi Shopee). */
  printStatus?: string;
};

/** Terminal / thoát pool chờ lấy hàng — khớp isShopeeCancelledLike + shipping/completed. */
const ORDER_TAB_LEFT_PICKUP_RAW = [
  "SHIPPED",
  "TO_CONFIRM_RECEIVE",
  "COMPLETED",
  "CANCELLED",
  "IN_CANCEL",
  "TO_RETURN",
] as const;

const ORDER_TAB_TRACKING_PRESENT: Record<string, unknown> = {
  $or: [
    { tracking_no: { $exists: true, $nin: [null, "", "0"] } },
    { "data.tracking_no": { $exists: true, $nin: [null, "", "0"] } },
    { "data.trackingNumber": { $exists: true, $nin: [null, "", "0"] } },
    { "data.shopee_tracking_number": { $exists: true, $nin: [null, "", "0"] } },
  ],
};

const ORDER_TAB_TRACKING_EMPTY: Record<string, unknown> = {
  $and: [
    { $or: [{ tracking_no: { $exists: false } }, { tracking_no: { $in: [null, "", "0"] } }] },
    { $or: [{ "data.tracking_no": { $exists: false } }, { "data.tracking_no": { $in: [null, "", "0"] } }] },
    {
      $or: [
        { "data.trackingNumber": { $exists: false } },
        { "data.trackingNumber": { $in: [null, "", "0"] } },
      ],
    },
    {
      $or: [
        { "data.shopee_tracking_number": { $exists: false } },
        { "data.shopee_tracking_number": { $in: [null, "", "0"] } },
      ],
    },
  ],
};

const ORDER_TAB_DROPOFF_PREPARED: Record<string, unknown> = {
  $and: [
    {
      $or: [
        { fulfillment_type: { $in: ["dropoff", "drop_off", "drop-off"] } },
        { "data.fulfillment_type": { $in: ["dropoff", "drop_off", "drop-off"] } },
        { ship_method: { $in: ["dropoff", "drop_off", "drop-off"] } },
        { "data.ship_method": { $in: ["dropoff", "drop_off", "drop-off"] } },
        { "data.shipping_method": { $in: ["dropoff", "drop_off", "drop-off"] } },
      ],
    },
    {
      $or: [{ isPrepared: true }, { "data.isPrepared": true }],
    },
  ],
};

const ORDER_TAB_NOT_HANDED_OVER: Record<string, unknown> = {
  $and: [
    { is_handed_over: { $ne: true } },
    { "data.is_handed_over": { $ne: true } },
  ],
};

/** Khớp isShopeeShippingStatus — loại khỏi pool Chờ lấy hàng. */
const ORDER_TAB_NOT_SHIPPING_LOGISTICS: Record<string, unknown> = {
  $and: [
    {
      $or: [
        { logistics_status: { $exists: false } },
        { logistics_status: null },
        { logistics_status: "" },
        {
          logistics_status: {
            $not: {
              $regex:
                "PICKUP_DONE|LOGISTICS_SHIPPED|LOGISTICS_DELIVERY_DONE|DELIVERY_DONE|IN_TRANSIT|TRANSPORTING",
              $options: "i",
            },
          },
        },
      ],
    },
    {
      $or: [
        { "data.logistics_status": { $exists: false } },
        { "data.logistics_status": null },
        { "data.logistics_status": "" },
        {
          "data.logistics_status": {
            $not: {
              $regex:
                "PICKUP_DONE|LOGISTICS_SHIPPED|LOGISTICS_DELIVERY_DONE|DELIVERY_DONE|IN_TRANSIT|TRANSPORTING",
              $options: "i",
            },
          },
        },
      ],
    },
  ],
};

/**
 * SSOT Mongo filter theo tab — KHỚP matchesUnprocessedPickupTab / matchesProcessedPickupTab /
 * matchesShippingTab / isPendingConfirmOrder (OrderManager + GET /api/orders).
 * Dashboard pending counts và /api/orders/query dùng chung hàm này.
 */
export function orderTabFilter(tab?: string): Record<string, unknown> {
  const key = String(tab || "").trim().toLowerCase();
  switch (key) {
    case "shipping":
    case "shipped":
    case "dang-giao":
      return {
        $or: [
          { status: "shipping" },
          { shopee_order_status: { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE"] } },
          { "data.shopee_order_status": { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE"] } },
          {
            logistics_status: {
              $regex: "PICKUP_DONE|LOGISTICS_SHIPPED|LOGISTICS_DELIVERY_DONE|DELIVERY_DONE|IN_TRANSIT|TRANSPORTING",
              $options: "i",
            },
          },
          {
            "data.logistics_status": {
              $regex: "PICKUP_DONE|LOGISTICS_SHIPPED|LOGISTICS_DELIVERY_DONE|DELIVERY_DONE|IN_TRANSIT|TRANSPORTING",
              $options: "i",
            },
          },
        ],
      };
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
      // matchesProcessedPickupTab: pickup pool + isProcessedCondition + !handed_over
      return {
        $and: [
          ORDER_TAB_NOT_HANDED_OVER,
          ORDER_TAB_NOT_SHIPPING_LOGISTICS,
          {
            shopee_order_status: { $nin: [...ORDER_TAB_LEFT_PICKUP_RAW] },
          },
          {
            $or: [
              { "data.shopee_order_status": { $exists: false } },
              { "data.shopee_order_status": { $in: [null, ""] } },
              {
                "data.shopee_order_status": {
                  $nin: [...ORDER_TAB_LEFT_PICKUP_RAW],
                },
              },
            ],
          },
          {
            $or: [
              { shopee_order_status: "PROCESSED" },
              { "data.shopee_order_status": "PROCESSED" },
              {
                $and: [
                  {
                    $or: [
                      { shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] } },
                      { "data.shopee_order_status": { $in: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] } },
                      { status: { $in: ["processed", "unprocessed"] } },
                    ],
                  },
                  ORDER_TAB_TRACKING_PRESENT,
                ],
              },
              {
                $and: [
                  {
                    $or: [
                      { shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] } },
                      { "data.shopee_order_status": { $in: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] } },
                      { status: { $in: ["processed", "unprocessed"] } },
                    ],
                  },
                  ORDER_TAB_DROPOFF_PREPARED,
                ],
              },
              {
                $and: [
                  { status: "processed" },
                  {
                    shopee_order_status: {
                      $nin: ["READY_TO_SHIP", "RETRY_SHIP", ...ORDER_TAB_LEFT_PICKUP_RAW],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
    case "unprocessed":
    case "chua-xu-ly":
    case "ready_to_ship":
    case "cho-lay-hang":
      // matchesUnprocessedPickupTab: READY_TO_SHIP|RETRY_SHIP (hoặc local unprocessed),
      // chưa PROCESSED / chưa tracking / chưa dropoff-prepared / chưa bàn giao / chưa shipping logistics.
      return {
        $and: [
          ORDER_TAB_NOT_HANDED_OVER,
          ORDER_TAB_NOT_SHIPPING_LOGISTICS,
          { shopee_order_status: { $nin: ["PROCESSED", ...ORDER_TAB_LEFT_PICKUP_RAW] } },
          {
            $or: [
              { "data.shopee_order_status": { $exists: false } },
              { "data.shopee_order_status": { $in: [null, ""] } },
              { "data.shopee_order_status": { $nin: ["PROCESSED", ...ORDER_TAB_LEFT_PICKUP_RAW] } },
            ],
          },
          ORDER_TAB_TRACKING_EMPTY,
          { $nor: [ORDER_TAB_DROPOFF_PREPARED] },
          {
            $or: [
              { shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP"] } },
              { "data.shopee_order_status": { $in: ["READY_TO_SHIP", "RETRY_SHIP"] } },
              {
                status: "unprocessed",
                $or: [
                  { shopee_order_status: { $in: [null, ""] } },
                  { shopee_order_status: { $exists: false } },
                  {
                    shopee_order_status: {
                      $nin: ["PROCESSED", ...ORDER_TAB_LEFT_PICKUP_RAW],
                    },
                  },
                ],
              },
            ],
          },
        ],
      };
    case "pending_confirm":
    case "pending_verification":
    case "cho-xac-nhan":
      // Khớp isPendingConfirmOrder — loại đơn đã READY_TO_SHIP/PROCESSED.
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
        ],
      };
    case "handed_over_carrier":
      return {
        is_handed_over: true,
        shopee_order_status: { $nin: ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"] },
      };
    case "stale":
      return {
        "data.channel": "shopee",
        shopee_order_status: { $in: ["READY_TO_SHIP", "RETRY_SHIP", "PROCESSED"] },
        last_synced_at: { $lt: new Date(Date.now() - 15 * 60 * 1000) },
      };
    default:
      return {};
  }
}

/**
 * Khi refresh shallow (limit), vẫn phải kéo đủ đơn thuộc các tab vận hành
 * (Chưa xử lý / Đã xử lý / Chờ xác nhận / Đã giao ĐVVC) — tránh badge=4 mà list=0
 * vì 50 đơn mới nhất toàn SHIPPED/COMPLETED.
 */
export async function loadPriorityTabOrdersFromStore(opts?: {
  perTabLimit?: number;
  shopId?: string;
}): Promise<any[]> {
  requireMongo();
  const perTab = Math.max(
    20,
    Math.min(200, Math.floor(Number(opts?.perTabLimit) || 100)),
  );
  const tabs = [
    "unprocessed",
    "processed",
    "pending_confirm",
    "handed_over_carrier",
    "shipping",
  ] as const;
  const pages = await Promise.all(
    tabs.map((tab) =>
      queryOrdersPageFromStore({
        page: 1,
        pageSize: perTab,
        tab,
        shopId: opts?.shopId || "",
      }).catch((err) => {
        console.warn(
          `[MongoDB] loadPriorityTabOrders tab=${tab} failed:`,
          err?.message || err,
        );
        return { rows: [] as any[] };
      }),
    ),
  );
  const byId = new Map<string, any>();
  for (const page of pages) {
    for (const row of page.rows || []) {
      const id = String(row?.id || row?.orderSn || "").trim();
      if (id) byId.set(id, row);
    }
  }
  const merged = [...byId.values()];
  console.log(
    `[MongoDB] loadPriorityTabOrders merged=${merged.length}` +
      ` tabs=${tabs.map((t, i) => `${t}:${pages[i]?.rows?.length || 0}`).join(",")}`,
  );
  return merged;
}

/** Đếm số đơn theo tab từ MongoDB — dùng cho badge/tab, không gọi Shopee. */
export async function countOrdersByTabsFromStore(opts?: {
  shopId?: string;
}): Promise<Record<string, number>> {
  requireMongo();
  const shopAnd: Record<string, unknown>[] = [];
  if (opts?.shopId && opts.shopId !== "all") {
    const shopIdStr = String(opts.shopId).trim();
    const shopVariants: Record<string, unknown>[] = [
      { shopId: shopIdStr },
      { "data.shopId": shopIdStr },
    ];
    const asNum = Number(shopIdStr);
    if (Number.isFinite(asNum) && String(asNum) === shopIdStr) {
      shopVariants.push({ shopId: asNum }, { "data.shopId": asNum });
    }
    shopAnd.push({ $or: shopVariants });
  }
  const withShop = (tabFilter: Record<string, unknown>) => {
    const parts = [...shopAnd];
    if (tabFilter && Object.keys(tabFilter).length) parts.push(tabFilter);
    if (parts.length === 0) return {};
    if (parts.length === 1) return parts[0];
    return { $and: parts };
  };
  const cancelReturnsFilter = withShop({
    $or: [
      { status: { $in: ["cancelled", "return_pending", "return_received"] } },
      {
        shopee_order_status: {
          $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"],
        },
      },
      { "data.shopee_order_status": { $in: ["CANCELLED", "IN_CANCEL", "TO_RETURN"] } },
      { local_status: { $in: ["CANCELLED_STORED", "RETURN_RECEIVED"] } },
      { "data.local_status": { $in: ["CANCELLED_STORED", "RETURN_RECEIVED"] } },
    ],
  });
  const countTabs = [
    "pending_confirm",
    "unprocessed",
    "processed",
    "shipping",
    "handed_over_carrier",
    "return_pending",
  ] as const;
  const [all, ...tabCounts] = await Promise.all([
    OrderModel.countDocuments(withShop({})).maxTimeMS(8000),
    ...countTabs.map((t) =>
      OrderModel.countDocuments(withShop(orderTabFilter(t))).maxTimeMS(8000),
    ),
    OrderModel.countDocuments(cancelReturnsFilter).maxTimeMS(8000),
  ]);
  const counts: Record<string, number> = {
    all: Number(all) || 0,
    cancel_returns: Number(tabCounts[countTabs.length]) || 0,
  };
  countTabs.forEach((t, i) => {
    counts[t] = Number(tabCounts[i]) || 0;
  });
  try {
    const dhhFilter =
      opts?.shopId && opts.shopId !== "all"
        ? {
            $or: [
              { shopId: String(opts.shopId) },
              { shop_id: String(opts.shopId) },
            ],
          }
        : {};
    counts.received_cancel_returns = Number(
      await DonHoanHuyModel.countDocuments(dhhFilter).maxTimeMS(5000),
    );
  } catch {
    counts.received_cancel_returns = 0;
  }
  return counts;
}

/** Danh sách đơn phân trang từ MongoDB; frontend không cần tải toàn bộ collection để lọc. */
export async function queryOrdersPageFromStore(opts?: OrdersPageQuery): Promise<{
  rows: any[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  counts: Record<string, number>;
}> {
  requireMongo();
  const page = Math.max(1, Math.floor(Number(opts?.page) || 1));
  const pageSize = Math.max(10, Math.min(200, Math.floor(Number(opts?.pageSize) || 50)));
  const and: Record<string, unknown>[] = [];
  const tabFilter = orderTabFilter(opts?.tab);
  if (Object.keys(tabFilter).length) and.push(tabFilter);
  if (opts?.shopId && opts.shopId !== "all") {
    const shopIdStr = String(opts.shopId).trim();
    const shopVariants: Record<string, unknown>[] = [
      { shopId: shopIdStr },
      { "data.shopId": shopIdStr },
    ];
    const asNum = Number(shopIdStr);
    if (Number.isFinite(asNum) && String(asNum) === shopIdStr) {
      shopVariants.push({ shopId: asNum }, { "data.shopId": asNum });
    }
    and.push({ $or: shopVariants });
  }
  if (opts?.carrier && opts.carrier !== "all") and.push({ shipping_carrier: String(opts.carrier) });
  const printStatus = String(opts?.printStatus || "").trim().toLowerCase();
  if (printStatus === "printed" || printStatus === "da-in" || printStatus === "true") {
    and.push({
      $or: [{ isPrinted: true }, { "data.isPrinted": true }],
    });
  } else if (
    printStatus === "unprinted" ||
    printStatus === "chua-in" ||
    printStatus === "false" ||
    printStatus === "not_printed"
  ) {
    and.push({
      $and: [
        { $or: [{ isPrinted: { $exists: false } }, { isPrinted: false }, { isPrinted: null }] },
        {
          $or: [
            { "data.isPrinted": { $exists: false } },
            { "data.isPrinted": false },
            { "data.isPrinted": null },
          ],
        },
      ],
    });
  }
  const search = String(opts?.query || "").trim();
  if (search) {
    const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    and.push({
      $or: [
        { orderSn: regex },
        { tracking_no: regex },
        { "data.shopName": regex },
        { "data.shipping_carrier": regex },
        { "data.items.productTitle": regex },
      ],
    });
  }
  const filter = and.length === 0 ? {} : and.length === 1 ? and[0] : { $and: and };
  const countTabs = [
    "pending_confirm",
    "unprocessed",
    "processed",
    "shipping",
    "return_pending",
  ] as const;
  const [total, docs, allCount, ...tabCounts] = await Promise.all([
    OrderModel.countDocuments(filter).maxTimeMS(8000),
    OrderModel.find(filter)
      .sort({ "data.date": -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select({ _id: 1 })
      .maxTimeMS(8000)
      .lean(),
    OrderModel.countDocuments({}).maxTimeMS(8000),
    ...countTabs.map((t) =>
      OrderModel.countDocuments(orderTabFilter(t)).maxTimeMS(8000),
    ),
  ]);
  const ids = docs.map((doc: any) => String(doc._id));
  const hydrated = await loadOrdersFromStore({ ids });
  const rowById = new Map(hydrated.map((row: any) => [String(row.id || ""), row]));
  const rows = ids.map((id) => rowById.get(id)).filter(Boolean);
  const counts: Record<string, number> = { all: Number(allCount) || 0 };
  countTabs.forEach((t, i) => {
    counts[t] = Number(tabCounts[i]) || 0;
  });
  return { rows, total, page, pageSize, hasMore: page * pageSize < total, counts };
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
    String(doc?.return_tracking_no || base.return_tracking_no || "").trim() ||
    (local === "RETURN_RECEIVED" ? scanFallback || undefined : undefined);

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
    return_tracking_no: rtn || undefined,
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
  if (rtn && isShopeeInternalTrackingCode(rtn)) rtn = "";

  const DON_HOAN_HUY_MAX_MS = 5000;

  try {
    // Collection don_hoan_huy — unique theo orderSn, TTL 14d trên scannedAt.
    // Không $set tracking = null để tránh đè mất mã đã lưu khi re-upsert thiếu TN.
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
      `[MongoDB] upsert don_hoan_huy ok order_sn=${sn} type=${type} local_status=${local_status}`,
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

export async function upsertDonHoanHuyBatch(
  rows: Array<{ order: any; type?: "cancelled" | "return"; scanCode?: string; source?: string }>,
): Promise<{ ok: number; failed: number; errors: string[] }> {
  let ok = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const row of rows) {
    const r = await upsertDonHoanHuy(row.order, {
      type: row.type,
      scanCode: row.scanCode,
      source: row.source,
    });
    if (r.ok) ok += 1;
    else {
      failed += 1;
      if (r.error) errors.push(`#${r.orderSn || "?"}: ${r.error}`);
    }
  }
  return { ok, failed, errors };
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
 * Tồn kho thấp CHỈ dùng cho Dashboard — query CÓ ĐIỀU KIỆN + LIMIT + SORT ngay trong
 * MongoDB (KHÔNG còn `find({})` quét toàn bộ collection rồi lọc/sort thủ công trong
 * Node). Cần index `{ "data.stock": 1 }` (đã khai báo ở ProductSchema) để tránh COLLSCAN
 * khi catalog lớn dần. `.maxTimeMS()` đảm bảo Mongo tự huỷ query treo, KHÔNG giữ
 * connection trong pool vô thời hạn (nguyên nhân gây dồn ứ tiến trình khi pool cạn).
 */
export async function getLowStockProductsFromStore(
  threshold: number,
  limit = 50,
): Promise<DashboardLiteProduct[]> {
  requireMongo();
  const docs = await ProductModel.find(
    { "data.stock": { $lt: threshold, $gte: 0 } },
    {
      sku: 1,
      "data.id": 1,
      "data.title": 1,
      "data.name": 1,
      "data.sku": 1,
      "data.stock": 1,
    },
  )
    .sort({ "data.stock": 1 })
    .limit(Math.max(1, Math.min(200, limit)))
    .maxTimeMS(6000)
    .lean();
  return (docs as any[]).map((d) => ({
    id: String(d?.data?.id || d?._id || ""),
    title: String(d?.data?.title || d?.data?.name || d?.data?.id || ""),
    sku: String(d?.data?.sku || d?.sku || ""),
    stock: Number(d?.data?.stock) || 0,
    image: null,
  }));
}

export type DashboardStatsResult = {
  totalOrdersInDb: number;
  dashboardOrdersCount: number;
  ordersInRangeCount: number;
  revenue: number;
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
  dailyRevenue: Array<{ date: string; amount: number }>;
  topProducts: Array<{ productId: string; quantitySold: number; title: string | null; image: string | null }>;
};

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
              { $group: { _id: "$_dateKey", amount: { $sum: "$data.totalAmount" } } },
              { $project: { _id: 0, date: "$_id", amount: 1 } },
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
      OrderModel.countDocuments(withDashboard(orderTabFilter("shipping"))).maxTimeMS(6000),
      OrderModel.countDocuments(withDashboard(orderTabFilter("return_pending"))).maxTimeMS(6000),
    ]);

  const facet = facetResult?.[0] || {};
  const kpi = facet.kpi?.[0] || {};

  return {
    totalOrdersInDb,
    dashboardOrdersCount: facet.dashboardOrdersCount?.[0]?.count || 0,
    ordersInRangeCount: kpi.ordersInRangeCount || 0,
    revenue: kpi.revenue || 0,
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
    dailyRevenue: Array.isArray(facet.dailyRevenue) ? facet.dailyRevenue : [],
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
