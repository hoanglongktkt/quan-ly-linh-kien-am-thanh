import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CategoryNode, CategorySelection, FlatCategory, MarketplacePlatform } from '../types/marketplaceCategory';
import {
  DEFAULT_SUGGESTED_IDS,
  findCategoryById,
  flatToSelection,
  flattenCategoryTree,
  getCategoryTree,
} from '../data/marketplaceCategories';
import { getCategoryHistory, pushCategoryHistory } from '../utils/categoryHistory';
import { ChevronRight, Search, Sparkles, X, FolderTree, Zap, RefreshCw, Loader2 } from 'lucide-react';

interface SmartCategorySelectorProps {
  platform: MarketplacePlatform;
  value: CategorySelection | null;
  onChange: (selection: CategorySelection | null) => void;
  accent?: 'orange' | 'blue' | 'slate';
  label?: string;
  /** Shop Shopee để sync get_category */
  shopId?: string;
  /** Ép reset value từ parent (invalid category) */
  forceClearToken?: number;
  externalOpen?: boolean;
  onExternalOpenHandled?: () => void;
}

const ACCENT: Record<string, { border: string; bg: string; text: string; btn: string; tag: string }> = {
  orange: {
    border: 'border-orange-200',
    bg: 'bg-orange-50',
    text: 'text-orange-700',
    btn: 'bg-orange-500 hover:bg-orange-600',
    tag: 'bg-orange-50 text-orange-700 border-orange-200 hover:bg-orange-100',
  },
  blue: {
    border: 'border-blue-200',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    btn: 'bg-blue-600 hover:bg-blue-700',
    tag: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100',
  },
  slate: {
    border: 'border-slate-300',
    bg: 'bg-slate-100',
    text: 'text-slate-800',
    btn: 'bg-slate-900 hover:bg-black',
    tag: 'bg-slate-100 text-slate-800 border-slate-200 hover:bg-slate-200',
  },
};

const PLATFORM_LABEL: Record<MarketplacePlatform, string> = {
  shopee: 'Shopee',
  lazada: 'Lazada',
  tiktok: 'TikTok Shop',
};

function flattenLiveTree(platform: MarketplacePlatform, tree: CategoryNode[]): FlatCategory[] {
  const result: FlatCategory[] = [];
  const walk = (nodes: CategoryNode[], pathNames: string[] = []) => {
    for (const node of nodes || []) {
      const next = [...pathNames, node.name];
      if (node.children?.length) {
        walk(node.children, next);
      } else {
        const label = next.filter(Boolean).join(' > ');
        result.push({
          platform,
          categoryId: String(node.id),
          label,
          level1: next[0] || '',
          level2: next.length > 2 ? next[1] : next[1] || '',
          level3: next[next.length - 1] || '',
          searchText: `${label} ${node.id}`.toLowerCase(),
        });
      }
    }
  };
  walk(tree);
  return result;
}

