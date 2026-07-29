import { Router } from "express";

/**
 * PDF vận đơn — handler inject từ server (serveLabelPdfFromMem).
 * Mount: app.use(labelsRoutes) tại root (không prefix /api only).
 */
let serveHandler = null;

export function initLabelsRoutes(handler) {
  serveHandler = handler;
}

const router = Router();

function handlePublicLabelGet(req, res) {
  if (typeof serveHandler !== "function") {
    return res.status(503).type("text/plain").send("Label service chưa sẵn sàng.");
  }
  return serveHandler(req, res);
}

router.get("/api/public/labels/:filename", handlePublicLabelGet);
router.get("/api/labels/:filename", handlePublicLabelGet);
router.get("/labels/:filename", handlePublicLabelGet);
router.get("/prints/:filename", handlePublicLabelGet);

export default router;
export { router };
