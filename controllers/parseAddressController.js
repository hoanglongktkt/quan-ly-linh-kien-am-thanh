import { isGeminiConfigured, parseAddressWithGemini } from "../services/geminiService.ts";
import { matchParsedAddressToMaster } from "../services/addressMasterData.ts";

const HANDLER_TIMEOUT_MS = 15_000;
const MATCH_TIMEOUT_MS = 5_000;

function emptyParsed(detail = "") {
  return { province: "", district: "", ward: "", detail };
}

function errorPayload(rawAddress, message) {
  const raw = String(rawAddress || "").trim();
  return {
    success: false,
    fallback: true,
    error: message || "Lỗi AI tách địa chỉ. Vui lòng chọn thủ công.",
    message: message || "Lỗi AI tách địa chỉ. Vui lòng chọn thủ công.",
    raw_address: raw,
    parsed: emptyParsed(raw),
    matched: null,
    ghn: null,
    spx: null,
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) return;
  return res.status(status).json(body);
}

/**
 * POST /api/orders/parse-address
 * Body: { raw_address }
 * Gemini lỗi / timeout → 500 JSON (không để request treo).
 */
export async function parseOrderAddress(req, res) {
  const raw = String(
    req.body?.raw_address || req.body?.rawAddress || req.body?.address || "",
  ).trim();

  if (!raw) {
    return sendJson(res, 400, errorPayload("", "Thiếu raw_address"));
  }

  try {
    if (!isGeminiConfigured()) {
      return sendJson(
        res,
        500,
        errorPayload(raw, "Lỗi AI: chưa cấu hình GEMINI_API_KEY. Vui lòng chọn thủ công."),
      );
    }

    const parsed = await withTimeout(
      parseAddressWithGemini(raw),
      HANDLER_TIMEOUT_MS,
      "PARSE_ADDRESS_TIMEOUT",
    );

    let master = {
      vn: { province: null, district: null, ward: null },
      ghn: null,
      spx: null,
    };
    try {
      master = await withTimeout(
        matchParsedAddressToMaster(parsed),
        MATCH_TIMEOUT_MS,
        "ADDRESS_MATCH_TIMEOUT",
      );
    } catch (matchErr) {
      console.warn("[parse-address] master match:", matchErr?.message || matchErr);
    }

    return sendJson(res, 200, {
      success: true,
      fallback: false,
      raw_address: raw,
      parsed,
      matched: {
        province: master.vn.province,
        district: master.vn.district,
        ward: master.vn.ward,
      },
      ghn: master.ghn,
      spx: master.spx,
    });
  } catch (error) {
    console.error("[parse-address]", error?.message || error);
    const timedOut = String(error?.message || "").includes("TIMEOUT");
    return sendJson(
      res,
      500,
      errorPayload(
        raw,
        timedOut
          ? "Lỗi AI: quá thời gian chờ. Vui lòng chọn thủ công."
          : "Lỗi AI tách địa chỉ. Vui lòng chọn thủ công.",
      ),
    );
  }
}
