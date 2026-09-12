import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Loader2, RefreshCw, X } from 'lucide-react';
import { parseJsonResponse } from '../utils/apiClient';

export type SupplierReportTimeRange =
  | 'ytd'
  | 'today'
  | 'yesterday'
  | '7days'
  | '30days'
  | 'thisMonth'
  | 'lastMonth';

const TIME_RANGE_OPTIONS: { value: SupplierReportTimeRange; label: string }[] = [
  { value: 'ytd', label: 'Đầu năm đến nay' },
  { value: 'today', label: 'Hôm nay' },
  { value: 'yesterday', label: 'Hôm qua' },
  { value: '7days', label: '7 ngày trước' },
  { value: '30days', label: '30 ngày trước' },
  { value: 'thisMonth', label: 'Tháng này' },
  { value: 'lastMonth', label: 'Tháng trước' },
];

interface SupplierReportRow {
  supplierId: string | null;
  supplierName: string;
  totalOrders: number;
  totalQuantity: number;
  totalPaidAmount: number;
  totalAmount: number;
}

interface SupplierReportResponse {
  success?: boolean;
  timeRange?: string;
  startDate?: string;
  endDate?: string;
  totalSuppliers?: number;
  report?: SupplierReportRow[];
  error?: string;
}

interface SupplierImportReportModalProps {
  open: boolean;
  onClose: () => void;
}

function formatVnd(amount: number): string {
  return `${Math.round(amount || 0).toLocaleString('vi-VN')} đ`;
}

/**
 * Modal báo cáo nhập hàng gom nhóm theo Nhà cung cấp — có bộ lọc thời gian.
 * Tính năng đọc/thống kê độc lập, KHÔNG ảnh hưởng tới bảng lịch sử nhập hàng hiện tại.
 */
export default function SupplierImportReportModal({
  open,
  onClose,
}: SupplierImportReportModalProps) {
  const [timeRange, setTimeRange] = useState<SupplierReportTimeRange>('ytd');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SupplierReportRow[]>([]);
  const [rangeLabel, setRangeLabel] = useState<{ start: string; end: string } | null>(null);

  const fetchReport = useCallback(async (range: SupplierReportTimeRange) => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch(`/api/imports/supplier-report?timeRange=${encodeURIComponent(range)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const data = await parseJsonResponse<SupplierReportResponse>(res);
      if (data?.success === false) {
        throw new Error(data.error || 'Không tải được báo cáo.');
      }
      setRows(Array.isArray(data.report) ? data.report : []);
      setRangeLabel(
        data.startDate && data.endDate ? { start: data.startDate, end: data.endDate } : null,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Không tải được báo cáo nhập hàng.';
      setError(message);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void fetchReport(timeRange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, timeRange]);

  if (!open) return null;

  const grandTotalPaid = rows.reduce((sum, r) => sum + (Number(r.totalPaidAmount) || 0), 0);
  const grandTotalOrders = rows.reduce((sum, r) => sum + (Number(r.totalOrders) || 0), 0);
  const grandTotalQuantity = rows.reduce((sum, r) => sum + (Number(r.totalQuantity) || 0), 0);

  return (
    <div className="fixed inset-0 z-90 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/50"
        aria-label="Đóng"
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-4xl bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-gray-100 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100 flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-extrabold text-gray-900 flex items-center gap-2">
              <BarChart3 className="w-5 h-5 text-indigo-600" /> Báo cáo Nhà cung cấp
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              Tổng hợp số tiền đã thanh toán, số đơn và số lượng hàng nhập theo từng nhà cung cấp.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-3 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shrink-0 bg-gray-50/60">
          <div className="flex items-center gap-2">
            <label className="text-xs font-bold uppercase tracking-wider text-gray-400 whitespace-nowrap">
              Khoảng thời gian
            </label>
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as SupplierReportTimeRange)}
              className="pl-3 pr-8 py-2 bg-white text-sm rounded-xl border border-gray-200 outline-none cursor-pointer appearance-none min-w-[200px] font-semibold text-gray-700"
            >
              {TIME_RANGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void fetchReport(timeRange)}
              disabled={loading}
              title="Tải lại"
              className="p-2 rounded-xl border border-gray-200 bg-white text-gray-500 hover:text-indigo-600 hover:border-indigo-200 disabled:opacity-50"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            </button>
          </div>
          {rangeLabel && (
            <p className="text-[11px] text-gray-400 font-mono">
              {rangeLabel.start} → {rangeLabel.end}
            </p>
          )}
        </div>

        <div className="overflow-y-auto flex-1 p-4">
          {error ? (
            <div className="text-center text-sm text-rose-600 font-semibold py-10">{error}</div>
          ) : loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 gap-2">
              <Loader2 className="w-6 h-6 animate-spin" />
              <span className="text-xs">Đang tải báo cáo...</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center text-sm text-gray-400 py-16">
              Không có dữ liệu nhập hàng trong khoảng thời gian này.
            </div>
          ) : (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <table className="w-full text-left border-collapse min-w-[640px]">
                <thead>
                  <tr className="bg-slate-50 border-b border-gray-200 text-[11px] font-bold text-gray-500 uppercase tracking-wider">
                    <th className="px-4 py-3">Tên nhà cung cấp</th>
                    <th className="px-4 py-3 text-center">SL đơn nhập</th>
                    <th className="px-4 py-3 text-center">SL hàng nhập</th>
                    <th className="px-4 py-3 text-right">Tổng tiền đã thanh toán</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-sm">
                  {rows.map((row) => {
                    const paid = Number(row.totalPaidAmount) || 0;
                    const isPaid = paid > 0;
                    return (
                      <tr key={row.supplierId || row.supplierName} className="hover:bg-slate-50/60">
                        <td className="px-4 py-3 font-semibold text-gray-900">{row.supplierName}</td>
                        <td className="px-4 py-3 text-center font-mono font-bold text-gray-700">
                          {row.totalOrders}
                        </td>
                        <td className="px-4 py-3 text-center font-mono font-bold text-gray-700">
                          {row.totalQuantity}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono font-extrabold whitespace-nowrap ${
                            isPaid ? 'text-emerald-600' : 'text-rose-600'
                          }`}
                        >
                          {formatVnd(paid)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-slate-50 border-t-2 border-gray-200 text-sm">
                    <td className="px-4 py-3 font-extrabold text-gray-900">Tổng cộng</td>
                    <td className="px-4 py-3 text-center font-mono font-extrabold text-gray-900">
                      {grandTotalOrders}
                    </td>
                    <td className="px-4 py-3 text-center font-mono font-extrabold text-gray-900">
                      {grandTotalQuantity}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-extrabold text-emerald-700 whitespace-nowrap">
                      {formatVnd(grandTotalPaid)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
