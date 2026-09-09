import { v4 as uuidv4 } from 'uuid';
import aiFactory from './ai/aiFactory';
import apiKeyService from './apiKey.service';
import interviewRepository from '../repositories/interview.repository';
import interviewEvents from './interviewEvents';
import { BaseAIService } from './ai/baseService';
import transcriptionService from './ai/transcriptionService';
import {
  SessionData,
  StartSessionOptions,
  QuestionData,
  AnswerData,
  EvaluationData,
  InterviewContextEntry,
  ProviderSwitchNotice,
  EvaluationDigestItem,
  FinalEvaluationData,
  ResumeProfile,
  TranscriptionResult,
} from '../types';
import config from '../config/config';
import { resolveDifficultyLevel } from '../config/difficultyLevels';
import { validateResumeProfile } from './ai/baseService';
import { AppError } from '../utils/appError';
import logger from '../utils/logger';

// ─── Extend-session ceilings ────────────────────────────────────────────────
// See docs/audit/02-BACKLOG-P4-P10.md [P4-02] and extendSession's doc
// comment. Deliberately generous — these exist to bound worst-case prompt
// size and row size, not to constrain normal usage. Exported (not just
// module-private) so the [P4-02] characterization tests reference the real
// ceiling values instead of hardcoding numbers that could silently drift
// out of sync with these.
export const MAX_TOTAL_QUESTIONS = 150;
export const MAX_EXTENSIONS = 10;
export const EXTEND_CONTEXT_WINDOW = 30;

// ─── Resume-mode opening sequence ───────────────────────────────────────────
// See docs/project-improvement/RESUME_MODE_PLAN.md §4.4. Built
// deterministically here rather than by asking the model to "please put
// these first" — a prompt instruction is a request, not a guarantee, and a
// model that ignores it would produce an interview missing the two
// questions this feature exists for.
const RESUME_PINNED_QUESTIONS = 2;
/** Resume mode's own floor, independent of config.app.questionsPerInterview
 *  — the two pinned openers come out of the same total, so below this there
 *  would be fewer than 3 technical questions. */
const MIN_RESUME_QUESTIONS = 5;

class InterviewService {
  /**
   * Tracks background per-question evaluations currently in flight, keyed
   * by `${sessionId}:${questionId}`. Populated by submitAnswer, consumed by
   * endSession's bounded wait (see below), and always cleaned up in the
   * evaluation's own `.finally()` regardless of how it resolves.
   */
  private pendingEvaluations = new Map<string, Promise<void>>();

  /**
   * Builds the fixed Resume-mode opening pair (§4.4) and prepends them to
   * the AI-generated technical questions, renumbering everything into one
   * contiguous 1..N id sequence. Q2 is personalized from the extracted
   * profile's top project when one exists — no extra AI call needed — and
   * falls back to generic phrasing otherwise. Called ONLY from
   * startSession; extendSession never calls this, so later extends never
   * re-prepend a second introduction.
   */
  private composeResumeOpeningQuestions(profile: ResumeProfile, technicalQuestions: QuestionData[]): QuestionData[] {
    const introduction: QuestionData = {
      id: 1,
      question:
        "Tell me about yourself — walk me through your background, what you've worked on, and how you got to where you are today.",
      difficulty: 'easy',
      topic: 'Introduction',
      expectedKeywords: [],
      kind: 'introduction',
    };

    const topProject = profile.projects?.[0];
    const projectQuestion: QuestionData = {
      id: 2,
      question: topProject
        ? `Walk me through this project from your resume: ${topProject.summary}${
            topProject.technologies?.length ? ` (built with ${topProject.technologies.join(', ')})` : ''
          }. Cover your role, the hardest part, and what you'd do differently.`
        : "Walk me through the project you're most proud of — your role, what you built, the hardest part, and what you'd do differently.",
      difficulty: 'medium',
      topic: 'Project Experience',
      expectedKeywords: [],
      kind: 'project_narration',
    };

    const renumberedTechnical = technicalQuestions.map((q, i) => ({
      ...q,
      id: i + RESUME_PINNED_QUESTIONS + 1,
      kind: 'technical' as const,
    }));

    return [introduction, projectQuestion, ...renumberedTechnical];
  }

  /**
   * Resolves the Gemini API key to use for this request: an explicit
   * ad-hoc key wins, otherwise fall back to the user's saved key (if any).
   * Both paths flow into the SAME per-request AI service instance — see
   * aiFactory.getService — never into shared mutable state.
   */
  private async resolveUserApiKey(
    userId: string | null,
    modelId: string,
    explicitKey?: string
  ): Promise<string | undefined> {
    if (explicitKey) return explicitKey;
    if (!userId) return undefined;
    if (!aiFactory.resolveModelInfo(modelId).provider.startsWith('google')) return undefined;
    const saved = await apiKeyService.getUserApiKey(userId, 'gemini');
    return saved ?? undefined;
  }

  /**
   * Persists a provider switch onto the session row (reusing the existing
   * `model`/`provider` columns — see docs/AI_PROVIDER_AUTO_SWITCH_PLAN.md)
   * so every subsequent call for this session goes straight to the working
   * provider instead of re-discovering the same failure from scratch.
   * Called only from the branch where a fallback call already succeeded.
   */
  private async persistProviderSwitch(
    sessionId: string,
    failedModelId: string,
    fallbackModelId: string,
    // 'primary_timeout' when the immediately-preceding attempt failed via
    // our own request timeout (createTimeoutSignal, ~120s — see
    // baseService.ts) rather than a genuine error response — lets the
    // client show "didn't respond in time" instead of "was unavailable".
    // See runWithProviderChain's `timedOut` return value.
    reason: string = 'primary_unavailable'
  ): Promise<ProviderSwitchNotice> {
    const fallbackInfo = aiFactory.resolveModelInfo(fallbackModelId);
    await interviewRepository.updateSession(sessionId, {
      model: fallbackModelId,
      provider: fallbackInfo.provider,
    });
    return {
      from: aiFactory.resolveModelInfo(failedModelId).provider,
      to: fallbackInfo.provider,
      reason,
    };
  }

