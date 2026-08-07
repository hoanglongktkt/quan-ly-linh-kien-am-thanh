import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, SyncLog } from '../types';
import {
  CategorySelection,
  ShopeeAttributeSelection,
  ShopeeCategoryAttribute,
  isShopeeMedicalCategorySelection,
} from '../types/marketplaceCategory';
import { applySmartPricesFromShopee } from '../utils/smartPricing';
import SmartCategorySelector from './SmartCategorySelector';
import {
  Store,
  Plus,
  Info,
  Image as ImageIcon,
  Upload,
  Trash2,
  Sparkles,
  Package,
  Truck,
  Globe,
  AlertCircle,
  Check,
  Loader2,
  Save,
  PenLine,
  Table2,
  Zap,
} from 'lucide-react';

export interface ListingVariant {
  id: string;
  name: string;
  sku: string;
  stock: number;
  weight: number;
  priceShopee: number;
  priceLazada: number;
  priceTiktok: number;
  /** Giá khuyến mại (optional) */
  pricePromo?: number;
  /** Chỉ số tier cho Shopee multi-tier (VD: [0, 0] = Tier1[0] + Tier2[0]) */
  tierIndices?: number[];
}

export interface LogisticChannel {
  logistic_id: number;
  logistic_name: string;
  channel_type: string; // 'express' | 'fast' | 'pickup' | 'bulky'
  enabled: boolean;
  has_size_limit: boolean;
  max_dimension?: { max_length: number; max_width: number; max_height: number };
  cod_enabled?: boolean;
  fee_type?: string;
}

/** Thuộc tính phiên bản (VD: Màu, Size) */
export interface TierAttribute {
  id: string;
  name: string;
  values: string[];
  /** Ảnh gắn với từng value (chỉ thuộc tính đầu) */
  images: Record<string, string>;
}

export interface MultiChannelListingPayload {
  selectedShops: string[];
  title: string;
  shopeeCat: string;
  shopeeCategoryId: string;
  shopeeBrand: string;
  shopeeBrandId?: number;
  shopeeAttributes?: ShopeeAttributeSelection[];
  /** Shopee medicine_id (uint64 string) — bắt buộc ngành Y tế/Dược. */
  medicine_id?: string;
  lazadaCat: string;
  lazadaCategoryId: string;
  lazadaBrand: string;
  tiktokCat: string;
  tiktokCategoryId: string;
  tiktokBrand: string;
  shopeeCategory?: CategorySelection | null;
  lazadaCategory?: CategorySelection | null;
  tiktokCategory?: CategorySelection | null;
  images: string[];
  variants: ListingVariant[];
  /** Biến thể theo từng gian hàng (shopId → variants) */
  perShopVariants?: Record<string, ListingVariant[]>;
  /** Logistics bật theo từng gian (shopId → logistic_id[] — đã resolve từ generic keys) */
  perShopLogistics?: Record<string, number[]>;
  /** Tên thuộc tính tier (VD: Màu) — legacy 1 tier */
  tierName?: string;
  /** Danh sách tier attributes (tối đa 2) — dùng cho Shopee multi-tier */
  tierVariations?: Array<{ name: string; options: string[] }>;
  descriptionHtml: string;
  packageWeight: number;
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  shippingMethod: string;
  /** Toggle: thiết lập cân nặng riêng cho từng phân loại */
  perVariationWeight: boolean;
  /** FE gửi logistic channels được BẬT (FE đã filter theo kích thước) */
  enabledLogistics: number[];
  /** Hàng đặt trước */
  isPreOrder: boolean;
  /** Số ngày chuẩn bị hàng (7–15) */
  daysToShip: number;
}

interface ShopItem {
  id: string;
  name: string;
  icon: string;
  platform: 'shopee' | 'lazada' | 'tiktok' | string;
  shopId?: string;
  shopName?: string;
}

interface MultiChannelListingFormProps {
  products: Product[];
  shops: ShopItem[];
  onAddLog: (log: SyncLog) => void;
}

const QUICK_TAGS_STORAGE_KEY = 'customProductTags';
const QUICK_TAGS_DEFAULT = ['[Chính hãng]', '[Ảnh thật]', '[FreeShip]', '[Siêu Sale]', '[Có bảo hành]'];

