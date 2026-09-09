import { AppError } from '../../utils/appError';
import {
  Question,
  EvaluationResult,
  FinalEvaluation,
  GenerationOptions,
  EvaluationDigestItem,
  AnswerGuidanceResult,
  ClaimVerificationItem,
  DifficultyLevel,
  ResumeProfile,
  QuestionKind,
} from '../../types';
import { isDifficultyLevelId } from '../../config/difficultyLevels';
import logger from '../../utils/logger';

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

/** Network-level error codes indicating the request never reached (or
 *  never heard back from) the provider at the socket level — as opposed to
 *  the provider answering with an HTTP error status, which is a
 *  `response.ok === false` and handled separately by
 *  handleProviderErrorResponse below, not here. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE',
]);

function hasNetworkErrorCode(code: unknown): boolean {
  return typeof code === 'string' && (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_'));
}

/**
 * True for a genuine network-level failure (DNS, connection reset/refused,
 * timeout at the socket level) surfacing through undici's `fetch` — NOT
 * for our own request-timeout abort (see createTimeoutSignal's doc
 * comment above `isRetryableError`): that's a DOMException named
 * 'AbortError', explicitly excluded here so it's never retried.
 *
 * Previously this checked `error instanceof TypeError &&
 * error.message.includes('fetch')` — matching undici's current "fetch
 * failed" message text. That's an implementation detail, not a contract:
 * see docs/audit/02-BACKLOG-P4-P10.md [P6-02] — a Node/undici version
 * bump that rewords the message silently turns off every network-error
 * retry, with nothing failing loudly enough to notice. undici instead
 * carries the real cause in `error.cause` (with its own `.code`, e.g.
 * `ECONNRESET` or an `UND_ERR_*` code); a raw Node `ErrnoException` can
 * also surface a `.code` directly. Inspect those instead of the message.
 */
function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError') return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (hasNetworkErrorCode(code)) return true;
  const causeCode = (error.cause as NodeJS.ErrnoException | undefined)?.code;
  return hasNetworkErrorCode(causeCode);
}

/**
 * Determines if an error is transient and worth retrying.
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    if (error.statusCode === 429) {
      // Only retry a rate limit when the provider actually told us how
      // long to wait (see docs/audit/02-BACKLOG-P4-P10.md [P5-04]).
      // Provider rate-limit windows are measured in seconds to a minute;
      // blindly retrying on this function's fixed 1s/2s backoff almost
      // always fails again and just delays runWithProviderChain from
      // moving to the next configured provider — which is the better
      // remedy for a rate limit than an in-place retry is.
      return error.retryAfterMs !== undefined;
    }
    return error.statusCode >= 500;
  }
  return isNetworkError(error);
}

/**
 * Executes `fn` with retry + exponential backoff for transient failures.
 * A 429 whose AppError carries `retryAfterMs` (see handleProviderErrorResponse)
 * waits exactly that long instead of the exponential backoff — honoring
 * what the provider actually asked for rather than guessing.
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
        const delay =
          error instanceof AppError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : BACKOFF_BASE_MS * Math.pow(2, attempt);
        // Metadata + error detail only — never candidate answer/question
        // text, which never passes through this generic retry wrapper
        // anyway (see RICH_EVALUATION_SCALE_PLAN.md §5).
        logger.warn(`${providerName} request failed, retrying`, {
          provider: providerName,
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          retryInMs: delay,
          statusCode: error instanceof AppError ? error.statusCode : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

// ─── Upstream error handling ────────────────────────────────────────────────

/**
 * Parses an HTTP `Retry-After` header (either a number of seconds or an
 * HTTP-date — RFC 9110 §10.2.3) into a millisecond delay. Returns
 * `undefined` for a missing or unparseable header.
 */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Builds and throws a stable, generic AppError for a failed provider HTTP
 * response (`response.ok === false`) — see
 * docs/audit/01-BACKLOG-P0-P3.md [P2-04]. The full upstream body is logged
 * via `logger.error` first — that's the diagnostic detail, correlated by
 * provider/model/statusCode in the logs — but it never reaches the client.
 *
 * Previously each service threw
 * `` new AppError(`${provider} API error (${status}): ${errText}`, ...) ``,
 * so whatever the upstream body contained (internal request ids, quota
 * structure, project identifiers, or — for Gemini's 400/403 branch — a
 * sentence naming the GEMINI_API_KEY environment variable) reached an
 * unauthenticated caller verbatim. This is a free oracle for anyone
 * probing provider configuration (e.g. via a model name crafted to fail in
 * a particular way — see [P2-02]).
 *
 * The accurate HTTP statusCode is always preserved — it drives
 * runWithProviderChain's fallback and isRetryableError's retry decision
 * above — only the message text changes. Do NOT flip these to
 * `isOperational: false`; that would turn every provider hiccup into a
 * generic 500 and break the chain's status-code-driven fallback (see
 * docs/audit/06-DEFERRED-DECISIONS.md, "Not deferred, worth flagging").
 */
