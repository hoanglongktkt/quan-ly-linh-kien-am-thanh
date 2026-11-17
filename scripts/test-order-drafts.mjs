import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import mongoose from 'mongoose';
import OrderDraft from '../models/OrderDraft.js';
import { normalizeDraft, listOrderDrafts, saveOrderDraft, deleteOrderDraft, withOrderDraft } from '../controllers/orderDraftsController.js';
import { draftTotals } from '../src/utils/orderDrafts.ts';

// No database connection, inventory writes or carrier calls are made by these tests.
const docs = new Map();
const clone = (v) => v == null ? v : structuredClone(v);
const readPath = (obj, path) => path.split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
const matches = (d, q) => Object.entries(q).every(([k, v]) => {
  if (k === '$or') return v.some((sub) => Object.entries(sub).some(([field, re]) => {
    const parts = field.split('.');
    const visit = (obj, keys) => Array.isArray(obj) ? obj.some((it) => visit(it, keys)) : keys.length ? visit(obj?.[keys[0]], keys.slice(1)) : re.test(String(obj ?? ''));
    return visit(d, parts);
  }));
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const actual = readPath(d, k);
    return Object.entries(v).every(([operator, expected]) => operator === '$gte' ? actual >= expected : operator === '$lt' ? actual < expected : false);
  }
  return readPath(d, k) === v;
});
function query(value) {
  let data = clone(value);
  return {
    sort(spec = {}) { if (Array.isArray(data)) data.sort((a, b) => Object.entries(spec).reduce((result, [field, direction]) => result || (readPath(a, field) < readPath(b, field) ? -direction : readPath(a, field) > readPath(b, field) ? direction : 0), 0)); return this; },
    skip(n) { data = data.slice(n); return this; },
    limit(n) { data = data.slice(0, n); return this; },
    lean: async () => clone(data),
  };
}
const fake = {
  async create(input) {
    if (docs.has(input._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    const now = new Date().toISOString();
    const doc = { ...clone(input), createdAt: input.createdAt || now, updatedAt: input.updatedAt || now };
    docs.set(doc._id, doc); return clone(doc);
  },
  find(q) { return query([...docs.values()].filter((d) => matches(d, q))); },
  async countDocuments(q) { return [...docs.values()].filter((d) => matches(d, q)).length; },
  findById(id) { return query(docs.get(id) || null); },
  findOneAndUpdate(q, update) {
    const d = [...docs.values()].find((row) => matches(row, q));
    if (d) {
      Object.assign(d, clone(update.$set || {}));
      for (const [k, n] of Object.entries(update.$inc || {})) d[k] += n;
      d.updatedAt = new Date().toISOString();
    }
    return query(d || null);
  },
  async updateOne(q, update) {
    const d = [...docs.values()].find((row) => matches(row, q));
    if (!d) return { matchedCount: 0 };
    Object.assign(d, clone(update.$set)); return { matchedCount: 1 };
  },
  async deleteOne(q) {
    const d = [...docs.values()].find((row) => matches(row, q));
    if (d) docs.delete(d._id);
    return { deletedCount: d ? 1 : 0 };
  },
};
const response = () => ({
  statusCode: 200, headersSent: false, body: null,
  status(n) { this.statusCode = n; return this; },
  json(b) { this.body = b; this.headersSent = true; return this; },
});
const input = (kind = 'pos') => ({
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', kind,
  payload: { customerName: 'Khách báo giá', customerPhone: '', customerAddress: '', walk_in: false,
    items: [{ productId: 'speaker', productTitle: 'Loa tiếng Việt', sku: 'LOA-01', quantity: 4, price: 150000, importPrice: 70000 }],
    shippingFee: 50000, prepaidAmount: 100000, orderDiscount: 20000, shippingFeePayer: 'customer', carrier: 'ghn',
    packageWeight: 1500, allowInspect: false, partialDelivery: true,
  },
  formState: { shippingAddress: { name: 'Khách báo giá', phone: '', provinceName: '', provinceCode: '', wardCode: '', street: '', addressMode: 'new2', saveToAddressBook: false } },
  storeInfo: { storeName: 'Linh Kiện Âm Thanh', storePhone: '0900000000', storeAddress: 'Biên Hòa', logoUrl: '/logo.png' },
});
let originals;
let originalReadyState;
before(() => {
  originalReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  originals = Object.fromEntries(Object.keys(fake).map((k) => [k, OrderDraft[k]]));
  Object.assign(OrderDraft, fake);
});
beforeEach(() => { docs.clear(); mongoose.connection.readyState = 1; });
after(() => { Object.assign(OrderDraft, originals); mongoose.connection.readyState = originalReadyState; });
async function create(kind = 'pos') {
  const res = response();
  await saveOrderDraft({ body: input(kind), params: {} }, res);
  assert.equal(res.statusCode, 200);
  return res.body.draft;
}

test('POS and external drafts persist incomplete customer / carrier data without invoking checkout', async () => {
  for (const kind of ['pos', 'manual']) {
    docs.clear();
    const saved = await create(kind);
    assert.equal(saved.kind, kind);
    assert.equal(saved.payload.items[0].price, 150000);
    assert.equal(saved.payload.items[0].importPrice, 70000);
    assert.equal(saved.payload.customerAddress, '');
    assert.equal(saved.payload.allowInspect, false);
    assert.equal(saved.payload.partialDelivery, true);
    assert.equal(saved.formState.shippingAddress.saveToAddressBook, false);
    assert.equal(saved.storeInfo.storeName, 'Linh Kiện Âm Thanh');
    assert.equal(saved.version, 1);
    assert.equal(docs.size, 1);
    assert.equal(saved.result, undefined);
  }
});
test('draft update requires the latest version and preserves the draft identity', async () => {
  const saved = await create();
  const edit = input(); edit.payload.items[0].price = 175000;
  const res = response();
  await saveOrderDraft({ params: { id: saved.id }, body: { ...edit, version: 1 } }, res);
  assert.equal(res.body.draft.id, saved.id);
  assert.equal(res.body.draft.version, 2);
  assert.equal(res.body.draft.payload.items[0].price, 175000);
  const stale = response();
  await saveOrderDraft({ params: { id: saved.id }, body: { ...edit, version: 1 } }, stale);
  assert.equal(stale.statusCode, 409);
  assert.equal(docs.size, 1);
});
test('lost save-response retries with the same ID do not duplicate quotations', async () => {
  await create();
  const retry = response();
  await saveOrderDraft({ params: {}, body: input() }, retry);
  assert.equal(retry.statusCode, 409);
  assert.equal(docs.size, 1);
});
test('list pagination, created-date filters and literal search exclude converted or reserved drafts', async () => {
  for (let i = 0; i < 35; i++) await fake.create({ _id: `draft-test-${String(i).padStart(3, '0')}`, state: 'draft', kind: 'manual', number: `BG-${i}`, createdAt: new Date(Date.UTC(2026, 10, 1 + i)), payload: { customerName: i === 34 ? 'A+B (VIP)' : 'Khách', items: [] } });
  await fake.create({ _id: 'converted-draft', state: 'converted' });
  await fake.create({ _id: 'locked-draft', state: 'converting' });
  const page = response();
  await listOrderDrafts({ query: { page: '2' } }, page);
  assert.equal(page.body.total, 35);
  assert.equal(page.body.drafts.length, 5);
  assert.equal(page.body.sortBy, 'createdAt');
  assert.equal(page.body.drafts[0].number, 'BG-4');
  const range = response();
  await listOrderDrafts({ query: { createdFrom: '2026-11-05', createdTo: '2026-11-05', sortBy: 'createdAt', sortOrder: 'asc' } }, range);
  assert.equal(range.statusCode, 200);
  assert.equal(range.body.total, 1);
  assert.equal(range.body.drafts[0].number, 'BG-4');
  const invalid = response();
  await listOrderDrafts({ query: { createdFrom: '2026-02-30' } }, invalid);
  assert.equal(invalid.statusCode, 400);
  const search = response();
  await listOrderDrafts({ query: { q: 'A+B (VIP)' } }, search);
  assert.equal(search.body.total, 1);
});
test('created-date boundaries include the entire Vietnam day and sorting is deterministic', async () => {
  for (const [id, createdAt, updatedAt] of [
    ['before', '2026-11-04T16:59:59.999Z', '2026-11-06T00:00:00Z'],
    ['start', '2026-11-04T17:00:00.000Z', '2026-11-07T00:00:00Z'],
    ['end', '2026-11-05T16:59:59.999Z', '2026-11-08T00:00:00Z'],
    ['after', '2026-11-05T17:00:00.000Z', '2026-11-09T00:00:00Z'],
  ]) await fake.create({ _id: id, state: 'draft', createdAt: new Date(createdAt), updatedAt: new Date(updatedAt) });
  const range = response();
  await listOrderDrafts({ query: { createdFrom: '2026-11-05', createdTo: '2026-11-05', sortOrder: 'asc' } }, range);
  assert.deepEqual(range.body.drafts.map((draft) => draft.id), ['start', 'end']);
  const updated = response();
  await listOrderDrafts({ query: { sortBy: 'updatedAt', sortOrder: 'desc' } }, updated);
  assert.deepEqual(updated.body.drafts.map((draft) => draft.id), ['after', 'end', 'start', 'before']);
  const invalidRange = response();
  await listOrderDrafts({ query: { createdFrom: '2026-11-06', createdTo: '2026-11-05' } }, invalidRange);
  assert.equal(invalidRange.statusCode, 400);
  const unsafeSort = response();
  await listOrderDrafts({ query: { sortBy: '$where' } }, unsafeSort);
  assert.equal(unsafeSort.body.sortBy, 'createdAt');
});
test('delete is version checked and cannot delete a draft while checkout is reserved', async () => {
  const draft = await create();
  const stale = response();
  await deleteOrderDraft({ params: { id: draft.id }, query: { version: '0' } }, stale);
  assert.equal(stale.statusCode, 409);
  docs.get(draft.id).state = 'converting';
  const locked = response();
  await deleteOrderDraft({ params: { id: draft.id }, query: { version: '1' } }, locked);
  assert.equal(locked.statusCode, 409);
  docs.get(draft.id).state = 'draft';
  const ok = response();
  await deleteOrderDraft({ params: { id: draft.id }, query: { version: '1' } }, ok);
  assert.equal(ok.statusCode, 200); assert.equal(docs.size, 0);
});
test('quote totals account for shipping payer, discount and prepaid independently', () => {
  const d = input();
  assert.deepEqual(draftTotals(d), { subtotal: 600000, shippingFee: 50000, discount: 20000, prepaid: 100000, total: 630000, amountDue: 530000 });
  d.kind = 'manual'; d.payload.shippingFeePayer = 'sender';
  assert.equal(draftTotals(d).total, 580000);
  assert.equal(draftTotals(d).shippingFee, 0);
});
test('invalid values and >80 products fail before persistence', () => {
  for (const value of [-1, Infinity, NaN]) {
    const body = input(); body.payload.items[0].price = value;
    assert.throws(() => normalizeDraft(body));
  }
  const body = input(); body.payload.items[0].quantity = 1.5;
  assert.throws(() => normalizeDraft(body));
  body.payload.items = Array.from({ length: 81 }, () => input().payload.items[0]);
  assert.throws(() => normalizeDraft(body));
});
test('checkout runs once, retries replay the same saved order without stock/carrier effects', async () => {
  for (const kind of ['pos', 'manual']) {
    docs.clear();
    const draft = await create(kind);
    let checkoutCalls = 0;
    const checkout = withOrderDraft(async (_req, res) => { checkoutCalls++; res.json({ success: true, order: { id: 'sale-1', orderSn: 'ORDER-1' }, trackingNumber: 'TRACK-1' }); }, kind, fake);
    const req = { body: { draftId: draft.id, draftVersion: 1 } };
    const first = response(); await checkout(req, first);
    assert.equal(first.body.order.id, 'sale-1');
    const retry = response(); await checkout(req, retry);
    assert.equal(retry.body.draftReplay, true);
    assert.equal(retry.body.trackingNumber, 'TRACK-1');
    assert.equal(checkoutCalls, 1);
    const list = response(); await listOrderDrafts({ query: {} }, list);
    assert.equal(list.body.total, 0);
  }
});
test('parallel checkout and stale versions cannot produce a second order', async () => {
  const draft = await create();
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const checkout = withOrderDraft(async (_req, res) => { calls++; await wait; res.json({ success: true, order: { id: 'sale-1' } }); }, 'pos', fake);
  const stale = response(); await checkout({ body: { draftId: draft.id, draftVersion: 0 } }, stale);
  assert.equal(stale.statusCode, 409); assert.equal(calls, 0);
  const first = response();
  const pending = checkout({ body: { draftId: draft.id, draftVersion: 1 } }, first);
  await new Promise((resolve) => setImmediate(resolve));
  const second = response(); await checkout({ body: { draftId: draft.id, draftVersion: 1 } }, second);
  assert.equal(second.statusCode, 409);
  release(); await pending;
  assert.equal(calls, 1);
});
test('validation rejection releases the draft, uncertain server failures preserve the reservation', async () => {
  const draft = await create();
  const bad = withOrderDraft(async (_req, res) => res.status(400).json({ success: false, error: 'address required' }), 'pos', fake);
  await bad({ body: { draftId: draft.id, draftVersion: 1 } }, response());
  assert.equal(docs.get(draft.id).state, 'draft');
  const fail = withOrderDraft(async (_req, res) => res.status(500).json({ success: false }), 'pos', fake);
  await fail({ body: { draftId: draft.id, draftVersion: 1 } }, response());
  assert.equal(docs.get(draft.id).state, 'converting');
});
test('disconnected database reports failure instead of falsely confirming a draft save', async () => {
  mongoose.connection.readyState = 0;
  const res = response();
  await saveOrderDraft({ params: {}, body: input() }, res);
  assert.equal(res.statusCode, 503); assert.equal(docs.size, 0);
});
