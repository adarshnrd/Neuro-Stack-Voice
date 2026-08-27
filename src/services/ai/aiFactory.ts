import { BaseAIService } from './baseService';
import { GeminiService } from './geminiService';
import { GroqService } from './groqService';
import { NvidiaService } from './nvidiaService';
import { ResolvedModel } from '../../types';

class AIFactory {
  /**
   * Resolves a model ID to its provider string.
   */
  resolveModelInfo(modelId: string): ResolvedModel {
    if (modelId.startsWith('gemini')) return { provider: 'google', model: modelId };
    if (modelId === 'groq') return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
    if (modelId.startsWith('llama')) return { provider: 'groq', model: modelId };
    if (modelId === 'nvidia') return { provider: 'nvidia', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning' };
    if (modelId.startsWith('nvidia/')) return { provider: 'nvidia', model: modelId };

    // Default fallback (failsafe)
    return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
  }

  /**
   * Returns a NEW AI service instance bound to the resolved model (and, for
   * Gemini, the caller-supplied API key if any). A fresh instance per call
   * means concurrent requests can never see each other's model or key —
   * see the class doc on BaseAIService for the bug this replaces.
   */
  getService(modelId: string, userApiKey?: string): BaseAIService {
    const info = this.resolveModelInfo(modelId);

    switch (info.provider) {
      case 'google':
        return new GeminiService(info.model, userApiKey);
      case 'nvidia':
        return new NvidiaService(info.model);
      case 'groq':
      default:
        return new GroqService(info.model);
    }
  }

  /**
   * Provides an alternative service instance when the primary fails.
   */
  getFallbackService(failedModelId: string, userApiKey?: string): BaseAIService {
    const info = this.resolveModelInfo(failedModelId);

    if (info.provider === 'google') {
      // If Gemini fails, try Groq Llama
      return new GroqService('llama-3.3-70b-versatile');
    }
    // If Groq/Nvidia fails, try Gemini Flash
    return new GeminiService('gemini-3.5-flash', userApiKey);
  }
}

export default new AIFactory();