function loadQuickTags(): string[] {
  try {
    const stored = localStorage.getItem(QUICK_TAGS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return [...QUICK_TAGS_DEFAULT];
}

function saveQuickTags(tags: string[]) {
  try {
    localStorage.setItem(QUICK_TAGS_STORAGE_KEY, JSON.stringify(tags));
  } catch {}
}

function formatVnd(n: number) {
  return (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
}

function getProductGroupKey(p: Product): string {
  return p.shopeeItemId || p.parentSku || p.id;
}

function buildVariantsFromProducts(allProducts: Product[], product: Product | undefined): ListingVariant[] {
  if (!product) {
    return [{
      id: 'var-default',
      name: 'Mặc định',
      sku: '',
      stock: 0,
      weight: 0,
      priceShopee: 0,
      priceLazada: 0,
      priceTiktok: 0,
    }];
  }
  const key = getProductGroupKey(product);
  const siblings = allProducts.filter((p) => getProductGroupKey(p) === key);
  const list = siblings.length > 0 ? siblings : [product];
  return list.map((p) => {
    const prices = applySmartPricesFromShopee(p.sellingPrice || 0);
    return {
      id: p.id,
      name: p.modelName || p.tierLabels?.join(' / ') || p.title,
      sku: p.sku,
      stock: p.stock,
      weight: p.weight || 0,
      priceShopee: prices.shopee,
      priceLazada: prices.lazada,
      priceTiktok: prices.tiktok,
    };
  });
}

const LOGISTIC_GROUP_LABELS: Record<string, string> = {
  express: 'Hỏa Tốc',
  fast: 'Nhanh',
  pickup: 'Điểm nhận hàng',
  bulky: 'Hàng Cồng Kềnh',
  sameday: 'Trong Ngày',
  spx_locker: 'Tủ nhận hàng - SPX',
  smartbox: 'Tủ nhận hàng - Viettel Smartbox',
};

/** Map generic channel key → regex để classify từ tên kênh Shopee */
const SHOP_CHANNEL_KEY_MAP: Record<string, (name: string, ch: LogisticChannel) => boolean> = {
  bulky: (name) => /cồng ?kềnh|bulky|heavy|large/i.test(name),
  express: (name) => /hoả? ?tốc|express/i.test(name),
  fast: (name) => /nhanh|fast|next.?day/i.test(name) && !/hoả? ?tốc/i.test(name),
  sameday: (name) => /trong ?ngày|same.?day/i.test(name),
  spx_locker: (name) => /tủ ?nhận ?hàng|tủ spx|spx ?locker/i.test(name),
  smartbox: (name) => /smartbox|viettel/i.test(name),
  pickup: (name) => /lấy ?hàng|pick.?up|self.?collect|điểm ?nhận/i.test(name),
};

function classifyGenericKey(ch: LogisticChannel): string {
  const name = String(ch.logistic_name || '').toLowerCase();
  for (const [key, matcher] of Object.entries(SHOP_CHANNEL_KEY_MAP)) {
    if (matcher(name, ch)) return key;
  }
  return 'other';
}

export default function MultiChannelListingForm({ products, shops, onAddLog }: MultiChannelListingFormProps) {
  const editorRef = useRef<HTMLDivElement>(null);

  const availableShops = useMemo((): ShopItem[] => {
    return (shops || [])
      .filter((s) => ['shopee', 'lazada', 'tiktok'].includes(String(s.platform || '').toLowerCase()))
      .map((s: any) => ({
        id: String(s.id || s.shopId || ''),
        shopId: String(s.shopId || s.id || ''),
        name: String(s.name || s.shopName || s.shopId || s.id || 'Shop'),
        shopName: String(s.shopName || s.name || ''),
        icon: s.icon || (s.platform === 'shopee' ? '🛒' : s.platform === 'lazada' ? '🔵' : '🎵'),
        platform: String(s.platform || '').toLowerCase(),
      }))
      .filter((s) => s.id);
  }, [shops]);

  const [selectedShops, setSelectedShops] = useState<string[]>(
    () => availableShops.map((s) => s.id)
  );
  const [title, setTitle] = useState('');
  const [quickTags, setQuickTags] = useState<string[]>(loadQuickTags);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [tagDraft, setTagDraft] = useState<string[]>([]);
  const [tagEditValue, setTagEditValue] = useState('');
  const [shopeeCategory, setShopeeCategory] = useState<CategorySelection | null>(null);
  const [shopeeBrand, setShopeeBrand] = useState('NoBrand');
  const [shopeeBrandId, setShopeeBrandId] = useState(0);
  const [shopeeAttrDefs, setShopeeAttrDefs] = useState<ShopeeCategoryAttribute[]>([]);
  const [shopeeAttrValues, setShopeeAttrValues] = useState<Record<string, string>>({});
  const [loadingShopeeAttrs, setLoadingShopeeAttrs] = useState(false);
  const [medicineId, setMedicineId] = useState('');
  const [requiresMedicineId, setRequiresMedicineId] = useState(false);
  const [categoryResetToken, setCategoryResetToken] = useState(0);
  const [lazadaCategory, setLazadaCategory] = useState<CategorySelection | null>(null);
  const [lazadaBrand, setLazadaBrand] = useState('No Brand');
  const [tiktokCategory, setTiktokCategory] = useState<CategorySelection | null>(null);
  const [tiktokBrand, setTiktokBrand] = useState('No Brand');

  const [images, setImages] = useState<string[]>([]);
  const [variants, setVariants] = useState<ListingVariant[]>([{
    id: 'var-default',
    name: 'Mặc định',
    sku: '',
    stock: 0,
    weight: 0,
    priceShopee: 0,
    priceLazada: 0,
    priceTiktok: 0,
  }]);

  const [descMode, setDescMode] = useState<'manual' | 'ai'>('manual');
  const [descriptionHtml, setDescriptionHtml] = useState('');
  const [aiKeywords, setAiKeywords] = useState('');
  const [isGeneratingDesc, setIsGeneratingDesc] = useState(false);

  const [packageWeight, setPackageWeight] = useState(500);
  const [packageLength, setPackageLength] = useState(20);
  const [packageWidth, setPackageWidth] = useState(15);
  const [packageHeight, setPackageHeight] = useState(10);
  const [shippingMethod, setShippingMethod] = useState('Giao hàng tiêu chuẩn');

  // Toggle: thiết lập cân nặng riêng cho từng phân loại
  const [perVariationWeight, setPerVariationWeight] = useState(false);

  // Kênh vận chuyển — theo từng gian hàng
  const [logisticChannels, setLogisticChannels] = useState<LogisticChannel[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [channelError, setChannelError] = useState('');
  /** generic channel keys bật theo từng shop_id (bulky|express|fast|sameday|spx_locker|smartbox|pickup) */
  const [perShopLogistics, setPerShopLogistics] = useState<Record<string, string[]>>({});

  // Hàng đặt trước
  const [isPreOrder, setIsPreOrder] = useState(false);
  const [daysToShip, setDaysToShip] = useState(10);

  // ====== PHẦN 2: Tier Attributes (biến thể theo thuộc tính) ======
  const [tierAttrs, setTierAttrs] = useState<TierAttribute[]>([
    { id: 'attr-color', name: 'Màu', values: [], images: {} }
  ]);
  // State riêng cho input text của từng thuộc tính (tag input)
  const [tierInputValues, setTierInputValues] = useState<Record<string, string>>({});

  // Bulk apply state — "Mẹo thiết lập nhanh"
  const [bulkSku, setBulkSku] = useState('');
  const [bulkStock, setBulkStock] = useState('');
  const [bulkPrice, setBulkPrice] = useState('');
  const [bulkPromoPrice, setBulkPromoPrice] = useState('');
  const [bulkWeight, setBulkWeight] = useState('');
  const [bulkDays, setBulkDays] = useState('');

  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  // warehouseProductId removed — form is now fully manual entry

  const primaryShopeeShopId = useMemo(() => {
    const selected = availableShops.find(
      (s) => selectedShops.includes(s.id) && s.platform === 'shopee'
    );
    return selected?.shopId || selected?.id || '';
  }, [availableShops, selectedShops]);

  const shopeeMandatoryAttrs = useMemo(
    () => shopeeAttrDefs.filter((a) => a.mandatory),
    [shopeeAttrDefs]
  );

  const isMedicalCategory = useMemo(
    () => requiresMedicineId || isShopeeMedicalCategorySelection(shopeeCategory),
    [requiresMedicineId, shopeeCategory]
  );

  const groupedChannels = useMemo(() => {
    const groups: Record<string, LogisticChannel[]> = {};
    for (const ch of logisticChannels) {
      const g = ch.channel_type || 'other';
      if (!groups[g]) groups[g] = [];
      groups[g].push(ch);
    }
    return groups;
  }, [logisticChannels]);

  const buildShopeeAttributesPayload = useCallback((): ShopeeAttributeSelection[] => {
    return shopeeAttrDefs
      .map((attr) => {
        const key = String(attr.attribute_id);
        const raw = String(shopeeAttrValues[key] || '').trim();
        if (!raw) return null;
        if (attr.values?.length) {
          const hit = attr.values.find((v) => String(v.value_id) === raw);
          if (!hit) return null;
          return {
            attribute_id: attr.attribute_id,
            value_id: hit.value_id,
            original_value_name: hit.name,
          };
        }
        return {
          attribute_id: attr.attribute_id,
          value_id: 0,
          original_value_name: raw,
        };
      })
      .filter(Boolean) as ShopeeAttributeSelection[];
  }, [shopeeAttrDefs, shopeeAttrValues]);

  // Tải kênh vận chuyển khi chọn shop Shopee
  const loadLogisticChannels = useCallback(async (shopId: string) => {
    setLoadingChannels(true);
    setChannelError('');
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch(`/api/shopee/logistics-channels?shop_id=${encodeURIComponent(shopId)}`, {
        headers: { Authorization: token ? `Bearer ${token}` : '' },
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Không lấy được kênh vận chuyển');
      const channels: LogisticChannel[] = data.channels || [];
      setLogisticChannels(channels);

      // Seed generic keys cho tất cả shop Shopee đang chọn
      const availableKeys = channels
        .filter((c) => c.enabled)
        .map((c) => classifyGenericKey(c))
        .filter((k) => k !== 'other');
      const uniqueKeys = [...new Set(availableKeys)];

      setPerShopLogistics((prev) => {
        const next = { ...prev };
        for (const s of availableShops) {
          if (s.platform !== 'shopee' || !selectedShops.includes(s.id)) continue;
          const k1 = s.shopId || s.id;
          const k2 = s.id;
          if (!next[k1]?.length) next[k1] = [...uniqueKeys];
          if (!next[k2]?.length) next[k2] = [...uniqueKeys];
        }
        return next;
      });
    } catch (err: any) {
      setChannelError(err.message);
      setLogisticChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  }, [availableShops, selectedShops]);

  useEffect(() => {
    if (primaryShopeeShopId) {
      loadLogisticChannels(primaryShopeeShopId);
    } else {
      setLogisticChannels([]);
    }
  }, [primaryShopeeShopId, loadLogisticChannels]);

  // Warehouse auto-fill removed — form is now fully manual entry

  useEffect(() => {
    if (descMode === 'manual' && editorRef.current) {
      if (editorRef.current.innerHTML !== descriptionHtml) {
        editorRef.current.innerHTML = descriptionHtml;
      }
    }
  }, [descMode, descriptionHtml]);

  useEffect(() => {
    const categoryId = shopeeCategory?.categoryId;
    if (!categoryId || !primaryShopeeShopId) {
      setShopeeAttrDefs([]);
      setShopeeAttrValues({});
      setRequiresMedicineId(isShopeeMedicalCategorySelection(shopeeCategory));
      return;
    }
    let cancelled = false;
    const loadAttrs = async () => {
      setLoadingShopeeAttrs(true);
      try {
        const token = localStorage.getItem('admin_token');
        const qs = new URLSearchParams({
          shop_id: primaryShopeeShopId,
          category_id: String(categoryId),
          category_label: shopeeCategory?.label || '',
          level1: shopeeCategory?.level1 || '',
          level2: shopeeCategory?.level2 || '',
          level3: shopeeCategory?.level3 || '',
          _t: String(Date.now()),
        });
        const res = await fetch(`/api/shopee/category-attributes?${qs}`, {
          headers: {
            Authorization: token ? `Bearer ${token}` : '',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
          cache: 'no-store',
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setShopeeAttrDefs([]);
          setShopeeAttrValues({});
          setRequiresMedicineId(isShopeeMedicalCategorySelection(shopeeCategory));
          return;
        }
        const attrs: ShopeeCategoryAttribute[] = Array.isArray(data.attributes) ? data.attributes : [];
        setShopeeAttrDefs(attrs);
        setRequiresMedicineId(
          Boolean(data.requires_medicine_id) || isShopeeMedicalCategorySelection(shopeeCategory)
        );
        const next: Record<string, string> = {};
        for (const a of attrs) {
          if (!a.mandatory) continue;
          if (a.values?.length) next[String(a.attribute_id)] = String(a.values[0].value_id);
          else next[String(a.attribute_id)] = '';
        }
        setShopeeAttrValues(next);
      } catch {
        if (!cancelled) {
          setShopeeAttrDefs([]);
          setShopeeAttrValues({});
          setRequiresMedicineId(isShopeeMedicalCategorySelection(shopeeCategory));
        }
      } finally {
        if (!cancelled) setLoadingShopeeAttrs(false);
      }
    };
    loadAttrs();
    return () => {
      cancelled = true;
    };
  }, [shopeeCategory?.categoryId, shopeeCategory?.label, primaryShopeeShopId]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const selectedShopItems = useMemo(
    () => availableShops.filter((s) => selectedShops.includes(s.id)),
    [availableShops, selectedShops]
  );

  /** Convert generic keys → logistic_id[] bằng cách match tên kênh Shopee */
  const resolveLogisticIds = useCallback((genericKeys: string[]): number[] => {
    if (!genericKeys.length) return [];
    return logisticChannels
      .filter((ch) => {
        const key = classifyGenericKey(ch);
        return genericKeys.includes(key);
      })
      .map((ch) => ch.logistic_id);
  }, [logisticChannels]);

  const buildPayload = useCallback((): MultiChannelListingPayload => {
    // perShopVariants: clone variants cho mỗi gian
    const perShopVariants: Record<string, ListingVariant[]> = {};
    const outLogistics: Record<string, number[]> = {};
    let primaryEnabledLogs: number[] = [];

    for (const shop of availableShops.filter((s) => selectedShops.includes(s.id))) {
      const key = shop.shopId || shop.id;
      perShopVariants[key] = variants.map((v) => ({ ...v }));
      perShopVariants[shop.id] = variants.map((v) => ({ ...v }));

      const genericKeys = perShopLogistics[key] || perShopLogistics[shop.id] || [];
      const resolved = resolveLogisticIds(genericKeys);
      outLogistics[key] = resolved;
      outLogistics[shop.id] = resolved;
      if (!primaryEnabledLogs.length) primaryEnabledLogs = resolved;
    }
    return {
      selectedShops,
      title,
      shopeeCat: shopeeCategory?.label || '',
      shopeeCategoryId: shopeeCategory?.categoryId || '',
      shopeeBrand,
      shopeeBrandId: shopeeBrand === 'NoBrand' ? 0 : shopeeBrandId,
      shopeeAttributes: buildShopeeAttributesPayload(),
      medicine_id: medicineId.trim() || undefined,
      lazadaCat: lazadaCategory?.label || '',
      lazadaCategoryId: lazadaCategory?.categoryId || '',
      lazadaBrand,
      tiktokCat: tiktokCategory?.label || '',
      tiktokCategoryId: tiktokCategory?.categoryId || '',
      tiktokBrand,
      shopeeCategory,
      lazadaCategory,
      tiktokCategory,
      images,
      variants,
      perShopVariants,
      perShopLogistics: outLogistics,
      tierName: tierAttrs[0]?.name || 'Phân loại',
      tierVariations: tierAttrs
        .filter((a) => a.values.length > 0)
        .slice(0, 2)
        .map((a) => ({
          name: (a.name || 'Phân loại').trim().slice(0, 14) || 'Phân loại',
          options: a.values.map((v) => String(v).trim()).filter(Boolean),
        })),
      descriptionHtml,
      packageWeight,
      packageLength,
      packageWidth,
      packageHeight,
      shippingMethod,
      perVariationWeight,
      enabledLogistics: primaryEnabledLogs,
      isPreOrder,
      daysToShip,
    };
  }, [
    selectedShops, title, shopeeCategory, shopeeBrand, shopeeBrandId, buildShopeeAttributesPayload, medicineId,
    lazadaCategory, lazadaBrand, tiktokCategory, tiktokBrand, images, variants, descriptionHtml,
    packageWeight, packageLength, packageWidth, packageHeight, shippingMethod, perVariationWeight,
    perShopLogistics, resolveLogisticIds, isPreOrder, daysToShip, availableShops, tierAttrs,
  ]);

  const handleInsertTag = (val: string) => {
    if (title.length + val.length <= 120) setTitle((prev) => prev + val);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []) as File[];
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (ev.target?.result) {
          setImages((prev) => [...prev, ev.target!.result as string].slice(0, 9));
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = '';
  };

  const removeImage = (idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateVariant = (id: string, patch: Partial<ListingVariant>) => {
    setVariants((prev) => prev.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  };

  const handleShopeePriceChange = (id: string, raw: string) => {
    const shopee = Math.max(0, Number(raw) || 0);
    const smart = applySmartPricesFromShopee(shopee);
    updateVariant(id, {
      priceShopee: smart.shopee,
      priceLazada: smart.lazada,
      priceTiktok: smart.tiktok,
    });
  };

  const addVariantRow = () => {
    const n = variants.length + 1;
    setVariants((prev) => [
      ...prev,
      {
        id: `var-${Date.now()}`,
        name: `Phân loại ${n}`,
        sku: '',
        stock: 0,
        weight: packageWeight,
        priceShopee: 0,
        priceLazada: 0,
        priceTiktok: 0,
      },
    ]);
  };

  const removeVariantRow = (id: string) => {
    if (variants.length <= 1) return;
    setVariants((prev) => prev.filter((v) => v.id !== id));
  };

  // ====== PHẦN 2: Tier Attribute Handlers ======
  const updateTierAttrName = (id: string, name: string) => {
    setTierAttrs((prev) => prev.map((a) => (a.id === id ? { ...a, name } : a)));
  };

  const updateTierAttrValues = (id: string, values: string[]) => {
    setTierAttrs((prev) => prev.map((a) => (a.id === id ? { ...a, values } : a)));
  };

  // Bắt phím Enter hoặc dấu phẩy để thêm tag mới
  const handleTagInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, attrId: string) => {
    const raw = (e.target as HTMLInputElement).value.trim();
    const isEnter = e.key === 'Enter';
    const isComma = e.key === ',';
    if (!isEnter && !isComma) return;
    if (isComma) {
      e.preventDefault();
      const parts = raw.split(',').map((v) => v.trim()).filter(Boolean);
      setTierAttrs((prev) => {
        const attr = prev.find((a) => a.id === attrId);
        if (!attr) return prev;
        const newVals = [...attr.values];
        let added = false;
        for (const p of parts) {
          if (!newVals.includes(p)) { newVals.push(p); added = true; }
        }
        return added ? prev.map((a) => (a.id === attrId ? { ...a, values: newVals } : a)) : prev;
      });
      setTierInputValues((prev) => ({ ...prev, [attrId]: '' }));
      return;
    }
    if (isEnter) {
      e.preventDefault();
      if (!raw) return;
      setTierAttrs((prev) => {
        const attr = prev.find((a) => a.id === attrId);
        if (!attr) return prev;
        if (attr.values.includes(raw)) return prev;
        return prev.map((a) => (a.id === attrId ? { ...a, values: [...a.values, raw] } : a));
      });
      setTierInputValues((prev) => ({ ...prev, [attrId]: '' }));
    }
  };

  // Xóa một tag khỏi danh sách giá trị
  const removeTierTag = (attrId: string, tagValue: string) => {
    setTierAttrs((prev) => prev.map((a) => (a.id === attrId ? { ...a, values: a.values.filter((v) => v !== tagValue) } : a)));
  };

  // Sinh tổ hợp biến thể (Cartesian product) từ tierAttrs — tối đa 2 tier
  const buildCartesianNames = useCallback((attrs: TierAttribute[]): string[] => {
    const t1 = attrs[0]?.values?.filter(Boolean) || [];
    const t2 = attrs[1]?.values?.filter(Boolean) || [];
    if (t1.length === 0 && t2.length === 0) return [];
    if (t1.length === 0) return t2;
    if (t2.length === 0) return t1;
    const names: string[] = [];
    for (const a of t1) {
      for (const b of t2) {
        names.push(`${a} - ${b}`);
      }
    }
    return names;
  }, []);

  // Tự động sinh/cập nhật variants khi tags Tier 1 hoặc Tier 2 thay đổi
  useEffect(() => {
    const t1 = tierAttrs[0]?.values?.filter(Boolean) || [];
    const t2 = tierAttrs[1]?.values?.filter(Boolean) || [];
    if (t1.length === 0 && t2.length === 0) return;

    const newVariants: ListingVariant[] = [];
    for (let i = 0; i < t1.length; i++) {
      for (let j = 0; j < (t2.length === 0 ? 1 : t2.length); j++) {
        const name = t2.length === 0 ? t1[i] : `${t1[i]} - ${t2[j]}`;
        const indices = t2.length === 0 ? [i] : [i, j];
        newVariants.push({ name, tierIndices: indices });
      }
    }

    setVariants((prev) => {
      const byName = new Map(prev.map((v) => [v.name, v]));
      return newVariants.map((nv) => {
        const existing = byName.get(nv.name);
        if (existing) return { ...existing, name: nv.name, tierIndices: nv.tierIndices };
        return {
          id: `var-tier-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: nv.name,
          tierIndices: nv.tierIndices,
          sku: '',
          stock: 0,
          weight: packageWeight,
          priceShopee: 0,
          priceLazada: 0,
          priceTiktok: 0,
        };
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tierAttrs.map((a) => a.values.join('\u0001')).join('\u0002'),
  ]);

  // ====== PHẦN 2: Bulk Apply Handlers ======
  const handleBulkApply = () => {
    const skuVal = bulkSku.trim();
    const stockVal = Number(bulkStock) || 0;
    const priceVal = Number(bulkPrice) || 0;
    const promoVal = Number(bulkPromoPrice) || 0;
    const weightVal = Number(bulkWeight) || 0;
    const daysVal = Number(bulkDays) || 0;

    setVariants((prev) =>
      prev.map((v) => {
        const smart = applySmartPricesFromShopee(priceVal);
        return {
          ...v,
          ...(skuVal ? { sku: skuVal } : {}),
          ...(bulkStock !== '' ? { stock: stockVal } : {}),
          ...(bulkPrice !== '' ? { priceShopee: smart.shopee, priceLazada: smart.lazada, priceTiktok: smart.tiktok } : {}),
          ...(bulkPromoPrice !== '' ? { pricePromo: promoVal } : {}),
          ...(bulkWeight !== '' && perVariationWeight ? { weight: weightVal } : {}),
        };
      })
    );
    if (daysVal > 0) setDaysToShip(Math.max(7, Math.min(15, daysVal)));
    setBulkSku('');
    setBulkStock('');
    setBulkPrice('');
    setBulkPromoPrice('');
    setBulkWeight('');
    setBulkDays('');
  };

  const handleGenerateDescription = async () => {
    if (!title.trim()) {
      alert('Vui lòng nhập tên sản phẩm trước khi dùng AI!');
      return;
    }
    setIsGeneratingDesc(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/ai/generate-description', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({
          title,
          keywords: aiKeywords,
          context: variants.map((v) => `${v.name}: ${formatVnd(v.priceShopee)}`).join('; '),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Lỗi API');
      setDescriptionHtml(data.html || '');
      setDescMode('manual');
      showToast('AI đã tạo mô tả sản phẩm thành công!');
    } catch (err: any) {
      const fallback = `<h3>${title}</h3><ul><li>${aiKeywords || 'Chất lượng cao, bền bỉ'}</li><li>Bảo hành chính hãng</li><li>Giao hàng nhanh toàn quốc</li></ul><p><strong>Cam kết:</strong> Hàng chính hãng 100%, đổi trả trong 7 ngày.</p>`;
      setDescriptionHtml(fallback);
      setDescMode('manual');
      showToast(`Dùng mô tả mẫu (AI lỗi): ${err.message}`);
    } finally {
      setIsGeneratingDesc(false);
    }
  };

  const handleSaveListing = async () => {
    setIsSaving(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/multi-channel/listing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Lưu thất bại');
      showToast('Đã lưu bản nháp đăng bán đa sàn!');
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'publish',
        status: 'success',
        message: `Lưu nháp đăng bán đa sàn: ${title || 'Chưa đặt tên'}`,
      });
    } catch (err: any) {
      showToast(`Lỗi lưu: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handlePublish = async () => {
    if (selectedShops.length === 0) {
      alert('Vui lòng chọn ít nhất một gian hàng!');
      return;
    }
    if (!title.trim()) {
      alert('Vui lòng điền tên sản phẩm!');
      return;
    }
    const needsShopee = selectedShops.some((id) => availableShops.find((s) => s.id === id)?.platform === 'shopee');
    const needsLazada = selectedShops.some((id) => availableShops.find((s) => s.id === id)?.platform === 'lazada');
    const needsTiktok = selectedShops.some((id) => availableShops.find((s) => s.id === id)?.platform === 'tiktok');
    if (needsShopee && !shopeeCategory?.categoryId) {
      alert('Vui lòng chọn ngành hàng Shopee (Category ID)!');
      return;
    }
    if (needsShopee && images.length === 0) {
      alert('Vui lòng thêm ít nhất 1 ảnh sản phẩm!');
      return;
    }
    if (needsShopee && shopeeMandatoryAttrs.length > 0) {
      const missing = shopeeMandatoryAttrs.filter((a) => !String(shopeeAttrValues[String(a.attribute_id)] || '').trim());
      if (missing.length) {
        alert(`Vui lòng điền thuộc tính bắt buộc Shopee: ${missing.map((a) => a.attribute_name).join(', ')}`);
        return;
      }
    }
    if (needsShopee && isMedicalCategory && !medicineId.trim()) {
      alert('Danh mục Y tế/Dược phẩm bắt buộc nhập Mã thuốc (medicine_id)!');
      return;
    }
    if (needsLazada && !lazadaCategory?.categoryId) {
      alert('Vui lòng chọn ngành hàng Lazada (Category ID)!');
      return;
    }
    if (needsTiktok && !tiktokCategory?.categoryId) {
      alert('Vui lòng chọn ngành hàng TikTok (Category ID)!');
      return;
    }
    if (isPreOrder && (daysToShip < 7 || daysToShip > 15)) {
      alert('Số ngày chuẩn bị hàng (Hàng đặt trước) phải từ 7 đến 15 ngày!');
      return;
    }
    setIsPublishing(true);
    try {
      const token = localStorage.getItem('admin_token');

      let publishImages = [...images];
      let shopTitlesPayload: Record<string, string> = {};

      try {
        const cfgRes = await fetch('/api/publish-edit', {
          headers: { Authorization: token ? `Bearer ${token}` : '' },
        });
        const cfgData = await cfgRes.json();
        if (cfgData.success) {
          if (cfgData.config?.autoApplyFrame && cfgData.config?.framePngUrl && images.length > 0) {
            const { composeImageWithFrame } = await import('../utils/imageFrameOverlay');
            const composed = await composeImageWithFrame(images[0], cfgData.config.framePngUrl);
            publishImages = [composed, ...publishImages.slice(1)];
          }
        }
      } catch {
        /* optional pre-publish frame */
      }

      const payload = { ...buildPayload(), images: publishImages, shopTitles: shopTitlesPayload };
      const shopDetails = selectedShops
        .map((id) => availableShops.find((s) => s.id === id))
        .filter(Boolean)
        .map((s) => ({
          id: s!.id,
          shopId: s!.shopId || s!.id,
          name: s!.name || s!.shopName || s!.id,
          platform: s!.platform,
        }));

      const res = await fetch('/api/multi-channel/publish', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ ...payload, shops: shopDetails, selectedShops }),
      });
      let data: any = {};
      try {
        data = await res.json();
      } catch {
        throw new Error(`Máy chủ trả phản hồi không phải JSON (HTTP ${res.status})`);
      }

      const listings: any[] = Array.isArray(data.listings) ? data.listings : [];
      const apiErrors: any[] = Array.isArray(data.errors) ? data.errors : [];
      const okCount = Number(data.summary?.success ?? listings.filter((l) => l.status === 'success').length);
      const failCount = Number(
        data.summary?.failed ?? listings.filter((l) => l.status !== 'success').length
      );

      const findListingForShop = (shop: ShopItem) =>
        listings.find(
          (l) =>
            String(l.client_shop_id || '') === String(shop.id) ||
            String(l.shop_id || '') === String(shop.shopId || shop.id) ||
            String(l.shop_id || '') === String(shop.id)
        );

      selectedShops.forEach((localId) => {
        const shop = availableShops.find((s) => s.id === localId);
        if (!shop) return;
        const listing = findListingForShop(shop);
        const errFromList =
          apiErrors.find(
            (e) =>
              String(e.shop_id) === String(shop.shopId || shop.id) ||
              String(e.shop_name) === String(shop.name)
          )?.error || listing?.error_message;
        const isOk = listing?.status === 'success';
        onAddLog({
          id: `log-${Date.now()}-${localId}`,
          timestamp: new Date().toISOString(),
          channel: (['shopee', 'tiktok', 'woocommerce', 'manual', 'all', 'ghn', 'spx'].includes(shop.platform)
            ? shop.platform
            : 'manual') as SyncLog['channel'],
          type: 'publish',
          status: isOk ? 'success' : 'failed',
          message: isOk
            ? `Đăng bán thành công lên [${shop.name}] — item_id=${listing?.platform_product_id || '?'} — ${title}`
            : `Đăng bán thất bại [${shop.name}]: ${errFromList || data.error || 'Lỗi không xác định'}`,
        });
      });

      if (!data.success || failCount > 0 || res.status === 207 || res.status >= 400) {
        const invalidCategory =
          data.invalid_category === true ||
          data.reset_category === true ||
          data.code === 'product.error_invalid_category' ||
          /error_invalid_category|Invalid category ID|danh mục cũ của sản phẩm đã bị Shopee/i.test(
            `${data.message || ''} ${data.error || ''} ${JSON.stringify(apiErrors)}`
          );

        if (invalidCategory) {
          const msg =
            'Danh mục cũ của sản phẩm đã bị Shopee thay đổi. Vui lòng chọn lại danh mục mới trước khi đăng bán!';
          setShopeeCategory(null);
          setShopeeAttrDefs([]);
          setShopeeAttrValues({});
          setCategoryResetToken((t) => t + 1);
          alert(`⚠ ${msg}`);
          showToast(`⚠ ${msg}`);
          onAddLog({
            id: `log-${Date.now()}-cat`,
            timestamp: new Date().toISOString(),
            channel: 'shopee',
            type: 'publish',
            status: 'failed',
            message: msg,
          });
          if (!okCount) throw new Error(msg);
          return;
        }

        const detailLines = (apiErrors.length ? apiErrors : listings.filter((l) => l.status !== 'success'))
          .map((e: any) => `• [${e.shop_name || e.shop_id}] ${e.error || e.error_message || 'Thất bại'}`)
          .slice(0, 8);
        const msg =
          data.message ||
          data.error ||
          `Đăng bán thất bại: ${failCount}/${okCount + failCount || selectedShops.length} gian hàng`;
        alert(
          `⚠ CẢNH BÁO ĐĂNG BÁN\n\n${msg}\n\n${detailLines.join('\n') || 'Không có chi tiết lỗi từ Shopee.'}\n\nKiểm tra log server: [SHOPEE UPLOAD ERROR]`
        );
        showToast(`⚠ ${okCount} thành công / ${failCount} thất bại`);
        if (!okCount) throw new Error(msg);
        return;
      }

      showToast(`Đăng bán thành công — ${okCount}/${selectedShops.length} gian hàng!`);
    } catch (err: any) {
      showToast(`Lỗi đăng bán: ${err.message}`);
      alert(`⚠ Đăng bán thất bại\n\n${err?.message || 'Lỗi không xác định'}`);
    } finally {
      setIsPublishing(false);
    }
  };

  const onEditorInput = () => {
    if (editorRef.current) setDescriptionHtml(editorRef.current.innerHTML);
  };

  // Kiểm tra kênh có hợp lệ với kích thước gói hàng hiện tại
  const isChannelSizeOk = (ch: LogisticChannel): boolean => {
    if (!ch.has_size_limit || !ch.max_dimension) return true;
    const { max_length, max_width, max_height } = ch.max_dimension;
    const dims = [packageLength, packageWidth, packageHeight].sort((a, b) => b - a);
    const maxDims = [max_length, max_width, max_height].sort((a, b) => b - a);
    return dims[0] <= maxDims[0] && dims[1] <= maxDims[1] && dims[2] <= maxDims[2];
  };

  const isChannelEnabledForShop = (shopKey: string, logisticId: number): boolean => {
    const ids = perShopLogistics[shopKey];
    if (ids) return ids.includes(logisticId);
    return logisticChannels.find((c) => c.logistic_id === logisticId)?.enabled ?? false;
  };

  const isGenericKeyEnabled = (shopKey: string, shopId: string, genericKey: string): boolean => {
    const keys = perShopLogistics[shopKey] || perShopLogistics[shopId] || [];
    return keys.includes(genericKey);
  };

  const toggleGenericChannel = (shopKey: string, shopId: string, genericKey: string) => {
    setPerShopLogistics((prev) => {
      const current = prev[shopKey] || prev[shopId] || [];
      const next = current.includes(genericKey)
        ? current.filter((k) => k !== genericKey)
        : [...current, genericKey];
      return { ...prev, [shopKey]: next, [shopId]: next };
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {toast && (
        <div className={`fixed top-5 right-5 z-50 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border flex items-center gap-2 ${
          toast.includes('⚠') || toast.toLowerCase().includes('lỗi') || toast.toLowerCase().includes('thất bại')
            ? 'bg-red-700 border-red-500'
            : 'bg-slate-900 border-slate-700'
        }`}>
          {toast.includes('⚠') || toast.toLowerCase().includes('lỗi') || toast.toLowerCase().includes('thất bại')
            ? <AlertCircle className="w-4 h-4 text-amber-300" />
            : <Check className="w-4 h-4 text-emerald-400" />}
          <span>{toast}</span>
        </div>
      )}

      {/* 1. Chọn gian hàng */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-4">
        <div className="flex justify-between items-center border-b border-gray-100 pb-3">
          <div>
            <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider flex items-center gap-2">
              <Store className="w-4 h-4 text-blue-600" /> Chọn gian hàng (Shopee · Lazada · TikTok)
            </h3>
            <p className="text-[11px] text-gray-400 mt-0.5">Tích chọn sàn muốn đăng bán đồng thời</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {availableShops.map((shop) => {
            const isSelected = selectedShops.includes(shop.id);
            const platformColor =
              shop.platform === 'shopee' ? 'orange' : shop.platform === 'lazada' ? 'blue' : 'slate';
            return (
              <label
                key={shop.id}
                className={`p-4 rounded-2xl border-2 transition-all flex items-center gap-3 cursor-pointer ${
                  isSelected ? `border-${platformColor}-500 bg-${platformColor}-50/20 shadow-xs` : 'border-gray-100 bg-white hover:border-gray-300'
                }`}
                style={isSelected ? { borderColor: shop.platform === 'shopee' ? '#f97316' : shop.platform === 'lazada' ? '#2563eb' : '#0f172a', backgroundColor: 'rgba(248,250,252,0.5)' } : undefined}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {
                    setSelectedShops((prev) =>
                      isSelected ? prev.filter((id) => id !== shop.id) : [...prev, shop.id]
                    );
                  }}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded"
                />
                <span className="text-lg">{shop.icon || '🏪'}</span>
                <div>
                  <p className="text-xs font-bold text-gray-800">{shop.name}</p>
                  <p className="text-[10px] text-gray-400 uppercase font-mono">{shop.platform}</p>
                </div>
              </label>
            );
          })}
        </div>
      </div>

      {/* 2. Thông tin cơ bản */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-5">
        <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider border-b border-gray-100 pb-3 flex items-center gap-2">
          <Info className="w-4 h-4 text-emerald-500" /> Thông tin cơ bản
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <div className="flex justify-between">
              <label className="text-xs font-extrabold text-gray-700">Tên sản phẩm *</label>
              <span className="text-[10px] font-mono text-gray-400">{title.length}/120</span>
            </div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 120))}
              placeholder="Nhập tên sản phẩm đăng bán..."
              className="w-full mt-1 px-4 py-2.5 rounded-xl border border-gray-200 text-xs font-bold"
            />
            <div className="flex flex-wrap gap-1 mt-2 items-center">
              {quickTags.map((tag) => (
                <button key={tag} type="button" onClick={() => handleInsertTag(tag + ' ')}
                  className="px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold rounded-lg">
                  {tag}
                </button>
              ))}
              <button type="button" onClick={() => { setTagDraft([...quickTags]); setTagEditValue(''); setShowTagEditor(true); }}
                className="px-2 py-0.5 bg-gray-100 text-gray-500 border border-gray-200 text-[10px] font-bold rounded-lg flex items-center gap-0.5 hover:bg-gray-200 transition-colors">
                <PenLine className="w-2.5 h-2.5" /> Chỉnh sửa
              </button>
            </div>
            {showTagEditor && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowTagEditor(false)}>
                <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
                  <h4 className="text-sm font-extrabold text-gray-800">Chỉnh sửa tag ghi nhanh</h4>
                  <div className="flex flex-wrap gap-1.5 min-h-[40px]">
                    {tagDraft.map((tag, idx) => (
                      <span key={tag + idx} className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 text-[11px] font-bold rounded-lg">
                        {tag}
                        <button type="button" onClick={() => setTagDraft((prev) => prev.filter((_, i) => i !== idx))}
                          className="ml-0.5 text-amber-400 hover:text-red-500 font-bold leading-none">&times;</button>
                      </span>
                    ))}
                    {tagDraft.length === 0 && <span className="text-[11px] text-gray-400 italic">Chưa có tag nào</span>}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={tagEditValue}
                      onChange={(e) => setTagEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const v = tagEditValue.trim();
                          if (v && !tagDraft.includes(v)) {
                            setTagDraft((prev) => [...prev, v]);
                            setTagEditValue('');
                          }
                        }
                      }}
                      placeholder='Nhập tag mới, VD: [Xả kho]'
                      className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-xs font-bold"
                    />
                    <button type="button" onClick={() => {
                      const v = tagEditValue.trim();
                      if (v && !tagDraft.includes(v)) {
                        setTagDraft((prev) => [...prev, v]);
                        setTagEditValue('');
                      }
                    }}
                      className="px-3 py-2 bg-emerald-500 text-white text-xs font-bold rounded-xl hover:bg-emerald-600 transition-colors">
                      Thêm
                    </button>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={() => setShowTagEditor(false)}
                      className="px-4 py-2 text-xs font-bold text-gray-500 bg-gray-100 rounded-xl hover:bg-gray-200 transition-colors">
                      Hủy
                    </button>
                    <button type="button" onClick={() => {
                      setQuickTags(tagDraft);
                      saveQuickTags(tagDraft);
                      setShowTagEditor(false);
                    }}
                      className="px-4 py-2 text-xs font-bold text-white bg-amber-500 rounded-xl hover:bg-amber-600 transition-colors flex items-center gap-1">
                      <Save className="w-3 h-3" /> Lưu
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="bg-orange-50/30 border border-orange-100 rounded-2xl p-4 space-y-3">
            <h4 className="text-xs font-bold text-orange-700 flex items-center gap-1.5">
              <span className="bg-orange-500 text-white px-1.5 py-0.5 rounded text-[9px]">SP</span> Shopee
            </h4>
            <SmartCategorySelector
              platform="shopee"
              accent="orange"
              label="Ngành hàng Shopee"
              value={shopeeCategory}
              onChange={setShopeeCategory}
              shopId={primaryShopeeShopId}
              forceClearToken={categoryResetToken}
            />
            <select
              value={shopeeBrand}
              onChange={(e) => {
                const v = e.target.value;
                setShopeeBrand(v);
                setShopeeBrandId(v === 'NoBrand' ? 0 : 0);
              }}
              className="w-full px-2.5 py-1.5 bg-white border rounded-lg text-xs"
            >
              <option value="NoBrand">NoBrand (brand_id=0)</option>
              <option value="Sony">Sony</option>
              <option value="JBL">JBL</option>
            </select>
            {isMedicalCategory && (
              <div className="space-y-1">
                <label className="text-[10px] font-bold text-orange-800">
                  Mã thuốc (medicine_id) <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={medicineId}
                  onChange={(e) => setMedicineId(e.target.value.replace(/[^\d]/g, ''))}
                  placeholder="Nhập medicine_id từ Shopee (số)"
                  className="w-full px-2.5 py-1.5 bg-white border border-orange-200 rounded-lg text-xs font-mono"
                />
                <p className="text-[9px] text-orange-600/90">
                  Bắt buộc với danh mục Y tế/Dược phẩm — lưu dạng chuỗi (uint64).
                </p>
              </div>
            )}
          </div>
          <div className="bg-blue-50/30 border border-blue-100 rounded-2xl p-4 space-y-3">
            <h4 className="text-xs font-bold text-blue-700 flex items-center gap-1.5">
              <span className="bg-blue-600 text-white px-1.5 py-0.5 rounded text-[9px]">LZ</span> Lazada
            </h4>
            <SmartCategorySelector
              platform="lazada"
              accent="blue"
              label="Ngành hàng Lazada"
              value={lazadaCategory}
              onChange={setLazadaCategory}
            />
            <select value={lazadaBrand} onChange={(e) => setLazadaBrand(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border rounded-lg text-xs">
              <option value="No Brand">No Brand</option>
              <option value="OEM">OEM</option>
            </select>
          </div>
          <div className="bg-slate-100/60 border border-slate-200 rounded-2xl p-4 space-y-3">
            <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <span className="bg-black text-white px-1.5 py-0.5 rounded text-[9px]">TT</span> TikTok
            </h4>
            <SmartCategorySelector
              platform="tiktok"
              accent="slate"
              label="Ngành hàng TikTok"
              value={tiktokCategory}
              onChange={setTiktokCategory}
            />
            <select value={tiktokBrand} onChange={(e) => setTiktokBrand(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border rounded-lg text-xs">
              <option value="No Brand">No Brand</option>
              <option value="OEM">OEM</option>
            </select>
          </div>
        </div>

        {shopeeCategory?.categoryId && (
          <div className="border border-orange-100 rounded-2xl p-4 bg-orange-50/20 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-bold text-orange-700 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5" /> Thuộc tính bắt buộc Shopee
              </h4>
              {loadingShopeeAttrs && (
                <span className="text-[10px] text-orange-500 font-medium flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Đang tải...
                </span>
              )}
            </div>
            {!primaryShopeeShopId ? (
              <p className="text-[10px] text-amber-700 font-medium">Chọn ít nhất một gian hàng Shopee để tải thuộc tính danh mục.</p>
            ) : shopeeMandatoryAttrs.length === 0 && !loadingShopeeAttrs ? (
              <p className="text-[10px] text-gray-400">Danh mục này không có thuộc tính bắt buộc (hoặc chưa lấy được từ API).</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {shopeeMandatoryAttrs.map((attr) => {
                  const key = String(attr.attribute_id);
                  const hasOptions = Array.isArray(attr.values) && attr.values.length > 0;
                  return (
                    <div key={key} className="space-y-1">
                      <label className="text-[10px] font-bold text-gray-600">
                        {attr.attribute_name} <span className="text-red-500">*</span>
                      </label>
                      {hasOptions ? (
                        <select
                          value={shopeeAttrValues[key] || ''}
                          onChange={(e) =>
                            setShopeeAttrValues((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          className="w-full px-2.5 py-1.5 bg-white border border-orange-100 rounded-lg text-xs"
                        >
                          <option value="">— Chọn —</option>
                          {attr.values.map((v) => (
                            <option key={v.value_id} value={String(v.value_id)}>
                              {v.name || v.value_id}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={shopeeAttrValues[key] || ''}
                          onChange={(e) =>
                            setShopeeAttrValues((prev) => ({ ...prev, [key]: e.target.value }))
                          }
                          placeholder="Nhập giá trị"
                          className="w-full px-2.5 py-1.5 bg-white border border-orange-100 rounded-lg text-xs"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. Hình ảnh */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-4">
        <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider border-b border-gray-100 pb-3 flex items-center gap-2">
          <ImageIcon className="w-4 h-4 text-blue-600" /> Quản lý hình ảnh
        </h3>
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-6 gap-3">
          {images.map((url, idx) => (
            <div key={idx} className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 group">
              <img src={url} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
              <button type="button" onClick={() => removeImage(idx)}
                className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                <Trash2 className="w-3 h-3" />
              </button>
              {idx === 0 && (
                <span className="absolute bottom-1 left-1 bg-blue-600 text-white text-[8px] font-bold px-1 rounded">Ảnh bìa</span>
              )}
            </div>
          ))}
          {images.length < 9 && (
            <label className="aspect-square rounded-xl border-2 border-dashed border-gray-300 flex flex-col items-center justify-center cursor-pointer hover:border-blue-400 hover:bg-blue-50/30 transition-all">
              <Upload className="w-5 h-5 text-gray-400" />
              <span className="text-[10px] font-bold text-gray-500 mt-1">Tải ảnh</span>
              <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageUpload} />
            </label>
          )}
        </div>
        <p className="text-[10px] text-gray-400">Tối đa 9 ảnh. Ảnh đầu tiên là ảnh bìa.</p>
      </div>

      {/* 4. Phiên bản · Giá & Tồn kho — gom nhóm theo gian hàng */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-6">

        {/* ===== A. Thiết lập phiên bản sản phẩm (Tier Attributes) ===== */}
        <div>
          <div className="flex justify-between items-center border-b border-gray-100 pb-3 mb-4">
            <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider flex items-center gap-2">
              <Table2 className="w-4 h-4 text-violet-600" /> Thiết lập phiên bản sản phẩm
            </h3>
          </div>

          {/* Toggle thiết lập cân nặng riêng */}
          <div className="flex items-center gap-3 p-3 bg-violet-50 border border-violet-200 rounded-xl mb-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={perVariationWeight}
                onChange={(e) => setPerVariationWeight(e.target.checked)}
                className="w-4 h-4 accent-violet-600" />
              <span className="text-xs font-bold text-violet-800">
                Thiết lập cân nặng &amp; kích thước riêng cho từng phân loại
              </span>
            </label>
            <span className="text-[10px] text-violet-600 font-medium">
              {perVariationWeight ? '→ Nhập weight/dim tại bảng bên dưới' : '→ Dùng cân nặng chung bên dưới mục Đóng gói'}
            </span>
          </div>

          {/* Danh sách thuộc tính — Tag Input UI */}
          <div className="space-y-3">
            {tierAttrs.map((attr, attrIdx) => {
              const inputVal = tierInputValues[attr.id] ?? '';
              return (
                <div key={attr.id} className="border border-gray-100 rounded-2xl p-4 bg-gray-50/50">
                  {/* Dòng 1: Tên thuộc tính + Nút xóa */}
                  <div className="flex items-center gap-3 mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-extrabold text-gray-500 uppercase tracking-wider shrink-0">Tên thuộc tính</span>
                      <input
                        type="text"
                        value={attr.name}
                        onChange={(e) => updateTierAttrName(attr.id, e.target.value)}
                        placeholder="VD: Màu, Size..."
                        className="px-3 py-1.5 border border-gray-200 rounded-xl text-xs font-bold bg-white w-36 focus:border-violet-400 focus:outline-none"
                      />
                    </div>
                    {tierAttrs.length > 1 && (
                      <button type="button" onClick={() => {
                        setTierAttrs((prev) => prev.filter((a) => a.id !== attr.id));
                      }}
                        className="ml-auto p-1.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Dòng 2: Tag Input */}
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Vùng tags */}
                    <div className="flex flex-wrap items-center gap-1.5 flex-1 min-w-0">
                      {attr.values.map((tag) => (
                        <span key={tag} className="inline-flex items-center gap-1 px-2.5 py-1 bg-teal-100 text-teal-800 text-xs font-bold rounded-full border border-teal-200">
                          {tag}
                          <button type="button" onClick={() => removeTierTag(attr.id, tag)}
                            className="hover:text-red-500 transition-colors ml-0.5 leading-none">×</button>
                        </span>
                      ))}
                      {/* Input nhập tag mới */}
                      <input
                        type="text"
                        value={inputVal}
                        onChange={(e) => setTierInputValues((prev) => ({ ...prev, [attr.id]: e.target.value }))}
                        onKeyDown={(e) => handleTagInputKeyDown(e, attr.id)}
                        placeholder={attr.values.length === 0 ? 'Nhấn Enter để thêm giá trị...' : 'Nhập giá trị...'}
                        className="flex-1 min-w-[140px] px-2 py-1 border border-dashed border-gray-300 rounded-full text-xs bg-white focus:border-violet-400 focus:outline-none placeholder:text-gray-300"
                      />
                    </div>
                  </div>
                  <p className="text-[9px] text-gray-400 mt-1.5">Nhấn <kbd className="px-1 py-0.5 bg-gray-100 border border-gray-200 rounded text-[9px] font-mono">Enter</kbd> hoặc <kbd className="px-1 py-0.5 bg-gray-100 border border-gray-200 rounded text-[9px] font-mono">,</kbd> để thêm giá trị. Tổ hợp biến thể được sinh tự động.</p>

                  {/* Ảnh cho thuộc tính — chỉ hiện cho thuộc tính đầu tiên */}
                  {attrIdx === 0 && attr.values.length > 0 && (
                    <div className="mt-4 border-t border-dashed border-gray-200 pt-4">
                      <p className="text-[10px] font-extrabold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1">
                        <ImageIcon className="w-3.5 h-3.5" /> Hình ảnh cho thuộc tính
                      </p>
                      <div className="flex flex-wrap gap-3">
                        {attr.values.map((val) => (
                          <div key={val} className="flex flex-col items-center gap-1.5">
                            <div className="w-16 h-16 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-100 relative group">
                              {attr.images[val] ? (
                                <img src={attr.images[val]} alt={val} className="w-full h-full object-cover" />
                              ) : (
                                <ImageIcon className="w-6 h-6 text-gray-300" />
                              )}
                              <label className="absolute inset-0 cursor-pointer opacity-0 group-hover:opacity-100 bg-black/40 flex items-center justify-center transition-opacity rounded-xl">
                                <Upload className="w-4 h-4 text-white" />
                                <input type="file" accept="image/*" className="hidden"
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    const reader = new FileReader();
                                    reader.onload = (ev) => {
                                      setTierAttrs((prev) => prev.map((a) =>
                                        a.id === attr.id
                                          ? { ...a, images: { ...a.images, [val]: ev.target?.result as string } }
                                          : a
                                      ));
                                    };
                                    reader.readAsDataURL(file);
                                  }} />
                              </label>
                            </div>
                            <span className="text-[9px] font-bold text-gray-500 text-center truncate w-16">{val}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {tierAttrs.length < 2 && (
            <button type="button" onClick={() => {
              const newId = `attr-${Date.now()}`;
              setTierAttrs((prev) => [...prev, { id: newId, name: '', values: [], images: {} }]);
              setTierInputValues((prev) => ({ ...prev, [newId]: '' }));
            }}
              className="mt-2 px-3 py-1.5 bg-gray-50 text-gray-600 text-xs font-bold rounded-xl border border-gray-200 flex items-center gap-1 hover:bg-gray-100">
              <Plus className="w-3.5 h-3.5" /> Thêm thuộc tính
            </button>
          )}
        </div>

        {/* ===== B. Giá và tồn kho — Mẹo thiết lập nhanh ===== */}
        <div>
          <div className="border-t border-dashed border-gray-100 pt-5">
            <div className="flex justify-between items-center border-b border-gray-100 pb-3 mb-4">
              <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider flex items-center gap-2">
                <Table2 className="w-4 h-4 text-orange-500" /> Giá &amp; Tồn kho theo gian hàng
              </h3>
              <button type="button" onClick={addVariantRow}
                className="px-3 py-1.5 bg-orange-50 text-orange-700 text-xs font-bold rounded-xl border border-orange-200 flex items-center gap-1">
                <Plus className="w-3.5 h-3.5" /> Thêm phân loại
              </button>
            </div>

            {/* Bulk Apply Bar */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-4 mb-4">
              <p className="text-[10px] font-extrabold text-blue-700 uppercase tracking-wider mb-3 flex items-center gap-1">
                <Zap className="w-3.5 h-3.5" /> Mẹo thiết lập nhanh — Áp dụng chung
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                <div>
                  <label className="text-[9px] font-bold text-gray-500 block mb-1">SKU</label>
                  <input type="text" value={bulkSku} onChange={(e) => setBulkSku(e.target.value)}
                    placeholder="Mã SKU"
                    className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs" />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-gray-500 block mb-1">Tồn kho</label>
                  <input type="number" min={0} value={bulkStock} onChange={(e) => setBulkStock(e.target.value)}
                    placeholder="Số lượng"
                    className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs" />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-gray-500 block mb-1">Giá gốc</label>
                  <input type="number" min={0} value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)}
                    placeholder="Giá Shopee"
                    className="w-full px-2 py-1.5 border border-orange-200 bg-white rounded-lg text-xs" />
                </div>
                <div>
                  <label className="text-[9px] font-bold text-gray-500 block mb-1">Giá KM</label>
                  <input type="number" min={0} value={bulkPromoPrice} onChange={(e) => setBulkPromoPrice(e.target.value)}
                    placeholder="Giá khuyến mại"
                    className="w-full px-2 py-1.5 border border-red-200 bg-white rounded-lg text-xs" />
                </div>
                {perVariationWeight && (
                  <div>
                    <label className="text-[9px] font-bold text-gray-500 block mb-1">Cân nặng (g)</label>
                    <input type="number" min={0} value={bulkWeight} onChange={(e) => setBulkWeight(e.target.value)}
                      placeholder="gram"
                      className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs" />
                  </div>
                )}
                <div>
                  <label className="text-[9px] font-bold text-gray-500 block mb-1">Ngày giao</label>
                  <input type="number" min={7} max={15} value={bulkDays} onChange={(e) => setBulkDays(e.target.value)}
                    placeholder="7–15 ngày"
                    className="w-full px-2 py-1.5 border border-gray-200 rounded-lg text-xs" />
                </div>
              </div>
              <button type="button" onClick={handleBulkApply}
                className="mt-3 w-full sm:w-auto px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl flex items-center justify-center gap-2">
                <Zap className="w-3.5 h-3.5" /> Áp dụng cho tất cả biến thể
              </button>
            </div>

            {/* ===== Bảng biến thể — gom nhóm theo gian hàng ===== */}
            {variants.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-xs">
                Chưa có biến thể — nhập giá trị thuộc tính (Enter) để hệ thống tự sinh tổ hợp
              </div>
            ) : (
              <div className="space-y-5">
                {selectedShopItems.map((shop) => (
                  <div key={shop.id} className="border border-gray-100 rounded-2xl overflow-hidden">
                    {/* Header group */}
                    <div className="bg-gray-50 border-b border-gray-100 px-4 py-2.5 flex items-center gap-2">
                      <span className="text-base">{shop.icon || '🏪'}</span>
                      <span className="text-xs font-extrabold text-gray-700">
                        Group [{shop.platform.charAt(0).toUpperCase() + shop.platform.slice(1)}] {shop.name}
                      </span>
                    </div>
                    {/* Table */}
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 text-[9px] font-extrabold text-gray-500 uppercase">
                          <tr>
                            <th className="px-3 py-2 text-left">Phân loại</th>
                            <th className="px-3 py-2 text-left">SKU</th>
                            <th className="px-3 py-2 text-right">Tồn kho</th>
                            {perVariationWeight && <th className="px-3 py-2 text-right">KL(g)</th>}
                            <th className="px-3 py-2 text-right text-orange-600">Giá gốc</th>
                            <th className="px-3 py-2 text-right text-red-600">Giá KM</th>
                            <th className="px-3 py-2 text-right text-blue-600">Giá Lazada</th>
                            <th className="px-3 py-2 text-right text-slate-700">Giá TikTok</th>
                            <th className="px-3 py-2 w-8" />
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {variants.map((v) => {
                            const smart = applySmartPricesFromShopee(v.priceShopee);
                            return (
                              <tr key={`${shop.id}-${v.id}`} className="hover:bg-gray-50/40">
                                <td className="px-2 py-1.5">
                                  <input value={v.name} onChange={(e) => updateVariant(v.id, { name: e.target.value })}
                                    className="w-full min-w-[100px] px-2 py-1.5 border border-violet-200 rounded-lg text-xs font-bold bg-violet-50/20" />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input value={v.sku} onChange={(e) => updateVariant(v.id, { sku: e.target.value })}
                                    className="w-full min-w-[80px] px-2 py-1.5 border rounded-lg text-xs font-mono" />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input type="number" min={0} value={v.stock} onChange={(e) => updateVariant(v.id, { stock: Number(e.target.value) })}
                                    className="w-20 px-2 py-1.5 border rounded-lg text-xs text-right font-mono" />
                                </td>
                                {perVariationWeight && (
                                  <td className="px-2 py-1.5">
                                    <input type="number" min={0} value={v.weight}
                                      onChange={(e) => updateVariant(v.id, { weight: Number(e.target.value) })}
                                      className="w-16 px-2 py-1.5 border rounded-lg text-xs text-right" />
                                  </td>
                                )}
                                <td className="px-2 py-1.5">
                                  <input type="number" min={0} value={v.priceShopee || ''}
                                    onChange={(e) => handleShopeePriceChange(v.id, e.target.value)}
                                    className="w-24 px-2 py-1.5 border border-orange-200 bg-orange-50/30 rounded-lg text-xs text-right font-bold text-orange-700" />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input type="number" min={0} value={v.pricePromo || ''}
                                    onChange={(e) => updateVariant(v.id, { pricePromo: Number(e.target.value) || 0 })}
                                    className="w-24 px-2 py-1.5 border border-red-200 bg-red-50/30 rounded-lg text-xs text-right text-red-600" />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input type="number" min={0} value={v.priceLazada || ''} readOnly
                                    className="w-24 px-2 py-1.5 border border-blue-100 bg-blue-50/30 rounded-lg text-xs text-right text-blue-600" />
                                </td>
                                <td className="px-2 py-1.5">
                                  <input type="number" min={0} value={v.priceTiktok || ''} readOnly
                                    className="w-24 px-2 py-1.5 border border-slate-100 bg-slate-50 rounded-lg text-xs text-right text-slate-700" />
                                </td>
                                <td className="px-2 py-1.5">
                                  <button type="button" onClick={() => removeVariantRow(v.id)} disabled={variants.length <= 1}
                                    className="p-1 text-red-400 hover:text-red-600 disabled:opacity-30">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}

                {/* Khi chỉ có 1 shop → hiện bảng rút gọn */}
                {selectedShopItems.length === 0 && (
                  <div className="overflow-x-auto rounded-xl border border-gray-200">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 text-[9px] font-extrabold text-gray-500 uppercase">
                        <tr>
                          <th className="px-3 py-2 text-left">Phân loại</th>
                          <th className="px-3 py-2 text-left">SKU</th>
                          <th className="px-3 py-2 text-right">Tồn kho</th>
                          {perVariationWeight && <th className="px-3 py-2 text-right">KL(g)</th>}
                          <th className="px-3 py-2 text-right text-orange-600">Giá gốc</th>
                          <th className="px-3 py-2 text-right text-red-600">Giá KM</th>
                          <th className="px-3 py-2 text-right text-blue-600">Giá Lazada</th>
                          <th className="px-3 py-2 text-right text-slate-700">Giá TikTok</th>
                          <th className="px-3 py-2 w-8" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {variants.map((v) => (
                          <tr key={v.id} className="hover:bg-gray-50/40">
                            <td className="px-2 py-1.5">
                              <input value={v.name} onChange={(e) => updateVariant(v.id, { name: e.target.value })}
                                className="w-full min-w-[100px] px-2 py-1.5 border border-violet-200 rounded-lg text-xs font-bold" />
                            </td>
                            <td className="px-2 py-1.5">
                              <input value={v.sku} onChange={(e) => updateVariant(v.id, { sku: e.target.value })}
                                className="w-full min-w-[80px] px-2 py-1.5 border rounded-lg text-xs font-mono" />
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="number" min={0} value={v.stock} onChange={(e) => updateVariant(v.id, { stock: Number(e.target.value) })}
                                className="w-20 px-2 py-1.5 border rounded-lg text-xs text-right" />
                            </td>
                            {perVariationWeight && (
                              <td className="px-2 py-1.5">
                                <input type="number" min={0} value={v.weight}
                                  onChange={(e) => updateVariant(v.id, { weight: Number(e.target.value) })}
                                  className="w-16 px-2 py-1.5 border rounded-lg text-xs text-right" />
                              </td>
                            )}
                            <td className="px-2 py-1.5">
                              <input type="number" min={0} value={v.priceShopee || ''}
                                onChange={(e) => handleShopeePriceChange(v.id, e.target.value)}
                                className="w-24 px-2 py-1.5 border border-orange-200 bg-orange-50/30 rounded-lg text-xs text-right font-bold text-orange-700" />
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="number" min={0} value={v.pricePromo || ''}
                                onChange={(e) => updateVariant(v.id, { pricePromo: Number(e.target.value) || 0 })}
                                className="w-24 px-2 py-1.5 border border-red-200 bg-red-50/30 rounded-lg text-xs text-right text-red-600" />
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="number" min={0} value={v.priceLazada || ''} readOnly
                                className="w-24 px-2 py-1.5 border border-blue-100 bg-blue-50/30 rounded-lg text-xs text-right text-blue-600" />
                            </td>
                            <td className="px-2 py-1.5">
                              <input type="number" min={0} value={v.priceTiktok || ''} readOnly
                                className="w-24 px-2 py-1.5 border border-slate-100 bg-slate-50 rounded-lg text-xs text-right text-slate-700" />
                            </td>
                            <td className="px-2 py-1.5">
                              <button type="button" onClick={() => removeVariantRow(v.id)} disabled={variants.length <= 1}
                                className="p-1 text-red-400 hover:text-red-600 disabled:opacity-30">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 5. Mô tả sản phẩm + AI */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-4">
        <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider border-b border-gray-100 pb-3 flex items-center gap-2">
          <PenLine className="w-4 h-4 text-indigo-500" /> Mô tả sản phẩm
        </h3>
        <div className="bg-gray-100 p-1 rounded-xl flex gap-1 w-full sm:w-auto">
          <button type="button" onClick={() => setDescMode('manual')}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all ${descMode === 'manual' ? 'bg-white text-indigo-600 shadow-xs' : 'text-gray-500'}`}>
            Nhập thủ công
          </button>
          <button type="button" onClick={() => setDescMode('ai')}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${descMode === 'ai' ? 'bg-white text-indigo-600 shadow-xs' : 'text-gray-500'}`}>
            <Sparkles className="w-3.5 h-3.5" /> Viết bằng AI
          </button>
        </div>

        {descMode === 'ai' ? (
          <div className="space-y-3 bg-indigo-50/40 border border-indigo-100 rounded-2xl p-5">
            <label className="text-xs font-bold text-gray-700">Từ khóa / Tính năng nổi bật</label>
            <textarea
              value={aiKeywords}
              onChange={(e) => setAiKeywords(e.target.value)}
              rows={3}
              placeholder="VD: Bluetooth 5.0, pin 8h, chống nước IPX5, bass mạnh..."
              className="w-full px-3 py-2 border border-indigo-200 rounded-xl text-xs"
            />
            <button type="button" onClick={handleGenerateDescription} disabled={isGeneratingDesc}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl flex items-center gap-2 disabled:opacity-60">
              {isGeneratingDesc ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> AI đang soạn thảo...</>
              ) : (
                <><Sparkles className="w-4 h-4" /> Tạo mô tả</>
              )}
            </button>
          </div>
        ) : (
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={onEditorInput}
            className="min-h-[200px] px-4 py-3 border border-gray-200 rounded-xl text-xs leading-relaxed focus:outline-none focus:border-indigo-400 prose prose-sm max-w-none"
            data-placeholder="Nhập mô tả sản phẩm (hỗ trợ HTML)..."
          />
        )}
      </div>

      {/* 6. Đóng gói & Vận chuyển */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-6">

        {/* Header */}
        <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider border-b border-gray-100 pb-3 flex items-center gap-2">
          <Package className="w-4 h-4 text-teal-600" /> Đóng gói &amp; Vận chuyển
        </h3>

        {/* ===== A. Thông tin đóng gói ===== */}
        <div>
          <p className="text-[10px] font-bold text-gray-500 mb-3 flex items-center gap-1">
            <Package className="w-3.5 h-3.5" /> Thông tin đóng gói
          </p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div>
              <label className="text-[10px] font-bold text-gray-500">Khối lượng (gram)</label>
              <div className="relative mt-1">
                <input type="number" min={0} value={packageWeight} onChange={(e) => setPackageWeight(Number(e.target.value))}
                  className="w-full px-3 py-2 pr-10 border rounded-xl text-xs" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 font-medium pointer-events-none">gram</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-gray-500">Chiều rộng (cm)</label>
              <div className="relative mt-1">
                <input type="number" min={0} value={packageWidth} onChange={(e) => setPackageWidth(Number(e.target.value))}
                  className="w-full px-3 py-2 pr-8 border rounded-xl text-xs" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 font-medium pointer-events-none">cm</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-gray-500">Chiều dài (cm)</label>
              <div className="relative mt-1">
                <input type="number" min={0} value={packageLength} onChange={(e) => setPackageLength(Number(e.target.value))}
                  className="w-full px-3 py-2 pr-8 border rounded-xl text-xs" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 font-medium pointer-events-none">cm</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-gray-500">Chiều cao (cm)</label>
              <div className="relative mt-1">
                <input type="number" min={0} value={packageHeight} onChange={(e) => setPackageHeight(Number(e.target.value))}
                  className="w-full px-3 py-2 pr-8 border rounded-xl text-xs" />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-400 font-medium pointer-events-none">cm</span>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-bold text-gray-500">Phương thức giao hàng</label>
              <select value={shippingMethod} onChange={(e) => setShippingMethod(e.target.value)}
                className="w-full mt-1 px-3 py-2 border rounded-xl text-xs bg-white">
                <option>Giao hàng tiêu chuẩn</option>
                <option>Giao hàng nhanh</option>
                <option>Giao hàng hỏa tốc</option>
              </select>
            </div>
          </div>
        </div>

        {/* ===== B. Chọn đơn vị vận chuyển — Table 2 cột: Kênh bán | Đơn vị vận chuyển ===== */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-bold text-gray-500 flex items-center gap-1 uppercase tracking-wider">
              <Truck className="w-3.5 h-3.5" /> Chọn đơn vị vận chuyển
            </p>
            <div className="flex items-center gap-2">
              {loadingChannels && <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-500" />}
              {channelError && <span className="text-[10px] text-red-500">{channelError}</span>}
            </div>
          </div>

          {!primaryShopeeShopId ? (
            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Chọn gian hàng Shopee để tải danh sách kênh vận chuyển.
            </p>
          ) : loadingChannels ? (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Đang tải kênh vận chuyển...
            </div>
          ) : channelError ? (
            <p className="text-[10px] text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{channelError}</p>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-100">
              {/* Table Header */}
              <div className="grid grid-cols-5 bg-gray-50 border-b border-gray-100 px-4 py-2.5 text-[9px] font-extrabold text-gray-400 uppercase tracking-wider">
                <div className="col-span-2 flex items-center gap-1.5">
                  <Store className="w-3.5 h-3.5" /> Kênh bán
                </div>
                <div className="col-span-3 flex items-center gap-1.5">
                  <Truck className="w-3.5 h-3.5" /> Đơn vị vận chuyển
                </div>
              </div>

              {/* Table Rows */}
              {selectedShopItems.filter((s) => s.platform === 'shopee').length === 0 ? (
                <div className="flex items-center gap-2 text-xs text-gray-400 px-4 py-5 bg-gray-50/30">
                  <Info className="w-4 h-4" />
                  Chưa chọn gian hàng Shopee — kênh vận chuyển sẽ được tải khi chọn Shopee.
                </div>
              ) : (
                selectedShopItems
                  .filter((s) => s.platform === 'shopee')
                  .map((shop) => {
                    const shopKey = shop.shopId || shop.id;
                    const shopKeys = perShopLogistics[shopKey] || perShopLogistics[shop.id] || [];
                    const genericOptions = (['bulky', 'express', 'fast', 'sameday', 'spx_locker', 'smartbox', 'pickup'] as const);
                    return (
                      <div key={shop.id} className="grid grid-cols-5 border-b border-gray-50 last:border-b-0 hover:bg-gray-50/20 transition-colors">

                        {/* Cột trái: Icon + Tên gian hàng */}
                        <div className="col-span-2 px-4 py-4 flex items-center gap-3 border-r border-gray-100">
                          <span className="text-lg">{shop.icon || '🛒'}</span>
                          <div className="min-w-0">
                            <p className="text-xs font-extrabold text-gray-800 truncate">{shop.name}</p>
                            <p className="text-[9px] text-teal-600 font-bold">{shopKeys.length} kênh bật</p>
                          </div>
                        </div>

                        {/* Cột phải: Grid 3 cột — 7 checkbox generic */}
                        <div className="col-span-3 px-3 py-3">
                          <div className="grid grid-cols-3 gap-1.5">
                            {genericOptions.map((gk) => {
                              const isAvailable = logisticChannels.some((ch) => classifyGenericKey(ch) === gk);
                              const enabled = shopKeys.includes(gk);
                              const label = LOGISTIC_GROUP_LABELS[gk] || gk;
                              return (
                                <label key={gk}
                                  className={`flex items-center gap-1.5 px-2.5 py-2 rounded-xl border text-[10px] cursor-pointer transition-all select-none ${
                                    !isAvailable
                                      ? 'border-gray-100 opacity-35 cursor-not-allowed'
                                      : enabled
                                      ? 'border-teal-400 bg-teal-50/40'
                                      : 'border-gray-100 hover:border-teal-300'
                                  }`}>
                                  <input type="checkbox"
                                    checked={enabled}
                                    disabled={!isAvailable}
                                    onChange={() => isAvailable && toggleGenericChannel(shopKey, shop.id, gk)}
                                    className="w-3.5 h-3.5 accent-teal-600 shrink-0" />
                                  <span className={`truncate font-medium ${isAvailable ? 'text-gray-700' : 'text-gray-400'}`}>
                                    {label}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>

                      </div>
                    );
                  })
              )}
            </div>
          )}
        </div>

        {/* ===== C. Hàng đặt trước (Pre-order) ===== */}
        <div>
          <p className="text-[10px] font-bold text-gray-500 mb-3 flex items-center gap-1">
            <Zap className="w-3.5 h-3.5" /> Hàng Đặt Trước (Pre-order)
          </p>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="radio" name="preOrder" checked={!isPreOrder}
                onChange={() => setIsPreOrder(false)} className="w-4 h-4 accent-teal-600" />
              <span className="text-xs font-medium text-gray-700">Không</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="radio" name="preOrder" checked={isPreOrder}
                onChange={() => setIsPreOrder(true)} className="w-4 h-4 accent-teal-600" />
              <span className="text-xs font-medium text-gray-700">Đồng ý</span>
            </label>
          </div>
          {isPreOrder && (
            <div className="mt-3 flex items-center gap-4">
              <div>
                <label className="text-[10px] font-bold text-gray-600">Số ngày chuẩn bị hàng</label>
                <div className="flex items-center gap-2 mt-1">
                  <input type="number" min={7} max={15} value={daysToShip}
                    onChange={(e) => setDaysToShip(Math.max(7, Math.min(15, Number(e.target.value))))}
                    className="w-20 px-3 py-2 border border-teal-200 bg-teal-50 rounded-xl text-xs text-center font-bold text-teal-800" />
                  <span className="text-xs text-gray-500">ngày (7 – 15)</span>
                </div>
                <p className="text-[9px] text-gray-400 mt-1">
                  Ngày kể từ khi khách đặt hàng đến khi Shopee giao cho đơn vị vận chuyển.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="pt-2 border-t border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-xs text-slate-500 font-medium">
          <AlertCircle className="w-4 h-4 text-blue-500 shrink-0" />
          <span>Giá đa sàn tự chênh lệch chống quét trùng lặp. Lưu nháp trước khi đăng.</span>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <button type="button" onClick={handleSaveListing} disabled={isSaving}
            className="flex-1 sm:flex-initial px-5 py-3 bg-gray-100 hover:bg-gray-200 text-gray-800 font-extrabold text-xs rounded-xl flex items-center justify-center gap-2 disabled:opacity-60">
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Lưu nháp
          </button>
          <button type="button" onClick={handlePublish} disabled={isPublishing}
            className="flex-1 sm:flex-initial px-8 py-3 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-md flex items-center justify-center gap-2 disabled:opacity-60">
            {isPublishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
            Xác nhận đăng bán ({selectedShops.length})
          </button>
        </div>
      </div>
    </div>
  );
}
