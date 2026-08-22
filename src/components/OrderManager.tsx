import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  startLiveQrScanner,
  stopLiveQrScanner,
  stopTapToFocusAssist,
  CAMERA_TAP_LAYER_ID,
  HTTPS_CAMERA_MESSAGE,
  type LiveQrScannerHandle,
} from '../utils/cameraScanner';
import {
  findOrderByScanPayload,
  scanFeedback,
  playScanSound,
  vibrateScan,
  isLikelyTrackingCode,
  buildOrderScanIndex,
  normalizeOrderScanKey,
  buildScanLookupKeys,
  buildScannerSyncMap,
  lookupScannerSyncMap,
  scannerSyncEntryToOrder,
  lookupOrderByScanCode,
  putOrderIntoScannerSyncMap,
  ScanLookupError,
  type ScannerSyncEntry,
} from '../utils/orderScan';
import {
  isOrderHandedOverToCarrier,
  matchesHandedOverCarrierTab,
  matchesProcessedPickupTab,
  matchesUnprocessedPickupTab,
  matchesShippingTab,
  isShopeeReadyToShipStatus,
  hasOrderTrackingNo,
  getOrderTrackingNo,
  isProcessedCondition,
  isOrderPrintedEffective,
  isOrderPreparedEffective,
  resolveOrderBadgeStatus,
  applyHandedOverWrite,
  applyClearHandedOver,
  buildHandedOverWritePatch,
  isEligibleForHandOverToCarrier,
  getHandOverIneligibleReason,
  getShopeeOrderRawStatus,
  isShopeeCancelledLikeStatus,
  HANDED_OVER_SOURCE,
  UI_TAB_HANDED_OVER_CARRIER,
} from '../utils/orderHandover';
import {
  isOrderAlreadyScanProcessed,
  getScanProcessedReason,
  matchesReceivedCancelReturnTab,
  isWarehouseReturnReceived,
} from '../utils/orderLocalStatus';
import {
  enqueueScanBgCodes,
  fetchScanBgStatus,
  ackScanBgNotifications,
  buildScanBgPendingKeySet,
  formatScanBgToast,
} from '../utils/scanBgQueue';
import { 
  Search, 
  ShoppingBag, 
  CheckCircle2, 
  Printer, 
  Clock, 
  Truck, 
  XCircle, 
  Check, 
  Filter, 
  Eye, 
  Barcode, 
  ArrowRight, 
  AlertCircle, 
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square,
  Package,
  Layers,
  Sparkle,
  Plus,
  ImageIcon,
  Loader2,
  X,
  ImageOff,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Order, ConnectedShop, SyncLog, Product, SystemFee } from '../types';
import ManualOrderPage from './ManualOrderPage';
import { ExternalOrdersTable } from './ExternalOrdersTable';
import { resolveLabelFetchUrl, parseJsonResponse, readResponseJson } from '../utils/apiClient';
import { aggregateOrderProducts, type AggregatedOrderProduct } from '../utils/aggregateOrderProducts';
import { getCarrierWaybillDisplay } from '../utils/orderTracking';
import {
  getOrderCarrierText,
  getShippingCarrierGroup,
  orderMatchesShippingCarrierFilter,
  type ShippingCarrierFilter,
} from '../utils/shippingCarrier';
import { resolveOrderShopDisplayName } from '../utils/resolveOrderShopName';
import { orderCreatedAtMs } from '../utils/sanitizeOrder';
import {
  defaultCustomDateInputs,
  resolveOrderDateRange,
  type OrderDatePreset,
} from '../utils/orderDateFilter';
import {
  computeShopeeSurchargeTotal,
  getShopeeItemAmount,
  getShopeeNetRevenue,
  getShopeeTaxTotal,
  getShopeeTransactionFee,
  isShopeeEscrowSynced,
} from '../utils/shopeeFees';
import {
  playNotificationSound,
  unlockAudio,
  isAudioUnlockedState,
} from '../utils/notificationSound';
import { useMediaQuery } from '../hooks/useMediaQuery';
import {
  OrderCardRow,
  OrderTableRow,
  type OrderListRowActions,
} from './OrderListRows';
import OrderDateFilter from './OrderDateFilter';
import {
  classifyShopeeCancelReturnKind,
  isShopeeCancelledStatus,
  isShopeeRtsFailedDelivery,
  isShopeeReturnRefundOrder,
  shouldShowAwaitingShopeeTracking,
} from '../utils/shopeeCancelReturnClassify';

function isReturnRequestOrder(order: Order): boolean {
  return isShopeeReturnRefundOrder(order);
}

function hasReturnRequestFlag(order: Order): boolean {
  return Boolean(String(order.return_sn || '').trim()) || order.is_return === true;
}

