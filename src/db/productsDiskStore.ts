/**
 * Kho Gốc trên đĩa hosting (data/products.json) — không dùng Mongo Atlas.
 * Bật bằng PRODUCTS_STORAGE=disk | json | file
 */
import fs from "fs";
import path from "path";

export function isProductsDiskMode(): boolean {
  // Mặc định disk (hosting) — Atlas free dễ đầy. Set PRODUCTS_STORAGE=mongo để dùng Atlas.
  const raw = process.env.PRODUCTS_STORAGE ?? process.env.PRODUCTS_DISK;
  if (raw == null || String(raw).trim() === "") return true;
  const v = String(raw).trim().toLowerCase();
  if (v === "mongo" || v === "atlas" || v === "0" || v === "false" || v === "off") {
    return false;
  }
  return (
    v === "disk" ||
    v === "json" ||
    v === "file" ||
    v === "1" ||
    v === "true" ||
    v === "on"
  );
}

let appRootResolved = "";
let productsCache: { mtimeMs: number; products: any[] } | null = null;
let writeChain: Promise<void> = Promise.resolve();

export function setProductsDiskAppRoot(appRoot: string): void {
  appRootResolved = String(appRoot || "").trim();
}

function resolveAppRoot(): string {
  if (appRootResolved) return appRootResolved;
  return process.cwd();
}

export function getProductsDiskPath(): string {
  return path.join(resolveAppRoot(), "data", "products.json");
}

