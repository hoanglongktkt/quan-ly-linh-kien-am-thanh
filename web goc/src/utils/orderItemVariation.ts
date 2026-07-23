import { Order, Product } from '../types';

export type OrderLineItem = Order['items'][number];

export interface EnrichedOrderLine extends OrderLineItem {
  modelId?: string;
  modelSku?: string;
  modelName?: string;
}

function normalizeModelId(raw?: string | null): string {
  const v = String(raw ?? '').trim();
  if (!v || v === '0') return '0';
  return v;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-/]/gi, '');
}

export function normalizeImageKey(url?: string): string {
  if (!url) return '';
  const cleaned = url.replace(/[?#].*$/, '').replace(/_tn(\.\w+)?$/i, '');
  const file = cleaned.split('/').pop() || cleaned;
  return file.trim();
}

export function findCatalogVariants(catalogProducts: Product[], itemId: string): Product[] {
  return catalogProducts.filter(
    (p) =>
      p.shopeeItemId === itemId ||
      p.id === itemId ||
      (p.shopeeId && String(p.shopeeId).startsWith(`${itemId}:`))
  );
}

function priceMatches(catalogPrice: number, orderPrice: number): boolean {
  if (!catalogPrice || !orderPrice) return false;
  const diff = Math.abs(catalogPrice - orderPrice);
  return diff <= Math.max(500, orderPrice * 0.1);
}

function stripModelSuffix(title: string, modelName?: string): string {
  if (!modelName) return title;
  const suffix = ` - ${modelName}`;
  if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim() || title;
  return title;
}

function parseModelNameFromTitle(title: string): { baseTitle: string; modelName?: string } {
  if (!title.includes(' - ')) return { baseTitle: title };
  const idx = title.lastIndexOf(' - ');
  const maybeModel = title.slice(idx + 3).trim();
  const maybeBase = title.slice(0, idx).trim();
  if (maybeModel && maybeBase) return { baseTitle: maybeBase, modelName: maybeModel };
  return { baseTitle: title };
}

function matchVariantsByName(variants: Product[], modelName: string): Product[] {
  const lower = modelName.toLowerCase();
  return variants.filter(
    (p) =>
      p.modelName?.toLowerCase() === lower ||
      p.title.toLowerCase().endsWith(` - ${lower}`)
  );
}

function matchVariantsByPrice(variants: Product[], orderPrice: number): Product[] {
  if (!orderPrice || variants.length === 0) return [];
  return variants.filter(
    (p) => p.shopeeModelId && priceMatches(Number(p.sellingPrice) || 0, orderPrice)
  );
}

function matchVariantByImage(variants: Product[], orderImage?: string): Product | undefined {
  const orderKey = normalizeImageKey(orderImage);
  if (!orderKey) return undefined;

  const matches = variants.filter((v) => {
    const variantKey = normalizeImageKey(v.avatarUrl || v.imageUrl);
    if (!variantKey) return false;
    if (orderKey === variantKey) return true;
    const orderStem = orderKey.split('-')[0] || orderKey;
    const variantStem = variantKey.split('-')[0] || variantKey;
    return orderStem.length >= 4 && variantStem.length >= 4 && orderStem === variantStem;
  });

  return matches.length === 1 ? matches[0] : undefined;
}

export function extractVariationIdentifier(item: OrderLineItem): string {
  const modelId = normalizeModelId(item.modelId);
  if (modelId !== '0') return modelId;

  const modelName = item.modelName?.trim();
  if (modelName) return slugify(modelName);

  const parsed = parseModelNameFromTitle(item.productTitle || '');
  if (parsed.modelName) return slugify(parsed.modelName);

  const imageKey = normalizeImageKey(item.productImage);
  if (imageKey) return `img_${slugify(imageKey)}`;

  const price = Math.round(Number(item.price) || 0);
  if (price > 0) return `p${price}`;

  return 'unknown';
}

export function buildVariationGroupKey(itemId: string, item: OrderLineItem): string {
  const id = String(itemId || '').trim() || 'unknown';
  const variationIdentifier = extractVariationIdentifier(item);
  return `${id}_${variationIdentifier}`;
}

/** Tên phân loại hiển thị — ưu tiên model_name / variation_name / catalog. */
export function extractVariationName(
  item: OrderLineItem,
  matchedVariant?: Product
): string | undefined {
  const candidates = [
    item.modelName,
    matchedVariant?.modelName,
    matchedVariant?.tierLabels?.length ? matchedVariant.tierLabels.join(' / ') : undefined,
  ];
  for (const raw of candidates) {
    const name = String(raw || '').trim();
    if (name) return name;
  }
  const parsed = parseModelNameFromTitle(item.productTitle || '');
  if (parsed.modelName?.trim()) return parsed.modelName.trim();
  return undefined;
}

export function pickVariationSku(
  item: OrderLineItem,
  matchedVariant?: Product
): string {
  const direct =
    item.modelSku?.trim() ||
    matchedVariant?.sku?.trim() ||
    item.modelName?.trim() ||
    matchedVariant?.modelName?.trim();

  if (direct) return direct;
  if (item.modelId && normalizeModelId(item.modelId) !== '0') return item.modelId;
  return 'Không có SKU';
}

export function enrichOrderItemFromCatalog(
  item: OrderLineItem,
  catalogProducts: Product[] = []
): EnrichedOrderLine {
  const itemId = String(item.productId || '').trim();
  let modelId = normalizeModelId(item.modelId);
  let modelSku = item.modelSku?.trim();
  let modelName = item.modelName?.trim();
  let productTitle = item.productTitle?.trim() || 'Sản phẩm không tên';
  const orderPrice = Number(item.price) || 0;

  const parsed = parseModelNameFromTitle(productTitle);
  if (!modelName && parsed.modelName) {
    modelName = parsed.modelName;
    productTitle = parsed.baseTitle;
  } else {
    productTitle = stripModelSuffix(productTitle, modelName);
  }

  const variants = itemId ? findCatalogVariants(catalogProducts, itemId) : [];
  let matched: Product | undefined;

  if (modelId !== '0') {
    matched = variants.find((p) => p.shopeeModelId === modelId);
  }

  if (!matched && modelName) {
    const byName = matchVariantsByName(variants, modelName);
    if (byName.length === 1) matched = byName[0];
  }

  if (!matched && orderPrice > 0) {
    const byPrice = matchVariantsByPrice(variants, orderPrice);
    if (byPrice.length === 1) matched = byPrice[0];
  }

  if (!matched) {
    matched = matchVariantByImage(variants, item.productImage);
  }

  if (matched) {
    modelId = normalizeModelId(matched.shopeeModelId);
    modelSku = modelSku || matched.sku?.trim();
    modelName = modelName || matched.modelName?.trim();
    productTitle = stripModelSuffix(matched.title, matched.modelName) || productTitle;
  }

  const enriched: EnrichedOrderLine = {
    ...item,
    productTitle: modelName ? `${productTitle} - ${modelName}` : productTitle,
    modelId: modelId !== '0' ? modelId : item.modelId,
    modelSku: modelSku || item.modelSku,
    modelName: modelName || item.modelName,
  };

  return enriched;
}

export function enrichOrdersFromCatalog(orders: Order[], catalogProducts: Product[] = []): Order[] {
  return orders.map((order) => ({
    ...order,
    items: (order.items || []).map((item) => enrichOrderItemFromCatalog(item, catalogProducts)),
  }));
}
