import { createHash, randomUUID } from 'node:crypto';
import { generateVapidKeys, sendWebPush, validatePushEndpoint, validatePushSubscription } from './webPushTransport.js';

const MAX_ORDER_AGE_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 2 * 60_000;
const ORDER_PUSH_POLL_MS = 5000;
const ORDER_PUSH_LEASE_MS = 45_000;
const DEVICES_PER_CLAIM = 4;
const QUEUE_INDEX = 'order_push_due';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const enabled = () => process.env.ORDER_PUSH_ENABLED !== '0';
const adminName = () => process.env.ADMIN_USERNAME || 'admin';

export function orderPushSourceDate(value) {
  if (value == null || value === '' || value === 0) return undefined;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const unix = Number(value);
    value = unix < 1e12 ? unix * 1000 : unix;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function orderPushWriteFields(order, now = Date.now()) {
  if (!enabled() || !order.orderSn || !['shopee', 'woocommerce'].includes(order.channel)) return {};
  const sourceDate = orderPushSourceDate(order._orderPushCreatedAt);
  if (sourceDate && (now - sourceDate.getTime() > MAX_ORDER_AGE_MS || sourceDate.getTime() - now > CLOCK_SKEW_MS)) {
    return {};
  }
  // A thin Shopee webhook may create the row before get_order_detail supplies create_time.
  // Record the pending event on insert, then wait for a verified creation time before sending.
  if (!sourceDate && (order.channel !== 'shopee' || !order._orderPushAwaitCreation)) return {};
  return {
    sourceDate,
    pending: { dueAt: new Date(now), queuedAt: new Date(now) },
  };
}

function deviceKey(endpoint) {
  const url = validatePushEndpoint(endpoint);
  return url ? hash(url.href) : null;
}

function devices(db) {
  return db.collection('order_push_devices');
}

async function getVapid(db) {
  const config = db.collection('order_push_config');
  const query = { _id: 'vapid' };
  const saved = await config.findOne(query);
  if (saved) return saved;
  const keys = generateVapidKeys();
  try {
    await config.insertOne({ ...query, ...keys });
    return keys;
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const winner = await config.findOne(query);
    if (!winner) throw err;
    return winner;
  }
}

export function mountOrderPushRoutes(app, { auth, getDb, loadOrder, subject, send = sendWebPush }) {
  const handle = (handler) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const username = req.user?.username;
    if (req.user?.role !== 'admin' || username !== adminName()) {
      return res.status(403).json({ error: 'order_push_admin_required' });
    }
    const db = getDb();
    if (!db) return res.status(503).json({ error: 'order_push_database_unavailable' });
    try {
      return await handler(req, res, db, username);
    } catch (err) {
      console.error('[Order Push] API error', err?.code || err?.name || 'unknown');
      return res.status(503).json({ error: 'order_push_unavailable' });
    }
  };
  const path = '/api/order-push';

  app.get(path + '/config', auth, handle(async (_req, res, db) => {
    if (!enabled()) return res.json({ enabled: false });
    const { publicKey } = await getVapid(db);
    return res.json({ enabled: true, publicKey });
  }));

  app.post(path + '/status', auth, handle(async (req, res, db, username) => {
    const id = deviceKey(req.body?.endpoint);
    if (!id) return res.status(400).json({ error: 'order_push_invalid_endpoint' });
    const device = await devices(db).findOne({ _id: id, username }, { projection: { _id: 1 } });
    return res.json({ subscribed: Boolean(device) });
  }));

  app.put(path + '/subscription', auth, handle(async (req, res, db, username) => {
    if (!enabled()) return res.status(503).json({ error: 'order_push_disabled' });
    const subscription = validatePushSubscription(req.body?.subscription);
    if (!subscription) return res.status(400).json({ error: 'order_push_invalid_subscription' });
    const id = deviceKey(subscription.endpoint);
    const collection = devices(db);
    const existing = await collection.findOne({ _id: id });
    if (existing?.username === username
        && existing.subscription.keys.p256dh === subscription.keys.p256dh
        && existing.subscription.keys.auth === subscription.keys.auth) return res.json({ subscribed: true });
    const registration = { _id: id, username, subscription, registrationId: randomUUID(), enabledAt: new Date() };
    try {
      await collection.replaceOne({ _id: id }, registration, { upsert: true });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      await collection.replaceOne({ _id: id }, registration);
    }
    return res.json({ subscribed: true });
  }));

  app.delete(path + '/subscription', auth, handle(async (req, res, db, username) => {
    const id = deviceKey(req.body?.endpoint);
    if (!id) return res.status(400).json({ error: 'order_push_invalid_endpoint' });
    await devices(db).deleteOne({ _id: id, username });
    return res.json({ subscribed: false });
  }));

  app.post(path + '/test', auth, handle(async (req, res, db, username) => {
    if (!enabled()) return res.status(503).json({ error: 'order_push_disabled' });
    const id = deviceKey(req.body?.endpoint);
    if (!id) return res.status(400).json({ error: 'order_push_invalid_endpoint' });
    const collection = devices(db);
    const now = new Date();
    const device = await collection.findOneAndUpdate(
      { _id: id, username, $or: [{ lastTestAt: { $exists: false } }, { lastTestAt: { $lte: new Date(+now - 10_000) } }] },
      { $set: { lastTestAt: now } },
      { returnDocument: 'after' },
    );
    if (!device) {
      const subscribed = await collection.findOne({ _id: id, username }, { projection: { _id: 1 } });
      return res.status(subscribed ? 429 : 404).json({ error: subscribed ? 'order_push_test_rate' : 'order_push_device_missing' });
    }
    const status = await send(device.subscription, {
      title: 'Thông báo thử', body: 'Thiết bị này đã nhận được thông báo từ Quản lý cửa hàng.',
      path: '/?tab=settings', tag: 'order-push-test',
    }, { vapid: await getVapid(db), subject, ttl: 60, topic: 'order-push-test' });
    if (status === 404 || status === 410) {
      await collection.deleteOne({ _id: id, registrationId: device.registrationId });
      return res.status(410).json({ error: 'order_push_device_expired' });
    }
    if (status < 200 || status >= 300) {
      console.warn('[Order Push] Test rejected', status);
      return res.status(502).json({ error: 'order_push_send_failed' });
    }
    return res.json({ sent: true });
  }));

  app.get(path + '/orders/:id', auth, handle(async (req, res) => {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) return res.status(400).json({ error: 'order_push_invalid_order' });
    const order = await loadOrder(id);
    return order ? res.json({ order }) : res.status(404).json({ error: 'order_push_order_missing' });
  }));
}

