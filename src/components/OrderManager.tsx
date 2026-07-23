import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  lookupOrderByScanCode,
  scanFeedback,
  playScanSound,
  vibrateScan,
  isLikelyTrackingCode,
  buildOrderScanIndex,
  normalizeOrderScanKey,
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
  buildHandedOverWritePatch,
  isEligibleForHandOverToCarrier,
  getHandOverIneligibleReason,
  HANDED_OVER_SOURCE,
  UI_TAB_HANDED_OVER_CARRIER,
} from '../utils/orderHandover';
import {
  isOrderAlreadyScanProcessed,
  getScanProcessedReason,
  matchesReceivedCancelReturnTab,
} from '../utils/orderLocalStatus';
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
  RefreshCw,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square,
  Package,
  Calendar,
  Layers,
  Sparkle,
  Plus,
  ImageIcon,
  Loader2,
  X,
  ImageOff,
} from 'lucide-react';
import { Order, ConnectedShop, SyncLog, Product, SystemFee } from '../types';
import ManualOrderPage from './ManualOrderPage';
import { resolveLabelFetchUrl, parseJsonResponse, readResponseJson } from '../utils/apiClient';
import { aggregateOrderProducts } from '../utils/aggregateOrderProducts';
import { getCarrierWaybillDisplay } from '../utils/orderTracking';
import {
  getOrderCarrierText,
  getShippingCarrierGroup,
  orderMatchesShippingCarrierFilter,
  type ShippingCarrierFilter,
} from '../utils/shippingCarrier';
import { resolveOrderShopDisplayName } from '../utils/resolveOrderShopName';
import {
  computeShopeeSurchargeTotal,
  getShopeeItemAmount,
  getShopeeNetRevenue,
  getShopeeTaxTotal,
  getShopeeTransactionFee,
  isShopeeEscrowSynced,
} from '../utils/shopeeFees';

function getOrderWaybillCode(order: Order): string {
  // Ưu tiên mã đi (tracking_no) theo order_sn — return_tracking_no chỉ fallback.
  const fromHelper = getCarrierWaybillDisplay(order);
  if (fromHelper) return fromHelper;
  const fallback = String(
    order.trackingNumber || order.tracking_no || order.return_tracking_no || '',
  ).trim();
  if (fallback && !/^0FG/i.test(fallback) && fallback !== String(order.orderSn || '')) {
    return fallback;
  }
  return '';
}

