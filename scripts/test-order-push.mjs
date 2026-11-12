import assert from 'node:assert/strict';
import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import express from 'express';
import { dispatchNextOrderPush, mountOrderPushRoutes, orderPushWriteFields } from '../services/orderPush.js';
import {
  encryptPushPayload, generateVapidKeys, makeVapidAuthorization, sendWebPush, validatePushSubscription,
} from '../services/webPushTransport.js';

const bytes = (str) => Buffer.from(str, 'base64url');

test('Web Push encryption matches the RFC 8291 example byte for byte', () => {
  const sender = createECDH('prime256v1');
  sender.setPrivateKey(bytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  const keys = {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  };
  const expected = 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml'
    + 'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT'
    + 'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  const actual = encryptPushPayload('When I grow up, I want to be a watermelon', keys, {
    sender, salt: bytes('DGv6ra1nlYgDCS1FRnbzlw'),
  });
  assert.equal(actual.toString('base64url'), expected);
});

test('VAPID signs the endpoint origin and restricts outbound requests to supported HTTPS services', async () => {
  const vapid = generateVapidKeys();
  const subject = 'https://quanly.example.com';
  const endpoint = 'https://fcm.googleapis.com/fcm/send/example';
  const audience = new URL(endpoint).origin;
  const time = 1_700_000_000_000;
  const header = makeVapidAuthorization(vapid, audience, subject, time);
  const [, token, publicKey] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  const [algorithm, claims, signature] = token.split('.');
  assert.equal(publicKey, vapid.publicKey);
  assert.deepEqual(JSON.parse(bytes(claims)), { aud: audience, exp: time / 1000 + 7200, sub: subject });
  const point = bytes(publicKey);
  const key = createPublicKey({ format: 'jwk', key: {
    kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url'),
  } });
  assert.ok(verify('sha256', Buffer.from(algorithm + '.' + claims), { key, dsaEncoding: 'ieee-p1363' }, bytes(signature)));
  const subscription = {
    endpoint, keys: { p256dh: generateVapidKeys().publicKey, auth: randomBytes(16).toString('base64url') },
  };
  assert.ok(validatePushSubscription(subscription));
  assert.equal(validatePushSubscription({ ...subscription, endpoint: 'https://fcm.googleapis.com@127.0.0.1/' }), null);
  assert.equal(validatePushSubscription({ ...subscription, endpoint: 'https://fcm.googleapis.com:444/' }), null);
  assert.ok(validatePushSubscription({ ...subscription, endpoint: 'https://web.push.apple.com/Q-test' }));
  const status = await sendWebPush(subscription, { title: 'Báo đơn' }, {
    vapid, subject, ttl: 60, topic: 'unique-order',
    request: async (url, options) => {
      assert.equal(url.href, endpoint);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['Content-Encoding'], 'aes128gcm');
      assert.equal(options.headers.TTL, '60');
      assert.match(options.headers.Topic, /^[\w-]{32}$/);
      assert.ok(Buffer.isBuffer(options.body));
      return { status: 201 };
    },
  });
  assert.equal(status, 201);
});

test('only fresh Shopee and WooCommerce orders are eligible, including thin Shopee webhooks awaiting details', () => {
  const now = 1_700_000_000_000;
  const fields = (channel, time, wait = false) => orderPushWriteFields({
    channel, orderSn: '1234', _orderPushCreatedAt: time, _orderPushAwaitCreation: wait,
  }, now);
  assert.ok(fields('shopee', now / 1000 - 20).pending);
  assert.ok(fields('woocommerce', new Date(now - 100)).pending);
  assert.deepEqual(fields('woocommerce', new Date(now - 16 * 60_000)), {});
  assert.deepEqual(fields('manual', now), {});
  assert.deepEqual(fields('woocommerce', undefined), {});
  assert.deepEqual(fields('shopee', undefined), {});
  assert.deepEqual(fields('shopee', undefined, true), {
    pending: { dueAt: new Date(now), queuedAt: new Date(now) },
    sourceDate: undefined,
  });
});

