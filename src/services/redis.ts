/**
 * Redis client (ioredis) with graceful fallback.
 * If Redis is unavailable / REDIS_URL unset, cache ops no-op and callers hit the API.
 */
import Redis from "ioredis";

const REDIS_URL = String(process.env.REDIS_URL || process.env.REDIS_URI || "").trim();
const ADDRESS_LIST_TTL_SEC = 24 * 60 * 60; // 24h
const ADDRESS_LIST_KEY_PREFIX = "shopee:address_list:";

let redis: Redis | null = null;
let redisDisabled = false;
let lastWarnAt = 0;

function warnRedis(msg: string, err?: unknown) {
  const now = Date.now();
  if (now - lastWarnAt < 30_000) return;
  lastWarnAt = now;
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  console.warn(`[Redis] ${msg}${detail ? `: ${detail}` : ""} — fallback (no cache).`);
}

function getRedis(): Redis | null {
  if (redisDisabled) return null;
  if (!REDIS_URL) {
    redisDisabled = true;
    return null;
  }
  if (redis) return redis;
  try {
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      lazyConnect: true,
      connectTimeout: 3_000,
      commandTimeout: 2_000,
      retryStrategy(times) {
        if (times > 3) {
          redisDisabled = true;
          warnRedis("too many reconnect attempts — disabling for this process");
          return null;
        }
        return Math.min(times * 200, 1_000);
      },
    });
    redis.on("error", (err) => {
      warnRedis("client error", err);
    });
    redis.on("end", () => {
      warnRedis("connection ended");
    });
  } catch (err) {
    warnRedis("failed to create client", err);
    redisDisabled = true;
    redis = null;
  }
  return redis;
}

async function ensureConnected(client: Redis): Promise<boolean> {
  try {
    if (client.status === "ready") return true;
    if (client.status === "wait" || client.status === "close" || client.status === "end") {
      await client.connect();
    } else if (client.status === "connecting") {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onError = (e: Error) => {
          cleanup();
          reject(e);
        };
        const cleanup = () => {
          client.off("ready", onReady);
          client.off("error", onError);
          if (timer) clearTimeout(timer);
        };
        client.once("ready", onReady);
        client.once("error", onError);
        timer = setTimeout(() => {
          cleanup();
          reject(new Error("connect timeout"));
        }, 3_000);
      });
    }
    return client.status === "ready";
  } catch (err) {
    warnRedis("connect failed", err);
    return false;
  }
}

export function shopeeAddressListCacheKey(shopId: string): string {
  return `${ADDRESS_LIST_KEY_PREFIX}${String(shopId || "").trim()}`;
}

export async function redisGetJson<T = unknown>(key: string): Promise<T | null> {
  const client = getRedis();
  if (!client) return null;
  try {
    if (!(await ensureConnected(client))) return null;
    const raw = await client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    warnRedis(`GET ${key} failed`, err);
    return null;
  }
}

export async function redisSetJson(
  key: string,
  value: unknown,
  ttlSeconds: number = ADDRESS_LIST_TTL_SEC,
): Promise<boolean> {
  const client = getRedis();
  if (!client) return false;
  try {
    if (!(await ensureConnected(client))) return false;
    const payload = JSON.stringify(value);
    if (ttlSeconds > 0) {
      await client.set(key, payload, "EX", ttlSeconds);
    } else {
      await client.set(key, payload);
    }
    return true;
  } catch (err) {
    warnRedis(`SET ${key} failed`, err);
    return false;
  }
}

export type CachedShopeeAddressList = {
  result: any;
  list: any[];
  cachedAt: number;
};

/** Read cached get_address_list for shop. Null on miss / Redis down. */
export async function getCachedShopeeAddressList(
  shopId: string,
): Promise<CachedShopeeAddressList | null> {
  const sid = String(shopId || "").trim();
  if (!sid) return null;
  const cached = await redisGetJson<CachedShopeeAddressList>(shopeeAddressListCacheKey(sid));
  if (!cached || !cached.result) return null;
  const list = Array.isArray(cached.list)
    ? cached.list
    : cached.result?.response?.address_list || cached.result?.address_list || [];
  return { result: cached.result, list, cachedAt: cached.cachedAt || Date.now() };
}

/** Persist successful get_address_list response (24h TTL). Skips error payloads. */
export async function setCachedShopeeAddressList(
  shopId: string,
  result: any,
): Promise<boolean> {
  const sid = String(shopId || "").trim();
  if (!sid || !result || result.error) return false;
  const list = result.response?.address_list || result.address_list || [];
  return redisSetJson(shopeeAddressListCacheKey(sid), {
    result,
    list,
    cachedAt: Date.now(),
  }, ADDRESS_LIST_TTL_SEC);
}

export function isRedisEnabled(): boolean {
  return Boolean(REDIS_URL) && !redisDisabled;
}

export async function closeRedis(): Promise<void> {
  if (!redis) return;
  try {
    await redis.quit();
  } catch {
    try {
      redis.disconnect();
    } catch {
      /* ignore */
    }
  }
  redis = null;
}
