import {
  BaseAIService,
  createTimeoutSignal,
  withRetry,
  validateQuestions,
  validateEvaluation,
  validateFinalEvaluation,
  validateAnswerGuidance,
  validateResumeProfile,
  handleProviderErrorResponse,
} from './baseService';
import {
  Question,
  EvaluationResult,
  FinalEvaluation,
  GenerationOptions,
  EvaluationDigestItem,
  AnswerGuidanceResult,
  DifficultyLevel,
  QuestionKind,
  ResumeProfile,
} from '../../types';
import config from '../../config/config';
import {
  getQuestionsPrompt,
  getEvaluationPrompt,
  getFinalEvaluationPrompt,
  getAnswerGuidancePrompt,
  getResumeExtractionPrompt,
} from '../../utils/promptBuilder';
import { AppError } from '../../utils/appError';
import logger from '../../utils/logger';

export class GeminiService extends BaseAIService {
  private readonly baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';

  getDefaultModel(): string {
    // Configurable via GEMINI_FALLBACK_MODEL. Note: in normal operation the
    // primary Gemini model is whichever gemini-* id the user picked, passed
    // straight through by aiFactory — this default is only used when a
    // model string is empty (constructor fallback) or when this service is
    // being constructed as the FALLBACK target for a failed Groq/NVIDIA call.
    return config.ai.geminiFallbackModel;
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
          // Deliberately NOT setting responseMimeType: 'application/json'.
          // Google's own docs/examples always pair that with a
          // responseSchema describing the exact JSON shape — this service
          // sent it with no schema. scripts/test-provider-keys.mjs's bare
          // "hi" prompt (no generationConfig at all) passes even when a
          // real interview call 400s, which is consistent with the
          // mismatch being in generationConfig specifically, not the key,
          // model id, or auth header (all already confirmed working by
          // that same script). extractJson() in baseService.ts already
          // does direct-parse -> sanitized-parse -> regex-extraction, the
          // same fallback chain Groq/NVIDIA rely on without any structured
          // output mode at all, so dropping this doesn't weaken JSON
          // handling — it removes a plausible 400 source instead of
          // building out a responseSchema per call type (questions array
          // vs. evaluation object vs. final-evaluation object) to satisfy
          // it properly.
        },
      }),
      signal: createTimeoutSignal(),
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 403) {
        // A 400/403 here is usually a bad/expired key or a key whose
        // project doesn't have the Generative Language API enabled — but
        // it can also be a genuinely malformed request (bad model id,
        // conflicting params, etc.), and those look identical from the
        // status code alone. Full detail goes to the log, correlated by
        // model/statusCode; the client gets a stable, generic message with
        // no upstream body and no environment-variable name — see
        // docs/audit/01-BACKLOG-P0-P3.md [P2-04]. (Previously this echoed
        // up to 300 chars of the upstream body plus a sentence naming
        // GEMINI_API_KEY to the caller.)
        const errText = await response.text();
        logger.error('Gemini API error response', {
          provider: 'google',
          model: this.getActiveModel(),
          statusCode: response.status,
          body: errText.substring(0, 1000),
        });
        throw new AppError(
          'Gemini rejected this request — the request may be malformed, or the API key invalid or unauthorized for this model.',
          401
        );
      }
      // Every other case (429 honors Retry-After — see [P5-04]; otherwise
      // the upstream status is preserved) goes through the same generic,
      // non-leaking handling every provider uses.
      await handleProviderErrorResponse(response, 'Gemini', this.getActiveModel());
    }

    const data: unknown = await response.json();

    const text = (data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') {
      logger.error('Gemini: unexpected response shape', { provider: 'google', model: this.getActiveModel() });
      throw new AppError('Gemini returned an unexpected response format', 502);
    }

    return text;
  }

  async generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]> {
    const prompt = getQuestionsPrompt(techStack, count, options);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateQuestions(parsed, 'Gemini', count);
    }, 'Gemini');
  }

  async evaluateAnswer(question: string, answer: string, level?: DifficultyLevel, kind?: QuestionKind): Promise<EvaluationResult> {
    const prompt = getEvaluationPrompt(question, answer, level, kind);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateEvaluation(parsed, 'Gemini');
    }, 'Gemini');
  }

  async evaluateInterview(digest: EvaluationDigestItem[], level?: DifficultyLevel): Promise<FinalEvaluation> {
    const prompt = getFinalEvaluationPrompt(digest, level);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateFinalEvaluation(parsed, 'Gemini');
    }, 'Gemini');
  }

  async generateAnswerGuidance(
    question: string,
    topic?: string,
    level?: DifficultyLevel,
    kind?: QuestionKind
  ): Promise<AnswerGuidanceResult> {
    const prompt = getAnswerGuidancePrompt(question, topic, level, kind);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateAnswerGuidance(parsed, 'Gemini');
    }, 'Gemini');
  }

  /** Resume-mode pass 1 — see RESUME_MODE_PLAN.md §4.1. */
  async extractResumeProfile(resumeText: string): Promise<ResumeProfile> {
    const prompt = getResumeExtractionPrompt(resumeText);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Gemini');
      return validateResumeProfile(parsed, 'Gemini');
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
      logger.warn('Gemini API key validation failed', {
        provider: 'google',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

export default GeminiService;
