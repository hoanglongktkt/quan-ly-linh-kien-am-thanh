import { Router } from "express";
import {
  listAddressBook,
  rankingAddressBook,
  createAddressBookEntry,
} from "../controllers/addressBookController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/ranking", h(rankingAddressBook));
router.get("/", h(listAddressBook));
router.post("/", h(createAddressBookEntry));

export default router;
export { router };
