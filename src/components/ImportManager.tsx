import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ImportTransaction, Supplier, Product } from '../types';
import {
  calcImportPriceChangePercent,
  getImportPriceChangeStatus,
} from '../utils/importPriceChange';
import ImportProductSearchSelect, {
  ImportProductSearchSelectHandle,
} from './ImportProductSearchSelect';
import ImportSupplierSelect, { ImportSupplierSelectHandle } from './ImportSupplierSelect';
import {
  Plus,
  Search,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  Calendar,
  Box,
  ExternalLink,
  AlertTriangle,
  FileSpreadsheet,
  ArrowLeft,
  History,
  Truck,
  CheckCircle2,
  X,
  Trash2,
  Package,
} from 'lucide-react';

function PriceChangeBadge({
  oldPrice,
  newPrice,
  size = 'sm',
}: {
  oldPrice: number;
  newPrice: number;
  size?: 'sm' | 'md';
}) {
  const status = getImportPriceChangeStatus(oldPrice, newPrice);
  const pct = calcImportPriceChangePercent(oldPrice, newPrice);
  const cls = size === 'md' ? 'px-2 py-0.5 rounded-lg text-xs font-extrabold' : 'px-1.5 py-0.5 rounded text-xs font-bold';

  if (status === 'new') {
    return (
      <span className={`inline-flex items-center ${cls} bg-sky-50 text-sky-600 border border-sky-100`}>
        Mới
      </span>
    );
  }
  if (status === 'up' && pct !== null) {
    return (
      <span className={`inline-flex items-center gap-0.5 ${cls} bg-rose-50 text-rose-600 border border-rose-100`}>
        <ArrowUpRight className="w-3.5 h-3.5" /> +{pct.toFixed(1)}%
        {size === 'md' && ' (Tăng giá)'}
      </span>
    );
  }
  if (status === 'down' && pct !== null) {
    return (
      <span className={`inline-flex items-center gap-0.5 ${cls} bg-emerald-50 text-emerald-600 border border-emerald-100`}>
        <ArrowDownRight className="w-3.5 h-3.5" /> {pct.toFixed(1)}%
        {size === 'md' && ' (Giảm giá)'}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center ${cls} bg-gray-50 text-gray-400 border border-gray-100 font-semibold`}>
      Bằng giá cũ
    </span>
  );
}

interface SelectedImportLine {
  productId: string;
  title: string;
  sku: string;
  image?: string;
  currentStock: number;
  oldImportPrice: number;
  quantity: number;
  unitPrice: number;
}

interface ImportManagerProps {
  imports: ImportTransaction[];
  suppliers: Supplier[];
  onRefreshSuppliers?: () => Promise<void> | void;
  onSuppliersUpdated?: (suppliers: Supplier[]) => void;
  products: Product[];
  onAddImport: (transaction: ImportTransaction) => void | Promise<void>;
  onEditProductShortcut: (productId: string) => void;
  initialProductId?: string | null;
  onInitialProductConsumed?: () => void;
}

export default function ImportManager({
  imports,
  suppliers: suppliersProp,
  onRefreshSuppliers,
  onSuppliersUpdated,
  products,
  onAddImport,
  onEditProductShortcut,
  initialProductId,
  onInitialProductConsumed,
}: ImportManagerProps) {
  const [localSuppliers, setLocalSuppliers] = useState<Supplier[]>(suppliersProp);
  const [viewMode, setViewMode] = useState<'list' | 'create'>('list');
  const prefillHandledRef = useRef<string | null>(null);
  const supplierSelectRef = useRef<ImportSupplierSelectHandle>(null);
  const productSearchRef = useRef<ImportProductSearchSelectHandle>(null);

  const fetchSuppliersFromApi = useCallback(async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const res = await fetch('/api/suppliers', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        setLocalSuppliers(await res.json());
      }
    } catch (err) {
      console.error('Fetch suppliers for import error:', err);
    }
  }, []);

  useEffect(() => {
    fetchSuppliersFromApi();
  }, [fetchSuppliersFromApi]);

  useEffect(() => {
    setLocalSuppliers(suppliersProp);
  }, [suppliersProp]);

  const suppliers = localSuppliers;

  const [search, setSearch] = useState('');
  const [selectedSupplierFilter, setSelectedSupplierFilter] = useState('all');

  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [selectedProducts, setSelectedProducts] = useState<SelectedImportLine[]>([]);
  const [importCost, setImportCost] = useState<number>(0);
  const [paidAmount, setPaidAmount] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [historyModal, setHistoryModal] = useState<{
    productId: string;
    productTitle: string;
    productSku: string;
    rows: ImportTransaction[];
    loading: boolean;
  } | null>(null);
  const [priceHistoryOpenId, setPriceHistoryOpenId] = useState<string | null>(null);

  const goodsTotal = useMemo(
    () => selectedProducts.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
    [selectedProducts],
  );
  const totalCost = goodsTotal + importCost;

  const filteredImports = imports.filter((imp) => {
    const matchesSearch =
      imp.productTitle.toLowerCase().includes(search.toLowerCase()) ||
      imp.productSku.toLowerCase().includes(search.toLowerCase()) ||
      imp.supplierName.toLowerCase().includes(search.toLowerCase());
    const matchesSupplier = selectedSupplierFilter === 'all' || imp.supplierId === selectedSupplierFilter;
    return matchesSearch && matchesSupplier;
  });

  // F3 = focus tìm SP, F4 = focus NCC
  useEffect(() => {
    if (viewMode !== 'create') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault();
        productSearchRef.current?.focus();
      } else if (e.key === 'F4') {
        e.preventDefault();
        supplierSelectRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'create') return;
    const onDocClick = () => setPriceHistoryOpenId(null);
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [viewMode]);

  const syncPaidToTotal = (total: number) => {
    setPaidAmount(total);
  };

  const addProductToTable = useCallback(
    async (product: Product) => {
      const productId = String(product.id || '').trim();
      if (!productId) return;

      setSelectedProducts((prev) => {
        if (prev.some((l) => l.productId === productId)) {
          setToastMessage('Sản phẩm đã có trong bảng — tăng số lượng nếu cần.');
          setTimeout(() => setToastMessage(null), 2500);
          return prev;
        }
        const price = Number(product.importPrice) || 0;
        const next: SelectedImportLine[] = [
          ...prev,
          {
            productId,
            title: product.title || (product as any).name || '',
            sku: product.sku || '',
            image: (product as any).image || product.avatarUrl || product.imageUrl,
            currentStock: Number(product.stock) || 0,
            oldImportPrice: price,
            quantity: 1,
            unitPrice: price > 0 ? price : 0,
          },
        ];
        const goods = next.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        syncPaidToTotal(goods + importCost);
        return next;
      });

      // Bổ sung tồn kho / giá cũ từ product-context
      const token = localStorage.getItem('admin_token');
      if (!token) return;
      try {
        const res = await fetch(`/api/imports/product-context/${encodeURIComponent(productId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        console.log('[ImportManager] product-context:', data);
        setSelectedProducts((prev) =>
          prev.map((line) =>
            line.productId === productId
              ? {
                  ...line,
                  currentStock: data.stock != null ? Number(data.stock) || 0 : line.currentStock,
                  oldImportPrice: Number(data.oldPrice ?? data.importPrice ?? line.oldImportPrice) || 0,
                  unitPrice:
                    line.unitPrice > 0
                      ? line.unitPrice
                      : Number(data.oldPrice ?? data.importPrice ?? 0) || 0,
                  title: data.title || line.title,
                  sku: data.sku || line.sku,
                }
              : line,
          ),
        );
      } catch (err) {
        console.error('Fetch product import context error:', err);
      }
    },
    [importCost],
  );

  const updateLine = (productId: string, patch: Partial<Pick<SelectedImportLine, 'quantity' | 'unitPrice'>>) => {
    setSelectedProducts((prev) => {
      const next = prev.map((line) => {
        if (line.productId !== productId) return line;
        return {
          ...line,
          quantity: patch.quantity != null ? Math.max(1, Math.round(patch.quantity)) : line.quantity,
          unitPrice: patch.unitPrice != null ? Math.max(0, Math.round(patch.unitPrice)) : line.unitPrice,
        };
      });
      const goods = next.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      syncPaidToTotal(goods + importCost);
      return next;
    });
  };

  const removeLine = (productId: string) => {
    setSelectedProducts((prev) => {
      const next = prev.filter((l) => l.productId !== productId);
      const goods = next.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      syncPaidToTotal(goods + importCost);
      return next;
    });
  };

  const bootstrapCreateForm = async (prefillProductId?: string) => {
    const token = localStorage.getItem('admin_token');
    let fresh: Supplier[] = [];
    if (token) {
      try {
        const res = await fetch('/api/suppliers', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          fresh = await res.json();
          setLocalSuppliers(fresh);
        }
      } catch (err) {
        console.error('Refresh suppliers before import:', err);
      }
    }
    onRefreshSuppliers?.();

    if (fresh.length === 0) {
      setSelectedSupplierId('');
    } else {
      setSelectedSupplierId(fresh[0].id);
    }
    setImportCost(0);
    setPaidAmount(0);
    setSelectedProducts([]);
    setViewMode('create');

    if (prefillProductId) {
      const local = products.find((p) => p.id === prefillProductId);
      if (local) {
        void addProductToTable(local);
      } else {
        void addProductToTable({
          id: prefillProductId,
          title: '',
          sku: '',
          stock: 0,
          importPrice: 0,
          sellingPrice: 0,
          channels: [],
          category: '',
          status: 'active',
          description: '',
        } as Product);
      }
    }

    setTimeout(() => productSearchRef.current?.focus(), 100);
  };

  const handleOpenCreate = async () => {
    await bootstrapCreateForm();
  };

  useEffect(() => {
    if (!initialProductId) {
      prefillHandledRef.current = null;
      return;
    }
    if (prefillHandledRef.current === initialProductId) return;
    prefillHandledRef.current = initialProductId;
    void bootstrapCreateForm(initialProductId).finally(() => {
      onInitialProductConsumed?.();
    });
  }, [initialProductId]);

  const openImportHistory = async (productId: string, productTitle: string, productSku: string) => {
    const token = localStorage.getItem('admin_token');
    setHistoryModal({ productId, productTitle, productSku, rows: [], loading: true });
    try {
      if (token) {
        const res = await fetch(`/api/imports/history/${encodeURIComponent(productId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (res.ok && Array.isArray(data.history)) {
          setHistoryModal({
            productId,
            productTitle,
            productSku,
            rows: data.history,
            loading: false,
          });
          return;
        }
      }
      const local = imports
        .filter((imp) => imp.productId === productId || (productSku && imp.productSku === productSku))
        .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
      setHistoryModal({ productId, productTitle, productSku, rows: local, loading: false });
    } catch {
      const local = imports.filter((imp) => imp.productId === productId);
      setHistoryModal({ productId, productTitle, productSku, rows: local, loading: false });
    }
  };

  const lineHistoryPreview = (productId: string) =>
    imports
      .filter((imp) => imp.productId === productId)
      .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
      .slice(0, 5);

  const handleSubmitImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplierId) {
      alert('Vui lòng chọn nhà cung cấp!');
      supplierSelectRef.current?.focus();
      return;
    }
    if (selectedProducts.length === 0) {
      alert('Vui lòng thêm ít nhất một sản phẩm vào bảng!');
      productSearchRef.current?.focus();
      return;
    }
    if (selectedProducts.some((l) => l.quantity <= 0 || l.unitPrice <= 0)) {
      alert('Mỗi dòng cần Số lượng và Đơn giá hợp lệ!');
      return;
    }

    const supplier = suppliers.find((s) => s.id === selectedSupplierId);
    if (!supplier) {
      alert('Nhà cung cấp không hợp lệ!');
      return;
    }

    const finalPaid = Number(paidAmount);
    if (finalPaid > totalCost) {
      alert('Số tiền thực trả không được vượt quá tổng giá trị đơn nhập hàng!');
      return;
    }

    setSubmitting(true);
    try {
      let remainingPaid = finalPaid;
      const date = new Date().toISOString().split('T')[0];

      for (let i = 0; i < selectedProducts.length; i++) {
        const line = selectedProducts[i];
        const lineGoods = line.quantity * line.unitPrice;
        const lineImportCost = i === 0 ? importCost : 0;
        const lineTotal = lineGoods + lineImportCost;
        const linePaid = Math.min(remainingPaid, lineTotal);
        remainingPaid -= linePaid;

        let status: 'fully_paid' | 'partial' | 'unpaid' = 'unpaid';
        if (linePaid === lineTotal) status = 'fully_paid';
        else if (linePaid > 0) status = 'partial';

        const tx: ImportTransaction = {
          id: `imp-${Date.now()}-${i}`,
          supplierId: selectedSupplierId,
          supplierName: supplier.name,
          date,
          productId: line.productId,
          productTitle: line.title,
          productSku: line.sku,
          quantity: line.quantity,
          oldImportPrice: line.oldImportPrice,
          newImportPrice: line.unitPrice,
          importCost: lineImportCost,
          totalAmount: lineTotal,
          paidAmount: linePaid,
          status,
          warehouseId: 'default',
        };
        await onAddImport(tx);
      }

      setViewMode('list');
      alert(`Đã lưu đơn nhập kho thành công (${selectedProducts.length} sản phẩm). Tồn kho đã được cập nhật.`);
    } catch (err) {
      console.error(err);
      alert('Có lỗi khi lưu đơn nhập. Vui lòng thử lại.');
    } finally {
      setSubmitting(false);
    }
  };

  const historyModalEl = historyModal && (
    <div className="fixed inset-0 z-80 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-slate-900/40" aria-label="Đóng" onClick={() => setHistoryModal(null)} />
      <div className="relative w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-gray-100 max-h-[85vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
              <History className="w-4 h-4 text-indigo-600" /> Lịch sử nhập hàng
            </h3>
            <p className="text-xs text-gray-500 mt-1 line-clamp-2">
              [{historyModal.productSku}] {historyModal.productTitle}
            </p>
          </div>
          <button type="button" onClick={() => setHistoryModal(null)} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4 space-y-2">
          {historyModal.loading ? (
            <p className="text-center text-xs text-gray-400 py-8">Đang tải lịch sử...</p>
          ) : historyModal.rows.length === 0 ? (
            <p className="text-center text-xs text-gray-400 py-8">Chưa có lần nhập nào.</p>
          ) : (
            historyModal.rows.map((row, idx) => {
              const prev = historyModal.rows[idx + 1];
              return (
                <div key={row.id} className="rounded-xl border border-gray-100 bg-gray-50/60 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold text-gray-800">{row.supplierName}</span>
                    <span className="text-gray-400">{row.date}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <span className="text-gray-400 block">SL</span>
                      <span className="font-bold">{row.quantity}</span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">Giá nhập</span>
                      <span className="font-mono font-bold">{row.newImportPrice.toLocaleString('vi-VN')} đ</span>
                    </div>
                    <div>
                      <span className="text-gray-400 block">So lần trước</span>
                      {prev ? (
                        <PriceChangeBadge oldPrice={prev.newImportPrice} newPrice={row.newImportPrice} />
                      ) : (
                        <span className="text-sky-600 font-bold">Lần đầu</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );

  if (viewMode === 'create') {
    return (
      <div className="space-y-0 -mx-4 sm:-mx-6 lg:-mx-8">
        {toastMessage && (
          <div className="fixed top-5 right-5 z-70 bg-emerald-600 text-white font-semibold text-sm px-5 py-3 rounded-xl shadow-lg flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{toastMessage}</span>
            <button type="button" onClick={() => setToastMessage(null)} className="ml-1 text-emerald-200 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="bg-white border-y border-gray-100 shadow-sm">
          <div className="px-6 lg:px-10 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className="mt-0.5 p-2 hover:bg-gray-50 rounded-xl border border-gray-200 text-gray-500 hover:text-gray-800 shrink-0"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-xl font-extrabold text-gray-900 flex items-center gap-2">
                  <Box className="w-6 h-6 text-indigo-600" />
                  Tạo Đơn Nhập Hàng
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Phím tắt: <kbd className="px-1.5 py-0.5 bg-gray-100 rounded border text-[10px] font-mono">F4</kbd> Nhà cung cấp ·{' '}
                  <kbd className="px-1.5 py-0.5 bg-gray-100 rounded border text-[10px] font-mono">F3</kbd> Tìm sản phẩm
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400 font-medium">
              <Calendar className="w-4 h-4" />
              {new Date().toLocaleDateString('vi-VN')}
            </div>
          </div>

          <form onSubmit={handleSubmitImport} className="px-6 lg:px-10 py-6 space-y-6">
            {/* Block 1: NCC */}
            <section className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
                1. Nhà cung cấp <span className="normal-case font-normal text-gray-300">(F4)</span>
              </label>
              <div className="max-w-xl">
                <ImportSupplierSelect
                  ref={supplierSelectRef}
                  suppliers={suppliers}
                  value={selectedSupplierId}
                  onChange={setSelectedSupplierId}
                  onSuppliersUpdated={(updated) => {
                    setLocalSuppliers(updated);
                    onSuppliersUpdated?.(updated);
                  }}
                  onQuickAddSuccess={() => {
                    setToastMessage('Đã thêm nhà cung cấp mới!');
                    setTimeout(() => setToastMessage(null), 3000);
                  }}
                />
              </div>
            </section>

            {/* Block 2: Tìm SP */}
            <section className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
                2. Tìm kiếm sản phẩm <span className="normal-case font-normal text-gray-300">(F3)</span>
              </label>
              <ImportProductSearchSelect
                ref={productSearchRef}
                products={products}
                excludeIds={selectedProducts.map((l) => l.productId)}
                onSelect={(p) => void addProductToTable(p)}
              />
            </section>

            {/* Block 3: Bảng chi tiết */}
            <section className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
                3. Chi tiết sản phẩm nhập ({selectedProducts.length})
              </label>
              <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[720px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-gray-200 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                        <th className="px-3 py-3 w-12 text-center">STT</th>
                        <th className="px-3 py-3 w-14">Ảnh</th>
                        <th className="px-3 py-3">Tên sản phẩm</th>
                        <th className="px-3 py-3 w-28 text-center">Tồn</th>
                        <th className="px-3 py-3 w-32 text-center">SL nhập</th>
                        <th className="px-3 py-3 w-44 text-right">Đơn giá</th>
                        <th className="px-3 py-3 w-36 text-right">Thành tiền</th>
                        <th className="px-3 py-3 w-14 text-center" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 text-sm">
                      {selectedProducts.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-14 text-center text-gray-400 text-sm">
                            <Package className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                            Chưa có sản phẩm — dùng ô tìm kiếm phía trên (F3) để thêm vào bảng.
                          </td>
                        </tr>
                      ) : (
                        selectedProducts.map((line, idx) => {
                          const lineTotal = line.quantity * line.unitPrice;
                          const preview = lineHistoryPreview(line.productId);
                          return (
                            <tr key={line.productId} className="hover:bg-slate-50/60">
                              <td className="px-3 py-3 text-center text-gray-400 font-mono text-xs">{idx + 1}</td>
                              <td className="px-3 py-3">
                                {line.image ? (
                                  <img
                                    src={line.image}
                                    alt=""
                                    className="w-10 h-10 rounded-lg object-cover border border-gray-100"
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
                                    <Package className="w-4 h-4 text-gray-400" />
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-3 min-w-0">
                                <p className="font-semibold text-gray-900 line-clamp-2 leading-snug">{line.title || '—'}</p>
                                <p className="text-[11px] font-mono text-gray-400 mt-0.5">{line.sku || '—'}</p>
                              </td>
                              <td className="px-3 py-3 text-center font-mono text-xs text-gray-500">{line.currentStock}</td>
                              <td className="px-3 py-3">
                                <input
                                  type="number"
                                  min={1}
                                  value={line.quantity}
                                  onChange={(e) => updateLine(line.productId, { quantity: Number(e.target.value) })}
                                  className="w-full px-2 py-2 text-center font-mono font-bold text-sm rounded-lg border border-gray-200 outline-none focus:border-indigo-400"
                                />
                              </td>
                              <td className="px-3 py-3">
                                <div className="relative flex items-center gap-1 justify-end">
                                  <input
                                    type="number"
                                    min={0}
                                    value={line.unitPrice}
                                    onChange={(e) => updateLine(line.productId, { unitPrice: Number(e.target.value) })}
                                    className="w-full min-w-[100px] px-2 py-2 text-right font-mono font-bold text-sm text-indigo-700 rounded-lg border border-gray-200 outline-none focus:border-indigo-400"
                                  />
                                  <button
                                    type="button"
                                    title="Lịch sử giá nhập"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setPriceHistoryOpenId((id) => (id === line.productId ? null : line.productId));
                                    }}
                                    className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 shrink-0"
                                  >
                                    <History className="w-3.5 h-3.5" />
                                  </button>
                                  {priceHistoryOpenId === line.productId && (
                                    <div
                                      className="absolute right-0 top-full mt-1 z-40 w-64 bg-white border border-gray-200 rounded-xl shadow-xl p-3 text-left"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <p className="text-[10px] font-bold uppercase text-gray-400 mb-2">Lịch sử giá nhập</p>
                                      <p className="text-xs text-gray-500 mb-2">
                                        Giá cũ:{' '}
                                        <span className="font-mono font-bold text-gray-800">
                                          {line.oldImportPrice > 0
                                            ? `${line.oldImportPrice.toLocaleString('vi-VN')} đ`
                                            : 'N/A'}
                                        </span>
                                      </p>
                                      {preview.length === 0 ? (
                                        <p className="text-xs text-gray-400 italic">Chưa có lịch sử.</p>
                                      ) : (
                                        <ul className="space-y-1.5 max-h-36 overflow-y-auto">
                                          {preview.map((imp) => (
                                            <li key={imp.id} className="flex justify-between text-[11px] gap-2">
                                              <span className="text-gray-400 shrink-0">{imp.date}</span>
                                              <span className="font-mono font-bold text-gray-800">
                                                {imp.newImportPrice.toLocaleString('vi-VN')} đ
                                              </span>
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                      <button
                                        type="button"
                                        className="mt-2 text-[11px] font-semibold text-indigo-600 hover:underline"
                                        onClick={() => openImportHistory(line.productId, line.title, line.sku)}
                                      >
                                        Xem đầy đủ →
                                      </button>
                                    </div>
                                  )}
                                </div>
                                {line.oldImportPrice > 0 && line.unitPrice !== line.oldImportPrice && (
                                  <div className="mt-1 flex justify-end">
                                    <PriceChangeBadge oldPrice={line.oldImportPrice} newPrice={line.unitPrice} />
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-3 text-right font-mono font-bold text-slate-800">
                                {lineTotal.toLocaleString('vi-VN')} đ
                              </td>
                              <td className="px-3 py-3 text-center">
                                <button
                                  type="button"
                                  onClick={() => removeLine(line.productId)}
                                  className="p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
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
              </div>
            </section>

            {/* Block 4: Tổng kết */}
            <section className="border-t border-gray-100 pt-5 space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
                <div className="flex flex-wrap gap-4 items-end">
                  <div className="space-y-1 w-44">
                    <label className="text-xs font-semibold text-gray-600 flex items-center gap-1">
                      <Truck className="w-3.5 h-3.5 text-gray-400" /> Chi phí khác
                    </label>
                    <input
                      type="number"
                      min={0}
                      value={importCost}
                      onChange={(e) => {
                        const cost = Math.max(0, Number(e.target.value) || 0);
                        setImportCost(cost);
                        syncPaidToTotal(goodsTotal + cost);
                      }}
                      className="w-full px-3 py-2.5 rounded-lg border border-gray-200 font-mono font-bold text-amber-800 text-sm outline-none focus:border-amber-300"
                    />
                  </div>
                  <div className="space-y-1 w-48">
                    <label className="text-xs font-semibold text-gray-600">Số tiền đã trả</label>
                    <input
                      type="number"
                      min={0}
                      max={totalCost}
                      value={paidAmount}
                      onChange={(e) => setPaidAmount(Math.min(totalCost, Math.max(0, Number(e.target.value))))}
                      className="w-full px-3 py-2.5 rounded-lg border border-gray-200 font-mono font-bold text-indigo-600 text-sm text-right outline-none focus:border-indigo-400"
                    />
                    <p className="text-[11px] text-gray-400">
                      Còn nợ:{' '}
                      <span className="font-mono font-bold text-rose-600">
                        {(totalCost - paidAmount).toLocaleString('vi-VN')} đ
                      </span>
                    </p>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">Tổng cộng</span>
                  <span className="text-3xl font-extrabold text-indigo-900 font-mono tracking-tight">
                    {totalCost.toLocaleString('vi-VN')} đ
                  </span>
                  <p className="text-[11px] text-gray-400 font-mono mt-0.5">
                    Hàng: {goodsTotal.toLocaleString('vi-VN')}
                    {importCost > 0 ? ` + CP: ${importCost.toLocaleString('vi-VN')}` : ''}
                  </p>
                </div>
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className="px-5 py-3 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={submitting || selectedProducts.length === 0 || !selectedSupplierId}
                  className="min-w-[200px] px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-xl shadow-sm"
                >
                  {submitting ? 'Đang lưu...' : 'Xác nhận nhập kho'}
                </button>
              </div>
            </section>
          </form>
        </div>

        {historyModalEl}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Tổng số đợt nhập sỉ</span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{imports.length} đợt</h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Tổng vốn nhập kho sỉ</span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">
              {imports.reduce((sum, item) => sum + item.totalAmount, 0).toLocaleString('vi-VN')} đ
            </h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center font-bold">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Nợ chưa trả nhà sỉ</span>
            <h3 className="text-xl font-extrabold text-rose-600 mt-0.5">
              {suppliers.reduce((sum, item) => sum + item.totalDebt, 0).toLocaleString('vi-VN')} đ
            </h3>
          </div>
        </div>
      </div>

      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex-1 flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-3.5" />
            <input
              type="text"
              placeholder="Tìm theo sản phẩm, mã SKU, tên nhà phân phối..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-4 py-2.5 w-full bg-gray-50/50 hover:bg-gray-50 focus:bg-white text-sm rounded-xl border border-gray-100 focus:border-blue-500 outline-none transition-all"
            />
          </div>

          <div className="relative">
            <select
              value={selectedSupplierFilter}
              onChange={(e) => setSelectedSupplierFilter(e.target.value)}
              className="pl-3 pr-8 py-2.5 bg-gray-50/50 hover:bg-gray-50 text-sm rounded-xl border border-gray-100 outline-none cursor-pointer appearance-none min-w-[200px]"
            >
              <option value="all">Tất cả nhà cung cấp</option>
              {suppliers.map((sup) => (
                <option key={sup.id} value={sup.id}>
                  {sup.supplierCode} — {sup.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={handleOpenCreate}
          className="w-full sm:w-auto min-h-11 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 shadow-sm shrink-0"
        >
          <Plus className="w-4.5 h-4.5" /> Thêm Mới
        </button>
      </div>

      <div className="max-md:hidden md:block bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-gray-50/50 border-b border-gray-100 text-xs font-bold text-gray-500 uppercase tracking-wider">
                <th className="p-4">Ngày & Nhà Sỉ</th>
                <th className="p-4">Sản phẩm nhập kho</th>
                <th className="p-4 text-center">Số lượng</th>
                <th className="p-4 text-right">Giá nhập cũ</th>
                <th className="p-4 text-right">Giá nhập mới</th>
                <th className="p-4 text-right">Chi phí NH</th>
                <th className="p-4 text-center">% Thay đổi giá</th>
                <th className="p-4 text-right">Thành tiền / Đã trả</th>
                <th className="p-4 text-center">Liên kết sửa sản phẩm</th>
                <th className="p-4 text-center">Lịch sử giá</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 text-sm">
              {filteredImports.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-12 text-center text-gray-400">
                    Không tìm thấy bản ghi nhập kho nào phù hợp.
                  </td>
                </tr>
              ) : (
                filteredImports.map((imp) => (
                  <tr key={imp.id} className="hover:bg-gray-50/50 transition-colors">
                    <td className="p-4">
                      <div className="space-y-1">
                        <div className="text-xs text-gray-400 flex items-center gap-1">
                          <Calendar className="w-3.5 h-3.5 text-gray-400" />
                          <span>{imp.date}</span>
                        </div>
                        <span className="font-bold text-gray-800 block line-clamp-1">{imp.supplierName}</span>
                      </div>
                    </td>
                    <td className="p-4 max-w-xs">
                      <div className="space-y-1">
                        <span className="font-semibold text-gray-900 block leading-tight line-clamp-2">{imp.productTitle}</span>
                        <span className="text-[11px] font-mono bg-gray-100 px-1.5 py-0.2 rounded text-gray-500 font-bold">
                          {imp.productSku}
                        </span>
                      </div>
                    </td>
                    <td className="p-4 text-center font-bold text-gray-800">{imp.quantity}</td>
                    <td className="p-4 text-right font-mono text-gray-400 text-xs">
                      {imp.oldImportPrice > 0 ? `${imp.oldImportPrice.toLocaleString('vi-VN')} đ` : 'N/A'}
                    </td>
                    <td className="p-4 text-right font-mono font-semibold text-gray-900">
                      {imp.newImportPrice.toLocaleString('vi-VN')} đ
                    </td>
                    <td className="p-4 text-right font-mono text-amber-700 text-xs">
                      {(imp.importCost ?? 0) > 0 ? `${(imp.importCost ?? 0).toLocaleString('vi-VN')} đ` : '—'}
                    </td>
                    <td className="p-4 text-center">
                      <PriceChangeBadge oldPrice={imp.oldImportPrice} newPrice={imp.newImportPrice} />
                    </td>
                    <td className="p-4 text-right">
                      <div className="font-mono font-bold text-slate-800">{imp.totalAmount.toLocaleString('vi-VN')} đ</div>
                      <div className="text-xs text-gray-400">Đã trả: {imp.paidAmount.toLocaleString('vi-VN')} đ</div>
                    </td>
                    <td className="p-4 text-center">
                      <button
                        onClick={() => onEditProductShortcut(imp.productId)}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-semibold bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg border border-blue-100"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Sửa SP
                      </button>
                    </td>
                    <td className="p-4 text-center">
                      <button
                        type="button"
                        onClick={() => openImportHistory(imp.productId, imp.productTitle, imp.productSku)}
                        className="inline-flex items-center gap-1 text-xs text-indigo-600 font-semibold bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-100"
                      >
                        <History className="w-3.5 h-3.5" /> Lịch sử
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="max-md:block md:hidden space-y-3">
        {filteredImports.length === 0 ? (
          <div className="bg-white rounded-2xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
            Không tìm thấy bản ghi nhập kho nào phù hợp.
          </div>
        ) : (
          filteredImports.map((imp) => (
            <div key={imp.id} className="bg-white rounded-2xl border border-gray-100 p-4 shadow-xs space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 line-clamp-2">{imp.productTitle}</p>
                  <p className="text-[11px] font-mono text-gray-500 mt-1">{imp.productSku}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-400">{imp.date}</p>
                  <p className="text-sm font-bold text-gray-800 mt-1">{imp.supplierName}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="bg-gray-50 rounded-xl p-3">
                  <span className="text-gray-400 block text-[10px] uppercase font-bold">Số lượng</span>
                  <span className="font-bold text-gray-900 text-base">{imp.quantity}</span>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <span className="text-gray-400 block text-[10px] uppercase font-bold">Thành tiền</span>
                  <span className="font-mono font-bold">{imp.totalAmount.toLocaleString('vi-VN')} đ</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {historyModalEl}
    </div>
  );
}
