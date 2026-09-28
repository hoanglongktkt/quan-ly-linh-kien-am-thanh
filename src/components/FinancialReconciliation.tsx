import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Wallet } from 'lucide-react';
import type { ConnectedShop } from '../types';
import { getApiBaseUrl, parseJsonResponse } from '../utils/apiClient';

interface FinancialReconciliationProps {
  authHeaders: () => Record<string, string>;
  shops: ConnectedShop[];
}

interface EscrowRow {
  ordersn: string;
  shop_id: string;
  shop_name?: string;
  order_date?: string | null;
  total_amount: number;
  shopee_commission: number;
  service_fee: number;
  shipping_fee: number;
  withholding_tax?: number;
  payout_amount: number;
  actual_cost: number;
  net_profit: number;
  status: string;
  is_disputed?: boolean;
  dispute_reason?: string;
}

interface Summary {
  total_amount: number;
  shopee_fees: number;
  payout_amount: number;
  net_profit: number;
  order_count: number;
  disputed_count: number;
}

const EMPTY_SUMMARY: Summary = {
  total_amount: 0,
  shopee_fees: 0,
  payout_amount: 0,
  net_profit: 0,
  order_count: 0,
  disputed_count: 0,
};

function vnd(n: number): string {
  return `${Math.round(Number(n) || 0).toLocaleString('vi-VN')} đ`;
}

function toInputDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('vi-VN');
}

function shopeeCut(row: EscrowRow): number {
  const parts =
    Number(row.shopee_commission || 0) +
    Number(row.service_fee || 0) +
    Number(row.shipping_fee || 0) +
    Number(row.withholding_tax || 0);
  if (parts > 0) return parts;
  if (row.total_amount > 0 && row.payout_amount > 0) {
    return Math.max(0, row.total_amount - row.payout_amount);
  }
  return 0;
}

function statusClass(status: string): string {
  if (status === 'Đã đối soát') return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (status === 'Lệch tiền') return 'bg-rose-50 text-rose-700 border-rose-200';
  return 'bg-amber-50 text-amber-800 border-amber-200';
}

