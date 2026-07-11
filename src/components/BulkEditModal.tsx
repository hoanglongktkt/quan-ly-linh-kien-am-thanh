import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Product, Supplier, BulkSaveProductUpdate } from '../types';
import { Search, X, RefreshCw, Package, SlidersHorizontal } from 'lucide-react';

export interface BulkEditRow {
  id: string;
  title: string;
  sku: string;
  barcode: string;
  imageUrl?: string;
  category: string;
  brand: string;
  supplierId: string;
  weight: number;
  weightUnit: 'g' | 'kg';
  sellingPrice: number;
  wholesalePrice: number;
  importPrice: number;
  stock: number;
  stockMin: number;
  stockMax: number;
}

interface BulkEditModalProps {
  products: Product[];
  selectedIds: string[];
  suppliers: Supplier[];
  onClose: () => void;
  onSave: (updates: BulkSaveProductUpdate[]) => Promise<boolean>;
}

type PriceAction = 'set' | 'percent_up' | 'percent_down' | 'fixed_up' | 'fixed_down';
type StockAction = 'set' | 'increase' | 'decrease';
type ThresholdFilter = 'all' | 'below_min' | 'above_max';

const SAPO = {
  blue: '#0078D4',
  blueHover: '#006CBE',
  bg: '#F4F6F8',
  border: '#E0E0E0',
  text: '#212121',
  muted: '#6B7280',
  headerBg: '#EEF0F3',
};

function productToRow(p: Product): BulkEditRow {
  return {
    id: p.id,
    title: p.title,
    sku: p.sku,
    barcode: p.barcode || p.sku,
    imageUrl: p.imageUrl,
    category: p.category,
    brand: p.brand || '',
    supplierId: p.supplierId || '',
    weight: p.weight ?? 0,
    weightUnit: 'g',
    sellingPrice: p.sellingPrice,
    wholesalePrice: p.wholesalePrice ?? p.sellingPrice,
    importPrice: p.importPrice,
    stock: p.stock,
    stockMin: p.stockMin ?? 10,
    stockMax: p.stockMax ?? 500,
  };
}

function applyPriceAction(price: number, importPrice: number, action: PriceAction, value: number): number {
  switch (action) {
    case 'set': return Math.max(0, Math.round(value));
    case 'percent_up': return Math.max(0, Math.round(price * (1 + value / 100)));
    case 'percent_down': return Math.max(0, Math.round(price * (1 - value / 100)));
    case 'fixed_up': return Math.max(0, Math.round(price + value));
    case 'fixed_down': return Math.max(importPrice, Math.round(price - value));
    default: return price;
  }
}

function applyStockAction(stock: number, action: StockAction, value: number): number {
  switch (action) {
    case 'set': return Math.max(0, Math.round(value));
    case 'increase': return Math.max(0, Math.round(stock + value));
    case 'decrease': return Math.max(0, Math.round(stock - value));
    default: return stock;
  }
}

function parseNumInput(raw: string): number {
  const n = Number(String(raw).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function SapoPriceInput({
  value,
  onChange,
  highlight,
}: {
  value: number;
  onChange: (v: number) => void;
  highlight?: boolean;
}) {
  const [text, setText] = useState(value.toLocaleString('vi-VN'));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setText(value.toLocaleString('vi-VN'));
  }, [value, focused]);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={focused ? text : value.toLocaleString('vi-VN')}
      onFocus={() => { setFocused(true); setText(String(value || '')); }}
      onBlur={() => {
        setFocused(false);
        onChange(Math.max(0, Math.round(parseNumInput(text))));
      }}
      onChange={e => {
        setText(e.target.value);
        onChange(Math.max(0, Math.round(parseNumInput(e.target.value))));
      }}
      className={`w-full min-w-[100px] px-2.5 py-[7px] text-[13px] text-right border rounded-[4px] bg-white outline-none transition-colors ${
        highlight ? 'font-semibold text-[#212121]' : 'text-[#424242]'
      } ${focused ? 'border-[#0078D4] ring-1 ring-[#0078D4]/25' : 'border-[#E0E0E0] hover:border-[#BDBDBD]'}`}
    />
  );
}

