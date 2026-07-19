import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ImportTransaction, Supplier, Product } from '../types';
import {
  calcImportPriceChangePercent,
  getImportPriceChangeStatus,
} from '../utils/importPriceChange';
import ImportProductSearchSelect from './ImportProductSearchSelect';
import ImportSupplierSelect from './ImportSupplierSelect';
import {
  Plus,
  Search,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  Calendar,
  Box,
  DollarSign,
  ExternalLink,
  AlertTriangle,
  FileSpreadsheet,
  ArrowLeft,
  History,
  Truck,
  Package,
  CheckCircle2,
  X,
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

interface ProductImportContext {
  oldPrice: number;
  lastSupplierName: string | null;
  lastSupplierId: string | null;
  lastImportDate: string | null;
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
  const [selectedProductId, setSelectedProductId] = useState('');
  const [selectedProductSnap, setSelectedProductSnap] = useState<Product | null>(null);
  const [quantity, setQuantity] = useState<number>(10);
  const [newPrice, setNewPrice] = useState<number>(0);
  const [importCost, setImportCost] = useState<number>(0);
  const [paidAmount, setPaidAmount] = useState<number>(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [productContext, setProductContext] = useState<ProductImportContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [historyModal, setHistoryModal] = useState<{
    productId: string;
    productTitle: string;
    productSku: string;
    rows: ImportTransaction[];
    loading: boolean;
  } | null>(null);

  const activeProduct =
    selectedProductSnap && selectedProductSnap.id === selectedProductId
      ? selectedProductSnap
      : products.find((p) => p.id === selectedProductId);
  const oldPrice = productContext?.oldPrice ?? (activeProduct ? activeProduct.importPrice : 0);
  const lineSubtotal = quantity * newPrice;
  const totalCost = lineSubtotal + importCost;

  const filteredImports = imports.filter((imp) => {
    const matchesSearch =
      imp.productTitle.toLowerCase().includes(search.toLowerCase()) ||
      imp.productSku.toLowerCase().includes(search.toLowerCase()) ||
      imp.supplierName.toLowerCase().includes(search.toLowerCase());
    const matchesSupplier = selectedSupplierFilter === 'all' || imp.supplierId === selectedSupplierFilter;
    return matchesSearch && matchesSupplier;
  });

  const productHistory = useMemo(() => {
    if (!selectedProductId) return [];
    return imports
      .filter((imp) => imp.productId === selectedProductId)
      .sort((a, b) => {
        const tb = new Date(b.date || 0).getTime();
        const ta = new Date(a.date || 0).getTime();
        if (tb !== ta) return tb - ta;
        return String(b.id).localeCompare(String(a.id));
      })
      .slice(0, 5);
  }, [imports, selectedProductId]);

  const syncPaidToTotal = (total: number) => {
    setPaidAmount(total);
  };

  const fetchProductContext = useCallback(async (productId: string) => {
    const token = localStorage.getItem('admin_token');
    if (!token || !productId) {
      setProductContext(null);
      return;
    }
    setContextLoading(true);
    try {
      const res = await fetch(`/api/imports/product-context/${productId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProductContext({
          oldPrice: data.oldPrice ?? 0,
          lastSupplierName: data.lastSupplierName ?? null,
          lastSupplierId: data.lastSupplierId ?? null,
          lastImportDate: data.lastImportDate ?? null,
        });
      } else {
        setProductContext(null);
      }
    } catch (err) {
      console.error('Fetch product import context error:', err);
      setProductContext(null);
    } finally {
      setContextLoading(false);
    }
  }, []);

  useEffect(() => {
    if (viewMode === 'create' && selectedProductId) {
      fetchProductContext(selectedProductId);
    }
  }, [viewMode, selectedProductId, fetchProductContext]);

  const handleProductChange = (productId: string, product?: Product) => {
    setSelectedProductId(productId);
    const prod = product || products.find((p) => p.id === productId) || null;
    if (prod) {
      setSelectedProductSnap(prod);
      const price = Number(prod.importPrice) || 0;
      setNewPrice(price);
      syncPaidToTotal(price * quantity + importCost);
    } else {
      setSelectedProductSnap(null);
    }
    fetchProductContext(productId);
  };

  const handleQuantityChange = (qty: number) => {
    setQuantity(qty);
    syncPaidToTotal(newPrice * qty + importCost);
  };

  const handlePriceChange = (price: number) => {
    setNewPrice(price);
    syncPaidToTotal(price * quantity + importCost);
  };

  const handleImportCostChange = (cost: number) => {
    setImportCost(cost);
    syncPaidToTotal(newPrice * quantity + cost);
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
    const productId =
      prefillProductId && products.some((p) => p.id === prefillProductId)
        ? prefillProductId
        : products[0]?.id;
    if (productId) handleProductChange(productId);
    setViewMode('create');
  };

  const handleOpenCreate = async () => {
    if (products.length === 0) {
      alert('Vui lòng thêm sản phẩm vào hệ thống trước khi tạo đơn nhập sỉ!');
      return;
    }
    await bootstrapCreateForm();
  };

  useEffect(() => {
    if (!initialProductId) {
      prefillHandledRef.current = null;
      return;
    }
    if (products.length === 0 || prefillHandledRef.current === initialProductId) return;
    if (!products.some((p) => p.id === initialProductId)) {
      onInitialProductConsumed?.();
      return;
    }
    prefillHandledRef.current = initialProductId;
    void bootstrapCreateForm(initialProductId).finally(() => {
      onInitialProductConsumed?.();
    });
  }, [initialProductId, products]);

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

  const handleSubmitImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplierId || !selectedProductId || quantity <= 0 || newPrice <= 0) {
      alert('Vui lòng điền đầy đủ các trường thông tin hợp lệ!');
      return;
    }

    const supplier = suppliers.find((s) => s.id === selectedSupplierId)!;
    const product = activeProduct;
    if (!product) {
      alert('Vui lòng chọn sản phẩm hợp lệ từ kho!');
      return;
    }

    const finalPaid = Number(paidAmount);
    if (finalPaid > totalCost) {
      alert('Số tiền thực trả không được vượt quá tổng giá trị đơn nhập hàng!');
      return;
    }

    let status: 'fully_paid' | 'partial' | 'unpaid' = 'unpaid';
    if (finalPaid === totalCost) {
      status = 'fully_paid';
    } else if (finalPaid > 0) {
      status = 'partial';
    }

    const newTransaction: ImportTransaction = {
      id: `imp-${Date.now()}`,
      supplierId: selectedSupplierId,
      supplierName: supplier.name,
      date: new Date().toISOString().split('T')[0],
      productId: selectedProductId,
      productTitle: product.title,
      productSku: product.sku,
      quantity,
      oldImportPrice: oldPrice,
      newImportPrice: newPrice,
      importCost,
      totalAmount: totalCost,
      paidAmount: finalPaid,
      status,
      warehouseId: 'default',
    };

    await onAddImport(newTransaction);
    setViewMode('list');
    alert(`Đã lưu đơn nhập kho thành công cho sản phẩm: ${product.title}. Kho đã tự động tăng thêm +${quantity} sản phẩm.`);
  };

  if (viewMode === 'create') {
    return (
      <div className="space-y-0 -mx-4 sm:-mx-6 lg:-mx-8">
        {toastMessage && (
          <div className="fixed top-5 right-5 z-70 bg-emerald-600 text-white font-semibold text-sm px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{toastMessage}</span>
            <button type="button" onClick={() => setToastMessage(null)} className="ml-1 text-emerald-200 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        <div className="bg-white border-y border-gray-100 shadow-sm">
          <div className="px-6 lg:px-10 py-5 border-b border-gray-100 bg-linear-to-r from-indigo-50/80 via-white to-white flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-start gap-4">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                className="mt-0.5 p-2 hover:bg-white rounded-xl border border-gray-200 text-gray-500 hover:text-gray-800 transition-all shrink-0"
              >
                <ArrowLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="text-xl font-extrabold text-gray-900 flex items-center gap-2">
                  <Box className="w-6 h-6 text-indigo-600" />
                  Tạo Đơn Nhập Hàng
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Lập chứng từ nhập sỉ — tồn kho, công nợ và chi phí vận hành được cập nhật tự động.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400 font-medium">
              <Calendar className="w-4 h-4" />
              {new Date().toLocaleDateString('vi-VN')}
            </div>
          </div>

          <form onSubmit={handleSubmitImport} className="px-6 lg:px-10 py-8">
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 xl:gap-10">
              {/* Khu vực 1: NCC + Sản phẩm */}
              <div className="xl:col-span-4 space-y-6">
                <div className="rounded-2xl border border-gray-100 bg-gray-50/40 p-5 space-y-5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center gap-2">
                    <Package className="w-4 h-4" /> Nguồn hàng
                  </h3>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700">Nhà cung cấp</label>
                    <ImportSupplierSelect
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

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700">Tìm / chọn sản phẩm</label>
                    <ImportProductSearchSelect
                      products={selectedProductSnap ? [selectedProductSnap, ...products] : products}
                      value={selectedProductId}
                      onChange={handleProductChange}
                    />
                  </div>
                </div>

                {activeProduct && (
                  <div className="rounded-2xl border border-gray-100 p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center gap-2">
                      <History className="w-4 h-4" /> Lịch sử nhập gần đây
                    </h3>
                    {productHistory.length === 0 ? (
                      <p className="text-xs text-gray-400 italic">Chưa có lần nhập nào cho SKU này.</p>
                    ) : (
                      <ul className="space-y-2 max-h-48 overflow-y-auto">
                        {productHistory.map((imp) => (
                          <li
                            key={imp.id}
                            className="flex items-center justify-between gap-2 text-xs p-2.5 rounded-xl bg-gray-50 border border-gray-100"
                          >
                            <div className="min-w-0">
                              <span className="font-semibold text-gray-700 block truncate">{imp.supplierName}</span>
                              <span className="text-gray-400">{imp.date} · SL {imp.quantity}</span>
                            </div>
                            <span className="font-mono font-bold text-gray-800 shrink-0">
                              {imp.newImportPrice.toLocaleString('vi-VN')} đ
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {activeProduct && (
                      <button
                        type="button"
                        onClick={() =>
                          openImportHistory(activeProduct.id, activeProduct.title, activeProduct.sku)
                        }
                        className="w-full mt-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 py-2 rounded-lg border border-indigo-100 bg-indigo-50/50"
                      >
                        Xem đầy đủ lịch sử & so sánh giá
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Khu vực 2: Thông tin kho + nhập liệu */}
              <div className="xl:col-span-4 space-y-6">
                {activeProduct && (
                  <div className="rounded-2xl border border-indigo-100 bg-indigo-50/30 p-5">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-400 mb-4">
                      Thông tin kho hiện tại
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-gray-400 block">Tồn kho</span>
                        <span className="text-lg font-extrabold text-gray-900">{activeProduct.stock} cái</span>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] uppercase font-bold text-gray-400 block">Biến động giá</span>
                        <div className="mt-1 flex justify-end">
                          <PriceChangeBadge oldPrice={oldPrice} newPrice={newPrice} size="md" />
                        </div>
                      </div>
                    </div>
                    <div className="mt-4 pt-4 border-t border-indigo-100/80 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Giá nhập cũ ghi nhận</span>
                        <span className="font-mono font-bold text-gray-800">
                          {oldPrice > 0 ? `${oldPrice.toLocaleString('vi-VN')} đ` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">Nhà cung cấp gần nhất</span>
                        <span className="font-semibold text-gray-800 text-right max-w-[60%] truncate">
                          {contextLoading
                            ? 'Đang tải...'
                            : productContext?.lastSupplierName || 'Chưa có'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="rounded-2xl border border-gray-100 bg-white p-5 space-y-5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 flex items-center gap-2">
                    <DollarSign className="w-4 h-4" /> Chi tiết nhập kho
                  </h3>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-gray-700">Số lượng nhập</label>
                      <input
                        type="number"
                        min="1"
                        required
                        value={quantity}
                        onChange={(e) => handleQuantityChange(Math.max(1, Number(e.target.value)))}
                        className="w-full px-4 py-3 min-h-11 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none font-mono font-bold focus:border-indigo-400 transition-all"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-gray-700">Giá nhập sỉ mới (đ/cái)</label>
                      <input
                        type="number"
                        min="100"
                        required
                        value={newPrice}
                        onChange={(e) => handlePriceChange(Math.max(0, Number(e.target.value)))}
                        className="w-full px-4 py-3 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none font-mono font-bold text-indigo-700 focus:border-indigo-400 transition-all"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                      <Truck className="w-3.5 h-3.5 text-gray-400" />
                      Chi phí nhập hàng (Vận chuyển, bốc xếp...)
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={importCost}
                      onChange={(e) => handleImportCostChange(Math.max(0, Number(e.target.value)))}
                      placeholder="0"
                      className="w-full px-4 py-3 bg-amber-50/50 rounded-xl border border-amber-100 text-sm outline-none font-mono font-bold text-amber-800 focus:border-amber-300 transition-all"
                    />
                  </div>

                  <div className="text-xs text-gray-400 bg-gray-50 rounded-xl px-4 py-3 border border-gray-100 font-mono">
                    Thành tiền hàng: {lineSubtotal.toLocaleString('vi-VN')} đ
                    {importCost > 0 && (
                      <span> + Chi phí: {importCost.toLocaleString('vi-VN')} đ</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Khu vực 3: Tổng tiền + thanh toán */}
              <div className="xl:col-span-4">
                <div className="rounded-2xl border border-indigo-200 bg-linear-to-b from-indigo-50/60 to-white p-6 h-full flex flex-col">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-500 mb-5">
                    Tổng kết & thanh toán
                  </h3>

                  <div className="flex-1 space-y-5">
                    <div className="p-5 bg-white rounded-2xl border border-indigo-100 shadow-xs">
                      <span className="text-xs font-medium text-indigo-700 block mb-1">TỔNG GIÁ TRỊ ĐƠN HÀNG</span>
                      <span className="text-3xl font-extrabold text-indigo-900 font-mono tracking-tight">
                        {totalCost.toLocaleString('vi-VN')} đ
                      </span>
                      <p className="text-[11px] text-gray-400 mt-2">
                        = ({quantity} × {newPrice.toLocaleString('vi-VN')}) + {importCost.toLocaleString('vi-VN')}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label className="text-xs font-bold text-gray-600">Số tiền thực tế đã trả</label>
                      <input
                        type="number"
                        min="0"
                        max={totalCost}
                        value={paidAmount}
                        onChange={(e) => setPaidAmount(Math.min(totalCost, Math.max(0, Number(e.target.value))))}
                        className="w-full px-4 py-3 bg-white rounded-xl border border-indigo-200 text-base font-mono font-bold text-indigo-600 text-right outline-none focus:border-indigo-400"
                      />
                      <div className="flex justify-between text-xs">
                        <span className="text-gray-400">Còn nợ nhà sỉ</span>
                        <span className="font-mono font-bold text-rose-600">
                          {(totalCost - paidAmount).toLocaleString('vi-VN')} đ
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 mt-6 pt-5 border-t border-indigo-100">
                    <button
                      type="button"
                      onClick={() => setViewMode('list')}
                      className="flex-1 px-5 py-3 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-all"
                    >
                      Hủy bỏ
                    </button>
                    <button
                      type="submit"
                      className="flex-1 px-5 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm rounded-xl transition-all shadow-sm"
                    >
                      Xác nhận nhập kho
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>

      {historyModal && (
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
      )}
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
                      {imp.status === 'fully_paid' && (
                        <span className="inline-block text-[9px] bg-emerald-50 text-emerald-600 font-bold px-1 rounded-full border border-emerald-100 mt-1">
                          Đã trả hết
                        </span>
                      )}
                      {imp.status === 'partial' && (
                        <span className="inline-block text-[9px] bg-amber-50 text-amber-600 font-bold px-1 rounded-full border border-amber-100 mt-1">
                          Trả một phần
                        </span>
                      )}
                      {imp.status === 'unpaid' && (
                        <span className="inline-block text-[9px] bg-rose-50 text-rose-600 font-bold px-1 rounded-full border border-rose-100 mt-1">
                          Nợ 100%
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      <button
                        onClick={() => onEditProductShortcut(imp.productId)}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline font-semibold bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg border border-blue-100 transition-all cursor-pointer"
                      >
                        <ExternalLink className="w-3.5 h-3.5" /> Sửa SP
                      </button>
                    </td>
                    <td className="p-4 text-center">
                      <button
                        type="button"
                        onClick={() => openImportHistory(imp.productId, imp.productTitle, imp.productSku)}
                        className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-semibold bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-100 transition-all cursor-pointer"
                        title="Xem lịch sử nhập & so sánh giá"
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
            <div
              key={imp.id}
              className="bg-white rounded-2xl border border-gray-100 p-4 shadow-xs space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-900 line-clamp-2 leading-snug">{imp.productTitle}</p>
                  <p className="text-[11px] font-mono text-gray-500 mt-1">{imp.productSku}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs text-gray-400 flex items-center gap-1 justify-end">
                    <Calendar className="w-3.5 h-3.5" />
                    {imp.date}
                  </p>
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
                  <span className="font-mono font-bold text-slate-800">{imp.totalAmount.toLocaleString('vi-VN')} đ</span>
                </div>
                <div className="bg-gray-50 rounded-xl p-3">
                  <span className="text-gray-400 block text-[10px] uppercase font-bold">Giá nhập mới</span>
                  <span className="font-mono font-semibold">{imp.newImportPrice.toLocaleString('vi-VN')} đ</span>
                </div>
                <div className="bg-gray-50 rounded-xl p-3 flex flex-col justify-center">
                  <span className="text-gray-400 block text-[10px] uppercase font-bold mb-1">% Thay đổi</span>
                  <PriceChangeBadge oldPrice={imp.oldImportPrice} newPrice={imp.newImportPrice} />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1 border-t border-gray-50">
                <span className="text-xs text-gray-500">
                  Đã trả: <strong className="text-gray-800">{imp.paidAmount.toLocaleString('vi-VN')} đ</strong>
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openImportHistory(imp.productId, imp.productTitle, imp.productSku)}
                    className="min-h-11 px-3 inline-flex items-center gap-1.5 text-xs text-indigo-600 font-semibold bg-indigo-50 hover:bg-indigo-100 rounded-xl border border-indigo-100 transition-all"
                  >
                    <History className="w-4 h-4" /> Lịch sử
                  </button>
                  <button
                    type="button"
                    onClick={() => onEditProductShortcut(imp.productId)}
                    className="min-h-11 px-4 inline-flex items-center gap-1.5 text-xs text-blue-600 font-semibold bg-blue-50 hover:bg-blue-100 rounded-xl border border-blue-100 transition-all"
                  >
                    <ExternalLink className="w-4 h-4" /> Sửa SP
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {historyModal && (
        <div className="fixed inset-0 z-80 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <button
            type="button"
            className="absolute inset-0 bg-slate-900/40"
            aria-label="Đóng"
            onClick={() => setHistoryModal(null)}
          />
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
              <button
                type="button"
                onClick={() => setHistoryModal(null)}
                className="p-2 rounded-lg hover:bg-gray-100 text-gray-400"
              >
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
                    <div
                      key={row.id}
                      className="rounded-xl border border-gray-100 bg-gray-50/60 p-3 space-y-2"
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-gray-800">{row.supplierName}</span>
                        <span className="text-gray-400 flex items-center gap-1">
                          <Calendar className="w-3 h-3" /> {row.date}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-[11px]">
                        <div>
                          <span className="text-gray-400 block">SL</span>
                          <span className="font-bold text-gray-900">{row.quantity}</span>
                        </div>
                        <div>
                          <span className="text-gray-400 block">Giá nhập</span>
                          <span className="font-mono font-bold text-gray-900">
                            {row.newImportPrice.toLocaleString('vi-VN')} đ
                          </span>
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
                      {row.warehouseId && (
                        <p className="text-[10px] text-gray-400">Kho: {row.warehouseId}</p>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
