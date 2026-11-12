import {
  createCipheriv, createECDH, createHash, createPrivateKey, ECDH,
  hkdfSync, randomBytes, sign,
} from 'node:crypto';

const base64url = (value) => Buffer.from(value).toString('base64url');
const decode = (value) => Buffer.from(value, 'base64url');
const vapidHeaders = new Map();

export function generateVapidKeys() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  const scalar = key.getPrivateKey();
  return {
    publicKey: base64url(key.getPublicKey()),
    privateKey: base64url(Buffer.concat([Buffer.alloc(32 - scalar.length), scalar])),
  };
}

export function validatePushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const supported = url.hostname === 'fcm.googleapis.com'
      || url.hostname === 'updates.push.services.mozilla.com'
      || url.hostname.endsWith('.push.apple.com');
    if (!supported || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

export function validatePushSubscription(value) {
  const endpoint = validatePushEndpoint(value?.endpoint);
  const { p256dh, auth } = value?.keys || {};
  if (!endpoint || typeof p256dh !== 'string' || typeof auth !== 'string'
      || !/^[\w-]{87}$/.test(p256dh) || !/^[\w-]{22}$/.test(auth)) return null;
  try {
    const key = decode(p256dh);
    if (key[0] !== 4 || key.length !== 65 || decode(auth).length !== 16) return null;
    ECDH.convertKey(key, 'prime256v1');
    return { endpoint: endpoint.href, keys: { p256dh, auth } };
  } catch {
    return null;
  }
}

// RFC 8291 / RFC 8188, one final aes128gcm record per notification.
export function encryptPushPayload(payload, keys, {
  salt = randomBytes(16),
  sender,
} = {}) {
  const plaintext = Buffer.from(payload);
  if (plaintext.length > 3993) throw new RangeError('web_push_payload_too_large');
  if (!sender) {
    sender = createECDH('prime256v1');
    sender.generateKeys();
  }
  const senderPublic = sender.getPublicKey();
  const receiverPublic = decode(keys.p256dh);
  const secret = sender.computeSecret(receiverPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, decode(keys.auth), info, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const cipher = createCipheriv('aes-128-gcm', key, nonce);
  const record = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, record]);
}

export function makeVapidAuthorization(vapid, audience, subject, now = Date.now()) {
  const publicKey = decode(vapid.publicKey);
  const privateKey = createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: base64url(publicKey.subarray(1, 33)),
      y: base64url(publicKey.subarray(33, 65)),
      d: vapid.privateKey,
    },
    format: 'jwk',
  });
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64url(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 7200, sub: subject }));
  const token = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(token), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${token}.${base64url(signature)}, k=${vapid.publicKey}`;
}

export async function sendWebPush(subscription, payload, { vapid, subject, ttl, topic, request = fetch }) {
  const endpoint = validatePushEndpoint(subscription.endpoint);
  if (!endpoint) return 410;
  const now = Date.now();
  let cached = vapidHeaders.get(endpoint.origin);
  if (!cached || cached.refreshAt <= now || cached.publicKey !== vapid.publicKey || cached.subject !== subject) {
    cached = {
      value: makeVapidAuthorization(vapid, endpoint.origin, subject, now),
      publicKey: vapid.publicKey,
      subject,
      refreshAt: now + 3600_000,
    };
    vapidHeaders.set(endpoint.origin, cached);
  }
  const headers = {
    Authorization: cached.value,
    'Content-Type': 'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    TTL: String(ttl),
    Urgency: 'high',
    Topic: createHash('sha256').update(topic).digest('base64url').slice(0, 32),
  };
  const response = await request(endpoint, {
    method: 'POST',
    headers,
    body: encryptPushPayload(JSON.stringify(payload), subscription.keys),
    redirect: 'error',
    signal: AbortSignal.timeout(6000),
  });
  await response.body?.cancel().catch(() => {});
  return response.status;
}
