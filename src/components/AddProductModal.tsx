import React, { useEffect, useState } from 'react';
import { AlertCircle, Coins, Layers, Package, Sparkles, TrendingUp } from 'lucide-react';
import { Product } from '../types';
import VariantRowsEditor, {
  VariantRow,
  createVariantRow,
  toVariantPayload,
  validateVariantRows,
} from './VariantRowsEditor';

interface AddProductModalProps {
  open: boolean;
  onClose: () => void;
  onAddProduct: (product: Product) => void | Promise<Product | void>;
  onToast: (message: string, ok?: boolean) => void;
}

const DEFAULT_IMAGE =
  'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&auto=format&fit=crop&q=60&ixlib=rb-4.0.3';

const inputBase =
  'w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all';

export default function AddProductModal({
  open,
  onClose,
  onAddProduct,
  onToast,
}: AddProductModalProps) {
  const [newTitle, setNewTitle] = useState('');
  const [newSku, setNewSku] = useState('');
  const [newSkuError, setNewSkuError] = useState('');
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [newCategory, setNewCategory] = useState('Gia dụng');
  const [newStock, setNewStock] = useState(10);
  const [newImportPrice, setNewImportPrice] = useState(100000);
  const [newSellingPrice, setNewSellingPrice] = useState(180000);
  const [newDescription, setNewDescription] = useState('');
  const [newChannels, setNewChannels] = useState<('shopee' | 'tiktok')[]>(['shopee']);
  const [newImageUrl, setNewImageUrl] = useState('');
  const [hasVariants, setHasVariants] = useState(false);
  const [variantRows, setVariantRows] = useState<VariantRow[]>([]);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');

  useEffect(() => {
    if (open) return;
    setNewSkuError('');
    setAiError('');
  }, [open]);

  if (!open) return null;

  const resetForm = () => {
    setNewTitle('');
    setNewSku('');
    setNewSkuError('');
    setNewStock(10);
    setNewImportPrice(100000);
    setNewSellingPrice(180000);
    setNewDescription('');
    setNewChannels(['shopee']);
    setNewImageUrl('');
    setHasVariants(false);
    setVariantRows([]);
  };

  const toggleVariants = (enabled: boolean) => {
    setHasVariants(enabled);
    setAiError('');
    // Tắt toggle phải dọn sạch mảng để không gửi nhầm phân loại lên server.
    setVariantRows(enabled ? [createVariantRow()] : []);
  };

  // Smart AI Generation of Product Content
  const handleAIGenerate = async () => {
    if (!newTitle) {
      setAiError('Vui lòng nhập tiêu đề thô để AI tối ưu hóa.');
      return;
    }
    setAiLoading(true);
    setAiError('');

    try {
      // 1. Optimize Title
      const titleRes = await fetch('/api/gemini/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'optimize-title',
          text: newTitle,
          context: `Danh mục: ${newCategory}. Giá bán đề xuất: ${newSellingPrice.toLocaleString('vi-VN')} VNĐ.`
        })
      });
      const titleData = await titleRes.json();
      if (titleData.error) throw new Error(titleData.error);

      // Select first optimized title
      const lines = titleData.result.split('\n').filter((l: string) => l.trim().length > 0);
      const chosenTitle = lines[0]?.replace(/^\d+[\.\-\s]+/, '').trim() || newTitle;
      setNewTitle(chosenTitle);

      // 2. Generate Description
      const descRes = await fetch('/api/gemini/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'generate-description',
          text: chosenTitle,
          context: `Giá bán sỉ (nhập): ${newImportPrice} đ, Giá bán lẻ: ${newSellingPrice} đ, SKU: ${newSku || 'Chưa có'}`
        })
      });
      const descData = await descRes.json();
      if (descData.error) throw new Error(descData.error);
      setNewDescription(descData.result);

      // Suggest SKU if empty
      if (!newSku) {
        const words = chosenTitle.split(' ');
        const suggestedSku = words.slice(0, 3).map((w: string) => w.substring(0, 2).toUpperCase()).join('-') + '-' + Math.floor(Math.random() * 1000);
        setNewSku(suggestedSku);
      }
    } catch (err: any) {
      console.error(err);
      setAiError(err.message || 'Lỗi không thể kết nối tới máy chủ AI.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleCreateProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle || !newSku || creatingProduct) return;

    let variantPayload: ReturnType<typeof toVariantPayload> = [];
    if (hasVariants) {
      const invalid = validateVariantRows(variantRows, newSku);
      if (invalid) {
        setAiError(invalid);
        onToast(invalid, false);
        return;
      }
      variantPayload = toVariantPayload(variantRows);
    }

    // Có phân loại: giá/tồn cha do server tính lại từ children, chỉ gửi để tương thích.
    const totalStock = hasVariants
      ? variantPayload.reduce((sum, v) => sum + v.stock, 0)
      : Number(newStock);

    const prod: Product = {
      id: `prod-${Date.now()}`,
      title: newTitle,
      sku: newSku,
      category: newCategory,
      stock: totalStock,
      importPrice: hasVariants ? variantPayload[0].importPrice : Number(newImportPrice),
      sellingPrice: hasVariants ? variantPayload[0].sellingPrice : Number(newSellingPrice),
      channels: newChannels,
      description: newDescription || `${newTitle} là sản phẩm chất lượng cao, phân phối chính hãng.`,
      status: totalStock === 0 ? 'out_of_stock' : 'active',
      shopeeId: newChannels.includes('shopee') ? `SP-${Math.floor(100000 + Math.random() * 900000)}` : undefined,
      tiktokId: newChannels.includes('tiktok') ? `TT-${Math.floor(100000 + Math.random() * 900000)}` : undefined,
      imageUrl: newImageUrl || DEFAULT_IMAGE,
      lastSynced: new Date().toISOString()
    };
    if (hasVariants) {
      (prod as any).children = variantPayload;
    }

    setCreatingProduct(true);
    setNewSkuError('');
    setAiError('');
    try {
      await onAddProduct(prod);
      resetForm();
      onClose();
      onToast(
        hasVariants
          ? `Đã thêm sản phẩm kèm ${variantPayload.length} phân loại vào kho.`
          : 'Đã thêm sản phẩm vào kho.',
        true,
      );
    } catch (err: any) {
      const isDup =
        err?.code === 'sku_duplicate' ||
        err?.status === 400 ||
        /sku/i.test(String(err?.message || ''));
      const msg = err?.message || 'Tạo sản phẩm thất bại.';
      if (isDup) {
        setNewSkuError(msg);
        onToast(msg, false);
      } else {
        setAiError(msg);
        onToast(msg, false);
      }
    } finally {
      setCreatingProduct(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
      <div className="bg-white rounded-3xl max-w-3xl w-full max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="p-6 border-b border-gray-100 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Package className="w-5 h-5 text-blue-600" /> Thêm Sản Phẩm Mới Vào Hệ Thống
            </h3>
            <p className="text-xs text-gray-400 mt-1">Điền tay thông tin cơ bản hoặc dùng AI để tối ưu hóa tiêu đề & viết mô tả tự động.</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-gray-100 rounded-full transition-all text-gray-400 hover:text-gray-600"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleCreateProduct} className="overflow-y-auto p-6 space-y-4 flex-1">
          {aiError && (
            <div className="p-3 bg-red-50 border border-red-100 text-red-700 text-xs rounded-xl flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{aiError}</span>
            </div>
          )}

          {/* Title Input & AI Generate Trigger */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-xs font-semibold text-gray-700">Tên sản phẩm / Tiêu đề gốc</label>
              <button
                type="button"
                onClick={handleAIGenerate}
                disabled={aiLoading || !newTitle}
                className="inline-flex items-center gap-1 px-3 py-1 bg-linear-to-r from-purple-500 to-indigo-600 text-white rounded-lg text-xs font-semibold hover:from-purple-600 hover:to-indigo-700 disabled:from-gray-200 disabled:to-gray-300 disabled:text-gray-400 cursor-pointer transition-all shadow-xs"
                title="AI tự động nâng cấp tiêu đề chuẩn SEO và viết mô tả bán hàng chuyên nghiệp"
              >
                <Sparkles className={`w-3.5 h-3.5 ${aiLoading ? 'animate-spin' : ''}`} />
                {aiLoading ? 'AI đang viết...' : 'Tạo Tự Động (AI)'}
              </button>
            </div>
            <input
              type="text"
              required
              placeholder="Ví dụ: nồi chiên không dầu philips 5 lít"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className={inputBase}
            />
          </div>

          {/* SKU & Category */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700">
                {hasVariants ? 'Mã SKU gốc (sản phẩm cha)' : 'Mã SKU nội bộ'}
              </label>
              <input
                type="text"
                required
                placeholder="VD: PH-NCKD-5L"
                value={newSku}
                onChange={(e) => {
                  setNewSku(e.target.value);
                  if (newSkuError) setNewSkuError('');
                }}
                className={`w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border text-sm outline-none font-mono focus:bg-white transition-all ${
                  newSkuError
                    ? 'border-red-400 focus:border-red-500'
                    : 'border-gray-100 focus:border-blue-500'
                }`}
              />
              {newSkuError && (
                <p className="text-xs text-red-600 font-medium">{newSkuError}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700">Danh mục</label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                className={`${inputBase} cursor-pointer`}
              >
                <option value="Gia dụng">Gia dụng</option>
                <option value="Mỹ phẩm">Mỹ phẩm</option>
                <option value="Thời trang">Thời trang</option>
                <option value="Điện tử">Điện tử</option>
                <option value="Mẹ & Bé">Mẹ & Bé</option>
                <option value="Khác">Khác</option>
              </select>
            </div>
          </div>

          {/* Variant toggle */}
          <label className="flex items-center gap-3 p-3 bg-indigo-50/60 border border-indigo-100 rounded-xl cursor-pointer">
            <input
              type="checkbox"
              checked={hasVariants}
              onChange={(e) => toggleVariants(e.target.checked)}
              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-400 w-4.5 h-4.5 cursor-pointer"
            />
            <span className="flex items-center gap-1.5 text-xs font-bold text-indigo-900">
              <Layers className="w-4 h-4" /> Sản phẩm có nhiều phân loại?
            </span>
            <span className="text-[11px] text-indigo-500/80 ml-auto hidden sm:block">
              Mỗi phân loại có SKU, giá và tồn kho riêng
            </span>
          </label>

          {hasVariants ? (
            <VariantRowsEditor
              rows={variantRows}
              onChange={setVariantRows}
              parentSku={newSku}
              disabled={creatingProduct}
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-700">Tồn kho ban đầu</label>
                <input
                  type="number"
                  min="0"
                  required
                  value={newStock}
                  onChange={(e) => setNewStock(Math.max(0, Number(e.target.value)))}
                  className={`${inputBase} font-mono`}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-700 flex items-center gap-1">
                  <Coins className="w-3.5 h-3.5 text-gray-400" /> Giá nhập sỉ (VNĐ)
                </label>
                <input
                  type="number"
                  min="0"
                  required
                  value={newImportPrice}
                  onChange={(e) => setNewImportPrice(Math.max(0, Number(e.target.value)))}
                  className={`${inputBase} font-mono text-gray-700 font-medium`}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-gray-700 flex items-center gap-1">
                  <TrendingUp className="w-3.5 h-3.5 text-emerald-500" /> Giá bán lẻ (VNĐ)
                </label>
                <input
                  type="number"
                  min="0"
                  required
                  value={newSellingPrice}
                  onChange={(e) => setNewSellingPrice(Math.max(0, Number(e.target.value)))}
                  className={`${inputBase} font-mono text-emerald-700 font-bold`}
                />
              </div>
            </div>
          )}

          {/* Image URL & Channel Options */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700">Link ảnh sản phẩm (Nếu có)</label>
              <input
                type="url"
                placeholder="https://..."
                value={newImageUrl}
                onChange={(e) => setNewImageUrl(e.target.value)}
                className={`${inputBase} text-gray-600`}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-700">Kênh đăng tải lên</label>
              <div className="flex gap-4 pt-2">
                <label className="inline-flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newChannels.includes('shopee')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setNewChannels([...newChannels, 'shopee']);
                      } else {
                        setNewChannels(newChannels.filter(c => c !== 'shopee'));
                      }
                    }}
                    className="rounded border-gray-300 text-orange-500 focus:ring-orange-400 w-4.5 h-4.5 cursor-pointer"
                  />
                  <span className="text-orange-600">Shopee</span>
                </label>

                <label className="inline-flex items-center gap-2 text-xs font-bold text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newChannels.includes('tiktok')}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setNewChannels([...newChannels, 'tiktok']);
                      } else {
                        setNewChannels(newChannels.filter(c => c !== 'tiktok'));
                      }
                    }}
                    className="rounded border-gray-300 text-zinc-950 focus:ring-zinc-800 w-4.5 h-4.5 cursor-pointer"
                  />
                  <span>TikTok Shop</span>
                </label>
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-gray-700">Mô tả sản phẩm (Markdown hỗ trợ)</label>
            <textarea
              rows={4}
              placeholder="Hãy giới thiệu chi tiết về sản phẩm, đặc điểm, công năng..."
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              className={`${inputBase} text-xs font-sans leading-relaxed`}
            />
          </div>
        </form>

        <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-all"
          >
            Hủy bỏ
          </button>
          <button
            type="button"
            onClick={handleCreateProduct}
            disabled={!newTitle || !newSku || creatingProduct}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl transition-all shadow-sm disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {creatingProduct ? 'Đang tạo...' : 'Tạo sản phẩm'}
          </button>
        </div>
      </div>
    </div>
  );
}
