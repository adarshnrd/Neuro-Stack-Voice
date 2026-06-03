import { AppError } from '../../utils/appError';
import {
  Question,
  EvaluationResult,
  FinalEvaluation,
  GenerationOptions
} from '../../interfaces';

// ─── Request helpers ────────────────────────────────────────────────────────

/** Default timeout for AI API calls — 2m (120s) prevents hangs while allowing large reasoning models. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Max retries for transient failures (5xx, network errors). */
const MAX_RETRIES = 2;

/** Base delay for exponential backoff (doubled each retry). */
const BACKOFF_BASE_MS = 1_000;

/**
 * Creates an AbortSignal that fires after `ms` milliseconds.
 * Used to enforce request timeouts on `fetch()` calls.
 */
export function createTimeoutSignal(ms: number = DEFAULT_TIMEOUT_MS): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  // Prevent the timer from keeping the Node process alive during shutdown
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }
  return controller.signal;
}

/**
 * Determines if an error is transient and worth retrying.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    // Retry 5xx server errors and rate limits (after backoff)
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  // Network errors, timeouts
  if (error instanceof TypeError && error.message.includes('fetch')) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  return false;
}

/**
 * Executes `fn` with retry + exponential backoff for transient failures.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  providerName: string,
  maxRetries: number = MAX_RETRIES
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isRetryableError(error)) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `[${providerName}] Request failed (attempt ${attempt + 1}/${maxRetries + 1}), ` +
          `retrying in ${delay}ms:`,
          error instanceof Error ? error.message : error
        );
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

// ─── Response validation ────────────────────────────────────────────────────

/**
 * Validates that parsed AI output matches the expected Question[] shape.
 * Returns the validated array or throws.
 */
export function validateQuestions(data: unknown, providerName: string): Question[] {
  if (!Array.isArray(data)) {
    throw new AppError(`${providerName} returned non-array for questions`, 502);
  }
  if (data.length === 0) {
    throw new AppError(`${providerName} returned 0 questions`, 502);
  }
  // Validate each question has required fields
  for (let i = 0; i < data.length; i++) {
    const q = data[i];
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      throw new AppError(
        `${providerName} returned malformed question at index ${i}`,
        502
      );
    }
    // Ensure required fields have defaults
    q.id = q.id ?? i + 1;
    q.difficulty = q.difficulty ?? 'medium';
    q.topic = q.topic ?? 'General';
    q.expectedKeywords = Array.isArray(q.expectedKeywords)
      ? q.expectedKeywords
      : [];
  }
  return data as Question[];
}

/**
 * Validates that parsed AI output matches the expected EvaluationResult shape.
 */
export function validateEvaluation(
  data: unknown,
  providerName: string
): EvaluationResult {
  if (!data || typeof data !== 'object') {
    throw new AppError(`${providerName} returned non-object for evaluation`, 502);
  }
  const obj = data as Record<string, unknown>;
  return {
    score: typeof obj.score === 'number' ? Math.min(10, Math.max(0, obj.score)) : 0,
    feedback: typeof obj.feedback === 'string' ? obj.feedback : 'No feedback provided.',
    betterAnswer: typeof obj.betterAnswer === 'string' ? obj.betterAnswer : '',
  };
}

/**
 * Validates that parsed AI output matches the expected FinalEvaluation shape.
 */
export function validateFinalEvaluation(
  data: unknown,
  providerName: string
): FinalEvaluation {
  if (!data || typeof data !== 'object') {
    throw new AppError(
      `${providerName} returned non-object for final evaluation`,
      502
    );
  }
  const obj = data as Record<string, unknown>;
  return {
    overallScore:
      typeof obj.overallScore === 'number'
        ? Math.min(100, Math.max(0, obj.overallScore))
        : 0,
    overallFeedback:
      typeof obj.overallFeedback === 'string'
        ? obj.overallFeedback
        : 'No feedback provided.',
  };
}

// ─── Abstract base ──────────────────────────────────────────────────────────

export abstract class BaseAIService {
  protected currentModel: string = '';

  setModel(model: string): void {
    this.currentModel = model;
  }

  getActiveModel(): string {
    return this.currentModel || this.getDefaultModel();
  }

  /**
   * Sanitises a raw JSON string by escaping unescaped control characters
   * (newlines, carriage returns, tabs) that appear inside JSON string values.
   * LLMs frequently return these when their output contains code blocks.
   */
  protected sanitizeJsonString(text: string): string {
    // Replace literal control characters that are NOT already escaped
    return text
      .replace(/(?<!\\)\n/g, '\\n')
      .replace(/(?<!\\)\r/g, '\\r')
      .replace(/(?<!\\)\t/g, '\\t');
  }

  /**
   * Robust JSON extraction with multi-stage fallback:
   * 1. Direct parse
   * 2. Sanitised parse (escapes stray control chars)
   * 3. Regex extraction + sanitised parse
   */
  protected extractJson(text: string, providerName: string): unknown {
    // 1 — direct parse
    try {
      return JSON.parse(text);
    } catch (_) { /* fall through */ }

    // 2 — sanitise then parse
    try {
      return JSON.parse(this.sanitizeJsonString(text));
    } catch (_) { /* fall through */ }

    // 3 — extract JSON object / array via regex, then sanitise + parse
    try {
      const match = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (_) {
          return JSON.parse(this.sanitizeJsonString(match[0]));
        }
      }
    } catch (e) {
      console.error(`[${providerName}] All JSON extraction attempts failed:`, e);
    }

    console.error(`[${providerName}] Failed to parse JSON from response:`, text.substring(0, 500));
    throw new AppError(`${providerName} returned an invalid JSON format`, 502);
  }

  abstract getDefaultModel(): string;
  abstract generateQuestions(techStack: string, count: number, options?: GenerationOptions): Promise<Question[]>;
  abstract evaluateAnswer(question: string, answer: string): Promise<EvaluationResult>;
  abstract evaluateInterview(qaPairs: {question: string, answer: string}[]): Promise<FinalEvaluation>;
}
