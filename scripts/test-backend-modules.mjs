import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebhookJob from "../models/WebhookJob.js";
import * as oldWebhook from "../src/webhooks/shopeeWebhookHandler.ts";
import * as webhook from "../modules/webhooks/shopeeWebhookHandler.ts";
import * as oldQueue from "../services/webhookJobQueue.js";
import * as queue from "../modules/jobs/webhookJobQueue.js";
import * as oldPdf from "../services/orderSync/labelPdfQueue.js";
import * as pdf from "../modules/logistics/pdfQueue.js";
import { verifyShopeeWebhookSignature } from "../modules/webhooks/shopeeSignature.ts";
import { parseWebhookBody } from "../modules/webhooks/payload.ts";
import { readShopeePushData, extractShopeeWebhookRawStatus } from "../modules/webhooks/pushData.ts";
import { normalizeScannedCode } from "../modules/orders/scanCode.ts";
import { isValidTrackingNo, coerceShopeeWatermarkDate } from "../modules/orders/repositoryValues.ts";
import * as oldTracking from "../src/utils/orderTracking.ts";
import * as tracking from "../modules/logistics/tracking.ts";
import * as oldHandover from "../src/utils/orderHandover.ts";
import * as handover from "../modules/logistics/handover.ts";
import * as oldScheduler from "../cron/index.js";
import * as scheduler from "../modules/shopee-sync/scheduler.js";
import { findOrderRecord, resolveOrdersFromRequest } from "../modules/orders/lookupService.js";

// Kiểm tra compatibility và singleton để import cũ/mới không tạo hai worker.
test("import cũ/mới cùng hàm và cùng trạng thái", () => {
  for (const key of Object.keys(oldWebhook)) assert.equal(oldWebhook[key], webhook[key]);
  for (const key of Object.keys(oldQueue)) assert.equal(oldQueue[key], queue[key]);
  for (const key of Object.keys(oldPdf)) assert.equal(oldPdf[key], pdf[key]);
  for (const [oldModule, newModule] of [[oldTracking, tracking], [oldHandover, handover], [oldScheduler, scheduler]]) {
    assert.deepEqual(Object.keys(oldModule), Object.keys(newModule));
    for (const key of Object.keys(oldModule)) assert.equal(oldModule[key], newModule[key]);
  }
});

test("lookup giữ fallback ID, chuẩn hóa mã và loại đơn trùng", () => {
  const orders = [{ id: "shopee-ABC-123", orderSn: "ABC-123" }, { id: "local-2", orderSn: "XYZ" }];
  assert.equal(findOrderRecord(orders, " abc123 ").order, orders[0]);
  assert.equal(findOrderRecord(orders, "SHOPEE-ABC-123").index, 0);
  assert.equal(findOrderRecord(orders, "unknown"), null);
  assert.deepEqual(resolveOrdersFromRequest(orders, ["shopee-ABC-123"], ["ABC-123", "XYZ"]).map((hit) => hit.index), [0, 1]);
});

test("payload giữ uint64, data dạng chuỗi và fallback trạng thái", () => {
  const body = Buffer.from('{"shop_id":1234567890123456789,"data":"{\\"ordersn\\":\\"ABC\\",\\"status\\":\\"ready_to_ship\\"}"}');
  const payload = parseWebhookBody(body);
  assert.equal(payload.shop_id, "1234567890123456789");
  assert.equal(webhook.webhookOrderKey(payload), "1234567890123456789:ABC");
  assert.equal(extractShopeeWebhookRawStatus(payload), "READY_TO_SHIP");
  assert.deepEqual(readShopeePushData({ data: "invalid", status: "UNPAID" }), { data: "invalid", status: "UNPAID" });
  assert.equal(parseWebhookBody("[]"), null);
  assert.equal(parseWebhookBody(""), null);
  assert.equal(normalizeScannedCode(" ab-c "), "AB-C");
  assert.equal(isValidTrackingNo("0FG123"), false);
  assert.equal(isValidTrackingNo("GHN123456"), true);
  assert.equal(coerceShopeeWatermarkDate(1700000000).getTime(), 1700000000000);
  assert.equal(coerceShopeeWatermarkDate("invalid"), null);
});

// HTTP local + Mongo giả: không gọi API sàn hoặc ghi dữ liệu thật.
test("webhook ACK trước Mongo, enqueue, lỗi queue và HMAC giữ hành vi cũ", async (t) => {
  const previous = { key: process.env.SHOPEE_PARTNER_KEY, id: process.env.SHOPEE_PARTNER_ID };
  process.env.SHOPEE_PARTNER_KEY = "local-test-key";
  process.env.SHOPEE_PARTNER_ID = "123";
  t.after(() => {
    for (const [name, value] of [["SHOPEE_PARTNER_KEY", previous.key], ["SHOPEE_PARTNER_ID", previous.id]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const rows = [];
  let releaseWrite;
  let failQueue = false;
  let overflow = 0;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  t.mock.method(WebhookJob, "create", async (row) => {
    if (failQueue) throw new Error("test_queue_failure");
    await writeGate;
    rows.push(row);
    return row;
  });
  const app = express();
  app.use("/api/shopee", webhook.createShopeeWebhookRouter(async () => {}, "/webhook", {
    onQueueOverflow: () => { overflow += 1; },
  }));
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => { releaseWrite(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/shopee/webhook`;
  assert.equal((await fetch(url)).status, 200);
  const body = JSON.stringify({ shop_id: "123", data: { ordersn: "ABC", status: "UNPAID", update_time: Math.floor(Date.now() / 1000) } });
  const signature = crypto.createHmac("sha256", "local-test-key").update(url + "|" + body).digest("hex");
  assert.equal(verifyShopeeWebhookSignature(Buffer.from(body), signature, url), true);
  assert.equal(verifyShopeeWebhookSignature(Buffer.from(body), "bad", url), false);
  const response = await fetch(url, { method: "POST", headers: { authorization: signature }, body });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "OK");
  assert.equal(rows.length, 0);
  releaseWrite();
  const waitUntil = async (condition) => {
    for (let i = 0; i < 100 && !condition(); i += 1) await delay(10);
    assert.ok(condition(), "Xử lý nền phải hoàn tất trong thời gian kiểm thử");
  };
  await waitUntil(() => rows.length === 1);
  assert.equal(rows[0].orderKey, "123:ABC");
  assert.equal(rows[0].state, "pending");
  assert.deepEqual(oldWebhook.getShopeeWebhookStats(), webhook.getShopeeWebhookStats());
  // HMAC sai vẫn tiếp tục như trước; refactor không sửa chính sách xác thực.
  await fetch(url, { method: "POST", body });
  await waitUntil(() => rows.length === 2);
  failQueue = true;
  assert.equal((await fetch(url, { method: "POST", body })).status, 200);
  await waitUntil(() => overflow === 1);
});
