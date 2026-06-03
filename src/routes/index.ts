import { Router } from 'express';
import interviewRoutes from './interviewRoutes';
import apiKeyRoutes from './apiKeyRoutes';

const router = Router();

router.use('/interviews', interviewRoutes);
router.use('/settings/api-key', apiKeyRoutes);

export default router;
