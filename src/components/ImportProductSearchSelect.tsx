import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Search, Package, Loader2, Plus } from 'lucide-react';
import { Product } from '../types';
import QuickAddProductModal from './QuickAddProductModal';

function getVariantLabel(p: Product): string {
  if (p.modelName?.trim()) return p.modelName.trim();
  if (p.tierLabels?.length) return p.tierLabels.join(' / ');
  const idx = (p.title || '').indexOf(' - ');
  if (idx > 0) return p.title.slice(idx + 3).trim();
  return '—';
}

function getProductImage(p: Product): string | undefined {
  return (p as any).image || p.avatarUrl || p.imageUrl;
}

export interface ImportProductSearchSelectHandle {
  focus: () => void;
}

interface ImportProductSearchSelectProps {
  onSelect: (product: Product) => void;
  placeholder?: string;
  excludeIds?: string[];
  onProductCreated?: (product: Product) => void;
}

const ImportProductSearchSelect = forwardRef<ImportProductSearchSelectHandle, ImportProductSearchSelectProps>(
  function ImportProductSearchSelect(
    {
      onSelect,
      placeholder = 'F3 — Gõ SKU hoặc tên sản phẩm, Enter để thêm vào bảng...',
      excludeIds = [],
      onProductCreated,
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [highlightIndex, setHighlightIndex] = useState(0);
    const [remoteProducts, setRemoteProducts] = useState<Product[]>([]);
    const [searching, setSearching] = useState(false);
    const [showQuickAdd, setShowQuickAdd] = useState(false);
    const [checkedProducts, setCheckedProducts] = useState<Product[]>([]);
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const reqSeqRef = useRef(0);

    useImperativeHandle(ref, () => ({
      focus: () => {
        setTimeout(() => inputRef.current?.focus(), 0);
      },
    }));

    const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
    const filtered = remoteProducts.filter((p) => !excludeSet.has(p.id));
    const searchTerm = query.trim();
    const showEmpty = open && searchTerm.length > 0 && !searching && filtered.length === 0;
    const showDropdown = (open && searchTerm.length > 0 && filtered.length > 0) || showEmpty;

    useEffect(() => {
      setHighlightIndex(0);
    }, [query, open, filtered.length]);

    useEffect(() => {
      if (!showDropdown) return;
      const onDocClick = (e: MouseEvent) => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
          setOpen(false);
          setCheckedProducts([]);
        }
      };
      document.addEventListener('mousedown', onDocClick);
      return () => document.removeEventListener('mousedown', onDocClick);
    }, [showDropdown]);

    // Loại bỏ khỏi danh sách tích chọn các SP đã nằm trong bảng nhập
    useEffect(() => {
      setCheckedProducts((prev) => {
        const next = prev.filter((p) => !excludeSet.has(p.id));
        return next.length === prev.length ? prev : next;
      });
    }, [excludeSet]);

    useEffect(() => {
      if (!showDropdown || !listRef.current) return;
      const el = listRef.current.children[highlightIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }, [highlightIndex, showDropdown]);

    // Chỉ gọi API khi đã có từ khóa — không auto-load toàn bộ khi ô trống
    useEffect(() => {
      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!searchTerm) {
        abortRef.current?.abort();
        setRemoteProducts([]);
        setSearching(false);
        setOpen(false);
        setCheckedProducts([]);
        return;
      }

      debounceRef.current = setTimeout(async () => {
        const token = localStorage.getItem('admin_token');
        if (!token) {
          setRemoteProducts([]);
          setOpen(false);
          return;
        }

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const seq = ++reqSeqRef.current;

        setSearching(true);
        try {
          const qs = new URLSearchParams({
            q: searchTerm,
            limit: '40',
          });
          const res = await fetch(`/api/products/search?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({}));
          console.log('[ImportSearch] API /api/products/search:', {
            q: searchTerm,
            status: res.status,
            ok: res.ok,
            success: data?.success,
            total: data?.total,
            source: data?.source,
            count: Array.isArray(data?.products) ? data.products.length : 0,
            products: data?.products,
          });
          if (seq !== reqSeqRef.current) return;
          if (!res.ok || data.success === false) {
            throw new Error(data.error || data.message || `Lỗi tìm kiếm (HTTP ${res.status})`);
          }
          const list = (Array.isArray(data.products) ? data.products : []).map((p: any) => ({
            ...p,
            id: String(p.id || ''),
            title: p.title || p.name || '',
            sku: p.sku || '',
            stock: p.stock ?? p.current_stock ?? 0,
            importPrice: p.importPrice ?? p.last_import_price ?? 0,
            imageUrl: p.imageUrl || p.image || p.avatarUrl,
            avatarUrl: p.avatarUrl || p.image || p.imageUrl,
          }));
          setRemoteProducts(list);
          setOpen(list.filter((p: Product) => !excludeSet.has(p.id)).length > 0);
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
          if (seq !== reqSeqRef.current) return;
          console.error('[ImportSearch] fetch error:', err);
          setRemoteProducts([]);
          setOpen(false);
        } finally {
          if (seq === reqSeqRef.current) setSearching(false);
        }
      }, 400);

      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, [searchTerm, excludeSet]);

    const selectProduct = (p: Product) => {
      console.log('[ImportSearch] selected product:', p);
      onSelect(p);
      setQuery('');
      setOpen(false);
      setRemoteProducts([]);
      setCheckedProducts([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    };

    const toggleChecked = (p: Product) => {
      setCheckedProducts((prev) => {
        if (prev.some((x) => x.id === p.id)) {
          return prev.filter((x) => x.id !== p.id);
        }
        return [...prev, p];
      });
    };

    const confirmMultiSelect = () => {
      if (checkedProducts.length === 0) return;
      for (const p of checkedProducts) {
        onSelect(p);
      }
      setCheckedProducts([]);
      setQuery('');
      setOpen(false);
      setRemoteProducts([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    };

    const openQuickAdd = () => {
      setOpen(false);
      setCheckedProducts([]);
      setShowQuickAdd(true);
    };

    const handleQuickCreated = (p: Product) => {
      onProductCreated?.(p);
      selectProduct(p);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!showDropdown) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlightIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && filtered[highlightIndex]) {
        e.preventDefault();
        selectProduct(filtered[highlightIndex]);
      } else if (e.key === 'Escape') {
        setOpen(false);
      }
    };

    return (
      <>
        <div ref={rootRef} className="relative">
          <div className="flex items-stretch gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className="w-full pl-10 pr-10 h-12 text-sm bg-white rounded-xl border border-gray-200 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/15 shadow-sm"
                autoComplete="off"
              />
              {searching && (
                <Loader2 className="w-4 h-4 text-indigo-500 absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin" />
              )}
            </div>
            <button
              type="button"
              onClick={openQuickAdd}
              className="shrink-0 h-12 px-3 sm:px-4 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold text-xs sm:text-sm rounded-xl border border-emerald-200 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Thêm sản phẩm mới</span>
              <span className="sm:hidden">Thêm mới</span>
            </button>
          </div>

          {showDropdown && (
            <div className="absolute z-50 left-0 right-0 mt-1.5 bg-white rounded-xl border border-gray-200 shadow-xl shadow-gray-200/60 overflow-hidden">
              {showEmpty ? (
                <div className="py-6 px-4 text-center">
                  <p className="text-xs text-gray-400 mb-3">Không tìm thấy sản phẩm phù hợp.</p>
                  <button
                    type="button"
                    onClick={openQuickAdd}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-100"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Thêm sản phẩm mới
                  </button>
                </div>
              ) : (
                <>
                  <div ref={listRef} className="max-h-[380px] overflow-y-auto scrollbar-thin">
                    {filtered.map((p, idx) => {
                      const img = getProductImage(p);
                      const isActive = idx === highlightIndex;
                      const isChecked = checkedProducts.some((x) => x.id === p.id);
                      return (
                        <div
                          key={p.id}
                          role="button"
                          tabIndex={-1}
                          onMouseEnter={() => setHighlightIndex(idx)}
                          onClick={() => selectProduct(p)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-gray-50 last:border-b-0 transition-colors cursor-pointer ${
                            isActive ? 'bg-indigo-50/80' : 'hover:bg-gray-50'
                          } ${isChecked ? 'bg-indigo-50/40' : ''}`}
                        >
                          <label
                            className="shrink-0 flex items-center justify-center p-0.5 cursor-pointer"
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                e.stopPropagation();
                                toggleChecked(p);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              className="w-4 h-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer accent-indigo-600"
                              aria-label={`Chọn ${p.sku || p.title}`}
                            />
                          </label>
                          {img ? (
                            <img
                              src={img}
                              alt=""
                              className="w-10 h-10 rounded-lg object-cover border border-gray-100 shrink-0"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-gray-100 border border-gray-100 flex items-center justify-center shrink-0">
                              <Package className="w-5 h-5 text-gray-400" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-bold text-gray-900 line-clamp-1">
                              [{p.sku}] {p.title}
                            </p>
                            <p className="text-[10px] text-gray-400 line-clamp-1 mt-0.5">{getVariantLabel(p)}</p>
                          </div>
                          <div className="text-right shrink-0 text-[10px]">
                            <p className="text-gray-500">
                              Giá nhập:{' '}
                              <span className="font-semibold text-gray-800 font-mono">
                                {(Number(p.importPrice) || 0).toLocaleString('vi-VN')} đ
                              </span>
                            </p>
                            <p className="text-gray-400 mt-0.5">
                              Tồn:{' '}
                              <span className="font-bold text-gray-600">{Number(p.stock) || 0}</span>
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {checkedProducts.length > 0 ? (
                    <button
                      type="button"
                      onClick={confirmMultiSelect}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 border-t border-indigo-500 transition-colors"
                    >
                      Chọn nhiều sản phẩm ({checkedProducts.length})
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={openQuickAdd}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-t border-emerald-100 transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Thêm sản phẩm mới
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        <QuickAddProductModal
          open={showQuickAdd}
          onClose={() => setShowQuickAdd(false)}
          onCreated={handleQuickCreated}
          initialName={searchTerm}
        />
      </>
    );
  },
);

export default ImportProductSearchSelect;
