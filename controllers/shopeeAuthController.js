/**
 * Controllers: Shopee OAuth callback / auth-url / oauth-shops / webhook probe.
 * Phase 6 — tách từ server.ts.
 */
import { resolveAppRoot } from "../utils/appPaths.js";
import {
  queryParamOne,
  normalizeShopIdKey,
  completeShopeeOAuthFlow,
  shouldOAuthRedirectToFrontend,
  buildOAuthFrontendRedirectUrl,
  saveOAuthAudit,
  ensureShopeeLinkedShopTokenKeys,
  loadShopeeTokens,
  listShopeeSyncShopIds,
  getShopeeTokenRecord,
  resolveShopeeTokenConnectionStatus,
  loadLastOAuthAudit,
  buildShopeeAuthPartnerUrl,
  isShopeeConfigValid,
  SHOPEE_TOKENS_PATH,
  SHOPEE_CALLBACK_URL,
  SHOPEE_CALLBACK_IDLE_MSG,
} from "../services/shopee/auth.js";

const APP_ROOT = resolveAppRoot();

let deps = {
  logOAuthSaveError: (ctx, err) => console.error(ctx, err),
};

export function initShopeeAuthController(partial) {
  deps = { ...deps, ...partial };
}

function logShopeeIngress(prefix, req) {
  console.log(
    prefix,
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      query: req.query || {},
      headers: req.headers || {},
      body: req.body ?? null,
    }),
  );
}

/** GET /api/shopee/oauth/complete */
export async function oauthComplete(req, res) {
  console.log("DEBUG RAW RESPONSE:", JSON.stringify(req.query));
  logShopeeIngress("[Shopee OAuth Complete]", req);
  const code = queryParamOne(req.query.code);
  const shopIdRaw = queryParamOne(req.query.shop_id);
  const mainAccountIdRaw = queryParamOne(req.query.main_account_id);
  const expectedShop = queryParamOne(req.query.expected_shop);

  console.log(
    "[Shopee OAuth Complete] REQUEST (Vercel proxy JSON)",
    JSON.stringify({
      code_present: Boolean(code),
      shop_id_raw: shopIdRaw || null,
      main_account_id_raw: mainAccountIdRaw || null,
      expected_shop: expectedShop || null,
      SHOPEE_TOKENS_PATH,
    }),
  );

  if (!code || (!shopIdRaw && !mainAccountIdRaw)) {
    return res.status(200).type("text/plain; charset=utf-8").send(SHOPEE_CALLBACK_IDLE_MSG);
  }

  try {
    const result = await completeShopeeOAuthFlow(code, {
      shopIdRaw: shopIdRaw || undefined,
      mainAccountIdRaw: mainAccountIdRaw || undefined,
      expectedShopId: expectedShop || undefined,
    });
    console.log("[Shopee OAuth Complete] KẾT QUẢ", JSON.stringify(result));
    return res.status(result.success ? 200 : 400).json({
      ...result,
      message: result.success
        ? `OAuth thành công. Token đã lưu cho shop ${result.oauth_shop_id}.`
        : result.message || result.error || "OAuth thất bại",
      tokens_path: SHOPEE_TOKENS_PATH,
    });
  } catch (error) {
    deps.logOAuthSaveError("Shopee OAuth Complete", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "unknown_error",
    });
  }
}

