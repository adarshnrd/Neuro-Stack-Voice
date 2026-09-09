import { Prisma, Session as PrismaSession } from '@prisma/client';
import { prisma } from '../config/database';
import {
  SessionData,
  QuestionData,
  AnswerData,
  EvaluationData,
  FinalEvaluationData,
  InterviewContextEntry,
  ResumeProfile,
} from '../types';
import { resolveDifficultyLevel, DEFAULT_DIFFICULTY_LEVEL } from '../config/difficultyLevels';
import logger from '../utils/logger';

/**
 * Converts a Prisma `Session` row into the app's `SessionData` shape — see
 * docs/audit/02-BACKLOG-P4-P10.md [P5-03]. Prisma's generated `Session` type
 * has `createdAt: Date` (a real `Date` object), while `SessionData`
 * (src/types/index.ts) declares `createdAt: string`. Every read call site in
 * this file used to close that gap with a single blanket `session as unknown
 * as SessionData` — under `strict` + `noImplicitAny` that is the one place
 * the type checker was told to stop checking, and it was hiding a genuine
 * mismatch: `listCompletedFromMemory`'s `new Date(s.createdAt)` happens to
 * work whether `createdAt` is really a string (the in-memory path) or,
 * masked by that cast, actually a `Date` (the database path) — a future
 * `session.createdAt.slice(...)` would compile cleanly and throw at runtime
 * only on the database path. This is the one function that performs that
 * narrowing (`.toISOString()`), so every `SessionData` this repository hands
 * out — from either storage path — is a real string, not a disguised Date.
 * The remaining `as unknown as <JsonType>` casts below narrow Prisma's
 * `Json`/`JsonValue` columns (which are typed as close to `unknown` as
 * Prisma gets) to this app's concrete shapes for those columns; there is no
 * static way to prove that narrowing to the compiler short of a runtime
 * validator, so, unlike the createdAt case, a cast is the correct tool here
 * — the fix is having exactly one place that does it, not scattering it
 * across every call site.
 */