function getOrderWaybillCode(order: Order): string {
  // Ưu tiên mã đi (tracking_no) theo order_sn — return_tracking_no / scan_code chỉ fallback.
  const fromHelper = getCarrierWaybillDisplay(order);
  if (fromHelper) return fromHelper;
  const note = String((order as any).note || '').trim();
  const fromNote = note.startsWith('scan:') ? note.slice(5).trim() : '';
  const fallback = String(
    order.trackingNumber ||
      order.tracking_no ||
      order.returnTrackingNumber ||
      order.return_tracking_no ||
      (order as any).scan_code ||
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

function CancelledNoTrackingBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-gray-100 text-gray-600 border border-gray-200 ${className}`}
    >
      Hủy trước khi giao
    </span>
  );
}

/** Chia mảng thành các chunk cố định — FE gọi API theo chunk (nhiều đơn). */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

/** Pool concurrency giới hạn — chạy gần song song có kiểm soát. */
async function mapPoolLimited<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** Số đơn / 1 request xác nhận hoặc in đơn. */
const LOGISTICS_FE_CHUNK_SIZE = 5;
/** In nhiều đơn: tối đa 2 chunk song song (tránh Over Process + rate-limit). */
const PRINT_FE_CHUNK_CONCURRENCY = 2;
/** Nghỉ ngắn trước khi bắt đầu chunk tiếp theo trong pool (ms). */
const PRINT_FE_CHUNK_STAGGER_MS = 250;
/** Poll trạng thái task in (create/status) — 1 giây/lần. */
const PRINT_FE_STATUS_POLL_MS = 1000;

/** UNPAID/PENDING → Chờ xác nhận (tab "Đang kiểm tra bởi Shopee" đã bỏ). */
function isPendingConfirmOrder(order: Order): boolean {
  const raw = String(order.shopee_order_status || '').toUpperCase();
  // Đã qua chờ xác nhận (raw Shopee / đã xử lý / đã giao) → KHÔNG còn ở tab này.
  // Tránh đơn stale status=pending_confirm nhưng PROCESSED/có mã VĐ hiện cả 2 tab.
  if (
    raw === 'READY_TO_SHIP' ||
    raw === 'RETRY_SHIP' ||
    raw === 'PROCESSED' ||
    raw === 'SHIPPED' ||
    raw === 'TO_CONFIRM_RECEIVE' ||
    raw === 'COMPLETED' ||
    raw === 'CANCELLED' ||
    raw === 'IN_CANCEL' ||
    raw === 'TO_RETURN'
  ) {
    return false;
  }
  if (
    order.status === 'unprocessed' ||
    order.status === 'processed' ||
    order.status === 'shipping' ||
    order.status === 'completed' ||
    order.status === 'cancelled' ||
    order.status === 'return_pending' ||
    order.status === 'return_received'
  ) {
    return false;
  }
  if (isProcessedCondition(order)) return false;
  if (matchesProcessedPickupTab(order) || matchesUnprocessedPickupTab(order)) return false;

  if (order.status === 'pending_confirm' || order.status === 'pending_verification') return true;
  return (
    raw === 'UNPAID' ||
    raw === 'PENDING' ||
    raw === 'IN_REVIEW' ||
    raw === 'FRAUD_CHECK' ||
    raw === 'INVOICE_PENDING'
  );
}

function calculateDynamicFeeItems(itemAmount: number, systemFees: SystemFee[]) {
  return systemFees
    .filter((fee) => fee.active && fee.name.trim() && Number(fee.value) > 0)
    .map((fee) => ({
      ...fee,
      amount: fee.calculationType === 'percentage'
        ? Math.round((itemAmount * Number(fee.value)) / 100)
        : Math.round(Number(fee.value)),
    }));
}

function formatOrderNetRevenueDisplay(order: Order, systemFees: SystemFee[] = []): { text: string; pending: boolean } {
  const pending = order.channel === 'shopee' && !isShopeeEscrowSynced(order);
  const itemAmount = getShopeeItemAmount(order);
  const amount = pending
    ? Math.max(0, itemAmount - calculateDynamicFeeItems(itemAmount, systemFees).reduce((sum, fee) => sum + fee.amount, 0))
    : getShopeeNetRevenue(order);
  return { text: `${amount.toLocaleString('vi-VN')}đ`, pending };
}

function OrderShopeeFinanceSummary({
  order,
  systemFees,
}: {
  order: Order;
  systemFees: SystemFee[];
}) {
  const fees = order.shopee_fees;
  const commissionFee = Math.max(0, Number(fees?.commission_fee) || 0);
  const serviceFee = Math.max(0, Number(fees?.service_fee) || 0);
  const transactionFee = getShopeeTransactionFee(fees);
  const taxTotal = getShopeeTaxTotal(fees, order);
  const surchargeTotal = computeShopeeSurchargeTotal(fees);
  const itemAmount = getShopeeItemAmount(order);
  const escrowReady = order.channel !== 'shopee' || isShopeeEscrowSynced(order);
  const dynamicFeeItems = calculateDynamicFeeItems(itemAmount, systemFees);
  const dynamicFeeTotal = dynamicFeeItems.reduce((sum, fee) => sum + fee.amount, 0);
  const netRevenue = escrowReady
    ? getShopeeNetRevenue(order)
    : Math.max(0, itemAmount - dynamicFeeTotal);

  if (order.channel === 'manual') {
    return (
      <>
        <div className="flex justify-between">
          <span>Tổng tiền sản phẩm:</span>
          <span className="font-bold text-gray-900">{order.totalAmount.toLocaleString('vi-VN')}đ</span>
        </div>
        <div className="flex justify-between text-emerald-600">
          <span>Phí sàn / Chi phí trung gian:</span>
          <span className="font-bold">0đ (Đơn trực tiếp)</span>
        </div>
        <div className="flex justify-between text-emerald-600 pt-1.5 border-t border-dashed border-gray-200 text-sm">
          <span className="font-bold">Doanh thu Nhận Về:</span>
          <span className="font-extrabold">{netRevenue.toLocaleString('vi-VN')}đ</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex justify-between">
        <span>Tổng tiền sản phẩm:</span>
        <span className="font-bold text-gray-900">{itemAmount.toLocaleString('vi-VN')}đ</span>
      </div>
      {!escrowReady ? (
        <div className="space-y-1.5">
          <div className="flex justify-between text-violet-700 font-bold">
            <span>Phí vận hành ước tính</span>
            <span>-{dynamicFeeTotal.toLocaleString('vi-VN')}đ</span>
          </div>
          {dynamicFeeItems.length > 0 ? (
            <div className="pl-3 space-y-1 border-l-2 border-violet-100 text-violet-700">
              {dynamicFeeItems.map((fee) => (
                <div key={fee.id} className="flex justify-between gap-2">
                  <span>{fee.name}{fee.calculationType === 'percentage' ? ` (${fee.value}%)` : ''}:</span>
                  <span className="font-semibold">-{fee.amount.toLocaleString('vi-VN')}đ</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-amber-700">Chưa có phí đang bật trong Cấu hình Chi phí Hệ thống.</p>
          )}
        </div>
      ) : (
      <div className="space-y-1.5">
        <div className="flex justify-between text-rose-600 font-bold">
          <span>Phụ phí Shopee</span>
          <span>-{surchargeTotal.toLocaleString('vi-VN')}đ</span>
        </div>
        <div className="pl-3 space-y-1 border-l-2 border-rose-100 text-rose-500">
          <div className="flex justify-between gap-2">
            <span>Phí cố định:</span>
            <span className="font-semibold text-right">
              -{commissionFee.toLocaleString('vi-VN')}đ
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Phí dịch vụ:</span>
            <span className="font-semibold text-right">
              -{serviceFee.toLocaleString('vi-VN')}đ
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Phí xử lý giao dịch:</span>
            <span className="font-semibold text-right">
              -{transactionFee.toLocaleString('vi-VN')}đ
            </span>
          </div>
        </div>
      </div>
      )}
      {escrowReady && (
      <div className="flex justify-between text-rose-500 gap-2">
        <span>Thuế:</span>
        <span className="font-semibold text-right">
          -{taxTotal.toLocaleString('vi-VN')}đ
        </span>
      </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-emerald-600 pt-1.5 border-t border-dashed border-gray-200 text-sm">
        <span className="font-bold">Doanh thu Nhận Về:</span>
        <div className="text-right">
          <span className="font-extrabold">{netRevenue.toLocaleString('vi-VN')}đ</span>
          {!escrowReady && <span className="block text-[10px] text-violet-700 font-semibold mt-0.5">Tổng từ Cấu hình Chi phí Hệ thống</span>}
        </div>
      </div>
    </>
  );
}

/** Resolve customer info from WooCommerce billing/shipping or flat fields.
 *  Hỗ trợ cả camelCase (customerName) và snake_case (customer_name) — key mismatch fix.
 *  Conditional rendering:
 *   - woocommerce / manual: hiển thị đầy đủ thông tin
 *   - shopee / tiktok: ẩn PII → hiển thị "***" hoặc ẩn dòng
 */
function resolveWooCustomerInfo(order: Order): {
  name: string;
  phone: string;
  email: string;
  address: string;
  isWooCommerce: boolean;
  isSecure: boolean;
} {
  const o = order as any;
  const isWooCommerce = order.channel === 'woocommerce' || order.channel === 'manual';
  const isSecure = order.channel === 'shopee' || order.channel === 'tiktok';

  // billing/shipping: root → data.billing → {}
  const billing = (order.billing && typeof order.billing === 'object' ? order.billing : null)
    || (o.data?.billing && typeof o.data.billing === 'object' ? o.data.billing : null)
    || {};
  const shippingRaw = (typeof order.shipping === 'object' && order.shipping && !Array.isArray(order.shipping)
    ? order.shipping
    : null)
    || (typeof o.data?.shipping === 'object' && o.data?.shipping && !Array.isArray(o.data.shipping)
      ? o.data.shipping
      : null)
    || {};
  const shipping = shippingRaw as {
    first_name?: string;
    last_name?: string;
    phone?: string;
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };

  // Tên: customerName / customer_name → billing → shipping → fallback
  const nameFromParts = [billing.first_name, billing.last_name].filter(Boolean).join(' ').trim()
    || [shipping.first_name, shipping.last_name].filter(Boolean).join(' ').trim();
  const rawCustomerName = String(
    order.customerName || o.customer_name || o.data?.customerName || o.data?.customer_name || ''
  ).trim();
  const isPlaceholder = !rawCustomerName
    || rawCustomerName === 'Khách WooCommerce'
    || rawCustomerName === 'Khách web'
    || rawCustomerName === 'Khách web (Không có thông tin)';
  const name = (!isPlaceholder ? rawCustomerName : '') || nameFromParts || '';

  // SĐT: customerPhone / customer_phone / billing.phone
  const phone = String(
    order.customerPhone || o.customer_phone || o.data?.customerPhone || o.data?.customer_phone
    || billing.phone || shipping.phone || ''
  ).trim();

  // Email
  const email = String(
    order.customerEmail || o.customer_email || o.data?.customerEmail || billing.email || ''
  ).trim();

  // Địa chỉ: customerAddress / customer_address / shippingAddress / billing parts
  const addrFromParts = [
    shipping.address_1 || billing.address_1,
    shipping.address_2 || billing.address_2,
    shipping.city || billing.city,
    shipping.state || billing.state,
    shipping.postcode || billing.postcode,
    shipping.country || billing.country,
  ].filter(Boolean).join(', ');
  const shippingStr = typeof order.shippingAddress === 'string'
    ? order.shippingAddress
    : (order.shippingAddress?.fullAddress || order.shippingAddress?.street || '');
  const address = String(
    order.customerAddress || o.customer_address || o.data?.customerAddress || o.data?.customer_address
    || shippingStr || order.billingAddress || addrFromParts || ''
  ).trim();

  // Secure: cho Shopee/TikTok → ẩn PII, hiển thị ***
  const displayName = isSecure ? (name ? '***' : '') : (name || 'Khách web (Không có thông tin)');
  const displayPhone = isSecure ? '***' : phone;
  const displayEmail = isSecure ? '' : email;
  const displayAddress = isSecure ? '***' : address;

  return { name: displayName, phone: displayPhone, email: displayEmail, address: displayAddress, isWooCommerce, isSecure };
}

function OrderDetailAccordionPanel({
  order,
  shops,
  systemFees,
}: {
  order: Order;
  shops: ConnectedShop[];
  systemFees: SystemFee[];
}) {
  const wooCustomer = order.channel === 'woocommerce' ? resolveWooCustomerInfo(order) : null;
  return (
    <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/80 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-extrabold text-slate-800">Chi tiết đơn #{order.orderSn}</h4>
        <p className="text-[10px] text-slate-500">
          {order.channel === 'manual' ? 'Đơn ngoài sàn' : order.channel === 'woocommerce' ? 'Đơn trên web' : order.channel.toUpperCase()}
          {' · '}
          {resolveOrderShopDisplayName(order, shops)}
        </p>
      </div>

      {wooCustomer && (
        <div className="bg-white p-4 rounded-2xl border border-indigo-100 space-y-1.5 text-xs">
          <h4 className="text-[10px] font-bold text-indigo-700 uppercase tracking-wider mb-1">
            {wooCustomer.isSecure ? 'Thông tin khách hàng (Sàn ẩn PII)' : 'Thông tin khách hàng (Web)'}
          </h4>
          <div className="flex justify-between gap-2">
            <span className="text-gray-400 shrink-0">Tên:</span>
            <span className="font-bold text-gray-900 text-right">{wooCustomer.name || '—'}</span>
          </div>
          {!wooCustomer.isSecure && wooCustomer.phone ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-400 shrink-0">SĐT:</span>
              <span className="font-mono font-semibold text-gray-800 text-right">{wooCustomer.phone}</span>
            </div>
          ) : null}
          {wooCustomer.email ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-400 shrink-0">Email:</span>
              <span className="font-medium text-gray-700 text-right break-all">{wooCustomer.email}</span>
            </div>
          ) : null}
          {!wooCustomer.isSecure && wooCustomer.address ? (
            <div className="flex justify-between gap-2">
              <span className="text-gray-400 shrink-0">Địa chỉ:</span>
              <span className="font-medium text-gray-800 text-right leading-snug">{wooCustomer.address}</span>
            </div>
          ) : null}
          {wooCustomer.isSecure && (
            <p className="text-[10px] text-amber-600 italic mt-1">Thông tin khách hàng do sàn ẩn</p>
          )}
        </div>
      )}

      {getOrderWaybillCode(order) ? (
        <div className="bg-white p-4 rounded-2xl border border-indigo-100">
          <div className="flex items-center gap-2 text-xs">
            <Barcode className="w-4 h-4 text-indigo-500 shrink-0" />
            <div>
              <span className="text-gray-400">Mã vận đơn:</span>{' '}
              <strong className="text-gray-900 font-mono text-sm">{getOrderWaybillCode(order)}</strong>
            </div>
          </div>
          {(() => {
            const rtn = String(order.return_tracking_no || order.returnTrackingNumber || '').trim();
            const outbound = String(order.trackingNumber || order.tracking_no || '').trim();
            if (!rtn || (outbound && rtn.toUpperCase() === outbound.toUpperCase())) return null;
            return (
              <div className="text-blue-600 font-bold font-mono text-xs mt-2 select-text cursor-text break-all">
                Mã chiều hoàn: {rtn}
              </div>
            );
          })()}
        </div>
      ) : order.channel === 'woocommerce' ? null : (
        <div className={`bg-white p-4 rounded-2xl border ${isShopeeCancelledStatus(order) ? 'border-gray-200' : 'border-orange-100'}`}>
          {!shouldShowAwaitingShopeeTracking(order) || isShopeeCancelledStatus(order) ? (
            <CancelledNoTrackingBadge />
          ) : (
            <AwaitingShopeeTrackingBadge />
          )}
          {(() => {
            const rtn = String(order.return_tracking_no || order.returnTrackingNumber || '').trim();
            const outbound = String(order.trackingNumber || order.tracking_no || '').trim();
            if (!rtn || (outbound && rtn.toUpperCase() === outbound.toUpperCase())) return null;
            return (
              <div className="text-blue-600 font-bold font-mono text-xs mt-2 select-text cursor-text break-all">
                Mã chiều hoàn: {rtn}
              </div>
            );
          })()}
        </div>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider">Sản phẩm khách đặt</h4>
        <div className="border border-gray-100 rounded-2xl overflow-hidden divide-y divide-gray-50 bg-white">
          {(order.items || []).map((item, index) => (
            <div key={index} className="p-3 flex items-center justify-between text-xs gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                {item.productImage ? (
                  <img
                    src={item.productImage}
                    alt={item.productTitle}
                    className="w-11 h-11 rounded-lg object-cover border border-gray-200 shrink-0 bg-gray-50"
                  />
                ) : (
                  <div className="w-11 h-11 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center shrink-0">
                    <ImageIcon className="w-4 h-4 text-gray-300" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="font-bold text-gray-800 line-clamp-2">{item.productTitle}</p>
                  <VariationNameBadge variationName={item.modelName} />
                  <p className="text-gray-400 text-[10px] mt-0.5">Giá bán lẻ niêm yết: {item.price.toLocaleString('vi-VN')}đ</p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <span className="text-gray-500">x{item.quantity}</span>
                <p className="font-extrabold text-gray-900 mt-0.5">{(item.price * item.quantity).toLocaleString('vi-VN')}đ</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2 pt-2 border-t border-gray-100 text-xs text-gray-600 bg-white p-4 rounded-2xl border border-gray-100">
        <OrderShopeeFinanceSummary order={order} systemFees={systemFees} />
      </div>
    </div>
  );
}

type OrderTab = 
  | 'all' 
  | 'pending_verification'
  | 'pending_confirm' 
  | 'unprocessed' 
  | 'processed' 
  | 'handed_over_carrier'
  | 'shipping' 
  | 'return_requests'
  | 'cancel_returns'
  | 'received_cancel_returns'
  | 'order_products'
  | 'web_orders'
  | 'external_orders';

export type OrdersSubTabId = OrderTab;

type CancelReturnTab = 'all' | 'refund_return' | 'cancelled' | 'failed_delivery';

const ORDER_TAB_SET = new Set<string>([
  'all',
  'pending_verification',
  'pending_confirm',
  'unprocessed',
  'processed',
  'handed_over_carrier',
  'shipping',
  'return_requests',
  'cancel_returns',
  'received_cancel_returns',
  'order_products',
  'web_orders',
  'external_orders',
]);

const ORDER_TAB_ALIASES: Record<string, OrderTab> = {
  'da-giao-dvvc': 'handed_over_carrier',
  'handed_over_carrier': 'handed_over_carrier',
  'cho-xac-nhan': 'pending_confirm',
  'cho-lay-hang': 'unprocessed',
  'da-xu-ly': 'processed',
  'dang-giao': 'shipping',
  'yeu-cau-tra-hang': 'all',
  'return_requests': 'all',
  'don-huy-hoan': 'cancel_returns',
  'da-nhan-huy-hoan': 'received_cancel_returns',
  'don-tren-web': 'web_orders',
  'web_orders': 'web_orders',
  'woocommerce': 'web_orders',
  'don-ngoai-san': 'external_orders',
  'external_orders': 'external_orders',
  'manual-orders': 'external_orders',
};

function normalizeOrderTab(raw: string | null | undefined): OrderTab | null {
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (ORDER_TAB_ALIASES[key]) return ORDER_TAB_ALIASES[key];
  if (key === 'pending_verification') return 'pending_confirm';
  if (key === 'return_requests' || key === 'yeu-cau-tra-hang') return 'all';
  if (ORDER_TAB_SET.has(key)) return key as OrderTab;
  return null;
}

function readStoredOrdersTab(): OrderTab | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    return (
      normalizeOrderTab(params.get('ordersTab')) ||
      normalizeOrderTab(params.get('subtab')) ||
      normalizeOrderTab(params.get('tab')) ||
      normalizeOrderTab(sessionStorage.getItem('omni_orders_subtab'))
    );
  } catch {
    return null;
  }
}

function readStoredCancelTab(): CancelReturnTab {
  if (typeof window === 'undefined') return 'all';
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('cancelTab') || sessionStorage.getItem('omni_cancel_tab') || 'all';
    if (raw === 'refund_return' || raw === 'cancelled' || raw === 'failed_delivery' || raw === 'all') {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return 'all';
}

/** Đồng bộ sub-tab đơn hàng lên URL + sessionStorage (giữ nguyên khi F5). */
function syncOrdersTabToUrl(subTab: OrderTab, cancelTab: CancelReturnTab) {
  if (typeof window === 'undefined') return;
  try {
    const path = window.location.pathname.replace(/\/$/, '') || '/';
    if (path === '/picking') return;

    const params = new URLSearchParams(window.location.search);
    params.set('tab', 'orders');
    params.set('ordersTab', subTab);
    if (subTab === 'cancel_returns' && cancelTab !== 'all') {
      params.set('cancelTab', cancelTab);
    } else {
      params.delete('cancelTab');
    }
    // Xóa alias cũ nếu còn
    if (params.get('subtab')) params.delete('subtab');

    const next = `${path === '/' ? '/' : path}?${params.toString()}`;
    const cur = `${window.location.pathname}${window.location.search}`;
    if (cur !== next) {
      window.history.replaceState({ tab: 'orders', ordersTab: subTab, cancelTab }, '', next);
    }
    sessionStorage.setItem('omni_active_tab', 'orders');
    sessionStorage.setItem('omni_orders_subtab', subTab);
    sessionStorage.setItem('omni_cancel_tab', cancelTab);
  } catch {
    /* ignore */
  }
}

interface OrderManagerProps {
  orders: Order[];
  ordersMeta?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
    counters?: { total: number; returned: number; cancelled: number; rts: number };
  };
  onUpdateOrders: (orders: Order[], opts?: { persist?: boolean }) => void;
  /** Chỉ đọc lại orders từ DB local — dùng sau xác nhận/in đơn để không ghi đè trạng thái */
  onFetchOrders?: (opts?: {
    silent?: boolean;
    bustCache?: boolean;
    limit?: number;
    merge?: boolean;
    page?: number;
    /** `printed` | `unprinted` — lọc theo isPrinted từ Mongo (không gọi Shopee). */
    print_status?: 'printed' | 'unprinted' | 'all' | '';
    /** Tab SSOT — cùng filter với /api/orders/counter. */
    tab?: string;
    /** Search toàn collection MongoDB — không kẹp tab. */
    q?: string;
    /** Sub-tab Hủy/Hoàn: refund_return | cancelled | failed_delivery */
    kind?: string;
    startDate?: string;
    endDate?: string;
    force?: boolean;
    retriesLeft?: number;
    throwOnError?: boolean;
    signal?: AbortSignal;
    shopId?: string;
    shopIds?: string[];
  }) => Promise<void> | void;
  ordersLoading?: boolean;
  shops: ConnectedShop[];
  systemFees?: SystemFee[];
  onAddLog: (log: SyncLog) => void;
  products?: Product[];
  onUpdateProduct?: (updated: Product) => void;
  focusScanner?: boolean;
  onCloseScanner?: () => void;
  onEndScanSession?: () => void;
  /** Mở sẵn sub-tab khi vào từ menu (vd: received_cancel_returns) */
  initialOrdersSubTab?: OrderTab | null;
  /** Báo App khi user đổi sub-tab (để giữ hint/menu + URL đồng bộ) */
  onOrdersSubTabChange?: (tab: OrderTab) => void;
}

const ORDERS_PAGE_SIZE = 50;
const SCAN_BG_STATUS_POLL_MS = 15_000;
const COUNTER_POLL_MS = 20_000;

function cancelReturnKindParam(tab: CancelReturnTab): string | undefined {
  if (tab === 'all') return undefined;
  return tab;
}

function shopsIdentityKey(shops: ConnectedShop[]): string {
  return shops
    .map((s) => `${s.platform}:${s.shopId || s.id}:${s.connected === false ? 0 : 1}`)
    .sort()
    .join('|');
}

function resolveShopIdsForFetch(
  shops: ConnectedShop[],
  selectedShopId: string,
  selectedPlatform: string,
): string[] {
  if (selectedShopId && selectedShopId !== 'all') return [String(selectedShopId)];
  if (
    selectedPlatform === 'all' ||
    selectedPlatform === 'manual' ||
    selectedPlatform === 'lazada'
  ) {
    return [];
  }
  const ids = shops
    .filter((s) => s.platform === selectedPlatform && s.connected !== false)
    .map((s) => String(s.shopId || '').trim() || String(s.id || '').trim())
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

const CANCEL_RETURN_STATUSES: Order['status'][] = ['cancelled', 'return_pending', 'return_received'];
const OM_PULL_REFRESH_THRESHOLD_PX = 72;

function isCancelReturnOrder(order: Order): boolean {
  const local = String(order.local_status || order.localStatus || '').toUpperCase();
  const raw = String(order.shopee_order_status || '').toUpperCase();
  return (
    CANCEL_RETURN_STATUSES.includes(order.status) ||
    local === 'CANCELLED_STORED' ||
    local === 'RETURN_RECEIVED' ||
    Boolean(order.return_sn) ||
    raw === 'CANCELLED' ||
    raw === 'IN_CANCEL' ||
    raw === 'TO_RETURN' ||
    order.shopee_cancel_return_kind === 'refund_return' ||
    order.shopee_cancel_return_kind === 'failed_delivery' ||
    order.shopee_cancel_return_kind === 'cancelled' ||
    String(order.sub_status || '').toUpperCase() === 'RTS' ||
    isShopeeRtsFailedDelivery(order) ||
    isShopeeReturnRefundOrder(order)
  );
}

/** Phân loại khớp Seller Center: Trả hàng/Hoàn tiền | Đơn hủy | Giao không thành công. */
function resolveCancelReturnKind(order: Order): CancelReturnTab | null {
  if (!isCancelReturnOrder(order)) return null;
  return classifyShopeeCancelReturnKind(order);
}

/** Phân loại độc quyền 1 đơn → 1 sub-tab (Return | RTS | Hủy). */
function resolveCancelReturnBucket(order: Order): Exclude<CancelReturnTab, 'all'> | null {
  const kind = classifyShopeeCancelReturnKind(order);
  if (kind === 'refund_return') return 'refund_return';
  if (kind === 'failed_delivery') return 'failed_delivery';
  if (kind === 'cancelled') return 'cancelled';
  const raw = String(order.shopee_order_status || '').toUpperCase();
  const statusU = String(order.status || '').toUpperCase();
  const isCancelled =
    raw === 'CANCELLED' || raw === 'IN_CANCEL' || statusU === 'CANCELLED';
  if (isCancelled && !hasReturnRequestFlag(order) && !isShopeeRtsFailedDelivery(order)) {
    return 'cancelled';
  }
  return null;
}

function matchesCancelReturnTab(order: Order, tab: CancelReturnTab): boolean {
  if (tab === 'all') return true;
  return resolveCancelReturnBucket(order) === tab;
}

function hasOrderReturnSn(order: Order): boolean {
  return Boolean(String(order.return_sn || '').trim());
}

function isOrderCancelledStatus(order: Order): boolean {
  const statusU = String(order.status || '').toUpperCase();
  const raw = String(order.shopee_order_status || '').toUpperCase();
  return statusU === 'CANCELLED' || raw === 'CANCELLED' || raw === 'IN_CANCEL';
}

/** Lớp lọc cuối — chặn đơn Hủy/Hoàn/RTS lẫn tab khi response cũ về muộn. */
function matchesStrictDisplaySubTab(
  order: Order,
  subTab: OrderTab,
  cancelTab: CancelReturnTab,
): boolean {
  if (subTab === 'return_requests') return hasOrderReturnSn(order);
  if (subTab === 'cancelled') {
    return isOrderCancelledStatus(order) && !hasOrderReturnSn(order) && !order.is_rts;
  }
  if (subTab === 'failed_delivery') return order.is_rts === true;
  if (subTab !== 'cancel_returns') return true;
  if (cancelTab === 'refund_return') return hasOrderReturnSn(order);
  if (cancelTab === 'cancelled') {
    return isOrderCancelledStatus(order) && !hasOrderReturnSn(order) && !order.is_rts;
  }
  if (cancelTab === 'failed_delivery') return order.is_rts === true;
  return true;
}

/** Phân loại hủy/hoàn dùng chung verify realtime + background lookup. */
function classifyScanCancelReturnBuckets(order: Order): {
  isReturnBucket: boolean;
  isCancelBucket: boolean;
} {
  const badge = resolveOrderBadgeStatus(order);
  const raw = getShopeeOrderRawStatus(order);
  const cancelReturnKind = resolveCancelReturnKind(order);
  const isReturnBucket =
    cancelReturnKind === 'refund_return' ||
    badge === 'return_pending' ||
    badge === 'return_received' ||
    order.status === 'return_pending' ||
    order.status === 'return_received' ||
    raw === 'TO_RETURN' ||
    Boolean(order.return_sn);
  const isCancelBucket =
    !isReturnBucket &&
    (cancelReturnKind === 'cancelled' ||
      cancelReturnKind === 'failed_delivery' ||
      badge === 'cancelled' ||
      order.status === 'cancelled' ||
      raw === 'CANCELLED' ||
      raw === 'IN_CANCEL' ||
      isShopeeCancelledLikeStatus(order) ||
      Boolean(isCancelReturnOrder(order) && cancelReturnKind));
  return { isReturnBucket, isCancelBucket };
}

/** Quét khớp mã vận đơn chiều hoàn (return waybill). */
function scannedMatchesReturnWaybill(order: Order, rawCode: string): boolean {
  const rtn = normalizeOrderScanKey(order.return_tracking_no || order.returnTrackingNumber || '');
  if (!rtn || rtn.length < 6) return false;
  const keys = buildScanLookupKeys(rawCode);
  return keys.some((sk) => {
    if (!sk) return false;
    if (sk === rtn) return true;
    if (sk.length >= 10 && rtn.length >= 10) {
      return rtn.endsWith(sk) || sk.endsWith(rtn);
    }
    return false;
  });
}

function VariationNameBadge({ variationName }: { variationName?: string }) {
  const name = variationName?.trim();
  if (!name) return null;
  return (
    <p
      className="inline-flex items-center gap-1.5 mt-1.5 mb-0.5 px-2.5 py-1 rounded-lg bg-orange-50 border-2 border-orange-400 text-orange-700 text-sm font-extrabold uppercase tracking-wide shadow-sm"
      role="status"
    >
      <span aria-hidden="true">👉</span>
      <span>
        Phân loại: <span className="text-red-600">[{name}]</span>
      </span>
    </p>
  );
}

export default function OrderManager({ 
  orders,
  ordersMeta,
  onUpdateOrders, 
  onFetchOrders,
  ordersLoading = false,
  shops, 
  systemFees = [],
  onAddLog, 
  products = [], 
  onUpdateProduct,
  focusScanner = false,
  onCloseScanner,
  onEndScanSession,
  initialOrdersSubTab = null,
  onOrdersSubTabChange,
}: OrderManagerProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [activeSubTab, setActiveSubTab] = useState<OrderTab>(() => {
    const restored =
      (initialOrdersSubTab
        ? normalizeOrderTab(initialOrdersSubTab)
        : null) ||
      readStoredOrdersTab() ||
      'unprocessed';
    if (restored === 'pending_verification') return 'pending_confirm';
    if (restored === 'return_requests') return 'all';
    return restored;
  });
  const [cancelReturnTab, setCancelReturnTab] = useState<CancelReturnTab>(() => readStoredCancelTab());
  const listKind =
    activeSubTab === 'cancel_returns' ? cancelReturnKindParam(cancelReturnTab) : undefined;
  /** Primitive key — chỉ đổi khi sub-tab Hủy/Hoàn thật sự đổi, tránh object/array deps. */
  const listFetchKind = activeSubTab === 'cancel_returns' ? cancelReturnTab : '';
  const [selectedShopId, setSelectedShopId] = useState<string>('all');
  const [selectedPlatform, setSelectedPlatform] = useState<'all' | 'shopee' | 'tiktok' | 'lazada' | 'woocommerce' | 'manual'>('all');
  const [showShopeeDropdown, setShowShopeeDropdown] = useState(false);
  const [showTikTokDropdown, setShowTikTokDropdown] = useState(false);
  const [showWooDropdown, setShowWooDropdown] = useState(false);
  const shopsKey = shopsIdentityKey(shops);
  const resolvedShopIds = useMemo(
    () => resolveShopIdsForFetch(shops, selectedShopId, selectedPlatform),
    // shopsKey = primitive fingerprint — CẤM đưa `shops` array vào deps (loop re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedShopId, selectedPlatform, shopsKey],
  );
  const shopIdsKey = resolvedShopIds.join(',');
  const shopScopeRef = useRef({ shopIds: resolvedShopIds, shopIdsKey, selectedPlatform });
  shopScopeRef.current = { shopIds: resolvedShopIds, shopIdsKey, selectedPlatform };
  const onFetchOrdersPropRef = useRef(onFetchOrders);
  onFetchOrdersPropRef.current = onFetchOrders;
  const [datePreset, setDatePreset] = useState<OrderDatePreset>('30d');
  const [customStartDate, setCustomStartDate] = useState(() => defaultCustomDateInputs().start);
  const [customEndDate, setCustomEndDate] = useState(() => defaultCustomDateInputs().end);
  const orderDateRange = useMemo(
    () => resolveOrderDateRange(datePreset, customStartDate, customEndDate),
    [datePreset, customStartDate, customEndDate],
  );
  const dateRangeKey = `${orderDateRange.startDate}|${orderDateRange.endDate}`;
  const dateRangeRef = useRef(orderDateRange);
  dateRangeRef.current = orderDateRange;
  /** Primitive SSOT cho useEffect fetch — không đưa object shops/filters/dateRange vào deps. */
  const ordersFetchKey = [shopIdsKey, dateRangeKey, activeSubTab, listFetchKind].join('::');
  const shopsBootRef = useRef(false);
  const [shopsBootReady, setShopsBootReady] = useState(false);
  useEffect(() => {
    if (shopsBootRef.current) return;
    const timer = window.setTimeout(() => {
      shopsBootRef.current = true;
      setShopsBootReady(true);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [shopsKey]);
  const fetchOrdersWithShop = useCallback(
    (opts?: Parameters<NonNullable<OrderManagerProps['onFetchOrders']>>[0]) => {
      const shopIds = shopScopeRef.current.shopIds;
      const range = dateRangeRef.current;
      return onFetchOrdersPropRef.current?.({
        ...opts,
        ...(shopIds.length > 0 ? { shopIds } : {}),
        startDate: opts?.startDate || range.startDate,
        endDate: opts?.endDate || range.endDate,
      });
    },
    [],
  );
  const [searchQuery, setSearchQuery] = useState('');
  const activeSubTabRef = useRef(activeSubTab);
  const cancelReturnTabRef = useRef(cancelReturnTab);
  const currentPageRef = useRef(currentPage);
  const searchQueryRef = useRef(searchQuery);
  activeSubTabRef.current = activeSubTab;
  cancelReturnTabRef.current = cancelReturnTab;
  currentPageRef.current = currentPage;
  searchQueryRef.current = searchQuery;
  const listScopeRef = useRef({ tab: '', kind: undefined as string | undefined, page: 1, q: '' });
  listScopeRef.current = {
    tab: searchQuery.trim() ? '' : activeSubTab === 'all' ? '' : activeSubTab,
    kind: searchQuery.trim()
      ? undefined
      : activeSubTab === 'cancel_returns'
        ? cancelReturnKindParam(cancelReturnTab)
        : undefined,
    page: currentPage,
    q: searchQuery.trim(),
  };
  const isListFetchingRef = useRef(false);
  /** Đóng modal xác nhận: gộp set tab+filter, CẤM fetch blocking (spinner) lần nữa. */
  const skipNextOrdersTabFetchRef = useRef(false);
  const hasPdfPollGenRef = useRef(0);
  const hasPdfPollTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (hasPdfPollTimerRef.current != null) {
        window.clearTimeout(hasPdfPollTimerRef.current);
        hasPdfPollTimerRef.current = null;
      }
    };
  }, []);
  const isMobileViewport = useMediaQuery('(max-width: 768px)');
  const isWideDesktop = useMediaQuery('(min-width: 1440px)');
  const useOrderCardList = isMobileViewport || isWideDesktop;

  // Sync = background job; FE chỉ ACK + lock nút + toast (không đổi text nút).
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncSummary, setLastSyncSummary] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [serverOrderCounts, setServerOrderCounts] = useState<Record<string, number> | null>(null);
  const [fulfillmentProducts, setFulfillmentProducts] = useState<AggregatedOrderProduct[] | null>(null);
  const [fulfillmentProductsLoading, setFulfillmentProductsLoading] = useState(false);
  const fulfillmentAbortRef = useRef<AbortController | null>(null);
  const [hasNewOrders, setHasNewOrders] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(() => isAudioUnlockedState());
  const syncPollTimerRef = useRef<number | null>(null);
  const counterPollTimerRef = useRef<number | null>(null);
  const counterAbortRef = useRef<AbortController | null>(null);
  const counterInFlightKeyRef = useRef('');
  const counterInFlightPromiseRef = useRef<Promise<Record<string, number> | null> | null>(null);
  const lastCounterCallAtRef = useRef(0);
  const prevCounters = useRef({ pending_confirm: 0, all: 0, unprocessed: 0 });
  const prevCountersReadyRef = useRef(false);
  const prevCounterScopeRef = useRef('');
  const isSyncingRef = useRef(false);
  /** Pull-to-refresh (mobile): vuốt từ trên xuống để fetch lại đơn. */
  const [pullDistance, setPullDistance] = useState(0);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const pullStartYRef = useRef<number | null>(null);
  const pullActiveRef = useRef(false);
  const pullDistanceRef = useRef(0);
  /** Loading state for WooCommerce action buttons (Đã xử lý / Ngưng xử lý) — must be before handleWooOrderStatusAction */
  const [wooActionLoadingId, setWooActionLoadingId] = useState<string | null>(null);
  const wooActionLoadingIdRef = useRef<string | null>(null);
  const showToast = (msg: string, durationMs = 4500) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), durationMs);
  };

  const fetchOrderCounts = useCallback(async (): Promise<Record<string, number> | null> => {
    const token = localStorage.getItem('admin_token') || '';
    if (!token) return null;
    const shopIds = shopScopeRef.current.shopIds;
    const range = dateRangeRef.current;
    const flightKey = `${shopIds.join(',')}|${range.startDate}|${range.endDate}`;
    const now = Date.now();
    if (counterInFlightPromiseRef.current) {
      return counterInFlightPromiseRef.current;
    }
    if (counterInFlightKeyRef.current === flightKey && now - lastCounterCallAtRef.current < 800) {
      return counterInFlightPromiseRef.current;
    }
    lastCounterCallAtRef.current = now;
    const controller = new AbortController();
    counterAbortRef.current = controller;
    counterInFlightKeyRef.current = flightKey;
    const run = (async (): Promise<Record<string, number> | null> => {
      try {
        const fetchCounterForShops = async (ids: string[]): Promise<{
          counts: Record<string, number>;
          counters?: { total?: number; returned?: number; cancelled?: number; rts?: number };
        } | null> => {
          const params = new URLSearchParams();
          params.set('t', String(Date.now()));
          if (ids.length === 1) params.set('shop_id', ids[0]);
          else if (ids.length > 1) params.set('shop_ids', ids.join(','));
          if (range.startDate) params.set('startDate', range.startDate);
          if (range.endDate) params.set('endDate', range.endDate);
          const res = await fetch(`/api/orders/counter?${params.toString()}`, {
            cache: 'no-store',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              Pragma: 'no-cache',
            },
          });
          const json = await res.json().catch(() => ({} as Record<string, unknown>));
          if (!res.ok || !json?.success || !json?.counts || typeof json.counts !== 'object') {
            return null;
          }
          return {
            counts: json.counts as Record<string, number>,
            counters: json.counters as
              | { total?: number; returned?: number; cancelled?: number; rts?: number }
              | undefined,
          };
        };
        const responses = await Promise.all([fetchCounterForShops(shopIds)]);
        const ok = responses.filter(Boolean) as Array<{
          counts: Record<string, number>;
          counters?: { total?: number; returned?: number; cancelled?: number; rts?: number };
        }>;
        if (ok.length === 0) return null;
        const mergedCounts: Record<string, number> = {};
        ok.forEach((res) => {
          Object.entries(res.counts).forEach(([k, v]) => {
            mergedCounts[k] = (Number(mergedCounts[k]) || 0) + (Number(v) || 0);
          });
        });
        const mergedCounters = {
          total: 0,
          returned: 0,
          cancelled: 0,
          rts: 0,
        };
        ok.forEach((res) => {
          mergedCounters.total += Number(res.counters?.total) || 0;
          mergedCounters.returned += Number(res.counters?.returned) || 0;
          mergedCounters.cancelled += Number(res.counters?.cancelled) || 0;
          mergedCounters.rts += Number(res.counters?.rts) || 0;
        });
        if (mergedCounters.total || mergedCounters.returned || mergedCounters.cancelled || mergedCounters.rts) {
          mergedCounts.cancel_returns = mergedCounters.total || mergedCounts.cancel_returns || 0;
          mergedCounts.cancel_returns_returned = mergedCounters.returned;
          mergedCounts.cancel_returns_cancelled = mergedCounters.cancelled;
          mergedCounts.cancel_returns_rts = mergedCounters.rts;
          mergedCounts.refund_return = mergedCounters.returned;
          mergedCounts.cancelled = mergedCounters.cancelled;
          mergedCounts.failed_delivery = mergedCounters.rts;
        }
        setServerOrderCounts(mergedCounts);
        return mergedCounts;
      } catch (err) {
        const aborted =
          (err instanceof DOMException && err.name === 'AbortError') ||
          (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError');
        if (!aborted) console.warn('[OrderCounts] fetch failed:', err);
      } finally {
        if (counterAbortRef.current === controller) counterAbortRef.current = null;
        if (counterInFlightKeyRef.current === flightKey) {
          counterInFlightPromiseRef.current = null;
        }
      }
      return null;
    })();
    counterInFlightPromiseRef.current = run;
    return run;
  }, []);

  const fetchFulfillmentProducts = useCallback(async (): Promise<AggregatedOrderProduct[]> => {
    const token = localStorage.getItem('admin_token') || '';
    if (!token) return [];
    fulfillmentAbortRef.current?.abort();
    const controller = new AbortController();
    fulfillmentAbortRef.current = controller;
    setFulfillmentProductsLoading(true);
    try {
      const shopIds = shopScopeRef.current.shopIds;
      const range = dateRangeRef.current;
      const params = new URLSearchParams();
      params.set('t', String(Date.now()));
      if (shopIds.length === 1) params.set('shop_id', shopIds[0]);
      else if (shopIds.length > 1) params.set('shop_ids', shopIds.join(','));
      if (range.startDate) params.set('startDate', range.startDate);
      if (range.endDate) params.set('endDate', range.endDate);
      const res = await fetch(`/api/orders/products-summary?${params.toString()}`, {
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
        },
      });
      const json = await res.json().catch(() => ({} as Record<string, unknown>));
      const rows = Array.isArray(json?.data) ? (json.data as AggregatedOrderProduct[]) : [];
      if (!controller.signal.aborted) setFulfillmentProducts(rows);
      return rows;
    } catch (err) {
      const aborted =
        (err instanceof DOMException && err.name === 'AbortError') ||
        (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError');
      if (!aborted) {
        console.warn('[OrderProducts] fetch products-summary failed:', err);
        if (!controller.signal.aborted) setFulfillmentProducts([]);
      }
      return [];
    } finally {
      if (fulfillmentAbortRef.current === controller) {
        fulfillmentAbortRef.current = null;
        setFulfillmentProductsLoading(false);
      }
    }
  }, []);

  const refetchOrdersPage = useCallback(
    (opts?: { silent?: boolean; page?: number }) => {
      setHasNewOrders(false);
      if (activeSubTab === 'order_products') {
        void fetchFulfillmentProducts();
        void fetchOrderCounts();
        return;
      }
      const page = opts?.page && opts.page > 0 ? opts.page : currentPage;
      void fetchOrdersWithShop({
        silent: opts?.silent !== false,
        page,
        limit: ORDERS_PAGE_SIZE,
        merge: false,
        tab: searchQuery.trim() ? '' : activeSubTab === 'all' ? '' : activeSubTab,
        q: searchQuery.trim() || undefined,
        kind:
          activeSubTab === 'cancel_returns'
            ? cancelReturnKindParam(cancelReturnTab)
            : undefined,
      });
      void fetchOrderCounts();
    },
    [activeSubTab, cancelReturnTab, currentPage, fetchFulfillmentProducts, fetchOrderCounts, fetchOrdersWithShop, searchQuery],
  );

  const refetchOrdersPageRef = useRef(refetchOrdersPage);
  refetchOrdersPageRef.current = refetchOrdersPage;
  const onFetchOrdersRef = useRef(fetchOrdersWithShop);
  onFetchOrdersRef.current = fetchOrdersWithShop;
  const newOrderRefreshTimersRef = useRef<number[]>([]);
  const lastNewOrderNotifyAtRef = useRef(0);

  /** Set tab + sub-tab + page cùng 1 tick — tránh fetch 2 lần khi vào nhóm Hủy/Hoàn. */
  const selectOrdersSubTab = useCallback((tab: OrderTab, cancelReturn?: CancelReturnTab) => {
    const nextTab = tab === 'return_requests' ? 'all' : tab;
    setActiveSubTab(nextTab);
    if (nextTab === 'cancel_returns') {
      setCancelReturnTab(cancelReturn ?? 'all');
    }
    setCurrentPage((p) => (p === 1 ? p : 1));
  }, []);

  /** Toast đơn mới → đợi Mongo commit → refetch list 1 lần. */
  const scheduleNewOrderListRefresh = useCallback(() => {
    for (const id of newOrderRefreshTimersRef.current) {
      window.clearTimeout(id);
    }
    newOrderRefreshTimersRef.current = [];
    setHasNewOrders(true);
    setCurrentPage(1);
    const now = Date.now();
    if (now - lastNewOrderNotifyAtRef.current > 2500) {
      lastNewOrderNotifyAtRef.current = now;
      playNotificationSound();
      showToast('Đã có đơn mới — đang làm mới danh sách', 3500);
    }
    const t1 = window.setTimeout(() => {
      refetchOrdersPageRef.current({ silent: false, page: 1 });
    }, 400);
    newOrderRefreshTimersRef.current = [t1];
  }, []);

  /** Báo đơn mới khi pending_confirm / unprocessed / all TĂNG. SSE `new_order` là đường chính. */
  const maybeNotifyNewOrdersFromCounts = useCallback(
    (counts: Record<string, number>) => {
      const nextPending = Number(counts.pending_confirm) || 0;
      const nextAll = Number(counts.all) || 0;
      const nextUnprocessed = Number(counts.unprocessed) || 0;
      const shopIds = shopScopeRef.current.shopIds;
      const range = dateRangeRef.current;
      const scopeKey = `${shopIds.join(',')}|${range.startDate || ''}|${range.endDate || ''}`;
      if (prevCounterScopeRef.current !== scopeKey) {
        prevCounterScopeRef.current = scopeKey;
        prevCounters.current = { pending_confirm: nextPending, all: nextAll, unprocessed: nextUnprocessed };
        prevCountersReadyRef.current = true;
        return;
      }
      if (!prevCountersReadyRef.current) {
        prevCounters.current = { pending_confirm: nextPending, all: nextAll, unprocessed: nextUnprocessed };
        prevCountersReadyRef.current = true;
        return;
      }
      const prevPending = Number(prevCounters.current.pending_confirm) || 0;
      const prevAll = Number(prevCounters.current.all) || 0;
      const prevUnprocessed = Number(prevCounters.current.unprocessed) || 0;
      // Timeout lag countDocuments → 0: giữ baseline, chỉ badge (đã set trong fetchOrderCounts).
      if ((nextPending === 0 && prevPending > 0 && nextAll === 0) || (nextAll === 0 && prevAll > 0)) {
        return;
      }
      if (nextPending > prevPending || nextAll > prevAll || nextUnprocessed > prevUnprocessed) {
        scheduleNewOrderListRefresh();
      }
      prevCounters.current = { pending_confirm: nextPending, all: nextAll, unprocessed: nextUnprocessed };
    },
    [scheduleNewOrderListRefresh],
  );

  const goToOrdersPage = useCallback(
    (page: number) => {
      const next = Math.max(1, Math.floor(page) || 1);
      setCurrentPage(next);
      void fetchOrdersWithShop({
        silent: false,
        page: next,
        limit: ORDERS_PAGE_SIZE,
        merge: false,
        tab: searchQuery.trim() ? '' : activeSubTab === 'all' ? '' : activeSubTab,
        q: searchQuery.trim() || undefined,
        kind:
          activeSubTab === 'cancel_returns'
            ? cancelReturnKindParam(cancelReturnTab)
            : undefined,
      });
    },
    [activeSubTab, cancelReturnTab, fetchOrdersWithShop, searchQuery],
  );

  // Đồng bộ currentPage với metadata API (sau fetch).
  useEffect(() => {
    if (ordersMeta?.page && ordersMeta.page > 0 && ordersMeta.page !== currentPage) {
      setCurrentPage(ordersMeta.page);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersMeta?.page]);

  /** Sau sync nền: chỉ poll counter nhẹ — không kéo 150–400 đơn + merge. */
  const startSyncPolling = useCallback(() => {
    if (syncPollTimerRef.current != null) {
      window.clearTimeout(syncPollTimerRef.current);
      syncPollTimerRef.current = null;
    }
    let ticks = 0;
    const maxTicks = 8; // ~2 phút @ 15s
    const pollOnce = async () => {
      const counts = await fetchOrderCounts();
      if (!counts) return;
      maybeNotifyNewOrdersFromCounts(counts);
    };
    const loop = async () => {
      ticks += 1;
      await pollOnce();
      if (ticks >= maxTicks) {
        syncPollTimerRef.current = null;
        setLastSyncSummary('Đồng bộ ngầm hoàn tất');
        return;
      }
      syncPollTimerRef.current = window.setTimeout(() => {
        void loop();
      }, 15_000);
    };
    syncPollTimerRef.current = window.setTimeout(() => {
      void loop();
    }, 2000);
  }, [fetchOrderCounts, maybeNotifyNewOrdersFromCounts]);

  useEffect(() => {
    return () => {
      if (syncPollTimerRef.current != null) {
        window.clearTimeout(syncPollTimerRef.current);
      }
      if (counterPollTimerRef.current != null) {
        window.clearTimeout(counterPollTimerRef.current);
      }
      counterAbortRef.current?.abort();
      for (const id of newOrderRefreshTimersRef.current) {
        window.clearTimeout(id);
      }
      newOrderRefreshTimersRef.current = [];
    };
  }, []);

  /** Polling counter — badge + toast + tự refetch list khi có đơn mới. */
  useEffect(() => {
    let cancelled = false;
    const schedule = (delay: number) => {
      if (cancelled) return;
      counterPollTimerRef.current = window.setTimeout(() => {
        void poll();
      }, delay);
    };
    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'hidden') {
        const counts = await fetchOrderCounts();
        if (!cancelled && counts) {
          maybeNotifyNewOrdersFromCounts(counts);
        }
      }
      schedule(COUNTER_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (counterPollTimerRef.current != null) {
        window.clearTimeout(counterPollTimerRef.current);
        counterPollTimerRef.current = null;
      }
      counterAbortRef.current?.abort();
    };
  }, [fetchOrderCounts, maybeNotifyNewOrdersFromCounts]);

  /** Lắng nghe SSE `new_order` — popup + refresh ngay, không chờ poll counter. */
  useEffect(() => {
    const token = localStorage.getItem('admin_token') || '';
    if (!token || typeof EventSource === 'undefined') return;
    const url = `/api/orders/live?token=${encodeURIComponent(token)}`;
    let es: EventSource | null = null;
    try {
      es = new EventSource(url);
    } catch {
      return;
    }
    const onNewOrder = (ev: MessageEvent) => {
      let payload: {
        shopId?: string;
        shopIds?: string[];
        orderSn?: string;
        orderSns?: string[];
      } = {};
      try {
        payload = JSON.parse(String(ev.data || '{}')) as typeof payload;
      } catch {
        payload = {};
      }
      const scoped = shopScopeRef.current.shopIds.map(String);
      const eventShops = [
        ...(Array.isArray(payload.shopIds) ? payload.shopIds : []),
        payload.shopId || '',
      ]
        .map((s) => String(s || '').trim())
        .filter(Boolean);
      if (scoped.length > 0 && eventShops.length > 0) {
        const hit = eventShops.some((id) => scoped.includes(id));
        if (!hit) return;
      }
      scheduleNewOrderListRefresh();
    };
    es.addEventListener('new_order', onNewOrder as EventListener);
    es.onerror = () => {
      /* EventSource tự reconnect; không spam log. */
    };
    return () => {
      es.removeEventListener('new_order', onNewOrder as EventListener);
      es.close();
    };
  }, [scheduleNewOrderListRefresh]);

  /** Tự unlock audio sau click/touch đầu tiên của user trên trang. */
  useEffect(() => {
    if (audioEnabled) return;
    const unlock = () => {
      unlockAudio();
      setAudioEnabled(true);
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('click', unlock, { once: true });
    document.addEventListener('touchstart', unlock, { once: true });
    document.addEventListener('keydown', unlock, { once: true });
    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
      document.removeEventListener('keydown', unlock);
    };
  }, [audioEnabled]);

  const triggerShopeeSync = async (mode: 'full' | 'quick') => {
    if (isSyncingRef.current || isSyncing) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      const token = localStorage.getItem('admin_token') || '';
      const body: Record<string, unknown> = {
        mode,
        ...(mode === 'full' ? { lookback_hours: 14 * 24 } : {}),
      };
      const shopIds = shopScopeRef.current.shopIds;
      if (shopIds.length > 0) body.shop_ids = shopIds;
      console.log(`[Orders Sync] → POST /api/sync-shopee mode=${mode}`);
      showToast('Đang đồng bộ ngầm...', 8000);
      setLastSyncSummary('Đang đồng bộ ngầm...');
      const syncRes = await fetch('/api/sync-shopee', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const syncJson = await syncRes.json().catch(() => ({} as Record<string, unknown>));
      if (syncRes.ok && syncJson?.warning === true) {
        const warnMsg = String(
          syncJson?.message ||
            'Hệ thống đang trong quá trình đồng bộ ngầm. Vui lòng đợi trong giây lát',
        );
        setLastSyncSummary(warnMsg);
        showToast(warnMsg, 7000);
        window.setTimeout(() => {
          isSyncingRef.current = false;
          setIsSyncing(false);
        }, 4000);
        void fetchOrderCounts();
        return;
      }
      if (!syncRes.ok) {
        const errMsg = String(
          syncJson?.message || syncJson?.error || 'Không thể bắt đầu đồng bộ Shopee',
        );
        setLastSyncSummary(`Đồng bộ thất bại: ${errMsg}`);
        showToast(errMsg, 7000);
        isSyncingRef.current = false;
        setIsSyncing(false);
        return;
      }
      setLastSyncSummary('Đang đồng bộ ngầm...');
      showToast('Đang đồng bộ ngầm...', 5000);
      void fetch('/api/orders/sync-return-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ mode: 'full' }),
      }).catch(() => {});
      void fetch('/api/orders/enrich-tracking', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ max: 120 }),
      }).catch(() => {});
      void fetchOrderCounts();
      startSyncPolling();
      window.setTimeout(() => {
        isSyncingRef.current = false;
        setIsSyncing(false);
      }, 4000);
    } catch (err) {
      console.error('[Orders Sync] sync-shopee failed:', err);
      setLastSyncSummary('Đồng bộ thất bại: lỗi kết nối máy chủ.');
      showToast('Không nhận được phản hồi đồng bộ — thử lại.', 5000);
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  };

  /** Cập nhật trạng thái đơn WooCommerce — Optimistic UI + Non-blocking */
  const handleWooOrderStatusAction = useCallback(
    async (order: Order, action: 'completed' | 'on-hold') => {
      const orderKey = String(order.id || order.orderSn || order.wooOrderId || '').trim();
      if (!orderKey) {
        showToast('Không xác định được mã đơn WooCommerce', 4000);
        return;
      }
      if (wooActionLoadingIdRef.current) return;

      wooActionLoadingIdRef.current = orderKey;
      setWooActionLoadingId(orderKey);

      const internalStatus = action === 'completed' ? 'completed' : 'cancelled';
      const label = action === 'completed' ? 'Đã xử lý' : 'Ngưng xử lý';
      const prevStatus = order.status;

      // ─── OPTIMISTIC UI: cập nhật ngay lập tức ───────────────────────────
      const updatedOrders = orders.map((o) =>
        o.id === order.id || o.orderSn === order.orderSn
          ? { ...o, status: internalStatus as Order['status'], wooStatus: action }
          : o,
      );
      onUpdateOrders(updatedOrders);

      try {
        const token = localStorage.getItem('admin_token') || '';
        const res = await fetch('/api/woocommerce/orders/update-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            orderId: order.wooOrderId || order.id || order.orderSn,
            internalStatus: action === 'completed' ? 'completed' : 'on-hold',
            shopId: order.shopId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok || data.success === false) {
          showToast(`${label} thất bại: ${data.message || data.error || 'Lỗi không xác định'}`, 6000);
          // Revert optimistic state on failure
          onUpdateOrders(orders);
          return;
        }

        showToast(`${label} thành công — đơn #${order.orderSn}`, 4000);
        onAddLog({
          id: `log-woo-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: 'woocommerce',
          type: 'stock_sync',
          status: 'success',
          message: `${label} đơn web #${order.orderSn} → ${action}`,
        });
      } catch (err) {
        console.error('[Woo Action]', err);
        showToast(`${label} lỗi kết nối — đã khôi phục trạng thái`, 5000);
        onUpdateOrders(orders);
      } finally {
        wooActionLoadingIdRef.current = null;
        setWooActionLoadingId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orders, onUpdateOrders, onAddLog],
  );

  /** Trigger WooCommerce orders sync */
  const triggerWooSync = async (lookbackDays = 7) => {
    if (isSyncingRef.current || isSyncing) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    setLastSyncSummary('Đang đồng bộ đơn WooCommerce...');
    showToast('Đang đồng bộ đơn WooCommerce...', 5000);
    try {
      const token = localStorage.getItem('admin_token') || '';
      const body: Record<string, unknown> = { lookback_days: lookbackDays };
      const shopIds = shopScopeRef.current.shopIds;
      if (shopIds.length === 1) body.shopId = shopIds[0];
      else if (shopIds.length > 1) body.shopIds = shopIds;
      const res = await fetch('/api/woocommerce/orders/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setLastSyncSummary(`WooCommerce: ${data.totalOrdersImported || 0} đơn mới`);
        showToast(`Đồng bộ WooCommerce hoàn tất — ${data.totalOrdersImported || 0} đơn`, 6000);
        // Immediately refresh orders page so WooCommerce orders appear without waiting for poll
        void refetchOrdersPage({ silent: false, page: 1 });
      } else if (data.error === 'no_woo_shops') {
        setLastSyncSummary('Chưa có shop WooCommerce được kết nối');
        showToast('Chưa có shop WooCommerce được kết nối. Vào Cài đặt để thêm.', 6000);
      } else {
        setLastSyncSummary(`Lỗi: ${data.message || 'Không xác định'}`);
        showToast(`Đồng bộ WooCommerce lỗi: ${data.message || data.error}`, 7000);
      }
      void fetchOrderCounts();
    } catch (err) {
      console.error('[Orders Sync] WooCommerce sync failed:', err);
      setLastSyncSummary('Đồng bộ WooCommerce thất bại');
      showToast('Lỗi kết nối khi đồng bộ WooCommerce', 5000);
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  };

  const handleRefreshOrders = async () => {
    if (selectedPlatform === 'woocommerce') {
      await triggerWooSync(14);
    } else {
      await triggerShopeeSync('full');
    }
  };

  /** Đồng bộ nhanh 3h — sync nền, tránh chờ timeout cPanel. */
  const handleQuickSyncOrders = async () => {
    if (selectedPlatform === 'woocommerce') {
      await triggerWooSync(3);
    } else {
      await triggerShopeeSync('quick');
    }
  };

  useEffect(() => {
    if (!initialOrdersSubTab) return;
    const next =
      initialOrdersSubTab === 'pending_verification'
        ? 'pending_confirm'
        : normalizeOrderTab(initialOrdersSubTab) || initialOrdersSubTab;
    setActiveSubTab((prev) => (prev === next ? prev : next));
  }, [initialOrdersSubTab]);

  // Tab "Đang kiểm tra bởi Shopee" đã xóa — chuyển sang Chờ xác nhận.
  useEffect(() => {
    if (activeSubTab === 'pending_verification') {
      setActiveSubTab('pending_confirm');
    }
  }, [activeSubTab]);

  // Sync URL khi đổi tab / nhóm Hủy-Hoàn — không fetch (tránh abort list khi bấm sub-tab).
  useEffect(() => {
    if (activeSubTab === 'pending_verification') return;
    syncOrdersTabToUrl(activeSubTab, cancelReturnTab);
    onOrdersSubTabChange?.(activeSubTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubTab, cancelReturnTab]);

  // Chỉ fetch khi tab / kind / shop IDs / dateRange thật sự đổi (chuỗi primitive).
  useEffect(() => {
    if (!shopsBootReady) return;
    if (activeSubTab === 'pending_verification') return;
    const tabFetchTabs = new Set([
      'all',
      'unprocessed',
      'processed',
      'pending_confirm',
      'shipping',
      'handed_over_carrier',
      'return_requests',
      'cancel_returns',
      'received_cancel_returns',
      'web_orders',
      'external_orders',
    ]);
    if (!tabFetchTabs.has(activeSubTab) || !onFetchOrdersRef.current) return;
    if (skipNextOrdersTabFetchRef.current) {
      skipNextOrdersTabFetchRef.current = false;
      return;
    }

    const expectedTab = searchQuery.trim() ? '' : activeSubTab === 'all' ? '' : activeSubTab;
    const expectedKind =
      activeSubTab === 'cancel_returns' ? cancelReturnKindParam(cancelReturnTab) : undefined;
    const delay = datePreset === 'custom' ? 280 : 80;
    const timer = window.setTimeout(() => {
      isListFetchingRef.current = true;
      setCurrentPage((p) => (p === 1 ? p : 1));
      console.log(`[Orders Tab] activeSubTab=${activeSubTab} kind=${listFetchKind || '(none)'} shops=${shopIdsKey || '(all)'} → fetch page=1`);
      void Promise.resolve(
        onFetchOrdersRef.current?.({
          silent: false,
          page: 1,
          limit: ORDERS_PAGE_SIZE,
          merge: false,
          tab: expectedTab,
          q: searchQuery.trim() || undefined,
          kind: expectedKind,
        }),
      )
        .catch((error: unknown) => {
          const name =
            error instanceof Error
              ? error.name
              : typeof error === 'object' && error !== null
                ? (error as { name?: string }).name
                : undefined;
          if (name === 'AbortError') return;
          console.warn('[Orders Tab] fetchOrders failed:', error);
        })
        .finally(() => {
          isListFetchingRef.current = false;
        });
    }, delay);

    return () => {
      window.clearTimeout(timer);
    };
    // Primitive key only — shopIds.join + dateRange + filters. CẤM object selectedShops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersFetchKey, shopsBootReady]);

  // Tab sản phẩm trong đơn: Backend tự gộp 3 tab kho — KHÔNG gửi 1 status cứng.
  useEffect(() => {
    if (!shopsBootReady) return;
    if (activeSubTab !== 'order_products') return;
    const timer = window.setTimeout(() => {
      void fetchFulfillmentProducts();
    }, 80);
    return () => {
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubTab, shopIdsKey, dateRangeKey, shopsBootReady, fetchFulfillmentProducts]);

  const searchBootRef = React.useRef(true);
  useEffect(() => {
    if (searchBootRef.current) {
      searchBootRef.current = false;
      return;
    }
    if (activeSubTab === 'order_products') return;
    const q = searchQuery.trim();
    const handle = window.setTimeout(() => {
      setCurrentPage(1);
      void Promise.resolve(
        onFetchOrdersRef.current?.({
          silent: false,
          page: 1,
          limit: ORDERS_PAGE_SIZE,
          merge: false,
          tab: q ? '' : activeSubTab === 'all' ? '' : activeSubTab,
          q: q || undefined,
          kind:
            !q && activeSubTab === 'cancel_returns'
              ? cancelReturnKindParam(cancelReturnTab)
              : undefined,
        }),
      ).catch((error: unknown) => {
        const name =
          error instanceof Error
            ? error.name
            : typeof error === 'object' && error !== null
              ? (error as { name?: string }).name
              : undefined;
        if (name === 'AbortError') return;
      });
    }, q ? 400 : 80);
    return () => {
      window.clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  const [cameraScanResult, setCameraScanResult] = useState<string>('Đang chờ quét QR / mã vạch...');
  const [cameraScanSuccess, setCameraScanSuccess] = useState<boolean>(false);
  const [cameraScanError, setCameraScanError] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string>('');
  const [cameraRestartKey, setCameraRestartKey] = useState(0);
  const lastQrScanRef = React.useRef({ key: '', at: 0 });

  type ScanVerifiedItem = {
    id: string;
    code: string;
    orderId?: string;
    orderSn?: string;
    trackingNumber?: string;
    at: number;
  };
  type ScanStatModalKey = 'daXuatKho' | 'donHuy' | 'daNhanHoan';

  /** Real-time lists — quét đến đâu phân loại đến đó (ghi DB khi bấm Kết thúc). */
  const [daXuatKhoList, setDaXuatKhoList] = useState<ScanVerifiedItem[]>([]);
  const [donHuyList, setDonHuyList] = useState<ScanVerifiedItem[]>([]);
  const [daNhanHoanList, setDaNhanHoanList] = useState<ScanVerifiedItem[]>([]);
  const [scanStatModal, setScanStatModal] = useState<ScanStatModalKey | null>(null);
  const [scanToast, setScanToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [handingOverOrderId, setHandingOverOrderId] = useState<string | null>(null);
  const [confirmingReturnId, setConfirmingReturnId] = useState<string | null>(null);
  const [isBulkHandingOver, setIsBulkHandingOver] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isFlushingQueue, setIsFlushingQueue] = useState(false);
  const [flushingDbCount, setFlushingDbCount] = useState(0);
  const [isVerifyingScan, setIsVerifyingScan] = useState(false);

  const ordersRef = React.useRef(orders);
  type OptimisticOrderMutation = {
    isPrinted?: boolean;
    isPrepared?: boolean;
    status?: Order['status'];
    expiresAt: number;
  };
  /** Overlay chống GET cũ ghi đè trạng thái vừa xác nhận/in. */
  const optimisticOrderMutationsRef = React.useRef<Map<string, OptimisticOrderMutation>>(new Map());
  /** Chặn race-condition: response GET cũ không được làm đơn vừa in xuất hiện lại. */
  const recentlyPrintedRef = React.useRef<Map<string, number>>(new Map());
  const applyScanRef = React.useRef<(query: string) => void>(() => {});
  const verifyScanRef = React.useRef<(query: string) => void>(() => {});
  const isScanBusyRef = React.useRef(false);
  const scanGunInputRef = React.useRef<HTMLInputElement | null>(null);
  /** Hàng đợi mã quét khi đang verify — không bỏ mã khi quét liên tục. */
  const pendingScanQueueRef = React.useRef<string[]>([]);
  /** Hàng đợi dò ngầm đã chuyển lên Backend — FE chỉ enqueue + poll badge. */
  const [scanBgPendingKeys, setScanBgPendingKeys] = useState<Set<string>>(() => new Set());
  const [scanBgPendingCount, setScanBgPendingCount] = useState(0);
  const prevFocusScannerRef = React.useRef(focusScanner);
  const isHandingOverRef = React.useRef(false);
  const daXuatKhoListRef = React.useRef(daXuatKhoList);
  const donHuyListRef = React.useRef(donHuyList);
  const daNhanHoanListRef = React.useRef(daNhanHoanList);
  /** Instance scanner sống — dùng để await stop/clear trước khi unmount. */
  const liveScannerRef = React.useRef<LiveQrScannerHandle | null>(null);
  const isTearingDownScannerRef = React.useRef(false);
  const orderScanIndex = useMemo(() => buildOrderScanIndex(orders), [orders]);
  /** Hash map mã VĐ từ /api/orders/scanner-sync — lookup O(1), không phụ thuộc pool orders UI. */
  const [scannerSyncMap, setScannerSyncMap] = useState<Map<string, ScannerSyncEntry>>(
    () => new Map(),
  );
  const scannerSyncMapRef = React.useRef(scannerSyncMap);
  const [scannerSyncCodeCount, setScannerSyncCodeCount] = useState(0);
  /** Tổng mã VĐ đã tải local — UI "Đã dò x/{n}". */
  const continuousScanTarget = scannerSyncCodeCount;
  const totalVerifiedScans = daXuatKhoList.length + donHuyList.length + daNhanHoanList.length;

  useEffect(() => {
    const now = Date.now();
    const overlays = optimisticOrderMutationsRef.current;
    for (const [key, mutation] of overlays) {
      if (mutation.expiresAt <= now) overlays.delete(key);
    }
    const recentlyPrinted = recentlyPrintedRef.current;
    for (const [key, expiresAt] of recentlyPrinted) {
      if (expiresAt <= now) recentlyPrinted.delete(key);
    }
    let changed = false;
    const guarded = orders.map((order) => {
      const sn = String(order.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
      const id = String(order.id || '').trim().toLowerCase();
      const mutation =
        overlays.get(id) ||
        overlays.get(sn) ||
        (sn ? overlays.get(`shopee-${sn}`) : undefined);
      const wasRecentlyPrinted =
        (id && recentlyPrinted.has(id)) ||
        (sn && (recentlyPrinted.has(sn) || recentlyPrinted.has(`shopee-${sn}`)));
      if (!mutation && !wasRecentlyPrinted) return order;
      const next = {
        ...order,
        ...(mutation?.isPrinted != null
          ? { isPrinted: mutation.isPrinted }
          : wasRecentlyPrinted
            ? { isPrinted: true }
            : {}),
        ...(mutation?.isPrepared != null
          ? { isPrepared: mutation.isPrepared }
          : mutation?.status === 'processed' || wasRecentlyPrinted
            ? { isPrepared: true }
            : {}),
        ...(mutation?.status
          ? { status: mutation.status }
          : wasRecentlyPrinted
            ? { status: 'processed' as const }
            : {}),
      };
      if (
        next.isPrinted !== order.isPrinted ||
        next.status !== order.status ||
        next.isPrepared !== order.isPrepared
      ) {
        changed = true;
      }
      return next;
    });
    ordersRef.current = guarded;
    if (changed) onUpdateOrders(guarded, { persist: false });
  }, [orders, onUpdateOrders]);

  useEffect(() => {
    scannerSyncMapRef.current = scannerSyncMap;
  }, [scannerSyncMap]);

  useEffect(() => {
    daXuatKhoListRef.current = daXuatKhoList;
  }, [daXuatKhoList]);
  useEffect(() => {
    donHuyListRef.current = donHuyList;
  }, [donHuyList]);
  useEffect(() => {
    daNhanHoanListRef.current = daNhanHoanList;
  }, [daNhanHoanList]);

  /** Thoát Quét → Menu: luôn refresh để badge Đã nhận hủy/hoàn khớp Mongo. */
  useEffect(() => {
    const wasFocused = prevFocusScannerRef.current;
    prevFocusScannerRef.current = focusScanner;
    if (wasFocused && !focusScanner) {
      const expectedTab = activeSubTabRef.current;
      void onFetchOrdersRef.current?.({
        silent: true,
        page: 1,
        limit: ORDERS_PAGE_SIZE,
        merge: false,
        tab: expectedTab === 'all' ? '' : expectedTab,
        kind:
          expectedTab === 'cancel_returns'
            ? cancelReturnKindParam(cancelReturnTabRef.current)
            : undefined,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusScanner]);

  const showScanToast = (text: string, type: 'success' | 'error') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2800);
  };

  /** `all` | `printed` | `unprinted` — lọc theo isPrinted từ DB. */
  const [printStatusFilter, setPrintStatusFilter] = useState<'all' | 'printed' | 'unprinted'>('all');
  const [resettingPrintIds, setResettingPrintIds] = useState<string[]>([]);

  const matchesSelectedShop = (order: Order): boolean => {
    if (selectedShopId === 'all') return true;

    const orderShopId = String(order.shopId || '').trim();
    const selected = String(selectedShopId || '').trim();
    if (orderShopId && orderShopId === selected) return true;

    // Đơn cũ có thể lưu ID nội bộ, còn đơn mới lưu shop_id thật từ sàn.
    const selectedShop = shops.find(
      (shop) => String(shop.shopId || '') === selected || String(shop.id || '') === selected,
    );
    if (!selectedShop) return false;
    return (
      orderShopId === String(selectedShop.shopId || '') ||
      orderShopId === String(selectedShop.id || '')
    );
  };

  const openHandedOverCarrierTab = React.useCallback(() => {
    setPrintStatusFilter('all');
    setSearchQuery('');
    setSelectedShopId('all');
    setActiveSubTab(UI_TAB_HANDED_OVER_CARRIER);
  }, []);

  /** Đổi lọc Đã in / Chưa in — lọc client theo cờ isPrinted.
   * Đồng bộ lại cờ từ Mongo (KHÔNG gửi print_status: merge subset làm lệch cờ các đơn không nằm trong response). */
  const applyPrintStatusFilter = React.useCallback(
    (next: 'all' | 'printed' | 'unprinted') => {
      setPrintStatusFilter(next);
      void Promise.resolve(
        fetchOrdersWithShop({
          silent: true,
          page: 1,
          limit: ORDERS_PAGE_SIZE,
          merge: false,
          tab: activeSubTab === 'all' ? '' : activeSubTab,
          kind: listKind,
        }),
      ).catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
      });
    },
    [activeSubTab, listKind, fetchOrdersWithShop],
  );

  // markPrintedOnLocalPdfOpen declared after applyPrintedLocalOptimistic + updatePrintStatusForOrders (see below).

  type PrintedOptimisticSnapshot = {
    key: string;
    isPrinted: boolean;
    status?: Order['status'];
  };

  /** Optimistic UI: set isPrinted ngay trên local state (0ms) — đơn biến mất khỏi lọc "Chưa in". */
  const applyPrintedLocalOptimistic = React.useCallback(
    (orderKeys: string[], isPrinted: boolean, status?: Order['status']) => {
      const idSet = new Set(
        orderKeys
          .map((s) => String(s || '').replace(/^shopee-/i, '').trim().toLowerCase())
          .filter(Boolean),
      );
      if (idSet.size === 0) return [] as Order[];
      const expiresAt = Date.now() + 5 * 60 * 1000;
      for (const key of idSet) {
        const mutation = {
          isPrinted,
          isPrepared: status === 'processed' ? true : undefined,
          ...(status ? { status } : {}),
          expiresAt,
        };
        optimisticOrderMutationsRef.current.set(key, mutation);
        optimisticOrderMutationsRef.current.set(`shopee-${key}`, mutation);
        if (isPrinted) {
          recentlyPrintedRef.current.set(key, expiresAt);
          recentlyPrintedRef.current.set(`shopee-${key}`, expiresAt);
        } else {
          recentlyPrintedRef.current.delete(key);
          recentlyPrintedRef.current.delete(`shopee-${key}`);
        }
      }
      const hit: Order[] = [];
      const patched = ordersRef.current.map((o) => {
        const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const oid = String(o.id || '').replace(/^shopee-/i, '').trim().toLowerCase();
        if (!idSet.has(sn) && !idSet.has(oid) && !idSet.has(`shopee-${sn}`)) return o;
        const next = {
          ...o,
          isPrinted,
          ...(status === 'processed' ? { isPrepared: true } : {}),
          ...(status ? { status } : {}),
        };
        hit.push(next);
        return next;
      });
      ordersRef.current = patched;
      onUpdateOrders(patched, { persist: false });
      return hit;
    },
    [onUpdateOrders],
  );

  const rollbackPrintedLocalOptimistic = React.useCallback(
    (previous: PrintedOptimisticSnapshot[]) => {
      if (!previous.length) return;
      const prevByKey = new Map<string, PrintedOptimisticSnapshot>();
      for (const row of previous) {
        const key = String(row.key || '').replace(/^shopee-/i, '').trim().toLowerCase();
        if (!key) continue;
        prevByKey.set(key, row);
        optimisticOrderMutationsRef.current.delete(key);
        optimisticOrderMutationsRef.current.delete(`shopee-${key}`);
        recentlyPrintedRef.current.delete(key);
        recentlyPrintedRef.current.delete(`shopee-${key}`);
      }
      if (prevByKey.size === 0) return;
      const patched = ordersRef.current.map((o) => {
        const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const oid = String(o.id || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const prev = prevByKey.get(sn) || prevByKey.get(oid);
        if (!prev) return o;
        return { ...o, isPrinted: prev.isPrinted, ...(prev.status ? { status: prev.status } : {}) };
      });
      ordersRef.current = patched;
      onUpdateOrders(patched, { persist: false });
    },
    [onUpdateOrders],
  );

  /** Cập nhật isPrinted trên DB nội bộ (không gọi Shopee) — hỗ trợ true/false.
   * Optimistic: local state TRƯỚC, API fire-and-forget. Lỗi → rollback. */
  const updatePrintStatusForOrders = React.useCallback(
    async (
      targetOrders: Order[],
      isPrinted: boolean,
      opts?: { silent?: boolean },
    ) => {
      const ids = targetOrders
        .map((o) => String(o.orderSn || o.id || '').replace(/^shopee-/i, '').trim())
        .filter(Boolean);
      const label = isPrinted ? 'đã in' : 'chưa in';
      if (ids.length === 0) {
        if (!opts?.silent) showToast(`Chưa chọn đơn để đánh dấu ${label}.`);
        return;
      }
      const previous: PrintedOptimisticSnapshot[] = targetOrders.map((o) => ({
        key: String(o.orderSn || o.id || '').replace(/^shopee-/i, '').trim().toLowerCase(),
        isPrinted: Boolean(o.isPrinted),
        status: o.status,
      })).filter((row) => row.key);
      // Optimistic UI: cập nhật local NGAY, không chờ Backend.
      applyPrintedLocalOptimistic(ids, isPrinted);
      if (!opts?.silent) showToast(`Đã đánh dấu ${label}: ${ids.length} đơn.`);
      const token = localStorage.getItem('admin_token');
      const endpoint = isPrinted
        ? '/api/orders/mark-printed'
        : '/api/orders/update-print-status';
      void fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          orderIds: ids,
          orderSns: ids,
          order_sns: ids,
          is_printed: isPrinted,
          isPrinted,
        }),
      })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data?.success === false) {
            rollbackPrintedLocalOptimistic(previous);
            console.warn(
              `[Print Status] update-print-status failed HTTP ${res.status}:`,
              data?.message || data?.error || res.statusText,
            );
            if (!opts?.silent) {
              showToast(
                data?.message || `Không lưu được trạng thái ${label} lên server — đã hoàn tác.`,
              );
            }
          }
        })
        .catch((err: any) => {
          const isAbort =
            err?.name === 'AbortError' ||
            (err instanceof DOMException && err.name === 'AbortError') ||
            /aborted|AbortError|signal|this operation was aborted/i.test(String(err?.message || ''));
          console.warn('[Print Status] update-print-status exception:', err?.message || err, isAbort ? '(ignored — silent fire-and-forget)' : '');
          if (isAbort) return;
          rollbackPrintedLocalOptimistic(previous);
          if (!opts?.silent) {
            showToast(err?.message || `Lỗi đánh dấu ${label} — đã hoàn tác.`);
          }
        });
    },
    [applyPrintedLocalOptimistic, rollbackPrintedLocalOptimistic],
  );

  const resetPrintStatusForOrders = React.useCallback(
    (targetOrders: Order[]) => updatePrintStatusForOrders(targetOrders, false),
    [updatePrintStatusForOrders],
  );

  const markPrintedStatusForOrders = React.useCallback(
    (targetOrders: Order[]) => updatePrintStatusForOrders(targetOrders, true),
    [updatePrintStatusForOrders],
  );

  /**
   * LUỒNG LOCAL PDF: Gọi NGAY tại thời điểm mở PDF local.
   * Bước 1: setLocal isPrinted=true → đơn biến mất khỏi "Chưa in" trong 0.1s
   * Bước 2: gọi API Backend (không block) → ghi vĩnh viễn vào MongoDB
   */
  const markPrintedOnLocalPdfOpen = React.useCallback(
    (orders: Order[]) => {
      if (orders.length === 0) return;
      const keys = orders
        .map((o) => String(o.orderSn || o.id || '').replace(/^shopee-/i, '').trim())
        .filter(Boolean);
      if (keys.length === 0) return;
      // Bước 1: optimistic — set isPrinted ngay trên local state (0ms)
      applyPrintedLocalOptimistic(keys, true);
      // Bước 2: API Backend — không block UI (void + catch)
      void updatePrintStatusForOrders(orders, true, { silent: true }).catch((err) => {
        console.warn('[Print] markPrintedOnLocalPdfOpen API failed:', err);
      });
    },
    [applyPrintedLocalOptimistic, updatePrintStatusForOrders],
  );

  const applyHandoverToLocalOrders = React.useCallback(
    (updatedOrder: Order, source: 'qr_scan' | 'manual_button' = 'manual_button') => {
      const patched = applyHandedOverWrite(
        { ...updatedOrder },
        undefined,
        source === 'qr_scan' ? HANDED_OVER_SOURCE.QR_SCAN : HANDED_OVER_SOURCE.MANUAL_BUTTON,
      ) as Order;
      const sn = String(patched.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
      const id = String(patched.id || '').trim().toLowerCase();
      let hit = false;
      let wasAlreadyHanded = false;
      const merged = ordersRef.current.map((o) => {
        const oSn = String(o.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const oId = String(o.id || '').trim().toLowerCase();
        const same =
          (id && oId && oId === id) ||
          (sn && oSn && oSn === sn) ||
          (id && oSn && `shopee-${oSn}` === id) ||
          (sn && oId && oId === `shopee-${sn}`);
        if (!same) return o;
        hit = true;
        wasAlreadyHanded = isOrderHandedOverToCarrier(o);
        return { ...o, ...patched };
      });
      if (!hit) merged.unshift(patched);
      ordersRef.current = merged;
      onUpdateOrders(merged, { persist: false });
      // Badge realtime: trừ Đã xử lý, cộng Đã giao ĐVVC (chỉ khi mới bàn giao).
      if (!wasAlreadyHanded) {
        setServerOrderCounts((prev) => {
          if (!prev) return prev;
          const processed = Math.max(0, Number(prev.processed || 0) - 1);
          const handed = Number(prev.handed_over_carrier || 0) + 1;
          return { ...prev, processed, handed_over_carrier: handed };
        });
      }
    },
    [onUpdateOrders]
  );

  const applyHandoverBulkToLocalOrders = React.useCallback(
    (updatedList: Order[]) => {
      if (!updatedList.length) return;
      const byKey = new Map<string, Order>();
      const addKeys = (patched: Order) => {
        const sn = String(patched.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const id = String(patched.id || '').trim().toLowerCase();
        if (id) byKey.set(id, patched);
        if (sn) {
          byKey.set(sn, patched);
          byKey.set(`shopee-${sn}`, patched);
        }
      };
      for (const u of updatedList) {
        addKeys(
          applyHandedOverWrite(
            { ...u },
            undefined,
            HANDED_OVER_SOURCE.MANUAL_BUTTON,
          ) as Order,
        );
      }
      let newlyHanded = 0;
      const merged = ordersRef.current.map((o) => {
        const oSn = String(o.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const oId = String(o.id || '').trim().toLowerCase();
        const hit =
          byKey.get(oId) ||
          byKey.get(oSn) ||
          (oSn ? byKey.get(`shopee-${oSn}`) : undefined);
        if (!hit) return o;
        if (!isOrderHandedOverToCarrier(o)) newlyHanded += 1;
        return { ...o, ...hit };
      });
      ordersRef.current = merged;
      onUpdateOrders(merged, { persist: false });
      if (newlyHanded > 0) {
        setServerOrderCounts((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            processed: Math.max(0, Number(prev.processed || 0) - newlyHanded),
            handed_over_carrier: Number(prev.handed_over_carrier || 0) + newlyHanded,
          };
        });
      }
    },
    [onUpdateOrders]
  );

  const sameOrderKey = React.useCallback((a: Order, b: Order) => {
    const aSn = String(a.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
    const aId = String(a.id || '').trim().toLowerCase();
    const bSn = String(b.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
    const bId = String(b.id || '').trim().toLowerCase();
    return Boolean(
      (aId && bId && aId === bId) ||
        (aSn && bSn && aSn === bSn) ||
        (aId && bSn && aId === `shopee-${bSn}`) ||
        (bId && aSn && bId === `shopee-${aSn}`),
    );
  }, []);

  /** Rollback optimistic ĐVVC → trả đơn về tab Đã xử lý. */
  const rollbackHandoverOnLocalOrders = React.useCallback(
    (originals: Order | Order[]) => {
      const list = Array.isArray(originals) ? originals : [originals];
      if (!list.length) return;
      let restored = 0;
      const merged = ordersRef.current.map((o) => {
        const hit = list.find((orig) => sameOrderKey(o, orig));
        if (!hit) return o;
        restored += 1;
        return applyClearHandedOver({ ...hit }) as Order;
      });
      ordersRef.current = merged;
      onUpdateOrders(merged, { persist: false });
      if (restored > 0) {
        setServerOrderCounts((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            processed: Number(prev.processed || 0) + restored,
            handed_over_carrier: Math.max(0, Number(prev.handed_over_carrier || 0) - restored),
          };
        });
      }
      setActiveSubTab('processed');
    },
    [onUpdateOrders, sameOrderKey],
  );

  const handOverOrderToCarrier = React.useCallback(
    async (order: Order, opts?: { switchTab?: boolean; fromScan?: boolean; silent?: boolean }) => {
      const token = localStorage.getItem('admin_token');
      if (!token) {
        if (!opts?.silent) showScanToast('Chưa đăng nhập — không thể ghi nhận bàn giao ĐVVC.', 'error');
        return false;
      }
      if (!isEligibleForHandOverToCarrier(order) && !isOrderHandedOverToCarrier(order)) {
        const why = getHandOverIneligibleReason(order) || 'không đủ điều kiện';
        if (!opts?.silent) showScanToast(`Đơn #${order.orderSn}: ${why}`, 'error');
        return false;
      }
      if (isOrderHandedOverToCarrier(order)) {
        if (opts?.switchTab !== false) openHandedOverCarrierTab();
        if (!opts?.silent) {
          showScanToast(`Đơn #${order.orderSn} đã ghi nhận giao cho ĐVVC trước đó.`, 'success');
        }
        return true;
      }

      const source = opts?.fromScan ? 'qr_scan' : 'manual_button';
      // 1) Optimistic UI — cập nhật state/badge ngay, không chờ API.
      applyHandoverToLocalOrders(order, source);
      if (opts?.switchTab !== false) openHandedOverCarrierTab();
      if (!opts?.silent) {
        showScanToast(`Đã giao cho ĐVVC — đơn #${order.orderSn}`, 'success');
      }
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: order.channel,
        type: 'stock_sync',
        status: 'success',
        message: opts?.fromScan
          ? `[QUÉT QR] Bàn giao ĐVVC đơn ${order.orderSn} → Tab Đã giao cho ĐVVC (optimistic).`
          : `[BÀN GIAO] Đơn ${order.orderSn} → Đã giao cho ĐVVC (optimistic).`,
      });

      // 2) API nền — fire-and-forget, tuyệt đối không block UI quét.
      const orderKey = order.id || order.orderSn;
      const waybill =
        getOrderWaybillCode(order) ||
        getOrderTrackingNo(order) ||
        order.trackingNumber ||
        order.tracking_no ||
        '';
      const handOverBody = JSON.stringify({
        orderId: order.id,
        orderSn: order.orderSn,
        shopId: order.shopId,
        trackingNumber: waybill,
        tracking_no: waybill,
        waybill,
        source,
      });
      setHandingOverOrderId(order.id);
      void (async () => {
        try {
          let res = await fetch(`/api/orders/${encodeURIComponent(String(orderKey))}/hand-over-carrier`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: handOverBody,
          });
          if (!res.ok) {
            const altRes = await fetch('/api/orders/hand-over-carrier', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: handOverBody,
            });
            if (altRes.ok) res = altRes;
          }
          const data = (await res.json().catch(() => ({}))) as {
            success?: boolean;
            message?: string;
            error?: string;
          };
          if (!res.ok || data?.success === false) {
            throw new Error(String(data?.message || data?.error || `HTTP ${res.status}`));
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Handover BG] đơn ${order.orderSn} fail:`, msg);
          rollbackHandoverOnLocalOrders(order);
          showScanToast(`Lưu ĐVVC nền thất bại #${order.orderSn}: ${msg}`, 'error');
        } finally {
          setHandingOverOrderId((cur) => (cur === order.id ? null : cur));
        }
      })();

      return true;
    },
    [applyHandoverToLocalOrders, onAddLog, openHandedOverCarrierTab, rollbackHandoverOnLocalOrders]
  );

  const handleOrderScan = React.useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed || isScanBusyRef.current) return;

      isScanBusyRef.current = true;
      setIsScanBusy(true);

      try {
        // Local HashMap từ scanner-sync — miss thì fallback HTTP lookup (Mongo + Shopee live).
        const syncHit = lookupScannerSyncMap(scannerSyncMapRef.current, trimmed);
        let order: Order | null = null;
        if (syncHit) {
          const fromPool = findOrderByScanPayload(ordersRef.current, trimmed, orderScanIndex);
          order = fromPool || scannerSyncEntryToOrder(syncHit);
        }

        if (!order) {
          setCameraScanResult(`Đang tra cứu mã: ${trimmed}...`);
          const token = localStorage.getItem('admin_token') || '';
          try {
            order = await lookupOrderByScanCode(
              trimmed,
              ordersRef.current,
              token,
              orderScanIndex,
            );
            if (order) {
              const nextMap = putOrderIntoScannerSyncMap(
                scannerSyncMapRef.current,
                order,
                trimmed,
              );
              scannerSyncMapRef.current = nextMap;
              setScannerSyncMap(nextMap);
            }
          } catch (lookupErr) {
            console.warn(
              '[Scan Lookup] HTTP fallback fail:',
              lookupErr instanceof ScanLookupError ? lookupErr.kind : lookupErr,
            );
            scanFeedback('error');
            setCameraScanSuccess(false);
            setCameraScanError(true);
            setCameraScanResult('Lỗi kết nối máy chủ khi tìm mã hoàn');
            showScanToast('Lỗi kết nối máy chủ khi tìm mã hoàn', 'error');
            setTimeout(() => setCameraScanError(false), 2000);
            return;
          }
        }

        if (order) {
          const idx = ordersRef.current.findIndex((o) => o.id === order!.id || o.orderSn === order!.orderSn);
          if (idx >= 0) {
            const merged = ordersRef.current.map((o, i) => (i === idx ? { ...o, ...order! } : o));
            ordersRef.current = merged;
            onUpdateOrders(merged, { persist: false });
          } else {
            const merged = [order, ...ordersRef.current];
            ordersRef.current = merged;
            onUpdateOrders(merged, { persist: false });
          }
        }

        if (!order) {
          scanFeedback('error');
          setCameraScanSuccess(false);
          setCameraScanError(true);
          setCameraScanResult(`Không tìm thấy đơn: ${trimmed}`);
          showScanToast(
            isLikelyTrackingCode(trimmed)
              ? `Không tìm thấy đơn hàng với mã vận đơn "${trimmed}"`
              : `Không tìm thấy đơn hàng này trong hệ thống (${trimmed})`,
            'error'
          );
          setTimeout(() => setCameraScanError(false), 2000);
          return;
        }

        if (isEligibleForHandOverToCarrier(order)) {
          const waybill = getOrderWaybillCode(order);
          // Optimistic + API nền — không await, mở khóa quét ngay.
          void handOverOrderToCarrier(order, {
            fromScan: true,
            switchTab: false,
          });
          scanFeedback('success');
          setCameraScanError(false);
          setCameraScanSuccess(true);
          setCameraScanResult(
            waybill
              ? `✓ Giao ĐVVC · VĐ ${waybill} · #${order.orderSn}`
              : `✓ Giao ĐVVC #${order.orderSn}`,
          );
          setTimeout(() => setCameraScanSuccess(false), 1500);
          return;
        }

        if (order.status === 'unprocessed') {
          scanFeedback('error');
          setCameraScanSuccess(false);
          setCameraScanError(true);
          setCameraScanResult(`Đơn #${order.orderSn} còn Chưa xử lý — không giao ĐVVC`);
          showScanToast(
            `Đơn #${order.orderSn} phải ở Chờ lấy hàng (đã xử lý) mới quét ĐVVC`,
            'error',
          );
          setTimeout(() => setCameraScanError(false), 2000);
          return;
        }

        if (
          order.status === 'cancelled' ||
          order.status === 'return_pending' ||
          scannedMatchesReturnWaybill(order, trimmed) ||
          Boolean(order.return_sn)
        ) {
          const isCancelRequest = order.status === 'cancelled' && !order.return_sn;
          const updated = ordersRef.current.map((o) =>
            o.id === order.id ? { ...o, status: 'return_received' as const } : o
          );
          ordersRef.current = updated;
          onUpdateOrders(updated, { persist: false });
          onAddLog({
            id: `log-${Date.now()}`,
            timestamp: new Date().toISOString(),
            channel: order.channel,
            type: 'stock_sync',
            status: 'success',
            message: `[QUÉT QR] Nhận hoàn đơn ${order.orderSn} → Yêu cầu trả hàng.`,
          });
          scanFeedback(isCancelRequest ? 'warning' : 'success');
          setCameraScanError(false);
          setCameraScanSuccess(true);
          setCameraScanResult(`✓ YCTH #${order.orderSn}`);
          showScanToast(
            isCancelRequest
              ? `Đơn báo hủy #${order.orderSn} — đã chuyển nhận kiện`
              : `Đã nhận hoàn / Yêu cầu trả hàng #${order.orderSn}`,
            'success'
          );
          setTimeout(() => setCameraScanSuccess(false), 2000);
          return;
        }

        if (order.status === 'shipping') {
          scanFeedback('warning');
          setCameraScanSuccess(false);
          setCameraScanError(true);
          const waybillShip = getOrderWaybillCode(order);
          setCameraScanResult(
            waybillShip
              ? `Đang giao · VĐ ${waybillShip} · #${order.orderSn}`
              : `Đơn #${order.orderSn} đang giao`,
          );
          showScanToast(`Đơn #${order.orderSn} đang giao — không cần xuất kho lại`, 'error');
          setTimeout(() => setCameraScanError(false), 2000);
          return;
        }

        if (order.status === 'return_received') {
          scanFeedback('error');
          setCameraScanSuccess(false);
          setCameraScanError(true);
          setCameraScanResult(`Đơn #${order.orderSn} đã nhận hoàn trước đó`);
          showScanToast(`Đơn #${order.orderSn} đã nhận hoàn`, 'error');
          setTimeout(() => setCameraScanError(false), 2000);
          return;
        }

        const statusLabels: Record<Order['status'], string> = {
          pending_verification: 'Chờ xác nhận',
          pending_confirm: 'Chờ xác nhận',
          unprocessed: 'Đơn chưa xử lý',
          processed: 'Chờ lấy hàng (Đã xử lý)',
          shipping: 'Đang giao',
          completed: 'Thành công',
          cancelled: 'Yêu cầu huỷ đơn',
          return_pending: 'Hủy giao chờ nhận',
          return_received: 'Hủy giao đã nhận',
        };
        const statusLabel = statusLabels[order.status] || order.status;
        scanFeedback('error');
        setCameraScanSuccess(false);
        setCameraScanError(true);
        setCameraScanResult(`Trạng thái không hợp lệ: ${statusLabel}`);
        showScanToast(`Đơn #${order.orderSn} — ${statusLabel}. Không thể xử lý tự động.`, 'error');
        setTimeout(() => setCameraScanError(false), 2000);
      } finally {
        isScanBusyRef.current = false;
        setIsScanBusy(false);
        try {
          scanGunInputRef.current?.blur();
        } catch {
          /* ignore */
        }
      }
    },
    [onUpdateOrders, onAddLog, orderScanIndex, handOverOrderToCarrier]
  );

  useEffect(() => {
    applyScanRef.current = handleOrderScan;
  }, [handleOrderScan]);

  const flashViewfinder = (type: 'success' | 'error', ms = 500) => {
    if (type === 'success') {
      setCameraScanError(false);
      setCameraScanSuccess(true);
      window.setTimeout(() => setCameraScanSuccess(false), ms);
    } else {
      setCameraScanSuccess(false);
      setCameraScanError(true);
      window.setTimeout(() => setCameraScanError(false), ms);
    }
  };

  const isCodeAlreadyVerified = (key: string) => {
    const inList = (list: ScanVerifiedItem[]) =>
      list.some((item) => normalizeOrderScanKey(item.code) === key || normalizeOrderScanKey(item.orderSn || '') === key);
    return (
      inList(daXuatKhoListRef.current) ||
      inList(donHuyListRef.current) ||
      inList(daNhanHoanListRef.current)
    );
  };

  /** Ghi đơn hủy/hoàn qua scan-bulk-update (resolve orderSn + items, không tạo đơn giả). */
  const persistCancelReturnScanFlag = React.useCallback(
    async (
      order: Order,
      kind: 'cancel' | 'return',
      scannedCode?: string,
    ) => {
      const token = localStorage.getItem('admin_token');
      const orderSn = String(order?.orderSn || '').replace(/^shopee-/i, '').trim();
      if (!token || !orderSn) return;
      const codes = [
        ...new Set(
          [
            orderSn,
            scannedCode,
            order.trackingNumber,
            order.tracking_no,
            order.return_tracking_no,
            order.id,
          ]
            .map((c) => String(c || '').trim())
            .filter(Boolean),
        ),
      ];
      try {
        const res = await fetch('/api/orders/scan-bulk-update', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            codes,
            scannedCodes: codes,
            donHuyCodes: kind === 'cancel' ? codes : [],
            daNhanHoanCodes: kind === 'return' ? codes : [],
          }),
        });
        const data = await res.json().catch(() => ({} as Record<string, unknown>));
        if (!res.ok || data?.success === false) {
          console.warn('[Scan] persist cancel/return flag failed:', data?.message || res.status);
          showScanToast(
            String(data?.message || `HTTP ${res.status} — không lưu được đơn hủy/hoàn`),
            'error',
          );
          return;
        }
        if (kind === 'return') {
          const nowIso = new Date().toISOString();
          const patched = ordersRef.current.map((o) =>
            o.id === order.id || o.orderSn === order.orderSn
              ? {
                  ...o,
                  local_status: 'RETURN_RECEIVED' as const,
                  localStatus: 'RETURN_RECEIVED' as const,
                  internal_status: 'RETURN_RECEIVED' as const,
                  scanFlag: 'RETURN_RECEIVED',
                  local_status_updated_at: nowIso,
                }
              : o,
          );
          ordersRef.current = patched;
          onUpdateOrders(patched, { persist: false });
        }
      } catch (err) {
        console.warn('[Scan] persist cancel/return flag error:', err);
        showScanToast(
          err instanceof Error ? err.message : 'Không kết nối được API lưu đơn.',
          'error',
        );
      }
    },
    [onUpdateOrders],
  );

  const confirmWarehouseReturnReceived = React.useCallback(
    async (order: Order) => {
      if (isWarehouseReturnReceived(order)) return;
      const token = localStorage.getItem('admin_token');
      const key = String(order.id || order.orderSn || '').trim();
      if (!token || !key) {
        showToast('Chưa đăng nhập — không thể xác nhận nhận hàng hoàn.');
        return;
      }
      setConfirmingReturnId(key);
      try {
        const res = await fetch(
          `/api/orders/${encodeURIComponent(key)}/confirm-return-received`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              orderId: order.id,
              orderSn: order.orderSn,
              local_status: 'RETURN_RECEIVED',
            }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          message?: string;
          order?: Order;
        };
        if (!res.ok || data?.success === false) {
          throw new Error(String(data?.message || `HTTP ${res.status}`));
        }
        const nowIso = new Date().toISOString();
        const patched = ordersRef.current.map((o) =>
          o.id === order.id || o.orderSn === order.orderSn
            ? {
                ...o,
                ...(data.order || {}),
                local_status: 'RETURN_RECEIVED' as const,
                localStatus: 'RETURN_RECEIVED' as const,
                internal_status: 'RETURN_RECEIVED' as const,
                scanFlag: 'RETURN_RECEIVED',
                local_status_updated_at: nowIso,
              }
            : o,
        );
        ordersRef.current = patched;
        onUpdateOrders(patched, { persist: false });
        showToast(`Đã xác nhận nhận hàng hoàn #${order.orderSn}`);
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: nowIso,
          channel: order.channel,
          type: 'stock_sync',
          status: 'success',
          message: `Xác nhận thủ công đã nhận hàng hoàn #${order.orderSn} (RETURN_RECEIVED).`,
        });
      } catch (err) {
        showToast(
          err instanceof Error ? err.message : 'Không xác nhận được hàng hoàn.',
        );
      } finally {
        setConfirmingReturnId(null);
      }
    },
    [onAddLog, onUpdateOrders],
  );

  /** Đẩy mã miss lên Backend queue — worker dò Shopee + ghi cờ độc lập FE. */
  const enqueueBackgroundLookup = React.useCallback(
    (rawCode: string) => {
      const trimmed = String(rawCode || '').trim();
      const key = normalizeOrderScanKey(trimmed);
      if (!trimmed || !key) return;
      if (scanBgPendingKeys.has(key)) return;
      setScanBgPendingKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      setScanBgPendingCount((c) => c + 1);
      void (async () => {
        const result = await enqueueScanBgCodes([trimmed]);
        if (!result.ok) {
          showScanToast(
            result.message || 'Không xếp được hàng đợi dò ngầm',
            'error',
          );
          return;
        }
        if (!isTearingDownScannerRef.current) {
          showScanToast(
            result.queued > 0
              ? `Đã xếp dò ngầm Backend (${result.pending} mã đang chờ)`
              : `Mã đã có trong hàng đợi dò ngầm (${result.pending} đang chờ)`,
            'success',
          );
        }
      })();
    },
    [scanBgPendingKeys],
  );

  /** Poll trạng thái worker Backend — badge + toast + refresh tab hủy/hoàn. */
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let abortCtrl: AbortController | null = null;
    let inFlight = false;
    const schedule = () => {
      if (cancelled) return;
      timer = window.setTimeout(() => {
        void poll();
      }, SCAN_BG_STATUS_POLL_MS);
    };
    const poll = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      inFlight = true;
      abortCtrl = new AbortController();
      const signal = abortCtrl.signal;
      try {
        const status = await fetchScanBgStatus(signal);
        if (cancelled || !status) return;
        const keys = buildScanBgPendingKeySet(status);
        setScanBgPendingKeys(keys);
        setScanBgPendingCount(status.pendingCount || 0);

        const unnotified = status.unnotified || [];
        if (unnotified.length > 0) {
          const toast = formatScanBgToast(status.summary);
          if (toast) {
            if (focusScanner) showScanToast(toast, 'success');
            else {
              showScanToast(toast, 'success');
            }
          }
          await ackScanBgNotifications(unnotified.map((j) => j.id));
          const saved =
            (status.summary?.cancelled || 0) + (status.summary?.returnReceived || 0);
          if (saved > 0) {
            const expectedTab = activeSubTabRef.current;
            void onFetchOrdersRef.current?.({
              silent: true,
              page: 1,
              limit: ORDERS_PAGE_SIZE,
              merge: false,
              tab: expectedTab === 'all' ? '' : expectedTab,
              kind:
                expectedTab === 'cancel_returns'
                  ? cancelReturnKindParam(cancelReturnTabRef.current)
                  : undefined,
            });
          }
        }
      } finally {
        inFlight = false;
        schedule();
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      abortCtrl?.abort();
    };
  }, [focusScanner]);

  const verifySingleOrder = React.useCallback(
    async (rawQuery: string) => {
      const trimmed = String(rawQuery || '').trim();
      if (!trimmed || isFlushingQueue || isTearingDownScannerRef.current) return;

      const key = normalizeOrderScanKey(trimmed);
      if (!key) return;

      const now = Date.now();
      // Debounce 400ms cùng mã — tránh double-beep khi giữ camera, vẫn cho quét liên tục mã khác.
      if (key === lastQrScanRef.current.key && now - lastQrScanRef.current.at < 400) {
        return;
      }

      if (isCodeAlreadyVerified(key)) {
        lastQrScanRef.current = { key, at: now };
        playScanSound('warning');
        vibrateScan('warning');
        flashViewfinder('error', 500);
        setCameraScanResult(`Mã đã quét trong phiên này: ${trimmed}`);
        showScanToast('Mã này đã có trong danh sách phiên quét', 'error');
        return;
      }

      // Đang verify mã khác → xếp hàng, không bỏ mã khi quét liên tục.
      if (isScanBusyRef.current) {
        const q = pendingScanQueueRef.current;
        if (!q.some((c) => normalizeOrderScanKey(c) === key) && q.length < 20) {
          q.push(trimmed);
        }
        return;
      }

      lastQrScanRef.current = { key, at: now };

      // Local HashMap O(1) từ scanner-sync — miss thì BẮT BUỘC fallback HTTP lookup.
      const syncHit = lookupScannerSyncMap(scannerSyncMapRef.current, trimmed);
      let localOrder: Order | null = null;
      if (syncHit) {
        const fromPool = findOrderByScanPayload(ordersRef.current, trimmed, orderScanIndex);
        localOrder = fromPool || scannerSyncEntryToOrder(syncHit);
        if (syncHit.matchedReturn && localOrder) {
          localOrder = {
            ...localOrder,
            return_tracking_no: syncHit.return_waybill || localOrder.return_tracking_no,
            returnTrackingNumber:
              syncHit.return_waybill || localOrder.returnTrackingNumber,
            return_sn: localOrder.return_sn || 'scanner-sync',
            status:
              localOrder.status === 'return_received' ? 'return_received' : 'return_pending',
          };
        }
      }

      isScanBusyRef.current = true;
      setIsVerifyingScan(true);

      try {
        if (!localOrder) {
          setCameraScanResult(`Đang tra cứu mã hoàn: ${trimmed}...`);
          const token = localStorage.getItem('admin_token') || '';
          try {
            const remote = await lookupOrderByScanCode(
              trimmed,
              ordersRef.current,
              token,
              orderScanIndex,
            );
            if (remote) {
              const scannedIsReturn =
                scannedMatchesReturnWaybill(remote, trimmed) ||
                (Boolean(remote.return_sn) &&
                  normalizeOrderScanKey(trimmed) !==
                    normalizeOrderScanKey(
                      remote.tracking_no || remote.trackingNumber || '',
                    ));
              localOrder = scannedIsReturn
                ? {
                    ...remote,
                    return_tracking_no:
                      remote.return_tracking_no || remote.returnTrackingNumber || trimmed,
                    returnTrackingNumber:
                      remote.returnTrackingNumber || remote.return_tracking_no || trimmed,
                    status:
                      remote.status === 'return_received' ? 'return_received' : 'return_pending',
                  }
                : remote;
              const nextMap = putOrderIntoScannerSyncMap(
                scannerSyncMapRef.current,
                localOrder,
                trimmed,
              );
              scannerSyncMapRef.current = nextMap;
              setScannerSyncMap(nextMap);
            }
          } catch (lookupErr) {
            console.warn(
              '[Scan Lookup] HTTP fallback fail:',
              lookupErr instanceof ScanLookupError ? lookupErr.kind : lookupErr,
            );
            playScanSound('error');
            vibrateScan('error');
            flashViewfinder('error', 400);
            setCameraScanResult('Lỗi kết nối máy chủ khi tìm mã hoàn');
            showScanToast('Lỗi kết nối máy chủ khi tìm mã hoàn', 'error');
            return;
          }
        }

        if (!localOrder) {
          playScanSound('error');
          vibrateScan('error');
          flashViewfinder('error', 400);
          setCameraScanResult(`Không tìm thấy mã: ${trimmed}`);
          showScanToast(
            isLikelyTrackingCode(trimmed)
              ? `Không có trong danh sách đã tải: "${trimmed}"`
              : `Mã không khớp pool quét đã tải (${trimmed})`,
            'error',
          );
          return;
        }

        setCameraScanResult(`Đang phân loại: ${trimmed}...`);
        const order = localOrder;

        const idx = ordersRef.current.findIndex(
          (o) => o.id === order.id || o.orderSn === order.orderSn,
        );
        if (idx >= 0) {
          const merged = ordersRef.current.map((o, i) => (i === idx ? { ...o, ...order } : o));
          ordersRef.current = merged;
          onUpdateOrders(merged, { persist: false });
        } else {
          const merged = [order, ...ordersRef.current];
          ordersRef.current = merged;
          onUpdateOrders(merged, { persist: false });
        }

        // Phân loại theo cancel/return kind + badge — gồm failed_delivery / hoàn / hủy.
        const badge = resolveOrderBadgeStatus(order);
        const raw = getShopeeOrderRawStatus(order);
        const cancelReturnKind = resolveCancelReturnKind(order);
        const matchedReturnWaybill = scannedMatchesReturnWaybill(order, trimmed);
        const classified = classifyScanCancelReturnBuckets(order);
        const isReturnBucket = classified.isReturnBucket || matchedReturnWaybill;
        const isCancelBucket = !isReturnBucket && classified.isCancelBucket;

        // Đang giao (SHIPPED) / đã bàn giao thuần — tìm thấy rồi, không báo "không tìm thấy".
        const isShippingOnly =
          !isReturnBucket &&
          !isCancelBucket &&
          (matchesShippingTab(order) ||
            badge === 'shipping' ||
            order.status === 'shipping' ||
            raw === 'SHIPPED' ||
            raw === 'TO_CONFIRM_RECEIVE');

        // Chặn trùng DB — HANDED_OVER + hủy/hoàn đã được nới trong isOrderAlreadyScanProcessed.
        if (isOrderAlreadyScanProcessed(order) && !isReturnBucket && !isCancelBucket) {
          const reason = isShippingOnly
            ? `Đơn #${order.orderSn} đang giao / đã bàn giao ĐVVC`
            : getScanProcessedReason(order);
          playScanSound('warning');
          vibrateScan('warning');
          flashViewfinder('error', 500);
          setCameraScanResult(`⚠ ${reason}`);
          showScanToast(reason, 'error');
          return;
        }

        if (isShippingOnly && !isEligibleForHandOverToCarrier(order)) {
          const waybillShip = getOrderWaybillCode(order);
          playScanSound('warning');
          vibrateScan('warning');
          flashViewfinder('error', 500);
          setCameraScanResult(
            waybillShip
              ? `Đang giao · VĐ ${waybillShip} · #${order.orderSn}`
              : `Đơn #${order.orderSn} đang giao`,
          );
          showScanToast(
            `Đơn #${order.orderSn} đang giao — không cần xuất kho lại`,
            'error',
          );
          return;
        }

        const waybill =
          (matchedReturnWaybill && order.return_tracking_no) ||
          getOrderWaybillCode(order);
        const orderKey = normalizeOrderScanKey(order.orderSn || order.id);
        if (
          isCodeAlreadyVerified(orderKey) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(waybill)) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(order.trackingNumber || '')) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(order.tracking_no || '')) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(order.return_tracking_no || ''))
        ) {
          playScanSound('warning');
          vibrateScan('warning');
          flashViewfinder('error', 500);
          showScanToast(`Đơn #${order.orderSn} đã quét trong phiên này`, 'error');
          return;
        }

        const item: ScanVerifiedItem = {
          id: `sv-${now}-${Math.random().toString(36).slice(2, 7)}`,
          code: trimmed,
          orderId: order.id,
          orderSn: order.orderSn,
          trackingNumber: waybill || order.trackingNumber || order.tracking_no || order.internalTrackingCode,
          at: now,
        };

        // Ưu tiên hủy/hoàn trước xuất kho — đơn từng bàn giao rồi bị hủy/hoàn.
        if (isReturnBucket) {
          playScanSound('success');
          vibrateScan('success');
          flashViewfinder('success', 500);
          setDaNhanHoanList((prev) => {
            const next = [item, ...prev];
            daNhanHoanListRef.current = next;
            return next;
          });
          // Continuous scan: chỉ ghi list cục bộ — commit Mongo 1 lần khi bấm Kết thúc.
          setCameraScanResult(
            waybill
              ? `✓ YCTH · VĐ hoàn ${waybill} · #${order.orderSn}`
              : `✓ Yêu cầu trả hàng #${order.orderSn}`,
          );
          showScanToast(
            waybill
              ? `Yêu cầu trả hàng #${order.orderSn} — mã VĐ hoàn: ${waybill}`
              : `Đơn hoàn #${order.orderSn} — đã ghi nhận vào Yêu cầu trả hàng`,
            'success',
          );
          return;
        }

        if (isCancelBucket) {
          const isFailedDelivery = cancelReturnKind === 'failed_delivery';
          playScanSound('warning');
          vibrateScan('warning');
          flashViewfinder('error', 500);
          setDonHuyList((prev) => {
            const next = [item, ...prev];
            donHuyListRef.current = next;
            return next;
          });
          // Continuous scan: chỉ ghi list cục bộ — commit Mongo 1 lần khi bấm Kết thúc.
          setCameraScanResult(
            waybill
              ? isFailedDelivery
                ? `⚠ GIAO THẤT BẠI · VĐ ${waybill} · #${order.orderSn}`
                : `⚠ ĐƠN HỦY · VĐ ${waybill} · #${order.orderSn}`
              : isFailedDelivery
                ? `⚠ GIAO THẤT BẠI #${order.orderSn}`
                : `⚠ ĐƠN HỦY #${order.orderSn} — loại kiện này ra!`,
          );
          showScanToast(
            isFailedDelivery
              ? `Giao không thành công #${order.orderSn} — đã ghi nhận nhận kiện`
              : `CẢNH BÁO: Đơn hủy #${order.orderSn} — hãy loại kiện hàng này`,
            'error',
          );
          return;
        }

        if (isEligibleForHandOverToCarrier(order)) {
          playScanSound('success');
          vibrateScan('success');
          flashViewfinder('success', 500);
          setDaXuatKhoList((prev) => {
            const next = [item, ...prev];
            daXuatKhoListRef.current = next;
            return next;
          });
          // Continuous scan: chỉ ghi list cục bộ — commit Mongo 1 lần khi bấm Kết thúc.
          setCameraScanResult(
            waybill
              ? `✓ Xuất kho · VĐ ${waybill} · #${order.orderSn}`
              : `✓ Xuất kho #${order.orderSn}`,
          );
          showScanToast(
            waybill
              ? `Xuất kho #${order.orderSn} — mã VĐ: ${waybill}`
              : `Đơn chờ lấy hàng (đã xử lý) #${order.orderSn} — đã ghi nhận xuất kho`,
            'success',
          );
          return;
        }

        if (badge === 'unprocessed' || order.status === 'unprocessed') {
          playScanSound('error');
          vibrateScan('error');
          flashViewfinder('error', 500);
          setCameraScanResult(`Đơn #${order.orderSn} còn Chưa xử lý — không xuất kho ĐVVC`);
          showScanToast(
            `Chỉ quét đơn ở Chờ lấy hàng (đã xử lý), Đơn hủy hoặc Đơn hoàn`,
            'error',
          );
          return;
        }

        const reason = getHandOverIneligibleReason(order);
        playScanSound('error');
        vibrateScan('error');
        flashViewfinder('error', 500);
        setCameraScanResult(
          reason
            ? `Đơn #${order.orderSn} — ${reason}`
            : `Đơn #${order.orderSn} — trạng thái không xử lý được`,
        );
        showScanToast(
          reason || `Đơn #${order.orderSn} không thuộc trạng thái cần phân loại`,
          'error',
        );
      } finally {
        isScanBusyRef.current = false;
        setIsVerifyingScan(false);
        setIsScanBusy(false);
        try {
          scanGunInputRef.current?.blur();
          const active = document.activeElement as HTMLElement | null;
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
            active.blur();
          }
        } catch {
          /* ignore */
        }
        const nextQueued = pendingScanQueueRef.current.shift();
        if (nextQueued && !isTearingDownScannerRef.current) {
          queueMicrotask(() => {
            void verifySingleOrder(nextQueued);
          });
        }
      }
    },
    [isFlushingQueue, orderScanIndex, onUpdateOrders]
  );

  useEffect(() => {
    verifyScanRef.current = (q: string) => {
      void verifySingleOrder(q);
    };
  }, [verifySingleOrder]);

  // Súng USB: bắt phím ở document — không focus input (tránh bàn phím ảo mobile).
  useEffect(() => {
    if (!focusScanner) return;
    try {
      scanGunInputRef.current?.blur();
    } catch {
      /* ignore */
    }
    let buf = '';
    let flushTimer: number | undefined;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target !== scanGunInputRef.current &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const code = buf.trim();
        buf = '';
        if (code) verifyScanRef.current(code);
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        buf += e.key;
        if (flushTimer) window.clearTimeout(flushTimer);
        flushTimer = window.setTimeout(() => {
          buf = '';
        }, 120);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (flushTimer) window.clearTimeout(flushTimer);
    };
  }, [focusScanner]);

  useEffect(() => {
    let isMounted = true;

    if (focusScanner) {
      // Tránh restart camera khi đang graceful teardown / đang ghi DB.
      if (isTearingDownScannerRef.current) {
        return () => {
          isMounted = false;
        };
      }

      setCameraScanSuccess(false);
      setCameraScanError(false);
      setCameraError('');
      lastQrScanRef.current = { key: '', at: 0 };
      pendingScanQueueRef.current = [];
      isScanBusyRef.current = false;
      setCameraScanResult((prev) =>
        prev.includes('Xuất kho') ||
        prev.includes('ĐƠN HỦY') ||
        prev.includes('Nhận hoàn') ||
        prev.includes('sẵn sàng quét tiếp') ||
        prev.includes('Đã lưu') ||
        prev.includes('Lưu thất bại')
          ? prev
          : 'Quét realtime QR + mã vạch — dò trạng thái ngay mỗi mã',
      );

      const timer = setTimeout(() => {
        if (!isMounted || isTearingDownScannerRef.current) return;

        const element = document.getElementById('camera-reader');
        if (!element) {
          console.error('camera-reader element not found');
          setCameraError('Không tìm thấy vùng hiển thị camera.');
          return;
        }

        const qrCodeSuccessCallback = (decodedText: string) => {
          if (!decodedText?.trim() || isTearingDownScannerRef.current) return;
          // Realtime: verify ngay — không xếp hàng đợi batch.
          verifyScanRef.current(decodedText);
        };

        void startLiveQrScanner({
          containerId: 'camera-reader',
          tapLayerId: CAMERA_TAP_LAYER_ID,
          onSuccess: qrCodeSuccessCallback,
        })
          .then((handle) => {
            if (!isMounted || isTearingDownScannerRef.current) {
              void handle.stop();
              return;
            }
            liveScannerRef.current = handle;
          })
          .catch((err: unknown) => {
            console.error('Camera scanner start failed:', err);
            const msg =
              err instanceof Error ? err.message : 'Không thể khởi động camera.';
            setCameraError(
              msg === HTTPS_CAMERA_MESSAGE
                ? msg
                : `Không thể khởi động Camera${msg ? `: ${msg}` : ''}. Bấm "Thử lại".`,
            );
          });
      }, 200);

      return () => {
        isMounted = false;
        clearTimeout(timer);
        // Nếu finish handler đã/đang teardown — không stop lần 2 (tránh race removeChild).
        if (isTearingDownScannerRef.current) return;
        stopTapToFocusAssist(CAMERA_TAP_LAYER_ID);
        const handle = liveScannerRef.current;
        liveScannerRef.current = null;
        void handle?.stop().catch((err) => console.error('Error stopping QR scanner', err));
      };
    }

    return () => {
      isMounted = false;
    };
  }, [focusScanner, cameraRestartKey]);

  // Prefetch scanner-sync 1 lần khi mở quét — HashMap local O(1), không shallow 50.
  useEffect(() => {
    if (!focusScanner) return;
    let cancelled = false;
    (async () => {
      const token = localStorage.getItem('admin_token') || '';
      try {
        const res = await fetch('/api/orders/scanner-sync', {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          orders?: Array<{
            order_id: string;
            tracking_code: string;
            return_waybill: string;
            status: string;
          }>;
          code_count?: number;
        };
        if (cancelled) return;
        const rows = Array.isArray(data.orders) ? data.orders : [];
        const map = buildScannerSyncMap(rows);
        scannerSyncMapRef.current = map;
        setScannerSyncMap(map);
        setScannerSyncCodeCount(
          Number.isFinite(Number(data.code_count)) ? Number(data.code_count) : map.size,
        );
      } catch (err) {
        console.warn('[Scan Prefetch] scanner-sync fail:', err);
        if (!cancelled) {
          setScannerSyncMap(new Map());
          setScannerSyncCodeCount(0);
          showScanToast('Không tải được danh sách mã quét — thử mở lại màn quét', 'error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusScanner, shopIdsKey]);

  // Search / sort
  const [selectedSort] = useState<'newest' | 'oldest' | 'highest_value'>('newest');
  /** Client-side: ưu tiên + gom nhóm đơn 1 SP (tab Chờ lấy hàng chưa xử lý). */
  const [smartPickSort, setSmartPickSort] = useState(false);

  // Multi-select bulk state
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [showBulkActionsDropdown, setShowBulkActionsDropdown] = useState(false);
  /** Tab Đơn chưa xử lý: lọc theo ĐVVC — all | spx | ghn | instant | other */
  const [selectedShippingCarrier, setSelectedShippingCarrier] =
    useState<ShippingCarrierFilter>('all');

  // Detail Modal & Bulk Print Modal
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  const toggleOrderDetails = useCallback((orderId: string) => {
    setExpandedOrderId((prev) => (prev === orderId ? null : orderId));
  }, []);
  const [bulkPrintOrders, setBulkPrintOrders] = useState<Order[] | null>(null);

  // Real Shopee/TikTok logistics API call state (ship_order / shipping document)
  const [printingOrderId, setPrintingOrderId] = useState<string | null>(null);
  const [isBulkPrinting, setIsBulkPrinting] = useState(false);

  const handlePrintExternalWaybill = useCallback(async (order: Order) => {
    const key = String(order.id || order.orderSn || '').trim();
    if (!key || printingOrderId) return;
    setPrintingOrderId(key);
    try {
      const token = localStorage.getItem('admin_token') || '';
      const res = await fetch('/api/orders/external/print-waybill', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ orderSn: order.orderSn, format: 'a5' }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok || !data?.success) {
        throw new Error(String(data?.error || 'In vận đơn thất bại'));
      }
      const pdfB64 = String(data.pdfBase64 || '').trim();
      if (pdfB64) {
        const bin = atob(pdfB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        window.open(blobUrl, '_blank');
        return;
      }
      const url = String(data.url || '').trim();
      if (!url) throw new Error('Hãng không trả link PDF gốc.');
      window.open(url, '_blank');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'In vận đơn thất bại';
      window.alert(msg);
    } finally {
      setPrintingOrderId(null);
    }
  }, [printingOrderId]);

  // "Xác nhận đơn hàng" modal — lets the seller choose pickup vs dropoff before
  // any ship_order call is made, for one order (single button) or many (bulk).
  const [shipConfirmOrders, setShipConfirmOrders] = useState<Order[] | null>(null);
  const [shipMethod, setShipMethod] = useState<'pickup' | 'dropoff'>('dropoff');
  const [isShipping, setIsShipping] = useState(false);
  const [isScanBusy, setIsScanBusy] = useState(false);

  /** Modal "Tiếp tục In Đơn" — bypass popup blocker sau await xác nhận hàng loạt. */
  type PendingAutoPrint = {
    pdfFilename?: string | null;
    url?: string | null;
    successfullyConfirmedIds: string[];
    count: number;
  };
  const [pendingAutoPrint, setPendingAutoPrint] = useState<PendingAutoPrint | null>(null);
  const [silentPrintSrc, setSilentPrintSrc] = useState<string | null>(null);

  // Floating "processing..." overlay shown during any real Shopee API call
  // (ship_order / create+download shipping document), single or bulk — gives
  // the seller immediate visual feedback instead of just a disabled button.
  const [progressMessage, setProgressMessage] = useState<string | null>(null);
  const [progressCompleted, setProgressCompleted] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [progressDone, setProgressDone] = useState(false);
  const [shipJobResults, setShipJobResults] = useState<any[]>([]);
  const [shipConfirmSummary, setShipConfirmSummary] = useState<{
    total: number;
    successCount: number;
    failCount: number;
    successfulOrderIds: string[];
    failedOrderDetails: Array<{ orderSn?: string; orderId?: string; error?: string; message?: string }>;
  } | null>(null);
  const [isPrintingFromSummary, setIsPrintingFromSummary] = useState(false);
  const [isFetchingPdf, setIsFetchingPdf] = useState(false);
  const progressCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Khóa click In đơn — chặn double-fire / bubbling / 2 view cùng lúc (≥1440px). */
  const isPrintingRef = React.useRef(false);
  const isPrintingUnlockTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Khóa mở PDF toàn cục — chỉ 1 tab mỗi phiên in (kể cả await fetch). */
  const pdfOpenSessionRef = React.useRef(false);
  const pdfOpenUnlockTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOpenedPdfKeyRef = React.useRef('');

  // Auto-hiding toast — replaces blocking alert() in bulk ship/print flows.
  // (state + showToast khai báo gần đầu component — dùng chung Làm mới / in / bàn giao)

  const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('admin_token');
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  };

  const releasePdfOpenSession = () => {
    if (pdfOpenUnlockTimerRef.current) clearTimeout(pdfOpenUnlockTimerRef.current);
    pdfOpenUnlockTimerRef.current = window.setTimeout(() => {
      pdfOpenSessionRef.current = false;
      lastOpenedPdfKeyRef.current = '';
      pdfOpenUnlockTimerRef.current = null;
    }, 2000);
  };

  const beginPdfOpenSession = (sessionKey: string, force = false): boolean => {
    if (!force && pdfOpenSessionRef.current) return false;
    pdfOpenSessionRef.current = true;
    lastOpenedPdfKeyRef.current = sessionKey;
    releasePdfOpenSession();
    return true;
  };

  const revokeSilentPrintBlob = () => {
    setSilentPrintSrc(null);
  };

  /** In ngầm qua iframe — bypass popup blocker sau await API (URL tĩnh, không blob). */
  const printPdfViaHiddenIframe = (printUrl: string): void => {
    const absolute = /^https?:\/\//i.test(printUrl)
      ? printUrl
      : new URL(printUrl.startsWith('/') ? printUrl : `/${printUrl}`, window.location.origin).href;
    setSilentPrintSrc(absolute);
  };

  const handleSilentPrintIframeLoad = (e: React.SyntheticEvent<HTMLIFrameElement>) => {
    const iframe = e.currentTarget;
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      showToast('Đang mở hộp thoại in vận đơn...');
    } catch (err) {
      console.error('[Auto-Print] iframe.print() lỗi:', err);
    }
    window.setTimeout(() => {
      revokeSilentPrintBlob();
    }, 120_000);
  };

  /** Chỉ mở đúng 1 tab in — trả về Window|null để phát hiện popup bị chặn. */
  const openPrintUrlInBlankTab = (printUrl: string): Window | null => {
    const raw = String(printUrl || '').trim();
    if (!raw || raw === '/' || raw === '#') return null;
    const absolute = /^https?:\/\//i.test(raw)
      ? raw
      : new URL(raw.startsWith('/') ? raw : `/${raw}`, window.location.origin).href;
    return window.open(absolute, '_blank');
  };

  /**
   * Mở tab placeholder ngay trong user-gesture (tránh popup blocker sau await ship).
   * Tab độc lập (không React) → dùng HTML/CSS/JS thuần: spinner + đếm ngược mượt.
   */
  const openReservedPrintPlaceholder = (): Window | null => {
    try {
      const win = window.open('about:blank', '_blank');
      if (!win) return null;
      try {
        win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Đang tạo vận đơn...</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    height: 100%;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, system-ui, sans-serif;
    background: linear-gradient(135deg, #eff6ff 0%, #ffffff 50%, #eff6ff 100%);
    color: #1e293b;
  }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    max-width: 420px;
    width: 100%;
    background: #ffffff;
    border-radius: 24px;
    box-shadow: 0 20px 60px rgba(15, 23, 42, 0.12);
    padding: 40px 36px;
    text-align: center;
    animation: fadeIn 0.4s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .spinner-wrap {
    position: relative;
    width: 72px;
    height: 72px;
    margin: 0 auto 24px;
  }
  .spinner-ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 4px solid #dbeafe;
  }
  .spinner-arc {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 4px solid transparent;
    border-top-color: #2563eb;
    border-right-color: #2563eb;
    animation: spin 0.9s linear infinite;
  }
  .spinner-check {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    color: #059669;
    animation: popIn 0.4s ease-out;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes popIn {
    from { transform: scale(0.5); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
  h2 {
    font-size: 19px;
    font-weight: 800;
    color: #0f172a;
    margin-bottom: 10px;
  }
  .status-line {
    font-size: 14px;
    color: #475569;
    font-weight: 600;
    margin-bottom: 18px;
    min-height: 20px;
  }
  .countdown {
    color: #2563eb;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }
  .progress-track {
    width: 100%;
    height: 6px;
    background: #eef2ff;
    border-radius: 999px;
    overflow: hidden;
    margin-bottom: 18px;
  }
  .progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #3b82f6, #2563eb);
    border-radius: 999px;
    transition: width 0.3s linear;
  }
  .progress-fill.done { background: #059669; width: 100% !important; }
  .hint {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: #64748b;
    font-weight: 600;
    background: #f8fafc;
    padding: 8px 14px;
    border-radius: 999px;
  }
  .hint.done { color: #059669; background: #ecfdf5; }
  .dots span {
    display: inline-block;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #3b82f6;
    margin: 0 2px;
    animation: bounce 1.2s infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
    30% { transform: translateY(-4px); opacity: 1; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner-wrap">
      <div class="spinner-ring"></div>
      <div class="spinner-arc" id="spinnerArc"></div>
      <div class="spinner-check" id="spinnerCheck">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
      </div>
    </div>
    <h2>Đã xác nhận đơn hàng</h2>
    <div class="status-line" id="statusLine">
      Đang chờ Shopee tạo vận đơn (<span class="countdown" id="countdown">12</span> giây)
      <span class="dots" id="dots"><span></span><span></span><span></span></span>
    </div>
    <div class="progress-track"><div class="progress-fill" id="progressFill"></div></div>
    <div class="hint" id="hintBox">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
      </svg>
      <span>PDF sẽ tự mở khi sẵn sàng — vui lòng không đóng tab này</span>
    </div>
  </div>
  <script>
    (function () {
      var totalMs = 12000;
      var startedAt = Date.now();
      var countdownEl = document.getElementById('countdown');
      var fillEl = document.getElementById('progressFill');
      var tick = function () {
        var elapsed = Date.now() - startedAt;
        var remainMs = Math.max(0, totalMs - elapsed);
        var remainSec = Math.ceil(remainMs / 1000);
        if (countdownEl) countdownEl.textContent = String(remainSec);
        if (fillEl) fillEl.style.width = Math.min(100, (elapsed / totalMs) * 100) + '%';
        if (remainMs > 0) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
  </script>
</body></html>`);
        win.document.close();
      } catch {
        /* cross-origin / blank restrictions — vẫn giữ window reference */
      }
      return win;
    } catch {
      return null;
    }
  };

  const navigateReservedPrintWindow = (
    win: Window | null | undefined,
    printUrl: string
  ): boolean => {
    const raw = String(printUrl || '').trim();
    if (!raw || !win || win.closed) return false;
    const fullUrl = resolveLabelFetchUrl(raw);
    try {
      win.location.href = fullUrl;
      showToast('Đã mở vận đơn — bấm In trên trình xem PDF.');
      return true;
    } catch (err) {
      console.warn('[Auto-Print] Navigate reserved window failed:', err);
      return false;
    }
  };

  const closeReservedPrintWindow = (win: Window | null | undefined) => {
    if (!win || win.closed) return;
    try {
      win.close();
    } catch {
      /* ignore */
    }
  };

  const queuePendingAutoPrint = (
    opts: {
      pdfFilename?: string | null;
      url?: string | null;
    },
    successfullyConfirmedIds: string[] = []
  ) => {
    setPendingAutoPrint({
      pdfFilename: opts.pdfFilename,
      url: opts.url,
      successfullyConfirmedIds,
      count: successfullyConfirmedIds.length || 1,
    });
  };

  /** Mở PDF qua static URL /api/public/labels/ — ưu tiên tab đã mở sẵn (user-gesture). */
  const openShopeeLabelFromStream = async (
    opts: {
      pdfFilename?: string | null;
      url?: string | null;
    },
    options?: {
      force?: boolean;
      successfullyConfirmedIds?: string[];
      showContinueModalOnBlock?: boolean;
      reservedWindow?: Window | null;
    }
  ) => {
    const printUrl = String(opts.url || '').trim();
    const sessionKey = printUrl;
    if (!sessionKey || !beginPdfOpenSession(sessionKey, !!options?.force)) return;

    const confirmedIds = options?.successfullyConfirmedIds || [];
    const showModalOnBlock = options?.showContinueModalOnBlock !== false;
    const fullUrl = resolveLabelFetchUrl(printUrl);

    // Ưu tiên tab đã reserve từ lúc bấm Xác nhận (cùng gesture → không bị chặn).
    if (navigateReservedPrintWindow(options?.reservedWindow, fullUrl)) {
      return;
    }

    const win = openPrintUrlInBlankTab(fullUrl);
    if (win) {
      showToast('Đã mở vận đơn — bấm In trên trình xem PDF.');
      return;
    }

    console.warn('[Auto-Print] window.open bị chặn — chuyển iframe print / modal tiếp tục.');
    printPdfViaHiddenIframe(fullUrl);
    if (showModalOnBlock) {
      queuePendingAutoPrint(opts, confirmedIds);
      showToast('Trình duyệt chặn popup — đang in ngầm; bấm "Tiếp tục In Đơn" nếu cần.');
    } else {
      showToast('Đang mở hộp thoại in vận đơn...');
    }
  };

  const handleContinueAutoPrint = async () => {
    if (!pendingAutoPrint) return;
    const payload = pendingAutoPrint;
    setPendingAutoPrint(null);

    if (payload.url) {
      await openShopeeLabelFromStream(
        {
          pdfFilename: payload.pdfFilename,
          url: payload.url,
        },
        {
          force: true,
          successfullyConfirmedIds: payload.successfullyConfirmedIds,
          showContinueModalOnBlock: false,
        }
      );
      return;
    }

    if (payload.successfullyConfirmedIds.length > 0) {
      const printResult = await printShopeeDocuments(payload.successfullyConfirmedIds, {
        openPdf: true,
      });
      if (!printResult.success && printResult.message) showToast(printResult.message);
    }
  };

  const handlePackingSlipPrint = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => window.print(), 150);
      });
    });
  };

  type PrintDocumentResponse = {
    success?: boolean;
    url?: string;
    mergedUrl?: string;
    urls?: string[];
    pdfFilename?: string;
    documents?: {
      url?: string;
      pdfFilename?: string;
      orderSn?: string;
      orderSns?: string[];
      message?: string;
      error?: string;
    }[];
    orders?: Order[];
    error?: string;
    message?: string;
    missingOrderSns?: string[];
  };

  const TRACKING_MISSING_TOAST =
    'Shopee chưa xuất được PDF vận đơn. Đơn đã xác nhận — thử In đơn lại sau ít phút.';

  /** Tải PDF riêng lẻ — gắn tên file theo Order SN (tránh popup blocker khi nhiều tab). */
  const downloadLabelPdf = async (rawUrl: string, orderSn?: string, pdfFilename?: string) => {
    const fullUrl = resolveLabelFetchUrl(rawUrl);
    const safeSn = String(orderSn || '')
      .replace(/^shopee-/i, '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .trim();
    const fromApi = String(pdfFilename || '').trim();
    const filename =
      (fromApi && !fromApi.includes('..') && !fromApi.includes('/') ? fromApi : '') ||
      (safeSn ? `order_${safeSn}.pdf` : `van-don-${Date.now()}.pdf`);
    try {
      const res = await fetch(fullUrl, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
      return true;
    } catch (err) {
      console.warn('[Print Download] fetch blob failed, fallback open tab:', err);
      window.open(fullUrl, '_blank', 'noopener,noreferrer');
      return false;
    }
  };

  /** Tên file gộp nhiều vận đơn A4 — gọn, dễ Ctrl+P. */
  const buildBatchVanDonFilename = (orderCount: number) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `Danh_Sach_Van_Don_${Math.max(1, orderCount)}_${ts}.pdf`;
  };

  /**
   * Ghép nhiều PDF thành 1 file A4 (mỗi nguồn giữ nguyên trang) → tải đúng 1 lần.
   * Dùng khi BE đã merge trong chunk hoặc khi FE gom nhiều chunk.
   */
  const mergeAndDownloadLabelPdfs = async (
    rawUrls: string[],
    opts?: { filename?: string; orderCount?: number },
  ): Promise<{ ok: boolean; filename: string }> => {
    const uniqueUrls = [
      ...new Set(rawUrls.map((u) => resolveLabelFetchUrl(String(u || '').trim())).filter(Boolean)),
    ];
    const filename =
      opts?.filename && !opts.filename.includes('..') && !opts.filename.includes('/')
        ? opts.filename
        : buildBatchVanDonFilename(opts?.orderCount || uniqueUrls.length);

    if (uniqueUrls.length === 0) return { ok: false, filename };
    if (uniqueUrls.length === 1) {
      const ok = await downloadLabelPdf(uniqueUrls[0], undefined, filename);
      return { ok, filename };
    }

    try {
      const { PDFDocument } = await import('pdf-lib');
      const merged = await PDFDocument.create();
      for (const url of uniqueUrls) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} khi tải ${url}`);
        const bytes = await res.arrayBuffer();
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(src, src.getPageIndices());
        for (const page of pages) merged.addPage(page);
      }
      const out = await merged.save();
      const blob = new Blob([new Uint8Array(out)], { type: 'application/pdf' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      return { ok: true, filename };
    } catch (err) {
      console.warn('[Print Merge] pdf-lib merge failed, fallback tải từng file:', err);
      for (let i = 0; i < uniqueUrls.length; i++) {
        await downloadLabelPdf(uniqueUrls[i]);
        if (i < uniqueUrls.length - 1) await new Promise((r) => setTimeout(r, 200));
      }
      return { ok: false, filename };
    }
  };

  const fetchPrintDocumentSync = async (
    orderIds: string[],
    opts?: { waitMs?: number }
  ): Promise<{
    ok: boolean;
    status: number;
    data: PrintDocumentResponse;
  }> => {
    const res = await fetch('/api/shopee/print-document', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        orderIds,
        ...(opts?.waitMs != null && opts.waitMs > 0 ? { waitMs: opts.waitMs } : {}),
      }),
    });
    const data = await parseJsonResponse<PrintDocumentResponse>(res);
    return { ok: res.ok, status: res.status, data };
  };

  /**
   * In đơn:
   * - 1 đơn: fast-path — 1 request thẳng, không chunk/queue.
   * - Nhiều đơn: chia chunk, chạy gần song song (concurrency 2) + stagger ngắn.
   */
  const fetchPrintDocumentApi = async (
    orderIds: string[],
    opts?: {
      waitMs?: number;
      onStatus?: (message: string) => void;
      onProgress?: (completed: number, total: number) => void;
    }
  ): Promise<{
    ok: boolean;
    status: number;
    data: PrintDocumentResponse;
  }> => {
    void opts?.waitMs;
    const uniqueIds = [...new Set(orderIds.map(String).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return {
        ok: false,
        status: 400,
        data: { error: 'missing_order_ids', message: 'Không có đơn để in.' },
      };
    }

    const mergeChunkResponse = (
      data: PrintDocumentResponse & {
        urls?: string[];
        results?: Array<{
          success?: boolean;
          url?: string;
          orderSn?: string;
          orderId?: string;
          pdfFilename?: string;
          error?: string;
          message?: string;
        }>;
      },
      allDocs: NonNullable<PrintDocumentResponse['documents']>,
      allUrls: string[],
      errors: string[],
    ) => {
      const chunkUrls = [
        ...(Array.isArray(data.urls) ? data.urls : []),
        ...(data.url ? [data.url] : []),
        ...(data.mergedUrl ? [data.mergedUrl] : []),
      ]
        .map((u) => String(u || '').trim())
        .filter(Boolean);
      for (const u of chunkUrls) {
        if (!allUrls.includes(u)) allUrls.push(u);
      }

      if (Array.isArray(data.documents) && data.documents.length > 0) {
        for (const d of data.documents) {
          allDocs.push(d);
          const u = String(d?.url || '').trim();
          if (u && !allUrls.includes(u)) allUrls.push(u);
        }
      } else if (Array.isArray(data.results)) {
        for (const r of data.results) {
          const u = String(r?.url || '').trim();
          allDocs.push({
            url: u || undefined,
            pdfFilename: r?.pdfFilename,
            orderSn: r?.orderSn,
            orderSns: r?.orderSn ? [r.orderSn] : undefined,
            error: r?.success === false ? r?.error || 'print_failed' : undefined,
            message: r?.message,
          });
          if (u && !allUrls.includes(u)) allUrls.push(u);
          if (r?.success === false) {
            errors.push(String(r?.message || r?.error || r?.orderSn || 'fail'));
          }
        }
      }
    };

    const reportProgress = (completed: number) => {
      opts?.onProgress?.(Math.min(completed, uniqueIds.length), uniqueIds.length);
    };

    // —— Local DB print: 1 request cho toàn bộ order_ids (backend không gọi Shopee) ——
    opts?.onStatus?.(
      uniqueIds.length === 1
        ? 'Đang lấy PDF từ kho nội bộ...'
        : `Đang lấy ${uniqueIds.length} PDF từ kho nội bộ...`,
    );
    reportProgress(0);
    // Chặn treo vô hạn nếu mạng/proxy im lặng không trả response — khớp trần chờ Backend (~25s) + đệm.
    const printChunkController = new AbortController();
    const printChunkTimeoutId = window.setTimeout(
      () => printChunkController.abort(),
      35_000,
    );
    try {
      const res = await fetch('/api/shopee/print-document/chunk', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ order_ids: uniqueIds, orderIds: uniqueIds }),
        signal: printChunkController.signal,
      });
      const data = await parseJsonResponse<
        PrintDocumentResponse & {
          urls?: string[];
          preparing?: string[];
          results?: Array<{
            success?: boolean;
            url?: string;
            orderSn?: string;
            orderId?: string;
            pdfFilename?: string;
            error?: string;
            message?: string;
          }>;
        }
      >(res);
      const allDocs: NonNullable<PrintDocumentResponse['documents']> = [];
      const allUrls: string[] = [];
      const errors: string[] = [];
      mergeChunkResponse(data, allDocs, allUrls, errors);

      const readyCount = allDocs.filter((d) => d.url).length || allUrls.length;
      reportProgress(readyCount > 0 ? readyCount : 0);

      if (Array.isArray(data.results)) {
        for (const r of data.results) {
          if (r?.success === false) {
            errors.push(String(r?.message || r?.error || r?.orderSn || 'fail'));
          }
        }
      }

      if ((!res.ok || res.status === 409) && allUrls.length === 0) {
        return {
          ok: false,
          status: res.status,
          data: {
            error: data.error || 'label_not_ready',
            message:
              data.message ||
              errors.join('; ') ||
              'Đang tải file in từ sàn, vui lòng thử lại sau vài giây...',
            documents: allDocs,
          },
        };
      }
      if (allUrls.length === 0 && allDocs.every((d) => !d.url)) {
        return {
          ok: false,
          status: res.status >= 400 ? res.status : 409,
          data: {
            error: 'label_not_ready',
            message:
              errors.join('; ') ||
              data.message ||
              'Đang tải file in từ sàn, vui lòng thử lại sau vài giây...',
            documents: allDocs,
          },
        };
      }

      reportProgress(uniqueIds.length);
      return {
        ok: true,
        status: 200,
        data: {
          success: true,
          url: allUrls[0],
          mergedUrl: allUrls[0],
          pdfFilename: allDocs.find((d) => d.pdfFilename)?.pdfFilename,
          documents: allDocs.length ? allDocs : allUrls.map((url) => ({ url })),
          message:
            data.message ||
            `Đã lấy ${allUrls.length} PDF từ kho nội bộ.`,
        },
      };
    } catch (err) {
      const isAbort =
        err instanceof DOMException && err.name === 'AbortError' ||
        (err instanceof Error && err.name === 'AbortError');
      return {
        ok: false,
        status: 500,
        data: {
          error: isAbort ? 'print_timeout' : 'print_exception',
          message: isAbort
            ? 'Quá thời gian chờ lấy PDF từ máy chủ. Vui lòng thử lại.'
            : err instanceof Error ? err.message : 'Lỗi in vận đơn (kho nội bộ).',
        },
      };
    } finally {
      window.clearTimeout(printChunkTimeoutId);
    }
  };
  const applyPrintDocumentResponse = async (
    data: PrintDocumentResponse,
    openPdf: boolean,
    reservedWindow?: Window | null,
    orderIdsForCache?: string[],
  ): Promise<{ success: boolean; message?: string; mergedUrl?: string | null }> => {
    const failedDocs = (data.documents || []).filter((d) => !d.url);
    const readyDocs = (data.documents || []).filter((d) => d.url);
    const printUrl =
      data.url ||
      data.mergedUrl ||
      readyDocs[0]?.url ||
      (data.documents || []).find((d) => d.url)?.url;
    const trackingMissing = failedDocs.some((d) => d.error === 'tracking_number_missing')
      || data.error === 'tracking_number_missing';

    if (Array.isArray(data.orders) && data.orders.length > 0) {
      // Backend có thể chỉ trả đơn vừa in (scoped Mongo) — merge vào list hiện có, không thay cả danh sách.
      const patchByKey = new Map<string, Order>();
      for (const o of data.orders as Order[]) {
        if (!o) continue;
        const id = String(o.id || '').trim();
        const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim();
        if (id) patchByKey.set(id, o);
        if (sn) {
          patchByKey.set(sn, o);
          patchByKey.set(`shopee-${sn}`, o);
        }
      }
      const merged = ordersRef.current.map((cur) => {
        const id = String(cur.id || '').trim();
        const sn = String(cur.orderSn || '').replace(/^shopee-/i, '').trim();
        const patch =
          (id && patchByKey.get(id)) ||
          (sn && patchByKey.get(sn)) ||
          (sn && patchByKey.get(`shopee-${sn}`)) ||
          null;
        return patch ? { ...cur, ...patch } : cur;
      });
      ordersRef.current = merged;
      onUpdateOrders(merged, { persist: false });
    }

    // Cache từng PDF theo đơn (không gộp 1 URL cho cả batch).
    if (readyDocs.length > 0 || (printUrl && orderIdsForCache?.length)) {
      const urlBySn = new Map<string, { url: string; pdfFilename?: string }>();
      for (const doc of readyDocs) {
        const url = String(doc.url || '').trim();
        if (!url) continue;
        const sns = [
          ...(Array.isArray(doc.orderSns) ? doc.orderSns : []),
          doc.orderSn,
        ]
          .map((s) => String(s || '').replace(/^shopee-/i, '').trim())
          .filter(Boolean);
        if (sns.length === 0 && orderIdsForCache?.length === 1) {
          sns.push(String(orderIdsForCache[0]).replace(/^shopee-/i, '').trim());
        }
        for (const sn of sns) {
          urlBySn.set(sn, { url, pdfFilename: doc.pdfFilename });
          urlBySn.set(`shopee-${sn}`, { url, pdfFilename: doc.pdfFilename });
        }
      }

      const idSet = new Set((orderIdsForCache || []).map(String));
      const patched = ordersRef.current.map((o) => {
        const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim();
        const hit =
          urlBySn.get(sn) ||
          urlBySn.get(`shopee-${sn}`) ||
          urlBySn.get(String(o.id || '')) ||
          (idSet.has(String(o.id)) || idSet.has(String(o.orderSn)) || idSet.has(`shopee-${o.orderSn}`)
            ? printUrl
              ? { url: printUrl, pdfFilename: data.pdfFilename }
              : null
            : null);
        if (!hit) return o;
        return {
          ...o,
          labelUrl: hit.url,
          pdfUrl: hit.url,
          waybill_url: hit.url,
          pdfFilename: hit.pdfFilename || o.pdfFilename,
          hasPdf: true,
          readyToPrint: true,
          isPrinted: true,
        };
      });
      ordersRef.current = patched;
      onUpdateOrders(patched, { persist: false });

      const targets = patched.filter((o) => {
        const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim();
        return (
          urlBySn.has(sn) ||
          urlBySn.has(`shopee-${sn}`) ||
          idSet.has(String(o.id)) ||
          idSet.has(String(o.orderSn)) ||
          idSet.has(`shopee-${o.orderSn}`)
        );
      });
      if (targets.length > 0) {
        void updatePrintStatusForOrders(targets, true, { silent: true }).catch((err) => {
          console.warn('[Print Status] sync after PDF (ignored):', err);
        });
      }
    }

    if (openPdf) {
      const docsToDownload =
        readyDocs.length > 0
          ? readyDocs
          : printUrl
            ? [{ url: printUrl, pdfFilename: data.pdfFilename, orderSn: orderIdsForCache?.[0] }]
            : [];

      if (docsToDownload.length === 0) {
        closeReservedPrintWindow(reservedWindow);
      } else {
        // Luôn ưu tiên 1 file: mergedUrl từ BE, hoặc ghép mọi URL thành 1 PDF A4.
        const uniqueUrls = [
          ...new Set(
            [
              data.mergedUrl,
              data.url,
              ...docsToDownload.map((d) => d.url),
            ]
              .map((u) => String(u || '').trim())
              .filter(Boolean),
          ),
        ];
        const orderCount = Math.max(
          uniqueUrls.length,
          docsToDownload.length,
          orderIdsForCache?.length || 0,
          1,
        );
        const preferredName = String(data.pdfFilename || '').trim();
        const batchName =
          preferredName &&
          /^Danh_Sach_Van_Don_/i.test(preferredName) &&
          uniqueUrls.length === 1
            ? preferredName
            : uniqueUrls.length > 1 || orderCount > 1
              ? buildBatchVanDonFilename(orderCount)
              : preferredName || undefined;

        if (uniqueUrls.length === 1 && orderCount <= 1) {
          await openShopeeLabelFromStream(
            { pdfFilename: docsToDownload[0]?.pdfFilename || preferredName, url: uniqueUrls[0] },
            { reservedWindow },
          );
        } else {
          closeReservedPrintWindow(reservedWindow);
          showToast(
            uniqueUrls.length > 1
              ? `Đang gộp ${orderCount} vận đơn thành 1 file PDF A4...`
              : `Đang tải 1 file PDF (${orderCount} trang A4)...`,
          );
          const merged = await mergeAndDownloadLabelPdfs(uniqueUrls, {
            filename: batchName,
            orderCount,
          });
          if (merged.ok) {
            showToast(`Đã tải ${merged.filename} — mở file và Ctrl+P để in toàn bộ.`);
          }
        }
      }
    } else if (!printUrl && readyDocs.length === 0) {
      closeReservedPrintWindow(reservedWindow);
    }

    if (printUrl || readyDocs.length > 0) {
      if (failedDocs.length > 0) {
        return {
          success: true,
          mergedUrl: printUrl || readyDocs[0]?.url || null,
          message: trackingMissing
            ? TRACKING_MISSING_TOAST
            : `Một số đơn lỗi: ${failedDocs.map((d) => d.message || d.error).join('; ')}`,
        };
      }
      return {
        success: true,
        mergedUrl: printUrl || readyDocs[0]?.url || null,
        message: data.message,
      };
    }

    if (trackingMissing) {
      return { success: false, message: data.message || TRACKING_MISSING_TOAST };
    }

    const detail = failedDocs.map((d) => d.message || d.error).filter(Boolean).join('\n');
    return { success: false, message: detail || 'Shopee chưa trả về file vận đơn PDF.' };
  };

  // Shopee print: 1 đơn = fast-path; nhiều đơn = chunk song song có giới hạn; BE poll READY ~1s.
  /** Nếu mọi đơn đã có labelUrl/pdfFilename trong state → tải/mở từng PDF, không gọi API. */
  const tryOpenCachedLabelUrls = (
    orderIds: string[],
    reservedWindow?: Window | null,
  ): { opened: boolean; url?: string; docs?: { url: string; orderSn: string; pdfFilename?: string }[] } => {
    const uniqueIds = [...new Set(orderIds.map(String).filter(Boolean))];
    if (uniqueIds.length === 0) return { opened: false };
    const docs: { url: string; orderSn: string; pdfFilename?: string }[] = [];
    for (const id of uniqueIds) {
      const o = ordersRef.current.find(
        (x) =>
          String(x.id) === id ||
          String(x.orderSn) === id ||
          `shopee-${x.orderSn}` === id,
      );
      if (!o) return { opened: false };
      const filename = String(o.pdfFilename || '').trim();
      const fromFile =
        filename && !filename.includes('..') && !filename.includes('/')
          ? `/api/public/labels/${encodeURIComponent(filename)}`
          : '';
      const raw =
        fromFile ||
        String(o.waybill_url || o.labelUrl || o.pdfUrl || '').trim();
      if (!raw) return { opened: false };
      docs.push({
        url: resolveLabelFetchUrl(raw),
        orderSn: String(o.orderSn || id).replace(/^shopee-/i, '').trim(),
        pdfFilename: filename || undefined,
      });
    }
    if (docs.length === 1) {
      const url = docs[0].url;
      if (reservedWindow && !reservedWindow.closed) {
        try {
          reservedWindow.location.href = url;
          // ✅ LUỒNG LOCAL PDF (reservedWindow path): đánh dấu Đã in ngay
          const openedOrders = uniqueIds
            .map((id) =>
              ordersRef.current.find(
                (x) =>
                  String(x.id || '') === id ||
                  String(x.orderSn || '') === id ||
                  `shopee-${x.orderSn}` === id,
              ),
            )
            .filter(Boolean) as Order[];
          markPrintedOnLocalPdfOpen(openedOrders);
          return { opened: true, url, docs };
        } catch {
          /* fall through */
        }
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      // ✅ LUỒNG LOCAL PDF: đánh dấu Đã in ngay tại thời điểm mở PDF
      const openedOrders = uniqueIds
        .map((id) =>
          ordersRef.current.find(
            (x) =>
              String(x.id || '') === id ||
              String(x.orderSn || '') === id ||
              `shopee-${x.orderSn}` === id,
          ),
        )
        .filter(Boolean) as Order[];
      markPrintedOnLocalPdfOpen(openedOrders);
      return { opened: true, url, docs };
    }
    // Nhiều đơn cache sẵn — caller sẽ download từng file.
    // ✅ LUỒNG LOCAL PDF (nhiều đơn): đánh dấu Đã in ngay
    const openedOrders = uniqueIds
      .map((id) =>
        ordersRef.current.find(
          (x) =>
            String(x.id || '') === id ||
            String(x.orderSn || '') === id ||
            `shopee-${x.orderSn}` === id,
        ),
      )
      .filter(Boolean) as Order[];
    markPrintedOnLocalPdfOpen(openedOrders);
    return { opened: true, url: docs[0]?.url, docs };
  };

  const printShopeeDocuments = async (
    orderIds: string[],
    options: {
      openPdf?: boolean;
      onProgress?: (completed: number, total: number) => void;
      onStatus?: (message: string) => void;
      waitMs?: number;
      reservedWindow?: Window | null;
    } = {}
  ): Promise<{ success: boolean; message?: string; mergedUrl?: string | null }> => {
    const { openPdf = true, onProgress, onStatus, waitMs, reservedWindow } = options;
    const uniqueIds = [...new Set(orderIds.map(String).filter(Boolean))];
    if (uniqueIds.length === 0) {
      closeReservedPrintWindow(reservedWindow);
      return { success: false, message: 'Không có đơn hàng để in.' };
    }

    const total = uniqueIds.length;

    try {
      if (onProgress) onProgress(0, total);

      if (openPdf) {
        const cached = tryOpenCachedLabelUrls(uniqueIds, reservedWindow);
        if (cached.opened) {
          if (onProgress) onProgress(total, total);
          // Optimistic: PDF cache mở thành công → đánh dấu Đã in ngay, API sync nền.
          const optimisticTargets = applyPrintedLocalOptimistic(uniqueIds, true);
          if (optimisticTargets.length > 0) {
            void updatePrintStatusForOrders(optimisticTargets, true, { silent: true }).catch((err) => {
              console.warn('[Print Status] sync after cache print (ignored):', err);
            });
          }
          const docs = cached.docs || [];
          if (docs.length > 1) {
            closeReservedPrintWindow(reservedWindow);
            showToast(`Đang gộp ${docs.length} vận đơn (cache) thành 1 file PDF A4...`);
            const merged = await mergeAndDownloadLabelPdfs(
              docs.map((d) => d.url),
              { orderCount: docs.length },
            );
            return {
              success: true,
              mergedUrl: docs[0]?.url,
              message: merged.ok
                ? `Đã tải ${merged.filename} — mở file và Ctrl+P để in toàn bộ.`
                : `Đã tải ${docs.length} vận đơn từ bộ nhớ đệm.`,
            };
          }
          return { success: true, mergedUrl: cached.url, message: 'Đã mở vận đơn từ bộ nhớ đệm.' };
        }
      }

      // Backend xử lý từng đơn (+ chờ Shopee nếu waitMs) — forward onProgress theo đơn.
      const { ok, status, data } = await fetchPrintDocumentApi(uniqueIds, {
        waitMs,
        onStatus,
        onProgress,
      });
      if (!ok) {
        closeReservedPrintWindow(reservedWindow);
        if (data.error === 'tracking_number_missing' || status === 409) {
          if (Array.isArray(data.orders) && data.orders.length > 0) {
            const patchByKey = new Map<string, Order>();
            for (const o of data.orders as Order[]) {
              if (!o) continue;
              const id = String(o.id || '').trim();
              const sn = String(o.orderSn || '').replace(/^shopee-/i, '').trim();
              if (id) patchByKey.set(id, o);
              if (sn) {
                patchByKey.set(sn, o);
                patchByKey.set(`shopee-${sn}`, o);
              }
            }
            const merged = ordersRef.current.map((cur) => {
              const id = String(cur.id || '').trim();
              const sn = String(cur.orderSn || '').replace(/^shopee-/i, '').trim();
              const patch =
                (id && patchByKey.get(id)) ||
                (sn && patchByKey.get(sn)) ||
                (sn && patchByKey.get(`shopee-${sn}`)) ||
                null;
              return patch ? { ...cur, ...patch } : cur;
            });
            ordersRef.current = merged;
            onUpdateOrders(merged, { persist: false });
          }
          if (data.error === 'tracking_number_missing') {
            return { success: false, message: data.message || TRACKING_MISSING_TOAST };
          }
          return {
            success: false,
            message:
              data.message ||
              'Đang tải file in từ sàn, vui lòng thử lại sau vài giây...',
          };
        }
        return {
          success: false,
          message: data.message || data.error || `Không thể tạo vận đơn Shopee (HTTP ${status}).`,
        };
      }

      if (onProgress) onProgress(total, total);
      return applyPrintDocumentResponse(data, openPdf, reservedWindow, uniqueIds);
    } catch (err) {
      closeReservedPrintWindow(reservedWindow);
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định khi in vận đơn.';
      return { success: false, message: msg };
    }
  };

  // Called from the "Xác nhận đơn hàng" modal — arranges shipment (pickup/dropoff,
  // per the seller's choice) for every order currently queued in `shipConfirmOrders`.
  const clearShipProgressOverlay = () => {
    if (progressCloseTimerRef.current) {
      clearTimeout(progressCloseTimerRef.current);
      progressCloseTimerRef.current = null;
    }
    setIsShipping(false);
    setProgressMessage(null);
    setProgressCompleted(0);
    setProgressTotal(0);
    setProgressDone(false);
    setShipConfirmSummary(null);
    setShipJobResults([]);
    setIsPrintingFromSummary(false);
  };

  const scheduleCloseProgressOverlay = (delayMs = 0) => {
    if (progressCloseTimerRef.current) clearTimeout(progressCloseTimerRef.current);
    if (delayMs <= 0) {
      clearShipProgressOverlay();
      return;
    }
    progressCloseTimerRef.current = setTimeout(() => {
      clearShipProgressOverlay();
    }, delayMs);
  };

  const markProgressComplete = (message?: string, options?: { autoClose?: boolean }) => {
    setProgressDone(true);
    if (message) setProgressMessage(message);
    // Functional update — tránh stale closure (progressTotal = 0 lúc bấm In → kẹt 0/N).
    setProgressTotal((t) => {
      if (t > 0) setProgressCompleted(t);
      return t;
    });
    if (options?.autoClose !== false) {
      scheduleCloseProgressOverlay(0);
    }
  };

  /** Reset overlay trước phiên in mới — xóa shipJobResults tồn đọng (nhãn "Thành công" giả). */
  const beginPrintProgressSession = (total: number, message: string) => {
    setShipJobResults([]);
    setShipConfirmSummary(null);
    setProgressDone(false);
    setProgressCompleted(0);
    setProgressTotal(Math.max(0, total));
    setProgressMessage(message);
  };

  const buildQueuedOrderKeys = (queued: Order[]) => {
    const keys = new Set<string>();
    for (const o of queued) {
      keys.add(o.id);
      keys.add(o.orderSn);
      keys.add(`shopee-${o.orderSn}`);
    }
    return keys;
  };

  const applyLocalShippedOrdersUpdate = (
    baseOrders: Order[],
    queuedKeys: Set<string>,
    opts?: { markPrinted?: boolean; shipMethod?: 'pickup' | 'dropoff' }
  ): Order[] =>
    baseOrders.map((o) => {
      if (!queuedKeys.has(o.id) && !queuedKeys.has(o.orderSn) && !queuedKeys.has(`shopee-${o.orderSn}`)) {
        return o;
      }
      // Sau ship_order (pickup HOẶC dropoff) → Đã xử lý ngay, không cần pickup_time.
      return {
        ...o,
        isPrepared: true,
        status: 'processed' as const,
        shopee_order_status:
          o.shopee_order_status === 'READY_TO_SHIP' ||
          o.shopee_order_status === 'RETRY_SHIP' ||
          !o.shopee_order_status
            ? 'PROCESSED'
            : o.shopee_order_status,
        fulfillment_type: opts?.shipMethod || o.fulfillment_type,
        ship_method: opts?.shipMethod || o.ship_method,
        hasPdf: Boolean(o.hasPdf || o.readyToPrint || o.labelUrl || o.pdfUrl || o.waybill_url),
        readyToPrint: Boolean(o.readyToPrint || o.hasPdf || o.labelUrl || o.pdfUrl || o.waybill_url),
        ...(opts?.markPrinted && isProcessedCondition({ ...o, status: 'processed', isPrepared: true })
          ? { isPrinted: true }
          : {}),
      };
    });

  const refreshOrdersAfterShip = async (
    queuedOrders: Order[],
    opts?: { markPrinted?: boolean; shipMethod?: 'pickup' | 'dropoff'; deferTabSwitch?: boolean }
  ) => {
    const queuedKeys = buildQueuedOrderKeys(queuedOrders);
    const patched = applyLocalShippedOrdersUpdate(ordersRef.current, queuedKeys, opts);
    ordersRef.current = patched;
    onUpdateOrders(patched, { persist: false });
    if (opts?.deferTabSwitch) {
      void fetchOrderCounts();
      return;
    }
    setActiveSubTab('processed');
    void fetchOrdersWithShop({
      silent: true,
      page: 1,
      limit: ORDERS_PAGE_SIZE,
      merge: false,
      tab: 'processed',
    });
    void fetchOrderCounts();
  };

  /**
   * Payload tóm tắt sau xác nhận hàng loạt — chỉ lỗi ship_order.
   * Không báo thất bại vì thiếu tracking_no / lỗi in PDF (đơn đã xác nhận vẫn tính thành công).
   */
  const buildShipConfirmSummary = (
    payload: {
      total?: number;
      successCount?: number;
      failCount?: number;
      failedCount?: number;
      successfulOrderIds?: Array<string | number>;
      failedOrderDetails?: Array<{ orderSn?: string; orderId?: string; error?: string; message?: string; shipped?: boolean }>;
      failedOrders?: Array<{ orderSn?: string; orderId?: string; error?: string; message?: string; shipped?: boolean }>;
      results?: Array<{ success?: boolean; orderSn?: string; orderId?: string; error?: string; message?: string }>;
      message?: string;
    },
    fallbackTotal = 0,
  ) => {
    const results = Array.isArray(payload.results) ? payload.results : [];
    const successfulOrderIds = [
      ...new Set(
        (Array.isArray(payload.successfulOrderIds)
          ? payload.successfulOrderIds.map((id) => String(id || '').trim()).filter(Boolean)
          : results
              .filter((r) => r?.success)
              .map((r) => String(r?.orderId || r?.orderSn || '').trim())
              .filter(Boolean)),
      ),
    ];
    const successKeySet = new Set<string>();
    for (const id of successfulOrderIds) {
      const s = String(id || '').trim();
      if (!s) continue;
      successKeySet.add(s);
      successKeySet.add(s.replace(/^shopee-/i, ''));
      successKeySet.add(`shopee-${s.replace(/^shopee-/i, '')}`);
    }
    const isPrintOnlyFail = (f: { error?: string; message?: string; shipped?: boolean }) => {
      const err = String(f?.error || '').toLowerCase();
      const msg = String(f?.message || '').toLowerCase();
      if (f?.shipped) return true;
      if (err.includes('tracking') || err.includes('pdf') || err.includes('document') || err.includes('print')) {
        return true;
      }
      if (msg.includes('mã vận đơn') || msg.includes('pdf') || msg.includes('vận đơn')) return true;
      return false;
    };
    const rawFailed = Array.isArray(payload.failedOrderDetails)
      ? payload.failedOrderDetails
      : Array.isArray(payload.failedOrders)
        ? payload.failedOrders
        : results
            .filter((r) => !r?.success)
            .map((r) => ({
              orderSn: String(r?.orderSn || ''),
              orderId: String(r?.orderId || ''),
              error: String(r?.error || 'ship_failed'),
              message: String(r?.message || r?.error || 'Xác nhận thất bại'),
            }));
    // Chỉ giữ lỗi xác nhận thật — bỏ fail in/thiếu mã và đơn đã success.
    const failedOrderDetails = rawFailed.filter((f) => {
      if (isPrintOnlyFail(f)) return false;
      const id = String(f?.orderId || '').trim();
      const sn = String(f?.orderSn || '').trim();
      if (id && successKeySet.has(id)) return false;
      if (sn && (successKeySet.has(sn) || successKeySet.has(`shopee-${sn}`))) return false;
      return true;
    });
    const successCount = Number(payload.successCount) || successfulOrderIds.length;
    const failCount = failedOrderDetails.length;
    return {
      total: Number(payload.total) || fallbackTotal || successCount + failCount,
      successCount,
      failCount,
      successfulOrderIds,
      failedOrderDetails,
    };
  };

  const pollShipJobUntilDone = async (jobId: string, total: number): Promise<any | null> => {
    const deadline = Date.now() + 5 * 60 * 1000;
    let finalJob: any | null = null;
    let pollCount = 0;
    while (Date.now() < deadline) {
      if (pollCount > 0) await new Promise((resolve) => setTimeout(resolve, 300));
      pollCount += 1;
      try {
        const response = await fetch(`/api/shopee/ship-order/job/${jobId}`, { headers: authHeaders() });
        if (!response.ok) throw new Error('Không thể đọc tiến độ xác nhận.');
        const job = await parseJsonResponse<any>(response);
        finalJob = job;
        setProgressCompleted(Number(job.completed) || 0);
        setProgressTotal(Number(job.total) || total);
        setShipJobResults(Array.isArray(job.results) ? job.results : []);
        if (job.status === 'done' || job.status === 'failed') return job;
        setProgressMessage(
          job.message || `Đang xác nhận ${Number(job.completed) || 0}/${Number(job.total) || total} đơn...`,
        );
      } catch (error) {
        setProgressMessage(error instanceof Error ? error.message : 'Không thể đọc tiến độ xác nhận.');
        return finalJob;
      }
    }
    return finalJob;
  };

  /** Kết thúc xác nhận — Result Summary modal (theo dõi tiến độ thật). */
  const finishShipJobResult = async (finalJob: any | null, total: number) => {
    const results = finalJob?.results || [];
    const summary = buildShipConfirmSummary(finalJob || {}, total);
    const report = `Thành công: ${summary.successCount} đơn. Thất bại: ${summary.failCount} đơn.`;

    onAddLog({
      id: `log-${Date.now() + 2}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: summary.successCount > 0 ? 'success' : 'failed',
      message: `${report} (${shipMethod === 'pickup' ? 'Lấy hàng' : 'Tự mang ra bưu cục'})`,
    });

    setProgressCompleted(summary.successCount);
    setProgressTotal(Math.max(total, summary.total, summary.successCount + summary.failCount));
    setProgressDone(true);
    setProgressMessage('Kết quả xác nhận hàng loạt');
    setShipConfirmSummary(summary);

    const confirmed = results.filter((r: any) => r?.success);
    if (confirmed.length > 0) {
      const queuedKeys = new Set<string>();
      for (const r of confirmed) {
        const id = String(r.orderId || '').trim();
        const sn = String(r.orderSn || '').trim();
        if (id) queuedKeys.add(id);
        if (sn) {
          queuedKeys.add(sn);
          queuedKeys.add(`shopee-${sn}`);
        }
      }
      for (const id of summary.successfulOrderIds) {
        const s = String(id || '').trim();
        if (s) {
          queuedKeys.add(s);
          queuedKeys.add(`shopee-${s.replace(/^shopee-/i, '')}`);
        }
      }
      const patched = applyLocalShippedOrdersUpdate(ordersRef.current, queuedKeys, {
        markPrinted: false,
        shipMethod,
      });
      ordersRef.current = patched;
      onUpdateOrders(patched, { persist: false });
      const queued = [...queuedKeys]
        .filter((k) => k && !k.toLowerCase().startsWith('shopee-'))
        .map((sn) => ({ id: `shopee-${sn}`, orderSn: sn })) as Order[];
      if (queued.length > 0) {
        void refreshOrdersAfterShip(queued, { markPrinted: false, shipMethod, deferTabSwitch: true });
      }
    }

    return summary;
  };

  const waitForConfirmedLabelsAndPrint = async (
    orderIds: string[],
    reservedWindow: Window | null,
  ): Promise<{ success: boolean; message?: string }> => {
    const uniqueIds = [...new Set(orderIds.map(String).filter(Boolean))];
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      setProgressMessage(`Đã xác nhận — đang lấy PDF vận đơn (${attempt}/20)...`);
      const { ok, status, data } = await fetchPrintDocumentApi(uniqueIds);
      if (ok) {
        const opened = await applyPrintDocumentResponse(data, true, reservedWindow, uniqueIds);
        if (opened.success) return opened;
      } else if (status !== 409 && data.error !== 'label_not_ready') {
        closeReservedPrintWindow(reservedWindow);
        return { success: false, message: data.message || data.error || `HTTP ${status}` };
      }
      if (attempt < 20) await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    closeReservedPrintWindow(reservedWindow);
    return {
      success: false,
      message: 'Đơn đã xác nhận nhưng Shopee chưa tạo xong PDF. Hệ thống vẫn tiếp tục tải ngầm.',
    };
  };

  const getBatchFailedOrderIds = (payload: any): string[] =>
    (Array.isArray(payload?.failedOrders) ? payload.failedOrders : [])
      .map((item: any) =>
        typeof item === 'string'
          ? item
          : String(item?.orderSn || item?.orderId || '').replace(/^shopee-/i, '').trim(),
      )
      .filter(Boolean);

  const normalizeConfirmSn = (raw: string): string =>
    String(raw || '').replace(/^shopee-/i, '').trim().toLowerCase();

  const stopHasPdfBackgroundPoll = () => {
    hasPdfPollGenRef.current += 1;
    if (hasPdfPollTimerRef.current != null) {
      window.clearTimeout(hasPdfPollTimerRef.current);
      hasPdfPollTimerRef.current = null;
    }
  };

  /** Poll hasPdf ngầm — không spinner, không await chặn render. Tối đa 20 lần, delay 1.5s. */
  const startHasPdfBackgroundPoll = (orderSns: string[]): void => {
    const targets = [
      ...new Set(orderSns.map((sn) => normalizeConfirmSn(sn)).filter(Boolean)),
    ];
    if (targets.length === 0) return;
    stopHasPdfBackgroundPoll();
    const gen = hasPdfPollGenRef.current;
    let attempt = 0;
    const maxAttempts = 20;
    const tick = () => {
      if (gen !== hasPdfPollGenRef.current) return;
      const remaining = targets.filter((sn) => {
        const hit = ordersRef.current.find((o) => {
          const key = normalizeConfirmSn(o.orderSn || o.id || '');
          return key === sn;
        });
        return !(hit?.hasPdf || hit?.readyToPrint || hit?.labelUrl || hit?.pdfUrl || hit?.waybill_url);
      });
      if (remaining.length === 0 || attempt >= maxAttempts) return;
      attempt += 1;
      void Promise.resolve(
        fetchOrdersWithShop({
          silent: true,
          page: 1,
          limit: ORDERS_PAGE_SIZE,
          merge: true,
          tab: 'processed',
          force: true,
        }),
      )
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') return;
        })
        .finally(() => {
          if (gen !== hasPdfPollGenRef.current) return;
          hasPdfPollTimerRef.current = window.setTimeout(tick, 1500);
        });
    };
    hasPdfPollTimerRef.current = window.setTimeout(tick, 1200);
  };

  /**
   * Đóng modal → hiện tab Đã xử lý + lọc Chưa in ngay (nút xám).
   * Gộp state 1 tick, bỏ fetch blocking; PDF poll chạy ngầm.
   */
  const revealProcessedUnprintedTab = (orderSns: string[]): void => {
    const want = new Set(orderSns.map((sn) => normalizeConfirmSn(sn)).filter(Boolean));
    const optimistic = ordersRef.current
      .filter((o) => {
        const sn = normalizeConfirmSn(o.orderSn || '');
        const id = normalizeConfirmSn(o.id || '');
        return want.has(sn) || want.has(id);
      })
      .map((o) => ({
        ...o,
        status: 'processed' as const,
        isPrepared: true,
        isPrinted: false,
        hasPdf: Boolean(o.hasPdf || o.readyToPrint || o.labelUrl || o.pdfUrl || o.waybill_url),
        readyToPrint: Boolean(o.readyToPrint || o.hasPdf || o.labelUrl || o.pdfUrl || o.waybill_url),
      }));
    if (optimistic.length > 0) {
      ordersRef.current = optimistic;
      onUpdateOrders(optimistic, { persist: false });
    }
    skipNextOrdersTabFetchRef.current = true;
    React.startTransition(() => {
      setActiveSubTab('processed');
      setPrintStatusFilter('unprinted');
      setCurrentPage(1);
    });
    void Promise.resolve(
      fetchOrdersWithShop({
        silent: true,
        page: 1,
        limit: ORDERS_PAGE_SIZE,
        merge: optimistic.length > 0,
        tab: 'processed',
        force: true,
      }),
    ).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return;
    });
    void fetchOrderCounts();
    startHasPdfBackgroundPoll(orderSns);
  };

  const startSilentPdfPrefetch = (orderSns: string[]): void => {
    if (!orderSns.length) return;
    void fetch('/api/orders/silent-prefetch-pdfs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ orderSns }),
    }).catch(() => {});
  };

  const handleBatchConfirmOnly = async () => {
    if (!shipConfirmOrders?.length || isShipping) return;
    const validQueued = shipConfirmOrders.filter(
      (order) => String(order.orderSn || order.id || '').trim(),
    );
    const orderIds = validQueued.map((order) => String(order.id || '').trim()).filter(Boolean);
    const orderSns = validQueued
      .map((order) => String(order.orderSn || '').replace(/^shopee-/i, '').trim())
      .filter(Boolean);
    if (!orderSns.length) {
      showToast('Không có mã đơn hàng hợp lệ trong danh sách đã chọn.');
      return;
    }

    setShipConfirmOrders(null);
    setIsShipping(true);
    setProgressMessage(`Đang xác nhận ${orderSns.length} đơn lên Shopee...`);
    setProgressDone(false);
    setProgressCompleted(0);
    setProgressTotal(orderSns.length);
    try {
      const response = await fetch('/api/orders/batch-confirm', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ orderIds, orderSns, method: shipMethod }),
      });
      const data = await readResponseJson<any>(response);
      if (!response.ok || !data.success) {
        throw new Error(data.message || data.error || `HTTP ${response.status}`);
      }

      const successfulSns = [
        ...new Set<string>(
          (Array.isArray(data.successOrders)
            ? data.successOrders
            : (Array.isArray(data.results) ? data.results : []).filter((result: any) => result?.success))
            .map((result: any) =>
              String(typeof result === 'string' ? result : result?.orderSn || result?.orderId || '')
                .replace(/^shopee-/i, '')
                .trim(),
            )
            .filter(Boolean),
        ),
      ];
      const failedOrders = (
        Array.isArray(data.failedOrders)
          ? data.failedOrders
          : (Array.isArray(data.results) ? data.results : []).filter((result: any) => !result?.success)
      ).map((result: any) => ({
        orderId: String(result?.orderId || ''),
        orderSn: String(result?.orderSn || '').replace(/^shopee-/i, '').trim(),
        error: String(result?.error || 'confirm_failed'),
        message: String(result?.message || result?.error || 'Xác nhận thất bại'),
      }));

      if (successfulSns.length > 0) {
        const optimisticTargets = applyPrintedLocalOptimistic(successfulSns, false, 'processed');
        if (optimisticTargets.length > 0) {
          void updatePrintStatusForOrders(optimisticTargets, false, { silent: true }).catch(() => {});
        }

        setSelectedOrderIds([]);
        const queued = successfulSns.map((sn) => ({
          id: `shopee-${sn}`,
          orderSn: sn,
        })) as Order[];
        void refreshOrdersAfterShip(queued, { markPrinted: false, shipMethod, deferTabSwitch: true });
        void startSilentPdfPrefetch(successfulSns);
      }

      const summary = {
        total: Number(data.total) || successfulSns.length + failedOrders.length,
        successCount: successfulSns.length,
        failCount: failedOrders.length,
        successfulOrderIds: successfulSns,
        failedOrderDetails: failedOrders,
      };
      setProgressCompleted(successfulSns.length);
      setProgressTotal(summary.total);
      setProgressDone(true);
      setProgressMessage('Kết quả xác nhận hàng loạt');
      setShipJobResults([
        ...successfulSns.map((orderSn) => ({ orderSn, success: true })),
        ...failedOrders.map((failure: any) => ({ ...failure, success: false })),
      ]);
      setShipConfirmSummary(summary);
      showToast(
        failedOrders.length > 0
          ? `Thành công ${successfulSns.length} đơn, thất bại ${failedOrders.length} đơn.`
          : `Đã xác nhận ${successfulSns.length} đơn — PDF đang được tải ngầm.`,
      );

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'stock_sync',
        status: successfulSns.length > 0 ? 'success' : 'failed',
        message: `Xác nhận thành công ${successfulSns.length}, thất bại ${failedOrders.length}; đã xếp hàng tải PDF nền.`,
      });
    } catch (err) {
      clearShipProgressOverlay();
      showToast(`Xác nhận thất bại: ${err instanceof Error ? err.message : 'Lỗi không xác định'}`);
    } finally {
      setIsShipping(false);
    }
  };

  const handleConfirmAndPrint = async () => {
    if (!shipConfirmOrders?.length) return;
    const validQueued = shipConfirmOrders.filter(
      (order) => String(order.orderSn || order.id || '').trim(),
    );
    if (!validQueued.length) {
      showToast('Không có mã đơn hàng hợp lệ trong danh sách đã chọn.');
      return;
    }

    const orderIds = validQueued
      .map((order) => String(order.id || '').trim())
      .filter(Boolean);
    const orderSns = validQueued
      .map((order) => String(order.orderSn || '').replace(/^shopee-/i, '').trim())
      .filter(Boolean);

    setShipConfirmOrders(null);
    setIsShipping(true);
    setProgressMessage('Đang xác nhận đơn lên Shopee...');
    setProgressDone(false);
    setProgressCompleted(0);
    setProgressTotal(validQueued.length);

    let reservedBatchWindow: Window | null = null;
    try {
      // BATCH PRINT: Nếu nhiều đơn (>= 2) -> gọi API gộp PDF
      if (orderSns.length >= 2) {
        console.log('[Confirm&Print] BATCH MODE: Gọi /api/orders/batch-confirm-print với', orderSns.length, 'đơn');
        setProgressMessage(`Đang xác nhận ${orderSns.length} đơn và gộp PDF...`);
        reservedBatchWindow = openReservedPrintPlaceholder();

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 38_000);
        let batchResponse: Response;
        try {
          batchResponse = await fetch('/api/orders/batch-confirm-print', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
              orderSns,
              method: shipMethod,
            }),
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timeoutId);
        }
        const batchData = await readResponseJson<any>(batchResponse);
        console.log('[Confirm&Print] Batch response:', batchData);

        if (!batchResponse.ok || !batchData.success) {
          throw new Error(batchData.message || batchData.error || `HTTP ${batchResponse.status}`);
        }

        if (batchData.url) {
          console.log('[Confirm&Print] Mở PDF gộp:', batchData.url);
          if (!navigateReservedPrintWindow(reservedBatchWindow, batchData.url)) {
            window.open(batchData.url, '_blank');
          }
          const failedOrderIds = getBatchFailedOrderIds(batchData);
          showToast(
            failedOrderIds.length > 0
              ? `Đã in gộp ${batchData.pdfCount} đơn. Các đơn lỗi: ${failedOrderIds.join(', ')}`
              : `Đã in gộp ${batchData.pdfCount} đơn.`,
          );
        } else {
          closeReservedPrintWindow(reservedBatchWindow);
          showToast(`Đã xác nhận ${batchData.confirmedCount} đơn nhưng không có PDF.`);
        }

        // Cập nhật trạng thái local
        const successfulSns = Array.isArray(batchData.printedOrders) ? batchData.printedOrders : orderSns;
        const expiresAt = Date.now() + 5 * 60 * 1000;
        for (const sn of successfulSns) {
          const key = sn.toLowerCase();
          recentlyPrintedRef.current.set(key, expiresAt);
          recentlyPrintedRef.current.set(`shopee-${key}`, expiresAt);
        }

        const optimisticTargets = applyPrintedLocalOptimistic(successfulSns, true, 'processed');
        if (optimisticTargets.length) {
          void updatePrintStatusForOrders(optimisticTargets, true, { silent: true }).catch(() => {});
        }

        setSelectedOrderIds([]);
        setShipConfirmSummary(null);
        setShipJobResults([]);
        clearShipProgressOverlay();
        const queuedBatch = successfulSns.map((sn: string) => ({
          id: `shopee-${sn}`,
          orderSn: sn,
        })) as Order[];
        void refreshOrdersAfterShip(queuedBatch, { markPrinted: true, shipMethod });
        
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: 'all',
          type: 'stock_sync',
          status: 'success',
          message: `Batch print: Xác nhận và gộp ${successfulSns.length} đơn thành 1 PDF.`,
        });
      } else {
        // ĐƠN LẺ: Xác nhận + lấy PDF riêng biệt
        console.log('[Confirm&Print] SINGLE MODE: Xử lý 1 đơn');
        
        const confirmResponse = await fetch('/api/orders/confirm', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            orderIds,
            orderSns,
            order_ids: orderIds,
            order_sns: orderSns,
            method: shipMethod,
          }),
        });
        const confirmData = await readResponseJson<any>(confirmResponse);
        if (!confirmResponse.ok) throw new Error(confirmData.message || confirmData.error || `HTTP ${confirmResponse.status}`);

        const successfulResults = (Array.isArray(confirmData.results) ? confirmData.results : []).filter(
          (result: any) => result?.success,
        );
        const successfulSns: string[] = [
          ...new Set<string>(
            successfulResults
              .map((result: any) => String(result.orderSn || '').replace(/^shopee-/i, '').trim())
              .filter(Boolean),
          ),
        ];
        
        if (!successfulSns.length) {
          throw new Error(confirmData.message || 'Shopee không xác nhận được đơn nào.');
        }

        setProgressMessage(`Đã xác nhận ${successfulSns.length} đơn - đang lấy PDF...`);

        console.log('[Confirm&Print] Gọi /api/orders/get-pdf với orderSns:', successfulSns);
        const pdfResponse = await fetch('/api/orders/get-pdf', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ orderSns: successfulSns }),
        });
        const pdfData = await readResponseJson<any>(pdfResponse);
        console.log('[Confirm&Print] Response từ /api/orders/get-pdf:', pdfData);

        if (pdfResponse.ok && pdfData.success && Array.isArray(pdfData.results)) {
          const successPdfs = pdfData.results.filter((r: any) => r.success && r.url);
          console.log('[Confirm&Print] Danh sách PDF thành công:', successPdfs);
          if (successPdfs.length > 0) {
            for (const pdfResult of successPdfs) {
              console.log('[Confirm&Print] Mở PDF:', pdfResult.url);
              window.open(pdfResult.url, '_blank');
            }
            showToast(`Đã xác nhận & mở ${successPdfs.length} PDF vận đơn.`);
          } else {
            console.warn('[Confirm&Print] Không có PDF nào thành công');
            showToast('Đơn đã xác nhận nhưng chưa có PDF. Vui lòng in lại sau.');
          }
        } else {
          console.error('[Confirm&Print] Lỗi lấy PDF:', pdfData);
          showToast('Đơn đã xác nhận nhưng không lấy được PDF. Vui lòng in lại sau.');
        }

        const expiresAt = Date.now() + 5 * 60 * 1000;
        for (const sn of successfulSns) {
          const key = sn.toLowerCase();
          recentlyPrintedRef.current.set(key, expiresAt);
          recentlyPrintedRef.current.set(`shopee-${key}`, expiresAt);
        }

        const optimisticTargets = applyPrintedLocalOptimistic(successfulSns, true, 'processed');
        if (optimisticTargets.length) {
          void updatePrintStatusForOrders(optimisticTargets, true, { silent: true }).catch(() => {});
        }

        setSelectedOrderIds([]);
        setShipConfirmSummary(null);
        setShipJobResults([]);
        clearShipProgressOverlay();
        const queuedSingle = successfulSns.map((sn) => ({
          id: `shopee-${sn}`,
          orderSn: sn,
        })) as Order[];
        void refreshOrdersAfterShip(queuedSingle, { markPrinted: true, shipMethod });
        
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: 'all',
          type: 'stock_sync',
          status: 'success',
          message: `Xác nhận và in ${successfulSns.length} đơn thành công.`,
        });
      }
    } catch (err) {
      closeReservedPrintWindow(reservedBatchWindow);
      const message = err instanceof DOMException && err.name === 'AbortError'
        ? 'Quá thời gian 38 giây. Vui lòng thử lại hoặc chọn ít đơn hơn.'
        : err instanceof Error
          ? err.message
          : 'Lỗi không xác định';
      clearShipProgressOverlay();
      showToast(`Xác nhận thất bại: ${message}`);
    } finally {
      setIsShipping(false);
    }
  };

  const handlePrintFromShipSummary = async () => {
    const ids = (
      shipConfirmSummary?.successfulOrderIds || []
    )
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!ids.length || isPrintingFromSummary) return;

    // Fast path: PDF đã có trên order state → 1 đơn mở tab; nhiều đơn gộp 1 file.
    const cached = tryOpenCachedLabelUrls(ids);
    if (cached.opened) {
      const docs = cached.docs || [];
      // Optimistic: mở PDF cache thành công → Đã in ngay, sync DB nền.
      const optimisticTargets = applyPrintedLocalOptimistic(ids, true);
      if (optimisticTargets.length > 0) {
        void updatePrintStatusForOrders(optimisticTargets, true, { silent: true }).catch(() => {});
      }
      if (docs.length > 1) {
        showToast(`Đang gộp ${docs.length} vận đơn (cache) thành 1 file PDF A4...`);
        const merged = await mergeAndDownloadLabelPdfs(
          docs.map((d) => d.url),
          { orderCount: docs.length },
        );
        if (merged.ok) showToast(`Đã tải ${merged.filename} — mở file và Ctrl+P để in toàn bộ.`);
      } else {
        showToast('Đã mở vận đơn từ bộ nhớ đệm.');
      }
      setShipConfirmSummary(null);
      setShipJobResults([]);
      markProgressComplete('In vận đơn thành công!');
      return;
    }

    setIsFetchingPdf(true);
    setIsPrintingFromSummary(true);
    setIsShipping(true);
    beginPrintProgressSession(
      ids.length,
      ids.length === 1
        ? 'Đang in 1 đơn — xử lý ngay...'
        : `Đang in ${ids.length} đơn (tối đa ${PRINT_FE_CHUNK_CONCURRENCY} đơn song song)...`,
    );

    try {
      const result = await printShopeeDocuments(ids, {
        onProgress: (completed, total) => {
          setProgressCompleted(completed);
          setProgressTotal(total);
            setProgressMessage(
              completed >= total
                ? 'Hoàn tất — đang tải PDF từng đơn...'
                : `Đang lấy PDF từ kho nội bộ: ${completed}/${total}...`
            );
        },
        onStatus: (message) => {
          setProgressMessage(message);
        },
      });
      if (!result.success) {
        showToast(`In vận đơn Shopee thất bại: ${result.message}`);
      } else {
        if (result.message) showToast(result.message);
        const optimisticTargets = applyPrintedLocalOptimistic(ids, true);
        if (optimisticTargets.length > 0) {
          void updatePrintStatusForOrders(optimisticTargets, true, { silent: true }).catch(() => {});
        }
        refetchOrdersPage({ silent: true });
        markProgressComplete('In vận đơn thành công!');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
      showToast(`In vận đơn Shopee thất bại: ${msg}`);
    } finally {
      setIsFetchingPdf(false);
      setIsPrintingFromSummary(false);
      clearShipProgressOverlay();
    }
  };

  const [showCreateOrderPage, setShowCreateOrderPage] = useState(false);

  /**
   * Tab "Đã giao cho ĐVVC": dò API Shopee ngầm (ACK) — khi đơn thật sự SHIPPED
   * Backend cập nhật Mongo → refresh list → tự nhảy sang "Đang giao".
   * Không await / không set loading → không block UI; cooldown ở Backend chống spam.
   */
  useEffect(() => {
    if (activeSubTab !== 'handed_over_carrier') return;
    let cancelled = false;
    let busy = false;

    const triggerReconcile = () => {
      if (cancelled || busy || document.visibilityState === 'hidden') return;
      const token = localStorage.getItem('admin_token') || '';
      if (!token) return;
      busy = true;
      void fetch('/api/orders/reconcile-handed-over', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          maxOrders: 80,
          ...(shopScopeRef.current.shopIds.length
            ? { shopIds: shopScopeRef.current.shopIds }
            : {}),
        }),
      })
        .catch(() => {})
        .finally(() => {
          busy = false;
        });
    };

    // Lần đầu khi mở tab — sau 2s để không đụng fetch list.
    const firstTimer = window.setTimeout(triggerReconcile, 2_000);
    const intervalId = window.setInterval(triggerReconcile, 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(firstTimer);
      window.clearInterval(intervalId);
    };
  }, [activeSubTab, shopIdsKey]);

  const isAtScrollTop = useCallback(() => {
    if (typeof window === 'undefined') return true;
    const main = document.querySelector('.app-main-scroll') as HTMLElement | null;
    if (main) return main.scrollTop <= 2;
    return window.scrollY <= 2 || document.documentElement.scrollTop <= 2;
  }, []);

  const handlePullTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (isPullRefreshing || isSyncing || ordersLoading) return;
      if (typeof window !== 'undefined' && window.matchMedia('(min-width: 769px)').matches) return;
      if (!isAtScrollTop()) {
        pullStartYRef.current = null;
        pullActiveRef.current = false;
        return;
      }
      pullStartYRef.current = e.touches[0]?.clientY ?? null;
      pullActiveRef.current = true;
      pullDistanceRef.current = 0;
    },
    [isAtScrollTop, isPullRefreshing, isSyncing, ordersLoading],
  );

  const handlePullTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!pullActiveRef.current || pullStartYRef.current == null || isPullRefreshing) return;
      if (!isAtScrollTop()) {
        pullActiveRef.current = false;
        pullStartYRef.current = null;
        if (pullDistanceRef.current !== 0) {
          pullDistanceRef.current = 0;
          setPullDistance(0);
        }
        return;
      }
      const y = e.touches[0]?.clientY ?? pullStartYRef.current;
      const raw = Math.max(0, y - pullStartYRef.current);
      // Rubber-band: giảm độ nhạy sau threshold
      const dist = Math.min(120, raw * 0.45);
      pullDistanceRef.current = dist;
      setPullDistance(dist);
    },
    [isAtScrollTop, isPullRefreshing],
  );

  const handlePullTouchEnd = useCallback(async () => {
    if (!pullActiveRef.current) return;
    pullActiveRef.current = false;
    pullStartYRef.current = null;
    const dist = pullDistanceRef.current;
    pullDistanceRef.current = 0;

    if (dist < OM_PULL_REFRESH_THRESHOLD_PX || isPullRefreshing) {
      setPullDistance(0);
      return;
    }

    setIsPullRefreshing(true);
    setPullDistance(OM_PULL_REFRESH_THRESHOLD_PX);
    try {
      setCurrentPage(1);
      if (activeSubTab === 'order_products') {
        await fetchFulfillmentProducts();
      } else {
        await fetchOrdersWithShop({
          silent: false,
          page: 1,
          limit: ORDERS_PAGE_SIZE,
          merge: false,
          tab: activeSubTab === 'all' ? '' : activeSubTab,
          kind: listKind,
        });
      }
      void fetchOrderCounts();
    } finally {
      setIsPullRefreshing(false);
      setPullDistance(0);
    }
  }, [activeSubTab, fetchFulfillmentProducts, fetchOrderCounts, fetchOrdersWithShop, isPullRefreshing, listKind]);

  // Helper count statistics — ưu tiên tổng hợp Mongo 3 tab; fallback list đang mở.
  const aggregatedOrderProducts = useMemo(
    () => fulfillmentProducts ?? aggregateOrderProducts(orders, products ?? []),
    [fulfillmentProducts, orders, products]
  );

  /** Counter 3 nhóm Hủy/Hoàn/RTS — CHỈ đọc global count từ BE, CẤM array.length trang 50. */
  const cancelReturnKindCounts = useMemo(() => {
    const c = ordersMeta?.counters;
    const sc = serverOrderCounts || {};
    const src = Number(c?.total) > 0 ? c : null;
    const total = Number(src?.total ?? sc.cancel_returns) || 0;
    const returned =
      Number(src?.returned ?? sc.cancel_returns_returned ?? sc.refund_return) || 0;
    const cancelled =
      Number(src?.cancelled ?? sc.cancel_returns_cancelled) || 0;
    const rts = Number(src?.rts ?? sc.cancel_returns_rts ?? sc.failed_delivery) || 0;
    return { refund_return: returned, cancelled, failed_delivery: rts, all: total };
  }, [ordersMeta?.counters, serverOrderCounts]);

  const getCancelReturnCount = (tab: CancelReturnTab) => Number(cancelReturnKindCounts[tab]) || 0;

  const cancelReturnTabItems: { id: CancelReturnTab; label: string }[] = [
    { id: 'all', label: 'Tất cả' },
    { id: 'refund_return', label: 'Đơn Trả hàng Hoàn tiền' },
    { id: 'cancelled', label: 'Đơn Hủy' },
    { id: 'failed_delivery', label: 'Đơn Giao hàng không thành công' },
  ];

  const getCount = (status: OrderTab) => {
    if (status === 'order_products') {
      return aggregatedOrderProducts.length;
    }
    // Ưu tiên counter API (Mongo countDocuments) — badge nhảy độc lập với list.
    if (serverOrderCounts) {
      const key = status === 'pending_verification' ? 'pending_confirm' : status;
      const serverN = Number(serverOrderCounts[key]);
      if (Number.isFinite(serverN)) return serverN;
    }
    // web_orders: đếm trực tiếp từ orders array khi chưa có server counter
    if (status === 'web_orders') {
      return orders.filter((o) => o.channel === 'woocommerce').length;
    }
    if (status === 'external_orders') {
      return orders.filter((o) => o.channel === 'manual').length;
    }
    let clientCount = 0;
    if (status === 'cancel_returns') {
      clientCount = Number(cancelReturnKindCounts.all) || 0;
    } else if (status === 'return_requests') {
      clientCount = orders.filter((o) => isReturnRequestOrder(o)).length;
    } else if (status === 'received_cancel_returns') {
      clientCount = orders.filter((o) => matchesReceivedCancelReturnTab(o)).length;
    } else {
      clientCount = orders.filter((o) => {
        if (status === 'all') return true;
        if (status === 'pending_confirm' || status === 'pending_verification') {
          return isPendingConfirmOrder(o);
        }
        if (status === 'unprocessed') {
          return matchesUnprocessedPickupTab(o) && !isPendingConfirmOrder(o);
        }
        if (status === 'processed') {
          return matchesProcessedPickupTab(o) && !isPendingConfirmOrder(o);
        }
        if (status === 'shipping') return matchesShippingTab(o);
        if (status === 'handed_over_carrier') return matchesHandedOverCarrierTab(o);
        return o.status === status;
      }).length;
    }
    return clientCount;
  };

  /**
   * Chỉ lọc cục bộ: Shop + Sàn + Search + Print.
   * Backend đã lọc theo `?tab=` — CẤM filter lại activeSubTab (processed/unprocessed/...).
   * Tab Đơn Hủy/Hoàn: list API là nguồn sự thật — không return false chặn render.
   */
  const matchesOrdersListBaseFilters = (order: Order): boolean => {
    const isBackendCancelReturnTab =
      activeSubTab === 'cancel_returns' || activeSubTab === 'received_cancel_returns';

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchSn = String(order.orderSn || '').toLowerCase().includes(q);
      const matchTracking = Boolean(
        (order.trackingNumber && order.trackingNumber.toLowerCase().includes(q)) ||
          (order.tracking_no && String(order.tracking_no).toLowerCase().includes(q)) ||
          (order.returnTrackingNumber && String(order.returnTrackingNumber).toLowerCase().includes(q)) ||
          (order.return_tracking_no && String(order.return_tracking_no).toLowerCase().includes(q)) ||
          (getOrderWaybillCode(order) && getOrderWaybillCode(order).toLowerCase().includes(q)),
      );
      const matchInternal = order.internalTrackingCode
        ? order.internalTrackingCode.toLowerCase().includes(q)
        : false;
      const matchProduct = (order.items || []).some((it) =>
        String(it.productTitle || it.name || '').toLowerCase().includes(q),
      );
      const cust = order.channel === 'woocommerce' ? resolveWooCustomerInfo(order) : null;
      const matchCustomer = cust
        ? [cust.name, cust.phone, cust.email, cust.address].some((v) =>
            String(v || '').toLowerCase().includes(q),
          )
        : Boolean(
            (order.customerName && order.customerName.toLowerCase().includes(q)) ||
              (order.customerPhone && order.customerPhone.toLowerCase().includes(q)),
          );
      if (!matchSn && !matchTracking && !matchInternal && !matchProduct && !matchCustomer) return false;
    }

    // Backend đã trả list chuẩn của tab Hủy/Hoàn — render 100%, không chặn shop/sàn/print.
    if (isBackendCancelReturnTab) return true;

    if (selectedPlatform !== 'all') {
      if (selectedPlatform === 'lazada') return false;
      if (order.channel !== selectedPlatform) return false;
    }

    if (!matchesSelectedShop(order)) return false;

    if (printStatusFilter === 'printed' && !isOrderPrintedEffective(order)) return false;
    if (printStatusFilter === 'unprinted' && isOrderPrintedEffective(order)) return false;

    return true;
  };

  const ordersPoolBeforeCarrier = useMemo(
    () => orders.filter(matchesOrdersListBaseFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors live filter inputs below
    [
      orders,
      selectedPlatform,
      selectedShopId,
      searchQuery,
      printStatusFilter,
      activeSubTab,
    ],
  );

  /** Badge count ĐVVC — cùng logic getShippingCarrierGroup với filter list. */
  const shippingCarrierCounts = useMemo(() => {
    const counts: Record<ShippingCarrierFilter, number> = {
      all: 0,
      spx: 0,
      ghn: 0,
      instant: 0,
      other: 0,
    };
    const carrierFilterTabs = new Set([
      'pending_confirm',
      'pending_verification',
      'unprocessed',
      'processed',
      'cancel_returns',
      'received_cancel_returns',
    ]);
    if (!carrierFilterTabs.has(activeSubTab)) return counts;
    const pool =
      activeSubTab === 'cancel_returns' && cancelReturnTab !== 'all'
        ? ordersPoolBeforeCarrier.filter((o) => matchesCancelReturnTab(o, cancelReturnTab))
        : ordersPoolBeforeCarrier;
    for (const order of pool) {
      const group = getShippingCarrierGroup(order);
      counts.all += 1;
      counts[group] += 1;
    }
    return counts;
  }, [activeSubTab, cancelReturnTab, ordersPoolBeforeCarrier]);

  const singleItemSortKey = (order: Order) => {
    const item = (order.items || [])[0];
    if (!item) return '';
    return String(item.productTitle || item.modelSku || item.modelName || '').trim();
  };

  const filteredOrdersBase = useMemo(() => {
    return ordersPoolBeforeCarrier
      .filter((order) => {
        if (searchQuery.trim()) return true;
        return orderMatchesShippingCarrierFilter(order, selectedShippingCarrier);
      })
      .sort((a, b) => {
        if (selectedSort === 'newest') return orderCreatedAtMs(b) - orderCreatedAtMs(a);
        if (selectedSort === 'oldest') return orderCreatedAtMs(a) - orderCreatedAtMs(b);
        if (selectedSort === 'highest_value') {
          return (Number(b.totalAmount) || 0) - (Number(a.totalAmount) || 0);
        }
        return 0;
      });
  }, [
    ordersPoolBeforeCarrier,
    searchQuery,
    selectedShippingCarrier,
    selectedSort,
    activeSubTab,
    cancelReturnTab,
  ]);

  const filteredOrders = useMemo(() => {
    if (!(smartPickSort && activeSubTab === 'unprocessed')) return filteredOrdersBase;
    return [...filteredOrdersBase].sort((a, b) => {
      const aSingle = (a.items || []).length === 1;
      const bSingle = (b.items || []).length === 1;
      if (aSingle && !bSingle) return -1;
      if (!aSingle && bSingle) return 1;
      if (aSingle && bSingle) {
        const nameCmp = singleItemSortKey(a).localeCompare(singleItemSortKey(b), 'vi', {
          sensitivity: 'base',
          numeric: true,
        });
        if (nameCmp !== 0) return nameCmp;
        const aq = Number(a.items[0]?.quantity) || 0;
        const bq = Number(b.items[0]?.quantity) || 0;
        return aq - bq;
      }
      return 0;
    });
  }, [filteredOrdersBase, smartPickSort, activeSubTab]);

  /** Màng lọc cuối — không render đơn lệch sub-tab Hủy/Hoàn dù state bị race. */
  const displayOrders = useMemo(
    () =>
      filteredOrders.filter((order) =>
        matchesStrictDisplaySubTab(order, activeSubTab, cancelReturnTab),
      ),
    [filteredOrders, activeSubTab, cancelReturnTab],
  );

  const listPagingTotal = useMemo(() => {
    const backend = Number(ordersMeta?.total) || 0;
    if (activeSubTab !== 'cancel_returns') return backend;
    if (cancelReturnTab === 'all') {
      return Number(cancelReturnKindCounts.all) || backend;
    }
    return backend || Number(cancelReturnKindCounts[cancelReturnTab]) || 0;
  }, [activeSubTab, cancelReturnTab, cancelReturnKindCounts, ordersMeta?.total]);

  const listPagingPages = useMemo(() => {
    if (activeSubTab !== 'cancel_returns') return ordersMeta?.totalPages ?? 1;
    return Math.max(1, Math.ceil(listPagingTotal / ORDERS_PAGE_SIZE) || 1);
  }, [activeSubTab, listPagingTotal, ordersMeta?.totalPages]);


  // Resolve checkbox selections to full Order rows — CHỈ lấy đơn đang hiển thị
  // (đã lọc ĐVVC), để In/Xác nhận hàng loạt không đụng đơn bị ẩn.
  const getSelectedOrders = (): Order[] => {
    if (selectedOrderIds.length === 0) return [];
    const keySet = new Set(selectedOrderIds.map(k => String(k).trim()).filter(Boolean));
    return displayOrders.filter(o =>
      keySet.has(o.id) ||
      keySet.has(o.orderSn) ||
      keySet.has(`shopee-${o.orderSn}`)
    );
  };

  const getSelectedOrderSns = (): string[] =>
    [...new Set(getSelectedOrders().map(o => o.orderSn).filter(sn => Boolean(sn && String(sn).trim())))];

  const openBulkShipConfirm = (targets: Order[]) => {
    if (targets.length === 0) {
      showToast('Không có đơn Shopee hợp lệ trong danh sách đã chọn.');
      return;
    }
    setShowBulkActionsDropdown(false);
    setShipMethod('dropoff');
    setShipConfirmOrders(targets);
  };

  // Toggle selection for bulk actions
  const handleToggleSelectAll = () => {
    if (selectedOrderIds.length === displayOrders.length) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(displayOrders.map(o => o.id));
    }
  };

  const handleToggleSelectOne = useCallback((id: string) => {
    setSelectedOrderIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  }, []);

  // Bulk Actions — chặn mọi redirect/navigation mặc định của nút/link
  const handleBulkPrint = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn hàng để thực hiện in!');
      return;
    }
    setShowBulkActionsDropdown(false);

    const resolveShopIdForPrint = (o: Order): string => {
      const direct = String(o.shopId || '').trim();
      if (direct) return direct;
      const name = String(o.shopName || '').trim().toLowerCase();
      if (!name) return '';
      const match = shops.find(
        (s) =>
          String(s.platform || '').toLowerCase() === 'shopee' &&
          String(s.shopName || '').trim().toLowerCase() === name,
      );
      return String(match?.shopId || '').trim();
    };

    const shopeeAll = selected
      .filter((o) => o.channel === 'shopee' && (o.shopId || resolveShopIdForPrint(o)))
      .map((o) => o.id || `shopee-${o.orderSn}`);
    const others = selected.filter(
      (o) => !(o.channel === 'shopee' && (o.shopId || resolveShopIdForPrint(o))),
    );

    setIsBulkPrinting(true);
    if (shopeeAll.length > 0) {
      beginPrintProgressSession(
        shopeeAll.length,
        shopeeAll.length === 1
          ? 'Đang in 1 đơn — xử lý ngay...'
          : `Đang in hàng loạt ${shopeeAll.length} đơn...`,
      );
    }
    try {
      if (shopeeAll.length > 0) {
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: 'shopee',
          type: 'stock_sync',
          status: 'success',
          message: `[SHOPEE PRINT] ${shopeeAll.length === 1 ? 'fast-path 1 đơn' : `batch×${shopeeAll.length}`} — đọc PDF kho nội bộ (Mongo waybill_url).`,
        });
        const result = await printShopeeDocuments(shopeeAll, {
          onProgress: (completed, total) => {
            setProgressCompleted(completed);
            setProgressTotal(total);
            setProgressMessage(
              completed >= total
                ? 'Hoàn tất — đang mở PDF vận đơn...'
                : total === 1
                  ? 'Đang lấy PDF từ kho nội bộ...'
                  : `Đang lấy PDF nội bộ: ${completed}/${total} đơn...`
            );
          },
          onStatus: (message) => setProgressMessage(message),
        });
        if (!result.success) {
          showToast(`In vận đơn Shopee thất bại: ${result.message}`);
        } else {
          if (result.message) showToast(result.message);
          const optimisticTargets = applyPrintedLocalOptimistic(shopeeAll, true);
          if (optimisticTargets.length > 0) {
            void updatePrintStatusForOrders(optimisticTargets, true, { silent: true }).catch(() => {});
          }
          refetchOrdersPage({ silent: true });
          setSelectedOrderIds([]);
          markProgressComplete('In vận đơn thành công!');
        }
      }
      // Non-Shopee (manual/tiktok) orders don't have a real Shopee AWB — show the mock preview instead.
      if (others.length > 0) {
        setBulkPrintOrders(others);
        onUpdateOrders(orders.map(o => others.some(x => x.id === o.id) ? {
          ...o,
          ...(isProcessedCondition(o)
            ? { isPrinted: true, status: 'processed' as const }
            : { isPrepared: o.isPrepared }),
        } : o), { persist: false });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
      showToast(`In vận đơn Shopee thất bại: ${msg}`);
    } finally {
      setIsBulkPrinting(false);
      clearShipProgressOverlay();
    }
  };

  const handleBulkConfirm = () => {
    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn hàng để xác nhận!');
      return;
    }
    setShowBulkActionsDropdown(false);

    const shopeeShipTargets = selected.filter(
      o => o.channel === 'shopee' && (o.status === 'unprocessed' || o.status === 'pending_confirm')
    );
    if (shopeeShipTargets.length > 0) {
      openBulkShipConfirm(shopeeShipTargets);
      return;
    }

    let count = 0;
    const updated = orders.map(o => {
      if (selected.some(s => s.id === o.id) && o.status === 'pending_confirm') {
        count++;
        return { ...o, status: 'unprocessed' as const };
      }
      return o;
    });

    if (count === 0) {
      showToast('Không có đơn nào ở trạng thái có thể xác nhận trong danh sách đã chọn.');
      return;
    }

    onUpdateOrders(updated);
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: `Xác nhận hàng loạt thành công ${count} đơn hàng chờ xác nhận.`
    });
    showToast(`Đã xác nhận xử lý thành công ${count} đơn hàng.`);
    setSelectedOrderIds([]);
  };

  /** In lại đơn đã chọn (không xác nhận lại, chỉ lấy PDF và gộp thành 1 file) */
  const handleReprintSelected = async () => {
    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn để in!');
      return;
    }
    setShowBulkActionsDropdown(false);

    const shopeeOrders = selected.filter(o => o.channel === 'shopee');
    if (shopeeOrders.length === 0) {
      showToast('Chỉ hỗ trợ in lại đơn Shopee.');
      return;
    }

    const orderSns = shopeeOrders.map(o => String(o.orderSn || '').replace(/^shopee-/i, '').trim()).filter(Boolean);
    if (orderSns.length === 0) {
      showToast('Không tìm thấy mã đơn hợp lệ.');
      return;
    }

    beginPrintProgressSession(orderSns.length, `Đang gộp PDF ${orderSns.length} đơn...`);
    const reservedPrintWindow = openReservedPrintPlaceholder();
    
    try {
      setProgressMessage('Đang gọi API gộp PDF...');
      
      // Cho phép backend fallback polling Shopee khi PDF nền chưa READY.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35_000);
      
      try {
        const response = await fetch('/api/orders/batch-print-only', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ orderSns }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const data = await readResponseJson<any>(response);
        
        if (response.ok && data.success && data.url) {
          setProgressMessage('Đang mở PDF...');
          if (!navigateReservedPrintWindow(reservedPrintWindow, data.url)) {
            const printWindow = window.open(data.url, '_blank');
            if (!printWindow) {
              throw new Error('Trình duyệt đã chặn cửa sổ PDF. Vui lòng cho phép popup và thử lại.');
            }
          }
          const failedOrderIds = getBatchFailedOrderIds(data);
          const completionMessage = failedOrderIds.length > 0
            ? `Đã in gộp ${data.pdfCount} đơn. Các đơn lỗi: ${failedOrderIds.join(', ')}`
            : `Đã in gộp ${data.pdfCount} đơn.`;
          const printedSns = Array.isArray(data.printedOrders) ? data.printedOrders : orderSns;
          const optimisticTargets = applyPrintedLocalOptimistic(printedSns, true);
          const statusTargets = optimisticTargets.length > 0 ? optimisticTargets : shopeeOrders;
          void updatePrintStatusForOrders(statusTargets, true, { silent: true }).catch(() => {});
          refetchOrdersPage({ silent: true });
          markProgressComplete(completionMessage);
          showToast(completionMessage);
          setSelectedOrderIds([]);
          
          onAddLog({
            id: `log-${Date.now()}`,
            timestamp: new Date().toISOString(),
            channel: 'shopee',
            type: 'stock_sync',
            status: 'success',
            message: `[IN LẠI] ${data.pdfCount} đơn → ${data.filename}`,
          });
        } else {
          closeReservedPrintWindow(reservedPrintWindow);
          alert(`In lại thất bại: ${data.message || 'Lỗi không xác định'}`);
        }
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);
        closeReservedPrintWindow(reservedPrintWindow);
        if (fetchErr.name === 'AbortError') {
          alert('Shopee chưa tạo xong PDF sau thời gian chờ. Vui lòng thử lại sau ít phút.');
        } else {
          throw fetchErr;
        }
      }
    } catch (err) {
      closeReservedPrintWindow(reservedPrintWindow);
      console.error('[Reprint] Error:', err);
      alert('Không thể kết nối API. Vui lòng thử lại.');
    } finally {
      clearShipProgressOverlay();
    }
  };

  /** Giao cho ĐVVC hàng loạt — đơn đã chọn (đã có mã vận đơn, chưa bàn giao). */
  const handleBulkHandOverCarrier = async (e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setShowBulkActionsDropdown(false);

    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn hàng để giao cho ĐVVC!');
      return;
    }

    const eligible = selected.filter(
      (o) => isEligibleForHandOverToCarrier(o) && !isOrderHandedOverToCarrier(o),
    );
    if (eligible.length === 0) {
      const sample = selected[0];
      const why = sample ? getHandOverIneligibleReason(sample) : '';
      showToast(
        why
          ? `Không bàn giao được: ${why}`
          : 'Không có đơn hợp lệ (chỉ Chờ lấy hàng đã xử lý + có mã VĐ + chưa giao ĐVVC).',
      );
      return;
    }

    const token = localStorage.getItem('admin_token');
    if (!token) {
      showToast('Chưa đăng nhập — không thể bàn giao ĐVVC hàng loạt.');
      return;
    }

    if (isHandingOverRef.current || isBulkHandingOver) {
      showToast('Đang xử lý bàn giao ĐVVC — vui lòng đợi.');
      return;
    }

    isHandingOverRef.current = true;
    setIsBulkHandingOver(true);

    // Optimistic UI ngay — không chờ API / không refetch full list.
    applyHandoverBulkToLocalOrders(eligible);
    setSelectedOrderIds([]);
    openHandedOverCarrierTab();
    showToast(`Đã giao cho ĐVVC ${eligible.length} đơn (đang lưu nền)...`);
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: `[BÀN GIAO HÀNG LOẠT] ${eligible.length} đơn → Đã giao cho ĐVVC (optimistic).`,
    });

    const orderIds = eligible.map((o) => o.id).filter(Boolean);
    const orderSns = eligible.map((o) => o.orderSn).filter(Boolean);
    void (async () => {
      try {
        const res = await fetch('/api/orders/hand-over-carrier/bulk', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ orderIds, orderSns }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          message?: string;
          error?: string;
        };
        if (!res.ok || data?.success === false) {
          throw new Error(String(data?.message || data?.error || `HTTP ${res.status}`));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        rollbackHandoverOnLocalOrders(eligible);
        showToast(`Lưu bàn giao ĐVVC nền thất bại: ${msg}`);
      } finally {
        isHandingOverRef.current = false;
        setIsBulkHandingOver(false);
      }
    })();
  };

  // Single-order "Chuẩn bị hàng" — opens the pickup/dropoff confirmation modal;
  // the real ship_order call fires only after the seller confirms a method.
  const handleSinglePrepare = useCallback((order: Order) => {
    setShipMethod('dropoff');
    setShipConfirmOrders([order]);
  }, []);

  // Single-order print — fetches the REAL Shopee AWB PDF, or falls back to the
  // mock packing-slip preview for non-Shopee (manual/tiktok) orders.
  /** Xóa dữ liệu hàng loạt — chỉ hoạt động trong tab Đã nhận đơn hủy/hoàn. */
  const handleBulkDeleteOrders = async () => {
    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn hàng để xóa.');
      return;
    }
    if (!window.confirm(`Xóa ${selected.length} đơn đã chọn khỏi Database? Hành động này không thể hoàn tác.`)) {
      return;
    }
    const token = localStorage.getItem('admin_token');
    if (!token) {
      showToast('Chưa đăng nhập — không thể xóa đơn.');
      return;
    }
    const orderSns = selected.map(o => o.orderSn || o.id).filter(Boolean) as string[];
    try {
      const res = await fetch('/api/orders/batch-delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ orderSns }),
      });
      const data = await res.json();
      if (data.success) {
        const deletedSns = new Set(orderSns);
        const updated = orders.filter(o => !deletedSns.has(o.orderSn || '') && !deletedSns.has(o.id || ''));
        onUpdateOrders(updated, { persist: true });
        setSelectedOrderIds([]);
        showToast(`Đã xóa ${data.deleted} đơn (Mongo: ${data.mongoDeleted}, don_hoan_huy: ${data.donHoanHuyDeleted ?? 0}, JSON: ${data.jsonRemoved}).`);
      } else {
        showToast(data.error || data.message || 'Xóa thất bại.');
      }
    } catch {
      showToast('Lỗi kết nối khi xóa đơn.');
    }
  };

  const releasePrintClickLock = () => {
    if (isPrintingUnlockTimerRef.current) clearTimeout(isPrintingUnlockTimerRef.current);
    isPrintingUnlockTimerRef.current = window.setTimeout(() => {
      isPrintingRef.current = false;
      isPrintingUnlockTimerRef.current = null;
    }, 1000);
  };

  const handlePrintButtonClick = (e: React.MouseEvent, order: Order) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPrintingRef.current) return;
    isPrintingRef.current = true;
    void handleSinglePrint(order).finally(() => {
      releasePrintClickLock();
    });
  };

  const handleSinglePrint = async (order: Order) => {
    if (order.channel !== 'shopee' || !order.shopId) {
      setBulkPrintOrders([order]);
      // Optimistic: non-Shopee → đánh dấu Đã in ngay + sync DB nền.
      const localHit = applyPrintedLocalOptimistic(
        [String(order.orderSn || order.id || '')],
        true,
      );
      if (localHit.length === 0) {
        onUpdateOrders(orders.map(o => o.id === order.id ? {
          ...o,
          isPrinted: true,
          ...(isProcessedCondition(o) ? { status: 'processed' as const } : {}),
        } : o), { persist: false });
      }
      void updatePrintStatusForOrders([order], true, { silent: true }).catch(() => {});
      return;
    }

    // Deliberately NOT checking order.isPrepared here anymore — Shopee's own
    // create_shipping_document/get_shipping_document API is the single source
    // of truth for whether the order's logistics status actually allows a
    // label to be generated. If it doesn't, Shopee's own error message (surfaced
    // in the alert below) explains why — no more local pre-check blocking the request.
    setPrintingOrderId(order.id);
    beginPrintProgressSession(1, 'Đang in 1 đơn — xử lý ngay...');
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'shopee',
      type: 'stock_sync',
      status: 'success',
      message: `[SHOPEE PRINT] fast-path 1 đơn ${order.orderSn} — đọc PDF kho nội bộ.`,
    });
    try {
      const result = await printShopeeDocuments([order.id], {
        onProgress: (completed, total) => {
          setProgressCompleted(completed);
          setProgressTotal(total);
          setProgressMessage(
            completed >= total ? 'Hoàn tất — đang mở PDF...' : 'Đang lấy PDF từ kho nội bộ...'
          );
        },
        onStatus: (message) => setProgressMessage(message),
      });
      if (!result.success) {
        alert(`In vận đơn thất bại cho đơn ${order.orderSn}: ${result.message}`);
      } else {
        applyPrintedLocalOptimistic(
          [String(order.id || ''), String(order.orderSn || '')],
          true,
        );
        void updatePrintStatusForOrders([order], true, { silent: true }).catch(() => {});
        refetchOrdersPage({ silent: true });
        markProgressComplete('In vận đơn thành công!');
      }
    } catch (err) {
      alert('Không thể kết nối API in vận đơn Shopee. Vui lòng thử lại.');
    } finally {
      setPrintingOrderId(null);
      clearShipProgressOverlay();
    }
  };

  // Separate shops for multi-store badges
  const shopeeShops = shops.filter(s => s.platform === 'shopee');
  const tiktokShops = shops.filter(s => s.platform === 'tiktok');
  const woocommerceShops = shops.filter(s => s.platform === 'woocommerce');

  const selectedShopeeShop =
    selectedPlatform === 'shopee' && selectedShopId && selectedShopId !== 'all'
      ? shopeeShops.find(
          (s) =>
            String(s.shopId) === String(selectedShopId) ||
            String(s.id) === String(selectedShopId),
        )
      : undefined;
  const shopeeSelectorLabel = (() => {
    if (selectedShopeeShop?.shopName) return `Shopee: ${selectedShopeeShop.shopName}`;
    if (selectedPlatform === 'shopee' && (!selectedShopId || selectedShopId === 'all')) {
      if (shopeeShops.length === 1 && shopeeShops[0]?.shopName) {
        return `Shopee: ${shopeeShops[0].shopName}`;
      }
      if (shopeeShops.length === 0) return 'Chọn gian hàng';
    }
    if (shopeeShops.length === 0) return 'Chọn gian hàng';
    return `Shopee (${shopeeShops.length} gian hàng)`;
  })();

  const clearVerifiedScanLists = () => {
    daXuatKhoListRef.current = [];
    donHuyListRef.current = [];
    daNhanHoanListRef.current = [];
    setDaXuatKhoList([]);
    setDonHuyList([]);
    setDaNhanHoanList([]);
    setScanStatModal(null);
  };

  /** Chỉ đóng UI quét khi user chủ động thoát — không redirect trang chủ. */
  const closeScannerUiOnly = () => {
    clearVerifiedScanLists();
    setCameraScanResult('Quét realtime QR + mã vạch — dò trạng thái ngay mỗi mã');
    setCameraScanSuccess(false);
    setScanToast(null);
    setShowEndConfirm(false);
    setIsFlushingQueue(false);
    // Refresh badge Menu ngay khi thoát Quét (worker dò ngầm có thể vừa ghi DB).
    void fetchOrdersWithShop({
      silent: true,
      page: 1,
      limit: ORDERS_PAGE_SIZE,
      merge: false,
      tab: activeSubTab === 'all' ? '' : activeSubTab,
      kind: listKind,
    });
    if (onCloseScanner) onCloseScanner();
    else if (onEndScanSession) onEndScanSession();
  };

  const handleEndScanSession = () => {
    closeScannerUiOnly();
  };

  /** Kết thúc: tắt camera → ghi DB (timeout 90s) → reset list → bật lại camera. */
  const handleFinishContinuousScan = async () => {
    // Chống double-click / gọi trùng khi đang ghi DB.
    if (isFlushingQueue) return;
    setShowEndConfirm(false);

    const shipped = [...daXuatKhoListRef.current];
    const cancelled = [...donHuyListRef.current];
    const returned = [...daNhanHoanListRef.current];
    const codes = [
      ...shipped.map((i) => i.code),
      ...cancelled.map((i) => i.code),
      ...returned.map((i) => i.code),
    ];

    const stopCameraHard = async () => {
      isTearingDownScannerRef.current = true;
      pendingScanQueueRef.current = [];
      isScanBusyRef.current = false;
      stopTapToFocusAssist(CAMERA_TAP_LAYER_ID);
      try {
        const handle = liveScannerRef.current;
        liveScannerRef.current = null;
        await handle?.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
      try {
        await stopLiveQrScanner('camera-reader');
      } catch {
        /* ignore */
      }
    };

    /** Camera stop tối đa 3s — không được treo loading vì ZXing/DOM. */
    const stopCameraWithTimeout = async () => {
      await Promise.race([
        stopCameraHard(),
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 3_000);
        }),
      ]);
    };

    // Không có mã đã verify → thoát phiên (đóng UI quét, vẫn ở tab Đơn hàng).
    if (codes.length === 0) {
      await stopCameraWithTimeout();
      isTearingDownScannerRef.current = false;
      closeScannerUiOnly();
      return;
    }

    const SCAN_SAVE_TIMEOUT_MS = 90_000;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), SCAN_SAVE_TIMEOUT_MS);
    let shouldCloseScanner = false;
    let shouldResumeCamera = false;

    setFlushingDbCount(codes.length);
    setIsFlushingQueue(true);
    setCameraScanResult(`Đang ghi DB ${codes.length} đơn đã phân loại...`);

    try {
      // 1) Tắt camera trong try — lỗi/treo stop không bỏ sót finally tắt loading.
      await stopCameraWithTimeout();

      const token = localStorage.getItem('admin_token');
      if (!token) {
        throw new Error('Chưa đăng nhập — không thể cập nhật đơn đã quét.');
      }

      const pickCodes = (items: ScanVerifiedItem[]) =>
        [
          ...new Set(
            items
              .flatMap((i) => [i.code, i.orderSn, i.trackingNumber, i.orderId])
              .map((c) => String(c || '').trim())
              .filter(Boolean),
          ),
        ];

      const huyCodes = pickCodes(cancelled);
      const hoanCodes = pickCodes(returned);
      const xuatCodes = pickCodes(shipped);

      let data: Record<string, unknown> = {};
      let dhhFromSave: {
        ok?: number;
        failed?: number;
        already?: number;
        ensured?: number;
        errors?: string[];
      } | null = null;

      try {
        const allCodes = [...new Set([...huyCodes, ...hoanCodes, ...xuatCodes])];
        if (allCodes.length === 0) {
          throw new Error('Không có mã đơn để lưu.');
        }
        const res = await fetch('/api/orders/scan-bulk-update', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            codes: allCodes,
            scannedCodes: allCodes,
            daXuatKhoCodes: xuatCodes,
            donHuyCodes: huyCodes,
            daNhanHoanCodes: hoanCodes,
          }),
        });
        const bulkData = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok || bulkData?.success === false || bulkData?.partialFailure === true) {
          throw new Error(
            String(
              bulkData?.message ||
                bulkData?.error ||
                `HTTP ${res.status} — lưu đơn đã quét thất bại`,
            ),
          );
        }
        // Dùng nguyên response server — KHÔNG ghi đè processedCount / summary bằng số mã FE.
        dhhFromSave = (bulkData?.donHoanHuy || null) as typeof dhhFromSave;
        data = bulkData;
      } catch (fetchErr: unknown) {
        const aborted =
          (fetchErr instanceof DOMException && fetchErr.name === 'AbortError') ||
          (fetchErr instanceof Error && fetchErr.name === 'AbortError') ||
          /aborted|AbortError|timeout|timed?\s*out/i.test(
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
          );
        throw new Error(
          aborted
            ? `Hết thời gian chờ ${Math.round(SCAN_SAVE_TIMEOUT_MS / 1000)} giây — server chưa phản hồi. Kiểm tra MongoDB / mạng rồi thử lại.`
            : fetchErr instanceof Error
              ? fetchErr.message
              : 'Không kết nối được API lưu đơn.',
        );
      }

      const summaryRaw = (data?.summary || {}) as {
        daXuatKho?: number;
        donHuy?: number;
        daNhanHoan?: number;
      };
      const daXuatKho = Number(summaryRaw.daXuatKho);
      const donHuy = Number(summaryRaw.donHuy);
      const daNhanHoan = Number(summaryRaw.daNhanHoan);
      const safeXuat = Number.isFinite(daXuatKho) ? daXuatKho : 0;
      const safeHuy = Number.isFinite(donHuy) ? donHuy : 0;
      const safeHoan = Number.isFinite(daNhanHoan) ? daNhanHoan : 0;
      const processedRaw = Number(data?.processedCount);
      const processedCount = Number.isFinite(processedRaw)
        ? processedRaw
        : safeXuat + safeHuy + safeHoan;
      const failedScans = Array.isArray(data?.failed_scans)
        ? (data.failed_scans as Array<{ reason?: string }>)
        : [];

      if (processedCount <= 0) {
        throw new Error(
          String(
            failedScans[0]?.reason ||
              data?.message ||
              'Không có đơn nào được lưu thành công!',
          ),
        );
      }

      // Hủy/hoàn bắt buộc phải có bản ghi don_hoan_huy (ok hoặc already).
      const needDonHoanHuy = cancelled.length + returned.length > 0;
      if (needDonHoanHuy) {
        const dhh = (data?.donHoanHuy || dhhFromSave || null) as {
          ok?: number;
          failed?: number;
          already?: number;
          ensured?: number;
          errors?: string[];
        } | null;
        if (!dhh) {
          throw new Error(
            'Backend chưa ghi collection don_hoan_huy — dữ liệu hủy/hoàn không được lưu. Kiểm tra server Mongo.',
          );
        }
        const ensured = Number(
          dhh.ensured ?? Number(dhh.ok || 0) + Number(dhh.already || 0),
        );
        if (!Number.isFinite(ensured) || ensured < 1) {
          throw new Error(
            String(
              dhh.errors?.[0] ||
                data?.message ||
                'Không ghi được đơn hủy/hoàn vào don_hoan_huy. Thử lại.',
            ),
          );
        }
      }

      const updatedOrders = Array.isArray(data?.orders) ? (data.orders as Order[]) : [];
      if (updatedOrders.length > 0) {
        const byId = new Map(updatedOrders.map((o) => [o.id, o]));
        const merged = ordersRef.current.map((o) => {
          const next = byId.get(o.id);
          return next ? { ...o, ...next } : o;
        });
        for (const o of updatedOrders) {
          if (!merged.some((x) => x.id === o.id)) merged.unshift(o);
        }
        ordersRef.current = merged;
        onUpdateOrders(merged, { persist: false });
      } else if (safeXuat > 0 && shipped.length > 0) {
        const shippedOrders = shipped
          .map((item) =>
            ordersRef.current.find(
              (o) =>
                o.id === item.orderId ||
                o.orderSn === item.orderSn ||
                String(o.trackingNumber || o.tracking_no || '') ===
                  String(item.trackingNumber || item.code || ''),
            ),
          )
          .filter(Boolean) as Order[];
        if (shippedOrders.length > 0) {
          applyHandoverBulkToLocalOrders(shippedOrders);
        }
      }

      if (safeXuat > 0) openHandedOverCarrierTab();
      else if (safeHoan > 0 || safeHuy > 0) {
        setActiveSubTab('received_cancel_returns');
      }

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'shopee',
        type: 'stock_sync',
        status: 'success',
        message: `[QUÉT QR COMMIT] xuất kho ${safeXuat}, đơn hủy ${safeHuy}, nhận hoàn ${safeHoan}.`,
      });

      // Toast trên màn quét + global — đọc ~1.5s rồi mới đóng UI.
      const successMsg = `Đã lưu thành công — Xuất kho ${safeXuat} / Hủy ${safeHuy} / Nhận hoàn ${safeHoan}${
        failedScans.length ? ` · Bỏ qua ${failedScans.length}` : ''
      }`;
      showScanToast(successMsg, 'success');
      showToast(successMsg, 5500);
      setCameraScanResult(
        `✓ Đã lưu DB: Xuất kho ${safeXuat} · Hủy ${safeHuy} · Nhận hoàn ${safeHoan}`,
      );
      if (failedScans.length > 0) {
        window.setTimeout(() => {
          showToast(`Bỏ qua ${failedScans.length} mã (trùng/không hợp lệ)`, 4500);
        }, 1600);
      }

      shouldCloseScanner = true;
    } catch (err: unknown) {
      // Giữ 3 list đã verify — cho phép bấm lại GHI DB.
      const msg = err instanceof Error ? err.message : String(err);
      const failMsg =
        msg?.trim() || 'Lưu thất bại — không rõ nguyên nhân. Xem log server.';
      showToast(failMsg, 7000);
      showScanToast(failMsg, 'error');
      setCameraScanResult(`${failMsg} — còn ${codes.length} mã. Bấm Kết thúc để thử lại`);
      shouldResumeCamera = true;
    } finally {
      window.clearTimeout(timeoutId);
      setIsFlushingQueue(false);
      setFlushingDbCount(0);
      if (shouldCloseScanner) {
        // Giữ teardown lock — tránh camera useEffect tự bật lại trước khi unmount.
        isTearingDownScannerRef.current = true;
        window.setTimeout(() => {
          isTearingDownScannerRef.current = false;
          closeScannerUiOnly();
        }, 1500);
      } else if (shouldResumeCamera) {
        isTearingDownScannerRef.current = false;
        window.setTimeout(() => {
          setCameraRestartKey((k) => k + 1);
        }, 80);
      }
    }
  };

  const scanStatModalMeta: Record<
    ScanStatModalKey,
    { title: string; color: string; items: ScanVerifiedItem[] }
  > = {
    daXuatKho: {
      title: 'Đã xuất kho',
      color: 'text-emerald-400',
      items: daXuatKhoList,
    },
    donHuy: {
      title: 'Đơn báo hủy',
      color: 'text-rose-400',
      items: donHuyList,
    },
    daNhanHoan: {
      title: 'Đã nhận hoàn',
      color: 'text-amber-400',
      items: daNhanHoanList,
    },
  };

  const handlePatchOrderStatus = useCallback(
    (order: Order, status: Order['status'], logMessage?: string) => {
      const updated = ordersRef.current.map((o) => (o.id === order.id ? { ...o, status } : o));
      ordersRef.current = updated;
      onUpdateOrders(updated);
      if (logMessage) {
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: order.channel,
          type: 'stock_sync',
          status: 'success',
          message: logMessage,
        });
      }
    },
    [onAddLog, onUpdateOrders],
  );

  const selectedOrderIdSet = useMemo(() => new Set(selectedOrderIds), [selectedOrderIds]);
  const resettingPrintSet = useMemo(
    () => new Set(resettingPrintIds.map((id) => String(id || '').replace(/^shopee-/i, '').trim())),
    [resettingPrintIds],
  );

  const handlePrintButtonClickRef = useRef(handlePrintButtonClick);
  handlePrintButtonClickRef.current = handlePrintButtonClick;
  const handOverOrderToCarrierRef = useRef(handOverOrderToCarrier);
  handOverOrderToCarrierRef.current = handOverOrderToCarrier;

  const orderRowActions = useMemo<OrderListRowActions>(
    () => ({
      onToggleSelect: handleToggleSelectOne,
      onToggleDetails: toggleOrderDetails,
      onPrint: (e, order) => handlePrintButtonClickRef.current(e, order),
      onPrepare: handleSinglePrepare,
      onHandOver: (order) => {
        void handOverOrderToCarrierRef.current(order);
      },
      onMarkPrinted: markPrintedStatusForOrders,
      onResetPrint: resetPrintStatusForOrders,
      onWooAction: handleWooOrderStatusAction,
      onConfirmReturn: confirmWarehouseReturnReceived,
      onPatchStatus: handlePatchOrderStatus,
    }),
    [
      confirmWarehouseReturnReceived,
      handlePatchOrderStatus,
      handleSinglePrepare,
      handleToggleSelectOne,
      handleWooOrderStatusAction,
      markPrintedStatusForOrders,
      resetPrintStatusForOrders,
      toggleOrderDetails,
    ],
  );

  const renderOrderDetails = useCallback(
    (order: Order) => (
      <OrderDetailAccordionPanel order={order} shops={shops} systemFees={systemFees} />
    ),
    [shops, systemFees],
  );

  if (focusScanner) {
    const modalMeta = scanStatModal ? scanStatModalMeta[scanStatModal] : null;

    return (
      <div
        className={`fixed inset-0 bg-zinc-950 z-50 flex flex-col select-none font-sans transition-colors duration-300 ${
          cameraScanError ? 'bg-rose-950' : ''
        }`}
      >
        <input
          ref={scanGunInputRef}
          type="text"
          readOnly
          inputMode="none"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          className="absolute left-0 top-0 w-px h-px opacity-0"
        />
        {/* Counters dashboard — clickable */}
        <div className="shrink-0 px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-white font-extrabold text-[10px] uppercase tracking-widest">
                Quét realtime · QR + mã vạch
              </span>
            </div>
            <div className="rounded-lg bg-blue-500/20 border border-blue-400/40 px-2.5 py-1">
              <span className="text-blue-300 font-black text-xs tabular-nums">
                Đã dò {totalVerifiedScans}/{continuousScanTarget || 0}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setScanStatModal('daXuatKho')}
              className="rounded-xl bg-emerald-500/15 border border-emerald-500/30 px-2 py-2.5 text-center cursor-pointer hover:bg-emerald-500/25 hover:border-emerald-400/50 active:scale-[0.98] transition-all"
            >
              <p className="text-[9px] font-bold text-emerald-400/90 uppercase tracking-wide leading-tight">Đã xuất kho</p>
              <p className="text-2xl font-black text-emerald-400 tabular-nums mt-0.5">{daXuatKhoList.length}</p>
            </button>
            <button
              type="button"
              onClick={() => setScanStatModal('donHuy')}
              className="rounded-xl bg-rose-500/15 border border-rose-500/30 px-2 py-2.5 text-center cursor-pointer hover:bg-rose-500/25 hover:border-rose-400/50 active:scale-[0.98] transition-all"
            >
              <p className="text-[9px] font-bold text-rose-400/90 uppercase tracking-wide leading-tight">Đơn báo hủy</p>
              <p className="text-2xl font-black text-rose-400 tabular-nums mt-0.5">{donHuyList.length}</p>
            </button>
            <button
              type="button"
              onClick={() => setScanStatModal('daNhanHoan')}
              className="rounded-xl bg-amber-500/15 border border-amber-500/30 px-2 py-2.5 text-center cursor-pointer hover:bg-amber-500/25 hover:border-amber-400/50 active:scale-[0.98] transition-all"
            >
              <p className="text-[9px] font-bold text-amber-400/90 uppercase tracking-wide leading-tight">Đã nhận hoàn</p>
              <p className="text-2xl font-black text-amber-400 tabular-nums mt-0.5">{daNhanHoanList.length}</p>
            </button>
          </div>
          <p className="text-center text-[10px] text-zinc-500 font-semibold">
            Chạm vào ô thống kê để xem danh sách mã · Đơn hủy sẽ báo đỏ + âm cảnh báo ngay
          </p>
        </div>

        {/* Camera */}
        <div className="flex-1 min-h-0 px-3 flex flex-col gap-2 pb-2">
          <div
            className={`flex-1 min-h-[220px] relative rounded-2xl overflow-hidden bg-black transition-colors duration-300 ${
              cameraScanSuccess
                ? 'border-2 border-emerald-400 shadow-[0_0_24px_rgba(52,211,153,0.35)]'
                : cameraScanError
                  ? 'border-2 border-rose-500 shadow-[0_0_24px_rgba(244,63,94,0.4)]'
                  : 'border border-zinc-800'
            }`}
          >
            <div id="camera-reader" className="w-full h-full object-cover" />
            <button
              type="button"
              id={CAMERA_TAP_LAYER_ID}
              className="absolute inset-0 z-[5] w-full h-full cursor-pointer opacity-0"
              aria-label="Chạm để lấy nét"
            />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center bg-black/20 z-[6]">
              <div
                className={`qr-viewfinder ${
                  cameraScanSuccess
                    ? 'qr-viewfinder-success'
                    : cameraScanError
                      ? 'qr-viewfinder-error'
                      : 'qr-viewfinder-idle'
                }`}
              >
                {!cameraScanSuccess && !cameraScanError && <div className="qr-scan-line" />}
              </div>
            </div>

            <p className="absolute bottom-2 left-0 right-0 text-center text-[10px] font-bold text-white/80 pointer-events-none z-[7]">
              Quét đến đâu · dò ngay đến đó — nghe bíp xanh OK / còi đỏ = đơn hủy
            </p>
            {cameraError && (
              <div className="absolute inset-0 z-20 bg-black/85 flex flex-col items-center justify-center p-4 text-center text-xs text-rose-400 font-semibold gap-3">
                <AlertCircle className="w-7 h-7 text-rose-500" />
                <span>{cameraError}</span>
                {cameraError !== HTTPS_CAMERA_MESSAGE && (
                  <button
                    type="button"
                    onClick={() => {
                      setCameraError('');
                      setCameraRestartKey((k) => k + 1);
                    }}
                    className="min-h-10 px-4 rounded-xl bg-blue-600 text-white font-bold text-xs"
                  >
                    Thử lại
                  </button>
                )}
              </div>
            )}
            {(isVerifyingScan && !isFlushingQueue) && (
              <div className="pointer-events-none absolute top-2 left-2 right-2 z-10 flex items-center justify-center gap-2 rounded-lg bg-black/50 px-3 py-1.5">
                <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                <p className="text-[11px] font-bold text-white/90">Đang phân loại...</p>
              </div>
            )}
          </div>

          <div
            className={`shrink-0 text-sm font-bold px-3 py-2.5 rounded-xl text-center transition-all ${
              cameraScanSuccess
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : cameraScanError
                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                  : cameraScanResult.includes('sẵn sàng') || cameraScanResult.includes('realtime')
                    ? 'text-zinc-500'
                    : 'bg-zinc-800 text-yellow-400 border border-zinc-700'
            }`}
          >
            {cameraScanResult}
          </div>
        </div>

        {scanToast && (
          <div
            className={`fixed top-16 left-3 right-3 z-60 text-xs font-bold px-4 py-3 rounded-xl shadow-lg flex items-center gap-2 ${
              scanToast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-rose-600 text-white'
            }`}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span className="flex-1">{scanToast.text}</span>
          </div>
        )}

        <div className="shrink-0 p-3 pt-2 border-t border-zinc-800 bg-zinc-950 space-y-2">
          <button
            type="button"
            disabled={isFlushingQueue}
            onClick={() => setShowEndConfirm(true)}
            className="w-full min-h-14 rounded-2xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-black text-base uppercase tracking-wide transition-colors shadow-lg shadow-rose-900/40 disabled:opacity-50"
          >
            Kết thúc
            {totalVerifiedScans > 0 ? ` · Ghi DB ${totalVerifiedScans} mã` : ' · Thoát'}
          </button>
          <p className="text-center text-[10px] text-zinc-500 font-semibold">
            Kết thúc = lưu chính thức vào database · đóng máy quét và về Quản lý đơn hàng
          </p>
        </div>

        {showEndConfirm && (
          <div className="fixed inset-0 z-70 bg-black/70 flex items-center justify-center p-6">
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-full max-w-sm space-y-4">
              <p className="text-white font-bold text-sm">
                {totalVerifiedScans > 0 ? 'Ghi database các mã đã dò?' : 'Thoát màn hình quét?'}
              </p>
              <p className="text-zinc-400 text-xs leading-relaxed">
                {totalVerifiedScans > 0
                  ? `Sẽ ghi DB: xuất kho ${daXuatKhoList.length} · hủy ${donHuyList.length} · nhận hoàn ${daNhanHoanList.length}. Sau đó đóng máy quét và quay về Quản lý đơn hàng.`
                  : 'Chưa có mã đã dò — sẽ đóng camera và quay về tab Đơn hàng.'}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowEndConfirm(false)}
                  className="flex-1 min-h-11 rounded-xl bg-zinc-800 text-zinc-300 font-bold text-sm"
                >
                  Huỷ
                </button>
                <button
                  type="button"
                  disabled={isFlushingQueue}
                  onClick={() => void handleFinishContinuousScan()}
                  className="flex-1 min-h-11 rounded-xl bg-rose-600 text-white font-bold text-sm disabled:opacity-50 disabled:pointer-events-none"
                >
                  {isFlushingQueue ? 'Đang lưu...' : 'Xác nhận'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Full overlay khi đang ghi DB — camera đã tắt, giải phóng RAM/CPU. */}
        {isFlushingQueue && (
          <div className="fixed inset-0 z-[90] bg-zinc-950/95 flex flex-col items-center justify-center gap-4 p-6">
            <Loader2 className="w-12 h-12 text-blue-400 animate-spin" />
            <p className="text-white font-black text-base text-center">
              Đang ghi DB {flushingDbCount || totalVerifiedScans || 1} đơn...
            </p>
            <p className="text-zinc-400 text-xs text-center font-semibold max-w-xs leading-relaxed">
              Camera đã tắt để giải phóng máy. Vui lòng chờ — tối đa 45 giây.
            </p>
          </div>
        )}

        {modalMeta && (
          <div className="fixed inset-0 z-80 bg-black/75 flex items-end sm:items-center justify-center p-4">
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md max-h-[75vh] flex flex-col shadow-2xl">
              <div className="shrink-0 px-4 py-3 border-b border-zinc-800 flex items-center justify-between gap-3">
                <div>
                  <p className={`text-sm font-black uppercase tracking-wide ${modalMeta.color}`}>
                    {modalMeta.title}
                  </p>
                  <p className="text-[10px] text-zinc-500 font-semibold mt-0.5">
                    {modalMeta.items.length} mã · chạm ngoài hoặc Đóng để thoát
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setScanStatModal(null)}
                  className="min-h-9 px-3 rounded-xl bg-zinc-800 text-zinc-200 text-xs font-bold"
                >
                  Đóng
                </button>
              </div>
              {modalMeta.items.length === 0 ? (
                <div className="flex-1 flex items-center justify-center p-8 text-xs text-zinc-500 font-semibold text-center">
                  Chưa có mã nào trong danh mục này
                </div>
              ) : (
                <ul className="flex-1 overflow-y-auto p-3 space-y-2">
                  {modalMeta.items.map((item, idx) => (
                    <li
                      key={item.id}
                      className="rounded-xl bg-zinc-950/90 border border-zinc-800 px-3 py-2.5"
                    >
                      <div className="flex items-start gap-2">
                        <span className="shrink-0 w-6 h-6 rounded-lg bg-zinc-800 text-zinc-300 text-[10px] font-black flex items-center justify-center">
                          {modalMeta.items.length - idx}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-mono text-white truncate">{item.code}</p>
                          {item.orderSn && (
                            <p className="text-[11px] text-zinc-400 font-semibold mt-0.5">
                              Đơn #{item.orderSn}
                            </p>
                          )}
                          {item.trackingNumber && (
                            <p className="text-[10px] text-zinc-500 font-mono truncate mt-0.5">
                              VĐ: {item.trackingNumber}
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (showCreateOrderPage) {
    return (
      <ManualOrderPage
        products={products}
        orders={orders}
        onBack={() => setShowCreateOrderPage(false)}
        onUpdateOrders={onUpdateOrders}
        onUpdateProduct={onUpdateProduct}
        onAddLog={onAddLog}
        authHeaders={authHeaders}
      />
    );
  }

  return (
    <div
      className="space-y-6 max-md:space-y-4 om-orders-page relative"
      onTouchStart={handlePullTouchStart}
      onTouchMove={handlePullTouchMove}
      onTouchEnd={() => void handlePullTouchEnd()}
      onTouchCancel={() => {
        pullActiveRef.current = false;
        pullStartYRef.current = null;
        pullDistanceRef.current = 0;
        if (!isPullRefreshing) setPullDistance(0);
      }}
    >
      {/* Pull-to-refresh indicator — chỉ hiện trên mobile khi vuốt */}
      <div
        className="om-pull-refresh-indicator md:hidden pointer-events-none flex items-center justify-center overflow-hidden transition-[height] duration-150 ease-out"
        style={{ height: isPullRefreshing ? 56 : pullDistance }}
        aria-hidden={!(isPullRefreshing || pullDistance > 8)}
      >
        <div
          className={`flex items-center gap-2 text-sky-600 text-xs font-bold ${
            isPullRefreshing || pullDistance >= OM_PULL_REFRESH_THRESHOLD_PX ? 'opacity-100' : 'opacity-70'
          }`}
        >
          <Loader2
            className={`w-5 h-5 text-sky-500 ${
              isPullRefreshing || pullDistance >= OM_PULL_REFRESH_THRESHOLD_PX ? 'animate-spin' : ''
            }`}
            style={
              !isPullRefreshing && pullDistance < OM_PULL_REFRESH_THRESHOLD_PX
                ? { transform: `rotate(${Math.min(360, (pullDistance / OM_PULL_REFRESH_THRESHOLD_PX) * 360)}deg)` }
                : undefined
            }
          />
          <span>
            {isPullRefreshing
              ? 'Đang làm mới đơn hàng...'
              : pullDistance >= OM_PULL_REFRESH_THRESHOLD_PX
                ? 'Thả để làm mới'
                : 'Vuốt xuống để làm mới'}
          </span>
        </div>
      </div>
      {lastSyncSummary && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs font-semibold text-blue-800">
          {lastSyncSummary}
        </div>
      )}
      {toastMessage && (
        <div className="fixed top-5 right-5 z-110 bg-slate-900 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl border border-slate-700 animate-in fade-in flex items-center gap-2 max-w-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
          <button type="button" onClick={() => setToastMessage(null)} className="ml-1 text-gray-400 hover:text-white cursor-pointer">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Hidden iframe — in ngầm sau bulk confirm (bypass popup blocker). */}
      {silentPrintSrc && (
        <iframe
          title="silent-label-print"
          src={silentPrintSrc}
          onLoad={handleSilentPrintIframeLoad}
          style={{ display: 'none', width: 0, height: 0, border: 0 }}
        />
      )}

      {/* Modal user-gesture: Tiếp tục In Đơn khi trình duyệt chặn popup sau await. */}
      {pendingAutoPrint && (
        <div className="fixed inset-0 bg-gray-900/80 backdrop-blur-xs flex items-center justify-center p-4 z-120 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-md w-full overflow-hidden shadow-2xl">
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="text-sm font-bold">Tiếp tục In Đơn</h3>
                  <p className="text-[10px] text-slate-400">
                    {pendingAutoPrint.count} đơn đã xác nhận thành công — sẵn sàng in vận đơn
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPendingAutoPrint(null)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-xs text-gray-600 leading-relaxed">
                Trình duyệt có thể chặn cửa sổ in tự động sau khi xác nhận hàng loạt.
                Bấm nút bên dưới để mở vận đơn các đơn đã xác nhận thành công.
              </p>
              <button
                type="button"
                onClick={() => void handleContinueAutoPrint()}
                className="w-full py-3.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-sm rounded-2xl shadow-md flex items-center justify-center gap-2"
              >
                <Printer className="w-4 h-4" />
                <span>Tiếp tục In Đơn ({pendingAutoPrint.count})</span>
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 1. TOP BAR: TMDT Platform Quick Selection Bar (Close match to mockup) */}
      <div className="om-orders-mobile-hide-top-bar bg-slate-50 border border-gray-200 rounded-2xl p-3 flex flex-wrap items-center justify-between gap-4">
        {/* Left Platforms Pills */}
        <div className="flex items-center gap-2">
          {/* Shopee Dropdown Trigger */}
          <div className="relative">
            <button 
              onClick={() => {
                setShowShopeeDropdown(!showShopeeDropdown);
                setShowTikTokDropdown(false);
                setShowWooDropdown(false);
                if (selectedPlatform !== 'shopee') {
                  setSelectedPlatform('shopee');
                  setSelectedShopId('all');
                }
              }}
              className={`px-4 py-2 bg-white hover:bg-orange-50/40 border rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 shadow-xs cursor-pointer ${
                selectedPlatform === 'shopee' ? 'border-orange-500 ring-2 ring-orange-500/20 text-orange-600' : 'border-gray-200 text-gray-700'
              }`}
            >
              <span className="w-5 h-5 bg-orange-500 text-white font-extrabold text-[10px] rounded flex items-center justify-center">S</span>
              <span className="truncate max-w-40">{shopeeSelectorLabel}</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            </button>

            {showShopeeDropdown && (
              <div className="absolute top-11 left-0 bg-white border border-gray-100 rounded-2xl shadow-xl py-2 w-64 z-20 animate-in fade-in duration-100">
                <button
                  onClick={() => {
                    setSelectedPlatform('shopee');
                    setSelectedShopId('all');
                    setShowShopeeDropdown(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-orange-600 hover:bg-orange-50 flex items-center justify-between"
                >
                  <span>Tất cả Shopee</span>
                  <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.2 rounded">Chọn</span>
                </button>
                <div className="border-t border-gray-50 my-1"></div>
                {shopeeShops.map(shop => (
                  <button
                    key={shop.id}
                    onClick={() => {
                      setSelectedPlatform('shopee');
                      setSelectedShopId(String(shop.shopId));
                      setShowShopeeDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 flex items-center justify-between font-medium"
                  >
                    <span className="truncate">{shop.shopName}</span>
                    <span className="text-[10px] font-mono text-gray-400 shrink-0">ID: {shop.shopId}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* WooCommerce Dropdown Trigger */}
          <div className="relative">
            <button 
              onClick={() => {
                setShowWooDropdown(!showWooDropdown);
                setShowShopeeDropdown(false);
                setShowTikTokDropdown(false);
                if (selectedPlatform !== 'woocommerce') {
                  setSelectedPlatform('woocommerce');
                  setSelectedShopId('all');
                }
              }}
              className={`px-4 py-2 bg-white hover:bg-indigo-50/40 border rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 shadow-xs cursor-pointer ${
                selectedPlatform === 'woocommerce' ? 'border-indigo-600 ring-2 ring-indigo-600/20 text-indigo-700' : 'border-gray-200 text-gray-700'
              }`}
            >
              <span className="w-5 h-5 bg-indigo-600 text-white font-extrabold text-[10px] rounded flex items-center justify-center">W</span>
              <span>WooCommerce ({woocommerceShops.length} web)</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            </button>

            {showWooDropdown && (
              <div className="absolute top-11 left-0 bg-white border border-gray-100 rounded-2xl shadow-xl py-2 w-64 z-20 animate-in fade-in duration-100">
                <button
                  onClick={() => {
                    setSelectedPlatform('woocommerce');
                    setSelectedShopId('all');
                    setShowWooDropdown(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-50/50 flex items-center justify-between"
                >
                  <span>Tất cả WooCommerce</span>
                  <span className="text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.2 rounded">Chọn</span>
                </button>
                <div className="border-t border-gray-50 my-1"></div>
                {woocommerceShops.length === 0 ? (
                  <div className="px-4 py-2 text-xs text-gray-400 italic">Chưa kết nối website nào</div>
                ) : (
                  woocommerceShops.map(shop => (
                    <button
                      key={shop.id}
                      onClick={() => {
                        setSelectedPlatform('woocommerce');
                        setSelectedShopId(String(shop.shopId));
                        setShowWooDropdown(false);
                      }}
                      className="w-full text-left px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 flex items-center justify-between font-medium"
                    >
                      <span className="truncate">{shop.shopName}</span>
                      <span className="text-[10px] font-mono text-gray-400 shrink-0">Web</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Lazada Demo Pill (Greyed out as inactive like mockup) */}
          <button 
            type="button"
            className="px-4 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-semibold text-slate-400 flex items-center gap-2 cursor-not-allowed"
            title="Lazada Chưa kết nối API"
          >
            <span className="w-5 h-5 bg-slate-300 text-white font-bold text-[9px] rounded flex items-center justify-center">L</span>
            <span>Lazada (Chưa liên kết)</span>
          </button>

          {/* TikTok Dropdown Trigger */}
          <div className="relative">
            <button 
              onClick={() => {
                setShowTikTokDropdown(!showTikTokDropdown);
                setShowShopeeDropdown(false);
                setShowWooDropdown(false);
                if (selectedPlatform !== 'tiktok') {
                  setSelectedPlatform('tiktok');
                  setSelectedShopId('all');
                }
              }}
              className={`px-4 py-2 bg-white hover:bg-zinc-50 border rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 shadow-xs cursor-pointer ${
                selectedPlatform === 'tiktok' ? 'border-zinc-900 ring-2 ring-zinc-900/10 text-zinc-950' : 'border-gray-200 text-gray-700'
              }`}
            >
              <span className="w-5 h-5 bg-zinc-950 text-white font-bold text-[10px] rounded flex items-center justify-center">T</span>
              <span>TikTok Shop ({tiktokShops.length} gian hàng)</span>
              <ChevronDown className="w-3.5 h-3.5 text-gray-400 shrink-0" />
            </button>

            {showTikTokDropdown && (
              <div className="absolute top-11 left-0 bg-white border border-gray-100 rounded-2xl shadow-xl py-2 w-64 z-20 animate-in fade-in duration-100">
                <button
                  onClick={() => {
                    setSelectedPlatform('tiktok');
                    setSelectedShopId('all');
                    setShowTikTokDropdown(false);
                  }}
                  className="w-full text-left px-4 py-2 text-xs font-bold text-zinc-900 hover:bg-zinc-50 flex items-center justify-between"
                >
                  <span>Tất cả TikTok Shop</span>
                  <span className="text-[10px] bg-zinc-100 text-zinc-800 px-1.5 py-0.2 rounded">Chọn</span>
                </button>
                <div className="border-t border-gray-50 my-1"></div>
                {tiktokShops.map(shop => (
                  <button
                    key={shop.id}
                    onClick={() => {
                      setSelectedPlatform('tiktok');
                      setSelectedShopId(String(shop.shopId));
                      setShowTikTokDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2 text-xs text-gray-700 hover:bg-gray-50 flex items-center justify-between font-medium"
                  >
                    <span className="truncate">{shop.shopName}</span>
                    <span className="text-[10px] font-mono text-gray-400 shrink-0">ID: {shop.shopId}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Manual filter pill */}
          <button 
            type="button"
            onClick={() => {
              setSelectedPlatform('manual');
              setSelectedShopId('all');
            }}
            className={`px-4 py-2 bg-white hover:bg-emerald-50 border rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 shadow-xs cursor-pointer ${
              selectedPlatform === 'manual' ? 'border-emerald-600 ring-2 ring-emerald-600/15 text-emerald-700' : 'border-gray-200 text-gray-700'
            }`}
          >
            <span className="w-5 h-5 bg-emerald-600 text-white font-extrabold text-[10px] rounded flex items-center justify-center font-mono">M</span>
            <span>Đơn ngoài sàn ({orders.filter(o => o.channel === 'manual').length})</span>
          </button>

          {/* Reset Filter Pill */}
          {(selectedPlatform !== 'all' || selectedShopId !== 'all') && (
            <button
              onClick={() => {
                setSelectedPlatform('all');
                setSelectedShopId('all');
              }}
              className="px-2.5 py-1.5 bg-blue-50 text-blue-600 rounded-xl text-xs font-bold hover:bg-blue-100 transition-all"
            >
              Xem tất cả sàn ✕
            </button>
          )}
        </div>

        {/* Right action buttons */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleQuickSyncOrders}
            disabled={isSyncing || ordersLoading}
            title="Chỉ kéo đơn tạo/cập nhật trong 3 giờ gần nhất — nhanh, tránh timeout"
            className="px-4 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 font-extrabold text-xs rounded-xl shadow-xs transition-all flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Đồng bộ nhanh 3h</span>
          </button>
          <button
            type="button"
            onClick={handleRefreshOrders}
            disabled={isSyncing || ordersLoading}
            title="Đồng bộ đầy đủ ~14 ngày + đối soát trạng thái"
            className="px-4 py-2 bg-white hover:bg-blue-50 border border-gray-200 text-gray-700 font-extrabold text-xs rounded-xl shadow-xs transition-all flex items-center gap-2 cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Cập nhật đơn hàng</span>
          </button>
          <button
            onClick={() => setShowCreateOrderPage(true)}
            className="om-orders-mobile-hide-primary-actions px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl shadow-md shadow-emerald-500/15 hover:shadow-emerald-500/30 transition-all flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Tạo đơn hàng ngoài sàn</span>
          </button>
        </div>
      </div>

      {!audioEnabled && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2">
          <span className="text-xs font-semibold text-amber-800">
            Âm thanh thông báo đơn mới đang tắt
          </span>
          <button
            type="button"
            onClick={() => {
              unlockAudio();
              setAudioEnabled(true);
              playNotificationSound();
            }}
            className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold cursor-pointer"
          >
            Bật âm thanh thông báo
          </button>
        </div>
      )}

      {hasNewOrders && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-sky-200 bg-sky-50 px-4 py-2.5">
          <span className="text-xs font-semibold text-sky-800">
            Có đơn hàng mới trên hệ thống
          </span>
          <button
            type="button"
            onClick={() => refetchOrdersPage({ silent: false })}
            className="px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-bold cursor-pointer"
          >
            Có đơn hàng mới, làm mới danh sách
          </button>
        </div>
      )}

      {/* 2. SUB-TABS: Horizontal scrollable subtabs with counts — orders[] từ App.fetchOrders → GET /api/orders (cùng origin). Không import mock JSON. */}
      <div className="om-orders-sub-tabs border-b border-gray-200 flex flex-wrap gap-1 bg-white p-1 rounded-xl">
        <button
          onClick={() => selectOrdersSubTab('all')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'all' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          Tất cả đơn hàng ({getCount('all')})
        </button>

        <button
          onClick={() => selectOrdersSubTab('pending_confirm')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'pending_confirm' || activeSubTab === 'pending_verification'
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Chờ xác nhận</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-amber-100 text-amber-700 border border-amber-200/50">
            {getCount('pending_confirm')}
          </span>
        </button>

        <button
          onClick={() => selectOrdersSubTab('unprocessed')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'unprocessed' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Đơn chưa xử lý</span>
          <span className="px-1.5 py-0.2 text-[10px] font-black rounded-full bg-rose-100 text-rose-700 border border-rose-200">
            {getCount('unprocessed')}
          </span>
        </button>

        <button
          onClick={() => selectOrdersSubTab('processed')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'processed' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Chờ lấy hàng (Đã xử lý)</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-blue-100 text-blue-700 border border-blue-200">
            {getCount('processed')}
          </span>
        </button>

        <button
          onClick={() => openHandedOverCarrierTab()}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'handed_over_carrier' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Đã giao cho ĐVVC</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-violet-100 text-violet-700 border border-violet-200">
            {getCount('handed_over_carrier')}
          </span>
        </button>

        <button
          onClick={() => selectOrdersSubTab('shipping')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'shipping' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Đang giao</span>
          <span className="px-1.5 py-0.2 text-[10px] font-semibold rounded-full bg-indigo-100 text-indigo-700 border border-indigo-200/50">
            {getCount('shipping')}
          </span>
        </button>

        <button
          onClick={() => selectOrdersSubTab('cancel_returns', 'all')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'cancel_returns' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>ĐƠN HỦY, ĐƠN HOÀN</span>
          <span className="px-1.5 py-0.2 text-[10px] font-semibold rounded-full bg-orange-100 text-orange-700 border border-orange-200">
            {getCount('cancel_returns')}
          </span>
        </button>

        <button
          onClick={() => selectOrdersSubTab('received_cancel_returns')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'received_cancel_returns'
              ? 'border-teal-600 text-teal-700 font-extrabold bg-teal-50/40'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Đã nhận đơn hủy, đơn hoàn</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-teal-100 text-teal-800 border border-teal-200">
            {getCount('received_cancel_returns')}
          </span>
        </button>

        <button
          onClick={() => selectOrdersSubTab('order_products')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'order_products'
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Những sản phẩm có trong đơn</span>
          <span className="px-1.5 py-0.2 text-[10px] font-semibold rounded-full bg-violet-100 text-violet-700 border border-violet-200">
            {getCount('order_products')}
          </span>
        </button>

        <button
          onClick={() => {
            selectOrdersSubTab('web_orders');
            setSelectedPlatform('woocommerce');
            setSelectedShopId('all');
          }}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'web_orders'
              ? 'border-indigo-600 text-indigo-700 font-extrabold bg-indigo-50/40'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span className="w-4 h-4 bg-indigo-600 text-white font-extrabold text-[9px] rounded flex items-center justify-center shrink-0">W</span>
          <span>Đơn trên web</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-indigo-100 text-indigo-800 border border-indigo-200">
            {getCount('web_orders')}
          </span>
        </button>

        <button
          onClick={() => {
            selectOrdersSubTab('external_orders');
            setSelectedPlatform('manual');
            setSelectedShopId('all');
          }}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'external_orders'
              ? 'border-emerald-600 text-emerald-700 font-extrabold bg-emerald-50/40'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span className="w-4 h-4 bg-emerald-600 text-white font-extrabold text-[9px] rounded flex items-center justify-center shrink-0">N</span>
          <span>Đơn ngoại sàn</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200">
            {getCount('external_orders')}
          </span>
        </button>

      </div>

      {activeSubTab === 'cancel_returns' && (
        <div className="bg-white border border-gray-100 rounded-2xl shadow-xs overflow-x-auto">
          <div className="flex min-w-max border-b border-gray-100 px-2">
            {cancelReturnTabItems.map((tab) => {
              const active = cancelReturnTab === tab.id;
              const count = getCancelReturnCount(tab.id);
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setCancelReturnTab(tab.id);
                    setCurrentPage((p) => (p === 1 ? p : 1));
                  }}
                  className={`px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-colors ${
                    active
                      ? 'border-orange-500 text-orange-600'
                      : 'border-transparent text-gray-600 hover:text-orange-500'
                  }`}
                >
                  {tab.label} ({count})
                </button>
              );
            })}
          </div>
        </div>
      )}

      {scanBgPendingCount > 0 && (
        <div className="bg-sky-50 border border-sky-200 rounded-2xl px-4 py-3 text-xs text-sky-900 font-semibold leading-relaxed flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin shrink-0 text-sky-600" />
          <span>
            Đang dò ngầm Backend <strong>{scanBgPendingCount}</strong> mã — tiếp tục chạy kể cả khi tắt màn quét.
            Xong sẽ tự ghi cờ hủy/hoàn và cập nhật tab.
          </span>
        </div>
      )}

      {activeSubTab === 'received_cancel_returns' && (
        <div className="bg-teal-50/80 border border-teal-100 rounded-2xl px-4 py-3 text-xs text-teal-900 font-semibold leading-relaxed">
          Đối soát kiện hủy/hoàn đã quét nhận về kho (cờ nội bộ{' '}
          <code className="font-mono text-[11px]">RETURN_RECEIVED</code> /{' '}
          <code className="font-mono text-[11px]">CANCELLED_STORED</code>). Dữ liệu được lưu trữ vĩnh viễn, xóa thủ công khi cần.
        </div>
      )}

      {activeSubTab === 'web_orders' && (
        <div className="bg-indigo-50/80 border border-indigo-100 rounded-2xl px-4 py-3 text-xs text-indigo-950 font-semibold leading-relaxed flex flex-wrap items-center justify-between gap-3">
          <span>
            Đơn hàng từ website WooCommerce — hiển thị thông tin khách hàng (tên, SĐT, địa chỉ) và nút xử lý trạng thái.
          </span>
          <button
            type="button"
            onClick={() => void triggerWooSync(14)}
            disabled={isSyncing || ordersLoading}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold cursor-pointer disabled:opacity-60 inline-flex items-center gap-1.5"
          >
            {isSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Đồng bộ WooCommerce
          </button>
        </div>
      )}

      {activeSubTab === 'external_orders' && (
        <div className="bg-emerald-50/80 border border-emerald-100 rounded-2xl px-4 py-3 text-xs text-emerald-950 font-semibold leading-relaxed">
          Đơn GHN / SPX Express tạo ngoài sàn — in vận đơn bằng file PDF gốc của hãng (không vẽ mã vạch HTML).
        </div>
      )}

      {/* 4. FILTER BOX — search + ĐVVC (ẩn trên màn sản phẩm trong đơn) */}
      {activeSubTab !== 'order_products' && (
      <div className="om-orders-filters-panel bg-white p-5 max-md:p-4 rounded-3xl border border-gray-100 shadow-xs">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative w-full flex-1">
            <Search className="absolute left-3.5 top-3.5 text-gray-400 w-4 h-4" />
            <input 
              type="text" 
              placeholder="Tìm kiếm theo mã đơn hàng, tên khách hàng, sản phẩm hoặc mã bưu cục..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-xs outline-none transition-all font-medium"
            />
          </div>
          <OrderDateFilter
            preset={datePreset}
            customStart={customStartDate}
            customEnd={customEndDate}
            onPresetChange={(next) => {
              setDatePreset(next);
              if (next === 'custom') {
                const fallback = defaultCustomDateInputs();
                setCustomStartDate((prev) => prev || fallback.start);
                setCustomEndDate((prev) => prev || fallback.end);
              }
            }}
            onCustomStartChange={setCustomStartDate}
            onCustomEndChange={setCustomEndDate}
          />
        </div>
        {activeSubTab === 'unprocessed' && (
          <label className="mt-3 flex items-center gap-2.5 cursor-pointer select-none w-fit max-w-full">
            <input
              type="checkbox"
              checked={smartPickSort}
              onChange={(e) => setSmartPickSort(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-sky-600 focus:ring-sky-500 cursor-pointer shrink-0"
            />
            <span className="text-xs font-semibold text-slate-700 leading-snug">
              Ưu tiên đơn 1 sản phẩm (Gom nhóm nhặt hàng)
            </span>
          </label>
        )}
        {(activeSubTab === 'pending_confirm' ||
          activeSubTab === 'pending_verification' ||
          activeSubTab === 'unprocessed' ||
          activeSubTab === 'processed' ||
          activeSubTab === 'cancel_returns' ||
          activeSubTab === 'received_cancel_returns' ||
          activeSubTab === 'handed_over_carrier') && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-xs font-bold text-slate-600 shrink-0">Đơn vị vận chuyển</span>
            {(
              [
                { key: 'all' as const, label: 'Tất cả', highlight: false },
                { key: 'spx' as const, label: 'SPX Express', highlight: false },
                { key: 'ghn' as const, label: 'Giao Hàng Nhanh', highlight: false },
                { key: 'instant' as const, label: 'Đơn Hỏa Tốc', highlight: true },
                { key: 'other' as const, label: 'ĐVVC Khác', highlight: false },
              ] as const
            ).map((opt) => {
              const count = shippingCarrierCounts[opt.key];
              const active = selectedShippingCarrier === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    setSelectedShippingCarrier(opt.key);
                    setSelectedOrderIds([]);
                  }}
                  className={`text-[11px] px-3.5 py-1.5 rounded-full transition-all cursor-pointer whitespace-nowrap ${
                    opt.highlight
                      ? active
                        ? 'border-2 border-orange-500 text-orange-600 bg-orange-100 font-black shadow-sm'
                        : 'border-2 border-orange-400 text-orange-500 bg-orange-50 font-black hover:bg-orange-100'
                      : active
                        ? 'border border-[#ee4d2d] text-[#ee4d2d] bg-orange-50/40 font-bold'
                        : 'border border-gray-200 text-slate-700 bg-white font-bold hover:border-gray-300'
                  }`}
                >
                  {opt.label} ({count})
                </button>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* 5. BULK ACTION BAR — ẩn hoàn toàn ở tab Đơn Hủy, Đơn Hoàn */}
      {activeSubTab !== 'order_products' &&
        activeSubTab !== 'web_orders' &&
        activeSubTab !== 'external_orders' &&
        activeSubTab !== 'cancel_returns' && (
      <div className="om-orders-mobile-hide-bulk-bar bg-slate-50 border border-slate-200/80 p-3 max-md:p-2.5 rounded-2xl flex items-center justify-between gap-4 max-md:gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <button 
            type="button"
            onClick={handleToggleSelectAll}
            className="text-gray-500 hover:text-gray-800 transition-all cursor-pointer"
          >
            {selectedOrderIds.length === displayOrders.length && displayOrders.length > 0 ? (
              <CheckSquare className="w-5 h-5 text-blue-600" />
            ) : (
              <Square className="w-5 h-5 text-gray-400" />
            )}
          </button>
          <span className="text-xs font-extrabold text-slate-700">
            Đã chọn <strong className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md font-black">{selectedOrderIds.length}</strong> đơn hàng trên trang này
          </span>
          <button
            type="button"
            onClick={() => applyPrintStatusFilter(printStatusFilter === 'unprinted' ? 'all' : 'unprinted')}
            className={`text-[11px] font-black px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer ${
              printStatusFilter === 'unprinted'
                ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            {printStatusFilter === 'unprinted' ? 'Đang lọc: Chưa in (Bấm để Hủy)' : 'Lọc đơn Chưa in'}
          </button>
          <button
            type="button"
            onClick={() => applyPrintStatusFilter(printStatusFilter === 'printed' ? 'all' : 'printed')}
            className={`text-[11px] font-black px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer ${
              printStatusFilter === 'printed'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            {printStatusFilter === 'printed' ? 'Đang lọc: Đã in (Bấm để Hủy)' : 'Lọc đơn Đã in'}
          </button>
          <button
            type="button"
            onClick={() => {
              const targets =
                selectedOrderIds.length > 0
                  ? displayOrders.filter((o) => selectedOrderIds.includes(o.id))
                  : [];
              if (targets.length === 0) {
                showToast('Chọn đơn cần đánh dấu đã in trước.');
                return;
              }
              void markPrintedStatusForOrders(targets);
            }}
            disabled={resettingPrintIds.length > 0}
            className="text-[11px] font-black px-2.5 py-1.5 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition-all cursor-pointer disabled:opacity-50"
            title="Đánh dấu isPrinted=true trên DB nội bộ"
          >
            {resettingPrintIds.length > 0 ? 'Đang cập nhật...' : 'Đánh dấu đã in'}
          </button>
          <button
            type="button"
            onClick={() => {
              const targets =
                selectedOrderIds.length > 0
                  ? displayOrders.filter((o) => selectedOrderIds.includes(o.id))
                  : [];
              if (targets.length === 0) {
                showToast('Chọn đơn cần đánh dấu chưa in trước.');
                return;
              }
              void resetPrintStatusForOrders(targets);
            }}
            disabled={resettingPrintIds.length > 0}
            className="text-[11px] font-black px-2.5 py-1.5 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 transition-all cursor-pointer disabled:opacity-50"
            title="Reset isPrinted=false trên DB để in lại từ đầu"
          >
            {resettingPrintIds.length > 0 ? 'Đang cập nhật...' : 'Đánh dấu chưa in'}
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            onClick={() => handleBulkConfirm()}
            className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-black rounded-lg shadow-xs transition-all flex items-center gap-1.5 cursor-pointer"
            title="Xác nhận đơn hàng loạt"
          >
            <Check className="w-3.5 h-3.5 shrink-0" />
            <span>Xác nhận đơn hàng loạt</span>
          </button>

          <button
            type="button"
            onClick={() => void handleReprintSelected()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-black rounded-lg shadow-xs transition-all flex items-center gap-1.5 cursor-pointer"
            title="In đơn đã chọn"
          >
            <Printer className="w-3.5 h-3.5 shrink-0" />
            <span>In đơn đã chọn</span>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleBulkHandOverCarrier(e);
            }}
            disabled={isBulkHandingOver}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-black rounded-lg shadow-xs transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title="Giao cho ĐVVC hàng loạt"
          >
            <Truck className={`w-3.5 h-3.5 shrink-0 ${isBulkHandingOver ? 'animate-pulse' : ''}`} />
            <span>{isBulkHandingOver ? 'Đang giao ĐVVC...' : 'Giao ĐVVC'}</span>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleBulkDeleteOrders();
            }}
            className="px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-xs font-black rounded-lg shadow-xs transition-all flex items-center gap-1.5 cursor-pointer"
            title="Xóa dữ liệu đã chọn"
          >
            <Trash2 className="w-3.5 h-3.5 shrink-0" />
            <span>Xóa dữ liệu</span>
          </button>
        </div>
      </div>
      )}

      {/* 6. MAIN LIST / AGGREGATED PRODUCTS */}
      {activeSubTab === 'order_products' ? (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 bg-violet-50/40">
            <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
              <Layers className="w-4 h-4 text-violet-600" />
              Những sản phẩm có trong đơn
            </h3>
            <p className="text-[11px] text-gray-500 mt-1">
              Tổng hợp từ <strong>Chờ xác nhận</strong>, <strong>Đơn chưa xử lý</strong> và <strong>Chờ lấy hàng (Đã xử lý)</strong>
            </p>
          </div>

          {fulfillmentProductsLoading ? (
            <div className="py-20 text-center text-gray-400 text-sm flex flex-col items-center gap-3 px-4">
              <RefreshCw className="w-10 h-10 text-slate-300 animate-spin" />
              <span className="font-semibold text-slate-600">Đang tổng hợp sản phẩm từ 3 tab kho...</span>
            </div>
          ) : aggregatedOrderProducts.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm flex flex-col items-center gap-3 px-4">
              <Package className="w-12 h-12 text-slate-200" />
              <span className="font-semibold text-slate-600">Không có sản phẩm nào cần chuẩn bị</span>
            </div>
          ) : (
            <>
              {!useOrderCardList && (
              <div className="overflow-x-auto om-orders-table-view">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-gray-100 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                      <th className="p-4 w-16">Ảnh</th>
                      <th className="p-4">Tên sản phẩm</th>
                      <th className="p-4 text-right w-40">Số lượng cần chuẩn bị</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {aggregatedOrderProducts.map((item) => (
                      <tr key={item.groupKey} className="hover:bg-slate-50/50 transition-colors">
                        <td className="p-4">
                          {item.productImage ? (
                            <img
                              src={item.productImage}
                              alt=""
                              className="w-11 h-11 rounded-lg object-cover border border-gray-100"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-11 h-11 rounded-lg bg-gray-100 border border-gray-200 flex items-center justify-center">
                              <ImageOff className="w-4 h-4 text-gray-400" />
                            </div>
                          )}
                        </td>
                        <td className="p-4">
                          <p className="font-semibold text-gray-900 line-clamp-2">{item.baseTitle}</p>
                          <VariationNameBadge variationName={item.variationName} />
                          <p className="text-[11px] font-mono text-gray-500 mt-0.5">SKU: {item.variationSku}</p>
                        </td>
                        <td className="p-4 text-right">
                          <span className="text-lg font-extrabold text-violet-700">
                            Số lượng: {item.totalQuantity}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              )}

              {useOrderCardList && (
              <div className="om-order-card-list om-order-card-list-mounted app-wide-card-grid divide-y divide-gray-100 max-md:divide-y">
                {aggregatedOrderProducts.map((item) => (
                  <div key={item.groupKey} className="flex items-center gap-3 p-4 max-md:border-0">
                    {item.productImage ? (
                      <img
                        src={item.productImage}
                        alt=""
                        className="w-12 h-12 rounded-xl object-cover border border-gray-100 shrink-0"
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-xl bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                        <ImageOff className="w-4 h-4 text-gray-400" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 line-clamp-2">{item.baseTitle}</p>
                      <VariationNameBadge variationName={item.variationName} />
                      <p className="text-[11px] font-mono text-gray-500 truncate mt-0.5">SKU: {item.variationSku}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <span className="text-xs text-gray-400 block">Số lượng</span>
                      <span className="text-base font-extrabold text-violet-700">{item.totalQuantity}</span>
                    </div>
                  </div>
                ))}
              </div>
              )}
            </>
          )}
        </div>
      ) : (
      <div className="bg-white rounded-3xl border border-gray-100 shadow-xs overflow-hidden">
        {ordersLoading ? (
          <div className="py-20 text-center text-gray-400 text-xs flex flex-col items-center gap-3">
            <RefreshCw className="w-10 h-10 text-slate-300 animate-spin" />
            <span className="font-semibold text-slate-600">Đang tải danh sách đơn hàng...</span>
          </div>
        ) : displayOrders.length === 0 ? (
          <div className="py-20 text-center text-gray-400 text-xs flex flex-col items-center gap-3">
            <ShoppingBag className="w-12 h-12 text-slate-200" />
            <span className="font-semibold text-slate-600">Không tìm thấy đơn hàng nào khớp với điều kiện lọc</span>
            <p className="text-[11px] text-gray-400 max-w-sm leading-relaxed">
              {activeSubTab === 'external_orders'
                ? 'Chưa có đơn ngoại sàn. Bấm “Tạo đơn hàng ngoài sàn” để lên đơn GHN/SPX.'
                : 'Hãy thay đổi bộ lọc sàn TMĐT hoặc chuyển sang các tab khác như "Đơn chưa xử lý" để xem thêm.'}
            </p>
          </div>
        ) : activeSubTab === 'external_orders' ? (
          <div className="p-2 max-md:p-0">
            <ExternalOrdersTable
              orders={displayOrders}
              printingOrderId={printingOrderId}
              onPrintWaybill={(order) => void handlePrintExternalWaybill(order)}
              onOrderUpdated={(updated) => {
                const sn = String(updated.orderSn || '').trim();
                const id = String(updated.id || '').trim();
                onUpdateOrders(
                  orders.map((o) =>
                    (sn && o.orderSn === sn) || (id && o.id === id) ? { ...o, ...updated } : o,
                  ),
                  { persist: false },
                );
              }}
            />
          </div>
        ) : (
          <>
            {!useOrderCardList && (
            <div className="overflow-x-auto om-orders-table-view">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-gray-100 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  <th className="p-4 w-12 text-center">
                    <input
                      type="checkbox"
                      checked={selectedOrderIds.length === displayOrders.length}
                      onChange={handleToggleSelectAll}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                    />
                  </th>
                  {activeSubTab === 'web_orders' ? (
                    <>
                      <th className="p-4 w-40">Mã đơn hàng</th>
                      <th className="p-4 w-32">Ngày tạo</th>
                      <th className="p-4 w-[280px]">Sản phẩm</th>
                      <th className="p-4 text-right w-36">Tổng tiền</th>
                      <th className="p-4 text-center w-32">Trạng thái</th>
                      <th className="p-4 text-center w-56">Khách hàng &amp; Thao tác</th>
                    </>
                  ) : (
                    <>
                      <th className="p-4 w-44">Mã vận đơn &amp; Sàn</th>
                      <th className="p-4 w-32">Ngày tạo đơn</th>
                      <th className="p-4 w-[280px]">Sản phẩm đặt mua</th>
                      <th className="p-4 text-right w-40">Tổng thanh toán</th>
                      <th className="p-4 text-center w-32">Trạng thái sàn</th>
                      <th className="p-4 text-center w-52">Xử lý đơn hàng</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {displayOrders.map((order) => (
                  <OrderTableRow
                    key={order.id}
                    order={order}
                    isChecked={selectedOrderIdSet.has(order.id)}
                    isExpanded={expandedOrderId === order.id}
                    activeSubTab={activeSubTab}
                    shops={shops}
                    products={products}
                    systemFees={systemFees}
                    printingOrderId={printingOrderId}
                    handingOverOrderId={handingOverOrderId}
                    wooActionLoadingId={wooActionLoadingId}
                    confirmingReturn={
                      confirmingReturnId === String(order.id || '') ||
                      confirmingReturnId === String(order.orderSn || '')
                    }
                    resettingPrint={resettingPrintSet.has(String(order.orderSn || '').replace(/^shopee-/i, '').trim())}
                    actions={orderRowActions}
                    renderDetails={renderOrderDetails}
                  />
                ))}
              </tbody>
            </table>
            </div>
            )}
            {useOrderCardList && (
            <div className="om-order-card-list om-order-card-list-mounted flex flex-col divide-y divide-gray-100 w-full">
              {displayOrders.map((order) => (
                <OrderCardRow
                  key={order.id}
                  order={order}
                  isChecked={selectedOrderIdSet.has(order.id)}
                  isExpanded={expandedOrderId === order.id}
                  activeSubTab={activeSubTab}
                  shops={shops}
                  products={products}
                  systemFees={systemFees}
                  printingOrderId={printingOrderId}
                  handingOverOrderId={handingOverOrderId}
                  wooActionLoadingId={wooActionLoadingId}
                  confirmingReturn={
                    confirmingReturnId === String(order.id || '') ||
                    confirmingReturnId === String(order.orderSn || '')
                  }
                  resettingPrint={resettingPrintSet.has(String(order.orderSn || '').replace(/^shopee-/i, '').trim())}
                  actions={orderRowActions}
                  renderDetails={renderOrderDetails}
                />
              ))}
            </div>
            )}
          </>
        )}

        {(listPagingTotal > 0 || displayOrders.length > 0) && (
          <div className="px-4 py-3 bg-slate-50/80 border-t border-gray-100 flex flex-wrap items-center justify-end gap-3 text-xs text-gray-600">
            <span>
              Trang <b>{ordersMeta?.page ?? currentPage}</b>/{listPagingPages}
              {' — '}
              {displayOrders.length}/{listPagingTotal} đơn (mỗi trang {ORDERS_PAGE_SIZE})
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={ordersLoading || currentPage <= 1}
                onClick={() => goToOrdersPage(currentPage - 1)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40 font-semibold cursor-pointer"
              >
                Trang trước
              </button>
              <button
                type="button"
                disabled={
                  ordersLoading || currentPage >= listPagingPages
                }
                onClick={() => goToOrdersPage(currentPage + 1)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 bg-white disabled:opacity-40 font-semibold cursor-pointer"
              >
                Trang sau
              </button>
            </div>
          </div>
        )}
    </div>
      )}

      {/* Sync/tab loading: KHÔNG dùng blocking modal — chỉ toast (xem toastMessage).
          Overlay dưới đây chỉ cho ship_order / in vận đơn (progressMessage). */}
      {progressMessage && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-sm flex items-center justify-center p-4 z-100 animate-in fade-in duration-300">
          <div className="bg-white rounded-3xl max-w-md w-full p-8 shadow-2xl flex flex-col items-center gap-5 text-center relative overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-white to-blue-50 opacity-50 animate-pulse"></div>

            <div className="relative z-10 flex flex-col items-center gap-5 w-full">
              {shipConfirmSummary ? (
                <>
                  <div className="relative">
                    <CheckCircle2 className="w-16 h-16 text-emerald-600 animate-in zoom-in duration-500" />
                  </div>
                  <h3 className="text-lg font-black text-gray-900">
                    {shipConfirmSummary.successCount > 0 ? 'Xác nhận thành công' : 'Kết quả xác nhận'}
                  </h3>
                  <div className="w-full space-y-3 text-left">
                    <div className="rounded-2xl bg-emerald-50 border border-emerald-100 px-4 py-3">
                      <p className="text-base font-bold text-emerald-700">
                        Thành công: {shipConfirmSummary.successCount} đơn
                      </p>
                    </div>
                    <div className="rounded-2xl bg-rose-50 border border-rose-100 px-4 py-3">
                      <p className="text-base font-bold text-rose-700">
                        Thất bại: {shipConfirmSummary.failCount} đơn
                      </p>
                      {shipConfirmSummary.failedOrderDetails.length > 0 && (
                        <ul className="mt-2 space-y-1 max-h-28 overflow-y-auto">
                          {shipConfirmSummary.failedOrderDetails.slice(0, 8).map((f, idx) => (
                            <li key={`${f.orderSn || f.orderId || idx}-${idx}`} className="text-[11px] text-rose-600 font-medium leading-snug">
                              {f.orderSn || f.orderId || '—'}
                              {f.message ? `: ${f.message}` : f.error ? `: ${f.error}` : ''}
                            </li>
                          ))}
                          {shipConfirmSummary.failedOrderDetails.length > 8 && (
                            <li className="text-[11px] text-rose-500">
                              …và {shipConfirmSummary.failedOrderDetails.length - 8} đơn khác
                            </li>
                          )}
                        </ul>
                      )}
                    </div>
                  </div>
                  {shipJobResults.length > 0 && (
                    <ul className="w-full max-h-36 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50 text-left divide-y divide-slate-100">
                      {shipJobResults.map((result, index) => (
                        <li key={`${result.orderSn || result.orderId || index}-${index}`} className="px-3 py-2 text-xs">
                          <span className={result.success ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>
                            {result.orderSn || result.orderId || '—'}: {result.success ? 'Thành công' : 'Thất bại'}
                          </span>
                          {!result.success && (result.message || result.error) && (
                            <span className="text-rose-600"> — {result.message || result.error}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex w-full gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        const sns = shipConfirmSummary.successfulOrderIds || [];
                        if (sns.length > 0) {
                          revealProcessedUnprintedTab(sns);
                        }
                        clearShipProgressOverlay();
                      }}
                      className="flex-1 py-3 rounded-2xl border border-gray-200 bg-white text-gray-700 text-sm font-bold hover:bg-gray-50 transition-colors"
                    >
                      Đóng
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePrintFromShipSummary()}
                      disabled={
                        isPrintingFromSummary ||
                        isFetchingPdf ||
                        !shipConfirmSummary.successfulOrderIds.length
                      }
                      className="flex-1 py-3 rounded-2xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2"
                    >
                      {isPrintingFromSummary ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Printer className="w-4 h-4" />
                      )}
                      In đơn
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="relative">
                    {progressDone ? (
                      <div className="relative">
                        <CheckCircle2 className="w-16 h-16 text-emerald-600 animate-in zoom-in duration-500" />
                        <div className="absolute inset-0 rounded-full border-4 border-emerald-200 animate-ping"></div>
                      </div>
                    ) : (
                      <div className="relative">
                        <div className="absolute inset-0 rounded-full border-4 border-blue-200 animate-pulse"></div>
                        <Loader2 className="w-16 h-16 text-blue-600 animate-spin relative z-10" />
                      </div>
                    )}
                  </div>

                  {progressTotal > 0 && (
                    <div className="flex flex-col items-center gap-2 w-full">
                      <div className={`text-4xl font-black tabular-nums ${progressDone ? 'text-emerald-700' : 'text-blue-700'} transition-all duration-300`}>
                        {progressCompleted}<span className="text-2xl text-gray-400 mx-1">/</span>{progressTotal}
                      </div>
                      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all duration-500 ease-out ${progressDone ? 'bg-emerald-600' : 'bg-gradient-to-r from-blue-500 to-blue-600'}`}
                          style={{ width: `${Math.min(100, (progressCompleted / Math.max(1, progressTotal)) * 100)}%` }}
                        >
                          {!progressDone && (
                            <div className="h-full w-full bg-gradient-to-r from-transparent via-white to-transparent opacity-30 animate-[shimmer_1.5s_infinite]"></div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col gap-2 w-full">
                    <p className="text-base font-bold text-gray-800 leading-relaxed">
                      {progressMessage}
                    </p>

                    {!progressDone && progressMessage.includes('chờ') && (
                      <div className="flex items-center justify-center gap-2 mt-2">
                        <div className="flex gap-1">
                          {[0, 1, 2].map((i) => (
                            <div
                              key={i}
                              className="w-2 h-2 rounded-full bg-blue-500 animate-bounce"
                              style={{ animationDelay: `${i * 0.15}s` }}
                            ></div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {shipJobResults.length > 0 && (
                    <ul className="w-full max-h-32 overflow-y-auto rounded-xl border border-slate-100 bg-slate-50 text-left divide-y divide-slate-100">
                      {shipJobResults.map((result, index) => (
                        <li key={`${result.orderSn || result.orderId || index}-${index}`} className="px-3 py-2 text-xs">
                          <span className={result.success ? 'font-bold text-emerald-700' : 'font-bold text-rose-700'}>
                            {result.orderSn || result.orderId || '—'}: {result.success ? 'Thành công' : 'Thất bại'}
                          </span>
                          {!result.success && (result.message || result.error) && (
                            <span className="text-rose-600"> — {result.message || result.error}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className={`flex items-center gap-2 text-xs ${progressDone ? 'text-emerald-600' : 'text-gray-500'} font-semibold px-4 py-2 rounded-full ${progressDone ? 'bg-emerald-50' : 'bg-gray-50'} transition-all duration-300`}>
                    {progressDone ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Hoàn tất</span>
                      </>
                    ) : progressMessage.includes('PDF') || progressMessage.includes('vận đơn') ? (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <span>PDF sẽ tự mở khi sẵn sàng — vui lòng không đóng tab</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>Vui lòng không bấm liên tục — hệ thống đang xử lý</span>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => clearShipProgressOverlay()}
                    className="w-full mt-1 py-2.5 rounded-2xl border border-gray-200 bg-white text-gray-700 text-sm font-bold hover:bg-gray-50 transition-colors"
                  >
                    Đóng
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 7b. MODAL: "Xác nhận đơn hàng" — choose pickup vs dropoff before calling ship_order */}
      {shipConfirmOrders && shipConfirmOrders.length > 0 && (
        <div className="fixed inset-0 bg-gray-900/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-md w-full overflow-hidden shadow-2xl">
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Truck className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="text-sm font-bold">Xác nhận &amp; In</h3>
                  <p className="text-[10px] text-slate-400">
                    Hệ thống tự xác nhận, tải PDF vào cache, mở vận đơn và đánh dấu Đã in. {shipConfirmOrders.length} đơn {shipConfirmOrders.length === 1 ? `#${shipConfirmOrders[0].orderSn}` : 'đã chọn'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShipConfirmOrders(null)}
                disabled={isShipping}
                className="text-slate-400 hover:text-white disabled:opacity-40"
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-3" data-ship-options-order="dropoff-first">
              {(
                [
                  {
                    id: 'dropoff' as const,
                    title: 'Tự mang hàng ra bưu cục (Dropoff)',
                    desc: 'Bạn tự mang hàng ra bưu cục/điểm gửi gần nhất của đơn vị vận chuyển để gửi hàng.',
                  },
                  {
                    id: 'pickup' as const,
                    title: 'Lấy hàng (Pickup)',
                    desc: 'Đơn vị vận chuyển sẽ đến lấy hàng tại địa chỉ shop. Hệ thống tự động lấy lịch hẹn lấy hàng khả dụng gần nhất từ Shopee.',
                  },
                ] as const
              ).map((opt) => {
                const selected = shipMethod === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    data-ship-option={opt.id}
                    onClick={() => setShipMethod(opt.id)}
                    disabled={isShipping}
                    className={`w-full text-left p-4 rounded-2xl border-2 transition-all flex items-start gap-3 ${selected ? 'border-blue-600 bg-blue-50' : 'border-gray-100 hover:border-gray-200'}`}
                  >
                    <div className={`w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 ${selected ? 'border-blue-600' : 'border-gray-300'}`}>
                      {selected && <div className="w-2.5 h-2.5 rounded-full bg-blue-600" />}
                    </div>
                    <div>
                      <p className="text-xs font-black text-gray-800">{opt.title}</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">{opt.desc}</p>
                    </div>
                  </button>
                );
              })}

              {shipConfirmOrders.length > 1 && (
                <p className="text-[10px] text-amber-600 bg-amber-50 border border-amber-100 rounded-xl px-3 py-2">
                  Nếu đơn vị vận chuyển của một số đơn không hỗ trợ phương thức đã chọn, hệ thống sẽ báo lỗi riêng cho từng đơn đó mà không ảnh hưởng các đơn còn lại.
                </p>
              )}
            </div>

            <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-2">
              <button
                onClick={() => setShipConfirmOrders(null)}
                disabled={isShipping}
                className="px-4 py-2 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-bold text-xs rounded-xl disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                onClick={() => void handleBatchConfirmOnly()}
                disabled={isShipping}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center gap-1.5 disabled:opacity-60"
              >
                {isShipping && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isShipping ? 'Đang xác nhận...' : 'Xác nhận đơn'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 8. MODAL 2: BULK PRINT SLIPS & PACKING LABELS (Close fit to mockup requirements) */}
      {bulkPrintOrders && bulkPrintOrders.length > 0 && (
        <div className="fixed inset-0 bg-gray-900/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in om-no-print">
          <div className="bg-white rounded-3xl max-w-3xl w-full overflow-hidden shadow-2xl flex flex-col print:overflow-visible print:max-h-none print:shadow-none print:rounded-none">
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between om-no-print">
              <div className="flex items-center gap-2">
                <Printer className="w-5 h-5 text-blue-400 animate-pulse" />
                <div>
                  <h3 className="text-sm font-bold">Xác nhận In hàng loạt {bulkPrintOrders.length} Phiếu đóng gói &amp; Vận đơn</h3>
                  <p className="text-[10px] text-slate-400">Chuẩn bị sẵn sàng in nhiệt khổ 100x150mm để dán lên bao gói hàng sỉ</p>
                </div>
              </div>
              <button 
                onClick={() => setBulkPrintOrders(null)}
                className="text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Scrollable Printable list */}
            <div id="bulk-print-area" className="p-6 bg-slate-100/50 overflow-y-auto max-h-[480px] space-y-6 print:p-0 print:bg-white print:max-h-none print:overflow-visible">
              {bulkPrintOrders.map((order, index) => (
                <div 
                  key={order.id} 
                  className="print-slip-page bg-white p-5 rounded-xl border-2 border-dashed border-slate-300 w-full max-w-lg mx-auto shadow-sm text-[11px] text-black font-sans space-y-3 relative"
                >
                  {/* Order counter indicator */}
                  <span className="absolute top-2 right-2 bg-blue-600 text-white text-[10px] font-black px-2 py-0.5 rounded-full">
                    Phiếu {index + 1} / {bulkPrintOrders.length}
                  </span>

                  <div className="flex items-center justify-between border-b-2 border-black pb-2">
                    <span className="text-xs font-black tracking-wider uppercase bg-black text-white px-2 py-0.5 rounded">
                      {order.channel === 'shopee' ? 'SHOPEE EXPRESS' : 'TIKTOK SHIP'}
                    </span>
                    <div className="text-right">
                      <p className="font-extrabold text-[10px]">Đơn hàng: {order.orderSn}</p>
                      <p className="text-[9px] text-gray-500">Mã gian hàng: {order.shopId || 'Demo'}</p>
                    </div>
                  </div>

                  {/* Barcode */}
                  <div className="text-center py-1 space-y-1 border-b border-gray-100">
                    <div className="h-10 bg-slate-150 flex items-center justify-center rounded font-mono font-bold text-xs tracking-widest text-slate-700 relative overflow-hidden border border-gray-200">
                      <div className="absolute inset-0 opacity-15 flex justify-between px-2">
                        {Array.from({ length: 30 }).map((_, i) => (
                          <div key={i} className="bg-black" style={{ width: `${Math.floor(1 + Math.random() * 3)}px`, height: '100%' }}></div>
                        ))}
                      </div>
                      {getCarrierWaybillDisplay(order) || 'CHƯA_XÁC_ĐỊNH_VẬN_ĐƠN'}
                    </div>
                    <span className="font-mono text-[9px] uppercase font-black">MÃ VẬN ĐƠN: {getCarrierWaybillDisplay(order) || 'CHƯA PHÁT HÀNH'}</span>
                  </div>

                  {/* Sender */}
                  <div className="border-b border-gray-100 pb-2">
                    <div className="space-y-1 text-gray-600">
                      <p className="font-bold text-black uppercase text-[9px]">Gửi từ:</p>
                      <p className="font-semibold text-black">{resolveOrderShopDisplayName(order, shops)}</p>
                    </div>
                  </div>

                  {/* Items list summary */}
                  <div className="space-y-1">
                    <p className="font-bold text-black uppercase text-[9px]">Danh sách sản phẩm ({order.items.length} phân loại):</p>
                    <div className="divide-y divide-gray-100">
                      {(order.items || []).map((it, itemIdx) => (
                        <div key={itemIdx} className="py-1 flex justify-between font-medium">
                          <span>{it.productTitle}</span>
                          <span className="font-extrabold text-blue-600">x{it.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* COD billing footer */}
                  <div className="p-2 bg-slate-50 border border-slate-200 rounded flex justify-between items-center">
                    <div>
                      <p className="text-[9px] font-bold text-gray-400">CẦN THU COD</p>
                      <p className="text-sm font-black text-rose-600">{order.totalAmount.toLocaleString('vi-VN')}đ</p>
                    </div>
                    <span className="text-[9px] border border-black px-1.5 py-0.5 font-bold">KHÔNG CHO XEM HÀNG</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Print trigger and dialog dismiss */}
            <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-between items-center om-no-print">
              <span className="text-xs text-slate-500 font-bold">
                * Đơn ngoài Shopee (không có vận đơn điện tử) — in phiếu đóng gói tạm thời bằng máy in mặc định của Windows.
              </span>
              <div className="flex gap-2">
                <button 
                  onClick={() => setBulkPrintOrders(null)}
                  className="px-4 py-2 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-bold text-xs rounded-xl"
                >
                  Đóng lại
                </button>
                <button 
                  onClick={handlePackingSlipPrint}
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center gap-1.5"
                >
                  <Printer className="w-4 h-4" />
                  <span>In {bulkPrintOrders.length} Đơn hàng</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}


    </div>
  );
}
