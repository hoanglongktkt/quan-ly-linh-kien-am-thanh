export function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.VERCEL) {
    console.warn('[JWT] JWT_SECRET chưa set trên Vercel — token sẽ không khớp backend cPanel. Set cùng giá trị với cPanel (.htaccess / Node env).');
  }
  return secret || 'omnisales-vn-super-secret-key-2026';
}
