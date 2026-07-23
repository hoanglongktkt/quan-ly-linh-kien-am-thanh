import React, { useEffect, useMemo, useState } from 'react';
import { CategoryNode, CategorySelection, MarketplacePlatform } from '../types/marketplaceCategory';
import {
  DEFAULT_SUGGESTED_IDS,
  findCategoryById,
  flatToSelection,
  flattenCategoryTree,
  getCategoryTree,
} from '../data/marketplaceCategories';
import { getCategoryHistory, pushCategoryHistory } from '../utils/categoryHistory';
import { ChevronRight, Search, Sparkles, X, FolderTree, Zap } from 'lucide-react';

interface SmartCategorySelectorProps {
  platform: MarketplacePlatform;
  value: CategorySelection | null;
  onChange: (selection: CategorySelection | null) => void;
  accent?: 'orange' | 'blue' | 'slate';
  label?: string;
  /** Mở modal từ bên ngoài (nút Chọn nhanh) */
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

export default function SmartCategorySelector({
  platform,
  value,
  onChange,
  accent = 'orange',
  label = 'Ngành hàng',
  externalOpen,
  onExternalOpenHandled,
}: SmartCategorySelectorProps) {
  const theme = ACCENT[accent];
  const tree = useMemo(() => getCategoryTree(platform), [platform]);
  const flatList = useMemo(() => flattenCategoryTree(platform), [platform]);

  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [level1Id, setLevel1Id] = useState<string | null>(null);
  const [level2Id, setLevel2Id] = useState<string | null>(null);

  useEffect(() => {
    if (externalOpen) {
      setModalOpen(true);
      onExternalOpenHandled?.();
    }
  }, [externalOpen, onExternalOpenHandled]);

  useEffect(() => {
    if (!modalOpen || !value) return;
    const l1 = tree.find((n) => n.name === value.level1);
    if (l1) {
      setLevel1Id(l1.id);
      const l2 = l1.children?.find((n) => n.name === value.level2);
      if (l2) setLevel2Id(l2.id);
    }
  }, [modalOpen, value, tree]);

  const level1Nodes = tree;
  const level2Nodes: CategoryNode[] = useMemo(() => {
    const n = tree.find((x) => x.id === level1Id);
    return n?.children || [];
  }, [tree, level1Id]);

  const level3Nodes: CategoryNode[] = useMemo(() => {
    const n = level2Nodes.find((x) => x.id === level2Id);
    return n?.children || [];
  }, [level2Nodes, level2Id]);

  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return flatList.filter((c) => c.searchText.includes(q)).slice(0, 20);
  }, [search, flatList]);

  const suggestedItems = useMemo(() => {
    const history = getCategoryHistory(platform);
    const defaultIds = DEFAULT_SUGGESTED_IDS[platform];
    const fromDefaults = defaultIds
      .map((id) => findCategoryById(platform, id))
      .filter(Boolean)
      .map((c) => flatToSelection(c!));
    const merged = [...history];
    for (const d of fromDefaults) {
      if (!merged.some((m) => m.categoryId === d.categoryId)) merged.push(d);
    }
    return merged.slice(0, 8);
  }, [platform, modalOpen]);

  const applySelection = (sel: CategorySelection) => {
    pushCategoryHistory(sel);
    onChange(sel);
    setModalOpen(false);
    setSearch('');
  };

  const pickLeaf = (l1: string, l2: string, leaf: CategoryNode) => {
    applySelection({
      platform,
      categoryId: leaf.id,
      label: [l1, l2, leaf.name].filter(Boolean).join(' > '),
      level1: l1,
      level2: l2,
      level3: leaf.name,
    });
  };

  const openModal = () => {
    setSearch('');
    setModalOpen(true);
  };

  return (
    <>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label className="text-[10px] font-bold text-gray-500">{label} *</label>
          <button
            type="button"
            onClick={openModal}
            className={`text-[10px] font-extrabold px-2 py-0.5 rounded-lg border ${theme.border} ${theme.text} ${theme.bg} flex items-center gap-1 shrink-0`}
          >
            <Zap className="w-3 h-3" /> Chọn nhanh
          </button>
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
                <p className="text-[10px] text-gray-400 mt-0.5">Chọn phân cấp: Ngành lớn → Ngành nhỏ → Ngành chi tiết</p>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400">
                <X className="w-5 h-5" />
              </button>
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

              {search.trim() ? (
                <div className="border border-gray-100 rounded-xl overflow-hidden">
                  {searchResults.length === 0 ? (
                    <p className="text-xs text-gray-400 p-4 text-center">Không tìm thấy ngành hàng phù hợp</p>
                  ) : (
                    <ul className="divide-y divide-gray-50 max-h-48 overflow-y-auto">
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
                <div className="grid grid-cols-3 gap-2 min-h-[200px]">
                  <div className="border border-gray-100 rounded-xl overflow-hidden">
                    <div className={`px-3 py-2 text-[10px] font-extrabold uppercase ${theme.bg} ${theme.text}`}>Ngành lớn</div>
                    <ul className="max-h-44 overflow-y-auto">
                      {level1Nodes.map((n) => (
                        <li key={n.id}>
                          <button
                            type="button"
                            onClick={() => { setLevel1Id(n.id); setLevel2Id(null); }}
                            className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between ${
                              level1Id === n.id ? `${theme.bg} font-bold ${theme.text}` : 'hover:bg-gray-50 text-gray-700'
                            }`}
                          >
                            {n.name}
                            <ChevronRight className="w-3 h-3 opacity-50" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="border border-gray-100 rounded-xl overflow-hidden">
                    <div className={`px-3 py-2 text-[10px] font-extrabold uppercase ${theme.bg} ${theme.text}`}>Ngành nhỏ</div>
                    <ul className="max-h-44 overflow-y-auto">
                      {level2Nodes.length === 0 ? (
                        <li className="px-3 py-6 text-[10px] text-gray-400 text-center">← Chọn ngành lớn</li>
                      ) : level2Nodes.map((n) => (
                        <li key={n.id}>
                          <button
                            type="button"
                            onClick={() => setLevel2Id(n.id)}
                            className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between ${
                              level2Id === n.id ? `${theme.bg} font-bold ${theme.text}` : 'hover:bg-gray-50 text-gray-700'
                            }`}
                          >
                            {n.name}
                            <ChevronRight className="w-3 h-3 opacity-50" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="border border-gray-100 rounded-xl overflow-hidden">
                    <div className={`px-3 py-2 text-[10px] font-extrabold uppercase ${theme.bg} ${theme.text}`}>Ngành chi tiết</div>
                    <ul className="max-h-44 overflow-y-auto">
                      {level3Nodes.length === 0 ? (
                        <li className="px-3 py-6 text-[10px] text-gray-400 text-center">← Chọn ngành nhỏ</li>
                      ) : level3Nodes.map((leaf) => {
                        const l1 = level1Nodes.find((x) => x.id === level1Id)?.name || '';
                        const l2 = level2Nodes.find((x) => x.id === level2Id)?.name || '';
                        return (
                          <li key={leaf.id}>
                            <button
                              type="button"
                              onClick={() => pickLeaf(l1, l2, leaf)}
                              className="w-full px-3 py-2 text-left text-xs hover:bg-gray-50 text-gray-800 font-medium"
                            >
                              {leaf.name}
                              <span className="block text-[9px] font-mono text-gray-400">ID: {leaf.id}</span>
                            </button>
                          </li>
                        );
                      })}
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
                      {item.level3}
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
