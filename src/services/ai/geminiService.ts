import {
  BaseAIService,
  createTimeoutSignal,
  withRetry,
  validateQuestions,
  validateEvaluation,
  validateFinalEvaluation,
} from './baseService';
import { Question, EvaluationResult, FinalEvaluation, GenerationOptions } from '../../types';
import config from '../../config/config';
import { getQuestionsPrompt, getEvaluationPrompt, getFinalEvaluationPrompt } from '../../utils/promptBuilder';
import { AppError } from '../../utils/appError';

export class GeminiService extends BaseAIService {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  getDefaultModel(): string {
    return 'gemini-3.5-flash';
  }

  /** Precedence: constructor-supplied key (caller's own key) → system config. */
  private resolveApiKey(): string {
    if (this.apiKey) return this.apiKey;
    if (config.ai.geminiKey) return config.ai.geminiKey;
    throw new AppError(
      'GEMINI_API_KEY is not configured. Please set it in .env or provide your own API key.',
      503
    );
  }

  private async makeRequest(content: string): Promise<string> {
    const key = this.resolveApiKey();
    const url = `${this.baseUrl}/${this.getActiveModel()}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: content }] }],
        generationConfig: {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
      signal: createTimeoutSignal(),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 429) {
        throw new AppError(`Gemini API rate limit exceeded. Please try again later.`, 429);
      }
      if (response.status === 400 || response.status === 403) {
        throw new AppError(`Gemini API authentication error (${response.status}). Check GEMINI_API_KEY.`, 401);
      }
      throw new AppError(`Gemini API error (${response.status}): ${errText}`, 502);
    }

    const data: unknown = await response.json();

    const text = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') {
      console.error('[Gemini] Unexpected response format:', JSON.stringify(data).substring(0, 500));
      throw new AppError('Gemini returned an unexpected response format', 502);
    }

    return text;
  }

  async generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]> {
    const prompt = getQuestionsPrompt(techStack, count, options);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateQuestions(parsed, 'Gemini');
    }, 'Gemini');
  }

  async evaluateAnswer(question: string, answer: string): Promise<EvaluationResult> {
    const prompt = getEvaluationPrompt(question, answer);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateEvaluation(parsed, 'Gemini');
    }, 'Gemini');
  }

  async evaluateInterview(qaPairs: { question: string; answer: string }[]): Promise<FinalEvaluation> {
    const prompt = getFinalEvaluationPrompt(qaPairs);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateFinalEvaluation(parsed, 'Gemini');
    }, 'Gemini');
  }

  /**
   * Validates an API key by making a lightweight test request.
   * Static because key validation happens before we know we want a full
   * service instance bound to that key.
   */
  static async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      const probe = new GeminiService('gemini-3.5-flash', apiKey);
      await probe.makeRequest('Respond with: {"status":"ok"}');
      return true;
    } catch (error) {
      console.warn('[Gemini] API key validation failed:', error);
      return false;
    }
  }
}

export default GeminiService;
