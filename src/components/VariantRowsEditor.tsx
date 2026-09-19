import React, { useMemo, useState } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import CurrencyInput from './CurrencyInput';

/** Số dòng phân loại tối đa — phải khớp MAX_VARIANT_ROWS ở controllers/productsController.js. */
export const MAX_VARIANT_ROWS = 50;

export interface VariantRow {
  /** Khóa React cục bộ, không gửi lên server. */
  key: string;
  name: string;
  sku: string;
  importPrice: number;
  sellingPrice: number;
  stock: number;
}

let variantKeySeq = 0;

export function createVariantRow(partial: Partial<VariantRow> = {}): VariantRow {
  variantKeySeq += 1;
  return {
    key: `v${Date.now()}-${variantKeySeq}`,
    name: '',
    sku: '',
    importPrice: 0,
    sellingPrice: 0,
    stock: 0,
    ...partial,
  };
}

/**
 * Kiểm tra hợp lệ trước khi submit.
 * @returns thông báo lỗi, hoặc null nếu hợp lệ.
 */
export function validateVariantRows(rows: VariantRow[], parentSku: string): string | null {
  if (rows.length === 0) return 'Vui lòng thêm ít nhất 1 phân loại.';
  if (rows.length > MAX_VARIANT_ROWS) {
    return `Tối đa ${MAX_VARIANT_ROWS} phân loại cho mỗi sản phẩm.`;
  }

  const parentKey = parentSku.trim().toLowerCase();
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const name = rows[i].name.trim();
    const sku = rows[i].sku.trim();
    if (!name || !sku) {
      return `Phân loại dòng ${i + 1}: thiếu Tên phân loại hoặc Mã SKU.`;
    }
    const key = sku.toLowerCase();
    if (key === parentKey) {
      return `Mã SKU "${sku}" trùng với SKU của sản phẩm cha.`;
    }
    if (seen.has(key)) {
      return `Mã SKU "${sku}" bị lặp giữa các phân loại — mỗi phân loại cần một SKU riêng.`;
    }
    seen.add(key);
  }
  return null;
}

/** Chuyển sang payload `children` mà POST /api/products nhận. */
export function toVariantPayload(rows: VariantRow[]) {
  return rows.map((r) => ({
    name: r.name.trim(),
    sku: r.sku.trim(),
    importPrice: Math.max(0, Math.round(Number(r.importPrice) || 0)),
    sellingPrice: Math.max(0, Math.round(Number(r.sellingPrice) || 0)),
    stock: Math.max(0, Math.round(Number(r.stock) || 0)),
  }));
}

interface VariantRowsEditorProps {
  rows: VariantRow[];
  onChange: (rows: VariantRow[]) => void;
  parentSku?: string;
  /** Bảng ngang cho desktop, thẻ dọc cho Mini POS trên mobile. */
  layout?: 'table' | 'card';
  disabled?: boolean;
}

const inputClass =
  'w-full px-2.5 py-2 bg-white rounded-lg border border-gray-200 text-sm outline-none focus:border-emerald-400 transition-all';
const inputErrorClass =
  'w-full px-2.5 py-2 bg-white rounded-lg border border-red-400 text-sm outline-none focus:border-red-500 transition-all';

