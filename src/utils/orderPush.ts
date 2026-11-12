import { getApiBaseUrl } from './apiClient';

export class OrderPushError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function orderPushRequest<T>(path: string, init: RequestInit = {}, token = localStorage.getItem('admin_token')) {
  if (!token) throw new OrderPushError(401, 'Vui lòng đăng nhập để sử dụng thông báo.');
  const response = await fetch(getApiBaseUrl() + '/api/order-push' + path, {
    ...init,
    cache: 'no-store',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const messages: Record<string, string> = {
      order_push_admin_required: 'Tính năng này dành cho tài khoản quản trị chính.',
      order_push_device_expired: 'Đăng ký thông báo đã hết hạn. Hãy bật lại thông báo.',
      order_push_device_missing: 'Thiết bị chưa được đăng ký. Hãy bật lại thông báo.',
      order_push_invalid_subscription: 'Thiết bị không dùng dịch vụ Web Push được hỗ trợ.',
      order_push_test_rate: 'Vui lòng đợi 10 giây trước khi gửi lại.',
      order_push_send_failed: 'Dịch vụ push từ chối thông báo thử. Hãy thử lại.',
      order_push_order_missing: 'Không còn tìm thấy đơn này trong hệ thống.',
    };
    throw new OrderPushError(response.status,
      messages[data?.error] || 'Không kết nối được chức năng thông báo. Vui lòng thử lại.');
  }
  return data as T;
}

export function decodeVapidPublicKey(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
}

export async function removeOrderPushSubscription(subscription: PushSubscription, token?: string | null) {
  const result = await Promise.allSettled([
    subscription.unsubscribe(),
    orderPushRequest('/subscription', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
      signal: AbortSignal.timeout(5000),
      keepalive: true,
    }, token),
  ]);
  if (result[0].status === 'rejected' && result[1].status === 'rejected') throw result[0].reason;
}

export async function disableOrderPushOnLogout(token: string | null) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration?.pushManager) return;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await removeOrderPushSubscription(subscription, token);
}
