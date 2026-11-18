import { Router } from 'express';
import { AuthController } from './auth.controller';
import { authMiddleware } from '../../middleware/auth';
import { createRateLimiter } from '../../middleware/rate-limit';

export const loginRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 60 seconds
  max: 5, // 5 requests per IP
  message: 'Too many requests. Please try again later.',
  code: 'TOO_MANY_REQUESTS',
});

export const registerRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 60 minutes
  max: 3, // 3 requests per IP
  message: 'Too many requests. Please try again later.',
  code: 'TOO_MANY_REQUESTS',
});

const router = Router();

router.post('/register', registerRateLimiter, AuthController.register);
router.post('/login', loginRateLimiter, AuthController.login);
router.get('/me', authMiddleware, AuthController.me);
router.post('/logout', authMiddleware, AuthController.logout);

export default router;
