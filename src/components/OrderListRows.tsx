import React from 'react';
import {
  Barcode,
  Check,
  CheckCircle2,
  ChevronDown,
  ImageIcon,
  Loader2,
  Package,
  Printer,
  RefreshCw,
  Truck,
  X,
  XCircle,
} from 'lucide-react';
import type { ConnectedShop, Order, SystemFee } from '../types';
import {
  isEligibleForHandOverToCarrier,
  isOrderHandedOverToCarrier,
  isOrderPreparedEffective,
  isOrderPrintedEffective,
  isProcessedCondition,
  isShopeeReadyToShipStatus,
  matchesProcessedPickupTab,
} from '../utils/orderHandover';
import { isWarehouseReturnReceived } from '../utils/orderLocalStatus';
import { getCarrierWaybillDisplay } from '../utils/orderTracking';
import { resolveOrderShopDisplayName } from '../utils/resolveOrderShopName';
import {
  getShopeeItemAmount,
  getShopeeNetRevenue,
  isShopeeEscrowSynced,
} from '../utils/shopeeFees';

export type OrderListRowBadge = { text: string; color: string };

export type OrderListRowActions = {
  onToggleSelect: (id: string) => void;
  onToggleDetails: (id: string) => void;
  onPrint: (e: React.MouseEvent, order: Order) => void;
  onPrepare: (order: Order) => void;
  onHandOver: (order: Order) => void | Promise<void>;
  onMarkPrinted: (orders: Order[]) => void;
  onResetPrint: (orders: Order[]) => void;
  onWooAction: (order: Order, action: 'completed' | 'on-hold') => void | Promise<void>;
  onConfirmReturn: (order: Order) => void;
  onPatchStatus: (order: Order, status: Order['status'], logMessage?: string) => void;
};

type SharedRowProps = {
  order: Order;
  isChecked: boolean;
  isExpanded: boolean;
  badge: OrderListRowBadge;
  activeSubTab: string;
  shops: ConnectedShop[];
  systemFees: SystemFee[];
  printingOrderId: string | null;
  handingOverOrderId: string | null;
  wooActionLoadingId: string | null;
  confirmingReturn: boolean;
  resettingPrint: boolean;
  actions: OrderListRowActions;
  renderDetails: (order: Order) => React.ReactNode;
};

function getOrderWaybillCode(order: Order): string {
  const fromHelper = getCarrierWaybillDisplay(order);
  if (fromHelper) return fromHelper;
  const note = String((order as { note?: string }).note || '').trim();
  const fromNote = note.startsWith('scan:') ? note.slice(5).trim() : '';
  const fallback = String(
    order.trackingNumber ||
      order.tracking_no ||
      order.returnTrackingNumber ||
      order.return_tracking_no ||
      (order as { scan_code?: string }).scan_code ||
      fromNote ||
      '',
  ).trim();
  if (fallback && !/^0FG/i.test(fallback) && fallback !== String(order.orderSn || '')) {
    return fallback;
  }
  return '';
}

function AwaitingShopeeTrackingBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-50 text-orange-700 border border-orange-200 ${className}`}
    >
      Đang chờ Shopee cấp mã
    </span>
  );
}

function calculateDynamicFeeItems(itemAmount: number, systemFees: SystemFee[]) {
  return systemFees
    .filter((fee) => fee.active && fee.name.trim() && Number(fee.value) > 0)
    .map((fee) => ({
      ...fee,
      amount:
        fee.calculationType === 'percentage'
          ? Math.round((itemAmount * Number(fee.value)) / 100)
          : Math.round(Number(fee.value)),
    }));
}

function formatOrderNetRevenueDisplay(
  order: Order,
  systemFees: SystemFee[] = [],
): { text: string; pending: boolean } {
  const pending = order.channel === 'shopee' && !isShopeeEscrowSynced(order);
  const itemAmount = getShopeeItemAmount(order);
  const amount = pending
    ? Math.max(
        0,
        itemAmount - calculateDynamicFeeItems(itemAmount, systemFees).reduce((sum, fee) => sum + fee.amount, 0),
      )
    : getShopeeNetRevenue(order);
  return { text: `${amount.toLocaleString('vi-VN')}đ`, pending };
}

function shopChannelClass(channel: Order['channel']): string {
  if (channel === 'shopee') return 'bg-orange-50 text-orange-700 border border-orange-200';
  if (channel === 'tiktok') return 'bg-zinc-100 text-zinc-800 border border-zinc-200';
  if (channel === 'woocommerce') return 'bg-indigo-50 text-indigo-700 border border-indigo-200';
  return 'bg-blue-50 text-blue-700 border border-blue-200';
}

function ReturnWarehouseStatusBlock({
  order,
  confirming,
  onConfirm,
  compact,
}: {
  order: Order;
  confirming: boolean;
  onConfirm: (order: Order) => void;
  compact?: boolean;
}) {
  const received = isWarehouseReturnReceived(order);
  return (
    <div className={`flex flex-col ${compact ? 'items-end' : 'items-center'} gap-1.5`}>
      <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-indigo-50 text-indigo-600 border-indigo-200/60">
        Đang hoàn về
      </span>
      {received ? (
        <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
          Đã nhận hàng hoàn
        </span>
      ) : (
        <>
          <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-orange-50 text-orange-800 border-orange-300">
            Chưa nhận được hàng hoàn
          </span>
          <button
            type="button"
            disabled={confirming}
            onClick={() => onConfirm(order)}
            className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-60"
          >
            {confirming ? 'Đang xác nhận...' : 'Xác nhận đã nhận hoàn'}
          </button>
        </>
      )}
    </div>
  );
}

function resolveWooCustomerInfo(order: Order): { name: string; phone: string; address: string } {
  const o = order as Order & {
    customer_name?: string;
    customer_phone?: string;
    billing?: { first_name?: string; last_name?: string; phone?: string; address_1?: string };
    shipping?: { first_name?: string; last_name?: string; phone?: string; address_1?: string };
  };
  const billing = o.billing && typeof o.billing === 'object' ? o.billing : {};
  const shipping = o.shipping && typeof o.shipping === 'object' && !Array.isArray(o.shipping) ? o.shipping : {};
  const name =
    [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim() ||
    [shipping.first_name, shipping.last_name].filter(Boolean).join(' ').trim() ||
    String(order.customerName || o.customer_name || '').trim() ||
    'Khách hàng';
  const phone = String(billing.phone || shipping.phone || order.customerPhone || o.customer_phone || '').trim();
  const address = String(billing.address_1 || shipping.address_1 || '').trim();
  return { name, phone, address };
}

function OrderItemsCell({ order, compactTitle }: { order: Order; compactTitle?: boolean }) {
  return (
    <div className="space-y-2">
      {(order.items || []).map((item, idx) => {
        const itemTitle = item.productTitle || (item as { name?: string }).name || 'Sản phẩm';
        return (
          <div key={idx} className="flex items-center gap-2">
            {item.productImage ? (
              <img
                src={item.productImage}
                alt={itemTitle}
                className="w-10 h-10 rounded-lg object-cover border border-gray-200 shrink-0 bg-gray-50"
              />
            ) : (
              <div className="w-10 h-10 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center shrink-0">
                <ImageIcon className="w-4 h-4 text-gray-300" />
              </div>
            )}
            <div className={compactTitle ? 'flex-1 min-w-0 flex justify-between items-start gap-2' : 'min-w-0'}>
              {compactTitle ? (
                <>
                  <span className="truncate text-[11px] font-medium leading-tight text-gray-700">{itemTitle}</span>
                  <span className="text-blue-600 text-xs shrink-0 font-black">x{item.quantity}</span>
                </>
              ) : (
                <>
                  <p className="text-[11px] text-gray-700 font-semibold leading-snug line-clamp-2" title={itemTitle}>
                    {itemTitle}
                  </p>
                  <span className="text-[9px] bg-blue-50 text-blue-600 border border-blue-100 px-1 py-0.2 rounded font-extrabold inline-block mt-0.5">
                    x{item.quantity}
                  </span>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const OrderTableRow = React.memo(function OrderTableRow({
  order,
  isChecked,
  isExpanded,
  badge,
  activeSubTab,
  shops,
  systemFees,
  printingOrderId,
  handingOverOrderId,
  wooActionLoadingId,
  confirmingReturn,
  resettingPrint,
  actions,
  renderDetails,
}: SharedRowProps) {
  const shopName = resolveOrderShopDisplayName(order, shops);
  const waybill = getOrderWaybillCode(order);
  const revenue = formatOrderNetRevenueDisplay(order, systemFees);
  const refundAmt =
    Number(order.refund_amount) > 0 ? Number(order.refund_amount) : Number(order.totalAmount) || 0;
  const returnReason = String(order.text_reason || order.return_reason || '').trim() || '—';
  const wooKey = order.id || order.orderSn;
  const cust = activeSubTab === 'web_orders' || order.channel === 'woocommerce' ? resolveWooCustomerInfo(order) : null;
  const showHandover =
    (isEligibleForHandOverToCarrier(order) ||
      (matchesProcessedPickupTab(order) && Boolean(waybill))) &&
    !isOrderHandedOverToCarrier(order);
  const printed = isOrderPrintedEffective(order);

  return (
    <React.Fragment>
      <tr className={`hover:bg-slate-50/40 transition-all ${isChecked ? 'bg-blue-50/20' : ''}`}>
        <td className="p-4 text-center">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => actions.onToggleSelect(order.id)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
          />
        </td>

        {activeSubTab === 'return_requests' ? (
          <>
            <td className="p-4">
              <div className="font-mono font-extrabold text-gray-900 text-sm">#{order.orderSn}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">{shopName}</div>
            </td>
            <td className="p-4">
              <div className="font-mono font-bold text-orange-700 text-xs break-all">{order.return_sn || '—'}</div>
            </td>
            <td className="p-4 w-[260px]">
              <OrderItemsCell order={order} />
            </td>
            <td className="p-4 text-right">
              <div className="font-black text-rose-700 text-sm">{refundAmt.toLocaleString('vi-VN')}đ</div>
            </td>
            <td className="p-4">
              <p className="text-[11px] text-slate-700 font-medium leading-snug line-clamp-3" title={returnReason}>
                {returnReason}
              </p>
            </td>
            <td className="p-4 text-center">
              <ReturnWarehouseStatusBlock
                order={order}
                confirming={confirmingReturn}
                onConfirm={actions.onConfirmReturn}
              />
            </td>
            <td className="p-4">
              {order.return_tracking_no || order.returnTrackingNumber ? (
                <div
                  className="font-mono font-extrabold text-gray-900 text-sm tracking-tight flex items-center gap-1"
                  title={order.return_tracking_no || order.returnTrackingNumber}
                >
                  <Barcode className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="truncate max-w-[180px]">
                    {order.return_tracking_no || order.returnTrackingNumber}
                  </span>
                </div>
              ) : (
                <span className="text-xs text-gray-400 italic font-medium">Chưa có mã VĐ hoàn</span>
              )}
            </td>
          </>
        ) : (
          <>
            <td className="p-4 space-y-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`px-2 py-0.5 text-[10px] font-bold rounded truncate max-w-[11rem] inline-block ${shopChannelClass(order.channel)}`}
                  title={shopName}
                >
                  {shopName}
                </span>
              </div>
              {waybill ? (
                <div
                  className="font-mono font-extrabold text-gray-900 text-sm tracking-tight flex items-center gap-1"
                  title={waybill}
                >
                  <Barcode className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="truncate max-w-[160px]">{waybill}</span>
                </div>
              ) : order.channel === 'woocommerce' ? (
                <span className="text-[10px] text-indigo-600 font-semibold italic">Web order</span>
              ) : (
                <AwaitingShopeeTrackingBadge />
              )}
              <div className="text-[10px] text-gray-400 font-mono">#{order.orderSn}</div>
            </td>
            <td className="p-4 text-gray-500 font-medium">
              {new Date(order.date).toLocaleDateString('vi-VN')}
              <p className="text-[10px] text-gray-400 font-mono mt-0.5">
                {new Date(order.date).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </td>
            <td className="p-4 w-[280px]">
              <OrderItemsCell order={order} />
            </td>
            <td className="p-4 text-right space-y-0.5">
              <div className="font-black text-gray-950 text-sm">{order.totalAmount.toLocaleString('vi-VN')}đ</div>
              <div
                className={`text-[10px] font-bold p-0.5 px-1.5 rounded-md inline-block ${
                  revenue.pending ? 'text-amber-700 bg-amber-50/80' : 'text-emerald-600 bg-emerald-50/50'
                }`}
              >
                Lãi: {revenue.text}
                {revenue.pending && <span className="text-[9px] font-normal text-amber-700/80 ml-0.5">*</span>}
              </div>
            </td>
            <td className="p-4 text-center">
              {activeSubTab === 'processed' ? (
                <button
                  type="button"
                  onClick={(e) => actions.onPrint(e, order)}
                  disabled={!order.hasPdf || printingOrderId === order.id}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 font-bold text-[10px] rounded-lg transition-all border ${
                    !order.hasPdf
                      ? 'bg-gray-300 text-gray-600 border-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-700 disabled:opacity-60'
                  }`}
                  title={!order.hasPdf ? 'Đang tải file in...' : 'In đơn này'}
                >
                  <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                  In nhanh
                </button>
              ) : (
                <>
                  <span className={`inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border ${badge.color}`}>
                    {badge.text}
                  </span>
                  {activeSubTab === 'received_cancel_returns' && (
                    <span className="inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border bg-teal-50 text-teal-700 border-teal-200">
                      Đã nhận hoàn
                    </span>
                  )}
                </>
              )}
            </td>
            <td className="p-4 text-center">
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {cust && (
                  <>
                    <div className="w-full text-left mb-1.5 space-y-0.5 px-1">
                      <p className="text-[11px] font-extrabold text-slate-800 truncate" title={cust.name}>
                        {cust.name}
                      </p>
                      <p className="text-[10px] font-mono text-slate-600">{cust.phone || '—'}</p>
                      <p className="text-[9px] text-slate-500 line-clamp-2 leading-snug" title={cust.address}>
                        {cust.address || '—'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={wooActionLoadingId === wooKey || order.status === 'completed'}
                      onClick={() => void actions.onWooAction(order, 'completed')}
                      className="px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 inline-flex items-center gap-1"
                      title="Đánh dấu đã xử lý / completed"
                    >
                      {wooActionLoadingId === wooKey ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      Đã xử lý
                    </button>
                    <button
                      type="button"
                      disabled={wooActionLoadingId === wooKey || order.status === 'cancelled'}
                      onClick={() => void actions.onWooAction(order, 'on-hold')}
                      className="px-2.5 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-50 inline-flex items-center gap-1"
                      title="Ngưng xử lý / on-hold"
                    >
                      {wooActionLoadingId === wooKey ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <XCircle className="w-3 h-3" />
                      )}
                      Ngưng xử lý
                    </button>
                  </>
                )}

                {order.status === 'pending_confirm' && order.channel !== 'woocommerce' && (
                  <button
                    type="button"
                    onClick={() =>
                      actions.onPatchStatus(order, 'unprocessed', `Xác nhận thành công đơn hàng #${order.orderSn}`)
                    }
                    className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg transition-all"
                  >
                    Xác nhận đơn
                  </button>
                )}

                {isShopeeReadyToShipStatus(order) && !isProcessedCondition(order) && (
                  <>
                    {!isOrderPreparedEffective(order) ? (
                      <button
                        type="button"
                        onClick={() => actions.onPrepare(order)}
                        className="om-mobile-hide-prepare px-2.5 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-bold text-[10px] rounded-lg transition-all"
                      >
                        Chuẩn bị hàng
                      </button>
                    ) : (
                      <span className="om-mobile-hide-prepare text-[10px] text-emerald-600 font-bold bg-emerald-50 px-1.5 py-1 rounded">
                        ✓ Đã chuẩn bị
                      </span>
                    )}
                  </>
                )}

                {showHandover && (
                  <>
                    <span
                      className={`om-mobile-hide-print text-[10px] font-bold px-1.5 py-1 rounded ${
                        printed ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'
                      }`}
                    >
                      {printed ? '✓ Đã in' : '✕ Chưa in'}
                    </span>
                    {printed ? (
                      <button
                        type="button"
                        onClick={() => void actions.onResetPrint([order])}
                        disabled={resettingPrint}
                        className="om-mobile-hide-print text-[10px] font-bold px-1.5 py-1 rounded border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        title="Đánh dấu chưa in để in lại"
                      >
                        Đánh dấu chưa in
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void actions.onMarkPrinted([order])}
                        disabled={resettingPrint}
                        className="om-mobile-hide-print text-[10px] font-bold px-1.5 py-1 rounded border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        title="Đánh dấu đã in (nội bộ)"
                      >
                        Đánh dấu đã in
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => actions.onPrint(e, order)}
                      disabled={printingOrderId === order.id}
                      className="om-mobile-hide-print p-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-500 rounded-lg transition-all disabled:opacity-60"
                      title="In lại vận đơn (vận đơn thật Shopee)"
                    >
                      <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void actions.onHandOver(order)}
                      disabled={handingOverOrderId === order.id}
                      className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-60"
                    >
                      {handingOverOrderId === order.id ? 'Đang xử lý...' : 'Giao cho ĐVVC'}
                    </button>
                  </>
                )}

                {activeSubTab !== 'return_requests' && order.status === 'shipping' && (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => actions.onPatchStatus(order, 'completed')}
                      className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[10px] rounded"
                    >
                      Thắng
                    </button>
                    <button
                      type="button"
                      onClick={() => actions.onPatchStatus(order, 'return_pending')}
                      className="px-2 py-1 bg-rose-500 hover:bg-rose-600 text-white font-semibold text-[10px] rounded animate-pulse"
                    >
                      Bị Hoàn
                    </button>
                  </div>
                )}

                {activeSubTab !== 'return_requests' && order.status === 'return_pending' && (
                  <button
                    type="button"
                    onClick={() =>
                      actions.onPatchStatus(
                        order,
                        'return_received',
                        `Bấm nút nhận hàng hoàn trả cho đơn ${order.orderSn}.`,
                      )
                    }
                    className="px-2 py-1 bg-purple-600 hover:bg-purple-700 text-white font-bold text-[10px] rounded"
                  >
                    Nhận Hoàn
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => actions.onToggleDetails(order.id)}
                  className={`p-1.5 rounded-lg transition-all ${isExpanded ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-100 text-gray-500'}`}
                  title={isExpanded ? 'Ẩn chi tiết đơn' : 'Xem chi tiết đơn'}
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                </button>
              </div>
            </td>
          </>
        )}
      </tr>
      {isExpanded && (
        <tr className="bg-slate-50/60">
          <td colSpan={activeSubTab === 'return_requests' ? 8 : 7} className="p-0">
            {renderDetails(order)}
          </td>
        </tr>
      )}
    </React.Fragment>
  );
});