function ensureDataDir(): void {
  const dir = path.dirname(getProductsDiskPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeProduct(p: any): any | null {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").trim();
  if (!id) return null;
  return { ...p, id };
}

export function readProductsFromDisk(): any[] {
  const file = getProductsDiskPath();
  if (!fs.existsSync(file)) {
    productsCache = { mtimeMs: 0, products: [] };
    return [];
  }
  const st = fs.statSync(file);
  if (productsCache && productsCache.mtimeMs === st.mtimeMs) {
    return productsCache.products;
  }
  try {
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    const products = (Array.isArray(parsed) ? parsed : [])
      .map(normalizeProduct)
      .filter(Boolean) as any[];
    productsCache = { mtimeMs: st.mtimeMs, products };
    return products;
  } catch (err: any) {
    console.error("[Products Disk] Đọc products.json thất bại:", err?.message || err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

function writeProductsToDiskSync(products: any[]): void {
  ensureDataDir();
  const file = getProductsDiskPath();
  const list = (Array.isArray(products) ? products : [])
    .map(normalizeProduct)
    .filter(Boolean) as any[];
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(list), "utf-8");
  fs.renameSync(tmp, file);
  try {
    const st = fs.statSync(file);
    productsCache = { mtimeMs: st.mtimeMs, products: list };
  } catch {
    productsCache = { mtimeMs: Date.now(), products: list };
  }
  console.log(`[Products Disk] WRITE OK — path=${file} count=${list.length}`);
}

export async function saveProductsToDisk(products: any[]): Promise<void> {
  const run = writeChain.then(() => {
    writeProductsToDiskSync(products);
  });
  writeChain = run.catch(() => undefined);
  await run;
}

export async function upsertProductsToDisk(products: any[]): Promise<number> {
  const incoming = (Array.isArray(products) ? products : [])
    .map(normalizeProduct)
    .filter(Boolean) as any[];
  if (incoming.length === 0) return 0;
  const current = readProductsFromDisk();
  const byId = new Map(current.map((p) => [String(p.id), p]));
  for (const p of incoming) byId.set(String(p.id), { ...byId.get(String(p.id)), ...p, id: p.id });
  await saveProductsToDisk([...byId.values()]);
  return incoming.length;
}

export async function deleteProductsByIdsFromDisk(ids: string[]): Promise<number> {
  const safe = new Set(ids.map((id) => String(id || "").trim()).filter(Boolean));
  if (safe.size === 0) return 0;
  const current = readProductsFromDisk();
  const kept = current.filter((p) => !safe.has(String(p.id || "").trim()));
  const deleted = current.length - kept.length;
  if (deleted > 0) await saveProductsToDisk(kept);
  return deleted;
}

export function countProductsOnDisk(): number {
  return readProductsFromDisk().length;
}

export function loadProductsPageFromDisk(
  page = 1,
  pageSize = 50,
): {
  products: any[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasMore: boolean;
} {
  const all = readProductsFromDisk();
  const safePage = Math.max(1, Math.floor(Number(page) || 1));
  const safeSize = Math.min(50, Math.max(1, Math.floor(Number(pageSize) || 50)));
  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / safeSize) || 1);
  const currentPage = Math.min(safePage, totalPages);
  const start = (currentPage - 1) * safeSize;
  return {
    products: all.slice(start, start + safeSize),
    total,
    page: currentPage,
    pageSize: safeSize,
    totalPages,
    hasMore: currentPage < totalPages,
  };
}

function productMatchKeys(p: any): string[] {
  const keys = [
    p?.id,
    p?.sku,
    p?.shopeeItemId,
    p?.shopeeModelId,
    p?.barcode,
  ];
  for (const c of Array.isArray(p?.children) ? p.children : []) {
    keys.push(c?.id, c?.sku, c?.shopeeModelId);
  }
  for (const c of Array.isArray(p?.children_models) ? p.children_models : []) {
    keys.push(c?.id, c?.sku, c?.shopeeModelId);
  }
  return keys.map((k) => String(k || "").trim()).filter(Boolean);
}

export function loadProductByIdFromDisk(productId: string): any | null {
  const id = String(productId || "").trim();
  if (!id) return null;
  const all = readProductsFromDisk();
  for (const p of all) {
    if (String(p.id || "").trim() === id) return p;
    if (String(p.shopeeItemId || "").trim() === id) return p;
    if (String(p.shopeeModelId || "").trim() === id) return p;
    for (const key of ["children", "children_models"] as const) {
      const list = Array.isArray(p[key]) ? p[key] : [];
      const child = list.find(
        (c: any) =>
          String(c?.id || "").trim() === id ||
          String(c?.shopeeModelId || "").trim() === id,
      );
      if (child) {
        return {
          ...child,
          title: child.title || p.title,
          imageUrl: child.imageUrl || p.imageUrl,
          avatarUrl: child.avatarUrl || p.avatarUrl,
        };
      }
    }
  }
  return null;
}

export function loadProductsByIdsFromDisk(
  productIds: string[],
  shopeeItemIds: string[] = [],
): any[] {
  const wanted = new Set(
    [...productIds, ...shopeeItemIds].map((v) => String(v || "").trim()).filter(Boolean),
  );
  if (wanted.size === 0) return [];
  return readProductsFromDisk().filter((p) =>
    productMatchKeys(p).some((k) => wanted.has(k) || wanted.has(`shopee-item-${k}`)),
  );
}

export function searchProductsFromDisk(query: string, limit = 40): any[] {
  const q = String(query || "").trim().toLowerCase();
  const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 40)));
  const all = readProductsFromDisk();
  if (!q) return all.slice(0, safeLimit);

  const scored: Array<{ p: any; score: number }> = [];
  for (const p of all) {
    const sku = String(p.sku || "").toLowerCase();
    const title = String(p.title || "").toLowerCase();
    let score = 0;
    if (sku === q) score = 300;
    else if (sku.startsWith(q)) score = 200;
    else if (sku.includes(q)) score = 120;
    else if (title.includes(q)) score = 80;
    else {
      const childHit = [...(p.children || []), ...(p.children_models || [])].some((c: any) => {
        const csku = String(c?.sku || "").toLowerCase();
        const ctitle = String(c?.title || c?.modelName || "").toLowerCase();
        return csku === q || csku.startsWith(q) || csku.includes(q) || ctitle.includes(q);
      });
      if (childHit) score = 90;
    }
    if (score > 0) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, safeLimit).map((x) => x.p);
}

