import { Router } from "express";
import {
  getConversations,
  getMessages,
  sendMessage,
  markConversationRead,
  getUnreadCount,
  getQuickReplies,
  createQuickReply,
} from "../controllers/chatController.js";
import { chatSseStream } from "../controllers/chatSseController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/conversations", h(getConversations));
router.post("/conversations/:id/read", h(markConversationRead));
router.get("/messages/:conversation_id", h(getMessages));
router.post("/send", h(sendMessage));
router.get("/unread-count", h(getUnreadCount));
router.get("/quick-replies", h(getQuickReplies));
router.post("/quick-replies", h(createQuickReply));
router.get("/sse", chatSseStream);

export default router;
export { router };
