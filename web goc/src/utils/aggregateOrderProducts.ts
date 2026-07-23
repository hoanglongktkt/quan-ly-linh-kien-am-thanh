import { Order, Product } from '../types';
import {
  buildVariationGroupKey,
  enrichOrderItemFromCatalog,
  extractVariationIdentifier,
  extractVariationName,
  findCatalogVariants,
  pickVariationSku,
} from './orderItemVariation';

export interface AggregatedOrderProduct {
  groupKey: string;
  productId: string;
  modelId: string;
  baseTitle: string;
  modelName?: string;
  variationName?: string;
  variationSku: string;
  productImage?: string;
  totalQuantity: number;
}

type OrderLine = Order['items'][number];

interface NormalizedLine {
  groupKey: string;
  productId: string;
  modelId: string;
  baseTitle: string;
  modelName?: string;
  variationName?: string;
  variationSku: string;
  productImage?: string;
  quantity: number;
}

function normalizeModelId(raw?: string | null): string {
  const v = String(raw ?? '').trim();
  if (!v || v === '0') return '0';
  return v;
}

function stripModelSuffix(title: string, modelName?: string): string {
  if (!modelName) return title;
  const suffix = ` - ${modelName}`;
  if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim() || title;
  return title;
}

function normalizeOrderLine(item: OrderLine, catalogProducts: Product[]): NormalizedLine {
  const enriched = enrichOrderItemFromCatalog(item, catalogProducts);
  const itemId = String(enriched.productId || '').trim() || 'unknown';
  const modelId = normalizeModelId(enriched.modelId);
  const modelName = enriched.modelName?.trim();
  let baseTitle = enriched.productTitle?.trim() || 'Sản phẩm không tên';

  baseTitle = stripModelSuffix(baseTitle, modelName);

  const variants = itemId !== 'unknown' ? findCatalogVariants(catalogProducts, itemId) : [];
  const matched =
    modelId !== '0'
      ? variants.find((p) => p.shopeeModelId === modelId)
      : modelName
        ? variants.find(
            (p) =>
              p.modelName?.toLowerCase() === modelName.toLowerCase() ||
              p.title.toLowerCase().endsWith(` - ${modelName.toLowerCase()}`)
          )
        : undefined;

  const groupKey = buildVariationGroupKey(itemId, enriched);
  const variationSku = pickVariationSku(enriched, matched);
  const variationName = extractVariationName(enriched, matched);

  return {
    groupKey,
    productId: itemId,
    modelId: modelId !== '0' ? modelId : '0',
    baseTitle,
    modelName: variationName,
    variationName,
    variationSku,
    productImage: enriched.productImage,
    quantity: Math.max(0, Number(enriched.quantity) || 0),
  };
}

export function aggregateOrderProducts(
  orders: Order[],
  catalogProducts: Product[] = []
): AggregatedOrderProduct[] {
  const relevant = orders.filter(
    (o) => o.status === 'unprocessed' || o.status === 'processed'
  );

  const map = new Map<string, AggregatedOrderProduct>();

  for (const order of relevant) {
    for (const item of order.items ?? []) {
      const line = normalizeOrderLine(item, catalogProducts);
      if (line.quantity <= 0) continue;

      const existing = map.get(line.groupKey);
      if (existing) {
        existing.totalQuantity += line.quantity;
        if (!existing.productImage && line.productImage) {
          existing.productImage = line.productImage;
        }
        if (!existing.variationName && line.variationName) {
          existing.variationName = line.variationName;
          existing.modelName = line.variationName;
        }
        if (existing.variationSku === 'Không có SKU' && line.variationSku !== 'Không có SKU') {
          existing.variationSku = line.variationSku;
        }
      } else {
        map.set(line.groupKey, {
          groupKey: line.groupKey,
          productId: line.productId,
          modelId: line.modelId,
          baseTitle: line.baseTitle,
          modelName: line.variationName,
          variationName: line.variationName,
          variationSku: line.variationSku,
          productImage: line.productImage,
          totalQuantity: line.quantity,
        });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => b.totalQuantity - a.totalQuantity);
}

export { extractVariationIdentifier, buildVariationGroupKey };
