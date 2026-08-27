import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import {
  SessionData,
  AnswerData,
  EvaluationData,
  InterviewContextEntry,
} from '../types';

// ─── Bounded in-memory fallback ─────────────────────────────────────────────
// Used only when Prisma/DB is unreachable. Bounded to prevent memory leaks.
const MAX_MEMORY_ENTRIES = 500;
const memoryStore = new Map<string, SessionData>();

/**
 * Short circuit-breaker cooldown: once a Prisma call fails, skip straight to
 * the in-memory path for this long before trying Prisma again. Previously
 * every single request during a DB outage paid the full connection-attempt
 * latency before falling back — under sustained downtime this made every
 * request needlessly slow. Retrying every COOLDOWN_MS keeps the "self
 * healing" property (service recovers automatically once the DB is back)
 * without hammering it on every call in between.
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

// ─── Repository ─────────────────────────────────────────────────────────────

class InterviewRepository {
  /**
   * Creates a session in the database. Falls back to in-memory store on failure.
   */
  async createSession(sessionData: SessionData): Promise<SessionData> {
    if (isDbLikelyDown()) {
      memoryStore.set(sessionData.id, sessionData);
      enforceBound();
      return sessionData;
    }

    try {
      const session = await prisma.session.create({
        data: {
          id: sessionData.id,
          userId: sessionData.userId,
          techStack: sessionData.techStack,
          provider: sessionData.provider || 'groq',
          model: sessionData.model,
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
        },
      });
      return session as unknown as SessionData;
    } catch (error) {
      console.warn('[Repository] Prisma save failed, using in-memory fallback:', error);
      markDbDown();
      memoryStore.set(sessionData.id, sessionData);
      enforceBound();
      return sessionData;
    }
  }

  async getSession(sessionId: string): Promise<SessionData | undefined> {
    if (isDbLikelyDown()) {
      return memoryStore.get(sessionId);
    }

    try {
      const session = await prisma.session.findUnique({ where: { id: sessionId } });
      if (session) return session as unknown as SessionData;
      // DB didn't have it — check memory store (may have been a fallback write)
      return memoryStore.get(sessionId);
    } catch (error) {
      console.warn('[Repository] Prisma get failed, checking in-memory fallback:', error);
      markDbDown();
      return memoryStore.get(sessionId);
    }
  }

  /**
   * Atomically appends an answer AND its evaluation/context entry in a
   * single read-modify-write. Callers must NOT call updateSession separately
   * for the answer and then again for the evaluation of the same request —
   * the previous implementation did exactly that (write answers, then
   * separately compute evaluations/interviewContext from the pre-answer
   * snapshot and write again), so two concurrent answers on the same
   * session could silently drop one write. This method takes an updater
   * function and applies it to the freshest snapshot available immediately
   * before writing.
   */
  async recordAnswerAndEvaluation(
    sessionId: string,
    build: (session: SessionData) => {
      answers: AnswerData[];
      evaluations: EvaluationData[];
      interviewContext: InterviewContextEntry[];
    }
  ): Promise<SessionData | undefined> {
    const current = await this.getSession(sessionId);
    if (!current) return undefined;

    const { answers, evaluations, interviewContext } = build(current);
    return this.updateSession(sessionId, { answers, evaluations, interviewContext });
  }

  async updateSession(
    sessionId: string,
    updates: Partial<SessionData>
  ): Promise<SessionData | undefined> {
    const data: Record<string, unknown> = {};
    const updatableFields: (keyof SessionData)[] = [
      'techStack', 'provider', 'model', 'questions', 'answers',
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
      return session as unknown as SessionData;
    } catch (error) {
      console.warn('[Repository] Prisma update failed, using in-memory fallback:', error);
      markDbDown();
      return this.applyToMemory(sessionId, updates);
    }
  }

  private applyToMemory(sessionId: string, updates: Partial<SessionData>): SessionData | undefined {
    const session = memoryStore.get(sessionId);
    if (session) {
      Object.assign(session, updates);
      memoryStore.set(sessionId, session);
    }
    return session;
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
          createdAt: true,
        },
      });
      return sessions as unknown as Partial<SessionData>[];
    } catch (error) {
      console.warn('[Repository] Prisma list failed, using in-memory fallback:', error);
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
    return all.slice(offset, offset + limit);
  }
}

export default new InterviewRepository();
