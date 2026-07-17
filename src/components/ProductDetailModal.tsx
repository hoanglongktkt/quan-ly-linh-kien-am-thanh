import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Product, getProductChildren } from '../types';
import { X, RefreshCw, Check, Package, Plus } from 'lucide-react';

const SAPO = { blue: '#0078D4', bg: '#F4F6F8', border: '#E0E0E0' };

export function getShopeeItemKey(p: Product): string | null {
  if (p.shopeeItemId) return String(p.shopeeItemId);
  if (p.shopeeId?.includes(':')) return p.shopeeId.split(':')[0];
  const m = p.id.match(/^shopee-item-(\d+)/);
  return m ? m[1] : null;
}

export function isParentOnlyShopeeRow(p: Product): boolean {
  return /^shopee-item-\d+$/.test(p.id);
}

export function getProductVariants(allProducts: Product[], prod: Product): Product[] {
  const direct = getProductChildren(prod);
  if (direct.length > 0) {
    return [...direct].sort((a, b) => a.title.localeCompare(b.title, 'vi'));
  }
  const key = getShopeeItemKey(prod);
  if (!key) return [prod];
  const parent = allProducts.find(
    (p) => getShopeeItemKey(p) === key && getProductChildren(p).length > 0
  );
  if (parent) {
    return [...getProductChildren(parent)].sort((a, b) => a.title.localeCompare(b.title, 'vi'));
  }
  const variants = allProducts.filter((p) => getShopeeItemKey(p) === key);
  return variants.length > 0
    ? [...variants].sort((a, b) => a.title.localeCompare(b.title, 'vi'))
    : [prod];
}

export interface ProductGroupRow {
  groupId: string;
  representative: Product;
  variants: Product[];
  variantCount: number;
  hasVariants: boolean;
  displayTitle: string;
  totalStock: number;
  minSellingPrice: number;
  maxSellingPrice: number;
}

function getBaseTitle(variants: Product[]): string {
  const bases = variants.map((v) => {
    const idx = v.title.indexOf(' - ');
    return idx > 0 ? v.title.slice(0, idx).trim() : v.title.trim();
  });
  const first = bases[0];
  return bases.every((b) => b === first) ? first : variants[0].title;
}

export function isJunkCategoryLabel(category?: string): boolean {
  if (!category) return true;
  const t = category.trim();
  return !t || t === 'Chưa phân loại' || /^\d+$/.test(t);
}

export function formatPriceRange(min: number, max: number): string {
  const fmt = (n: number) => `${Math.round(n).toLocaleString('vi-VN')}đ`;
  if (min === max) return fmt(min);
  return `${fmt(min)} - ${fmt(max)}`;
}

function formatMoneyInput(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '0';
}

