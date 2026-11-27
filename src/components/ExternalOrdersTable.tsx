import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Printer, RefreshCw, Ban, Receipt, Pencil, Trash2 } from 'lucide-react';
import type { Order } from '../types';
import { createTimeoutSignal, isAbortError, readResponseJson } from '../utils/apiClient';
import type { MobileOrderCardControls } from './OrderListRows';
import { orderCreatedAtMs, parseOrderTimeMs } from '../utils/sanitizeOrder';
import {
  PosInvoiceTemplate,
  buildPosInvoiceFromOrder,
  loadStoreInfo,
} from './PosInvoiceTemplate';

type ExternalStatusKey = 'created' | 'shipping' | 'delivered' | 'rts' | 'cancelled';

const isPosOrder = (order: Order) => order.source === 'pos' || order.is_quick_order === true;

function resolveExternalStatus(order: Order): ExternalStatusKey {
  const ext = String(
    (order as { external_status?: string }).external_status || '',
  ).toLowerCase();
  const ghn = String((order as { ghn_status?: string }).ghn_status || '').toLowerCase();
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (
    ext === 'cancelled' ||
    raw === 'EXTERNAL_CANCELLED' ||
    ghn === 'cancel' ||
    ghn === 'cancelled' ||
    ghn === 'canceled'
  ) {
    return 'cancelled';
  }
  if (ext === 'rts' || raw === 'EXTERNAL_RTS' || raw.includes('RTS') || order.is_rts === true) {
    return 'rts';
  }
  if (
    ext === 'delivered' ||
    raw === 'EXTERNAL_DELIVERED' ||
    raw.includes('DELIVER') ||
    order.status === 'completed'
  ) {
    return 'delivered';
  }
  if (
    ext === 'shipping' ||
    raw === 'EXTERNAL_SHIPPING' ||
    raw.includes('SHIPPING') ||
    order.status === 'shipping'
  ) {
    return 'shipping';
  }
  return 'created';
}

const STATUS_META: Record<
  ExternalStatusKey,
  { label: string; className: string }
> = {
  created: {
    label: 'Đã tạo đơn',
    className: 'bg-sky-50 text-sky-800 border-sky-200',
  },
  shipping: {
    label: 'Đang giao',
    className: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  },
  delivered: {
    label: 'Giao thành công',
    className: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  rts: {
    label: 'Giao không thành công / RTS',
    className: 'bg-rose-50 text-rose-800 border-rose-200',
  },
  cancelled: {
    label: 'Đã hủy',
    className: 'bg-slate-100 text-slate-700 border-slate-300',
  },
};

function providerOf(order: Order): 'ghn' | 'spx' | 'self' {
  const p = String(
    (order as { provider?: string }).provider || order.carrier || '',
  ).toLowerCase();
  if (p === 'ghn' || p === 'spx') return p;
  const carrier = String(order.shipping_carrier || '').toLowerCase();
  if (carrier.includes('ghn') || carrier.includes('giao hàng nhanh')) return 'ghn';
  if (carrier.includes('spx')) return 'spx';
  return 'self';
}

function ProviderBadge({ provider }: { provider: 'ghn' | 'spx' | 'self' }) {
  if (provider === 'ghn') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[9px] font-black tracking-wide">
        GHN
      </span>
    );
  }
  if (provider === 'spx') {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-orange-500 text-white text-[9px] font-black tracking-wide">
        SPX
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-500 text-white text-[9px] font-black tracking-wide">
      TỰ GIAO
    </span>
  );
}

function formatAddress(order: Order): string {
  const sa = order.shippingAddress;
  if (sa && typeof sa === 'object') {
    const full = String((sa as { fullAddress?: string }).fullAddress || '').trim();
    if (full) return full;
    return [
      (sa as { street?: string }).street,
      (sa as { ward?: string }).ward,
      (sa as { district?: string }).district,
      (sa as { province?: string }).province,
    ]
      .filter(Boolean)
      .join(', ');
  }
  if (typeof sa === 'string' && sa.trim()) return sa;
  return String(order.customerAddress || '').trim() || '—';
}

function trackingOf(order: Order): string {
  return String(order.tracking_no || order.trackingNumber || '').trim();
}

function orderKeyOf(order: Order): string {
  return String(order.id || order.orderSn || '').trim();
}