export async function dispatchNextOrderPush(db, { subject, send = sendWebPush, now = Date.now }) {
  const orders = db.collection('orders');
  const lease = randomUUID();
  const started = now();
  const job = await orders.findOneAndUpdate(
    { 'orderPush.dueAt': { $lte: new Date(started) } },
    { $set: { 'orderPush.dueAt': new Date(started + ORDER_PUSH_LEASE_MS), 'orderPush.lease': lease } },
    {
      sort: { 'orderPush.dueAt': 1 },
      projection: { channel: 1, orderSn: 1, orderPush: 1, orderPushSourceCreatedAt: 1, 'data.wooStatus': 1 },
      returnDocument: 'after',
      hint: QUEUE_INDEX,
    },
  );
  if (!job) return false;

  const owned = { _id: job._id, 'orderPush.lease': lease };
  const queuedAt = +job.orderPush.queuedAt;
  const createdAt = job.orderPushSourceCreatedAt ? +job.orderPushSourceCreatedAt : 0;
  const expiresAt = (createdAt || queuedAt) + MAX_ORDER_AGE_MS;
  const finish = () => orders.updateOne(owned, { $unset: { orderPush: 1 } });
  const retry = (ms) => orders.updateOne(owned, {
    $set: { 'orderPush.dueAt': new Date(Math.min(now() + ms, expiresAt)) },
    $unset: { 'orderPush.lease': 1 },
  });

  if (started >= expiresAt || !job.orderSn || !['shopee', 'woocommerce'].includes(job.channel)) {
    await finish();
    return true;
  }
  if (!createdAt || (job.channel === 'woocommerce' && job.data?.wooStatus === 'checkout-draft')) {
    await retry(20_000);
    return true;
  }

  const collection = devices(db);
  const delayed = Object.fromEntries(Object.entries(job.orderPush.retryAt || {}).filter(([, until]) => +until > started));
  const target = {
    username: adminName(),
    enabledAt: { $lte: new Date(Math.min(queuedAt, Math.floor(createdAt / 1000) * 1000 + 999)) },
    registrationId: { $nin: [...(job.orderPush.finishedDevices || []), ...Object.keys(delayed)] },
  };
  const recipients = await collection.find(target).limit(DEVICES_PER_CLAIM + 1).toArray();
  if (!recipients.length) {
    const next = Math.min(...Object.values(delayed).map(Number));
    if (Number.isFinite(next)) await retry(Math.max(0, next - now()));
    else await finish();
    return true;
  }
  const vapid = await getVapid(db);
  const channel = job.channel === 'woocommerce' ? 'Website' : 'Shopee';
  const url = new URLSearchParams({ tab: 'orders', ordersTab: job.channel === 'woocommerce' ? 'web_orders' : 'all', pushOrder: job._id });
  const topic = 'order-' + hash(String(job._id)).slice(0, 24);
  const payload = { title: `${channel} có đơn mới`, body: String(job.orderSn).slice(0, 128), path: '/?' + url, tag: topic };
  for (const device of recipients.slice(0, DEVICES_PER_CLAIM)) {
    const ttl = Math.min(300, Math.floor((expiresAt - now()) / 1000));
    if (ttl <= 0) break;
    const active = await collection.findOne({ _id: device._id, registrationId: device.registrationId });
    if (!active) continue;
    const status = await send(device.subscription, payload, { vapid, subject, ttl, topic }).catch(() => 0);
    if (status === 0 || status === 429 || status >= 500) {
      const next = new Date(now() + 30_000);
      delayed[device.registrationId] = next;
      const result = await orders.updateOne(owned, { $set: { ['orderPush.retryAt.' + device.registrationId]: next } });
      if (result.matchedCount === 0) return true;
      continue;
    }
    if (status === 404 || status === 410) {
      await collection.deleteOne({ _id: device._id, registrationId: device.registrationId });
    } else if (status < 200 || status >= 300) {
      console.warn('[Order Push] Notification rejected', status);
    }
    const result = await orders.updateOne(owned, { $addToSet: { 'orderPush.finishedDevices': device.registrationId } });
    if (result.matchedCount === 0) return true;
  }
  if (now() >= expiresAt - 1000) await finish();
  else if (recipients.length > DEVICES_PER_CLAIM) await retry(0);
  else if (Object.keys(delayed).length) await retry(Math.max(0, Math.min(...Object.values(delayed).map(Number)) - now()));
  else await finish();
  return true;
}

export function startOrderPushWorker({ getDb, subject }) {
  if (!enabled()) return () => {};
  let running = false;
  let indexedDb;
  const tick = async () => {
    const db = getDb();
    if (!db || running) return;
    running = true;
    try {
      if (indexedDb !== db) {
        await db.collection('orders').createIndex({ 'orderPush.dueAt': 1 }, { name: QUEUE_INDEX, sparse: true });
        indexedDb = db;
      }
      const started = Date.now();
      for (let count = 0; count < 10 && Date.now() - started < 3000; count += 1) {
        if (!(await dispatchNextOrderPush(db, { subject }))) break;
      }
    } catch (err) {
      if (err?.code === 27) indexedDb = undefined;
      console.warn('[Order Push] Worker error', err?.code || err?.name || 'unknown');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ORDER_PUSH_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
