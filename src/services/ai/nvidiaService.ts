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

export class NvidiaService extends BaseAIService {
  private readonly apiUrl = 'https://integrate.api.nvidia.com/v1/chat/completions';

  getDefaultModel(): string {
    return 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
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
      const errText = await response.text();
      if (response.status === 429) {
        throw new AppError(`NVIDIA API rate limit exceeded. Please try again later.`, 429);
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError(`NVIDIA API authentication failed (${response.status}). Check NVIDIA_API_KEY.`, 503);
      }
      throw new AppError(`NVIDIA API error (${response.status}): ${errText}`, 502);
    }

    const data: unknown = await response.json();

    const text = (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
      ?.content;
    if (typeof text !== 'string') {
      console.error('[NVIDIA] Unexpected response shape:', JSON.stringify(data).substring(0, 500));
      throw new AppError('NVIDIA returned an unexpected response format', 502);
    }

    return text;
  }

  async generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]> {
    const prompt = getQuestionsPrompt(techStack, count, options);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateQuestions(parsed, 'NVIDIA');
    }, 'NVIDIA');
  }

  async evaluateAnswer(question: string, answer: string): Promise<EvaluationResult> {
    const prompt = getEvaluationPrompt(question, answer);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateEvaluation(parsed, 'NVIDIA');
    }, 'NVIDIA');
  }

  async evaluateInterview(qaPairs: { question: string; answer: string }[]): Promise<FinalEvaluation> {
    const prompt = getFinalEvaluationPrompt(qaPairs);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'NVIDIA');
      return validateFinalEvaluation(parsed, 'NVIDIA');
    }, 'NVIDIA');
  }
}

export default NvidiaService;
