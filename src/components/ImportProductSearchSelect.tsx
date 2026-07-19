import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Search, Package, Loader2 } from 'lucide-react';
import { Product } from '../types';

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
}

const ImportProductSearchSelect = forwardRef<ImportProductSearchSelectHandle, ImportProductSearchSelectProps>(
  function ImportProductSearchSelect(
    {
      onSelect,
      placeholder = 'F3 — Gõ SKU hoặc tên sản phẩm, Enter để thêm vào bảng...',
      excludeIds = [],
    },
    ref,
  ) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [highlightIndex, setHighlightIndex] = useState(0);
    const [remoteProducts, setRemoteProducts] = useState<Product[]>([]);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState<string | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const reqSeqRef = useRef(0);

    useImperativeHandle(ref, () => ({
      focus: () => {
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      },
    }));

    const excludeSet = useMemo(() => new Set(excludeIds), [excludeIds]);
    const filtered = remoteProducts.filter((p) => !excludeSet.has(p.id));

    useEffect(() => {
      setHighlightIndex(0);
    }, [query, open, filtered.length]);

    useEffect(() => {
      if (!open) return;
      const onDocClick = (e: MouseEvent) => {
        if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      };
      document.addEventListener('mousedown', onDocClick);
      return () => document.removeEventListener('mousedown', onDocClick);
    }, [open]);

    useEffect(() => {
      if (!open || !listRef.current) return;
      const el = listRef.current.children[highlightIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: 'nearest' });
    }, [highlightIndex, open]);

    // CHỈ lấy từ API — tuyệt đối không fallback danh sách local App
    useEffect(() => {
      if (!open) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(async () => {
        const token = localStorage.getItem('admin_token');
        if (!token) {
          setSearchError('Chưa đăng nhập');
          setRemoteProducts([]);
          return;
        }

        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        const seq = ++reqSeqRef.current;

        setSearching(true);
        setSearchError(null);
        try {
          const qs = new URLSearchParams({
            q: query.trim(),
            limit: '40',
          });
          const res = await fetch(`/api/products/search?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          const data = await res.json().catch(() => ({}));
          console.log('[ImportSearch] API /api/products/search:', {
            q: query.trim(),
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
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
          if (seq !== reqSeqRef.current) return;
          console.error('[ImportSearch] fetch error:', err);
          setSearchError(err?.message || 'Lỗi tìm kiếm');
          setRemoteProducts([]);
        } finally {
          if (seq === reqSeqRef.current) setSearching(false);
        }
      }, 400);

      return () => {
        // Chỉ hủy timer — không abort request ở cleanup (tránh React StrictMode hủy nhầm → phải search 2 lần)
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, [query, open]);

    const selectProduct = (p: Product) => {
      console.log('[ImportSearch] selected product:', p);
      onSelect(p);
      setQuery('');
      setOpen(false);
      setRemoteProducts([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        setOpen(true);
        return;
      }
      if (!open) return;

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
      <div ref={rootRef} className="relative">
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="w-full pl-10 pr-10 h-12 text-sm bg-white rounded-xl border border-gray-200 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/15 shadow-sm"
            autoComplete="off"
          />
          {searching && (
            <Loader2 className="w-4 h-4 text-indigo-500 absolute right-3.5 top-1/2 -translate-y-1/2 animate-spin" />
          )}
        </div>

        {open && (
          <div className="absolute z-50 left-0 right-0 mt-1.5 bg-white rounded-xl border border-gray-200 shadow-xl shadow-gray-200/60 overflow-hidden">
            <div ref={listRef} className="max-h-[380px] overflow-y-auto scrollbar-thin">
              {searchError && (
                <div className="px-3 py-2 text-[11px] text-rose-700 bg-rose-50 border-b border-rose-100">
                  {searchError}
                </div>
              )}
              {filtered.length === 0 ? (
                <div className="py-8 text-center text-xs text-gray-400">
                  {searching ? 'Đang tìm trong kho...' : searchError ? 'Không tải được danh sách từ server.' : 'Không tìm thấy sản phẩm phù hợp.'}
                </div>
              ) : (
                filtered.map((p, idx) => {
                  const img = getProductImage(p);
                  const isActive = idx === highlightIndex;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onMouseEnter={() => setHighlightIndex(idx)}
                      onClick={() => selectProduct(p)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-gray-50 last:border-b-0 transition-colors ${
                        isActive ? 'bg-indigo-50/80' : 'hover:bg-gray-50'
                      }`}
                    >
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
                    </button>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    );
  },
);

export default ImportProductSearchSelect;
