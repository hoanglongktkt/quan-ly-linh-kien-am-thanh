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

  // CORS cơ bản cho FE (Vercel / localhost)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      (/vercel\.app$/i.test(origin) ||
        /linhkienamthanh\.net$/i.test(origin) ||
        /^http:\/\/localhost(:\d+)?$/i.test(origin))
    ) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      message: "OK",
      service: "scan-mvc",
      mongo: Boolean(
        process.env.MONGODB_URI || process.env.MONGO_URL || process.env.MONGO_URI,
      ),
    });
  });

  app.post("/api/scan/save", async (req, res, next) => {
    try {
      const { saveScanOrders } = await import("./controllers/scanController.js");
      return saveScanOrders(req, res);
    } catch (err) {
      return next(err);
    }
  });
  app.get("/api/scan/don-hoan-huy", async (req, res, next) => {
    try {
      const { listDonHoanHuy } = await import("./controllers/scanController.js");
      return listDonHoanHuy(req, res);
    } catch (err) {
      return next(err);
    }
  });
  app.use("/api/scan", scanRoutes);

  app.use(errorHandler);

  try {
    await connectDB();
  } catch (err) {
    console.error("[Boot] MongoDB connect failed:", err?.message || err);
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] MVC scan API listening on :${PORT}`);
  });
}

start().catch((err) => {
  console.error("[Boot] Fatal:", err);
  process.exit(1);
});
