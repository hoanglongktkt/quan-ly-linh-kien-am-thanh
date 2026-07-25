/**
 * MongoDB Atlas — Single Source of Truth.
 * Mọi đọc: await Model.find({})
 * Mọi ghi: await insertMany / findOneAndUpdate / deleteMany
 * KHÔNG dùng mảng in-memory làm nguồn dữ liệu.
 */
import mongoose, { Schema, type Model } from "mongoose";
import fs from "fs";
import path from "path";

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

const ORDER_EVENT_TTL_SECONDS = Math.max(
  24 * 60 * 60,
  Number(process.env.ORDER_EVENT_TTL_SECONDS || 60 * 24 * 60 * 60),
);
const SYNC_JOB_TTL_SECONDS = Math.max(
  24 * 60 * 60,
  Number(process.env.SYNC_JOB_TTL_SECONDS || 60 * 24 * 60 * 60),
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
    isPrinted: { type: Boolean, default: false },
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

let ProductModel: Model<ProductDoc>;
let ChannelListingModel: Model<ListingDoc>;
let MetaModel: Model<MetaDoc>;
let OrderModel: Model<OrderDoc>;
let OrderEventModel: Model<OrderEventDoc>;
let SyncJobModel: Model<SyncJobDoc>;

let mongoReady = false;
let appRootResolved = "";
/** Serialize writes to avoid concurrent replace races. */
let writeChain: Promise<void> = Promise.resolve();

function getMongoUri(): string {
  return String(process.env.MONGODB_URI || process.env.MONGO_URL || "").trim();
}

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

  const uri = getMongoUri();
  console.log(`[MongoDB] Boot — APP_ROOT=${appRootResolved}`);
  console.log(`[MongoDB] Boot — URI=${getMongoUriMasked()}`);

  if (!uri) {
    mongoReady = false;
    console.error(
      "LỖI MONGODB STARTUP:",
      "thiếu MONGODB_URI / MONGO_URL trong .env hoặc Environment Variables."
    );
    return false;
  }

  try {
    ensureModels();
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        // Tăng 5→15: pool 5 quá nhỏ khi Dashboard/Products/Orders + Webhook cùng chạy
        // song song — hết pool khiến query MỚI phải XẾP HÀNG chờ connection (không lỗi
        // ngay) và có thể "treo" tới khi client-side timeout bắn, dù bản thân query rất
        // nhẹ. Đây là driver Node (I/O bất đồng bộ, dùng chung 1 process) — KHÔNG tạo
        // thêm OS process nên an toàn với giới hạn NPROC hosting nhỏ.
        maxPoolSize: 15,
        minPoolSize: 1,
        // Nếu pool vẫn hết, THẤT BẠI NHANH thay vì chờ vô thời hạn — trả lỗi rõ ràng
        // để route trả response ngay (tránh cộng dồn request treo → cPanel tăng process).
        waitQueueTimeoutMS: 8000,
        maxIdleTimeMS: 30000,
      });
      fs.writeFileSync(
        path.join(appRootResolved, "db_status.txt"),
        "KET_NOI_THANH_CONG_LUC: " + new Date().toISOString()
      );
    }

    mongoReady = mongoose.connection.readyState === 1;
    if (!mongoReady) {
      console.error(
        "LỖI MONGODB STARTUP:",
        `mongoose readyState=${mongoose.connection.readyState} (expect 1)`
      );
      return false;
    }

    const [productCount, listingCount] = await Promise.all([
      ProductModel.countDocuments(),
      ChannelListingModel.countDocuments(),
    ]);

    console.log("MongoDB Connected Successfully");
    console.log(
      `[MongoDB] Connected Successfully — ${getMongoUriMasked()} | products=${productCount} | channel_listings=${listingCount} | warehouse=KhoGoc(collection:products)`
    );

    try {
      await ProductModel.syncIndexes();
      console.log("[MongoDB] Product indexes synced (sku, data.sku, text title/sku, children.sku)");
    } catch (idxErr) {
      console.warn("[MongoDB] syncIndexes products:", idxErr);
    }

    try {
      await OrderModel.syncIndexes();
      console.log("[MongoDB] Order indexes synced (orderSn, shopId, orderSn+shopId compound)");
    } catch (idxErr) {
      console.warn("[MongoDB] syncIndexes orders:", idxErr);
    }
    try {
      await Promise.all([OrderEventModel.syncIndexes(), SyncJobModel.syncIndexes()]);
      console.log(
        `[MongoDB] Retention indexes synced (order_events=${ORDER_EVENT_TTL_SECONDS}s, sync_jobs=${SYNC_JOB_TTL_SECONDS}s)`,
      );
    } catch (idxErr) {
      console.warn("[MongoDB] syncIndexes order events/jobs:", idxErr);
    }

    // One-time migrate từ JSON local nếu Atlas trống
    if (productCount === 0 && listingCount === 0) {
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
    return false;
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

/** Đọc products TRỰC TIẾP từ MongoDB — Model.find({}) */
export async function loadProductsFromStore(): Promise<any[]> {
  requireMongo();
  const docs = await ProductModel.find({}).lean();
  return docsToProducts(docs);
}

/** Đọc 1 product theo id nội bộ / shopeeItemId — không quét toàn bộ catalog. */
export async function loadProductByIdFromStore(productId: string): Promise<any | null> {
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
    if (child) return child;
  }

  // Biến thể lưu trong children_models (search flatten dùng field này)
  const byChildModel = await ProductModel.findOne({ "data.children_models.id": id }).lean();
  if (byChildModel?.data && typeof byChildModel.data === "object") {
    const models = Array.isArray(byChildModel.data.children_models)
      ? byChildModel.data.children_models
      : [];
    const child = models.find((c: any) => String(c?.id || "").trim() === id);
    if (child) {
      return {
        ...child,
        title: child.title || byChildModel.data.title,
        imageUrl: child.imageUrl || byChildModel.data.imageUrl,
        avatarUrl: child.avatarUrl || byChildModel.data.avatarUrl,
      };
    }
  }

  const byModel = await ProductModel.findOne({ "data.shopeeModelId": id }).lean();
  if (byModel?.data && typeof byModel.data === "object") return byModel.data;

  return null;
}

