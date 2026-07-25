import crypto from "node:crypto";

function normalizeSignature(value: string): string {
  return value
    .trim()
    .replace(/^(?:Bearer|HMAC)\s+/i, "")
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a, "hex");
    const bBuf = Buffer.from(b, "hex");
    return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Xác thực Push Shopee theo docs Open Platform:
 * base_string = URL + "|" + request_body
 * Authorization = HMAC-SHA256(partner_key, base_string).hexdigest()
 *
 * Phải dùng đúng bytes raw body (trước JSON.parse) và URL Push đã đăng ký trên Console.
 */
export function verifyShopeeWebhookSignature(
  rawBody: Buffer,
  authorization: unknown,
  requestUrls: string | string[] = [],
): boolean {
  const secret = String(
    process.env.SHOPEE_PARTNER_KEY || process.env.SHOPEE_WEBHOOK_TOKEN || "",
  ).trim();
  const supplied = typeof authorization === "string" ? normalizeSignature(authorization) : "";

  if (!secret) {
    console.error("[Shopee Webhook] SHOPEE_PARTNER_KEY is not configured; rejecting webhook.");
    return false;
  }

  if (!supplied || !/^[a-f0-9]{64}$/.test(supplied)) {
    console.warn("[Shopee Webhook] Authorization missing or not a 64-char hex HMAC.");
    return false;
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : "";
  const urlList = (Array.isArray(requestUrls) ? requestUrls : [requestUrls])
    .map((u) => String(u || "").trim())
    .filter(Boolean);

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const url of urlList) {
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push(url);
  }

  if (candidates.length === 0) {
    console.error("[Shopee Webhook] No webhook URL candidates for HMAC base string.");
    return false;
  }

  for (const url of candidates) {
    const baseString = `${url}|${bodyStr}`;
    const expected = crypto.createHmac("sha256", secret).update(baseString).digest("hex");
    if (timingSafeEqualHex(expected, supplied)) {
      console.log(`[Shopee Webhook] HMAC OK (url=${url})`);
      return true;
    }
  }

  // Diagnostic only — never log full body/secret.
  console.warn("[Shopee Webhook] HMAC mismatch", {
    bodyBytes: Buffer.byteLength(bodyStr, "utf8"),
    urlCandidates: candidates,
    suppliedPrefix: supplied.slice(0, 12),
  });
  return false;
}
