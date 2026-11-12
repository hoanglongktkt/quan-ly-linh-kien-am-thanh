self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data?.json() || {};
  } catch {
    // Still show a visible notification if the payload cannot be read.
  }
  event.waitUntil(self.registration.showNotification(message.title || 'Quản lý cửa hàng', {
    body: message.body || 'Có cập nhật đơn hàng.',
    icon: '/pwa-icon-192.png',
    tag: message.tag || 'order-push',
    data: { path: message.path },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const fallback = new URL('/?tab=orders', self.location.origin);
    let target = fallback;
    try {
      const link = new URL(event.notification.data?.path || '', fallback);
      if (link.origin === fallback.origin && link.pathname === '/') target = link;
    } catch {
      // Use the orders page if the target is invalid.
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const exact = windows.find((client) => client.url === target.href);
    if (exact) {
      await exact.focus();
      return;
    }
    const app = windows.find((client) => new URL(client.url).origin === target.origin);
    if (app) {
      // Reuse the installed app window if the OS already has it open.
      const opened = await app.navigate(target.href).catch(() => null);
      if (opened) {
        await opened.focus();
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
