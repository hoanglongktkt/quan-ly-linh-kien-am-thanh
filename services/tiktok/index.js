/**
 * TikTok Shop integration — Custom App (Seller Center).
 */
export {
  resolveTiktokCustomAppCredentials,
  upsertTiktokCustomAppCredentials,
  isTiktokCustomAppConfigured,
  syncTiktokCredentialsFromShops,
  extractTiktokFieldsFromShop,
  getTiktokApiHost,
  TIKTOK_API_HOST,
  TIKTOK_TOKENS_PATH,
} from "./auth.js";

export { tiktokApiRequest, signTiktokRequest, tiktokApiDelay } from "./client.js";

export {
  exchangeTiktokAuthCode,
  refreshTikTokToken,
  ensureTiktokInboundCredential,
  syncAndExchangeTiktokShops,
  classifyTiktokCredentialInput,
  isTiktokTokenExpiredError,
} from "./token.js";

export {
  fetchTiktokOrderListPage,
  fetchTiktokOrderDetails,
  fetchTiktokOrdersPaginated,
  syncTiktokOrdersSkeleton,
} from "./orders.js";

export {
  fetchTiktokProductDetail,
  fetchTiktokProductDetails,
  fetchTiktokProductListPage,
  resolveTiktokSkuFromDetail,
  updateTiktokProductInventory,
  updateTiktokProductPrices,
  syncTiktokProductStockPrice,
} from "./products.js";

export { pingTiktokShopConnection, credentialsFromShopRecord } from "./ping.js";
