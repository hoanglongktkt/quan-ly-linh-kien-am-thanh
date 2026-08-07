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

/** Heuristic: danh mục Y tế / Dược phẩm → bắt buộc medicine_id. */
export function isShopeeMedicalCategorySelection(
  cat: Pick<CategorySelection, 'label' | 'level1' | 'level2' | 'level3'> | null | undefined,
  extraLabel = '',
): boolean {
  const text = [extraLabel, cat?.label, cat?.level1, cat?.level2, cat?.level3]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .normalize('NFC');
  return /dược|thuốc|y\s*tế|sức\s*khỏe|pharmacy|medicine|healthcare|health\s*care|pharma|\botc\b|thực phẩm chức năng|bổ sung sức khỏe|chăm sóc sức khỏe/.test(
    text,
  );
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
