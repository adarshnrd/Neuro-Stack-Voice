import { BaseAIService } from './baseService';
import { GeminiService } from './geminiService';
import { GroqService } from './groqService';
import { NvidiaService } from './nvidiaService';
import { ResolvedModel } from '../../types';
import config from '../../config/config';

class AIFactory {
  /**
   * Resolves a model ID to its provider string. The actual underlying model
   * string for Groq/NVIDIA comes from config (env-overridable) rather than
   * being hardcoded here, since providers deprecate/rename models on their
   * own schedule — see config.ts's `ai.groqModel`/`ai.nvidiaModel` comments.
   */
  resolveModelInfo(modelId: string): ResolvedModel {
    if (modelId.startsWith('gemini')) return { provider: 'google', model: modelId };
    if (modelId === 'groq') return { provider: 'groq', model: config.ai.groqModel };
    if (modelId.startsWith('llama') || modelId.startsWith('openai/') || modelId.startsWith('qwen/')) {
      return { provider: 'groq', model: modelId };
    }
    if (modelId === 'nvidia') return { provider: 'nvidia', model: config.ai.nvidiaModel };
    if (modelId.startsWith('nvidia/')) return { provider: 'nvidia', model: modelId };

    // Default fallback (failsafe)
    return { provider: 'groq', model: config.ai.groqModel };
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
   * Ordered list of every AI provider service instance worth trying for a
   * request, starting from `startModelId`'s own provider — see
   * docs/project-improvement/RICH_EVALUATION_SCALE_PLAN.md §1/§9. Replaces
   * the old "primary, then exactly one fallback" pair (getFallbackService /
   * resolveFallbackModelId): a caller now retries (via withRetry) against
   * each entry in this chain in order until one succeeds or the chain is
   * exhausted, so a real outage on the SECOND provider tried no longer
   * means giving up with two providers still configured and unused.
   *
   * Only providers with credentials actually configured are included —
   * there's no point queuing a call that will just 503 on
   * "…_API_KEY is not configured". Each provider appears at most once
   * (by provider, not by model id), even if it's also the starting model's
   * own provider.
   */
  getProviderChain(startModelId: string, userApiKey?: string): { modelId: string; service: BaseAIService }[] {
    const isConfigured = (provider: string): boolean => {
      if (provider === 'groq') return !!config.ai.groqKey;
      if (provider === 'google') return !!(userApiKey || config.ai.geminiKey);
      if (provider === 'nvidia') return !!config.ai.nvidiaKey;
      return false;
    };

    const startInfo = this.resolveModelInfo(startModelId);
    const candidates: { modelId: string; provider: string }[] = [
      { modelId: startModelId, provider: startInfo.provider },
      { modelId: 'groq', provider: 'groq' },
      { modelId: config.ai.geminiFallbackModel, provider: 'google' },
      { modelId: 'nvidia', provider: 'nvidia' },
    ];

    const seenProviders = new Set<string>();
    const chain: { modelId: string; service: BaseAIService }[] = [];
    for (const c of candidates) {
      if (seenProviders.has(c.provider) || !isConfigured(c.provider)) continue;
      seenProviders.add(c.provider);
      chain.push({ modelId: c.modelId, service: this.getService(c.modelId, c.provider === 'google' ? userApiKey : undefined) });
    }
    return chain;
  }
}

export default new AIFactory();
