import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Printer, RefreshCw, Ban, Pencil, Trash2, Eye, X } from 'lucide-react';
import type { Order } from '../types';
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

async function postGhnOrderAction(path: string, order: Order): Promise<Record<string, unknown>> {
  const token = localStorage.getItem('admin_token') || '';
  const id = encodeURIComponent(String(order.id || order.orderSn || '').trim());
  const res = await fetch(`/api/orders/${id}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : '',
    },
    body: JSON.stringify({ orderSn: order.orderSn }),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || data?.success === false) {
    throw new Error(String(data?.message || data?.error || 'Thao tác GHN thất bại'));
  }
  return data;
}

async function saveExternalOrder(order: Order, contact?: FormData) {
  const token = localStorage.getItem('admin_token') || '';
  const response = await fetch(`/api/orders/external/${encodeURIComponent(orderKeyOf(order))}`, {
    method: contact ? 'PATCH' : 'DELETE',
    headers: { Authorization: `Bearer ${token}`, ...(contact ? { 'Content-Type': 'application/json' } : {}) },
    body: contact ? JSON.stringify(Object.fromEntries(contact)) : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    throw new Error(data?.message || data?.error || (contact ? 'Không lưu được đơn.' : 'Không xóa được đơn.'));
  }
  return data;
}

function ExternalOrderContactDialog({ order, onClose, onSaved }: {
  order: Order;
  onClose: () => void;
  onSaved: (order: Order) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const inputClass = 'block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm mt-1';
  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="external-order-contact-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
      className="m-auto w-[92vw] max-w-lg rounded-2xl bg-white p-5 text-slate-800 shadow-xl backdrop:bg-slate-950/50">
      <form className="space-y-3" onSubmit={async (event) => {
        event.preventDefault();
        if (saving) return;
        const contact = new FormData(event.currentTarget);
        setSaving(true); setError('');
        try {
          const result = await saveExternalOrder(order, contact);
          onSaved(result.order);
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Không lưu được đơn.');
          setSaving(false);
        }
      }}>
        <h2 id="external-order-contact-title" className="font-bold">Chỉnh sửa đơn {order.orderSn}</h2>
        {trackingOf(order) && providerOf(order) !== 'self' && <p className="text-xs text-slate-600">Thông tin chỉnh sửa chỉ áp dụng cho đơn trên phần mềm.</p>}
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
    </dialog>, document.body,
  );
}

function ExternalOrderDetailsDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const invoice = buildPosInvoiceFromOrder(order);
  const status = STATUS_META[resolveExternalStatus(order)];
  useEffect(() => { dialogRef.current?.showModal(); }, []);
  const money = (value: number) => value.toLocaleString('vi-VN') + ' đ';
  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="external-order-details-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      className="om-no-print m-auto max-h-[90dvh] w-[94vw] max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 text-slate-800 shadow-xl backdrop:bg-slate-950/50">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="external-order-details-title" className="break-words text-lg font-bold">Chi tiết đơn {order.orderSn || order.id}</h2>
          <span className={`mt-2 inline-block rounded-full border px-2.5 py-1 text-xs font-semibold ${status.className}`}>{status.label}</span>
        </div>
        <button type="button" onClick={onClose} title="Đóng" aria-label="Đóng chi tiết đơn" className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-offset-2">
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-2 break-words text-sm">
        <OrderTimeCell order={order} status={resolveExternalStatus(order)} />
        <p><strong>Khách hàng:</strong> {invoice.customerName}</p>
        <p><strong>Điện thoại:</strong> {invoice.customerPhone}</p>
        <p><strong>Địa chỉ:</strong> {invoice.customerAddress}</p>
        <p><strong>Mã vận đơn:</strong> {trackingOf(order) || 'Chưa có mã hãng'}</p>
      </div>
      <div className="my-4 overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-xs">
          <caption className="mb-2 text-left text-sm font-bold">Sản phẩm trong đơn</caption>
          <thead className="bg-slate-50"><tr>
            <th className="p-2">Sản phẩm</th><th className="p-2 text-right">SL</th>
            <th className="p-2 text-right">Đơn giá</th><th className="p-2 text-right">Thành tiền</th>
          </tr></thead>
          <tbody>{invoice.lines.length ? invoice.lines.map((line, index) => (
            <tr key={index} className="border-b border-slate-100">
              <td className="p-2">{line.productTitle}</td><td className="p-2 text-right">{line.quantity}</td>
              <td className="whitespace-nowrap p-2 text-right">{money(line.sellingPrice)}</td>
              <td className="whitespace-nowrap p-2 text-right font-semibold">{money(line.lineTotal)}</td>
            </tr>
          )) : <tr><td colSpan={4} className="p-3 text-center text-slate-500">Chưa có dòng hàng</td></tr>}</tbody>
        </table>
      </div>
      <dl className="ml-auto max-w-sm space-y-2 text-sm">
        <div className="flex justify-between gap-3"><dt>Tạm tính</dt><dd>{money(invoice.subtotal)}</dd></div>
        <div className="flex justify-between gap-3"><dt>Phí giao hàng</dt><dd>{money(invoice.shippingFee)}</dd></div>
        <div className="flex justify-between gap-3"><dt>Giảm giá</dt><dd>{money(invoice.discount)}</dd></div>
        <div className="flex justify-between gap-3"><dt>Đã trả trước</dt><dd>{money(invoice.prepaid)}</dd></div>
        <div className="flex justify-between gap-3 border-t pt-2 font-bold"><dt>Tiền thu hộ (COD)</dt><dd>{money(codOf(order))}</dd></div>
      </dl>
      {invoice.note && <p className="mt-4 whitespace-pre-wrap break-words text-sm"><strong>Ghi chú:</strong> {invoice.note}</p>}
    </dialog>, document.body,
  );
}

type ExternalAction = 'print' | 'invoice' | 'sync' | 'cancel' | 'delete';

function GhnActionButtons({
  order,
  busyKind,
  onPrintWaybill,
  onPrintInvoice,
  onSyncGhn,
  onCancelGhn,
  onEditOrder,
  onDeleteOrder,
  onViewOrder,
}: {
  order: Order;
  busyKind: 'print' | 'invoice' | 'sync' | 'cancel' | 'delete' | null;
  onPrintWaybill: (order: Order) => void;
  onPrintInvoice: (order: Order) => void;
  onSyncGhn: (order: Order) => void;
  onCancelGhn: (order: Order) => void;
  onViewOrder: (order: Order) => void;
  onEditOrder?: (order: Order) => void;
  onDeleteOrder?: (order: Order) => void;
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

  const iconClass = 'inline-flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 disabled:cursor-not-allowed';
  return (
    <div className="inline-grid grid-cols-4 items-center justify-items-center gap-1">
      <button type="button" onClick={() => onViewOrder(order)} title="Xem đơn" aria-label="Xem đơn" className={`${iconClass} text-sky-700 hover:bg-sky-50`}>
        <Eye className="size-4" aria-hidden="true" />
      </button>
      {(!pos || (st !== 'cancelled' && st !== 'rts')) && <button type="button" disabled={anyBusy} onClick={() => onEditOrder?.(order)} title="Sửa đơn" aria-label="Sửa đơn" className={`${iconClass} text-slate-600 hover:bg-slate-100`}>
        <Pencil className="size-4" aria-hidden="true" />
      </button>}
      <button type="button" disabled={anyBusy} onClick={() => onDeleteOrder?.(order)} title="Xóa đơn" aria-label="Xóa đơn" className={`${iconClass} text-rose-600 hover:bg-rose-50`}>
        {busyKind === 'delete' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        disabled={anyBusy}
        onClick={() => onPrintInvoice(order)}
        aria-label="In hóa đơn"
        className={`${iconClass} text-amber-600 hover:bg-amber-50`}
        title="In lại hóa đơn bán lẻ (POS) cho khách"
      >
        {invoiceBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Printer className="size-4" aria-hidden="true" />
        )}
      </button>
      {!pos && <>
      <button
        type="button"
        disabled={anyBusy || provider === 'self' || !tn}
        onClick={() => onPrintWaybill(order)}
        aria-label="In vận đơn"
        className={`${iconClass} text-blue-600 hover:bg-blue-50`}
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
      </button>
      <button
        type="button"
        disabled={anyBusy || !canGhn}
        onClick={() => onSyncGhn(order)}
        aria-label="Đồng bộ GHN"
        className={`${iconClass} text-emerald-600 hover:bg-emerald-50`}
        title={!canGhn ? 'Chỉ đồng bộ đơn GHN đã có mã vận đơn' : 'Lấy trạng thái mới nhất từ GHN'}
      >
        {syncBusy ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
      </button>
      <button
        type="button"
        disabled={anyBusy || !canCancel}
        onClick={() => onCancelGhn(order)}
        aria-label="Hủy vận chuyển"
        className={`${iconClass} text-rose-600 hover:bg-rose-50`}
        title={
          !canGhn
            ? 'Chỉ hủy vận đơn GHN'
            : st === 'cancelled'
              ? 'Đơn đã hủy'
              : 'Hủy đồng thời trên GHN và phần mềm'
        }
      >
        {cancelBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
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
  renderMobileOrder,
  onOrderDeleted,
}: {
  orders: Order[];
  printingOrderId: string | null;
  onPrintWaybill: (order: Order) => void;
  onOrderUpdated?: (order: Order) => void;
  onEditPosOrder?: (order: Order) => void;
  onOrderEdited?: (order: Order) => void;
  renderMobileOrder?: (order: Order, controls: MobileOrderCardControls) => React.ReactNode;
  onOrderDeleted?: (order: Order) => void;
}) {
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<ExternalAction | null>(null);
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [singlePrintOrder, setSinglePrintOrder] = useState<Order | null>(null);

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

  const editOrder = (order: Order) => {
    if (actionKey || printingOrderId) return;
    if (isPosOrder(order)) onEditPosOrder?.(order);
    else setEditingOrder(order);
  };

  const deleteOrder = async (order: Order) => {
    if (actionKey || printingOrderId) return;
    const hasWaybill = Boolean(trackingOf(order)) && providerOf(order) !== 'self';
    if (!window.confirm(`Xóa vĩnh viễn đơn ${order.orderSn || order.id} khỏi phần mềm?` +
      (hasWaybill ? '\nNếu cần hủy giao hàng, hãy hủy vận đơn với hãng trước khi xóa.' : '') +
      (isPosOrder(order) ? '\nNếu cần hoàn tồn, hãy điều chỉnh trong kho.' : ''))) return;
    setActionKey(orderKeyOf(order)); setActionKind('delete');
    try {
      await saveExternalOrder(order);
      onOrderDeleted?.(order);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Không xóa được đơn.');
    } finally { setActionKey(null); setActionKind(null); }
  };

  const runGhnAction = async (order: Order, kind: 'sync' | 'cancel') => {
    const key = orderKeyOf(order);
    if (!key || actionKey) return;
    if (kind === 'cancel') {
      const ok = window.confirm(
        'Hủy đơn vận chuyển trên GHN và đổi trạng thái Đã hủy trên phần mềm?',
      );
      if (!ok) return;
    }
    setActionKey(key);
    setActionKind(kind);
    try {
      const path = kind === 'sync' ? 'sync-ghn' : 'cancel-ghn';
      const data = await postGhnOrderAction(path, order);
      const updated = (data.order || null) as Order | null;
      if (updated && onOrderUpdated) onOrderUpdated(updated);
      const msg = String(data.message || (kind === 'sync' ? 'Đã đồng bộ GHN' : 'Đã hủy đơn GHN'));
      window.alert(msg);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Thao tác GHN thất bại';
      window.alert(msg);
    } finally {
      setActionKey(null);
      setActionKind(null);
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
              <th className="p-4 w-48">Mã vận đơn</th>
              <th className="p-4 w-44">Khách hàng</th>
              <th className="p-4">Địa chỉ</th>
              <th className="p-4 text-right w-32">Tiền thu hộ (COD)</th>
              <th className="p-4 text-center w-40">Trạng thái</th>
              <th className="p-4 text-center w-52 min-w-52">Thao tác</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {orders.map((order) => {
              const provider = providerOf(order);
              const tn = trackingOf(order);
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
                      <ProviderBadge provider={provider} />
                      {tn ? (
                        <span className="font-mono font-extrabold text-gray-900 text-sm tracking-tight truncate max-w-[10rem]">
                          {tn}
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
                    <GhnActionButtons
                      order={order}
                      busyKind={busyKind}
                      onPrintWaybill={onPrintWaybill}
                      onPrintInvoice={handlePrintSingleInvoice}
                      onSyncGhn={(o) => void runGhnAction(o, 'sync')}
                      onCancelGhn={(o) => void runGhnAction(o, 'cancel')}
                      onViewOrder={setViewingOrder}
                      onEditOrder={editOrder}
                      onDeleteOrder={(o) => void deleteOrder(o)}
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
                title={canPrintWaybill ? 'In vận đơn' : 'In hóa đơn'}
                aria-label={canPrintWaybill ? 'In vận đơn' : 'In hóa đơn'}
                className="inline-flex size-10 items-center justify-center rounded-lg text-blue-700 active:bg-blue-50 disabled:opacity-60"
              >
                {busyKind === 'print' || busyKind === 'invoice' ? <Loader2 className="size-4 animate-spin" /> : <Printer className="size-4" />}
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
                <GhnActionButtons
                  order={order}
                  busyKind={busyKind}
                  onPrintWaybill={onPrintWaybill}
                  onPrintInvoice={handlePrintSingleInvoice}
                  onSyncGhn={(o) => void runGhnAction(o, 'sync')}
                  onCancelGhn={(o) => void runGhnAction(o, 'cancel')}
                  onViewOrder={setViewingOrder}
                      onEditOrder={editOrder}
                  onDeleteOrder={(order) => void deleteOrder(order)}
                />
              </div>
            ),
          });
        })}
      </div>}
      </div>

      {viewingOrder && <ExternalOrderDetailsDialog order={viewingOrder} onClose={() => setViewingOrder(null)} />}
      {editingOrder && <ExternalOrderContactDialog order={editingOrder} onClose={() => setEditingOrder(null)} onSaved={(order) => { setEditingOrder(null); onOrderEdited?.(order); }} />}
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

