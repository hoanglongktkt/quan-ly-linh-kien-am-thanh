import { Conversation, ChatMessage, QuickReply } from "../models/Chat.js";

const LIST_LIMIT = 50;
const MESSAGE_LIMIT = 100;
const QUICK_REPLY_LIMIT = 200;

function parseShopId(raw) {
  const shopId = Number(raw);
  if (!Number.isFinite(shopId)) return null;
  return shopId;
}

function parseLimit(raw, fallback, max) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function wantsUnreadOnly(query) {
  const unread = String(query?.unread ?? "").trim().toLowerCase();
  const status = String(query?.status ?? "").trim().toLowerCase();
  return unread === "1" || unread === "true" || status === "unread";
}

/** GET /api/chat/conversations?shop_id=&unread=1 */
export async function getConversations(req, res) {
  try {
    const shopId = parseShopId(req.query?.shop_id);
    if (shopId == null) {
      return res.status(400).json({ success: false, error: "Thiếu shop_id hợp lệ." });
    }

    const filter = { shop_id: shopId };
    if (wantsUnreadOnly(req.query)) {
      filter.unread_count = { $gt: 0 };
    }

    const limit = parseLimit(req.query?.limit, LIST_LIMIT, 100);
    const conversations = await Conversation.find(filter)
      .sort({ last_updated_at: -1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, conversations });
  } catch (error) {
    console.error("[Chat getConversations]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không tải được danh sách hội thoại",
      conversations: [],
    });
  }
}

/** GET /api/chat/conversations/:conversationId/messages?shop_id= */
export async function getMessages(req, res) {
  try {
    const conversationId = String(req.params?.conversationId || "").trim();
    if (!conversationId) {
      return res.status(400).json({ success: false, error: "Thiếu conversation_id." });
    }

    const shopId = parseShopId(req.query?.shop_id);
    const convFilter = { conversation_id: conversationId };
    if (shopId != null) convFilter.shop_id = shopId;

    const conversation = await Conversation.findOne(convFilter).select("conversation_id shop_id").lean();
    if (!conversation) {
      return res.json({ success: true, messages: [] });
    }

    const limit = parseLimit(req.query?.limit, MESSAGE_LIMIT, 200);
    const messages = await ChatMessage.find({ conversation_id: conversation.conversation_id })
      .sort({ created_at: 1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, messages });
  } catch (error) {
    console.error("[Chat getMessages]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không tải được tin nhắn",
      messages: [],
    });
  }
}

/** GET /api/chat/quick-replies */
export async function getQuickReplies(_req, res) {
  try {
    const quickReplies = await QuickReply.find({})
      .sort({ shortcut: 1 })
      .limit(QUICK_REPLY_LIMIT)
      .lean();
    return res.json({ success: true, quickReplies });
  } catch (error) {
    console.error("[Chat getQuickReplies]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không tải được tin nhắn nhanh",
      quickReplies: [],
    });
  }
}

/** POST /api/chat/quick-replies  body: { shortcut, content } */
export async function addQuickReply(req, res) {
  try {
    const shortcut = String(req.body?.shortcut || "").trim();
    const content = String(req.body?.content || "").trim();
    if (!shortcut || !content) {
      return res.status(400).json({
        success: false,
        error: "Cần shortcut và content.",
      });
    }

    const quickReply = await QuickReply.create({ shortcut, content });
    return res.status(201).json({ success: true, quickReply });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        error: "Shortcut đã tồn tại.",
      });
    }
    console.error("[Chat addQuickReply]", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Không lưu được tin nhắn nhanh",
    });
  }
}
