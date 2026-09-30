import { Conversation, ChatMessage } from "../../models/Chat.js";
import {
  SHOPEE_HOST,
  SHOPEE_PARTNER_ID,
  getAccessTokenForShop,
  shopeeSign,
} from "./auth.js";
import { shopeePostJsonWithRetry } from "./client.js";
import { toShopeeId, toShopeeIdNumber } from "./jsonBig.js";

const SEND_MESSAGE_PATH = "/api/v2/sellerchat/send_message";

function logChatError(label, error) {
  try {
    const message =
      error && typeof error === "object" && error.message
        ? error.message
        : String(error || "unknown");
    console.error(label, message);
  } catch {
    /* EPIPE — không để log làm sập process */
  }
}

function asRecord(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return null;
}

function unwrapData(payload) {
  const raw = payload?.data;
  if (asRecord(raw)) return raw;
  return payload && typeof payload === "object" ? payload : {};
}

function pickMessageNode(data) {
  const content = asRecord(data?.content);
  if (content && (content.conversation_id || content.message_id || content.from_id)) {
    return content;
  }
  const message = asRecord(data?.message);
  if (message && (message.conversation_id || message.message_id || message.from_id)) {
    return message;
  }
  return data;
}

function snippetFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content.trim().slice(0, 300);
  if (typeof content === "object") {
    const text = content.text || content.content || content.caption || "";
    if (String(text).trim()) return String(text).trim().slice(0, 300);
    if (content.image_url || content.imageUrl || content.url || content.image) return "[Hình ảnh]";
    if (content.sticker_id || content.sticker || content.sticker_package_id) return "[Sticker]";
    if (content.order_sn || content.ordersn) return "[Đơn hàng]";
    if (content.item_id) return "[Sản phẩm]";
  }
  return String(content).slice(0, 300);
}

function normalizeStoredContent(raw, messageType) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return messageType ? { ...raw, message_type: raw.message_type || messageType } : raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    return { type: "text", text: raw.trim(), message_type: messageType || "text" };
  }
  return { type: messageType || "unknown", message_type: messageType || "unknown" };
}

function resolveSenderType(shopId, msg) {
  const fromShop = Number(msg.from_shop_id ?? msg.from_shopid);
  const toShop = Number(msg.to_shop_id ?? msg.to_shopid);
  if (Number.isFinite(fromShop) && fromShop > 0 && fromShop === shopId) return "shop";
  if (Number.isFinite(toShop) && toShop > 0 && toShop === shopId) return "customer";
  const role = String(
    msg.sender_role || msg.from_type || msg.user_type || msg.sender || msg.source || "",
  )
    .trim()
    .toLowerCase();
  if (role === "seller" || role === "shop" || role === "sub_account" || role === "subaccount") {
    return "shop";
  }
  if (role === "buyer" || role === "customer") return "customer";
  return "customer";
}

function resolveCustomerId(senderType, msg) {
  const fromId = msg.from_id ?? msg.from_user_id ?? msg.buyer_id ?? msg.user_id;
  const toId = msg.to_id ?? msg.to_user_id;
  const raw = senderType === "customer" ? fromId ?? toId : toId ?? fromId;
  return toShopeeId(raw) || "";
}

