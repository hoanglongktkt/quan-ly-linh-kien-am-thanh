import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Product } from '../types';
import { CheckCircle2, Loader2, Scale, Search, X } from 'lucide-react';

interface InventoryAuditProps {
  products: Product[];
  shopId?: string;
  onRefreshProducts?: () => Promise<void>;
}

export default function InventoryAudit({ products, shopId, onRefreshProducts }: InventoryAuditProps) {
  const [search, setSearch] = useState('');
  const [actualStocks, setActualStocks] = useState<Record<string, string>>({});
  const [balancing, setBalancing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [products, search]);

  const pendingItems = useMemo(() => {
    return searchResults
      .filter((p) => actualStocks[p.id]?.trim() !== '')
      .map((p) => ({
        sku: p.sku,
        actual_stock: Math.max(0, Math.round(Number(actualStocks[p.id]) || 0)),
      }))
      .filter((item) => item.sku && Number.isFinite(item.actual_stock));
  }, [searchResults, actualStocks]);

  const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;

  const updateActual = (id: string, value: string) => {
    setActualStocks((prev) => ({ ...prev, [id]: value }));
  };

  useEffect(() => {
    if (isMobile()) mobileSearchRef.current?.focus();
  }, []);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearch('');
      mobileSearchRef.current?.blur();
      searchRef.current?.blur();
    }
  };

  const handleBalance = async () => {
    if (pendingItems.length === 0) {
      setToast({ type: 'error', text: 'Vui lòng tìm sản phẩm và nhập số lượng thực tế.' });
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
      let data: { success?: boolean; message?: string; error?: string } = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(
          res.status === 404
            ? 'API cân bằng kho chưa sẵn sàng. Hãy restart server.'
            : 'Server không trả về dữ liệu hợp lệ.'
        );
      }

      if (!res.ok || !data.success) {
        throw new Error(data?.message || data?.error || 'Cân bằng kho thất bại.');
      }

      if (onRefreshProducts) await onRefreshProducts();

      setActualStocks({});
      setSearch('');
      setToast({ type: 'success', text: data.message || 'Cân bằng kho thành công!' });
      setTimeout(() => setToast(null), 4000);
      if (isMobile()) mobileSearchRef.current?.focus();
      else searchRef.current?.focus();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Cân bằng kho thất bại.';
      setToast({ type: 'error', text: msg });
      setTimeout(() => setToast(null), 4000);
    } finally {
      setBalancing(false);
    }
  };

  const toastNode = toast && (
    <div
      className={`fixed top-5 right-5 max-md:top-3 max-md:left-3 max-md:right-3 z-70 font-bold text-xs px-5 py-3 max-md:px-4 rounded-2xl max-md:rounded-xl shadow-2xl max-md:shadow-lg border flex items-center gap-2 ${
        toast.type === 'success'
          ? 'bg-emerald-600 text-white border-emerald-500 max-md:border-0'
          : 'bg-slate-900 text-white border-slate-700 max-md:bg-rose-600 max-md:border-0'
      }`}
    >
      <CheckCircle2 className={`w-4 h-4 shrink-0 ${toast.type === 'success' ? 'text-white' : 'text-emerald-400 max-md:text-white'}`} />
      <span className="flex-1">{toast.text}</span>
      <button type="button" onClick={() => setToast(null)} className="ml-1 opacity-70 hover:opacity-100">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  const renderTableBody = () => {
    if (!search.trim()) {
      return (
        <tr>
          <td colSpan={4} className="p-16 text-center">
            <div className="flex flex-col items-center gap-2 text-gray-400">
              <Search className="w-8 h-8 opacity-30" />
              <p className="text-sm font-semibold">Nhập từ khóa để tìm sản phẩm</p>
              <p className="text-xs">Kết quả sẽ hiển thị ngay dưới dạng bảng</p>
            </div>
          </td>
        </tr>
      );
    }

    if (searchResults.length === 0) {
      return (
        <tr>
          <td colSpan={4} className="p-12 text-center text-sm text-gray-400 font-medium">
            Không tìm thấy sản phẩm phù hợp
          </td>
        </tr>
      );
    }

    return searchResults.map((product, idx) => (
      <tr key={product.id} className="hover:bg-gray-50/40 transition-colors">
        <td className="p-3 text-center text-gray-500 font-mono text-xs">{idx + 1}</td>
        <td className="p-3">
          <p className="font-semibold text-gray-900 text-sm line-clamp-2">{product.title}</p>
          <p className="text-[11px] font-mono text-gray-500 mt-0.5">SKU: {product.sku}</p>
        </td>
        <td className="p-3 text-center">
          <span className="inline-flex min-w-[44px] justify-center font-mono font-bold text-gray-800 bg-gray-50 px-2 py-1 rounded border border-gray-100 text-sm">
            {product.stock}
          </span>
        </td>
        <td className="p-3 text-center">
          <input
            type="number"
            min={0}
            value={actualStocks[product.id] ?? ''}
            placeholder="—"
            onChange={(e) => updateActual(product.id, e.target.value)}
            className="w-28 px-2 py-1.5 text-center font-mono text-sm bg-white border border-gray-200 rounded-lg outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 placeholder:text-gray-300"
          />
        </td>
      </tr>
    ));
  };

  return (
    <>
      {toastNode}

      <div className="ia-desktop space-y-4">
        <div className="bg-white px-4 py-3 rounded-2xl border border-gray-100 shadow-xs">
          <h4 className="text-sm font-black text-slate-800 uppercase tracking-wide">Kiểm hàng &amp; cân bằng kho</h4>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Tìm sản phẩm theo Tên, SKU hoặc Barcode — nhập tồn thực tế rồi bấm Cân Bằng Kho.
          </p>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3.5 z-10" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Tìm theo Tên, SKU hoặc quét Barcode..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              className="pl-9 pr-4 py-2.5 w-full bg-gray-50/50 hover:bg-gray-50 focus:bg-white text-sm rounded-xl border border-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleBalance()}
            disabled={balancing || pendingItems.length === 0}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-bold rounded-xl transition-all shadow-md shadow-blue-600/20 flex items-center justify-center gap-2 shrink-0"
          >
            {balancing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />}
            <span>
              {balancing ? 'Đang cân bằng...' : `Cân Bằng Kho${pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}`}
            </span>
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
          <div className="px-4 py-2.5 border-b border-gray-100 bg-slate-50/60 flex items-center justify-between">
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Kết quả tìm kiếm</span>
            <span className="text-[11px] font-bold text-gray-400">
              {search.trim() ? `${searchResults.length} sản phẩm` : '—'}
            </span>
          </div>

          <div className="ia-audit-table-wrap overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[640px]">
              <thead>
                <tr className="bg-gray-50/50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                  <th className="p-3 w-14 text-center">STT</th>
                  <th className="p-3">Tên sản phẩm</th>
                  <th className="p-3 text-center w-36">Số lượng trong kho</th>
                  <th className="p-3 text-center w-36">Số lượng thực tế</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 text-sm">{renderTableBody()}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="ia-mobile flex flex-col -mx-1 pb-24">
        <div className="ia-mobile-search shrink-0 z-20 px-2 pt-1 pb-2 bg-gray-100">
          <div className="relative w-full">
            <Search className="w-[18px] h-[18px] text-gray-400/80 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={mobileSearchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              autoFocus
              enterKeyHint="search"
              placeholder="Tìm Tên, SKU, Barcode..."
              className="ia-mobile-search-input w-full min-h-[48px] pl-10 pr-4 text-sm bg-white border border-gray-200 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 transition-all"
            />
          </div>
        </div>

        <div className="ia-mobile-body px-2 pb-2 bg-gray-100">
          {!search.trim() ? (
            <div className="py-20 text-center text-gray-400 text-sm">Nhập từ khóa để tìm sản phẩm</div>
          ) : searchResults.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm">Không tìm thấy sản phẩm</div>
          ) : (
            <ul className="ia-mobile-results space-y-2 pb-2">
              {searchResults.map((product) => (
                <li key={product.id} className="ia-mobile-card ia-mobile-card-row bg-white">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-gray-900 line-clamp-2 leading-snug">{product.title}</p>
                    <p className="text-[11px] font-mono text-gray-400 mt-0.5">
                      {product.sku} · Tồn HT {product.stock}
                    </p>
                  </div>
                  <div className="shrink-0">
                    <input
                      ref={(el) => {
                        if (el) qtyRefs.current.set(product.id, el);
                        else qtyRefs.current.delete(product.id);
                      }}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={actualStocks[product.id] ?? ''}
                      placeholder="0"
                      onChange={(e) => updateActual(product.id, e.target.value)}
                      className="ia-mobile-qty-inline"
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="ia-mobile-footer fixed bottom-17 left-0 right-0 z-55 px-2 py-2.5 bg-white">
          <button
            type="button"
            onClick={() => void handleBalance()}
            disabled={balancing || pendingItems.length === 0}
            className="ia-mobile-balance-btn w-full min-h-[56px] bg-blue-600 active:bg-blue-700 disabled:opacity-50 text-white font-extrabold text-sm uppercase tracking-wide flex items-center justify-center gap-2 transition-colors"
          >
            {balancing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Scale className="w-5 h-5" />}
            CÂN BẰNG KHO{pendingItems.length > 0 ? ` (${pendingItems.length})` : ''}
          </button>
        </div>
      </div>
    </>
  );
}
