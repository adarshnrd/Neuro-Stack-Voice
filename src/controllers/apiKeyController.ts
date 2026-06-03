import { Request, Response, NextFunction } from 'express';
import apiKeyService, { MAX_API_KEY_LENGTH } from '../services/apiKeyService';

class ApiKeyController {
  async saveKey(req: Request, res: Response, next: NextFunction) {
    try {
      const { provider, apiKey } = req.body;

      if (!provider || !apiKey) {
        res.status(400).json({ success: false, error: 'provider and apiKey are required' });
        return;
      }

      if (typeof apiKey !== 'string' || apiKey.length > MAX_API_KEY_LENGTH) {
        res.status(400).json({ success: false, error: `apiKey must be a string of at most ${MAX_API_KEY_LENGTH} characters` });
        return;
      }

      await apiKeyService.saveKey(provider, apiKey);
      res.json({ success: true, message: 'API key saved successfully' });
    } catch (error: any) {
      if (error.message.includes('Invalid API key') || error.message.includes('Only gemini provider')) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  getStatus(req: Request, res: Response) {
    const provider = (req.query.provider as string) || 'gemini';
    const status = apiKeyService.getKeyStatus(provider);
    res.json({ success: true, data: status });
  }

  async validateKey(req: Request, res: Response, next: NextFunction) {
    try {
      const { provider, apiKey } = req.body;

      if (!provider || !apiKey) {
        res.status(400).json({ success: false, error: 'provider and apiKey are required' });
        return;
      }

      if (typeof apiKey !== 'string' || apiKey.length > MAX_API_KEY_LENGTH) {
        res.status(400).json({ success: false, error: `apiKey must be a string of at most ${MAX_API_KEY_LENGTH} characters` });
        return;
      }

      const isValid = await apiKeyService.validateKey(provider, apiKey);
      res.json({ success: true, data: { isValid } });
    } catch (error: any) {
      if (error.message.includes('Only gemini provider')) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      next(error);
    }
  }

  removeKey(req: Request, res: Response) {
    const provider = (req.query.provider as string) || 'gemini';
    apiKeyService.removeKey(provider);
    res.json({ success: true, message: 'API key removed' });
  }
}

export default new ApiKeyController();
