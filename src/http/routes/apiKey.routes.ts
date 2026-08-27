import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import apiKeyController from '../controllers/apiKey.controller';
import { requireAuth } from '../middleware/auth';

const router = Router();

// Rate limiter for validation — this hits the upstream Gemini API per call.
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

// Every route here is scoped to req.user.id — see requireAuth. Previously
// these routes had no auth at all and mutated a single process-global key
// shared by every visitor.
router.use(requireAuth);

router.post('/', apiKeyController.saveKey);
router.get('/status', apiKeyController.getStatus);
router.post('/validate', rateLimiter, apiKeyController.validateKey);
router.delete('/', apiKeyController.removeKey);

export default router;
