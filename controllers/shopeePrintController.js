/**
 * Controllers: Shopee print-document (+ async job map shared từ server).
 * Phase 6 — HTTP layer tách; printDocumentHandler inject qua deps.
 */
let deps = {
  printDocumentHandler: null,
  printDocumentJobs: new Map(),
  createPrintDocumentJobId: () => `print-${Date.now()}`,
  pruneOldPrintDocumentJobs: () => {},
};

export function initShopeePrintController(partial) {
  deps = { ...deps, ...partial };
}

export function getPrintDocumentJobs() {
  return deps.printDocumentJobs;
}

/** POST /api/shopee/print-document */
export async function printDocument(req, res) {
  if (typeof deps.printDocumentHandler !== "function") {
    return res.status(500).json({ success: false, message: "printDocumentHandler chưa khởi tạo" });
  }
  return deps.printDocumentHandler(req, res);
}

/** POST /api/shopee/print-document/async */
export async function printDocumentAsync(req, res) {
  try {
    const { orderIds } = req.body || {};
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return res.status(400).json({ error: "Thiếu danh sách orderIds." });
    }
    if (typeof deps.printDocumentHandler !== "function") {
      return res.status(500).json({ success: false, message: "printDocumentHandler chưa khởi tạo" });
    }
    deps.pruneOldPrintDocumentJobs();
    const jobId = deps.createPrintDocumentJobId();
    deps.printDocumentJobs.set(jobId, {
      id: jobId,
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const fakeReq = { body: req.body, printJob: deps.printDocumentJobs.get(jobId) };
    setImmediate(() => {
      void (async () => {
        const job = deps.printDocumentJobs.get(jobId);
        if (!job) return;
        job.status = "running";
        job.updatedAt = Date.now();
        let capturedStatus = 200;
        const fakeRes = {
          status(code) {
            capturedStatus = code;
            return this;
          },
          json(body) {
            job.httpStatus = capturedStatus;
            job.result = body;
            job.status = capturedStatus >= 200 && capturedStatus < 300 ? "done" : "failed";
            job.updatedAt = Date.now();
            return this;
          },
        };
        try {
          await deps.printDocumentHandler(fakeReq, fakeRes);
        } catch (err) {
          job.status = "failed";
          job.error = err?.message || String(err);
          job.httpStatus = 500;
          job.result = { error: err?.message || String(err) };
          job.updatedAt = Date.now();
        }
      })();
    });

    return res.status(202).json({ accepted: true, jobId });
  } catch (error) {
    console.error("[Print Document Async] Lỗi nội bộ:", error?.stack || error);
    return res.status(500).json({ success: false, message: "Lỗi nội bộ server: " + error.message });
  }
}

/** GET /api/shopee/print-document/job/:jobId */
export async function getPrintDocumentJob(req, res) {
  deps.pruneOldPrintDocumentJobs();
  const job = deps.printDocumentJobs.get(String(req.params.jobId || ""));
  if (!job) {
    return res.status(404).json({
      error: "job_not_found",
      message: "Không tìm thấy tiến trình in vận đơn.",
    });
  }
  return res.json(job);
}