export default function FinancialReconciliation({ authHeaders, shops }: FinancialReconciliationProps) {
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    return toInputDate(d);
  });
  const [to, setTo] = useState(() => toInputDate(today));
  const [shopId, setShopId] = useState('');
  const [disputedOnly, setDisputedOnly] = useState(false);
  const [rows, setRows] = useState<EscrowRow[]>([]);
  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const shopeeShops = useMemo(
    () => (shops || []).filter((s) => s.platform === 'shopee' && s.shopId),
    [shops],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (shopId) params.set('shop_id', shopId);
      if (disputedOnly) params.set('disputed', '1');
      params.set('limit', '150');
      const response = await fetch(`${getApiBaseUrl()}/api/finance/reconciliation?${params.toString()}`, {
        headers: authHeaders(),
      });
      const data = await parseJsonResponse<{
        summary?: Summary;
        rows?: EscrowRow[];
        error?: string;
      }>(response);
      if (!response.ok) {
        throw new Error(data?.error || 'Không tải được đối soát');
      }
      setSummary({ ...EMPTY_SUMMARY, ...(data.summary || {}) });
      setRows(Array.isArray(data.rows) ? data.rows : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Không tải được đối soát');
      setRows([]);
      setSummary(EMPTY_SUMMARY);
    } finally {
      setLoading(false);
    }
  }, [authHeaders, from, to, shopId, disputedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/finance/sync-escrow`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          from,
          to,
          shop_id: shopId || undefined,
        }),
      });
      const data = await parseJsonResponse<{
        error?: string;
        message?: string;
        synced?: number;
        disputed?: number;
        failed?: number;
        skipped?: number;
      }>(response);
      if (!response.ok) {
        throw new Error(data?.error || 'Đồng bộ thất bại');
      }
      const bits = [
        data.message || `Đã đối soát ${data.synced || 0} đơn.`,
        typeof data.disputed === 'number' ? `${data.disputed} đơn lệch/thiếu tiền` : '',
        typeof data.failed === 'number' && data.failed > 0 ? `${data.failed} lỗi` : '',
        typeof data.skipped === 'number' && data.skipped > 0 ? `${data.skipped} đơn đã đối soát gần đây` : '',
      ].filter(Boolean);
      setNotice(bits.join(' · '));
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Đồng bộ thất bại');
    } finally {
      setSyncing(false);
    }
  };

  const cards = [
    { label: 'Tổng doanh thu', value: summary.total_amount, hint: `${summary.order_count} đơn`, tone: 'text-slate-900' },
    { label: 'Tổng phí sàn', value: summary.shopee_fees, hint: 'Hoa hồng + dịch vụ + ship + thuế', tone: 'text-rose-600' },
    { label: 'Tiền thực nhận về ví', value: summary.payout_amount, hint: 'Escrow Shopee', tone: 'text-blue-700' },
    { label: 'Lãi ròng', value: summary.net_profit, hint: 'Tiền về ví − giá vốn', tone: summary.net_profit >= 0 ? 'text-emerald-700' : 'text-rose-700' },
  ];

  return (
    <div className="space-y-4 max-w-7xl mx-auto pb-8">
      <div className="flex flex-col lg:flex-row lg:items-end gap-3 justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">
            Từ ngày
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block px-2.5 py-2 bg-white border border-gray-200 rounded-xl text-xs font-semibold text-gray-800"
            />
          </label>
          <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">
            Đến ngày
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block px-2.5 py-2 bg-white border border-gray-200 rounded-xl text-xs font-semibold text-gray-800"
            />
          </label>
          <label className="text-[11px] font-bold text-gray-500 uppercase tracking-wide">
            Shop
            <select
              value={shopId}
              onChange={(e) => setShopId(e.target.value)}
              className="mt-1 block min-w-40 px-2.5 py-2 bg-white border border-gray-200 rounded-xl text-xs font-semibold text-gray-800"
            >
              <option value="">Tất cả shop</option>
              {shopeeShops.map((shop) => (
                <option key={shop.shopId} value={shop.shopId}>
                  {shop.shopName || shop.shopId}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setDisputedOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border ${
              disputedOnly
                ? 'bg-rose-600 text-white border-rose-600'
                : 'bg-white text-rose-700 border-rose-200 hover:bg-rose-50'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            Chỉ đơn lệch / thiếu tiền
            {summary.disputed_count > 0 && !disputedOnly ? ` (${summary.disputed_count})` : ''}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={syncing}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs font-bold disabled:opacity-60"
        >
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Đồng bộ ví Shopee
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-xl bg-rose-50 border border-rose-100 text-xs font-semibold text-rose-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="px-3 py-2 rounded-xl bg-sky-50 border border-sky-100 text-xs font-semibold text-sky-800">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {cards.map((card) => (
          <div key={card.label} className="bg-white border border-gray-100 rounded-2xl p-4 shadow-xs">
            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{card.label}</p>
            <p className={`mt-1 text-lg md:text-xl font-extrabold tabular-nums ${card.tone}`}>{vnd(card.value)}</p>
            <p className="mt-1 text-[10px] text-gray-400">{card.hint}</p>
          </div>
        ))}
      </div>

      <div className="bg-white border border-gray-100 rounded-2xl shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Wallet className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-extrabold text-gray-900">Đơn đã đối soát</h3>
          {loading && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-xs">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left font-bold p-3">Mã đơn</th>
                <th className="text-left font-bold p-3">Shop</th>
                <th className="text-right font-bold p-3">Tiền khách trả</th>
                <th className="text-right font-bold p-3">Phí Shopee cắt</th>
                <th className="text-right font-bold p-3">Tiền về ví</th>
                <th className="text-right font-bold p-3">Giá vốn</th>
                <th className="text-right font-bold p-3">Lãi ròng</th>
                <th className="text-left font-bold p-3">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-400">
                    Chưa có dữ liệu trong khoảng này. Bấm «Đồng bộ ví Shopee» để lấy đơn đã hoàn thành.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const warn = Boolean(row.is_disputed) || row.status === 'Lệch tiền' || row.status === 'Chưa về ví';
                return (
                  <tr key={`${row.shop_id}-${row.ordersn}`} className={warn ? 'bg-rose-50/60' : 'border-t border-gray-50'}>
                    <td className="p-3 font-mono">
                      <a
                        href={`https://banhang.shopee.vn/portal/sale/order?type=all&search=search&keyword=${row.ordersn}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 font-semibold hover:underline cursor-pointer"
                      >
                        {row.ordersn}
                      </a>
                      <span className="block text-[10px] font-sans font-medium text-gray-400">{formatDate(row.order_date)}</span>
                    </td>
                    <td className="p-3 text-gray-700">{row.shop_name || row.shop_id}</td>
                    <td className="p-3 text-right font-mono">{vnd(row.total_amount)}</td>
                    <td className="p-3 text-right font-mono text-rose-600">{vnd(shopeeCut(row))}</td>
                    <td className="p-3 text-right font-mono font-bold text-blue-700">{vnd(row.payout_amount)}</td>
                    <td className="p-3 text-right font-mono">{vnd(row.actual_cost)}</td>
                    <td className={`p-3 text-right font-mono font-bold ${row.net_profit >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                      {vnd(row.net_profit)}
                    </td>
                    <td className="p-3">
                      <span className={`inline-flex px-2 py-0.5 rounded-full border text-[10px] font-bold ${statusClass(row.status)}`}>
                        {row.status}
                      </span>
                      {row.dispute_reason && (
                        <span className="block mt-1 text-[10px] text-rose-700 max-w-48">{row.dispute_reason}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
