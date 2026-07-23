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

/** Thuộc tính danh mục Shopee (get_attribute_tree) */
export interface ShopeeAttributeValue {
  value_id: number;
  name: string;
}

export interface ShopeeCategoryAttribute {
  attribute_id: number;
  attribute_name: string;
  mandatory: boolean;
  input_type?: string;
  values: ShopeeAttributeValue[];
}

export interface ShopeeAttributeSelection {
  attribute_id: number;
  value_id: number;
  original_value_name?: string;
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
