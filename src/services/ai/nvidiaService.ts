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

export class NvidiaService extends BaseAIService {
  private readonly apiUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

  getDefaultModel(): string {
    // Configurable via NVIDIA_MODEL — see groqService.ts for why this is a
    // config lookup rather than a hardcoded string.
    return config.ai.nvidiaModel;
  }

  private async makeRequest(content: string): Promise<string> {
    if (!config.ai.nvidiaKey) {
      throw new AppError('NVIDIA_API_KEY is not configured', 503);
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.ai.nvidiaKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.getActiveModel(),
        messages: [{ role: 'user', content }],
        temperature: 0.6,
        top_p: 0.95,
        max_tokens: 8192, // Capped from 65536 to prevent cost blowout
        reasoning_budget: 8192, // Capped from 16384
        chat_template_kwargs: { enable_thinking: true },
        stream: false,
      }),
      signal: createTimeoutSignal(),
    });

    if (!response.ok) {
      // Logs the full upstream body and throws a stable, generic message —
      // see docs/audit/01-BACKLOG-P0-P3.md [P2-04]. Also honors a 429's
      // Retry-After header — see [P5-04]. Status code (e.g. the 503
      // "resource exhausted" / worker-limit-reached responses NVIDIA sends
      // under load) is still preserved.
      await handleProviderErrorResponse(response, 'NVIDIA', this.getActiveModel());
    }

    const data: unknown = await response.json();

    const text = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content;
    if (typeof text !== 'string') {
      logger.error('NVIDIA: unexpected response shape', { provider: 'nvidia', model: this.getActiveModel() });
      throw new AppError('NVIDIA returned an unexpected response format', 502);
    }

    return text;
  }

  async generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]> {
    const prompt = getQuestionsPrompt(techStack, count, options);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateQuestions(parsed, 'NVIDIA', count);
    }, 'NVIDIA');
  }

  async evaluateAnswer(question: string, answer: string, level?: DifficultyLevel, kind?: QuestionKind): Promise<EvaluationResult> {
    const prompt = getEvaluationPrompt(question, answer, level, kind);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateEvaluation(parsed, 'NVIDIA');
    }, 'NVIDIA');
  }

  async evaluateInterview(digest: EvaluationDigestItem[], level?: DifficultyLevel): Promise<FinalEvaluation> {
    const prompt = getFinalEvaluationPrompt(digest, level);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateFinalEvaluation(parsed, 'NVIDIA');
    }, 'NVIDIA');
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
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateAnswerGuidance(parsed, 'NVIDIA');
    }, 'NVIDIA');
  }

  /** Resume-mode pass 1 — see RESUME_MODE_PLAN.md §4.1. */
  async extractResumeProfile(resumeText: string): Promise<ResumeProfile> {
    const prompt = getResumeExtractionPrompt(resumeText);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateResumeProfile(parsed, 'NVIDIA');
    }, 'NVIDIA');
  }
}

export default NvidiaService;
