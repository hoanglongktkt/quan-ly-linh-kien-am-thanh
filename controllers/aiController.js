import { GoogleGenAI } from "@google/genai";
import {
  getGeminiClient,
  setGeminiClient,
  ensureGeminiClientFromEnv,
} from "./settingsController.js";

function markdownToHtml(text) {
  if (!text) return "";
  if (/<[a-z][\s\S]*>/i.test(text)) return text;
  const lines = text.split("\n");
  const parts = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) {
        parts.push("</ul>");
        inList = false;
      }
      continue;
    }
    if (trimmed.startsWith("### ")) {
      if (inList) {
        parts.push("</ul>");
        inList = false;
      }
      parts.push(`<h3>${trimmed.slice(4)}</h3>`);
    } else if (trimmed.startsWith("## ")) {
      if (inList) {
        parts.push("</ul>");
        inList = false;
      }
      parts.push(`<h2>${trimmed.slice(3)}</h2>`);
    } else if (trimmed.startsWith("# ")) {
      if (inList) {
        parts.push("</ul>");
        inList = false;
      }
      parts.push(`<h1>${trimmed.slice(2)}</h1>`);
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        parts.push("<ul>");
        inList = true;
      }
      parts.push(`<li>${trimmed.replace(/^[-*]\s+/, "")}</li>`);
    } else {
      if (inList) {
        parts.push("</ul>");
        inList = false;
      }
      parts.push(`<p>${trimmed}</p>`);
    }
  }
  if (inList) parts.push("</ul>");
  return parts.join("");
}

function ensureAi() {
  let ai = getGeminiClient();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!ai && apiKey) {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    setGeminiClient(ai);
  }
  return ai;
}

/** Boot: khởi tạo client từ env (gọi từ server.ts). */
export { ensureGeminiClientFromEnv };

