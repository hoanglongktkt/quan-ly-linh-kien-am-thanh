import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Crown, Eye, Loader2, Pen, RefreshCw, Trash2, X } from 'lucide-react';
import {
  AddressBookEntry,
  fetchAddressBookRanking,
} from '../utils/addressBook';
import { deleteCustomer, updateCustomerProfile } from '../utils/customers';

interface VipCustomersPageProps {
  authHeaders: () => Record<string, string>;
  onOpenHistory: (phone: string) => void;
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

export default function VipCustomersPage({ authHeaders, onOpenHistory }: VipCustomersPageProps) {
  const now = new Date();
  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<number>(0);
  const [rows, setRows] = useState<AddressBookEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AddressBookEntry | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPhone, setDraftPhone] = useState('');
  const [draftAddress, setDraftAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AddressBookEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const openEdit = useCallback((row: AddressBookEntry) => {
    setEditing(row);
    setDraftName(row.name || '');
    setDraftPhone(row.phone || '');
    setDraftAddress(row.fullAddress || row.street || '');
    setSaveMsg(null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    const name = draftName.trim();
    const phone = draftPhone.replace(/\D/g, '');
    const address = draftAddress.trim();
    if (phone.length < 8) {
      setSaveMsg('Số điện thoại không hợp lệ.');
      return;
    }
    if (!address) {
      setSaveMsg('Nhập địa chỉ trước khi lưu.');
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    const result = await updateCustomerProfile(
      editing.id || editing.phone,
      { name, phone, address, currentPhone: editing.phone },
      authHeaders,
    );
    setSaving(false);
    if (!result.success) {
      setSaveMsg(result.error || 'Lưu thất bại');
      return;
    }
    setRows((prev) =>
      prev.map((row) =>
        row.id === editing.id
          ? { ...row, name, phone, street: address, fullAddress: address }
          : row,
      ),
    );
    setEditing(null);
  }, [editing, draftName, draftPhone, draftAddress, authHeaders]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    const result = await deleteCustomer(
      pendingDelete.id || pendingDelete.phone,
      pendingDelete.phone,
      authHeaders,
    );
    setDeleting(false);
    if (!result.success) {
      setDeleteError(result.error || 'Xóa khách hàng thất bại');
      return;
    }
    setRows((prev) => prev.filter((row) => row.id !== pendingDelete.id));
    setPendingDelete(null);
  }, [pendingDelete, authHeaders]);

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
              className="block w-full sm:w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold bg-white"
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
              className="block w-full sm:w-40 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold bg-white disabled:opacity-50"
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
          <table className="min-w-[760px] w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="px-3 py-2.5 text-left font-bold">STT</th>
                <th className="px-3 py-2.5 text-left font-bold">Tên</th>
                <th className="px-3 py-2.5 text-left font-bold">Số điện thoại</th>
                <th className="px-3 py-2.5 text-left font-bold">Địa chỉ</th>
                <th className="px-3 py-2.5 text-right font-bold">Tổng số đơn</th>
                <th className="px-3 py-2.5 text-right font-bold">Tổng chi tiêu</th>
                <th className="px-3 py-2.5 text-left font-bold">Ngày mua cuối</th>
                <th className="px-3 py-2.5 text-right font-bold">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-400 font-semibold">
                    <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
                    Đang tải…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-slate-400 font-semibold">
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
                    <td className="px-3 py-2.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        title="Sửa"
                        onClick={() => openEdit(row)}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                      >
                        <Pen className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Xóa"
                        onClick={() => {
                          setDeleteError(null);
                          setPendingDelete(row);
                        }}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-rose-600 hover:bg-rose-50 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        title="Xem lịch sử"
                        disabled={!row.phone}
                        onClick={() => onOpenHistory(row.phone)}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-sky-700 hover:bg-sky-50 disabled:opacity-40 cursor-pointer"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div
          className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sửa khách hàng"
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-extrabold text-slate-900">Sửa khách hàng</div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 cursor-pointer"
                aria-label="Đóng"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-slate-500">Tên</span>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-slate-500">Số điện thoại</span>
              <input
                value={draftPhone}
                onChange={(e) => setDraftPhone(e.target.value)}
                inputMode="tel"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium tabular-nums"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] font-bold text-slate-500">Địa chỉ</span>
              <textarea
                value={draftAddress}
                onChange={(e) => setDraftAddress(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium"
              />
            </label>
            {saveMsg && <div className="text-xs font-bold text-rose-700">{saveMsg}</div>}
            <button
              type="button"
              onClick={() => void saveEdit()}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Lưu thay đổi
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div
          className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-slate-900/50 p-4"
          onClick={() => {
            if (!deleting) setPendingDelete(null);
          }}
        >
          <div
            className="w-full sm:max-w-sm rounded-2xl bg-white shadow-2xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Xác nhận xóa khách hàng"
          >
            <div className="text-sm font-extrabold text-slate-900">Xóa khách hàng</div>
            <p className="text-sm text-slate-600">Bạn có chắc chắn muốn xóa khách hàng này?</p>
            <p className="text-xs font-bold text-slate-800">
              {pendingDelete.name || '—'} · {pendingDelete.phone || '—'}
            </p>
            {deleteError && <div className="text-xs font-bold text-rose-700">{deleteError}</div>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setPendingDelete(null)}
                className="px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 cursor-pointer"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void confirmDelete()}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-rose-600 text-white text-xs font-bold cursor-pointer disabled:opacity-50"
              >
                {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Xóa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
