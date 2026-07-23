import crypto from "node:crypto";

function normalizeSignature(value: string): string {
  return value
    .trim()
    .replace(/^(?:Bearer|HMAC)\s+/i, "")
    .replace(/^sha256=/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Xác thực trên đúng bytes nhận được từ Shopee, trước khi JSON.parse.
 * Không dùng JSON.stringify(req.body) vì thứ tự key/khoảng trắng có thể khác payload gốc.
 */
export function verifyShopeeWebhookSignature(
  rawBody: Buffer,
  authorization: unknown,
): boolean {
  const secret = String(
    process.env.SHOPEE_WEBHOOK_TOKEN || process.env.SHOPEE_PARTNER_KEY || "",
  ).trim();
  const supplied = typeof authorization === "string" ? normalizeSignature(authorization) : "";

  // Fail closed: không nhận webhook khi chưa cấu hình secret hoặc thiếu chữ ký.
  if (!secret || !supplied || !/^[a-f0-9]{64}$/.test(supplied)) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}
