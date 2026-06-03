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

class GroqService extends BaseAIService {
  private readonly apiUrl = 'https://api.groq.com/openai/v1/chat/completions';

  getDefaultModel(): string {
    return 'llama-3.3-70b-versatile';
  }

  private async makeRequest(content: string): Promise<string> {
    if (!config.ai.groqKey) {
      throw new AppError('GROQ_API_KEY is not configured', 503);
    }

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.ai.groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.getActiveModel(),
        messages: [{ role: 'user', content }],
        temperature: 0.7,
        max_completion_tokens: 8192,
        top_p: 0.9,
        stream: false,
      }),
      signal: createTimeoutSignal(),
    });

    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 429) {
        throw new AppError(`Groq API rate limit exceeded. Please try again later.`, 429);
      }
      if (response.status === 401 || response.status === 403) {
        throw new AppError(`Groq API authentication failed (${response.status}). Check GROQ_API_KEY.`, 503);
      }
      throw new AppError(`Groq API error (${response.status}): ${errText}`, 502);
    }

    const data: any = await response.json();

    // Guard against unexpected response shapes
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      console.error('[Groq] Unexpected response shape:', JSON.stringify(data).substring(0, 500));
      throw new AppError('Groq returned an unexpected response format', 502);
    }

    return text;
  }

  async generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]> {
    const prompt = getQuestionsPrompt(techStack, count, options);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateQuestions(parsed, 'Groq');
    }, 'Groq');
  }

  async evaluateAnswer(question: string, answer: string): Promise<EvaluationResult> {
    const prompt = getEvaluationPrompt(question, answer);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateEvaluation(parsed, 'Groq');
    }, 'Groq');
  }

  async evaluateInterview(qaPairs: { question: string; answer: string }[]): Promise<FinalEvaluation> {
    const prompt = getFinalEvaluationPrompt(qaPairs);
    return withRetry(async () => {
      const content = await this.makeRequest(prompt);
      const parsed = this.extractJson(content, 'Groq');
      return validateFinalEvaluation(parsed, 'Groq');
    }, 'Groq');
  }
}

export default new GroqService();