export const OrderCardRow = React.memo(function OrderCardRow({
  order,
  isChecked,
  isExpanded,
  badge,
  activeSubTab,
  shops,
  systemFees,
  printingOrderId,
  handingOverOrderId,
  wooActionLoadingId,
  confirmingReturn,
  resettingPrint,
  actions,
  renderDetails,
}: SharedRowProps) {
  const shopName = resolveOrderShopDisplayName(order, shops);
  const waybill = getOrderWaybillCode(order);
  const revenue = formatOrderNetRevenueDisplay(order, systemFees);
  const wooKey = order.id || order.orderSn;
  const cust = activeSubTab === 'web_orders' || order.channel === 'woocommerce' ? resolveWooCustomerInfo(order) : null;
  const showHandover =
    (isEligibleForHandOverToCarrier(order) ||
      (matchesProcessedPickupTab(order) && Boolean(waybill))) &&
    !isOrderHandedOverToCarrier(order);
  const printed = isOrderPrintedEffective(order);

  return (
    <div className={`w-full transition-colors ${isChecked ? 'bg-blue-50/20' : 'bg-white'}`}>
      <div className="om-order-card-row flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4 p-4 w-full">
        <div className="flex items-center gap-2 shrink-0 lg:min-w-[11rem]">
          <input
            type="checkbox"
            checked={isChecked}
            onChange={() => actions.onToggleSelect(order.id)}
            className="om-mobile-hide-checkbox w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={`px-2 py-0.5 text-[10px] font-bold rounded truncate max-w-44 inline-block shrink-0 ${shopChannelClass(order.channel)}`}
                title={shopName}
              >
                {shopName}
              </span>
            </div>
            {waybill ? (
              <p className="font-mono font-extrabold text-gray-900 text-sm truncate mt-0.5 flex items-center gap-1" title={waybill}>
                <Barcode className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span className="truncate">{waybill}</span>
              </p>
            ) : order.channel === 'woocommerce' ? (
              <p className="text-[10px] text-indigo-600 font-semibold italic mt-0.5">Web order</p>
            ) : (
              <p className="mt-0.5">
                <AwaitingShopeeTrackingBadge />
              </p>
            )}
            <p className="text-[10px] text-gray-400 font-mono mt-0.5">#{order.orderSn}</p>
            <p className="text-[11px] text-gray-500 font-medium mt-0.5">
              {new Date(order.date).toLocaleDateString('vi-VN')}
            </p>
            <button
              type="button"
              onClick={() => actions.onToggleDetails(order.id)}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-700 transition-colors"
              title={isExpanded ? 'Ẩn chi tiết đơn' : 'Xem chi tiết đơn'}
            >
              <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              {isExpanded ? 'Ẩn chi tiết' : 'Xem chi tiết đơn'}
            </button>
          </div>
        </div>

        <div className="flex-1 min-w-0 bg-slate-50/80 px-2.5 py-2 rounded-xl border border-slate-100">
          <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1">Sản phẩm đặt mua</div>
          <OrderItemsCell order={order} compactTitle />
        </div>

        <div className="flex flex-wrap items-center gap-3 lg:gap-4 shrink-0 lg:ml-auto">
          <div className="flex flex-col gap-2">
            <div className="text-xs">
              <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Tổng thanh toán</span>
              <span className="font-black text-slate-900 text-sm whitespace-nowrap">
                {order.totalAmount.toLocaleString('vi-VN')} đ
              </span>
            </div>
            <div className="text-xs">
              <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Tổng nhận được</span>
              <span
                className={`font-black text-sm whitespace-nowrap ${revenue.pending ? 'text-amber-700' : 'text-emerald-700'}`}
              >
                {revenue.text}
                {revenue.pending && (
                  <span className="block text-[9px] font-medium text-amber-600/90 mt-0.5">Chưa gồm phí Shopee</span>
                )}
              </span>
            </div>
          </div>

          {activeSubTab === 'processed' ? (
            <button
              type="button"
              onClick={(e) => actions.onPrint(e, order)}
              disabled={!order.hasPdf || printingOrderId === order.id}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 font-bold text-[10px] rounded-lg transition-all border shrink-0 ${
                !order.hasPdf
                  ? 'bg-gray-300 text-gray-600 border-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-700 disabled:opacity-60'
              }`}
              title={!order.hasPdf ? 'Đang tải file in...' : 'In đơn này'}
            >
              <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
              In nhanh
            </button>
          ) : activeSubTab === 'return_requests' ? (
            <ReturnWarehouseStatusBlock
              order={order}
              compact
              confirming={confirmingReturn}
              onConfirm={actions.onConfirmReturn}
            />
          ) : (
            <>
              <span className={`inline-block px-2 py-0.5 text-[9px] font-black rounded-full border shrink-0 ${badge.color}`}>
                {badge.text}
              </span>
              {activeSubTab === 'received_cancel_returns' && (
                <span className="inline-block px-2 py-0.5 text-[9px] font-black rounded-full border shrink-0 bg-teal-50 text-teal-700 border-teal-200">
                  Đã nhận hoàn
                </span>
              )}
            </>
          )}

          <div className="flex items-center gap-1 flex-wrap justify-end">
            {cust && (
              <>
                <div className="w-full text-left mb-1.5 px-1 space-y-0.5">
                  <p className="text-[11px] font-extrabold text-slate-800 truncate">{cust.name}</p>
                  <p className="text-[10px] font-mono text-slate-600">{cust.phone || '—'}</p>
                  <p className="text-[9px] text-slate-500 line-clamp-2 leading-snug">{cust.address || '—'}</p>
                </div>
                <button
                  type="button"
                  disabled={wooActionLoadingId === wooKey || order.status === 'completed'}
                  onClick={() => void actions.onWooAction(order, 'completed')}
                  className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {wooActionLoadingId === wooKey ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  )}
                  Đã xử lý
                </button>
                <button
                  type="button"
                  disabled={wooActionLoadingId === wooKey || order.status === 'cancelled'}
                  onClick={() => void actions.onWooAction(order, 'on-hold')}
                  className="px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {wooActionLoadingId === wooKey ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5" />
                  )}
                  Ngưng xử lý
                </button>
              </>
            )}

            {order.status === 'pending_confirm' && order.channel === 'woocommerce' ? null : order.status ===
                'pending_confirm' && order.channel !== 'woocommerce' ? (
              <button
                type="button"
                onClick={() =>
                  actions.onPatchStatus(order, 'unprocessed', `Xác nhận thành công đơn hàng #${order.orderSn}`)
                }
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all"
              >
                Xác nhận đơn
              </button>
            ) : null}

            {isShopeeReadyToShipStatus(order) && !isProcessedCondition(order) && (
              <>
                {!isOrderPreparedEffective(order) ? (
                  <button
                    type="button"
                    onClick={() => actions.onPrepare(order)}
                    className="om-mobile-hide-prepare px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-xs rounded-lg shadow-xs transition-all flex items-center gap-1"
                  >
                    <Package className="w-3.5 h-3.5" />
                    <span>Chuẩn bị hàng</span>
                  </button>
                ) : (
                  <div className="om-mobile-hide-prepare p-2 rounded-lg border border-emerald-200 bg-emerald-50" title="Đã soạn">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={(e) => actions.onPrint(e, order)}
                  disabled={printingOrderId === order.id}
                  className="om-order-card-print-btn om-mobile-hide-print p-2 bg-blue-600 hover:bg-blue-700 border border-blue-700 text-white rounded-lg transition-all disabled:opacity-60"
                  title="In đơn này"
                >
                  <Printer className={`w-4 h-4 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                </button>
              </>
            )}

            {showHandover && (
              <>
                <div
                  className={`om-mobile-hide-print p-2 rounded-lg border ${
                    printed ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'
                  }`}
                  title={printed ? 'Đã in' : 'Chưa in'}
                >
                  {printed ? <Check className="w-4 h-4 text-emerald-600" /> : <X className="w-4 h-4 text-rose-600" />}
                </div>
                {printed ? (
                  <button
                    type="button"
                    onClick={() => void actions.onResetPrint([order])}
                    disabled={resettingPrint}
                    className="om-mobile-hide-print p-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-50 transition-all"
                    title="Đánh dấu chưa in"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void actions.onMarkPrinted([order])}
                    disabled={resettingPrint}
                    className="om-mobile-hide-print p-2 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-all"
                    title="Đánh dấu đã in"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => actions.onPrint(e, order)}
                  disabled={printingOrderId === order.id}
                  className="om-order-card-print-btn om-mobile-hide-print p-2 bg-blue-600 hover:bg-blue-700 border border-blue-700 text-white rounded-lg transition-all disabled:opacity-60"
                  title="In đơn này"
                >
                  <Printer className={`w-4 h-4 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => void actions.onHandOver(order)}
                  disabled={handingOverOrderId === order.id}
                  className="p-2 bg-indigo-600 hover:bg-indigo-700 border border-indigo-700 text-white rounded-lg transition-all disabled:opacity-60"
                  title="Giao cho ĐVVC"
                >
                  <Truck className={`w-4 h-4 ${handingOverOrderId === order.id ? 'animate-pulse' : ''}`} />
                </button>
              </>
            )}

            {activeSubTab !== 'return_requests' && order.status === 'shipping' && (
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => actions.onPatchStatus(order, 'completed')}
                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] rounded-lg shadow-xs"
                >
                  Thắng
                </button>
                <button
                  type="button"
                  onClick={() => actions.onPatchStatus(order, 'return_pending')}
                  className="px-2.5 py-1 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-[11px] rounded-lg shadow-xs"
                >
                  Bị Hoàn
                </button>
              </div>
            )}

            {activeSubTab !== 'return_requests' && order.status === 'return_pending' && (
              <button
                type="button"
                onClick={() =>
                  actions.onPatchStatus(
                    order,
                    'return_received',
                    `Bấm nút nhận hàng hoàn trả cho đơn ${order.orderSn}.`,
                  )
                }
                className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white font-extrabold text-xs rounded-xl shadow-xs"
              >
                Nhận Hoàn
              </button>
            )}
          </div>
        </div>
      </div>
      {isExpanded ? renderDetails(order) : null}
    </div>
  );
});
