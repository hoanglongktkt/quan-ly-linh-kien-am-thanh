import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, getProductChildren } from '../types';
import {
  Barcode,
  CheckCircle2,
  ChevronDown,
  ImageOff,
  Info,
  Loader2,
  Scale,
  Search,
  Trash2,
  X,
} from 'lucide-react';

function getProductTitle(product: Product): string {
  const raw =
    product.title ||
    (product as { name?: string }).name ||
    (product as { product_name?: string }).product_name ||
    '';
  return String(raw).trim() || '—';
}

function getProductVariant(product: Product): string {
  return String(product.modelName || '').trim();
}

function getProductStock(product: Product): number {
  const raw =
    product.stock ??
    (product as { stock_quantity?: number }).stock_quantity ??
    (product as { quantity?: number }).quantity ??
    0;
  return Math.max(0, Math.round(Number(raw) || 0));
}

function productImage(product: Product): string | undefined {
  return product.avatarUrl || product.imageUrl;
}

/**
 * Flatten Kho chính → từng dòng SKU kiểm được:
 * - Có children/variants → liệt kê từng phân loại (giống Kho chính)
 * - Không có biến thể → giữ sản phẩm cha
 */
function flattenInventorySkus(products: Product[]): Product[] {
  const rows: Product[] = [];
  for (const parent of Array.isArray(products) ? products : []) {
    if (!parent) continue;
    const children = getProductChildren(parent);
    if (children.length > 0) {
      for (const child of children) {
        if (!child) continue;
        rows.push({
          ...child,
          title: String(child.title || parent.title || '').trim() || parent.title,
          modelName:
            String(child.modelName || '').trim() ||
            String(child.title || '').trim() ||
            undefined,
          avatarUrl: child.avatarUrl || child.imageUrl || parent.avatarUrl || parent.imageUrl,
          imageUrl: child.imageUrl || child.avatarUrl || parent.imageUrl || parent.avatarUrl,
          unit: child.unit || parent.unit,
          category: child.category || parent.category,
        });
      }
    } else {
      rows.push(parent);
    }
  }
  return rows;
}

function matchesProductQuery(product: Product, q: string): boolean {
  const title = getProductTitle(product).toLowerCase();
  const variant = getProductVariant(product).toLowerCase();
  return (
    title.includes(q) ||
    variant.includes(q) ||
    String(product.sku || '')
      .toLowerCase()
      .includes(q) ||
    (product.barcode || '').toLowerCase().includes(q)
  );
}

interface AuditLine {
  product: Product;
  actualStock: string;
}

interface InventoryAuditProps {
  products: Product[];
  shopId?: string;
  onRefreshProducts?: () => Promise<void>;
}

const PAGE_SIZES = [20, 50, 100];