function resolveCreatedAt(msg, payload) {
  const raw = Number(
    msg.created_timestamp ??
      msg.create_time ??
      msg.created_at ??
      payload?.timestamp ??
      0,
  );
  if (!Number.isFinite(raw) || raw <= 0) return new Date();
  const ms = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

/**
 * Ghi một dòng chat. Tin trùng message_id không tăng unread lần nữa.
 * sender shop → unread_count = 0. sender customer (tin mới) → unread_count + 1.
 */
export async function recordChatMessage(input) {
  const shopId = Number(input?.shopId);
  const conversationId = String(input?.conversationId || "").trim();
  const messageId = String(input?.messageId || "").trim();
  const senderType = input?.senderType === "shop" ? "shop" : "customer";
  const customerId = String(input?.customerId || "").trim() || "0";
  const content = normalizeStoredContent(input?.content, input?.messageType);
  const snippet = String(input?.snippet || snippetFromContent(content) || "").slice(0, 300);
  const createdAt = input?.createdAt instanceof Date ? input.createdAt : new Date();

  if (!Number.isFinite(shopId) || !conversationId || !messageId) {
    return { ok: false, error: "missing_fields" };
  }

  let created = false;
  try {
    await ChatMessage.create({
      conversation_id: conversationId,
      message_id: messageId,
      sender_type: senderType,
      content,
      created_at: createdAt,
    });
    created = true;
  } catch (error) {
    if (!(error && error.code === 11000)) throw error;
  }

  const set = {
    shop_id: shopId,
    conversation_id: conversationId,
    customer_id: customerId,
    latest_message_snippet: snippet,
    last_updated_at: createdAt,
  };
  const customerName = String(input?.customerName || "").trim();
  const customerAvatar = String(input?.customerAvatar || "").trim();
  if (customerName) set.customer_name = customerName;
  if (customerAvatar) set.customer_avatar = customerAvatar;
  if (senderType === "shop") set.unread_count = 0;

  const update = { $set: set };
  if (senderType === "customer" && created) {
    update.$inc = { unread_count: 1 };
  }

  await Conversation.findOneAndUpdate(
    { shop_id: shopId, conversation_id: conversationId },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ok: true, created, duplicate: !created };
}

/**
 * Webchat Push (code 10) — payload Shopee Open API v2.
 * Không gọi API Shopee. Chỉ parse và ghi MongoDB.
 */
export async function ingestShopeeChatPush(payload) {
  try {
    const envelope = payload && typeof payload === "object" ? payload : {};
    const data = unwrapData(envelope);
    const msg = pickMessageNode(data);
    const code = Number(envelope.code ?? data.code);
    const shopId = Number(envelope.shop_id ?? data.shop_id ?? msg.shop_id);
    const conversationId = String(
      msg.conversation_id ?? data.conversation_id ?? "",
    ).trim();

    if (!Number.isFinite(shopId) || !conversationId) {
      logChatError(
        "[Shopee Chat Webhook] Bỏ qua push thiếu shop_id hoặc conversation_id",
        `code=${Number.isFinite(code) ? code : "?"}`,
      );
      return { ok: false, skipped: true };
    }

    const senderType = resolveSenderType(shopId, msg);
    const messageType = String(msg.message_type || msg.type || data.type || "text").trim();
    const content = normalizeStoredContent(msg.content ?? data.content ?? msg, messageType);
    const messageId =
      toShopeeId(msg.message_id ?? msg.msg_id ?? data.message_id) ||
      `push-${shopId}-${conversationId}-${Number(envelope.timestamp) || Date.now()}`;
    const customerName = String(
      msg.from_user_name || msg.buyer_name || msg.user_name || msg.from_name || "",
    ).trim();
    const customerAvatar = String(
      msg.from_user_avatar || msg.buyer_avatar || msg.avatar || "",
    ).trim();

    const saved = await recordChatMessage({
      shopId,
      conversationId,
      customerId: resolveCustomerId(senderType, msg),
      customerName,
      customerAvatar,
      messageId,
      senderType,
      messageType,
      content,
      snippet: snippetFromContent(content),
      createdAt: resolveCreatedAt(msg, envelope),
    });

    try {
      console.log(
        `[Shopee Chat Webhook] shop_id=${shopId} conversation_id=${conversationId} sender=${senderType} message_id=${messageId} created=${Boolean(saved.created)}`,
      );
    } catch {
      /* ignore */
    }
    return { ok: true, ...saved, senderType, conversationId, shopId };
  } catch (error) {
    logChatError("[Shopee Chat Webhook] ingest failed", error);
    return { ok: false, error: "ingest_failed" };
  }
}

/**
 * v2.sellerchat.send_message — một request, retry có giới hạn trong client.
 * Body: { to_id, message_type: "text", content: { text } }.
 */
export async function sendShopeeChatText({ shopId, toId, text }) {
  const shopKey = toShopeeId(shopId);
  const buyerId = toShopeeIdNumber(toId);
  const bodyText = String(text || "").trim();
  if (!shopKey || buyerId == null || !bodyText) {
    return { ok: false, error: "Thiếu shop_id, người nhận hoặc nội dung." };
  }

  let accessToken = "";
  try {
    accessToken = String((await getAccessTokenForShop(shopKey)) || "").trim();
  } catch (error) {
    logChatError("[Shopee Chat Send] token", error);
    return { ok: false, error: "Không lấy được access_token của shop." };
  }
  if (!accessToken) {
    return { ok: false, error: "Shop chưa ủy quyền hoặc token hết hạn." };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const sign = shopeeSign(SEND_MESSAGE_PATH, timestamp, accessToken, shopKey);
  const url =
    `${SHOPEE_HOST}${SEND_MESSAGE_PATH}` +
    `?partner_id=${encodeURIComponent(SHOPEE_PARTNER_ID)}` +
    `&timestamp=${timestamp}` +
    `&access_token=${encodeURIComponent(accessToken)}` +
    `&shop_id=${encodeURIComponent(shopKey)}` +
    `&sign=${sign}`;

  let result;
  try {
    result = await shopeePostJsonWithRetry(
      url,
      {
        to_id: buyerId,
        message_type: "text",
        content: { text: bodyText },
      },
      "sellerchat.send_message",
      { maxAttempts: 3, baseDelayMs: 1500 },
    );
  } catch (error) {
    logChatError("[Shopee Chat Send] request", error);
    return { ok: false, error: "Không kết nối được Shopee Chat API." };
  }

  const json = result?.json || {};
  const shopeeError = String(json.error || "").trim();
  if (result?.httpStatus >= 400 || shopeeError) {
    logChatError(
      "[Shopee Chat Send] Shopee từ chối",
      shopeeError || json.message || `HTTP ${result?.httpStatus}`,
    );
    return {
      ok: false,
      error: String(json.message || shopeeError || "Shopee từ chối gửi tin."),
      shopee: json,
    };
  }

  const response = asRecord(json.response) || {};
  return {
    ok: true,
    messageId: toShopeeId(response.message_id) || "",
    conversationId: toShopeeId(response.conversation_id) || "",
    toId: toShopeeId(response.to_id) || String(buyerId),
    raw: json,
  };
}
