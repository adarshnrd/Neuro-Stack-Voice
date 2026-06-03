import { Router } from 'express';
import interviewController from '../controllers/interviewController';
import { validateBody, validateUuidParam } from '../middleware/requestValidator';

const router = Router();

router.post(
  '/start',
  validateBody({
    techStack:  { required: true, type: 'string', maxLength: 200 },
    model:      { required: true, type: 'string', maxLength: 100 },
  }),
  interviewController.start
);

router.post(
  '/:sessionId/extend',
  validateUuidParam('sessionId'),
  interviewController.extend
);

router.get('/tech-stacks', interviewController.getTechStacks);
router.get('/models', interviewController.getModels);
router.get('/config', interviewController.getConfig);
router.get('/history', interviewController.getHistory);

router.get(
  '/:sessionId',
  validateUuidParam('sessionId'),
  interviewController.getSessionDetail
);

export default router;
