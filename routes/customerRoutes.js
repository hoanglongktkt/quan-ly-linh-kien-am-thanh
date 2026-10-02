import { Router } from "express";
import {
  deleteCustomer,
  getCustomerOrderHistory,
  updateCustomerAddress,
} from "../controllers/customerController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/:phone/orders", h(getCustomerOrderHistory));
router.put("/:id", h(updateCustomerAddress));
router.delete("/:id", h(deleteCustomer));

export default router;
export { router };