/** UNPAID/PENDING → Chờ xác nhận (tab "Đang kiểm tra bởi Shopee" đã bỏ). */
function isPendingConfirmOrder(order: Order): boolean {
  if (order.status === 'pending_confirm') return true;
  if (order.status === 'pending_verification') return true;
  const raw = String(order.shopee_order_status || '').toUpperCase();
  return raw === 'UNPAID' || raw === 'PENDING' || raw === 'IN_REVIEW' || raw === 'FRAUD_CHECK';
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

function OrderDetailAccordionPanel({
  order,
  shops,
  systemFees,
}: {
  order: Order;
  shops: ConnectedShop[];
  systemFees: SystemFee[];
}) {
  return (
    <div className="px-4 pb-4 pt-3 border-t border-slate-100 bg-slate-50/80 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-extrabold text-slate-800">Chi tiết đơn #{order.orderSn}</h4>
        <p className="text-[10px] text-slate-500">
          {order.channel === 'manual' ? 'Đơn ngoài sàn' : order.channel.toUpperCase()}
          {' · '}
          {resolveOrderShopDisplayName(order, shops)}
        </p>
      </div>

      {getOrderWaybillCode(order) && (
        <div className="bg-white p-4 rounded-2xl border border-indigo-100">
          <div className="flex items-center gap-2 text-xs">
            <Barcode className="w-4 h-4 text-indigo-500 shrink-0" />
            <div>
              <span className="text-gray-400">Mã vận đơn:</span>{' '}
              <strong className="text-gray-900 font-mono text-sm">{getOrderWaybillCode(order)}</strong>
            </div>
          </div>
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
  | 'cancel_returns'
  | 'received_cancel_returns'
  | 'order_products';

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
  'cancel_returns',
  'received_cancel_returns',
  'order_products',
]);

const ORDER_TAB_ALIASES: Record<string, OrderTab> = {
  'da-giao-dvvc': 'handed_over_carrier',
  'handed_over_carrier': 'handed_over_carrier',
  'cho-xac-nhan': 'pending_confirm',
  'cho-lay-hang': 'unprocessed',
  'da-xu-ly': 'processed',
  'dang-giao': 'shipping',
  'don-huy-hoan': 'cancel_returns',
  'da-nhan-huy-hoan': 'received_cancel_returns',
};

function normalizeOrderTab(raw: string | null | undefined): OrderTab | null {
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (ORDER_TAB_ALIASES[key]) return ORDER_TAB_ALIASES[key];
  if (key === 'pending_verification') return 'pending_confirm';
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
  onUpdateOrders: (orders: Order[], opts?: { persist?: boolean }) => void;
  /** CHỈ gắn nút Đồng bộ — kéo Shopee. CẤM gọi khi refresh/scan/DB rỗng. */
  onPullShopeeOrders?: (opts?: { type?: 'incremental' | 'full' }) => Promise<void> | void;
  /** Chỉ đọc lại orders từ DB local — dùng sau xác nhận/in đơn để không ghi đè trạng thái */
  onFetchOrders?: (opts?: { silent?: boolean; bustCache?: boolean }) => Promise<void> | void;
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

const CANCEL_RETURN_STATUSES: Order['status'][] = ['cancelled', 'return_pending', 'return_received'];

function isCancelReturnOrder(order: Order): boolean {
  const local = String(order.local_status || order.localStatus || '').toUpperCase();
  const raw = String(order.shopee_order_status || '').toUpperCase();
  const logistics = String((order as any).logistics_status || '').toUpperCase();
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
    /DELIVERY_FAILED|FAILED_DELIVERY|LOGISTICS_DELIVERY_FAILED|UNDELIVERABLE|PICKUP_FAILED/.test(
      logistics,
    )
  );
}

/** Phân loại khớp Seller Center: Trả hàng/Hoàn tiền | Đơn hủy | Giao không thành công. */
function resolveCancelReturnKind(order: Order): CancelReturnTab | null {
  if (!isCancelReturnOrder(order)) return null;
  const kind = order.shopee_cancel_return_kind;
  if (kind === 'refund_return' || kind === 'cancelled' || kind === 'failed_delivery') {
    return kind;
  }

  const logistics = String((order as any).logistics_status || '').toUpperCase();
  const returnStatus = String(order.return_status || '').toUpperCase();
  // 1) Giao không thành công — ưu tiên logistics / return type
  if (
    /DELIVERY_FAILED|FAILED_DELIVERY|LOGISTICS_DELIVERY_FAILED|UNDELIVERABLE|PICKUP_FAILED|LOST/.test(
      logistics,
    ) ||
    /FAILED_DELIVERY|UNDELIVERABLE|NOT_RECEIVE/.test(returnStatus)
  ) {
    return 'failed_delivery';
  }
  const type = Number(order.return_refund_request_type);
  if (type === 2) return 'failed_delivery';

  // 2) Đơn Hủy — CANCELLED / IN_CANCEL
  const raw = String(order.shopee_order_status || '').toUpperCase();
  if (raw === 'CANCELLED' || raw === 'IN_CANCEL' || order.status === 'cancelled') {
    return 'cancelled';
  }
  const local = String(order.local_status || order.localStatus || '').toUpperCase();
  if (local === 'CANCELLED_STORED') return 'cancelled';

  // 3) Trả hàng / Hoàn tiền — TO_RETURN / return_sn / khiếu nại
  if (raw === 'TO_RETURN') return 'refund_return';
  if (order.return_sn || order.status === 'return_pending' || order.status === 'return_received') {
    return 'refund_return';
  }
  if (local === 'RETURN_RECEIVED') return 'refund_return';

  return 'cancelled';
}

function matchesCancelReturnTab(order: Order, tab: CancelReturnTab): boolean {
  const kind = resolveCancelReturnKind(order);
  if (!kind) return false;
  if (tab === 'all') return true;
  return kind === tab;
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
  onUpdateOrders, 
  onPullShopeeOrders,
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
  const [activeSubTab, setActiveSubTab] = useState<OrderTab>(() => {
    const restored =
      (initialOrdersSubTab
        ? normalizeOrderTab(initialOrdersSubTab)
        : null) ||
      readStoredOrdersTab() ||
      'unprocessed';
    return restored === 'pending_verification' ? 'pending_confirm' : restored;
  });
  const [cancelReturnTab, setCancelReturnTab] = useState<CancelReturnTab>(() => readStoredCancelTab());

  useEffect(() => {
    if (initialOrdersSubTab) {
      setActiveSubTab(initialOrdersSubTab === 'pending_verification' ? 'pending_confirm' : initialOrdersSubTab);
    }
  }, [initialOrdersSubTab]);

  // Tab "Đang kiểm tra bởi Shopee" đã xóa — chuyển sang Chờ xác nhận.
  useEffect(() => {
    if (activeSubTab === 'pending_verification') {
      setActiveSubTab('pending_confirm');
    }
  }, [activeSubTab]);

  // Đổi tab: chỉ đọc DB nội bộ (silent) — CẤM overlay + CẤM kích hoạt pull Shopee.
  useEffect(() => {
    if (activeSubTab === 'pending_verification') return;
    syncOrdersTabToUrl(activeSubTab, cancelReturnTab);
    onOrdersSubTabChange?.(activeSubTab);
    void onFetchOrders?.({ silent: true });
    // onFetchOrders / onOrdersSubTabChange không ổn định reference — chỉ phụ thuộc tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSubTab, cancelReturnTab]);
  
  // Camera Barcode Scanning States and Ref
  const [cameraScanResult, setCameraScanResult] = useState<string>('Đang chờ quét mã QR...');
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
  const [isBulkHandingOver, setIsBulkHandingOver] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isFlushingQueue, setIsFlushingQueue] = useState(false);
  const [isVerifyingScan, setIsVerifyingScan] = useState(false);

  const ordersRef = React.useRef(orders);
  const applyScanRef = React.useRef<(query: string) => void>(() => {});
  const verifyScanRef = React.useRef<(query: string) => void>(() => {});
  const isScanBusyRef = React.useRef(false);
  const isHandingOverRef = React.useRef(false);
  const daXuatKhoListRef = React.useRef(daXuatKhoList);
  const donHuyListRef = React.useRef(donHuyList);
  const daNhanHoanListRef = React.useRef(daNhanHoanList);
  /** Instance scanner sống — dùng để await stop/clear trước khi unmount. */
  const liveScannerRef = React.useRef<LiveQrScannerHandle | null>(null);
  const isTearingDownScannerRef = React.useRef(false);
  const orderScanIndex = useMemo(() => buildOrderScanIndex(orders), [orders]);
  const continuousScanTarget = useMemo(
    () =>
      orders.filter((o) =>
        ['unprocessed', 'processed', 'cancelled', 'return_pending'].includes(o.status)
      ).length,
    [orders]
  );
  const totalVerifiedScans = daXuatKhoList.length + donHuyList.length + daNhanHoanList.length;

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    daXuatKhoListRef.current = daXuatKhoList;
  }, [daXuatKhoList]);
  useEffect(() => {
    donHuyListRef.current = donHuyList;
  }, [donHuyList]);
  useEffect(() => {
    daNhanHoanListRef.current = daNhanHoanList;
  }, [daNhanHoanList]);

  const showScanToast = (text: string, type: 'success' | 'error') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2800);
  };

  const [selectedShopId, setSelectedShopId] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterUnprinted, setFilterUnprinted] = useState(false);

  const openHandedOverCarrierTab = React.useCallback(() => {
    setFilterUnprinted(false);
    setSearchQuery('');
    setSelectedShopId('all');
    setActiveSubTab(UI_TAB_HANDED_OVER_CARRIER);
  }, []);

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
        return { ...o, ...patched };
      });
      if (!hit) merged.unshift(patched);
      ordersRef.current = merged;
      onUpdateOrders(merged, { persist: false });
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
      const merged = ordersRef.current.map((o) => {
        const oSn = String(o.orderSn || '').replace(/^shopee-/i, '').trim().toLowerCase();
        const oId = String(o.id || '').trim().toLowerCase();
        const hit =
          byKey.get(oId) ||
          byKey.get(oSn) ||
          (oSn ? byKey.get(`shopee-${oSn}`) : undefined);
        return hit ? { ...o, ...hit } : o;
      });
      ordersRef.current = merged;
      onUpdateOrders(merged, { persist: false });
    },
    [onUpdateOrders]
  );

  const handOverOrderToCarrier = React.useCallback(
    async (order: Order, opts?: { switchTab?: boolean; fromScan?: boolean }) => {
      const token = localStorage.getItem('admin_token');
      if (!token) {
        showScanToast('Chưa đăng nhập — không thể ghi nhận bàn giao ĐVVC.', 'error');
        return false;
      }
      if (!isEligibleForHandOverToCarrier(order) && !isOrderHandedOverToCarrier(order)) {
        const why = getHandOverIneligibleReason(order) || 'không đủ điều kiện';
        showScanToast(`Đơn #${order.orderSn}: ${why}`, 'error');
        return false;
      }
      if (isOrderHandedOverToCarrier(order)) {
        if (opts?.switchTab !== false) openHandedOverCarrierTab();
        showScanToast(`Đơn #${order.orderSn} đã ghi nhận giao cho ĐVVC trước đó.`, 'success');
        return true;
      }
      if (isHandingOverRef.current) {
        showScanToast('Đang xử lý bàn giao ĐVVC — vui lòng đợi.', 'error');
        return false;
      }
      isHandingOverRef.current = true;
      setHandingOverOrderId(order.id);
      try {
        const orderKey = order.id || order.orderSn;
        const waybill = getOrderWaybillCode(order) || getOrderTrackingNo(order) || order.trackingNumber || order.tracking_no || '';
        const handOverBody = JSON.stringify({
          orderId: order.id,
          orderSn: order.orderSn,
          trackingNumber: waybill,
          tracking_no: waybill,
          waybill,
        });
        let res = await fetch(`/api/orders/${encodeURIComponent(orderKey)}/hand-over-carrier`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: handOverBody,
        });
        let data = await res.json().catch(() => ({}));

        // Fallback: POST by body, rồi PATCH local_status nếu endpoint bàn giao lỗi/404
        if (!res.ok) {
          const altRes = await fetch('/api/orders/hand-over-carrier', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: handOverBody,
          });
          if (altRes.ok) {
            res = altRes;
            data = await altRes.json().catch(() => ({}));
          } else {
            const patchRes = await fetch(`/api/orders/${encodeURIComponent(order.id)}`, {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(
                buildHandedOverWritePatch(
                  undefined,
                  opts?.fromScan
                    ? HANDED_OVER_SOURCE.QR_SCAN
                    : HANDED_OVER_SOURCE.MANUAL_BUTTON,
                ),
              ),
            });
            const patchData = await patchRes.json().catch(() => ({}));
            if (!patchRes.ok) {
              throw new Error(
                data?.message ||
                  data?.error ||
                  patchData?.message ||
                  patchData?.error ||
                  `HTTP ${res.status}`,
              );
            }
            res = patchRes;
            data = { success: true, order: patchData };
          }
        }

        if (data?.success === false) {
          throw new Error(data?.message || data?.error || 'hand_over_failed');
        }

        const saved = (data?.order || data) as Order;
        applyHandoverToLocalOrders(
          { ...order, ...saved },
          opts?.fromScan ? 'qr_scan' : 'manual_button',
        );
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: order.channel,
          type: 'stock_sync',
          status: 'success',
          message: opts?.fromScan
            ? `[QUÉT QR] Bàn giao ĐVVC đơn ${order.orderSn} → Tab Đã giao cho ĐVVC.`
            : `[BÀN GIAO] Đơn ${order.orderSn} → Đã giao cho ĐVVC.`,
        });
        if (opts?.switchTab !== false) openHandedOverCarrierTab();
        showScanToast(`Đã giao cho ĐVVC — đơn #${order.orderSn}`, 'success');
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showScanToast(`Không ghi nhận bàn giao: ${msg}`, 'error');
        return false;
      } finally {
        isHandingOverRef.current = false;
        setHandingOverOrderId(null);
      }
    },
    [applyHandoverToLocalOrders, onAddLog, openHandedOverCarrierTab]
  );

  const handleOrderScan = React.useCallback(
    async (rawQuery: string) => {
      const trimmed = rawQuery.trim();
      if (!trimmed || isScanBusyRef.current) return;

      isScanBusyRef.current = true;
      setIsScanBusy(true);
      setCameraScanResult('Đang tra cứu mã...');

      try {
        const token = localStorage.getItem('admin_token');
        let order =
          findOrderByScanPayload(ordersRef.current, trimmed, orderScanIndex) ||
          (await lookupOrderByScanCode(trimmed, ordersRef.current, token, orderScanIndex));

        if (order) {
          const idx = ordersRef.current.findIndex((o) => o.id === order!.id);
          if (idx >= 0) {
            const merged = ordersRef.current.map((o, i) => (i === idx ? { ...o, ...order! } : o));
            ordersRef.current = merged;
            onUpdateOrders(merged);
          } else {
            const merged = [order, ...ordersRef.current];
            ordersRef.current = merged;
            onUpdateOrders(merged);
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
          const ok = await handOverOrderToCarrier(order, { fromScan: true });
          if (ok) {
            scanFeedback('success');
            setCameraScanError(false);
            setCameraScanSuccess(true);
            setCameraScanResult(
              waybill
                ? `✓ Giao ĐVVC · VĐ ${waybill} · #${order.orderSn}`
                : `✓ Giao ĐVVC #${order.orderSn}`,
            );
            setTimeout(() => setCameraScanSuccess(false), 2000);
          } else {
            scanFeedback('error');
            setCameraScanSuccess(false);
            setCameraScanError(true);
            setTimeout(() => setCameraScanError(false), 2000);
          }
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

        if (order.status === 'cancelled' || order.status === 'return_pending') {
          const isCancelRequest = order.status === 'cancelled';
          const updated = ordersRef.current.map((o) =>
            o.id === order.id ? { ...o, status: 'return_received' as const } : o
          );
          ordersRef.current = updated;
          onUpdateOrders(updated);
          onAddLog({
            id: `log-${Date.now()}`,
            timestamp: new Date().toISOString(),
            channel: order.channel,
            type: 'stock_sync',
            status: 'success',
            message: `[QUÉT QR] Nhận hoàn đơn ${order.orderSn} → Hủy giao đã nhận.`,
          });
          scanFeedback(isCancelRequest ? 'warning' : 'success');
          setCameraScanError(false);
          setCameraScanSuccess(true);
          setCameraScanResult(`✓ Nhận hoàn #${order.orderSn}`);
          showScanToast(
            isCancelRequest
              ? `Đơn báo hủy #${order.orderSn} — đã chuyển Hủy giao đã nhận`
              : `Đã nhận hoàn đơn #${order.orderSn}`,
            'success'
          );
          setTimeout(() => setCameraScanSuccess(false), 2000);
          return;
        }

        if (order.status === 'shipping') {
          scanFeedback('error');
          setCameraScanSuccess(false);
          setCameraScanError(true);
          setCameraScanResult(`Đơn #${order.orderSn} đã ở trạng thái Đang giao`);
          showScanToast(`Đơn #${order.orderSn} đã xuất kho trước đó`, 'error');
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
          unprocessed: 'Chờ lấy hàng (Chưa xử lý)',
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

  /** Real-time: quét → dò trạng thái ngay (chưa ghi DB). */
  const verifySingleOrder = React.useCallback(
    async (rawQuery: string) => {
      const trimmed = String(rawQuery || '').trim();
      if (!trimmed || isFlushingQueue || isTearingDownScannerRef.current) return;

      const key = normalizeOrderScanKey(trimmed);
      if (!key) return;

      const now = Date.now();
      // Debounce 2.5s cùng mã — tránh gọi API/âm thanh liên tục.
      if (key === lastQrScanRef.current.key && now - lastQrScanRef.current.at < 2500) {
        return;
      }
      lastQrScanRef.current = { key, at: now };

      if (isCodeAlreadyVerified(key)) {
        playScanSound('warning');
        vibrateScan('warning');
        flashViewfinder('error', 500);
        setCameraScanResult(`Mã đã quét trong phiên này: ${trimmed}`);
        showScanToast('Mã này đã có trong danh sách phiên quét', 'error');
        return;
      }

      if (isScanBusyRef.current) return;
      isScanBusyRef.current = true;
      setIsVerifyingScan(true);
      setCameraScanResult(`Đang kiểm tra: ${trimmed}...`);

      try {
        const token = localStorage.getItem('admin_token');
        const order =
          findOrderByScanPayload(ordersRef.current, trimmed, orderScanIndex) ||
          (await lookupOrderByScanCode(trimmed, ordersRef.current, token, orderScanIndex));

        if (order) {
          const idx = ordersRef.current.findIndex((o) => o.id === order.id);
          if (idx >= 0) {
            const merged = ordersRef.current.map((o, i) => (i === idx ? { ...o, ...order } : o));
            ordersRef.current = merged;
            onUpdateOrders(merged);
          } else {
            const merged = [order, ...ordersRef.current];
            ordersRef.current = merged;
            onUpdateOrders(merged);
          }
        }

        if (!order) {
          playScanSound('error');
          vibrateScan('error');
          flashViewfinder('error', 500);
          setCameraScanResult(`Không tìm thấy: ${trimmed}`);
          showScanToast('Không tìm thấy mã này trong hệ thống', 'error');
          return;
        }

        // Chặn trùng theo DB (local_status đã xử lý trước đó).
        if (isOrderAlreadyScanProcessed(order)) {
          const reason = getScanProcessedReason(order);
          playScanSound('warning');
          vibrateScan('warning');
          flashViewfinder('error', 500);
          setCameraScanResult(`⚠ ${reason}`);
          showScanToast(reason, 'error');
          return;
        }

        const waybill = getOrderWaybillCode(order);
        const orderKey = normalizeOrderScanKey(order.orderSn || order.id);
        if (
          isCodeAlreadyVerified(orderKey) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(waybill)) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(order.trackingNumber || '')) ||
          isCodeAlreadyVerified(normalizeOrderScanKey(order.tracking_no || ''))
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

        if (isEligibleForHandOverToCarrier(order)) {
          playScanSound('success');
          vibrateScan('success');
          flashViewfinder('success', 500);
          setDaXuatKhoList((prev) => {
            const next = [item, ...prev];
            daXuatKhoListRef.current = next;
            return next;
          });
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

        if (order.status === 'unprocessed') {
          playScanSound('error');
          vibrateScan('error');
          flashViewfinder('error', 500);
          setCameraScanResult(`Đơn #${order.orderSn} còn Chưa xử lý — không xuất kho ĐVVC`);
          showScanToast(
            `Chỉ quét đơn ở Chờ lấy hàng (đã xử lý) hoặc Đơn hủy`,
            'error',
          );
          return;
        }

        if (order.status === 'cancelled') {
          playScanSound('warning');
          vibrateScan('warning');
          flashViewfinder('error', 500);
          setDonHuyList((prev) => {
            const next = [item, ...prev];
            donHuyListRef.current = next;
            return next;
          });
          setCameraScanResult(
            waybill
              ? `⚠ ĐƠN HỦY · VĐ ${waybill} · #${order.orderSn}`
              : `⚠ ĐƠN HỦY #${order.orderSn} — loại kiện này ra!`,
          );
          showScanToast(`CẢNH BÁO: Đơn hủy #${order.orderSn} — hãy loại kiện hàng này`, 'error');
          return;
        }

        if (order.status === 'return_pending') {
          playScanSound('success');
          vibrateScan('success');
          flashViewfinder('success', 500);
          setDaNhanHoanList((prev) => {
            const next = [item, ...prev];
            daNhanHoanListRef.current = next;
            return next;
          });
          setCameraScanResult(
            waybill
              ? `✓ Nhận hoàn · VĐ ${waybill} · #${order.orderSn}`
              : `✓ Nhận hoàn #${order.orderSn}`,
          );
          showScanToast(
            waybill
              ? `Nhận hoàn #${order.orderSn} — mã VĐ: ${waybill}`
              : `Đơn hoàn #${order.orderSn} — đã ghi nhận nhận hàng hoàn`,
            'success',
          );
          return;
        }

        playScanSound('error');
        vibrateScan('error');
        flashViewfinder('error', 500);
        setCameraScanResult(`Đơn #${order.orderSn} — trạng thái không xử lý được`);
        showScanToast(`Đơn #${order.orderSn} không thuộc trạng thái cần phân loại`, 'error');
      } finally {
        isScanBusyRef.current = false;
        setIsVerifyingScan(false);
      }
    },
    [isFlushingQueue, orderScanIndex, onUpdateOrders]
  );

  useEffect(() => {
    verifyScanRef.current = (q: string) => {
      void verifySingleOrder(q);
    };
  }, [verifySingleOrder]);

  useEffect(() => {
    let isMounted = true;

    if (focusScanner) {
      // Tránh restart camera khi đang graceful teardown (finish scan).
      if (isTearingDownScannerRef.current) {
        return () => {
          isMounted = false;
        };
      }

      setCameraScanSuccess(false);
      setCameraScanError(false);
      setCameraError('');
      lastQrScanRef.current = { key: '', at: 0 };
      setIsFlushingQueue(false);
      setCameraScanResult((prev) =>
        prev.includes('Xuất kho') ||
        prev.includes('ĐƠN HỦY') ||
        prev.includes('Nhận hoàn') ||
        prev.includes('sẵn sàng quét tiếp')
          ? prev
          : 'Quét realtime — dò trạng thái ngay mỗi mã',
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

  // Platform filtering & dropdown states
  const [selectedPlatform, setSelectedPlatform] = useState<'all' | 'shopee' | 'tiktok' | 'lazada' | 'woocommerce' | 'manual'>('all');
  const [showShopeeDropdown, setShowShopeeDropdown] = useState(false);
  const [showTikTokDropdown, setShowTikTokDropdown] = useState(false);
  const [showWooDropdown, setShowWooDropdown] = useState(false);
  
  // Search / sort
  const [selectedSort] = useState<'newest' | 'oldest' | 'highest_value'>('newest');
  /** Client-side: ưu tiên + gom nhóm đơn 1 SP (tab Chờ lấy hàng chưa xử lý). */
  const [smartPickSort, setSmartPickSort] = useState(false);

  // Multi-select bulk state
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [showBulkActionsDropdown, setShowBulkActionsDropdown] = useState(false);
  /** Tab Chờ lấy hàng (Chưa xử lý): lọc theo ĐVVC — all | spx | ghn | instant | other */
  const [selectedShippingCarrier, setSelectedShippingCarrier] =
    useState<ShippingCarrierFilter>('all');

  // Detail Modal & Bulk Print Modal
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);

  const toggleOrderDetails = (orderId: string) => {
    setExpandedOrderId((prev) => (prev === orderId ? null : orderId));
  };
  const [bulkPrintOrders, setBulkPrintOrders] = useState<Order[] | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  // Real Shopee/TikTok logistics API call state (ship_order / shipping document)
  const [printingOrderId, setPrintingOrderId] = useState<string | null>(null);
  const [isBulkPrinting, setIsBulkPrinting] = useState(false);

  // "Xác nhận đơn hàng" modal — lets the seller choose pickup vs dropoff before
  // any ship_order call is made, for one order (single button) or many (bulk).
  const [shipConfirmOrders, setShipConfirmOrders] = useState<Order[] | null>(null);
  const [shipMethod, setShipMethod] = useState<'pickup' | 'dropoff'>('pickup');
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
  const progressCloseTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Khóa click In đơn — chặn double-fire / bubbling / 2 view cùng lúc (≥1440px). */
  const isPrintingRef = React.useRef(false);
  const isPrintingUnlockTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Khóa mở PDF toàn cục — chỉ 1 tab mỗi phiên in (kể cả await fetch). */
  const pdfOpenSessionRef = React.useRef(false);
  const pdfOpenUnlockTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOpenedPdfKeyRef = React.useRef('');

  // Auto-hiding toast — replaces blocking alert() in bulk ship/print flows.
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4500);
  };

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

  /** Mở tab placeholder ngay trong user-gesture (tránh popup blocker sau await ship). */
  const openReservedPrintPlaceholder = (): Window | null => {
    try {
      const win = window.open('about:blank', '_blank');
      if (!win) return null;
      try {
        win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Đang tạo vận đơn...</title></head>
<body style="font-family:system-ui,sans-serif;padding:32px;color:#334155;line-height:1.5">
  <h2 style="margin:0 0 12px;font-size:18px">Đã xác nhận đơn hàng...</h2>
  <p style="margin:0 0 8px">Đang chờ Shopee tạo vận đơn (3–5 giây)...</p>
  <p style="margin:0;color:#64748b;font-size:13px">Vui lòng không đóng tab này — PDF sẽ tự mở khi sẵn sàng.</p>
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
    pdfFilename?: string;
    documents?: { url?: string; message?: string; error?: string }[];
    orders?: Order[];
    error?: string;
    message?: string;
    missingOrderSns?: string[];
  };

  const TRACKING_MISSING_TOAST =
    'Chưa đồng bộ được mã vận đơn từ Shopee, hệ thống đang tự động lấy lại, vui lòng thử lại sau!';

  const fetchPrintDocumentApi = async (
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
  const applyPrintDocumentResponse = async (
    data: PrintDocumentResponse,
    openPdf: boolean,
    reservedWindow?: Window | null
  ): Promise<{ success: boolean; message?: string; mergedUrl?: string | null }> => {
    const failedDocs = (data.documents || []).filter((d) => !d.url);
    const printUrl = data.url || data.mergedUrl || (data.documents || []).find((d) => d.url)?.url;
    const trackingMissing = failedDocs.some((d) => d.error === 'tracking_number_missing')
      || data.error === 'tracking_number_missing';

    if (Array.isArray(data.orders)) {
      onUpdateOrders(data.orders);
    }

    if (openPdf && printUrl) {
      await openShopeeLabelFromStream(
        {
          pdfFilename: data.pdfFilename,
          url: printUrl,
        },
        { reservedWindow }
      );
    } else if (!printUrl) {
      closeReservedPrintWindow(reservedWindow);
    }

    if (printUrl) {
      if (failedDocs.length > 0) {
        return {
          success: true,
          mergedUrl: printUrl,
          message: trackingMissing
            ? TRACKING_MISSING_TOAST
            : `Một số đơn lỗi: ${failedDocs.map((d) => d.message || d.error).join('; ')}`,
        };
      }
      return { success: true, mergedUrl: printUrl };
    }

    if (trackingMissing) {
      return { success: false, message: data.message || TRACKING_MISSING_TOAST };
    }

    const detail = failedDocs.map((d) => d.message || d.error).filter(Boolean).join('\n');
    return { success: false, message: detail || 'Shopee chưa trả về file vận đơn PDF.' };
  };

  // Shopee batch print: 1 request duy nhất với toàn bộ orderIds → BE merge 1 PDF → mở/in 1 lần.
  // TUYỆT ĐỐI không loop window.open / fetch từng đơn trên FE (popup blocker).
  const printShopeeDocuments = async (
    orderIds: string[],
    options: {
      openPdf?: boolean;
      onProgress?: (completed: number, total: number) => void;
      waitMs?: number;
      reservedWindow?: Window | null;
    } = {}
  ): Promise<{ success: boolean; message?: string; mergedUrl?: string | null }> => {
    const { openPdf = true, onProgress, waitMs, reservedWindow } = options;
    const uniqueIds = [...new Set(orderIds.map(String).filter(Boolean))];
    if (uniqueIds.length === 0) {
      closeReservedPrintWindow(reservedWindow);
      return { success: false, message: 'Không có đơn hàng để in.' };
    }

    const total = uniqueIds.length;

    try {
      if (onProgress) onProgress(0, total);
      // Một request duy nhất — backend gộp PDF toàn bộ orderIds (+ chờ Shopee nếu waitMs).
      const { ok, status, data } = await fetchPrintDocumentApi(uniqueIds, { waitMs });
      if (!ok) {
        closeReservedPrintWindow(reservedWindow);
        if (data.error === 'tracking_number_missing' || status === 409) {
          if (Array.isArray(data.orders)) onUpdateOrders(data.orders);
          return { success: false, message: data.message || TRACKING_MISSING_TOAST };
        }
        return {
          success: false,
          message: data.message || data.error || `Không thể tạo vận đơn Shopee (HTTP ${status}).`,
        };
      }

      if (onProgress) onProgress(total, total);
      return applyPrintDocumentResponse(data, openPdf, reservedWindow);
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
  };

  const scheduleCloseProgressOverlay = (delayMs = 1800) => {
    if (progressCloseTimerRef.current) clearTimeout(progressCloseTimerRef.current);
    progressCloseTimerRef.current = setTimeout(() => {
      clearShipProgressOverlay();
    }, delayMs);
  };

  const markProgressComplete = (message?: string) => {
    setProgressDone(true);
    if (message) setProgressMessage(message);
    if (progressTotal > 0) setProgressCompleted(progressTotal);
    scheduleCloseProgressOverlay(1800);
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
        ...(opts?.markPrinted && isProcessedCondition({ ...o, status: 'processed', isPrepared: true })
          ? { isPrinted: true }
          : {}),
      };
    });

  const refreshOrdersAfterShip = async (
    queuedOrders: Order[],
    opts?: { markPrinted?: boolean; shipMethod?: 'pickup' | 'dropoff' }
  ) => {
    const queuedKeys = buildQueuedOrderKeys(queuedOrders);
    const patched = applyLocalShippedOrdersUpdate(ordersRef.current, queuedKeys, opts);
    ordersRef.current = patched;
    onUpdateOrders(patched);
    if (onFetchOrders) {
      await onFetchOrders();
    }
  };

  const pollShipJobUntilDone = async (
    jobId: string,
    total: number,
    onShipComplete?: () => void
  ): Promise<any | null> => {
    const deadline = Date.now() + 15 * 60 * 1000;
    let finalJob: any = null;
    let shipCompleteNotified = false;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 900));
      try {
        const jobRes = await fetch(`/api/shopee/ship-order/job/${jobId}`, { headers: authHeaders() });
        if (!jobRes.ok) break;
        const job = await parseJsonResponse<any>(jobRes);
        finalJob = job;

        setProgressCompleted(job.completed || 0);
        setProgressTotal(job.total || total);

        if (Array.isArray(job.orders)) {
          onUpdateOrders(job.orders);
          ordersRef.current = job.orders;
        }

        if (job.status === 'printing') {
          setProgressMessage(
            `Đã xác nhận ${job.successCount || job.completed}/${job.total} đơn — Đang chờ tạo vận đơn...`,
          );
        } else if (job.status === 'running' || job.status === 'pending') {
          setProgressMessage(`Đang xác nhận trên Shopee: ${job.completed}/${job.total} đơn...`);
        }

        if (
          !shipCompleteNotified &&
          (job.status === 'printing' || job.status === 'done' || job.status === 'failed')
        ) {
          shipCompleteNotified = true;
          onShipComplete?.();
        }

        if (job.status === 'done' || job.status === 'failed') break;
      } catch {
        break;
      }
    }

    if (!shipCompleteNotified) onShipComplete?.();
    return finalJob;
  };

  const finishShipJobResult = async (
    finalJob: any | null,
    queuedCount: number,
    total: number,
    reservedPrintWin?: Window | null
  ) => {
    const results = finalJob?.results || [];
    const successfullyConfirmedIds: string[] = [];
    for (const r of results) {
      try {
        if (r?.success && r?.orderId) successfullyConfirmedIds.push(String(r.orderId));
      } catch (err) {
        console.error('[Bulk Confirm] Skip result lỗi khi gom ID:', err);
      }
    }
    const successCount = Number(finalJob?.successCount) || successfullyConfirmedIds.length;
    const failed = results.filter((r: any) => !r?.success);
    const failedCount = Number(finalJob?.failedCount) || failed.length;

    onAddLog({
      id: `log-${Date.now() + 2}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: successCount > 0 ? 'success' : 'failed',
      message: `Xác nhận thành công ${successCount} đơn. Bỏ qua ${failedCount} đơn bị lỗi. (${shipMethod === 'pickup' ? 'Lấy hàng' : 'Tự mang ra bưu cục'})`,
    });

    if (Array.isArray(finalJob?.orders)) {
      onUpdateOrders(finalJob.orders);
      ordersRef.current = finalJob.orders;
    }

    if (finalJob?.status === 'failed' && successCount === 0) {
      closeReservedPrintWindow(reservedPrintWin);
      showToast(finalJob.error || 'Đồng bộ Shopee gặp lỗi. Vui lòng kiểm tra lại danh sách đơn.');
    } else {
      showToast(
        finalJob?.message ||
          `Xác nhận thành công ${successCount} đơn. Bỏ qua ${failedCount} đơn bị lỗi.`,
      );
    }

    // Chỉ in đơn đã xác nhận thành công — 1 PDF gộp / 1 lần mở. Không loop popup.
    if (successfullyConfirmedIds.length > 0) {
      const printedSnsFromJob: string[] = Array.isArray(finalJob?.printDocument?.printedOrderSns)
        ? finalJob.printDocument.printedOrderSns.map(String)
        : [];
      const coversAllConfirmed =
        printedSnsFromJob.length >= successfullyConfirmedIds.length &&
        !!finalJob?.printDocument?.url;

      try {
        if (coversAllConfirmed) {
          setProgressMessage('Hoàn tất! Đang mở PDF vận đơn...');
          await openShopeeLabelFromStream(
            {
              pdfFilename: finalJob.printDocument.pdfFilename,
              url: finalJob.printDocument.url,
            },
            {
              successfullyConfirmedIds,
              showContinueModalOnBlock: true,
              reservedWindow: reservedPrintWin,
            }
          );
        } else {
          // PDF job thiếu đơn / thiếu file → chờ Shopee rồi gọi print-document (cùng /api/public/labels/).
          console.warn(
            `[Bulk Confirm] Auto-print job chỉ có ${printedSnsFromJob.length}/${successfullyConfirmedIds.length} đơn — gọi print-document gộp lại.`,
          );
          setProgressMessage('Đã xác nhận... Đang chờ tạo vận đơn (3 giây)...');
          await new Promise((r) => setTimeout(r, 3000));
          setProgressMessage('Đang tạo file PDF vận đơn...');
          const printResult = await printShopeeDocuments(successfullyConfirmedIds, {
            waitMs: 2000,
            reservedWindow: reservedPrintWin,
          });
          if (!printResult.success && printResult.message) {
            showToast(printResult.message);
            queuePendingAutoPrint(
              {
                url: finalJob?.printDocument?.url,
                pdfFilename: finalJob?.printDocument?.pdfFilename,
              },
              successfullyConfirmedIds
            );
          }
        }
      } catch (printErr) {
        console.error('[Bulk Confirm] Auto-print lỗi (continue):', printErr);
        closeReservedPrintWindow(reservedPrintWin);
        queuePendingAutoPrint({}, successfullyConfirmedIds);
      }
    } else {
      closeReservedPrintWindow(reservedPrintWin);
      if (finalJob?.printDocument?.message) {
        showToast(finalJob.printDocument.message);
      }
    }

    const printedSns = new Set<string>(
      (finalJob?.printDocument?.printedOrderSns as string[] | undefined) ||
        results.filter((r: any) => r?.success).map((r: any) => r.orderSn).filter(Boolean)
    );
    const queuedForRefresh = queuedCount > 0
      ? ordersRef.current.filter(
          (o) =>
            printedSns.has(o.orderSn) ||
            results.some(
              (r: any) => r?.success && (r.orderId === o.id || r.orderSn === o.orderSn)
            )
        )
      : [];
    if (queuedForRefresh.length > 0) {
      await refreshOrdersAfterShip(queuedForRefresh, {
        markPrinted: printedSns.size > 0,
        shipMethod,
      });
    } else if (onFetchOrders) {
      await onFetchOrders();
    }
  };

  const confirmShipOrders = async () => {
    if (!shipConfirmOrders || shipConfirmOrders.length === 0) return;
    const queuedOrders = [...shipConfirmOrders];
    const orderSns = [...new Set(queuedOrders.map(o => o.orderSn).filter(sn => Boolean(sn && String(sn).trim())))];
    const orderIds = [...new Set(queuedOrders.map(o => o.id).filter(id => Boolean(id && String(id).trim())))];

    if (orderSns.length === 0 && orderIds.length === 0) {
      showToast('Không có mã đơn hàng hợp lệ trong danh sách đã chọn. Vui lòng chọn lại.');
      return;
    }

    const queuedKeys = buildQueuedOrderKeys(queuedOrders);
    const optimisticOrders = applyLocalShippedOrdersUpdate(ordersRef.current, queuedKeys, {
      shipMethod,
    });
    onUpdateOrders(optimisticOrders);
    ordersRef.current = optimisticOrders;

    setIsShipping(true);
    setProgressCompleted(0);
    setProgressTotal(queuedOrders.length);
    setProgressDone(false);
    setProgressMessage(`Đang xác nhận ${queuedOrders.length} đơn...`);

    // Mở tab in NGAY trong user-gesture — sau await dài window.open sẽ bị chặn.
    const reservedPrintWin = openReservedPrintPlaceholder();

    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: `[LOGISTICS API] Đang gọi v2.logistics.ship_order (${shipMethod === 'pickup' ? 'pickup' : 'dropoff'}) cho ${orderSns.length} đơn: ${orderSns.join(', ')}.`
    });

    try {
      let res = await fetch('/api/shopee/ship-order/bulk-async', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ orderIds, orderSns, method: shipMethod }),
      });

      const shouldFallbackSync =
        res.status === 404 ||
        res.status === 502 ||
        res.status === 503 ||
        (res.status >= 500 && res.status !== 202);

      if (shouldFallbackSync) {
        setProgressMessage(`Backend async lỗi (HTTP ${res.status}) — đang xác nhận ${queuedOrders.length} đơn (có thể mất vài phút)...`);
        res = await fetch('/api/shopee/ship-order/bulk', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ orderIds, orderSns, method: shipMethod }),
        });
        const syncData = await readResponseJson<any>(res);
        if (!res.ok) {
          closeReservedPrintWindow(reservedPrintWin);
          showToast(syncData.message || syncData.error || `Không xác nhận được đơn (HTTP ${res.status}).`);
          if (onFetchOrders) await onFetchOrders();
          clearShipProgressOverlay();
          return;
        }
        if (Array.isArray(syncData.orders)) {
          onUpdateOrders(syncData.orders);
          ordersRef.current = syncData.orders;
        }
        setShipConfirmOrders(null);
        setSelectedOrderIds([]);
        setActiveSubTab('processed');

        const successfullyConfirmedIds: string[] = [];
        for (const r of syncData.results || []) {
          try {
            if (r?.success && r?.orderId) successfullyConfirmedIds.push(String(r.orderId));
          } catch (err) {
            console.error('[Bulk Confirm Sync] Skip result lỗi khi gom ID:', err);
          }
        }
        const successCount = Number(syncData.successCount) || successfullyConfirmedIds.length;
        const failedCount =
          Number(syncData.failedCount) ||
          (syncData.results || []).filter((r: any) => !r?.success).length;
        showToast(
          syncData.message ||
            `Xác nhận thành công ${successCount} đơn. Bỏ qua ${failedCount} đơn bị lỗi.`,
        );
        if (successfullyConfirmedIds.length === 0) {
          closeReservedPrintWindow(reservedPrintWin);
          clearShipProgressOverlay();
          return;
        }
        // await confirm xong → chờ Shopee tạo vận đơn → 1 PDF gộp
        const printedSnsSync: string[] = Array.isArray(syncData.printDocument?.printedOrderSns)
          ? syncData.printDocument.printedOrderSns.map(String)
          : [];
        const syncCoversAll =
          printedSnsSync.length >= successfullyConfirmedIds.length &&
          !!syncData.printDocument?.url;
        try {
          if (syncCoversAll) {
            setProgressMessage('Hoàn tất! Đang mở PDF vận đơn...');
            await openShopeeLabelFromStream(
              {
                pdfFilename: syncData.printDocument.pdfFilename,
                url: syncData.printDocument.url,
              },
              {
                successfullyConfirmedIds,
                showContinueModalOnBlock: true,
                reservedWindow: reservedPrintWin,
              }
            );
          } else {
            setProgressMessage('Đã xác nhận... Đang chờ tạo vận đơn (3 giây)...');
            await new Promise((r) => setTimeout(r, 3000));
            setProgressMessage('Đang tạo file PDF vận đơn...');
            await printShopeeDocuments(successfullyConfirmedIds, {
              waitMs: 2000,
              reservedWindow: reservedPrintWin,
            });
          }
        } catch (printErr) {
          console.error('[Bulk Confirm Sync] Auto-print lỗi (continue):', printErr);
          closeReservedPrintWindow(reservedPrintWin);
          queuePendingAutoPrint({}, successfullyConfirmedIds);
        }
        await refreshOrdersAfterShip(queuedOrders, {
          markPrinted: successCount > 0,
          shipMethod,
        });
        markProgressComplete('Hoàn tất! Đã xác nhận & mở vận đơn.');
        return;
      }

      const data = await readResponseJson<any>(res);
      if (!res.ok && res.status !== 202) {
        closeReservedPrintWindow(reservedPrintWin);
        showToast(data.message || data.error || data.detail || 'Không thể bắt đầu xác nhận đơn hàng.');
        if (onFetchOrders) await onFetchOrders();
        clearShipProgressOverlay();
        return;
      }

      if (Array.isArray(data.orders)) {
        onUpdateOrders(data.orders);
        ordersRef.current = data.orders;
      }

      setShipConfirmOrders(null);
      setSelectedOrderIds([]);
      setActiveSubTab('processed');

      const jobId = data.jobId as string | undefined;
      const total = Number(data.total) || queuedOrders.length;
      setProgressTotal(total);

      if (!jobId) {
        closeReservedPrintWindow(reservedPrintWin);
        showToast(`Đã ghi nhận ${queuedOrders.length} đơn.`);
        markProgressComplete('Đã ghi nhận đơn hàng!');
        return;
      }

      setProgressMessage(`Đang xác nhận trên Shopee: 0/${total} đơn...`);
      // BẮT BUỘC await xác nhận + gen PDF hoàn tất trước khi trigger in.
      const finalJob = await pollShipJobUntilDone(jobId, total, () => {
        setProgressMessage('Đã xác nhận... Đang chờ tạo vận đơn...');
        showToast('Đã xác nhận — đang chờ Shopee tạo vận đơn...');
      });
      await finishShipJobResult(finalJob, queuedOrders.length, total, reservedPrintWin);
      markProgressComplete('Hoàn tất! Đã xác nhận & mở vận đơn.');
    } catch (err) {
      closeReservedPrintWindow(reservedPrintWin);
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
      showToast(`Không thể kết nối API chuẩn bị hàng: ${msg}`);
      if (onFetchOrders) await onFetchOrders();
      clearShipProgressOverlay();
    } finally {
      setIsShipping(false);
    }
  };

  const [showCreateOrderPage, setShowCreateOrderPage] = useState(false);

  const handleSyncOrders = async (type: 'incremental' | 'full' = 'incremental') => {
    if (isSyncing) return;
    setIsSyncing(true);
    const isFull = type === 'full';
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: isFull
        ? 'Đã gửi Full Sync lịch sử đơn 30 ngày (ngầm) — UI không bị khóa.'
        : 'Đã gửi đồng bộ đơn 24 giờ (ngầm) — UI không bị khóa.',
    });

    showToast('Đã gửi yêu cầu đồng bộ ngầm...');

    try {
      // Fire-and-forget: backend trả 202 hoặc soft-ack nếu đang chạy — widget góc phải theo dõi.
      await onPullShopeeOrders?.({ type });
    } catch (err: any) {
      showToast(`Đồng bộ thất bại: ${err?.message || 'Vui lòng kiểm tra kết nối API và thử lại.'}`);
      try {
        void onFetchOrders?.({ silent: true });
      } catch {
        /* ignore */
      }
    } finally {
      setIsSyncing(false);
    }
  };

  // Status Vietnamese styling and labeling helper matching mockup closely
  const getStatusBadge = (status: Order['status']) => {
    switch (status) {
      case 'pending_verification':
      case 'pending_confirm': 
        return { text: 'Chờ xác nhận', color: 'bg-amber-50 text-amber-600 border-amber-200/60' };
      case 'unprocessed': 
        return { text: 'Chờ lấy hàng (Chưa xử lý)', color: 'bg-sky-50 text-sky-600 border-sky-200/60 font-semibold' };
      case 'processed': 
        return { text: 'Chờ lấy hàng (Đã xử lý)', color: 'bg-emerald-50 text-emerald-600 border-emerald-200/60' };
      case 'shipping': 
        return { text: 'Đang giao', color: 'bg-indigo-50 text-indigo-600 border-indigo-200/60' };
      case 'completed': 
        return { text: 'Thành công', color: 'bg-green-50 text-green-700 border-green-200/60' };
      case 'cancelled': 
        return { text: 'Đơn Hủy', color: 'bg-rose-50 text-rose-500 border-rose-100' };
      case 'return_pending': 
        return { text: 'Giao hàng không thành công', color: 'bg-purple-50 text-purple-600 border-purple-200/60 font-bold' };
      case 'return_received': 
        return { text: 'Trả hàng Hoàn tiền', color: 'bg-orange-50 text-orange-700 border-orange-200' };
    }
  };

  // Helper count statistics
  const aggregatedOrderProducts = useMemo(
    () => aggregateOrderProducts(orders, products ?? []),
    [orders, products]
  );

  const cancelReturnPool = useMemo(
    () => orders.filter(isCancelReturnOrder),
    [orders]
  );

  const getCancelReturnCount = (tab: CancelReturnTab) =>
    cancelReturnPool.filter((o) => matchesCancelReturnTab(o, tab)).length;

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
    if (status === 'cancel_returns') {
      return cancelReturnPool.length;
    }
    if (status === 'received_cancel_returns') {
      return orders.filter((o) => matchesReceivedCancelReturnTab(o)).length;
    }
    return orders.filter(o => {
      if (status === 'all') return true;
      if (status === 'pending_confirm' || status === 'pending_verification') {
        return isPendingConfirmOrder(o);
      }
      if (status === 'unprocessed') return matchesUnprocessedPickupTab(o) && !isPendingConfirmOrder(o);
      if (status === 'processed') return matchesProcessedPickupTab(o);
      if (status === 'shipping') return matchesShippingTab(o);
      if (status === 'handed_over_carrier') return matchesHandedOverCarrierTab(o);
      return o.status === status;
    }).length;
  };

  // Filter logic (client-side only — không gọi API)
  const singleItemSortKey = (order: Order) => {
    const item = (order.items || [])[0];
    if (!item) return '';
    return String(item.productTitle || item.modelSku || item.modelName || '').trim();
  };

  /** Tab + sàn + shop + search (+ chưa in) — CHƯA lọc ĐVVC. Count và list dùng chung pool này. */
  const matchesOrdersListBaseFilters = (order: Order): boolean => {
    // 1. Tab filter
    if (activeSubTab === 'cancel_returns') {
      if (!matchesCancelReturnTab(order, cancelReturnTab)) return false;
    } else if (activeSubTab === 'received_cancel_returns') {
      if (!matchesReceivedCancelReturnTab(order)) return false;
    } else if (activeSubTab === 'handed_over_carrier') {
      // ROLLBACK: tab ĐVVC tạm tắt — chuyển về pool chờ lấy hàng (READY_TO_SHIP-like)
      if (!matchesProcessedPickupTab(order) && !matchesUnprocessedPickupTab(order)) return false;
    } else if (activeSubTab === 'processed') {
      if (!matchesProcessedPickupTab(order)) return false;
    } else if (activeSubTab === 'pending_confirm' || activeSubTab === 'pending_verification') {
      if (!isPendingConfirmOrder(order)) return false;
    } else if (activeSubTab === 'unprocessed') {
      if (!matchesUnprocessedPickupTab(order) || isPendingConfirmOrder(order)) return false;
    } else if (activeSubTab === 'shipping') {
      if (!matchesShippingTab(order)) return false;
    } else if (activeSubTab !== 'all' && activeSubTab !== 'order_products') {
      if (order.status !== activeSubTab) return false;
    }

    // 2. Platform filter
    if (selectedPlatform !== 'all') {
      if (selectedPlatform === 'lazada') return false;
      if (order.channel !== selectedPlatform) return false;
    }

    // 3. Shop Filter
    if (selectedShopId !== 'all' && order.shopId !== selectedShopId) return false;

    // 4. Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchSn = String(order.orderSn || '').toLowerCase().includes(q);
      const matchTracking = Boolean(
        (order.trackingNumber && order.trackingNumber.toLowerCase().includes(q)) ||
          (order.tracking_no && String(order.tracking_no).toLowerCase().includes(q)) ||
          (getOrderWaybillCode(order) && getOrderWaybillCode(order).toLowerCase().includes(q)),
      );
      const matchInternal = order.internalTrackingCode
        ? order.internalTrackingCode.toLowerCase().includes(q)
        : false;
      const matchProduct = (order.items || []).some((it) =>
        String(it.productTitle || '').toLowerCase().includes(q),
      );
      if (!matchSn && !matchTracking && !matchInternal && !matchProduct) return false;
    }

    // 5. Lọc chưa in (áp dụng trước ĐVVC để count khớp list khi bật)
    if (filterUnprinted && isOrderPrintedEffective(order)) return false;

    return true;
  };

  const ordersPoolBeforeCarrier = useMemo(
    () => orders.filter(matchesOrdersListBaseFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mirrors live filter inputs below
    [
      orders,
      activeSubTab,
      cancelReturnTab,
      selectedPlatform,
      selectedShopId,
      searchQuery,
      filterUnprinted,
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
      'unprocessed',
      'processed',
      'cancel_returns',
      'received_cancel_returns',
    ]);
    if (!carrierFilterTabs.has(activeSubTab)) return counts;
    for (const order of ordersPoolBeforeCarrier) {
      const group = getShippingCarrierGroup(order);
      counts.all += 1;
      counts[group] += 1;
    }
    return counts;
  }, [activeSubTab, ordersPoolBeforeCarrier]);

  const filteredOrdersBase = ordersPoolBeforeCarrier
    .filter((order) => {
      // ĐVVC filter — Chờ lấy hàng + Đơn hủy/hoàn + Đã nhận hủy/hoàn
      if (
        activeSubTab === 'unprocessed' ||
        activeSubTab === 'processed' ||
        activeSubTab === 'cancel_returns' ||
        activeSubTab === 'received_cancel_returns'
      ) {
        return orderMatchesShippingCarrierFilter(order, selectedShippingCarrier);
      }
      return true;
    })
    .sort((a, b) => {
      const dateMs = (o: Order) => new Date(o.date || 0).getTime() || 0;
      if (selectedSort === 'newest') return dateMs(b) - dateMs(a);
      if (selectedSort === 'oldest') return dateMs(a) - dateMs(b);
      if (selectedSort === 'highest_value') {
        return (Number(b.totalAmount) || 0) - (Number(a.totalAmount) || 0);
      }
      return 0;
    });

  // Smart pick sort: không ẩn đơn — chỉ sắp xếp lại trên client khi bật toggle (tab unprocessed).
  const filteredOrders =
    smartPickSort && activeSubTab === 'unprocessed'
      ? [...filteredOrdersBase].sort((a, b) => {
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
        })
      : filteredOrdersBase;

  // Resolve checkbox selections to full Order rows — CHỈ lấy đơn đang hiển thị
  // (đã lọc ĐVVC), để In/Xác nhận hàng loạt không đụng đơn bị ẩn.
  const getSelectedOrders = (): Order[] => {
    if (selectedOrderIds.length === 0) return [];
    const keySet = new Set(selectedOrderIds.map(k => String(k).trim()).filter(Boolean));
    return filteredOrders.filter(o =>
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
    setShipMethod('pickup');
    setShipConfirmOrders(targets);
  };

  // Toggle selection for bulk actions
  const handleToggleSelectAll = () => {
    if (selectedOrderIds.length === filteredOrders.length) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(filteredOrders.map(o => o.id));
    }
  };

  const handleToggleSelectOne = (id: string) => {
    if (selectedOrderIds.includes(id)) {
      setSelectedOrderIds(prev => prev.filter(item => item !== id));
    } else {
      setSelectedOrderIds(prev => [...prev, id]);
    }
  };

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

    const shopeeAll = selected.filter(o => o.channel === 'shopee' && o.shopId).map(o => o.id);
    const others = selected.filter(o => !(o.channel === 'shopee' && o.shopId));

    setIsBulkPrinting(true);
    if (shopeeAll.length > 0) {
      setProgressDone(false);
      setProgressTotal(shopeeAll.length);
      setProgressCompleted(0);
      setProgressMessage(`Đang tải vận đơn: 0/${shopeeAll.length} đơn...`);
    }
    try {
      if (shopeeAll.length > 0) {
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: 'shopee',
          type: 'stock_sync',
          status: 'success',
          message: `[SHOPEE API] Đang gọi v2.logistics.create_shipping_document + download_shipping_document để lấy vận đơn thật cho ${shopeeAll.length} đơn hàng.`
        });
        const result = await printShopeeDocuments(shopeeAll, {
          onProgress: (completed, total) => {
            setProgressCompleted(completed);
            setProgressTotal(total);
            setProgressMessage(
              completed >= total
                ? 'Hoàn tất — đang mở PDF vận đơn...'
                : `Đang tải vận đơn từ Shopee: ${completed}/${total} đơn...`
            );
          },
        });
        if (!result.success) {
          showToast(`In vận đơn Shopee thất bại: ${result.message}`);
          clearShipProgressOverlay();
        } else {
          if (result.message) showToast(result.message);
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
        } : o));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
      showToast(`In vận đơn Shopee thất bại: ${msg}`);
      clearShipProgressOverlay();
    } finally {
      setIsBulkPrinting(false);
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
    try {
      const orderIds = eligible.map((o) => o.id).filter(Boolean);
      const orderSns = eligible.map((o) => o.orderSn).filter(Boolean);
      const res = await fetch('/api/orders/hand-over-carrier/bulk', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ orderIds, orderSns }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }

      // Không dùng `|| eligible.length` — updated=0 từng báo giả "thành công 3 đơn".
      const updatedCount = Number(data?.updated);
      const skippedCount = Number(data?.skipped) || 0;
      const failedArr = Array.isArray(data?.failed) ? data.failed : [];
      const realUpdated = Number.isFinite(updatedCount) ? updatedCount : 0;

      if (realUpdated <= 0 && skippedCount <= 0) {
        throw new Error(
          failedArr[0]?.error || data?.message || 'Không bàn giao được đơn nào vào DB.',
        );
      }

      const savedList = Array.isArray(data?.orders) ? (data.orders as Order[]) : [];
      if (savedList.length > 0) {
        applyHandoverBulkToLocalOrders(savedList);
      } else if (realUpdated > 0) {
        applyHandoverBulkToLocalOrders(eligible.slice(0, realUpdated));
      }

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'stock_sync',
        status: failedArr.length > 0 ? 'error' : 'success',
        message: `[BÀN GIAO HÀNG LOẠT] ${realUpdated} đơn → Đã giao cho ĐVVC${
          skippedCount ? ` (đã có sẵn ${skippedCount})` : ''
        }${failedArr.length ? ` (lỗi ${failedArr.length})` : ''}.`,
      });
      setSelectedOrderIds([]);

      if (onFetchOrders) {
        try {
          await onFetchOrders();
        } catch {
          /* giữ state local nếu refetch lỗi */
        }
      }
      openHandedOverCarrierTab();

      const visibleAfter = ordersRef.current.filter((o) => matchesHandedOverCarrierTab(o)).length;
      if (realUpdated <= 0 && skippedCount > 0) {
        showToast(
          `Đã có ${skippedCount} đơn mang cờ ĐVVC — tab đang hiện ${visibleAfter} đơn.`,
        );
      } else {
        showToast(
          failedArr.length > 0
            ? `Xuất kho ${realUpdated} / Lỗi ${failedArr.length}. Tab hiện ${visibleAfter}.`
            : `Xuất kho ${realUpdated} đơn — tab hiện ${visibleAfter}.`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Không bàn giao hàng loạt: ${msg}`);
    } finally {
      isHandingOverRef.current = false;
      setIsBulkHandingOver(false);
    }
  };

  // Single-order "Chuẩn bị hàng" — opens the pickup/dropoff confirmation modal;
  // the real ship_order call fires only after the seller confirms a method.
  const handleSinglePrepare = (order: Order) => {
    setShipMethod('pickup');
    setShipConfirmOrders([order]);
  };

  // Single-order print — fetches the REAL Shopee AWB PDF, or falls back to the
  // mock packing-slip preview for non-Shopee (manual/tiktok) orders.
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
      onUpdateOrders(orders.map(o => o.id === order.id ? {
        ...o,
        ...(isProcessedCondition(o)
          ? { isPrinted: true, status: 'processed' as const }
          : {}),
      } : o));
      return;
    }

    // Deliberately NOT checking order.isPrepared here anymore — Shopee's own
    // create_shipping_document/get_shipping_document API is the single source
    // of truth for whether the order's logistics status actually allows a
    // label to be generated. If it doesn't, Shopee's own error message (surfaced
    // in the alert below) explains why — no more local pre-check blocking the request.
    setPrintingOrderId(order.id);
    setProgressDone(false);
    setProgressTotal(1);
    setProgressCompleted(0);
    setProgressMessage('Đang tải vận đơn: 0/1 đơn...');
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'shopee',
      type: 'stock_sync',
      status: 'success',
      message: `[SHOPEE API] Đang tạo & tải vận đơn thật (AWB) cho đơn ${order.orderSn}.`
    });
    try {
      const result = await printShopeeDocuments([order.id], {
        onProgress: (completed, total) => {
          setProgressCompleted(completed);
          setProgressTotal(total);
          setProgressMessage(
            completed >= total ? 'Hoàn tất — đang mở PDF...' : `Đang tải vận đơn: ${completed}/${total} đơn...`
          );
        },
      });
      if (!result.success) {
        alert(`In vận đơn thất bại cho đơn ${order.orderSn}: ${result.message}`);
        clearShipProgressOverlay();
      } else {
        markProgressComplete('In vận đơn thành công!');
      }
    } catch (err) {
      alert('Không thể kết nối API in vận đơn Shopee. Vui lòng thử lại.');
      clearShipProgressOverlay();
    } finally {
      setPrintingOrderId(null);
    }
  };

  // Separate shops for multi-store badges
  const shopeeShops = shops.filter(s => s.platform === 'shopee');
  const tiktokShops = shops.filter(s => s.platform === 'tiktok');
  const woocommerceShops = shops.filter(s => s.platform === 'woocommerce');

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
    setCameraScanResult('Quét realtime — dò trạng thái ngay mỗi mã');
    setCameraScanSuccess(false);
    setScanToast(null);
    setShowEndConfirm(false);
    setIsFlushingQueue(false);
    if (onCloseScanner) onCloseScanner();
    else if (onEndScanSession) onEndScanSession();
  };

  const handleEndScanSession = () => {
    closeScannerUiOnly();
  };

  /** Kết thúc: ghi DB 1 lần từ 3 list đã verify realtime — clear list, ở lại màn quét. */
  const handleFinishContinuousScan = async () => {
    setShowEndConfirm(false);

    const shipped = [...daXuatKhoListRef.current];
    const cancelled = [...donHuyListRef.current];
    const returned = [...daNhanHoanListRef.current];
    const codes = [
      ...shipped.map((i) => i.code),
      ...cancelled.map((i) => i.code),
      ...returned.map((i) => i.code),
    ];

    // Không có mã đã verify → thoát phiên (đóng UI quét, vẫn ở tab Đơn hàng).
    if (codes.length === 0) {
      isTearingDownScannerRef.current = true;
      try {
        const handle = liveScannerRef.current;
        liveScannerRef.current = null;
        await handle?.stop().catch(() => undefined);
      } catch {
        /* ignore */
      }
      isTearingDownScannerRef.current = false;
      closeScannerUiOnly();
      return;
    }

    setIsFlushingQueue(true);
    setCameraScanResult(`Đang ghi DB ${codes.length} đơn đã phân loại...`);

    try {
      const token = localStorage.getItem('admin_token');
      if (!token) {
        throw new Error('Chưa đăng nhập — không thể cập nhật đơn đã quét.');
      }

      const res = await fetch('/api/orders/scan-bulk-update', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          codes,
          scannedCodes: codes,
          daXuatKhoCodes: shipped.map((i) => i.code),
          donHuyCodes: cancelled.map((i) => i.code),
          daNhanHoanCodes: returned.map((i) => i.code),
        }),
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      if (!res.ok || data?.success === false) {
        throw new Error(String(data?.message || data?.error || `HTTP ${res.status}`));
      }

      const summaryRaw = (data?.summary || {}) as {
        daXuatKho?: number;
        donHuy?: number;
        daNhanHoan?: number;
      };
      // NO FAKE SUCCESS: 0 là số thật — không fallback sang codes.length.
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
        status: processedCount > 0 ? 'success' : 'error',
        message: `[QUÉT QR COMMIT] xuất kho ${safeXuat}, đơn hủy ${safeHuy}, nhận hoàn ${safeHoan}.`,
      });

      const failedScans = Array.isArray(data?.failed_scans) ? data.failed_scans : [];
      clearVerifiedScanLists();
      if (processedCount > 0) {
        showScanToast(
          `Xuất kho ${safeXuat} / Hủy ${safeHuy} / Nhận hoàn ${safeHoan}${
            failedScans.length ? ` · Bỏ qua ${failedScans.length}` : ''
          }`,
          'success',
        );
      } else {
        showScanToast(
          failedScans.length > 0
            ? String(failedScans[0]?.reason || 'Xuất kho 0 — không có đơn nào được ghi DB')
            : 'Xuất kho 0 — Database không ghi nhận đơn nào',
          'error',
        );
      }
      if (failedScans.length > 0 && processedCount > 0) {
        window.setTimeout(() => {
          showScanToast(
            `Bỏ qua ${failedScans.length} mã (trùng/không hợp lệ)`,
            'error',
          );
        }, 1600);
      }
      setCameraScanResult(
        `✓ DB: Xuất kho ${safeXuat} · Hủy ${safeHuy} · Nhận hoàn ${safeHoan}${
          failedScans.length ? ` · Bỏ qua ${failedScans.length}` : ''
        }. Sẵn sàng quét tiếp`,
      );
      setIsFlushingQueue(false);

      try {
        // Chỉ đọc DB nội bộ (silent) — CẤM gọi onPullShopeeOrders (đó là pull Shopee).
        if (onFetchOrders) void onFetchOrders({ silent: true });
      } catch (refreshErr) {
        console.error('Refresh orders after scan failed:', refreshErr);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showScanToast(`Lỗi ghi DB hàng loạt: ${msg}`, 'error');
      setCameraScanResult(`Lỗi: ${msg}`);
      setIsFlushingQueue(false);
      isTearingDownScannerRef.current = false;
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

  if (focusScanner) {
    const modalMeta = scanStatModal ? scanStatModalMeta[scanStatModal] : null;

    return (
      <div
        className={`fixed inset-0 bg-zinc-950 z-50 flex flex-col select-none font-sans transition-colors duration-300 ${
          cameraScanError ? 'bg-rose-950' : ''
        }`}
      >
        {/* Counters dashboard — clickable */}
        <div className="shrink-0 px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-white font-extrabold text-[10px] uppercase tracking-widest">
                Quét realtime · Verify ngay
              </span>
            </div>
            <div className="rounded-lg bg-blue-500/20 border border-blue-400/40 px-2.5 py-1">
              <span className="text-blue-300 font-black text-xs tabular-nums">
                Đã dò {totalVerifiedScans}/{continuousScanTarget || '—'}
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
            {(isFlushingQueue || isVerifyingScan) && (
              <div className="absolute inset-0 bg-black/55 backdrop-blur-[1px] flex flex-col items-center justify-center gap-3 z-10">
                <Loader2 className="w-9 h-9 text-blue-400 animate-spin" />
                <p className="text-xs font-bold text-white/90 px-4 text-center">
                  {isFlushingQueue
                    ? `Đang ghi DB ${totalVerifiedScans} đơn...`
                    : 'Đang kiểm tra mã...'}
                </p>
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
            disabled={isFlushingQueue || isVerifyingScan}
            onClick={() => setShowEndConfirm(true)}
            className="w-full min-h-14 rounded-2xl bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white font-black text-base uppercase tracking-wide transition-colors shadow-lg shadow-rose-900/40 disabled:opacity-50"
          >
            Kết thúc
            {totalVerifiedScans > 0 ? ` · Ghi DB ${totalVerifiedScans} mã` : ' · Thoát'}
          </button>
          <p className="text-center text-[10px] text-zinc-500 font-semibold">
            Kết thúc = lưu chính thức vào database · giữ nguyên màn quét sau khi lưu
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
                  ? `Sẽ ghi DB: xuất kho ${daXuatKhoList.length} · hủy ${donHuyList.length} · nhận hoàn ${daNhanHoanList.length}. Sau đó xóa list và ở lại màn quét.`
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
                  onClick={() => void handleFinishContinuousScan()}
                  className="flex-1 min-h-11 rounded-xl bg-rose-600 text-white font-bold text-sm"
                >
                  Xác nhận
                </button>
              </div>
            </div>
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
    <div className="space-y-6 max-md:space-y-4 om-orders-page">
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
              }}
              className={`px-4 py-2 bg-white hover:bg-orange-50/40 border rounded-xl text-xs font-bold transition-all flex items-center gap-2.5 shadow-xs cursor-pointer ${
                selectedPlatform === 'shopee' ? 'border-orange-500 ring-2 ring-orange-500/20 text-orange-600' : 'border-gray-200 text-gray-700'
              }`}
            >
              <span className="w-5 h-5 bg-orange-500 text-white font-extrabold text-[10px] rounded flex items-center justify-center">S</span>
              <span>Shopee ({shopeeShops.length} gian hàng)</span>
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
                      setSelectedShopId(shop.id);
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
                        setSelectedShopId(shop.id);
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
                      setSelectedShopId(shop.id);
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
            onClick={() => setShowCreateOrderPage(true)}
            className="om-orders-mobile-hide-primary-actions px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs rounded-xl shadow-md shadow-emerald-500/15 hover:shadow-emerald-500/30 transition-all flex items-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Tạo đơn hàng ngoài sàn</span>
          </button>

          <button
            onClick={() => void handleSyncOrders('incremental')}
            disabled={isSyncing}
            className="om-orders-mobile-hide-primary-actions px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-75 text-white font-extrabold text-xs rounded-xl shadow-md shadow-blue-500/15 hover:shadow-blue-500/30 transition-all flex items-center gap-2 cursor-pointer"
            title="Cập nhật đơn mới: quét đơn trong 24 giờ gần nhất (chạy ngầm)"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Cập nhật đơn mới</span>
          </button>

          <button
            onClick={() => {
              if (
                !window.confirm(
                  'Full Sync sẽ kéo lịch sử đơn trong 30 ngày qua (chạy ngầm, không khóa UI). Tiếp tục?',
                )
              ) {
                return;
              }
              void handleSyncOrders('full');
            }}
            disabled={isSyncing}
            className="om-orders-mobile-hide-primary-actions px-4 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-75 text-slate-700 font-extrabold text-xs rounded-xl border border-slate-200 transition-all flex items-center gap-2 cursor-pointer"
            title="Full Sync: kéo lịch sử đơn trong 30 ngày qua — chạy ngầm"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>Full Sync</span>
          </button>
        </div>
      </div>

      {/* Mobile: nút Cập nhật đơn mới 24 giờ (desktop dùng nút ở top bar) */}
      <div className="hidden max-md:flex items-center justify-between gap-2 px-0.5">
        <p className="text-[11px] font-semibold text-slate-500 truncate">
          {isSyncing ? 'Đã gửi đồng bộ ngầm...' : 'Đồng bộ đơn Shopee (24 giờ)'}
        </p>
        <button
          type="button"
          onClick={() => void handleSyncOrders('incremental')}
          disabled={isSyncing}
          className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2.5 min-h-11 bg-blue-600 hover:bg-blue-700 disabled:opacity-75 text-white font-extrabold text-xs rounded-xl shadow-md shadow-blue-500/20 transition-all cursor-pointer"
          title="Cập nhật đơn mới — quét 24 giờ (ngầm)"
          aria-label="Cập nhật đơn mới 24 giờ"
        >
          <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
          <span>Cập nhật đơn mới</span>
        </button>
      </div>

      {/* 2. SUB-TABS: Horizontal scrollable subtabs with counts — orders[] từ App.fetchOrders → GET /api/orders (cùng origin). Không import mock JSON. */}
      <div className="om-orders-sub-tabs border-b border-gray-200 flex flex-wrap gap-1 bg-white p-1 rounded-xl">
        <button
          onClick={() => setActiveSubTab('all')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer ${
            activeSubTab === 'all' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          Tất cả đơn hàng ({orders.length})
        </button>

        <button
          onClick={() => setActiveSubTab('pending_confirm')}
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
          onClick={() => setActiveSubTab('unprocessed')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'unprocessed' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Chờ lấy hàng (Chưa xử lý)</span>
          <span className="px-1.5 py-0.2 text-[10px] font-black rounded-full bg-rose-100 text-rose-700 border border-rose-200">
            {getCount('unprocessed')}
          </span>
        </button>

        <button
          onClick={() => setActiveSubTab('processed')}
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

        {/* ROLLBACK: tạm ẩn Tab "Đã giao cho ĐVVC" — khôi phục sync Shopee thuần
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
        */}

        <button
          onClick={() => setActiveSubTab('shipping')}
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
          onClick={() => {
            setActiveSubTab('cancel_returns');
            setCancelReturnTab('all');
          }}
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
          onClick={() => setActiveSubTab('received_cancel_returns')}
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
          onClick={() => setActiveSubTab('order_products')}
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
                  onClick={() => setCancelReturnTab(tab.id)}
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

      {activeSubTab === 'received_cancel_returns' && (
        <div className="bg-teal-50/80 border border-teal-100 rounded-2xl px-4 py-3 text-xs text-teal-900 font-semibold leading-relaxed">
          Đối soát kiện hủy/hoàn đã quét nhận về kho (cờ nội bộ{' '}
          <code className="font-mono text-[11px]">RETURN_RECEIVED</code> /{' '}
          <code className="font-mono text-[11px]">CANCELLED_STORED</code>). Tự ẩn sau 14 ngày —
          không xóa lịch sử đơn Shopee.
        </div>
      )}

      {/* 4. FILTER BOX — search + ĐVVC (ẩn trên màn sản phẩm trong đơn) */}
      {activeSubTab !== 'order_products' && (
      <div className="om-orders-filters-panel bg-white p-5 max-md:p-4 rounded-3xl border border-gray-100 shadow-xs">
        <div className="relative w-full">
          <Search className="absolute left-3.5 top-3.5 text-gray-400 w-4 h-4" />
          <input 
            type="text" 
            placeholder="Tìm kiếm theo mã đơn hàng, tên khách hàng, sản phẩm hoặc mã bưu cục..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-xs outline-none transition-all font-medium"
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
        {(activeSubTab === 'unprocessed' ||
          activeSubTab === 'processed' ||
          activeSubTab === 'cancel_returns' ||
          activeSubTab === 'received_cancel_returns') && (
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

      {/* 5. BULK ACTION BAR — chỉ giữ In đơn hàng loạt + Xác nhận đơn hàng loạt */}
      {activeSubTab !== 'order_products' && (
      <div className="om-orders-mobile-hide-bulk-bar bg-slate-50 border border-slate-200/80 p-3 max-md:p-2.5 rounded-2xl flex items-center justify-between gap-4 max-md:gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <button 
            type="button"
            onClick={handleToggleSelectAll}
            className="text-gray-500 hover:text-gray-800 transition-all cursor-pointer"
          >
            {selectedOrderIds.length === filteredOrders.length && filteredOrders.length > 0 ? (
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
            onClick={() => setFilterUnprinted((v) => !v)}
            className={`text-[11px] font-black px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer ${
              filterUnprinted
                ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
          >
            {filterUnprinted ? 'Đang lọc: Chưa in (Bấm để Hủy)' : 'Lọc đơn Chưa in'}
          </button>
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setShowBulkActionsDropdown(!showBulkActionsDropdown)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-black rounded-xl shadow-xs transition-all flex items-center gap-2 cursor-pointer"
          >
            <span>Chọn thao tác</span>
            <ChevronDown className="w-4 h-4 shrink-0" />
          </button>

          {showBulkActionsDropdown && (
            <div className="absolute right-0 bottom-11 sm:bottom-auto sm:top-11 bg-white border border-gray-100 rounded-2xl shadow-xl py-2.5 w-64 z-20 animate-in fade-in duration-100">
              <p className="px-4 py-1.5 text-[10px] uppercase font-black tracking-wider text-gray-400">Hành động hàng loạt</p>
              
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleBulkPrint(e);
                }}
                disabled={isBulkPrinting}
                className="om-mobile-hide-print w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5 disabled:opacity-50"
              >
                <Printer className={`w-4 h-4 text-blue-600 shrink-0 ${isBulkPrinting ? 'animate-spin' : ''}`} />
                <span>{isBulkPrinting ? 'Đang lấy vận đơn Shopee...' : 'In đơn hàng hàng loạt'}</span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleBulkConfirm();
                }}
                className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5"
              >
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Xác nhận đơn hàng loạt</span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleBulkHandOverCarrier(e);
                }}
                disabled={isBulkHandingOver}
                className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5 disabled:opacity-50"
              >
                <Truck className={`w-4 h-4 text-indigo-600 shrink-0 ${isBulkHandingOver ? 'animate-pulse' : ''}`} />
                <span>{isBulkHandingOver ? 'Đang giao ĐVVC hàng loạt...' : 'Giao cho ĐVVC hàng loạt'}</span>
              </button>
            </div>
          )}
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
              Tổng hợp từ đơn <strong>Chờ lấy hàng (Chưa xử lý)</strong> và <strong>Chờ lấy hàng (Đã xử lý)</strong>
            </p>
          </div>

          {aggregatedOrderProducts.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm flex flex-col items-center gap-3 px-4">
              <Package className="w-12 h-12 text-slate-200" />
              <span className="font-semibold text-slate-600">Không có sản phẩm nào cần chuẩn bị</span>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto app-wide-hide-table om-orders-table-view max-md:hidden md:block">
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

              <div className="om-order-card-list app-wide-card-grid divide-y divide-gray-100 max-md:divide-y">
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
            </>
          )}
        </div>
      ) : (
      <div className="bg-white rounded-3xl border border-gray-100 shadow-xs overflow-hidden">
        {filteredOrders.length === 0 ? (
          <div className="py-20 text-center text-gray-400 text-xs flex flex-col items-center gap-3">
            <ShoppingBag className="w-12 h-12 text-slate-200" />
            <span className="font-semibold text-slate-600">Không tìm thấy đơn hàng nào khớp với điều kiện lọc</span>
            <p className="text-[11px] text-gray-400 max-w-sm leading-relaxed">
              Hãy thay đổi bộ lọc sàn TMĐT hoặc chuyển sang các tab khác như "Chờ lấy hàng (Chưa xử lý)" để xem thêm.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto app-wide-hide-table om-orders-table-view max-md:hidden md:block">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-gray-100 text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                  <th className="p-4 w-12 text-center">
                    <input 
                      type="checkbox"
                      checked={selectedOrderIds.length === filteredOrders.length}
                      onChange={handleToggleSelectAll}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                    />
                  </th>
                  <th className="p-4 w-44">Mã vận đơn &amp; Sàn</th>
                  <th className="p-4 w-32">Ngày tạo đơn</th>
                  <th className="p-4 w-[280px]">Sản phẩm đặt mua</th>
                  <th className="p-4 text-right w-40">Tổng thanh toán</th>
                  <th className="p-4 text-center w-32">Trạng thái sàn</th>
                  <th className="p-4 text-center w-52">Xử lý đơn hàng</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredOrders.map(order => {
                  const isChecked = selectedOrderIds.includes(order.id);
                  const badgeBase = getStatusBadge(resolveOrderBadgeStatus(order)) || { text: order.status, color: '' };
                  const badge =
                    matchesHandedOverCarrierTab(order)
                      ? {
                          text: 'Đã quét QR - Chờ ĐVVC nhận',
                          color: 'bg-violet-50 text-violet-700 border-violet-200/60 font-semibold',
                        }
                      : badgeBase;
                  const isExpanded = expandedOrderId === order.id;
                  return (
                    <React.Fragment key={order.id}>
                    <tr 
                      className={`hover:bg-slate-50/40 transition-all ${isChecked ? 'bg-blue-50/20' : ''}`}
                    >
                      {/* Checkbox column */}
                      <td className="p-4 text-center">
                        <input 
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleSelectOne(order.id)}
                          className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                        />
                      </td>

                      {/* Waybill & Platform Label */}
                      <td className="p-4 space-y-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`px-2 py-0.5 text-[10px] font-bold rounded truncate max-w-[11rem] inline-block ${
                              order.channel === 'shopee'
                                ? 'bg-orange-50 text-orange-700 border border-orange-200'
                                : order.channel === 'tiktok'
                                  ? 'bg-zinc-100 text-zinc-800 border border-zinc-200'
                                  : 'bg-blue-50 text-blue-700 border border-blue-200'
                            }`}
                            title={resolveOrderShopDisplayName(order, shops)}
                          >
                            {resolveOrderShopDisplayName(order, shops)}
                          </span>
                        </div>
                        {getOrderWaybillCode(order) ? (
                          <div className="font-mono font-extrabold text-gray-900 text-sm tracking-tight flex items-center gap-1" title={getOrderWaybillCode(order)}>
                            <Barcode className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span className="truncate max-w-[160px]">{getOrderWaybillCode(order)}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400 italic font-medium">Chưa có mã vận đơn</span>
                        )}
                        <div className="text-[10px] text-gray-400 font-mono">#{order.orderSn}</div>
                      </td>

                      {/* Created Time */}
                      <td className="p-4 text-gray-500 font-medium">
                        {new Date(order.date).toLocaleDateString('vi-VN')}
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5">08:12</p>
                      </td>

                      {/* Order items list — thumbnail + full title + quantity */}
                      <td className="p-4 w-[280px]">
                        <div className="space-y-2">
                          {(order.items || []).map((item, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              {item.productImage ? (
                                <img
                                  src={item.productImage}
                                  alt={item.productTitle}
                                  className="w-10 h-10 rounded-lg object-cover border border-gray-200 shrink-0 bg-gray-50"
                                />
                              ) : (
                                <div className="w-10 h-10 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center shrink-0">
                                  <ImageIcon className="w-4 h-4 text-gray-300" />
                                </div>
                              )}
                              <div className="min-w-0">
                                <p className="text-[11px] text-gray-700 font-semibold leading-snug line-clamp-2" title={item.productTitle}>
                                  {item.productTitle}
                                </p>
                                <span className="text-[9px] bg-blue-50 text-blue-600 border border-blue-100 px-1 py-0.2 rounded font-extrabold inline-block mt-0.5">
                                  x{item.quantity}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>

                      {/* Total bill & Net Profit */}
                      <td className="p-4 text-right space-y-0.5">
                        <div className="font-black text-gray-950 text-sm">{order.totalAmount.toLocaleString('vi-VN')}đ</div>
                        <div className={`text-[10px] font-bold p-0.5 px-1.5 rounded-md inline-block ${
                          formatOrderNetRevenueDisplay(order, systemFees).pending
                            ? 'text-amber-700 bg-amber-50/80'
                            : 'text-emerald-600 bg-emerald-50/50'
                        }`}>
                          Lãi: {formatOrderNetRevenueDisplay(order, systemFees).text}
                          {formatOrderNetRevenueDisplay(order, systemFees).pending && (
                            <span className="text-[9px] font-normal text-amber-700/80 ml-0.5">*</span>
                          )}
                        </div>
                      </td>

                      {/* Status */}
                      <td className="p-4 text-center">
                        <span className={`inline-block px-2.5 py-1 text-[10px] font-bold rounded-full border ${badge.color}`}>
                          {badge.text}
                        </span>
                      </td>

                      {/* Specific Single Actions */}
                      <td className="p-4 text-center">
                        <div className="flex flex-wrap items-center justify-center gap-1.5">
                          {order.status === 'pending_confirm' && (
                            <button
                              onClick={() => {
                                const updated = orders.map(o => o.id === order.id ? { ...o, status: 'unprocessed' as const } : o);
                                onUpdateOrders(updated);
                                onAddLog({
                                  id: `log-${Date.now()}`,
                                  timestamp: new Date().toISOString(),
                                  channel: order.channel,
                                  type: 'stock_sync',
                                  status: 'success',
                                  message: `Xác nhận thành công đơn hàng #${order.orderSn}`
                                });
                              }}
                              className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-[10px] rounded-lg transition-all"
                            >
                              Xác nhận đơn
                            </button>
                          )}

                          {isShopeeReadyToShipStatus(order) && !isProcessedCondition(order) && (
                            <>
                              {!isOrderPreparedEffective(order) ? (
                                <button
                                  onClick={() => handleSinglePrepare(order)}
                                  className="om-mobile-hide-prepare px-2.5 py-1.5 bg-rose-500 hover:bg-rose-600 text-white font-bold text-[10px] rounded-lg transition-all"
                                >
                                  Chuẩn bị hàng
                                </button>
                              ) : (
                                <span className="om-mobile-hide-prepare text-[10px] text-emerald-600 font-bold bg-emerald-50 px-1.5 py-1 rounded">
                                  ✓ Đã chuẩn bị
                                </span>
                              )}

                              <button
                                type="button"
                                onClick={(e) => handlePrintButtonClick(e, order)}
                                disabled={printingOrderId === order.id}
                                className="om-mobile-hide-print p-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-500 rounded-lg transition-all disabled:opacity-60"
                                title="In phiếu giao (vận đơn thật Shopee)"
                              >
                                <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                              </button>
                            </>
                          )}

                          {(isEligibleForHandOverToCarrier(order) ||
                            (matchesProcessedPickupTab(order) && Boolean(getOrderWaybillCode(order)))) &&
                            !isOrderHandedOverToCarrier(order) && (
                            <>
                              <span className={`om-mobile-hide-print text-[10px] font-bold px-1.5 py-1 rounded ${
                                isOrderPrintedEffective(order) ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'
                              }`}>
                                {isOrderPrintedEffective(order) ? '✓ Đã in' : '✕ Chưa in'}
                              </span>
                              <button
                                type="button"
                                onClick={(e) => handlePrintButtonClick(e, order)}
                                disabled={printingOrderId === order.id}
                                className="om-mobile-hide-print p-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-500 rounded-lg transition-all disabled:opacity-60"
                                title="In lại vận đơn (vận đơn thật Shopee)"
                              >
                                <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                              </button>
                              <button
                                type="button"
                                onClick={() => void handOverOrderToCarrier(order)}
                                disabled={handingOverOrderId === order.id}
                                className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] rounded-lg transition-all disabled:opacity-60"
                              >
                                {handingOverOrderId === order.id ? 'Đang xử lý...' : 'Giao cho ĐVVC'}
                              </button>
                            </>
                          )}

                          {order.status === 'shipping' && (
                            <div className="flex gap-1">
                              <button
                                onClick={() => {
                                  const updated = orders.map(o => o.id === order.id ? { ...o, status: 'completed' as const } : o);
                                  onUpdateOrders(updated);
                                }}
                                className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-[10px] rounded"
                              >
                                Thắng
                              </button>
                              <button
                                onClick={() => {
                                  const updated = orders.map(o => o.id === order.id ? { ...o, status: 'return_pending' as const } : o);
                                  onUpdateOrders(updated);
                                }}
                                className="px-2 py-1 bg-rose-500 hover:bg-rose-600 text-white font-semibold text-[10px] rounded animate-pulse"
                              >
                                Bị Hoàn
                              </button>
                            </div>
                          )}

                          {order.status === 'return_pending' && (
                            <button
                              onClick={() => {
                                const updated = orders.map(o => o.id === order.id ? { ...o, status: 'return_received' as const } : o);
                                onUpdateOrders(updated);
                                onAddLog({
                                  id: `log-${Date.now()}`,
                                  timestamp: new Date().toISOString(),
                                  channel: order.channel,
                                  type: 'stock_sync',
                                  status: 'success',
                                  message: `Bấm nút nhận hàng hoàn trả cho đơn ${order.orderSn}.`
                                });
                              }}
                              className="px-2 py-1 bg-purple-600 hover:bg-purple-700 text-white font-bold text-[10px] rounded"
                            >
                              Nhận Hoàn
                            </button>
                          )}

                          <button
                            onClick={() => toggleOrderDetails(order.id)}
                            className={`p-1.5 rounded-lg transition-all ${isExpanded ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-100 text-gray-500'}`}
                            title={isExpanded ? 'Ẩn chi tiết đơn' : 'Xem chi tiết đơn'}
                          >
                            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-slate-50/60">
                        <td colSpan={7} className="p-0">
                          <OrderDetailAccordionPanel
                            order={order}
                            shops={shops}
                            systemFees={systemFees}
                          />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="om-order-card-list flex flex-col divide-y divide-gray-100 w-full">
            {filteredOrders.map(order => {
              const isChecked = selectedOrderIds.includes(order.id);
              const badgeBase = getStatusBadge(resolveOrderBadgeStatus(order)) || { text: order.status, color: '' };
              const badge =
                matchesHandedOverCarrierTab(order)
                  ? {
                      text: 'Đã quét QR - Chờ ĐVVC nhận',
                      color: 'bg-violet-50 text-violet-700 border-violet-200/60 font-semibold',
                    }
                  : badgeBase;
              const isExpanded = expandedOrderId === order.id;
              return (
                <div
                  key={order.id}
                  className={`w-full transition-colors ${isChecked ? 'bg-blue-50/20' : 'bg-white'}`}
                >
                <div className="om-order-card-row flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4 p-4 w-full">
                  <div className="flex items-center gap-2 shrink-0 lg:min-w-[11rem]">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleToggleSelectOne(order.id)}
                      className="om-mobile-hide-checkbox w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span
                          className={`px-2 py-0.5 text-[10px] font-bold rounded truncate max-w-44 inline-block shrink-0 ${
                            order.channel === 'shopee'
                              ? 'bg-orange-50 text-orange-700 border border-orange-200'
                              : order.channel === 'tiktok'
                                ? 'bg-zinc-100 text-zinc-800 border border-zinc-200'
                                : 'bg-blue-50 text-blue-700 border border-blue-200'
                          }`}
                          title={resolveOrderShopDisplayName(order, shops)}
                        >
                          {resolveOrderShopDisplayName(order, shops)}
                        </span>
                      </div>
                      {getOrderWaybillCode(order) ? (
                        <p className="font-mono font-extrabold text-gray-900 text-sm truncate mt-0.5 flex items-center gap-1" title={getOrderWaybillCode(order)}>
                          <Barcode className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                          <span className="truncate">{getOrderWaybillCode(order)}</span>
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 italic font-medium mt-0.5">Chưa có mã vận đơn</p>
                      )}
                      <p className="text-[10px] text-gray-400 font-mono mt-0.5">#{order.orderSn}</p>
                      <p className="text-[11px] text-gray-500 font-medium mt-0.5">
                        {new Date(order.date).toLocaleDateString('vi-VN')}
                      </p>
                      <button
                        type="button"
                        onClick={() => toggleOrderDetails(order.id)}
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
                    <div className="space-y-2">
                      {(order.items || []).map((item, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          {item.productImage ? (
                            <img
                              src={item.productImage}
                              alt={item.productTitle}
                              className="w-10 h-10 rounded-lg object-cover border border-gray-200 shrink-0 bg-gray-50"
                            />
                          ) : (
                            <div className="w-10 h-10 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center shrink-0">
                              <ImageIcon className="w-4 h-4 text-gray-300" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0 flex justify-between items-start gap-2">
                            <span className="truncate text-[11px] font-medium leading-tight text-gray-700">{item.productTitle}</span>
                            <span className="text-blue-600 text-xs shrink-0 font-black">x{item.quantity}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 lg:gap-4 shrink-0 lg:ml-auto">
                    <div className="flex flex-col gap-2">
                      <div className="text-xs">
                        <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Tổng thanh toán</span>
                        <span className="font-black text-slate-900 text-sm whitespace-nowrap">{order.totalAmount.toLocaleString('vi-VN')} đ</span>
                      </div>
                      <div className="text-xs">
                        <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Tổng nhận được</span>
                        <span className={`font-black text-sm whitespace-nowrap ${
                          formatOrderNetRevenueDisplay(order, systemFees).pending ? 'text-amber-700' : 'text-emerald-700'
                        }`}>
                          {formatOrderNetRevenueDisplay(order, systemFees).text}
                          {formatOrderNetRevenueDisplay(order, systemFees).pending && (
                            <span className="block text-[9px] font-medium text-amber-600/90 mt-0.5">Chưa gồm phí Shopee</span>
                          )}
                        </span>
                      </div>
                    </div>

                    <span className={`inline-block px-2 py-0.5 text-[9px] font-black rounded-full border shrink-0 ${badge.color}`}>
                      {badge.text}
                    </span>

                    <div className="flex items-center gap-1 flex-wrap justify-end">
                      {order.status === 'pending_confirm' && (
                        <button
                          onClick={() => {
                            const updated = orders.map(o => o.id === order.id ? { ...o, status: 'unprocessed' as const } : o);
                            onUpdateOrders(updated);
                            onAddLog({
                              id: `log-${Date.now()}`,
                              timestamp: new Date().toISOString(),
                              channel: order.channel,
                              type: 'stock_sync',
                              status: 'success',
                              message: `Xác nhận thành công đơn hàng #${order.orderSn}`
                            });
                          }}
                          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all"
                        >
                          Xác nhận đơn
                        </button>
                      )}

                      {isShopeeReadyToShipStatus(order) && !isProcessedCondition(order) && (
                        <>
                          {!isOrderPreparedEffective(order) ? (
                            <button
                              onClick={() => handleSinglePrepare(order)}
                              className="om-mobile-hide-prepare min-h-11 px-3 py-2 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all"
                            >
                              Chuẩn bị hàng
                            </button>
                          ) : (
                            <span className="om-mobile-hide-prepare text-[11px] text-emerald-600 font-black bg-emerald-50 px-2.5 py-1 rounded-xl border border-emerald-100">
                              ✓ Đã soạn
                            </span>
                          )}

                          <button
                            type="button"
                            onClick={(e) => handlePrintButtonClick(e, order)}
                            disabled={printingOrderId === order.id}
                            className="om-order-card-print-btn om-mobile-hide-print min-h-11 min-w-11 p-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-xl transition-all disabled:opacity-60 flex items-center justify-center"
                            title="In phiếu giao (vận đơn thật Shopee)"
                          >
                            <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                          </button>
                        </>
                      )}

                      {(isEligibleForHandOverToCarrier(order) ||
                        (matchesProcessedPickupTab(order) && Boolean(getOrderWaybillCode(order)))) &&
                        !isOrderHandedOverToCarrier(order) && (
                        <>
                          <span className={`om-mobile-hide-print text-[11px] font-black px-2.5 py-1 rounded-xl border ${
                            isOrderPrintedEffective(order) ? 'text-emerald-600 bg-emerald-50 border-emerald-100' : 'text-rose-600 bg-rose-50 border-rose-100'
                          }`}>
                            {isOrderPrintedEffective(order) ? '✓ Đã in' : '✕ Chưa in'}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => handlePrintButtonClick(e, order)}
                            disabled={printingOrderId === order.id}
                            className="om-order-card-print-btn om-mobile-hide-print min-h-11 min-w-11 p-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-xl transition-all disabled:opacity-60 flex items-center justify-center"
                            title="In lại vận đơn (vận đơn thật Shopee)"
                          >
                            <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handOverOrderToCarrier(order)}
                            disabled={handingOverOrderId === order.id}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all disabled:opacity-60"
                          >
                            {handingOverOrderId === order.id ? 'Đang xử lý...' : 'Giao cho ĐVVC'}
                          </button>
                        </>
                      )}

                      {order.status === 'shipping' && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => {
                              const updated = orders.map(o => o.id === order.id ? { ...o, status: 'completed' as const } : o);
                              onUpdateOrders(updated);
                            }}
                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-[11px] rounded-lg shadow-xs"
                          >
                            Thắng
                          </button>
                          <button
                            onClick={() => {
                              const updated = orders.map(o => o.id === order.id ? { ...o, status: 'return_pending' as const } : o);
                              onUpdateOrders(updated);
                            }}
                            className="px-2.5 py-1 bg-rose-500 hover:bg-rose-600 text-white font-extrabold text-[11px] rounded-lg shadow-xs"
                          >
                            Bị Hoàn
                          </button>
                        </div>
                      )}

                      {order.status === 'return_pending' && (
                        <button
                          onClick={() => {
                            const updated = orders.map(o => o.id === order.id ? { ...o, status: 'return_received' as const } : o);
                            onUpdateOrders(updated);
                            onAddLog({
                              id: `log-${Date.now()}`,
                              timestamp: new Date().toISOString(),
                              channel: order.channel,
                              type: 'stock_sync',
                              status: 'success',
                              message: `Bấm nút nhận hàng hoàn trả cho đơn ${order.orderSn}.`
                            });
                          }}
                          className="px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white font-extrabold text-xs rounded-xl shadow-xs"
                        >
                          Nhận Hoàn
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {isExpanded && (
                  <OrderDetailAccordionPanel
                    order={order}
                    shops={shops}
                    systemFees={systemFees}
                  />
                )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
      )}

      {/* Sync/tab loading: KHÔNG dùng blocking modal — chỉ toast (xem toastMessage).
          Overlay dưới đây chỉ cho ship_order / in vận đơn (progressMessage). */}
      {progressMessage && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-xs flex items-center justify-center p-4 z-100 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-sm w-full p-8 shadow-2xl flex flex-col items-center gap-4 text-center">
            {progressDone ? (
              <CheckCircle2 className="w-10 h-10 text-emerald-600" />
            ) : (
              <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
            )}
            {progressTotal > 0 && (
              <p className={`text-2xl font-black tabular-nums ${progressDone ? 'text-emerald-700' : 'text-blue-700'}`}>
                {progressCompleted}/{progressTotal}
              </p>
            )}
            <p className="text-sm font-extrabold text-gray-800 leading-relaxed">{progressMessage}</p>
            <p className="text-[11px] text-gray-400 font-semibold">
              {progressDone ? 'Modal sẽ tự đóng sau vài giây...' : 'Vui lòng không bấm liên tục — hệ thống đang xử lý phía sau.'}
            </p>
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
                  <h3 className="text-sm font-bold">Xác nhận đơn hàng</h3>
                  <p className="text-[10px] text-slate-400">
                    Chọn phương thức giao vận cho {shipConfirmOrders.length} đơn hàng {shipConfirmOrders.length === 1 ? `#${shipConfirmOrders[0].orderSn}` : 'đã chọn'}
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

            <div className="p-5 space-y-3">
              <button
                onClick={() => setShipMethod('pickup')}
                disabled={isShipping}
                className={`w-full text-left p-4 rounded-2xl border-2 transition-all flex items-start gap-3 ${shipMethod === 'pickup' ? 'border-blue-600 bg-blue-50' : 'border-gray-100 hover:border-gray-200'}`}
              >
                <div className={`w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 ${shipMethod === 'pickup' ? 'border-blue-600' : 'border-gray-300'}`}>
                  {shipMethod === 'pickup' && <div className="w-2.5 h-2.5 rounded-full bg-blue-600"></div>}
                </div>
                <div>
                  <p className="text-xs font-black text-gray-800">Lấy hàng (Pickup)</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">Đơn vị vận chuyển sẽ đến lấy hàng tại địa chỉ shop. Hệ thống tự động lấy lịch hẹn lấy hàng khả dụng gần nhất từ Shopee.</p>
                </div>
              </button>

              <button
                onClick={() => setShipMethod('dropoff')}
                disabled={isShipping}
                className={`w-full text-left p-4 rounded-2xl border-2 transition-all flex items-start gap-3 ${shipMethod === 'dropoff' ? 'border-blue-600 bg-blue-50' : 'border-gray-100 hover:border-gray-200'}`}
              >
                <div className={`w-5 h-5 mt-0.5 rounded-full border-2 flex items-center justify-center shrink-0 ${shipMethod === 'dropoff' ? 'border-blue-600' : 'border-gray-300'}`}>
                  {shipMethod === 'dropoff' && <div className="w-2.5 h-2.5 rounded-full bg-blue-600"></div>}
                </div>
                <div>
                  <p className="text-xs font-black text-gray-800">Tự mang hàng ra bưu cục (Dropoff)</p>
                  <p className="text-[11px] text-gray-500 mt-0.5">Bạn tự mang hàng ra bưu cục/điểm gửi gần nhất của đơn vị vận chuyển để gửi hàng.</p>
                </div>
              </button>

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
                onClick={confirmShipOrders}
                disabled={isShipping}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center gap-1.5 disabled:opacity-60"
              >
                {isShipping && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isShipping ? 'Đang gọi API vận chuyển...' : 'Xác nhận'}</span>
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
