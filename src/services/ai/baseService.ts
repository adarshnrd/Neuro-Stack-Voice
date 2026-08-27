import { AppError } from '../../utils/appError';
import { Question, EvaluationResult, FinalEvaluation, GenerationOptions } from '../../types';

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
 *
 * Deliberately excludes AbortError: an abort here means our own
 * request-timeout fired (see createTimeoutSignal), so the provider already
 * took the full DEFAULT_TIMEOUT_MS and didn't answer. Retrying that would
 * silently compound the wait to 2-3x the configured timeout before the
 * caller ever sees a failure.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    // Retry 5xx server errors and rate limits (after backoff)
    return error.statusCode >= 500 || error.statusCode === 429;
  }
  // Network errors (DNS, connection reset, etc.) — but not our own timeout abort.
  if (error instanceof TypeError && error.message.includes('fetch')) return true;
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
  for (let i = 0; i < data.length; i++) {
    const q = data[i];
    if (!q || typeof q.question !== 'string' || !q.question.trim()) {
      throw new AppError(`${providerName} returned malformed question at index ${i}`, 502);
    }
    q.id = q.id ?? i + 1;
    q.difficulty = q.difficulty ?? 'medium';
    q.topic = q.topic ?? 'General';
    q.expectedKeywords = Array.isArray(q.expectedKeywords) ? q.expectedKeywords : [];
  }
  return data as Question[];
}

/**
 * Validates that parsed AI output matches the expected EvaluationResult shape.
 */
export function validateEvaluation(data: unknown, providerName: string): EvaluationResult {
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
export function validateFinalEvaluation(data: unknown, providerName: string): FinalEvaluation {
  if (!data || typeof data !== 'object') {
    throw new AppError(`${providerName} returned non-object for final evaluation`, 502);
  }
  const obj = data as Record<string, unknown>;
  return {
    overallScore:
      typeof obj.overallScore === 'number' ? Math.min(100, Math.max(0, obj.overallScore)) : 0,
    overallFeedback:
      typeof obj.overallFeedback === 'string' ? obj.overallFeedback : 'No feedback provided.',
  };
}

// ─── Abstract base ──────────────────────────────────────────────────────────

/**
 * Base class for all AI provider services.
 *
 * IMPORTANT: instances are created PER REQUEST by AIFactory, never shared as
 * module-level singletons. Earlier revisions kept one singleton per provider
 * with mutable `currentModel` / `runtimeApiKey` fields — under concurrent
 * requests, request A's model selection (and even API key) could be
 * overwritten by request B between `setModel()` and the actual fetch call.
 * Constructor injection makes that class of bug structurally impossible:
 * each instance's `model` and `apiKey` are set once, at construction, and
 * never mutated afterwards.
 */
export abstract class BaseAIService {
  protected readonly model: string;
  protected readonly apiKey?: string;

  constructor(model: string, apiKey?: string) {
    this.model = model || this.getDefaultModel();
    this.apiKey = apiKey;
  }

  getActiveModel(): string {
    return this.model;
  }

  /**
   * Sanitises a raw JSON string by escaping unescaped control characters
   * (newlines, carriage returns, tabs) that appear INSIDE JSON string
   * values — without touching structural whitespace between tokens.
   *
   * The previous implementation escaped every unescaped control character
   * anywhere in the text, including the newlines LLMs routinely emit
   * between top-level array/object elements for readability. That mangled
   * otherwise-valid JSON into a string JSON.parse would reject, so the
   * "sanitised parse" fallback stage could essentially never succeed —
   * only the far coarser regex-extraction stage ever recovered anything.
   *
   * This version tracks whether we're inside a string literal (honoring
   * escape sequences and skipping escaped quotes) and only rewrites control
   * characters while inside one.
   */
  protected sanitizeJsonString(text: string): string {
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (inString) {
        if (escaped) {
          result += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          result += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
          result += ch;
          continue;
        }
        if (ch === '\n') {
          result += '\\n';
          continue;
        }
        if (ch === '\r') {
          result += '\\r';
          continue;
        }
        if (ch === '\t') {
          result += '\\t';
          continue;
        }
        result += ch;
        continue;
      }

      if (ch === '"') {
        inString = true;
      }
      result += ch;
    }

    return result;
  }

  /**
   * Robust JSON extraction with multi-stage fallback:
   * 1. Direct parse
   * 2. Sanitised parse (escapes stray control chars inside string literals)
   * 3. Regex extraction + sanitised parse
   */
  protected extractJson(text: string, providerName: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }

    try {
      return JSON.parse(this.sanitizeJsonString(text));
    } catch {
      /* fall through */
    }

    try {
      const match = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
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
  abstract generateQuestions(
    techStack: string,
    count: number,
    options?: GenerationOptions
  ): Promise<Question[]>;
  abstract evaluateAnswer(question: string, answer: string): Promise<EvaluationResult>;
  abstract evaluateInterview(
    qaPairs: { question: string; answer: string }[]
  ): Promise<FinalEvaluation>;
}
