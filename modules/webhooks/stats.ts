// Thống kê dùng chung giữa health và webhook.
/** Mốc push cuối cùng — /api/health dùng để biết webhook còn sống hay đã chết. */
let lastWebhookAt = 0;

export function markWebhookReceived(): void {
  lastWebhookAt = Date.now();
}

export function getShopeeWebhookStats(): {
  pid: number;
  lastWebhookAt: string | null;
} {
  return {
    pid: process.pid,
    lastWebhookAt: lastWebhookAt ? new Date(lastWebhookAt).toISOString() : null,
  };
}