export async function handleProviderErrorResponse(
  response: Response,
  providerName: string,
  model: string
): Promise<never> {
  const errText = await response.text();
  // Upstream error status/body — not candidate content — so full detail is
  // fine to log per RICH_EVALUATION_SCALE_PLAN.md §5.
  logger.error(`${providerName} API error response`, {
    provider: providerName,
    model,
    statusCode: response.status,
    body: errText.substring(0, 1000),
  });

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    throw new AppError(`${providerName} API rate limit exceeded. Please try again later.`, 429, true, retryAfterMs);
  }
  if (response.status === 401 || response.status === 403) {
    // Deliberately doesn't say which env var to check, or why (bad key vs.
    // API not enabled vs. a malformed request that only looks like a key
    // problem) — that diagnosis is for whoever reads the log line above,
    // not for an unauthenticated caller.
    throw new AppError(`${providerName} rejected this request.`, 503);
  }
  // Preserve the upstream status code instead of collapsing every other
  // failure to a hardcoded 502, so isRetryableError's `>= 500` check and
  // any future caller inspecting statusCode see what actually happened.
  throw new AppError(
    `${providerName} API request failed (${response.status}).`,
    response.status >= 400 ? response.status : 502
  );
}

// ─── Response validation ────────────────────────────────────────────────────

/** See validateQuestions's `requestedCount` cap below. */
const MAX_QUESTIONS_MULTIPLIER = 3;
const MAX_QUESTIONS_FLOOR = 10;

/**
 * Validates that parsed AI output matches the expected Question[] shape.
 * Returns a NEW normalized array — does not mutate `data` or its elements
 * (see docs/audit/02-BACKLOG-P4-P10.md [P4-04]: every other validator in
 * this file is pure; this one used to write `id`/`difficulty`/`topic`/
 * `expectedKeywords` straight onto the parsed objects, which is a surprise
 * at the call site for a function named "validate").
 *
 * When `requestedCount` is given, rejects a response far above what was
 * actually asked for — previously unbounded, so a model returning (say)
 * 500 questions produced a 500-question interview and a correspondingly
 * oversized row with no upper limit at all. The cap is deliberately loose
 * (a generous multiple of what was requested, not an exact match) since
 * models routinely return a few more or fewer than asked.
 */
