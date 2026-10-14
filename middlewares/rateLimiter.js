/**
 * Rate limiting middleware để chống brute force attacks
 */
import rateLimit from 'express-rate-limit';

/**
 * Login rate limiter - 5 attempts per 15 minutes
 */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 5, // Tối đa 5 attempts
  message: {
    error: 'Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau 15 phút.',
    retryAfter: 15 * 60 // seconds
  },
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  // Skip successful logins from count
  skipSuccessfulRequests: true,
  // Use IP + username for more granular limiting
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const username = req.body?.username || 'anonymous';
    return `${ip}:${username}`;
  },
  handler: (req, res) => {
    console.warn(`[Security] Rate limit exceeded for IP: ${req.ip}, username: ${req.body?.username || 'N/A'}`);
    res.status(429).json({
      error: 'Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau 15 phút.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * API rate limiter - 100 requests per 15 minutes
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 phút
  max: 100, // Tối đa 100 requests
  message: {
    error: 'Quá nhiều requests. Vui lòng thử lại sau.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip for authenticated users with valid tokens
  skip: (req) => {
    // Cho phép bypass nếu có valid JWT
    return req.user && req.user.username;
  }
});

/**
 * Strict rate limiter cho system endpoints - 10 requests per hour
 */
export const systemLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 giờ
  max: 10,
  message: {
    error: 'Quá nhiều requests đến system endpoint.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.error(`[Security] System endpoint rate limit exceeded: ${req.path} from IP: ${req.ip}`);
    res.status(429).json({
      error: 'Quá nhiều requests đến system endpoint.',
      retryAfter: Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
    });
  }
});

/**
 * Webhook rate limiter - 1000 requests per minute (cho Shopee webhooks)
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 phút
  max: 1000,
  message: {
    error: 'Webhook rate limit exceeded',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Chỉ apply cho webhooks không có HMAC valid
    return req.shopeeWebhookVerified === true;
  }
});

export default {
  loginLimiter,
  apiLimiter,
  systemLimiter,
  webhookLimiter
};