export default function SmartCategorySelector({
  platform,
  value,
  onChange,
  accent = 'orange',
  label = 'Ngành hàng',
  shopId,
  forceClearToken,
  externalOpen,
  onExternalOpenHandled,
}: SmartCategorySelectorProps) {
  const theme = ACCENT[accent];
  const staticTree = useMemo(() => getCategoryTree(platform), [platform]);
  const [liveTree, setLiveTree] = useState<CategoryNode[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const tree = platform === 'shopee' && liveTree?.length ? liveTree : staticTree;
  const flatList = useMemo(
    () => (platform === 'shopee' && liveTree?.length
      ? flattenLiveTree(platform, liveTree)
      : flattenCategoryTree(platform)),
    [platform, liveTree],
  );

  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  /** Path navigation cho cây sâu (Shopee live). */
  const [path, setPath] = useState<CategoryNode[]>([]);

  useEffect(() => {
    if (forceClearToken != null && forceClearToken > 0) {
      onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceClearToken]);

  useEffect(() => {
    if (externalOpen) {
      setModalOpen(true);
      onExternalOpenHandled?.();
    }
  }, [externalOpen, onExternalOpenHandled]);

  const loadShopeeCategories = useCallback(async (force = false) => {
    if (platform !== 'shopee' || !shopId) return;
    setLoadingTree(true);
    setSyncError(null);
    try {
      const token = localStorage.getItem('admin_token');
      const url = force
        ? '/api/shopee/categories/sync'
        : `/api/shopee/categories?shop_id=${encodeURIComponent(shopId)}&_t=${Date.now()}`;
      const res = await fetch(url, {
        method: force ? 'POST' : 'GET',
        headers: {
          Authorization: token ? `Bearer ${token}` : '',
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        ...(force ? { body: JSON.stringify({ shop_id: shopId }) } : { cache: 'no-store' as RequestCache }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Không tải được danh mục Shopee');
      }
      setLiveTree(Array.isArray(data.tree) ? data.tree : []);
      setSyncedAt(data.synced_at || null);
      setPath([]);
    } catch (err: any) {
      setSyncError(err?.message || 'Lỗi đồng bộ danh mục');
    } finally {
      setLoadingTree(false);
    }
  }, [platform, shopId]);

  useEffect(() => {
    if (platform === 'shopee' && shopId) {
      loadShopeeCategories(false);
    }
  }, [platform, shopId, loadShopeeCategories]);

  const currentChildren: CategoryNode[] = useMemo(() => {
    if (path.length === 0) return tree;
    return path[path.length - 1]?.children || [];
  }, [tree, path]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return flatList.filter((c) => c.searchText.includes(q)).slice(0, 30);
  }, [search, flatList]);

  const suggestedItems = useMemo(() => {
    const history = getCategoryHistory(platform);
    const defaultIds = DEFAULT_SUGGESTED_IDS[platform];
    const fromDefaults = defaultIds
      .map((id) => {
        const live = flatList.find((c) => c.categoryId === id);
        return live || findCategoryById(platform, id);
      })
      .filter(Boolean)
      .map((c) => flatToSelection(c!));
    const merged = [...history];
    for (const d of fromDefaults) {
      if (!merged.some((m) => m.categoryId === d.categoryId)) merged.push(d);
    }
    // Chỉ giữ leaf còn tồn tại trong cây hiện tại (Shopee)
    if (platform === 'shopee' && flatList.length) {
      return merged.filter((m) => flatList.some((f) => f.categoryId === m.categoryId)).slice(0, 8);
    }
    return merged.slice(0, 8);
  }, [platform, flatList, modalOpen]);

  const applySelection = (sel: CategorySelection) => {
    pushCategoryHistory(sel);
    onChange(sel);
    setModalOpen(false);
    setSearch('');
    setPath([]);
  };

  const pickNode = (node: CategoryNode, ancestors: CategoryNode[]) => {
    if (node.children?.length) {
      setPath([...ancestors, node]);
      return;
    }
    const names = [...ancestors.map((a) => a.name), node.name];
    applySelection({
      platform,
      categoryId: String(node.id),
      label: names.filter(Boolean).join(' > '),
      level1: names[0] || '',
      level2: names.length > 2 ? names[1] : names[1] || '',
      level3: names[names.length - 1] || '',
    });
  };

  const openModal = () => {
    setSearch('');
    setPath([]);
    setModalOpen(true);
    if (platform === 'shopee' && shopId && !liveTree?.length) {
      loadShopeeCategories(false);
    }
  };

  return (
    <>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[10px] font-bold text-gray-500">{label} *</label>
          <div className="flex items-center gap-1 shrink-0">
            {platform === 'shopee' && shopId && (
              <button
                type="button"
                title="Đồng bộ lại danh mục ngành hàng"
                disabled={loadingTree}
                onClick={() => loadShopeeCategories(true)}
                className={`text-[10px] font-extrabold px-2 py-0.5 rounded-lg border ${theme.border} ${theme.text} ${theme.bg} flex items-center gap-1 disabled:opacity-60`}
              >
                {loadingTree ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Đồng bộ DM
              </button>
            )}
            <button
              type="button"
              onClick={openModal}
              className={`text-[10px] font-extrabold px-2 py-0.5 rounded-lg border ${theme.border} ${theme.text} ${theme.bg} flex items-center gap-1`}
            >
              <Zap className="w-3 h-3" /> Chọn nhanh
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={openModal}
          className={`w-full px-2.5 py-2 bg-white border ${theme.border} rounded-lg text-xs text-left flex items-center gap-2 transition-colors ${
            accent === 'orange' ? 'hover:bg-orange-50' : accent === 'blue' ? 'hover:bg-blue-50' : 'hover:bg-slate-100'
          }`}
        >
          <FolderTree className={`w-3.5 h-3.5 shrink-0 ${theme.text}`} />
          <span className={`flex-1 truncate ${value ? 'font-semibold text-gray-800' : 'text-gray-400'}`}>
            {value ? value.label : `Chọn ngành hàng ${PLATFORM_LABEL[platform]}...`}
          </span>
          {value && (
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${theme.bg} ${theme.text}`}>
              ID: {value.categoryId}
            </span>
          )}
        </button>
        {platform === 'shopee' && syncedAt && (
          <p className="text-[9px] text-gray-400">
            Danh mục Shopee cập nhật: {new Date(syncedAt).toLocaleString('vi-VN')}
            {liveTree?.length ? ` · ${flatList.length} ngành lá` : ''}
          </p>
        )}
        {syncError && <p className="text-[9px] text-red-600 font-medium">{syncError}</p>}
      </div>

      {modalOpen && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
            <div className={`px-5 py-4 border-b ${theme.border} flex items-center justify-between`}>
              <div>
                <h3 className={`text-sm font-extrabold ${theme.text} flex items-center gap-2`}>
                  <FolderTree className="w-4 h-4" />
                  Ngành hàng thông minh — {PLATFORM_LABEL[platform]}
                </h3>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {platform === 'shopee'
                    ? 'Chỉ chọn danh mục lá (leaf) từ cây get_category mới nhất'
                    : 'Chọn phân cấp: Ngành lớn → Ngành nhỏ → Ngành chi tiết'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {platform === 'shopee' && shopId && (
                  <button
                    type="button"
                    disabled={loadingTree}
                    onClick={() => loadShopeeCategories(true)}
                    className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg border ${theme.border} ${theme.text} flex items-center gap-1`}
                  >
                    {loadingTree ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Đồng bộ lại danh mục ngành hàng
                  </button>
                )}
                <button type="button" onClick={() => setModalOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-4 space-y-3 overflow-y-auto flex-1">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Tìm ngành hàng (VD: loa bluetooth, tai nghe...)"
                  className={`w-full pl-9 pr-3 py-2.5 border ${theme.border} rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-opacity-30`}
                  autoFocus
                />
              </div>

              {loadingTree && (
                <p className="text-xs text-gray-500 flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Đang tải danh mục từ Shopee...
                </p>
              )}

              {search.trim() ? (
                <div className="border border-gray-100 rounded-xl overflow-hidden">
                  {searchResults.length === 0 ? (
                    <p className="text-xs text-gray-400 p-4 text-center">Không tìm thấy ngành hàng phù hợp</p>
                  ) : (
                    <ul className="divide-y divide-gray-50 max-h-64 overflow-y-auto">
                      {searchResults.map((item) => (
                        <li key={item.categoryId}>
                          <button
                            type="button"
                            onClick={() => applySelection(flatToSelection(item))}
                            className="w-full px-4 py-2.5 text-left hover:bg-gray-50 flex items-center justify-between gap-2"
                          >
                            <span className="text-xs font-medium text-gray-800">{item.label}</span>
                            <span className="text-[10px] font-mono text-gray-400 shrink-0">#{item.categoryId}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {path.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 text-[10px]">
                      <button
                        type="button"
                        onClick={() => setPath([])}
                        className={`px-2 py-0.5 rounded border ${theme.border} ${theme.text} font-bold`}
                      >
                        Gốc
                      </button>
                      {path.map((n, idx) => (
                        <React.Fragment key={n.id}>
                          <ChevronRight className="w-3 h-3 text-gray-300" />
                          <button
                            type="button"
                            onClick={() => setPath(path.slice(0, idx + 1))}
                            className="px-2 py-0.5 rounded bg-gray-50 text-gray-700 font-medium"
                          >
                            {n.name}
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                  <div className="border border-gray-100 rounded-xl overflow-hidden min-h-[200px]">
                    <div className={`px-3 py-2 text-[10px] font-extrabold uppercase ${theme.bg} ${theme.text}`}>
                      {path.length === 0 ? 'Ngành lớn' : 'Chọn tiếp / danh mục lá'}
                    </div>
                    <ul className="max-h-56 overflow-y-auto">
                      {currentChildren.length === 0 ? (
                        <li className="px-3 py-6 text-[10px] text-gray-400 text-center">
                          {loadingTree ? 'Đang tải...' : 'Không có danh mục'}
                        </li>
                      ) : (
                        currentChildren.map((n) => {
                          const isLeaf = !n.children?.length;
                          return (
                            <li key={n.id}>
                              <button
                                type="button"
                                onClick={() => pickNode(n, path)}
                                className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between hover:bg-gray-50 ${
                                  isLeaf ? 'font-semibold text-gray-900' : 'text-gray-700'
                                }`}
                              >
                                <span>
                                  {n.name}
                                  {isLeaf && (
                                    <span className="block text-[9px] font-mono text-gray-400">ID: {n.id} · leaf</span>
                                  )}
                                </span>
                                {!isLeaf && <ChevronRight className="w-3 h-3 opacity-50" />}
                              </button>
                            </li>
                          );
                        })
                      )}
                    </ul>
                  </div>
                </div>
              )}

              <div className="space-y-2 pt-1">
                <p className="text-[10px] font-extrabold text-gray-600 flex items-center gap-1">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" /> Ngành hàng được đề xuất
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {suggestedItems.map((item) => (
                    <button
                      key={item.categoryId}
                      type="button"
                      onClick={() => applySelection(item)}
                      className={`px-2.5 py-1 border rounded-lg text-[10px] font-bold transition-all ${theme.tag}`}
                    >
                      {item.level3 || item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="px-4 py-3 border-t border-gray-100 flex justify-end gap-2">
              {value && (
                <button
                  type="button"
                  onClick={() => { onChange(null); setModalOpen(false); }}
                  className="px-4 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 rounded-xl"
                >
                  Xóa chọn
                </button>
              )}
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className={`px-5 py-2 text-white text-xs font-extrabold rounded-xl ${theme.btn}`}
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
