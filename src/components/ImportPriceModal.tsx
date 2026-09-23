import React, { useRef, useState } from 'react';
import { read, utils } from 'xlsx';
import { Download, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';

export type ImportPriceRow = { sku: string; import_price: number };

type Props = {
  open: boolean;
  onClose: () => void;
  onImported: (result: { updatedCount: number; notFoundCount: number }) => void;
  onError: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
};

function normalizeHeader(h: string): string {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
    .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
    .replace(/[ìíịỉĩ]/g, 'i')
    .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
    .replace(/[ùúụủũưừứựửữ]/g, 'u')
    .replace(/[ỳýỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd');
}

function pickSku(row: Record<string, unknown>): string {
  const keys = Object.keys(row);
  for (const k of keys) {
    const n = normalizeHeader(k);
    if (n === 'sku' || n === 'ma_sku' || n === 'ma_san_pham' || n === 'product_sku') {
      return String(row[k] ?? '').trim();
    }
  }
  // fallback: cột đầu
  if (keys.length > 0) return String(row[keys[0]] ?? '').trim();
  return '';
}

function pickImportPrice(row: Record<string, unknown>): number | null {
  const keys = Object.keys(row);
  for (const k of keys) {
    const n = normalizeHeader(k);
    if (
      n === 'import_price' ||
      n === 'importprice' ||
      n === 'gia_nhap' ||
      n === 'cost_price' ||
      n === 'last_import_price'
    ) {
      const raw = row[k];
      if (raw === '' || raw == null) return null;
      const cleaned = String(raw).replace(/[^\d.-]/g, '');
      const num = Number(cleaned);
      if (!Number.isFinite(num)) return null;
      return Math.max(0, Math.round(num));
    }
  }
  // fallback: cột thứ 2
  if (keys.length > 1) {
    const raw = row[keys[1]];
    if (raw === '' || raw == null) return null;
    const cleaned = String(raw).replace(/[^\d.-]/g, '');
    const num = Number(cleaned);
    if (!Number.isFinite(num)) return null;
    return Math.max(0, Math.round(num));
  }
  return null;
}

export function parseImportPriceRows(rows: Record<string, unknown>[]): ImportPriceRow[] {
  const out: ImportPriceRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const sku = pickSku(row);
    if (!sku) continue;
    const price = pickImportPrice(row);
    if (price == null) continue;
    const key = sku.toLowerCase();
    // Dòng trùng SKU: lấy giá dòng sau cùng.
    if (seen.has(key)) {
      const idx = out.findIndex((r) => r.sku.toLowerCase() === key);
      if (idx >= 0) out[idx] = { sku, import_price: price };
      continue;
    }
    seen.add(key);
    out.push({ sku, import_price: price });
  }
  return out;
}

async function readFileToRows(file: File): Promise<ImportPriceRow[]> {
  const buf = await file.arrayBuffer();
  const wb = read(buf, { type: 'array', raw: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const json = utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: '',
    raw: false,
  });
  return parseImportPriceRows(json);
}

function downloadTemplate() {
  const csv = 'sku,import_price\nV7200K,480000\nSKU-MAU-02,125000\n';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mau_import_gia_nhap.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatImportError(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'sai định dạng file';
  const message = String(raw || 'sai định dạng file').trim();
  return message.toLowerCase().startsWith('lỗi import') ? message : `Lỗi import: ${message}`;
}

export default function ImportPriceModal({ open, onClose, onImported, onError, onBusyChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [previewCount, setPreviewCount] = useState(0);
  const [rows, setRows] = useState<ImportPriceRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  if (!open) return null;

  const resetFileInput = () => {
    if (inputRef.current) inputRef.current.value = '';
  };

  const resetLocal = () => {
    setFileName('');
    setPreviewCount(0);
    setRows([]);
    resetFileInput();
  };

  const setBusy = (busy: boolean) => {
    setIsImporting(busy);
    onBusyChange?.(busy);
  };

  const handleClose = () => {
    if (isImporting) return;
    resetLocal();
    onClose();
  };

  const submitRows = async (parsed: ImportPriceRow[]) => {
    const token = localStorage.getItem('admin_token');
    if (!token) throw new Error('Chưa đăng nhập.');
    const res = await fetch('/api/products/bulk-import-price', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(parsed),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) {
      throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
    }
    resetLocal();
    onImported({
      updatedCount: Number(data.updatedCount) || 0,
      notFoundCount: Number(data.notFoundCount) || 0,
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file || isImporting) {
      input.value = '';
      return;
    }
    setBusy(true);
    setFileName(file.name);
    try {
      const parsed = await readFileToRows(file);
      setRows(parsed);
      setPreviewCount(parsed.length);
      if (parsed.length === 0) {
        throw new Error('sai định dạng file (cần cột sku và import_price).');
      }
      await submitRows(parsed);
    } catch (err: unknown) {
      onError(formatImportError(err));
    } finally {
      setBusy(false);
      input.value = '';
      resetFileInput();
    }
  };

  const handleSubmit = async () => {
    if (rows.length === 0 || isImporting) return;
    setBusy(true);
    try {
      await submitRows(rows);
    } catch (err: unknown) {
      onError(formatImportError(err));
    } finally {
      setBusy(false);
      resetFileInput();
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
      <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col border border-gray-100">
        <div className="p-5 border-b border-gray-100 flex items-center justify-between bg-emerald-50">
          <h3 className="text-sm font-black text-emerald-800 uppercase tracking-wider flex items-center gap-2">
            <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
            <span>Import Giá Nhập theo SKU</span>
          </h3>
          <button
            type="button"
            onClick={handleClose}
            disabled={isImporting}
            className="p-1 hover:bg-emerald-100 rounded-full transition-all text-emerald-600 hover:text-emerald-900 cursor-pointer disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="bg-emerald-50/70 border border-emerald-200/50 p-4 rounded-xl text-xs text-emerald-900 leading-relaxed font-semibold">
            Upload file Excel/CSV (2 cột: <code className="font-mono">sku</code>,{' '}
            <code className="font-mono">import_price</code>) xuất từ Sapo. Hệ thống sẽ dò SKU trong
            Kho gốc và cập nhật đè giá nhập hàng loạt.
          </div>

          <button
            type="button"
            onClick={downloadTemplate}
            className="w-full px-4 py-2.5 bg-white border border-emerald-200 hover:bg-emerald-50 text-emerald-800 text-xs font-extrabold rounded-xl transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Tải File Mẫu (CSV)
          </button>

          <div className="space-y-2">
            <label className="text-xs font-black text-gray-700">Chọn file (.xlsx / .csv)</label>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              onChange={(e) => void handleFileChange(e)}
              disabled={isImporting}
              className="block w-full text-xs text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-emerald-600 file:text-white hover:file:bg-emerald-700 file:cursor-pointer cursor-pointer disabled:opacity-60"
            />
            {isImporting && (
              <p className="text-xs font-extrabold text-emerald-700 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Đang xử lý...
              </p>
            )}
            {fileName && !isImporting && (
              <p className="text-[11px] text-gray-500 font-semibold">
                {`${fileName} — ${previewCount} dòng hợp lệ`}
              </p>
            )}
          </div>
        </div>

        <div className="p-4 bg-slate-50 border-t border-gray-100 flex justify-end gap-3.5">
          <button
            type="button"
            onClick={handleClose}
            disabled={isImporting}
            className="px-4 py-2.5 text-xs font-bold text-gray-600 hover:bg-gray-100 rounded-xl transition-all cursor-pointer disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={rows.length === 0 || isImporting}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white text-xs font-extrabold rounded-xl transition-all flex items-center gap-2 cursor-pointer shadow-md shadow-emerald-500/20"
          >
            {isImporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5" />
            )}
            {isImporting ? 'Đang xử lý...' : `Import ${rows.length || ''} SKU`}
          </button>
        </div>
      </div>
    </div>
  );
}
