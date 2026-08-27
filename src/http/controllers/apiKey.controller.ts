import { Request, Response, NextFunction } from 'express';
import apiKeyService, { MAX_API_KEY_LENGTH } from '../../services/apiKey.service';
import { AppError } from '../../utils/appError';

function requireUserId(req: Request): string {
  if (!req.user) throw new AppError('Authentication required', 401);
  return req.user.id;
}

class ApiKeyController {
  async saveKey(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = requireUserId(req);
      const { provider, apiKey } = req.body;

      if (!provider || !apiKey) {
        res.status(400).json({ success: false, error: 'provider and apiKey are required' });
        return;
      }
      if (typeof apiKey !== 'string' || apiKey.length > MAX_API_KEY_LENGTH) {
        res
          .status(400)
          .json({ success: false, error: `apiKey must be a string of at most ${MAX_API_KEY_LENGTH} characters` });
        return;
      }

      await apiKeyService.saveKey(userId, provider, apiKey);
      res.json({ success: true, message: 'API key saved successfully' });
    } catch (error) {
      next(error);
    }
  }

  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = requireUserId(req);
      const provider = (req.query.provider as string) || 'gemini';
      const status = await apiKeyService.getKeyStatus(userId, provider);
      res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  }

  async validateKey(req: Request, res: Response, next: NextFunction) {
    try {
      const { provider, apiKey } = req.body;

      if (!provider || !apiKey) {
        res.status(400).json({ success: false, error: 'provider and apiKey are required' });
        return;
      }
      if (typeof apiKey !== 'string' || apiKey.length > MAX_API_KEY_LENGTH) {
        res
          .status(400)
          .json({ success: false, error: `apiKey must be a string of at most ${MAX_API_KEY_LENGTH} characters` });
        return;
      }

      const isValid = await apiKeyService.validateKey(provider, apiKey);
      res.json({ success: true, data: { isValid } });
    } catch (error) {
      next(error);
    }
  }

  async removeKey(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = requireUserId(req);
      const provider = (req.query.provider as string) || 'gemini';
      await apiKeyService.removeKey(userId, provider);
      res.json({ success: true, message: 'API key removed' });
    } catch (error) {
      next(error);
    }
  }
}

export default new ApiKeyController();