function codOf(order: Order): number {
  const n = Number((order as { cod_amount?: number }).cod_amount ?? order.totalAmount);
  return Number.isFinite(n) ? n : 0;
}

function formatOrderDateTime(raw: unknown): string {
  const ms = parseOrderTimeMs(raw);
  if (ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(raw || '—');
  }
}

function orderDeliveredAtMs(order: Order): number {
  const raw = order as Record<string, unknown>;
  const candidates = [
    order.ghn_synced_at,
    raw.updated_at,
    raw.updatedAt,
    raw.update_time,
    order.local_status_updated_at,
    order.localStatusAt,
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const t = parseOrderTimeMs(candidates[i]);
    if (t > 0) return t;
  }
  return 0;
}

function OrderTimeCell({ order, status }: { order: Order; status: ExternalStatusKey }) {
  const createdMs = orderCreatedAtMs(order);
  const deliveredMs = status === 'delivered' ? orderDeliveredAtMs(order) : 0;
  return (
    <div className="leading-snug">
      <div className="font-bold text-gray-900 text-[11px] whitespace-nowrap">
        Tạo: {formatOrderDateTime(createdMs > 0 ? createdMs : order.date)}
      </div>
      {status === 'delivered' && deliveredMs > 0 ? (
        <div className="text-[10px] text-emerald-600 font-semibold mt-0.5 whitespace-nowrap">
          Giao: {formatOrderDateTime(deliveredMs)}
        </div>
      ) : null}
    </div>
  );
}

async function postGhnOrderAction(path: string, order: Order, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const token = localStorage.getItem('admin_token') || '';
  const id = encodeURIComponent(String(order.id || order.orderSn || '').trim());
  const scope = createTimeoutSignal(30_000, signal);
  try {
    const res = await fetch(`/api/orders/${id}/${path}`, {
      method: 'POST', signal: scope.signal,
      headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
      body: JSON.stringify({ orderSn: order.orderSn }),
    });
    const data = await readResponseJson(res);
    if (!res.ok || data.success === false) throw new Error(String(data.message || data.error || 'Thao tác GHN thất bại'));
    return data;
  } catch (error) {
    if (!signal?.aborted && (scope.signal.aborted || isAbortError(error))) {
      throw new Error('Chưa xác nhận được kết quả từ GHN. Hãy đồng bộ kiểm tra trạng thái trước khi thử lại.');
    }
    throw error;
  } finally {
    scope.cleanup();
  }
}

async function saveExternalOrder(order: Order, contact?: FormData, signal?: AbortSignal) {
  const token = localStorage.getItem('admin_token') || '';
  const scope = createTimeoutSignal(20_000, signal);
  try {
    const response = await fetch(`/api/orders/external/${encodeURIComponent(orderKeyOf(order))}`, {
      method: contact ? 'PATCH' : 'DELETE', signal: scope.signal,
      headers: { Authorization: `Bearer ${token}`, ...(contact ? { 'Content-Type': 'application/json' } : {}) },
      body: contact ? JSON.stringify(Object.fromEntries(contact)) : undefined,
    });
    const data = await readResponseJson<{ success?: boolean; message?: string; error?: string; order: Order }>(response);
    if (!response.ok || data.success !== true) throw new Error(data.message || data.error || 'Không cập nhật được đơn.');
    return data;
  } catch (error) {
    if (!signal?.aborted && (scope.signal.aborted || isAbortError(error))) {
      throw new Error('Chưa xác nhận được kết quả cập nhật. Hãy tải lại danh sách trước khi thử lại.');
    }
    throw error;
  } finally {
    scope.cleanup();
  }
}

