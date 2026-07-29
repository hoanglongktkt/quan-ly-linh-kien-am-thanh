import { Router } from "express";
import {
  getProvinces,
  getDistricts,
  getWards,
} from "../controllers/vietnamAddressController.js";

const router = Router();

router.get("/provinces", getProvinces);
router.get("/districts/:provinceCode", getDistricts);
router.get("/wards/:districtCode", getWards);

export default router;
export { router };
