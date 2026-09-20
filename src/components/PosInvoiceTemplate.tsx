import React from 'react';
import type { Order } from '../types';

export type StoreInvoiceInfo = {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  logoUrl: string;
};

export type PosInvoiceLine = {
  productTitle: string;
  quantity: number;
  sellingPrice: number;
  lineTotal: number;
};

export const STORE_INFO_LS_KEY = 'pos_invoice_store_info';

export const EMPTY_STORE_INFO: StoreInvoiceInfo = {
  storeName: '',
  storePhone: '',
  storeAddress: '',
  logoUrl: '',
};

export function loadStoreInfo(): StoreInvoiceInfo {
  try {
    const raw = localStorage.getItem(STORE_INFO_LS_KEY);
    if (!raw) return { ...EMPTY_STORE_INFO };
    const parsed = JSON.parse(raw) as Partial<StoreInvoiceInfo>;
    return {
      storeName: String(parsed.storeName || ''),
      storePhone: String(parsed.storePhone || ''),
      storeAddress: String(parsed.storeAddress || ''),
      logoUrl: String(parsed.logoUrl || ''),
    };
  } catch {
    return { ...EMPTY_STORE_INFO };
  }
}

export function saveStoreInfo(info: StoreInvoiceInfo) {
  try {
    localStorage.setItem(STORE_INFO_LS_KEY, JSON.stringify(info));
  } catch {
    /* ignore quota / private mode */
  }
}

export function formatVnd(n: number): string {
  return Math.round(n || 0).toLocaleString('vi-VN');
}