/** POST /api/gemini/optimize */
export async function geminiOptimize(req, res) {
  try {
    const { action, text, context } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "Chưa cấu hình API Key của Gemini AI. Vui lòng cài đặt trong mục Settings hoặc Secrets.",
      });
    }

    const ai = ensureAi();

    let prompt = "";
    if (action === "optimize-title") {
      prompt = `Bạn là một chuyên gia tối ưu hóa SEO trên Shopee và TikTok Shop tại Việt Nam.
Hãy viết lại tiêu đề sản phẩm sau đây để thu hút khách hàng, kích thích click, tăng tỷ lệ chuyển đổi và chứa các từ khóa tìm kiếm phổ biến (SEO).
Tiêu đề gốc: "${text}"
${context ? `Yêu cầu thêm: ${context}` : ""}

Quy tắc viết tiêu đề:
- Độ dài từ 50-120 ký tự.
- Viết hoa chữ cái đầu của mỗi từ quan trọng (như tên thương hiệu, tính năng chính).
- Chứa thương hiệu, chất liệu, dung tích/kích thước, công dụng nổi bật.
- KHÔNG dùng ký tự đặc biệt gây lỗi tìm kiếm.
- Chỉ trả về danh sách 3 phương án tiêu đề tối ưu nhất dưới dạng danh sách, mỗi phương án trên 1 dòng. Không giải thích thêm.`;
    } else if (action === "generate-description") {
      prompt = `Bạn là một chuyên gia Copywriter viết bài mô tả sản phẩm bán hàng (Product Description) đỉnh cao trên sàn thương mại điện tử Shopee và TikTok Shop Việt Nam.
Hãy viết một bài mô tả sản phẩm chi tiết, chuyên nghiệp, thu hút người mua dựa trên thông tin sản phẩm sau đây.
Tên sản phẩm: "${text}"
${context ? `Thông tin bổ sung / Giá cả / Tính năng: ${context}` : ""}

Cấu trúc bài viết mô tả sản phẩm cần có:
1. Slogan thu hút & Giới thiệu ngắn về sản phẩm.
2. Các đặc điểm nổi bật nhất (gạch đầu dòng dễ đọc).
3. Thông số kỹ thuật / Hướng dẫn sử dụng chi tiết.
4. Cam kết của Shop (Hàng chính hãng, bảo hành, đổi trả 1-1 trong 7 ngày).
5. Hashtag liên quan chuẩn SEO (8-12 hashtags ở cuối bài, ví dụ: #noichien #giadung).

Phong cách viết: Thân thiện, thuyết phục, đáng tin cậy. Định dạng Markdown đẹp mắt, phân cấp rõ ràng. Hãy chỉ trả về bài viết mô tả bằng Markdown. Không chào hỏi hay giải thích thêm.`;
    } else if (action === "suggest-prices") {
      const importP = typeof context === "object" ? context.importPrice : 0;
      const sellP = typeof context === "object" ? context.sellingPrice : 0;
      prompt = `Bạn là chuyên gia cố vấn tài chính và định giá sản phẩm E-commerce trên Shopee & TikTok Shop.
Dựa trên thông tin sản phẩm này:
Tên sản phẩm: "${text}"
Giá nhập gốc: ${importP.toLocaleString("vi-VN")} VNĐ.
Giá bán dự kiến hiện tại: ${sellP.toLocaleString("vi-VN")} VNĐ.

Hãy tính toán và phân tích chi tiết bằng tiếng Việt:
1. Tỷ suất lợi nhuận gộp (Gross Profit Margin %) của giá bán dự kiến hiện tại.
2. Đề xuất 3 mức giá bán tối ưu (Giá thâm nhập thị trường, Giá tối đa hóa lợi nhuận, Giá khuyến mãi Flash Sale) kèm phân tích lợi nhuận thực tế (đã trừ khoảng 10-12% phí sàn Shopee/TikTok thông thường bao gồm phí thanh toán, phí cố định, phí Freeship Xtra).
3. Phân tích tính cạnh tranh của giá nhập và đề xuất chiến lược tối ưu chi phí hiệu quả.

Hãy trả về kết quả chi tiết bằng tiếng Việt, viết ngắn gọn dưới dạng Markdown, sử dụng bảng để so sánh rõ ràng các mức giá đề xuất và lợi nhuận thực nhận.`;
    } else if (action === "bulk-tag") {
      prompt = `Bạn là chuyên gia từ khóa SEO cho Shopee và TikTok Shop tại Việt Nam.
Hãy gợi ý một danh sách gồm 10-15 hashtags bán chạy nhất liên quan đến sản phẩm: "${text}".
Các từ khóa phải phù hợp với xu hướng tìm kiếm hàng đầu của người Việt.
Trả về kết quả dưới dạng: các hashtags cách nhau bằng dấu cách, kèm theo 3 gợi ý cụm từ khóa tìm kiếm chính (search volume cao) để chèn vào phần đầu tiêu đề hoặc mô tả. Trả về dưới dạng văn bản Markdown ngắn gọn.`;
    } else if (action === "avoid-duplication-title") {
      prompt = `Bạn là chuyên gia tư vấn SEO và bán hàng thương mại điện tử chuyên nghiệp tại Việt Nam.
Nhiệm vụ của bạn là viết lại tên sản phẩm gốc thành 3 phương án tiêu đề khác nhau hoàn toàn về mặt cấu trúc chữ viết và cụm từ bổ trợ, nhưng vẫn giữ nguyên bản chất sản phẩm để đăng lên nhiều gian hàng khác nhau (Shopee, TikTok, Lazada) mà KHÔNG bị quét trùng lặp nội dung (tránh thuật toán spam/duplicate listings).

Tiêu đề gốc: "${text}"
${context ? `Từ khóa/Yêu cầu thêm: ${context}` : ""}

Quy tắc tối ưu hóa chống trùng lặp:
- Phương án 1 (Sử dụng cụm từ giật tít đầu trang, cấu trúc kỹ thuật): Ví dụ: "[Chính Hãng] + Tên sản phẩm + Thông số kỹ thuật nổi bật + Công dụng chính".
- Phương án 2 (Đánh vào giá trị/mô tả cảm xúc người mua, quà tặng kèm): Ví dụ: "Tên sản phẩm + [Tặng Kèm Quà / Freeship Xtra] + Phân loại/Màu sắc hot + Bảo hành 12T".
- Phương án 3 (Tập trung từ khóa SEO ngách, phân khúc đối tượng): Ví dụ: "Tên sản phẩm + Giải pháp cho... + Chất liệu + [Ảnh Thật Tự Chụp]".
- Đảm bảo độ dài mỗi tiêu đề từ 75 đến 115 ký tự.
- Chứa các từ khóa đồng nghĩa phong phú để công cụ tìm kiếm không nhận dạng trùng lặp.
- Chỉ trả về danh sách đúng 3 dòng tiêu đề đã chỉnh sửa, mỗi dòng một phương án, không có số thứ tự ở đầu dòng, không giải thích thêm bất kỳ điều gì.`;
    } else {
      return res.status(400).json({ error: "Hành động không hợp lệ." });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    return res.json({ result: response.text });
  } catch (error) {
    console.error("Gemini API Error:", error);
    return res.status(500).json({ error: error.message || "Lỗi xử lý AI từ server" });
  }
}