export function validateQuestions(data: unknown, providerName: string, requestedCount?: number): Question[] {
  if (!Array.isArray(data)) {
    throw new AppError(`${providerName} returned non-array for questions`, 502);
  }
  if (data.length === 0) {
    throw new AppError(`${providerName} returned 0 questions`, 502);
  }
  if (requestedCount !== undefined) {
    const cap = Math.max(requestedCount * MAX_QUESTIONS_MULTIPLIER, requestedCount + MAX_QUESTIONS_FLOOR);
    if (data.length > cap) {
      throw new AppError(
        `${providerName} returned ${data.length} questions, far more than the ${requestedCount} requested`,
        502
      );
    }
  }
  return data.map((raw, i) => {
    const q = (raw ?? {}) as Record<string, unknown>;
    if (!raw || typeof q.question !== 'string' || !q.question.trim()) {
      throw new AppError(`${providerName} returned malformed question at index ${i}`, 502);
    }
    return {
      id: (q.id as number | undefined) ?? i + 1,
      question: q.question,
      difficulty: (q.difficulty as string | undefined) ?? 'medium',
      topic: (q.topic as string | undefined) ?? 'General',
      expectedKeywords: Array.isArray(q.expectedKeywords) ? (q.expectedKeywords as string[]) : [],
    };
  });
}

/**
 * Validates that parsed AI output matches the expected EvaluationResult
 * shape — fully separate structured fields (see
 * docs/project-improvement/RICH_EVALUATION_SCALE_PLAN.md §3/§9). Every
 * free-text field defaults to an empty string (not a placeholder sentence)
 * when the model omits it, since an empty "strengths"/"gaps" is a
 * legitimate answer (e.g. genuinely nothing was wrong), not a failure —
 * `summary` is the one exception, since a blank overall take is never
 * actually useful to show.
 */
/** Valid verdict values for a single claim-verification item — anything
 *  else the model returns falls back to 'unverifiable' rather than being
 *  dropped, since a malformed verdict is still worth surfacing as
 *  "couldn't be confirmed" rather than silently disappearing. */
const CLAIM_VERDICTS = new Set(['correct', 'partially_correct', 'incorrect', 'unverifiable']);

/**
 * Parses the optional Staff/Principal-only `claimVerification` array — see
 * DIFFICULTY_LEVEL_PLAN.md §2.4 and promptBuilder.ts's
 * buildDeepVerificationInstructions. Returns `undefined` (not an empty
 * array) when the field is absent or unusable, matching
 * EvaluationResult.claimVerification's optionality: this field simply
 * doesn't exist for a non-Staff-level evaluation, as opposed to
 * `studyPoints` which is always a real (possibly empty) array. Capped at 5
 * items regardless of how many the model returns, mirroring the prompt's
 * own cap.
 */
function validateClaimVerification(data: unknown): ClaimVerificationItem[] | undefined {
  if (!Array.isArray(data)) return undefined;
  const items: ClaimVerificationItem[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.claim !== 'string' || !c.claim.trim()) continue;
    const verdict = typeof c.verdict === 'string' && CLAIM_VERDICTS.has(c.verdict) ? c.verdict : 'unverifiable';
    const item: ClaimVerificationItem = {
      claim: c.claim,
      verdict: verdict as ClaimVerificationItem['verdict'],
    };
    if (typeof c.correction === 'string' && c.correction.trim()) item.correction = c.correction;
    items.push(item);
    if (items.length >= 5) break;
  }
  return items.length > 0 ? items : undefined;
}

export function validateEvaluation(data: unknown, providerName: string): EvaluationResult {
  if (!data || typeof data !== 'object') {
    throw new AppError(`${providerName} returned non-object for evaluation`, 502);
  }
  const obj = data as Record<string, unknown>;
  const result: EvaluationResult = {
    score: typeof obj.score === 'number' ? Math.min(10, Math.max(0, obj.score)) : 0,
    summary: typeof obj.summary === 'string' && obj.summary.trim() ? obj.summary : 'No summary provided.',
    strengths: typeof obj.strengths === 'string' ? obj.strengths : '',
    gaps: typeof obj.gaps === 'string' ? obj.gaps : '',
    improvementAreas: typeof obj.improvementAreas === 'string' ? obj.improvementAreas : '',
    betterAnswer: typeof obj.betterAnswer === 'string' ? obj.betterAnswer : '',
    studyPoints: Array.isArray(obj.studyPoints)
      ? obj.studyPoints.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : [],
  };
  // Staff/Principal-only fields — only ever present when the prompt asked
  // for them (see buildDeepVerificationInstructions), but parsed
  // defensively here regardless of level: if a model includes them
  // unprompted, they're still valid data worth keeping rather than a
  // reason to fail the whole evaluation.
  const claimVerification = validateClaimVerification(obj.claimVerification);
  if (claimVerification) result.claimVerification = claimVerification;
  if (typeof obj.followUpChallenge === 'string' && obj.followUpChallenge.trim()) {
    result.followUpChallenge = obj.followUpChallenge;
  }
  return result;
}

