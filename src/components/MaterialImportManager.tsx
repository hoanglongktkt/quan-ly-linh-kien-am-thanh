import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Material, MaterialImportTransaction, Supplier } from '../types';
import ImportSupplierSelect, { ImportSupplierSelectHandle } from './ImportSupplierSelect';
import CurrencyInput from './CurrencyInput';
import {
  Plus,
  Search,
  Calendar,
  Box,
  ArrowLeft,
  CheckCircle2,
  X,
  Trash2,
  Package,
  FileSpreadsheet,
  TrendingUp,
  Truck,
  AlertTriangle,
  ExternalLink,
  Link2,
  Layers,
} from 'lucide-react';

/** Detect URL trong ghi chú — hỗ trợ http(s) và domain phổ biến (1688, taobao…) */
function extractUrls(text: string): string[] {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const urlRe =
    /https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|(?:detail\.)?(?:1688|taobao|tmall|alibaba)\.com[^\s<>"']*/gi;
  const matches = raw.match(urlRe) || [];
  return [...new Set(matches.map((u) => u.trim()).filter(Boolean))];
}

function normalizeHref(url: string): string {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u.replace(/^\/+/, '')}`;
}

function isLikelyUrlOnly(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const urls = extractUrls(t);
  if (urls.length === 0) return false;
  // Toàn bộ ghi chú gần như chỉ là 1 URL
  const stripped = t.replace(urls[0], '').trim();
  return urls.length === 1 && stripped.length < 3;
}

/** Render ghi chú: nếu có URL → thẻ <a> / nút "Mở link" */
export function MaterialNoteDisplay({
  note,
  className = '',
}: {
  note: string;
  className?: string;
}) {
  const text = String(note || '').trim();
  if (!text) return <span className="text-gray-300">—</span>;

  const urls = extractUrls(text);
  if (urls.length === 0) {
    return <span className={`text-gray-600 whitespace-pre-wrap break-words ${className}`}>{text}</span>;
  }

  if (isLikelyUrlOnly(text)) {
    const href = normalizeHref(urls[0]);
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={`inline-flex items-center gap-1.5 text-sky-600 hover:text-sky-700 font-semibold text-xs ${className}`}
        title={href}
      >
        <Link2 className="w-3.5 h-3.5 shrink-0" />
        🔗 Mở link
        <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />
      </a>
    );
  }

  // Ghi chú lẫn text + URL: thay từng URL bằng thẻ <a>
  const parts: React.ReactNode[] = [];
  let rest = text;
  urls.forEach((url, i) => {
    const idx = rest.indexOf(url);
    if (idx < 0) return;
    if (idx > 0) {
      parts.push(<span key={`t-${i}`}>{rest.slice(0, idx)}</span>);
    }
    const href = normalizeHref(url);
    parts.push(
      <a
        key={`u-${i}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-sky-600 hover:underline font-semibold mx-0.5"
        title={href}
      >
        🔗 Mở link
        <ExternalLink className="w-3 h-3" />
      </a>,
    );
    rest = rest.slice(idx + url.length);
  });
  if (rest) parts.push(<span key="tail">{rest}</span>);

  return <span className={`text-gray-600 break-words ${className}`}>{parts}</span>;
}

interface MaterialLine {
  key: string;
  materialId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  notes: string;
  currentStock?: number;
}

interface MaterialImportManagerProps {
  suppliers: Supplier[];
  onRefreshSuppliers?: () => Promise<void> | void;
  onSuppliersUpdated?: (suppliers: Supplier[]) => void;
}

