import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Package } from 'lucide-react';
import { Product } from '../types';

function getVariantLabel(p: Product): string {
  if (p.modelName?.trim()) return p.modelName.trim();
  if (p.tierLabels?.length) return p.tierLabels.join(' / ');
  const idx = p.title.indexOf(' - ');
  if (idx > 0) return p.title.slice(idx + 3).trim();
  return '—';
}

function getProductImage(p: Product): string | undefined {
  return p.avatarUrl || p.imageUrl;
}

interface ImportProductSearchSelectProps {
  products: Product[];
  value: string;
  onChange: (productId: string) => void;
  placeholder?: string;
}

export default function ImportProductSearchSelect({
  products,
  value,
  onChange,
  placeholder = 'Tìm theo SKU, tên sản phẩm...',
}: ImportProductSearchSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = products.find((p) => p.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.sku.toLowerCase().includes(q) ||
        p.title.toLowerCase().includes(q) ||
        getVariantLabel(p).toLowerCase().includes(q)
    );
  }, [products, query]);

  useEffect(() => {
    setHighlightIndex(0);
  }, [query, open]);

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

  const selectProduct = (p: Product) => {
    onChange(p.id);
    setOpen(false);
    setQuery('');
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
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2.5 bg-gray-50/50 hover:bg-gray-50 rounded-xl border border-gray-100 text-sm outline-none text-left flex items-center gap-2 min-h-[42px]"
      >
        {selected ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {getProductImage(selected) ? (
              <img
                src={getProductImage(selected)}
                alt=""
                className="w-8 h-8 rounded-md object-cover border border-gray-100 shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="w-8 h-8 rounded-md bg-gray-100 border border-gray-100 flex items-center justify-center shrink-0">
                <Package className="w-4 h-4 text-gray-400" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <span className="font-semibold text-gray-900 text-xs line-clamp-1 block">
                [{selected.sku}] {selected.title}
              </span>
              <span className="text-[10px] text-gray-400 line-clamp-1">{getVariantLabel(selected)}</span>
            </div>
          </div>
        ) : (
          <span className="text-gray-400 flex-1">Chọn sản phẩm...</span>
        )}
        <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-50 left-0 right-0 mt-1.5 bg-white rounded-xl border border-gray-200 shadow-xl shadow-gray-200/60 overflow-hidden">
          <div className="p-2 border-b border-gray-100">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                className="w-full pl-8 pr-3 py-2 text-xs bg-gray-50 rounded-lg border border-gray-100 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/20"
              />
            </div>
          </div>

          <div ref={listRef} className="max-h-[360px] overflow-y-auto scrollbar-thin">
            {filtered.length === 0 ? (
              <div className="py-8 text-center text-xs text-gray-400">Không tìm thấy sản phẩm phù hợp.</div>
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
                    } ${value === p.id ? 'bg-indigo-50/40' : ''}`}
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
                          {p.importPrice.toLocaleString('vi-VN')} đ
                        </span>
                      </p>
                      <p className="text-gray-400 mt-0.5">
                        Tồn kho:{' '}
                        <span className="font-bold text-gray-600">{p.stock}</span>
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
}
