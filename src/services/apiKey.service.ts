import { encrypt, decrypt } from '../utils/encryption';
import { GeminiService } from './ai/geminiService';
import { prisma } from '../config/database';
import { AppError } from '../utils/appError';
import logger from '../utils/logger';

/** Maximum allowed length for an API key string. */
export const MAX_API_KEY_LENGTH = 256;

const SUPPORTED_PROVIDERS = ['gemini'];

/**
 * Per-user encrypted API key storage, backed by the `UserApiKey` table.
 *
 * Previously this was a single process-global object (`storedKeys`) keyed
 * only by provider name — every visitor to the app shared the exact same
 * stored key, and any visitor could overwrite or delete it for everyone via
 * an unauthenticated POST/DELETE. Scoping storage to `userId` (now that
 * requests are authenticated — see requireAuth) fixes both the leak and the
 * unauthenticated-mutation issue in one change.
 */
class ApiKeyService {
  private assertSupported(provider: string): void {
    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      throw new AppError('Only the gemini provider is currently supported for saved API keys', 400);
    }
  }

  async saveKey(userId: string, provider: string, apiKey: string): Promise<void> {
    this.assertSupported(provider);

    const isValid = await GeminiService.validateApiKey(apiKey);
    if (!isValid) {
      throw new AppError('Invalid API key. Please check and try again.', 400);
    }

    const encryptedKey = encrypt(apiKey);
    await prisma.userApiKey.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, encryptedKey, isValid: true, lastValidated: new Date() },
      update: { encryptedKey, isValid: true, lastValidated: new Date() },
    });
  }

  async getKeyStatus(
    userId: string,
    provider: string
  ): Promise<{ hasKey: boolean; isValid: boolean; provider: string }> {
    const stored = await prisma.userApiKey.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    return {
      hasKey: !!stored,
      isValid: stored?.isValid ?? false,
      provider,
    };
  }

  /** Stateless validation — does not persist anything. */
  async validateKey(provider: string, apiKey: string): Promise<boolean> {
    this.assertSupported(provider);
    return GeminiService.validateApiKey(apiKey);
  }

  async removeKey(userId: string, provider: string): Promise<void> {
    await prisma.userApiKey.deleteMany({ where: { userId, provider } });
  }

  /**
   * Get the decrypted API key for a user+provider (internal use only, e.g.
   * threading into the AI factory for a session). Returns null rather than
   * throwing when absent/invalid so callers can fall back to the system key.
   */
  async getUserApiKey(userId: string, provider: string): Promise<string | null> {
    const stored = await prisma.userApiKey.findUnique({
      where: { userId_provider: { userId, provider } },
    });
    if (!stored || !stored.isValid) return null;
    try {
      return decrypt(stored.encryptedKey);
    } catch (error) {
      logger.error('Failed to decrypt stored API key', {
        userId,
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export default new ApiKeyService();