/** Chỉ kéo products liên quan tới danh sách id / shopeeItemId (dùng $in, không find({})). */
export async function loadProductsByIdsFromStore(
  productIds: string[],
  shopeeItemIds: string[] = [],
): Promise<any[]> {
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
 * Tìm sản phẩm Kho Gốc (collection `products`) — CHỈ Mongo nội bộ, không gọi Shopee.
 * Ưu tiên exact SKU → prefix SKU → regex tên. Trả field lean.
 */
export async function searchProductsFromStore(
  query: string,
  limit = 40,
): Promise<any[]> {
  requireMongo();
  const q = String(query || "").trim();
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
  const parentFetchLimit = Math.min(120, Math.max(safeLimit * 2, 40));
  const qLower = q.toLowerCase();

  let docs: Array<{ _id?: any; data?: any; sku?: string | null }> = [];

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
      const seen = new Set(docs.map((d) => String(d._id)));
      for (const d of more) {
        const key = String(d._id);
        if (seen.has(key)) continue;
        seen.add(key);
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
      const seen = new Set(docs.map((d) => String(d._id)));
      for (const d of more) {
        const key = String(d._id);
        if (seen.has(key)) continue;
        seen.add(key);
        docs.push(d);
      }
    }

    console.log("[MongoSearch] KhoGoc products", {
      q,
      parentHits: docs.length,
      sampleSkus: docs.slice(0, 5).map((d) => d?.sku || d?.data?.sku),
    });
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

/** Đọc channel_listings TRỰC TIẾP từ MongoDB — Model.find({}) */
export async function loadChannelListingsFromStore(): Promise<any[]> {
  requireMongo();
  const docs = await ChannelListingModel.find({}).lean();
  return docsToListings(docs);
}

export async function countProducts(): Promise<number> {
  requireMongo();
  return ProductModel.countDocuments();
}

export async function countChannelListings(): Promise<number> {
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
  requireMongo();
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  const docs = toProductDocs(list);

  await enqueueWrite(async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await ProductModel.deleteMany({}, { session });
        if (docs.length > 0) {
          await ProductModel.insertMany(docs, { ordered: false, session });
        }
        await setMeta("products_updated_at", new Date().toISOString());
      });
    } finally {
      await session.endSession();
    }
    console.log(`[MongoDB] insertMany products — ${docs.length} dòng`);
  });
}

