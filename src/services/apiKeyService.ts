import { encrypt, decrypt } from '../utils/encryption';
import geminiService from './ai/geminiService';

/** Maximum allowed length for an API key string. */
export const MAX_API_KEY_LENGTH = 256;

/**
 * In-memory store for user API keys.
 *
 * LIMITATION: This store is lost on server restart and does not support
 * multi-instance deployments. For production at scale, migrate to the
 * Prisma UserApiKey model defined in the schema.
 */
const storedKeys: Record<string, { encryptedKey: string; isValid: boolean }> = {};

class ApiKeyService {
  async saveKey(provider: string, apiKey: string): Promise<void> {
    if (provider !== 'gemini') {
      throw new Error('Only gemini provider is currently supported for user API keys');
    }

    // Validate the key first
    const isValid = await geminiService.validateApiKey(apiKey);
    if (!isValid) {
      throw new Error('Invalid API key. Please check and try again.');
    }

    // Encrypt and store
    const encryptedKey = encrypt(apiKey);
    storedKeys[provider] = { encryptedKey, isValid: true };
    console.log(`[APIKey] User API key saved for provider: ${provider}`);
  }

  getKeyStatus(provider: string): { hasKey: boolean; isValid: boolean; provider: string } {
    const stored = storedKeys[provider];
    return {
      hasKey: !!stored,
      isValid: stored?.isValid ?? false,
      provider,
    };
  }

  async validateKey(provider: string, apiKey: string): Promise<boolean> {
    if (provider !== 'gemini') {
      throw new Error('Only gemini provider is supported');
    }
    return await geminiService.validateApiKey(apiKey);
  }

  removeKey(provider: string): void {
    delete storedKeys[provider];
    console.log(`[APIKey] User API key removed for provider: ${provider}`);
  }

  /**
   * Get decrypted API key for a provider (internal use only)
   */
  getUserApiKey(provider: string): string | null {
    const stored = storedKeys[provider];
    if (!stored || !stored.isValid) return null;
    try {
      return decrypt(stored.encryptedKey);
    } catch (error) {
      console.error(`[APIKey] Failed to decrypt key for ${provider}:`, error);
      return null;
    }
  }
}

export default new ApiKeyService();
