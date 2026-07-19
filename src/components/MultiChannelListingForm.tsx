import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, SyncLog } from '../types';
import {
  CategorySelection,
  ShopeeAttributeSelection,
  ShopeeCategoryAttribute,
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
}

export interface MultiChannelListingPayload {
  selectedShops: string[];
  title: string;
  shopeeCat: string;
  shopeeCategoryId: string;
  shopeeBrand: string;
  shopeeBrandId?: number;
  shopeeAttributes?: ShopeeAttributeSelection[];
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
  descriptionHtml: string;
  packageWeight: number;
  packageLength: number;
  packageWidth: number;
  packageHeight: number;
  shippingMethod: string;
  warehouseProductId?: string;
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
  initialProductId?: string | null;
}

const TITLE_TEMPLATES = [
  { label: '[Chính hãng]', value: '[Chính hãng] ' },
  { label: '[Ảnh thật]', value: '[Ảnh thật] ' },
  { label: '[FreeShip]', value: '[FreeShip] ' },
  { label: '[Siêu Sale]', value: '[Siêu Sale] ' },
  { label: '[Có bảo hành]', value: '[Có bảo hành] ' },
];

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

export default function MultiChannelListingForm({ products, shops, onAddLog, initialProductId }: MultiChannelListingFormProps) {
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
  const [warehouseProductId, setWarehouseProductId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [shopeeCategory, setShopeeCategory] = useState<CategorySelection | null>(null);
  const [shopeeBrand, setShopeeBrand] = useState('NoBrand');
  const [shopeeBrandId, setShopeeBrandId] = useState(0);
  const [shopeeAttrDefs, setShopeeAttrDefs] = useState<ShopeeCategoryAttribute[]>([]);
  const [shopeeAttrValues, setShopeeAttrValues] = useState<Record<string, string>>({});
  const [loadingShopeeAttrs, setLoadingShopeeAttrs] = useState(false);
  const [lazadaCategory, setLazadaCategory] = useState<CategorySelection | null>(null);
  const [lazadaBrand, setLazadaBrand] = useState('No Brand');
  const [tiktokCategory, setTiktokCategory] = useState<CategorySelection | null>(null);
  const [tiktokBrand, setTiktokBrand] = useState('No Brand');

  const [images, setImages] = useState<string[]>([]);
  const [variants, setVariants] = useState<ListingVariant[]>([]);

  const [descMode, setDescMode] = useState<'manual' | 'ai'>('manual');
  const [descriptionHtml, setDescriptionHtml] = useState('');
  const [aiKeywords, setAiKeywords] = useState('');
  const [isGeneratingDesc, setIsGeneratingDesc] = useState(false);

  const [packageWeight, setPackageWeight] = useState(500);
  const [packageLength, setPackageLength] = useState(20);
  const [packageWidth, setPackageWidth] = useState(15);
  const [packageHeight, setPackageHeight] = useState(10);
  const [shippingMethod, setShippingMethod] = useState('Giao hàng tiêu chuẩn');

  const [toast, setToast] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  const warehouseProduct = products.find((p) => p.id === warehouseProductId);

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

  useEffect(() => {
    if (!warehouseProductId && products.length > 0) {
      setWarehouseProductId(products[0].id);
    }
  }, [products, warehouseProductId]);

  useEffect(() => {
    if (initialProductId) setWarehouseProductId(initialProductId);
  }, [initialProductId]);

  useEffect(() => {
    if (!warehouseProduct) return;
    setTitle(warehouseProduct.title);
    setVariants(buildVariantsFromProducts(products, warehouseProduct));
    if (warehouseProduct.imageUrl) {
      setImages([warehouseProduct.imageUrl]);
    }
    if (warehouseProduct.description) {
      setDescriptionHtml(warehouseProduct.description);
    }
    if (warehouseProduct.weight) setPackageWeight(warehouseProduct.weight);
  }, [warehouseProduct?.id]);

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
        });
        const res = await fetch(`/api/shopee/category-attributes?${qs}`, {
          headers: { Authorization: token ? `Bearer ${token}` : '' },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.success) {
          setShopeeAttrDefs([]);
          setShopeeAttrValues({});
          return;
        }
        const attrs: ShopeeCategoryAttribute[] = Array.isArray(data.attributes) ? data.attributes : [];
        setShopeeAttrDefs(attrs);
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
        }
      } finally {
        if (!cancelled) setLoadingShopeeAttrs(false);
      }
    };
    loadAttrs();
    return () => {
      cancelled = true;
    };
  }, [shopeeCategory?.categoryId, primaryShopeeShopId]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const buildPayload = useCallback((): MultiChannelListingPayload => ({
    selectedShops,
    title,
    shopeeCat: shopeeCategory?.label || '',
    shopeeCategoryId: shopeeCategory?.categoryId || '',
    shopeeBrand,
    shopeeBrandId: shopeeBrand === 'NoBrand' ? 0 : shopeeBrandId,
    shopeeAttributes: buildShopeeAttributesPayload(),
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
    descriptionHtml,
    packageWeight,
    packageLength,
    packageWidth,
    packageHeight,
    shippingMethod,
    warehouseProductId: warehouseProductId || undefined,
  }), [
    selectedShops, title, shopeeCategory, shopeeBrand, shopeeBrandId, buildShopeeAttributesPayload,
    lazadaCategory, lazadaBrand, tiktokCategory, tiktokBrand, images, variants, descriptionHtml,
    packageWeight, packageLength, packageWidth, packageHeight, shippingMethod, warehouseProductId,
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
    if (needsLazada && !lazadaCategory?.categoryId) {
      alert('Vui lòng chọn ngành hàng Lazada (Category ID)!');
      return;
    }
    if (needsTiktok && !tiktokCategory?.categoryId) {
      alert('Vui lòng chọn ngành hàng TikTok (Category ID)!');
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
          const meta = cfgData.meta?.[warehouseProductId || ''];
          if (meta?.shopTitles) shopTitlesPayload = meta.shopTitles;
          if (cfgData.config?.autoApplyFrame && cfgData.config?.framePngUrl && warehouseProduct) {
            const cover = warehouseProduct.imageUrl || warehouseProduct.avatarUrl;
            if (cover) {
              const { composeImageWithFrame } = await import('../utils/imageFrameOverlay');
              const composed = await composeImageWithFrame(cover, cfgData.config.framePngUrl);
              await fetch('/api/publish-edit/save-framed-image', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: token ? `Bearer ${token}` : '',
                },
                body: JSON.stringify({ productId: warehouseProduct.id, imageDataUrl: composed }),
              });
              publishImages = [composed, ...publishImages.slice(1)];
            }
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
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Đăng bán thất bại');

      selectedShops.forEach((shopId) => {
        const shop = availableShops.find((s) => s.id === shopId);
        const listing = (data.listings || []).find((l: { shop_id: string }) => l.shop_id === shopId);
        if (shop) {
          onAddLog({
            id: `log-${Date.now()}-${shopId}`,
            timestamp: new Date().toISOString(),
            channel: (['shopee', 'tiktok', 'woocommerce', 'manual', 'all', 'ghn', 'spx'].includes(shop.platform)
              ? shop.platform
              : 'manual') as SyncLog['channel'],
            type: 'publish',
            status: listing?.status === 'success' ? 'success' : 'failed',
            message: listing?.status === 'success'
              ? `Đăng bán thành công lên [${shop.name}] — ${title}`
              : `Đăng bán thất bại [${shop.name}]: ${listing?.error_message || 'Lỗi không xác định'}`,
          });
        }
      });
      showToast(`Đăng bán hoàn tất — ${(data.listings || []).filter((l: { status: string }) => l.status === 'success').length}/${selectedShops.length} gian hàng thành công!`);
    } catch (err: any) {
      showToast(`Lỗi đăng bán: ${err.message}`);
    } finally {
      setIsPublishing(false);
    }
  };

  const onEditorInput = () => {
    if (editorRef.current) setDescriptionHtml(editorRef.current.innerHTML);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {toast && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border border-slate-700 flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-400" />
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
            <label className="text-[10px] font-bold text-gray-500">Lấy từ kho hàng</label>
            <select
              value={warehouseProductId}
              onChange={(e) => setWarehouseProductId(e.target.value)}
              className="w-full mt-1 px-3 py-2 bg-white border border-gray-200 rounded-xl text-xs font-medium"
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.title} ({p.sku})</option>
              ))}
            </select>
          </div>
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
            <div className="flex flex-wrap gap-1 mt-2">
              {TITLE_TEMPLATES.map((t) => (
                <button key={t.label} type="button" onClick={() => handleInsertTag(t.value)}
                  className="px-2 py-0.5 bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold rounded-lg">
                  {t.label}
                </button>
              ))}
            </div>
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

      {/* 4. Phiên bản · Giá & Tồn kho */}
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-4">
        <div className="flex justify-between items-center border-b border-gray-100 pb-3">
          <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider flex items-center gap-2">
            <Table2 className="w-4 h-4 text-violet-600" /> Phiên bản · Giá &amp; Tồn kho
          </h3>
          <button type="button" onClick={addVariantRow}
            className="px-3 py-1.5 bg-violet-50 text-violet-700 text-xs font-bold rounded-xl border border-violet-200 flex items-center gap-1">
            <Plus className="w-3.5 h-3.5" /> Thêm phân loại
          </button>
        </div>
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 font-medium">
          💡 Nhập giá Shopee (giá gốc) — hệ thống tự điền Lazada (+0.05%) và TikTok (+0.1%), làm tròn lên hàng trăm đồng.
        </p>
        <div className="overflow-x-auto rounded-xl border border-gray-200">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-[10px] font-extrabold text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Phân loại</th>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-right">Tồn kho</th>
                <th className="px-3 py-2 text-right">KL (g)</th>
                <th className="px-3 py-2 text-right text-orange-600">Giá Shopee</th>
                <th className="px-3 py-2 text-right text-blue-600">Giá Lazada</th>
                <th className="px-3 py-2 text-right text-slate-800">Giá TikTok</th>
                <th className="px-3 py-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {variants.map((v) => (
                <tr key={v.id} className="hover:bg-gray-50/50">
                  <td className="px-2 py-1.5">
                    <input value={v.name} onChange={(e) => updateVariant(v.id, { name: e.target.value })}
                      className="w-full min-w-[100px] px-2 py-1 border rounded-lg text-xs font-medium" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input value={v.sku} onChange={(e) => updateVariant(v.id, { sku: e.target.value })}
                      className="w-full min-w-[80px] px-2 py-1 border rounded-lg text-xs font-mono" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min={0} value={v.stock} onChange={(e) => updateVariant(v.id, { stock: Number(e.target.value) })}
                      className="w-20 px-2 py-1 border rounded-lg text-xs text-right" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min={0} value={v.weight} onChange={(e) => updateVariant(v.id, { weight: Number(e.target.value) })}
                      className="w-16 px-2 py-1 border rounded-lg text-xs text-right" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min={0} value={v.priceShopee || ''} onChange={(e) => handleShopeePriceChange(v.id, e.target.value)}
                      className="w-24 px-2 py-1 border border-orange-200 bg-orange-50/50 rounded-lg text-xs text-right font-bold text-orange-700" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min={0} value={v.priceLazada || ''} readOnly
                      className="w-24 px-2 py-1 border border-blue-100 bg-blue-50/40 rounded-lg text-xs text-right text-blue-700" />
                  </td>
                  <td className="px-2 py-1.5">
                    <input type="number" min={0} value={v.priceTiktok || ''} readOnly
                      className="w-24 px-2 py-1 border border-slate-200 bg-slate-50 rounded-lg text-xs text-right text-slate-800" />
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
      <div className="bg-white rounded-3xl border border-gray-150 p-6 shadow-xs space-y-4">
        <h3 className="text-sm font-extrabold text-gray-800 uppercase tracking-wider border-b border-gray-100 pb-3 flex items-center gap-2">
          <Package className="w-4 h-4 text-teal-600" /> Đóng gói &amp; Vận chuyển
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="text-[10px] font-bold text-gray-500">Khối lượng (gram)</label>
            <input type="number" min={0} value={packageWeight} onChange={(e) => setPackageWeight(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 border rounded-xl text-xs" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500">Dài (cm)</label>
            <input type="number" min={0} value={packageLength} onChange={(e) => setPackageLength(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 border rounded-xl text-xs" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500">Rộng (cm)</label>
            <input type="number" min={0} value={packageWidth} onChange={(e) => setPackageWidth(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 border rounded-xl text-xs" />
          </div>
          <div>
            <label className="text-[10px] font-bold text-gray-500">Cao (cm)</label>
            <input type="number" min={0} value={packageHeight} onChange={(e) => setPackageHeight(Number(e.target.value))}
              className="w-full mt-1 px-3 py-2 border rounded-xl text-xs" />
          </div>
        </div>
        <div>
          <label className="text-[10px] font-bold text-gray-500 flex items-center gap-1">
            <Truck className="w-3.5 h-3.5" /> Đơn vị vận chuyển
          </label>
          <select value={shippingMethod} onChange={(e) => setShippingMethod(e.target.value)}
            className="w-full mt-1 px-3 py-2 border rounded-xl text-xs font-medium max-w-md">
            <option>Giao hàng tiêu chuẩn</option>
            <option>Giao hàng nhanh</option>
            <option>Hỏa tốc</option>
            <option>Tự vận chuyển</option>
          </select>
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
