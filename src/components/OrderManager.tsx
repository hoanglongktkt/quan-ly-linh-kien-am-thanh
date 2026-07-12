import React, { useState, useEffect, useMemo } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { startRearCameraScanner, HTTPS_CAMERA_MESSAGE } from '../utils/cameraScanner';
import { 
  Search, 
  ShoppingBag, 
  CheckCircle2, 
  Printer, 
  Clock, 
  Truck, 
  FileText, 
  XCircle, 
  RotateCcw, 
  Check, 
  Filter, 
  Eye, 
  MapPin, 
  Phone, 
  Barcode, 
  ArrowRight, 
  AlertCircle, 
  Sparkles, 
  RefreshCw,
  Sliders,
  HelpCircle,
  Share2,
  ChevronDown,
  ChevronRight,
  CheckSquare,
  Square,
  Package,
  Calendar,
  Layers,
  Sparkle,
  Plus,
  Trash2,
  User,
  CreditCard,
  ImageIcon,
  Loader2,
  X,
  ImageOff,
} from 'lucide-react';
import { Order, ConnectedShop, SyncLog, Product } from '../types';
import StructuredAddressForm from './StructuredAddressForm';
import {
  emptyStructuredAddress,
  formatFullAddress,
  isStructuredAddressComplete,
  StructuredAddressValue,
} from '../utils/vietnamAddress';
import { aggregateOrderProducts } from '../utils/aggregateOrderProducts';

interface OrderManagerProps {
  orders: Order[];
  onUpdateOrders: (orders: Order[]) => void;
  onRefreshOrders?: () => Promise<void> | void;
  ordersLoading?: boolean;
  shops: ConnectedShop[];
  onAddLog: (log: SyncLog) => void;
  products?: Product[];
  onUpdateProduct?: (updated: Product) => void;
  focusScanner?: boolean;
  onCloseScanner?: () => void;
  onEndScanSession?: () => void;
}

type OrderTab = 
  | 'all' 
  | 'pending_confirm' 
  | 'unprocessed' 
  | 'processed' 
  | 'shipping' 
  | 'cancelled' 
  | 'return_pending' 
  | 'return_received'
  | 'order_products';

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

const playBeep = () => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(1000, audioCtx.currentTime); // 1000Hz beep
    gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.15);
  } catch (err) {
    console.error("Audio beep failed:", err);
  }
};

