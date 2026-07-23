import React, { useCallback, useEffect, useState } from 'react';
import { Product } from '../types';
import { ProductListingGroup, ListingPlatform } from '../types/productListing';
import {
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Pencil,
  RefreshCw,
  List,
  Package,
} from 'lucide-react';

interface PublishListingTableProps {
  products: Product[];
  onEditListing: (productId: string) => void;
}

const PLATFORM_META: Record<ListingPlatform, { label: string; icon: string; color: string; viewBase: string }> = {
  shopee: { label: 'Shopee', icon: '🟧', color: 'text-orange-600 bg-orange-50 border-orange-200', viewBase: 'https://shopee.vn/product/' },
  lazada: { label: 'Lazada', icon: '🟦', color: 'text-blue-600 bg-blue-50 border-blue-200', viewBase: 'https://www.lazada.vn/products/' },
  tiktok: { label: 'TikTok', icon: '⬛', color: 'text-slate-800 bg-slate-100 border-slate-300', viewBase: 'https://shop.tiktok.com/view/product/' },
};

function statusBadge(status: string, size: 'sm' | 'md' = 'md') {
  const cls = size === 'sm' ? 'text-[9px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5';
  if (status === 'success') {
    return <span className={`${cls} rounded-full font-extrabold bg-emerald-100 text-emerald-700 border border-emerald-200`}>Thành công</span>;
  }
  if (status === 'failed') {
    return <span className={`${cls} rounded-full font-extrabold bg-red-100 text-red-700 border border-red-200`}>Thất bại</span>;
  }
  if (status === 'partial') {
    return <span className={`${cls} rounded-full font-extrabold bg-orange-100 text-orange-700 border border-orange-200`}>Thành công một phần</span>;
  }
  return <span className={`${cls} rounded-full font-extrabold bg-gray-100 text-gray-600 border border-gray-200`}>Đang xử lý</span>;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function buildViewUrl(platform: ListingPlatform, platformProductId?: string, shopId?: string) {
  if (!platformProductId) return null;
  const meta = PLATFORM_META[platform];
  if (platform === 'shopee') return `${meta.viewBase}${shopId || '0'}/${platformProductId}`;
  return `${meta.viewBase}${platformProductId}`;
}

export default function PublishListingTable({ products, onEditListing }: PublishListingTableProps) {
  const [groups, setGroups] = useState<ProductListingGroup[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/product-listings', {
        headers: { Authorization: token ? `Bearer ${token}` : '' },
      });
      const data = await res.json();
      if (data.success) setGroups(data.groups || []);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchListings(); }, [fetchListings]);

  const toggleExpand = (productId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const resolveImage = (group: ProductListingGroup) => {
    if (group.product_image) return group.product_image;
    const prod = products.find((p) => p.id === group.product_id);
    return prod?.imageUrl || prod?.avatarUrl;
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl border border-gray-100 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs">
        <div>
          <h3 className="text-sm font-extrabold text-gray-800 flex items-center gap-2">
            <List className="w-4 h-4 text-blue-600" /> Danh sách đăng bán đa sàn
          </h3>
          <p className="text-[11px] text-gray-400 mt-0.5">Theo dõi trạng thái đăng bán từng gian hàng Shopee, Lazada, TikTok</p>
        </div>
        <button
          type="button"
          onClick={fetchListings}
          disabled={loading}
          className="px-4 py-2 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl text-xs font-bold flex items-center gap-2 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Làm mới
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-[10px] font-extrabold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <th className="w-10 px-3 py-3" />
                <th className="px-4 py-3 text-left min-w-[220px]">Danh sách sản phẩm</th>
                <th className="px-4 py-3 text-left min-w-[130px]">Thời gian tạo/sửa</th>
                <th className="px-4 py-3 text-left min-w-[120px]">Trạng thái</th>
                <th className="px-4 py-3 text-left min-w-[140px]">Sàn đăng bán</th>
                <th className="px-4 py-3 text-right min-w-[100px]">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading && (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400 font-medium">Đang tải danh sách...</td></tr>
              )}
              {!loading && groups.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <Package className="w-8 h-8 text-gray-300 mx-auto mb-2" />
                    <p className="text-gray-400 font-medium">Chưa có lịch sử đăng bán</p>
                    <p className="text-[10px] text-gray-300 mt-1">Đăng bán sản phẩm từ tab &quot;Đăng bán mới&quot; để hiển thị tại đây</p>
                  </td>
                </tr>
              )}
              {!loading && groups.map((group) => {
                const isOpen = expanded.has(group.product_id);
                const img = resolveImage(group);
                return (
                  <React.Fragment key={group.product_id}>
                    <tr className="hover:bg-gray-50/60 transition-colors">
                      <td className="px-3 py-3">
                        <button
                          type="button"
                          onClick={() => toggleExpand(group.product_id)}
                          className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"
                        >
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-lg border border-gray-100 overflow-hidden shrink-0 bg-gray-50">
                            {img ? (
                              <img src={img} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-gray-300"><Package className="w-5 h-5" /></div>
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-gray-800 truncate">{group.product_title}</p>
                            {group.product_sku && <p className="text-[10px] text-gray-400 font-mono mt-0.5">SKU: {group.product_sku}</p>}
                            <p className="text-[10px] text-gray-400 mt-0.5">{group.children.length} gian hàng</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 font-medium whitespace-nowrap">
                        <div>Tạo: {formatDate(group.created_at)}</div>
                        <div className="text-[10px] text-gray-400 mt-0.5">Sửa: {formatDate(group.updated_at)}</div>
                      </td>
                      <td className="px-4 py-3">{statusBadge(group.overall_status)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {group.platform_labels.map((pl) => {
                            const p = pl as ListingPlatform;
                            const m = PLATFORM_META[p];
                            return m ? (
                              <span key={pl} className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${m.color}`}>{m.icon} {m.label}</span>
                            ) : null;
                          })}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => onEditListing(group.product_id)}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg inline-flex"
                          title="Sửa đăng bán"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>

                    {isOpen && group.children.map((child) => {
                      const meta = PLATFORM_META[child.platform];
                      const viewUrl = buildViewUrl(child.platform, child.platform_product_id, child.shop_id);
                      return (
                        <tr key={child.id} className="bg-slate-50/50 border-t border-gray-50">
                          <td className="px-3 py-2" />
                          <td className="px-4 py-2 pl-12" colSpan={1}>
                            <div className="flex items-center gap-2.5">
                              <span className="text-base">{meta.icon}</span>
                              <div>
                                <p className="font-semibold text-gray-700">{child.shop_name}</p>
                                <p className="text-[10px] text-gray-400">{meta.label} · Shop ID: {child.shop_id}</p>
                                {child.error_message && (
                                  <p className="text-[10px] text-red-500 mt-0.5">{child.error_message}</p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-[10px] text-gray-500 whitespace-nowrap">{formatDate(child.updated_at)}</td>
                          <td className="px-4 py-2">{statusBadge(child.status, 'sm')}</td>
                          <td className="px-4 py-2">
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${meta.color}`}>{meta.label}</span>
                          </td>
                          <td className="px-4 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {viewUrl && child.status === 'success' && (
                                <a
                                  href={viewUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="p-1.5 text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg"
                                  title="Xem trên sàn"
                                >
                                  <ExternalLink className="w-4 h-4" />
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => onEditListing(group.product_id)}
                                className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg"
                                title="Sửa"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
