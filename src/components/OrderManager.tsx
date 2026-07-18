import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  startLiveQrScanner,
  stopTapToFocusAssist,
  CAMERA_TAP_LAYER_ID,
  HTTPS_CAMERA_MESSAGE,
  type LiveQrScannerHandle,
} from '../utils/cameraScanner';
import { findOrderByScanPayload, lookupOrderByScanCode, scanFeedback, isLikelyTrackingCode, buildOrderScanIndex, normalizeOrderScanKey } from '../utils/orderScan';
import {
  isOrderHandedOverToCarrier,
  matchesHandedOverCarrierTab,
  matchesProcessedPickupTab,
  isOrderAwaitingCarrierPickup,
} from '../utils/orderHandover';
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
  Sparkles, 
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
import { Order, ConnectedShop, SyncLog, Product } from '../types';
import ManualOrderPage from './ManualOrderPage';
import { resolveBackendFileUrl, resolveLabelFetchUrl, parseJsonResponse, readResponseJson, base64ToPdfBlob } from '../utils/apiClient';
import { aggregateOrderProducts } from '../utils/aggregateOrderProducts';
import { getCarrierWaybillDisplay } from '../utils/orderTracking';
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
  return getCarrierWaybillDisplay(order);
}

function withGlobalPackagingCost(order: Order, packagingCostPerOrder: number): Order {
  return { ...order, custom_costs: Math.max(0, Number(packagingCostPerOrder) || 0), custom_cost_items: [] };
}

function formatOrderNetRevenueDisplay(order: Order, packagingCostPerOrder = 0): { text: string; pending: boolean } {
  const amount = getShopeeNetRevenue(withGlobalPackagingCost(order, packagingCostPerOrder));
  const pending = order.channel === 'shopee' && !isShopeeEscrowSynced(order);
  return { text: `${amount.toLocaleString('vi-VN')}đ`, pending };
}