function toSessionData(row: PrismaSession): SessionData {
  return {
    id: row.id,
    userId: row.userId,
    techStack: row.techStack,
    provider: row.provider,
    model: row.model,
    // Resolved (not a bare cast) so a row somehow carrying an unrecognized
    // value — should never happen past the route's oneOf allowlist, but
    // this is the one place every read path funnels through — degrades to
    // DEFAULT_DIFFICULTY_LEVEL instead of handing callers a string outside
    // the DifficultyLevel union. See difficultyLevels.ts.
    difficultyLevel: resolveDifficultyLevel(row.difficultyLevel).id,
    questions: row.questions as unknown as QuestionData[],
    answers: row.answers as unknown as AnswerData[],
    evaluations: row.evaluations as unknown as EvaluationData[],
    status: row.status,
    finalEvaluation: (row.finalEvaluation as unknown as FinalEvaluationData | null) ?? null,
    jobDescription: row.jobDescription,
    questionHistory: row.questionHistory as unknown as string[] | null,
    extensionCount: row.extensionCount,
    totalQuestions: row.totalQuestions,
    answeredCount: row.answeredCount,
    interviewContext: row.interviewContext as unknown as InterviewContextEntry[] | null,
    userApiKeyUsed: row.userApiKeyUsed,
    historyEmail: row.historyEmail,
    // Additive/nullable column — see RESUME_MODE_PLAN.md §6. A row's own
    // Json value is already the exact shape validateResumeProfile
    // produces (it's never written any other way — see createSession
    // below), so a plain cast is correct here, same as questions/answers/
    // evaluations above.
    resumeProfile: (row.resumeProfile as unknown as ResumeProfile | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Same narrowing as `toSessionData`, for the trimmed 8-field projection the
 * two history-list queries below `select` (see [P4-05] / `projectHistoryFields`,
 * the equivalent projection for the in-memory fallback path) — kept as its
 * own function rather than widening `toSessionData` to accept a partial row,
 * since Prisma's `select`-narrowed return type only actually has these 8
 * fields at runtime; reusing `toSessionData` here would silently compile
 * against fields (`questions`, `answers`, ...) this row was never asked for.
 */
function toHistorySummary(
  row: Pick<
    PrismaSession,
    | 'id'
    | 'techStack'
    | 'model'
    | 'provider'
    | 'answeredCount'
    | 'totalQuestions'
    | 'finalEvaluation'
    | 'createdAt'
    | 'difficultyLevel'
  >
): Partial<SessionData> {
  return {
    id: row.id,
    techStack: row.techStack,
    model: row.model,
    provider: row.provider,
    answeredCount: row.answeredCount,
    totalQuestions: row.totalQuestions,
    finalEvaluation: (row.finalEvaluation as unknown as FinalEvaluationData | null) ?? null,
    difficultyLevel: resolveDifficultyLevel(row.difficultyLevel).id,
    createdAt: row.createdAt.toISOString(),
  };
}

// ─── Bounded in-memory fallback ─────────────────────────────────────────────
// Used only when Prisma/DB is unreachable. Bounded to prevent memory leaks.
const MAX_MEMORY_ENTRIES = 500;
const memoryStore = new Map<string, SessionData>();

/**
 * Deep-copies a session before it enters or leaves the in-memory store, so
 * every caller holding a `SessionData` reference has its own independent
 * object — see docs/audit/02-BACKLOG-P4-P10.md P4-01. Previously
 * `getSession` returned the exact object stored in `memoryStore`, so any
 * incidental mutation by a caller (or a later `applyToMemory` write) was
 * visible to every other holder of that "snapshot" with no repository call
 * involved. `structuredClone` is available on Node >= 17 (this project
 * requires >= 20 — see package.json engines) and correctly deep-copies the
 * plain JSON-shaped data this repository stores (no functions, no Dates in
 * SessionData itself).
 */
function cloneSession(session: SessionData): SessionData {
  return structuredClone(session);
}

/**
 * Short circuit-breaker cooldown: once the database is confirmed unreachable,
 * skip straight to the in-memory path for this long before trying again.
 * Previously every single request during a DB outage paid the full
 * connection-attempt latency before falling back — under sustained downtime
 * this made every request needlessly slow. Retrying every COOLDOWN_MS keeps
 * the "self healing" property (service recovers automatically once the DB is
 * back) without hammering it on every call in between.
 */
const DB_COOLDOWN_MS = 5_000;
let dbUnavailableUntil = 0;

function isDbLikelyDown(): boolean {
  return Date.now() < dbUnavailableUntil;
}

function markDbDown(): void {
  dbUnavailableUntil = Date.now() + DB_COOLDOWN_MS;
}

/**
 * True only for errors that mean the DATABASE ITSELF is unreachable — a
 * connection failure, a timeout establishing one, or the engine process
 * crashing. NOT true for an ordinary query-level outcome like "no row
 * matched" (Prisma P2025) or a constraint/validation error.
 *
 * See docs/audit/01-BACKLOG-P0-P3.md [P2-03]: previously EVERY caught error
 * — regardless of cause — tripped `markDbDown()`, so one client hitting an
 * ordinary 404 (update against a session id that doesn't exist) would
 * degrade every other concurrent user's requests to the bounded in-memory
 * fallback for the next DB_COOLDOWN_MS. That silently dropped new sessions
 * out of Postgres during a window nothing was actually wrong with Postgres.
 */
function isDatabaseUnreachable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientRustPanicError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P1001 Can't reach database server · P1002 timed out reaching it ·
    // P1008 operation timed out · P1017 server closed the connection.
    return ['P1001', 'P1002', 'P1008', 'P1017'].includes(error.code);
  }
  // Defensive fallback: a raw (non-Prisma-wrapped) Node.js network error
  // surfacing from underneath the engine.
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].includes(code)) {
      return true;
    }
  }
  return false;
}

/**
 * Evicts the oldest entry when the memory store exceeds its limit.
 * Uses insertion-order iteration (Map preserves insertion order in JS).
 */
function enforceBound(): void {
  while (memoryStore.size > MAX_MEMORY_ENTRIES) {
    const oldestKey = memoryStore.keys().next().value;
    if (oldestKey !== undefined) {
      memoryStore.delete(oldestKey);
    }
  }
}

