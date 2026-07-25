/**
 * Pure helpers for Shopee v2.order.get_order_list pagination.
 * Kept free of I/O so unit tests can prove cursor loops cannot spin forever.
 */

export type ShopeeOrderListPagination = {
  more: boolean;
  nextCursor: string;
};

export type AdvanceCursorResult =
  | { action: "continue"; nextCursor: string; reason: string }
  | { action: "break"; nextCursor: null; reason: string };

export function parseShopeeOrderListPagination(result: unknown): ShopeeOrderListPagination {
  const root = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const body = (
    root.response && typeof root.response === "object" ? root.response : root
  ) as Record<string, unknown>;
  const nextCursor = String(body.next_cursor ?? "").trim();
  const more = body.more === true || body.more === 1 || body.more === "true";
  return { more, nextCursor };
}

export function extractShopeeOrderListRows(result: unknown): unknown[] {
  const root = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const body = (
    root.response && typeof root.response === "object" ? root.response : root
  ) as Record<string, unknown>;
  const rows = body.order_list ?? root.order_list;
  return Array.isArray(rows) ? rows : [];
}

/**
 * Quyết định có tiếp tục phân trang hay BREAK.
 * CẤM tiếp tục khi: more=false, list rỗng, next_cursor rỗng/không đổi, hoặc cursor đã thấy (vòng lặp).
 */
export function advanceShopeeOrderListCursor(opts: {
  listResult: unknown;
  currentCursor: string | undefined;
  seenCursors: Set<string>;
  pageIndex: number;
  hardCap: number;
  logLabel?: string;
}): AdvanceCursorResult {
  const label = opts.logLabel || "get_order_list";
  const rows = extractShopeeOrderListRows(opts.listResult);
  const { more, nextCursor } = parseShopeeOrderListPagination(opts.listResult);
  const prev = String(opts.currentCursor ?? "").trim();

  if (opts.pageIndex >= opts.hardCap) {
    return {
      action: "break",
      nextCursor: null,
      reason: `${label}: hardCap=${opts.hardCap} reached`,
    };
  }

  if (!more) {
    return { action: "break", nextCursor: null, reason: `${label}: more=false` };
  }

  if (rows.length === 0) {
    return {
      action: "break",
      nextCursor: null,
      reason: `${label}: more=true but order_list empty (Shopee quirk)`,
    };
  }

  if (!nextCursor) {
    return {
      action: "break",
      nextCursor: null,
      reason: `${label}: more=true but next_cursor empty`,
    };
  }

  if (nextCursor === prev) {
    return {
      action: "break",
      nextCursor: null,
      reason: `${label}: next_cursor unchanged ("${nextCursor.slice(0, 32)}")`,
    };
  }

  if (opts.seenCursors.has(nextCursor)) {
    return {
      action: "break",
      nextCursor: null,
      reason: `${label}: cursor cycle detected ("${nextCursor.slice(0, 32)}")`,
    };
  }

  return {
    action: "continue",
    nextCursor,
    reason: `${label}: advance cursor → ${nextCursor.slice(0, 48)}`,
  };
}

/** Ước lượng số vòng lặp tối đa an toàn (dùng trong test + runtime guard). */
export function maxSafeOrderListPages(hardCap: number): number {
  return Math.max(1, Math.floor(hardCap));
}