function parseMoneyInput(raw: string): number {
  const normalized = raw.replace(/,/g, '').replace(/[^\d.]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function countDigits(value: string): number {
  return (value.match(/\d/g) || []).length;
}

function getCaretFromDigitCount(value: string, digitsBeforeCaret: number): number {
  if (digitsBeforeCaret <= 0) return 0;
  let digitsSeen = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (/\d/.test(value[index])) {
      digitsSeen += 1;
      if (digitsSeen >= digitsBeforeCaret) {
        return index + 1;
      }
    }
  }
  return value.length;
}

/** Nhóm Parent-Child: ưu tiên children; còn lại gom flat legacy theo item_id. */
export function buildProductGroups(products: Product[]): ProductGroupRow[] {
  const rows: ProductGroupRow[] = [];
  const consumedKeys = new Set<string>();

  for (const p of products) {
    const children = getProductChildren(p);
    if (children.length > 0) {
      const key = getShopeeItemKey(p) || p.id;
      consumedKeys.add(key);
      const prices = children.map((v) => Number(v.sellingPrice) || 0);
      rows.push({
        groupId: p.id,
        representative: p,
        variants: children,
        variantCount: children.length,
        hasVariants: true,
        displayTitle: p.title,
        totalStock: children.reduce((sum, v) => sum + (Number(v.stock) || 0), 0),
        minSellingPrice: Math.min(...prices),
        maxSellingPrice: Math.max(...prices),
      });
      continue;
    }

    const key = getShopeeItemKey(p);
    if (!key) {
      const price = Number(p.sellingPrice) || 0;
      rows.push({
        groupId: p.id,
        representative: p,
        variants: [p],
        variantCount: 1,
        hasVariants: false,
        displayTitle: p.title,
        totalStock: Number(p.stock) || 0,
        minSellingPrice: price,
        maxSellingPrice: price,
      });
      continue;
    }

    if (consumedKeys.has(key)) continue;
    const flatSiblings = products.filter((x) => {
      if (getProductChildren(x).length > 0) return false;
      return getShopeeItemKey(x) === key;
    });
    consumedKeys.add(key);
    const sorted = [...flatSiblings].sort((a, b) => a.title.localeCompare(b.title, 'vi'));
    const hasVariants = sorted.length > 1 || sorted.some((v) => !!v.shopeeModelId);
    const variants = hasVariants
      ? sorted.filter((v) => v.shopeeModelId || sorted.length === 1)
      : sorted;
    const list = variants.length ? variants : sorted;
    const prices = list.map((v) => Number(v.sellingPrice) || 0);
    rows.push({
      groupId: `group-${key}`,
      representative: sorted.find((v) => !v.shopeeModelId) || sorted[0],
      variants: list,
      variantCount: list.length,
      hasVariants: list.length > 1,
      displayTitle: getBaseTitle(sorted),
      totalStock: list.reduce((sum, v) => sum + (Number(v.stock) || 0), 0),
      minSellingPrice: Math.min(...prices),
      maxSellingPrice: Math.max(...prices),
    });
  }

  return rows.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle, 'vi'));
}

interface ProductDetailModalProps {
  product: Product;
  allProducts: Product[];
  onClose: () => void;
  onUpdateProduct: (
    product: Product,
    opts?: { save?: boolean }
  ) => void | Promise<void | { success?: boolean; error?: string; shopeeSynced?: boolean; shopeeMessage?: string }>;
  onSyncItemVariants?: (itemId: string) => Promise<Product[] | null>;
  onProductsRefresh?: (products: Product[]) => void;
}