/** GET /api/shopee/callback | /api/auth/shopee/callback */
export async function oauthCallback(req, res) {
  console.log("DEBUG RAW RESPONSE:", JSON.stringify(req.query));
  logShopeeIngress("[Shopee Callback]", req);
  const code = queryParamOne(req.query.code);
  const shopIdRaw = queryParamOne(req.query.shop_id);
  const mainAccountIdRaw = queryParamOne(req.query.main_account_id);
  const expectedShop = queryParamOne(req.query.expected_shop);

  console.log(
    "[Shopee Callback] REQUEST NHẬN ĐƯỢC",
    JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      code_present: Boolean(code),
      code_length: code.length,
      shop_id_raw: shopIdRaw || null,
      main_account_id_raw: mainAccountIdRaw || null,
      expected_shop: expectedShop || null,
      query: req.query || {},
      SHOPEE_TOKENS_PATH,
      SHOPEE_CALLBACK_URL,
      APP_ROOT,
      cwd: process.cwd(),
    }),
  );

  if (!code || (!shopIdRaw && !mainAccountIdRaw)) {
    console.log("[Shopee Callback] Truy cập trực tiếp — thiếu code/shop_id");
    return res.status(200).type("text/plain; charset=utf-8").send(SHOPEE_CALLBACK_IDLE_MSG);
  }

  const oauthShopId = normalizeShopIdKey(shopIdRaw);
  const mainAccountId = normalizeShopIdKey(mainAccountIdRaw);
  if (!oauthShopId && !mainAccountId) {
    console.error(
      `[Shopee Callback] shop_id/main_account_id không hợp lệ: shop_id=${shopIdRaw}, main_account_id=${mainAccountIdRaw}`,
    );
    return res.status(400).json({
      success: false,
      error: "invalid_shop_id",
      message: `Shop ID / Main Account ID không hợp lệ`,
      tokens_path: SHOPEE_TOKENS_PATH,
    });
  }

  try {
    const result = await completeShopeeOAuthFlow(code, {
      shopIdRaw: shopIdRaw || undefined,
      mainAccountIdRaw: mainAccountIdRaw || undefined,
      expectedShopId: expectedShop || undefined,
    });

    if (!result.success) {
      console.error(`[Shopee Callback] Đổi code thất bại:`, result.error, result.message);
      if (shouldOAuthRedirectToFrontend(req)) {
        return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
      }
      return res.status(400).json({
        ...result,
        message: result.message || result.error || "token_exchange_failed",
        tokens_path: SHOPEE_TOKENS_PATH,
      });
    }

    console.log(
      `[Shopee Callback] OAuth OK. Token đã lưu cho: [${result.saved_shop_ids.join(", ")}]. verified=${result.verified_in_file} File: ${SHOPEE_TOKENS_PATH}`,
    );
    if (shouldOAuthRedirectToFrontend(req)) {
      return res.redirect(302, buildOAuthFrontendRedirectUrl(req, result));
    }
    return res.status(200).json({
      ...result,
      message:
        result.message ||
        `OAuth thành công. Token đã lưu cho: [${result.saved_shop_ids.join(", ")}].`,
      tokens_path: SHOPEE_TOKENS_PATH,
      callback_url: SHOPEE_CALLBACK_URL,
    });
  } catch (error) {
    deps.logOAuthSaveError("Shopee Callback", error);
    saveOAuthAudit({
      callback_shop_id: oauthShopId || mainAccountId || null,
      main_account_id: mainAccountId || null,
      success: false,
      error: error?.message || "unknown_error",
      tokens_path: SHOPEE_TOKENS_PATH,
      app_root: APP_ROOT,
    });
    const failResult = {
      success: false,
      error: error?.message || "unknown_error",
      message: error?.message || "Lỗi xử lý OAuth callback",
      oauth_shop_id: oauthShopId,
    };
    if (shouldOAuthRedirectToFrontend(req)) {
      return res.redirect(302, buildOAuthFrontendRedirectUrl(req, failResult));
    }
    return res.status(500).json({
      ...failResult,
      tokens_path: SHOPEE_TOKENS_PATH,
    });
  }
}

/** GET /api/shopee/webhook — probe only */
export function webhookProbe(req, res) {
  logShopeeIngress("[Shopee Webhook]", req);
  console.log("[Shopee Webhook] GET verification probe — 200 success");
  res.status(200).type("text/plain; charset=utf-8").send("success");
}

/** GET /api/shopee/oauth-shops */
export async function listOauthShops(_req, res) {
  ensureShopeeLinkedShopTokenKeys();
  const tokens = loadShopeeTokens();
  const shopIds = listShopeeSyncShopIds();
  const details = shopIds.map((id) => {
    const record = getShopeeTokenRecord(tokens, id);
    const tokenStatus = resolveShopeeTokenConnectionStatus(id);
    return {
      shop_id: id,
      obtained_at: record?.obtained_at ?? null,
      expire_in: record?.expire_in ?? null,
      oauth_shop_id: record?.oauth_shop_id ?? null,
      shop_id_list: record?.shop_id_list ?? [],
      has_own_key: Boolean(tokens[id]),
      connection_status: tokenStatus.status,
      connection_message: tokenStatus.message,
      token_expires_at: tokenStatus.expires_at,
    };
  });
  const lastOAuth = loadLastOAuthAudit();
  return res.json({
    success: true,
    shopIds,
    details,
    tokensPath: SHOPEE_TOKENS_PATH,
    appRoot: APP_ROOT,
    lastOAuth,
    count: shopIds.length,
  });
}

/** GET /api/shopee/auth-url */
export async function getAuthUrl(req, res) {
  if (!isShopeeConfigValid()) {
    return res.status(500).json({
      success: false,
      error: "invalid_partner_config",
      message: "SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY chưa cấu hình trên backend cPanel.",
    });
  }
  const shopId = normalizeShopIdKey(String(req.query.shop_id || ""));
  if (!shopId) {
    return res.status(400).json({
      success: false,
      error: "shop_id_required",
      message: "Cần shop_id (VD: 241215004) để tạo link ủy quyền OAuth.",
    });
  }
  return res.json({
    success: true,
    shop_id: shopId,
    url: buildShopeeAuthPartnerUrl(shopId),
    callback: SHOPEE_CALLBACK_URL,
  });
}
