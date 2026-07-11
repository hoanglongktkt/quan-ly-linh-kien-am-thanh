import jwt from 'jsonwebtoken';
import { getJwtSecret } from './lib/jwtSecret.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { username, password } = req.body || {};
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const expectedPassword = process.env.ADMIN_PASSWORD || 'password123';

  if (username === expectedUsername && password === expectedPassword) {
    const token = jwt.sign({ username }, getJwtSecret(), { expiresIn: '24h' });
    return res.status(200).json({ token, username });
  }

  return res.status(401).json({
    error: 'Tên đăng nhập hoặc mật khẩu không chính xác.',
  });
}
