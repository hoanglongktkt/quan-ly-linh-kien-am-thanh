export type MarketplacePlatform = 'shopee' | 'lazada' | 'tiktok';

export interface CategoryNode {
  id: string;
  name: string;
  children?: CategoryNode[];
}

export interface CategorySelection {
  platform: MarketplacePlatform;
  categoryId: string;
  label: string;
  level1: string;
  level2: string;
  level3: string;
}

export interface FlatCategory {
  platform: MarketplacePlatform;
  categoryId: string;
  label: string;
  level1: string;
  level2: string;
  level3: string;
  searchText: string;
}
