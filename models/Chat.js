import mongoose from "mongoose";

/**
 * Hội thoại Shopee — phân biệt 2 shop bằng shop_id.
 * Collection `chat_conversations`. Chưa đồng bộ từ Shopee.
 */
const ConversationSchema = new mongoose.Schema(
  {
    shop_id: { type: Number, required: true, index: true },
    conversation_id: { type: String, required: true, trim: true },
    customer_id: { type: mongoose.Schema.Types.Mixed, required: true },
    customer_name: { type: String, default: "", trim: true },
    customer_avatar: { type: String, default: "", trim: true },
    unread_count: { type: Number, default: 0, min: 0 },
    latest_message_snippet: { type: String, default: "", trim: true },
    last_updated_at: { type: Date, default: Date.now, index: true },
  },
  {
    collection: "chat_conversations",
    versionKey: false,
  },
);

ConversationSchema.index(
  { shop_id: 1, conversation_id: 1 },
  { unique: true, name: "chat_conv_shop_conversation" },
);
ConversationSchema.index(
  { shop_id: 1, last_updated_at: -1 },
  { name: "chat_conv_shop_updated" },
);
ConversationSchema.index(
  { shop_id: 1, unread_count: 1, last_updated_at: -1 },
  { name: "chat_conv_shop_unread" },
);

/**
 * Từng dòng tin nhắn. conversation_id trỏ tới Conversation.conversation_id.
 * Collection `chat_messages`.
 */
const ChatMessageSchema = new mongoose.Schema(
  {
    conversation_id: { type: String, required: true, trim: true, index: true },
    message_id: { type: String, required: true, trim: true },
    sender_type: {
      type: String,
      required: true,
      enum: ["shop", "customer"],
    },
    content: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    created_at: { type: Date, default: Date.now },
  },
  {
    collection: "chat_messages",
    versionKey: false,
  },
);

ChatMessageSchema.index(
  { conversation_id: 1, message_id: 1 },
  { unique: true, name: "chat_msg_conversation_message" },
);
ChatMessageSchema.index(
  { conversation_id: 1, created_at: 1 },
  { name: "chat_msg_conversation_created" },
);

/**
 * Mẫu tin nhắn nhanh. Collection `chat_quick_replies`.
 */
const QuickReplySchema = new mongoose.Schema(
  {
    shortcut: { type: String, required: true, trim: true },
    content: { type: String, required: true, trim: true },
  },
  {
    collection: "chat_quick_replies",
    versionKey: false,
  },
);

QuickReplySchema.index({ shortcut: 1 }, { unique: true, name: "chat_quick_reply_shortcut" });

const Conversation =
  mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);
const ChatMessage =
  mongoose.models.ChatMessage || mongoose.model("ChatMessage", ChatMessageSchema);
const QuickReply =
  mongoose.models.QuickReply || mongoose.model("QuickReply", QuickReplySchema);

export { ConversationSchema, ChatMessageSchema, QuickReplySchema, Conversation, ChatMessage, QuickReply };
export default Conversation;
