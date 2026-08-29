/**
 * Controllers: TikTok Shop OAuth callback.
 */
import {
  queryParamOne,
  shouldOAuthRedirectToFrontend,
  buildOAuthFrontendRedirectUrl,
  exchangeTiktokAuthCode,
  TIKTOK_CALLBACK_URL,
  TIKTOK_CALLBACK_IDLE_MSG,
} from "../services/tiktok/auth.js";

function logTiktokIngress(prefix, req) {
  console.log(
    prefix,
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      query: req.query || {},
    }),
  );
}

/**
 * GET /api/tiktok/callback
 * Nhận code (+ shop_id nếu có) từ TikTok Shop Partner OAuth, đổi token (khung), redirect FE.
 */
export async function oauthCallback(req, res) {
  logTiktokIngress("[TikTok Callback]", req);

  const code = queryParamOne(req.query.code);
  const shopId = queryParamOne(req.query.shop_id) || queryParamOne(req.query.open_id);
  const state = queryParamOne(req.query.state);

  console.log(
    "[TikTok Callback] REQUEST",
    JSON.stringify({
      code_present: Boolean(code),
      code_length: code.length,
      shop_id: shopId || null,
      state: state || null,
      callback_url: TIKTOK_CALLBACK_URL,
    }),
  );

  if (!code) {
    console.log("[TikTok Callback] Truy cập trực tiếp — thiếu code");
    return res.status(200).type("text/plain; charset=utf-8").send(TIKTOK_CALLBACK_IDLE_MSG);
  }

  try {
    const result = await exchangeTiktokAuthCode(code, { shopId: shopId || undefined });

    if (queryParamOne(req.query.format) === "json") {
      return res.status(result.success ? 200 : 400).json({
        ...result,
        callback_url: TIKTOK_CALLBACK_URL,
      });
    }

    if (shouldOAuthRedirectToFrontend(req)) {
      return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
    }

    if (result.success) {
      return res.status(200).type("text/html; charset=utf-8").send(
        `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>Ủy quyền TikTok thành công</h2><p>${escapeHtml(result.message || "OK")}</p><p>Bạn có thể đóng tab này.</p></body></html>`,
      );
    }
    return res.status(400).type("text/html; charset=utf-8").send(
      `<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h2>Ủy quyền TikTok thất bại</h2><p>${escapeHtml(result.message || result.error || "error")}</p></body></html>`,
    );
  } catch (error) {
    console.error("[TikTok Callback] Lỗi:", error?.stack || error);
    const failResult = {
      success: false,
      shop_id: shopId || undefined,
      error: error?.message || "unknown_error",
      message: error?.message || "Lỗi xử lý OAuth callback TikTok",
    };
    if (queryParamOne(req.query.format) === "json") {
      return res.status(500).json(failResult);
    }
    if (shouldOAuthRedirectToFrontend(req)) {
      return res.redirect(302, buildOAuthFrontendRedirectUrl(req, failResult));
    }
    return res.status(500).type("text/html; charset=utf-8").send(
      `<!doctype html><html><body><h2>Ủy quyền thất bại</h2><p>${escapeHtml(failResult.message)}</p></body></html>`,
    );
  }
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
