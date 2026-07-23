export type ListingPlatform = 'shopee' | 'lazada' | 'tiktok';
export type ListingStatus = 'success' | 'failed' | 'pending';

export interface ProductListing {
  id: string;
  product_id: string;
  publish_batch_id?: string;
  platform: ListingPlatform;
  shop_id: string;
  shop_name: string;
  status: ListingStatus;
  platform_product_id?: string;
  error_message?: string;
  listing_title?: string;
  product_image?: string;
  created_at: string;
  updated_at: string;
}

export type OverallListingStatus = 'success' | 'failed' | 'partial' | 'pending';

export interface ProductListingGroup {
  product_id: string;
  product_title: string;
  product_image?: string;
  product_sku?: string;
  created_at: string;
  updated_at: string;
  overall_status: OverallListingStatus;
  platform_labels: string[];
  children: ProductListing[];
}
