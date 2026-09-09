/**
 * A minimal in-memory stand-in for the Prisma client, used by integration
 * tests via `jest.mock('../../src/config/database', ...)`.
 *
 * `user` and `session` are implemented as small in-memory stores that mimic
 * the real Prisma calls src/repositories/*.ts makes — `userApiKey` is left
 * undefined on purpose (nothing under test here exercises it yet).
 *
 * `session` used to be left undefined here too, on the theory that the
 * resulting synchronous throw would be caught by the repository's own
 * try/catch and exercise its bounded in-memory fallback path "for free" —
 * see docs/audit/02-BACKLOG-P4-P10.md [P3-02], which independently flagged
 * this as a real gap: every integration test using this helper exercised
 * ONLY that fallback path, never the real (mocked) persistence path where
 * [P1-02]/[P1-03]/[P2-03]/[P2-05]/[P3-09]/[P5-03] all live. It also turned
 * out to be actively broken by [P2-03]'s own fix: narrowing
 * `isDatabaseUnreachable()` to true connection-level errors means the
 * synthetic `TypeError: Cannot read properties of undefined` from calling
 * `.create()` on `undefined` no longer LOOKS like a database outage to that
 * function, so it was no longer being treated as one — it re-threw instead
 * of falling back, and every test relying on session creation succeeding
 * (`POST /api/interviews/start` returning 201, `GET /:id` 404-ing instead of
 * 500-ing for a genuinely missing id) would fail. A real, working `session`
 * store fixes both problems at once: it's what P3-02 asks for, and it's
 * what keeps these tests passing under the now-correctly-narrowed breaker.
 */
import { randomUUID } from 'crypto';

export interface MockUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Mirrors prisma/schema.prisma's `Session` model field-for-field. */
export interface MockSessionRecord {
  id: string;
  userId: string | null;
  techStack: string;
  provider: string;
  model: string;
  difficultyLevel: string;
  questions: unknown;
  answers: unknown;
  evaluations: unknown;
  status: string;
  finalEvaluation: unknown;
  jobDescription: string | null;
  questionHistory: unknown;
  extensionCount: number;
  totalQuestions: number;
  answeredCount: number;
  interviewContext: unknown;
  userApiKeyUsed: boolean;
  historyEmail: string | null;
  // See docs/project-improvement/RESUME_MODE_PLAN.md §5/§6 — the extracted,
  // PII-stripped ResumeProfile for a Resume-mode session; null for every
  // other tech stack. Stored as `unknown` here (mirroring `questions` /
  // `answers` / etc. above) since this mock has no reason to know its
  // shape — interview.repository.ts's own cast is what's under test.
  resumeProfile: unknown;
  createdAt: Date;
  updatedAt: Date;
}

type WhereCondition = Record<string, unknown>;

/**
 * Supports exactly the `where` shapes interview.repository.ts actually
 * sends: plain equality (`{ status: 'completed', userId }`,
 * `{ status: 'completed', historyEmail, userId: null }`) and the one `{ in:
 * [...] }` operator (`claimAnonymousSessions`'s `{ id: { in: sessionIds },
 * userId: null }`). Not a general Prisma `where` implementation.
 */
function matchesWhere(record: MockSessionRecord, where?: WhereCondition): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    const value = (record as unknown as Record<string, unknown>)[key];
    if (condition && typeof condition === 'object' && 'in' in (condition as Record<string, unknown>)) {
      return ((condition as { in: unknown[] }).in).includes(value);
    }
    return value === condition;
  });
}

