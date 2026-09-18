import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Crown, Loader2, RefreshCw } from 'lucide-react';
import {
  AddressBookEntry,
  fetchAddressBookRanking,
} from '../utils/addressBook';

interface VipCustomersPageProps {
  authHeaders: () => Record<string, string>;
}

function formatVnd(n: number): string {
  return Math.round(n || 0).toLocaleString('vi-VN');
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN');
}

const MONTHS = [
  { value: 0, label: 'Cả năm' },
  { value: 1, label: 'Tháng 1' },
  { value: 2, label: 'Tháng 2' },
  { value: 3, label: 'Tháng 3' },
  { value: 4, label: 'Tháng 4' },
  { value: 5, label: 'Tháng 5' },
  { value: 6, label: 'Tháng 6' },
  { value: 7, label: 'Tháng 7' },
  { value: 8, label: 'Tháng 8' },
  { value: 9, label: 'Tháng 9' },
  { value: 10, label: 'Tháng 10' },
  { value: 11, label: 'Tháng 11' },
  { value: 12, label: 'Tháng 12' },
];

export default function VipCustomersPage({ authHeaders }: VipCustomersPageProps) {
  const now = new Date();
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number>(0);
  const [rows, setRows] = useState<AddressBookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const yearOptions = useMemo(() => {
    const y = now.getFullYear();
    const list: number[] = [];
    for (let i = 0; i < 6; i += 1) list.push(y - i);
    return list;
  }, [now]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const entries = await fetchAddressBookRanking(authHeaders, {
        year: year ?? undefined,
        month: month >= 1 && month <= 12 ? month : null,
        limit: 300,
      });
      const sorted = [...entries].sort(
        (a, b) => (b.total_spent || 0) - (a.total_spent || 0),
      );
      setRows(sorted);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Tải xếp hạng VIP thất bại');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, year, month]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4 max-w-6xl mx-auto pb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900 flex items-center gap-2">
            <Crown className="w-5 h-5 text-amber-500" />
            Khách hàng VIP
          </h2>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Thống kê từ Sổ địa chỉ — sắp xếp theo tổng chi tiêu giảm dần để chọn khách tặng quà.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Làm mới
        </button>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-bold text-slate-600 space-y-1">
            <span>Năm mua hàng</span>
            <select
              value={year ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setYear(v === '' ? null : Number(v));
              }}
              className="block w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold bg-white"
            >
              <option value="">Tất cả</option>
              {yearOptions.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-bold text-slate-600 space-y-1">
            <span>Tháng</span>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value) || 0)}
              disabled={year == null}
              className="block w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold bg-white disabled:opacity-50"
            >
              {MONTHS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="text-[11px] font-semibold text-slate-400 pb-2">
            Sort: Tổng chi tiêu ↓ · {rows.length} khách
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
            {error}
          </div>
        )}

        <div className="overflow-x-auto rounded-xl border border-slate-100">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left font-bold">STT</th>
                <th className="px-3 py-2.5 text-left font-bold">Tên</th>
                <th className="px-3 py-2.5 text-left font-bold">Số điện thoại</th>
                <th className="px-3 py-2.5 text-left font-bold">Địa chỉ</th>
                <th className="px-3 py-2.5 text-right font-bold">Tổng số đơn</th>
                <th className="px-3 py-2.5 text-right font-bold">Tổng chi tiêu</th>
                <th className="px-3 py-2.5 text-left font-bold">Ngày mua cuối</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-slate-400 font-semibold">
                    <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                    Đang tải…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-slate-400 font-semibold">
                    Chưa có dữ liệu VIP — tạo đơn nhanh có SĐT để tích lũy chi tiêu.
                  </td>
                </tr>
              ) : (
                rows.map((row, i) => (
                  <tr
                    key={row.id || `${row.phone}-${i}`}
                    className={`border-t border-slate-100 ${i < 3 && (row.total_spent || 0) > 0 ? 'bg-amber-50/40' : ''}`}
                  >
                    <td className="px-3 py-2.5 font-bold text-slate-500">{i + 1}</td>
                    <td className="px-3 py-2.5 font-extrabold text-slate-800">
                      {i === 0 && (row.total_spent || 0) > 0 && (
                        <Crown className="w-3.5 h-3.5 text-amber-500 inline-block mr-1 -mt-0.5" />
                      )}
                      {row.name || '—'}
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-slate-700 tabular-nums">
                      {row.phone || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 max-w-xs truncate" title={row.fullAddress || row.street}>
                      {row.fullAddress || row.street || '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold tabular-nums text-slate-700">
                      {row.total_orders ?? 0}
                    </td>
                    <td className="px-3 py-2.5 text-right font-black tabular-nums text-emerald-700">
                      {formatVnd(row.total_spent || 0)}₫
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-slate-600">
                      {formatDate(row.last_purchase_date)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
