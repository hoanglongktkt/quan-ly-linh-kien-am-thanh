import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Product, SyncLog } from '../types';
import { composeImageWithFrame, hashDataUrl } from '../utils/imageFrameOverlay';
import { distributeTitlesToShops, fallbackTitles, parseAiTitleLines } from '../utils/titleDistribution';
import {
  Sparkles,
  Upload,
  Image as ImageIcon,
  Check,
  Loader2,
  Pencil,
  Package,
  Frame,
  RefreshCw,
  Search,
  Filter,
} from 'lucide-react';

interface ShopItem {
  id: string;
  name?: string;
  shopName?: string;
  platform: string;
}

interface ProductEditMeta {
  framedImageUrl?: string;
  framedHash?: string;
  shopTitles?: Record<string, string>;
  aiTitles?: string[];
  frameAppliedAt?: string;
  titlesAppliedAt?: string;
}

interface PublishEditAssetsProps {
  products: Product[];
  shops: ShopItem[];
  onUpdateProduct: (product: Product) => void;
  onAddLog: (log: SyncLog) => void;
}

export default function PublishEditAssets({
  products,
  shops,
  onUpdateProduct,
  onAddLog,
}: PublishEditAssetsProps) {
  const availableShops = useMemo(() => {
    const list = (shops || []).filter((s) =>
      ['shopee', 'lazada', 'tiktok'].includes(String(s.platform || '').toLowerCase())
    );
    return list;
  }, [shops]);

  const publishProducts = useMemo(
    () => products.filter((p) => p.status === 'active' || p.status === 'draft'),
    [products]
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [framePngUrl, setFramePngUrl] = useState<string | null>(null);
  const [frameFileName, setFrameFileName] = useState('');
  const [autoApplyFrame, setAutoApplyFrame] = useState(true);
  const [editMeta, setEditMeta] = useState<Record<string, ProductEditMeta>>({});
  const [processing, setProcessing] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'edited' | 'unedited'>('all');

  const isProductEdited = useCallback(
    (productId: string) => {
      const m = editMeta[productId];
      const hasFrame = Boolean(m?.framedImageUrl || m?.framedHash);
      const hasTitles =
        Boolean(m?.shopTitles && Object.keys(m.shopTitles).length > 0) ||
        Boolean(m?.aiTitles && m.aiTitles.length > 0);
      return hasFrame || hasTitles;
    },
    [editMeta]
  );

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return publishProducts.filter((p) => {
      const matchSearch =
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.sku.toLowerCase().includes(q);
      const edited = isProductEdited(p.id);
      const matchStatus =
        statusFilter === 'all' ||
        (statusFilter === 'edited' && edited) ||
        (statusFilter === 'unedited' && !edited);
      return matchSearch && matchStatus;
    });
  }, [publishProducts, searchQuery, statusFilter, isProductEdited]);

  const editedCount = useMemo(
    () => publishProducts.filter((p) => isProductEdited(p.id)).length,
    [publishProducts, isProductEdited]
  );

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const loadMeta = useCallback(async () => {
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/publish-edit', {
        headers: { Authorization: token ? `Bearer ${token}` : '' },
      });
      const data = await res.json();
      if (data.success) {
        if (data.config?.framePngUrl) {
          setFramePngUrl(data.config.framePngUrl);
          setFrameFileName(data.config.frameFileName || '');
        }
        if (typeof data.config?.autoApplyFrame === 'boolean') {
          setAutoApplyFrame(data.config.autoApplyFrame);
        }
        if (data.meta) setEditMeta(data.meta);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  const saveConfig = async (patch: { framePngUrl?: string | null; frameFileName?: string; autoApplyFrame?: boolean }) => {
    const token = localStorage.getItem('admin_token');
    await fetch('/api/publish-edit/config', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
      },
      body: JSON.stringify(patch),
    });
  };

  const handleFrameUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.includes('png')) {
      alert('Vui lòng chọn file khung .PNG trong suốt!');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result as string;
      setFramePngUrl(url);
      setFrameFileName(file.name);
      saveConfig({ framePngUrl: url, frameFileName: file.name, autoApplyFrame });
      showToast(`Đã tải khung "${file.name}"`);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const visibleIds = filteredProducts.map((p) => p.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => new Set([...prev, ...visibleIds]));
    }
  };

  const applyFrameToProduct = async (product: Product): Promise<ProductEditMeta | null> => {
    if (!framePngUrl) return null;
    const cover = product.imageUrl || product.avatarUrl;
    if (!cover) return null;

    const composed = await composeImageWithFrame(cover, framePngUrl);
    const framedHash = await hashDataUrl(composed);

    const token = localStorage.getItem('admin_token');
    const res = await fetch('/api/publish-edit/save-framed-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
      },
      body: JSON.stringify({ productId: product.id, imageDataUrl: composed, framedHash }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Lưu ảnh thất bại');

    const imageUrl = data.imageUrl || composed;
    onUpdateProduct({ ...product, imageUrl });

    return {
      framedImageUrl: imageUrl,
      framedHash,
      frameAppliedAt: new Date().toISOString(),
    };
  };

  const handleBatchApplyFrames = async () => {
    if (!framePngUrl) {
      alert('Vui lòng upload khung .PNG trước!');
      return;
    }
    const targets = selectedIds.size
      ? publishProducts.filter((p) => selectedIds.has(p.id))
      : publishProducts;

    if (!targets.length) {
      alert('Không có sản phẩm để xử lý!');
      return;
    }

    setProcessing(true);
    let ok = 0;
    try {
      for (const product of targets) {
        try {
          const meta = await applyFrameToProduct(product);
          if (meta) {
            setEditMeta((prev) => ({ ...prev, [product.id]: { ...prev[product.id], ...meta } }));
            ok++;
          }
        } catch (err) {
          console.error(product.id, err);
        }
      }
      showToast(`Đã đóng khung ${ok}/${targets.length} sản phẩm — MD5/pixel mới!`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'publish',
        status: 'success',
        message: `Đóng khung chống trùng ảnh hàng loạt: ${ok} sản phẩm`,
      });
    } finally {
      setProcessing(false);
    }
  };

  const fetchAiTitles = async (baseTitle: string): Promise<string[]> => {
    const token = localStorage.getItem('admin_token');
    const res = await fetch('/api/gemini/optimize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: token ? `Bearer ${token}` : '',
      },
      body: JSON.stringify({
        action: 'avoid-duplication-title',
        text: baseTitle,
        context:
          'Hãy tạo ra 3 biến thể tiêu đề khác nhau hoàn toàn cấu trúc, giữ nguyên từ khóa chính và độ dài dưới 120 ký tự để tránh thuật toán Duplicate của sàn TMĐT',
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'AI lỗi');
    const parsed = parseAiTitleLines(data.result || '');
    return parsed.length >= 3 ? parsed : fallbackTitles(baseTitle);
  };

  const handleBatchAiTitles = async (onlyIds?: string[]) => {
    const ids = onlyIds ?? (selectedIds.size > 0 ? [...selectedIds] : []);
    const targets = ids.length
      ? publishProducts.filter((p) => ids.includes(p.id))
      : [];

    if (!targets.length) {
      alert('Chọn ít nhất một sản phẩm!');
      return;
    }

    setAiRunning(true);
    try {
      const token = localStorage.getItem('admin_token');
      const assignments: Array<{ productId: string; shopTitles: Record<string, string>; aiTitles: string[] }> = [];

      for (const product of targets) {
        const titles = await fetchAiTitles(product.title);
        const shopTitles = distributeTitlesToShops(titles, availableShops);
        assignments.push({ productId: product.id, shopTitles, aiTitles: titles });

        setEditMeta((prev) => ({
          ...prev,
          [product.id]: {
            ...prev[product.id],
            shopTitles,
            aiTitles: titles,
            titlesAppliedAt: new Date().toISOString(),
          },
        }));
      }

      await fetch('/api/publish-edit/batch-titles', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ assignments }),
      });

      showToast(`Gemini đã đảo ${assignments.length} sản phẩm — phân phối tiêu đề theo từng shop!`);
      onAddLog({
        id: `log-${Date.now()}`,
        timestamp: new Date().toISOString(),
        channel: 'all',
        type: 'price_update',
        status: 'success',
        message: `AI chống trùng tiêu đề: ${assignments.length} sản phẩm, ${availableShops.length} gian hàng`,
      });
    } catch (err: any) {
      showToast(`Lỗi AI: ${err.message}`);
    } finally {
      setAiRunning(false);
    }
  };

  const getEditStatus = (productId: string) => {
    if (isProductEdited(productId)) {
      return { label: 'Đã sửa', color: 'bg-emerald-100 text-emerald-700 border-emerald-200' };
    }
    return { label: 'Chưa sửa', color: 'bg-orange-100 text-orange-700 border-orange-200' };
  };

  return (
    <div className="space-y-5 animate-in fade-in duration-200">
      {toast && (
        <div className="fixed top-5 right-5 z-50 bg-slate-900 text-white font-bold text-xs px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-400" />
          <span>{toast}</span>
        </div>
      )}

      {/* Công cụ cấu hình nhanh */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-xs space-y-3">
          <h4 className="text-xs font-extrabold text-gray-800 flex items-center gap-2">
            <Frame className="w-4 h-4 text-blue-600" /> Chống trùng lặp hình ảnh
          </h4>
          <label className="flex items-center gap-3 p-3 border border-dashed border-blue-200 rounded-xl bg-blue-50/30 cursor-pointer hover:bg-blue-50 transition-colors">
            <Upload className="w-5 h-5 text-blue-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-blue-800">
                {frameFileName || 'Upload khung viền .PNG trong suốt'}
              </p>
              <p className="text-[10px] text-gray-400">Đè lên ảnh bìa — tạo file mới (MD5 khác)</p>
            </div>
            <input type="file" accept="image/png" className="hidden" onChange={handleFrameUpload} />
          </label>
          <label className="flex items-center gap-2 text-xs font-semibold text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              checked={autoApplyFrame}
              onChange={(e) => {
                setAutoApplyFrame(e.target.checked);
                saveConfig({ autoApplyFrame: e.target.checked });
              }}
              className="w-4 h-4 rounded text-blue-600"
            />
            Tự động chèn khung đè lên ảnh gốc khi đăng
          </label>
          <button
            type="button"
            onClick={handleBatchApplyFrames}
            disabled={processing || !framePngUrl}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {processing ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
            Áp dụng khung cho {selectedIds.size > 0 ? `${selectedIds.size} sản phẩm` : 'tất cả sản phẩm'}
          </button>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 p-5 shadow-xs space-y-3">
          <h4 className="text-xs font-extrabold text-gray-800 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-600" /> AI Chống trùng lặp tiêu đề
          </h4>
          <p className="text-[10px] text-gray-500 leading-relaxed">
            Gemini tạo 3 tiêu đề khác cấu trúc (&lt;120 ký tự). Tự phân phối: Shopee A → T1, Shopee B → T2, Lazada/TikTok → T3.
          </p>
          <button
            type="button"
            onClick={handleBatchAiTitles}
            disabled={aiRunning}
            className="w-full py-2.5 bg-linear-to-r from-purple-600 to-indigo-600 text-white font-extrabold text-xs rounded-xl disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {aiRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {aiRunning ? 'AI đang soạn thảo...' : 'Kích hoạt Gemini đảo tiêu đề'}
          </button>
          <div className="text-[10px] text-gray-400 flex flex-wrap gap-1">
            {availableShops.map((s) => (
              <span key={s.id} className="px-1.5 py-0.5 bg-gray-100 rounded font-mono">
                {s.platform === 'shopee' ? '🟧' : s.platform === 'lazada' ? '🟦' : '⬛'} {s.name || s.shopName}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Bảng sản phẩm */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-gray-100 space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Tìm kiếm sản phẩm theo tên hoặc mã SKU..."
                className="w-full pl-9 pr-3 py-2.5 border border-gray-200 rounded-xl text-xs font-medium focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Filter className="w-4 h-4 text-gray-400" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as 'all' | 'edited' | 'unedited')}
                className="px-3 py-2.5 border border-gray-200 rounded-xl text-xs font-bold text-gray-700 bg-white focus:outline-none focus:border-blue-500"
              >
                <option value="all">Tất cả trạng thái</option>
                <option value="edited">Đã sửa ({editedCount})</option>
                <option value="unedited">Chưa sửa ({publishProducts.length - editedCount})</option>
              </select>
            </div>
          </div>
          <p className="text-[10px] text-gray-400 font-medium">
            Hiển thị {filteredProducts.length}/{publishProducts.length} sản phẩm
            {searchQuery.trim() ? ` · Tìm: "${searchQuery.trim()}"` : ''}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-[10px] font-extrabold text-gray-500 uppercase border-b border-gray-100">
                <th className="px-3 py-3 w-10">
                  <input
                    type="checkbox"
                    checked={
                      filteredProducts.length > 0 &&
                      filteredProducts.every((p) => selectedIds.has(p.id))
                    }
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded"
                  />
                </th>
                <th className="px-4 py-3 text-left min-w-[240px]">Sản phẩm chuẩn bị đăng</th>
                <th className="px-4 py-3 text-left">Khung ảnh</th>
                <th className="px-4 py-3 text-left">Tiêu đề đa shop</th>
                <th className="px-4 py-3 text-left">Trạng thái</th>
                <th className="px-4 py-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredProducts.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-gray-400">
                    <Package className="w-8 h-8 mx-auto mb-2 opacity-40" />
                    {publishProducts.length === 0
                      ? 'Không có sản phẩm trong kho'
                      : 'Không tìm thấy sản phẩm phù hợp'}
                  </td>
                </tr>
              )}
              {filteredProducts.map((product) => {
                const meta = editMeta[product.id];
                const status = getEditStatus(product.id);
                const thumb = meta?.framedImageUrl || product.imageUrl || product.avatarUrl;
                const shopTitleCount = meta?.shopTitles ? Object.keys(meta.shopTitles).length : 0;

                return (
                  <tr key={product.id} className="hover:bg-gray-50/50">
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(product.id)}
                        onChange={() => toggleSelect(product.id)}
                        className="w-4 h-4 rounded"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-lg border overflow-hidden shrink-0 bg-gray-50">
                          {thumb ? (
                            <img src={thumb} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-300">
                              <Package className="w-5 h-5" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="font-bold text-gray-800 truncate">{product.title}</p>
                          <p className="text-[10px] text-gray-400 font-mono">SKU: {product.sku}</p>
                          {meta?.framedHash && (
                            <p className="text-[9px] text-emerald-600 font-mono mt-0.5">MD5: {meta.framedHash}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {meta?.framedImageUrl ? (
                        <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-100">
                          ✓ Đã đóng khung
                        </span>
                      ) : (
                        <span className="text-[10px] text-gray-400">Chưa xử lý</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {shopTitleCount > 0 ? (
                        <div className="space-y-0.5 max-w-[200px]">
                          {Object.entries(meta!.shopTitles!).slice(0, 2).map(([shopId, t]) => {
                            const shop = availableShops.find((s) => s.id === shopId);
                            return (
                              <p key={shopId} className="text-[9px] text-gray-600 truncate" title={t}>
                                {(shop?.platform === 'shopee' ? '🟧' : shop?.platform === 'lazada' ? '🟦' : '⬛')}{' '}
                                {t.slice(0, 40)}…
                              </p>
                            );
                          })}
                          {shopTitleCount > 2 && (
                            <p className="text-[9px] text-gray-400">+{shopTitleCount - 2} shop khác</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] text-gray-400">Chưa AI</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded-full border ${status.color}`}>
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          title="Đóng khung ảnh bìa"
                          disabled={processing || !framePngUrl}
                          onClick={async () => {
                            setProcessing(true);
                            try {
                              const m = await applyFrameToProduct(product);
                              if (m) {
                                setEditMeta((prev) => ({ ...prev, [product.id]: { ...prev[product.id], ...m } }));
                                showToast('Đã đóng khung ảnh bìa!');
                              }
                            } catch (e: any) {
                              showToast(e.message);
                            } finally {
                              setProcessing(false);
                            }
                          }}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg disabled:opacity-40"
                        >
                          <ImageIcon className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          title="Sửa / AI tiêu đề"
                          onClick={() => handleBatchAiTitles([product.id])}
                          className="p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded-lg"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={loadMeta}
          className="px-4 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 rounded-xl flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Làm mới
        </button>
      </div>
    </div>
  );
}
