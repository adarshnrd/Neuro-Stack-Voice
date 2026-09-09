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

export class GroqService extends BaseAIService {
  private readonly apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

  getDefaultModel(): string {
    // Configurable via GROQ_MODEL — Groq deprecates/renames models on their
    // own schedule (e.g. llama-3.3-70b-versatile stopped working for
    // free/developer-tier keys on 2026-08-16), so this is a config lookup,
    // not a hardcoded string. aiFactory always passes an explicit model in
    // practice; this is the constructor's fallback if it ever doesn't.
    return config.ai.groqModel;
  }

  private async makeRequest(content: string): Promise<string> {
    if (!config.ai.groqKey) {
      throw new AppError('GROQ_API_KEY is not configured', 503);
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.getActiveModel(),
        messages: [{ role: 'user', content }],
        temperature: 0.7,
        // See config.ts's groqMaxCompletionTokens comment: this used to be
        // a hardcoded 8192, which alone was at/above this org's 8000 TPM
        // cap for this model — every request 413'd regardless of prompt
        // size ("Request too large... Requested 8704").
        max_completion_tokens: config.ai.groqMaxCompletionTokens,
        top_p: 0.9,
        stream: false,
      }),
      signal: createTimeoutSignal(),
    });

    if (!response.ok) {
      // Logs the full upstream body and throws a stable, generic message —
      // see docs/audit/01-BACKLOG-P0-P3.md [P2-04]. Also honors a 429's
      // Retry-After header — see [P5-04].
      await handleProviderErrorResponse(response, 'Groq', this.getActiveModel());
    }

    const data: unknown = await response.json();

    const text = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content;
    if (typeof text !== 'string') {
      // Metadata only — the response shape, not its content.
      logger.error('Groq: unexpected response shape', { provider: 'groq', model: this.getActiveModel() });
      throw new AppError('Groq returned an unexpected response format', 502);
    }

    return text;
  }

  async generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]> {
    const prompt = getQuestionsPrompt(techStack, count, options);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateQuestions(parsed, 'Groq', count);
    }, 'Groq');
  }

  async evaluateAnswer(question: string, answer: string, level?: DifficultyLevel, kind?: QuestionKind): Promise<EvaluationResult> {
    const prompt = getEvaluationPrompt(question, answer, level, kind);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateEvaluation(parsed, 'Groq');
    }, 'Groq');
  }

  async evaluateInterview(digest: EvaluationDigestItem[], level?: DifficultyLevel): Promise<FinalEvaluation> {
    const prompt = getFinalEvaluationPrompt(digest, level);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateFinalEvaluation(parsed, 'Groq');
    }, 'Groq');
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
      const parsed = this.extractJson(content, 'Groq');
      return validateAnswerGuidance(parsed, 'Groq');
    }, 'Groq');
  }

  /** Resume-mode pass 1 — see RESUME_MODE_PLAN.md §4.1. */
  async extractResumeProfile(resumeText: string): Promise<ResumeProfile> {
    const prompt = getResumeExtractionPrompt(resumeText);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateResumeProfile(parsed, 'Groq');
    }, 'Groq');
  }
}

export default GroqService;
