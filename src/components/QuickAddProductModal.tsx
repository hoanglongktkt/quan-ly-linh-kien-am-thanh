import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Plus, X } from 'lucide-react';
import { Product } from '../types';
import CurrencyInput from './CurrencyInput';

interface QuickAddProductModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (product: Product) => void;
  initialName?: string;
  initialSku?: string;
}

function mapCreatedProduct(data: any): Product {
  return {
    id: String(data.id || ''),
    title: String(data.title || data.name || ''),
    sku: String(data.sku || ''),
    stock: Number(data.stock) || 0,
    importPrice: Number(data.importPrice) || 0,
    sellingPrice: Number(data.sellingPrice) || 0,
    unit: data.unit || 'cái',
    channels: Array.isArray(data.channels) ? data.channels : [],
    category: data.category || 'Chưa phân loại',
    description: data.description || '',
    status: data.status || 'active',
    imageUrl: data.imageUrl,
    avatarUrl: data.avatarUrl || data.imageUrl,
    lastSynced: data.lastSynced,
  };
}

export default function QuickAddProductModal({
  open,
  onClose,
  onCreated,
  initialName = '',
  initialSku = '',
}: QuickAddProductModalProps) {
  const [title, setTitle] = useState('');
  const [sku, setSku] = useState('');
  const [sellingPrice, setSellingPrice] = useState(0);
  const [importPrice, setImportPrice] = useState(0);
  const [unit, setUnit] = useState('cái');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(initialName.trim());
    setSku(initialSku.trim());
    setSellingPrice(0);
    setImportPrice(0);
    setUnit('cái');
    setError('');
  }, [open, initialName, initialSku]);

  if (!open) return null;

  const handleSave = async () => {
    const name = title.trim();
    const code = sku.trim();
    if (!name || !code) {
      setError('Vui lòng nhập Tên sản phẩm và Mã SKU.');
      return;
    }

    const token = localStorage.getItem('admin_token');
    if (!token) {
      setError('Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: name,
          name,
          sku: code,
          sellingPrice,
          importPrice,
          unit: unit.trim() || 'cái',
          stock: 0,
          channels: [],
          category: 'Chưa phân loại',
          status: 'active',
          description: '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 || data.error === 'sku_duplicate') {
        setError(data.message || 'Mã SKU đã tồn tại.');
        return;
      }
      if (!res.ok || data.success === false) {
        setError(data.message || data.error || 'Tạo sản phẩm thất bại. Vui lòng thử lại.');
        return;
      }
      const created = mapCreatedProduct(data.product || data);
      if (!created.id) {
        setError('Máy chủ không trả về ID sản phẩm.');
        return;
      }
      onCreated(created);
      onClose();
    } catch {
      setError('Lỗi kết nối máy chủ.');
    } finally {
      setSaving(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void handleSave();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-gray-900/50 backdrop-blur-xs flex items-center justify-center p-4 z-60"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bg-white rounded-2xl max-w-md w-full shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Plus className="w-5 h-5 text-emerald-600" />
            Thêm nhanh sản phẩm mới
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-full text-gray-400 hover:text-gray-600 transition-all"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3.5">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-700">
              Tên sản phẩm <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={onEnter}
              placeholder="VD: Áo thun nam basic"
              className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none focus:border-emerald-400 transition-all"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-700">
              Mã SKU <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={onEnter}
              placeholder="VD: AT-NAM-001"
              className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none font-mono focus:border-emerald-400 transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700">Giá bán</label>
              <CurrencyInput
                value={sellingPrice}
                onChange={setSellingPrice}
                smartShorthand
                placeholder="0"
                className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none font-mono focus:border-emerald-400 transition-all"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700">Giá nhập</label>
              <CurrencyInput
                value={importPrice}
                onChange={setImportPrice}
                smartShorthand
                placeholder="0"
                className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none font-mono focus:border-emerald-400 transition-all"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-700">Đơn vị tính</label>
            <input
              type="text"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              onKeyDown={onEnter}
              placeholder="VD: cái, hộp, thùng..."
              className="w-full px-3 py-2.5 bg-gray-50 rounded-xl border border-gray-200 text-sm outline-none focus:border-emerald-400 transition-all"
            />
          </div>

          {error && (
            <p className="text-xs text-rose-600 font-medium bg-rose-50 border border-rose-100 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 bg-white hover:bg-gray-50 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-all"
            >
              Hủy
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="flex-1 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-semibold text-sm rounded-xl transition-all shadow-sm inline-flex items-center justify-center gap-2"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? 'Đang lưu...' : 'Lưu và Chọn'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
