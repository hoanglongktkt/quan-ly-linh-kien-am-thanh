import { Router } from "express";
import {
  printDocument,
  printDocumentAsync,
  getPrintDocumentJob,
} from "../controllers/shopeePrintController.js";

const router = Router();

router.post("/print-document", printDocument);
router.post("/print-document/async", printDocumentAsync);
router.get("/print-document/job/:jobId", getPrintDocumentJob);

export default router;
export { router };
export { printDocument, printDocumentAsync, getPrintDocumentJob };
