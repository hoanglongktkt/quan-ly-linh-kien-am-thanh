import crypto from "node:crypto";
import { fetchWooCommerceOrders } from "./wooCommerce.js";
import { sleep } from "../utils/concurrency.js";

export const WOO_SYNC_INTERVAL_MS = 60_000;
const OVERLAP_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export function wooSyncEnabled(env = process.env) {
  return !["0", "false", "off"].includes(String(env.AUTO_WOO_ORDER_SYNC ?? "1").trim().toLowerCase());
}

export function wooSyncIntervalMs(env = process.env) {
  return boundedNumber(env.AUTO_WOO_ORDER_SYNC_MS, WOO_SYNC_INTERVAL_MS, 30_000, 10 * 60_000);
}

// Keys contain no credentials. One lock per store, shared by manual and scheduled runs.
export function wooShopSyncKey(shop) {
  const url = String(shop.wooUrl || "").trim().replace(/\/+$/, "").toLowerCase();
  return `woo-orders:${crypto.createHash("sha256").update(url).digest("hex")}`;
}

/** @param {any} deps */
export function createWooCommerceOrderSync(deps) {
  const fetchOrders = deps.fetchOrders || fetchWooCommerceOrders;
  const pause = deps.sleep || sleep;
  const now = deps.now || Date.now;
  let running = false;

  /** @param {any} [options] */
  async function run(options = {}) {
    const started = now();
    if (running) return { success: false, skipped: true, error: "woo_sync_busy", message: "WooCommerce đang đồng bộ, vui lòng đợi lượt hiện tại hoàn tất." };
    if (!deps.isMongoReady()) return { success: false, skipped: true, error: "mongodb_not_ready", message: "Cơ sở dữ liệu chưa sẵn sàng." };
    running = true;
    try {
      const target = options.shopId ? String(options.shopId).trim() : "";
      const shops = (deps.loadChannelSettings()?.shops || []).filter((s) =>
        s.platform === "woocommerce" && s.connected !== false &&
        (!target || String(s.shopId || s.id || "") === target));
      if (!shops.length) return { success: false, error: "no_woo_shops", message: "Chưa có shop WooCommerce được kết nối." };

      const incremental = options.incremental === true;
      const lookbackDays = boundedNumber(options.lookback_days ?? options.days, 7, 1, 30);
      const perPage = boundedNumber(options.per_page, 50, 10, 100);
      // Keep scheduled work bounded on low-resource hosting; resume its saved page next tick.
      const maxPages = incremental ? 5 : 100;
      const results = [];
      const errors = [];
      let totalOrdersImported = 0;
      for (const shop of shops) {
        const key = wooShopSyncKey(shop);
        const token = crypto.randomUUID();
        let claimed = false;
        let imported = 0;
        try {
          const state = await deps.state.claim(key, token, { incremental, intervalMs: wooSyncIntervalMs() });
          if (!state) {
            results.push({ shopName: shop.shopName, shopId: shop.shopId, success: true, skipped: true, imported: 0 });
            continue;
          }
          claimed = true;
          const until = new Date(Math.floor((started - 5000) / 1000) * 1000).toISOString();
          const since = new Date(state.cursorAt
            ? new Date(state.cursorAt).getTime() - OVERLAP_MS
            : started - lookbackDays * DAY_MS).toISOString();
          let window = incremental && state.pendingWindow
            ? state.pendingWindow
            : { after: incremental ? since : new Date(started - lookbackDays * DAY_MS).toISOString(), before: until, page: 1 };
          let complete = false;
          for (let count = 0; count < maxPages; count++) {
            await deps.state.renew(key, token);
            const pageResult = await fetchOrders(shop, {
              ...(incremental
                ? { modifiedAfter: window.after, modifiedBefore: window.before, orderby: "modified", order: "asc" }
                : { after: window.after, before: window.before }),
              datesAreGmt: true,
              page: window.page,
              perPage,
            });
            const orders = pageResult.orders;
            if (!Array.isArray(orders)) throw new Error("WooCommerce trả dữ liệu đơn hàng không hợp lệ.");
            await deps.state.renew(key, token);
            if (orders.length) {
              const saved = await deps.persistOrders(orders);
              if (saved !== orders.length) throw new Error(`Chưa lưu đủ đơn WooCommerce (${saved}/${orders.length}).`);
              imported += saved;
              totalOrdersImported += saved;
            }
            complete = orders.length === 0 || window.page >= pageResult.totalPages;
            window = { ...window, page: window.page + 1 };
            if (incremental) {
              await deps.state.save(key, token, complete
                ? { cursorAt: window.before, pendingWindow: null, lastSuccessAt: new Date(now()).toISOString(), lastError: null }
                : { pendingWindow: window });
            }
            if (complete) break;
            await pause(300);
          }
          if (!incremental) {
            if (!complete) throw new Error("Lượt đồng bộ vượt giới hạn 100 trang; hãy chọn khoảng ngày ngắn hơn.");
            // Manual imports must not move the incremental checkpoint past an unfinished backlog.
            await deps.state.save(key, token, { lastSuccessAt: new Date(now()).toISOString(), lastError: null });
          }
          results.push({ shopName: shop.shopName, shopId: shop.shopId, success: true, imported, pending: !complete });
          console.log(`[WooCommerce Sync] trigger=${options.trigger || "manual"} imported=${imported} pending=${!complete}`);
        } catch (err) {
          const message = err?.message || String(err);
          errors.push({ shopId: shop.shopId, shopName: shop.shopName, error: message });
          results.push({ shopId: shop.shopId, shopName: shop.shopName, success: false, imported, error: message });
          console.error("[WooCommerce Sync] Failed:", message);
          if (claimed) await deps.state.save(key, token, { lastError: message }).catch(() => {});
        } finally {
          if (claimed) await deps.state.release(key, token).catch((err) => console.error("[WooCommerce Sync] Unlock failed:", err?.message));
        }
      }
      const failed = results.filter((r) => !r.success).length;
      const skipped = results.every((r) => r.skipped);
      return {
        success: failed === 0, skipped,
        message: skipped ? "WooCommerce đang được đồng bộ hoặc chưa đến lượt kiểm tra tiếp theo."
          : failed ? `Đồng bộ WooCommerce có ${failed} shop lỗi; sẽ thử lại.`
            : `Đồng bộ WooCommerce hoàn tất: ${totalOrdersImported} đơn.`,
        totalOrdersImported, shops: results, errors,
        shopsSynced: results.filter((r) => r.success && !r.skipped).length,
        shopsFailed: failed, durationMs: now() - started,
      };
    } finally {
      running = false;
    }
  }
  return { run };
}

/** @param {any} deps */
export function scheduleWooCommerceOrderSync(deps) {
  if (!wooSyncEnabled()) {
    console.log("[WooCommerce Sync] Automatic sync OFF (AUTO_WOO_ORDER_SYNC=0).");
    return () => {};
  }
  const intervalMs = wooSyncIntervalMs();
  const tick = () => {
    void deps.run({ incremental: true, trigger: "auto" }).catch((err) =>
      console.error("[WooCommerce Sync] Automatic sync failed:", err?.message || err));
  };
  const timer = setInterval(tick, intervalMs);
  const boot = setTimeout(tick, 15_000);
  timer.unref?.();
  boot.unref?.();
  console.log(`[WooCommerce Sync] Automatic sync ON: every ${intervalMs / 1000}s, boot in 15s.`);
  return () => { clearInterval(timer); clearTimeout(boot); };
}