/**
 * Projects a full in-memory SessionData down to the same field set the
 * database-backed history queries `select` — see
 * docs/audit/02-BACKLOG-P4-P10.md [P4-05]. Previously the memory-fallback
 * list methods returned the ENTIRE session (every question, answer,
 * evaluation, and the full job description) instead of the eight summary
 * fields the endpoint's contract promises, purely because the fallback path
 * happened to have the whole object sitting in memory already.
 */
function projectHistoryFields(s: SessionData): Partial<SessionData> {
  return {
    id: s.id,
    techStack: s.techStack,
    model: s.model,
    provider: s.provider,
    answeredCount: s.answeredCount,
    totalQuestions: s.totalQuestions,
    finalEvaluation: s.finalEvaluation,
    difficultyLevel: s.difficultyLevel,
    createdAt: s.createdAt,
  };
}

// ─── Per-session write serialization ────────────────────────────────────────
// Every write below is a read-modify-write against one session's JSON
// columns. See docs/audit/01-BACKLOG-P0-P3.md [P1-02]/[P2-05]/[P3-09]: with
// no serialization, two concurrent writes for the SAME session (the normal
// case now that per-question evaluation is deliberately fire-and-forget —
// see interview.service.ts's submitAnswer) can both read the same snapshot
// and one writer's result silently overwrites the other's.
//
// `sessionLocks` chains every operation for a given sessionId onto the same
// promise, so at most one read-modify-write for that session is ever in
// flight; writes for DIFFERENT sessions are completely unaffected and still
// run fully in parallel. This is process-local — see
// docs/audit/06-DEFERRED-DECISIONS.md §4: correct at the single-instance
// deployment this app currently requires, and the natural place to build
// real cross-instance locking (e.g. a DB-level `SELECT ... FOR UPDATE`) into
// later, without changing any caller.
const sessionLocks = new Map<string, Promise<unknown>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const tail = sessionLocks.get(sessionId) ?? Promise.resolve();
  // Run `fn` once the previous operation on this session settles, whichever
  // way it settled — a failed previous write must not wedge every later
  // operation on the same session.
  const next = tail.then(fn, fn);
  sessionLocks.set(sessionId, next);
  // Bound the map: once this is the last-queued operation for the session,
  // drop the entry so it doesn't grow forever across the process lifetime.
  // Chained with .then(cleanup, cleanup) rather than .finally(cleanup) so
  // this bookkeeping promise itself never rejects — an unhandled rejection
  // here would trip server.ts's process-level guard and crash the process,
  // exactly the landmine interview.service.ts's submitAnswer already
  // documents avoiding for its own background promise.
  next.then(cleanup, cleanup);
  return next;

  function cleanup(): void {
    if (sessionLocks.get(sessionId) === next) {
      sessionLocks.delete(sessionId);
    }
  }
}

// ─── Repository ─────────────────────────────────────────────────────────────

class InterviewRepository {
  /**
   * Creates a session in the database. Falls back to in-memory store only
   * when the database is actually unreachable — see isDatabaseUnreachable.
   * A genuine query error (bad data, constraint violation) is NOT masked as
   * a successful in-memory write: it propagates, because silently writing
   * "success" to memory would leave the caller believing the session is
   * durably persisted when it never will be.
   */
  async createSession(sessionData: SessionData): Promise<SessionData> {
    if (isDbLikelyDown()) {
      memoryStore.set(sessionData.id, cloneSession(sessionData));
      enforceBound();
      return sessionData;
    }

    try {
      // The `as unknown as Prisma.InputJsonValue` casts below are the
      // opposite direction from `toSessionData`'s: a concrete app-typed
      // array/object going INTO a Prisma `Json` column, not a `Json` column
      // coming out. Prisma's own generated input types don't structurally
      // accept an arbitrary interface here even though every one of these
      // values (QuestionData[], AnswerData[], ...) is already plain,
      // JSON-serializable data — this is the standard, narrowly-scoped cast
      // for that TS/Prisma boundary, not the createdAt-style masked bug
      // [P5-03] exists to close.
      const session = await prisma.session.create({
        data: {
          id: sessionData.id,
          userId: sessionData.userId,
          techStack: sessionData.techStack,
          provider: sessionData.provider || 'groq',
          model: sessionData.model,
          difficultyLevel: sessionData.difficultyLevel || DEFAULT_DIFFICULTY_LEVEL,
          questions: sessionData.questions as unknown as Prisma.InputJsonValue,
          answers: (sessionData.answers || []) as unknown as Prisma.InputJsonValue,
          evaluations: (sessionData.evaluations || []) as unknown as Prisma.InputJsonValue,
          status: sessionData.status,
          finalEvaluation: (sessionData.finalEvaluation as unknown as Prisma.InputJsonValue) ?? undefined,
          jobDescription: sessionData.jobDescription || null,
          questionHistory: (sessionData.questionHistory as unknown as Prisma.InputJsonValue) ?? undefined,
          extensionCount: sessionData.extensionCount || 0,
          totalQuestions: sessionData.totalQuestions || 0,
          interviewContext: (sessionData.interviewContext as unknown as Prisma.InputJsonValue) ?? undefined,
          userApiKeyUsed: sessionData.userApiKeyUsed || false,
          historyEmail: sessionData.historyEmail || null,
          resumeProfile: (sessionData.resumeProfile as unknown as Prisma.InputJsonValue) ?? undefined,
        },
      });
      return toSessionData(session);
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      logger.warn('[Repository] Database unreachable on create, using in-memory fallback', {
        sessionId: sessionData.id,
        error: error instanceof Error ? error.message : String(error),
      });
      markDbDown();
      memoryStore.set(sessionData.id, cloneSession(sessionData));
      enforceBound();
      return sessionData;
    }
  }

