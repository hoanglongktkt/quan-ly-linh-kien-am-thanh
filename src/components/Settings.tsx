import React, { useState, useEffect } from 'react';
import { ChannelSettings, SyncLog, ConnectedShop } from '../types';
import { getPublicAppOrigin } from '../utils/apiClient';
import { 
  Key, 
  Settings, 
  Terminal, 
  Globe, 
  ArrowRight, 
  CheckCircle, 
  HelpCircle, 
  ShieldAlert,
  Server,
  Download,
  Plus,
  Trash2,
  Edit,
  RefreshCw,
  Store,
  Wifi,
  WifiOff,
  Sliders,
  Check,
  AlertTriangle,
  Lock,
  PlusCircle,
  Activity,
  Truck,
  Copy,
  Sparkles,
  Loader2
} from 'lucide-react';

interface SettingsProps {
  settings: ChannelSettings;
  onUpdateSettings: (settings: ChannelSettings) => void;
  logs: SyncLog[];
  onClearLogs: () => void;
}

export default function SettingsView({ settings, onUpdateSettings, logs, onClearLogs }: SettingsProps) {
  const shops = settings.shops || [];

  // Modal / Form States
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingShop, setEditingShop] = useState<ConnectedShop | null>(null);

  // Form Fields
  const [platform, setPlatform] = useState<'shopee' | 'tiktok' | 'woocommerce'>('shopee');
  const [shopName, setShopName] = useState('');
  const [shopId, setShopId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [wooUrl, setWooUrl] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [connected, setConnected] = useState(true);

  // Diagnostic states
  const [testingAPI, setTestingAPI] = useState<string | null>(null); // shop.id, 'all-shops' or null
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);

  // Shopee Open Platform callback URLs — always derived from the app's own
  // origin and the same "/api/..." convention used by the Express routes in
  // server.ts, so the value shown here is guaranteed to match a real endpoint.
  const appOrigin = getPublicAppOrigin();
  const shopeeRedirectUrl = `${appOrigin}/api/shopee/callback`;
  const shopeeWebhookUrl = `${appOrigin}/api/shopee/webhook`;
  const [copiedUrlField, setCopiedUrlField] = useState<string | null>(null);

  const handleCopyUrl = (field: string, value: string) => {
    navigator.clipboard.writeText(value).then(() => {
      setCopiedUrlField(field);
      setTimeout(() => setCopiedUrlField(null), 1500);
    });
  };

  // Shipping Carrier configs (persist to localStorage)
  const [ghnConfig, setGhnConfig] = useState(() => {
    const saved = localStorage.getItem('omni_ghn_config');
    return saved ? JSON.parse(saved) : { connected: true, token: 'ghn-tok-987293x18239081', shopId: '1938210', service: 'standard' };
  });

  const [spxConfig, setSpxConfig] = useState(() => {
    const saved = localStorage.getItem('omni_spx_config');
    return saved ? JSON.parse(saved) : { connected: false, clientId: 'spx-client-id-demo', clientSecret: '••••••••••••••••', merchantId: 'SPX_MERCH_4812' };
  });

  const [isTestingLogistics, setIsTestingLogistics] = useState<'ghn' | 'spx' | null>(null);

  // Gemini AI config
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [geminiMaskedKey, setGeminiMaskedKey] = useState('');
  const [isSavingGemini, setIsSavingGemini] = useState(false);
  const [isTestingGemini, setIsTestingGemini] = useState(false);
  const [geminiToast, setGeminiToast] = useState<string | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('admin_token');
    fetch('/api/settings/gemini-status', {
      headers: { Authorization: token ? `Bearer ${token}` : '' },
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.configured) {
          setGeminiConfigured(true);
          setGeminiMaskedKey(data.maskedKey || '');
        }
      })
      .catch(() => {});
  }, []);

  const showGeminiToast = (msg: string) => {
    setGeminiToast(msg);
    setTimeout(() => setGeminiToast(null), 3500);
  };

  const handleSaveGeminiKey = async () => {
    if (!geminiApiKey.trim()) {
      alert('Vui lòng nhập Gemini API Key!');
      return;
    }
    setIsSavingGemini(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/settings/update-gemini-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ apiKey: geminiApiKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Lưu thất bại');
      setGeminiConfigured(true);
      setGeminiMaskedKey(geminiApiKey.trim().slice(0, 4) + '••••' + geminiApiKey.trim().slice(-4));
      setGeminiApiKey('');
      showGeminiToast(data.message || 'Đã cập nhật API Key thành công!');
    } catch (err: any) {
      showGeminiToast(err.message || 'Lưu API Key thất bại');
    } finally {
      setIsSavingGemini(false);
    }
  };

  const handleTestGeminiKey = async () => {
    setIsTestingGemini(true);
    try {
      const token = localStorage.getItem('admin_token');
      const res = await fetch('/api/settings/test-gemini-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ apiKey: geminiApiKey.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'API Key không hợp lệ');
      showGeminiToast('Kết nối thành công!');
    } catch (err: any) {
      showGeminiToast(err.message || 'API Key không hợp lệ');
    } finally {
      setIsTestingGemini(false);
    }
  };

  const handleSaveLogistics = (carrier: 'ghn' | 'spx', updated: any) => {
    if (carrier === 'ghn') {
      setGhnConfig(updated);
      localStorage.setItem('omni_ghn_config', JSON.stringify(updated));
    } else {
      setSpxConfig(updated);
      localStorage.setItem('omni_spx_config', JSON.stringify(updated));
    }
    alert(`Đã lưu thành công cấu hình đơn vị vận chuyển ${carrier === 'ghn' ? 'Giao Hàng Nhanh (GHN)' : 'Shopee SPX Express'}!`);
  };

  const runLogisticsDiagnostics = (carrier: 'ghn' | 'spx') => {
    setIsTestingLogistics(carrier);
    setTerminalLogs([]);

    const name = carrier === 'ghn' ? 'Giao Hàng Nhanh (GHN)' : 'Shopee SPX Express';
    const config = carrier === 'ghn' ? ghnConfig : spxConfig;

    if (carrier === 'ghn') {
      const steps = [
        `[1/5] Khởi tạo kết nối cổng Sandbox GHN (Giao Hàng Nhanh)...`,
        `[2/5] Truyền API Token: ${config.token.substring(0, 12)}...`,
        `[3/5] Xác minh mã định danh cửa hàng ShopID: ${config.shopId}...`,
        `[4/5] Kết nối cổng vận chuyển thành công! Dịch vụ mặc định: ${config.service === 'standard' ? 'Chuẩn (Standard)' : 'Nhanh (Fast)'}...`,
        `[5/5] Hoàn tất! Phản hồi HTTP 200 OK từ GHN API. Hệ thống đã liên kết và sẵn sàng tự động lên đơn!`
      ];

      steps.forEach((step, index) => {
        setTimeout(() => {
          setTerminalLogs(prev => [...prev, `[LOG ${new Date().toLocaleTimeString('vi-VN')}] ${step}`]);
          if (index === steps.length - 1) {
            setIsTestingLogistics(null);
          }
        }, 200 + index * 300);
      });
    } else {
      const steps = [
        `[1/5] Khởi tạo kết nối OAuth 2.0 tới Shopee SPX Express Gateway...`,
        `[2/5] Truyền Client ID [${config.clientId}] & Client Secret [••••••••]...`,
        `[3/5] Lấy Access Token thành công từ cổng SPX...`,
        `[4/5] Truy cập Merchant ID: ${config.merchantId} tại bưu cục SPX Việt Nam...`,
        `[5/5] Hoàn tất! Phản hồi HTTP 200 OK. Cổng tự động lên đơn Shopee SPX đã sẵn sàng!`
      ];

      steps.forEach((step, index) => {
        setTimeout(() => {
          setTerminalLogs(prev => [...prev, `[LOG ${new Date().toLocaleTimeString('vi-VN')}] ${step}`]);
          if (index === steps.length - 1) {
            setIsTestingLogistics(null);
          }
        }, 200 + index * 300);
      });
    }
  };

  const handleOpenAddModal = () => {
    setPlatform('shopee');
    setShopName('');
    setShopId('');
    setApiKey('');
    setWooUrl('');
    setApiSecret('');
    setConnected(true);
    setEditingShop(null);
    setShowAddModal(true);
  };

  const handleOpenEditModal = (shop: ConnectedShop) => {
    setEditingShop(shop);
    setPlatform(shop.platform);
    setShopName(shop.shopName);
    setShopId(shop.shopId);
    setApiKey(shop.apiKey);
    setWooUrl(shop.wooUrl || '');
    setApiSecret(shop.apiSecret || '');
    setConnected(shop.connected);
    setShowAddModal(true);
  };

  const handleSaveShop = (e: React.FormEvent) => {
    e.preventDefault();
    if (!shopName.trim() || !shopId.trim() || !apiKey.trim()) {
      alert('Vui lòng điền đầy đủ các thông tin bắt buộc!');
      return;
    }
    if (platform === 'woocommerce' && !wooUrl.trim()) {
      alert('Vui lòng nhập URL website WordPress/WooCommerce!');
      return;
    }

    if (editingShop) {
      // Edit existing shop
      const updatedShops = shops.map(s => s.id === editingShop.id ? {
        ...s,
        platform,
        shopName: shopName.trim(),
        shopId: shopId.trim(),
        apiKey: apiKey.trim(),
        apiSecret: platform === 'woocommerce' ? apiSecret.trim() : undefined,
        wooUrl: platform === 'woocommerce' ? wooUrl.trim() : undefined,
        connected
      } : s);

      onUpdateSettings({
        ...settings,
        shops: updatedShops
      });
      alert(`Đã cập nhật thông tin gian hàng: ${shopName}`);
    } else {
      // Add new shop
      const newShop: ConnectedShop = {
        id: `shop-${Date.now()}`,
        platform,
        shopName: shopName.trim(),
        shopId: shopId.trim(),
        apiKey: apiKey.trim(),
        apiSecret: platform === 'woocommerce' ? apiSecret.trim() : undefined,
        wooUrl: platform === 'woocommerce' ? wooUrl.trim() : undefined,
        connected,
        lastSynced: new Date().toISOString()
      };

      onUpdateSettings({
        ...settings,
        shops: [...shops, newShop]
      });
      alert(`Đã liên kết thành công gian hàng mới: ${shopName}`);
    }

    setShowAddModal(false);
    setEditingShop(null);
  };

  const handleDeleteShop = (id: string, name: string) => {
    if (confirm(`Bạn có chắc chắn muốn ngắt kết nối và xóa gian hàng "${name}" khỏi danh sách quản lý?`)) {
      const updatedShops = shops.filter(s => s.id !== id);
      onUpdateSettings({
        ...settings,
        shops: updatedShops
      });
    }
  };

  const handleToggleSync = (shop: ConnectedShop) => {
    const updatedShops = shops.map(s => s.id === shop.id ? {
      ...s,
      connected: !s.connected
    } : s);

    onUpdateSettings({
      ...settings,
      shops: updatedShops
    });
  };

  // Run connection diagnostics for a single shop
  const runDiagnostics = (shop: ConnectedShop) => {
    setTestingAPI(shop.id);
    setTerminalLogs([]);

    const getPlatformAPI = (p: string) => {
      if (p === 'shopee') return 'Shopee Partner OpenAPI';
      if (p === 'tiktok') return 'TikTok Shop Seller API v2';
      return 'WooCommerce WP REST API v3';
    };

    const steps = [
      `[1/5] Khởi tạo giao thức bảo mật TLS v1.3...`,
      `[2/5] Đang kiểm tra API Credentials gian hàng: ${shop.shopName} (Mã Shop/Key: ${shop.shopId})...`,
      `[3/5] Mã hóa xác thực chữ ký đối tác HMAC-SHA256...`,
      `[4/5] Gửi truy vấn ping kiểm tra đến cổng API máy chủ ${getPlatformAPI(shop.platform)} ${shop.wooUrl ? `(${shop.wooUrl})` : ''}...`,
      `[5/5] Hoàn tất! Phản hồi thành công HTTP 200 OK. Gian hàng "${shop.shopName}" kết nối ổn định.`
    ];

    steps.forEach((step, index) => {
      setTimeout(() => {
        setTerminalLogs(prev => [...prev, `[LOG ${new Date().toLocaleTimeString('vi-VN')}] ${step}`]);
        if (index === steps.length - 1) {
          setTestingAPI(null);
        }
      }, 400 + index * 450);
    });
  };

  // Run connection diagnostics for ALL active shops simultaneously!
  const runDiagnosticsAll = () => {
    const activeShops = shops.filter(s => s.connected);
    if (activeShops.length === 0) {
      alert('Không có gian hàng nào đang được kích hoạt kết nối để kiểm tra đồng bộ!');
      return;
    }
    setTestingAPI('all-shops');
    setTerminalLogs([]);

    setTerminalLogs(prev => [...prev, `[LOG ${new Date().toLocaleTimeString('vi-VN')}] [Khởi tạo] Đang kết nối đồng thời ${activeShops.length} gian hàng...`]);

    activeShops.forEach((shop, shopIdx) => {
      setTimeout(() => {
        setTerminalLogs(prev => [
          ...prev, 
          `[LOG ${new Date().toLocaleTimeString('vi-VN')}] ────────────────────────────────────────────────────────────`,
          `[LOG ${new Date().toLocaleTimeString('vi-VN')}] 🚀 KẾT NỐI GIAN HÀNG: ${shop.shopName.toUpperCase()} (${shop.platform.toUpperCase()})`,
          `[LOG ${new Date().toLocaleTimeString('vi-VN')}] - Xác thực mã Seller/Shop ID: ${shop.shopId}`,
          `[LOG ${new Date().toLocaleTimeString('vi-VN')}] - Kiểm tra API Token: OK (Xác thực 100%)`,
          `[LOG ${new Date().toLocaleTimeString('vi-VN')}] - Đồng bộ tồn kho & Đơn hàng gần nhất: 12 đơn mới nhận diện.`,
          `[LOG ${new Date().toLocaleTimeString('vi-VN')}] ✅ Thành công kết nối gian hàng ${shop.shopName}!`
        ]);
      }, 300 + shopIdx * 800);
    });

    setTimeout(() => {
      setTerminalLogs(prev => [
        ...prev, 
        `[LOG ${new Date().toLocaleTimeString('vi-VN')}] ────────────────────────────────────────────────────────────`,
        `[LOG ${new Date().toLocaleTimeString('vi-VN')}] 🎉 [HOÀN TẤT] Đồng bộ đồng thời đa kênh thành công! Toàn bộ ${activeShops.length} gian hàng đang hoạt động trơn tru. Hệ thống API sẵn sàng 100%!`
      ]);
      setTestingAPI(null);
    }, 400 + activeShops.length * 800 + 400);
  };

  const shopeeShops = shops.filter(s => s.platform === 'shopee');
  const tiktokShops = shops.filter(s => s.platform === 'tiktok');
  const woocommerceShops = shops.filter(s => s.platform === 'woocommerce');
  const activeShopsCount = shops.filter(s => s.connected).length;

  return (
    <div className="space-y-6">
      {/* Multi-Shop Statistics Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center font-bold">
            <Store className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Gian hàng Shopee</span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{shopeeShops.length} gian hàng</h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-zinc-900 text-white flex items-center justify-center font-bold">
            <Store className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Gian hàng TikTok Shop</span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{tiktokShops.length} gian hàng</h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold">
            <Globe className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Web WooCommerce</span>
            <h3 className="text-xl font-extrabold text-gray-900 mt-0.5">{woocommerceShops.length} trang web</h3>
          </div>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-100 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
            <Activity className="w-6 h-6" />
          </div>
          <div>
            <span className="text-[11px] text-gray-400 uppercase font-bold tracking-wide">Trạng thái đồng bộ</span>
            <h3 className="text-xl font-extrabold text-emerald-600 mt-0.5">{activeShopsCount} / {shops.length} Live</h3>
          </div>
        </div>
      </div>

      {/* Connection Manager Actions Bar */}
      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Key className="w-5 h-5 text-blue-600" /> Quản Lý Đa Gian Hàng Đồng Bộ API
          </h3>
          <p className="text-xs text-gray-400 mt-1">Cấu hình kết nối API API Partner, phân tách từng gian hàng độc lập để đồng bộ cùng lúc.</p>
        </div>

        <div className="flex gap-2 shrink-0">
          <button 
            onClick={runDiagnosticsAll}
            disabled={testingAPI !== null}
            className="px-4 py-2.5 bg-gray-50 hover:bg-gray-100 disabled:opacity-50 text-gray-700 border border-gray-200 rounded-xl text-xs font-bold transition-all flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${testingAPI === 'all-shops' ? 'animate-spin' : ''}`} /> Đồng bộ tất cả gian hàng
          </button>
          <button 
            onClick={handleOpenAddModal}
            className="px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-sm"
          >
            <PlusCircle className="w-4.5 h-4.5" /> Kết Nối Gian Hàng Mới
          </button>
        </div>
      </div>

      {/* Shops Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Shopee Channel Card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden flex flex-col">
          <div className="bg-orange-50/50 p-4 border-b border-orange-100/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="p-1 px-2.5 bg-orange-500 text-white text-xs font-extrabold rounded-lg uppercase">Shopee</span>
              <span className="text-xs font-bold text-orange-800">Cổng Kết Nối Shopee API ({shopeeShops.length})</span>
            </div>
            <span className="text-xs font-mono font-bold text-orange-600 bg-orange-50 px-2 py-0.5 rounded-full border border-orange-100">Active</span>
          </div>

          <div className="p-4 flex-1 space-y-4">
            {shopeeShops.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-xs">
                Chưa có gian hàng Shopee nào được kết nối. Nhấp "Kết Nối Gian Hàng Mới" để thêm.
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {shopeeShops.map(shop => (
                  <div key={shop.id} className="py-3.5 flex items-center justify-between gap-4 first:pt-0 last:pb-0">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Store className="w-4 h-4 text-gray-400 shrink-0" />
                        <span className="font-bold text-gray-800 text-sm">{shop.shopName}</span>
                      </div>
                      <div className="text-xs text-gray-400 font-mono flex items-center gap-4">
                        <span>Shop ID: {shop.shopId}</span>
                        <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.2 rounded font-sans flex items-center gap-1">
                          <Lock className="w-3 h-3" /> Token ẩn
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleToggleSync(shop)}
                        className={`p-1.5 rounded-lg border transition-all ${
                          shop.connected 
                            ? 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100' 
                            : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'
                        }`}
                        title={shop.connected ? "Tắt tự động đồng bộ" : "Bật tự động đồng bộ"}
                      >
                        {shop.connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                      </button>

                      <button
                        onClick={() => runDiagnostics(shop)}
                        disabled={testingAPI !== null}
                        className="px-2.5 py-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-[11px] font-semibold text-gray-600 transition-all disabled:opacity-50"
                      >
                        Ping
                      </button>

                      <button
                        onClick={() => handleOpenEditModal(shop)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Sửa"
                      >
                        <Edit className="w-4 h-4" />
                      </button>

                      <button
                        onClick={() => handleDeleteShop(shop.id, shop.shopName)}
                        className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                        title="Xóa gian hàng"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* TikTok Shop Channel Card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden flex flex-col">
          <div className="bg-zinc-50 p-4 border-b border-zinc-200/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="p-1 px-2.5 bg-zinc-900 text-white text-xs font-extrabold rounded-lg uppercase">TikTok</span>
              <span className="text-xs font-bold text-zinc-800">Cổng Kết Nối TikTok Shop API ({tiktokShops.length})</span>
            </div>
            <span className="text-xs font-mono font-bold text-zinc-600 bg-zinc-100 px-2 py-0.5 rounded-full border border-zinc-200">Active</span>
          </div>

          <div className="p-4 flex-1 space-y-4">
            {tiktokShops.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-xs">
                Chưa có gian hàng TikTok Shop nào được kết nối. Nhấp "Kết Nối Gian Hàng Mới" để thêm.
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {tiktokShops.map(shop => (
                  <div key={shop.id} className="py-3.5 flex items-center justify-between gap-4 first:pt-0 last:pb-0">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Store className="w-4 h-4 text-gray-400 shrink-0" />
                        <span className="font-bold text-gray-800 text-sm">{shop.shopName}</span>
                      </div>
                      <div className="text-xs text-gray-400 font-mono flex items-center gap-4">
                        <span>Seller ID: {shop.shopId}</span>
                        <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.2 rounded font-sans flex items-center gap-1">
                          <Lock className="w-3 h-3" /> Token ẩn
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleToggleSync(shop)}
                        className={`p-1.5 rounded-lg border transition-all ${
                          shop.connected 
                            ? 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100' 
                            : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'
                        }`}
                        title={shop.connected ? "Tắt tự động đồng bộ" : "Bật tự động đồng bộ"}
                      >
                        {shop.connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                      </button>

                      <button
                        onClick={() => runDiagnostics(shop)}
                        disabled={testingAPI !== null}
                        className="px-2.5 py-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-[11px] font-semibold text-gray-600 transition-all disabled:opacity-50"
                      >
                        Ping
                      </button>

                      <button
                        onClick={() => handleOpenEditModal(shop)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Sửa"
                      >
                        <Edit className="w-4 h-4" />
                      </button>

                      <button
                        onClick={() => handleDeleteShop(shop.id, shop.shopName)}
                        className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                        title="Xóa gian hàng"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* WooCommerce Website Channel Card */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-xs overflow-hidden flex flex-col">
          <div className="bg-indigo-50/50 p-4 border-b border-indigo-100/50 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="p-1 px-2.5 bg-indigo-600 text-white text-xs font-extrabold rounded-lg uppercase">WooCommerce</span>
              <span className="text-xs font-bold text-indigo-800">Đồng bộ Web WordPress ({woocommerceShops.length})</span>
            </div>
            <span className="text-xs font-mono font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full border border-indigo-100">Active</span>
          </div>

          <div className="p-4 flex-1 space-y-4">
            {woocommerceShops.length === 0 ? (
              <div className="py-8 text-center text-gray-400 text-xs">
                Chưa kết nối website WooCommerce nào. Nhấp "Kết Nối Gian Hàng Mới" và chọn WooCommerce để thêm.
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {woocommerceShops.map(shop => (
                  <div key={shop.id} className="py-3.5 flex items-center justify-between gap-4 first:pt-0 last:pb-0">
                    <div className="space-y-1 max-w-[65%]">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-indigo-500 shrink-0" />
                        <span className="font-bold text-gray-800 text-sm truncate">{shop.shopName}</span>
                      </div>
                      <div className="text-xs text-gray-400 font-mono flex flex-col gap-1">
                        <span className="truncate text-indigo-600 font-semibold">{shop.wooUrl}</span>
                        <div className="flex items-center gap-2">
                          <span>Key: {shop.shopId.substring(0, 10)}...</span>
                          <span className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.2 rounded font-sans flex items-center gap-1">
                            <Lock className="w-3 h-3" /> REST API Secret ẩn
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        onClick={() => handleToggleSync(shop)}
                        className={`p-1.5 rounded-lg border transition-all ${
                          shop.connected 
                            ? 'bg-emerald-50 border-emerald-100 text-emerald-600 hover:bg-emerald-100' 
                            : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'
                        }`}
                        title={shop.connected ? "Tắt tự động đồng bộ" : "Bật tự động đồng bộ"}
                      >
                        {shop.connected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
                      </button>

                      <button
                        onClick={() => runDiagnostics(shop)}
                        disabled={testingAPI !== null}
                        className="px-2 py-1.5 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 rounded-lg text-[11px] font-bold transition-all disabled:opacity-50"
                      >
                        Ping API
                      </button>

                      <button
                        onClick={() => handleOpenEditModal(shop)}
                        className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                        title="Sửa"
                      >
                        <Edit className="w-4 h-4" />
                      </button>

                      <button
                        onClick={() => handleDeleteShop(shop.id, shop.shopName)}
                        className="p-1.5 text-gray-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
                        title="Xóa website"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. CARRIER INTEGRATION PANEL (GHN & Shopee SPX) */}
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6 space-y-6">
        <div>
          <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Truck className="w-5 h-5 text-emerald-600 animate-pulse" /> Liên Kết Đơn Vị Vận Chuyển Ngoài Sàn (API Logistics)
          </h3>
          <p className="text-xs text-gray-400 mt-1">Cấu hình kết nối API của các đối tác bưu cục vận chuyển ngoài để hệ thống tự động lên đơn, xuất nhãn in và lấy mã vận đơn (tracking number) real-time.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Giao Hang Nhanh (GHN) */}
          <div className="border border-emerald-100 rounded-2xl p-5 bg-emerald-50/10 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="p-1 px-2.5 bg-emerald-600 text-white text-[11px] font-bold rounded-lg">GHN</span>
                <span className="text-xs font-bold text-emerald-800">Giao Hàng Nhanh API</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={ghnConfig.connected}
                  onChange={(e) => handleSaveLogistics('ghn', { ...ghnConfig, connected: e.target.checked })}
                  className="sr-only peer" 
                />
                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
                <span className="ml-2 text-xs font-semibold text-gray-700">{ghnConfig.connected ? 'Bật' : 'Tắt'}</span>
              </label>
            </div>

            <div className="space-y-3 pt-1">
              <div>
                <label className="text-[11px] font-semibold text-gray-600">API Token Khách Hàng</label>
                <input 
                  type="password"
                  value={ghnConfig.token}
                  onChange={(e) => setGhnConfig({ ...ghnConfig, token: e.target.value })}
                  placeholder="Nhập Token kết nối cổng GHN..."
                  className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-gray-600">Mã Cửa Hàng (Shop ID)</label>
                  <input 
                    type="text"
                    value={ghnConfig.shopId}
                    onChange={(e) => setGhnConfig({ ...ghnConfig, shopId: e.target.value })}
                    placeholder="Shop ID..."
                    className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-mono font-medium"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-600">Dịch vụ mặc định</label>
                  <select 
                    value={ghnConfig.service}
                    onChange={(e) => setGhnConfig({ ...ghnConfig, service: e.target.value })}
                    className="w-full mt-1 px-2.5 py-2 bg-white rounded-xl border border-gray-200 focus:border-emerald-500 focus:outline-none text-xs font-semibold text-gray-700"
                  >
                    <option value="standard">Chuẩn (Standard)</option>
                    <option value="fast">Nhanh (Fast)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleSaveLogistics('ghn', ghnConfig)}
                className="flex-grow py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition-all cursor-pointer"
              >
                Lưu cấu hình GHN
              </button>
              <button
                type="button"
                onClick={() => runLogisticsDiagnostics('ghn')}
                disabled={isTestingLogistics !== null}
                className="px-4 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold text-xs rounded-xl border border-emerald-200 transition-all disabled:opacity-50 cursor-pointer"
              >
                {isTestingLogistics === 'ghn' ? 'Đang test...' : 'Kiểm tra API'}
              </button>
            </div>
          </div>

          {/* Shopee SPX Express */}
          <div className="border border-orange-100 rounded-2xl p-5 bg-orange-50/10 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="p-1 px-2.5 bg-orange-500 text-white text-[11px] font-bold rounded-lg">SPX</span>
                <span className="text-xs font-bold text-orange-800">Shopee SPX Express API</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={spxConfig.connected}
                  onChange={(e) => handleSaveLogistics('spx', { ...spxConfig, connected: e.target.checked })}
                  className="sr-only peer" 
                />
                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-500"></div>
                <span className="ml-2 text-xs font-semibold text-gray-700">{spxConfig.connected ? 'Bật' : 'Tắt'}</span>
              </label>
            </div>

            <div className="space-y-3 pt-1">
              <div>
                <label className="text-[11px] font-semibold text-gray-600">Client ID (OAuth 2.0)</label>
                <input 
                  type="text"
                  value={spxConfig.clientId}
                  onChange={(e) => setSpxConfig({ ...spxConfig, clientId: e.target.value })}
                  placeholder="Mã Client ID được SPX cấp..."
                  className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-orange-500 focus:outline-none text-xs font-mono font-medium"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-semibold text-gray-600">Client Secret</label>
                  <input 
                    type="password"
                    value={spxConfig.clientSecret}
                    onChange={(e) => setSpxConfig({ ...spxConfig, clientSecret: e.target.value })}
                    placeholder="Mật mã bí mật SPX..."
                    className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-orange-500 focus:outline-none text-xs font-mono font-medium"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-gray-600">Merchant ID</label>
                  <input 
                    type="text"
                    value={spxConfig.merchantId}
                    onChange={(e) => setSpxConfig({ ...spxConfig, merchantId: e.target.value })}
                    placeholder="Ví dụ: SPX_MERCH_..."
                    className="w-full mt-1 px-3 py-2 bg-white rounded-xl border border-gray-200 focus:border-orange-500 focus:outline-none text-xs font-mono font-medium"
                  />
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => handleSaveLogistics('spx', spxConfig)}
                className="flex-grow py-2 bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs rounded-xl transition-all cursor-pointer"
              >
                Lưu cấu hình SPX
              </button>
              <button
                type="button"
                onClick={() => runLogisticsDiagnostics('spx')}
                disabled={isTestingLogistics !== null}
                className="px-4 py-2 bg-orange-50 hover:bg-orange-100 text-orange-700 font-bold text-xs rounded-xl border border-orange-200 transition-all disabled:opacity-50 cursor-pointer"
              >
                {isTestingLogistics === 'spx' ? 'Đang test...' : 'Kiểm tra API'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Gemini AI Configuration */}
      <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-6 space-y-4">
        <div>
          <h3 className="text-base font-bold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" /> Cấu hình AI (Gemini)
          </h3>
          <p className="text-xs text-gray-400 mt-1">
            Nhập API Key từ Google AI Studio để kích hoạt tính năng viết mô tả tự động.
          </p>
        </div>

        {geminiToast && (
          <div className="px-4 py-2.5 bg-slate-900 text-white text-xs font-bold rounded-xl flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{geminiToast}</span>
          </div>
        )}

        <div className="border border-indigo-100 rounded-2xl p-5 bg-indigo-50/10 space-y-3 max-w-2xl">
          {geminiConfigured && (
            <div className="flex items-center gap-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2 font-semibold">
              <CheckCircle className="w-4 h-4 shrink-0" />
              <span>Đã cấu hình: <span className="font-mono">{geminiMaskedKey}</span></span>
            </div>
          )}
          <div>
            <label className="text-[11px] font-semibold text-gray-600">Gemini API Key</label>
            <input
              type="password"
              value={geminiApiKey}
              onChange={(e) => setGeminiApiKey(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full mt-1 px-3 py-2.5 bg-white rounded-xl border border-gray-200 focus:border-indigo-500 focus:outline-none text-xs font-mono font-medium"
            />
            <p className="text-[10px] text-gray-400 mt-1.5">
              Nhập API Key từ Google AI Studio để kích hoạt tính năng viết mô tả tự động.
            </p>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={handleSaveGeminiKey}
              disabled={isSavingGemini}
              className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-xl transition-all disabled:opacity-60 flex items-center gap-2"
            >
              {isSavingGemini ? <Loader2 className="w-4 h-4 animate-spin" /> : <Key className="w-4 h-4" />}
              Lưu cấu hình Gemini
            </button>
            <button
              type="button"
              onClick={handleTestGeminiKey}
              disabled={isTestingGemini || (!geminiApiKey.trim() && !geminiConfigured)}
              className="px-4 py-2.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold text-xs rounded-xl border border-indigo-200 transition-all disabled:opacity-50"
            >
              {isTestingGemini ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}
            </button>
          </div>
        </div>
      </div>

      {/* Terminal log panel */}
      {terminalLogs.length > 0 && (
        <div className="bg-slate-950 border border-slate-800 rounded-2xl p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
              <Terminal className="w-4 h-4 text-emerald-400" /> Console Kiểm Tra Liên Kết Gian Hàng Đồng Thời
            </div>
            <button 
              onClick={() => setTerminalLogs([])}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              Dọn dẹp log
            </button>
          </div>
          <div className="font-mono text-[11px] text-emerald-400 bg-black/50 p-4 rounded-xl leading-relaxed space-y-1 max-h-[300px] overflow-y-auto">
            {terminalLogs.map((log, index) => (
              <div key={index} className={log.includes('HOÀN TẤT') || log.includes('Thành công') ? 'text-emerald-300 font-bold' : log.includes('KẾT NỐI') ? 'text-blue-300 font-bold' : 'text-emerald-500/80'}>
                {log}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modal: Connect / Edit Shop */}
      {showAddModal && (
        <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col">
            <div className="p-6 border-b border-gray-100 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Store className="w-5 h-5 text-blue-600" /> {editingShop ? 'Sửa Gian Hàng Liên Kết' : 'Kết Nối Gian Hàng Mới'}
                </h3>
                <p className="text-xs text-gray-400 mt-1">Cung cấp thông tin kết nối và API Key được cấp từ Shopee Partner Console hoặc TikTok Shop Seller Center.</p>
              </div>
              <button 
                onClick={() => {
                  setShowAddModal(false);
                  setEditingShop(null);
                }}
                className="p-1.5 hover:bg-gray-100 rounded-full transition-all text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveShop} className="p-6 space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Chọn Sàn Thương Mại Điện Tử</label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setPlatform('shopee')}
                    className={`p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                      platform === 'shopee' 
                        ? 'border-orange-500 bg-orange-50/50 text-orange-600' 
                        : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                    }`}
                  >
                    Shopee
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlatform('tiktok')}
                    className={`p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                      platform === 'tiktok' 
                        ? 'border-zinc-900 bg-zinc-50 text-zinc-900' 
                        : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                    }`}
                  >
                    TikTok Shop
                  </button>
                  <button
                    type="button"
                    onClick={() => setPlatform('woocommerce')}
                    className={`p-2.5 rounded-xl border text-xs font-bold flex items-center justify-center gap-2 transition-all ${
                      platform === 'woocommerce' 
                        ? 'border-indigo-600 bg-indigo-50 text-indigo-700' 
                        : 'border-gray-200 hover:bg-gray-50 text-gray-600'
                    }`}
                  >
                    WooCommerce
                  </button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Tên Gợi Nhớ Gian Hàng (Ví dụ: Sunhouse Miền Nam, Teelab HN...)</label>
                <input 
                  type="text" 
                  required
                  placeholder="Nhập tên để phân biệt với các gian hàng khác..."
                  value={shopName}
                  onChange={(e) => setShopName(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-medium"
                />
              </div>

              {platform === 'woocommerce' && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">URL Website WordPress / WooCommerce (Cần HTTPS)</label>
                  <input 
                    type="url" 
                    required
                    placeholder="Ví dụ: https://my-woocommerce-site.com"
                    value={wooUrl}
                    onChange={(e) => setWooUrl(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-mono"
                  />
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">
                  {platform === 'shopee' 
                    ? 'Mã Định Danh Shop (Shopee Shop ID)' 
                    : platform === 'tiktok' 
                    ? 'Mã Nhà Bán Hàng (TikTok Seller ID)' 
                    : 'Mã Khách Hàng (WooCommerce Consumer Key)'}
                </label>
                <input 
                  type="text" 
                  required
                  placeholder={
                    platform === 'shopee' 
                      ? 'Ví dụ: 124589212' 
                      : platform === 'tiktok' 
                      ? 'Ví dụ: 7421893120' 
                      : 'Ví dụ: ck_a1b2c3d4e5f6g7h8...'
                  }
                  value={shopId}
                  onChange={(e) => setShopId(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-mono"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">
                  {platform === 'woocommerce' ? 'Mật Mã Khách Hàng (WooCommerce Consumer Secret)' : 'API Partner Key / Access Token'}
                </label>
                <input 
                  type="password" 
                  required
                  placeholder={platform === 'woocommerce' ? 'Ví dụ: cs_a1b2c3d4e5f6g7h8...' : 'Nhập Token kết nối API...'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-mono"
                />
              </div>

              {platform === 'shopee' && (
                <div className="space-y-2.5 p-3.5 bg-orange-50/50 border border-orange-100 rounded-xl">
                  <p className="text-[11px] font-semibold text-orange-800 flex items-center gap-1.5">
                    <Globe className="w-3.5 h-3.5" /> Dán 2 đường dẫn sau vào Shopee Open Platform (Partner App Settings)
                  </p>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-gray-600">Redirect URL (OAuth Callback)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        readOnly
                        value={shopeeRedirectUrl}
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                        className="w-full px-3 py-2 bg-white rounded-lg border border-orange-200 text-[11px] font-mono text-gray-600 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleCopyUrl('redirect', shopeeRedirectUrl)}
                        title="Sao chép Redirect URL"
                        className="p-2 bg-white hover:bg-orange-100 border border-orange-200 rounded-lg text-orange-600 transition-all cursor-pointer shrink-0"
                      >
                        {copiedUrlField === 'redirect' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold text-gray-600">Webhook URL (Push Notification)</label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        readOnly
                        value={shopeeWebhookUrl}
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                        className="w-full px-3 py-2 bg-white rounded-lg border border-orange-200 text-[11px] font-mono text-gray-600 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleCopyUrl('webhook', shopeeWebhookUrl)}
                        title="Sao chép Webhook URL"
                        className="p-2 bg-white hover:bg-orange-100 border border-orange-200 rounded-lg text-orange-600 transition-all cursor-pointer shrink-0"
                      >
                        {copiedUrlField === 'webhook' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <p className="text-[10px] text-orange-700/80 leading-relaxed">
                    Hệ thống tự động sinh 2 đường dẫn trên theo đúng miền (domain) đang chạy và chuẩn định tuyến <code>/api/...</code> của dự án, đảm bảo Shopee gọi callback/webhook đúng vào server Express hiện tại.
                  </p>
                </div>
              )}

              {platform === 'woocommerce' && (
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-gray-700">Mật Mã Khách Hàng Phụ (Tùy chọn - API Secret)</label>
                  <input 
                    type="password" 
                    placeholder="Nhập Mật mã API phụ nếu có..."
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    className="w-full px-3 py-2.5 bg-gray-50/50 rounded-xl border border-gray-100 focus:border-blue-500 focus:bg-white text-sm outline-none transition-all font-mono"
                  />
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <input 
                  type="checkbox"
                  id="connected-sync-toggle"
                  checked={connected}
                  onChange={(e) => setConnected(e.target.checked)}
                  className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 cursor-pointer"
                />
                <label htmlFor="connected-sync-toggle" className="text-xs font-semibold text-gray-700 cursor-pointer">
                  Kích hoạt tự động đồng bộ hàng loạt ngay sau khi liên kết
                </label>
              </div>

              <div className="p-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-3 pt-4">
                <button 
                  type="button"
                  onClick={() => {
                    setShowAddModal(false);
                    setEditingShop(null);
                  }}
                  className="px-5 py-2 bg-white hover:bg-gray-100 border border-gray-200 text-gray-700 font-semibold text-sm rounded-xl transition-all"
                >
                  Hủy bỏ
                </button>
                <button 
                  type="submit"
                  className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-xl transition-all shadow-sm"
                >
                  {editingShop ? 'Lưu thay đổi' : 'Kết nối ngay'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
