import { signAdminToken } from "../middlewares/auth.js";

/**
 * POST /api/login
 */
export function login(req, res) {
  const { username, password } = req.body;
  const expectedUsername = process.env.ADMIN_USERNAME || "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD || "password123";
  if (username === expectedUsername && password === expectedPassword) {
    const token = signAdminToken(username);
    return res.json({ token, username });
  } else {
    return res.status(401).json({
      error: "Tên đăng nhập hoặc mật khẩu không chính xác.",
    });
  }
}

/**
 * GET /api/auth/verify
 */
export async function verifyAuth(req, res) {
  if (!req.user || !req.user.username) {
    return res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
  res.json({ valid: true, username: req.user.username });
}
