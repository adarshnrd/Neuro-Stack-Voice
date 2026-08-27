import { Router } from 'express';
import interviewController from '../controllers/interview.controller';
import { validateBody, validateUuidParam } from '../middleware/validate';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── Public reference data — no user data involved ──
router.get('/tech-stacks', interviewController.getTechStacks);
router.get('/models', interviewController.getModels);
router.get('/config', interviewController.getConfig);

// ── Everything below touches a specific user's interview data ──
router.post(
  '/start',
  requireAuth,
  validateBody({
    techStack: { required: true, type: 'string', maxLength: 200 },
    model: { required: true, type: 'string', maxLength: 100 },
  }),
  interviewController.start
);

router.post('/:sessionId/extend', requireAuth, validateUuidParam('sessionId'), interviewController.extend);

router.get('/history', requireAuth, interviewController.getHistory);

router.get('/:sessionId', requireAuth, validateUuidParam('sessionId'), interviewController.getSessionDetail);

export default router;
