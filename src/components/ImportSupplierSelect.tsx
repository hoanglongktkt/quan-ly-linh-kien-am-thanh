import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, Plus, Building2, X } from 'lucide-react';
import { Supplier } from '../types';

export interface ImportSupplierSelectHandle {
  focus: () => void;
}

interface ImportSupplierSelectProps {
  suppliers: Supplier[];
  value: string;
  onChange: (supplierId: string) => void;
  onSuppliersUpdated: (suppliers: Supplier[]) => void;
  onQuickAddSuccess?: () => void;
}

const ImportSupplierSelect = forwardRef<ImportSupplierSelectHandle, ImportSupplierSelectProps>(
  function ImportSupplierSelect(
    { suppliers, value, onChange, onSuppliersUpdated, onQuickAddSuccess },
    ref,
  ) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [supplierCode, setSupplierCode] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [quickAddError, setQuickAddError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      setOpen(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    },
  }));

  const selected = suppliers.find((s) => s.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.supplierCode.toLowerCase().includes(q)
    );
  }, [suppliers, query]);

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

  const selectSupplier = (s: Supplier) => {
    onChange(s.id);
    setOpen(false);
    setQuery('');
  };

  const openQuickAddModal = () => {
    setOpen(false);
    setSupplierCode('');
    setName('');
    setQuickAddError('');
    setShowQuickAdd(true);
  };

  const handleQuickAddSave = async () => {
    const code = supplierCode.trim().toUpperCase();
    const supplierName = name.trim();
    if (!code || !supplierName) {
      setQuickAddError('Vui lòng điền đầy đủ mã và tên nhà cung cấp.');
      return;
    }

    const token = localStorage.getItem('admin_token');
    if (!token) {
      setQuickAddError('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.');
      return;
    }

    setSaving(true);
    setQuickAddError('');
    try {
      const res = await fetch('/api/suppliers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          supplierCode: code,
          name: supplierName,
          status: 'active',
        }),
      });
      const data = await res.json();
      if (res.ok && data.supplier) {
        const updated = Array.isArray(data.suppliers) ? data.suppliers : [data.supplier, ...suppliers];
        onSuppliersUpdated(updated);
        onChange(data.supplier.id);
        setShowQuickAdd(false);
        onQuickAddSuccess?.();
      } else if (data.error === 'supplier_code_duplicate') {
        setQuickAddError('Mã nhà cung cấp đã tồn tại!');
      } else {
        setQuickAddError('Tạo nhà cung cấp thất bại. Vui lòng thử lại.');
      }
    } catch {
      setQuickAddError('Lỗi kết nối máy chủ.');
    } finally {
      setSaving(false);
    }
  };

  const handleQuickAddKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void handleQuickAddSave();
    }
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
      selectSupplier(filtered[highlightIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full px-4 py-3 bg-white hover:bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none text-left flex items-center gap-2 min-h-[48px] focus:border-indigo-400 transition-all"
        >
          {selected ? (
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
                <Building2 className="w-4 h-4 text-indigo-600" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="font-bold text-gray-900 text-sm line-clamp-1 block">{selected.name}</span>
                <span className="text-[10px] text-gray-400 font-mono">{selected.supplierCode}</span>
              </div>
            </div>
          ) : (
            <span className="text-gray-400 flex-1">Chọn nhà cung cấp...</span>
          )}
          <ChevronDown className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>

        {open && (
          <div className="absolute z-50 left-0 right-0 mt-1.5 bg-white rounded-xl border border-gray-200 shadow-xl shadow-gray-200/60 overflow-hidden">
            <div className="p-2 border-b border-gray-100">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  ref={searchInputRef}
                  type="text"
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="F4 — Tìm theo mã, tên nhà cung cấp..."
                  className="w-full pl-8 pr-3 py-2 text-xs bg-gray-50 rounded-lg border border-gray-100 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400/20"
                />
              </div>
            </div>

            <div ref={listRef} className="max-h-[280px] overflow-y-auto scrollbar-thin">
              {filtered.length === 0 ? (
                <div className="py-6 text-center text-xs text-gray-400">Không tìm thấy nhà cung cấp phù hợp.</div>
              ) : (
                filtered.map((s, idx) => {
                  const isActive = idx === highlightIndex;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onMouseEnter={() => setHighlightIndex(idx)}
                      onClick={() => selectSupplier(s)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-gray-50 transition-colors ${
                        isActive ? 'bg-indigo-50/80' : 'hover:bg-gray-50'
                      } ${value === s.id ? 'bg-indigo-50/40' : ''}`}
                    >
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
                        <Building2 className="w-4 h-4 text-indigo-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-bold text-gray-900 line-clamp-1">{s.name}</p>
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5">{s.supplierCode}</p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <button
              type="button"
              onClick={openQuickAddModal}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 text-sm font-bold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-t border-emerald-100 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Thêm nhà cung cấp mới
            </button>
          </div>
        )}
      </div>

      {showQuickAdd &&
        createPortal(
          <div
            className="fixed inset-0 bg-gray-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-60"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
                  <Plus className="w-5 h-5 text-emerald-600" />
                  Thêm nhanh Nhà Cung Cấp
                </h3>
                <button
                  type="button"
                  onClick={() => setShowQuickAdd(false)}
                  className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-all"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">
                    Mã nhà cung cấp (Viết tắt) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={supplierCode}
                    onChange={(e) => setSupplierCode(e.target.value.toUpperCase())}
                    onKeyDown={handleQuickAddKeyDown}
                    placeholder="VD: XUONG-A"
                    className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none font-mono uppercase focus:border-emerald-400 transition-all"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-gray-700">
                    Tên nhà cung cấp / Tên xưởng <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={handleQuickAddKeyDown}
                    placeholder="VD: Xưởng May Áo Thun ABC"
                    className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none focus:border-emerald-400 transition-all"
                  />
                </div>

                {quickAddError && (
                  <p className="text-xs text-rose-600 font-medium bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
                    {quickAddError}
                  </p>
                )}

                <div className="flex gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowQuickAdd(false)}
                    className="flex-1 px-4 py-2.5 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-all"
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleQuickAddSave()}
                    className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold text-sm rounded-xl transition-all shadow-sm"
                  >
                    {saving ? 'Đang lưu...' : 'Lưu & Chọn'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
});

export default ImportSupplierSelect;