function formatOrderAddress(order: Order): string {
  if (order.walk_in) return 'Mua tại cửa hàng';
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

export function buildPosInvoiceFromOrder(order: Order): {
  orderSn: string;
  dateText: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  lines: PosInvoiceLine[];
  subtotal: number;
  shippingFee: number;
  prepaid: number;
  amountDue: number;
} {
  const lines: PosInvoiceLine[] = (order.items || []).map((it) => {
    const sellingPrice = Number(it.price ?? it.sellingPrice) || 0;
    const quantity = Number(it.quantity) || 0;
    return {
      productTitle: String(it.productTitle || it.modelName || 'Sản phẩm'),
      quantity,
      sellingPrice,
      lineTotal: sellingPrice * quantity,
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const raw = order as Record<string, unknown>;
  const shippingFee =
    Number(order.estimated_shipping_fee ?? raw.shippingFee ?? raw.shipping_fee) || 0;
  const prepaid = Number(order.prepaid_amount ?? order.prepaidAmount) || 0;
  const total = Number(order.totalAmount) || 0;
  let dateText = new Date().toLocaleString('vi-VN');
  try {
    if (order.date) dateText = new Date(order.date).toLocaleString('vi-VN');
  } catch {
    /* keep now */
  }
  const walkIn = order.walk_in === true;
  return {
    orderSn: String(order.orderSn || order.id || '—'),
    dateText,
    customerName:
      String(order.customerName || '').trim() || (walkIn ? 'Khách tại cửa hàng' : '—'),
    customerPhone: String(order.customerPhone || '').trim() || '—',
    customerAddress: formatOrderAddress(order),
    lines,
    subtotal,
    shippingFee,
    prepaid,
    amountDue: Math.max(0, total - prepaid),
  };
}

export function PosInvoiceTemplate({
  storeInfo,
  orderSn,
  dateText,
  customerName,
  customerPhone,
  customerAddress,
  lines,
  subtotal,
  shippingFee,
  prepaid,
  amountDue,
  className,
}: {
  storeInfo: StoreInvoiceInfo;
  orderSn: string;
  dateText: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  lines: PosInvoiceLine[];
  subtotal: number;
  shippingFee: number;
  prepaid: number;
  amountDue: number;
  className?: string;
}) {
  return (
    <div
      id="pos-invoice"
      className={`print-invoice-container rounded-2xl border border-dashed border-slate-200 bg-white p-6 ${className || ''}`}
    >
      <div className="relative mb-5 pb-4 border-b border-slate-300">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4 min-w-0 flex-1">
            {storeInfo.logoUrl.trim() ? (
              <img
                src={storeInfo.logoUrl.trim()}
                alt="Logo cửa hàng"
                className="h-16 w-16 object-contain flex-shrink-0"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : null}
            <div className="min-w-0">
              <div className="text-base font-black tracking-wide uppercase text-slate-900">
                {storeInfo.storeName.trim() || 'CỬA HÀNG'}
              </div>
              {storeInfo.storePhone.trim() ? (
                <div className="text-xs text-slate-600 mt-0.5">
                  <span className="font-bold">ĐT:</span> {storeInfo.storePhone.trim()}
                </div>
              ) : null}
              {storeInfo.storeAddress.trim() ? (
                <div className="text-xs text-slate-600 mt-0.5">
                  <span className="font-bold">Địa chỉ:</span> {storeInfo.storeAddress.trim()}
                </div>
              ) : null}
            </div>
          </div>
          <div className="text-right text-[11px] text-slate-600 font-semibold flex-shrink-0 leading-snug">
            <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">
              Thời gian tạo đơn
            </div>
            <div>{dateText}</div>
            <div className="mt-0.5">{orderSn}</div>
          </div>
        </div>
        <div className="text-center font-bold text-xl uppercase tracking-wide text-slate-900 mt-3">
          HÓA ĐƠN BÁN HÀNG
        </div>
      </div>

      <div className="text-xs mb-4 space-y-1 pb-3 border-b border-slate-200">
        <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500 mb-1">
          Người nhận / Khách hàng
        </div>
        <div>
          <span className="font-bold">Khách:</span> {customerName}
        </div>
        <div>
          <span className="font-bold">SĐT:</span> {customerPhone}
        </div>
        <div>
          <span className="font-bold">Địa chỉ:</span> {customerAddress}
        </div>
      </div>

      <div className="text-center font-bold uppercase mt-4 mb-2">DANH SÁCH ĐƠN HÀNG</div>

      <table className="w-full text-xs border-collapse table-fixed">
        <thead>
          <tr className="border-b-2 border-slate-800">
            <th className="col-stt w-12 px-2 py-2 text-left font-bold border-x border-gray-400">STT</th>
            <th className="col-name px-2 py-2 text-left font-bold border-x border-gray-400">Sản phẩm</th>
            <th className="col-qty w-16 px-2 py-2 text-right font-bold border-x border-gray-400">SL</th>
            <th className="col-price w-24 px-2 py-2 text-right font-bold border-x border-gray-400">Đơn giá</th>
            <th className="col-total w-28 px-2 py-2 text-right font-bold border-x border-gray-400">Thành tiền</th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-2 py-4 text-center text-slate-400 border-x border-gray-400">
                Chưa có dòng hàng
              </td>
            </tr>
          ) : (
            lines.map((l, i) => (
              <tr key={i} className="border-b border-slate-200">
                <td className="col-stt w-12 px-2 py-1.5 text-left align-top text-slate-600 border-x border-gray-400">{i + 1}</td>
                <td className="col-name px-2 py-1.5 text-left align-top break-words border-x border-gray-400">{l.productTitle}</td>
                <td className="col-qty w-16 px-2 py-1.5 text-right align-top tabular-nums border-x border-gray-400">{l.quantity}</td>
                <td className="col-price w-24 px-2 py-1.5 text-right align-top tabular-nums border-x border-gray-400">
                  {formatVnd(l.sellingPrice)}
                </td>
                <td className="col-total w-28 px-2 py-1.5 text-right align-top font-bold tabular-nums border-x border-gray-400">
                  {formatVnd(l.lineTotal)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="invoice-totals mt-4 text-xs space-y-1 max-w-xs ml-auto">
        <div className="flex justify-between gap-4 px-2">
          <span>Tạm tính</span>
          <span className="font-bold tabular-nums">{formatVnd(subtotal)}₫</span>
        </div>
        <div className="flex justify-between gap-4 px-2">
          <span>Phí giao ước tính</span>
          <span className="font-bold tabular-nums">{formatVnd(shippingFee)}₫</span>
        </div>
        <div className="flex justify-between gap-4 px-2">
          <span>Đã trả trước</span>
          <span className="font-bold tabular-nums">{formatVnd(prepaid)}₫</span>
        </div>
        <div className="flex justify-between gap-4 border-t border-slate-800 pt-2 px-2 text-sm font-black">
          <span>Tổng thanh toán</span>
          <span className="tabular-nums">{formatVnd(amountDue)}₫</span>
        </div>
      </div>
    </div>
  );
}