/** POST /api/ai/parse-address */
export async function parseAddress(req, res) {
  try {
    const { address } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "Chưa cấu hình API Key của Gemini AI.",
      });
    }

    if (!address?.trim()) {
      return res.status(400).json({ error: "Thiếu chuỗi địa chỉ cần phân tích." });
    }

    const ai = ensureAi();

    const prompt = `Bạn là chuyên gia phân tích địa chỉ giao hàng Việt Nam.
Phân tích chuỗi địa chỉ sau và trả về JSON thuần (KHÔNG markdown, KHÔNG giải thích):
{"province":"...","district":"...","ward":"...","street":"..."}

Yêu cầu:
- province: tên Tỉnh/Thành phố chuẩn (VD: "Thành phố Hồ Chí Minh", "Hà Nội")
- district: tên Quận/Huyện/Thị xã chuẩn (VD: "Quận 1", "Huyện Đông Anh")
- ward: tên Phường/Xã/Thị trấn chuẩn
- street: phần địa chỉ chi tiết còn lại (số nhà, tên đường, ngõ ngách)
- Chuẩn hóa viết tắt: HCM/TPHCM -> Thành phố Hồ Chí Minh, Q1 -> Quận 1, P. -> Phường

Địa chỉ cần phân tích: "${String(address).trim()}"`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    const raw = (response.text || "").trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(422).json({ error: "AI không trả về JSON hợp lệ." });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return res.json({
      success: true,
      parsed: {
        province: String(parsed.province || "").trim(),
        district: String(parsed.district || "").trim(),
        ward: String(parsed.ward || "").trim(),
        street: String(parsed.street || "").trim(),
      },
    });
  } catch (error) {
    console.error("[AI parse-address]", error);
    const msg = String(error?.message || "");
    const lower = msg.toLowerCase();
    if (
      lower.includes("api key") ||
      lower.includes("api_key") ||
      lower.includes("invalid api") ||
      (lower.includes("invalid") && lower.includes("key"))
    ) {
      return res.status(401).json({
        error: "Gemini API Key không hợp lệ. Vào Cài đặt → Cấu hình AI để cập nhật key.",
      });
    }
    if (msg.startsWith("{") || msg.includes("GoogleGenerativeAI")) {
      return res.status(502).json({
        error: "AI tạm thời không phản hồi. Vui lòng nhập địa chỉ thủ công hoặc thử lại sau.",
      });
    }
    return res.status(500).json({ error: msg || "Lỗi phân tích địa chỉ AI" });
  }
}

/** POST /api/ai/generate-description */
export async function generateDescription(req, res) {
  try {
    const { title, keywords, context } = req.body || {};
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "Chưa cấu hình API Key của Gemini AI.",
      });
    }

    const ai = ensureAi();

    const prompt = `Bạn là chuyên gia Copywriter viết mô tả sản phẩm bán hàng trên Shopee, Lazada và TikTok Shop Việt Nam.
Hãy viết mô tả sản phẩm dạng HTML (dùng thẻ h2, h3, p, ul, li, strong) — KHÔNG dùng markdown, KHÔNG bọc trong \`\`\`html.
Tên sản phẩm: "${title || ""}"
Từ khóa / Tính năng: "${keywords || ""}"
${context ? `Thông tin thêm: ${context}` : ""}

Cấu trúc: slogan ngắn, đặc điểm nổi bật (ul/li), thông số, cam kết shop, hashtags cuối bài. Chỉ trả về HTML thuần.`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    const raw = (response.text || "").trim();
    const html = markdownToHtml(raw.replace(/^```html\s*/i, "").replace(/```\s*$/i, ""));
    return res.json({ success: true, html });
  } catch (error) {
    console.error("[AI generate-description]", error);
    return res.status(500).json({ error: error.message || "Lỗi tạo mô tả AI" });
  }
}
