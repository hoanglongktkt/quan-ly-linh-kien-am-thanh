// Đọc raw bytes trước ACK; giữ timeout, giới hạn body và URL xác thực.
import express from "express";
import { resolveAppBaseUrl } from "../../utils/appPaths.js";
export function ackShopeeOk(res: express.Response): void {
  if (res.headersSent || res.writableEnded) return;
  try {
    // Shopee Live Push: HTTP 200 = push thành công.
    // Kết thúc response ngay, không giữ socket chờ parse / API Shopee / MongoDB.
    res.status(200).send("OK");
  } catch (ackErr) {
    console.warn("[Shopee Webhook] ACK send failed:", ackErr);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  }
}

export function readAuthorizationHeader(req: express.Request): string {
  const headers = req.headers as Record<string, unknown>;
  return String(
    req.get("authorization") ||
      req.get("Authorization") ||
      headers.authorization ||
      headers.Authorization ||
      headers.http_authorization ||
      process.env.HTTP_AUTHORIZATION ||
      "",
  ).trim();
}

export function buildWebhookUrlCandidates(req: express.Request): string[] {
  const path = String(req.originalUrl || req.url || "")
    .split("?")[0]
    .trim();
  const candidates = new Set<string>();
  const base = resolveAppBaseUrl().replace(/\/$/, "");
  const configured = String(process.env.SHOPEE_WEBHOOK_URL || "").trim();
  if (configured) candidates.add(configured.replace(/\/$/, ""));
  candidates.add(`${base}/api/shopee/webhook`);

  if (path.startsWith("/")) {
    candidates.add(`${base}${path}`);

    const forwardedProto = String(req.get("x-forwarded-proto") || "")
      .split(",")[0]
      .trim();
    const forwardedHost = String(req.get("x-forwarded-host") || "")
      .split(",")[0]
      .trim();
    if (forwardedProto && forwardedHost) {
      candidates.add(`${forwardedProto}://${forwardedHost}${path}`);
    }

    const host = String(req.get("host") || "").trim();
    if (host) {
      candidates.add(`${req.protocol}://${host}${path}`);
      candidates.add(`https://${host}${path}`);
      candidates.add(`http://${host}${path}`);
    }
  }

  return [...candidates];
}

export function readRawWebhookBody(req: express.Request): Promise<Buffer | null> {
  const maxBytes = 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let overflow = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Webhook body stream timeout"));
    }, 10_000);

    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (overflow) {
        console.warn(`[Shopee Webhook] Body vượt giới hạn ${maxBytes} bytes — bỏ xử lý sau ACK.`);
        resolve(null);
        return;
      }
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
