// ─── Difficulty level ────────────────────────────────────────────────────────
// Re-exported here (rather than importing straight from
// src/config/difficultyLevels.ts everywhere) so every other type in this
// file can reference DifficultyLevel without this file reaching into
// config/ — see DIFFICULTY_LEVEL_PLAN.md. The actual level DEFINITIONS
// (rubric weights, prompts, score anchors) live only in
// difficultyLevels.ts; this is just the id union.
export type { DifficultyLevelId as DifficultyLevel } from '../config/difficultyLevels';

// ─── Config ──────────────────────────────────────────────────────────────────

export interface AppConfig {
  env: string;
  isProduction: boolean;
  port: number;
  trustProxy: number | boolean;
  ai: {
    nvidiaKey?: string;
    groqKey?: string;
    geminiKey?: string;
    groqModel: string;
    nvidiaModel: string;
    geminiFallbackModel: string;
    // See config.ts for why this exists (Groq's TPM cap counts the
    // requested max_completion_tokens ceiling, not just actual usage).
    groqMaxCompletionTokens: number;
  };
  app: {
    questionsPerInterview: number;
    jdQuestionsPerInterview: number;
    silenceTimeoutMs: number;
  };
  /** See config.ts's inline comments — server-side speech-to-text on
   *  recorded answer audio, additive to the existing Web Speech flow. */
  stt: {
    enabled: boolean;
    providerChain: string[];
    groqModel: string;
    language: string;
    maxAudioBytes: number;
    maxAudioSeconds: number;
    timeoutMs: number;
    keywordBias: boolean;
  };
  encryption: {
    secret: string;
  };
  auth: {
    jwtSecret: string;
    cookieSecure: boolean;
    tokenTtlSeconds: number;
  };
  cors: {
    allowedOrigins: string[];
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type FieldRule = {
  /** The field must be present and non-empty */
  required?: boolean;
  /** The field must be one of these values */
  oneOf?: string[];
  /** The field must be a positive integer */
  positiveInt?: boolean;
  /** Max numeric value */
  max?: number;
  /** Min numeric value */
  min?: number;
  /** Max string length */
  maxLength?: number;
  /** Min string length */
  minLength?: number;
  /** Expected type ('string' | 'number' | 'boolean') */
  type?: 'string' | 'number' | 'boolean';
  /** Simple email format check */
  email?: boolean;
};

export type Schema = Record<string, FieldRule>;

// ─── AI domain ───────────────────────────────────────────────────────────────

export interface Question {
  id: number;
  question: string;
  difficulty: string;
  topic: string;
  expectedKeywords: string[];
}

/** Fully separate structured fields (decided over a single blended
 *  markdown blob — see
 *  docs/project-improvement/RICH_EVALUATION_SCALE_PLAN.md §3/§9).
 *  `feedback` is intentionally NOT part of the AI-facing result shape any
 *  more — see EvaluationData below for how legacy `feedback`-only rows
 *  already in the database stay readable without a migration. */
export interface EvaluationResult {
  score: number;
  summary: string;
  strengths: string;
  gaps: string;
  improvementAreas: string;
  betterAnswer: string;
  studyPoints: string[];
  /** Staff/Principal-only deep verification — see
   *  DIFFICULTY_LEVEL_PLAN.md §2.4 and difficultyLevels.ts's
   *  `deepVerification` flag. Absent (not an empty array) at every other
   *  level — see validateEvaluation in baseService.ts, which only
   *  populates this when the level requested it. Capped at 5 claims. */
  claimVerification?: ClaimVerificationItem[];
  /** The single follow-up question a real Staff/Principal interviewer
   *  would push back with next — same deepVerification gating as
   *  claimVerification above. */
  followUpChallenge?: string;
}

/** One extracted technical claim from the candidate's answer, verified
 *  independently of the overall score — Staff/Principal level only. See
 *  DIFFICULTY_LEVEL_PLAN.md §2.4. */
export interface ClaimVerificationItem {
  claim: string;
  verdict: 'correct' | 'partially_correct' | 'incorrect' | 'unverifiable';
  /** One-line correction — present when verdict isn't 'correct'. */
  correction?: string;
}

/** Compact per-question digest item fed into the final holistic
 *  evaluation call instead of the raw transcript — see
 *  RICH_EVALUATION_SCALE_PLAN.md §2. Deliberately small and fixed-shape:
 *  its total size scales with question COUNT, not with how much any
 *  individual candidate said, which is what keeps the final call safe
 *  from the token-limit risk a raw-transcript prompt has at 20-30+
 *  questions. */
export interface EvaluationDigestItem {
  topic: string;
  score?: number;
  summary: string;
}

/** A provider switch that happened as a side effect of an AI call falling
 *  back mid-session (see docs/AI_PROVIDER_AUTO_SWITCH_PLAN.md). Present
 *  only on the call where the switch actually occurred. */
export interface ProviderSwitchNotice {
  from: string;
  to: string;
  reason: string;
}

export interface FinalEvaluation {
  overallScore: number;
  overallFeedback: string;
}

/** Standalone guidance on how to approach an interview question well —
 *  independent of grading any particular answer. Fetched on demand only
 *  for a question whose own evaluation genuinely couldn't be scored (every
 *  configured AI provider failed) — see interview.service.ts's
 *  getAnswerGuidance and EvaluationData.guidance below. */
export interface AnswerGuidanceResult {
  guidance: string;
}

/** Result of a server-side ASR pass on recorded answer audio — see
 *  services/ai/transcriptionService.ts and
 *  docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. Audio
 *  itself is never persisted anywhere (see transcriptionService.ts's
 *  header comment); this is the only trace of it that survives the
 *  request. `provider: 'none'` means every configured provider failed (or
 *  none were configured / the feature is disabled) — that is NOT an
 *  error, it's a normal, expected outcome the client already handles by
 *  keeping whatever transcript it already has (the Web Speech text). */
export interface TranscriptionResult {
  /** Empty string when provider is 'none'. */
  transcript: string;
  provider: 'groq' | 'gemini' | 'none';
  model?: string;
  /** True when the ASR model itself flagged this transcription as
   *  uncertain (e.g. Groq's no_speech_prob / avg_logprob on the returned
   *  segments) — a hint for the client to nudge the user to double-check
   *  the text, not a hard error. */
  lowConfidence?: boolean;
  /** Present only when provider is 'none' — a short, user-safe reason
   *  (never upstream error detail — see handleProviderErrorResponse's
   *  same reasoning in baseService.ts) suitable for a quiet console log,
   *  not necessarily surfaced to the candidate. */
  warning?: string;
}

/** Status lifecycle for a single question's evaluation — see
 *  RICH_EVALUATION_SCALE_PLAN.md §4. Absence of an evaluations[] entry for
 *  a question means implicit "pending" (answered, background scoring not
 *  started yet); an explicit `processing` entry is written the moment the
 *  AI call for it begins, so endSession's bounded wait can tell "still
 *  working on it" apart from "no entry at all yet" — both cases still
 *  count as not-yet-done for that wait, but the distinction matters for
 *  anything inspecting evaluations mid-flight (e.g. a future live
 *  indicator). Rows written before this field existed have no `status` at
 *  all; treat those as `completed` if they carry a numeric score, else
 *  `failed` — see interview.service.ts's isEvaluationCompleted helper. */
export type EvaluationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface GenerationOptions {
  jobDescription?: string;
  previousQuestions?: string[];
  interviewContext?: string;
  /** Interview difficulty level — see difficultyLevels.ts. Every prompt
   *  builder falls back to DEFAULT_DIFFICULTY_LEVEL when this is absent,
   *  so omitting it (as every pre-existing caller does until updated)
   *  reproduces today's exact question-generation behavior. */
  level?: DifficultyLevel;
  /** True when the question count was explicitly chosen by the caller
   *  (not a server default) — see RESUME_MODE_PLAN.md §7.1. When true,
   *  getJDQuestionsPrompt skips its normal 15-question floor so an
   *  explicit lower count is actually honored. Undefined/false preserves
   *  today's always-floor behavior for every existing caller, including
   *  extendSession (which never sets this). */
  explicitQuestionCount?: boolean;
  /** PII-stripped structured profile extracted from a candidate's resume
   *  — see RESUME_MODE_PLAN.md §4. Only meaningful when techStack is
   *  'Resume'; every other mode never sets this. */
  resumeProfile?: ResumeProfile;
}

/**
 * Structured, PII-stripped extraction from a candidate's resume — see
 * RESUME_MODE_PLAN.md §4.1/§5. The raw resume text is NEVER stored or
 * threaded past extraction; this profile is what every later prompt
 * (question generation, extend) actually reads. Every array here is
 * capped and every string truncated by validateResumeProfile — see
 * baseService.ts — regardless of whether the profile came from an AI
 * extraction call or was re-validated after a round-trip through the
 * client (POST /start's resumeProfile — see RESUME_MODE_PLAN.md §9).
 */
export interface ResumeProfile {
  /** Ranked most-central-first. ≤ 12. */
  primarySkills: string[];
  /** ≤ 12. */
  secondarySkills: string[];
  /** Short neutral descriptions — no employer/company names. ≤ 6. */
  projects: Array<{ summary: string; technologies: string[] }>;
  /** e.g. "fintech", "IoT". ≤ 5. */
  domains: string[];
  /** Total years of professional experience the resume evidences, or
   *  null when it can't reasonably be inferred. */
  yearsOfExperience: number | null;
  /** What the resume reads as, independent of what the user picked at
   *  the level picker — advisory only, never overrides the user's
   *  explicit choice. See RESUME_MODE_PLAN.md §8. */
  inferredLevel: DifficultyLevel | null;
  /** Claims worth probing in the interview — e.g. "led migration to
   *  microservices". ≤ 8. */
  notableClaims: string[];
}

export interface ResolvedModel {
  provider: string;
  model: string;
}

/** Runtime options passed to an AI service instance for a single request. */
export interface AIServiceOptions {
  model: string;
  /** Explicit caller-supplied API key, takes precedence over stored/config keys. */
  apiKey?: string;
}

// ─── Interview domain ────────────────────────────────────────────────────────

export interface StartSessionOptions {
  jobDescription?: string;
  userApiKey?: string;
  /** Optional, unverified self-reported email — see
   *  docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md (Option B: no PIN/verification).
   *  Normalized (trimmed + lowercased) before storage/lookup. */
  historyEmail?: string;
  /** Interview difficulty level — see difficultyLevels.ts. Validated
   *  against DIFFICULTY_LEVEL_IDS at the route layer (oneOf), same
   *  pattern as techStack/model; startSession itself falls back to
   *  DEFAULT_DIFFICULTY_LEVEL when omitted. */
  difficultyLevel?: DifficultyLevel;
  /** Required when techStack === 'Resume' — see RESUME_MODE_PLAN.md §4.
   *  Re-validated server-side via validateResumeProfile before it ever
   *  reaches a prompt (the client-supplied object is untrusted input,
   *  same as jobDescription). */
  resumeProfile?: ResumeProfile;
}

export interface SessionData {
  id: string;
  userId: string | null;
  techStack: string;
  provider: string;
  model: string;
  /** Interview difficulty level this session was started at — see
   *  difficultyLevels.ts. Every downstream prompt call (extend, per-answer
   *  evaluation, final summary, answer guidance) reads this back off the
   *  session rather than re-accepting it per call, so a session stays at
   *  the level it started at for its whole lifetime. Always present on a
   *  full SessionData (backed by the column's own DB default — see
   *  toSessionData); a `Partial<SessionData>` history-summary row (see
   *  toHistorySummary) may omit it, in which case every reader falls back
   *  to DEFAULT_DIFFICULTY_LEVEL via resolveDifficultyLevel, same as an
   *  unrecognized value. */
  difficultyLevel: DifficultyLevel;
  questions: QuestionData[];
  answers: AnswerData[];
  evaluations: EvaluationData[];
  status: string;
  finalEvaluation: FinalEvaluationData | null;
  jobDescription: string | null;
  questionHistory: string[] | null;
  extensionCount: number;
  totalQuestions: number;
  answeredCount?: number;
  interviewContext: InterviewContextEntry[] | null;
  userApiKeyUsed: boolean;
  /** Optional, unverified self-reported email tagged at start time — see
   *  StartSessionOptions.historyEmail and docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md. */
  historyEmail?: string | null;
  /** PII-stripped resume profile this session was started from — see
   *  RESUME_MODE_PLAN.md §5/§6. Null for every non-Resume session. The raw
   *  resume text is deliberately never stored anywhere — this profile is
   *  the only trace of it. Nullable (not required, unlike difficultyLevel)
   *  so no existing test factory or literal SessionData construction needs
   *  touching for this feature. */
  resumeProfile?: ResumeProfile | null;
  createdAt: string;
}

/** Distinguishes the two pinned Resume-mode openers from a normal
 *  technical question — see RESUME_MODE_PLAN.md §4.4/§4.5. Used both to
 *  tag QuestionData.kind and to pick the evaluation rubric variant
 *  (promptBuilder.ts's buildLevelEvaluationGuidance). */
export type QuestionKind = 'introduction' | 'project_narration' | 'technical';

export interface QuestionData {
  id: number;
  question: string;
  difficulty: string;
  topic: string;
  expectedKeywords: string[];
  /** Absent means 'technical', so every existing question row and every
   *  non-Resume interview is completely unaffected by this field's
   *  existence. */
  kind?: QuestionKind;
}

export interface AnswerData {
  questionId: number;
  text: string;
  timestamp: string;
}

export interface EvaluationData {
  questionId: number;
  /** See EvaluationStatus. Absent on rows written before this field
   *  existed — those legacy rows are still fully readable (see
   *  interview.service.ts's isEvaluationCompleted). */
  status?: EvaluationStatus;
  // Optional (not just on EvaluationResult) because a question can be
  // answered-but-not-yet-scored placeholder entry gets written with no
  // score at all — see interview.service.ts's decoupled evaluation design.
  // Only `completed` evaluations contribute to the overall-score average
  // (see computeOverallScore) — an absent/pending/processing/failed score
  // is excluded from the denominator entirely, never counted as a zero.
  score?: number;
  /** Legacy single blended write-up field. No longer written by new
   *  evaluations (see EvaluationResult) — kept optional purely so rows
   *  saved before the structured-fields change stay readable without a
   *  migration. Also reused for the two short synthetic placeholder
   *  messages (processing / all-providers-failed / timed-out). */
  feedback?: string;
  /** One-or-two-sentence overall take on this answer (new, structured). */
  summary?: string;
  /** What the candidate got right (new, structured). Empty string, not
   *  absent, when the AI found genuinely nothing — absent means "not
   *  evaluated with the structured schema at all" (legacy row). */
  strengths?: string;
  /** What was missing, incorrect, or shallow (new, structured). */
  gaps?: string;
  /** Concrete, actionable advice specific to this answer (new, structured). */
  improvementAreas?: string;
  betterAnswer?: string;
  /** 1-4 concepts/topics worth studying further, based on this answer
   *  (new, structured). */
  studyPoints?: string[];
  /** True only for a synthetic placeholder written when scoring couldn't
   *  complete (all providers failed, or it didn't finish before the
   *  session ended) — lets the UI show a clear "not scored" state instead
   *  of a generic "no feedback available". Superseded in meaning by
   *  `status === 'failed'` for rows written after this change, but kept so
   *  older `unavailable: true` rows (no `status` field) still render
   *  correctly. */
  unavailable?: boolean;
  /** Which provider actually produced this result (for logging/debugging —
   *  RICH_EVALUATION_SCALE_PLAN.md §3). */
  provider?: string;
  /** ISO timestamp of when this evaluation was written. */
  evaluatedAt?: string;
  /** On-demand "how would I answer this" guidance, fetched only for a
   *  question whose scoring genuinely failed (status 'failed' /
   *  unavailable) — see interview.service.ts's getAnswerGuidance. Absent
   *  until the candidate actually asks for it; cached here once fetched so
   *  revisiting the page doesn't re-call the AI. Never present alongside a
   *  real score — this is strictly the failure-state affordance. */
  guidance?: string;
  /** Staff/Principal-only deep verification results — see
   *  DIFFICULTY_LEVEL_PLAN.md §2.4 and EvaluationResult.claimVerification.
   *  Absent at every other level, and absent on every row scored before
   *  this feature existed — purely additive, never required for the UI to
   *  render a question's other fields. */
  claimVerification?: ClaimVerificationItem[];
  /** Staff/Principal-only single follow-up challenge question — see
   *  EvaluationResult.followUpChallenge. */
  followUpChallenge?: string;
}

export interface FinalEvaluationData {
  overallScore: number;
  overallFeedback: string;
  /** Tracks whether `overallFeedback` was generated against the CURRENT
   *  set of evaluations, or a late-arriving per-question result has landed
   *  since — see RICH_EVALUATION_SCALE_PLAN.md §6. `overallScore` is
   *  always kept current regardless (see computeOverallScore); only the
   *  narrative can go stale, since it's the piece that would otherwise
   *  require another AI call to refresh. Absent on rows written before
   *  this field existed — treat as 'generated' (nothing to mark stale
   *  against, no evaluations changed since those rows finished). */
  overallFeedbackStatus?: 'generated' | 'stale';
  /** How many of this session's evaluations counted toward `overallScore`
   *  the last time it was computed — i.e. had status 'completed' (or, for
   *  legacy rows, a numeric score with no status field at all). */
  evaluationsCompleted?: number;
  /** Total answered questions this session has (not the interview's full
   *  question count — matches evaluationsCompleted's denominator context). */
  evaluationsTotal?: number;
}

export interface InterviewContextEntry {
  question: string;
  answer: string;
  score: number;
  topic: string;
}

// ─── Auth domain ─────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
}

export interface JwtPayload {
  sub: string; // user id
  email: string;
  iat?: number;
  exp?: number;
}

// Augment Express's Request type with the fields our middleware attaches.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}
