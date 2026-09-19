import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Loader2,
  Printer,
  Save,
  Settings2,
  Store,
  Trash2,
} from 'lucide-react';
import { Order, Product, SyncLog } from '../types';
import ImportProductSearchSelect, {
  ImportProductSearchSelectHandle,
} from './ImportProductSearchSelect';
import CurrencyInput from './CurrencyInput';
import { AddressBookEntry, fetchAddressBook } from '../utils/addressBook';
import {
  buildPosPriceChips,
  lookupCustomerSkuPrice,
  mergePosPriceHistory,
  mergePosSkuPrices,
  resolvePosSellingPrice,
  roundPosPrice,
} from '../utils/posSellingPrice';

type PosLine = {
  productId: string;
  productTitle: string;
  productImage?: string;
  sku: string;
  quantity: number;
  importPrice: number;
  sellingPrice: number;
  stock?: number;
  catalogSellingPrice?: number;
  posPriceHistory?: number[];
  customerPrice?: number;
};

function digitsPhone(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function findCustomerByPhone(book: AddressBookEntry[], phone: string): AddressBookEntry | null {
  const digits = digitsPhone(phone);
  if (!digits) return null;
  for (let i = 0; i < book.length; i += 1) {
    if (book[i].phone === digits) return book[i];
  }
  return null;
}

function resolveLineFromProduct(
  p: Product,
  customer: AddressBookEntry | null,
): Pick<PosLine, 'sellingPrice' | 'catalogSellingPrice' | 'posPriceHistory' | 'customerPrice'> {
  const catalogSellingPrice = roundPosPrice(p.sellingPrice);
  const posPriceHistory = mergePosPriceHistory(p.posPriceHistory, p.posLastSellingPrice);
  const customerPrice = lookupCustomerSkuPrice(customer?.posSkuPrices, p.sku);
  const resolved = resolvePosSellingPrice({
    customerPrice,
    posLastSellingPrice: p.posLastSellingPrice,
    catalogSellingPrice,
  });
  return {
    sellingPrice: resolved.price,
    catalogSellingPrice,
    posPriceHistory,
    customerPrice,
  };
}

type StoreInvoiceInfo = {
  storeName: string;
  storePhone: string;
  storeAddress: string;
  logoUrl: string;
};

const STORE_INFO_LS_KEY = 'pos_invoice_store_info';

const EMPTY_STORE_INFO: StoreInvoiceInfo = {
  storeName: '',
  storePhone: '',
  storeAddress: '',
  logoUrl: '',
};

function loadStoreInfo(): StoreInvoiceInfo {
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

function saveStoreInfo(info: StoreInvoiceInfo) {
  try {
    localStorage.setItem(STORE_INFO_LS_KEY, JSON.stringify(info));
  } catch {
    /* ignore quota / private mode */
  }
}

interface QuickPosPageProps {
  products: Product[];
  orders: Order[];
  onBack: () => void;
  onUpdateOrders: (orders: Order[]) => void;
  onUpdateProduct?: (product: Product, opts?: { save?: boolean }) => void;
  onAddLog: (log: SyncLog) => void;
  authHeaders: () => Record<string, string>;
}

function formatVnd(n: number): string {
  return Math.round(n || 0).toLocaleString('vi-VN');
}

function productImage(p: Product | PosLine): string {
  return String(
    (p as any).productImage ||
      (p as any).imageUrl ||
      (p as any).avatarUrl ||
      (p as any).image ||
      '',
  );
}

function entryDisplayAddress(entry: AddressBookEntry): string {
  return (
    entry.fullAddress ||
    [entry.street, entry.wardName, entry.districtName, entry.provinceName]
      .filter(Boolean)
      .join(', ')
  );
}

export default function QuickPosPage({
  products,
  orders,
  onBack,
  onUpdateOrders,
  onUpdateProduct,
  onAddLog,
  authHeaders,
}: QuickPosPageProps) {
  const searchRef = useRef<ImportProductSearchSelectHandle>(null);
  const phoneWrapRef = useRef<HTMLDivElement>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [walkIn, setWalkIn] = useState(true);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<PosLine[]>([]);
  const [shippingFee, setShippingFee] = useState(0);
  const [prepaidAmount, setPrepaidAmount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>([]);
  const [phoneSuggestOpen, setPhoneSuggestOpen] = useState(false);
  const [phoneQuery, setPhoneQuery] = useState('');
  const [storeInfo, setStoreInfo] = useState<StoreInvoiceInfo>(EMPTY_STORE_INFO);
  const [storeInfoOpen, setStoreInfoOpen] = useState(false);

  useEffect(() => {
    setStoreInfo(loadStoreInfo());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchAddressBook(authHeaders).then((list) => {
      if (!cancelled) setAddressBook(list);
    });
    return () => {
      cancelled = true;
    };
  }, [authHeaders]);

  const patchStoreInfo = (patch: Partial<StoreInvoiceInfo>) => {
    setStoreInfo((prev) => {
      const next = { ...prev, ...patch };
      saveStoreInfo(next);
      return next;
    });
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!phoneWrapRef.current?.contains(e.target as Node)) {
        setPhoneSuggestOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const phoneSuggestions = useMemo(() => {
    const q = phoneQuery.trim().toLowerCase();
    if (q.length < 1) return [];
    const digits = q.replace(/\D/g, '');
    const matched: AddressBookEntry[] = [];
    for (let i = 0; i < addressBook.length && matched.length < 12; i += 1) {
      const e = addressBook[i];
      const nameHit = e.name.toLowerCase().includes(q);
      const phoneHit = digits.length > 0 && e.phone.includes(digits);
      if (nameHit || phoneHit) matched.push(e);
    }
    return matched;
  }, [addressBook, phoneQuery]);

  const pickAddressEntry = (entry: AddressBookEntry) => {
    setCustomerName(entry.name || '');
    setCustomerPhone(entry.phone || '');
    setPhoneQuery(entry.phone || '');
    const addr = entryDisplayAddress(entry);
    if (addr) {
      setCustomerAddress(addr);
      setWalkIn(false);
    }
    setPhoneSuggestOpen(false);
    setLines((prev) =>
      prev.map((l) => {
        const customerPrice = lookupCustomerSkuPrice(entry.posSkuPrices, l.sku);
        if (customerPrice <= 0) {
          return { ...l, customerPrice: 0 };
        }
        return { ...l, sellingPrice: customerPrice, customerPrice };
      }),
    );
  };

  const subtotal = useMemo(
    () => lines.reduce((s, l) => s + l.sellingPrice * l.quantity, 0),
    [lines],
  );
  const totalAmount = Math.max(0, subtotal + Math.max(0, shippingFee));
  const amountDue = Math.max(0, totalAmount - Math.max(0, prepaidAmount));

  const addProduct = (p: Product) => {
    const id = String(p.id || '').trim();
    if (!id) return;
    const customer = findCustomerByPhone(addressBook, customerPhone);
    const priceFields = resolveLineFromProduct(p, customer);
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.productId === id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 };
        return next;
      }
      return [
        ...prev,
        {
          productId: id,
          productTitle: String(p.title || ''),
          productImage: productImage(p),
          sku: String(p.sku || ''),
          quantity: 1,
          importPrice: Math.max(0, Math.round(Number(p.importPrice) || 0)),
          stock: Math.max(0, Math.round(Number(p.stock) || 0)),
          ...priceFields,
        },
      ];
    });
    setError(null);
  };

  const updateLine = (productId: string, patch: Partial<PosLine>) => {
    setLines((prev) =>
      prev.map((l) => (l.productId === productId ? { ...l, ...patch } : l)),
    );
  };

  const removeLine = (productId: string) => {
    setLines((prev) => prev.filter((l) => l.productId !== productId));
  };

  const applyLocalStockOptimistic = (order: Order) => {
    if (!onUpdateProduct || !Array.isArray(order.items)) return;
    for (const it of order.items) {
      const pid = String(it.productId || '').trim();
      const qty = Math.max(0, Math.round(Number(it.quantity) || 0));
      if (!pid || qty <= 0) continue;
      const local = products.find((p) => p.id === pid);
      if (!local) continue;
      const sell = roundPosPrice(it.price ?? it.sellingPrice);
      onUpdateProduct(
        {
          ...local,
          stock: Math.max(0, (Number(local.stock) || 0) - qty),
          ...(sell > 0
            ? {
                posLastSellingPrice: sell,
                posPriceHistory: mergePosPriceHistory(local.posPriceHistory, sell),
              }
            : {}),
        },
        { save: false },
      );
    }
  };

  const rememberLocalCustomerPrices = (soldLines: PosLine[], phone: string) => {
    const digits = digitsPhone(phone);
    if (!digits) return;
    setAddressBook((prev) => {
      const idx = prev.findIndex((e) => e.phone === digits);
      if (idx < 0) return prev;
      let prices = prev[idx].posSkuPrices || [];
      let changed = false;
      for (let i = 0; i < soldLines.length && i < 80; i += 1) {
        const l = soldLines[i];
        const sku = String(l.sku || '').trim();
        const price = roundPosPrice(l.sellingPrice);
        if (!sku || price <= 0) continue;
        prices = mergePosSkuPrices(prices, sku, price);
        changed = true;
      }
      if (!changed) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], posSkuPrices: prices };
      return next;
    });
  };

  const submitOrder = async (andPrint: boolean) => {
    if (lines.length === 0) {
      setError('Vui lòng thêm ít nhất 1 sản phẩm.');
      return;
    }
    if (!walkIn && !customerAddress.trim()) {
      setError('Nhập địa chỉ hoặc tích «Mua tại cửa hàng».');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/orders/pos', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(),
        },
        body: JSON.stringify({
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim(),
          customerAddress: customerAddress.trim(),
          walk_in: walkIn,
          note: note.trim(),
          shippingFee: Math.max(0, Math.round(shippingFee) || 0),
          prepaidAmount: Math.max(0, Math.round(prepaidAmount) || 0),
          items: lines.map((l) => ({
            productId: l.productId,
            productTitle: l.productTitle,
            productImage: l.productImage,
            sku: l.sku,
            quantity: l.quantity,
            price: l.sellingPrice,
            sellingPrice: l.sellingPrice,
            importPrice: l.importPrice,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status !== 200 || data.success !== true) {
        throw new Error(data.error || data.message || `Lỗi HTTP ${res.status}`);
      }
      const order = data.order as Order;
      if (!order?.id || !order?.orderSn) {
        throw new Error('Server trả về đơn POS không hợp lệ.');
      }
      setLastOrder(order);
      onUpdateOrders([order, ...orders.filter((o) => o.id !== order.id)]);
      const soldLines = lines;
      applyLocalStockOptimistic(order);
      rememberLocalCustomerPrices(soldLines, customerPhone);
      onAddLog({
        id: `log-pos-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'manual',
        type: 'stock_sync',
        status: 'success',
        message: `[POS] Tạo đơn nhanh ${order.orderSn} — trừ tồn ${data.stockDeducted ?? 0}`,
      });

      void fetchAddressBook(authHeaders)
        .then((list) => {
          const digits = digitsPhone(customerPhone);
          if (!digits) {
            setAddressBook(list);
            return;
          }
          let prices = findCustomerByPhone(list, digits)?.posSkuPrices || [];
          for (let i = 0; i < soldLines.length && i < 80; i += 1) {
            const l = soldLines[i];
            const sku = String(l.sku || '').trim();
            const price = roundPosPrice(l.sellingPrice);
            if (!sku || price <= 0) continue;
            prices = mergePosSkuPrices(prices, sku, price);
          }
          setAddressBook(
            list.map((entry) =>
              entry.phone === digits ? { ...entry, posSkuPrices: prices } : entry,
            ),
          );
        })
        .catch((refreshErr) => {
          console.warn('[Quick POS] Không thể làm mới sổ địa chỉ:', refreshErr);
        });

      // Chỉ in sau khi server xác nhận HTTP 200 + success=true + order hợp lệ.
      // Chờ React paint #pos-invoice với lastOrder rồi mới print — tránh in hóa đơn trống.
      if (andPrint) {
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => {
            window.setTimeout(() => {
              try {
                window.print();
              } catch (printErr) {
                console.error('[Quick POS] window.print failed:', printErr);
                window.alert('Đơn đã lưu thành công nhưng không mở được hộp thoại in. Hãy dùng Ctrl+P.');
              }
              resolve();
            }, 400);
          });
        });
      }
      setLines([]);
      setPrepaidAmount(0);
      setShippingFee(0);
      setNote('');
    } catch (err: any) {
      const raw = err?.message || 'Tạo đơn nhanh thất bại';
      const message = /checking out a connection|wait queue|WaitQueueTimeout|pos_order_update_timeout/i.test(
        raw,
      )
        ? 'Máy chủ đang bận (database chậm). Đợi 5–10 giây rồi nhấn Lưu lại.'
        : raw;
      console.error('[Quick POS] Lưu đơn thất bại:', err);
      setError(message);
      onAddLog({
        id: `log-pos-error-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'manual',
        type: 'stock_sync',
        status: 'failed',
        message: `[POS] ${message}`,
      });
      window.alert(`Không thể lưu đơn POS: ${message}`);
    } finally {
      setSaving(false);
    }
  };

  const printLines = lastOrder?.items?.length
    ? lastOrder.items.map((it) => ({
        productTitle: it.productTitle,
        quantity: it.quantity,
        sellingPrice: Number(it.price ?? it.sellingPrice) || 0,
        lineTotal:
          (Number(it.price ?? it.sellingPrice) || 0) * (Number(it.quantity) || 0),
      }))
    : lines.map((l) => ({
        productTitle: l.productTitle,
        quantity: l.quantity,
        sellingPrice: l.sellingPrice,
        lineTotal: l.sellingPrice * l.quantity,
      }));

  const printTotal = lastOrder
    ? Number(lastOrder.totalAmount) || 0
    : totalAmount;
  const printFee = lastOrder
    ? Number((lastOrder as any).estimated_shipping_fee || (lastOrder as any).shippingFee) || 0
    : shippingFee;
  const printPrepaid = lastOrder
    ? Number((lastOrder as any).prepaid_amount || (lastOrder as any).prepaidAmount) || 0
    : prepaidAmount;
  const printSubtotal = printLines.reduce((s, l) => s + l.lineTotal, 0);

  return (
    <div className="space-y-4 max-w-6xl mx-auto pb-10">
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          #pos-invoice, #pos-invoice * { visibility: visible !important; }
          #pos-invoice {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            padding: 16px !important;
            background: #fff !important;
            color: #000 !important;
            border: none !important;
            border-radius: 0 !important;
          }
          #pos-invoice table { width: 100% !important; border-collapse: collapse !important; }
          #pos-invoice th,
          #pos-invoice td { padding: 6px 8px !important; }
          #pos-invoice th:first-child,
          #pos-invoice td:first-child { width: 48px !important; text-align: left !important; }
          .no-print { display: none !important; }
        }
      `}</style>

      <div className="no-print flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-bold text-slate-600 hover:text-slate-900 cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Quay lại đơn hàng
        </button>
        <div className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
          Mini POS — Tạo đơn nhanh
        </div>
      </div>

      <div className="no-print grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className="lg:col-span-1 rounded-2xl border border-slate-200 bg-white p-4 space-y-3 shadow-sm">
          <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 overflow-hidden">
            <button
              type="button"
              onClick={() => setStoreInfoOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer hover:bg-emerald-50"
            >
              <span className="text-xs font-extrabold text-emerald-800 flex items-center gap-1.5">
                <Settings2 className="w-3.5 h-3.5" />
                Thông tin Cửa hàng trên Hóa đơn
              </span>
              {storeInfoOpen ? (
                <ChevronUp className="w-4 h-4 text-emerald-600" />
              ) : (
                <ChevronDown className="w-4 h-4 text-emerald-600" />
              )}
            </button>
            {storeInfoOpen && (
              <div className="px-3 pb-3 space-y-2 border-t border-emerald-100 pt-2">
                <p className="text-[10px] text-emerald-700/80 font-medium">
                  Lưu trên trình duyệt (localStorage) — tự hiện khi in hóa đơn.
                </p>
                <input
                  type="text"
                  value={storeInfo.storeName}
                  onChange={(e) => patchStoreInfo({ storeName: e.target.value })}
                  placeholder="Tên cửa hàng"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium bg-white"
                />
                <input
                  type="text"
                  value={storeInfo.storePhone}
                  onChange={(e) => patchStoreInfo({ storePhone: e.target.value })}
                  placeholder="Số điện thoại cửa hàng"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium bg-white"
                />
                <textarea
                  value={storeInfo.storeAddress}
                  onChange={(e) => patchStoreInfo({ storeAddress: e.target.value })}
                  placeholder="Địa chỉ cửa hàng"
                  rows={2}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium resize-y bg-white"
                />
                <input
                  type="url"
                  value={storeInfo.logoUrl}
                  onChange={(e) => patchStoreInfo({ logoUrl: e.target.value })}
                  placeholder="URL Logo (https://...)"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium bg-white"
                />
                {storeInfo.logoUrl.trim() ? (
                  <div className="flex items-center gap-2">
                    <img
                      src={storeInfo.logoUrl.trim()}
                      alt="Logo preview"
                      className="h-10 w-auto max-w-[120px] object-contain rounded border border-slate-200 bg-white"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                    <span className="text-[10px] text-slate-500 font-medium">Xem trước logo</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <h2 className="text-sm font-extrabold text-slate-800 flex items-center gap-2">
            <Store className="w-4 h-4 text-emerald-600" />
            Khách hàng
          </h2>
          <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={walkIn}
              onChange={(e) => setWalkIn(e.target.checked)}
              className="pos-compact-checkbox h-2 w-2 !h-2 !w-2 !min-h-2 !min-w-2 rounded border-slate-300 text-blue-600 accent-blue-600 focus:ring-blue-500"
            />
            Mua tại cửa hàng
          </label>
          <input
            type="text"
            value={customerName}
            onChange={(e) => {
              setCustomerName(e.target.value);
              setPhoneQuery(e.target.value);
              setPhoneSuggestOpen(true);
            }}
            onFocus={() => {
              setPhoneQuery(customerName || customerPhone);
              setPhoneSuggestOpen(true);
            }}
            placeholder="Tên khách (tuỳ chọn)"
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium"
            autoComplete="off"
          />
          <div className="relative" ref={phoneWrapRef}>
            <input
              type="text"
              value={customerPhone}
              onChange={(e) => {
                const v = e.target.value;
                setCustomerPhone(v);
                setPhoneQuery(v);
                setPhoneSuggestOpen(true);
              }}
              onFocus={() => {
                setPhoneQuery(customerPhone || customerName);
                setPhoneSuggestOpen(true);
              }}
              placeholder="Số điện thoại — gõ để tìm khách quen"
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium"
              autoComplete="off"
            />
            {phoneSuggestOpen && phoneSuggestions.length > 0 && (
              <ul className="absolute z-30 left-0 right-0 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                {phoneSuggestions.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-emerald-50 cursor-pointer border-b border-slate-50 last:border-0"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickAddressEntry(entry)}
                    >
                      <div className="text-xs font-extrabold text-slate-800">
                        {entry.name || 'Không tên'} · {entry.phone}
                      </div>
                      <div className="text-[10px] text-slate-500 font-medium truncate">
                        {entryDisplayAddress(entry) || 'Chưa có địa chỉ'}
                        {(entry.total_spent || 0) > 0
                          ? ` · VIP ${formatVnd(entry.total_spent || 0)}₫`
                          : ''}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {!walkIn && (
            <textarea
              value={customerAddress}
              onChange={(e) => setCustomerAddress(e.target.value)}
              placeholder="Địa chỉ giao hàng (text tự do)"
              rows={3}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium resize-y"
            />
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ghi chú đơn"
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-medium resize-y"
          />
        </section>

        <section className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-4 space-y-4 shadow-sm">
          <div>
            <h2 className="text-sm font-extrabold text-slate-800 mb-2">Sản phẩm</h2>
            <ImportProductSearchSelect
              ref={searchRef}
              onSelect={addProduct}
              placeholder="Gõ tên / SKU để thêm sản phẩm…"
              excludeIds={[]}
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-slate-100">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-left font-bold">STT</th>
                  <th className="px-2 py-2 text-left font-bold">Ảnh</th>
                  <th className="px-2 py-2 text-left font-bold">Tên</th>
                  <th className="px-2 py-2 text-right font-bold">SL</th>
                  <th className="px-2 py-2 text-right font-bold">Giá nhập</th>
                  <th className="px-2 py-2 text-right font-bold">Giá bán</th>
                  <th className="px-2 py-2 text-right font-bold">Thành tiền</th>
                  <th className="px-2 py-2 no-print" />
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-slate-400 font-semibold">
                      Chưa có sản phẩm — tìm và chọn ở ô phía trên
                    </td>
                  </tr>
                ) : (
                  lines.map((l, i) => (
                    <tr key={l.productId} className="border-t border-slate-100">
                      <td className="px-2 py-2 font-bold text-slate-500">{i + 1}</td>
                      <td className="px-2 py-2">
                        {l.productImage ? (
                          <img
                            src={l.productImage}
                            alt=""
                            className="w-10 h-10 rounded-lg object-cover border border-slate-100"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-lg bg-slate-100" />
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <div className="font-bold text-slate-800 line-clamp-2">{l.productTitle}</div>
                        <div className="text-[10px] text-slate-400 font-semibold">{l.sku}</div>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <input
                          type="number"
                          min={1}
                          value={l.quantity}
                          onChange={(e) =>
                            updateLine(l.productId, {
                              quantity: Math.max(1, Math.round(Number(e.target.value) || 1)),
                            })
                          }
                          className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-right font-bold"
                        />
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-slate-500">
                        {formatVnd(l.importPrice)}
                      </td>
                      <td className="px-2 py-2 text-right align-top">
                        <CurrencyInput
                          smartShorthand
                          min={0}
                          value={l.sellingPrice}
                          onChange={(v) =>
                            updateLine(l.productId, {
                              sellingPrice: Math.max(0, Math.round(v) || 0),
                            })
                          }
                          title="Gõ 60 rồi rời ô → 60.000"
                          placeholder="0"
                          className="w-28 rounded-lg border border-slate-200 px-2 py-1 text-right font-bold"
                        />
                        {(() => {
                          const chips = buildPosPriceChips({
                            customerPrice: l.customerPrice,
                            posPriceHistory: l.posPriceHistory,
                            catalogSellingPrice: l.catalogSellingPrice,
                          });
                          if (chips.length === 0) return null;
                          return (
                            <div className="mt-1 flex flex-wrap justify-end gap-1 max-w-[160px] ml-auto">
                              {chips.map((chip) => {
                                const active = chip.price === l.sellingPrice;
                                const isCustomer = chip.kind === 'customer';
                                return (
                                  <button
                                    key={`${chip.kind}-${chip.price}`}
                                    type="button"
                                    title={
                                      isCustomer
                                        ? 'Giá khách này từng mua'
                                        : chip.kind === 'catalog'
                                          ? 'Giá niêm yết kho'
                                          : 'Giá POS đã bán'
                                    }
                                    onClick={() =>
                                      updateLine(l.productId, { sellingPrice: chip.price })
                                    }
                                    className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold tabular-nums cursor-pointer border ${
                                      isCustomer
                                        ? 'border-emerald-400 text-emerald-800 bg-emerald-50'
                                        : 'border-slate-200 text-slate-600 bg-white'
                                    } ${active ? 'ring-1 ring-emerald-500' : 'hover:bg-slate-50'}`}
                                  >
                                    {formatVnd(chip.price)}
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-2 text-right font-extrabold text-slate-800">
                        {formatVnd(l.sellingPrice * l.quantity)}
                      </td>
                      <td className="px-2 py-2 no-print">
                        <button
                          type="button"
                          onClick={() => removeLine(l.productId)}
                          className="p-1.5 rounded-lg text-rose-500 hover:bg-rose-50 cursor-pointer"
                          title="Xóa dòng"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl bg-slate-50 border border-slate-100 p-3">
            <label className="text-xs font-bold text-slate-600 space-y-1">
              <span>Phí giao hàng ước tính</span>
              <input
                type="number"
                min={0}
                value={shippingFee}
                onChange={(e) => setShippingFee(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <label className="text-xs font-bold text-slate-600 space-y-1">
              <span>Đã trả trước</span>
              <input
                type="number"
                min={0}
                value={prepaidAmount}
                onChange={(e) =>
                  setPrepaidAmount(Math.max(0, Math.round(Number(e.target.value) || 0)))
                }
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold"
              />
            </label>
            <div className="text-xs font-bold text-slate-600 space-y-1">
              <span>Tổng thanh toán</span>
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-lg font-black text-emerald-800">
                {formatVnd(amountDue)}₫
              </div>
              <div className="text-[10px] font-semibold text-slate-400">
                Tổng đơn {formatVnd(totalAmount)}₫
                {prepaidAmount > 0 ? ` − trả trước ${formatVnd(prepaidAmount)}₫` : ''}
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 justify-end">
            <button
              type="button"
              disabled={saving || lines.length === 0}
              onClick={() => void submitOrder(false)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-900 text-white text-xs font-extrabold disabled:opacity-50 cursor-pointer"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Lưu đơn
            </button>
            <button
              type="button"
              disabled={saving || lines.length === 0}
              onClick={() => void submitOrder(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold disabled:opacity-50 cursor-pointer shadow-md shadow-emerald-500/20"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Printer className="w-4 h-4" />}
              Lưu &amp; In
            </button>
          </div>
        </section>
      </div>

      <div id="pos-invoice" className="rounded-2xl border border-dashed border-slate-200 bg-white p-6">
        {/* Header: Logo + Thông tin cửa hàng */}
        <div className="flex items-start gap-4 mb-5 pb-4 border-b border-slate-300">
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
          <div className="min-w-0 flex-1">
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
            <div className="text-sm font-extrabold text-slate-800 mt-2">HÓA ĐƠN / BÁO GIÁ</div>
            <div className="text-[11px] text-slate-500 font-semibold mt-0.5">
              {lastOrder?.orderSn || '— chờ lưu đơn —'} ·{' '}
              {lastOrder?.date
                ? new Date(lastOrder.date).toLocaleString('vi-VN')
                : new Date().toLocaleString('vi-VN')}
            </div>
          </div>
        </div>

        {/* Thông tin khách hàng */}
        <div className="text-xs mb-4 space-y-1 pb-3 border-b border-slate-200">
          <div className="text-[11px] font-extrabold uppercase tracking-wide text-slate-500 mb-1">
            Người nhận / Khách hàng
          </div>
          <div>
            <span className="font-bold">Khách:</span>{' '}
            {lastOrder?.customerName || customerName || (walkIn ? 'Khách tại cửa hàng' : '—')}
          </div>
          <div>
            <span className="font-bold">SĐT:</span>{' '}
            {lastOrder?.customerPhone || customerPhone || '—'}
          </div>
          <div>
            <span className="font-bold">Địa chỉ:</span>{' '}
            {lastOrder?.customerAddress ||
              (walkIn ? 'Mua tại cửa hàng' : customerAddress || '—')}
          </div>
        </div>

        <table className="w-full text-xs border-collapse table-fixed">
          <thead>
            <tr className="border-b-2 border-slate-800">
              <th className="w-12 px-2 py-2 text-left font-bold">STT</th>
              <th className="px-2 py-2 text-left font-bold">Sản phẩm</th>
              <th className="w-16 px-2 py-2 text-right font-bold">SL</th>
              <th className="w-24 px-2 py-2 text-right font-bold">Đơn giá</th>
              <th className="w-28 px-2 py-2 text-right font-bold">Thành tiền</th>
            </tr>
          </thead>
          <tbody>
            {printLines.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-4 text-center text-slate-400">
                  Chưa có dòng hàng
                </td>
              </tr>
            ) : (
              printLines.map((l, i) => (
                <tr key={i} className="border-b border-slate-200">
                  <td className="w-12 px-2 py-1.5 text-left align-top text-slate-600">{i + 1}</td>
                  <td className="px-2 py-1.5 text-left align-top break-words">{l.productTitle}</td>
                  <td className="w-16 px-2 py-1.5 text-right align-top tabular-nums">{l.quantity}</td>
                  <td className="w-24 px-2 py-1.5 text-right align-top tabular-nums">
                    {formatVnd(l.sellingPrice)}
                  </td>
                  <td className="w-28 px-2 py-1.5 text-right align-top font-bold tabular-nums">
                    {formatVnd(l.lineTotal)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="mt-4 text-xs space-y-1 max-w-xs ml-auto">
          <div className="flex justify-between gap-4 px-2">
            <span>Tạm tính</span>
            <span className="font-bold tabular-nums">{formatVnd(printSubtotal)}₫</span>
          </div>
          <div className="flex justify-between gap-4 px-2">
            <span>Phí giao ước tính</span>
            <span className="font-bold tabular-nums">{formatVnd(printFee)}₫</span>
          </div>
          <div className="flex justify-between gap-4 px-2">
            <span>Đã trả trước</span>
            <span className="font-bold tabular-nums">{formatVnd(printPrepaid)}₫</span>
          </div>
          <div className="flex justify-between gap-4 border-t border-slate-800 pt-2 px-2 text-sm font-black">
            <span>Tổng thanh toán</span>
            <span className="tabular-nums">{formatVnd(Math.max(0, printTotal - printPrepaid))}₫</span>
          </div>
        </div>
      </div>
    </div>
  );
}
