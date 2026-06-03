import { Router } from 'express';
import apiKeyController from '../controllers/apiKeyController';

const router = Router();

// Rate limiter for validation
import rateLimit from 'express-rate-limit';
const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many validation attempts. Please try again later.',
  },
});

router.post('/', apiKeyController.saveKey);
router.get('/status', apiKeyController.getStatus);
router.post('/validate', rateLimiter, apiKeyController.validateKey);
router.delete('/', apiKeyController.removeKey);

export default router;
