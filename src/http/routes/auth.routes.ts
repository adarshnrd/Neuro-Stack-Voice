import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import authController from '../controllers/auth.controller';
import { validateBody } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Tight limiter on credential-guessing surfaces — 100 req/15min at the
// app-wide layer is far too loose for login/register.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
});

router.post(
  '/register',
  authLimiter,
  validateBody({
    email: { required: true, type: 'string', email: true, maxLength: 254 },
    password: { required: true, type: 'string', minLength: 8, maxLength: 256 },
  }),
  authController.register
);

router.post(
  '/login',
  authLimiter,
  validateBody({
    email: { required: true, type: 'string', maxLength: 254 },
    password: { required: true, type: 'string', maxLength: 256 },
  }),
  authController.login
);

router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

export default router;
