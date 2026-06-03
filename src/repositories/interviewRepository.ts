import { Prisma } from '@prisma/client';
import { prisma } from '../config/databaseConfig';
import {
  SessionData,
  QuestionData,
  AnswerData,
  EvaluationData,
  FinalEvaluationData,
  InterviewContextEntry
} from '../interfaces';

// ─── Bounded in-memory fallback ─────────────────────────────────────────────
// Used only when Prisma/DB is unreachable. Bounded to prevent memory leaks.
const MAX_MEMORY_ENTRIES = 500;
const memoryStore = new Map<string, SessionData>();

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
   * Unlike the previous implementation, fallback is per-request — the next
   * request will attempt Prisma again (self-healing).
   */
  async createSession(sessionData: SessionData): Promise<SessionData> {
    try {
      const session = await prisma.session.create({
        data: {
          id: sessionData.id,
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
      memoryStore.set(sessionData.id, sessionData);
      enforceBound();
      return sessionData;
    }
  }

  async getSession(sessionId: string): Promise<SessionData | undefined> {
    try {
      const session = await prisma.session.findUnique({
        where: { id: sessionId },
      });
      if (session) return session as unknown as SessionData;
      // DB didn't have it — check memory store (may have been a fallback write)
      return memoryStore.get(sessionId);
    } catch (error) {
      console.warn('[Repository] Prisma get failed, checking in-memory fallback:', error);
      return memoryStore.get(sessionId);
    }
  }

  async updateSession(
    sessionId: string,
    updates: Partial<SessionData>
  ): Promise<SessionData | undefined> {
    // Build a clean update payload — only include fields that are present
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

    try {
      const session = await prisma.session.update({
        where: { id: sessionId },
        data,
      });
      return session as unknown as SessionData;
    } catch (error) {
      console.warn('[Repository] Prisma update failed, using in-memory fallback:', error);
      const session = memoryStore.get(sessionId);
      if (session) {
        Object.assign(session, updates);
        memoryStore.set(sessionId, session);
      }
      return session;
    }
  }

  async listCompletedSessions(
    limit: number = 20,
    offset: number = 0
  ): Promise<Partial<SessionData>[]> {
    try {
      // Use select to avoid fetching large JSON blobs for the list view
      const sessions = await prisma.session.findMany({
        where: { status: 'completed' },
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
      const all = Array.from(memoryStore.values())
        .filter((s) => s.status === 'completed')
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      return all.slice(offset, offset + limit);
    }
  }
}

export default new InterviewRepository();