  /** True for our own request-timeout abort (createTimeoutSignal in
   *  baseService.ts fires an AbortController after ~120s with no response)
   *  — as opposed to a genuine error response from the provider (4xx/5xx,
   *  a network failure, a malformed body). Both count as a "provider
   *  failed" for runWithProviderChain's fallback purposes, but the two are
   *  worth telling apart in the switch notice: "didn't respond in time" vs
   *  "was unavailable" are different things to tell the candidate. */
  private isProviderTimeout(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
  }

  /**
   * Runs `call` against every configured provider in `aiFactory`'s chain,
   * in order, until one succeeds — see
   * docs/project-improvement/RICH_EVALUATION_SCALE_PLAN.md §1/§9 (decided:
   * no scheduled background sweep; instead cycle through every configured
   * provider, 2 retries each via withRetry, before it counts as a genuine
   * permanent failure). Replaces the old duplicated
   * try-primary/catch/try-fallback pattern that used to live inline in
   * startSession, _evaluateAndPersist, endSession, and extendSession.
   *
   * `label` is only for logging (call type — matches §5's decided logging
   * plan) and the error message on total failure; it never appears in any
   * AI prompt.
   */
  private async runWithProviderChain<T>(
    modelId: string,
    userApiKey: string | undefined,
    label: string,
    call: (service: BaseAIService) => Promise<T>,
    logFields: { sessionId?: string; questionId?: number } = {}
  ): Promise<{ result: T; usedModelId: string; switched: boolean; timedOut: boolean }> {
    const chain = aiFactory.getProviderChain(modelId, userApiKey);
    if (chain.length === 0) {
      throw new AppError('No AI providers are currently configured.', 503);
    }

    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
      const { modelId: candidateModelId, service } = chain[i];
      try {
        const result = await call(service);
        if (i > 0) {
          logger.warn(`${label}: succeeded after switching provider`, {
            ...logFields,
            callType: label,
            provider: aiFactory.resolveModelInfo(candidateModelId).provider,
            attemptIndex: i,
            chainLength: chain.length,
            previousAttemptTimedOut: this.isProviderTimeout(lastError),
          });
        }
        // `timedOut` reflects the attempt immediately before this success —
        // i.e. what actually caused the switch a caller sees, not whether
        // ANY earlier attempt in the chain happened to time out. Only
        // meaningful when switched (i > 0); false (and irrelevant) on a
        // first-try success.
        return { result, usedModelId: candidateModelId, switched: i > 0, timedOut: i > 0 && this.isProviderTimeout(lastError) };
      } catch (error) {
        lastError = error;
        logger.warn(`${label}: provider failed`, {
          ...logFields,
          callType: label,
          provider: aiFactory.resolveModelInfo(candidateModelId).provider,
          attemptIndex: i,
          chainLength: chain.length,
          nextProvider:
            i + 1 < chain.length ? aiFactory.resolveModelInfo(chain[i + 1].modelId).provider : undefined,
          statusCode: error instanceof AppError ? error.statusCode : undefined,
          timedOut: this.isProviderTimeout(error),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.error(`${label}: all providers exhausted`, {
      ...logFields,
      callType: label,
      chainLength: chain.length,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError instanceof AppError
      ? lastError
      : new AppError(`All AI providers are currently unavailable for ${label}. Please try again in a few moments.`, 503);
  }

  /** A question's evaluation counts toward the overall-score average once
   *  it's `completed` — or, for a row written before the status field
   *  existed, once it has a numeric score with no status at all (legacy
   *  rows only ever got written after their AI call resolved, so their
   *  mere existence with a score already meant "done"). See
   *  RICH_EVALUATION_SCALE_PLAN.md §6. */
  private isEvaluationCompleted(e: EvaluationData): boolean {
    return e.status === 'completed' || (!e.status && typeof e.score === 'number');
  }

  /**
   * Strict mathematical average of completed-question scores, out of 100.
   * Only `completed` evaluations contribute — pending/processing/failed
   * questions are excluded from the denominator entirely, never counted as
   * a zero (decided in RICH_EVALUATION_SCALE_PLAN.md §6, with your exact
   * example: (80+90+70)/3, not (80+90+0+70)/4).
   */
  private computeOverallScore(evaluations: EvaluationData[]): number {
    const completed = (evaluations || []).filter((e) => this.isEvaluationCompleted(e));
    if (completed.length === 0) return 0;
    const total = completed.reduce((sum, e) => sum + (typeof e.score === 'number' ? e.score : 0), 0);
    return Math.round((total / (completed.length * 10)) * 100);
  }

  /**
   * Builds the compact per-question digest fed to the final holistic
   * evaluation call — see RICH_EVALUATION_SCALE_PLAN.md §2. Every answered
   * question contributes one line (topic + score + a short summary),
   * regardless of whether its evaluation is completed or failed, so the
   * final narrative can still acknowledge a question that never got
   * scored — same coverage the old raw-transcript version had, at a
   * fraction of the size. Each summary is capped so even a large
   * interview's digest stays small.
   */
  private buildEvaluationDigest(session: SessionData): EvaluationDigestItem[] {
    const MAX_SUMMARY_CHARS = 220;
    const digest: EvaluationDigestItem[] = [];
    for (const q of session.questions) {
      const answer = session.answers?.find((a) => a.questionId === q.id);
      if (!answer) continue; // unanswered — nothing to digest
      const evalEntry = session.evaluations?.find((e) => e.questionId === q.id);
      const rawSummary =
        evalEntry?.summary || // new structured field
        evalEntry?.feedback || // legacy blended field, still useful if that's all we have
        'Not scored in time.';
      const summary =
        rawSummary.length > MAX_SUMMARY_CHARS ? `${rawSummary.slice(0, MAX_SUMMARY_CHARS)}…` : rawSummary;
      const item: EvaluationDigestItem = {
        topic: q.topic || 'General',
        summary,
      };
      if (typeof evalEntry?.score === 'number') {
        item.score = evalEntry.score;
      }
      digest.push(item);
    }
    return digest;
  }

  /**
   * Resume-mode pass 1 — see RESUME_MODE_PLAN.md §4.1/§9. Runs standalone,
   * BEFORE a session exists, so the client can show what was detected and
   * let the candidate fix it before POST /start ever runs. Goes through
   * the same provider-fallback chain as every other AI call in this
   * service; `modelId` defaults to 'groq' since the setup page's own model
   * picker may not have been touched yet when this runs.
   */
  async analyzeResume(
    userId: string | null,
    resumeText: string,
    modelId: string = 'groq',
    userApiKey?: string
  ): Promise<{ profile: ResumeProfile; providerSwitch: ProviderSwitchNotice | null }> {
    const resolvedApiKey = await this.resolveUserApiKey(userId, modelId, userApiKey);
    const { result: profile, usedModelId, switched } = await this.runWithProviderChain(
      modelId,
      resolvedApiKey,
      'resume analysis',
      (service) => service.extractResumeProfile(resumeText)
    );
    const providerSwitch: ProviderSwitchNotice | null = switched
      ? {
          from: aiFactory.resolveModelInfo(modelId).provider,
          to: aiFactory.resolveModelInfo(usedModelId).provider,
          reason: 'primary_unavailable',
        }
      : null;
    return { profile, providerSwitch };
  }

  async startSession(
    userId: string | null,
    techStack: string,
    modelId: string,
    questionsCount: number | undefined,
    options: StartSessionOptions = {}
  ): Promise<{ session: SessionData; providerSwitch: ProviderSwitchNotice | null }> {
    const sessionId = uuidv4();

    // Whether the caller explicitly chose a count (vs. falling through to
    // a server default) — threaded into GenerationOptions so
    // getJDQuestionsPrompt knows whether to honor a count below its
    // normal 15-question floor. See RESUME_MODE_PLAN.md §7.1.
    const explicitQuestionCount = !!(questionsCount && questionsCount > 0);

    let count: number;
    if (explicitQuestionCount) {
      count = questionsCount as number;
    } else if (techStack === 'Job Description') {
      count = config.app.jdQuestionsPerInterview;
    } else {
      count = config.app.questionsPerInterview;
    }
    // Resume mode enforces its own floor regardless of what was
    // requested: the two pinned openers (§4.4) come out of the same
    // total, so below 5 there would be fewer than three technical
    // questions. See RESUME_MODE_PLAN.md §7.2.
    if (techStack === 'Resume' && count < MIN_RESUME_QUESTIONS) {
      count = MIN_RESUME_QUESTIONS;
    }

    // Resume mode requires an already-analyzed profile (POST
    // /resume/analyze — see RESUME_MODE_PLAN.md §9). The controller
    // already 400s on a missing one; this is the same check as
    // defense-in-depth for any caller that reaches startSession directly.
    // The profile is untrusted input regardless of source (it round-trips
    // through the client between /analyze and /start) — re-validated here
    // exactly like an AI response would be, so a caller can't smuggle
    // oversized arrays or unbounded strings into the question-generation
    // prompt. See RESUME_MODE_PLAN.md §9's "trust question".
    let resolvedResumeProfile: ResumeProfile | null = null;
    if (techStack === 'Resume') {
      if (!options.resumeProfile) {
        throw new AppError('Resume analysis is required for Resume mode', 400);
      }
      resolvedResumeProfile = validateResumeProfile(options.resumeProfile, 'client-submitted', 400);
    }

    const resolvedApiKey = await this.resolveUserApiKey(userId, modelId, options.userApiKey);
    // Resolved once here (falls back to DEFAULT_DIFFICULTY_LEVEL for an
    // absent value — the route layer's oneOf allowlist already rejects an
    // unrecognized one before this ever runs) and threaded through both the
    // question-generation call below AND the session row itself, so every
    // later call for this session (extend, per-answer evaluation, final
    // summary, answer guidance) can just read session.difficultyLevel back
    // instead of re-resolving it — see DIFFICULTY_LEVEL_PLAN.md §3.4.
    const difficultyLevel = resolveDifficultyLevel(options.difficultyLevel).id;
    const generationOptions = {
      jobDescription: options.jobDescription,
      level: difficultyLevel,
      explicitQuestionCount,
      resumeProfile: resolvedResumeProfile ?? undefined,
    };

    // Resume mode asks the AI for only the TECHNICAL questions — the two
    // openers below are composed deterministically, not AI-generated, so
    // they can never be skipped or reordered by a model that ignores the
    // prompt. See RESUME_MODE_PLAN.md §4.4.
    const aiRequestedCount = techStack === 'Resume' ? count - RESUME_PINNED_QUESTIONS : count;

    // Cycles through every configured provider (not just one fallback)
    // before giving up — see runWithProviderChain's doc comment and
    // RICH_EVALUATION_SCALE_PLAN.md §1/§9.
    const { result: aiQuestions, usedModelId: effectiveModelId, switched } = await this.runWithProviderChain(
      modelId,
      resolvedApiKey,
      'question generation',
      (service) => service.generateQuestions(techStack, aiRequestedCount, generationOptions),
      { sessionId }
    );
    const questions =
      techStack === 'Resume' ? this.composeResumeOpeningQuestions(resolvedResumeProfile as ResumeProfile, aiQuestions) : aiQuestions;
    // The session row doesn't exist yet — no DB write needed to "switch,"
    // just create it with the winning model/provider directly. Still
    // surfaced as a providerSwitch notice so the client can show the same
    // one-time notice as a mid-session switch.
    const providerSwitch: ProviderSwitchNotice | null = switched
      ? {
          from: aiFactory.resolveModelInfo(modelId).provider,
          to: aiFactory.resolveModelInfo(effectiveModelId).provider,
          reason: 'primary_unavailable',
        }
      : null;

    const modelInfo = aiFactory.resolveModelInfo(effectiveModelId);
    const questionHistory = questions.map((q) => q.question);

    // Optional, unverified self-reported email (see
    // docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md — Option B, no PIN/verification).
    // Normalized here (trim + lowercase) so every later lookup is a plain
    // equality match, same normalization login/register already use for
    // real accounts. Blank/whitespace-only input is treated as "not
    // provided" rather than stored as an empty-string tag.
    const normalizedHistoryEmail = options.historyEmail?.trim().toLowerCase() || undefined;

    const sessionData: SessionData = {
      id: sessionId,
      userId,
      techStack,
      provider: modelInfo.provider,
      model: effectiveModelId,
      difficultyLevel,
      questions,
      answers: [],
      evaluations: [],
      status: 'active',
      finalEvaluation: null,
      jobDescription: options.jobDescription || null,
      questionHistory,
      extensionCount: 0,
      totalQuestions: questions.length,
      interviewContext: null,
      userApiKeyUsed: !!resolvedApiKey,
      historyEmail: normalizedHistoryEmail ?? null,
      resumeProfile: resolvedResumeProfile,
      createdAt: new Date().toISOString(),
    };

    await interviewRepository.createSession(sessionData);
    return { session: sessionData, providerSwitch };
  }

  /** Throws 404 if missing, 403 if it belongs to a different user. */
  private async getOwnedSession(sessionId: string, userId: string | null): Promise<SessionData> {
    const session = await interviewRepository.getSession(sessionId);
    if (!session) throw new AppError('Session not found', 404);
    // Sessions created before auth existed (or by an anonymous flow) have a
    // null userId and are only reachable by their creator's original,
    // unauthenticated path — treat any authenticated mismatch as forbidden.
    if (session.userId && session.userId !== userId) {
      throw new AppError('Session not found', 404);
    }
    return session;
  }

  /**
   * Records a submitted answer and returns immediately — evaluation runs in
   * the background (see _evaluateAndPersist) instead of blocking the
   * caller. Previously this method (then called processAnswer) awaited the
   * full AI evaluation call before returning, which meant the client
   * couldn't move to the next question until scoring the CURRENT one had
   * finished — every retry/backoff/fallback delay landed directly in the
   * middle of the interview. The next question's text is already known
   * (all questions are generated upfront in startSession), so there's no
   * real reason progression needs to wait on evaluation at all.
   */
  async submitAnswer(
    sessionId: string,
    userId: string | null,
    questionId: number,
    answerText: string
  ): Promise<{ session: SessionData }> {
    const session = await this.getOwnedSession(sessionId, userId);

    if (session.status === 'completed') {
      throw new AppError('This session has already been completed', 400);
    }

    const question = session.questions.find((q) => q.id === questionId);
    if (!question) throw new AppError('Question not found', 404);

    const alreadyAnswered = session.answers?.some((a) => a.questionId === questionId);
    if (alreadyAnswered) {
      throw new AppError(`Question ${questionId} has already been answered`, 409);
    }

    const newAnswer: AnswerData = { questionId, text: answerText, timestamp: new Date().toISOString() };
    const result = await interviewRepository.recordAnswer(sessionId, newAnswer);

    // Never report success on a write that persisted nowhere — see
    // docs/audit/01-BACKLOG-P0-P3.md [P1-03]. The session existed moments
    // ago (getOwnedSession above), but if neither the database nor the
    // in-memory fallback has a matching entry now, the answer simply
    // wasn't saved anywhere — surface that honestly instead of silently
    // falling back to the stale pre-write `session` object and telling the
    // caller it worked.
    if (result.outcome === 'not_found') {
      throw new AppError('Unable to save your answer right now — please try again.', 503);
    }
    // Lost a race with a concurrent submission for the same question. The
    // `alreadyAnswered` check above only catches the common, non-racing
    // case; this outcome comes from the repository's check INSIDE its
    // per-session lock, which is what actually closes the race — see
    // docs/audit/01-BACKLOG-P0-P3.md [P2-05].
    if (result.outcome === 'duplicate') {
      throw new AppError(`Question ${questionId} has already been answered`, 409);
    }
    const updated = result.session;

    // Fire-and-forget: NOT awaited, so submitAnswer returns as soon as the
    // answer itself is safely recorded. Every branch inside
    // _evaluateAndPersist is caught internally (it never rejects), and the
    // .catch() here is an extra belt-and-braces guard — an unhandled
    // rejection on this promise would trip server.ts's unhandledRejection
    // guard and crash the whole process, so nothing may escape unhandled.
    const key = `${sessionId}:${questionId}`;
    const evalPromise = this._evaluateAndPersist(sessionId, session, question, answerText)
      .catch((err) => {
        // Should be unreachable — _evaluateAndPersist catches everything
        // internally — this is a belt-and-braces log in case that
        // invariant is ever broken.
        logger.error('Background evaluation failed unexpectedly', {
          sessionId,
          questionId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.pendingEvaluations.delete(key);
      });
    this.pendingEvaluations.set(key, evalPromise);

    return { session: updated };
  }

  /**
   * Runs a server-side ASR pass over a candidate's recorded answer audio
   * and returns the transcript — see
   * docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md and
   * transcriptionService.ts. Purely additive to the answer flow: this
   * never writes anything to the session (the client still submits the
   * final text itself via submitAnswer, same as today — this only
   * produces a better draft of that text for the candidate to review). The
   * audio buffer passed in is never persisted here or in
   * transcriptionService — it lives only for the duration of this call.
   *
   * Mirrors submitAnswer's guard rails (ownership, session not completed,
   * question exists, not already answered) so a client can't burn a
   * transcription call against a question that could no longer accept the
   * result anyway.
   */
  async transcribeAnswer(
    sessionId: string,
    userId: string | null,
    questionId: number,
    audioBuffer: Buffer,
    contentType: string
  ): Promise<TranscriptionResult> {
    const session = await this.getOwnedSession(sessionId, userId);

    if (session.status === 'completed') {
      throw new AppError('This session has already been completed', 400);
    }

    const question = session.questions.find((q) => q.id === questionId);
    if (!question) throw new AppError('Question not found', 404);

    const alreadyAnswered = session.answers?.some((a) => a.questionId === questionId);
    if (alreadyAnswered) {
      throw new AppError(`Question ${questionId} has already been answered`, 409);
    }

    return transcriptionService.transcribe({
      audioBuffer,
      contentType,
      techStack: session.techStack,
      topic: question.topic,
      expectedKeywords: question.expectedKeywords,
    });
  }

  /**
   * Evaluates one answer and persists the result. Always resolves (never
   * rejects) — on total failure (every configured provider down) it writes
   * a synthetic `status: 'failed'` placeholder rather than leaving the
   * question with no evaluation entry at all, so endSession's bounded wait
   * (below) never has to distinguish "still running" from "failed
   * silently."
   *
   * Writes a `status: 'processing'` placeholder BEFORE calling the AI (see
   * RICH_EVALUATION_SCALE_PLAN.md §4) so anything inspecting evaluations
   * mid-flight — including endSession's own bounded-wait check just below
   * this method — can tell "AI call in flight" apart from "answer saved,
   * nothing started yet" (implicit: no entry at all).
   */
  private async _evaluateAndPersist(
    sessionId: string,
    session: SessionData,
    question: QuestionData,
    answerText: string
  ): Promise<void> {
    const questionId = question.id;

    await interviewRepository.recordEvaluation(sessionId, {
      questionId,
      status: 'processing',
    });

    let providerSwitch: ProviderSwitchNotice | null = null;
    let evaluationEntry: EvaluationData;

    try {
      const { result: evaluation, usedModelId, switched, timedOut } = await this.runWithProviderChain(
        session.model,
        undefined, // per-answer evaluation has never used the caller's own Gemini key — unchanged behavior
        'answer evaluation',
        (service) => service.evaluateAnswer(question.question, answerText, session.difficultyLevel, question.kind),
        { sessionId, questionId }
      );
      if (switched) {
        // Only this call site (per-answer scoring — what the candidate is
        // actively waiting on) distinguishes 'primary_timeout' for the
        // client's wording; the other runWithProviderChain call sites
        // (question generation, extend, final digest) keep the generic
        // default reason.
        providerSwitch = await this.persistProviderSwitch(
          sessionId,
          session.model,
          usedModelId,
          timedOut ? 'primary_timeout' : 'primary_unavailable'
        );
      }

      evaluationEntry = {
        questionId,
        status: 'completed',
        score: evaluation.score,
        summary: evaluation.summary,
        strengths: evaluation.strengths,
        gaps: evaluation.gaps,
        improvementAreas: evaluation.improvementAreas,
        betterAnswer: evaluation.betterAnswer,
        studyPoints: evaluation.studyPoints,
        // Staff/Principal-only deep-verification fields — see
        // DIFFICULTY_LEVEL_PLAN.md §2.4. Only ever present on
        // `evaluation` when the level requested them (see
        // promptBuilder.ts's buildDeepVerificationInstructions and
        // baseService.ts's validateEvaluation); spreading conditionally
        // here keeps them absent (not present-but-empty) on every
        // non-Staff evaluation, same as the AI-facing result shape.
        ...(evaluation.claimVerification ? { claimVerification: evaluation.claimVerification } : {}),
        ...(evaluation.followUpChallenge ? { followUpChallenge: evaluation.followUpChallenge } : {}),
        provider: aiFactory.resolveModelInfo(usedModelId).provider,
        evaluatedAt: new Date().toISOString(),
      };
      const contextEntry: InterviewContextEntry = {
        question: question.question,
        answer: answerText,
        score: evaluation.score,
        topic: question.topic,
      };
      await interviewRepository.recordEvaluation(sessionId, evaluationEntry, contextEntry);
    } catch {
      // Every configured provider was tried (including at least one
      // request-timeout retry — see runWithProviderChain) and all failed —
      // record a placeholder so this question is never silently left
      // without any evaluation entry at all (runWithProviderChain already
      // logged full detail per §5). This is the state the client shows a
      // "How would I answer this?" button for (see getAnswerGuidance) —
      // it's a genuine exhaustion, not a timing issue that self-heals.
      evaluationEntry = {
        questionId,
        status: 'failed',
        feedback: "We weren't able to get AI feedback for this question — every configured AI provider failed. Your answer was still recorded.",
        unavailable: true,
      };
      await interviewRepository.recordEvaluation(sessionId, evaluationEntry);
    }

    interviewEvents.emitAnswerEvaluated({ sessionId, questionId, evaluation: evaluationEntry });
    if (providerSwitch) {
      interviewEvents.emitProviderSwitch({ sessionId, ...providerSwitch });
    }

    // Keeps the aggregate score honest if this evaluation landed AFTER the
    // interview was already marked completed — see §6. A no-op read+skip
    // for the overwhelmingly common case (session still active).
    await this._maybeRefreshAggregateScore(sessionId);
  }

  /**
   * If this session is already `completed`, recomputes and persists
   * `overallScore` from the current evaluations (only `completed` ones
   * count — see computeOverallScore) and marks the narrative
   * `overallFeedbackStatus: 'stale'` if anything actually changed. Never
   * re-runs the narrative itself — that's a separate, deliberately manual
   * action (see refreshOverallFeedback) — decided in
   * RICH_EVALUATION_SCALE_PLAN.md §6 specifically to avoid an extra AI
   * call, extra latency, and race conditions every time a straggler lands.
   */
  private async _maybeRefreshAggregateScore(sessionId: string): Promise<void> {
    // Wrapped in updateSessionWith so the read-recompute-write is atomic
    // against a concurrent evaluation landing for the same session — see
    // docs/audit/01-BACKLOG-P0-P3.md [P3-09]. Without the lock, two
    // per-question evaluations finishing close together (the normal case,
    // since scoring is deliberately fire-and-forget) could each read the
    // same pre-update finalEvaluation here, and whichever write landed
    // second would silently clobber the other's more current score/count
    // instead of building on it.
    await interviewRepository.updateSessionWith(sessionId, (current) => {
      if (current.status !== 'completed' || !current.finalEvaluation) return undefined;

      const evaluations = current.evaluations || [];
      const newScore = this.computeOverallScore(evaluations);
      const completedCount = evaluations.filter((e) => this.isEvaluationCompleted(e)).length;
      const totalCount = current.totalQuestions ?? current.questions.length;

      const prev = current.finalEvaluation;
      if (newScore === prev.overallScore && completedCount === (prev.evaluationsCompleted ?? completedCount)) {
        return undefined; // nothing actually changed — skip a redundant write
      }

      const updated: FinalEvaluationData = {
        ...prev,
        overallScore: newScore,
        evaluationsCompleted: completedCount,
        evaluationsTotal: totalCount,
        overallFeedbackStatus: 'stale',
      };
      return { finalEvaluation: updated };
    });
  }

  async endSession(
    sessionId: string,
    userId: string | null
  ): Promise<{ session: SessionData | undefined; providerSwitch: ProviderSwitchNotice | null }> {
    let session = await this.getOwnedSession(sessionId, userId);

    if (session.status === 'completed') {
      return { session, providerSwitch: null }; // Idempotent — already completed.
    }

    // Waits for any of this session's answered-but-not-yet-scored questions
    // to actually finish evaluating in the background — see the "wait for
    // real completion" decision this replaced the old fixed 15s bounded
    // wait with: "End Interview" now shows every answered question's real
    // AI feedback, never a "wasn't ready in time" placeholder for something
    // that would have scored fine given a few more seconds. This is safe to
    // await without its own extra timer because each individual evaluation
    // ALREADY has a bounded worst case: runWithProviderChain retries every
    // configured provider in turn, and each attempt is capped by that
    // provider's own request timeout (createTimeoutSignal, 120s — see
    // baseService.ts) before moving on. So the real ceiling here is
    // "however many providers are configured × ~120s", not unbounded — and
    // _evaluateAndPersist's own try/catch guarantees its promise always
    // resolves (never rejects) with a terminal 'completed' or 'failed'
    // evaluation entry once that chain is exhausted, so there's nothing
    // left needing a race against a clock.
    // A question with NO evaluation entry at all is implicitly pending; one
    // with `status: 'processing'` is explicitly still in flight (see §4) —
    // both count as "not done yet" for this wait. A `completed` or `failed`
    // entry (or a legacy row with no status field, which only ever got
    // written once its AI call had already resolved) is done either way.
    const isStillInFlight = (session: SessionData, qid: number): boolean => {
      const e = (session.evaluations || []).find((ev) => ev.questionId === qid);
      return !e || e.status === 'processing';
    };

    const unevaluatedIds = (session.answers || [])
      .map((a) => a.questionId)
      .filter((qid) => isStillInFlight(session, qid));

    if (unevaluatedIds.length > 0) {
      const pending = unevaluatedIds
        .map((qid) => this.pendingEvaluations.get(`${sessionId}:${qid}`))
        .filter((p): p is Promise<void> => !!p);

      if (pending.length > 0) {
        // Wait for every in-flight evaluation to actually settle — see this
        // method's doc comment above for why no outer timer is needed here
        // any more: each promise's own worst case is already bounded by
        // runWithProviderChain's provider-chain exhaustion, and it never
        // rejects, so Promise.allSettled here can't hang on anything this
        // process itself controls. (It CAN still take a while in the
        // unlucky case where a provider genuinely uses its full per-attempt
        // timeout — that's the deliberate trade-off: real results over a
        // fast but sometimes-wrong placeholder.)
        await Promise.allSettled(pending);
      }

      // Re-fetch — the wait above let every in-flight evaluation land.
      session = await this.getOwnedSession(sessionId, userId);

      // Anything STILL unevaluated at this point never had a promise to
      // wait on in the first place (e.g. lost from `pendingEvaluations`
      // across a process restart mid-interview) — a genuine edge case, not
      // the normal "still scoring" path any more. Gets a placeholder so the
      // final view always shows something for every answered question
      // rather than a silent gap.
      const stillMissing = (session.answers || [])
        .map((a) => a.questionId)
        .filter((qid) => isStillInFlight(session, qid));

      for (const qid of stillMissing) {
        await interviewRepository.recordEvaluation(sessionId, {
          questionId: qid,
          status: 'failed',
          feedback: "Scoring wasn't ready when the interview ended — your answer was recorded but not scored in time.",
          unavailable: true,
        });
      }
      if (stillMissing.length > 0) {
        session = await this.getOwnedSession(sessionId, userId);
      }
    }

    const answeredCount = (session.answers || []).length;
    const totalCount = session.questions.length;

    let finalEval: FinalEvaluationData;
    let providerSwitch: ProviderSwitchNotice | null = null;

    if (answeredCount === 0) {
      finalEval = {
        overallScore: 0,
        overallFeedback: 'No questions were answered during this interview. Start a new session to practice your skills.',
        overallFeedbackStatus: 'generated',
        evaluationsCompleted: 0,
        evaluationsTotal: 0,
      };
    } else {
      // Compact digest, not the raw transcript — see buildEvaluationDigest
      // and RICH_EVALUATION_SCALE_PLAN.md §2. This is the actual fix for
      // the token-limit risk a raw-transcript final call has at 20-30+
      // questions.
      const digest = this.buildEvaluationDigest(session);
      const { result, switched, usedModelId } = await this.runWithProviderChain(
        session.model,
        undefined,
        'final evaluation',
        (service) => service.evaluateInterview(digest, session.difficultyLevel),
        { sessionId }
      );
      if (switched) {
        providerSwitch = await this.persistProviderSwitch(sessionId, session.model, usedModelId);
      }

      // Override the subjective AI overall score with a strict mathematical
      // average of only the COMPLETED question scores — see
      // computeOverallScore (excludes pending/processing/failed from the
      // denominator entirely, never counts them as a zero).
      const evaluationsCompleted = (session.evaluations || []).filter((e) => this.isEvaluationCompleted(e)).length;
      finalEval = {
        overallScore: this.computeOverallScore(session.evaluations || []),
        overallFeedback: result.overallFeedback,
        overallFeedbackStatus: 'generated',
        evaluationsCompleted,
        evaluationsTotal: answeredCount,
      };
    }

    await interviewRepository.updateSession(sessionId, {
      status: 'completed',
      finalEvaluation: finalEval,
      answeredCount,
      totalQuestions: totalCount,
    });

    return { session: await interviewRepository.getSession(sessionId), providerSwitch };
  }

  /**
   * Manually regenerates just the narrative (`overallFeedback`) for an
   * already-completed session — the only path that ever re-runs the
   * synthesis AI call after completion (see RICH_EVALUATION_SCALE_PLAN.md
   * §6: `overallScore` auto-refreshes on every late arrival, the narrative
   * deliberately does not, so this exists for when a person actually wants
   * an up-to-date write-up after a straggler landed).
   */
  async refreshOverallFeedback(
    sessionId: string,
    userId: string | null
  ): Promise<{ session: SessionData | undefined; providerSwitch: ProviderSwitchNotice | null }> {
    const session = await this.getOwnedSession(sessionId, userId);
    if (session.status !== 'completed') {
      throw new AppError('Only a completed interview has a final review to refresh.', 400);
    }

    const digest = this.buildEvaluationDigest(session);
    if (digest.length === 0) {
      throw new AppError('This interview has no answered questions to summarize.', 400);
    }

    const { result, switched, usedModelId } = await this.runWithProviderChain(
      session.model,
      undefined,
      'final review refresh',
      (service) => service.evaluateInterview(digest, session.difficultyLevel),
      { sessionId }
    );

    let providerSwitch: ProviderSwitchNotice | null = null;
    if (switched) {
      providerSwitch = await this.persistProviderSwitch(sessionId, session.model, usedModelId);
    }

    const evaluationsCompleted = (session.evaluations || []).filter((e) => this.isEvaluationCompleted(e)).length;
    const finalEval: FinalEvaluationData = {
      overallScore: this.computeOverallScore(session.evaluations || []),
      overallFeedback: result.overallFeedback,
      overallFeedbackStatus: 'generated',
      evaluationsCompleted,
      evaluationsTotal: session.answers?.length ?? 0,
    };

    await interviewRepository.updateSession(sessionId, { finalEvaluation: finalEval });

    return { session: await interviewRepository.getSession(sessionId), providerSwitch };
  }

  /**
   * On-demand "how would I answer this" guidance for a question whose own
   * scoring genuinely failed (every configured AI provider was tried and
   * failed — see _evaluateAndPersist's catch block). Deliberately does NOT
   * take the candidate's answer into account at all: nothing useful could
   * be said about it (it was never scored), so this gives guidance on the
   * QUESTION itself instead — independent, standalone, and worth showing
   * even though the original evaluation is a dead end.
   *
   * Scoped to only the failed/unavailable state on purpose (see the
   * eligibility check below) — this is specifically the failure-state
   * affordance, not a general "explain this question" feature available on
   * every card; a normally-scored question already has `betterAnswer` from
   * its own evaluation for that.
   *
   * The result is cached onto the evaluation entry (`guidance` field) so a
   * page reload doesn't re-trigger an AI call — see the merge below, which
   * goes through updateSessionWith (not recordEvaluation's full-replace)
   * specifically so it can't clobber the entry's other fields (status,
   * feedback, unavailable) written by _evaluateAndPersist's failure path.
   */
  async getAnswerGuidance(
    sessionId: string,
    userId: string | null,
    questionId: number
  ): Promise<{ session: SessionData | undefined; providerSwitch: ProviderSwitchNotice | null }> {
    const session = await this.getOwnedSession(sessionId, userId);

    const question = session.questions.find((q) => q.id === questionId);
    if (!question) {
      throw new AppError('This interview has no question with that id.', 404);
    }

    const evalEntry = (session.evaluations || []).find((e) => e.questionId === questionId);
    const isFailedEvaluation =
      !!evalEntry && (evalEntry.status === 'failed' || (!evalEntry.status && evalEntry.unavailable));
    if (!isFailedEvaluation) {
      throw new AppError(
        'Answer guidance is only available for a question whose scoring genuinely failed.',
        400
      );
    }

    // Already fetched (and cached) once — hand back the existing session
    // rather than paying for another AI call.
    if (evalEntry.guidance) {
      return { session, providerSwitch: null };
    }

    const { result, switched, usedModelId, timedOut } = await this.runWithProviderChain(
      session.model,
      undefined,
      'answer guidance',
      (service) => service.generateAnswerGuidance(question.question, question.topic, session.difficultyLevel, question.kind),
      { sessionId, questionId }
    );

    let providerSwitch: ProviderSwitchNotice | null = null;
    if (switched) {
      providerSwitch = await this.persistProviderSwitch(
        sessionId,
        session.model,
        usedModelId,
        timedOut ? 'primary_timeout' : 'primary_unavailable'
      );
    }

    const updated = await interviewRepository.updateSessionWith(sessionId, (current) => {
      const currentEntry = (current.evaluations || []).find((e) => e.questionId === questionId);
      if (!currentEntry) return undefined; // shouldn't happen — the entry existed moments ago
      const evaluations = [
        ...(current.evaluations || []).filter((e) => e.questionId !== questionId),
        { ...currentEntry, guidance: result.guidance },
      ];
      return { evaluations };
    });

    return { session: updated, providerSwitch };
  }

  async extendSession(
    sessionId: string,
    userId: string | null,
    additionalCount: number = 5
  ): Promise<{ session: SessionData | undefined; providerSwitch: ProviderSwitchNotice | null }> {
    const session = await this.getOwnedSession(sessionId, userId);

    // Hard ceilings — see docs/audit/02-BACKLOG-P4-P10.md [P4-02].
    // Previously unbounded: questions/questionHistory/interviewContext all
    // grow with every extend and are serialized whole into the NEXT
    // extend's prompt, so prompt size grows roughly quadratically with the
    // number of extends — the same token-budget failure mode this project
    // already hit and fixed once for the final evaluation (see
    // RICH_EVALUATION_SCALE_PLAN.md §2). Checked before the AI call so a
    // session already at a cap doesn't pay for a call it's about to reject.
    if ((session.extensionCount || 0) >= MAX_EXTENSIONS) {
      throw new AppError(
        `This interview has already been extended the maximum number of times (${MAX_EXTENSIONS}).`,
        400
      );
    }
    const currentTotal = session.questions.length;
    if (currentTotal >= MAX_TOTAL_QUESTIONS) {
      throw new AppError(`This interview has already reached the maximum of ${MAX_TOTAL_QUESTIONS} questions.`, 400);
    }
    const cappedAdditionalCount = Math.max(1, Math.min(additionalCount, MAX_TOTAL_QUESTIONS - currentTotal));

    const previousQuestions: string[] = session.questionHistory || session.questions.map((q) => q.question);
    // What actually gets SENT to the model is a recent window, not the
    // full history — questionHistory itself still accumulates in full
    // below (other code reads the complete list), only the prompt payload
    // is bounded, so prompt size stays flat regardless of how long the
    // interview has run.
    const previousQuestionsForPrompt = previousQuestions.slice(-EXTEND_CONTEXT_WINDOW);
    const interviewContextForPrompt = session.interviewContext
      ? session.interviewContext.slice(-EXTEND_CONTEXT_WINDOW)
      : undefined;

    const { result: newQuestions, switched, usedModelId } = await this.runWithProviderChain(
      session.model,
      undefined,
      'extend session',
      (service) =>
        service.generateQuestions(session.techStack, cappedAdditionalCount, {
          previousQuestions: previousQuestionsForPrompt,
          jobDescription: session.jobDescription || undefined,
          // Resume mode's extend re-passes the stored PROFILE, never the
          // raw resume text (which is never stored in the first place —
          // see RESUME_MODE_PLAN.md §5). getQuestionsPrompt's Resume
          // branch only activates when this is present, so a non-Resume
          // session (where resumeProfile is null) is unaffected.
          resumeProfile: session.resumeProfile || undefined,
          interviewContext: interviewContextForPrompt ? JSON.stringify(interviewContextForPrompt) : undefined,
          level: session.difficultyLevel,
          // No explicitQuestionCount here — extend keeps today's exact
          // floor behavior for JD mode, unchanged by RESUME_MODE_PLAN.md
          // §7.1 (that fix only applies to a fresh startSession call).
        }),
      { sessionId }
    );
    const providerSwitch: ProviderSwitchNotice | null = switched
      ? await this.persistProviderSwitch(sessionId, session.model, usedModelId)
      : null;

    const maxId = Math.max(...session.questions.map((q) => q.id), 0);
    newQuestions.forEach((q, i: number) => {
      q.id = maxId + i + 1;
    });

    const updatedQuestions = [...session.questions, ...newQuestions];
    const updatedHistory = [...previousQuestions, ...newQuestions.map((q) => q.question)];

    const updatePayload: Partial<SessionData> = {
      questions: updatedQuestions,
      questionHistory: updatedHistory,
      extensionCount: (session.extensionCount || 0) + 1,
      totalQuestions: updatedQuestions.length,
      status: 'active',
    };

    // Extending an already-COMPLETED interview must not destroy its
    // finished report — see docs/audit/01-BACKLOG-P0-P3.md [P1-01].
    // Previously this unconditionally nulled `finalEvaluation`, so a
    // candidate who extended a completed interview lost their score and
    // write-up entirely, even though it had already been generated and was
    // still valid for the questions it covered. Instead, keep it intact
    // and mark the narrative `stale` — the same shape
    // `_maybeRefreshAggregateScore` already produces when a late-arriving
    // evaluation invalidates a completed session's report — so the
    // existing refresh-banner UI just picks it up with no client changes.
    // A session that was still active has no finalEvaluation to begin
    // with, so there's nothing to touch in that case.
    if (session.status === 'completed' && session.finalEvaluation) {
      updatePayload.finalEvaluation = {
        ...session.finalEvaluation,
        overallFeedbackStatus: 'stale',
      };
    }

    await interviewRepository.updateSession(sessionId, updatePayload);

    return { session: await interviewRepository.getSession(sessionId), providerSwitch };
  }

  async getHistory(userId: string, limit: number = 20, offset: number = 0) {
    const sessions = await interviewRepository.listCompletedSessions(userId, limit, offset);
    return sessions.map((s) => ({
      id: s.id,
      techStack: s.techStack,
      model: s.model,
      provider: s.provider,
      difficultyLevel: resolveDifficultyLevel(s.difficultyLevel).id,
      overallScore: s.finalEvaluation?.overallScore ?? null,
      answeredCount: s.answeredCount ?? s.answers?.length ?? 0,
      totalQuestions: s.totalQuestions ?? s.questions?.length ?? 0,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Looks up completed sessions tagged with a self-reported email — see
   * docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md, Option B: explicitly chosen with
   * NO password/PIN/verification. Anyone who knows or guesses an email
   * used here can see that email's interview summaries (and, by opening
   * one, its full Q&A — GET /:sessionId is already public for any
   * userId-null session, same as the anonymous flow it reuses). That
   * trade-off was discussed and accepted explicitly; this is not an
   * oversight. Rate limiting lives at the route layer
   * (interview.routes.ts) to blunt bulk scraping, not targeted lookups.
   *
   * Same normalization as startSession (trim + lowercase) so a lookup for
   * "Foo@Bar.com" matches sessions tagged under "foo@bar.com".
   */
  async getHistoryByEmail(email: string, limit: number = 20, offset: number = 0) {
    const normalized = email.trim().toLowerCase();
    const sessions = await interviewRepository.listCompletedSessionsByEmail(normalized, limit, offset);
    return sessions.map((s) => ({
      id: s.id,
      techStack: s.techStack,
      model: s.model,
      provider: s.provider,
      difficultyLevel: resolveDifficultyLevel(s.difficultyLevel).id,
      overallScore: s.finalEvaluation?.overallScore ?? null,
      answeredCount: s.answeredCount ?? s.answers?.length ?? 0,
      totalQuestions: s.totalQuestions ?? s.questions?.length ?? 0,
      createdAt: s.createdAt,
    }));
  }

  async getSessionDetail(sessionId: string, userId: string | null) {
    return this.getOwnedSession(sessionId, userId);
  }

  /**
   * Migrates a batch of anonymous sessions (userId null) to a real
   * account, once that visitor logs in or registers. Sessions that don't
   * exist, or already belong to someone (anyone, including this same
   * caller), are silently skipped rather than erroring — this is called
   * with a client-supplied id list that may be stale or partially already
   * claimed, and partial success is the expected common case, not a
   * failure.
   */
  async claimSessions(sessionIds: string[], userId: string): Promise<number> {
    return interviewRepository.claimAnonymousSessions(sessionIds, userId);
  }
}

export default new InterviewService();