test('a retry keeps the successful device receipt and delivers to the failed device later', async () => {
  let clock = Date.now();
  let job = {
    _id: 'woo-123', orderSn: 'WOO-123', channel: 'woocommerce',
    orderPushSourceCreatedAt: new Date(clock - 5000),
    orderPush: { queuedAt: new Date(clock), dueAt: new Date(clock) },
  };
  const registered = [
    { _id: 'first', registrationId: 'r1', enabledAt: new Date(clock - 10_000), subscription: { endpoint: 'first' } },
    { _id: 'second', registrationId: 'r2', enabledAt: new Date(clock - 10_000), subscription: { endpoint: 'second' } },
    { _id: 'late', registrationId: 'r3', enabledAt: new Date(clock + 1000), subscription: { endpoint: 'late' } },
  ];
  const tables = {
    orders: {
      async findOneAndUpdate(filter, update) {
        if (!job || job.orderPush.dueAt > filter['orderPush.dueAt'].$lte) return null;
        job.orderPush.dueAt = update.$set['orderPush.dueAt'];
        job.orderPush.lease = update.$set['orderPush.lease'];
        return structuredClone(job);
      },
      async updateOne(filter, update) {
        assert.equal(filter['orderPush.lease'], job.orderPush.lease);
        if (update.$unset?.orderPush) job = null;
        if (update.$set?.['orderPush.dueAt']) job.orderPush.dueAt = update.$set['orderPush.dueAt'];
        if (update.$addToSet) (job.orderPush.finishedDevices ||= []).push(update.$addToSet['orderPush.finishedDevices']);
        for (const [name, value] of Object.entries(update.$set || {})) {
          if (name.startsWith('orderPush.retryAt.')) (job.orderPush.retryAt ||= {})[name.split('.')[2]] = value;
        }
        return { matchedCount: 1 };
      },
    },
    order_push_devices: {
      find: (filter) => ({
        limit: (max) => ({
          toArray: async () => registered.filter((device) => device.enabledAt <= filter.enabledAt.$lte
            && !filter.registrationId.$nin.includes(device.registrationId)).slice(0, max),
        }),
      }),
      findOne: async (filter) => registered.find((device) => device._id === filter._id),
    },
    order_push_config: { findOne: async () => generateVapidKeys() },
  };
  const db = { collection: (name) => tables[name] };
  const attempts = [];
  const options = {
    subject: 'https://quanly.example.com',
    now: () => clock,
    send: async (subscription, payload) => {
      assert.equal(payload.path, '/?tab=orders&ordersTab=web_orders&pushOrder=woo-123');
      attempts.push(subscription.endpoint);
      return attempts.length === 1 ? 503 : 201;
    },
  };
  assert.equal(await dispatchNextOrderPush(db, options), true);
  assert.deepEqual(attempts, ['first', 'second']);
  assert.equal(await dispatchNextOrderPush(db, options), false);
  clock += 30_000;
  assert.equal(await dispatchNextOrderPush(db, options), true);
  assert.equal(job, null);
  assert.deepEqual(attempts, ['first', 'second', 'first']);
});

test('only the primary admin can enroll a device, send a test and remove the subscription', async (t) => {
  const rows = new Map();
  const vapid = generateVapidKeys();
  const deliveries = [];
  const storage = {
    findOne: async ({ _id }) => rows.get(_id),
    replaceOne: async ({ _id }, device) => rows.set(_id, device),
    deleteOne: async ({ _id }) => rows.delete(_id),
    findOneAndUpdate: async ({ _id }, { $set }) => {
      const row = rows.get(_id);
      if (!row || row.lastTestAt) return null;
      Object.assign(row, $set);
      return row;
    },
  };
  const app = express();
  app.use(express.json());
  mountOrderPushRoutes(app, {
    auth(req, _res, next) {
      req.user = {
        role: req.get('Authorization') === 'Bearer preview' ? 'admin' : 'employee',
        username: process.env.ADMIN_USERNAME || 'admin',
      };
      next();
    },
    getDb: () => ({ collection: (name) => name === 'order_push_config' ? { findOne: async () => vapid } : storage }),
    subject: 'https://quanly.example.com',
    loadOrder: async (id) => ({ id }),
    send: async (subscription, payload) => { deliveries.push({ subscription, payload }); return 201; },
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  const origin = 'http://127.0.0.1:' + server.address().port + '/api/order-push';
  const request = (path, method, body, token = 'preview') => fetch(origin + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert.equal((await request('/config', 'GET', undefined, 'employee')).status, 403);
  const config = await (await request('/config', 'GET')).json();
  assert.deepEqual(config, { enabled: true, publicKey: vapid.publicKey });
  const endpoint = 'https://fcm.googleapis.com/fcm/send/fixture';
  const subscription = { endpoint, keys: { p256dh: generateVapidKeys().publicKey, auth: randomBytes(16).toString('base64url') } };
  assert.equal((await request('/subscription', 'PUT', { subscription })).status, 200);
  assert.deepEqual(await (await request('/status', 'POST', { endpoint })).json(), { subscribed: true });
  assert.equal((await request('/test', 'POST', { endpoint })).status, 200);
  assert.equal(deliveries[0].subscription.endpoint, endpoint);
  assert.equal((await request('/test', 'POST', { endpoint })).status, 429);
  assert.deepEqual(await (await request('/orders/woo-123', 'GET')).json(), { order: { id: 'woo-123' } });
  assert.equal((await request('/subscription', 'DELETE', { endpoint })).status, 200);
  assert.deepEqual(await (await request('/status', 'POST', { endpoint })).json(), { subscribed: false });
});

test('service worker displays the order and opens its exact management link', async () => {
  const handlers = new Map();
  const notifications = [];
  const windows = [];
  const self = {
    addEventListener: (name, fn) => handlers.set(name, fn),
    location: { origin: 'https://quanly.example.com' },
    registration: { showNotification: async (...args) => notifications.push(args) },
    clients: { matchAll: async () => [], openWindow: async (url) => windows.push(url) },
  };
  vm.runInNewContext(await readFile(new URL('../public/order-push-sw.js', import.meta.url), 'utf8'), { self, URL });
  let pending;
  const waitUntil = (promise) => { pending = promise; };
  const path = '/?tab=orders&ordersTab=all&pushOrder=shopee-123';
  handlers.get('push')({ waitUntil, data: { json: () => ({ title: 'Shopee có đơn mới', body: '123', path }) } });
  await pending;
  assert.equal(notifications[0][0], 'Shopee có đơn mới');
  assert.equal(notifications[0][1].data.path, path);
  handlers.get('notificationclick')({ waitUntil, notification: { data: notifications[0][1].data, close() {} } });
  await pending;
  assert.equal(windows[0], self.location.origin + path);
  handlers.get('notificationclick')({ waitUntil, notification: { data: { path: 'https://elsewhere.example/' }, close() {} } });
  await pending;
  assert.equal(windows[1], self.location.origin + '/?tab=orders');
});
