import { BaseAIService } from './baseService';
import geminiService from './geminiService';
import groqService from './groqService';
import nvidiaService from './nvidiaService';
import { AppError } from '../../utils/appError';
import { ResolvedModel } from '../../interfaces';

class AIFactory {
  /**
   * Resolves a model ID to its provider string.
   */
  resolveModelInfo(modelId: string): ResolvedModel {
    if (modelId.startsWith('gemini')) return { provider: 'google', model: modelId };
    if (modelId.startsWith('llama') || modelId === 'groq') return { provider: 'groq', model: modelId };
    if (modelId.startsWith('nvidia')) return { provider: 'nvidia', model: modelId };

    // Default fallback (failsafe)
    return { provider: 'groq', model: 'llama-3.3-70b-versatile' };
  }

  /**
   * Returns the appropriate AI service implementation based on the model ID.
   * Sets the model on the service before returning.
   */
  getService(modelId: string, userApiKey?: string): BaseAIService {
    const info = this.resolveModelInfo(modelId);
    let service: BaseAIService;

    switch (info.provider) {
      case 'google':
        service = geminiService;
        break;
      case 'nvidia':
        service = nvidiaService;
        break;
      case 'groq':
      default:
        service = groqService;
        break;
    }

    service.setModel(info.model);
    return service;
  }

  /**
   * Provides an alternative service when the primary fails.
   */
  getFallbackService(failedModelId: string): BaseAIService {
    const info = this.resolveModelInfo(failedModelId);

    // Hardcoded fallback chain to maximize reliability
    if (info.provider === 'google') {
      // If Gemini fails, try Groq Llama
      const svc = groqService;
      svc.setModel('llama-3.3-70b-versatile');
      return svc;
    } else {
      // If Groq/Nvidia fails, try Gemini Flash
      const svc = geminiService;
      svc.setModel('gemini-3.5-flash');
      return svc;
    }
  }
}

export default new AIFactory();
