import "dotenv/config";
import express from "express";
import { connectDB } from "./config/db.js";
import scanRoutes from "./routes/scanRoutes.js";
import errorHandler from "./middlewares/errorHandler.js";

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  const app = express();

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/api/health", (_req, res) => {
    res.json({ success: true, message: "OK", service: "scan-mvc" });
  });

  app.use("/api/scan", scanRoutes);

  app.use(errorHandler);

  try {
    await connectDB();
  } catch (err) {
    console.error("[Boot] MongoDB connect failed:", err?.message || err);
    // Vẫn listen để health check / trả lỗi JSON rõ ràng từ controller.
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] MVC scan API listening on :${PORT}`);
  });
}

start().catch((err) => {
  console.error("[Boot] Fatal:", err);
  process.exit(1);
});