export default function ProductDetailModal({
  product,
  allProducts,
  onClose,
  onUpdateProduct,
  onSyncItemVariants,
  onProductsRefresh,
}: ProductDetailModalProps) {
  const priceSelectionRef = useRef<{ input: HTMLInputElement; caret: number } | null>(null);
  const [localProducts, setLocalProducts] = useState(allProducts);
  const variants = useMemo(() => getProductVariants(localProducts, product), [localProducts, product]);
  const [activeId, setActiveId] = useState(product.id);
  const active = variants.find(v => v.id === activeId) || variants[0] || product;

  const [editTitle, setEditTitle] = useState('');
  const [editSku, setEditSku] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editWeight, setEditWeight] = useState(0);
  const [editWeightUnit, setEditWeightUnit] = useState<'g' | 'kg'>('g');
  const [editStock, setEditStock] = useState(0);
  const [editSellingPrice, setEditSellingPrice] = useState(0);
  const [editWholesalePrice, setEditWholesalePrice] = useState(0);
  const [editImportPrice, setEditImportPrice] = useState(0);
  const [editUnit, setEditUnit] = useState('');

  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => { setLocalProducts(allProducts); }, [allProducts]);

  useEffect(() => {
    if (!priceSelectionRef.current) return;
    const { input, caret } = priceSelectionRef.current;
    input.setSelectionRange(caret, caret);
    priceSelectionRef.current = null;
  });

  useEffect(() => {
    if (!active) return;
    setEditTitle(active.title);
    setEditSku(active.sku);
    setEditBarcode(active.barcode || active.sku);
    setEditWeight(active.weight ?? 0);
    setEditStock(active.stock);
    setEditSellingPrice(active.sellingPrice);
    setEditWholesalePrice(active.wholesalePrice ?? active.sellingPrice);
    setEditImportPrice(active.importPrice);
    setEditUnit(active.unit || '');
    setToast(null);
  }, [active?.id]);

  const itemKey = getShopeeItemKey(active);

  const handleSyncVariants = async () => {
    if (!onSyncItemVariants || !itemKey) return;
    setSyncing(true);
    setToast('Đang tải phân loại SKU từ Shopee (get_model_list)...');
    try {
      const updated = await onSyncItemVariants(itemKey);
      if (updated) {
        setLocalProducts(updated);
        onProductsRefresh?.(updated);
        const newVariants = getProductVariants(updated, active);
        if (newVariants.length > 0) {
          setActiveId(newVariants.find(v => v.shopeeModelId)?.id || newVariants[0].id);
          setToast(
            newVariants.length > 1
              ? `Đã tải ${newVariants.length} phân loại với SKU riêng từ Shopee.`
              : 'Shopee chỉ trả về 1 dòng — sản phẩm có thể không có phân loại con.'
          );
        }
      } else {
        setToast('Không nhận được dữ liệu phân loại từ server.');
      }
    } catch (err: any) {
      setToast(err?.message || 'Tải SKU phân loại thất bại.');
    } finally {
      setSyncing(false);
      setTimeout(() => setToast(null), 5000);
    }
  };

  const handleSave = async () => {
    if (!active) return;
    setSaving(true);
    setToast('Đang lưu sản phẩm và đồng bộ Shopee...');
    const updated: Product = {
      ...active,
      title: editTitle.trim() || active.title,
      sku: editSku.trim() || active.sku,
      barcode: editBarcode.trim() || editSku.trim(),
      weight: Math.max(0, editWeight),
      stock: Math.max(0, Math.round(editStock)),
      sellingPrice: Math.max(0, Math.round(editSellingPrice)),
      wholesalePrice: Math.max(0, Math.round(editWholesalePrice)),
      importPrice: Math.max(0, Math.round(editImportPrice)),
      unit: editUnit.trim(),
      status: editStock <= 0 ? 'out_of_stock' : active.status === 'draft' ? 'draft' : 'active',
      lastSynced: new Date().toISOString(),
    };
    try {
      const result = await onUpdateProduct(updated, { save: true });
      setLocalProducts(prev => prev.map(p => (p.id === updated.id ? updated : p)));
      if (result && typeof result === 'object' && result.success === false) {
        const detail =
          result.error ||
          result.shopeeMessage ||
          'Lưu kho thành công nhưng đồng bộ Shopee thất bại.';
        setToast(`Lỗi đồng bộ Shopee: ${detail}`);
      } else if (result && typeof result === 'object' && result.shopeeSynced) {
        setToast(
          result.shopeeMessage
            ? `Đồng bộ Shopee thành công! ${result.shopeeMessage}`
            : 'Đồng bộ Shopee thành công!'
        );
      } else if (result && typeof result === 'object' && result.shopeeMessage) {
        setToast(`Đã lưu vào kho gốc. ${result.shopeeMessage}`);
      } else {
        setToast('Đã lưu vào kho gốc.');
      }
    } catch (err: any) {
      setToast(`Lỗi cập nhật: ${err?.message || 'Cập nhật sản phẩm thất bại.'}`);
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 4500);
    }
  };

  const labelCls = 'text-[12px] text-[#6B7280] mb-1 block';
  const inputCls = 'w-full px-3 py-[8px] text-[13px] border border-[#E0E0E0] rounded-[4px] bg-white focus:border-[#0078D4] focus:ring-1 focus:ring-[#0078D4]/20 outline-none';
  const cardCls = 'bg-white border rounded-[4px]' ;
  const cardHeader = 'px-4 py-2.5 border-b text-[13px] font-semibold text-[#212121]';

  const handleMoneyInputChange =
    (setter: React.Dispatch<React.SetStateAction<number>>) =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const { value, selectionStart } = event.target;
      const digitsBeforeCaret = countDigits(value.slice(0, selectionStart ?? value.length));
      const numericValue = Math.max(0, parseMoneyInput(value));
      const formattedValue = formatMoneyInput(numericValue);

      setter(numericValue);

      const nextCaret = getCaretFromDigitCount(formattedValue, digitsBeforeCaret);
      priceSelectionRef.current = { input: event.target, caret: nextCaret };
    };

  const marginPct = editSellingPrice > 0
    ? (((editSellingPrice - editImportPrice) / editSellingPrice) * 100).toFixed(0)
    : '0';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-0 sm:p-3">
      <div className="bg-white w-full max-w-[1100px] h-full sm:h-[92vh] flex flex-col overflow-hidden sm:rounded-[6px] shadow-xl" style={{ border: `1px solid ${SAPO.border}` }}>
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: SAPO.border }}>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0078D4]">Chi tiết sản phẩm</p>
            <h2 className="text-[15px] font-semibold text-[#212121]">Chỉnh sửa thông tin kho</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#F4F6F8] text-[#9CA3AF]"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex flex-1 min-h-0" style={{ background: SAPO.bg }}>
          {/* Sidebar phiên bản — Sapo */}
          <aside className="w-[240px] shrink-0 bg-white border-r max-sm:hidden sm:flex sm:flex-col" style={{ borderColor: SAPO.border }}>
            <div className="px-3 py-2.5 border-b flex items-center justify-between" style={{ borderColor: SAPO.border }}>
              <span className="text-[13px] font-semibold text-[#212121]">Phiên bản ({variants.length})</span>
              {itemKey && active.channels.includes('shopee') && (
                <button onClick={handleSyncVariants} disabled={syncing} className="text-[11px] text-[#0078D4] hover:underline disabled:opacity-50 font-semibold">
                  {syncing ? 'Đang tải...' : 'Tải SKU'}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {variants.map(v => {
                const selected = v.id === activeId;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setActiveId(v.id)}
                    className={`w-full flex items-start gap-2 px-2 py-2 rounded-[4px] text-left transition-colors ${
                      selected ? 'bg-[#0078D4] text-white' : 'hover:bg-[#F4F6F8] text-[#424242]'
                    }`}
                  >
                    {v.imageUrl ? (
                      <img src={v.imageUrl} alt="" className="w-9 h-9 rounded-[3px] object-cover border shrink-0" referrerPolicy="no-referrer" />
                    ) : (
                      <div className={`w-9 h-9 rounded-[3px] flex items-center justify-center shrink-0 ${selected ? 'bg-white/20' : 'bg-[#F4F6F8]'}`}>
                        <Package className="w-4 h-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`text-[11px] font-medium leading-tight line-clamp-2 ${selected ? 'text-white' : 'text-[#212121]'}`}>{v.title}</p>
                          <p className={`text-[10px] font-mono mt-0.5 ${selected ? 'text-blue-100' : 'text-[#9CA3AF]'}`}>{v.sku}</p>
                          {v.parentSku && v.parentSku !== v.sku && (
                            <p className={`text-[9px] mt-0.5 ${selected ? 'text-blue-200' : 'text-[#BDBDBD]'}`}>SKU cha: {v.parentSku}</p>
                          )}
                      <p className={`text-[10px] mt-0.5 ${selected ? 'text-blue-100' : 'text-[#6B7280]'}`}>
                        Tồn kho: {v.stock} · Có thể bán: {v.stock}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
            {syncing && (
              <div className="px-3 py-2 border-t text-[11px] text-[#0078D4] flex items-center gap-1" style={{ borderColor: SAPO.border }}>
                <RefreshCw className="w-3 h-3 animate-spin" /> Đang tải phân loại...
              </div>
            )}
          </aside>

          {/* Main form */}
          <div className="flex-1 overflow-y-auto p-3 sm:p-4 pb-28 sm:pb-4 space-y-3">
            {/* Mobile variant picker */}
            <div className="sm:hidden">
              <label className={labelCls}>Phiên bản ({variants.length})</label>
              <select value={activeId} onChange={e => setActiveId(e.target.value)} className={inputCls}>
                {variants.map(v => <option key={v.id} value={v.id}>{v.sku} — {v.title}</option>)}
              </select>
            </div>

            {/* Card: Thông tin chi tiết */}
            <div className={cardCls} style={{ borderColor: SAPO.border }}>
              <div className={cardHeader} style={{ borderColor: SAPO.border }}>Thông tin chi tiết phiên bản</div>
              <div className="p-4">
                <div className="flex gap-4">
                  <div className="flex-1 space-y-3">
                    <div>
                      <label className={labelCls}>Tên phiên bản sản phẩm <span className="text-red-500">*</span></label>
                      <input value={editTitle} onChange={e => setEditTitle(e.target.value)} className={inputCls} />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Mã sản phẩm / SKU</label>
                        <input value={editSku} onChange={e => setEditSku(e.target.value)} className={`${inputCls} font-mono`} />
                      </div>
                      <div>
                        <label className={labelCls}>Mã vạch / Barcode</label>
                        <input value={editBarcode} onChange={e => setEditBarcode(e.target.value)} className={`${inputCls} font-mono`} />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className={labelCls}>Khối lượng</label>
                        <div className="flex gap-1">
                          <input type="number" step="0.01" value={editWeight} onChange={e => setEditWeight(Math.max(0, Number(e.target.value)))} className={`${inputCls} flex-1`} />
                          <select value={editWeightUnit} onChange={e => setEditWeightUnit(e.target.value as 'g' | 'kg')} className="w-12 px-1 py-[8px] text-[12px] border border-[#E0E0E0] rounded-[4px]">
                            <option value="g">g</option>
                            <option value="kg">kg</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Tồn kho</label>
                        <input type="number" value={editStock} onChange={e => setEditStock(Math.max(0, Number(e.target.value)))} className={`${inputCls} font-semibold`} />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Đơn vị tính</label>
                      <input
                        value={editUnit}
                        onChange={e => setEditUnit(e.target.value)}
                        placeholder="Nhập đơn vị (VD: 1 cái, 1 hộp...)"
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <div className="max-sm:hidden sm:block shrink-0 w-[120px] text-center">
                    {active.imageUrl ? (
                      <img src={active.imageUrl} alt="" className="w-[110px] h-[110px] object-cover rounded-[4px] border" style={{ borderColor: SAPO.border }} referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-[110px] h-[110px] bg-[#F4F6F8] rounded-[4px] flex items-center justify-center">
                        <Package className="w-8 h-8 text-[#BDBDBD]" />
                      </div>
                    )}
                    <button type="button" className="mt-2 text-[11px] text-[#0078D4] hover:underline">Thay đổi ảnh</button>
                  </div>
                </div>
              </div>
            </div>

            {/* Card: Giá sản phẩm */}
            <div className={cardCls} style={{ borderColor: SAPO.border }}>
              <div className={`${cardHeader} flex items-center justify-between`} style={{ borderColor: SAPO.border }}>
                <span>Giá sản phẩm</span>
                <button type="button" className="text-[12px] text-[#0078D4] font-normal flex items-center gap-0.5 hover:underline">
                  <Plus className="w-3.5 h-3.5" /> Thêm chính sách giá
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Giá bán lẻ</label>
                    <input type="text" inputMode="decimal" value={formatMoneyInput(editSellingPrice)} onChange={handleMoneyInputChange(setEditSellingPrice)} className={`${inputCls} text-right font-semibold`} />
                  </div>
                  <div>
                    <label className={labelCls}>Giá bán buôn</label>
                    <input type="text" inputMode="decimal" value={formatMoneyInput(editWholesalePrice)} onChange={handleMoneyInputChange(setEditWholesalePrice)} className={`${inputCls} text-right`} />
                  </div>
                </div>
                <div className="sm:w-1/2">
                  <label className={labelCls}>Giá nhập</label>
                  <input type="text" inputMode="decimal" value={formatMoneyInput(editImportPrice)} onChange={handleMoneyInputChange(setEditImportPrice)} className={`${inputCls} text-right`} />
                </div>
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="p-3 bg-[#F9FAFB] border rounded-[4px]" style={{ borderColor: SAPO.border }}>
                    <span className="text-[11px] text-[#9CA3AF]">Giá vốn</span>
                    <p className="text-[14px] font-semibold text-[#424242] mt-0.5">{editImportPrice.toLocaleString('vi-VN')} đ</p>
                  </div>
                  <div className="p-3 bg-[#ECFDF5] border border-[#A7F3D0] rounded-[4px]">
                    <span className="text-[11px] text-emerald-600">Biên lãi gộp</span>
                    <p className="text-[14px] font-semibold text-emerald-700 mt-0.5">{marginPct}%</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Liên kết sàn */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="p-3 bg-white border rounded-[4px] flex justify-between items-center text-[12px]" style={{ borderColor: SAPO.border }}>
                <span className="font-semibold text-orange-700">Shopee ID</span>
                <span className="font-mono text-orange-900">{active.shopeeId || 'Chưa liên kết'}</span>
              </div>
              <div className="p-3 bg-white border rounded-[4px] flex justify-between items-center text-[12px]" style={{ borderColor: SAPO.border }}>
                <span className="font-semibold text-[#424242]">TikTok ID</span>
                <span className="font-mono text-[#6B7280]">{active.tiktokId || 'Chưa liên kết'}</span>
              </div>
            </div>

            {toast && (
              <div className="fixed top-5 left-3 right-3 sm:left-auto sm:right-5 sm:max-w-md z-[90] text-[13px] font-medium text-[#075985] bg-[#E8F4FD] border border-[#7DD3FC] rounded-[6px] px-4 py-3 shadow-xl">
                {toast}
              </div>
            )}
          </div>
        </div>

        <div
          className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 px-4 sm:px-5 py-3 border-t bg-white shrink-0 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:shadow-none"
          style={{ borderColor: SAPO.border, paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
        >
          <button
            onClick={onClose}
            className="w-full sm:w-auto min-h-11 sm:min-h-0 px-5 py-3 sm:py-[7px] text-[14px] sm:text-[13px] font-medium text-[#424242] bg-white border rounded-[6px] sm:rounded-[4px] hover:bg-[#F9FAFB] max-sm:order-2"
            style={{ borderColor: SAPO.border }}
          >
            Hủy bỏ
          </button>
          <button
            onClick={handleSave}
            disabled={saving || syncing}
            className="w-full sm:w-auto min-h-12 sm:min-h-0 px-5 py-3 sm:py-[7px] text-[15px] sm:text-[13px] font-semibold text-white rounded-[6px] sm:rounded-[4px] disabled:opacity-50 flex items-center justify-center gap-2 shadow-sm sm:shadow-none max-sm:order-1"
            style={{ background: '#0078D4' }}
          >
            {saving ? <RefreshCw className="w-5 h-5 sm:w-4 sm:h-4 animate-spin" /> : <Check className="w-5 h-5 sm:w-4 sm:h-4" />}
            {saving ? 'Đang cập nhật...' : 'Cập nhật'}
          </button>
        </div>
      </div>
    </div>
  );
}
