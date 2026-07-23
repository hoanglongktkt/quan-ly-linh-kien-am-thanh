import React, { useState } from 'react';
import { Product, SyncLog } from '../types';
import MultiChannelListingForm from './MultiChannelListingForm';
import PublishListingTable from './PublishListingTable';
import PublishEditAssets from './PublishEditAssets';
import {
  Sparkles,
  FolderPlus,
  Globe,
  List,
} from 'lucide-react';

interface PublishManagerProps {
  products: Product[];
  onUpdateProduct: (product: Product) => void;
  onAddLog: (log: SyncLog) => void;
  shops: any[];
}

export default function PublishManager({ products, onUpdateProduct, onAddLog, shops }: PublishManagerProps) {
  const [activeTab, setActiveTab] = useState<'publish_new' | 'listing_list' | 'edit_assets'>('publish_new');
  const [editProductId, setEditProductId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="bg-white border border-gray-100 p-2.5 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
        <div className="flex bg-gray-100/80 p-1 rounded-xl w-full sm:w-auto overflow-x-auto">
          <button
            onClick={() => setActiveTab('publish_new')}
            className={`flex-1 sm:flex-initial px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'publish_new'
                ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            <FolderPlus className="w-4 h-4" />
            <span>Đăng bán mới</span>
          </button>

          <button
            onClick={() => setActiveTab('listing_list')}
            className={`flex-1 sm:flex-initial px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'listing_list'
                ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            <List className="w-4 h-4" />
            <span>Danh sách đăng bán</span>
          </button>

          <button
            onClick={() => setActiveTab('edit_assets')}
            className={`flex-1 sm:flex-initial px-5 py-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'edit_assets'
                ? 'bg-white text-blue-600 shadow-xs font-extrabold'
                : 'text-gray-500 hover:text-gray-900'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Sửa sản phẩm đăng bán</span>
          </button>
        </div>

        <div className="text-[11px] text-gray-400 font-semibold flex items-center gap-1.5 px-3">
          <Globe className="w-3.5 h-3.5 text-blue-500" />
          <span>Đăng tải đồng thời lên nhiều gian hàng Shopee, TikTok Shop, Lazada</span>
        </div>
      </div>

      {activeTab === 'publish_new' && (
        <MultiChannelListingForm
          products={products}
          shops={shops}
          onAddLog={onAddLog}
          initialProductId={editProductId}
        />
      )}

      {activeTab === 'listing_list' && (
        <PublishListingTable
          products={products}
          onEditListing={(productId) => {
            setEditProductId(productId);
            setActiveTab('publish_new');
          }}
        />
      )}

      {activeTab === 'edit_assets' && (
        <PublishEditAssets
          products={products}
          shops={shops}
          onUpdateProduct={onUpdateProduct}
          onAddLog={onAddLog}
        />
      )}
    </div>
  );
}
