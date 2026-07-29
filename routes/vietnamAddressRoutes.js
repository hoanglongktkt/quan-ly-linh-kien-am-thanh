import { Router } from "express";
import {
  getProvinces,
  getDistricts,
  getWards,
} from "../controllers/vietnamAddressController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();

router.get("/provinces", asyncHandler(getProvinces));
router.get("/districts/:provinceCode", asyncHandler(getDistricts));
router.get("/wards/:districtCode", asyncHandler(getWards));

export default router;
export { router };
