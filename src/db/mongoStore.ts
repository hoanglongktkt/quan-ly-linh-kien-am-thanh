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
  status?: string | null;
  shopId?: string | null;
  /** Flag bẫy lỗi: đơn đang chờ Shopee kiểm tra — default false */
  is_pending_shopee_check?: boolean;
  data: any;
};

const ProductSchema = new Schema<ProductDoc>(
  {
    _id: { type: String, required: true },
    sku: { type: String, default: null, index: true },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { collection: "products", versionKey: false }
);

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
    shopId: { type: String, default: null, index: true },
    /** Boolean flag — đơn bị bẫy "đang kiểm tra bởi Shopee" (default: false) */
    is_pending_shopee_check: { type: Boolean, default: false, index: true },
    /**
     * Full order payload — includes withholding_cit_tax, shopee_fees,
     * is_handed_over_to_carrier, local_status (HANDED_OVER|CANCELLED_STORED|RETURN_RECEIVED),
     * local_status_updated_at, is_local_return_archived, partialCancel, is_pending_shopee_check
     */
    data: { type: Schema.Types.Mixed, required: true },
  },
  { collection: "orders", versionKey: false }
);

let ProductModel: Model<ProductDoc>;
let ChannelListingModel: Model<ListingDoc>;
let MetaModel: Model<MetaDoc>;
let OrderModel: Model<OrderDoc>;

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

function docsToProducts(docs: Array<{ data?: any }>): any[] {
  const out: any[] = [];
  for (const d of docs) {
    if (d?.data && typeof d.data === "object") out.push(d.data);
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
        maxPoolSize: 3,
        minPoolSize: 1,
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
      `[MongoDB] Connected Successfully — ${getMongoUriMasked()} | products=${productCount} | channel_listings=${listingCount}`
    );

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

  const docs = await ProductModel.find(orClauses.length === 1 ? orClauses[0] : { $or: orClauses }).lean();
  return docsToProducts(docs);
}

/**
 * Tìm sản phẩm kho gốc theo SKU/tên — 1 query Mongo (không N+1).
 * Không lọc warehouse_id cứng (kho hệ thống = collection products Mongo).
 */
export async function searchProductsFromStore(
  query: string,
  limit = 40,
): Promise<any[]> {
  requireMongo();
  const q = String(query || "").trim();
  const safeLimit = Math.min(80, Math.max(1, Math.floor(Number(limit) || 40)));

  let docs: Array<{ data?: any }> = [];
  if (!q) {
    docs = await ProductModel.find({}).sort({ _id: 1 }).limit(safeLimit).lean();
  } else {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(escaped, "i");
    docs = await ProductModel.find({
      $or: [
        { sku: rx },
        { "data.sku": rx },
        { "data.title": rx },
        { "data.modelName": rx },
        { "data.barcode": rx },
        { "data.children.sku": rx },
        { "data.children.title": rx },
        { "data.children.modelName": rx },
        { "data.children_models.sku": rx },
        { "data.children_models.title": rx },
      ],
    })
      .limit(safeLimit)
      .lean();
  }

  const parents = docsToProducts(docs);
  const flat: any[] = [];
  const seen = new Set<string>();
  const qLower = q.toLowerCase();

  const pushRow = (row: any) => {
    if (!row || typeof row !== "object") return;
    const id = String(row.id || "").trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    flat.push(row);
  };

  const matchesQuery = (row: any, extra = ""): boolean => {
    if (!q) return true;
    const hay = `${row?.sku || ""} ${row?.title || ""} ${row?.modelName || ""} ${(row?.tierLabels || []).join(" ")} ${extra}`.toLowerCase();
    return hay.includes(qLower);
  };

  for (const p of parents) {
    const children = Array.isArray(p?.children) && p.children.length
      ? p.children
      : Array.isArray(p?.children_models)
        ? p.children_models
        : [];
    if (children.length > 0) {
      let childMatched = 0;
      for (const c of children) {
        if (!matchesQuery(c, String(p.title || ""))) continue;
        pushRow({
          ...c,
          title: c.title || p.title,
          imageUrl: c.imageUrl || p.imageUrl,
          avatarUrl: c.avatarUrl || p.avatarUrl,
        });
        childMatched += 1;
      }
      if (childMatched === 0 && matchesQuery(p)) pushRow(p);
    } else if (matchesQuery(p)) {
      pushRow(p);
    }
  }

  return flat.slice(0, safeLimit);
}