export default function OrderManager({ 
  orders, 
  onUpdateOrders, 
  onRefreshOrders,
  ordersLoading = false,
  shops, 
  onAddLog, 
  products = [], 
  onUpdateProduct,
  focusScanner = false,
  onCloseScanner,
  onEndScanSession
}: OrderManagerProps) {
  const [activeSubTab, setActiveSubTab] = useState<OrderTab>('unprocessed'); // Default to unprocessed "Chờ lấy hàng (Chưa xử lý)" like mockup
  
  // Camera Barcode Scanning States and Ref
  const [cameraScanResult, setCameraScanResult] = useState<string>('Đang chờ quét...');
  const [cameraScanSuccess, setCameraScanSuccess] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string>('');
  const [cameraRestartKey, setCameraRestartKey] = useState(0);

  const [sessionStats, setSessionStats] = useState({ shipped: 0, cancelDetected: 0, returnReceived: 0 });
  const [manualScanInput, setManualScanInput] = useState('');
  const [scanToast, setScanToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  
  const ordersRef = React.useRef(orders);
  const applyScanRef = React.useRef<(query: string) => void>(() => {});
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const showScanToast = (text: string, type: 'success' | 'error') => {
    setScanToast({ text, type });
    setTimeout(() => setScanToast(null), 2800);
  };

  const handleOrderScan = React.useCallback(
    (rawQuery: string) => {
      const query = rawQuery.trim().toUpperCase();
      if (!query) return;

      const findOrder = () =>
        ordersRef.current.find(
          (o) =>
            o.orderSn.toUpperCase() === query ||
            (o.trackingNumber && o.trackingNumber.toUpperCase() === query)
        );

      const order = findOrder();

      if (!order) {
        playBeep();
        setCameraScanSuccess(false);
        setCameraScanResult(`Không tìm thấy đơn: ${rawQuery.trim()}`);
        showScanToast(`Không tìm thấy đơn khớp mã "${rawQuery.trim()}"`, 'error');
        return;
      }

      if (order.status === 'processed') {
        const updated = ordersRef.current.map((o) => {
          if (o.id !== order.id) return o;
          const tracking =
            o.trackingNumber ||
            `${o.channel === 'shopee' ? 'SPX' : o.channel === 'tiktok' ? 'TTS' : 'WOO'}-VN-${Math.floor(10000000 + Math.random() * 90000000)}`;
          return { ...o, status: 'shipping' as const, trackingNumber: tracking, isPrepared: true };
        });
        onUpdateOrders(updated);
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: order.channel,
          type: 'stock_sync',
          status: 'success',
          message: `[QUÉT MÃ] Xuất kho đơn ${order.orderSn} → Đang giao.`,
        });
        setSessionStats((s) => ({ ...s, shipped: s.shipped + 1 }));
        playBeep();
        setCameraScanSuccess(true);
        setCameraScanResult(`✓ Xuất kho #${order.orderSn}`);
        showScanToast(`Đã xuất kho — đơn #${order.orderSn} chuyển sang Đang giao`, 'success');
        setManualScanInput('');
        setTimeout(() => setCameraScanSuccess(false), 2000);
        return;
      }

      if (order.status === 'cancelled' || order.status === 'return_pending') {
        const isCancelRequest = order.status === 'cancelled';
        const updated = ordersRef.current.map((o) =>
          o.id === order.id ? { ...o, status: 'return_received' as const } : o
        );
        onUpdateOrders(updated);
        onAddLog({
          id: `log-${Date.now()}`,
          timestamp: new Date().toISOString(),
          channel: order.channel,
          type: 'stock_sync',
          status: 'success',
          message: `[QUÉT MÃ] Nhận hoàn đơn ${order.orderSn} → Hủy giao đã nhận.`,
        });
        setSessionStats((s) => ({
          ...s,
          cancelDetected: isCancelRequest ? s.cancelDetected + 1 : s.cancelDetected,
          returnReceived: s.returnReceived + 1,
        }));
        playBeep();
        setCameraScanSuccess(true);
        setCameraScanResult(`✓ Nhận hoàn #${order.orderSn}`);
        showScanToast(
          isCancelRequest
            ? `Đơn báo hủy #${order.orderSn} — đã chuyển Hủy giao đã nhận`
            : `Đã nhận hoàn đơn #${order.orderSn}`,
          'success'
        );
        setManualScanInput('');
        setTimeout(() => setCameraScanSuccess(false), 2000);
        return;
      }

      if (order.status === 'shipping') {
        playBeep();
        setCameraScanSuccess(false);
        setCameraScanResult(`Đơn #${order.orderSn} đã ở trạng thái Đang giao`);
        showScanToast(`Đơn #${order.orderSn} đã xuất kho trước đó`, 'error');
        return;
      }

      if (order.status === 'return_received') {
        playBeep();
        setCameraScanSuccess(false);
        setCameraScanResult(`Đơn #${order.orderSn} đã nhận hoàn trước đó`);
        showScanToast(`Đơn #${order.orderSn} đã nhận hoàn`, 'error');
        return;
      }

      const statusLabels: Record<Order['status'], string> = {
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
      playBeep();
      setCameraScanSuccess(false);
      setCameraScanResult(`Trạng thái không hợp lệ: ${statusLabel}`);
      showScanToast(`Đơn #${order.orderSn} — ${statusLabel}. Không thể xử lý tự động.`, 'error');
    },
    [onUpdateOrders, onAddLog]
  );

  useEffect(() => {
    applyScanRef.current = handleOrderScan;
  }, [handleOrderScan]);

  useEffect(() => {
    let html5Qrcode: Html5Qrcode | null = null;
    let isMounted = true;

    if (focusScanner) {
      setCameraScanResult('Đang chờ quét...');
      setCameraScanSuccess(false);
      setCameraError('');

      const timer = setTimeout(() => {
        if (!isMounted) return;

        const element = document.getElementById('camera-reader');
        if (!element) {
          console.error('camera-reader element not found');
          return;
        }

        html5Qrcode = new Html5Qrcode('camera-reader');

        const qrCodeSuccessCallback = (decodedText: string) => {
          if (!decodedText) return;
          applyScanRef.current(decodedText);
        };

        const config = {
          fps: 15,
          qrbox: (width: number, height: number) => {
            const size = Math.min(width, height) * 0.75;
            return { width: size, height: size };
          },
        };

        void startRearCameraScanner(html5Qrcode, config, qrCodeSuccessCallback, () => {})
          .catch((err: unknown) => {
            console.error('Camera scanner start failed:', err);
            const msg =
              err instanceof Error ? err.message : 'Không thể khởi động camera.';
            setCameraError(
              msg === HTTPS_CAMERA_MESSAGE
                ? msg
                : 'Không thể khởi động Camera. Vui lòng cấp quyền truy cập và bấm "Thử lại".'
            );
          });
      }, 300);

      return () => {
        isMounted = false;
        clearTimeout(timer);
        if (html5Qrcode?.isScanning) {
          html5Qrcode.stop().catch((err) => console.error('Error stopping html5-qrcode scanner', err));
        }
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
  
  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTimeRange, setSelectedTimeRange] = useState<'all' | 'today' | 'week' | 'month'>('week');
  const [selectedSort, setSelectedSort] = useState<'newest' | 'oldest' | 'highest_value'>('newest');
  // Quick print-status filter for the "Chờ lấy hàng (Đã xử lý)" tab — lets the
  // seller instantly isolate orders whose label failed to print / never printed.
  const [printFilter, setPrintFilter] = useState<'all' | 'unprinted' | 'printed'>('all');

  // Multi-select bulk state
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [showBulkActionsDropdown, setShowBulkActionsDropdown] = useState(false);

  // Scanner Simulator states
  const [activeScannerTab, setActiveScannerTab] = useState<'handover' | 'returns'>('handover');
  const [shipperBarcode, setShipperBarcode] = useState('');
  const [returnBarcode, setReturnBarcode] = useState('');
  const [scannerMessage, setScannerMessage] = useState<{ text: string; type: 'success' | 'error' | null }>({ text: '', type: null });

  // Detail Modal & Bulk Print Modal
  const [selectedOrderDetails, setSelectedOrderDetails] = useState<Order | null>(null);
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

  // Floating "processing..." overlay shown during any real Shopee API call
  // (ship_order / create+download shipping document), single or bulk — gives
  // the seller immediate visual feedback instead of just a disabled button.
  const [progressMessage, setProgressMessage] = useState<string | null>(null);

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

  // Opens a real Shopee AWB/label file (PDF/HTML) — now served from our own
  // public /labels/<file> link (like Sapo) — in a new tab and immediately
  // triggers the OS's native print dialog via the standard window.open(url).print().
  const openAndPrintDocument = (url: string) => {
    const printWindow = window.open(url, '_blank');
    if (printWindow) {
      printWindow.focus();
      printWindow.onload = function () {
        printWindow.print();
      };
      // PDF native viewers often don't fire a reliable `load` event — retry once after render settles.
      setTimeout(() => {
        try {
          printWindow.print();
        } catch {
          // Cross-origin or already-closed — ignore, the tab is still visible for manual printing.
        }
      }, 800);
    }
  };

  // Calls the real Shopee shipping-document flow (create → poll → download AWB PDF)
  // for one or more orders, then opens + auto-prints each returned real PDF/label.
  const printShopeeDocuments = async (orderIds: string[]): Promise<{ success: boolean; message?: string }> => {
    const res = await fetch('/api/shopee/print-document', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ orderIds }),
    });
    const data = await res.json();
    if (!res.ok) {
      return { success: false, message: data.error || 'Không thể tạo vận đơn Shopee.' };
    }

    const failedDocs = (data.documents || []).filter((d: any) => !d.url);
    const printUrl = data.mergedUrl || (data.documents || []).find((d: any) => d.url)?.url;

    if (printUrl) {
      openAndPrintDocument(printUrl);
    }

    if (Array.isArray(data.orders)) {
      onUpdateOrders(data.orders);
    }

    if (failedDocs.length > 0 && !printUrl) {
      return { success: false, message: failedDocs.map((d: any) => d.message || d.error).join('\n') };
    }
    return { success: true, message: failedDocs.length > 0 ? `Một số đơn lỗi: ${failedDocs.map((d: any) => d.message || d.error).join('; ')}` : undefined };
  };

  // Called from the "Xác nhận đơn hàng" modal — arranges shipment (pickup/dropoff,
  // per the seller's choice) for every order currently queued in `shipConfirmOrders`.
  const confirmShipOrders = async () => {
    if (!shipConfirmOrders || shipConfirmOrders.length === 0) return;
    const queuedOrders = [...shipConfirmOrders];
    const orderSns = [...new Set(queuedOrders.map(o => o.orderSn).filter(sn => Boolean(sn && String(sn).trim())))];
    const orderIds = [...new Set(queuedOrders.map(o => o.id).filter(id => Boolean(id && String(id).trim())))];

    if (orderSns.length === 0 && orderIds.length === 0) {
      showToast('Không có mã đơn hàng hợp lệ trong danh sách đã chọn. Vui lòng chọn lại.');
      return;
    }

    setIsShipping(true);
    setProgressMessage('Đang xử lý xác nhận đơn hàng trên Shopee, vui lòng đợi...');
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'all',
      type: 'stock_sync',
      status: 'success',
      message: `[LOGISTICS API] Đang gọi v2.logistics.ship_order (${shipMethod === 'pickup' ? 'pickup' : 'dropoff'}) cho ${orderSns.length} đơn: ${orderSns.join(', ')}.`
    });

    const isBulk = queuedOrders.length > 1;
    const waitMsgTimer = isBulk
      ? window.setTimeout(() => {
          setProgressMessage('Xác nhận thành công! Đang đợi Shopee khởi tạo mã vận đơn hàng loạt (khoảng 4 giây)...');
        }, 1500)
      : null;

    try {
      const res = await fetch('/api/shopee/ship-order/bulk', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ orderIds, orderSns, method: shipMethod }),
      });
      const data = await res.json();
      if (Array.isArray(data.orders)) {
        onUpdateOrders(data.orders);
      }

      const successCount = data.successCount || 0;
      const failed = (data.results || []).filter((r: any) => !r.success);

      onAddLog({
        id: `log-${Date.now() + 1}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'stock_sync',
        status: successCount > 0 ? 'success' : 'failed',
        message: `Đã chuẩn bị hàng (${shipMethod === 'pickup' ? 'Lấy hàng' : 'Tự mang ra bưu cục'}) thành công ${successCount}/${queuedOrders.length} đơn hàng.`
      });

      if (successCount === 0) {
        const errDetail = failed.map((f: any) => `${f.orderSn || f.orderId}: ${f.message || f.error}`).join('; ');
        showToast(`Không xác nhận được đơn nào. ${errDetail || 'Vui lòng thử lại.'}`);
        return;
      }

      setShipConfirmOrders(null);
      setSelectedOrderIds([]);
      setActiveSubTab('processed');
      setPrintFilter('all');

      if (failed.length > 0) {
        showToast(`Chuẩn bị thành công ${successCount}/${queuedOrders.length} đơn. ${failed.length} đơn lỗi.`);
      } else {
        showToast(`Chuẩn bị thành công ${successCount} đơn — đang tự động in vận đơn...`);
      }

      // Backend already merged AWB PDF for all successful Shopee orders in one shot.
      if (data.printDocument?.url) {
        setProgressMessage(isBulk
          ? 'Xác nhận thành công! Đang đợi Shopee khởi tạo mã vận đơn hàng loạt (khoảng 4 giây)...'
          : 'Xác nhận thành công! Đang tải tài liệu in từ Shopee...');
        openAndPrintDocument(data.printDocument.url);
        showToast(`Đã tải vận đơn gộp (${data.printDocument.printedOrderSns?.length || successCount} đơn) — hộp thoại in đã mở.`);
      } else if (data.printDocument?.message) {
        showToast(data.printDocument.message);
      }

      if (onRefreshOrders) {
        await onRefreshOrders();
      }
    } catch (err) {
      showToast('Không thể kết nối API chuẩn bị hàng. Vui lòng kiểm tra kết nối và thử lại.');
    } finally {
      if (waitMsgTimer) clearTimeout(waitMsgTimer);
      setIsShipping(false);
      setProgressMessage(null);
    }
  };

  // Manual Order Creator states
  const [showCreateOrderModal, setShowCreateOrderModal] = useState(false);
  const [custName, setCustName] = useState('');
  const [custPhone, setCustPhone] = useState('');
  const [shippingAddress, setShippingAddress] = useState<StructuredAddressValue>(emptyStructuredAddress());
  const [submittingManualOrder, setSubmittingManualOrder] = useState(false);
  const [orderItems, setOrderItems] = useState<{ productId: string; productTitle: string; sku: string; quantity: number; price: number; stock: number }[]>([]);
  
  // Single selected item state inside modal
  const [selectedProdId, setSelectedProdId] = useState('');
  const [selectedQty, setSelectedQty] = useState(1);
  const [selectedPrice, setSelectedPrice] = useState(0);

  // Logistics carrier connection state inside modal
  const [selectedCarrier, setSelectedCarrier] = useState<'self' | 'ghn' | 'spx'>('self');
  const [carrierNotes, setCarrierNotes] = useState('Cho xem hàng không cho thử');
  const [packageWeight, setPackageWeight] = useState(500);
  const [shippingFee, setShippingFee] = useState(30000);
  const [orderDiscount, setOrderDiscount] = useState(0);

  const handleAddItemToOrder = () => {
    if (!selectedProdId) {
      alert('Vui lòng chọn một sản phẩm từ kho!');
      return;
    }
    const prod = products.find(p => p.id === selectedProdId);
    if (!prod) return;

    if (selectedQty <= 0) {
      alert('Số lượng sản phẩm phải lớn hơn 0!');
      return;
    }

    if (selectedQty > prod.stock) {
      alert(`⚠️ Tồn kho khả dụng của sản phẩm này chỉ còn ${prod.stock}. Bạn không thể bán vượt quá tồn kho khả dụng.`);
      return;
    }

    // Check if product already in items
    const existing = orderItems.find(it => it.productId === selectedProdId);
    if (existing) {
      if (existing.quantity + selectedQty > prod.stock) {
        alert(`⚠️ Tổng số lượng (${existing.quantity + selectedQty}) vượt quá tồn kho khả dụng của sản phẩm (${prod.stock})!`);
        return;
      }
      setOrderItems(prev => prev.map(it => it.productId === selectedProdId ? { ...it, quantity: it.quantity + selectedQty } : it));
    } else {
      setOrderItems(prev => [...prev, {
        productId: prod.id,
        productTitle: prod.title,
        sku: prod.sku,
        quantity: selectedQty,
        price: selectedPrice || prod.sellingPrice,
        stock: prod.stock
      }]);
    }

    // Reset item inputs
    setSelectedProdId('');
    setSelectedQty(1);
    setSelectedPrice(0);
  };

  const handleRemoveItemFromOrder = (prodId: string) => {
    setOrderItems(prev => prev.filter(it => it.productId !== prodId));
  };

  const handleSubmitManualOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custName.trim() || !custPhone.trim()) {
      alert('Vui lòng điền đầy đủ thông tin khách hàng (Tên, SĐT)!');
      return;
    }
    if (!isStructuredAddressComplete(shippingAddress)) {
      alert('Vui lòng chọn đầy đủ Tỉnh/Quận/Phường và nhập địa chỉ chi tiết!');
      return;
    }
    if (orderItems.length === 0) {
      alert('Vui lòng thêm ít nhất 1 sản phẩm vào đơn hàng!');
      return;
    }

    setSubmittingManualOrder(true);
    try {
      const res = await fetch('/api/orders/manual', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: custName.trim(),
          customerPhone: custPhone.trim(),
          shippingAddress: {
            province: shippingAddress.provinceName,
            provinceCode: shippingAddress.provinceCode,
            district: shippingAddress.districtName,
            districtCode: shippingAddress.districtCode,
            ward: shippingAddress.wardName,
            wardCode: shippingAddress.wardCode,
            street: shippingAddress.street.trim(),
          },
          items: orderItems,
          carrier: selectedCarrier,
          packageWeight,
          shippingFee,
          orderDiscount,
          carrierNotes,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Tạo đơn hàng thất bại!');
        return;
      }

      const newOrder: Order = data.order;
      const generatedTracking = data.trackingNumber || newOrder.trackingNumber || '';

      if (onUpdateProduct) {
        orderItems.forEach(item => {
          const prod = products.find(p => p.id === item.productId);
          if (prod) {
            onUpdateProduct({
              ...prod,
              stock: Math.max(0, prod.stock - item.quantity),
            });
          }
        });
      }

      if (data.orders) {
        onUpdateOrders(data.orders);
      } else {
        onUpdateOrders([newOrder, ...orders]);
      }

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'manual',
        type: 'publish',
        status: 'success',
        message: `[TẠO ĐƠN THỦ CÔNG] Đã khởi tạo thành công đơn hàng sỉ ngoài sàn #${newOrder.orderSn} cho khách ${newOrder.customerName}. Tổng thu: ${newOrder.totalAmount.toLocaleString('vi-VN')}đ.`
      });

      if (selectedCarrier !== 'self') {
        onAddLog({
          id: `log-${Date.now() + 1}`,
          timestamp: new Date().toISOString(),
          channel: selectedCarrier,
          type: 'stock_sync',
          status: 'success',
          message: `[API LOGISTICS] Đã tự động gọi API đẩy đơn sỉ sang đơn vị vận chuyển ${selectedCarrier === 'ghn' ? 'Giao Hàng Nhanh' : 'Shopee SPX Express'}. Tracking ID trả về: ${generatedTracking}`
        });
      }

      const fullAddr = formatFullAddress(shippingAddress);
      if (selectedCarrier === 'ghn') {
        alert(`🎉 Đã tạo đơn ngoài sàn thành công!\n\n• Mã đơn hàng: ${newOrder.orderSn}\n• Địa chỉ: ${fullAddr}\n• Đơn vị vận chuyển: Giao Hàng Nhanh (GHN)\n• Mã vận đơn API: ${generatedTracking}\n\nĐơn hàng đã được đẩy sang cổng vận chuyển GHN tự động và khấu trừ ${orderItems.reduce((acc, it) => acc + it.quantity, 0)} sản phẩm trong kho.`);
      } else if (selectedCarrier === 'spx') {
        alert(`🎉 Đã tạo đơn ngoài sàn thành công!\n\n• Mã đơn hàng: ${newOrder.orderSn}\n• Địa chỉ: ${fullAddr}\n• Đơn vị vận chuyển: Shopee SPX Express\n• Mã vận đơn API: ${generatedTracking}\n\nĐơn hàng đã được đẩy sang cổng vận chuyển Shopee SPX tự động và khấu trừ ${orderItems.reduce((acc, it) => acc + it.quantity, 0)} sản phẩm trong kho.`);
      } else {
        alert(`🎉 Đã tạo đơn ngoài sàn thành công!\n\n• Mã đơn hàng: ${newOrder.orderSn}\n• Địa chỉ: ${fullAddr}\n• Đơn vị vận chuyển: Tự giao hàng\n• Mã vận đơn: ${generatedTracking}\n\nĐơn hàng đã được lưu và tự giao, tồn kho đã tự động khấu trừ.`);
      }

      setShowCreateOrderModal(false);
      setOrderItems([]);
      setCustName('');
      setCustPhone('');
      setShippingAddress(emptyStructuredAddress());
    } catch {
      alert('Lỗi kết nối server khi tạo đơn hàng!');
    } finally {
      setSubmittingManualOrder(false);
    }
  };

  // Calls Shopee API to sync READY_TO_SHIP + PROCESSED orders, then reload list.
  const handleShopeeSyncOrders = async () => {
    setIsSyncing(true);
    setProgressMessage('Đang quét và đồng bộ toàn bộ đơn hàng mới nhất từ Shopee...');
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'shopee',
      type: 'stock_sync',
      status: 'success',
      message: '[Shopee Sync] Đang gọi v2.order.get_order_list + get_order_detail (READY_TO_SHIP, PROCESSED, SHIPPED — 15 ngày, lật trang).'
    });

    try {
      const res = await fetch('/api/shopee/orders/sync', {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        const parts = [data?.error, data?.detail, data?.hint].filter(Boolean);
        throw new Error(parts.join(' — ') || 'Đồng bộ đơn hàng Shopee thất bại.');
      }
      if (data.warning) {
        showToast(data.warning);
      }
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        throw new Error(data.errors.map((e: any) => `${e.shopId ? `Shop ${e.shopId}: ` : ''}${e.error}${e.message ? ` - ${e.message}` : ''}`).join('; '));
      }
      const refreshRes = await fetch('/api/orders', { headers: authHeaders() });
      if (refreshRes.ok) {
        onUpdateOrders(await refreshRes.json());
      } else if (Array.isArray(data.orders)) {
        onUpdateOrders(data.orders);
      }
      const ui = data.uiStatusCounts;
      const countMsg = ui
        ? ` — Đang giao: ${ui.shipping}, Chờ lấy (đã xử lý): ${ui.processed}, Chưa xử lý: ${ui.unprocessed}`
        : '';
      showToast(`Đồng bộ thành công ${data.synced || 0} đơn từ Shopee${countMsg}.`);
    } catch (err: any) {
      showToast(`Đồng bộ thất bại: ${err?.message || 'Vui lòng kiểm tra kết nối API và thử lại.'}`);
    } finally {
      setIsSyncing(false);
      setProgressMessage(null);
    }
  };

  // Calls the backend's real "/api/orders" endpoint to refresh the list with
  // whatever has actually been synced in so far (e.g. via the Shopee webhook).
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
        return { text: 'Yêu cầu huỷ đơn', color: 'bg-rose-50 text-rose-500 border-rose-100' };
      case 'return_pending': 
        return { text: 'Hủy giao chờ nhận', color: 'bg-purple-50 text-purple-600 border-purple-200/60 font-bold animate-pulse' };
      case 'return_received': 
        return { text: 'Hủy giao đã nhận', color: 'bg-slate-100 text-slate-700 border-slate-300' };
    }
  };

  // Helper count statistics
  const aggregatedOrderProducts = useMemo(
    () => aggregateOrderProducts(orders, products ?? []),
    [orders, products]
  );

  const getCount = (status: OrderTab) => {
    if (status === 'order_products') {
      return aggregatedOrderProducts.length;
    }
    return orders.filter(o => {
      if (status === 'all') return true;
      if (status === 'unprocessed') return o.status === 'unprocessed';
      return o.status === status;
    }).length;
  };

  // Filter logic
  const filteredOrders = orders.filter(order => {
    // 1. Tab filter
    if (activeSubTab !== 'all' && activeSubTab !== 'order_products') {
      if (order.status !== activeSubTab) return false;
    }

    // 2. Platform filter
    if (selectedPlatform !== 'all') {
      if (selectedPlatform === 'lazada') return false; // Lazada is a mock demo
      if (order.channel !== selectedPlatform) return false;
    }

    // 3. Shop Filter
    if (selectedShopId !== 'all' && order.shopId !== selectedShopId) return false;

    // 3b. Print-status filter (only meaningful in the "Đã xử lý" tab)
    if (activeSubTab === 'processed' && printFilter !== 'all') {
      if (printFilter === 'printed' && !order.isPrinted) return false;
      if (printFilter === 'unprinted' && order.isPrinted) return false;
    }

    // 4. Time Range Filter
    if (selectedTimeRange === 'today') {
      const todayStr = new Date().toISOString().split('T')[0];
      if (!order.date.startsWith(todayStr)) return false;
    } else if (selectedTimeRange === 'week') {
      // Within last 7 days from local time 2026-07-07
      const limit = new Date('2026-07-01');
      if (new Date(order.date) < limit) return false;
    }

    // 5. Text query search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchSn = order.orderSn.toLowerCase().includes(q);
      const matchName = order.customerName.toLowerCase().includes(q);
      const matchTracking = order.trackingNumber ? order.trackingNumber.toLowerCase().includes(q) : false;
      const matchProduct = order.items.some(it => it.productTitle.toLowerCase().includes(q));

      if (!matchSn && !matchName && !matchTracking && !matchProduct) return false;
    }

    return true;
  }).sort((a, b) => {
    if (selectedSort === 'newest') return new Date(b.date).getTime() - new Date(a.date).getTime();
    if (selectedSort === 'oldest') return new Date(a.date).getTime() - new Date(b.date).getTime();
    if (selectedSort === 'highest_value') return b.totalAmount - a.totalAmount;
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
      setProgressMessage('Đang kết nối Shopee và tải tài liệu in về hosting...');
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
        const result = await printShopeeDocuments(shopeeAll);
        if (!result.success) {
          showToast(`In vận đơn Shopee thất bại: ${result.message}`);
        } else if (result.message) {
          showToast(result.message);
        }
      }
      // Non-Shopee (manual/tiktok) orders don't have a real Shopee AWB — show the mock preview instead.
      if (others.length > 0) {
        setBulkPrintOrders(others);
        onUpdateOrders(orders.map(o => others.some(x => x.id === o.id) ? { ...o, isPrinted: true, status: o.isPrepared ? ('processed' as const) : o.status } : o));
      }
    } finally {
      setIsBulkPrinting(false);
      setProgressMessage(null);
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
    setProgressMessage('Đang kết nối Shopee và tải tài liệu in về hosting...');
    onAddLog({
      id: `log-${Date.now()}`,
      timestamp: new Date().toISOString(),
      channel: 'shopee',
      type: 'stock_sync',
      status: 'success',
      message: `[SHOPEE API] Đang tạo & tải vận đơn thật (AWB) cho đơn ${order.orderSn}.`
    });
    try {
      const result = await printShopeeDocuments([order.id]);
      if (!result.success) {
        alert(`In vận đơn thất bại cho đơn ${order.orderSn}: ${result.message}`);
      }
    } catch (err) {
      alert('Không thể kết nối API in vận đơn Shopee. Vui lòng thử lại.');
    } finally {
      setPrintingOrderId(null);
      setProgressMessage(null);
    }
  };

  // NEW: Scanner Handover Simulator - Transition to "shipping" (Đang giao)
  const handleShipperScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!shipperBarcode.trim()) return;

    const query = shipperBarcode.trim().toUpperCase();
    
    // Find matching order in "unprocessed" or "processed" state
    const targetOrder = orders.find(o => 
      (o.status === 'unprocessed' || o.status === 'processed') &&
      (o.orderSn.toUpperCase() === query || (o.trackingNumber && o.trackingNumber.toUpperCase() === query))
    );

    if (targetOrder) {
      // Update status to shipping
      const updated = orders.map(o => {
        if (o.id === targetOrder.id) {
          // ensure it has a tracking number if scanned with order ID
          const tracking = o.trackingNumber || `${o.channel === 'shopee' ? 'SPX' : o.channel === 'tiktok' ? 'TTS' : 'WOO'}-VN-${Math.floor(10000000 + Math.random() * 90000000)}`;
          return {
            ...o,
            status: 'shipping' as const,
            trackingNumber: tracking,
            isPrepared: true
          };
        }
        return o;
      });

      onUpdateOrders(updated);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: targetOrder.channel,
        type: 'stock_sync',
        status: 'success',
        message: `[BẮN MÃ SHIPPER] Quét thành công đơn ${targetOrder.orderSn}. Đã xác nhận bàn giao bưu cục, trạng thái: ĐANG GIAO.`
      });

      setScannerMessage({
        text: `✅ [BÀN GIAO SHIPPER] Thành công! Đơn hàng #${targetOrder.orderSn} (${targetOrder.customerName}) đã được chuyển trạng thái "ĐANG GIAO".`,
        type: 'success'
      });
      setShipperBarcode('');
    } else {
      // Check if already in shipping
      const alreadyShipping = orders.find(o => 
        o.status === 'shipping' && 
        (o.orderSn.toUpperCase() === query || (o.trackingNumber && o.trackingNumber.toUpperCase() === query))
      );

      if (alreadyShipping) {
        setScannerMessage({
          text: `⚠️ Đơn hàng #${alreadyShipping.orderSn} đã được bàn giao vận chuyển trước đó rồi!`,
          type: 'error'
        });
      } else {
        setScannerMessage({
          text: `❌ Không tìm thấy đơn hàng "Chưa xử lý" / "Đã chuẩn bị" nào khớp với mã "${shipperBarcode}"`,
          type: 'error'
        });
      }
    }

    setTimeout(() => {
      setScannerMessage({ text: '', type: null });
    }, 4500);
  };

  // Existing Scanner Return Simulator
  const handleReturnScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnBarcode.trim()) return;

    const query = returnBarcode.trim().toUpperCase();

    // Find return_pending order
    const targetOrder = orders.find(o =>
      o.status === 'return_pending' &&
      (o.orderSn.toUpperCase() === query || (o.trackingNumber && o.trackingNumber.toUpperCase() === query))
    );

    if (targetOrder) {
      const updated = orders.map(o => {
        if (o.id === targetOrder.id) {
          return {
            ...o,
            status: 'return_received' as const
          };
        }
        return o;
      });

      onUpdateOrders(updated);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: targetOrder.channel,
        type: 'stock_sync',
        status: 'success',
        message: `[QUÉT TRẢ HÀNG] Đã nhận lại thành công hàng hoàn cho đơn ${targetOrder.orderSn}. Đã tự động cập nhật cộng trả tồn kho sỉ.`
      });

      setScannerMessage({
        text: `✅ [QUÉT HOÀN HÀNG] Thành công! Đã nhận lại hàng hoàn đơn #${targetOrder.orderSn}. Tồn kho tự động hoàn phục hồi.`,
        type: 'success'
      });
      setReturnBarcode('');
    } else {
      const otherStateOrder = orders.find(o =>
        (o.orderSn.toUpperCase() === query || (o.trackingNumber && o.trackingNumber.toUpperCase() === query))
      );

      if (otherStateOrder) {
        setScannerMessage({
          text: `❌ Mã đơn này đang ở trạng thái "${getStatusBadge(otherStateOrder.status)?.text}", không phải đơn "Hủy giao chờ nhận"!`,
          type: 'error'
        });
      } else {
        setScannerMessage({
          text: `❌ Không tìm thấy đơn hàng hoàn bưu cục nào khớp với mã "${returnBarcode}"`,
          type: 'error'
        });
      }
    }

    setTimeout(() => {
      setScannerMessage({ text: '', type: null });
    }, 4500);
  };

  // Separate shops for multi-store badges
  const shopeeShops = shops.filter(s => s.platform === 'shopee');
  const tiktokShops = shops.filter(s => s.platform === 'tiktok');
  const woocommerceShops = shops.filter(s => s.platform === 'woocommerce');

  const handleEndScanSession = () => {
    setSessionStats({ shipped: 0, cancelDetected: 0, returnReceived: 0 });
    setManualScanInput('');
    setCameraScanResult('Đang chờ quét...');
    setCameraScanSuccess(false);
    setScanToast(null);
    setShowEndConfirm(false);
    if (onEndScanSession) onEndScanSession();
    else if (onCloseScanner) onCloseScanner();
  };

  const handleManualScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualScanInput.trim()) return;
    handleOrderScan(manualScanInput);
  };

  if (focusScanner) {
    return (
      <div className="fixed inset-0 bg-zinc-950 z-50 flex flex-col select-none font-sans">
        {/* Counters dashboard */}
        <div className="shrink-0 px-3 pt-3 pb-2 space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-white font-extrabold text-[10px] uppercase tracking-widest">Quét mã vận đơn</span>
            </div>
            {onCloseScanner && (
              <button
                type="button"
                onClick={onCloseScanner}
                className="w-9 h-9 rounded-full bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center text-white text-sm font-extrabold border border-zinc-700"
              >
                ✕
              </button>
            )}
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

        {/* Camera */}
        <div className="flex-1 min-h-0 px-3 flex flex-col gap-2 pb-2">
          <div className="flex-1 min-h-[180px] max-h-[42vh] relative rounded-2xl border border-zinc-800 overflow-hidden bg-black">
            <div id="camera-reader" className="w-full h-full object-cover" />
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              <div
                className={`w-[200px] h-[200px] border-2 rounded-xl transition-all duration-300 ${
                  cameraScanSuccess
                    ? 'border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.4)]'
                    : 'border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.2)]'
                }`}
              />
            </div>
            {cameraError && (
              <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-4 text-center text-xs text-rose-400 font-semibold gap-3">
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
          </div>

          <form onSubmit={handleManualScanSubmit} className="flex gap-2 shrink-0">
            <input
              type="text"
              value={manualScanInput}
              onChange={(e) => setManualScanInput(e.target.value)}
              placeholder="Nhập / dán mã đơn..."
              className="flex-1 min-h-11 px-3 rounded-xl bg-zinc-900 border border-zinc-700 text-white text-sm font-mono outline-none focus:border-blue-500"
              autoComplete="off"
            />
            <button
              type="submit"
              className="shrink-0 min-h-11 px-4 rounded-xl bg-blue-600 text-white font-bold text-xs uppercase"
            >
              OK
            </button>
          </form>

          <div
            className={`shrink-0 text-sm font-bold px-3 py-2.5 rounded-xl text-center transition-all ${
              cameraScanSuccess
                ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                : cameraScanResult.startsWith('Đang chờ')
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

        <div className="shrink-0 p-3 pt-2 border-t border-zinc-800 bg-zinc-950">
          <button
            type="button"
            onClick={() => setShowEndConfirm(true)}
            className="w-full min-h-12 rounded-xl bg-zinc-700 hover:bg-zinc-600 active:bg-rose-700 text-white font-extrabold text-sm uppercase tracking-wide transition-colors"
          >
            KẾT THÚC QUÉT
          </button>
        </div>

        {showEndConfirm && (
          <div className="fixed inset-0 z-70 bg-black/70 flex items-center justify-center p-6">
            <div className="bg-zinc-900 border border-zinc-700 rounded-2xl p-5 w-full max-w-sm space-y-4">
              <p className="text-white font-bold text-sm">Kết thúc phiên quét?</p>
              <p className="text-zinc-400 text-xs leading-relaxed">
                Toàn bộ bộ đếm sẽ reset về 0 và bạn sẽ quay về tab Đơn hàng.
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
                  onClick={handleEndScanSession}
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
      {/* If focusScanner is true, we display the scanner panel at the very top of OrderManager! */}
      {focusScanner && (
        <div className="bg-blue-50/50 p-1 rounded-3xl border border-blue-200 shadow-md animate-in fade-in slide-in-from-top-4 duration-350">
          <div className="bg-white p-5 rounded-3xl border border-gray-150 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-gray-100 pb-2">
              <h3 className="text-sm font-black text-blue-900 uppercase tracking-widest flex items-center gap-1.5">
                <Barcode className="w-5 h-5 text-blue-600 animate-pulse" />
                <span>CHẾ ĐỘ QUÉT MÃ VẠCH (MOBILE-FIRST)</span>
              </h3>
              <span className="text-[10px] text-gray-400 font-mono">Bắn mã bằng máy quét hoặc camera điện thoại</span>
            </div>
            
            <div className="flex border-b border-gray-100">
              <button
                onClick={() => setActiveScannerTab('handover')}
                className={`flex-1 text-center py-2.5 text-xs font-bold flex items-center justify-center gap-2 border-b-2 transition-all ${
                  activeScannerTab === 'handover' ? 'border-indigo-600 text-indigo-600 font-black' : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                <Barcode className="w-4 h-4 text-indigo-500" />
                <span>QUÉT BÀN GIAO SHIPPER</span>
              </button>
              <button
                onClick={() => setActiveScannerTab('returns')}
                className={`flex-1 text-center py-2.5 text-xs font-bold flex items-center justify-center gap-2 border-b-2 transition-all ${
                  activeScannerTab === 'returns' ? 'border-purple-600 text-purple-600 font-black' : 'border-transparent text-gray-400 hover:text-gray-600'
                }`}
              >
                <RotateCcw className="w-4 h-4 text-purple-500" />
                <span>QUÉT HOÀN TRẢ KHO SỈ</span>
              </button>
            </div>

            {activeScannerTab === 'handover' ? (
              <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100/60 flex flex-col gap-4">
                <div className="space-y-1">
                  <h4 className="text-xs font-extrabold text-indigo-950 flex items-center gap-1.5">
                    BẮN MÃ VẠCH BÀN GIAO SHIPPER NHANH
                  </h4>
                  <p className="text-[11px] text-indigo-700 font-semibold">
                    Khi bưu tá đến lấy hàng, quét mã đơn (Ví dụ: <code className="bg-white px-1.5 py-0.5 rounded text-indigo-900 font-mono font-bold">SPX-VN-11029312</code>) để lập tức xác nhận **Đang giao**.
                  </p>
                </div>

                <form onSubmit={handleShipperScanSubmit} className="flex flex-col sm:flex-row gap-2">
                  <input 
                    type="text"
                    placeholder="Nhập/Quét mã đơn, mã vận đơn..."
                    value={shipperBarcode}
                    onChange={(e) => setShipperBarcode(e.target.value)}
                    className="px-4 py-3 bg-white rounded-xl border border-indigo-250 focus:border-indigo-500 text-sm font-mono outline-none w-full shadow-inner"
                    autoFocus
                  />
                  <button 
                    type="submit"
                    className="px-4 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-xs transition-all whitespace-nowrap uppercase tracking-wider cursor-pointer"
                  >
                    Xác Nhận Giao Shipper
                  </button>
                </form>
              </div>
            ) : (
              <div className="bg-purple-50/50 p-4 rounded-2xl border border-purple-100/60 flex flex-col gap-4">
                <div className="space-y-1">
                  <h4 className="text-xs font-extrabold text-purple-950 flex items-center gap-1.5">
                    BẮN MÃ VẠCH KHÁCH HUỶ / ĐƠN HOÀN VỀ KHO
                  </h4>
                  <p className="text-[11px] text-purple-700 font-semibold">
                    Nhập hoặc dán mã vận đơn của đơn bị từ chối giao để bưu cục trả về kho sỉ. Hệ thống sẽ chuyển trạng thái sang **Hủy giao đã nhận** và tự động cộng trả lại tồn kho sỉ.
                  </p>
                </div>

                <form onSubmit={handleReturnScanSubmit} className="flex flex-col sm:flex-row gap-2">
                  <input 
                    type="text"
                    placeholder="Nhập/Quét mã đơn, mã vận đơn hoàn..."
                    value={returnBarcode}
                    onChange={(e) => setReturnBarcode(e.target.value)}
                    className="px-4 py-3 bg-white rounded-xl border border-purple-250 focus:border-purple-500 text-sm font-mono outline-none w-full shadow-inner"
                    autoFocus
                  />
                  <button 
                    type="submit"
                    className="px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-xl shadow-xs transition-all whitespace-nowrap uppercase tracking-wider cursor-pointer"
                  >
                    Xác Nhận Nhận Hoàn
                  </button>
                </form>
              </div>
            )}

            {scannerMessage.text && (
              <div className={`p-3.5 rounded-xl border text-xs font-bold animate-in slide-in-from-top-2 duration-200 ${
                scannerMessage.type === 'success' 
                  ? 'bg-emerald-50 border-emerald-100 text-emerald-800' 
                  : 'bg-rose-50 border-rose-100 text-rose-800'
              }`}>
                {scannerMessage.text}
              </div>
            )}
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

        {/* Right Help Utilities & "Cập nhật đơn hàng" button */}
        <div className="flex items-center gap-3">
          <button 
            onClick={() => alert('Đường dây hỗ trợ kỹ thuật API & Logistics sẵn sàng 24/7!')}
            className="om-orders-mobile-hide-support p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-all"
            title="Trợ giúp"
          >
            <HelpCircle className="w-5 h-5" />
          </button>
          <button 
            className="om-orders-mobile-hide-support p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-all"
            title="Xuất Excel"
          >
            <Share2 className="w-5 h-5" />
          </button>

          <button 
            onClick={() => alert('Đang tập hợp chứng từ Hóa đơn điện tử (HĐĐT)...')}
            className="max-sm:hidden sm:flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold text-gray-600 hover:bg-gray-100 rounded-xl border border-gray-200 transition-all"
          >
            <FileText className="w-4 h-4 text-gray-400" />
            <span>Danh sách xuất HĐĐT</span>
          </button>

          <button
            onClick={() => {
              setCustName('');
              setCustPhone('');
              setShippingAddress(emptyStructuredAddress());
              setOrderItems([]);
              setSelectedCarrier('self');
              setShippingFee(30000);
              setOrderDiscount(0);
              setShowCreateOrderModal(true);
            }}
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
          onClick={() => setActiveSubTab('cancelled')}
          className={`om-orders-mobile-show-subtab px-4 py-3 max-md:py-3.5 text-xs font-bold uppercase tracking-wider border-b-2 max-md:border-b-0 max-md:border max-md:border-gray-100 max-md:rounded-xl transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'cancelled' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Yêu cầu huỷ đơn</span>
          <span className="px-1.5 py-0.2 text-[10px] font-semibold rounded-full bg-gray-100 text-gray-600 border border-gray-200">
            {getCount('cancelled')}
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
          onClick={() => setActiveSubTab('return_pending')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'return_pending' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Hủy giao chờ nhận</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-purple-100 text-purple-700 border border-purple-200">
            {getCount('return_pending')}
          </span>
        </button>

        <button
          onClick={() => setActiveSubTab('return_received')}
          className={`om-orders-mobile-hide-subtab px-4 py-3 text-xs font-bold uppercase tracking-wider border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${
            activeSubTab === 'return_received' 
              ? 'border-blue-600 text-blue-600 font-extrabold bg-blue-50/20' 
              : 'border-transparent text-gray-500 hover:text-gray-900 hover:bg-gray-50'
          }`}
        >
          <span>Hủy giao đã nhận</span>
          <span className="px-1.5 py-0.2 text-[10px] font-bold rounded-full bg-slate-200 text-slate-700 border border-slate-300">
            {getCount('return_received')}
          </span>
        </button>
      </div>

      {/* 3. SCANNERS PANEL: NEW DUAL BARCODE SCANNERS (HANDOVER + RETURNS) */}
      {!focusScanner && activeSubTab !== 'order_products' && (
        <div className="om-orders-mobile-hide-scanner-panel bg-white p-5 rounded-3xl border border-gray-100 shadow-sm space-y-4">
          <div className="flex border-b border-gray-100">
            <button
              onClick={() => setActiveScannerTab('handover')}
              className={`px-4 py-2.5 text-xs font-bold flex items-center gap-2 border-b-2 transition-all ${
                activeScannerTab === 'handover' ? 'border-indigo-600 text-indigo-600 font-extrabold' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              <Barcode className="w-4 h-4 text-indigo-500" />
              <span>QUÉT BÀN GIAO ĐƠN CHO SHIPIER (XÁC NHẬN "ĐANG GIAO")</span>
            </button>
            <button
              onClick={() => setActiveScannerTab('returns')}
              className={`px-4 py-2.5 text-xs font-bold flex items-center gap-2 border-b-2 transition-all ${
                activeScannerTab === 'returns' ? 'border-purple-600 text-purple-600 font-extrabold' : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              <RotateCcw className="w-4 h-4 text-purple-500" />
              <span>QUÉT NHẬN HÀNG HOÀN TRẢ VỀ KHO SỈ (XÁC NHẬN "ĐÃ NHẬN HOÀN")</span>
            </button>
          </div>

          {activeScannerTab === 'handover' ? (
            <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-100/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <h4 className="text-xs font-extrabold text-indigo-950 flex items-center gap-1.5">
                  BẮN MÃ VẠCH BÀN GIAO SHIPPER NHANH
                </h4>
                <p className="text-[11px] text-indigo-700">
                  Khi bưu tá đến lấy hàng, dùng máy quét bắn mã vận đơn hoặc mã đơn (Ví dụ: <code className="bg-white px-1.5 py-0.5 rounded text-indigo-900 font-mono font-bold">SPX-VN-11029312</code>) để lập tức chuyển đơn sang trạng thái **Đang giao**.
                </p>
              </div>

              <form onSubmit={handleShipperScanSubmit} className="flex gap-2 w-full sm:w-auto shrink-0">
                <input 
                  type="text"
                  placeholder="Nhập/Quét mã đơn, mã vận đơn..."
                  value={shipperBarcode}
                  onChange={(e) => setShipperBarcode(e.target.value)}
                  className="px-4 py-2 bg-white rounded-xl border border-indigo-200 focus:border-indigo-500 text-xs font-mono outline-none w-full sm:w-60 shadow-inner"
                />
                <button 
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl shadow-xs transition-all whitespace-nowrap"
                >
                  Xác Nhận Giao Shipper
                </button>
              </form>
            </div>
          ) : (
            <div className="bg-purple-50/50 p-4 rounded-2xl border border-purple-100/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <h4 className="text-xs font-extrabold text-purple-950 flex items-center gap-1.5">
                  BẮN MÃ VẠCH KHÁCH HUỶ / ĐƠN HOÀN VỀ KHO
                </h4>
                <p className="text-[11px] text-purple-700">
                  Nhập hoặc dán mã vận đơn của đơn bị từ chối giao để bưu cục trả về kho sỉ (Ví dụ: <code className="bg-white px-1.5 py-0.5 rounded text-purple-900 font-mono font-bold">GHN-TT-00129</code>). Hệ thống sẽ chuyển trạng thái sang **Hủy giao đã nhận** và tự động cộng trả lại tồn kho sỉ.
                </p>
              </div>

              <form onSubmit={handleReturnScanSubmit} className="flex gap-2 w-full sm:w-auto shrink-0">
                <input 
                  type="text"
                  placeholder="Nhập/Quét mã đơn, mã vận đơn hoàn..."
                  value={returnBarcode}
                  onChange={(e) => setReturnBarcode(e.target.value)}
                  className="px-4 py-2 bg-white rounded-xl border border-purple-200 focus:border-purple-500 text-xs font-mono outline-none w-full sm:w-60 shadow-inner"
                />
                <button 
                  type="submit"
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white font-bold text-xs rounded-xl shadow-xs transition-all whitespace-nowrap"
                >
                  Xác Nhận Nhận Hoàn
                </button>
              </form>
            </div>
          )}

          {scannerMessage.text && (
            <div className={`p-3.5 rounded-xl border text-xs font-bold animate-in slide-in-from-top-2 duration-200 ${
              scannerMessage.type === 'success' 
                ? 'bg-emerald-50 border-emerald-100 text-emerald-800' 
                : 'bg-rose-50 border-rose-100 text-rose-800'
            }`}>
              {scannerMessage.text}
            </div>
          )}
        </div>
      )}

      {/* 4. FILTER BOX & SEARCH TAGS (Mockup faithful design) */}
      {activeSubTab !== 'order_products' && (
      <div className="om-orders-filters-panel bg-white p-5 max-md:p-4 rounded-3xl border border-gray-100 shadow-xs space-y-4">
        <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
          
          {/* Main search */}
          <div className="om-orders-mobile-hide-search relative w-full lg:flex-1">
            <Search className="absolute left-3.5 top-3.5 text-gray-400 w-4 h-4" />
            <input 
              type="text" 
              placeholder="Tìm kiếm theo mã đơn hàng, tên khách hàng, sản phẩm hoặc mã bưu cục..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-xs outline-none transition-all font-medium"
            />
          </div>

          {/* Sàn/Trạng thái/Ngày tạo dropdowns like mockup */}
          <div className="flex flex-wrap items-center gap-2.5 w-full lg:w-auto">
            
            <div className="om-orders-mobile-hide-date-filter flex items-center gap-1.5 bg-gray-50 border border-gray-200 px-3 py-2 rounded-xl text-xs font-semibold text-gray-600">
              <span className="text-gray-400 font-bold">Ngày tạo:</span>
              <select 
                value={selectedTimeRange} 
                onChange={(e) => setSelectedTimeRange(e.target.value as any)}
                className="bg-transparent border-none outline-none text-xs font-extrabold text-gray-800 cursor-pointer"
              >
                <option value="week">Tuần này (Mới cập nhật)</option>
                <option value="today">Hôm nay (Đơn phát sinh)</option>
                <option value="all">Mọi thời gian</option>
              </select>
            </div>

            <div className="om-orders-mobile-hide-sort-filter flex items-center gap-1.5 bg-gray-50 border border-gray-200 px-3 py-2 rounded-xl text-xs font-semibold text-gray-600">
              <Sliders className="w-3.5 h-3.5 text-gray-400" />
              <select 
                value={selectedSort} 
                onChange={(e) => setSelectedSort(e.target.value as any)}
                className="bg-transparent border-none outline-none text-xs font-extrabold text-gray-800 cursor-pointer"
              >
                <option value="newest">Sắp xếp: Mới nhất</option>
                <option value="oldest">Sắp xếp: Cũ nhất</option>
                <option value="highest_value">Sắp xếp: Giá trị lớn nhất</option>
              </select>
            </div>

            <button
              onClick={handleShopeeSyncOrders}
              disabled={isSyncing || ordersLoading}
              className="om-orders-mobile-hide-sync-btn px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:opacity-75 text-white rounded-xl text-xs font-extrabold transition-all flex items-center gap-1.5 shadow-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${(isSyncing || ordersLoading) ? 'animate-spin' : ''}`} />
              <span>ĐỒNG BỘ ĐƠN HÀNG TỪ SHOPEE</span>
            </button>

            <button 
              onClick={() => alert('Đã lưu thành công bộ lọc tùy chỉnh của bạn!')}
              className="om-orders-mobile-hide-save-filter px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-xl text-xs font-extrabold transition-all"
            >
              Lưu bộ lọc
            </button>

            <button 
              onClick={() => alert('Mở bảng cấu hình tùy biến hiển thị cột dữ liệu')}
              className="om-orders-mobile-hide-columns-btn px-3.5 py-2 bg-white text-gray-600 hover:bg-gray-50 border border-gray-200 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5"
            >
              <Sliders className="w-3.5 h-3.5 rotate-90" />
              <span>Cột</span>
            </button>
          </div>
        </div>

        {/* Filter tags below (matching mockup exactly) */}
        <div className="om-orders-mobile-hide-active-filters flex flex-wrap items-center gap-2 pt-1">
          <span className="text-[11px] text-gray-400 font-bold uppercase tracking-wide">Bộ lọc hoạt động:</span>
          
          <span className="inline-flex items-center gap-1.5 bg-blue-50/80 border border-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold">
            Trạng thái trên sàn: {getStatusBadge(activeSubTab)?.text || 'Tất cả'}
            <button onClick={() => setActiveSubTab('all')} className="hover:text-blue-900 font-extrabold">✕</button>
          </span>

          <span className="inline-flex items-center gap-1.5 bg-blue-50/80 border border-blue-100 text-blue-700 px-3 py-1 rounded-full text-xs font-bold">
            Thời gian: {selectedTimeRange === 'week' ? 'Tuần này (01/07 - 07/07)' : selectedTimeRange === 'today' ? 'Hôm nay' : 'Mọi thời gian'}
            <button onClick={() => setSelectedTimeRange('all')} className="hover:text-blue-900 font-extrabold">✕</button>
          </span>

          {selectedPlatform !== 'all' && (
            <span className="inline-flex items-center gap-1.5 bg-orange-50 border border-orange-100 text-orange-700 px-3 py-1 rounded-full text-xs font-bold uppercase">
              Kênh: {selectedPlatform}
              <button onClick={() => setSelectedPlatform('all')} className="hover:text-orange-950">✕</button>
            </span>
          )}

          {searchQuery && (
            <span className="inline-flex items-center gap-1.5 bg-gray-100 border border-gray-200 text-gray-700 px-3 py-1 rounded-full text-xs font-bold">
              Từ khóa: "{searchQuery}"
              <button onClick={() => setSearchQuery('')} className="hover:text-gray-900">✕</button>
            </span>
          )}
        </div>

        {/* Quick print-status filter — only relevant once orders reach "Đã xử lý" */}
        {activeSubTab === 'processed' && (
          <div className="om-mobile-hide-print flex items-center gap-2 pt-2 border-t border-gray-100">
            <span className="text-[11px] text-gray-400 font-bold uppercase tracking-wide flex items-center gap-1">
              <Printer className="w-3.5 h-3.5" /> Lọc theo in ấn:
            </span>
            <button
              onClick={() => setPrintFilter('all')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                printFilter === 'all' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
              }`}
            >
              Tất cả
            </button>
            <button
              onClick={() => setPrintFilter('unprinted')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                printFilter === 'unprinted' ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-rose-600 border-rose-200 hover:bg-rose-50'
              }`}
            >
              Chưa in ({orders.filter(o => o.status === 'processed' && !o.isPrinted).length})
            </button>
            <button
              onClick={() => setPrintFilter('printed')}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${
                printFilter === 'printed' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-600 border-emerald-200 hover:bg-emerald-50'
              }`}
            >
              Đã in ({orders.filter(o => o.status === 'processed' && o.isPrinted).length})
            </button>
          </div>
        )}
      </div>
      )}

      {/* 5. BULK ACTION BAR ("Chọn thao tác" dropdown matching mockup perfectly) */}
      {activeSubTab !== 'order_products' && (
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
                  <th className="p-4 w-44">Mã đơn &amp; Sàn</th>
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
                  return (
                    <tr 
                      key={order.id} 
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

                      {/* Order Code & Platform Label */}
                      <td className="p-4 space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className={`px-1.5 py-0.5 text-[9px] font-black uppercase rounded ${
                            order.channel === 'shopee' ? 'bg-orange-500 text-white' : 'bg-zinc-950 text-white'
                          }`}>
                            {order.channel}
                          </span>
                          <span className="font-mono font-bold text-gray-900 text-xs tracking-tight">{order.orderSn}</span>
                        </div>
                        {order.trackingNumber ? (
                          <div className="text-[10px] text-slate-500 font-mono flex items-center gap-1 bg-slate-100 p-1 px-1.5 rounded-lg w-max max-w-[140px] truncate" title={order.trackingNumber}>
                            <Barcode className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span>{order.trackingNumber}</span>
                          </div>
                        ) : (
                          <span className="om-mobile-hide-prepare text-[10px] text-gray-400 italic">Chưa chuẩn bị bưu cục</span>
                        )}
                      </td>

                      {/* Created Time */}
                      <td className="p-4 text-gray-500 font-medium">
                        {new Date(order.date).toLocaleDateString('vi-VN')}
                        <p className="text-[10px] text-gray-400 font-mono mt-0.5">08:12</p>
                      </td>

                      {/* Order items list — thumbnail + full title + quantity */}
                      <td className="p-4 w-[280px]">
                        <div className="space-y-2">
                          {order.items.map((item, idx) => (
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
                        <div className="text-[10px] text-emerald-600 font-bold bg-emerald-50/50 p-0.5 px-1.5 rounded-md inline-block">
                          Lãi: {order.revenue.toLocaleString('vi-VN')}đ
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
                                onClick={() => handleSinglePrint(order)}
                                disabled={printingOrderId === order.id}
                                className="om-mobile-hide-print p-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-500 rounded-lg transition-all disabled:opacity-60"
                                title="In phiếu giao (vận đơn thật Shopee)"
                              >
                                <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                              </button>
                            </>
                          )}

                          {order.status === 'processed' && (
                            <>
                              <span className={`om-mobile-hide-print text-[10px] font-bold px-1.5 py-1 rounded ${
                                order.isPrinted ? 'text-emerald-600 bg-emerald-50' : 'text-rose-600 bg-rose-50'
                              }`}>
                                {order.isPrinted ? '✓ Đã in' : '✕ Chưa in'}
                              </span>
                              <button
                                onClick={() => handleSinglePrint(order)}
                                disabled={printingOrderId === order.id}
                                className="om-mobile-hide-print p-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 text-gray-500 rounded-lg transition-all disabled:opacity-60"
                                title="In lại vận đơn (vận đơn thật Shopee)"
                              >
                                <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                              </button>
                              <button
                                onClick={() => {
                                  const updated = orders.map(o => o.id === order.id ? { ...o, status: 'shipping' as const } : o);
                                  onUpdateOrders(updated);
                                }}
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
                            onClick={() => setSelectedOrderDetails(order)}
                            className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500 transition-all"
                            title="Xem chi tiết đơn"
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="om-order-card-list flex flex-col divide-y divide-gray-100 w-full">
            {filteredOrders.map(order => {
              const isChecked = selectedOrderIds.includes(order.id);
              const badge = getStatusBadge(order.status) || { text: order.status, color: '' };
              return (
                <div
                  key={order.id}
                  className={`om-order-card-row flex flex-col lg:flex-row lg:items-center gap-3 lg:gap-4 p-4 w-full transition-colors ${isChecked ? 'bg-blue-50/20' : 'bg-white'}`}
                >
                  <div className="flex items-center gap-2 shrink-0 lg:min-w-[11rem]">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => handleToggleSelectOne(order.id)}
                      className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={`px-1.5 py-0.5 text-[9px] font-black uppercase rounded shrink-0 ${
                          order.channel === 'shopee' ? 'bg-orange-500 text-white' : order.channel === 'tiktok' ? 'bg-zinc-900 text-white' : 'bg-blue-600 text-white'
                        }`}>
                          {order.channel}
                        </span>
                        <span className="font-mono font-black text-gray-900 text-xs truncate">
                          #{order.orderSn}
                        </span>
                      </div>
                      <p className="text-[11px] text-gray-500 font-medium mt-0.5">
                        {new Date(order.date).toLocaleDateString('vi-VN')}
                      </p>
                    </div>
                  </div>

                  <div className="flex-1 min-w-0 bg-slate-50/80 px-2.5 py-2 rounded-xl border border-slate-100">
                    <div className="text-[9px] font-bold text-gray-400 uppercase tracking-wide mb-1">Sản phẩm đặt mua</div>
                    <div className="space-y-1">
                      {order.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between items-start text-gray-700 gap-2">
                          <span className="truncate text-[11px] font-medium leading-tight">{item.productTitle}</span>
                          <span className="text-blue-600 text-xs shrink-0 font-black">x{item.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 lg:gap-4 shrink-0 lg:ml-auto">
                    <div className="text-xs">
                      <span className="text-gray-400 text-[9px] block uppercase font-bold tracking-wider">Tổng thanh toán</span>
                      <span className="font-black text-slate-900 text-sm whitespace-nowrap">{order.totalAmount.toLocaleString('vi-VN')} đ</span>
                      {order.trackingNumber && (
                        <p className="text-[10px] text-indigo-700 font-mono mt-1 flex items-center gap-1">
                          <Barcode className="w-3 h-3 text-indigo-400 shrink-0" />
                          <span className="truncate max-w-[8rem]">{order.trackingNumber}</span>
                        </p>
                      )}
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
                            onClick={() => handleSinglePrint(order)}
                            disabled={printingOrderId === order.id}
                            className="om-mobile-hide-print min-h-11 min-w-11 p-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-xl transition-all disabled:opacity-60 flex items-center justify-center"
                            title="In phiếu giao (vận đơn thật Shopee)"
                          >
                            <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                          </button>
                        </>
                      )}

                      {order.status === 'processed' && (
                        <>
                          <span className={`om-mobile-hide-print text-[11px] font-black px-2.5 py-1 rounded-xl border ${
                            order.isPrinted ? 'text-emerald-600 bg-emerald-50 border-emerald-100' : 'text-rose-600 bg-rose-50 border-rose-100'
                          }`}>
                            {order.isPrinted ? '✓ Đã in' : '✕ Chưa in'}
                          </span>
                          <button
                            onClick={() => handleSinglePrint(order)}
                            disabled={printingOrderId === order.id}
                            className="om-mobile-hide-print min-h-11 min-w-11 p-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-600 rounded-xl transition-all disabled:opacity-60 flex items-center justify-center"
                            title="In lại vận đơn (vận đơn thật Shopee)"
                          >
                            <Printer className={`w-3.5 h-3.5 ${printingOrderId === order.id ? 'animate-spin' : ''}`} />
                          </button>
                          <button
                            onClick={() => {
                              const updated = orders.map(o => o.id === order.id ? { ...o, status: 'shipping' as const } : o);
                              onUpdateOrders(updated);
                            }}
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

                      <button
                        onClick={() => setSelectedOrderDetails(order)}
                        className="min-h-11 px-3 py-2 bg-gray-50 hover:bg-gray-100 text-gray-600 font-bold text-xs rounded-xl flex items-center gap-1 transition-all border border-gray-150"
                        title="Xem chi tiết đơn"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        <span className="max-lg:sr-only">Xem</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
      )}

      {/* 7. MODAL 1: Order Details Drawer/Modal */}
      {selectedOrderDetails && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col">
            <div className="p-6 border-b border-gray-100 flex items-start justify-between bg-slate-900 text-white">
              <div>
                <h3 className="text-base font-extrabold">Chi Tiết Đơn Hàng #{selectedOrderDetails.orderSn}</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Sàn: {selectedOrderDetails.channel === 'manual' ? 'Đơn ngoài sàn (Tự tạo)' : selectedOrderDetails.channel.toUpperCase()} 
                  {selectedOrderDetails.shopName ? ` | Gian: ${selectedOrderDetails.shopName}` : ''}
                </p>
              </div>
              <button 
                onClick={() => setSelectedOrderDetails(null)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto max-h-[480px]">
              
              {/* Delivery info */}
              <div className="space-y-3 bg-gray-50/70 p-4 rounded-2xl border border-gray-100">
                <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider">Thông tin người nhận</h4>
                <div className="space-y-2 text-xs">
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                    <div>
                      <span className="text-gray-400">Địa chỉ:</span>{' '}
                      <strong className="text-gray-800">{selectedOrderDetails.customerName}</strong>
                      <p className="text-gray-500 mt-0.5 text-[11px] leading-relaxed">{selectedOrderDetails.customerAddress || 'Chưa cung cấp đầy đủ thông tin'}</p>
                    </div>
                  </div>
                  {selectedOrderDetails.customerPhone && (
                    <div className="flex items-center gap-2">
                      <Phone className="w-4 h-4 text-emerald-500 shrink-0" />
                      <div>
                        <span className="text-gray-400">Số điện thoại:</span>{' '}
                        <strong className="text-gray-800 font-mono">{selectedOrderDetails.customerPhone}</strong>
                      </div>
                    </div>
                  )}
                  {selectedOrderDetails.trackingNumber && (
                    <div className="flex items-center gap-2">
                      <Barcode className="w-4 h-4 text-indigo-500 shrink-0" />
                      <div>
                        <span className="text-gray-400">Mã bưu cục vận đơn:</span>{' '}
                        <strong className="text-gray-800 font-mono">{selectedOrderDetails.trackingNumber}</strong>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Items List */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider">Sản phẩm khách đặt</h4>
                <div className="border border-gray-100 rounded-2xl overflow-hidden divide-y divide-gray-50">
                  {selectedOrderDetails.items.map((item, index) => (
                    <div key={index} className="p-3 bg-white flex items-center justify-between text-xs gap-3">
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

              {/* Net profit financial summary */}
              <div className="space-y-2 pt-2 border-t border-gray-100 text-xs text-gray-600">
                <div className="flex justify-between">
                  <span>Tổng tiền hàng khách trả:</span>
                  <span className="font-bold text-gray-900">{selectedOrderDetails.totalAmount.toLocaleString('vi-VN')}đ</span>
                </div>
                {selectedOrderDetails.channel !== 'manual' ? (
                  <div className="flex justify-between text-rose-500">
                    <span>Khấu trừ phí sàn ({selectedOrderDetails.channel === 'shopee' ? '12%' : '10%'}):</span>
                    <span className="font-bold">-{(selectedOrderDetails.totalAmount - selectedOrderDetails.revenue).toLocaleString('vi-VN')}đ</span>
                  </div>
                ) : (
                  <div className="flex justify-between text-emerald-600">
                    <span>Phí sàn / Chi phí trung gian:</span>
                    <span className="font-bold">0đ (Đơn trực tiếp)</span>
                  </div>
                )}
                <div className="flex justify-between text-emerald-600 pt-1.5 border-t border-dashed border-gray-200 text-sm">
                  <span className="font-bold">Doanh thu chuyển về ví kho sỉ:</span>
                  <span className="font-extrabold">{selectedOrderDetails.revenue.toLocaleString('vi-VN')}đ</span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end">
              <button 
                onClick={() => setSelectedOrderDetails(null)}
                className="px-5 py-2 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-semibold text-xs rounded-xl transition-all"
              >
                Đóng chi tiết
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating processing overlay — shown for the full duration of any real
          Shopee API call (ship_order / create+download shipping document),
          single or bulk. Highest z-index so it always sits above every other modal. */}
      {progressMessage && (
        <div className="fixed inset-0 bg-gray-900/70 backdrop-blur-xs flex items-center justify-center p-4 z-100 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-sm w-full p-8 shadow-2xl flex flex-col items-center gap-4 text-center">
            <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
            <p className="text-sm font-extrabold text-gray-800 leading-relaxed">{progressMessage}</p>
            <p className="text-[11px] text-gray-400 font-semibold">Vui lòng không tắt hoặc rời khỏi trang trong lúc xử lý.</p>
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
        <div className="fixed inset-0 bg-gray-900/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-3xl w-full overflow-hidden shadow-2xl flex flex-col">
            <div className="p-5 bg-slate-900 text-white flex items-center justify-between">
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
            <div id="bulk-print-area" className="p-6 bg-slate-100/50 overflow-y-auto max-h-[480px] space-y-6">
              {bulkPrintOrders.map((order, index) => (
                <div 
                  key={order.id} 
                  className="bg-white p-5 rounded-xl border-2 border-dashed border-slate-300 w-full max-w-lg mx-auto shadow-sm text-[11px] text-black font-sans space-y-3 relative"
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
                      {order.trackingNumber || 'CHƯA_XÁC_ĐỊNH_VẬN_ĐƠN'}
                    </div>
                    <span className="font-mono text-[9px] uppercase font-black">MÃ VẬN ĐƠN: {order.trackingNumber || 'CHƯA PHÁT HÀNH'}</span>
                  </div>

                  {/* Addresses */}
                  <div className="grid grid-cols-2 gap-4 border-b border-gray-100 pb-2">
                    <div className="space-y-1 text-gray-600">
                      <p className="font-bold text-black uppercase text-[9px]">Gửi từ:</p>
                      <p className="font-semibold text-black">{order.shopName || 'Tổng Kho Sunhouse Hà Nội'}</p>
                      <p className="text-[10px]">Kho trung chuyển Quận Tân Bình, TP. Hồ Chí Minh</p>
                    </div>
                    <div className="space-y-1 text-gray-600 border-l border-gray-100 pl-2">
                      <p className="font-bold text-black uppercase text-[9px]">Người nhận:</p>
                      <p className="font-semibold text-black">{order.customerName}</p>
                      {order.customerPhone && <p className="font-mono">{order.customerPhone}</p>}
                      <p className="text-[10px] leading-tight line-clamp-2">{order.customerAddress || 'Việt Nam'}</p>
                    </div>
                  </div>

                  {/* Items list summary */}
                  <div className="space-y-1">
                    <p className="font-bold text-black uppercase text-[9px]">Danh sách sản phẩm ({order.items.length} phân loại):</p>
                    <div className="divide-y divide-gray-100">
                      {order.items.map((it, itemIdx) => (
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
            <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-between items-center">
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
                  onClick={() => window.print()}
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

      {/* 9. MODAL 3: CREATE MANUAL ORDER (OFF-PLATFORM + LOGISTICS CARRIER) */}
      {showCreateOrderModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-4xl w-full overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="p-6 border-b border-gray-100 flex items-center justify-between bg-emerald-600 text-white">
              <div className="flex items-center gap-2">
                <Plus className="w-5 h-5" />
                <div>
                  <h3 className="text-base font-extrabold">Tạo Đơn Hàng Sỉ Ngoài Sàn (Tự Tạo / Gửi Bưu Cục)</h3>
                  <p className="text-[11px] text-emerald-100 mt-0.5">Tự động khấu trừ tồn kho thực tế &amp; Liên kết API bưu cục để lấy mã vận đơn</p>
                </div>
              </div>
              <button 
                type="button"
                onClick={() => setShowCreateOrderModal(false)}
                className="text-emerald-100 hover:text-white text-lg font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            {/* Content Container (Two columns) */}
            <div className="p-6 overflow-y-auto grid grid-cols-1 md:grid-cols-12 gap-6 bg-gray-50/50">
              
              {/* Column 1: Customer & Carrier Info (col-span-5) */}
              <div className="md:col-span-5 space-y-4">
                <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs space-y-3">
                  <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5 border-b border-gray-100 pb-2">
                    <User className="w-4 h-4 text-emerald-600" /> Thông tin người nhận
                  </h4>
                  
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Tên khách hàng *</label>
                    <input 
                      type="text"
                      required
                      value={custName}
                      onChange={(e) => setCustName(e.target.value)}
                      placeholder="Nguyễn Văn A..."
                      className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-medium text-gray-800"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Số điện thoại *</label>
                    <input 
                      type="text"
                      required
                      value={custPhone}
                      onChange={(e) => setCustPhone(e.target.value)}
                      placeholder="Số điện thoại nhận hàng..."
                      className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium text-gray-800"
                    />
                  </div>

                  <StructuredAddressForm
                    value={shippingAddress}
                    onChange={setShippingAddress}
                    authHeaders={authHeaders}
                  />
                </div>

                <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs space-y-3">
                  <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5 border-b border-gray-100 pb-2">
                    <Truck className="w-4 h-4 text-blue-600" /> Kết nối đối tác bưu cục (API Logistics)
                  </h4>

                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Hình thức / Đơn vị giao</label>
                    <select 
                      value={selectedCarrier}
                      onChange={(e) => {
                        const val = e.target.value as 'self' | 'ghn' | 'spx';
                        setSelectedCarrier(val);
                        if (val === 'self') setShippingFee(0);
                        else setShippingFee(30000);
                      }}
                      className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-bold text-gray-700"
                    >
                      <option value="self">🏍️ Tự giao hàng / GrabShip / COD ngoài</option>
                      <option value="ghn">🚚 Giao Hàng Nhanh (GHN API Cổng Sỉ)</option>
                      <option value="spx">📦 Shopee SPX Express (SPX API Cổng sỉ)</option>
                    </select>
                  </div>

                  {selectedCarrier !== 'self' && (
                    <div className="p-3 bg-blue-50/50 border border-blue-100 rounded-xl space-y-2.5 animate-in slide-in-from-top-2 duration-150">
                      <p className="text-[10px] text-blue-700 font-semibold leading-relaxed">
                        ⚡ Hệ thống đang kết nối qua cổng API Sandbox/Production. Đơn hàng sau khi tạo sẽ tự động khởi tạo vận đơn trên hệ thống {selectedCarrier === 'ghn' ? 'GHN' : 'SPX'} và trả về mã vạch in nhiệt.
                      </p>
                      
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="text-[10px] font-semibold text-gray-500">Trọng lượng (Grams)</label>
                          <input 
                            type="number"
                            value={packageWeight}
                            onChange={(e) => setPackageWeight(Number(e.target.value))}
                            className="w-full mt-0.5 px-2.5 py-1.5 bg-white rounded-lg border border-gray-200 text-xs font-mono text-gray-800"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-semibold text-gray-500">Tiền vận chuyển (đ)</label>
                          <input 
                            type="number"
                            value={shippingFee}
                            onChange={(e) => setShippingFee(Number(e.target.value))}
                            className="w-full mt-0.5 px-2.5 py-1.5 bg-white rounded-lg border border-gray-200 text-xs font-mono text-gray-800"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="text-[10px] font-semibold text-gray-500">Ghi chú bưu tá lấy hàng</label>
                        <input 
                          type="text"
                          value={carrierNotes}
                          onChange={(e) => setCarrierNotes(e.target.value)}
                          className="w-full mt-0.5 px-2.5 py-1.5 bg-white rounded-lg border border-gray-200 text-xs text-gray-800"
                        />
                      </div>
                    </div>
                  )}

                  {selectedCarrier === 'self' && (
                    <div>
                      <label className="text-[11px] font-semibold text-gray-500">Phí giao hàng dự kiến (đ)</label>
                      <input 
                        type="number"
                        value={shippingFee}
                        onChange={(e) => setShippingFee(Number(e.target.value))}
                        className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium text-gray-800"
                      />
                    </div>
                  )}

                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Mã giảm giá đơn hàng (đ)</label>
                    <input 
                      type="number"
                      value={orderDiscount}
                      onChange={(e) => setOrderDiscount(Number(e.target.value))}
                      className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium text-gray-800"
                      placeholder="0"
                    />
                  </div>
                </div>
              </div>

              {/* Column 2: Product selection & Cart (col-span-7) */}
              <div className="md:col-span-7 space-y-4">
                {/* Selector */}
                <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs space-y-3">
                  <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5 border-b border-gray-100 pb-2">
                    <Package className="w-4 h-4 text-amber-500" /> Chọn sản phẩm sỉ từ kho
                  </h4>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                    <div className="sm:col-span-5">
                      <label className="text-[11px] font-semibold text-gray-500">Sản phẩm khả dụng</label>
                      <select 
                        value={selectedProdId}
                        onChange={(e) => {
                          const id = e.target.value;
                          setSelectedProdId(id);
                          const prod = products.find(p => p.id === id);
                          if (prod) {
                            setSelectedPrice(prod.sellingPrice);
                          }
                        }}
                        className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs text-gray-700 font-semibold"
                      >
                        <option value="">-- Chọn sản phẩm sỉ --</option>
                        {products.map(prod => (
                          <option key={prod.id} value={prod.id} disabled={prod.stock <= 0}>
                            {prod.title} (SKU: {prod.sku}) - Tồn: {prod.stock}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="sm:col-span-3">
                      <label className="text-[11px] font-semibold text-gray-500">Số lượng</label>
                      <input 
                        type="number"
                        min={1}
                        value={selectedQty}
                        onChange={(e) => setSelectedQty(Math.max(1, Number(e.target.value)))}
                        className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium text-gray-800"
                      />
                    </div>

                    <div className="sm:col-span-4">
                      <label className="text-[11px] font-semibold text-gray-500">Giá bán sỉ (đ)</label>
                      <input 
                        type="number"
                        value={selectedPrice}
                        onChange={(e) => setSelectedPrice(Number(e.target.value))}
                        className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium text-gray-800"
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-1">
                    <button
                      type="button"
                      onClick={handleAddItemToOrder}
                      className="px-4 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-extrabold text-xs rounded-xl border border-emerald-150 flex items-center gap-1.5 transition-all cursor-pointer"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Thêm vào giỏ</span>
                    </button>
                  </div>
                </div>

                {/* Items Cart List */}
                <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs space-y-3">
                  <h4 className="text-xs font-bold text-gray-700 uppercase tracking-wider border-b border-gray-100 pb-2">
                    Danh sách sản phẩm đã chọn ({orderItems.length})
                  </h4>

                  {orderItems.length === 0 ? (
                    <div className="py-8 text-center text-gray-400 text-xs">
                      Chưa có sản phẩm nào được chọn. Chọn sản phẩm phía trên để đưa vào đơn hàng.
                    </div>
                  ) : (
                    <div className="overflow-hidden border border-gray-100 rounded-xl divide-y divide-gray-100">
                      <div className="bg-gray-50 p-3 grid grid-cols-12 gap-2 text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                        <div className="col-span-6">Tên / SKU</div>
                        <div className="col-span-2 text-center">Số lượng</div>
                        <div className="col-span-3 text-right">Đơn giá / Thành tiền</div>
                        <div className="col-span-1 text-center">Xóa</div>
                      </div>

                      <div className="max-h-[160px] overflow-y-auto divide-y divide-gray-100">
                        {orderItems.map((item) => (
                          <div key={item.productId} className="p-3 grid grid-cols-12 gap-2 items-center text-xs text-gray-700 hover:bg-gray-50/50">
                            <div className="col-span-6 pr-2">
                              <p className="font-bold text-gray-800 truncate">{item.productTitle}</p>
                              <span className="font-mono text-[9px] bg-gray-100 text-gray-500 px-1 py-0.2 rounded font-medium">SKU: {item.sku}</span>
                            </div>
                            <div className="col-span-2 text-center font-bold text-gray-900">
                              x{item.quantity}
                            </div>
                            <div className="col-span-3 text-right">
                              <p className="font-semibold">{item.price.toLocaleString('vi-VN')}đ</p>
                              <p className="text-[10px] text-emerald-600 font-bold">{(item.price * item.quantity).toLocaleString('vi-VN')}đ</p>
                            </div>
                            <div className="col-span-1 text-center">
                              <button 
                                type="button"
                                onClick={() => handleRemoveItemFromOrder(item.productId)}
                                className="text-gray-400 hover:text-rose-600 p-1 rounded-lg hover:bg-rose-50 transition-all cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Subtotals Panel */}
                <div className="bg-emerald-50/35 border border-emerald-100/50 rounded-2xl p-4 space-y-2 text-xs">
                  <div className="flex justify-between text-gray-600">
                    <span>Tổng tiền hàng:</span>
                    <span className="font-semibold text-gray-800">
                      {orderItems.reduce((sum, item) => sum + (item.price * item.quantity), 0).toLocaleString('vi-VN')}đ
                    </span>
                  </div>
                  <div className="flex justify-between text-gray-600">
                    <span>Phí vận chuyển bưu cục:</span>
                    <span className="font-semibold text-gray-800">+{shippingFee.toLocaleString('vi-VN')}đ</span>
                  </div>
                  {orderDiscount > 0 && (
                    <div className="flex justify-between text-rose-500">
                      <span>Mã giảm giá đã áp dụng:</span>
                      <span className="font-semibold">-{orderDiscount.toLocaleString('vi-VN')}đ</span>
                    </div>
                  )}
                  <div className="border-t border-dashed border-emerald-200/50 my-2 pt-2 flex justify-between text-gray-900 text-sm">
                    <span className="font-bold flex items-center gap-1">
                      <CreditCard className="w-4 h-4 text-emerald-600" /> Tổng tiền khách cần thanh toán (Thu COD):
                    </span>
                    <span className="font-black text-emerald-700 text-base">
                      {Math.max(0, orderItems.reduce((sum, item) => sum + (item.price * item.quantity), 0) + shippingFee - orderDiscount).toLocaleString('vi-VN')}đ
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer Buttons */}
            <div className="p-4 bg-gray-100 border-t border-gray-200 flex justify-end gap-3.5">
              <button 
                type="button"
                onClick={() => setShowCreateOrderModal(false)}
                className="px-5 py-2.5 bg-white hover:bg-gray-100 border border-gray-300 text-gray-700 font-bold text-xs rounded-xl transition-all cursor-pointer"
              >
                Hủy bỏ
              </button>
              <button 
                type="button"
                onClick={handleSubmitManualOrder}
                disabled={submittingManualOrder}
                className="px-6 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-70 text-white font-extrabold text-xs rounded-xl shadow-md shadow-emerald-500/10 hover:shadow-emerald-500/30 transition-all flex items-center gap-1.5 cursor-pointer animate-pulse"
              >
                {submittingManualOrder ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>{submittingManualOrder ? 'Đang đẩy đơn...' : 'Xác nhận & Đẩy đơn API'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