export async function applyImportStockAndPriceOnDisk(
  productId: string,
  quantityDelta: number,
  importPrice: number,
  opts?: { skuHint?: string },
): Promise<{
  product: any;
  oldStock: number;
  newStock: number;
  oldImportPrice: number;
  newImportPrice: number;
  target: "parent" | "child";
  parentId?: string;
  warehouse: "KhoGoc";
  collection: "products";
}> {
  const id = String(productId || "").trim();
  const skuHint = String(opts?.skuHint || "").trim();
  if (!id && !skuHint) throw new Error("Thiếu productId/sku để cập nhật Kho Gốc");
  const qty = Math.round(Number(quantityDelta) || 0);
  const price = Math.max(0, Math.round(Number(importPrice) || 0));

  const all = readProductsFromDisk();
  let parentIdx = -1;
  let mode: "parent" | "child" = "parent";
  let childKey: "children" | "children_models" | null = null;
  let childIdx = -1;

  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    const parentMatch =
      (id && String(p.id || "").trim() === id) ||
      (skuHint && String(p.sku || "").trim().toLowerCase() === skuHint.toLowerCase());
    const cKey: "children" | "children_models" | null =
      Array.isArray(p.children) && p.children.length
        ? "children"
        : Array.isArray(p.children_models) && p.children_models.length
          ? "children_models"
          : null;
    if (cKey) {
      const children = p[cKey] as any[];
      const cIdx = children.findIndex((c) => {
        const cid = String(c?.id || c?.shopeeModelId || "").trim();
        const csku = String(c?.sku || "").trim();
        return (id && cid === id) || (skuHint && csku.toLowerCase() === skuHint.toLowerCase());
      });
      if (cIdx >= 0) {
        parentIdx = i;
        mode = "child";
        childKey = cKey;
        childIdx = cIdx;
        break;
      }
    }
    if (parentMatch) {
      parentIdx = i;
      childKey = cKey;
      break;
    }
  }

  if (parentIdx < 0) {
    throw new Error(
      `Không tìm thấy sản phẩm trong Kho Gốc (disk). id=${id || "—"} sku=${skuHint || "—"}`,
    );
  }

  const parent = { ...all[parentIdx], id: String(all[parentIdx].id) };
  let productOut: any;
  let oldStock = 0;
  let newStock = 0;
  let oldImportPrice = 0;

  if (mode === "child" && childKey && childIdx >= 0) {
    const children = [...(parent[childKey] as any[])];
    const before = children[childIdx];
    oldStock = Math.max(0, Math.round(Number(before.stock) || 0));
    oldImportPrice = Math.max(0, Math.round(Number(before.importPrice) || 0));
    newStock = Math.max(0, oldStock + qty);
    const mergedChild = {
      ...before,
      id: before.id || id,
      stock: newStock,
      importPrice: price,
      status:
        newStock <= 0 && before.status !== "draft"
          ? "out_of_stock"
          : before.status === "out_of_stock"
            ? "active"
            : before.status,
      lastSynced: new Date().toISOString(),
    };
    children[childIdx] = mergedChild;
    const totalStock = children.reduce(
      (s, c) => s + Math.max(0, Math.round(Number(c.stock) || 0)),
      0,
    );
    all[parentIdx] = {
      ...parent,
      [childKey]: children,
      stock: totalStock,
      lastSynced: new Date().toISOString(),
    };
    productOut = mergedChild;
  } else {
    oldStock = Math.max(0, Math.round(Number(parent.stock) || 0));
    oldImportPrice = Math.max(0, Math.round(Number(parent.importPrice) || 0));
    newStock = Math.max(0, oldStock + qty);
    productOut = {
      ...parent,
      stock: newStock,
      importPrice: price,
      status:
        newStock <= 0 && parent.status !== "draft"
          ? "out_of_stock"
          : parent.status === "out_of_stock"
            ? "active"
            : parent.status,
      lastSynced: new Date().toISOString(),
    };
    all[parentIdx] = productOut;
  }

  await saveProductsToDisk(all);
  return {
    product: productOut,
    oldStock,
    newStock,
    oldImportPrice,
    newImportPrice: price,
    target: mode,
    parentId: String(parent.id),
    warehouse: "KhoGoc",
    collection: "products",
  };
}
