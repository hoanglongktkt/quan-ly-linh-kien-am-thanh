/**
 * CORS allowlist — logic giữ nguyên từ server.ts (Phase 0 extract).
 */
export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const allowedOrigin =
    origin &&
    (/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin) ||
      /^https:\/\/([a-z0-9-]+\.)*linhkienamthanh\.net$/i.test(origin) ||
      /^http:\/\/localhost(:\d+)?$/i.test(origin));
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
}

export default corsMiddleware;
