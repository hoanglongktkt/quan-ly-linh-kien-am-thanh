import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product } from '../types';
import { CheckCircle2, ImageOff, Loader2, Scale, Search, Trash2, X } from 'lucide-react';

interface AuditLine {
  product: Product;
  actualStock: string;
}

interface InventoryAuditProps {
  products: Product[];
  shopId?: string;
  onRefreshProducts?: () => Promise<void>;
}

export default function InventoryAudit({ products, shopId, onRefreshProducts }: InventoryAuditProps) {
  const [search, setSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [mobileDropdownOpen, setMobileDropdownOpen] = useState(false);
  const [auditLines, setAuditLines] = useState<AuditLine[]>([]);
  const [balancing, setBalancing] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  const lastAddedIdRef = useRef<string | null>(null);

  const addedIds = useMemo(() => new Set(auditLines.map((l) => l.product.id)), [auditLines]);

  const suggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    let pool = products.filter((p) => !addedIds.has(p.id));
    if (q) {
      pool = pool.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q)
      );
    }
    return pool.slice(0, q ? 10 : 25);
  }, [products, search, addedIds]);

  const mobileSuggestions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q)
      )
      .slice(0, 15);
  }, [products, search]);

  const pendingItems = useMemo(() => {
    return auditLines
      .filter((line) => line.actualStock.trim() !== '')
      .map((line) => ({
        sku: line.product.sku,
        actual_stock: Math.max(0, Math.round(Number(line.actualStock) || 0)),
      }))
      .filter((item) => item.sku && Number.isFinite(item.actual_stock));
  }, [auditLines]);

  const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;

  const addProduct = useCallback(
    (prod: Product) => {
      setShowSuggestions(false);
      if (addedIds.has(prod.id)) {
        lastAddedIdRef.current = prod.id;
        if (isMobile()) setTimeout(() => qtyRefs.current.get(prod.id)?.focus(), 50);
        return;
      }
      setAuditLines((prev) => [...prev, { product: prod, actualStock: '' }]);
      setSearch('');
      lastAddedIdRef.current = prod.id;
      if (isMobile()) setTimeout(() => qtyRefs.current.get(prod.id)?.focus(), 80);
    },
    [addedIds]
  );

  const selectMobileProduct = useCallback(
    (prod: Product) => {
      setMobileDropdownOpen(false);
      setSearch('');
      lastAddedIdRef.current = prod.id;
      if (addedIds.has(prod.id)) {
        setTimeout(() => qtyRefs.current.get(prod.id)?.focus(), 80);
        return;
      }
      setAuditLines((prev) => [...prev, { product: prod, actualStock: '' }]);
      setTimeout(() => qtyRefs.current.get(prod.id)?.focus(), 80);
    },
    [addedIds]
  );

  const lookupMobileFromSearch = useCallback(
    (raw: string) => {
      const q = raw.trim().toLowerCase();
      if (!q) return;
      const exact = products.find(
        (p) => p.sku.toLowerCase() === q || (p.barcode || '').toLowerCase() === q
      );
      const prod =
        exact ||
        products.find(
          (p) => p.title.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)
        );
      if (prod) selectMobileProduct(prod);
    },
    [products, selectMobileProduct]
  );

  const lookupFromSearch = useCallback(
    (raw: string) => {
      const q = raw.trim().toLowerCase();
      if (!q) return;
      const exact = products.find(
        (p) =>
          !addedIds.has(p.id) &&
          (p.sku.toLowerCase() === q || (p.barcode || '').toLowerCase() === q)
      );
      const prod =
        exact ||
        products.find(
          (p) =>
            !addedIds.has(p.id) &&
            (p.title.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q))
        );
      if (prod) addProduct(prod);
    },
    [products, addedIds, addProduct]
  );

  useEffect(() => {
    if (isMobile()) mobileSearchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isMobile()) return;
    const id = lastAddedIdRef.current;
    if (!id) return;
    qtyRefs.current.get(id)?.focus();
  }, [auditLines.length]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (isMobile()) {
        if (mobileSuggestions.length === 1) selectMobileProduct(mobileSuggestions[0]);
        else lookupMobileFromSearch(search);
      } else {
        if (suggestions.length === 1) addProduct(suggestions[0]);
        else lookupFromSearch(search);
      }
    }
    if (e.key === 'Escape') {
      setShowSuggestions(false);
      setMobileDropdownOpen(false);
      mobileSearchRef.current?.blur();
    }
  };

  const handleMobileSearchFocus = () => {
    if (search.trim().length > 0) setMobileDropdownOpen(true);
  };

  const handleMobileSearchBlur = () => {
    setTimeout(() => setMobileDropdownOpen(false), 200);
  };

  const removeLine = (id: string) => {
    setAuditLines((prev) => prev.filter((l) => l.product.id !== id));
    if (isMobile()) setTimeout(() => mobileSearchRef.current?.focus(), 50);
  };

  const updateActual = (id: string, value: string) => {
    setAuditLines((prev) =>
      prev.map((l) => (l.product.id === id ? { ...l, actualStock: value } : l))
    );
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

      setAuditLines([]);
      setSearch('');
      setToast({ type: 'success', text: data.message || 'Cân bằng kho thành công!' });
      setTimeout(() => setToast(null), 4000);
      if (isMobile()) mobileSearchRef.current?.focus();
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

  return (
    <>
      {toastNode}

      {/* ── DESKTOP (≥769px): giao diện nguyên bản ── */}
      <div className="ia-desktop space-y-4">
        <div className="bg-white px-4 py-3 rounded-2xl border border-gray-100 shadow-xs">
          <h4 className="text-sm font-black text-slate-800 uppercase tracking-wide">Tạo phiếu kiểm kê</h4>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Tìm hoặc quét mã sản phẩm để thêm vào phiếu. Nhập tồn thực tế rồi bấm Cân Bằng Kho.
          </p>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-xs flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3.5 z-10" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Tìm theo Tên, SKU hoặc quét Barcode..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
              onKeyDown={handleSearchKeyDown}
              className="pl-9 pr-4 py-2.5 w-full bg-gray-50/50 hover:bg-gray-50 focus:bg-white text-sm rounded-xl border border-gray-100 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all"
            />
            {showSuggestions && suggestions.length > 0 && search.trim().length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-20 max-h-64 overflow-y-auto">
                {suggestions.map((prod) => (
                  <button
                    key={prod.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => addProduct(prod)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-blue-50 text-left border-b border-gray-50 last:border-0 transition-colors"
                  >
                    {prod.avatarUrl || prod.imageUrl ? (
                      <img
                        src={prod.avatarUrl || prod.imageUrl}
                        alt=""
                        className="w-8 h-8 rounded object-cover border border-gray-100 shrink-0"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded bg-gray-100 text-gray-400 flex items-center justify-center text-[9px] font-bold shrink-0">
                        SP
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900 truncate">{prod.title}</p>
                      <p className="text-[11px] font-mono text-gray-500">SKU: {prod.sku}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
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
            <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">Danh sách kiểm</span>
            <span className="text-[11px] font-bold text-gray-400">{auditLines.length} dòng</span>
          </div>

          <div className="ia-audit-table-wrap overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[880px]">
              <thead>
                <tr className="bg-gray-50/50 border-b border-gray-100 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                  <th className="p-3 w-10 text-center">STT</th>
                  <th className="p-3 w-14">Ảnh</th>
                  <th className="p-3">Tên sản phẩm & SKU</th>
                  <th className="p-3 w-24">Đơn vị</th>
                  <th className="p-3 text-center w-28">Tồn hiện tại</th>
                  <th className="p-3 text-center w-32">Tồn thực tế</th>
                  <th className="p-3 text-center w-24">Lệch</th>
                  <th className="p-3 text-center w-16">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 text-sm">
                {auditLines.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-16 text-center">
                      <div className="flex flex-col items-center gap-2 text-gray-400">
                        <Search className="w-8 h-8 opacity-30" />
                        <p className="text-sm font-semibold">Phiếu kiểm kê đang trống</p>
                        <p className="text-xs">Tìm kiếm sản phẩm ở ô phía trên để thêm vào bảng</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  auditLines.map((line, idx) => {
                    const { product, actualStock } = line;
                    const hasInput = actualStock.trim() !== '';
                    const actualNum = hasInput ? Math.max(0, Math.round(Number(actualStock) || 0)) : null;
                    const diff = actualNum !== null ? actualNum - product.stock : null;

                    return (
                      <tr key={product.id} className="hover:bg-gray-50/40 transition-colors">
                        <td className="p-3 text-center text-gray-500 font-mono text-xs">{idx + 1}</td>
                        <td className="p-3">
                          {product.avatarUrl || product.imageUrl ? (
                            <img
                              src={product.avatarUrl || product.imageUrl}
                              alt=""
                              className="w-10 h-10 rounded-lg object-cover border border-gray-100"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center text-[10px] font-bold">
                              SP
                            </div>
                          )}
                        </td>
                        <td className="p-3">
                          <p className="font-semibold text-gray-900 text-sm line-clamp-2">{product.title}</p>
                          <p className="text-[11px] font-mono text-gray-500 mt-0.5">SKU: {product.sku}</p>
                        </td>
                        <td className="p-3">
                          <span className="text-xs text-gray-600">{product.unit || '—'}</span>
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
                            value={actualStock}
                            placeholder="—"
                            onChange={(e) => updateActual(product.id, e.target.value)}
                            className="w-28 px-2 py-1.5 text-center font-mono text-sm bg-white border border-gray-200 rounded-lg outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 placeholder:text-gray-300"
                          />
                        </td>
                        <td className="p-3 text-center">
                          {diff !== null ? (
                            <span
                              className={`inline-flex min-w-[44px] justify-center font-mono font-bold px-2 py-1 rounded text-sm ${
                                diff > 0
                                  ? 'text-emerald-700 bg-emerald-50 border border-emerald-100'
                                  : diff < 0
                                    ? 'text-rose-700 bg-rose-50 border border-rose-100'
                                    : 'text-gray-500 bg-gray-50 border border-gray-100'
                              }`}
                            >
                              {diff > 0 ? `+${diff}` : diff}
                            </span>
                          ) : (
                            <span className="text-gray-300 font-mono">—</span>
                          )}
                        </td>
                        <td className="p-3 text-center">
                          <button
                            type="button"
                            onClick={() => removeLine(product.id)}
                            className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                            title="Xóa dòng"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {auditLines.length > 0 && (
            <div className="ia-desktop-audit-grid">
              {auditLines.map((line, idx) => {
                const { product, actualStock } = line;
                const hasInput = actualStock.trim() !== '';
                const actualNum = hasInput ? Math.max(0, Math.round(Number(actualStock) || 0)) : null;
                const diff = actualNum !== null ? actualNum - product.stock : null;

                return (
                  <div key={`grid-${product.id}`} className="ia-audit-row-card space-y-2">
                    <div className="flex items-start gap-2">
                      {product.avatarUrl || product.imageUrl ? (
                        <img
                          src={product.avatarUrl || product.imageUrl}
                          alt=""
                          className="w-10 h-10 rounded-lg object-cover border border-gray-100 shrink-0"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-100 text-gray-400 flex items-center justify-center text-[10px] font-bold shrink-0">
                          SP
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-bold text-gray-400">#{idx + 1}</p>
                        <p className="font-semibold text-gray-900 text-sm line-clamp-2">{product.title}</p>
                        <p className="text-[11px] font-mono text-gray-500 mt-0.5">SKU: {product.sku}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeLine(product.id)}
                        className="p-2 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all shrink-0"
                        title="Xóa dòng"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase">Tồn HT</span>
                        <span className="font-mono font-bold text-gray-800">{product.stock}</span>
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase">Thực tế</span>
                        <input
                          type="number"
                          min={0}
                          value={actualStock}
                          placeholder="—"
                          onChange={(e) => updateActual(product.id, e.target.value)}
                          className="w-full mt-0.5 px-2 py-1.5 text-center font-mono text-sm bg-white border border-gray-200 rounded-lg outline-none focus:border-blue-500 app-touch-input"
                        />
                      </div>
                      <div>
                        <span className="text-gray-400 block text-[10px] uppercase">Lệch</span>
                        {diff !== null ? (
                          <span
                            className={`inline-flex min-w-[44px] justify-center font-mono font-bold px-2 py-1 rounded text-sm mt-0.5 ${
                              diff > 0
                                ? 'text-emerald-700 bg-emerald-50 border border-emerald-100'
                                : diff < 0
                                  ? 'text-rose-700 bg-rose-50 border border-rose-100'
                                  : 'text-gray-500 bg-gray-50 border border-gray-100'
                            }`}
                          >
                            {diff > 0 ? `+${diff}` : diff}
                          </span>
                        ) : (
                          <span className="text-gray-300 font-mono">—</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ── MOBILE (≤768px): giao diện tối giản, card-based ── */}
      <div className="ia-mobile flex flex-col min-h-[calc(100dvh-6rem)] -mx-1">
        <div className="ia-mobile-search shrink-0 z-20 px-2 pt-1 pb-2 bg-gray-100">
          <div className="relative w-full">
            <Search className="w-[18px] h-[18px] text-gray-400/80 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={mobileSearchRef}
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setMobileDropdownOpen(e.target.value.trim().length > 0);
              }}
              onFocus={handleMobileSearchFocus}
              onBlur={handleMobileSearchBlur}
              onKeyDown={handleSearchKeyDown}
              autoFocus
              enterKeyHint="search"
              className="ia-mobile-search-input w-full min-h-[48px] pl-10 pr-4 text-sm bg-white border border-gray-200 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15 transition-all"
            />

            {mobileDropdownOpen && mobileSuggestions.length > 0 && (
              <ul className="ia-mobile-dropdown absolute left-0 right-0 top-full mt-1.5 max-h-[40vh] overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-xl z-30 divide-y divide-gray-50">
                {mobileSuggestions.map((p) => {
                  const img = p.avatarUrl || p.imageUrl;
                  const alreadyAdded = addedIds.has(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectMobileProduct(p)}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left active:bg-blue-50"
                      >
                        {img ? (
                          <img
                            src={img}
                            alt=""
                            className="w-9 h-9 rounded-lg object-cover border border-gray-100 shrink-0"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-lg bg-gray-100 shrink-0 flex items-center justify-center">
                            <ImageOff className="w-3.5 h-3.5 text-gray-400" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-gray-900 line-clamp-1">{p.title}</p>
                          <p className="text-[11px] font-mono text-gray-400">
                            {p.sku} · Tồn {p.stock}
                            {alreadyAdded ? ' · Đã thêm' : ''}
                          </p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="ia-mobile-body flex-1 min-h-0 overflow-y-auto px-2 pb-2 bg-gray-100">
          {auditLines.length === 0 ? (
            <div className="py-20 text-center text-gray-300 text-sm font-medium">—</div>
          ) : (
            <ul className="ia-mobile-results space-y-2 pb-2">
              {auditLines.map((line) => {
                const { product, actualStock } = line;
                const img = product.avatarUrl || product.imageUrl;
                return (
                  <li key={product.id} className="ia-mobile-card ia-mobile-card-row bg-white">
                    {img ? (
                      <img
                        src={img}
                        alt=""
                        className="ia-mobile-card-img w-11 h-11 rounded-lg object-cover border border-gray-100 shrink-0"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="ia-mobile-card-img w-11 h-11 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                        <ImageOff className="w-4 h-4 text-gray-400" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 line-clamp-2 leading-snug">{product.title}</p>
                      <p className="text-[11px] font-mono text-gray-400 mt-0.5">
                        {product.sku} · Tồn HT {product.stock}
                      </p>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        ref={(el) => {
                          if (el) qtyRefs.current.set(product.id, el);
                          else qtyRefs.current.delete(product.id);
                        }}
                        type="number"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        min={0}
                        value={actualStock}
                        placeholder="0"
                        onChange={(e) => updateActual(product.id, e.target.value)}
                        className="ia-mobile-qty-inline"
                      />
                      <button
                        type="button"
                        onClick={() => removeLine(product.id)}
                        className="p-2 text-gray-300 active:text-rose-500"
                        aria-label="Xóa"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
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
