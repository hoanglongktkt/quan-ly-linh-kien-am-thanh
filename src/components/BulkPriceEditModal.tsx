import React, { useMemo, useState } from 'react';
import { Product, getProductChildren } from '../types';
import { TrendingUp, X, Loader2 } from 'lucide-react';

export type BulkPriceAdjustmentMode =
  | 'percent_up'
  | 'percent_down'
  | 'fixed_up'
  | 'fixed_down';

export interface BulkPriceUpdateItem {
  id: string;
  new_price: number;
}

interface BulkPriceEditModalProps {
  products: Product[];
  selectedIds: string[];
  onClose: () => void;
  onApply: (updates: BulkPriceUpdateItem[]) => Promise<boolean>;
}

const MODE_LABELS: Record<BulkPriceAdjustmentMode, string> = {
  percent_up: 'Tăng theo %',
  percent_down: 'Giảm theo %',
  fixed_up: 'Tăng số tiền cố định (đ)',
  fixed_down: 'Giảm số tiền cố định (đ)',
};

function collectSelectedProducts(products: Product[], selectedIds: string[]): Product[] {
  const idSet = new Set(selectedIds);
  const result: Product[] = [];
  const visit = (p: Product) => {
    if (idSet.has(p.id)) result.push(p);
    getProductChildren(p).forEach(visit);
  };
  products.forEach(visit);
  return result;
}

/** Làm tròn lên hàng nghìn (VNĐ). */
function roundVndPrice(price: number): number {
  if (price <= 0) return 0;
  return Math.ceil(price / 1000) * 1000;
}

function applyPriceAdjustment(
  currentPrice: number,
  importPrice: number,
  mode: BulkPriceAdjustmentMode,
  value: number,
): number {
  let next = currentPrice;
  switch (mode) {
    case 'percent_up':
      next = currentPrice * (1 + value / 100);
      break;
    case 'percent_down':
      next = currentPrice * (1 - value / 100);
      break;
    case 'fixed_up':
      next = currentPrice + value;
      break;
    case 'fixed_down':
      next = Math.max(importPrice, currentPrice - value);
      break;
  }
  return roundVndPrice(Math.max(0, next));
}

export default function BulkPriceEditModal({
  products,
  selectedIds,
  onClose,
  onApply,
}: BulkPriceEditModalProps) {
  const selectedProducts = useMemo(
    () => collectSelectedProducts(products, selectedIds),
    [products, selectedIds],
  );

  const [mode, setMode] = useState<BulkPriceAdjustmentMode>('percent_up');
  const [value, setValue] = useState<number>(10);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPercent = mode === 'percent_up' || mode === 'percent_down';

  const handleConfirm = async () => {
    if (selectedProducts.length === 0) {
      setError('Không có sản phẩm được chọn.');
      return;
    }
    const numValue = Number(value);
    if (!Number.isFinite(numValue) || numValue <= 0) {
      setError('Giá trị thay đổi phải lớn hơn 0.');
      return;
    }
    if (isPercent && numValue > 100 && mode === 'percent_down') {
      setError('Giảm theo % không được vượt quá 100%.');
      return;
    }

    const updates: BulkPriceUpdateItem[] = selectedProducts.map((p) => ({
      id: p.id,
      new_price: applyPriceAdjustment(
        Number(p.sellingPrice) || 0,
        Number(p.importPrice) || 0,
        mode,
        numValue,
      ),
    }));

    setApplying(true);
    setError(null);
    try {
      const ok = await onApply(updates);
      if (!ok) {
        setError('Cập nhật giá hàng loạt thất bại. Vui lòng thử lại.');
        return;
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cập nhật giá hàng loạt thất bại.');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 backdrop-blur-xs p-4 animate-in fade-in">
      <div
        className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
        role="dialog"
        aria-labelledby="bulk-price-modal-title"
      >
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3">
          <div>
            <h3
              id="bulk-price-modal-title"
              className="text-base font-bold text-gray-900 flex items-center gap-2"
            >
              <TrendingUp className="w-5 h-5 text-emerald-600" />
              CHỈNH SỬA GIÁ HÀNG LOẠT
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              Áp dụng công thức cho các sản phẩm đã tích chọn.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Cách thức điều chỉnh
            </label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as BulkPriceAdjustmentMode)}
              disabled={applying}
              className="w-full px-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 disabled:opacity-60"
            >
              {(Object.keys(MODE_LABELS) as BulkPriceAdjustmentMode[]).map((key) => (
                <option key={key} value={key}>{MODE_LABELS[key]}</option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Giá trị thay đổi
            </label>
            <div className="relative">
              <input
                type="number"
                min={0}
                step={isPercent ? 1 : 1000}
                value={value}
                onChange={(e) => setValue(Number(e.target.value) || 0)}
                disabled={applying}
                className="w-full px-3 py-2.5 pr-10 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/20 disabled:opacity-60"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-400">
                {isPercent ? '%' : 'đ'}
              </span>
            </div>
          </div>

          <p className="text-xs text-gray-500 bg-indigo-50 border border-indigo-100 rounded-xl px-3 py-2.5">
            Áp dụng cho <strong className="text-indigo-700">{selectedIds.length}</strong> sản phẩm
            đang được tích chọn bên dưới.
          </p>
        </div>

        <div className="px-5 py-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-xl transition-colors disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={applying || selectedProducts.length === 0}
            className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {applying ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Đang áp dụng...
              </>
            ) : (
              'Xác nhận áp dụng'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