function ExternalOrderContactDialog({ order, onClose, onSaved }: {
  order: Order;
  onClose: () => void;
  onSaved: (order: Order) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const lifetimeRef = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetimeRef.current = controller;
    dialogRef.current?.showModal();
    return () => controller.abort();
  }, []);
  const inputClass = 'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm mt-1';
  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="external-order-contact-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
      className="m-auto w-[92vw] max-w-lg rounded-2xl bg-white p-5 text-slate-800 shadow-xl backdrop:bg-slate-950/50"
    >
      <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        if (savingRef.current) return;
        const signal = lifetimeRef.current.signal;
        if (signal.aborted) return;
        savingRef.current = true;
        const contact = new FormData(event.currentTarget);
        setSaving(true);
        setError('');
        try {
          const result = await saveExternalOrder(order, contact, signal);
          if (!signal.aborted) onSaved(result.order);
        } catch (error) {
          if (!signal.aborted) setError(error instanceof Error ? error.message : 'Không lưu được đơn.');
        } finally {
          savingRef.current = false;
          if (!signal.aborted) setSaving(false);
        }
      }}>
        <h2 id="external-order-contact-title" className="font-bold">Chỉnh sửa đơn {order.orderSn}</h2>
        {trackingOf(order) && providerOf(order) !== 'self' && (
          <p className="text-xs text-slate-600">Thông tin chỉnh sửa chỉ áp dụng cho đơn trên phần mềm.</p>
        )}
        <label className="block text-xs font-semibold">Tên khách
          <input name="customerName" defaultValue={order.customerName} required maxLength={1000} className={inputClass} />
        </label>
        <label className="block text-xs font-semibold">Số điện thoại
          <input name="customerPhone" type="tel" defaultValue={order.customerPhone} maxLength={1000} className={inputClass} />
        </label>
        <label className="block text-xs font-semibold">Địa chỉ
          <textarea name="customerAddress" defaultValue={order.customerAddress || (order.shippingAddress ? formatAddress(order) : '')} rows={2} maxLength={1000} className={inputClass} />
        </label>
        <label className="block text-xs font-semibold">Ghi chú
          <textarea name="note" defaultValue={typeof order.note === 'string' ? order.note : ''} rows={2} maxLength={1000} className={inputClass} />
        </label>
        {error && <p role="alert" className="text-sm text-rose-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-bold">Đóng</button>
          <button type="submit" disabled={saving} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">{saving ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
        </div>
      </form>
    </dialog>,
    document.body,
  );
}

type ExternalAction = 'print' | 'invoice' | 'sync' | 'cancel' | 'delete';

