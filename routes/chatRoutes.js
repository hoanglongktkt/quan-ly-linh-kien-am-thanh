import { Router } from "express";
import {
  getConversations,
  getMessages,
  getQuickReplies,
  addQuickReply,
} from "../controllers/chatController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/conversations", h(getConversations));
router.get("/conversations/:conversationId/messages", h(getMessages));
router.get("/quick-replies", h(getQuickReplies));
router.post("/quick-replies", h(addQuickReply));

export default router;
export { router };
