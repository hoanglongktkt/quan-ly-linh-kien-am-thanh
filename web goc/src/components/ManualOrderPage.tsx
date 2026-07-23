import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CreditCard,
  Loader2,
  Package,
  Plus,
  Scale,
  Search,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import { Order, Product, SyncLog } from '../types';
import StructuredAddressForm from './StructuredAddressForm';
import {
  emptyStructuredAddress,
  formatFullAddress,
  isStructuredAddressComplete,
  StructuredAddressValue,
} from '../utils/vietnamAddress';

export type ManualOrderItem = {
  productId: string;
  productTitle: string;
  sku: string;
  quantity: number;
  price: number;
  weightGrams: number;
  stock?: number;
  isCustom?: boolean;
};

interface ManualOrderPageProps {
  products: Product[];
  orders: Order[];
  onBack: () => void;
  onUpdateOrders: (orders: Order[]) => void;
  onUpdateProduct?: (product: Product) => void;
  onAddLog: (log: SyncLog) => void;
  authHeaders: () => Record<string, string>;
}

function ProductSearchCombobox({
  products,
  value,
  onChange,
}: {
  products: Product[];
  value: string;
  onChange: (id: string, prod?: Product) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = products.find((p) => p.id === value);

  useEffect(() => {
    if (selected) setQuery(selected.title);
  }, [selected?.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = products.filter((p) => p.stock > 0);
    if (!q) return available.slice(0, 40);
    return available
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.sku.toLowerCase().includes(q) ||
          (p.barcode || '').toLowerCase().includes(q)
      )
      .slice(0, 30);
  }, [products, query]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={wrapRef} className="relative">
      <label className="text-[11px] font-semibold text-gray-500">Tìm sản phẩm (Tên / SKU)</label>
      <div className="relative mt-1">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (!e.target.value.trim()) onChange('');
          }}
          onFocus={() => setOpen(true)}
          placeholder="Gõ tên hoặc SKU để tìm..."
          className="w-full pl-9 pr-3 py-2.5 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-sm text-gray-800"
        />
      </div>
      {open && (
        <ul className="absolute z-20 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-xl shadow-lg text-sm">
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-gray-400 text-xs">Không tìm thấy sản phẩm khả dụng</li>
          ) : (
            filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(p.id, p);
                    setQuery(p.title);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2.5 hover:bg-emerald-50 border-b border-gray-50 last:border-0 ${
                    value === p.id ? 'bg-emerald-50/80' : ''
                  }`}
                >
                  <p className="font-semibold text-gray-800 truncate">{p.title}</p>
                  <p className="text-[11px] text-gray-500 font-mono">
                    SKU: {p.sku} · Tồn: {p.stock} · {(p.sellingPrice || 0).toLocaleString('vi-VN')}đ
                  </p>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export default function ManualOrderPage({
  products,
  orders,
  onBack,
  onUpdateOrders,
  onUpdateProduct,
  onAddLog,
  authHeaders,
}: ManualOrderPageProps) {
  const [shippingAddress, setShippingAddress] = useState<StructuredAddressValue>(emptyStructuredAddress());
  const [submitting, setSubmitting] = useState(false);
  const [orderItems, setOrderItems] = useState<ManualOrderItem[]>([]);

  const [productMode, setProductMode] = useState<'warehouse' | 'custom'>('warehouse');
  const [selectedProdId, setSelectedProdId] = useState('');
  const [selectedQty, setSelectedQty] = useState(1);
  const [selectedPrice, setSelectedPrice] = useState(0);
  const [selectedWeight, setSelectedWeight] = useState(100);

  const [customTitle, setCustomTitle] = useState('');
  const [customPrice, setCustomPrice] = useState(0);
  const [customQty, setCustomQty] = useState(1);
  const [customWeight, setCustomWeight] = useState(100);

  const [selectedCarrier, setSelectedCarrier] = useState<'self' | 'ghn' | 'spx'>('self');
  const [carrierNotes, setCarrierNotes] = useState('Cho xem hàng không cho thử');
  const [packageWeight, setPackageWeight] = useState(500);
  const [shippingFee, setShippingFee] = useState(0);
  const [shippingFeePayer, setShippingFeePayer] = useState<'sender' | 'customer'>('customer');
  const [orderDiscount, setOrderDiscount] = useState(0);

  const itemsSubtotal = orderItems.reduce((sum, it) => sum + it.price * it.quantity, 0);
  const totalWeightGrams = orderItems.reduce((sum, it) => sum + it.weightGrams * it.quantity, 0);
  const customerShipping = shippingFeePayer === 'customer' ? shippingFee : 0;
  const grandTotal = Math.max(0, itemsSubtotal + customerShipping - orderDiscount);

  useEffect(() => {
    if (orderItems.length > 0 && totalWeightGrams > 0) {
      setPackageWeight(totalWeightGrams);
    }
  }, [totalWeightGrams, orderItems.length]);

  const handleAddWarehouseItem = () => {
    if (!selectedProdId) {
      alert('Vui lòng chọn một sản phẩm từ kho!');
      return;
    }
    const prod = products.find((p) => p.id === selectedProdId);
    if (!prod) return;

    if (selectedQty <= 0) {
      alert('Số lượng sản phẩm phải lớn hơn 0!');
      return;
    }
    if (selectedQty > prod.stock) {
      alert(`⚠️ Tồn kho khả dụng chỉ còn ${prod.stock}.`);
      return;
    }

    const weight = selectedWeight || prod.weight || 100;
    const existing = orderItems.find((it) => it.productId === selectedProdId && !it.isCustom);
    if (existing) {
      if (existing.quantity + selectedQty > prod.stock) {
        alert(`⚠️ Tổng số lượng vượt quá tồn kho (${prod.stock})!`);
        return;
      }
      setOrderItems((prev) =>
        prev.map((it) =>
          it.productId === selectedProdId && !it.isCustom
            ? { ...it, quantity: it.quantity + selectedQty }
            : it
        )
      );
    } else {
      setOrderItems((prev) => [
        ...prev,
        {
          productId: prod.id,
          productTitle: prod.title,
          sku: prod.sku,
          quantity: selectedQty,
          price: selectedPrice || prod.sellingPrice,
          weightGrams: weight,
          stock: prod.stock,
        },
      ]);
    }

    setSelectedProdId('');
    setSelectedQty(1);
    setSelectedPrice(0);
    setSelectedWeight(100);
  };

  const handleAddCustomItem = () => {
    if (!customTitle.trim()) {
      alert('Vui lòng nhập tên sản phẩm tự tạo!');
      return;
    }
    if (customQty <= 0) {
      alert('Số lượng phải lớn hơn 0!');
      return;
    }
    if (customPrice < 0) {
      alert('Giá bán không hợp lệ!');
      return;
    }

    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setOrderItems((prev) => [
      ...prev,
      {
        productId: id,
        productTitle: customTitle.trim(),
        sku: 'TU-TAO',
        quantity: customQty,
        price: customPrice,
        weightGrams: Math.max(1, customWeight),
        isCustom: true,
      },
    ]);

    setCustomTitle('');
    setCustomPrice(0);
    setCustomQty(1);
    setCustomWeight(100);
  };

  const handleRemoveItem = (prodId: string) => {
    setOrderItems((prev) => prev.filter((it) => it.productId !== prodId));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isStructuredAddressComplete(shippingAddress)) {
      alert('Vui lòng chọn đầy đủ Tỉnh/Quận/Phường và nhập địa chỉ chi tiết!');
      return;
    }
    if (orderItems.length === 0) {
      alert('Vui lòng thêm ít nhất 1 sản phẩm vào đơn hàng!');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/orders/manual', {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
          packageWeight: packageWeight || totalWeightGrams || 500,
          shippingFee,
          shippingFeePayer,
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
        orderItems
          .filter((it) => !it.isCustom)
          .forEach((item) => {
            const prod = products.find((p) => p.id === item.productId);
            if (prod) {
              onUpdateProduct({
                ...prod,
                stock: Math.max(0, prod.stock - item.quantity),
              });
            }
          });
      }

      if (data.orders) onUpdateOrders(data.orders);
      else onUpdateOrders([newOrder, ...orders]);

      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'manual',
        type: 'publish',
        status: 'success',
        message: `[TẠO ĐƠN THỦ CÔNG] Đã khởi tạo thành công đơn hàng sỉ ngoài sàn #${newOrder.orderSn}. Tổng thu: ${newOrder.totalAmount.toLocaleString('vi-VN')}đ.`,
      });

      if (selectedCarrier !== 'self') {
        onAddLog({
          id: `log-${Date.now() + 1}`,
          timestamp: new Date().toISOString(),
          channel: selectedCarrier,
          type: 'stock_sync',
          status: 'success',
          message: `[API LOGISTICS] Đã tự động gọi API đẩy đơn sỉ sang ${selectedCarrier === 'ghn' ? 'Giao Hàng Nhanh' : 'Shopee SPX Express'}. Tracking: ${generatedTracking}`,
        });
      }

      const fullAddr = formatFullAddress(shippingAddress);
      const qtyTotal = orderItems.reduce((acc, it) => acc + it.quantity, 0);
      const carrierLabel =
        selectedCarrier === 'ghn'
          ? 'Giao Hàng Nhanh (GHN)'
          : selectedCarrier === 'spx'
            ? 'Shopee SPX Express'
            : 'Tự giao hàng';

      alert(
        `🎉 Đã tạo đơn ngoài sàn thành công!\n\n• Mã đơn: ${newOrder.orderSn}\n• Địa chỉ: ${fullAddr}\n• Vận chuyển: ${carrierLabel}\n• Mã vận đơn: ${generatedTracking}\n\nĐã khấu trừ ${qtyTotal} sản phẩm trong kho (nếu có).`
      );

      onBack();
    } catch {
      alert('Lỗi kết nối server khi tạo đơn hàng!');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-full flex flex-col bg-gray-50/80 -m-4 md:-m-6 p-4 md:p-6">
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 px-4 py-2.5 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-bold text-sm rounded-xl shadow-sm transition-all"
        >
          <ArrowLeft className="w-4 h-4" />
          Quay lại
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-extrabold text-gray-900">Tạo đơn hàng ngoài sàn</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Tự động khấu trừ tồn kho &amp; liên kết API bưu cục lấy mã vận đơn
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-5 space-y-5">
          <section className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2 border-b border-gray-100 pb-3">
              <Truck className="w-4 h-4 text-emerald-600" /> Địa chỉ giao hàng
            </h2>
            <StructuredAddressForm
              value={shippingAddress}
              onChange={setShippingAddress}
              authHeaders={authHeaders}
            />
          </section>

          <section className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2 border-b border-gray-100 pb-3">
              <Truck className="w-4 h-4 text-blue-600" /> Vận chuyển &amp; bưu cục
            </h2>

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
                className="w-full mt-1 px-3 py-2.5 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-sm font-semibold text-gray-700"
              >
                <option value="self">Tự giao hàng / GrabShip / COD ngoài</option>
                <option value="ghn">Giao Hàng Nhanh (GHN API)</option>
                <option value="spx">Shopee SPX Express (API)</option>
              </select>
            </div>

            {selectedCarrier !== 'self' && (
              <div className="p-4 bg-blue-50/60 border border-blue-100 rounded-xl space-y-3">
                <p className="text-xs text-blue-700 leading-relaxed">
                  Đơn sẽ tự động khởi tạo vận đơn trên {selectedCarrier === 'ghn' ? 'GHN' : 'SPX'} sau khi tạo.
                </p>
                <div>
                  <label className="text-[11px] font-semibold text-gray-500">Trọng lượng kiện (g)</label>
                  <input
                    type="number"
                    min={1}
                    value={packageWeight}
                    onChange={(e) => setPackageWeight(Number(e.target.value))}
                    className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-500">Ghi chú bưu tá</label>
                  <input
                    type="text"
                    value={carrierNotes}
                    onChange={(e) => setCarrierNotes(e.target.value)}
                    className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 text-sm"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="text-[11px] font-semibold text-gray-500">Mã giảm giá đơn hàng (đ)</label>
              <input
                type="number"
                min={0}
                value={orderDiscount}
                onChange={(e) => setOrderDiscount(Number(e.target.value))}
                className="w-full mt-1 px-3 py-2.5 bg-white rounded-xl border border-gray-200 text-sm font-mono"
                placeholder="0"
              />
            </div>
          </section>
        </div>

        <div className="xl:col-span-7 space-y-5">
          <section className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                <Package className="w-4 h-4 text-amber-500" /> Thêm sản phẩm
              </h2>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-bold">
                <button
                  type="button"
                  onClick={() => setProductMode('warehouse')}
                  className={`px-3 py-1.5 ${productMode === 'warehouse' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Từ kho
                </button>
                <button
                  type="button"
                  onClick={() => setProductMode('custom')}
                  className={`px-3 py-1.5 ${productMode === 'custom' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >
                  Sản phẩm tự tạo
                </button>
              </div>
            </div>

            {productMode === 'warehouse' ? (
              <>
                <ProductSearchCombobox
                  products={products}
                  value={selectedProdId}
                  onChange={(id, prod) => {
                    setSelectedProdId(id);
                    if (prod) {
                      setSelectedPrice(prod.sellingPrice);
                      setSelectedWeight(prod.weight || 100);
                    }
                  }}
                />
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Số lượng</label>
                    <input
                      type="number"
                      min={1}
                      value={selectedQty}
                      onChange={(e) => setSelectedQty(Math.max(1, Number(e.target.value)))}
                      className="w-full mt-1 px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Giá bán (đ)</label>
                    <input
                      type="number"
                      min={0}
                      value={selectedPrice}
                      onChange={(e) => setSelectedPrice(Number(e.target.value))}
                      className="w-full mt-1 px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-semibold text-gray-500">Trọng lượng (g)</label>
                    <input
                      type="number"
                      min={1}
                      value={selectedWeight}
                      onChange={(e) => setSelectedWeight(Math.max(1, Number(e.target.value)))}
                      className="w-full mt-1 px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleAddWarehouseItem}
                      className="w-full py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold text-sm rounded-xl border border-emerald-200 flex items-center justify-center gap-1.5"
                    >
                      <Plus className="w-4 h-4" /> Thêm
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="text-[11px] font-semibold text-gray-500">Tên sản phẩm *</label>
                  <input
                    type="text"
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    placeholder="Nhập tên sản phẩm tự tạo..."
                    className="w-full mt-1 px-3 py-2.5 rounded-xl border border-gray-200 text-sm"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-500">Giá (đ)</label>
                  <input
                    type="number"
                    min={0}
                    value={customPrice}
                    onChange={(e) => setCustomPrice(Number(e.target.value))}
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-500">Số lượng</label>
                  <input
                    type="number"
                    min={1}
                    value={customQty}
                    onChange={(e) => setCustomQty(Math.max(1, Number(e.target.value)))}
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-500">Trọng lượng (g)</label>
                  <input
                    type="number"
                    min={1}
                    value={customWeight}
                    onChange={(e) => setCustomWeight(Math.max(1, Number(e.target.value)))}
                    className="w-full mt-1 px-3 py-2 rounded-xl border border-gray-200 text-sm font-mono"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    onClick={handleAddCustomItem}
                    className="w-full py-2.5 bg-amber-50 hover:bg-amber-100 text-amber-800 font-bold text-sm rounded-xl border border-amber-200 flex items-center justify-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" /> Thêm sản phẩm tự tạo
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm space-y-3">
            <h2 className="text-sm font-bold text-gray-800 border-b border-gray-100 pb-3">
              Danh sách sản phẩm ({orderItems.length})
            </h2>
            {orderItems.length === 0 ? (
              <p className="py-10 text-center text-gray-400 text-sm">Chưa có sản phẩm. Thêm từ kho hoặc tự tạo ở trên.</p>
            ) : (
              <div className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
                <div className="bg-gray-50 px-4 py-3 grid grid-cols-12 gap-2 text-[10px] font-bold text-gray-500 uppercase">
                  <div className="col-span-5">Tên / SKU</div>
                  <div className="col-span-2 text-center">SL</div>
                  <div className="col-span-2 text-center">KL (g)</div>
                  <div className="col-span-2 text-right">Thành tiền</div>
                  <div className="col-span-1" />
                </div>
                {orderItems.map((item) => (
                  <div
                    key={item.productId}
                    className="px-4 py-3 grid grid-cols-12 gap-2 items-center text-sm hover:bg-gray-50/50"
                  >
                    <div className="col-span-5 min-w-0">
                      <p className="font-semibold text-gray-800 truncate">{item.productTitle}</p>
                      <span className="text-[10px] font-mono text-gray-500">
                        {item.isCustom ? 'Tự tạo' : `SKU: ${item.sku}`}
                      </span>
                    </div>
                    <div className="col-span-2 text-center font-bold">x{item.quantity}</div>
                    <div className="col-span-2 text-center text-gray-600 text-xs">
                      {(item.weightGrams * item.quantity).toLocaleString('vi-VN')}g
                    </div>
                    <div className="col-span-2 text-right font-semibold text-emerald-700">
                      {(item.price * item.quantity).toLocaleString('vi-VN')}đ
                    </div>
                    <div className="col-span-1 text-center">
                      <button
                        type="button"
                        onClick={() => handleRemoveItem(item.productId)}
                        className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-gradient-to-br from-emerald-50 to-teal-50/50 border border-emerald-100 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
              <Scale className="w-4 h-4 text-emerald-600" /> Tổng kết đơn hàng
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white/80 rounded-xl p-4 border border-emerald-100/80">
                <p className="text-[11px] font-semibold text-gray-500 uppercase">Tổng trọng lượng</p>
                <p className="text-xl font-black text-gray-900 mt-1">
                  {totalWeightGrams.toLocaleString('vi-VN')} <span className="text-sm font-bold text-gray-500">g</span>
                </p>
              </div>
              <div className="bg-white/80 rounded-xl p-4 border border-emerald-100/80">
                <p className="text-[11px] font-semibold text-gray-500 uppercase">Tổng tiền hàng</p>
                <p className="text-xl font-black text-emerald-700 mt-1">{itemsSubtotal.toLocaleString('vi-VN')}đ</p>
              </div>
            </div>

            <div className="bg-white/80 rounded-xl p-4 border border-emerald-100/80 space-y-3">
              <div>
                <label className="text-[11px] font-semibold text-gray-500">Phí vận chuyển (VND)</label>
                <input
                  type="number"
                  min={0}
                  value={shippingFee}
                  onChange={(e) => setShippingFee(Number(e.target.value))}
                  className="w-full mt-1 px-3 py-2.5 rounded-xl border border-gray-200 text-sm font-mono font-semibold"
                />
              </div>
              <div>
                <label className="text-[11px] font-semibold text-gray-500 block mb-2">Người trả phí vận chuyển</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShippingFeePayer('sender')}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all ${
                      shippingFeePayer === 'sender'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300'
                    }`}
                  >
                    Người gửi trả phí
                  </button>
                  <button
                    type="button"
                    onClick={() => setShippingFeePayer('customer')}
                    className={`flex-1 py-2.5 rounded-xl text-xs font-bold border transition-all ${
                      shippingFeePayer === 'customer'
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-emerald-300'
                    }`}
                  >
                    Khách trả phí
                  </button>
                </div>
              </div>
            </div>

            {orderDiscount > 0 && (
              <div className="flex justify-between text-sm text-rose-600 px-1">
                <span>Giảm giá</span>
                <span className="font-bold">-{orderDiscount.toLocaleString('vi-VN')}đ</span>
              </div>
            )}

            <div className="border-t border-emerald-200/60 pt-4 flex justify-between items-center">
              <span className="font-bold text-gray-800 flex items-center gap-2 text-sm">
                <CreditCard className="w-4 h-4 text-emerald-600" />
                Tổng thu khách (COD)
              </span>
              <span className="text-2xl font-black text-emerald-700">{grandTotal.toLocaleString('vi-VN')}đ</span>
            </div>
            {shippingFeePayer === 'sender' && shippingFee > 0 && (
              <p className="text-[11px] text-blue-700 bg-blue-50 px-3 py-2 rounded-lg">
                Phí ship {shippingFee.toLocaleString('vi-VN')}đ do người gửi chi trả — không tính vào COD.
              </p>
            )}
          </section>

          <div className="flex justify-end gap-3 pb-4">
            <button
              type="button"
              onClick={onBack}
              className="px-6 py-3 bg-white hover:bg-gray-50 border border-gray-300 text-gray-700 font-bold text-sm rounded-xl"
            >
              Hủy bỏ
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="px-8 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-70 text-white font-extrabold text-sm rounded-xl shadow-md flex items-center gap-2"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {submitting ? 'Đang tạo đơn...' : 'Xác nhận & Tạo đơn'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
