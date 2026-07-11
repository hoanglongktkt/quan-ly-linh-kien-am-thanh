import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import {
  Barcode,
  Camera,
  Check,
  CheckCircle2,
  ImageOff,
  Loader2,
  Package,
  X,
} from 'lucide-react';
import { Order, SyncLog } from '../types';
import { startRearCameraScanner, HTTPS_CAMERA_MESSAGE } from '../utils/cameraScanner';

interface OrderPickingProps {
  orders: Order[];
  onUpdateOrders: (orders: Order[]) => void;
  onAddLog?: (log: SyncLog) => void;
}

interface PickLine {
  key: string;
  productId: string;
  productTitle: string;
  productImage?: string;
  quantity: number;
}

function vibratePick() {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    navigator.vibrate(45);
  }
}

export default function OrderPicking({ orders, onUpdateOrders, onAddLog }: OrderPickingProps) {
  const [scanInput, setScanInput] = useState('');
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [pickedKeys, setPickedKeys] = useState<Set<string>>(new Set());
  const [scanError, setScanError] = useState('');
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraError, setCameraError] = useState('');
  const [cameraRestartKey, setCameraRestartKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const pickLines: PickLine[] = useMemo(() => {
    if (!activeOrder) return [];
    return (activeOrder.items ?? []).map((item, idx) => ({
      key: `${item.productId || 'item'}-${idx}`,
      productId: item.productId,
      productTitle: item.productTitle,
      productImage: item.productImage,
      quantity: Math.max(1, Number(item.quantity) || 1),
    }));
  }, [activeOrder]);

  const pickedCount = pickLines.filter((line) => pickedKeys.has(line.key)).length;
  const totalLines = pickLines.length;
  const progressPct = totalLines > 0 ? Math.round((pickedCount / totalLines) * 100) : 0;
  const allPicked = totalLines > 0 && pickedCount === totalLines;

  const resetSession = useCallback(() => {
    setActiveOrder(null);
    setPickedKeys(new Set());
    setScanInput('');
    setScanError('');
    setCameraOpen(false);
    setCameraError('');
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  const lookupOrder = useCallback(
    (raw: string) => {
      const query = raw.trim().toUpperCase();
      if (!query) {
        setScanError('Vui lòng nhập hoặc quét mã đơn hàng.');
        return;
      }

      const found = orders.find(
        (o) =>
          o.status === 'unprocessed' &&
          (o.orderSn.toUpperCase() === query ||
            o.id.toUpperCase() === query ||
            (o.trackingNumber && o.trackingNumber.toUpperCase() === query))
      );

      if (!found) {
        const other = orders.find(
          (o) =>
            o.orderSn.toUpperCase() === query ||
            o.id.toUpperCase() === query ||
            (o.trackingNumber && o.trackingNumber.toUpperCase() === query)
        );
        if (other && other.status !== 'unprocessed') {
          setScanError(`Đơn #${other.orderSn} không ở trạng thái "Chờ lấy hàng (Chưa xử lý)".`);
        } else {
          setScanError(`Không tìm thấy đơn chờ lấy hàng khớp mã "${raw.trim()}".`);
        }
        setActiveOrder(null);
        setPickedKeys(new Set());
        return;
      }

      if (!found.items?.length) {
        setScanError(`Đơn #${found.orderSn} chưa có danh sách sản phẩm.`);
        return;
      }

      setScanError('');
      setActiveOrder(found);
      setPickedKeys(new Set());
      setCameraOpen(false);
    },
    [orders]
  );

  const handleScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    lookupOrder(scanInput);
  };

  const togglePick = (key: string) => {
    setPickedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        vibratePick();
      }
      return next;
    });
  };

  const handleMoveToPacking = async () => {
    if (!activeOrder) return;
    if (!allPicked) {
      alert(`Chưa nhặt đủ sản phẩm! (${pickedCount}/${totalLines})`);
      return;
    }

    setSubmitting(true);
    try {
      const updated = orders.map((o) =>
        o.id === activeOrder.id
          ? { ...o, status: 'processed' as const, isPrepared: true }
          : o
      );
      onUpdateOrders(updated);
      onAddLog?.({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: activeOrder.channel,
        type: 'stock_sync',
        status: 'success',
        message: `[NHẶT HÀNG] Hoàn tất nhặt đơn #${activeOrder.orderSn} — chuyển sang đóng gói.`,
      });
      vibratePick();
      resetSession();
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (!cameraOpen || activeOrder) return;

    let html5Qrcode: Html5Qrcode | null = null;
    let isMounted = true;

    const timer = setTimeout(() => {
      if (!isMounted) return;
      const element = document.getElementById('picking-camera-reader');
      if (!element) return;

      html5Qrcode = new Html5Qrcode('picking-camera-reader');

      const onScan = (decodedText: string) => {
        if (!decodedText) return;
        setScanInput(decodedText.trim());
        lookupOrder(decodedText);
      };

      const config = {
        fps: 12,
        qrbox: (w: number, h: number) => {
          const size = Math.min(w, h) * 0.7;
          return { width: size, height: size };
        },
      };

      void startRearCameraScanner(html5Qrcode, config, onScan, () => {})
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Không thể mở camera.';
          setCameraError(
            msg === HTTPS_CAMERA_MESSAGE
              ? msg
              : 'Không thể khởi động camera. Hãy cấp quyền và bấm "Thử lại".'
          );
        });
    }, 300);

    return () => {
      isMounted = false;
      clearTimeout(timer);
      if (html5Qrcode?.isScanning) {
        html5Qrcode.stop().catch(() => undefined);
      }
    };
  }, [cameraOpen, activeOrder, cameraRestartKey, lookupOrder]);

  return (
    <div className="max-md:space-y-3 space-y-5 max-w-3xl mx-auto pb-24 md:pb-6">
      {!activeOrder ? (
        <div className="bg-white max-md:rounded-b-2xl md:rounded-2xl border border-gray-100 max-md:border-x-0 max-md:border-t-0 shadow-xs max-md:px-3 max-md:pt-2 max-md:pb-4 p-4 sm:p-5 space-y-3 md:space-y-4">
          <form onSubmit={handleScanSubmit} className="space-y-3">
            <label className="text-xs font-bold text-gray-600 uppercase tracking-wide">
              Quét hoặc nhập mã đơn
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Barcode className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  ref={inputRef}
                  type="text"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  placeholder="Mã đơn, mã vận đơn..."
                  autoFocus
                  className="w-full min-h-12 pl-10 pr-4 py-3 rounded-xl border border-gray-200 bg-gray-50 focus:bg-white focus:border-emerald-500 outline-none text-sm font-mono"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  setCameraError('');
                  setCameraOpen((v) => !v);
                }}
                className={`min-h-12 min-w-12 shrink-0 rounded-xl border flex items-center justify-center transition-all ${
                  cameraOpen
                    ? 'bg-emerald-600 border-emerald-600 text-white'
                    : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
                }`}
                title="Quét bằng camera"
              >
                <Camera className="w-5 h-5" />
              </button>
            </div>
            <button
              type="submit"
              className="w-full min-h-12 py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl transition-colors"
            >
              Tìm đơn hàng
            </button>
          </form>

          {scanError && (
            <p className="text-xs font-semibold text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2.5">
              {scanError}
            </p>
          )}

          {cameraOpen && (
            <div className="rounded-2xl border border-gray-200 overflow-hidden bg-black relative">
              <div id="picking-camera-reader" className="w-full min-h-[220px]" />
              {cameraError && (
                <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center p-4 text-center gap-3">
                  <p className="text-xs text-rose-300 font-semibold">{cameraError}</p>
                  {cameraError !== HTTPS_CAMERA_MESSAGE && (
                    <button
                      type="button"
                      onClick={() => {
                        setCameraError('');
                        setCameraRestartKey((k) => k + 1);
                      }}
                      className="min-h-11 px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold"
                    >
                      Thử lại
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-gray-100 shadow-xs p-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase">Đơn đang nhặt</p>
              <p className="text-base font-extrabold text-gray-900 font-mono">#{activeOrder.orderSn}</p>
              <p className="text-xs text-gray-500 mt-0.5">{activeOrder.customerName}</p>
            </div>
            <button
              type="button"
              onClick={resetSession}
              className="min-h-11 min-w-11 flex items-center justify-center rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50"
              title="Quét đơn khác"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="bg-white rounded-2xl border border-gray-100 shadow-xs p-4 space-y-2">
            <div className="flex items-center justify-between text-xs font-bold text-gray-600">
              <span>Đã nhặt {pickedCount}/{totalLines} sản phẩm</span>
              <span className="text-emerald-600">{progressPct}%</span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-300 rounded-full"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <ul className="space-y-3">
            {pickLines.map((line) => {
              const isPicked = pickedKeys.has(line.key);
              return (
                <li key={line.key}>
                  <button
                    type="button"
                    onClick={() => togglePick(line.key)}
                    className={`w-full min-h-[72px] flex items-center gap-3 p-3 rounded-2xl border-2 text-left transition-all ${
                      isPicked
                        ? 'border-emerald-500 bg-emerald-50 shadow-sm'
                        : 'border-gray-100 bg-white hover:border-emerald-200 hover:bg-emerald-50/30'
                    }`}
                  >
                    <div
                      className={`min-h-12 min-w-12 shrink-0 rounded-xl border-2 flex items-center justify-center transition-colors ${
                        isPicked
                          ? 'border-emerald-500 bg-emerald-500 text-white'
                          : 'border-gray-200 bg-gray-50 text-gray-400'
                      }`}
                    >
                      {isPicked ? <Check className="w-6 h-6 stroke-[3]" /> : <Package className="w-5 h-5" />}
                    </div>

                    {line.productImage ? (
                      <img
                        src={line.productImage}
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
                      <p className={`text-sm font-bold line-clamp-2 ${isPicked ? 'text-emerald-900' : 'text-gray-900'}`}>
                        {line.productTitle}
                      </p>
                      <p className="text-xs font-mono text-gray-400 mt-0.5">SL: {line.quantity}</p>
                    </div>

                    <span
                      className={`shrink-0 text-[11px] font-extrabold uppercase px-2.5 py-1 rounded-lg ${
                        isPicked ? 'bg-emerald-600 text-white' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {isPicked ? 'Đã nhặt' : 'Chưa nhặt'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            disabled={!allPicked || submitting}
            onClick={() => void handleMoveToPacking()}
            className={`w-full min-h-14 py-4 rounded-2xl font-extrabold text-sm flex items-center justify-center gap-2 transition-all ${
              allPicked
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-lg shadow-indigo-500/20'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            {submitting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <CheckCircle2 className="w-5 h-5" />
            )}
            Chuyển đóng gói
          </button>

          {!allPicked && totalLines > 0 && (
            <p className="text-center text-[11px] text-amber-600 font-semibold">
              Tích &quot;Đã nhặt&quot; cho tất cả {totalLines} dòng sản phẩm để kích hoạt nút.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