  async getSession(sessionId: string): Promise<SessionData | undefined> {
    if (isDbLikelyDown()) {
      const stored = memoryStore.get(sessionId);
      return stored ? cloneSession(stored) : undefined;
    }

    try {
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (session) return toSessionData(session);
      // DB didn't have it — check memory store (may have been a fallback write)
      const stored = memoryStore.get(sessionId);
      return stored ? cloneSession(stored) : undefined;
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      logger.warn('[Repository] Database unreachable on get, checking in-memory fallback', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      markDbDown();
      const stored = memoryStore.get(sessionId);
      return stored ? cloneSession(stored) : undefined;
    }
  }

  /**
   * Appends a single answer — atomically with respect to any other write on
   * this session (see withSessionLock) — and reports exactly what happened:
   *
   *   'not_found'  — the session doesn't exist in either store.
   *   'duplicate'  — this question already has an answer recorded. The
   *                  uniqueness check now happens INSIDE the lock, right
   *                  next to the write, closing the race where two
   *                  concurrent submissions for the same question could
   *                  both pass a pre-read check and both append — see
   *                  docs/audit/01-BACKLOG-P0-P3.md [P2-05].
   *   'recorded'   — the answer was appended and durably written somewhere
   *                  (database or the bounded in-memory fallback).
   *
   * Callers MUST branch on `outcome` rather than falling back to a stale
   * snapshot on failure — see [P1-03]: silently substituting the
   * pre-write session and reporting success to the user is exactly the bug
   * this return shape exists to make impossible to reproduce by accident.
   */
  async recordAnswer(
    sessionId: string,
    answer: AnswerData
  ): Promise<
    | { outcome: 'not_found' }
    | { outcome: 'duplicate'; session: SessionData }
    | { outcome: 'recorded'; session: SessionData }
  > {
    return withSessionLock(sessionId, async () => {
      const current = await this.getSession(sessionId);
      if (!current) return { outcome: 'not_found' as const };

      const alreadyAnswered = (current.answers || []).some((a) => a.questionId === answer.questionId);
      if (alreadyAnswered) return { outcome: 'duplicate' as const, session: current };

      const answers = [...(current.answers || []), answer];
      const updated = await this.updateSession(sessionId, { answers });
      if (!updated) return { outcome: 'not_found' as const };
      return { outcome: 'recorded' as const, session: updated };
    });
  }

  /**
   * Records (or replaces, by questionId) a single evaluation, and
   * optionally appends an interviewContext entry alongside it — atomically
   * with respect to any other write on this session (see withSessionLock),
   * which is what closes docs/audit/01-BACKLOG-P0-P3.md [P1-02]: two
   * per-question evaluations for the same session finishing close together
   * (the normal case, since scoring is deliberately fire-and-forget — see
   * interview.service.ts) now serialize instead of racing on the same
   * `evaluations` array snapshot.
   *
   * Replacing rather than blindly appending matters here: a synthetic
   * "unavailable" placeholder (written by endSession if scoring didn't
   * finish in time) can later be superseded by the real evaluation if it
   * finishes after all — this keeps exactly one evaluation entry per
   * question either way, rather than accumulating duplicates.
   *
   * contextEntry is optional and intentionally omitted for unavailable
   * placeholders — interviewContext feeds future question-generation
   * prompts (see promptBuilder's `interviewContext` option), and a
   * placeholder has no real score/topic worth feeding back into that.
   */
  async recordEvaluation(
    sessionId: string,
    evaluation: EvaluationData,
    contextEntry?: InterviewContextEntry
  ): Promise<SessionData | undefined> {
    return this.updateSessionWith(sessionId, (current) => {
      const evaluations = [
        ...(current.evaluations || []).filter((e) => e.questionId !== evaluation.questionId),
        evaluation,
      ];
      const interviewContext = contextEntry
        ? [...(current.interviewContext || []), contextEntry]
        : current.interviewContext;
      return { evaluations, interviewContext };
    });
  }

  /**
   * General-purpose atomic read-modify-write: reads the current session,
   * lets `mutate` compute the partial update from it, and writes that
   * update — all serialized per session id through the SAME lock every
   * other write in this repository goes through, so it correctly
   * interleaves with concurrent `recordAnswer`/`recordEvaluation` calls
   * rather than racing them. `mutate` returning `undefined` means "nothing
   * to write" and skips the update (and the extra round-trip) entirely —
   * used by interview.service.ts's `_maybeRefreshAggregateScore` (see
   * docs/audit/01-BACKLOG-P0-P3.md [P3-09]) to guard both its precondition
   * check and its no-op-when-nothing-changed check inside the same atomic
   * section that used to be an unguarded read-then-maybe-write.
   */
  async updateSessionWith(
    sessionId: string,
    mutate: (current: SessionData) => Partial<SessionData> | undefined
  ): Promise<SessionData | undefined> {
    return withSessionLock(sessionId, async () => {
      const current = await this.getSession(sessionId);
      if (!current) return undefined;
      const updates = mutate(current);
      if (updates === undefined) return current;
      return this.updateSession(sessionId, updates);
    });
  }

  /**
   * Low-level write. Prefer `recordAnswer` / `recordEvaluation` /
   * `updateSessionWith` for anything that reads-then-writes — those go
   * through the per-session lock; this method does not lock on its own; it
   * merely performs the write it's given, so calling it directly with a
   * value that a caller computed OUTSIDE the lock reopens the exact race
   * this file exists to close.
   */
  async updateSession(
    sessionId: string,
    updates: Partial<SessionData>
  ): Promise<SessionData | undefined> {
    const data: Record<string, unknown> = {};
    const updatableFields: (keyof SessionData)[] = [
      'techStack', 'provider', 'model', 'difficultyLevel', 'questions', 'answers',
      'evaluations', 'status', 'finalEvaluation', 'jobDescription',
      'questionHistory', 'extensionCount', 'totalQuestions',
      'interviewContext', 'userApiKeyUsed', 'answeredCount',
    ];

    for (const field of updatableFields) {
      if (updates[field] !== undefined) {
        data[field] = updates[field];
      }
    }

    if (isDbLikelyDown()) {
      return this.applyToMemory(sessionId, updates);
    }

    try {
      const session = await prisma.session.update({ where: { id: sessionId }, data });
      return toSessionData(session);
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      logger.warn('[Repository] Database unreachable on update, using in-memory fallback', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      markDbDown();
      return this.applyToMemory(sessionId, updates);
    }
  }

  /**
   * Applies `updates` to the in-memory copy of a session, WITHOUT mutating
   * the object currently stored (or any object a caller may still be
   * holding from an earlier `getSession`) — see [P4-01]. Builds a new
   * object, stores that, and hands the caller its own independent clone.
   */
  private applyToMemory(sessionId: string, updates: Partial<SessionData>): SessionData | undefined {
    const session = memoryStore.get(sessionId);
    if (!session) return undefined;
    const updated: SessionData = { ...session, ...updates };
    memoryStore.set(sessionId, updated);
    return cloneSession(updated);
  }

  async listCompletedSessions(
    userId: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<Partial<SessionData>[]> {
    if (isDbLikelyDown()) {
      return this.listCompletedFromMemory(userId, limit, offset);
    }

    try {
      const sessions = await prisma.session.findMany({
        where: { status: 'completed', userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          techStack: true,
          model: true,
          provider: true,
          answeredCount: true,
          totalQuestions: true,
          finalEvaluation: true,
          difficultyLevel: true,
          createdAt: true,
        },
      });
      return sessions.map(toHistorySummary);
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      logger.warn('[Repository] Database unreachable on list, using in-memory fallback', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      markDbDown();
      return this.listCompletedFromMemory(userId, limit, offset);
    }
  }

  private listCompletedFromMemory(
    userId: string,
    limit: number,
    offset: number
  ): Partial<SessionData>[] {
    const all = Array.from(memoryStore.values())
      .filter((s) => s.status === 'completed' && s.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all.slice(offset, offset + limit).map(projectHistoryFields);
  }

  /**
   * Lists completed sessions tagged with a given self-reported email (see
   * docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md, Option B) — deliberately parallel
   * to listCompletedSessions above, but keyed on `historyEmail` instead of
   * `userId`. `email` must already be normalized (trimmed + lowercased) by
   * the caller (interview.service.ts) — this method does an exact match,
   * same as `userId` above.
   *
   * Scoped to `userId: null` — see docs/audit/01-BACKLOG-P0-P3.md [P1-04]:
   * a session that has since been claimed by a real account must stop
   * surfacing its existence, score, and timestamp to an unauthenticated
   * caller who merely knows the tagged email. The full transcript was
   * already protected for a claimed session (GET /:sessionId 404s for a
   * non-owner) — this closes the narrower leak in the summary list itself.
   */
  async listCompletedSessionsByEmail(
    email: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<Partial<SessionData>[]> {
    if (isDbLikelyDown()) {
      return this.listCompletedByEmailFromMemory(email, limit, offset);
    }

    try {
      const sessions = await prisma.session.findMany({
        where: { status: 'completed', historyEmail: email, userId: null },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          techStack: true,
          model: true,
          provider: true,
          answeredCount: true,
          totalQuestions: true,
          finalEvaluation: true,
          difficultyLevel: true,
          createdAt: true,
        },
      });
      return sessions.map(toHistorySummary);
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      logger.warn('[Repository] Database unreachable on email-history list, using in-memory fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      markDbDown();
      return this.listCompletedByEmailFromMemory(email, limit, offset);
    }
  }

  private listCompletedByEmailFromMemory(
    email: string,
    limit: number,
    offset: number
  ): Partial<SessionData>[] {
    const all = Array.from(memoryStore.values())
      .filter((s) => s.status === 'completed' && s.historyEmail === email && !s.userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all.slice(offset, offset + limit).map(projectHistoryFields);
  }

  /**
   * Reassigns a batch of currently-anonymous sessions (userId null) to a
   * real account. Scoped to `userId: null` in the WHERE clause so it can
   * never take over a session someone else (or the caller, redundantly)
   * already owns — replaying a claim, or passing an id you don't actually
   * own the anonymous copy of, is a safe no-op. Returns how many rows were
   * actually reassigned.
   */
  async claimAnonymousSessions(sessionIds: string[], userId: string): Promise<number> {
    if (sessionIds.length === 0) return 0;

    if (isDbLikelyDown()) {
      return this.claimAnonymousFromMemory(sessionIds, userId);
    }

    try {
      const result = await prisma.session.updateMany({
        where: { id: { in: sessionIds }, userId: null },
        data: { userId },
      });
      return result.count;
    } catch (error) {
      if (!isDatabaseUnreachable(error)) throw error;
      logger.warn('[Repository] Database unreachable on claim, using in-memory fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
      markDbDown();
      return this.claimAnonymousFromMemory(sessionIds, userId);
    }
  }

  private claimAnonymousFromMemory(sessionIds: string[], userId: string): number {
    let claimed = 0;
    for (const id of sessionIds) {
      const session = memoryStore.get(id);
      if (session && !session.userId) {
        memoryStore.set(id, { ...session, userId });
        claimed++;
      }
    }
    return claimed;
  }
}

export default new InterviewRepository();
