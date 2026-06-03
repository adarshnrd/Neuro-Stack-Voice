import {
  BaseAIService,
  createTimeoutSignal,
  withRetry,
  validateQuestions,
  validateEvaluation,
  validateFinalEvaluation,
} from './baseService';
import { Question, EvaluationResult, FinalEvaluation, GenerationOptions } from '../../interfaces';
import config from '../../config/config';
import { getQuestionsPrompt, getEvaluationPrompt, getFinalEvaluationPrompt } from '../../utils/promptBuilder';
import { AppError } from '../../utils/appError';

class GeminiService extends BaseAIService {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  /**
   * Per-call API key override. Stored here as a convenience for the current
   * request flow, but makeRequest() also accepts it as a parameter to avoid
   * the race condition where concurrent requests could overwrite each other's key.
   *
   * IMPORTANT: Always prefer passing the key explicitly to makeRequest().
   */
  private runtimeApiKey: string | null = null;

  getDefaultModel(): string {
    return 'gemini-3.5-flash';
  }

  setRuntimeApiKey(key: string): void {
    this.runtimeApiKey = key;
  }

  clearRuntimeApiKey(): void {
    this.runtimeApiKey = null;
  }

  private resolveApiKey(explicitKey?: string): string {
    // Precedence: explicit parameter → runtime override → system config
    if (explicitKey) return explicitKey;
    if (this.runtimeApiKey) return this.runtimeApiKey;
    if (config.ai.geminiKey) return config.ai.geminiKey;
    throw new AppError(
      'GEMINI_API_KEY is not configured. Please set it in .env or provide your own API key.',
      503
    );
  }

  private async makeRequest(content: string, apiKey?: string): Promise<string> {
    const key = this.resolveApiKey(apiKey);
    const model = this.getActiveModel();
    const url = `${this.baseUrl}/${model}:generateContent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: content }],
          },
        ],
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

    const data: any = await response.json();

    // Guard against unexpected response shapes
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
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
   */
  async validateApiKey(apiKey: string): Promise<boolean> {
    try {
      await this.makeRequest('Respond with: {"status":"ok"}', apiKey);
      return true;
    } catch (error) {
      console.warn('[Gemini] API key validation failed:', error);
      return false;
    }
  }
}

export default new GeminiService();
