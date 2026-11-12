import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { decodeVapidPublicKey, OrderPushError, orderPushRequest, removeOrderPushSubscription } from '../utils/orderPush';

type PushSetup = {
  registration: ServiceWorkerRegistration;
  applicationServerKey: Uint8Array<ArrayBuffer>;
};

function getSupportMessage() {
  if (!window.isSecureContext) return 'Mở trang quản lý qua HTTPS để bật thông báo.';
  const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (isAppleMobile && !standalone) {
    return 'Trên iPhone hoặc iPad, hãy mở app từ màn hình chính để bật thông báo.';
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'Trình duyệt này chưa hỗ trợ Web Push. Trên iPhone cần iOS 16.4 trở lên.';
  }
  return '';
}

export default function OrderPushSettings() {
  const [setup, setSetup] = useState<PushSetup | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const [supportMessage] = useState(getSupportMessage);
  const permissionDenied = 'Notification' in window && Notification.permission === 'denied';

  useEffect(() => {
    if (supportMessage) return;
    const controller = new AbortController();
    const signal = controller.signal;
    void (async () => {
      const config = await orderPushRequest<{ enabled: boolean; publicKey?: string }>('/config', { signal });
      if (signal.aborted) return;
      if (!config.enabled || !config.publicKey) {
        setMessage('Máy chủ chưa bật chức năng báo đơn mới.');
        return;
      }
      await navigator.serviceWorker.register('/order-push-sw.js', { scope: '/', updateViaCache: 'none' });
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      const state = subscription && await orderPushRequest<{ subscribed: boolean }>('/status', {
        method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }), signal,
      });
      if (signal.aborted) return;
      setSubscribed(Boolean(state && state.subscribed));
      setSetup({ registration, applicationServerKey: decodeVapidPublicKey(config.publicKey) });
    })().catch((err) => {
      if (!signal.aborted) setMessage(err instanceof OrderPushError ? err.message : 'Không khởi động được Web Push trên thiết bị này.');
    });
    return () => controller.abort();
  }, [supportMessage, reload]);

  const run = async (action: 'enable' | 'disable' | 'test') => {
    if (!setup || busy) return;
    setBusy(true);
    setMessage('');
    const { registration, applicationServerKey } = setup;
    try {
      if (action === 'enable') {
        // Call directly from the button gesture so WebKit can request permission.
        const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        await orderPushRequest('/subscription', {
          method: 'PUT', body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
        setSubscribed(true);
        setMessage('Thiết bị này đã bật báo đơn mới.');
        return;
      }
      const subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        setSubscribed(false);
        setMessage('Đăng ký thông báo đã hết hạn. Hãy bật lại thông báo.');
        return;
      }
      if (action === 'disable') {
        await removeOrderPushSubscription(subscription);
        setSubscribed(false);
        setMessage('Đã tắt báo đơn mới trên thiết bị này.');
        return;
      }
      await orderPushRequest('/test', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
      setMessage('Đã gửi thông báo thử. Hãy kiểm tra thông báo trên điện thoại.');
    } catch (err) {
      if (err instanceof OrderPushError && [404, 410].includes(err.status) && action === 'test') {
        setSubscribed(false);
        const subscription = await registration.pushManager.getSubscription().catch(() => null);
        await subscription?.unsubscribe().catch(() => {});
      }
      setMessage(Notification.permission === 'denied'
        ? 'Thông báo đang bị chặn. Hãy cho phép trong cài đặt của điện thoại hoặc trình duyệt.'
        : err instanceof OrderPushError ? err.message : 'Không thực hiện được. Vui lòng thử lại.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 sm:p-5" aria-labelledby="order-push-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="rounded-xl bg-sky-50 p-2 text-sky-700">
            {subscribed ? <Bell size={20} aria-hidden /> : <BellOff size={20} aria-hidden />}
          </span>
          <div>
            <h2 id="order-push-heading" className="font-semibold text-slate-900">Thông báo đơn mới</h2>
            <p className="text-sm text-slate-600">Nhận báo đơn Shopee và website khi khóa màn hình.</p>
          </div>
        </div>
        {setup && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${subscribed ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
            {subscribed ? 'Đã bật trên thiết bị này' : 'Đang tắt'}
          </span>
        )}
      </div>
      {setup && (
        <div className="mt-3 flex flex-wrap gap-2">
          {subscribed ? (
            <>
              <button type="button" disabled={busy || permissionDenied} onClick={() => void run('test')} className="min-h-11 rounded-xl bg-sky-700 px-4 text-sm font-semibold text-white disabled:opacity-50">Gửi thông báo thử</button>
              <button type="button" disabled={busy} onClick={() => void run('disable')} className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-semibold text-slate-700 disabled:opacity-50">Tắt trên thiết bị này</button>
            </>
          ) : (
            <button type="button" disabled={busy || permissionDenied} onClick={() => void run('enable')} className="min-h-11 rounded-xl bg-sky-700 px-4 text-sm font-semibold text-white disabled:opacity-50">Bật thông báo đơn mới</button>
          )}
        </div>
      )}
      <p className="mt-2 text-sm text-slate-600" role="status">
        {supportMessage || message || (permissionDenied ? 'Hãy cho phép thông báo trong cài đặt của điện thoại hoặc trình duyệt.' : !setup ? 'Đang kiểm tra thiết bị…' : '')}
      </p>
      {!supportMessage && !setup && message && (
        <button type="button" className="min-h-11 text-sm font-semibold text-sky-700 underline" onClick={() => { setMessage(''); setReload((prev) => prev + 1); }}>
          Kiểm tra lại
        </button>
      )}
    </section>
  );
}