function ExternalOrderActions({
  order,
  busyKind,
  onPrintWaybill,
  onPrintInvoice,
  onSyncGhn,
  onCancelGhn,
  onEditOrder,
  onDeleteOrder,
}: {
  order: Order;
  busyKind: ExternalAction | null;
  onPrintWaybill: (order: Order) => void;
  onPrintInvoice: (order: Order) => void;
  onSyncGhn: (order: Order) => void;
  onCancelGhn: (order: Order) => void;
  onEditOrder: (order: Order) => void;
  onDeleteOrder: (order: Order) => void;
}) {
  const provider = providerOf(order);
  const tn = trackingOf(order);
  const st = resolveExternalStatus(order);
  const printBusy = busyKind === 'print';
  const invoiceBusy = busyKind === 'invoice';
  const syncBusy = busyKind === 'sync';
  const cancelBusy = busyKind === 'cancel';
  const anyBusy = Boolean(busyKind);
  const canGhn = provider === 'ghn' && Boolean(tn);
  const canCancel = canGhn && st !== 'cancelled' && st !== 'delivered';
  const pos = isPosOrder(order);

  const iconButtonClass =
    'inline-flex h-10 w-10 md:h-8 md:w-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="inline-flex flex-col items-center gap-1.5">
      <div className="inline-flex items-center justify-center gap-1.5">
        {(!pos || (st !== 'cancelled' && st !== 'rts')) && (
          <button
            type="button"
            disabled={anyBusy}
            onClick={() => onEditOrder(order)}
            className={`${iconButtonClass} bg-slate-800 text-white hover:bg-slate-900 focus-visible:ring-slate-500`}
            title="Sửa đơn"
            aria-label="Sửa đơn"
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          disabled={anyBusy}
          onClick={() => onDeleteOrder(order)}
          className={`${iconButtonClass} border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 focus-visible:ring-rose-400`}
          title="Xóa đơn"
          aria-label={busyKind === 'delete' ? 'Đang xóa đơn' : 'Xóa đơn'}
          aria-busy={busyKind === 'delete'}
        >
          {busyKind === 'delete' ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          disabled={anyBusy}
          onClick={() => onPrintInvoice(order)}
          className={`${iconButtonClass} bg-amber-500 text-white hover:bg-amber-600 focus-visible:ring-amber-400`}
          title="In lại hóa đơn bán lẻ (POS) cho khách"
          aria-label={invoiceBusy ? 'Đang in hóa đơn' : 'In hóa đơn'}
          aria-busy={invoiceBusy}
        >
          {invoiceBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Receipt className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {!pos && <>
      <button
        type="button"
        disabled={anyBusy || provider === 'self' || !tn}
        onClick={() => onPrintWaybill(order)}
        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title={
          provider === 'self'
            ? 'Đơn tự giao không có phiếu bưu cục'
            : !tn
              ? 'Chưa có mã vận đơn từ hãng'
              : 'Mở PDF vận đơn gốc của hãng'
        }
      >
        {printBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Printer className="w-3.5 h-3.5" />
        )}
        In vận đơn
      </button>
      <button
        type="button"
        disabled={anyBusy || !canGhn}
        onClick={() => onSyncGhn(order)}
        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title={!canGhn ? 'Chỉ đồng bộ đơn GHN đã có mã vận đơn' : 'Lấy trạng thái mới nhất từ GHN'}
      >
        {syncBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
        Đồng bộ GHN
      </button>
      <button
        type="button"
        disabled={anyBusy || !canCancel}
        onClick={() => onCancelGhn(order)}
        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        title={
          !canGhn
            ? 'Chỉ hủy vận đơn GHN'
            : st === 'cancelled'
              ? 'Đơn đã hủy'
              : 'Hủy đồng thời trên GHN và phần mềm'
        }
      >
        {cancelBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
        Hủy vận chuyển
      </button>
      </>}
    </div>
  );
}

export function ExternalOrdersTable({
  orders,
  printingOrderId,
  onPrintWaybill,
  onOrderUpdated,
  onEditPosOrder,
  onOrderEdited,
  onOrderDeleted,
  renderMobileOrder,
}: {
  orders: Order[];
  printingOrderId: string | null;
  onPrintWaybill: (order: Order) => void;
  onOrderUpdated?: (order: Order) => void;
  onEditPosOrder: (order: Order) => void;
  onOrderEdited: (order: Order) => void;
  onOrderDeleted: (order: Order) => void;
  renderMobileOrder?: (order: Order, controls: MobileOrderCardControls) => React.ReactNode;
}) {
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<ExternalAction | null>(null);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [singlePrintOrder, setSinglePrintOrder] = useState<Order | null>(null);
  const actionLockRef = useRef(false);
  const lifetimeRef = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetimeRef.current = controller;
    return () => controller.abort();
  }, []);

  const handlePrintSingleInvoice = (order: Order) => {
    if (actionKey || printingOrderId) return;
    setActionKey(orderKeyOf(order));
    setActionKind('invoice');
    setSinglePrintOrder(order);
  };

  useEffect(() => {
    if (!singlePrintOrder) return;
    let cancelled = false;
    document.body.classList.add('pos-invoice-printing');

    const clearSinglePrint = () => {
      document.body.classList.remove('pos-invoice-printing');
      setSinglePrintOrder(null);
      setActionKey(null);
      setActionKind(null);
    };

    const onAfterPrint = () => {
      if (cancelled) return;
      clearSinglePrint();
    };
    window.addEventListener('afterprint', onAfterPrint);

    const printTimer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        window.print();
      } catch (err) {
        console.error('[POS Invoice] window.print failed:', err);
        window.alert('Không mở được hộp thoại in. Hãy dùng Ctrl+P.');
        onAfterPrint();
      }
    }, 300);

    const fallbackClear = window.setTimeout(() => {
      if (!cancelled) clearSinglePrint();
    }, 120000);

    return () => {
      cancelled = true;
      window.clearTimeout(printTimer);
      window.clearTimeout(fallbackClear);
      window.removeEventListener('afterprint', onAfterPrint);
      document.body.classList.remove('pos-invoice-printing');
    };
  }, [singlePrintOrder]);

  const runGhnAction = async (order: Order, kind: 'sync' | 'cancel') => {
    const key = orderKeyOf(order);
    if (!key || actionKey || actionLockRef.current) return;
    const signal = lifetimeRef.current.signal;
    if (signal.aborted) return;
    if (kind === 'cancel') {
      const ok = window.confirm(
        'Hủy đơn vận chuyển trên GHN và đổi trạng thái Đã hủy trên phần mềm?',
      );
      if (!ok) return;
    }
    actionLockRef.current = true;
    setActionKey(key);
    setActionKind(kind);
    try {
      const path = kind === 'sync' ? 'sync-ghn' : 'cancel-ghn';
      const data = await postGhnOrderAction(path, order, signal);
      if (signal.aborted) return;
      const updated = (data.order || null) as Order | null;
      if (updated && onOrderUpdated) onOrderUpdated(updated);
      const msg = String(data.message || (kind === 'sync' ? 'Đã đồng bộ GHN' : 'Đã hủy đơn GHN'));
      window.alert(msg);
    } catch (err: unknown) {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : 'Thao tác GHN thất bại';
      window.alert(msg);
    } finally {
      actionLockRef.current = false;
      if (!signal.aborted) {
        setActionKey(null);
        setActionKind(null);
      }
    }
  };

  const editOrder = (order: Order) => {
    if (actionKey || printingOrderId) return;
    if (isPosOrder(order)) onEditPosOrder(order);
    else setEditingOrder(order);
  };

  const deleteOrder = async (order: Order) => {
    if (actionKey || printingOrderId || actionLockRef.current) return;
    const signal = lifetimeRef.current.signal;
    if (signal.aborted) return;
    const hasWaybill = Boolean(trackingOf(order)) && providerOf(order) !== 'self';
    if (!window.confirm(
      `Xóa vĩnh viễn đơn ${order.orderSn || order.id} khỏi phần mềm?` +
      (hasWaybill ? '\nNếu cần hủy giao hàng, hãy hủy vận đơn với hãng trước khi xóa.' : '') +
      (isPosOrder(order) ? '\nNếu cần hoàn tồn, hãy điều chỉnh trong kho.' : ''),
    )) return;
    actionLockRef.current = true;
    setActionKey(orderKeyOf(order));
    setActionKind('delete');
    try {
      await saveExternalOrder(order, undefined, signal);
      if (!signal.aborted) onOrderDeleted(order);
    } catch (error) {
      if (!signal.aborted) window.alert(error instanceof Error ? error.message : 'Không xóa được đơn.');
    } finally {
      actionLockRef.current = false;
      if (!signal.aborted) {
        setActionKey(null);
        setActionKind(null);
      }
    }
  };

  if (orders.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 px-6 py-16 text-center text-sm text-gray-500 font-medium">
        Chưa có đơn ngoại sàn. Bấm “Tạo đơn hàng ngoài sàn” để lên đơn GHN/SPX.
      </div>
    );
  }

  return (
    <>
      <div className="om-no-print">
      <div className="overflow-x-auto om-orders-table-view max-md:hidden bg-white rounded-2xl border border-gray-100">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-gray-100 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
              <th className="p-4 w-40">Thời gian</th>
              <th className="p-4 w-48">Mã đơn / vận đơn</th>
              <th className="p-4 w-44">Khách hàng</th>
              <th className="p-4">Địa chỉ</th>
              <th className="p-4 text-right w-32">Tiền thu hộ (COD)</th>
              <th className="p-4 text-center w-40">Trạng thái</th>
              <th className="p-4 text-center w-40">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {orders.map((order) => {
              const provider = providerOf(order);
              const tn = trackingOf(order);
              const pos = isPosOrder(order);
              const st = resolveExternalStatus(order);
              const meta = STATUS_META[st];
              const key = orderKeyOf(order);
              const printBusy = printingOrderId === order.id || printingOrderId === order.orderSn;
              const rowBusy = actionKey === key;
              const busyKind = printBusy
                ? 'print'
                : rowBusy
                  ? actionKind
                  : null;
              return (
                <tr key={order.id || order.orderSn} className="hover:bg-slate-50/40">
                  <td className="p-4">
                    <OrderTimeCell order={order} status={st} />
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-1.5">
                      {pos ? <span className="px-1.5 py-0.5 rounded bg-blue-600 text-white text-[9px] font-bold">POS</span> : <ProviderBadge provider={provider} />}
                      {pos || tn ? (
                        <span className="font-mono font-extrabold text-gray-900 text-sm tracking-tight truncate max-w-[10rem]">
                          {pos ? order.orderSn : tn}
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-700 italic font-semibold">
                          Chưa có mã hãng
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-4">
                    <p className="font-extrabold text-slate-800 truncate" title={order.customerName}>
                      {order.customerName || '—'}
                    </p>
                    <p className="font-mono text-[11px] text-slate-600 mt-0.5">
                      {order.customerPhone || '—'}
                    </p>
                  </td>
                  <td className="p-4">
                    <p className="text-[11px] text-slate-600 leading-snug line-clamp-2" title={formatAddress(order)}>
                      {formatAddress(order)}
                    </p>
                  </td>
                  <td className="p-4 text-right">
                    <span className="font-black text-gray-950 text-sm">
                      {codOf(order).toLocaleString('vi-VN')}đ
                    </span>
                  </td>
                  <td className="p-4 text-center">
                    <span
                      className={`inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border ${meta.className}`}
                    >
                      {meta.label}
                    </span>
                  </td>
                  <td className="p-4 text-center">
                    <ExternalOrderActions
                      order={order}
                      busyKind={busyKind}
                      onPrintWaybill={onPrintWaybill}
                      onPrintInvoice={handlePrintSingleInvoice}
                      onSyncGhn={(o) => void runGhnAction(o, 'sync')}
                      onCancelGhn={(o) => void runGhnAction(o, 'cancel')}
                      onEditOrder={editOrder}
                      onDeleteOrder={(order) => void deleteOrder(order)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {renderMobileOrder && <div className="flex w-full flex-col gap-3 md:hidden">
        {orders.map((order) => {
          const provider = providerOf(order);
          const tn = trackingOf(order);
          const pos = isPosOrder(order);
          const st = resolveExternalStatus(order);
          const meta = STATUS_META[st];
          const key = orderKeyOf(order);
          const printBusy = printingOrderId === order.id || printingOrderId === order.orderSn;
          const rowBusy = actionKey === key;
          const busyKind = printBusy ? 'print' : rowBusy ? actionKind : null;
          const canPrintWaybill = !pos && provider !== 'self' && Boolean(tn);
          return renderMobileOrder(order, {
            waybill: pos ? '' : tn,
            channelLabel: pos ? 'POS' : 'Ngoài sàn',
            badge: <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${meta.className}`}>{meta.label}</span>,
            print: (
              <button
                type="button"
                disabled={Boolean(busyKind)}
                onClick={() => canPrintWaybill ? onPrintWaybill(order) : handlePrintSingleInvoice(order)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-2.5 text-[11px] font-bold text-blue-700 active:bg-blue-50 disabled:opacity-60"
              >
                {busyKind === 'print' || busyKind === 'invoice' ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
                {canPrintWaybill ? 'In phiếu' : 'In hóa đơn'}
              </button>
            ),
            details: (
              <div className="flex flex-wrap items-start justify-between gap-3 border-t border-slate-100 px-3 py-2.5">
                <div className="min-w-0 flex-1 space-y-1 text-xs text-slate-700">
                  <OrderTimeCell order={order} status={st} />
                  <p className="font-semibold">{order.customerName || '-'} · {order.customerPhone || '-'}</p>
                  <p>{formatAddress(order)}</p>
                  <p>Thu hộ: {codOf(order).toLocaleString('vi-VN')} đ</p>
                </div>
                <ExternalOrderActions
                  order={order}
                  busyKind={busyKind}
                  onPrintWaybill={onPrintWaybill}
                  onPrintInvoice={handlePrintSingleInvoice}
                  onSyncGhn={(o) => void runGhnAction(o, 'sync')}
                  onCancelGhn={(o) => void runGhnAction(o, 'cancel')}
                  onEditOrder={editOrder}
                  onDeleteOrder={(order) => void deleteOrder(order)}
                />
              </div>
            ),
          });
        })}
      </div>}
      </div>

      {editingOrder && <ExternalOrderContactDialog
        order={editingOrder}
        onClose={() => setEditingOrder(null)}
        onSaved={(order) => { setEditingOrder(null); onOrderEdited(order); }}
      />}

      {singlePrintOrder && typeof document !== 'undefined'
        ? createPortal(
            <div id="print-section" className="pos-invoice-reprint-host" aria-hidden="true">
              <PosInvoiceTemplate
                storeInfo={loadStoreInfo()}
                {...buildPosInvoiceFromOrder(singlePrintOrder)}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