export default function VariantRowsEditor({
  rows,
  onChange,
  parentSku = '',
  layout = 'table',
  disabled = false,
}: VariantRowsEditorProps) {
  const [bulkImportPrice, setBulkImportPrice] = useState(0);
  const [bulkSellingPrice, setBulkSellingPrice] = useState(0);
  const [bulkStock, setBulkStock] = useState('');
  const [bulkSku, setBulkSku] = useState('');

  const atLimit = rows.length >= MAX_VARIANT_ROWS;

  /** SKU bị lặp giữa các dòng hoặc đụng SKU cha — tô đỏ ngay để sửa trước khi lưu. */
  const conflictSkuKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = r.sku.trim().toLowerCase();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const conflicts = new Set<string>();
    for (const [key, count] of counts) {
      if (count > 1) conflicts.add(key);
    }
    const parentKey = parentSku.trim().toLowerCase();
    if (parentKey && counts.has(parentKey)) conflicts.add(parentKey);
    return conflicts;
  }, [rows, parentSku]);

  const isConflictSku = (sku: string) => {
    const key = sku.trim().toLowerCase();
    return Boolean(key) && conflictSkuKeys.has(key);
  };

  const updateRow = (key: string, patch: Partial<VariantRow>) => {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    if (atLimit) return;
    onChange([...rows, createVariantRow()]);
  };

  const removeRow = (key: string) => {
    onChange(rows.filter((r) => r.key !== key));
  };

  const applyToAllRows = () => {
    if (rows.length === 0) return;
    const patch: Partial<VariantRow> = {};
    if (bulkImportPrice > 0) patch.importPrice = bulkImportPrice;
    if (bulkSellingPrice > 0) patch.sellingPrice = bulkSellingPrice;
    if (bulkStock.trim() !== '') {
      patch.stock = Math.max(0, Math.round(Number(bulkStock) || 0));
    }
    const sku = bulkSku.trim();
    if (sku) patch.sku = sku;
    if (Object.keys(patch).length === 0) return;
    onChange(rows.map((r) => ({ ...r, ...patch })));
  };

  const bulkApplyBar = (
    <div className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2">
      <p className="text-xs font-bold text-gray-700">Danh sách phân loại hàng</p>
      <div className="flex flex-wrap items-center gap-2">
        <CurrencyInput
          value={bulkImportPrice}
          onChange={setBulkImportPrice}
          disabled={disabled}
          smartShorthand
          placeholder="Giá nhập"
          className={`${inputClass} font-mono flex-1 min-w-24`}
        />
        <CurrencyInput
          value={bulkSellingPrice}
          onChange={setBulkSellingPrice}
          disabled={disabled}
          smartShorthand
          placeholder="Giá bán"
          className={`${inputClass} font-mono flex-1 min-w-24`}
        />
        <input
          type="number"
          min={0}
          value={bulkStock}
          disabled={disabled}
          onChange={(e) => setBulkStock(e.target.value)}
          placeholder="Tồn kho"
          className={`${inputClass} font-mono flex-1 min-w-24`}
        />
        <input
          type="text"
          value={bulkSku}
          disabled={disabled}
          onChange={(e) => setBulkSku(e.target.value)}
          placeholder="SKU phân loại"
          className={`${inputClass} font-mono flex-1 min-w-24`}
        />
        <button
          type="button"
          onClick={applyToAllRows}
          disabled={disabled || rows.length === 0}
          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-white text-xs font-semibold rounded-lg whitespace-nowrap transition-all"
        >
          Áp dụng cho tất cả phân loại
        </button>
      </div>
      <p className="text-[11px] text-gray-400">
        Điền ô nào thì áp ô đó cho mọi dòng bên dưới. Bỏ trống để giữ nguyên.
      </p>
    </div>
  );

  const footer = (
    <div className="flex flex-wrap items-center gap-2 pt-2">
      <button
        type="button"
        onClick={addRow}
        disabled={disabled || atLimit}
        className="inline-flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold rounded-lg transition-all"
      >
        <Plus className="w-3.5 h-3.5" />
        Thêm phân loại mới
      </button>
      <span className="text-[11px] text-gray-400 ml-auto">
        {rows.length}/{MAX_VARIANT_ROWS} phân loại
      </span>
    </div>
  );

  const conflictWarning = conflictSkuKeys.size > 0 && (
    <p className="flex items-start gap-1.5 text-xs text-red-600 font-medium bg-red-50 border border-red-100 rounded-lg px-3 py-2">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
      <span>Có SKU bị trùng nhau (ô viền đỏ). Mỗi phân loại cần một SKU riêng để trừ đúng tồn kho.</span>
    </p>
  );

  if (layout === 'card') {
    return (
      <div className="space-y-2.5">
        {bulkApplyBar}
        {rows.map((row, idx) => (
          <div key={row.key} className="bg-gray-50 border border-gray-200 rounded-xl p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-gray-400 shrink-0">#{idx + 1}</span>
              <input
                type="text"
                value={row.name}
                disabled={disabled}
                onChange={(e) => updateRow(row.key, { name: e.target.value })}
                placeholder="Tên phân loại (VD: Đỏ / Size M)"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => removeRow(row.key)}
                disabled={disabled}
                className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg shrink-0 transition-all"
                title="Xóa phân loại"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={row.sku}
              disabled={disabled}
              onChange={(e) => updateRow(row.key, { sku: e.target.value })}
              placeholder="Mã SKU"
              className={`${isConflictSku(row.sku) ? inputErrorClass : inputClass} font-mono`}
            />
            <div className="grid grid-cols-3 gap-2">
              <CurrencyInput
                value={row.importPrice}
                onChange={(v) => updateRow(row.key, { importPrice: v })}
                disabled={disabled}
                smartShorthand
                placeholder="Giá nhập"
                className={`${inputClass} font-mono`}
              />
              <CurrencyInput
                value={row.sellingPrice}
                onChange={(v) => updateRow(row.key, { sellingPrice: v })}
                disabled={disabled}
                smartShorthand
                placeholder="Giá bán"
                className={`${inputClass} font-mono`}
              />
              <input
                type="number"
                min={0}
                value={row.stock}
                disabled={disabled}
                onChange={(e) => updateRow(row.key, { stock: Number(e.target.value) || 0 })}
                placeholder="Tồn"
                className={`${inputClass} font-mono`}
              />
            </div>
          </div>
        ))}
        {conflictWarning}
        {footer}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {bulkApplyBar}
      <div className="overflow-x-auto border border-gray-200 rounded-xl">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left text-[11px] font-semibold text-gray-500 uppercase">
              <th className="px-3 py-2 w-[26%]">Tên phân loại</th>
              <th className="px-3 py-2 w-[22%]">Mã SKU</th>
              <th className="px-3 py-2 w-[18%]">Giá nhập</th>
              <th className="px-3 py-2 w-[18%]">Giá bán</th>
              <th className="px-3 py-2 w-[12%]">Tồn kho</th>
              <th className="px-3 py-2 w-[4%]"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-gray-100">
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={row.name}
                    disabled={disabled}
                    onChange={(e) => updateRow(row.key, { name: e.target.value })}
                    placeholder="VD: Đỏ / Size M"
                    className={inputClass}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="text"
                    value={row.sku}
                    disabled={disabled}
                    onChange={(e) => updateRow(row.key, { sku: e.target.value })}
                    placeholder="SKU-01"
                    className={`${isConflictSku(row.sku) ? inputErrorClass : inputClass} font-mono`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <CurrencyInput
                    value={row.importPrice}
                    onChange={(v) => updateRow(row.key, { importPrice: v })}
                    disabled={disabled}
                    smartShorthand
                    placeholder="0"
                    className={`${inputClass} font-mono`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <CurrencyInput
                    value={row.sellingPrice}
                    onChange={(v) => updateRow(row.key, { sellingPrice: v })}
                    disabled={disabled}
                    smartShorthand
                    placeholder="0"
                    className={`${inputClass} font-mono`}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    min={0}
                    value={row.stock}
                    disabled={disabled}
                    onChange={(e) => updateRow(row.key, { stock: Number(e.target.value) || 0 })}
                    className={`${inputClass} font-mono`}
                  />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <button
                    type="button"
                    onClick={() => removeRow(row.key)}
                    disabled={disabled}
                    className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition-all"
                    title="Xóa phân loại"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-gray-400">
                  Chưa có phân loại nào — bấm "Thêm phân loại mới" để bắt đầu.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {conflictWarning}
      {footer}
    </div>
  );
}
