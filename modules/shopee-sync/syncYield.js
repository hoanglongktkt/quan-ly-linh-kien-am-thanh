import { AsyncLocalStorage } from "node:async_hooks";
import { observeWebhookStage } from "../operations/telemetry.js";

const scope = new AsyncLocalStorage();
export const isSyncControlError = (error) => ["sync_yield_for_webhook", "sync_worker_cancelled"].includes(error?.code);
export const withYieldableSync = (control, work) => scope.run(control, work);

export function assertSyncActive() {
  const control = scope.getStore();
  if (control && !control.lifecycle.active) {
    throw Object.assign(new Error("sync_worker_cancelled"), { code: "sync_worker_cancelled" });
  }
}

// Call only between requests/batches, never while committing an order or stock.
// The current job is returned to its durable queue; no nested/parallel worker.
export async function yieldSyncIfWebhookWaiting() {
  const control = scope.getStore();
  if (!control) return;
  assertSyncActive();
  if (typeof control.hasWebhook !== "function") return;
  if (await observeWebhookStage("sync_check_webhooks", control.hasWebhook)) {
    throw Object.assign(new Error("sync_yield_for_webhook"), { code: "sync_yield_for_webhook" });
  }
}
