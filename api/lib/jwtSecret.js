export function getJwtSecret() {
  return process.env.JWT_SECRET || 'omnisales-vn-super-secret-key-2026';
}
