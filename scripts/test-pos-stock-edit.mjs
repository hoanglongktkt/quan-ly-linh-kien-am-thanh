import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { withPosStockFileLock, commitPosStockEditFiles, recoverPosStockEditFiles } from "../utils/posStockEditFiles.js";
import { applyPosStockEdit, planPosStockEdit } from "../modules/orders/posOrderEdit.ts";
import { applyPosStockEditOnDisk, setProductsDiskAppRoot } from "../src/db/productsDiskStore.ts";

function withTempDirectory(work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pos-stock-test-"));
  return Promise.resolve().then(() => work(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("lock đang thuộc worker khác không bị xóa khi EEXIST", () => withTempDirectory((dir) => {
  const lock = path.join(dir, ".pos-stock-edit.lock");
  const owner = JSON.stringify({ pid: process.pid });
  fs.writeFileSync(lock, owner);
  assert.throws(() => withPosStockFileLock(dir, () => assert.fail("Không được vượt lock")), /busy/);
  assert.equal(fs.readFileSync(lock, "utf8"), owner);
}));

test("journal phục hồi sau khi chỉ products.json được rename", () => withTempDirectory((dir) => {
  commitPosStockEditFiles(dir, {
    "products.json": [{ id: "p", stock: 5 }],
    "pos-stock-edits.json": [["o", { revision: 1 }]],
  });
  const values = {
    "products.json": [{ id: "p", stock: 3 }],
    "pos-stock-edits.json": [["o", { revision: 2 }]],
  };
  const files = Object.entries(values).map(([target, value]) => {
    const text = JSON.stringify(value);
    const staged = `.pos-stock-${crypto.randomUUID()}-${target}.tmp`;
    fs.writeFileSync(path.join(dir, staged), text);
    return { target, staged, sha256: crypto.createHash("sha256").update(text).digest("hex") };
  });
  fs.writeFileSync(path.join(dir, ".pos-stock-edit-journal.json"), JSON.stringify({ version: 1, files }));
  // Mô phỏng tiến trình dừng giữa hai lần rename.
  fs.renameSync(path.join(dir, files[0].staged), path.join(dir, files[0].target));
  assert.equal(recoverPosStockEditFiles(dir), true);
  for (const [target, value] of Object.entries(values)) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, target), "utf8")), value);
  }
  assert.equal(recoverPosStockEditFiles(dir), false);
}));

test("chỉ trả lại tồn đã thực trừ khi số lượng đặt lớn hơn tồn", () => {
  const previous = {
    items: [{ productId: "p", quantity: 10 }],
    stock_deducted: true,
    pos_stock_allocations: { p: 3 },
  };
  const plan = planPosStockEdit(previous, [{ productId: "p", quantity: 2 }]);
  assert.deepEqual(plan.deltas, [{ id: "p", delta: -1 }]);
  const result = applyPosStockEdit([{ id: "p", stock: 0 }], plan);
  assert.equal(result.changed.get("p").stock, 1);
  assert.deepEqual(result.allocations, { p: 2 });
});

test("sửa phân loại con cập nhật tổng tồn cha và giữ trường mapping", () => {
  const plan = planPosStockEdit({ items: [{ productId: "c", quantity: 1 }], stock_deducted: true }, [{ productId: "c", quantity: 3 }]);
  const result = applyPosStockEdit([{ id: "p", stock: 8, shopeeItemId: "123", children: [{ id: "c", stock: 5 }, { id: "d", stock: 3 }] }], plan);
  const parent = result.changed.get("p");
  assert.equal(parent.stock, 6);
  assert.equal(parent.children[0].stock, 3);
  assert.equal(parent.shopeeItemId, "123");
  assert.deepEqual(result.allocations, { c: 3 });
});

test("retry cùng phiên bản không trừ tồn lần hai", () => withTempDirectory(async (dir) => {
  const data = path.join(dir, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "products.json"), JSON.stringify([{ id: "p", stock: 10 }]));
  setProductsDiskAppRoot(dir);
  const plan = planPosStockEdit({ items: [{ productId: "p", quantity: 1 }], stock_deducted: true }, [{ productId: "p", quantity: 3 }]);
  const first = await applyPosStockEditOnDisk("o", 1, plan);
  const second = await applyPosStockEditOnDisk("o", 1, plan);
  assert.deepEqual(second, JSON.parse(JSON.stringify(first)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, "products.json"), "utf8"))[0].stock, 8);
  assert.deepEqual(second.allocations, { p: 3 });
}));