export default function InventoryAudit({ products, shopId, onRefreshProducts }: InventoryAuditProps) {
  const [search, setSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [auditLines, setAuditLines] = useState<AuditLine[]>([]);
  const [pageSize, setPageSize] = useState(20);
  const [currentPage, setCurrentPage] = useState(1);
  const [balancing, setBalancing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  /** Danh sách SKU kiểm kho = cha không phân loại + từng SKU phân loại. */
  const inventorySkus = useMemo(() => flattenInventorySkus(products), [products]);

  const addedIds = useMemo(() => new Set(auditLines.map((l) => l.product.id)), [auditLines]);

  const suggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return inventorySkus.filter((p) => matchesProductQuery(p, q)).slice(0, 25);
  }, [inventorySkus, search]);

  const totalPages = Math.max(1, Math.ceil(auditLines.length / pageSize));
  const pagedLines = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return auditLines.slice(start, start + pageSize);
  }, [auditLines, currentPage, pageSize]);

  const pendingItems = useMemo(() => {
    return auditLines
      .filter((line) => line.actualStock.trim() !== '')
      .map((line) => ({
        sku: line.product.sku,
        actual_stock: Math.max(0, Math.round(Number(line.actualStock) || 0)),
      }))
      .filter((item) => item.sku && Number.isFinite(item.actual_stock));
  }, [auditLines]);

  const isMobile = () =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;

  const addProduct = useCallback(
    (prod: Product) => {
      setShowSuggestions(false);
      setSearch('');
      setHighlightIdx(0);

      if (addedIds.has(prod.id)) {
        setTimeout(() => qtyRefs.current.get(prod.id)?.focus(), 60);
        return;
      }

      setAuditLines((prev) => [...prev, { product: prod, actualStock: '' }]);
      setCurrentPage(Math.max(1, Math.ceil((auditLines.length + 1) / pageSize)));
      setTimeout(() => qtyRefs.current.get(prod.id)?.focus(), 80);
    },
    [addedIds, auditLines.length, pageSize]
  );

  const updateActual = (id: string, value: string) => {
    setAuditLines((prev) =>
      prev.map((l) => (l.product.id === id ? { ...l, actualStock: value } : l))
    );
  };

  const removeLine = (id: string) => {
    setAuditLines((prev) => prev.filter((l) => l.product.id !== id));
  };

  const lookupFromSearch = useCallback(
    (raw: string) => {
      const q = raw.trim().toLowerCase();
      if (!q) return;
      const exact = inventorySkus.find(
        (p) =>
          String(p.sku || '').toLowerCase() === q || (p.barcode || '').toLowerCase() === q
      );
      const prod = exact || inventorySkus.find((p) => matchesProductQuery(p, q));
      if (prod) addProduct(prod);
    },
    [inventorySkus, addProduct]
  );

  useEffect(() => {
    if (isMobile()) mobileSearchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault();
        if (isMobile()) mobileSearchRef.current?.focus();
        else searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (suggestions.length) {
        setShowSuggestions(true);
        setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
      }
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (showSuggestions && suggestions[highlightIdx]) {
        addProduct(suggestions[highlightIdx]);
      } else if (suggestions.length === 1) {
        addProduct(suggestions[0]);
      } else {
        lookupFromSearch(search);
      }
      return;
    }
    if (e.key === 'Escape') {
      setShowSuggestions(false);
      setSearch('');
    }
  };

  const handleBalance = async () => {
    if (pendingItems.length === 0) {
      setToast({ type: 'error', text: 'Vui lòng thêm sản phẩm và nhập tồn thực tế.' });
      setTimeout(() => setToast(null), 3000);
      return;
    }

    setBalancing(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/products/inventory-balance', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ items: pendingItems, shopId }),
      });

      const raw = await res.text();
      let data: { success?: boolean; message?: string; error?: string; shopeeWarnings?: string[]; shopeeErrors?: string[] } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error('Server không trả về dữ liệu hợp lệ.');
      }

      if (!res.ok || !data.success) {
        const parts = [
          data?.message,
          data?.error,
          ...(Array.isArray(data.shopeeErrors) ? data.shopeeErrors : []),
        ].filter(Boolean);
        throw new Error(Array.from(new Set(parts)).join('\n') || 'Cân bằng kho thất bại.');
      }

      if (onRefreshProducts) await onRefreshProducts();

      setAuditLines([]);
      setSearch('');
      setCurrentPage(1);
      const warnNote =
        Array.isArray(data.shopeeWarnings) && data.shopeeWarnings.length > 0
          ? ` (${data.shopeeWarnings.length} SKU Shopee bỏ qua do liên kết hết hạn)`
          : '';
      setToast({ type: 'success', text: (data.message || 'Cân bằng kho thành công!') + warnNote });
      setTimeout(() => setToast(null), 4000);
      searchRef.current?.focus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Cân bằng kho thất bại.';
      setToast({ type: 'error', text: msg });
      setTimeout(() => setToast(null), 8000);
    } finally {
      setBalancing(false);
    }
  };

  const renderSuggestionItem = (prod: Product, idx: number) => {
    const img = productImage(prod);
    const stock = getProductStock(prod);
    const variant = getProductVariant(prod);
    const active = idx === highlightIdx;

    return (
      <button
        key={prod.id}
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => addProduct(prod)}
        onMouseEnter={() => setHighlightIdx(idx)}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left border-b border-gray-100 last:border-0 transition-colors ${
          active ? 'bg-sky-50' : 'hover:bg-sky-50/70'
        }`}
      >
        {img ? (
          <img src={img} alt="" className="w-11 h-11 rounded object-cover border border-gray-100 shrink-0" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-11 h-11 rounded bg-gray-100 text-gray-400 flex items-center justify-center shrink-0">
            <ImageOff className="w-4 h-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-blue-600 line-clamp-2 leading-snug">{getProductTitle(prod)}</p>
          {variant && <p className="text-xs text-gray-800 mt-0.5">{variant}</p>}
          <p className="text-[11px] font-mono text-gray-500 mt-0.5">{prod.sku}</p>
        </div>
        <div className="shrink-0 text-[11px] text-gray-500 whitespace-nowrap">
          Tồn: <span className="font-semibold text-gray-700">{stock}</span>
          <span className="mx-1 text-gray-300">|</span>
          Có thể bán: <span className="font-semibold text-gray-700">{stock}</span>
        </div>
      </button>
    );
  };

  const renderAuditRow = (line: AuditLine, globalIdx: number) => {
    const { product, actualStock } = line;
    const img = productImage(product);
    const stock = getProductStock(product);
    const hasInput = actualStock.trim() !== '';
    const actualNum = hasInput ? Math.max(0, Math.round(Number(actualStock) || 0)) : null;
    const diff = actualNum !== null ? actualNum - stock : null;
    const variant = getProductVariant(product);

    return (
      <tr key={product.id} className="hover:bg-gray-50/50 border-b border-gray-100">
        <td className="px-3 py-2.5 text-center text-gray-500 text-sm">{globalIdx + 1}</td>
        <td className="px-3 py-2.5">
          {img ? (
            <img src={img} alt="" className="w-10 h-10 rounded object-cover border border-gray-100" referrerPolicy="no-referrer" />
          ) : (
            <div className="w-10 h-10 rounded bg-gray-100 flex items-center justify-center">
              <ImageOff className="w-4 h-4 text-gray-400" />
            </div>
          )}
        </td>
        <td className="px-3 py-2.5 min-w-[220px]">
          <div className="flex items-start gap-1">
            <p className="text-sm text-gray-900 line-clamp-2 flex-1">{getProductTitle(product)}</p>
            <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
          </div>
          {variant && <p className="text-xs text-gray-700 mt-0.5">{variant}</p>}
          <p className="text-xs font-mono text-blue-600 mt-0.5">{product.sku}</p>
        </td>
        <td className="px-3 py-2.5 text-sm text-gray-500 text-center">{product.unit || '—'}</td>
        <td className="px-3 py-2.5 text-center text-sm font-semibold text-gray-800">{stock}</td>
        <td className="px-3 py-2.5 text-center">
          <input
            ref={(el) => {
              if (el) qtyRefs.current.set(product.id, el);
              else qtyRefs.current.delete(product.id);
            }}
            type="number"
            min={0}
            value={actualStock}
            placeholder=""
            onChange={(e) => updateActual(product.id, e.target.value)}
            className="w-20 px-1 py-1 text-center text-sm font-mono border-0 border-b-2 border-blue-500 bg-transparent outline-none focus:border-blue-600"
          />
        </td>
        <td className="px-3 py-2.5 text-center text-sm font-mono font-bold">
          {diff !== null ? (
            <span className={diff > 0 ? 'text-emerald-600' : diff < 0 ? 'text-rose-600' : 'text-gray-500'}>
              {diff > 0 ? `+${diff}` : diff}
            </span>
          ) : (
            <span className="text-gray-300">—</span>
          )}
        </td>
        <td className="px-3 py-2.5 text-center">
          <button
            type="button"
            onClick={() => removeLine(product.id)}
            className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded"
            title="Xóa dòng"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </td>
      </tr>
    );
  };

  const toastNode = toast && (
    <div
      className={`fixed top-5 right-5 z-70 font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border flex items-center gap-2 ${
        toast.type === 'success' ? 'bg-emerald-600 text-white border-emerald-500' : 'bg-slate-900 text-white border-slate-700'
      }`}
    >
      <CheckCircle2 className="w-4 h-4 shrink-0" />
      <span>{toast.text}</span>
      <button type="button" onClick={() => setToast(null)} className="ml-1 opacity-70 hover:opacity-100">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <>
      {toastNode}

      <div className="ia-desktop space-y-0 bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="flex items-stretch border-b border-gray-200 bg-white">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2 z-10" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Tìm theo tên, mã SKU, hoặc quét mã Barcode...(F3)"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShowSuggestions(true);
                setHighlightIdx(0);
              }}
              onFocus={() => search.trim() && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
              onKeyDown={handleSearchKeyDown}
              className="w-full pl-9 pr-4 py-3 text-sm border-0 outline-none focus:ring-0"
            />
            {showSuggestions && suggestions.length > 0 && search.trim() && (
              <div className="absolute left-0 right-0 top-full z-30 bg-white border border-gray-200 border-t-0 shadow-lg max-h-80 overflow-y-auto">
                {suggestions.map((prod, idx) => renderSuggestionItem(prod, idx))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="px-4 py-3 text-sm text-gray-600 border-l border-gray-200 hover:bg-gray-50 whitespace-nowrap"
          >
            Chọn nhiều
          </button>
          <button
            type="button"
            className="px-4 py-3 text-sm text-gray-600 border-l border-gray-200 hover:bg-gray-50 flex items-center gap-1.5 whitespace-nowrap"
          >
            <Barcode className="w-4 h-4" />
            Barcode
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleBalance()}
            disabled={balancing || pendingItems.length === 0}
            className="px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white text-sm font-bold border-l border-blue-700 flex items-center gap-2 whitespace-nowrap"
          >
            {balancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />}
            Cân Bằng Kho{pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}
          </button>
        </div>

        <div className="ia-audit-table-wrap overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[960px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-600">
                <th className="px-3 py-2.5 w-12 text-center">STT</th>
                <th className="px-3 py-2.5 w-14">Ảnh</th>
                <th className="px-3 py-2.5 min-w-[220px]">Tên sản phẩm</th>
                <th className="px-3 py-2.5 w-20 text-center">Đơn vị</th>
                <th className="px-3 py-2.5 w-28 text-center">Tồn chi nhánh</th>
                <th className="px-3 py-2.5 w-28 text-center">Tồn thực tế</th>
                <th className="px-3 py-2.5 w-20 text-center">Lệch</th>
                <th className="px-3 py-2.5 w-14 text-center" />
              </tr>
            </thead>
            <tbody>
              {auditLines.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-sm text-gray-400">
                    Tìm và chọn sản phẩm ở ô phía trên để thêm vào phiếu kiểm
                  </td>
                </tr>
              ) : (
                pagedLines.map((line, idx) => renderAuditRow(line, (currentPage - 1) * pageSize + idx))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-gray-200 bg-gray-50/80 text-sm text-gray-600">
          <span>Hiển thị</span>
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setCurrentPage(1);
            }}
            className="px-2 py-1 border border-gray-200 rounded bg-white text-sm outline-none"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          {auditLines.length > pageSize && (
            <div className="flex items-center gap-1 ml-2">
              <button
                type="button"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => p - 1)}
                className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 bg-white"
              >
                ‹
              </button>
              <span className="px-2 text-xs">
                {currentPage}/{totalPages}
              </span>
              <button
                type="button"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => p + 1)}
                className="px-2 py-1 border border-gray-200 rounded disabled:opacity-40 bg-white"
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="ia-mobile flex flex-col -mx-1 pb-24">
        <div className="ia-mobile-search shrink-0 z-20 px-2 pt-1 pb-2 bg-gray-100">
          <div className="relative w-full">
            <Search className="w-[18px] h-[18px] text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={mobileSearchRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShowSuggestions(true);
                setHighlightIdx(0);
              }}
              onFocus={() => search.trim() && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Tìm tên, SKU, Barcode..."
              className="ia-mobile-search-input w-full min-h-[48px] pl-10 pr-4 text-sm bg-white border border-gray-200 outline-none focus:border-blue-500"
            />
            {showSuggestions && suggestions.length > 0 && search.trim() && (
              <ul className="ia-mobile-dropdown absolute left-0 right-0 top-full mt-1 max-h-[45vh] overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-xl z-30">
                {suggestions.map((prod, idx) => (
                  <li key={prod.id}>{renderSuggestionItem(prod, idx)}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="ia-mobile-body px-2 pb-2 bg-gray-100">
          {auditLines.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">Chọn sản phẩm từ ô tìm kiếm</div>
          ) : (
            <ul className="ia-mobile-results space-y-2 pb-2">
              {auditLines.map((line) => {
                const { product, actualStock } = line;
                const img = productImage(product);
                const stock = getProductStock(product);
                return (
                  <li key={product.id} className="ia-mobile-card ia-mobile-card-row bg-white">
                    {img ? (
                      <img src={img} alt="" className="w-11 h-11 rounded-lg object-cover border shrink-0" referrerPolicy="no-referrer" />
                    ) : (
                      <div className="w-11 h-11 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                        <ImageOff className="w-4 h-4 text-gray-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-blue-700 line-clamp-2">{getProductTitle(product)}</p>
                      {getProductVariant(product) && (
                        <p className="text-xs text-gray-700">{getProductVariant(product)}</p>
                      )}
                      <p className="text-[11px] font-mono text-gray-500">
                        {product.sku} · Tồn {stock}
                      </p>
                    </div>
                    <input
                      type="number"
                      min={0}
                      value={actualStock}
                      placeholder="0"
                      onChange={(e) => updateActual(product.id, e.target.value)}
                      className="ia-mobile-qty-inline"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="ia-mobile-footer fixed bottom-17 left-0 right-0 z-55 px-2 py-2.5 bg-white">
          <button
            type="button"
            onClick={() => void handleBalance()}
            disabled={balancing || pendingItems.length === 0}
            className="ia-mobile-balance-btn w-full min-h-[56px] bg-blue-600 active:bg-blue-700 disabled:opacity-50 text-white font-extrabold text-sm uppercase flex items-center justify-center gap-2"
          >
            {balancing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scale className="w-5 h-5" />}
            CÂN BẰNG KHO{pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}
          </button>
        </div>
      </div>
    </>
  );
}
