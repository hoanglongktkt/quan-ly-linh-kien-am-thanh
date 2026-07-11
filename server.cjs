var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_express = __toESM(require("express"), 1);
var import_path = __toESM(require("path"), 1);
var import_vite = require("vite");
var import_genai = require("@google/genai");
var import_dotenv = __toESM(require("dotenv"), 1);
var import_jsonwebtoken = __toESM(require("jsonwebtoken"), 1);
import_dotenv.default.config();
var JWT_SECRET = process.env.JWT_SECRET || "omnisales-vn-super-secret-key-2026";
var authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Y\xEAu c\u1EA7u cung c\u1EA5p Token x\xE1c th\u1EF1c h\u1EE3p l\u1EC7." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decoded = import_jsonwebtoken.default.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Token kh\xF4ng h\u1EE3p l\u1EC7 ho\u1EB7c \u0111\xE3 h\u1EBFt h\u1EA1n." });
  }
};
async function startServer() {
  const app = (0, import_express.default)();
  const PORT = process.env.PORT || 3e3;
  app.use(import_express.default.json());
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const expectedUsername = process.env.ADMIN_USERNAME || "admin";
    const expectedPassword = process.env.ADMIN_PASSWORD || "password123";
    if (username === expectedUsername && password === expectedPassword) {
      const token = import_jsonwebtoken.default.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
      return res.json({ token, username });
    } else {
      return res.status(401).json({ error: "T\xEAn \u0111\u0103ng nh\u1EADp ho\u1EB7c m\u1EADt kh\u1EA9u kh\xF4ng ch\xEDnh x\xE1c." });
    }
  });
  app.get("/api/auth/verify", authMiddleware, (req, res) => {
    res.json({ valid: true, username: req.user.username });
  });
  let ai = null;
  if (process.env.GEMINI_API_KEY) {
    ai = new import_genai.GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
  } else {
    console.warn("Warning: GEMINI_API_KEY is not configured in .env");
  }
  app.post("/api/gemini/optimize", authMiddleware, async (req, res) => {
    try {
      const { action, text, context } = req.body;
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(503).json({
          error: "Ch\u01B0a c\u1EA5u h\xECnh API Key c\u1EE7a Gemini AI. Vui l\xF2ng c\xE0i \u0111\u1EB7t trong m\u1EE5c Settings ho\u1EB7c Secrets."
        });
      }
      if (!ai) {
        ai = new import_genai.GoogleGenAI({
          apiKey,
          httpOptions: {
            headers: {
              "User-Agent": "aistudio-build"
            }
          }
        });
      }
      let prompt = "";
      if (action === "optimize-title") {
        prompt = `B\u1EA1n l\xE0 m\u1ED9t chuy\xEAn gia t\u1ED1i \u01B0u h\xF3a SEO tr\xEAn Shopee v\xE0 TikTok Shop t\u1EA1i Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt l\u1EA1i ti\xEAu \u0111\u1EC1 s\u1EA3n ph\u1EA9m sau \u0111\xE2y \u0111\u1EC3 thu h\xFAt kh\xE1ch h\xE0ng, k\xEDch th\xEDch click, t\u0103ng t\u1EF7 l\u1EC7 chuy\u1EC3n \u0111\u1ED5i v\xE0 ch\u1EE9a c\xE1c t\u1EEB kh\xF3a t\xECm ki\u1EBFm ph\u1ED5 bi\u1EBFn (SEO).
Ti\xEAu \u0111\u1EC1 g\u1ED1c: "${text}"
${context ? `Y\xEAu c\u1EA7u th\xEAm: ${context}` : ""}

Quy t\u1EAFc vi\u1EBFt ti\xEAu \u0111\u1EC1:
- \u0110\u1ED9 d\xE0i t\u1EEB 50-120 k\xFD t\u1EF1.
- Vi\u1EBFt hoa ch\u1EEF c\xE1i \u0111\u1EA7u c\u1EE7a m\u1ED7i t\u1EEB quan tr\u1ECDng (nh\u01B0 t\xEAn th\u01B0\u01A1ng hi\u1EC7u, t\xEDnh n\u0103ng ch\xEDnh).
- Ch\u1EE9a th\u01B0\u01A1ng hi\u1EC7u, ch\u1EA5t li\u1EC7u, dung t\xEDch/k\xEDch th\u01B0\u1EDBc, c\xF4ng d\u1EE5ng n\u1ED5i b\u1EADt.
- KH\xD4NG d\xF9ng k\xFD t\u1EF1 \u0111\u1EB7c bi\u1EC7t g\xE2y l\u1ED7i t\xECm ki\u1EBFm.
- Ch\u1EC9 tr\u1EA3 v\u1EC1 danh s\xE1ch 3 ph\u01B0\u01A1ng \xE1n ti\xEAu \u0111\u1EC1 t\u1ED1i \u01B0u nh\u1EA5t d\u01B0\u1EDBi d\u1EA1ng danh s\xE1ch, m\u1ED7i ph\u01B0\u01A1ng \xE1n tr\xEAn 1 d\xF2ng. Kh\xF4ng gi\u1EA3i th\xEDch th\xEAm.`;
      } else if (action === "generate-description") {
        prompt = `B\u1EA1n l\xE0 m\u1ED9t chuy\xEAn gia Copywriter vi\u1EBFt b\xE0i m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m b\xE1n h\xE0ng (Product Description) \u0111\u1EC9nh cao tr\xEAn s\xE0n th\u01B0\u01A1ng m\u1EA1i \u0111i\u1EC7n t\u1EED Shopee v\xE0 TikTok Shop Vi\u1EC7t Nam.
H\xE3y vi\u1EBFt m\u1ED9t b\xE0i m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m chi ti\u1EBFt, chuy\xEAn nghi\u1EC7p, thu h\xFAt ng\u01B0\u1EDDi mua d\u1EF1a tr\xEAn th\xF4ng tin s\u1EA3n ph\u1EA9m sau \u0111\xE2y.
T\xEAn s\u1EA3n ph\u1EA9m: "${text}"
${context ? `Th\xF4ng tin b\u1ED5 sung / Gi\xE1 c\u1EA3 / T\xEDnh n\u0103ng: ${context}` : ""}

C\u1EA5u tr\xFAc b\xE0i vi\u1EBFt m\xF4 t\u1EA3 s\u1EA3n ph\u1EA9m c\u1EA7n c\xF3:
1. Slogan thu h\xFAt & Gi\u1EDBi thi\u1EC7u ng\u1EAFn v\u1EC1 s\u1EA3n ph\u1EA9m.
2. C\xE1c \u0111\u1EB7c \u0111i\u1EC3m n\u1ED5i b\u1EADt nh\u1EA5t (g\u1EA1ch \u0111\u1EA7u d\xF2ng d\u1EC5 \u0111\u1ECDc).
3. Th\xF4ng s\u1ED1 k\u1EF9 thu\u1EADt / H\u01B0\u1EDBng d\u1EABn s\u1EED d\u1EE5ng chi ti\u1EBFt.
4. Cam k\u1EBFt c\u1EE7a Shop (H\xE0ng ch\xEDnh h\xE3ng, b\u1EA3o h\xE0nh, \u0111\u1ED5i tr\u1EA3 1-1 trong 7 ng\xE0y).
5. Hashtag li\xEAn quan chu\u1EA9n SEO (8-12 hashtags \u1EDF cu\u1ED1i b\xE0i, v\xED d\u1EE5: #noichien #giadung).

Phong c\xE1ch vi\u1EBFt: Th\xE2n thi\u1EC7n, thuy\u1EBFt ph\u1EE5c, \u0111\xE1ng tin c\u1EADy. \u0110\u1ECBnh d\u1EA1ng Markdown \u0111\u1EB9p m\u1EAFt, ph\xE2n c\u1EA5p r\xF5 r\xE0ng. H\xE3y ch\u1EC9 tr\u1EA3 v\u1EC1 b\xE0i vi\u1EBFt m\xF4 t\u1EA3 b\u1EB1ng Markdown. Kh\xF4ng ch\xE0o h\u1ECFi hay gi\u1EA3i th\xEDch th\xEAm.`;
      } else if (action === "suggest-prices") {
        const importP = typeof context === "object" ? context.importPrice : 0;
        const sellP = typeof context === "object" ? context.sellingPrice : 0;
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia c\u1ED1 v\u1EA5n t\xE0i ch\xEDnh v\xE0 \u0111\u1ECBnh gi\xE1 s\u1EA3n ph\u1EA9m E-commerce tr\xEAn Shopee & TikTok Shop.
D\u1EF1a tr\xEAn th\xF4ng tin s\u1EA3n ph\u1EA9m n\xE0y:
T\xEAn s\u1EA3n ph\u1EA9m: "${text}"
Gi\xE1 nh\u1EADp g\u1ED1c: ${importP.toLocaleString("vi-VN")} VN\u0110.
Gi\xE1 b\xE1n d\u1EF1 ki\u1EBFn hi\u1EC7n t\u1EA1i: ${sellP.toLocaleString("vi-VN")} VN\u0110.

H\xE3y t\xEDnh to\xE1n v\xE0 ph\xE2n t\xEDch chi ti\u1EBFt b\u1EB1ng ti\u1EBFng Vi\u1EC7t:
1. T\u1EF7 su\u1EA5t l\u1EE3i nhu\u1EADn g\u1ED9p (Gross Profit Margin %) c\u1EE7a gi\xE1 b\xE1n d\u1EF1 ki\u1EBFn hi\u1EC7n t\u1EA1i.
2. \u0110\u1EC1 xu\u1EA5t 3 m\u1EE9c gi\xE1 b\xE1n t\u1ED1i \u01B0u (Gi\xE1 th\xE2m nh\u1EADp th\u1ECB tr\u01B0\u1EDDng, Gi\xE1 t\u1ED1i \u0111a h\xF3a l\u1EE3i nhu\u1EADn, Gi\xE1 khuy\u1EBFn m\xE3i Flash Sale) k\xE8m ph\xE2n t\xEDch l\u1EE3i nhu\u1EADn th\u1EF1c t\u1EBF (\u0111\xE3 tr\u1EEB kho\u1EA3ng 10-12% ph\xED s\xE0n Shopee/TikTok th\xF4ng th\u01B0\u1EDDng bao g\u1ED3m ph\xED thanh to\xE1n, ph\xED c\u1ED1 \u0111\u1ECBnh, ph\xED Freeship Xtra).
3. Ph\xE2n t\xEDch t\xEDnh c\u1EA1nh tranh c\u1EE7a gi\xE1 nh\u1EADp v\xE0 \u0111\u1EC1 xu\u1EA5t chi\u1EBFn l\u01B0\u1EE3c t\u1ED1i \u01B0u chi ph\xED hi\u1EC7u qu\u1EA3.

H\xE3y tr\u1EA3 v\u1EC1 k\u1EBFt qu\u1EA3 chi ti\u1EBFt b\u1EB1ng ti\u1EBFng Vi\u1EC7t, vi\u1EBFt ng\u1EAFn g\u1ECDn d\u01B0\u1EDBi d\u1EA1ng Markdown, s\u1EED d\u1EE5ng b\u1EA3ng \u0111\u1EC3 so s\xE1nh r\xF5 r\xE0ng c\xE1c m\u1EE9c gi\xE1 \u0111\u1EC1 xu\u1EA5t v\xE0 l\u1EE3i nhu\u1EADn th\u1EF1c nh\u1EADn.`;
      } else if (action === "bulk-tag") {
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia t\u1EEB kh\xF3a SEO cho Shopee v\xE0 TikTok Shop t\u1EA1i Vi\u1EC7t Nam.
H\xE3y g\u1EE3i \xFD m\u1ED9t danh s\xE1ch g\u1ED3m 10-15 hashtags b\xE1n ch\u1EA1y nh\u1EA5t li\xEAn quan \u0111\u1EBFn s\u1EA3n ph\u1EA9m: "${text}".
C\xE1c t\u1EEB kh\xF3a ph\u1EA3i ph\xF9 h\u1EE3p v\u1EDBi xu h\u01B0\u1EDBng t\xECm ki\u1EBFm h\xE0ng \u0111\u1EA7u c\u1EE7a ng\u01B0\u1EDDi Vi\u1EC7t.
Tr\u1EA3 v\u1EC1 k\u1EBFt qu\u1EA3 d\u01B0\u1EDBi d\u1EA1ng: c\xE1c hashtags c\xE1ch nhau b\u1EB1ng d\u1EA5u c\xE1ch, k\xE8m theo 3 g\u1EE3i \xFD c\u1EE5m t\u1EEB kh\xF3a t\xECm ki\u1EBFm ch\xEDnh (search volume cao) \u0111\u1EC3 ch\xE8n v\xE0o ph\u1EA7n \u0111\u1EA7u ti\xEAu \u0111\u1EC1 ho\u1EB7c m\xF4 t\u1EA3. Tr\u1EA3 v\u1EC1 d\u01B0\u1EDBi d\u1EA1ng v\u0103n b\u1EA3n Markdown ng\u1EAFn g\u1ECDn.`;
      } else if (action === "avoid-duplication-title") {
        prompt = `B\u1EA1n l\xE0 chuy\xEAn gia t\u01B0 v\u1EA5n SEO v\xE0 b\xE1n h\xE0ng th\u01B0\u01A1ng m\u1EA1i \u0111i\u1EC7n t\u1EED chuy\xEAn nghi\u1EC7p t\u1EA1i Vi\u1EC7t Nam.
Nhi\u1EC7m v\u1EE5 c\u1EE7a b\u1EA1n l\xE0 vi\u1EBFt l\u1EA1i t\xEAn s\u1EA3n ph\u1EA9m g\u1ED1c th\xE0nh 3 ph\u01B0\u01A1ng \xE1n ti\xEAu \u0111\u1EC1 kh\xE1c nhau ho\xE0n to\xE0n v\u1EC1 m\u1EB7t c\u1EA5u tr\xFAc ch\u1EEF vi\u1EBFt v\xE0 c\u1EE5m t\u1EEB b\u1ED5 tr\u1EE3, nh\u01B0ng v\u1EABn gi\u1EEF nguy\xEAn b\u1EA3n ch\u1EA5t s\u1EA3n ph\u1EA9m \u0111\u1EC3 \u0111\u0103ng l\xEAn nhi\u1EC1u gian h\xE0ng kh\xE1c nhau (Shopee, TikTok, Lazada) m\xE0 KH\xD4NG b\u1ECB qu\xE9t tr\xF9ng l\u1EB7p n\u1ED9i dung (tr\xE1nh thu\u1EADt to\xE1n spam/duplicate listings).

Ti\xEAu \u0111\u1EC1 g\u1ED1c: "${text}"
${context ? `T\u1EEB kh\xF3a/Y\xEAu c\u1EA7u th\xEAm: ${context}` : ""}

Quy t\u1EAFc t\u1ED1i \u01B0u h\xF3a ch\u1ED1ng tr\xF9ng l\u1EB7p:
- Ph\u01B0\u01A1ng \xE1n 1 (S\u1EED d\u1EE5ng c\u1EE5m t\u1EEB gi\u1EADt t\xEDt \u0111\u1EA7u trang, c\u1EA5u tr\xFAc k\u1EF9 thu\u1EADt): V\xED d\u1EE5: "[Ch\xEDnh H\xE3ng] + T\xEAn s\u1EA3n ph\u1EA9m + Th\xF4ng s\u1ED1 k\u1EF9 thu\u1EADt n\u1ED5i b\u1EADt + C\xF4ng d\u1EE5ng ch\xEDnh".
- Ph\u01B0\u01A1ng \xE1n 2 (\u0110\xE1nh v\xE0o gi\xE1 tr\u1ECB/m\xF4 t\u1EA3 c\u1EA3m x\xFAc ng\u01B0\u1EDDi mua, qu\xE0 t\u1EB7ng k\xE8m): V\xED d\u1EE5: "T\xEAn s\u1EA3n ph\u1EA9m + [T\u1EB7ng K\xE8m Qu\xE0 / Freeship Xtra] + Ph\xE2n lo\u1EA1i/M\xE0u s\u1EAFc hot + B\u1EA3o h\xE0nh 12T".
- Ph\u01B0\u01A1ng \xE1n 3 (T\u1EADp trung t\u1EEB kh\xF3a SEO ng\xE1ch, ph\xE2n kh\xFAc \u0111\u1ED1i t\u01B0\u1EE3ng): V\xED d\u1EE5: "T\xEAn s\u1EA3n ph\u1EA9m + Gi\u1EA3i ph\xE1p cho... + Ch\u1EA5t li\u1EC7u + [\u1EA2nh Th\u1EADt T\u1EF1 Ch\u1EE5p]".
- \u0110\u1EA3m b\u1EA3o \u0111\u1ED9 d\xE0i m\u1ED7i ti\xEAu \u0111\u1EC1 t\u1EEB 75 \u0111\u1EBFn 115 k\xFD t\u1EF1.
- Ch\u1EE9a c\xE1c t\u1EEB kh\xF3a \u0111\u1ED3ng ngh\u0129a phong ph\xFA \u0111\u1EC3 c\xF4ng c\u1EE5 t\xECm ki\u1EBFm kh\xF4ng nh\u1EADn d\u1EA1ng tr\xF9ng l\u1EB7p.
- Ch\u1EC9 tr\u1EA3 v\u1EC1 danh s\xE1ch \u0111\xFAng 3 d\xF2ng ti\xEAu \u0111\u1EC1 \u0111\xE3 ch\u1EC9nh s\u1EEDa, m\u1ED7i d\xF2ng m\u1ED9t ph\u01B0\u01A1ng \xE1n, kh\xF4ng c\xF3 s\u1ED1 th\u1EE9 t\u1EF1 \u1EDF \u0111\u1EA7u d\xF2ng, kh\xF4ng gi\u1EA3i th\xEDch th\xEAm b\u1EA5t k\u1EF3 \u0111i\u1EC1u g\xEC.`;
      } else {
        return res.status(400).json({ error: "H\xE0nh \u0111\u1ED9ng kh\xF4ng h\u1EE3p l\u1EC7." });
      }
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt
      });
      return res.json({ result: response.text });
    } catch (error) {
      console.error("Gemini API Error:", error);
      return res.status(500).json({ error: error.message || "L\u1ED7i x\u1EED l\xFD AI t\u1EEB server" });
    }
  });
  if (process.env.NODE_ENV !== "production") {
    const vite = await (0, import_vite.createServer)({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = import_path.default.join(process.cwd(), "dist");
    app.use(import_express.default.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(import_path.default.join(distPath, "index.html"));
    });
  }
  if (process.env.PORT) {
    app.listen(PORT, () => {
      console.log(`Server optimized for cPanel Phusion Passenger: listening on ${PORT}`);
    });
  } else {
    app.listen(Number(PORT), "0.0.0.0", () => {
      console.log(`Server running locally on port ${PORT}`);
    });
  }
}
startServer();
//# sourceMappingURL=server.cjs.map
