import { CategoryNode, FlatCategory, MarketplacePlatform } from '../types/marketplaceCategory';

const SHOPEE_TREE: CategoryNode[] = [
  {
    id: '100017',
    name: 'Thiết bị điện tử',
    children: [
      {
        id: '100534',
        name: 'Thiết bị âm thanh',
        children: [
          { id: '100535', name: 'Loa bluetooth' },
          { id: '100536', name: 'Tai nghe' },
          { id: '100537', name: 'Micro thu âm' },
          { id: '100538', name: 'Amply & Mixer' },
          { id: '100539', name: 'Phụ kiện âm thanh' },
        ],
      },
      {
        id: '100540',
        name: 'Phụ kiện điện tử',
        children: [
          { id: '100541', name: 'Cáp âm thanh' },
          { id: '100542', name: 'Jack chuyển đổi' },
          { id: '100543', name: 'Adapter & Converter' },
        ],
      },
    ],
  },
  {
    id: '100100',
    name: 'Nhà cửa & Đời sống',
    children: [
      {
        id: '100201',
        name: 'Đồ dùng nhà bếp',
        children: [
          { id: '100202', name: 'Nồi chiên không dầu' },
          { id: '100203', name: 'Máy xay sinh tố' },
        ],
      },
    ],
  },
];

const LAZADA_TREE: CategoryNode[] = [
  {
    id: '42062201',
    name: 'Điện tử',
    children: [
      {
        id: '42062202',
        name: 'Âm thanh',
        children: [
          { id: '42062203', name: 'Loa di động' },
          { id: '42062204', name: 'Tai nghe & Headphone' },
          { id: '42062205', name: 'Microphone' },
          { id: '42062206', name: 'Thiết bị DJ & Karaoke' },
          { id: '42062207', name: 'Linh kiện âm thanh' },
        ],
      },
      {
        id: '42062210',
        name: 'Phụ kiện điện tử',
        children: [
          { id: '42062211', name: 'Cáp & Adapter' },
          { id: '42062212', name: 'Jack & Chuyển đổi' },
        ],
      },
    ],
  },
  {
    id: '42063001',
    name: 'Gia dụng',
    children: [
      {
        id: '42063002',
        name: 'Thiết bị nhà bếp',
        children: [
          { id: '42063003', name: 'Nồi chiên' },
          { id: '42063004', name: 'Máy ép trái cây' },
        ],
      },
    ],
  },
];

const TIKTOK_TREE: CategoryNode[] = [
  {
    id: '600001',
    name: 'Điện tử gia dụng',
    children: [
      {
        id: '600101',
        name: 'Thiết bị âm thanh',
        children: [
          { id: '600102', name: 'Loa bluetooth' },
          { id: '600103', name: 'Tai nghe không dây' },
          { id: '600104', name: 'Micro karaoke' },
          { id: '600105', name: 'Amply mini' },
          { id: '600106', name: 'Phụ kiện loa' },
        ],
      },
    ],
  },
  {
    id: '600200',
    name: 'Phụ kiện điện tử',
    children: [
      {
        id: '600201',
        name: 'Cáp & Jack',
        children: [
          { id: '600202', name: 'Cáp AUX 3.5mm' },
          { id: '600203', name: 'Jack chuyển Type-C' },
          { id: '600204', name: 'Splitter âm thanh' },
        ],
      },
    ],
  },
];

const TREES: Record<MarketplacePlatform, CategoryNode[]> = {
  shopee: SHOPEE_TREE,
  lazada: LAZADA_TREE,
  tiktok: TIKTOK_TREE,
};

export function getCategoryTree(platform: MarketplacePlatform): CategoryNode[] {
  return TREES[platform] || [];
}

export function flattenCategoryTree(platform: MarketplacePlatform): FlatCategory[] {
  const tree = getCategoryTree(platform);
  const result: FlatCategory[] = [];

  const walk = (nodes: CategoryNode[], l1 = '', l2 = '') => {
    for (const node of nodes) {
      if (node.children?.length) {
        if (!l1) walk(node.children, node.name, '');
        else walk(node.children, l1, node.name);
      } else {
        const level1 = l1;
        const level2 = l2;
        const level3 = node.name;
        const label = [level1, level2, level3].filter(Boolean).join(' > ');
        result.push({
          platform,
          categoryId: node.id,
          label,
          level1,
          level2,
          level3,
          searchText: `${label} ${node.id}`.toLowerCase(),
        });
      }
    }
  };

  walk(tree);
  return result;
}

export function findCategoryById(platform: MarketplacePlatform, categoryId: string): FlatCategory | undefined {
  return flattenCategoryTree(platform).find((c) => c.categoryId === categoryId);
}

export function flatToSelection(item: FlatCategory) {
  return {
    platform: item.platform,
    categoryId: item.categoryId,
    label: item.label,
    level1: item.level1,
    level2: item.level2,
    level3: item.level3,
  };
}

/** Gợi ý ngành hàng thường dùng (mặc định theo shop âm thanh) */
export const DEFAULT_SUGGESTED_IDS: Record<MarketplacePlatform, string[]> = {
  shopee: ['100535', '100536', '100539', '100541'],
  lazada: ['42062203', '42062204', '42062207', '42062211'],
  tiktok: ['600102', '600103', '600106', '600202'],
};