function OrderShopeeFinanceSummary({
  order,
  packagingCostPerOrder,
}: {
  order: Order;
  packagingCostPerOrder: number;
}) {
  const fees = order.shopee_fees;
  const commissionFee = Math.max(0, Number(fees?.commission_fee) || 0);
  const serviceFee = Math.max(0, Number(fees?.service_fee) || 0);
  const transactionFee = getShopeeTransactionFee(fees);
  const taxTotal = getShopeeTaxTotal(fees, order);
  const surchargeTotal = computeShopeeSurchargeTotal(fees);
  const packagingCost = Math.max(0, Number(packagingCostPerOrder) || 0);
  const calculatedOrder = withGlobalPackagingCost(order, packagingCost);
  const netRevenue = getShopeeNetRevenue(calculatedOrder);
  const itemAmount = getShopeeItemAmount(order);
  const escrowReady = order.channel !== 'shopee' || isShopeeEscrowSynced(order);
  const estimatedHint = !escrowReady
    ? order.finance_source === 'estimated_api'
      ? ' (Ước tính từ Shopee)'
      : ' (Ước tính theo tỷ lệ mặc định)'
    : '';

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
        {packagingCost > 0 && (
          <div className="flex justify-between text-amber-600">
            <span>Chi phí vận hành/đóng gói (Tự động):</span>
            <span className="font-bold">-{packagingCost.toLocaleString('vi-VN')}đ</span>
          </div>
        )}
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
      <div className="space-y-1.5">
        <div className="flex justify-between text-rose-600 font-bold">
          <span>Phụ phí Shopee{estimatedHint}</span>
          <span>-{surchargeTotal.toLocaleString('vi-VN')}đ</span>
        </div>
        <div className="pl-3 space-y-1 border-l-2 border-rose-100 text-rose-500">
          <div className="flex justify-between gap-2">
            <span>Phí cố định:</span>
            <span className="font-semibold text-right">
              -{commissionFee.toLocaleString('vi-VN')}đ
              {!escrowReady && commissionFee === 0 && <span className="block text-[10px] text-gray-400 font-normal">Chờ chi tiết từ Shopee</span>}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Phí dịch vụ:</span>
            <span className="font-semibold text-right">
              -{serviceFee.toLocaleString('vi-VN')}đ
              {!escrowReady && serviceFee === 0 && <span className="block text-[10px] text-gray-400 font-normal">Chờ chi tiết từ Shopee</span>}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span>Phí xử lý giao dịch:</span>
            <span className="font-semibold text-right">
              -{transactionFee.toLocaleString('vi-VN')}đ
              {!escrowReady && transactionFee === 0 && <span className="block text-[10px] text-gray-400 font-normal">Chờ chi tiết từ Shopee</span>}
            </span>
          </div>
        </div>
      </div>
      <div className="flex justify-between text-rose-500 gap-2">
        <span>Thuế:</span>
        <span className="font-semibold text-right">
          -{taxTotal.toLocaleString('vi-VN')}đ
          {!escrowReady && taxTotal === 0 && <span className="block text-[10px] text-gray-400 font-normal">Chờ chi tiết từ Shopee</span>}
        </span>
      </div>
      {packagingCost > 0 && (
        <div className="flex justify-between text-amber-600 pt-2 border-t border-dashed border-gray-200">
          <span>Chi phí vận hành/đóng gói (Tự động):</span>
          <span className="font-bold">-{packagingCost.toLocaleString('vi-VN')}đ</span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-emerald-600 pt-1.5 border-t border-dashed border-gray-200 text-sm">
        <span className="font-bold">Doanh thu Nhận Về:</span>
        <div className="text-right">
          <span className="font-extrabold">{netRevenue.toLocaleString('vi-VN')}đ</span>
          {!escrowReady && <span className="block text-[10px] text-amber-600 font-semibold mt-0.5">Đang dùng phí Shopee ước tính</span>}
        </div>
      </div>
    </>
  );
}

function OrderDetailAccordionPanel({
  order,
  shops,
  packagingCostPerOrder,
}: {
  order: Order;
  shops: ConnectedShop[];
  packagingCostPerOrder: number;
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

      {getCarrierWaybillDisplay(order) && (
        <div className="bg-white p-4 rounded-2xl border border-gray-100">
          <div className="flex items-center gap-2 text-xs">
            <Barcode className="w-4 h-4 text-indigo-500 shrink-0" />
            <div>
              <span className="text-gray-400">Mã vận đơn:</span>{' '}
              <strong className="text-gray-800 font-mono">{getCarrierWaybillDisplay(order)}</strong>
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
        <OrderShopeeFinanceSummary order={order} packagingCostPerOrder={packagingCostPerOrder} />
      </div>
    </div>
  );
}

interface OrderManagerProps {
  orders: Order[];
  onUpdateOrders: (orders: Order[]) => void;
  /** Kéo đơn từ Shopee API (nặng) — dùng cho nút đồng bộ thủ công */
  onRefreshOrders?: () => Promise<void> | void;
  /** Chỉ đọc lại orders từ DB local — dùng sau xác nhận/in đơn để không ghi đè trạng thái */
  onFetchOrders?: () => Promise<void> | void;
  ordersLoading?: boolean;
  shops: ConnectedShop[];
  packagingCostPerOrder?: number;
  onAddLog: (log: SyncLog) => void;
  products?: Product[];
  onUpdateProduct?: (updated: Product) => void;
  focusScanner?: boolean;
  onCloseScanner?: () => void;
  onEndScanSession?: () => void;
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
  | 'order_products'
  | 'reprint';

type CancelReturnTab = 'all' | 'refund_return' | 'cancelled' | 'failed_delivery';

const CANCEL_RETURN_STATUSES: Order['status'][] = ['cancelled', 'return_pending', 'return_received'];

function isCancelReturnOrder(order: Order): boolean {
  return CANCEL_RETURN_STATUSES.includes(order.status);
}

function matchesCancelReturnTab(order: Order, tab: CancelReturnTab): boolean {
  if (!isCancelReturnOrder(order)) return false;
  switch (tab) {
    case 'all':
      return true;
    case 'refund_return':
      return order.status === 'return_received';
    case 'cancelled':
      return order.status === 'cancelled';
    case 'failed_delivery':
      return order.status === 'return_pending';
    default:
      return false;
  }
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
  onRefreshOrders,
  onFetchOrders,
  ordersLoading = false,
  shops, 
  packagingCostPerOrder = 0,
  onAddLog, 
  products = [], 
  onUpdateProduct,
  focusScanner = false,
  onCloseScanner,
  onEndScanSession
}: OrderManagerProps) {
  const [activeSubTab, setActiveSubTab] = useState<OrderTab>('unprocessed');
  const [cancelReturnTab, setCancelReturnTab] = useState<CancelReturnTab>('all');
  
  // Camera Barcode Scanning States and Ref
  const [cameraScanResult, setCameraScanResult] = useState<string>('Đang chờ quét mã QR...');
  const [cameraScanSuccess, setCameraScanSuccess] = useState<boolean>(false);
  const [cameraScanError, setCameraScanError] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string>('');
  const [cameraRestartKey, setCameraRestartKey] = useState(0);
  const lastQrScanRef = React.useRef({ key: '', at: 0 });

  const [sessionStats, setSessionStats] = useState({ shipped: 0, cancelDetected: 0, returnReceived: 0 });
  const [scanToast, setScanToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  /** Hàng đợi mã QR — chỉ xử lý khi bấm Kết thúc. */
  const [scanQueue, setScanQueue] = useState<Array<{ id: string; code: string; at: number }>>([]);
  const [isFlushingQueue, setIsFlushingQueue] = useState(false);

  const ordersRef = React.useRef(orders);
  const applyScanRef = React.useRef<(query: string) => void>(() => {});
  const enqueueScanRef = React.useRef<(query: string) => void>(() => {});
  const isScanBusyRef = React.useRef(false);
  const scanQueueRef = React.useRef(scanQueue);
  const orderScanIndex = useMemo(() => buildOrderScanIndex(orders), [orders]);
  const continuousScanTarget = useMemo(
    () =>
      orders.filter((o) =>
        ['unprocessed', 'processed', 'cancelled', 'return_pending'].includes(o.status)
      ).length,
    [orders]
  );

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    scanQueueRef.current = scanQueue;
  }, [scanQueue]);

  const showScanToast = (text: string, type: 'success' | 'error') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2800);
  };

  const applyHandoverToLocalOrders = React.useCallback(
    (updatedOrder: Order) => {
      const merged = ordersRef.current.map((o) =>
        o.id === updatedOrder.id ? { ...o, ...updatedOrder } : o
      );
      ordersRef.current = merged;
      onUpdateOrders(merged);
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
      if (!isOrderAwaitingCarrierPickup(order)) {
        showScanToast(`Đơn #${order.orderSn} không ở trạng thái chờ lấy hàng.`, 'error');
        return false;
      }
      if (isOrderHandedOverToCarrier(order)) {
        if (opts?.switchTab !== false) setActiveSubTab('handed_over_carrier');
        showScanToast(`Đơn #${order.orderSn} đã ghi nhận giao cho ĐVVC trước đó.`, 'success');
        return true;
      }
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(order.id)}/hand-over-carrier`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
        }
        const saved = (data?.order || data) as Order;
        applyHandoverToLocalOrders({ ...order, ...saved, isHandedOverToCarrier: true, is_handed_over_to_carrier: true });
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
        if (opts?.switchTab !== false) setActiveSubTab('handed_over_carrier');
        showScanToast(`Đã giao cho ĐVVC — đơn #${order.orderSn}`, 'success');
        return true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        showScanToast(`Không ghi nhận bàn giao: ${msg}`, 'error');
        return false;
      }
    },
    [applyHandoverToLocalOrders, onAddLog]
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

        if (order.status === 'unprocessed' || order.status === 'processed') {
          const ok = await handOverOrderToCarrier(order, { fromScan: true });
          if (ok) {
            setSessionStats((s) => ({ ...s, shipped: s.shipped + 1 }));
            scanFeedback('success');
            setCameraScanError(false);
            setCameraScanSuccess(true);
          setCameraScanResult(`✓ Giao ĐVVC #${order.orderSn}`);
          setTimeout(() => setCameraScanSuccess(false), 2000);
          } else {
            scanFeedback('error');
            setCameraScanSuccess(false);
            setCameraScanError(true);
            setTimeout(() => setCameraScanError(false), 2000);
          }
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
          setSessionStats((s) => ({
            ...s,
            cancelDetected: isCancelRequest ? s.cancelDetected + 1 : s.cancelDetected,
            returnReceived: s.returnReceived + 1,
          }));
          scanFeedback('success');
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
          pending_verification: 'Đang được kiểm tra bởi Shopee',
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

  /** Continuous mode: chỉ xếp hàng đợi + bíp/rung — không xử lý đơn, không khóa camera. */
  const enqueueContinuousScan = React.useCallback((rawQuery: string) => {
    const trimmed = String(rawQuery || '').trim();
    if (!trimmed || isFlushingQueue) return;

    const key = normalizeOrderScanKey(trimmed);
    if (!key) return;

    const now = Date.now();
    if (
      key === lastQrScanRef.current.key &&
      now - lastQrScanRef.current.at < 1200
    ) {
      return;
    }
    lastQrScanRef.current = { key, at: now };

    if (scanQueueRef.current.some((q) => normalizeOrderScanKey(q.code) === key)) {
      scanFeedback('error');
      setCameraScanError(true);
      setCameraScanSuccess(false);
      setCameraScanResult(`Đã có trong hàng đợi: ${trimmed}`);
      window.setTimeout(() => setCameraScanError(false), 700);
      return;
    }

    const item = { id: `sq-${now}-${Math.random().toString(36).slice(2, 7)}`, code: trimmed, at: now };
    const next = [item, ...scanQueueRef.current];
    scanQueueRef.current = next;
    setScanQueue(next);
    scanFeedback('success');
    setCameraScanError(false);
    setCameraScanSuccess(true);
    setCameraScanResult(`✓ Đã xếp hàng #${next.length}: ${trimmed}`);
    window.setTimeout(() => setCameraScanSuccess(false), 450);
  }, [isFlushingQueue]);

  useEffect(() => {
    enqueueScanRef.current = enqueueContinuousScan;
  }, [enqueueContinuousScan]);

  useEffect(() => {
    const scannerRef = { current: null as LiveQrScannerHandle | null };
    let isMounted = true;

    if (focusScanner) {
      setCameraScanResult('Chế độ quét liên tục — sẵn sàng...');
      setCameraScanSuccess(false);
      setCameraScanError(false);
      setCameraError('');
      lastQrScanRef.current = { key: '', at: 0 };
      scanQueueRef.current = [];
      setScanQueue([]);
      setIsFlushingQueue(false);

      const timer = setTimeout(() => {
        if (!isMounted) return;

        const element = document.getElementById('camera-reader');
        if (!element) {
          console.error('camera-reader element not found');
          setCameraError('Không tìm thấy vùng hiển thị camera.');
          return;
        }

        const qrCodeSuccessCallback = (decodedText: string) => {
          if (!decodedText?.trim()) return;
          // Continuous: xếp hàng đợi ngay — không await backend, không đóng camera.
          enqueueScanRef.current(decodedText);
        };

        void startLiveQrScanner({
          containerId: 'camera-reader',
          tapLayerId: CAMERA_TAP_LAYER_ID,
          onSuccess: qrCodeSuccessCallback,
        })
          .then((handle) => {
            if (!isMounted) {
              void handle.stop();
              return;
            }
            scannerRef.current = handle;
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
        stopTapToFocusAssist(CAMERA_TAP_LAYER_ID);
        void scannerRef.current?.stop().catch((err) => console.error('Error stopping QR scanner', err));
      };
    }

    return () => {
      isMounted = false;
    };
  }, [focusScanner, cameraRestartKey]);

  // Platform filtering & dropdown states
  const [selectedPlatform, setSelectedPlatform] = useState<'all' | 'shopee' | 'tiktok' | 'lazada' | 'woocommerce' | 'manual'>('all');
  const [selectedShopId, setSelectedShopId] = useState<string>('all');
  const [showShopeeDropdown, setShowShopeeDropdown] = useState(false);
  const [showTikTokDropdown, setShowTikTokDropdown] = useState(false);
  const [showWooDropdown, setShowWooDropdown] = useState(false);
  
  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSort] = useState<'newest' | 'oldest' | 'highest_value'>('newest');

  // Multi-select bulk state
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [showBulkActionsDropdown, setShowBulkActionsDropdown] = useState(false);

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

  const [reprintOrderSn, setReprintOrderSn] = useState('');
  const [isReprintSearching, setIsReprintSearching] = useState(false);

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

  const beginPdfOpenSession = (sessionKey: string): boolean => {
    if (pdfOpenSessionRef.current) return false;
    pdfOpenSessionRef.current = true;
    lastOpenedPdfKeyRef.current = sessionKey;
    releasePdfOpenSession();
    return true;
  };

  const triggerPdfDownload = (href: string, filename: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const openPdfBlobInNewTab = (blob: Blob, filename = 'van-don-shopee.pdf') => {
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
    if (!win) {
      triggerPdfDownload(blobUrl, filename);
      showToast('Trình duyệt chặn popup — đã tải vận đơn PDF về máy.');
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      return;
    }
    showToast('Đã mở vận đơn Shopee — bấm In trên trình xem PDF.');
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 120_000);
  };

  /** Mở PDF — khóa phiên trước mọi await; không dùng anchor target=_blank (tránh tab thứ 2). */
  const openShopeeLabelFromStream = async (opts: {
    pdfBase64?: string | null;
    pdfFilename?: string | null;
    url?: string | null;
  }) => {
    const sessionKey =
      (opts.url && String(opts.url).trim()) ||
      (opts.pdfBase64 ? `b64:${opts.pdfBase64.slice(0, 48)}` : '');
    if (!sessionKey || !beginPdfOpenSession(sessionKey)) return;

    const filename = opts.pdfFilename || 'van-don-shopee.pdf';

    if (opts.url) {
      const fullUrl = resolveLabelFetchUrl(opts.url);
      const resolvedFilename = (decodeURIComponent(fullUrl.split('/').pop() || filename)).replace(/\?.*$/, '');

      if (/^https?:\/\//i.test(fullUrl)) {
        const win = window.open(fullUrl, '_blank', 'noopener,noreferrer');
        if (win) {
          showToast('Đã mở vận đơn — bấm In trên trình xem PDF.');
          return;
        }
        triggerPdfDownload(fullUrl, resolvedFilename);
        showToast('Trình duyệt chặn popup — đã tải vận đơn PDF về máy.');
        return;
      }

      try {
        let res = await fetch(fullUrl, { credentials: 'same-origin' });
        if (!res.ok && fullUrl.startsWith('/api/labels/')) {
          const altUrl = resolveBackendFileUrl(opts.url);
          if (altUrl !== fullUrl) res = await fetch(altUrl, { credentials: 'same-origin' });
        }
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          showToast(`Không lấy được vận đơn (HTTP ${res.status}). ${errText.slice(0, 80) || 'Thử lại sau vài giây.'}`);
          return;
        }
        const buf = await res.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 4));
        const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
        if (!isPdf) {
          showToast('File vận đơn không hợp lệ (backend trả HTML thay vì PDF).');
          return;
        }
        openPdfBlobInNewTab(new Blob([buf], { type: 'application/pdf' }), resolvedFilename);
      } catch {
        triggerPdfDownload(fullUrl, resolvedFilename);
        showToast('Không mở được tab xem PDF — đã tải vận đơn về máy.');
      }
      return;
    }

    if (opts.pdfBase64) {
      openPdfBlobInNewTab(base64ToPdfBlob(opts.pdfBase64), filename);
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
    mergedUrl?: string;
    pdfBase64?: string;
    pdfFilename?: string;
    documents?: { url?: string; message?: string; error?: string }[];
    orders?: Order[];
    error?: string;
  };

  const fetchPrintDocumentApi = async (orderIds: string[]): Promise<{
    ok: boolean;
    status: number;
    data: PrintDocumentResponse;
  }> => {
    const res = await fetch('/api/shopee/print-document', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ orderIds }),
    });
    const data = await parseJsonResponse<PrintDocumentResponse>(res);
    return { ok: res.ok, status: res.status, data };
  };
  const applyPrintDocumentResponse = async (
    data: PrintDocumentResponse,
    openPdf: boolean
  ): Promise<{ success: boolean; message?: string; mergedUrl?: string | null }> => {
    const failedDocs = (data.documents || []).filter((d) => !d.url);
    const printUrl = data.mergedUrl || (data.documents || []).find((d) => d.url)?.url;

    if (Array.isArray(data.orders)) {
      onUpdateOrders(data.orders);
    }

    if (openPdf) {
      if (printUrl) {
        await openShopeeLabelFromStream({ url: printUrl, pdfFilename: data.pdfFilename });
      } else if (data.pdfBase64) {
        await openShopeeLabelFromStream({
          pdfBase64: data.pdfBase64,
          pdfFilename: data.pdfFilename,
        });
      }
    }

    if (printUrl) {
      if (failedDocs.length > 0) {
        return {
          success: true,
          mergedUrl: printUrl,
          message: `Một số đơn lỗi: ${failedDocs.map((d) => d.message || d.error).join('; ')}`,
        };
      }
      return { success: true, mergedUrl: printUrl };
    }

    if (data.pdfBase64) {
      if (failedDocs.length > 0) {
        return {
          success: true,
          message: `Một số đơn lỗi: ${failedDocs.map((d) => d.message || d.error).join('; ')}`,
        };
      }
      return { success: true };
    }

    const detail = failedDocs.map((d) => d.message || d.error).filter(Boolean).join('\n');
    return { success: false, message: detail || 'Shopee chưa trả về file vận đơn PDF.' };
  };

  // Shopee: create → poll → download NORMAL_AIR_WAYBILL PDF, mở tab mới (không ép window.print).
  const printShopeeDocuments = async (
    orderIds: string[],
    options: { openPdf?: boolean; onProgress?: (completed: number, total: number) => void } = {}
  ): Promise<{ success: boolean; message?: string; mergedUrl?: string | null }> => {
    const { openPdf = true, onProgress } = options;
    const uniqueIds = [...new Set(orderIds.map(String).filter(Boolean))];
    if (uniqueIds.length === 0) {
      return { success: false, message: 'Không có đơn hàng để in.' };
    }

    const total = uniqueIds.length;

    try {
      if (onProgress) onProgress(0, total);

      // Tuần tự từng đơn để cập nhật tiến trình; cache từng PDF trước khi gộp/mở.
      if (total > 1 && onProgress) {
        const stepErrors: string[] = [];
        const stepUrls: string[] = [];

        for (let i = 0; i < uniqueIds.length; i++) {
          try {
            const step = await fetchPrintDocumentApi([uniqueIds[i]]);
            if (!step.ok) {
              stepErrors.push(step.data.error || `Đơn ${uniqueIds[i]}: lỗi HTTP ${step.status}`);
            } else {
              const stepResult = await applyPrintDocumentResponse(step.data, false);
              if (stepResult.mergedUrl) stepUrls.push(stepResult.mergedUrl);
              if (!stepResult.success && stepResult.message) stepErrors.push(stepResult.message);
            }
          } catch (stepErr) {
            stepErrors.push(stepErr instanceof Error ? stepErr.message : `Đơn ${uniqueIds[i]}: lỗi không xác định`);
          }
          onProgress(i + 1, total);
        }

        try {
          const final = await fetchPrintDocumentApi(uniqueIds);
          if (final.ok) {
            const result = await applyPrintDocumentResponse(final.data, openPdf);
            if (stepErrors.length > 0 && result.success) {
              return { ...result, message: stepErrors.join('; ') };
            }
            return result;
          }
          stepErrors.push(final.data.error || 'Không thể gộp vận đơn Shopee.');
        } catch (mergeErr) {
          stepErrors.push(mergeErr instanceof Error ? mergeErr.message : 'Lỗi gộp vận đơn.');
        }

        const fallbackUrl = stepUrls[stepUrls.length - 1] || null;
        if (fallbackUrl && openPdf) {
          await openShopeeLabelFromStream({ url: fallbackUrl });
          return {
            success: true,
            mergedUrl: fallbackUrl,
            message: stepErrors.length > 0 ? stepErrors.join('; ') : undefined,
          };
        }

        return { success: false, message: stepErrors.join('; ') || 'Không thể tạo vận đơn Shopee.' };
      }

      const { ok, status, data } = await fetchPrintDocumentApi(uniqueIds);
      if (!ok) {
        return { success: false, message: data.error || `Không thể tạo vận đơn Shopee (HTTP ${status}).` };
      }

      if (onProgress) onProgress(total, total);
      return applyPrintDocumentResponse(data, openPdf);
    } catch (err) {
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
    opts?: { markPrinted?: boolean }
  ): Order[] =>
    baseOrders.map((o) =>
      queuedKeys.has(o.id) || queuedKeys.has(o.orderSn) || queuedKeys.has(`shopee-${o.orderSn}`)
        ? {
            ...o,
            status: 'processed' as const,
            isPrepared: true,
            ...(opts?.markPrinted ? { isPrinted: true } : {}),
          }
        : o
    );

  const refreshOrdersAfterShip = async (queuedOrders: Order[], opts?: { markPrinted?: boolean }) => {
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
          setProgressMessage(`Đã xác nhận ${job.successCount || job.completed}/${job.total} đơn — đang tạo vận đơn PDF...`);
        } else if (job.status === 'running' || job.status === 'pending') {
          setProgressMessage(`Đang đồng bộ Shopee: ${job.completed}/${job.total} đơn`);
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

  const finishShipJobResult = async (finalJob: any | null, queuedCount: number, total: number) => {
    const successCount = finalJob?.successCount || 0;
    const failed = (finalJob?.results || []).filter((r: any) => !r.success);

    onAddLog({
      id: `log-${Date.now() + 2}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: successCount > 0 ? 'success' : 'failed',
      message: `Đồng bộ Shopee xong: ${successCount}/${queuedCount} đơn (${shipMethod === 'pickup' ? 'Lấy hàng' : 'Tự mang ra bưu cục'}).`,
    });

    if (finalJob?.status === 'failed') {
      showToast(finalJob.error || 'Đồng bộ Shopee gặp lỗi. Vui lòng kiểm tra lại danh sách đơn.');
    } else if (successCount === 0) {
      const errDetail = failed.map((f: any) => `${f.orderSn || f.orderId}: ${f.message || f.error}`).join('; ');
      showToast(`Không xác nhận được đơn nào trên Shopee. ${errDetail || 'Vui lòng thử lại.'}`);
    } else if (failed.length > 0) {
      showToast(`Shopee: ${successCount}/${queuedCount} đơn OK, ${failed.length} đơn lỗi.`);
    } else {
      showToast(`Xác nhận thành công ${successCount}/${total} đơn — đang mở vận đơn in...`);
    }

    if (finalJob?.printDocument?.pdfBase64 || finalJob?.printDocument?.url) {
      await openShopeeLabelFromStream({
        pdfBase64: finalJob.printDocument.pdfBase64,
        pdfFilename: finalJob.printDocument.pdfFilename,
        url: finalJob.printDocument.url,
      });
    } else if (successCount > 0) {
      const shopeeIds = (finalJob?.results || [])
        .filter((r: any) => r.success)
        .map((r: any) => r.orderId)
        .filter(Boolean);
      if (shopeeIds.length > 0) {
        const printResult = await printShopeeDocuments(shopeeIds);
        if (!printResult.success && printResult.message) {
          showToast(printResult.message);
        }
      }
    } else if (finalJob?.printDocument?.message) {
      showToast(finalJob.printDocument.message);
    }

    const printedSns = new Set<string>(
      (finalJob?.printDocument?.printedOrderSns as string[] | undefined) ||
        (finalJob?.results || []).filter((r: any) => r.success).map((r: any) => r.orderSn).filter(Boolean)
    );
    const queuedForRefresh = queuedCount > 0
      ? ordersRef.current.filter(
          (o) =>
            printedSns.has(o.orderSn) ||
            (finalJob?.results || []).some(
              (r: any) => r.success && (r.orderId === o.id || r.orderSn === o.orderSn)
            )
        )
      : [];
    if (queuedForRefresh.length > 0) {
      await refreshOrdersAfterShip(queuedForRefresh, { markPrinted: printedSns.size > 0 });
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
    const optimisticOrders = applyLocalShippedOrdersUpdate(ordersRef.current, queuedKeys);
    onUpdateOrders(optimisticOrders);
    ordersRef.current = optimisticOrders;

    setIsShipping(true);
    setProgressCompleted(0);
    setProgressTotal(queuedOrders.length);
    setProgressMessage(`Đang ghi nhận ${queuedOrders.length} đơn...`);

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

        const successCount = syncData.successCount || 0;
        if (successCount === 0) {
          const failed = (syncData.results || []).filter((r: any) => !r.success);
          const errDetail = failed.map((f: any) => `${f.orderSn || f.orderId}: ${f.message || f.error}`).join('; ');
          showToast(`Không xác nhận được đơn nào. ${errDetail || 'Vui lòng thử lại.'}`);
          clearShipProgressOverlay();
          return;
        }

        showToast(`Xác nhận thành công ${successCount}/${queuedOrders.length} đơn — đang mở vận đơn in...`);
        if (syncData.printDocument?.pdfBase64 || syncData.printDocument?.url) {
          await openShopeeLabelFromStream({
            pdfBase64: syncData.printDocument.pdfBase64,
            pdfFilename: syncData.printDocument.pdfFilename,
            url: syncData.printDocument.url,
          });
        } else {
          const shopeeIds = (syncData.results || [])
            .filter((r: any) => r.success)
            .map((r: any) => r.orderId)
            .filter(Boolean);
          if (shopeeIds.length > 0) await printShopeeDocuments(shopeeIds);
        }
        await refreshOrdersAfterShip(queuedOrders, { markPrinted: successCount > 0 });
        markProgressComplete('Xác nhận & in đơn hoàn tất!');
        return;
      }

      const data = await readResponseJson<any>(res);
      if (!res.ok && res.status !== 202) {
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
        showToast(`Đã ghi nhận ${queuedOrders.length} đơn.`);
        markProgressComplete('Đã ghi nhận đơn hàng!');
        return;
      }

      setProgressMessage(`Đang đồng bộ Shopee: 0/${total} đơn`);
      const finalJob = await pollShipJobUntilDone(jobId, total, () => {
        showToast(`Xác nhận thành công — đang mở vận đơn in...`);
      });
      await finishShipJobResult(finalJob, queuedOrders.length, total);
      markProgressComplete('Xác nhận & in đơn hoàn tất!');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Lỗi không xác định';
      showToast(`Không thể kết nối API chuẩn bị hàng: ${msg}`);
      if (onFetchOrders) await onFetchOrders();
      clearShipProgressOverlay();
    }
  };

  const [showCreateOrderPage, setShowCreateOrderPage] = useState(false);

  const handleSyncOrders = async () => {
    setIsSyncing(true);
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: 'Đang gọi API lấy danh sách đơn hàng thực tế đã đồng bộ từ các gian hàng liên kết.'
    });

    try {
      await onRefreshOrders?.();
      alert('Đồng bộ thành công! Danh sách đơn hàng đã được cập nhật từ dữ liệu thực tế trên hệ thống.');
    } catch (err: any) {
      alert(`Đồng bộ thất bại: ${err?.message || 'Vui lòng kiểm tra kết nối API và thử lại.'}`);
    } finally {
      setIsSyncing(false);
    }
  };

  // Status Vietnamese styling and labeling helper matching mockup closely
  const getStatusBadge = (status: Order['status']) => {
    switch (status) {
      case 'pending_verification':
        return { text: 'Đang được kiểm tra bởi Shopee', color: 'bg-violet-50 text-violet-700 border-violet-200/60' };
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
    return orders.filter(o => {
      if (status === 'all') return true;
      if (status === 'unprocessed') return o.status === 'unprocessed' && !isOrderHandedOverToCarrier(o);
      if (status === 'processed') return matchesProcessedPickupTab(o);
      if (status === 'handed_over_carrier') return matchesHandedOverCarrierTab(o);
      return o.status === status;
    }).length;
  };

  // Filter logic
  const filteredOrders = orders.filter(order => {
    // 1. Tab filter
    if (activeSubTab === 'cancel_returns') {
      if (!matchesCancelReturnTab(order, cancelReturnTab)) return false;
    } else if (activeSubTab === 'handed_over_carrier') {
      if (!matchesHandedOverCarrierTab(order)) return false;
    } else if (activeSubTab === 'processed') {
      if (!matchesProcessedPickupTab(order)) return false;
    } else if (activeSubTab === 'unprocessed') {
      if (order.status !== 'unprocessed' || isOrderHandedOverToCarrier(order)) return false;
    } else if (activeSubTab !== 'all' && activeSubTab !== 'order_products' && activeSubTab !== 'reprint') {
      if (order.status !== activeSubTab) return false;
    }

    // 2. Platform filter
    if (selectedPlatform !== 'all') {
      if (selectedPlatform === 'lazada') return false; // Lazada is a mock demo
      if (order.channel !== selectedPlatform) return false;
    }

    // 3. Shop Filter
    if (selectedShopId !== 'all' && order.shopId !== selectedShopId) return false;

    // 4. Text query search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchSn = String(order.orderSn || '').toLowerCase().includes(q);
      const matchTracking = order.trackingNumber ? order.trackingNumber.toLowerCase().includes(q) : false;
      const matchInternal = order.internalTrackingCode ? order.internalTrackingCode.toLowerCase().includes(q) : false;
      const matchProduct = (order.items || []).some(it => String(it.productTitle || '').toLowerCase().includes(q));

      if (!matchSn && !matchTracking && !matchInternal && !matchProduct) return false;
    }

    return true;
  }).sort((a, b) => {
    const dateMs = (o: Order) => new Date(o.date || 0).getTime() || 0;
    if (selectedSort === 'newest') return dateMs(b) - dateMs(a);
    if (selectedSort === 'oldest') return dateMs(a) - dateMs(b);
    if (selectedSort === 'highest_value') return (Number(b.totalAmount) || 0) - (Number(a.totalAmount) || 0);
    return 0;
  });

  // Resolve checkbox selections to full Order rows — match internal id, orderSn,
  // or the normalized shopee-{orderSn} id so bulk actions never lose selections.
  const getSelectedOrders = (): Order[] => {
    if (selectedOrderIds.length === 0) return [];
    const keySet = new Set(selectedOrderIds.map(k => String(k).trim()).filter(Boolean));
    return orders.filter(o =>
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

  // Bulk Actions
  const handleBulkPrint = async () => {
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
        onUpdateOrders(orders.map(o => others.some(x => x.id === o.id) ? { ...o, isPrinted: true, status: o.isPrepared ? ('processed' as const) : o.status } : o));
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

  // "Xác nhận Chuẩn bị hàng loạt" — opens the pickup/dropoff confirmation modal
  // for every selected Shopee order still in "Chưa xử lý"; the actual ship_order call
  // only happens after the seller picks a method and confirms (see confirmShipOrders).
  const handleBulkPrepare = () => {
    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn hàng để chuẩn bị!');
      return;
    }

    const targets = selected.filter(
      o => o.channel === 'shopee' && (o.status === 'unprocessed' || o.status === 'pending_confirm')
    );
    openBulkShipConfirm(targets);
  };

  const handleBulkHandover = () => {
    const selected = getSelectedOrders();
    if (selected.length === 0) {
      showToast('Vui lòng chọn ít nhất 1 đơn hàng để giao shipper!');
      return;
    }

    let count = 0;
    const selectedIds = new Set(selected.map(o => o.id));
    const updated = orders.map(o => {
      if (selectedIds.has(o.id) && (o.status === 'processed' || o.status === 'unprocessed')) {
        count++;
        return {
          ...o,
          status: 'shipping' as const
        };
      }
      return o;
    });

    onUpdateOrders(updated);
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: `Bàn giao vận chuyển hàng loạt cho ${count} đơn hàng sang Đơn vị vận chuyển.`
    });
    showToast(`Đã bàn giao hàng loạt ${count} đơn hàng cho Shippers.`);
    setSelectedOrderIds([]);
    setShowBulkActionsDropdown(false);
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
      onUpdateOrders(orders.map(o => o.id === order.id ? { ...o, isPrinted: true, status: o.isPrepared ? ('processed' as const) : o.status } : o));
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

  const handleReprintOrder = async () => {
    const query = reprintOrderSn.trim();
    if (!query) {
      showToast('Vui lòng nhập mã đơn hàng.');
      return;
    }

    const normalized = query.toUpperCase();
    const order = orders.find(
      (o) =>
        String(o.orderSn || '').toUpperCase() === normalized ||
        o.id === query ||
        o.id === `shopee-${query}` ||
        String(o.id).toUpperCase() === normalized
    );

    if (!order) {
      showToast(`Không tìm thấy đơn #${query} trong hệ thống.`);
      return;
    }

    if (order.channel !== 'shopee' || !order.shopId) {
      setBulkPrintOrders([order]);
      showToast(`Đơn #${order.orderSn} không phải Shopee — mở phiếu in mẫu.`);
      return;
    }

    setIsReprintSearching(true);
    setProgressDone(false);
    setProgressTotal(1);
    setProgressCompleted(0);
    setProgressMessage(`Đang tìm & tải vận đơn đơn #${order.orderSn}...`);

    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'shopee',
      type: 'stock_sync',
      status: 'success',
      message: `[IN LẠI ĐƠN] Đang lấy vận đơn cache cho đơn ${order.orderSn} (không phụ thuộc trạng thái tab).`,
    });

    try {
      const result = await printShopeeDocuments([order.id], {
        onProgress: (completed, total) => {
          setProgressCompleted(completed);
          setProgressTotal(total);
          setProgressMessage(`Đang tải vận đơn: ${completed}/${total} đơn...`);
        },
      });
      if (!result.success) {
        showToast(result.message || `Không in lại được vận đơn đơn #${order.orderSn}.`);
        clearShipProgressOverlay();
      } else {
        markProgressComplete(`Đã mở vận đơn đơn #${order.orderSn}!`);
      }
    } catch {
      showToast('Không thể kết nối API in vận đơn. Vui lòng thử lại.');
      clearShipProgressOverlay();
    } finally {
      setIsReprintSearching(false);
    }
  };

  // Separate shops for multi-store badges
  const shopeeShops = shops.filter(s => s.platform === 'shopee');
  const tiktokShops = shops.filter(s => s.platform === 'tiktok');
  const woocommerceShops = shops.filter(s => s.platform === 'woocommerce');

  const handleEndScanSession = () => {
    setSessionStats({ shipped: 0, cancelDetected: 0, returnReceived: 0 });
    setCameraScanResult('Chế độ quét liên tục — sẵn sàng...');
    setCameraScanSuccess(false);
    setScanToast(null);
    setShowEndConfirm(false);
    scanQueueRef.current = [];
    setScanQueue([]);
    setIsFlushingQueue(false);
    if (onEndScanSession) onEndScanSession();
    else if (onCloseScanner) onCloseScanner();
  };

  /** Kết thúc: xử lý cả hàng đợi rồi mới đóng camera. */
  const handleFinishContinuousScan = async () => {
    setShowEndConfirm(false);
    const queue = [...scanQueueRef.current].reverse();
    if (queue.length === 0) {
      handleEndScanSession();
      return;
    }

    setIsFlushingQueue(true);
    setCameraScanResult(`Đang xử lý ${queue.length} mã đã quét...`);
    try {
      for (let i = 0; i < queue.length; i++) {
        setCameraScanResult(`Đang xử lý ${i + 1}/${queue.length}: ${queue[i].code}`);
        await handleOrderScan(queue[i].code);
      }
      showScanToast(`Đã xử lý ${queue.length} mã quét liên tục`, 'success');
    } finally {
      scanQueueRef.current = [];
      setScanQueue([]);
      setIsFlushingQueue(false);
      handleEndScanSession();
    }
  };

  if (focusScanner) {
    return (
      <div className="fixed inset-0 bg-zinc-950 z-50 flex flex-col select-none font-sans">
        {/* Counters dashboard */}
        <div className="shrink-0 px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-white font-extrabold text-[10px] uppercase tracking-widest">
                Quét liên tục · Always-on
              </span>
            </div>
            <div className="rounded-lg bg-blue-500/20 border border-blue-400/40 px-2.5 py-1">
              <span className="text-blue-300 font-black text-xs tabular-nums">
                Đã quét {scanQueue.length}/{continuousScanTarget || '—'}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-emerald-500/15 border border-emerald-500/30 px-2 py-2.5 text-center">
              <p className="text-[9px] font-bold text-emerald-400/90 uppercase tracking-wide leading-tight">Đã xuất kho</p>
              <p className="text-2xl font-black text-emerald-400 tabular-nums mt-0.5">{sessionStats.shipped}</p>
            </div>
            <div className="rounded-xl bg-rose-500/15 border border-rose-500/30 px-2 py-2.5 text-center">
              <p className="text-[9px] font-bold text-rose-400/90 uppercase tracking-wide leading-tight">Đơn báo hủy</p>
              <p className="text-2xl font-black text-rose-400 tabular-nums mt-0.5">{sessionStats.cancelDetected}</p>
            </div>
            <div className="rounded-xl bg-amber-500/15 border border-amber-500/30 px-2 py-2.5 text-center">
              <p className="text-[9px] font-bold text-amber-400/90 uppercase tracking-wide leading-tight">Đã nhận hoàn</p>
              <p className="text-2xl font-black text-amber-400 tabular-nums mt-0.5">{sessionStats.returnReceived}</p>
            </div>
          </div>
        </div>

        {/* Camera + hàng đợi */}
        <div className="flex-1 min-h-0 px-3 flex flex-col gap-2 pb-2">
          <div className="shrink-0 min-h-[160px] max-h-[42vh] relative rounded-2xl border border-zinc-800 overflow-hidden bg-black">
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
              Quét liên tục — nghe bíp/rung là OK · không cần bấm gì
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
            {isFlushingQueue && (
              <div className="absolute inset-0 bg-black/80 backdrop-blur-[2px] flex flex-col items-center justify-center gap-3 z-10">
                <Loader2 className="w-9 h-9 text-blue-400 animate-spin" />
                <p className="text-xs font-bold text-white/90 px-4 text-center">
                  Đang xử lý hàng đợi ({scanQueue.length} mã)...
                </p>
              </div>
            )}
          </div>

          <div className="flex-1 min-h-[140px] max-h-[45vh] rounded-2xl border border-zinc-700 bg-zinc-900/95 overflow-hidden flex flex-col shadow-inner">
            <div className="shrink-0 px-3 py-2.5 border-b border-zinc-800 flex items-center justify-between">
              <p className="text-xs font-black text-emerald-300 uppercase tracking-wide">
                Hàng đợi · {scanQueue.length} mã
              </p>
              {scanQueue.length > 0 && (
                <span className="text-[10px] font-bold text-zinc-500">Mới nhất ở trên</span>
              )}
            </div>
            {scanQueue.length === 0 ? (
              <div className="flex-1 flex items-center justify-center px-4 text-center text-xs text-zinc-500 font-semibold">
                Quét mã QR — danh sách hiển thị tại đây
              </div>
            ) : (
              <ul className="flex-1 overflow-y-auto p-2 space-y-1.5">
                {scanQueue.map((item, idx) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-2 rounded-xl bg-zinc-950/80 border border-zinc-800 px-3 py-2.5"
                  >
                    <span className="shrink-0 w-6 h-6 rounded-lg bg-emerald-500/20 text-emerald-400 text-[10px] font-black flex items-center justify-center">
                      {scanQueue.length - idx}
                    </span>
                    <span className="flex-1 text-sm font-mono text-white truncate">{item.code}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div
            className={`shrink-0 text-sm font-bold px-3 py-2.5 rounded-xl text-center transition-all ${
              cameraScanSuccess
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : cameraScanError
                  ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                : cameraScanResult.includes('sẵn sàng') || cameraScanResult.includes('liên tục')
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
            Kết thúc{scanQueue.length > 0 ? ` · Xử lý ${scanQueue.length} mã` : ''}
          </button>
          <p className="text-center text-[10px] text-zinc-500 font-semibold">
            Camera luôn mở — bấm Kết thúc để đồng bộ và thoát
          </p>
        </div>

        {showEndConfirm && (
          <div className="fixed inset-0 z-70 bg-black/70 flex items-center justify-center p-6">
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-full max-w-sm space-y-4">
              <p className="text-white font-bold text-sm">Kết thúc phiên quét liên tục?</p>
              <p className="text-zinc-400 text-xs leading-relaxed">
                {scanQueue.length > 0
                  ? `Hệ thống sẽ xử lý ${scanQueue.length} mã trong hàng đợi, cập nhật đơn hàng, rồi đóng camera.`
                  : 'Chưa có mã trong hàng đợi — sẽ đóng camera và quay về tab Đơn hàng.'}
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
            onClick={handleSyncOrders}
            disabled={isSyncing || ordersLoading}
            className="om-orders-mobile-hide-primary-actions px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-75 text-white font-extrabold text-xs rounded-xl shadow-md shadow-blue-500/15 hover:shadow-blue-500/30 transition-all flex items-center gap-2 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${(isSyncing || ordersLoading) ? 'animate-spin' : ''}`} />
            <span>Cập nhật đơn hàng</span>
          </button>
        </div>
      </div>

      {/* 2. SUB-TABS: Horizontal scrollable subtabs with counts (Mockup identical) */}
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
          onClick={() => setActiveSubTab('pending_verification')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'pending_verification'
              ? 'border-violet-600 text-violet-700 font-extrabold bg-violet-50/40'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Đang được kiểm tra bởi Shopee</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-violet-100 text-violet-700 border border-violet-200/50">
            {getCount('pending_verification')}
          </span>
        </button>

        <button
          onClick={() => setActiveSubTab('pending_confirm')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'pending_confirm' 
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

        <button
          onClick={() => setActiveSubTab('handed_over_carrier')}
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

        <button
          onClick={() => setActiveSubTab('reprint')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'reprint'
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20'
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <Printer className="w-3.5 h-3.5" />
          <span>In lại đơn</span>
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

      {/* 4. FILTER BOX — search only (ẩn trên màn ĐƠN HỦY, ĐƠN HOÀN) */}
      {activeSubTab !== 'order_products' && activeSubTab !== 'reprint' && activeSubTab !== 'cancel_returns' && (
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
      </div>
      )}

      {/* 5. BULK ACTION BAR ("Chọn thao tác" dropdown matching mockup perfectly) */}
      {activeSubTab !== 'order_products' && activeSubTab !== 'reprint' && (
      <div className="om-orders-mobile-hide-bulk-bar bg-slate-50 border border-slate-200/80 p-3 max-md:p-2.5 rounded-2xl flex items-center justify-between gap-4 max-md:gap-2">
        <div className="flex items-center gap-3">
          <button 
            onClick={handleToggleSelectAll}
            className="text-gray-500 hover:text-gray-800 transition-all cursor-pointer"
          >
            {selectedOrderIds.length === filteredOrders.length ? (
              <CheckSquare className="w-5 h-5 text-blue-600" />
            ) : (
              <Square className="w-5 h-5 text-gray-400" />
            )}
          </button>
          <span className="text-xs font-extrabold text-slate-700">
            Đã chọn <strong className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded-md font-black">{selectedOrderIds.length}</strong> đơn hàng trên trang này
          </span>
        </div>

        {/* Bulk Action selector like mockup */}
        <div className="relative shrink-0">
          <button
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
                onClick={handleBulkPrint}
                disabled={isBulkPrinting}
                className="om-mobile-hide-print w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5 disabled:opacity-50"
              >
                <Printer className={`w-4 h-4 text-blue-600 shrink-0 ${isBulkPrinting ? 'animate-spin' : ''}`} />
                <span>{isBulkPrinting ? 'Đang lấy vận đơn Shopee...' : 'In đơn hàng hàng loạt'}</span>
              </button>

              <button
                onClick={handleBulkConfirm}
                className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5"
              >
                <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Xác nhận đơn hàng loạt</span>
              </button>

              <button
                onClick={handleBulkPrepare}
                className="om-mobile-hide-prepare w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5"
              >
                <Sparkles className="w-4 h-4 text-rose-500 shrink-0" />
                <span>Xác nhận Chuẩn bị hàng loạt</span>
              </button>

              <button
                onClick={handleBulkHandover}
                className="w-full text-left px-4 py-2 text-xs font-bold text-gray-700 hover:bg-slate-50 flex items-center gap-2.5"
              >
                <Truck className="w-4 h-4 text-indigo-500 shrink-0" />
                <span>Bàn giao vận chuyển loạt</span>
              </button>

              <div className="border-t border-gray-50 my-1.5"></div>
              
              <button
                onClick={() => {
                  alert('Khởi chạy API cập nhật lại trạng thái sàn đồng thời...');
                  setShowBulkActionsDropdown(false);
                }}
                className="w-full text-left px-4 py-2 text-xs text-gray-500 hover:bg-slate-50 font-medium"
              >
                Đồng bộ lại
              </button>
              <button
                onClick={() => {
                  alert('Gửi phản hồi hàng loạt...');
                  setShowBulkActionsDropdown(false);
                }}
                className="w-full text-left px-4 py-2 text-xs text-gray-500 hover:bg-slate-50 font-medium"
              >
                Phản hồi
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
      ) : activeSubTab === 'reprint' ? (
        <div className="bg-white rounded-3xl border border-gray-100 shadow-xs overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 bg-blue-50/40">
            <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
              <Printer className="w-4 h-4 text-blue-600" />
              In lại đơn
            </h3>
            <p className="text-[11px] text-gray-500 mt-1">
              Nhập mã đơn hàng để tìm và in lại vận đơn PDF từ bộ nhớ cache — không phụ thuộc trạng thái tab hiện tại.
            </p>
          </div>
          <div className="p-6 max-w-xl">
            <label className="block text-xs font-bold text-gray-700 mb-2 uppercase tracking-wide">
              Mã đơn hàng (Order ID)
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={reprintOrderSn}
                onChange={(e) => setReprintOrderSn(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleReprintOrder();
                }}
                placeholder="VD: 250712ABCDEF"
                className="flex-1 px-4 py-3 bg-gray-50 rounded-xl border border-gray-200 focus:border-blue-500 focus:bg-white text-sm outline-none font-mono font-semibold"
              />
              <button
                type="button"
                onClick={() => void handleReprintOrder()}
                disabled={isReprintSearching || !reprintOrderSn.trim()}
                className="px-5 py-3 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 shrink-0"
              >
                {isReprintSearching ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Printer className="w-4 h-4" />
                )}
                <span>{isReprintSearching ? 'Đang tìm...' : 'Tìm và In'}</span>
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-3 leading-relaxed">
              Hệ thống sẽ lấy vận đơn đã lưu trên server (nếu có) hoặc tải mới từ Shopee. Áp dụng cho mọi đơn Shopee trong cơ sở dữ liệu.
            </p>
          </div>
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
                  const badge = getStatusBadge(order.status) || { text: order.status, color: '' };
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
                          formatOrderNetRevenueDisplay(order, packagingCostPerOrder).pending
                            ? 'text-amber-700 bg-amber-50/80'
                            : 'text-emerald-600 bg-emerald-50/50'
                        }`}>
                          Lãi: {formatOrderNetRevenueDisplay(order, packagingCostPerOrder).text}
                          {formatOrderNetRevenueDisplay(order, packagingCostPerOrder).pending && (
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

                          {order.status === 'unprocessed' && (
                            <>
                              {!order.isPrepared ? (
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

                          {order.status === 'processed' && !isOrderHandedOverToCarrier(order) && (
                            <>
                              <span className={`om-mobile-hide-print text-[10px] font-bold px-1.5 py-1 rounded ${
                                order.isPrinted ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'
                              }`}>
                                {order.isPrinted ? '✓ Đã in' : '✕ Chưa in'}
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
                                onClick={() => void handOverOrderToCarrier(order)}
                                className="px-2.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-[10px] rounded-lg transition-all"
                              >
                                Giao cho ĐVVC
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
                            packagingCostPerOrder={packagingCostPerOrder}
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
              const badge = getStatusBadge(order.status) || { text: order.status, color: '' };
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
                          formatOrderNetRevenueDisplay(order, packagingCostPerOrder).pending ? 'text-amber-700' : 'text-emerald-700'
                        }`}>
                          {formatOrderNetRevenueDisplay(order, packagingCostPerOrder).text}
                          {formatOrderNetRevenueDisplay(order, packagingCostPerOrder).pending && (
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

                      {order.status === 'unprocessed' && (
                        <>
                          {!order.isPrepared ? (
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

                      {order.status === 'processed' && !isOrderHandedOverToCarrier(order) && (
                        <>
                          <span className={`om-mobile-hide-print text-[11px] font-black px-2.5 py-1 rounded-xl border ${
                            order.isPrinted ? 'text-emerald-600 bg-emerald-50 border-emerald-100' : 'text-rose-600 bg-rose-50 border-rose-100'
                          }`}>
                            {order.isPrinted ? '✓ Đã in' : '✕ Chưa in'}
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
                            onClick={() => void handOverOrderToCarrier(order)}
                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-xs transition-all"
                          >
                            Giao cho ĐVVC
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
                    packagingCostPerOrder={packagingCostPerOrder}
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

      {/* Floating processing overlay — shown for the full duration of any real
          Shopee API call (ship_order / create+download shipping document),
          single or bulk. Highest z-index so it always sits above every other modal. */}
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