export default function MaterialImportManager({
  suppliers: suppliersProp,
  onRefreshSuppliers,
  onSuppliersUpdated,
}: MaterialImportManagerProps) {
  const [localSuppliers, setLocalSuppliers] = useState<Supplier[]>(suppliersProp);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [imports, setImports] = useState<MaterialImportTransaction[]>([]);
  const [viewMode, setViewMode] = useState<'list' | 'create'>('list');
  const [loading, setLoading] = useState(false);
  const supplierSelectRef = useRef<ImportSupplierSelectHandle>(null);

  const [search, setSearch] = useState('');
  const [selectedSupplierFilter, setSelectedSupplierFilter] = useState('all');

  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [selectedLines, setSelectedLines] = useState<MaterialLine[]>([]);
  const [importCost, setImportCost] = useState(0);
  const [paidAmount, setPaidAmount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Form thêm vật tư nhanh
  const [quickName, setQuickName] = useState('');
  const [quickQty, setQuickQty] = useState<number>(1);
  const [quickPrice, setQuickPrice] = useState<number>(0);
  const [quickNote, setQuickNote] = useState('');
  const quickNameRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((text: string, ok = true, durationMs = 3500) => {
    setToast({ text, ok });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, durationMs);
  }, []);

  const authHeaders = useCallback(() => {
    const token = localStorage.getItem('admin_token');
    return {
      Authorization: `Bearer ${token || ''}`,
      'Content-Type': 'application/json',
    };
  }, []);

  const fetchMaterials = useCallback(async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const res = await fetch('/api/materials', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setMaterials(Array.isArray(data) ? data : Array.isArray(data?.materials) ? data.materials : []);
      }
    } catch (err) {
      console.error('Fetch materials error:', err);
    }
  }, []);

  const fetchMaterialImports = useCallback(async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const res = await fetch('/api/material-imports', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setImports(Array.isArray(data) ? data : Array.isArray(data?.imports) ? data.imports : []);
      }
    } catch (err) {
      console.error('Fetch material imports error:', err);
    }
  }, []);

  const fetchSuppliersFromApi = useCallback(async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) return;
    try {
      const res = await fetch('/api/suppliers', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setLocalSuppliers(
          Array.isArray(data) ? data : Array.isArray(data?.suppliers) ? data.suppliers : [],
        );
      }
    } catch (err) {
      console.error('Fetch suppliers for material import error:', err);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchMaterials(), fetchMaterialImports(), fetchSuppliersFromApi()]).finally(() =>
      setLoading(false),
    );
  }, [fetchMaterials, fetchMaterialImports, fetchSuppliersFromApi]);

  useEffect(() => {
    setLocalSuppliers(suppliersProp);
  }, [suppliersProp]);

  const suppliers = Array.isArray(localSuppliers) ? localSuppliers : [];

  const importCapitalTotal = useMemo(
    () => imports.reduce((sum, item) => sum + (Number(item.totalAmount) || 0), 0),
    [imports],
  );
  const goodsTotal = useMemo(
    () => selectedLines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0),
    [selectedLines],
  );
  const totalCost = goodsTotal + importCost;

  const filteredImports = useMemo(() => {
    const q = search.toLowerCase();
    return imports.filter((imp) => {
      const matchesSearch =
        String(imp.materialName || '').toLowerCase().includes(q) ||
        String(imp.supplierName || '').toLowerCase().includes(q) ||
        String(imp.notes || '').toLowerCase().includes(q);
      const matchesSupplier =
        selectedSupplierFilter === 'all' || imp.supplierId === selectedSupplierFilter;
      return matchesSearch && matchesSupplier;
    });
  }, [imports, search, selectedSupplierFilter]);

  useEffect(() => {
    if (viewMode !== 'create') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault();
        supplierSelectRef.current?.focus();
      } else if (e.key === 'F3') {
        e.preventDefault();
        quickNameRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [viewMode]);

  const syncPaidToTotal = (total: number) => {
    setPaidAmount(total);
  };

  const addQuickMaterialLine = () => {
    const name = quickName.trim();
    const notes = quickNote.trim();
    if (!name) {
      showToast('Vui lòng nhập Tên vật tư.', false);
      quickNameRef.current?.focus();
      return;
    }
    if (!notes) {
      showToast('Ghi chú là bắt buộc (có thể dán link 1688/Taobao).', false);
      return;
    }
    if (quickQty <= 0 || quickPrice <= 0) {
      showToast('Số lượng và Đơn giá phải lớn hơn 0.', false);
      return;
    }

    // Khớp vật tư đã có theo tên (không đụng products)
    const existing = materials.find(
      (m) => String(m.name || '').trim().toLowerCase() === name.toLowerCase(),
    );

    const line: MaterialLine = {
      key: `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      materialId: existing?.id,
      name,
      quantity: Math.max(1, Math.round(quickQty)),
      unitPrice: Math.max(0, Math.round(quickPrice)),
      notes,
      currentStock: existing ? Number(existing.stock) || 0 : 0,
    };

    setSelectedLines((prev) => {
      const next = [line, ...prev];
      const goods = next.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      syncPaidToTotal(goods + importCost);
      return next;
    });

    setQuickName('');
    setQuickQty(1);
    setQuickPrice(0);
    setQuickNote('');
    showToast(`Đã thêm vật tư "${name}" vào phiếu.`);
    setTimeout(() => quickNameRef.current?.focus(), 50);
  };

  const updateLine = (
    key: string,
    patch: Partial<Pick<MaterialLine, 'quantity' | 'unitPrice' | 'notes' | 'name'>>,
  ) => {
    setSelectedLines((prev) => {
      const next = prev.map((line) => {
        if (line.key !== key) return line;
        return {
          ...line,
          ...patch,
          quantity:
            patch.quantity != null
              ? Math.max(0, Math.round(Number(patch.quantity) || 0))
              : line.quantity,
          unitPrice:
            patch.unitPrice != null
              ? Math.max(0, Math.round(Number(patch.unitPrice) || 0))
              : line.unitPrice,
          notes: patch.notes != null ? String(patch.notes) : line.notes,
          name: patch.name != null ? String(patch.name) : line.name,
        };
      });
      if (patch.quantity != null || patch.unitPrice != null) {
        const goods = next.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
        syncPaidToTotal(goods + importCost);
      }
      return next;
    });
  };

  const removeLine = (key: string) => {
    setSelectedLines((prev) => {
      const next = prev.filter((l) => l.key !== key);
      const goods = next.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
      syncPaidToTotal(goods + importCost);
      return next;
    });
  };

  const handleOpenCreate = async () => {
    await fetchSuppliersFromApi();
    onRefreshSuppliers?.();
    const list = suppliers.length > 0 ? suppliers : localSuppliers;
    setSelectedSupplierId(list[0]?.id || '');
    setImportCost(0);
    setPaidAmount(0);
    setSelectedLines([]);
    setQuickName('');
    setQuickQty(1);
    setQuickPrice(0);
    setQuickNote('');
    setViewMode('create');
    setTimeout(() => quickNameRef.current?.focus(), 100);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSupplierId) {
      alert('Vui lòng chọn nhà cung cấp!');
      supplierSelectRef.current?.focus();
      return;
    }
    if (selectedLines.length === 0) {
      alert('Vui lòng thêm ít nhất một vật tư!');
      quickNameRef.current?.focus();
      return;
    }
    if (selectedLines.some((l) => !l.name.trim() || l.quantity <= 0 || l.unitPrice <= 0)) {
      alert('Mỗi dòng cần Tên, Số lượng và Đơn giá hợp lệ!');
      return;
    }
    if (selectedLines.some((l) => !String(l.notes || '').trim())) {
      alert('Mỗi dòng vật tư BẮT BUỘC có Ghi chú (có thể dán link mua hàng)!');
      return;
    }

    const supplier = suppliers.find((s) => s.id === selectedSupplierId);
    if (!supplier) {
      alert('Nhà cung cấp không hợp lệ!');
      return;
    }

    const finalPaid = Number(paidAmount);
    if (finalPaid > totalCost) {
      alert('Số tiền thực trả không được vượt quá tổng giá trị đơn nhập vật tư!');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/material-imports', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          supplierId: selectedSupplierId,
          supplierName: supplier.name,
          importCost,
          paidAmount: finalPaid,
          date: new Date().toISOString().split('T')[0],
          lines: selectedLines.map((line) => ({
            materialId: line.materialId,
            materialName: line.name.trim(),
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            notes: line.notes.trim(),
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        throw new Error(data.error || 'Lưu phiếu nhập vật tư thất bại');
      }

      if (Array.isArray(data.allImports)) {
        setImports(data.allImports);
      } else if (Array.isArray(data.imports)) {
        setImports((prev) => [...data.imports, ...prev]);
      } else {
        await fetchMaterialImports();
      }

      if (Array.isArray(data.materials)) {
        setMaterials(data.materials);
      } else {
        await fetchMaterials();
      }

      // Cập nhật công nợ NCC phía client (giống nhập hàng) — không đụng products
      const orderValue = totalCost;
      const paid = finalPaid;
      setLocalSuppliers((prev) =>
        prev.map((s) => {
          if (s.id !== selectedSupplierId) return s;
          const totalOrderValue = (Number(s.totalOrderValue) || 0) + orderValue;
          const totalPaid = (Number(s.totalPaid) || 0) + paid;
          return {
            ...s,
            totalOrderValue,
            totalPaid,
            totalDebt: Math.max(0, totalOrderValue - totalPaid),
          };
        }),
      );

      setViewMode('list');
      showToast('Đã lưu phiếu nhập vật tư! (Không ảnh hưởng tồn kho sản phẩm bán)', true, 5000);
    } catch (err) {
      console.error(err);
      alert(`Có lỗi khi lưu: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const toastNode = toast && (
    <div
      className={`fixed bottom-5 right-5 z-70 text-white font-semibold text-sm px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 max-w-sm ${
        toast.ok ? 'bg-emerald-600' : 'bg-rose-600'
      }`}
    >
      {toast.ok ? (
        <CheckCircle2 className="w-4 h-4 shrink-0" />
      ) : (
        <AlertTriangle className="w-4 h-4 shrink-0" />
      )}
      <span>{toast.text}</span>
      <button
        type="button"
        onClick={() => setToast(null)}
        className={`ml-1 hover:text-white ${toast.ok ? 'text-emerald-200' : 'text-rose-200'}`}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  if (viewMode === 'create') {
    return (
      <div className="space-y-0 -mx-4 sm:-mx-6 lg:-mx-8">
        {toastNode}

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
                  <Layers className="w-6 h-6 text-teal-600" />
                  Tạo Đơn Nhập Vật Tư
                </h2>
                <p className="text-xs text-gray-400 mt-1">
                  Độc lập với kho sản phẩm bán · Phím tắt:{' '}
                  <kbd className="px-1.5 py-0.5 bg-gray-100 rounded border text-[10px] font-mono">F4</kbd> NCC ·{' '}
                  <kbd className="px-1.5 py-0.5 bg-gray-100 rounded border text-[10px] font-mono">F3</kbd> Thêm
                  vật tư
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-400 font-medium">
              <Calendar className="w-4 h-4" />
              {new Date().toLocaleDateString('vi-VN')}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="px-6 lg:px-10 py-6 space-y-6">
            {/* Block 1: NCC — tái sử dụng collection Suppliers */}
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
                    showToast('Đã thêm nhà cung cấp mới!');
                  }}
                />
              </div>
            </section>

            {/* Block 2: Thêm vật tư nhanh */}
            <section className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
                2. Thêm vật tư nhanh <span className="normal-case font-normal text-gray-300">(F3)</span>
              </label>
              <div className="rounded-xl border border-teal-100 bg-teal-50/40 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-4">
                    <label className="text-[10px] font-bold uppercase text-gray-400 block mb-1">
                      Tên vật tư *
                    </label>
                    <input
                      ref={quickNameRef}
                      type="text"
                      value={quickName}
                      onChange={(e) => setQuickName(e.target.value)}
                      placeholder="VD: Keo AB, Nhựa ABS, Ốc vít M3..."
                      list="material-name-suggestions"
                      className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm outline-none focus:border-teal-400 bg-white"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addQuickMaterialLine();
                        }
                      }}
                    />
                    <datalist id="material-name-suggestions">
                      {materials.slice(0, 50).map((m) => (
                        <option key={m.id} value={m.name} />
                      ))}
                    </datalist>
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-[10px] font-bold uppercase text-gray-400 block mb-1">
                      Số lượng *
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={quickQty}
                      onChange={(e) => setQuickQty(Math.max(0, Number(e.target.value) || 0))}
                      className="w-full h-10 px-3 text-center font-mono font-bold rounded-lg border border-gray-200 text-sm outline-none focus:border-teal-400 bg-white"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-[10px] font-bold uppercase text-gray-400 block mb-1">
                      Đơn giá *
                    </label>
                    <CurrencyInput
                      value={quickPrice}
                      onChange={setQuickPrice}
                      smartShorthand
                      className="w-full h-10 px-3 text-right font-mono font-bold text-teal-700 rounded-lg border border-gray-200 text-sm outline-none focus:border-teal-400 bg-white"
                    />
                  </div>
                  <div className="md:col-span-4">
                    <label className="text-[10px] font-bold uppercase text-gray-400 block mb-1">
                      Ghi chú * <span className="normal-case font-normal">(link 1688/Taobao…)</span>
                    </label>
                    <input
                      type="text"
                      value={quickNote}
                      onChange={(e) => setQuickNote(e.target.value)}
                      placeholder="Bắt buộc — dán link mua hoặc ghi chú nguồn"
                      className="w-full h-10 px-3 rounded-lg border border-gray-200 text-sm outline-none focus:border-teal-400 bg-white"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addQuickMaterialLine();
                        }
                      }}
                    />
                  </div>
                </div>
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={addQuickMaterialLine}
                    className="inline-flex items-center gap-2 px-4 py-2.5 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-xl"
                  >
                    <Plus className="w-4 h-4" /> Thêm vào phiếu
                  </button>
                </div>
              </div>
            </section>

            {/* Block 3: Bảng chi tiết */}
            <section className="space-y-2">
              <label className="text-xs font-bold uppercase tracking-wider text-gray-400">
                3. Chi tiết vật tư nhập ({selectedLines.length})
              </label>
              <div className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-[900px]">
                    <thead>
                      <tr className="bg-slate-50 border-b border-gray-200 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                        <th className="px-3 py-3 w-12 text-center">STT</th>
                        <th className="px-3 py-3">Tên vật tư</th>
                        <th className="px-3 py-3 w-20 text-center">Tồn VT</th>
                        <th className="px-3 py-3 w-28 text-center">SL nhập</th>
                        <th className="px-3 py-3 w-40 text-right">Đơn giá</th>
                        <th className="px-3 py-3 w-36 text-right">Thành tiền</th>
                        <th className="px-3 py-3 min-w-[200px]">Ghi chú / Link</th>
                        <th className="px-3 py-3 w-12 text-center" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 text-sm">
                      {selectedLines.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="px-4 py-14 text-center text-gray-400 text-sm">
                            <Package className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                            Chưa có vật tư — dùng form &quot;Thêm vật tư nhanh&quot; phía trên.
                          </td>
                        </tr>
                      ) : (
                        selectedLines.map((line, idx) => (
                          <tr key={line.key} className="hover:bg-slate-50/60">
                            <td className="px-3 py-2.5 text-center text-gray-400 font-mono text-xs">
                              {idx + 1}
                            </td>
                            <td className="px-3 py-2.5">
                              <input
                                type="text"
                                value={line.name}
                                onChange={(e) => updateLine(line.key, { name: e.target.value })}
                                className="w-full h-9 px-2 rounded-lg border border-gray-200 text-sm font-semibold outline-none focus:border-teal-400"
                              />
                            </td>
                            <td className="px-3 py-2.5 text-center font-mono text-xs text-gray-500">
                              {line.currentStock ?? 0}
                            </td>
                            <td className="px-3 py-2.5">
                              <input
                                type="number"
                                min={0}
                                value={line.quantity}
                                onChange={(e) =>
                                  updateLine(line.key, { quantity: Number(e.target.value) })
                                }
                                className="w-full h-10 px-2 text-center font-mono font-bold text-sm rounded-lg border border-gray-200 outline-none focus:border-teal-400"
                              />
                            </td>
                            <td className="px-3 py-2.5">
                              <CurrencyInput
                                value={line.unitPrice}
                                onChange={(v) => updateLine(line.key, { unitPrice: v })}
                                smartShorthand
                                className="w-full h-10 px-2 text-right font-mono font-bold text-sm text-teal-700 rounded-lg border border-gray-200 outline-none focus:border-teal-400"
                              />
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-gray-800">
                              {(line.quantity * line.unitPrice).toLocaleString('vi-VN')} đ
                            </td>
                            <td className="px-3 py-2.5">
                              <input
                                type="text"
                                value={line.notes}
                                onChange={(e) => updateLine(line.key, { notes: e.target.value })}
                                placeholder="Ghi chú / URL bắt buộc"
                                className="w-full h-9 px-2 rounded-lg border border-gray-200 text-xs outline-none focus:border-teal-400"
                              />
                              {extractUrls(line.notes).length > 0 && (
                                <div className="mt-1">
                                  <MaterialNoteDisplay note={line.notes} />
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <button
                                type="button"
                                onClick={() => removeLine(line.key)}
                                className="p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            {/* Block 4: Tổng tiền */}
            <section className="space-y-4 border-t border-gray-100 pt-6">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="space-y-3 lg:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-400 block mb-1">
                        Chi phí phụ (ship, thuế…)
                      </label>
                      <CurrencyInput
                        value={importCost}
                        onChange={(v) => {
                          setImportCost(v);
                          syncPaidToTotal(goodsTotal + v);
                        }}
                        className="w-44 h-10 px-3 rounded-lg border border-gray-200 font-mono font-bold text-sm text-right outline-none focus:border-teal-400"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] uppercase font-bold text-gray-400 block mb-1">
                        Số tiền đã trả
                      </label>
                      <CurrencyInput
                        value={paidAmount}
                        max={totalCost}
                        onChange={(v) => setPaidAmount(Math.min(totalCost, Math.max(0, v)))}
                        className="w-44 h-10 px-3 rounded-lg border border-gray-200 font-mono font-bold text-teal-600 text-sm text-right outline-none focus:border-teal-400"
                      />
                      <p className="text-[11px] text-gray-400 mt-1 text-right">
                        Còn nợ:{' '}
                        <span className="font-mono font-bold text-rose-600">
                          {(totalCost - paidAmount).toLocaleString('vi-VN')} đ
                        </span>
                      </p>
                    </div>
                  </div>
                </div>

                <div className="text-right flex flex-col justify-center">
                  <span className="text-[10px] uppercase font-bold text-gray-400 block">Tổng cộng</span>
                  <span className="text-3xl font-extrabold text-teal-900 font-mono tracking-tight">
                    {totalCost.toLocaleString('vi-VN')} đ
                  </span>
                  <p className="text-[11px] text-gray-400 font-mono mt-0.5">
                    VT: {goodsTotal.toLocaleString('vi-VN')}
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
                  disabled={submitting || selectedLines.length === 0 || !selectedSupplierId}
                  className="min-w-[200px] px-6 py-3 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-xl shadow-sm"
                >
                  {submitting ? 'Đang lưu...' : 'Xác nhận nhập vật tư'}
                </button>
              </div>
            </section>
          </form>
        </div>
      </div>
    );
  }

  // —— LIST VIEW ——
  return (
    <div className="space-y-6">
      {toastNode}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center font-bold">
            <FileSpreadsheet className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">
              Số lần nhập vật tư
            </span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{imports.length} đợt</h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center font-bold">
            <TrendingUp className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">
              Tổng vốn nhập vật tư
            </span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">
              {importCapitalTotal.toLocaleString('vi-VN')} đ
            </h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center font-bold">
            <Box className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">
              Danh mục vật tư
            </span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{materials.length} loại</h3>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex flex-1 items-center gap-2 max-w-xl">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm tên vật tư, NCC, ghi chú / link…"
                className="w-full h-10 pl-9 pr-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-teal-400"
              />
            </div>
            <select
              value={selectedSupplierFilter}
              onChange={(e) => setSelectedSupplierFilter(e.target.value)}
              className="h-10 px-3 rounded-xl border border-gray-200 text-sm bg-white outline-none focus:border-teal-400"
            >
              <option value="all">Tất cả NCC</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            onClick={() => void handleOpenCreate()}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-xl shrink-0"
          >
            <Plus className="w-4 h-4" /> Tạo đơn nhập vật tư
          </button>
        </div>

        {loading ? (
          <p className="text-center text-xs text-gray-400 py-12">Đang tải dữ liệu vật tư…</p>
        ) : filteredImports.length === 0 ? (
          <div className="px-4 py-16 text-center text-gray-400">
            <Truck className="w-10 h-10 mx-auto mb-3 text-gray-300" />
            <p className="text-sm font-medium">Chưa có phiếu nhập vật tư</p>
            <p className="text-xs mt-1">Tạo đơn đầu tiên để theo dõi vật tư sản xuất (chợ, 1688…).</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-slate-50 border-b border-gray-100 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Ngày</th>
                  <th className="px-4 py-3">Nhà cung cấp</th>
                  <th className="px-4 py-3">Vật tư</th>
                  <th className="px-4 py-3 text-center">SL</th>
                  <th className="px-4 py-3 text-right">Đơn giá</th>
                  <th className="px-4 py-3 text-right">Thành tiền</th>
                  <th className="px-4 py-3">Ghi chú / Link mua</th>
                  <th className="px-4 py-3 text-center">TT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 text-sm">
                {filteredImports.map((imp) => (
                  <tr key={imp.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{imp.date}</td>
                    <td className="px-4 py-3 font-semibold text-gray-800">{imp.supplierName}</td>
                    <td className="px-4 py-3 font-medium text-gray-900">{imp.materialName}</td>
                    <td className="px-4 py-3 text-center font-mono font-bold">{imp.quantity}</td>
                    <td className="px-4 py-3 text-right font-mono text-teal-700">
                      {(imp.newImportPrice ?? imp.unitPrice ?? 0).toLocaleString('vi-VN')} đ
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-bold">
                      {imp.totalAmount.toLocaleString('vi-VN')} đ
                    </td>
                    <td className="px-4 py-3 max-w-[280px]">
                      <MaterialNoteDisplay note={imp.notes} />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex px-2 py-0.5 rounded-lg text-[10px] font-bold uppercase ${
                          imp.status === 'fully_paid'
                            ? 'bg-emerald-50 text-emerald-600'
                            : imp.status === 'partial'
                              ? 'bg-amber-50 text-amber-600'
                              : 'bg-rose-50 text-rose-600'
                        }`}
                      >
                        {imp.status === 'fully_paid'
                          ? 'Đã trả'
                          : imp.status === 'partial'
                            ? 'Một phần'
                            : 'Chưa trả'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