/** Upsert theo id — dùng cho thêm/sửa/sync để không tạo khoảng trống toàn collection. */
export async function upsertProductsToStoreAsync(products: any[]): Promise<number> {
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

/** Ghi đè toàn bộ channel_listings — deleteMany + insertMany (await). */
export async function saveChannelListingsToStoreAsync(rows: any[]): Promise<void> {
  requireMongo();
  const list = Array.isArray(rows)
    ? rows.filter((r) => r != null && typeof r === "object")
    : [];
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

/** Upsert 1 listing — findOneAndUpdate / findByIdAndUpdate. */
export async function upsertChannelListingToStore(row: any): Promise<any> {
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
 * Upsert lô channel_listings bằng bulkWrite (1 lệnh Mongo / lô).
 * Dùng cho auto-map hàng loạt — tránh N lần findByIdAndUpdate (NPROC/CageFS).
 */
export async function bulkUpsertChannelListingsToStore(rows: any[]): Promise<number> {
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
  requireMongo();
  await ProductModel.deleteMany({});
  await setMeta("products_updated_at", new Date().toISOString());
}

export async function deleteAllChannelListingsFromStore(): Promise<void> {
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

    const event: OrderEventDoc | null = orderSn
      ? {
          _id: `order-event-${orderSn}-${Date.now()}-${pendingWrites.length}`,
          orderSn,
          shopId: shopIdStr || null,
          source: String(order.sync_source || "shopee_sync"),
          next_status: order.status != null ? String(order.status) : null,
          next_shopee_status: rawStatus || null,
          logistics_status:
            order.logistics_status != null ? String(order.logistics_status) : null,
          occurred_at: new Date(),
          payload: {
            tracking_no: usableTn,
            package_number: order.packageNumber || null,
            shopee_update_at: incomingUpdateAt?.toISOString() || null,
          },
        }
      : null;
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
      event,
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
        const events = accepted.flatMap((item) => (item.event ? [item.event] : []));
        if (ops.length === 0) return;
        const result = await OrderModel.bulkWrite(ops as any, { ordered: false });
        await setMeta("orders_updated_at", new Date().toISOString());
        if (events.length > 0) {
          await OrderEventModel.insertMany(events, { ordered: false });
        }
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
    const data = d?.data && typeof d.data === "object" ? { ...d.data } : {};
    const sn = String(d?.orderSn || data.orderSn || String(d?._id || "").replace(/^shopee-/i, ""))
      .trim();
    if (!sn && !d?._id) continue;
    const tn = String(
      d?.tracking_no || data.tracking_no || data.trackingNumber || "",
    ).trim();
    const rawStatus = String(
      d?.shopee_order_status || data.shopee_order_status || "",
    )
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
      String(data.local_status || data.localStatus || "").toUpperCase() === "HANDED_OVER";
    out.push({
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
      ...(handed
        ? {
            local_status: data.local_status || "HANDED_OVER",
            localStatus: data.localStatus || "HANDED_OVER",
            internal_status: data.internal_status || "HANDED_OVER",
          }
        : {}),
    });
  }
  return out;
}

export type OrdersPageQuery = {
  page?: number;
  pageSize?: number;
  tab?: string;
  shopId?: string;
  carrier?: string;
  query?: string;
};

function orderTabFilter(tab?: string): Record<string, unknown> {
  switch (String(tab || "").trim()) {
    case "shipping":
      return {
        $or: [
          { status: "shipping" },
          { shopee_order_status: { $in: ["SHIPPED", "TO_CONFIRM_RECEIVE"] } },
        ],
      };
    case "completed":
      return { $or: [{ status: "completed" }, { shopee_order_status: "COMPLETED" }] };
    case "cancelled":
      return { $or: [{ status: "cancelled" }, { shopee_order_status: { $in: ["CANCELLED", "IN_CANCEL"] } }] };
    case "processed":
      return { status: "processed", shopee_order_status: { $nin: ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"] } };
    case "unprocessed":
      return { status: "unprocessed", shopee_order_status: { $nin: ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"] } };
    case "pending_confirm":
      return { status: { $in: ["pending_confirm", "pending_verification"] } };
    case "handed_over_carrier":
      return { is_handed_over: true, shopee_order_status: { $nin: ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"] } };
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
  if (opts?.shopId && opts.shopId !== "all") and.push({ shopId: String(opts.shopId) });
  if (opts?.carrier && opts.carrier !== "all") and.push({ shipping_carrier: String(opts.carrier) });
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
  const [total, docs, grouped] = await Promise.all([
    OrderModel.countDocuments(filter).maxTimeMS(8000),
    OrderModel.find(filter)
      .sort({ "data.date": -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .select({ _id: 1 })
      .maxTimeMS(8000)
      .lean(),
    OrderModel.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).option({ maxTimeMS: 8000 }),
  ]);
  const ids = docs.map((doc: any) => String(doc._id));
  const hydrated = await loadOrdersFromStore({ ids });
  const rowById = new Map(hydrated.map((row: any) => [String(row.id || ""), row]));
  const rows = ids.map((id) => rowById.get(id)).filter(Boolean);
  const counts: Record<string, number> = { all: 0 };
  for (const row of grouped as any[]) {
    const key = String(row?._id || "");
    if (key) counts[key] = Number(row?.count || 0);
    counts.all += Number(row?.count || 0);
  }
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

  const [totalOrdersInDb, facetResult] = await Promise.all([
    OrderModel.estimatedDocumentCount().maxTimeMS(3000),
    OrderModel.aggregate([
      { $match: isDashboardOrderMatch },
      {
        $addFields: {
          // So khớp theo NGÀY (10 ký tự đầu ISO) — đúng hành vi isDateInRange cũ.
          _dateKey: { $substrCP: [{ $ifNull: ["$data.date", ""] }, 0, 10] },
          // Ưu tiên data.isPrepared (được cập nhật khi gán tracking) hơn cờ top-level
          // (top-level chỉ set 1 lần lúc insert nên luôn "false" — không phản ánh trạng thái mới).
          _isPrepared: {
            $ifNull: ["$data.isPrepared", { $ifNull: ["$isPrepared", false] }],
          },
        },
      },
      {
        // LƯU Ý: MongoDB CẤM lồng $facet trong $facet — nên mỗi nhánh range-dependent
        // (kpi/dailyRevenue/topProducts) tự $match theo _dateKey ở đầu nhánh của nó,
        // thay vì dùng $facet lồng bên trong nhánh "inRange".
        $facet: {
          dashboardOrdersCount: [{ $count: "count" }],
          pendingOrders: [
            {
              $group: {
                _id: null,
                pendingApproval: { $sum: { $cond: [{ $eq: ["$status", "pending_confirm"] }, 1, 0] } },
                pendingPayment: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$status", "pending_confirm"] }, { $eq: ["$data.channel", "manual"] }] },
                      1,
                      0,
                    ],
                  },
                },
                pendingPack: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: ["$status", "unprocessed"] }, { $ne: ["$_isPrepared", true] }] },
                      1,
                      0,
                    ],
                  },
                },
                pendingPickup: {
                  $sum: {
                    $cond: [
                      {
                        $or: [
                          { $and: [{ $eq: ["$status", "unprocessed"] }, { $eq: ["$_isPrepared", true] }] },
                          { $eq: ["$status", "processed"] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                shipping: { $sum: { $cond: [{ $eq: ["$status", "shipping"] }, 1, 0] } },
                returnPending: { $sum: { $cond: [{ $eq: ["$status", "return_pending"] }, 1, 0] } },
              },
            },
          ],
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
                  $sum: { $cond: [{ $in: ["$status", ["pending_confirm", "unprocessed"]] }, 1, 0] },
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
  ]);

  const facet = facetResult?.[0] || {};
  const pending = facet.pendingOrders?.[0] || {};
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
      pendingApproval: pending.pendingApproval || 0,
      pendingPayment: pending.pendingPayment || 0,
      pendingPack: pending.pendingPack || 0,
      pendingPickup: pending.pendingPickup || 0,
      shipping: pending.shipping || 0,
      returnPending: pending.returnPending || 0,
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
