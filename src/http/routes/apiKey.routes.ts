import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import apiKeyController from '../controllers/apiKey.controller';
import { requireAuth, attachUserIfPresent } from '../middleware/auth';

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

// /, /status and DELETE / read/write PER-USER stored key state, so they
// stay behind requireAuth — see requireAuth's doc: previously these routes
// had no auth at all and mutated a single process-global key shared by
// every visitor.
//
// /validate is anonymous-friendly (attachUserIfPresent) — see
// docs/audit/01-BACKLOG-P0-P3.md [P3-03] / docs/audit/06-DEFERRED-DECISIONS.md
// §3 (Option A, confirmed): apiKeyController.validateKey is stateless —
// apiKeyService.validateKey persists nothing, it only makes a lightweight
// upstream probe call and reports whether the given key works. Before this,
// it sat behind requireAuth, so a guest pasting their own perfectly valid
// key was told "Invalid API key" — even though /interviews/start already
// accepts a user-supplied key anonymously and the key works there. The
// rate limiter above is the only guard for unauthenticated callers now
// that this is reachable without a session.
router.post('/', requireAuth, apiKeyController.saveKey);
router.get('/status', requireAuth, apiKeyController.getStatus);
router.post('/validate', attachUserIfPresent, rateLimiter, apiKeyController.validateKey);
router.delete('/', requireAuth, apiKeyController.removeKey);

export default router;
