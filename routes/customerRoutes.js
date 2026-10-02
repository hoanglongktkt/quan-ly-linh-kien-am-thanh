import { Router } from "express";
import {
  getCustomerOrderHistory,
  updateCustomerAddress,
} from "../controllers/customerController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/:phone/orders", h(getCustomerOrderHistory));
router.put("/:id", h(updateCustomerAddress));

export default router;
export { router };
