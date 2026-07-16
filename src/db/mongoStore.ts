/**
 * MongoDB Atlas — Single Source of Truth cho products + channel_listings.
 * Dùng Mongoose (pure JS, không cần native addon).
 *
 * Env: MONGODB_URI (hoặc MONGO_URL)
 * Runtime: in-memory cache + persist async lên Atlas.
 */
import mongoose, { Schema, type Model } from "mongoose";

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

let ProductModel: Model<ProductDoc>;
let ChannelListingModel: Model<ListingDoc>;
let MetaModel: Model<MetaDoc>;

let productsCache: any[] = [];
let listingsCache: any[] = [];
let mongoReady = false;
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

function enqueueWrite(task: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(task).catch((err) => {
    console.error("[MongoDB] Persist failed:", err);
  });
  return writeChain;
}

export function isMongoReady(): boolean {
  return mongoReady && mongoose.connection.readyState === 1;
}

export function getMongoUriMasked(): string {
  const uri = getMongoUri();
  if (!uri) return "(missing MONGODB_URI)";
  return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}

/** Kết nối Atlas + nạp cache vào RAM. */
export async function initMongo(): Promise<void> {
  const uri = getMongoUri();
  if (!uri) {
    console.warn(
      "[MongoDB] Thiếu MONGODB_URI — chạy memory-only. Thêm Connection String Atlas vào .env rồi restart."
    );
    mongoReady = false;
    productsCache = [];
    listingsCache = [];
    return;
  }

  ensureModels();

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 5,
    });
  }

  const [productDocs, listingDocs] = await Promise.all([
    ProductModel.find({}).lean(),
    ChannelListingModel.find({}).lean(),
  ]);

  productsCache = productDocs
    .map((d) => (d?.data && typeof d.data === "object" ? d.data : null))
    .filter(Boolean) as any[];
  listingsCache = listingDocs
    .map((d) => (d?.data && typeof d.data === "object" ? d.data : null))
    .filter(Boolean) as any[];

  mongoReady = true;
  console.log(
    `[MongoDB] Connected ${getMongoUriMasked()} — products=${productsCache.length}, listings=${listingsCache.length}`
  );
}

export function loadProductsFromStore(): any[] {
  return productsCache;
}

export function loadChannelListingsFromStore(): any[] {
  return listingsCache;
}

export function countProducts(): number {
  return productsCache.length;
}

export function countChannelListings(): number {
  return listingsCache.length;
}

export function buildLocalInventoryCacheFromStore(): LocalInventoryCache {
  return {
    updatedAt: new Date().toISOString(),
    products: productsCache,
    listings: listingsCache,
  };
}

async function setMeta(key: string, value: string): Promise<void> {
  if (!isMongoReady()) return;
  ensureModels();
  await MetaModel.findByIdAndUpdate(key, { value }, { upsert: true });
}

async function persistProducts(list: any[]): Promise<void> {
  if (!isMongoReady()) {
    console.warn("[MongoDB] saveProducts skipped — chưa kết nối Atlas");
    return;
  }
  ensureModels();
  const docs = toProductDocs(list);
  await ProductModel.deleteMany({});
  if (docs.length > 0) {
    await ProductModel.insertMany(docs, { ordered: false });
  }
  await setMeta("products_updated_at", new Date().toISOString());
  console.log(`[MongoDB] saveProducts — ${docs.length} dòng`);
}

async function persistListings(list: any[]): Promise<void> {
  if (!isMongoReady()) {
    console.warn("[MongoDB] saveChannelListings skipped — chưa kết nối Atlas");
    return;
  }
  ensureModels();
  const docs = toListingDocs(list);
  await ChannelListingModel.deleteMany({});
  if (docs.length > 0) {
    await ChannelListingModel.insertMany(docs, { ordered: false });
  }
  await setMeta("listings_updated_at", new Date().toISOString());
  console.log(`[MongoDB] saveChannelListings — ${docs.length} dòng`);
}

/** Ghi products: cập nhật RAM ngay + queue persist Atlas. */
export function saveProductsToStore(products: any[]): void {
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  productsCache = list;
  void enqueueWrite(() => persistProducts(list));
}

export async function saveProductsToStoreAsync(products: any[]): Promise<void> {
  const list = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  productsCache = list;
  await enqueueWrite(() => persistProducts(list));
}

export function saveChannelListingsToStore(rows: any[]): void {
  const list = Array.isArray(rows)
    ? rows.filter((r) => r != null && typeof r === "object")
    : [];
  listingsCache = list;
  void enqueueWrite(() => persistListings(list));
}

export async function saveChannelListingsToStoreAsync(rows: any[]): Promise<void> {
  const list = Array.isArray(rows)
    ? rows.filter((r) => r != null && typeof r === "object")
    : [];
  listingsCache = list;
  await enqueueWrite(() => persistListings(list));
}

/** Upsert 1 listing — RAM + Atlas (không rewrite cả bảng). */
export async function upsertChannelListingToStore(row: any): Promise<any> {
  if (!row || typeof row !== "object") {
    throw new Error("upsertChannelListing: row không hợp lệ");
  }
  const id = String(row.id || "").trim();
  if (!id) throw new Error("upsertChannelListing: thiếu id");

  const idx = listingsCache.findIndex((r) => String(r?.id || "").trim() === id);
  if (idx >= 0) listingsCache[idx] = row;
  else listingsCache.push(row);

  if (!isMongoReady()) {
    console.warn("[MongoDB] upsert listing skipped — chưa kết nối Atlas");
    return row;
  }

  ensureModels();
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
    { upsert: true }
  );
  await setMeta("listings_updated_at", new Date().toISOString());
  return row;
}

export async function deleteAllProductsFromStore(): Promise<void> {
  productsCache = [];
  if (!isMongoReady()) return;
  ensureModels();
  await ProductModel.deleteMany({});
  await setMeta("products_updated_at", new Date().toISOString());
}

export async function deleteAllChannelListingsFromStore(): Promise<void> {
  listingsCache = [];
  if (!isMongoReady()) return;
  ensureModels();
  await ChannelListingModel.deleteMany({});
  await setMeta("listings_updated_at", new Date().toISOString());
}

export async function flushDbWrites(): Promise<void> {
  await writeChain;
}

/** Seed cache từ mảng (migrate boot) rồi persist nếu đã connect. */
export async function seedStoreFromArrays(
  products: any[],
  listings: any[]
): Promise<void> {
  productsCache = Array.isArray(products)
    ? products.filter((p) => p != null && typeof p === "object")
    : [];
  listingsCache = Array.isArray(listings)
    ? listings.filter((r) => r != null && typeof r === "object")
    : [];
  if (!isMongoReady()) return;
  await persistProducts(productsCache);
  await persistListings(listingsCache);
}
