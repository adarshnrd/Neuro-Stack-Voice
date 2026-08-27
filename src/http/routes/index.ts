import { Router } from 'express';
import authRoutes from './auth.routes';
import interviewRoutes from './interview.routes';
import apiKeyRoutes from './apiKey.routes';
import { health } from '../controllers/health.controller';

const router = Router();

router.get('/health', health);
router.use('/auth', authRoutes);
router.use('/interviews', interviewRoutes);
router.use('/settings/api-key', apiKeyRoutes);

export default router;