export default function BulkEditModal({ products, selectedIds, suppliers, onClose, onSave }: BulkEditModalProps) {
  const sourceProducts = useMemo(
    () => products.filter(p => selectedIds.includes(p.id)),
    [products, selectedIds]
  );

  const [rows, setRows] = useState<BulkEditRow[]>([]);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [brandFilter, setBrandFilter] = useState('all');
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [thresholdFilter, setThresholdFilter] = useState<ThresholdFilter>('all');
  const [activeRowId, setActiveRowId] = useState<string | null>(null);

  const [priceAction, setPriceAction] = useState<PriceAction>('set');
  const [priceValue, setPriceValue] = useState(0);
  const [stockAction, setStockAction] = useState<StockAction>('set');
  const [stockValue, setStockValue] = useState(0);

  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  useEffect(() => {
    const mapped = sourceProducts.map(productToRow);
    setRows(mapped);
    setActiveRowId(mapped[0]?.id ?? null);
  }, [sourceProducts]);

  const categories = useMemo(() => {
    const set = new Set(rows.map(r => r.category).filter(Boolean));
    return Array.from(set).sort();
  }, [rows]);

  const brands = useMemo(() => {
    const set = new Set(rows.map(r => r.brand).filter(Boolean));
    return Array.from(set).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (q && !r.title.toLowerCase().includes(q) && !r.sku.toLowerCase().includes(q) && !r.barcode.toLowerCase().includes(q)) {
        return false;
      }
      if (typeFilter !== 'all' && r.category !== typeFilter) return false;
      if (brandFilter !== 'all' && r.brand !== brandFilter) return false;
      if (supplierFilter !== 'all' && r.supplierId !== supplierFilter) return false;
      if (thresholdFilter === 'below_min' && r.stock >= r.stockMin) return false;
      if (thresholdFilter === 'above_max' && r.stock <= r.stockMax) return false;
      return true;
    });
  }, [rows, search, typeFilter, brandFilter, supplierFilter, thresholdFilter]);

  const filteredIds = useMemo(() => new Set(filteredRows.map(r => r.id)), [filteredRows]);

  const updateRow = (id: string, patch: Partial<BulkEditRow>) => {
    setRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  };

  const focusRow = (id: string) => {
    setActiveRowId(id);
    rowRefs.current[id]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const handleApplyPrice = () => {
    if (filteredRows.length === 0) {
      setToast('Không có sản phẩm nào khớp bộ lọc để áp dụng.');
      return;
    }
    setRows(prev => prev.map(r => {
      if (!filteredIds.has(r.id)) return r;
      return { ...r, sellingPrice: applyPriceAction(r.sellingPrice, r.importPrice, priceAction, priceValue) };
    }));
    setToast(`Đã áp dụng công thức giá cho ${filteredRows.length} sản phẩm.`);
    setTimeout(() => setToast(null), 2500);
  };

  const handleApplyStock = () => {
    if (filteredRows.length === 0) {
      setToast('Không có sản phẩm nào khớp bộ lọc để áp dụng.');
      return;
    }
    setRows(prev => prev.map(r => {
      if (!filteredIds.has(r.id)) return r;
      return { ...r, stock: applyStockAction(r.stock, stockAction, stockValue) };
    }));
    setToast(`Đã áp dụng công thức tồn kho cho ${filteredRows.length} sản phẩm.`);
    setTimeout(() => setToast(null), 2500);
  };

  const handleSaveAll = async () => {
    setSaving(true);
    const updates: BulkSaveProductUpdate[] = rows.map(r => ({
      id: r.id,
      stock: r.stock,
      sellingPrice: r.sellingPrice,
      wholesalePrice: r.wholesalePrice,
      importPrice: r.importPrice,
      weight: r.weight,
      brand: r.brand || undefined,
      supplierId: r.supplierId || undefined,
      barcode: r.barcode || undefined,
      stockMin: r.stockMin,
      stockMax: r.stockMax,
      status: r.stock <= 0 ? 'out_of_stock' : 'active',
    }));
    const ok = await onSave(updates);
    setSaving(false);
    if (ok) onClose();
    else setToast('Cập nhật thất bại. Vui lòng thử lại.');
  };

  const filterSelect = 'w-full px-2.5 py-[7px] text-[13px] border border-[#E0E0E0] rounded-[4px] bg-white text-[#424242] focus:border-[#0078D4] focus:ring-1 focus:ring-[#0078D4]/20 outline-none';
  const actionSelect = 'min-w-[168px] px-2.5 py-[7px] text-[13px] border border-[#E0E0E0] rounded-[4px] bg-white text-[#424242] focus:border-[#0078D4] outline-none';
  const actionInput = 'w-[120px] px-2.5 py-[7px] text-[13px] text-right font-mono border border-[#E0E0E0] rounded-[4px] bg-white focus:border-[#0078D4] outline-none';
  const numCellInput = 'w-full px-2.5 py-[7px] text-[13px] text-right border border-[#E0E0E0] rounded-[4px] bg-white focus:border-[#0078D4] focus:ring-1 focus:ring-[#0078D4]/20 outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-0 sm:p-3">
      <div
        className="bg-white w-full max-w-[1320px] h-full sm:h-[94vh] flex flex-col overflow-hidden sm:rounded-[6px] shadow-xl"
        style={{ border: `1px solid ${SAPO.border}` }}
      >
        {/* Header — Sapo page title */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0" style={{ borderColor: SAPO.border }}>
          <h2 className="text-[15px] font-semibold" style={{ color: SAPO.text }}>
            Sửa hàng loạt sản phẩm
            <span className="ml-2 text-[13px] font-normal text-[#6B7280]">({rows.length} sản phẩm)</span>
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#F4F6F8] text-[#9CA3AF] hover:text-[#6B7280] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0" style={{ background: SAPO.bg }}>
          {/* ── Sidebar Filter (Sapo variant panel style) ── */}
          <aside
            className="w-[248px] shrink-0 border-r bg-white max-md:hidden md:flex md:flex-col"
            style={{ borderColor: SAPO.border }}
          >
            <div className="px-3 py-2.5 border-b flex items-center justify-between" style={{ borderColor: SAPO.border }}>
              <span className="text-[13px] font-semibold text-[#212121] flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5 text-[#0078D4]" />
                Bộ lọc
              </span>
              <span className="text-[11px] text-[#9CA3AF]">{filteredRows.length}/{rows.length}</span>
            </div>

            <div className="p-3 space-y-3 overflow-y-auto flex-1">
              <div>
                <label className="text-[12px] text-[#6B7280] mb-1 block">Tìm kiếm</label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-[#9CA3AF] absolute left-2.5 top-[9px]" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Tên, SKU, Mã vạch"
                    className="w-full pl-8 pr-2 py-[7px] text-[13px] border border-[#E0E0E0] rounded-[4px] focus:border-[#0078D4] outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="text-[12px] text-[#6B7280] mb-1 block">Loại sản phẩm</label>
                <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className={filterSelect}>
                  <option value="all">Tất cả loại</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[12px] text-[#6B7280] mb-1 block">Thương hiệu</label>
                <select value={brandFilter} onChange={e => setBrandFilter(e.target.value)} className={filterSelect}>
                  <option value="all">Tất cả thương hiệu</option>
                  {brands.map(b => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[12px] text-[#6B7280] mb-1 block">Nhà cung cấp</label>
                <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)} className={filterSelect}>
                  <option value="all">Tất cả NCC</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              <div>
                <label className="text-[12px] text-[#6B7280] mb-1 block">Trạng thái tồn</label>
                <select
                  value={thresholdFilter}
                  onChange={e => setThresholdFilter(e.target.value as ThresholdFilter)}
                  className={filterSelect}
                >
                  <option value="all">Tất cả</option>
                  <option value="below_min">Dưới định mức</option>
                  <option value="above_max">Vượt định mức</option>
                </select>
              </div>

              {/* Mini product list — Sapo phiên bản sidebar */}
              <div className="pt-1">
                <p className="text-[12px] font-semibold text-[#212121] mb-2">Danh sách ({filteredRows.length})</p>
                <div className="space-y-0.5 max-h-[220px] overflow-y-auto -mx-1">
                  {filteredRows.map(row => {
                    const active = activeRowId === row.id;
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={() => focusRow(row.id)}
                        className={`w-full flex items-start gap-2 px-2 py-2 rounded-[4px] text-left transition-colors ${
                          active ? 'bg-[#0078D4] text-white' : 'hover:bg-[#F4F6F8] text-[#424242]'
                        }`}
                      >
                        {row.imageUrl ? (
                          <img
                            src={row.imageUrl}
                            alt=""
                            className="w-8 h-8 rounded-[3px] object-cover border shrink-0"
                            style={{ borderColor: active ? 'rgba(255,255,255,0.3)' : SAPO.border }}
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className={`w-8 h-8 rounded-[3px] flex items-center justify-center shrink-0 ${active ? 'bg-white/20' : 'bg-[#F4F6F8]'}`}>
                            <Package className={`w-3.5 h-3.5 ${active ? 'text-white' : 'text-[#BDBDBD]'}`} />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className={`text-[11px] font-medium truncate leading-tight ${active ? 'text-white' : 'text-[#212121]'}`}>
                            {row.title}
                          </p>
                          <p className={`text-[10px] mt-0.5 ${active ? 'text-blue-100' : 'text-[#9CA3AF]'}`}>
                            Tồn kho: {row.stock}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </aside>

          {/* ── Main content ── */}
          <div className="flex-1 flex flex-col min-w-0 p-3 sm:p-4 gap-3 overflow-hidden">
            {/* Mobile filters */}
            <div className="max-md:block md:hidden bg-white border rounded-[4px] p-3 space-y-2" style={{ borderColor: SAPO.border }}>
              <div className="relative">
                <Search className="w-4 h-4 text-[#9CA3AF] absolute left-3 top-2.5" />
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Tìm Tên, SKU, Mã vạch..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-[#E0E0E0] rounded-[4px] focus:border-[#0078D4] outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className={filterSelect}>
                  <option value="all">Loại: Tất cả</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={thresholdFilter} onChange={e => setThresholdFilter(e.target.value as ThresholdFilter)} className={filterSelect}>
                  <option value="all">Tồn: Tất cả</option>
                  <option value="below_min">Dưới định mức</option>
                  <option value="above_max">Vượt định mức</option>
                </select>
              </div>
            </div>

            {/* Bulk Actions Card — Sapo "Giá sản phẩm" section style */}
            <div className="bg-white border rounded-[4px] shrink-0" style={{ borderColor: SAPO.border }}>
              <div className="px-4 py-2.5 border-b flex items-center justify-between" style={{ borderColor: SAPO.border }}>
                <span className="text-[13px] font-semibold text-[#212121]">Thao tác hàng loạt</span>
                {toast && <span className="text-[12px] text-[#0078D4]">{toast}</span>}
              </div>
              <div className="px-4 py-3 space-y-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[13px] text-[#6B7280] w-[72px] shrink-0">Giá bán</span>
                  <select value={priceAction} onChange={e => setPriceAction(e.target.value as PriceAction)} className={actionSelect}>
                    <option value="set">Áp dụng giá mới</option>
                    <option value="percent_up">Tăng theo %</option>
                    <option value="percent_down">Giảm theo %</option>
                    <option value="fixed_up">Tăng theo số tiền</option>
                    <option value="fixed_down">Giảm theo số tiền</option>
                  </select>
                  <input
                    type="number"
                    value={priceValue}
                    onChange={e => setPriceValue(Math.max(0, Number(e.target.value)))}
                    className={actionInput}
                    placeholder="Giá trị"
                  />
                  <button
                    onClick={handleApplyPrice}
                    className="px-4 py-[7px] text-[13px] font-medium text-white rounded-[4px] transition-colors"
                    style={{ background: SAPO.blue }}
                    onMouseEnter={e => (e.currentTarget.style.background = SAPO.blueHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = SAPO.blue)}
                  >
                    Áp dụng
                  </button>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="text-[13px] text-[#6B7280] w-[72px] shrink-0">Tồn kho</span>
                  <select value={stockAction} onChange={e => setStockAction(e.target.value as StockAction)} className={actionSelect}>
                    <option value="set">Thay đổi thành</option>
                    <option value="increase">Tăng thêm</option>
                    <option value="decrease">Giảm đi</option>
                  </select>
                  <input
                    type="number"
                    value={stockValue}
                    onChange={e => setStockValue(Number(e.target.value))}
                    className={actionInput}
                    placeholder="Số lượng"
                  />
                  <button
                    onClick={handleApplyStock}
                    className="px-4 py-[7px] text-[13px] font-medium text-white rounded-[4px] transition-colors"
                    style={{ background: SAPO.blue }}
                    onMouseEnter={e => (e.currentTarget.style.background = SAPO.blueHover)}
                    onMouseLeave={e => (e.currentTarget.style.background = SAPO.blue)}
                  >
                    Áp dụng
                  </button>
                </div>
              </div>
            </div>

            {/* Product Table Card */}
            <div className="bg-white border rounded-[4px] flex-1 flex flex-col min-h-0 overflow-hidden" style={{ borderColor: SAPO.border }}>
              <div className="px-4 py-2.5 border-b shrink-0" style={{ borderColor: SAPO.border }}>
                <span className="text-[13px] font-semibold text-[#212121]">Giá sản phẩm & Tồn kho</span>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full border-collapse min-w-[960px]">
                  <thead className="sticky top-0 z-10" style={{ background: SAPO.headerBg }}>
                    <tr className="text-[12px] font-semibold text-[#6B7280]">
                      <th className="px-4 py-2.5 text-left border-b min-w-[200px]" style={{ borderColor: SAPO.border }}>Sản phẩm</th>
                      <th className="px-3 py-2.5 text-right border-b w-[110px]" style={{ borderColor: SAPO.border }}>Khối lượng</th>
                      <th className="px-3 py-2.5 text-right border-b w-[130px]" style={{ borderColor: SAPO.border }}>Giá bán lẻ</th>
                      <th className="px-3 py-2.5 text-right border-b w-[130px]" style={{ borderColor: SAPO.border }}>Giá bán buôn</th>
                      <th className="px-3 py-2.5 text-right border-b w-[130px]" style={{ borderColor: SAPO.border }}>Giá nhập</th>
                      <th className="px-3 py-2.5 text-right border-b w-[90px]" style={{ borderColor: SAPO.border }}>Tồn kho</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-4 py-20 text-center text-[13px] text-[#9CA3AF]">
                          Không có sản phẩm khớp bộ lọc.
                        </td>
                      </tr>
                    ) : (
                      filteredRows.map(row => {
                        const isActive = activeRowId === row.id;
                        const lowStock = row.stock <= row.stockMin;
                        return (
                          <tr
                            key={row.id}
                            ref={el => { rowRefs.current[row.id] = el; }}
                            onClick={() => setActiveRowId(row.id)}
                            className={`border-b transition-colors cursor-pointer ${
                              isActive ? 'bg-[#E8F4FD]' : 'hover:bg-[#F8FAFC]'
                            }`}
                            style={{ borderColor: '#F0F0F0' }}
                          >
                            <td className="px-4 py-2">
                              <div className="flex items-center gap-2.5 min-w-0">
                                {row.imageUrl ? (
                                  <img
                                    src={row.imageUrl}
                                    alt=""
                                    className="w-9 h-9 rounded-[3px] object-cover border shrink-0"
                                    style={{ borderColor: SAPO.border }}
                                    referrerPolicy="no-referrer"
                                  />
                                ) : (
                                  <div className="w-9 h-9 rounded-[3px] bg-[#F4F6F8] flex items-center justify-center shrink-0">
                                    <Package className="w-4 h-4 text-[#BDBDBD]" />
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <p className="text-[13px] font-medium text-[#212121] truncate max-w-[180px]" title={row.title}>
                                    {row.title}
                                  </p>
                                  <p className="text-[11px] text-[#9CA3AF] font-mono">SKU: {row.sku}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              <div className="flex items-center gap-1">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={row.weight}
                                  onChange={e => updateRow(row.id, { weight: Math.max(0, Number(e.target.value)) })}
                                  className={`${numCellInput} flex-1 min-w-0`}
                                />
                                <select
                                  value={row.weightUnit}
                                  onChange={e => updateRow(row.id, { weightUnit: e.target.value as 'g' | 'kg' })}
                                  className="w-[42px] px-1 py-[7px] text-[11px] border border-[#E0E0E0] rounded-[4px] bg-white focus:border-[#0078D4] outline-none"
                                >
                                  <option value="g">g</option>
                                  <option value="kg">kg</option>
                                </select>
                              </div>
                            </td>
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              <SapoPriceInput
                                value={row.sellingPrice}
                                onChange={v => updateRow(row.id, { sellingPrice: v })}
                                highlight
                              />
                            </td>
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              <SapoPriceInput
                                value={row.wholesalePrice}
                                onChange={v => updateRow(row.id, { wholesalePrice: v })}
                              />
                            </td>
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              <SapoPriceInput
                                value={row.importPrice}
                                onChange={v => updateRow(row.id, { importPrice: v })}
                              />
                            </td>
                            <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                              <input
                                type="number"
                                value={row.stock}
                                onChange={e => updateRow(row.id, { stock: Math.max(0, Number(e.target.value)) })}
                                className={`${numCellInput} font-semibold ${lowStock ? 'text-[#D97706]' : 'text-[#212121]'}`}
                              />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* Footer — Sapo action bar */}
        <div
          className="flex items-center justify-end gap-2 px-5 py-3 border-t bg-white shrink-0"
          style={{ borderColor: SAPO.border }}
        >
          <button
            onClick={onClose}
            className="px-5 py-[7px] text-[13px] font-medium text-[#424242] bg-white border rounded-[4px] hover:bg-[#F9FAFB] transition-colors"
            style={{ borderColor: SAPO.border }}
          >
            Hủy bỏ
          </button>
          <button
            onClick={handleSaveAll}
            disabled={saving || rows.length === 0}
            className="px-5 py-[7px] text-[13px] font-medium text-white rounded-[4px] disabled:opacity-50 transition-colors flex items-center gap-2"
            style={{ background: saving ? '#9CA3AF' : SAPO.blue }}
          >
            {saving && <RefreshCw className="w-4 h-4 animate-spin" />}
            Cập nhật
          </button>
        </div>
      </div>
    </div>
  );
}
