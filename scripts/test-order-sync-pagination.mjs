#!/usr/bin/env node
/**
 * Diagnostic test: chứng minh pagination GetOrderList KHÔNG quay vòng vô hạn,
 * và cursor stall / cycle đều BREAK.
 *
 * Chạy: node scripts/test-order-sync-pagination.mjs
 *      npm run test:order-sync
 */
import assert from "node:assert/strict";
import {
  advanceShopeeOrderListCursor,
  extractShopeeOrderListRows,
  maxSafeOrderListPages,
  parseShopeeOrderListPagination,
} from "../src/utils/shopeeOrderListPagination.ts";

function ts() {
  return new Date().toISOString();
}

function log(step, detail) {
  console.log(`[${ts()}] [TEST] ${step}${detail != null ? `: ${detail}` : ""}`);
}

function makePage({ more, nextCursor, sns }) {
  return {
    response: {
      more,
      next_cursor: nextCursor,
      order_list: (sns || []).map((order_sn) => ({ order_sn })),
    },
  };
}

async function simulatePaginationLoop(pages, hardCap = 10) {
  const seenCursors = new Set();
  const orderSnSet = new Set();
  let cursor;
  let page = 0;
  const visited = [];

  log("Fetching order list...", `hardCap=${hardCap}, pagesPrepared=${pages.length}`);

  while (page < hardCap) {
    page += 1;
    const listResult = pages[page - 1] || makePage({ more: false, nextCursor: "", sns: [] });
    const rows = extractShopeeOrderListRows(listResult);
    for (const row of rows) {
      const sn = String(row?.order_sn || "").trim();
      if (sn) orderSnSet.add(sn);
    }
    log("Order list received", `${rows.length} orders (page=${page}, totalSn=${orderSnSet.size})`);
    visited.push({ page, cursor: cursor || "", rows: rows.length });

    const adv = advanceShopeeOrderListCursor({
      listResult,
      currentCursor: cursor,
      seenCursors,
      pageIndex: page,
      hardCap,
      logLabel: "test-loop",
    });
    log("Cursor decision", `${adv.action} — ${adv.reason}`);
    if (adv.action === "break") break;
    seenCursors.add(adv.nextCursor);
    cursor = adv.nextCursor;
  }

  log("Pagination finished", `pagesVisited=${visited.length}, uniqueSn=${orderSnSet.size}`);
  return { visited, orderSnSet, page };
}

async function main() {
  let failed = 0;

  // 1) Parse helpers
  try {
    log("CASE 1", "parse pagination");
    const p = parseShopeeOrderListPagination({
      response: { more: true, next_cursor: "abc", order_list: [{ order_sn: "A" }] },
    });
    assert.equal(p.more, true);
    assert.equal(p.nextCursor, "abc");
    assert.equal(extractShopeeOrderListRows({ response: { order_list: [1, 2] } }).length, 2);
    log("CASE 1 PASS", "ok");
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 1 FAIL`, e);
  }

  // 2) Normal multi-page then stop
  try {
    log("CASE 2", "normal 3-page pagination then more=false");
    const pages = [
      makePage({ more: true, nextCursor: "c1", sns: ["O1", "O2"] }),
      makePage({ more: true, nextCursor: "c2", sns: ["O3"] }),
      makePage({ more: false, nextCursor: "", sns: ["O4"] }),
    ];
    const { visited, orderSnSet } = await simulatePaginationLoop(pages, 10);
    assert.equal(visited.length, 3, "should visit exactly 3 pages");
    assert.equal(orderSnSet.size, 4);
    log("CASE 2 PASS", `visited=${visited.length}`);
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 2 FAIL`, e);
  }

  // 3) Infinite same-cursor attack — MUST break
  try {
    log("CASE 3", "stuck next_cursor (same page forever)");
    const stuck = makePage({ more: true, nextCursor: "SAME", sns: ["X1"] });
    const pages = Array.from({ length: 50 }, () => stuck);
    const { visited } = await simulatePaginationLoop(pages, 10);
    assert.ok(visited.length <= 2, `must break early, got ${visited.length}`);
    log("CASE 3 PASS", `broke after ${visited.length} page(s) — no infinite loop`);
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 3 FAIL`, e);
  }

  // 4) Cursor cycle A→B→A — MUST break
  try {
    log("CASE 4", "cursor cycle A→B→A");
    const pages = [
      makePage({ more: true, nextCursor: "A", sns: ["1"] }),
      makePage({ more: true, nextCursor: "B", sns: ["2"] }),
      makePage({ more: true, nextCursor: "A", sns: ["3"] }), // cycle
      makePage({ more: true, nextCursor: "C", sns: ["4"] }),
    ];
    const { visited, orderSnSet } = await simulatePaginationLoop(pages, 10);
    assert.ok(visited.length <= 3, `cycle must break ≤3 pages, got ${visited.length}`);
    assert.ok(orderSnSet.size <= 3);
    log("CASE 4 PASS", `broke at page ${visited.length}`);
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 4 FAIL`, e);
  }

  // 5) more=true + empty list — MUST break
  try {
    log("CASE 5", "more=true with empty order_list");
    const pages = [makePage({ more: true, nextCursor: "z", sns: [] })];
    const { visited } = await simulatePaginationLoop(pages, 10);
    assert.equal(visited.length, 1);
    log("CASE 5 PASS", "broke on empty list");
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 5 FAIL`, e);
  }

  // 6) Hard cap ceiling
  try {
    log("CASE 6", "hard cap prevents runaway");
    assert.equal(maxSafeOrderListPages(10), 10);
    const pages = Array.from({ length: 30 }, (_, i) =>
      makePage({ more: true, nextCursor: `c${i + 1}`, sns: [`S${i}`] }),
    );
    const { visited } = await simulatePaginationLoop(pages, 5);
    assert.equal(visited.length, 5);
    log("CASE 6 PASS", "hardCap=5 enforced");
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 6 FAIL`, e);
  }

  // 7) Simulate sync pipeline stages (timing logs only — no network)
  try {
    log("CASE 7", "pipeline stage timestamps (mock)");
    const t0 = Date.now();
    log("Fetching order list...", "shop=TEST");
    await new Promise((r) => setTimeout(r, 5));
    log("Order list received", "6 orders");
    log("Fetching details for chunk...", "chunk=1 sns=6");
    await new Promise((r) => setTimeout(r, 5));
    log("Saving to MongoDB...", "upsert 6 docs");
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 2000, "mock pipeline must finish quickly");
    log("CASE 7 PASS", `elapsed=${elapsed}ms`);
  } catch (e) {
    failed += 1;
    console.error(`[${ts()}] CASE 7 FAIL`, e);
  }

  console.log("\n========================================");
  if (failed > 0) {
    console.error(`[${ts()}] RESULT: FAIL (${failed} case(s))`);
    process.exit(1);
  }
  console.log(`[${ts()}] RESULT: ALL PASS — pagination cannot infinite-loop`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[${ts()}] FATAL`, err);
  process.exit(1);
});
