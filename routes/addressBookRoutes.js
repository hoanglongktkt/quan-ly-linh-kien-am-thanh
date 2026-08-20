import { Router } from "express";
import { listAddressBook, createAddressBookEntry } from "../controllers/addressBookController.js";
import { asyncHandler } from "../middlewares/errorHandler.js";

const router = Router();
const h = asyncHandler;

router.get("/", h(listAddressBook));
router.post("/", h(createAddressBookEntry));

export default router;
export { router };
