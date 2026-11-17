import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { initMongo, queryOrdersPageFromStore, countOrdersByTabsFromStore } from '../src/db/mongoStore';
import { editExternalOrder, deleteExternalOrder } from '../controllers/ordersController';
import { ExternalOrdersTable } from '../src/components/ExternalOrdersTable';
import { sanitizeOrders } from '../src/utils/sanitizeOrder';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'external-orders-check-'));
const created = new Date('2026-11-17T02:00:00.000Z');
const old = new Date('2026-11-16T02:00:00.000Z');
const records = [
  { _id: 'pos-id', channel: 'manual', source: 'pos', orderSn: 'POS-A1', status: 'completed',
    create_time: created, data: { date: created.toISOString(), is_quick_order: true, totalAmount: 100 } },
  { _id: 'external-id', channel: 'manual', source: 'external', orderSn: 'MANUAL-A1', status: 'pending',
    create_time: old, last_shopee_update_at: old, data: { date: old.toISOString(), cod_amount: 120,
      shippingAddress: { fullAddress: 'Old street', ward: 'Ward' }, trackingNumber: 'GHN1' } },
  { _id: 'shopee-id', channel: 'shopee', orderSn: 'SHOPEE-A1', create_time: created, data: {} },
];
const foundField = (doc, field) => field.split('.').reduce((parent, part) => parent?.[part], doc);
const matches = (doc, filter) => Object.entries(filter).every(([field, predicate]: [string, any]) => {
  if (field === '$or') return predicate.some((part) => matches(doc, part));
  if (field === '$and') return predicate.every((part) => matches(doc, part));
  const value = foundField(doc, field);
  if (predicate instanceof RegExp) return predicate.test(String(value ?? ''));
  if (predicate && typeof predicate === 'object') {
    if ('$exists' in predicate) return (value !== undefined) === predicate.$exists;
    if ('$ne' in predicate) return value !== predicate.$ne;
    if ('$gte' in predicate) return value >= predicate.$gte && value <= predicate.$lte;
  }
  return value === predicate;
});
const fake = {
  countDocuments: async () => 0,
  estimatedDocumentCount: async () => 0,
  createIndex: async () => 'index',
  indexes: async () => [],
  listIndexes: () => ({ toArray: async () => [] }),
  deleteMany: async () => ({ deletedCount: 0 }),
  findOne: async (filter) => structuredClone(records.find((doc) => matches(doc, filter)) ?? null),
  deleteOne: async (filter) => {
    const index = records.findIndex((doc) => matches(doc, filter));
    if (index >= 0) records.splice(index, 1);
    return { deletedCount: Number(index >= 0) };
  },
  findOneAndUpdate: async (filter, update) => {
    const doc = records.find((entry) => matches(entry, filter));
    if (!doc) return null;
    for (const [field, value] of Object.entries(update[0].$set)) {
      const parts = field.split('.');
      const target = parts.slice(0, -1).reduce((parent, part) => parent[part] ??= {}, doc);
      target[parts.at(-1)!] = (value as any).$literal;
    }
    return structuredClone(doc);
  },
};
const call = async (handler, id, body?) => {
  const out = { code: 200, payload: null as any };
  const response = { status: (code) => { out.code = code; return response; }, json: (payload) => { out.payload = payload; } };
  await handler({ params: { id }, body }, response);
  return out;
};

try {
  process.env.MONGODB_URI = 'mongodb://external-order-test.invalid/test';
  Object.assign(mongoose.connection, { db: { collection: () => fake } });
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, writable: true, value: 1 });
  assert.equal(await initMongo(dir), true);
  const model = mongoose.model('Order') as any;
  model.find = (filter) => {
    const docs = records.filter((doc) => matches(doc, filter));
    const cursor = {
      sort: (order) => {
        assert.deepEqual(order, { create_time: -1, _id: -1 });
        docs.sort((a, b) => Number(b.create_time) - Number(a.create_time));
        return cursor;
      },
      skip: () => cursor, limit: () => cursor, select: () => cursor, lean: () => cursor,
      maxTimeMS: () => cursor, exec: async () => structuredClone(docs),
    };
    return cursor;
  };
  model.aggregate = () => ({ option: async () => [] });
  model.countDocuments = (filter) => {
    const cursor = { maxTimeMS: () => cursor, hint: () => cursor, exec: async () => records.filter((doc) => matches(doc, filter)).length };
    return Object.assign(cursor, { then: (...args) => cursor.exec().then(...args) });
  };
  const opts = { tab: 'external_orders', startDate: '2026-11-15T00:00:00Z',
    endDate: '2026-11-17T23:59:59Z', skipCounts: true, shopId: 'shopee-shop' };
  const page = await queryOrdersPageFromStore(opts);
  assert.deepEqual(page.rows.map((order) => order.orderSn), ['POS-A1', 'MANUAL-A1']);
  assert.equal((await countOrdersByTabsFromStore(opts)).external_orders, 2);
  const orders = sanitizeOrders(page.rows);
  assert.equal(orders[0].source, 'pos');
  assert.equal(orders[0].is_quick_order, true);
  const markup = renderToStaticMarkup(<ExternalOrdersTable orders={orders} printingOrderId={null}
    onPrintWaybill={() => {}} onEditPosOrder={() => {}} onOrderEdited={() => {}} onOrderDeleted={() => {}} />);
  assert.equal(markup.match(/Sửa đơn/g)?.length, 4);
  assert.equal(markup.match(/Xóa đơn/g)?.length, 4);
  const contact = { customerName: '$Long', customerPhone: '0900000000', customerAddress: 'New street', note: 'Note' };
  assert.equal((await call(editExternalOrder, 'pos-id', contact)).code, 404);
  assert.equal((await call(editExternalOrder, 'shopee-id', contact)).code, 404);
  const edited = await call(editExternalOrder, 'external-id', contact);
  assert.equal(edited.payload.order.customerName, '$Long');
  assert.equal(edited.payload.order.shippingAddress.fullAddress, 'New street');
  assert.equal(edited.payload.order.shippingAddress.ward, 'Ward');
  assert.equal(edited.payload.order.cod_amount, 120);
  assert.equal(edited.payload.order.trackingNumber, 'GHN1');
  assert.equal((await call(deleteExternalOrder, 'shopee-id')).code, 404);
  const pos = records.find(({ _id }) => _id === 'pos-id')!;
  (pos as any).pos_pending_edit = {};
  assert.equal((await call(deleteExternalOrder, 'pos-id')).code, 409);
  delete (pos as any).pos_pending_edit;
  assert.equal((await call(deleteExternalOrder, 'pos-id')).payload.success, true);
  assert.deepEqual((await queryOrdersPageFromStore(opts)).rows.map((order) => order.orderSn), ['MANUAL-A1']);
  assert.equal((await countOrdersByTabsFromStore(opts)).external_orders, 1);
  console.log('External order list, badge, edit, delete, and desktop/mobile actions passed.');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
