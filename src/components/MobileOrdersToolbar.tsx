import { useEffect, useRef, useState } from 'react';
import { Barcode, Eye, EyeOff, Loader2, Package, Plus, Search, Wallet, X } from 'lucide-react';
import { startLiveQrScanner, type LiveQrScannerHandle } from '../utils/cameraScanner';
import { lookupPickingOrder } from '../utils/orderScan';
import { safeGetItem, safeGetJson, safeSetItem } from '../utils/safeStorage';
import type { Order } from '../types';

const profitVisibilityKey = 'omni_mobile_order_profit_hidden';
const numberFormat = new Intl.NumberFormat('vi-VN');

type DailySummary = { orders: number; profit: number };

export function MobileOrdersOverview({ onOpenOrder, refreshKey }: {
  onOpenOrder: (order: Order) => void;
  refreshKey: number;
}) {
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [hideProfit, setHideProfit] = useState(() => safeGetJson(profitVisibilityKey, true));
  const [scannerOpen, setScannerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [lookup, setLookup] = useState<{ code: string; immediate: boolean } | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [lookupError, setLookupError] = useState('');
  const onOpenOrderRef = useRef(onOpenOrder);
  const lookupControllerRef = useRef<AbortController | null>(null);
  onOpenOrderRef.current = onOpenOrder;

  const searchForOrder = (value: string, immediate = false) => {
    const code = value.trim();
    lookupControllerRef.current?.abort();
    setQuery(value);
    setLookingUp(false);
    setLookupError('');
    setLookup(code.length >= 4 ? { code, immediate } : null);
    if (code.length < 4 && immediate) setLookupError('Nhập đầy đủ mã đơn hàng hoặc mã vận đơn.');
  };

  const openScanner = () => {
    lookupControllerRef.current?.abort();
    setLookup(null);
    setLookingUp(false);
    setLookupError('');
    setScannerOpen(true);
  };

  useEffect(() => {
    if (!lookup) return;
    const controller = new AbortController();
    lookupControllerRef.current = controller;
    const timer = window.setTimeout(async () => {
      setLookingUp(true);
      try {
        const order = await lookupPickingOrder(lookup.code, safeGetItem('admin_token'), controller.signal);
        if (controller.signal.aborted) return;
        if (order) onOpenOrderRef.current(order);
        else setLookupError('Không tìm thấy đơn. Kiểm tra lại mã đơn hoặc mã vận đơn.');
      } catch {
        if (!controller.signal.aborted) setLookupError('Không thể tra cứu đơn hàng. Thử lại.');
      } finally {
        if (!controller.signal.aborted) setLookingUp(false);
      }
    }, lookup.immediate ? 0 : 500);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (lookupControllerRef.current === controller) lookupControllerRef.current = null;
    };
  }, [lookup]);

  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      if (document.hidden) return;
      const token = localStorage.getItem('admin_token');
      try {
        const response = await fetch('/api/dashboard?date_range=today', {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted) {
          setSummary(!data.message && Number.isFinite(data.meta?.ordersInRange) && Number.isFinite(data.kpi?.profit)
            ? { orders: data.meta.ordersInRange, profit: data.kpi.profit }
            : null);
        }
      } catch {
        // A temporary request failure leaves the last successful summary visible.
      }
    };
    const timer = window.setTimeout(refresh, 300);
    const interval = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [refreshKey]);

  return (
    <>
      <div className="-mx-2 bg-slate-900 px-3 pb-3">
        <form className="flex h-12 items-center gap-2 rounded-xl bg-white pl-3 text-slate-500 focus-within:ring-2 focus-within:ring-blue-400" onSubmit={(event) => { event.preventDefault(); searchForOrder(query, true); }}>
          {lookingUp ? <Loader2 className="size-5 shrink-0 animate-spin text-blue-700" aria-hidden="true" /> : <Search className="size-5 shrink-0" aria-hidden="true" />}
          <input
            type="text"
            inputMode="search"
            enterKeyHint="search"
            autoComplete="off"
            aria-label="Tìm mã đơn hàng hoặc mã vận đơn"
            placeholder="Tìm mã đơn hàng, mã vận đơn…"
            aria-describedby={lookupError ? 'mobile-order-lookup-error' : undefined}
            value={query}
            onChange={(event) => searchForOrder(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-base text-slate-900 outline-none placeholder:text-sm placeholder:text-slate-500"
          />
          {query && (
            <button type="button" aria-label="Xóa tìm kiếm" onClick={() => searchForOrder('')} className="grid size-9 shrink-0 place-items-center">
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={openScanner} aria-label="Quét mã để tìm đơn" className="grid h-11 w-12 shrink-0 place-items-center rounded-r-xl border-l border-slate-200 text-blue-700 active:bg-blue-50">
            <Barcode className="size-6" aria-hidden="true" />
          </button>
        </form>
        <p className="sr-only" role="status">{lookingUp ? 'Đang tìm đơn hàng…' : ''}</p>
        {lookupError && <p id="mobile-order-lookup-error" role="alert" className="mt-2 text-xs text-rose-200">{lookupError}</p>}
      </div>
      <section aria-label="Tổng quan hôm nay" className="grid grid-cols-2 gap-2.5 px-1 pt-1">
        <div className="min-w-0 rounded-xl bg-white px-3 pb-2.5 pt-2 shadow-sm">
          <div className="flex h-9 items-center gap-1.5 text-[11px] font-semibold text-slate-600">
            <Package className="size-4 shrink-0 text-blue-600" aria-hidden="true" /> Đơn hôm nay
          </div>
          <p className="text-lg font-bold leading-6 text-slate-900 tabular-nums">{summary ? numberFormat.format(summary.orders) : '—'} {summary && <span className="text-xs font-medium text-slate-500">đơn</span>}</p>
        </div>
        <div className="min-w-0 rounded-xl bg-white px-3 pb-2.5 pt-2 shadow-sm">
          <div className="flex h-9 items-center justify-between gap-1 text-[11px] font-semibold text-slate-600">
            <span className="flex min-w-0 items-center gap-1.5"><Wallet className="hidden size-4 shrink-0 text-emerald-700 min-[420px]:block" aria-hidden="true" /> Lợi nhuận tạm tính</span>
            <button
              type="button"
              aria-label={hideProfit ? 'Hiện lợi nhuận' : 'Ẩn lợi nhuận'}
              onClick={() => {
                safeSetItem(profitVisibilityKey, JSON.stringify(!hideProfit));
                setHideProfit(!hideProfit);
              }}
              className="-mr-2 grid w-9 shrink-0 place-items-center rounded-lg text-slate-600 active:bg-slate-100"
            >
              {hideProfit ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
            </button>
          </div>
          <p className={`break-words text-lg font-bold leading-6 tabular-nums ${summary && summary.profit < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
            {hideProfit ? '••••••' : summary ? `${numberFormat.format(summary.profit)} đ` : '—'}
          </p>
        </div>
      </section>
      {scannerOpen && <QuickOrderLookupScanner onClose={() => setScannerOpen(false)} onRead={(code) => { searchForOrder(code, true); setScannerOpen(false); }} />}
    </>
  );
}

function QuickOrderLookupScanner({ onClose, onRead }: { onClose: () => void; onRead: (code: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  const [status, setStatus] = useState('Đang mở camera…');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let active = true;
    let decoded = false;
    let scanner: LiveQrScannerHandle | undefined;
    void startLiveQrScanner({
      containerId: 'mobile-order-lookup-camera',
      onSuccess(value) {
        const code = value.trim();
        if (!active || decoded || !code) return false;
        decoded = true;
        onReadRef.current(code);
      },
    }).then((handle) => {
      if (!active) { void handle.stop(); return; }
      scanner = handle;
      setStatus('Đưa mã đơn hàng hoặc mã vận đơn vào giữa khung.');
    }).catch((error: unknown) => {
      if (active) setStatus(error instanceof Error ? error.message : 'Không mở được camera.');
    });
    return () => {
      active = false;
      element?.close();
      if (scanner) void scanner.stop();
    };
  }, []);

  return (
    <dialog ref={dialog} aria-labelledby="mobile-order-lookup-title" onCancel={(event) => { event.preventDefault(); onClose(); }} className="m-auto w-[calc(100%-1.5rem)] max-w-sm rounded-2xl bg-white p-3 shadow-xl backdrop:bg-slate-950/70">
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2 id="mobile-order-lookup-title" className="font-bold text-slate-900">Quét mã tìm đơn</h2>
        <button type="button" onClick={onClose} aria-label="Đóng máy quét tìm đơn" className="grid size-11 shrink-0 place-items-center rounded-lg bg-slate-100"><X className="size-5" /></button>
      </div>
      <div id="mobile-order-lookup-camera" className="aspect-video w-full overflow-hidden rounded-xl bg-slate-900" />
      <p role="status" className="mt-2 text-sm text-slate-600">{status}</p>
    </dialog>
  );
}

export function MobileOrderTabs<T extends string>({ tabs, active, onSelect }: {
  tabs: readonly { id: T; label: string; count: number }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  const strip = useRef<HTMLElement>(null);
  useEffect(() => {
    const bar = strip.current;
    const selected = bar?.querySelector('[aria-pressed="true"]');
    if (!bar || !selected) return;
    const bounds = bar.getBoundingClientRect();
    const item = selected.getBoundingClientRect();
    if (item.left < bounds.left) bar.scrollLeft += item.left - bounds.left - 12;
    if (item.right > bounds.right) bar.scrollLeft += item.right - bounds.right + 12;
  }, [active]);

  return (
    <nav ref={strip} aria-label="Trạng thái đơn hàng" className="scrollbar-hide sticky top-0 z-30 -mx-2 flex items-center gap-1.5 overflow-x-auto overscroll-x-contain border-y border-blue-950 bg-blue-900 px-3 py-1.5 shadow-sm" onTouchStart={(event) => event.stopPropagation()}>
      {tabs.map(({ id, label, count }) => (
        <button key={id} type="button" aria-pressed={active === id} onClick={() => onSelect(id)} className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-1.5 text-xs font-semibold leading-tight transition-colors ${active === id ? 'border-white bg-white text-blue-950 shadow-sm' : 'border-blue-700 bg-blue-800 text-white active:bg-blue-700'}`}>
          {label}
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none tabular-nums ${active === id ? 'bg-blue-900 text-white' : 'bg-blue-950/70 text-blue-100'}`}>{count}</span>
        </button>
      ))}
    </nav>
  );
}

export function MobileQuickOrderButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Tạo đơn nhanh" className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-40 grid size-14 place-items-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-900/30 active:bg-blue-700">
      <Plus className="size-7" aria-hidden="true" />
    </button>
  );
}
