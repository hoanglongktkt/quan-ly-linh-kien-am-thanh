import React from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
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

/** Sinh SKU con gợi ý dạng `<SKU cha>-<số thứ tự>`. */
export function suggestVariantSku(parentSku: string, index: number): string {
  const base = parentSku.trim();
  if (!base) return '';
  return `${base}-${index + 1}`;
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
      return `Mã SKU "${sku}" bị lặp giữa các phân loại.`;
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

export default function VariantRowsEditor({
  rows,
  onChange,
  parentSku = '',
  layout = 'table',
  disabled = false,
}: VariantRowsEditorProps) {
  const atLimit = rows.length >= MAX_VARIANT_ROWS;

  const updateRow = (key: string, patch: Partial<VariantRow>) => {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    if (atLimit) return;
    onChange([...rows, createVariantRow({ sku: suggestVariantSku(parentSku, rows.length) })]);
  };

  const removeRow = (key: string) => {
    onChange(rows.filter((r) => r.key !== key));
  };

  const applyPriceToAll = () => {
    const first = rows[0];
    if (!first) return;
    onChange(
      rows.map((r) => ({
        ...r,
        importPrice: first.importPrice,
        sellingPrice: first.sellingPrice,
      })),
    );
  };

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
      <button
        type="button"
        onClick={applyPriceToAll}
        disabled={disabled || rows.length < 2}
        className="inline-flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-gray-50 border border-gray-200 disabled:opacity-50 text-gray-700 text-xs font-semibold rounded-lg transition-all"
      >
        <Copy className="w-3.5 h-3.5" />
        Áp giá dòng đầu cho tất cả
      </button>
      <span className="text-[11px] text-gray-400 ml-auto">
        {rows.length}/{MAX_VARIANT_ROWS} phân loại
      </span>
    </div>
  );

  if (layout === 'card') {
    return (
      <div className="space-y-2.5">
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
              className={`${inputClass} font-mono`}
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
        {footer}
      </div>
    );
  }

  return (
    <div className="space-y-2">
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
                    className={`${inputClass} font-mono`}
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
      {footer}
    </div>
  );
}
