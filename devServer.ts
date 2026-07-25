import type { Express } from "express";
import { createServer as createViteServer } from "vite";

export async function setupDevelopmentMiddleware(app: Express): Promise<void> {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });

  vite.watcher.on("error", (err: Error) => {
    console.warn("[Vite] Watcher error (bỏ qua, server vẫn chạy):", err.message);
  });

  app.use(vite.middlewares);
}
