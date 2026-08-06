/**
 * Vercel — GET /api/auth/verify
 * Đồng bộ middlewares/auth + authController (Phase 7).
 */
import { authMiddleware } from '../../middlewares/auth.js';
import { verifyAuth } from '../../controllers/authController.js';

export async function handleAuthVerify(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return new Promise((resolve) => {
    authMiddleware(req, res, () => {
      Promise.resolve(verifyAuth(req, res)).then(resolve).catch((err) => {
        if (!res.headersSent) {
          // Luôn trả 401 — tuyệt đối không để lọt 500 ra ngoài
          res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
        }
        resolve(undefined);
      });
    });
  });
}
