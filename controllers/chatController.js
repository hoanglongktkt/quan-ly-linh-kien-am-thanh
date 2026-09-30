import { Conversation, ChatMessage, QuickReply } from "../models/Chat.js";
import { recordChatMessage, sendShopeeChatText } from "../services/shopee/chat.js";

const LIST_LIMIT = 100;
const MESSAGE_CAP = 1000;
const QUICK_REPLY_LIMIT = 200;

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

function parseShopId(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const shopId = Number(raw);
  if (!Number.isFinite(shopId)) return null;
  return shopId;
}

function snippetFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content.trim().slice(0, 300);
  if (typeof content === "object") {
    const text = content.text || content.content || content.caption || "";
    if (String(text).trim()) return String(text).trim().slice(0, 300);
    if (content.image_url || content.imageUrl || content.image) return "[Hình ảnh]";
    if (content.sticker || content.sticker_id) return "[Sticker]";
  }
  return String(content).slice(0, 300);
}

function normalizeContent(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  return { type: "text", text: String(raw ?? "").trim() };
}

function localMessageId() {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** GET /api/chat/conversations?shop_id=&filter=all|unread */
export async function getConversations(req, res) {
  try {
    const shopRaw = req.query?.shop_id;
    const hasShop = shopRaw != null && String(shopRaw).trim() !== "";
    const shopId = parseShopId(shopRaw);
    if (hasShop && shopId == null) {
      return res.status(400).json({ success: false, error: "shop_id không hợp lệ." });
    }

    const filterName = String(req.query?.filter || "all").trim().toLowerCase();
    if (filterName !== "all" && filterName !== "unread") {
      return res.status(400).json({ success: false, error: "filter phải là all hoặc unread." });
    }

    const query = {};
    if (shopId != null) query.shop_id = shopId;
    if (filterName === "unread") query.unread_count = { $gt: 0 };

    const conversations = await Conversation.find(query)
      .sort({ last_updated_at: -1 })
      .limit(LIST_LIMIT)
      .lean();

    return res.json({ success: true, conversations });
  } catch (error) {
    logChatError("[Chat getConversations]", error);
    return res.status(500).json({
      success: false,
      error: "Không tải được danh sách hội thoại",
      conversations: [],
    });
  }
}

/** GET /api/chat/messages/:conversation_id */
export async function getMessages(req, res) {
  try {
    const conversationId = String(
      req.params?.conversation_id || req.params?.conversationId || "",
    ).trim();
    if (!conversationId) {
      return res.status(400).json({ success: false, error: "Thiếu conversation_id." });
    }

    const messages = await ChatMessage.find({ conversation_id: conversationId })
      .sort({ created_at: 1 })
      .limit(MESSAGE_CAP)
      .lean();

    return res.json({ success: true, messages });
  } catch (error) {
    logChatError("[Chat getMessages]", error);
    return res.status(500).json({
      success: false,
      error: "Không tải được tin nhắn",
      messages: [],
    });
  }
}

/** POST /api/chat/send  body: { conversation_id, shop_id, content, sender_type: 'shop' } */
export async function sendMessage(req, res) {
  try {
    const conversationId = String(req.body?.conversation_id || "").trim();
    const shopId = parseShopId(req.body?.shop_id);
    const senderType = String(req.body?.sender_type || "shop").trim();
    const content = normalizeContent(req.body?.content);
    const text = snippetFromContent(content);

    if (!conversationId || shopId == null) {
      return res.status(400).json({
        success: false,
        error: "Cần conversation_id và shop_id.",
      });
    }
    if (senderType !== "shop") {
      return res.status(400).json({
        success: false,
        error: "sender_type phải là shop.",
      });
    }
    if (!text) {
      return res.status(400).json({ success: false, error: "Nội dung tin nhắn trống." });
    }

    const conversation = await Conversation.findOne({
      conversation_id: conversationId,
      shop_id: shopId,
    }).lean();
    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: "Không tìm thấy hội thoại.",
      });
    }

    const sent = await sendShopeeChatText({
      shopId,
      toId: conversation.customer_id,
      text,
    });
    if (!sent.ok) {
      return res.status(502).json({
        success: false,
        error: sent.error || "Shopee không gửi được tin nhắn.",
      });
    }

    const messageId = sent.messageId || localMessageId();
    const now = new Date();
    await recordChatMessage({
      shopId,
      conversationId,
      customerId: conversation.customer_id,
      customerName: conversation.customer_name,
      customerAvatar: conversation.customer_avatar,
      messageId,
      senderType: "shop",
      messageType: "text",
      content,
      snippet: text,
      createdAt: now,
    });

    return res.status(201).json({
      success: true,
      message: {
        conversation_id: conversationId,
        message_id: messageId,
        sender_type: "shop",
        content,
        created_at: now,
      },
      conversation: {
        conversation_id: conversationId,
        shop_id: shopId,
        latest_message_snippet: text,
        last_updated_at: now,
        unread_count: 0,
      },
    });
  } catch (error) {
    logChatError("[Chat sendMessage]", error);
    return res.status(500).json({
      success: false,
      error: "Không gửi được tin nhắn",
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
    logChatError("[Chat getQuickReplies]", error);
    return res.status(500).json({
      success: false,
      error: "Không tải được tin nhắn nhanh",
      quickReplies: [],
    });
  }
}

/** POST /api/chat/quick-replies  body: { shortcut, content } */
export async function createQuickReply(req, res) {
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
    if (error && error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: "Shortcut đã tồn tại.",
      });
    }
    logChatError("[Chat createQuickReply]", error);
    return res.status(500).json({
      success: false,
      error: "Không lưu được tin nhắn nhanh",
    });
  }
}