/**
 * Cộng tồn kho + ghi đè importPrice bằng 1 lần findByIdAndUpdate (hoặc cập nhật child trong parent).
 * Trả về sản phẩm đã cập nhật.
 */
export async function applyImportStockAndPriceToStore(
  productId: string,
  quantityDelta: number,
  importPrice: number,
): Promise<any> {
  requireMongo();
  const id = String(productId || "").trim();
  if (!id) throw new Error("Thiếu productId");
  const qty = Math.max(0, Math.round(Number(quantityDelta) || 0));
  const price = Math.max(0, Math.round(Number(importPrice) || 0));

  // 1) Document top-level
  const direct = await ProductModel.findById(id).lean();
  if (direct?.data && typeof direct.data === "object") {
    const before = direct.data;
    const nextStock = Math.max(0, Math.round(Number(before.stock) || 0) + qty);
    const merged = {
      ...before,
      stock: nextStock,
      importPrice: price,
      status: nextStock <= 0 && before.status !== "draft" ? "out_of_stock" : before.status === "out_of_stock" ? "active" : before.status,
      lastSynced: new Date().toISOString(),
    };
    await ProductModel.findByIdAndUpdate(
      id,
      { $set: { data: merged, sku: merged.sku != null ? String(merged.sku) : null } },
      { new: true },
    );
    return merged;
  }

  // 2) Child trong parent — 1 query tìm parent chứa child
  const parentDoc = await ProductModel.findOne({
    $or: [{ "data.children.id": id }, { "data.children_models.id": id }],
  }).lean();
  if (!parentDoc?.data || typeof parentDoc.data !== "object") {
    throw new Error(`Không tìm thấy sản phẩm id=${id} trong kho Mongo`);
  }

  const parent = { ...parentDoc.data };
  const childKey = Array.isArray(parent.children) && parent.children.some((c: any) => String(c?.id) === id)
    ? "children"
    : "children_models";
  const children = Array.isArray(parent[childKey]) ? [...parent[childKey]] : [];
  const idx = children.findIndex((c: any) => String(c?.id || "").trim() === id);
  if (idx < 0) throw new Error(`Không tìm thấy biến thể id=${id}`);

  const beforeChild = children[idx];
  const nextStock = Math.max(0, Math.round(Number(beforeChild.stock) || 0) + qty);
  const mergedChild = {
    ...beforeChild,
    stock: nextStock,
    importPrice: price,
    status: nextStock <= 0 && beforeChild.status !== "draft" ? "out_of_stock" : beforeChild.status === "out_of_stock" ? "active" : beforeChild.status,
    lastSynced: new Date().toISOString(),
  };
  children[idx] = mergedChild;
  const totalStock = children.reduce((s: number, c: any) => s + (Math.max(0, Math.round(Number(c.stock) || 0))), 0);
  const mergedParent = {
    ...parent,
    [childKey]: children,
    stock: totalStock,
    lastSynced: new Date().toISOString(),
  };
  await ProductModel.findByIdAndUpdate(
    parentDoc._id,
    { $set: { data: mergedParent, sku: mergedParent.sku != null ? String(mergedParent.sku) : null } },
    { new: true },
  );
  return mergedChild;
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

/** Ghi đè toàn bộ products — deleteMany + insertMany (await). */
export async function saveProductsToStoreAsync(products: any[]): Promise<void> {
  requireMongo();
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  const docs = toProductDocs(list);

  await enqueueWrite(async () => {
    await ProductModel.deleteMany({});
    if (docs.length > 0) {
      await ProductModel.insertMany(docs, { ordered: false });
    }
    await setMeta("products_updated_at", new Date().toISOString());
    console.log(`[MongoDB] insertMany products — ${docs.length} dòng`);
  });
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

/** Upsert lô đơn hàng bằng bulkWrite (1 lệnh / tối đa ~25 đơn). */
export async function bulkUpsertOrdersToStore(orders: any[]): Promise<number> {
  requireMongo();
  const list = Array.isArray(orders)
    ? orders.filter((o) => o != null && typeof o === "object")
    : [];
  const ops = [];
  for (const order of list) {
    const id = String(order.id || "").trim();
    const orderSn = String(order.orderSn || "").trim();
    if (!id && !orderSn) continue;
    const _id = id || `shopee-${orderSn}`;
    const pendingFlag = order.is_pending_shopee_check === true;
    ops.push({
      updateOne: {
        filter: { _id },
        update: {
          $set: {
            _id,
            orderSn: orderSn || null,
            status: order.status != null ? String(order.status) : null,
            shopId: order.shopId != null ? String(order.shopId) : null,
            is_pending_shopee_check: pendingFlag,
            data: { ...order, id: _id, is_pending_shopee_check: pendingFlag },
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length === 0) return 0;

  await enqueueWrite(async () => {
    const result = await OrderModel.bulkWrite(ops as any, { ordered: false });
    await setMeta("orders_updated_at", new Date().toISOString());
    console.log(
      `[MongoDB] bulkWrite orders — upserted=${result.upsertedCount || 0} modified=${result.modifiedCount || 0} matched=${result.matchedCount || 0}`,
    );
  });
  return ops.length;
}

/** Cưỡng bức update flag is_pending_shopee_check theo order_sn (JSON sync caller + Mongo). */
export async function updateOrderPendingShopeeCheckInStore(
  orderSn: string,
  isPending: boolean,
  patch?: Record<string, unknown>,
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").trim();
  if (!sn) return false;
  const _id = `shopee-${sn}`;
  const $set: Record<string, unknown> = {
    is_pending_shopee_check: isPending,
    "data.is_pending_shopee_check": isPending,
  };
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      $set[k] = v;
      $set[`data.${k}`] = v;
    }
  }
  const result = await OrderModel.updateOne(
    { $or: [{ orderSn: sn }, { _id }, { "data.orderSn": sn }] },
    { $set },
  );
  console.log(
    `[MongoDB] updateOne is_pending_shopee_check=${isPending} order_sn=${sn} matched=${result.matchedCount} modified=${result.modifiedCount}`,
  );
  return (result.matchedCount || 0) > 0 || (result.modifiedCount || 0) > 0;
}

/** findOneAndUpdate tracking_no / trackingNumber vào Mongo theo order_sn. */
export async function updateOrderTrackingInStore(
  orderSn: string,
  trackingNo: string,
  extra?: { internalTrackingCode?: string; packageNumber?: string },
): Promise<boolean> {
  if (!isMongoReady()) return false;
  requireMongo();
  const sn = String(orderSn || "").trim();
  const tn = String(trackingNo || "").trim();
  if (!sn || !tn) return false;
  const _id = `shopee-${sn}`;
  const $set: Record<string, unknown> = {
    tracking_no: tn,
    "data.tracking_no": tn,
    "data.trackingNumber": tn,
  };
  if (extra?.internalTrackingCode) {
    $set["data.internalTrackingCode"] = extra.internalTrackingCode;
  }
  if (extra?.packageNumber) {
    $set["data.packageNumber"] = extra.packageNumber;
  }
  const result = await OrderModel.findOneAndUpdate(
    { $or: [{ orderSn: sn }, { _id }, { "data.orderSn": sn }] },
    { $set },
    { new: true, upsert: false },
  );
  console.log(
    `[MongoDB] findOneAndUpdate tracking_no=${tn} order_sn=${sn} ok=${Boolean(result)}`,
  );
  return Boolean(result);
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
