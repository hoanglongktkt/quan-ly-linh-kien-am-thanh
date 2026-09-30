import { Router } from "express";
import {
  getConversations,
  getMessages,
  sendMessage,
  markConversationRead,
  getQuickReplies,
  createQuickReply,
} from "../controllers/chatController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/conversations", h(getConversations));
router.post("/conversations/:id/read", h(markConversationRead));
router.get("/messages/:conversation_id", h(getMessages));
router.post("/send", h(sendMessage));
router.get("/quick-replies", h(getQuickReplies));
router.post("/quick-replies", h(createQuickReply));

export default router;
export { router };