/**
 * Validates that parsed AI output matches the expected AnswerGuidanceResult
 * shape — see promptBuilder.ts's getAnswerGuidancePrompt.
 */
export function validateAnswerGuidance(data: unknown, providerName: string): AnswerGuidanceResult {
  if (!data || typeof data !== 'object') {
    throw new AppError(`${providerName} returned non-object for answer guidance`, 502);
  }
  const obj = data as Record<string, unknown>;
  return {
    guidance: typeof obj.guidance === 'string' && obj.guidance.trim() ? obj.guidance : 'No guidance available.',
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

// ─── Resume profile ─────────────────────────────────────────────────────────
// See docs/project-improvement/RESUME_MODE_PLAN.md §4.1/§9. This validator
// runs on BOTH sources: a fresh AI extraction (untrusted model output, same
// treatment as validateQuestions/validateEvaluation) AND a client-submitted
// profile at POST /start (untrusted input round-tripped through the
// browser between /analyze and /start — see §9's "trust question"). Every
// array is hard-capped and every string truncated regardless of source, so
// neither a misbehaving model nor a tampered request body can smuggle
// unbounded data into a later prompt.

const RESUME_PROFILE_MAX_SKILLS = 12;
const RESUME_PROFILE_MAX_PROJECTS = 6;
const RESUME_PROFILE_MAX_DOMAINS = 5;
const RESUME_PROFILE_MAX_CLAIMS = 8;
const RESUME_PROFILE_STRING_MAX_LEN = 300;
const RESUME_PROFILE_PROJECT_TECH_MAX = 10;

/** Loose email/phone patterns — belt-and-braces scrub on top of the
 *  extraction prompt's own PII instruction (see getResumeExtractionPrompt),
 *  since a model can still slip up. Not a general PII detector — just the
 *  two identifiers most likely to leak verbatim from a resume. */
const EMAIL_LIKE_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_LIKE_RE = /(?:\+?\d[\d\-\s().]{7,}\d)/g;

function scrubPii(text: string): string {
  return text.replace(EMAIL_LIKE_RE, '[redacted]').replace(PHONE_LIKE_RE, '[redacted]');
}

function cleanString(value: unknown, maxLen: number = RESUME_PROFILE_STRING_MAX_LEN): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = scrubPii(value).trim();
  if (!trimmed) return null;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

function cleanStringArray(value: unknown, maxItems: number, maxLen: number = RESUME_PROFILE_STRING_MAX_LEN): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    const cleaned = cleanString(raw, maxLen);
    if (cleaned) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Validates and normalizes a ResumeProfile from either source described
 * above. Returns a NEW object — never mutates `data`. `statusCode` lets the
 * caller distinguish "the AI returned something unusable" (502, matching
 * every other validator in this file) from "the client sent something
 * unusable" (400) — see startSession's client-side revalidation call.
 */
export function validateResumeProfile(data: unknown, sourceLabel: string, statusCode: number = 502): ResumeProfile {
  if (!data || typeof data !== 'object') {
    throw new AppError(`${sourceLabel} returned a non-object resume profile`, statusCode);
  }
  const obj = data as Record<string, unknown>;

  const projectsRaw = Array.isArray(obj.projects) ? obj.projects : [];
  const projects: ResumeProfile['projects'] = [];
  for (const raw of projectsRaw) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Record<string, unknown>;
    const summary = cleanString(p.summary, 500);
    if (!summary) continue;
    projects.push({
      summary,
      technologies: cleanStringArray(p.technologies, RESUME_PROFILE_PROJECT_TECH_MAX, 60),
    });
    if (projects.length >= RESUME_PROFILE_MAX_PROJECTS) break;
  }

  const yearsRaw = obj.yearsOfExperience;
  const years =
    typeof yearsRaw === 'number' && Number.isFinite(yearsRaw) && yearsRaw >= 0 && yearsRaw <= 60
      ? Math.round(yearsRaw)
      : null;

  const inferredLevel = typeof obj.inferredLevel === 'string' && isDifficultyLevelId(obj.inferredLevel)
    ? (obj.inferredLevel as DifficultyLevel)
    : null;

  return {
    primarySkills: cleanStringArray(obj.primarySkills, RESUME_PROFILE_MAX_SKILLS, 60),
    secondarySkills: cleanStringArray(obj.secondarySkills, RESUME_PROFILE_MAX_SKILLS, 60),
    projects,
    domains: cleanStringArray(obj.domains, RESUME_PROFILE_MAX_DOMAINS, 60),
    yearsOfExperience: years,
    inferredLevel,
    notableClaims: cleanStringArray(obj.notableClaims, RESUME_PROFILE_MAX_CLAIMS, RESUME_PROFILE_STRING_MAX_LEN),
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
      // Metadata only — deliberately never logs response content, since
      // this text can be the AI's paraphrase of what the candidate said
      // (see RICH_EVALUATION_SCALE_PLAN.md §5). Length + the parser's own
      // error message is enough to diagnose a malformed-JSON pattern
      // without ever needing the actual text.
      logger.error(`${providerName}: all JSON extraction attempts failed`, {
        provider: providerName,
        responseLength: text.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    logger.error(`${providerName}: failed to parse JSON from response`, {
      provider: providerName,
      responseLength: text.length,
    });
    throw new AppError(`${providerName} returned an invalid JSON format`, 502);
  }

  abstract getDefaultModel(): string;
  abstract generateQuestions(
    techStack: string,
    count: number,
    options?: GenerationOptions
  ): Promise<Question[]>;
  /** `level` is optional and falls back to DEFAULT_DIFFICULTY_LEVEL (see
   *  difficultyLevels.ts) — every pre-existing call site that doesn't pass
   *  one reproduces today's exact rubric. `kind` is optional and falls back
   *  to the standard technical rubric — see RESUME_MODE_PLAN.md §4.5;
   *  every pre-existing call site (which never passes it) is unaffected. */
  abstract evaluateAnswer(
    question: string,
    answer: string,
    level?: DifficultyLevel,
    kind?: QuestionKind
  ): Promise<EvaluationResult>;
  /** Takes a compact per-question digest, not the raw transcript — see
   *  promptBuilder.ts's getFinalEvaluationPrompt for why. */
  abstract evaluateInterview(digest: EvaluationDigestItem[], level?: DifficultyLevel): Promise<FinalEvaluation>;
  /** Standalone "how to answer this question well" guidance — no candidate
   *  answer involved. Only ever called for a question whose own scoring
   *  genuinely failed — see interview.service.ts's getAnswerGuidance.
   *  `kind` — see evaluateAnswer's doc comment above. */
  abstract generateAnswerGuidance(
    question: string,
    topic?: string,
    level?: DifficultyLevel,
    kind?: QuestionKind
  ): Promise<AnswerGuidanceResult>;
  /** Resume-mode pass 1 — resume text → structured, PII-stripped profile.
   *  See RESUME_MODE_PLAN.md §4.1. Every provider must implement this (a
   *  compile error otherwise, deliberately — see RESUME_MODE_PLAN.md §11's
   *  "one breaking change"). */
  abstract extractResumeProfile(resumeText: string): Promise<ResumeProfile>;
}