export function createMockPrisma() {
  const users = new Map<string, MockUserRecord>(); // keyed by email
  const sessions = new Map<string, MockSessionRecord>(); // keyed by id

  const prisma = {
    user: {
      findUnique: jest.fn(
        async ({
          where,
          select,
        }: {
          where: { email?: string; id?: string };
          select?: Record<string, boolean>;
        }) => {
          let record: MockUserRecord | null = null;
          if (where.email) record = users.get(where.email) ?? null;
          else if (where.id) {
            for (const u of users.values()) {
              if (u.id === where.id) {
                record = u;
                break;
              }
            }
          }
          if (!record) return null;
          if (!select) return record;
          const projected: Partial<MockUserRecord> = {};
          for (const key of Object.keys(select)) {
            if (select[key])
              (projected as unknown as Record<string, unknown>)[key] = (record as unknown as Record<string, unknown>)[
                key
              ];
          }
          return projected;
        }
      ),
      create: jest.fn(async ({ data }: { data: { email: string; passwordHash: string } }) => {
        const record: MockUserRecord = {
          id: randomUUID(),
          email: data.email,
          passwordHash: data.passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.set(data.email, record);
        return record;
      }),
    },
    session: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const record: MockSessionRecord = {
          id: data.id as string,
          userId: (data.userId as string | null | undefined) ?? null,
          techStack: data.techStack as string,
          provider: data.provider as string,
          model: data.model as string,
          difficultyLevel: (data.difficultyLevel as string | undefined) ?? 'software_engineer',
          questions: data.questions ?? [],
          answers: data.answers ?? [],
          evaluations: data.evaluations ?? [],
          status: data.status as string,
          finalEvaluation: data.finalEvaluation ?? null,
          jobDescription: (data.jobDescription as string | null | undefined) ?? null,
          questionHistory: data.questionHistory ?? null,
          extensionCount: (data.extensionCount as number | undefined) ?? 0,
          totalQuestions: (data.totalQuestions as number | undefined) ?? 0,
          answeredCount: 0,
          interviewContext: data.interviewContext ?? null,
          userApiKeyUsed: (data.userApiKeyUsed as boolean | undefined) ?? false,
          historyEmail: (data.historyEmail as string | null | undefined) ?? null,
          resumeProfile: data.resumeProfile ?? null,
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(record.id, record);
        return { ...record };
      }),

      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const record = sessions.get(where.id);
        return record ? { ...record } : null;
      }),

      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const record = sessions.get(where.id);
          if (!record) {
            // Mirrors real Prisma: updating a row that no longer exists
            // throws (P2025) rather than silently no-op'ing. Not a
            // connection-level error, so isDatabaseUnreachable correctly
            // does NOT treat this as a DB outage — same as production.
            throw new Error('Mock Prisma: Record to update not found (P2025)');
          }
          const updated: MockSessionRecord = { ...record, ...data, updatedAt: new Date() } as MockSessionRecord;
          sessions.set(where.id, updated);
          return { ...updated };
        }
      ),

      findMany: jest.fn(
        async ({
          where,
          orderBy,
          take,
          skip,
          select,
        }: {
          where?: WhereCondition;
          orderBy?: { createdAt?: 'asc' | 'desc' };
          take?: number;
          skip?: number;
          select?: Record<string, boolean>;
        }) => {
          let results = Array.from(sessions.values()).filter((s) => matchesWhere(s, where));
          if (orderBy?.createdAt === 'asc') {
            results = results.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          } else if (orderBy?.createdAt === 'desc') {
            results = results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          if (typeof skip === 'number') results = results.slice(skip);
          if (typeof take === 'number') results = results.slice(0, take);

          if (!select) return results.map((r) => ({ ...r }));
          return results.map((r) => {
            const projected: Record<string, unknown> = {};
            for (const key of Object.keys(select)) {
              if (select[key]) projected[key] = (r as unknown as Record<string, unknown>)[key];
            }
            return projected;
          });
        }
      ),

      updateMany: jest.fn(
        async ({ where, data }: { where?: WhereCondition; data: Record<string, unknown> }) => {
          let count = 0;
          for (const [id, record] of sessions.entries()) {
            if (matchesWhere(record, where)) {
              sessions.set(id, { ...record, ...data, updatedAt: new Date() } as MockSessionRecord);
              count++;
            }
          }
          return { count };
        }
      ),
    },
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
  };

  return { prisma, users, sessions };
}
