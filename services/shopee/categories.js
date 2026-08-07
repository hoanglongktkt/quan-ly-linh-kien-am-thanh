/**
 * Shopee v2.product.get_category — đồng bộ cây danh mục + cache disk.
 * Chỉ leaf (has_children=false) mới hợp lệ cho add_item / update_item.
 */
import fs from "fs";
import path from "path";

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const INVALID_CATEGORY_MSG =
  "Danh mục cũ của sản phẩm đã bị Shopee thay đổi. Vui lòng chọn lại danh mục mới trước khi đăng bán!";

export const SHOPEE_INVALID_CATEGORY_CODE = "product.error_invalid_category";
export const SHOPEE_INVALID_CATEGORY_USER_MSG = INVALID_CATEGORY_MSG;

function resolveCachePath(appRoot) {
  return path.join(appRoot || process.cwd(), "data", "shopee_categories.json");
}

export function isShopeeInvalidCategoryError(errOrText) {
  const text = String(
    errOrText?.message || errOrText?.error || errOrText?.code || errOrText || "",
  );
  return /error_invalid_category|invalid category id/i.test(text);
}

/** category_id → số nguyên dương (leaf ID). */
export function toShopeeCategoryIdInt(value) {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Flat category_list từ get_category → cây CategoryNode[].
 */
export function buildShopeeCategoryTree(categoryList) {
  const list = Array.isArray(categoryList) ? categoryList : [];
  const byParent = new Map();
  for (const row of list) {
    if (!row || row.category_id == null) continue;
    const id = String(row.category_id);
    const parentId = String(row.parent_category_id ?? 0);
    const name = String(
      row.display_category_name || row.original_category_name || `Category ${id}`,
    ).trim();
    const node = {
      id,
      name,
      has_children: Boolean(row.has_children),
      children: [],
    };
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(node);
  }

  const attach = (parentId) => {
    const kids = byParent.get(String(parentId)) || [];
    for (const kid of kids) {
      kid.children = attach(kid.id);
      if (!kid.children.length) delete kid.children;
    }
    return kids;
  };

  return attach("0");
}

/** Tập leaf category_id (số nguyên dạng string). */
export function collectShopeeLeafIds(categoryList) {
  const leaves = new Set();
  for (const row of Array.isArray(categoryList) ? categoryList : []) {
    if (!row || row.category_id == null) continue;
    if (row.has_children === false || row.has_children === 0) {
      const id = toShopeeCategoryIdInt(row.category_id);
      if (id != null) leaves.add(String(id));
    }
  }
  return leaves;
}

export function flattenShopeeTreeToLeaves(tree, platform = "shopee") {
  const result = [];
  const walk = (nodes, pathNames = []) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const nextPath = [...pathNames, node.name];
      if (node.children?.length) {
        walk(node.children, nextPath);
      } else {
        const level1 = nextPath[0] || "";
        const level2 = nextPath.length > 2 ? nextPath[1] : nextPath[1] || "";
        const level3 = nextPath[nextPath.length - 1] || "";
        const label = nextPath.filter(Boolean).join(" > ");
        result.push({
          platform,
          categoryId: String(node.id),
          label,
          level1,
          level2,
          level3,
          searchText: `${label} ${node.id}`.toLowerCase(),
        });
      }
    }
  };
  walk(tree);
  return result;
}

export function readShopeeCategoryCache(appRoot) {
  const file = resolveCachePath(appRoot);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || !Array.isArray(parsed.category_list)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeShopeeCategoryCache(appRoot, payload) {
  const file = resolveCachePath(appRoot);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf-8");
}

export function isShopeeCategoryCacheFresh(cache, ttlMs = CACHE_TTL_MS) {
  if (!cache?.synced_at) return false;
  const t = Date.parse(cache.synced_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < ttlMs;
}

/**
 * Gọi get_category (deps inject từ server để tránh circular import).
 * deps: { shopId, accessToken, fetchCategoryList }
 */
export async function syncShopeeCategories(appRoot, deps) {
  const list = await deps.fetchCategoryList(deps.shopId, deps.accessToken);
  const category_list = Array.isArray(list) ? list : [];
  const tree = buildShopeeCategoryTree(category_list);
  const leaf_ids = [...collectShopeeLeafIds(category_list)];
  const payload = {
    synced_at: new Date().toISOString(),
    shop_id: String(deps.shopId || ""),
    category_count: category_list.length,
    leaf_count: leaf_ids.length,
    category_list,
    tree,
    leaf_ids,
  };
  writeShopeeCategoryCache(appRoot, payload);
  return payload;
}

/**
 * Lấy cache hoặc sync nếu hết hạn / force.
 */
export async function getOrSyncShopeeCategories(appRoot, deps, opts = {}) {
  const force = Boolean(opts.force);
  const cache = readShopeeCategoryCache(appRoot);
  if (!force && cache && isShopeeCategoryCacheFresh(cache) && Array.isArray(cache.tree)) {
    return { ...cache, from_cache: true };
  }
  const fresh = await syncShopeeCategories(appRoot, deps);
  return { ...fresh, from_cache: false };
}

/**
 * Validate category_id là integer leaf trong cache (có thể force sync trước).
 * @returns {{ ok: true, categoryId: number } | { ok: false, error: string, code: string }}
 */
export function validateShopeeLeafCategoryId(categoryIdRaw, cache) {
  const categoryId = toShopeeCategoryIdInt(categoryIdRaw);
  if (categoryId == null) {
    return {
      ok: false,
      code: SHOPEE_INVALID_CATEGORY_CODE,
      error: "category_id phải là số nguyên dương (leaf category).",
    };
  }
  const leafSet = new Set(
    (cache?.leaf_ids || []).map((x) => String(x)).filter(Boolean),
  );
  // Fallback: quét category_list nếu leaf_ids thiếu
  if (leafSet.size === 0 && Array.isArray(cache?.category_list)) {
    for (const id of collectShopeeLeafIds(cache.category_list)) leafSet.add(id);
  }
  if (leafSet.size > 0 && !leafSet.has(String(categoryId))) {
    return {
      ok: false,
      code: SHOPEE_INVALID_CATEGORY_CODE,
      error: INVALID_CATEGORY_MSG,
    };
  }
  return { ok: true, categoryId };
}
