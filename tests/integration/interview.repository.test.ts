import { createMockPrisma } from '../helpers/mockPrisma';

const mock = createMockPrisma();

// See docs/audit/02-BACKLOG-P4-P10.md [P3-02] and tests/helpers/mockPrisma.ts's
// doc comment: this is the enabler test file for the P1 concurrency/atomicity
// fixes ([P1-02]/[P1-03]/[P2-03]/[P2-05]/[P3-09]/[P5-03]) — it exercises
// interview.repository.ts directly against a real (mocked) persistence path,
// not the in-memory fallback every other integration test happened to hit
// before mockPrisma.ts implemented a working `session` store.
jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import { randomUUID } from 'crypto';
import interviewRepository from '../../src/repositories/interview.repository';
import { SessionData, QuestionData } from '../../src/types';

function makeQuestion(id: number): QuestionData {
  return { id, question: `Question ${id}?`, difficulty: 'medium', topic: 'General', expectedKeywords: [] };
}

function makeSessionData(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: randomUUID(),
    userId: null,
    techStack: 'Node.js',
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    difficultyLevel: 'software_engineer',
    questions: [makeQuestion(1), makeQuestion(2), makeQuestion(3)],
    answers: [],
    evaluations: [],
    status: 'active',
    finalEvaluation: null,
    jobDescription: null,
    questionHistory: null,
    extensionCount: 0,
    totalQuestions: 3,
    interviewContext: null,
    userApiKeyUsed: false,
    historyEmail: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('interviewRepository — real (mocked) persistence path', () => {
  beforeEach(() => {
    mock.sessions.clear();
  });

  // [P5-03]: `SessionData.createdAt` is a `string`; Prisma's `Session.createdAt`
  // is a `Date`. This pins that `toSessionData` actually performs that
  // conversion, rather than merely satisfying the type checker with a cast.
  it('createSession + getSession round-trip, with createdAt coming back as a real ISO string', async () => {
    const input = makeSessionData();
    const created = await interviewRepository.createSession(input);
    expect(typeof created.createdAt).toBe('string');
    expect(() => new Date(created.createdAt).toISOString()).not.toThrow();

    const fetched = await interviewRepository.getSession(input.id);
    expect(fetched).toBeDefined();
    expect(typeof fetched?.createdAt).toBe('string');
    expect(fetched?.id).toBe(input.id);
    expect(fetched?.questions).toHaveLength(3);
  });

  it('getSession returns undefined for a session that was never created', async () => {
    const result = await interviewRepository.getSession(randomUUID());
    expect(result).toBeUndefined();
  });

  // See docs/project-improvement/RESUME_MODE_PLAN.md §6 — resumeProfile is
  // additive/nullable on the Session model, so this pins the two directions
  // that matter: a Resume-mode session's profile survives the JSON
  // round-trip through the (mocked) DB, and a non-Resume session — which
  // never sets it — reads back as null rather than undefined or a missing
  // key, matching every other nullable field's convention here.
  describe('resumeProfile — round-trip', () => {
    it('persists and returns a Resume-mode session profile unchanged', async () => {
      const profile = {
        primarySkills: ['TypeScript', 'PostgreSQL'],
        secondarySkills: ['Docker'],
        projects: [{ summary: 'Built a real-time chat service.', technologies: ['Node.js', 'Redis'] }],
        domains: ['fintech'],
        yearsOfExperience: 4,
        inferredLevel: 'senior_engineer' as const,
        notableClaims: ['cut p99 latency by 40%'],
      };
      const input = makeSessionData({ techStack: 'Resume', resumeProfile: profile });
      await interviewRepository.createSession(input);

      const fetched = await interviewRepository.getSession(input.id);
      expect(fetched?.resumeProfile).toEqual(profile);
    });

    it('defaults to null for a session that never set a resumeProfile', async () => {
      const input = makeSessionData(); // no resumeProfile override
      await interviewRepository.createSession(input);

      const fetched = await interviewRepository.getSession(input.id);
      expect(fetched?.resumeProfile).toBeNull();
    });
  });

  describe('recordAnswer — [P1-03]/[P2-05]', () => {
    it('reports not_found for a nonexistent session rather than fabricating a session', async () => {
      const result = await interviewRepository.recordAnswer(randomUUID(), {
        questionId: 1,
        text: 'answer',
        timestamp: new Date().toISOString(),
      });
      expect(result.outcome).toBe('not_found');
    });

    it('records a first answer, and rejects a second answer to the same question as duplicate', async () => {
      const input = makeSessionData();
      await interviewRepository.createSession(input);

      const first = await interviewRepository.recordAnswer(input.id, {
        questionId: 1,
        text: 'first answer',
        timestamp: new Date().toISOString(),
      });
      expect(first.outcome).toBe('recorded');
      if (first.outcome === 'recorded') {
        expect(first.session.answers).toHaveLength(1);
      }

      const second = await interviewRepository.recordAnswer(input.id, {
        questionId: 1,
        text: 'trying again',
        timestamp: new Date().toISOString(),
      });
      expect(second.outcome).toBe('duplicate');
      if (second.outcome === 'duplicate') {
        // The duplicate attempt must not have been appended alongside the
        // original — exactly one answer for questionId 1, ever.
        expect(second.session.answers).toHaveLength(1);
      }
    });

    // [P1-02]: withSessionLock must serialize concurrent writes to the SAME
    // session without dropping either one. Two answers for DIFFERENT
    // questions fired without awaiting between them is exactly the shape
    // submitAnswer's fire-and-forget evaluation design produces in
    // production (see interview.service.ts). Before withSessionLock existed,
    // both calls could read the same pre-write snapshot and the second
    // writer's result would silently overwrite the first's.
    it('serializes two concurrent recordAnswer calls for the same session so neither write is lost', async () => {
      const input = makeSessionData();
      await interviewRepository.createSession(input);

      const [r1, r2] = await Promise.all([
        interviewRepository.recordAnswer(input.id, {
          questionId: 1,
          text: 'answer to Q1',
          timestamp: new Date().toISOString(),
        }),
        interviewRepository.recordAnswer(input.id, {
          questionId: 2,
          text: 'answer to Q2',
          timestamp: new Date().toISOString(),
        }),
      ]);

      expect(r1.outcome).toBe('recorded');
      expect(r2.outcome).toBe('recorded');

      const final = await interviewRepository.getSession(input.id);
      const questionIds = (final?.answers ?? []).map((a) => a.questionId).sort();
      expect(questionIds).toEqual([1, 2]);
    });
  });

  describe('recordEvaluation — replaces rather than duplicates [P1-02]', () => {
    it('replaces an existing evaluation for the same questionId instead of appending a second one', async () => {
      const input = makeSessionData();
      await interviewRepository.createSession(input);

      await interviewRepository.recordEvaluation(input.id, {
        questionId: 1,
        status: 'processing',
        unavailable: false,
      });
      const afterFirst = await interviewRepository.getSession(input.id);
      expect(afterFirst?.evaluations).toHaveLength(1);

      // A real result superseding a placeholder — same questionId.
      await interviewRepository.recordEvaluation(input.id, {
        questionId: 1,
        status: 'completed',
        score: 8,
      });
      const afterSecond = await interviewRepository.getSession(input.id);
      expect(afterSecond?.evaluations).toHaveLength(1);
      expect(afterSecond?.evaluations[0].score).toBe(8);
      expect(afterSecond?.evaluations[0].status).toBe('completed');
    });
  });

  describe('updateSessionWith — [P3-09] guarded no-op', () => {
    it('mutate returning undefined skips the write and returns the unchanged current session', async () => {
      const input = makeSessionData();
      await interviewRepository.createSession(input);

      const result = await interviewRepository.updateSessionWith(input.id, () => undefined);
      expect(result?.id).toBe(input.id);
      expect(result?.totalQuestions).toBe(input.totalQuestions);
    });

    it('mutate returning a partial update is applied atomically', async () => {
      const input = makeSessionData();
      await interviewRepository.createSession(input);

      const result = await interviewRepository.updateSessionWith(input.id, (current) => ({
        totalQuestions: current.totalQuestions + 1,
      }));
      expect(result?.totalQuestions).toBe(input.totalQuestions + 1);
    });
  });

  describe('claimAnonymousSessions — only ever takes over userId: null sessions', () => {
    it('reassigns an anonymous session, and is a no-op for a session someone else already owns', async () => {
      const anon = makeSessionData({ userId: null });
      const ownedByOther = makeSessionData({ userId: 'some-other-user-id' });
      await interviewRepository.createSession(anon);
      await interviewRepository.createSession(ownedByOther);

      const claimingUserId = randomUUID();
      const count = await interviewRepository.claimAnonymousSessions(
        [anon.id, ownedByOther.id],
        claimingUserId
      );

      // Only the anonymous one was actually reassigned.
      expect(count).toBe(1);
      const claimed = await interviewRepository.getSession(anon.id);
      expect(claimed?.userId).toBe(claimingUserId);
      const untouched = await interviewRepository.getSession(ownedByOther.id);
      expect(untouched?.userId).toBe('some-other-user-id');
    });
  });

  describe('listCompletedSessions / listCompletedSessionsByEmail — [P4-05] projection, [P1-04] leak closure', () => {
    it('projects only the documented 8 summary fields, not the full session', async () => {
      const userId = randomUUID();
      const session = makeSessionData({
        userId,
        status: 'completed',
        jobDescription: 'Full JD text that must not leak into the history list',
      });
      await interviewRepository.createSession(session);

      const list = await interviewRepository.listCompletedSessions(userId);
      expect(list).toHaveLength(1);
      const summary = list[0] as Record<string, unknown>;
      expect(summary.id).toBe(session.id);
      expect(summary).not.toHaveProperty('jobDescription');
      expect(summary).not.toHaveProperty('questions');
      expect(summary).not.toHaveProperty('answers');
      expect(summary).not.toHaveProperty('evaluations');
    });

    // [P1-04]: a session that has since been claimed by a real account must
    // stop surfacing via the unauthenticated email-tag lookup — this pins
    // that closure at the repository layer, independent of the controller.
    it('listCompletedSessionsByEmail never returns a session that has been claimed by an account', async () => {
      const email = 'candidate@example.com';
      const session = makeSessionData({
        userId: null,
        status: 'completed',
        historyEmail: email,
      });
      await interviewRepository.createSession(session);

      const beforeClaim = await interviewRepository.listCompletedSessionsByEmail(email);
      expect(beforeClaim).toHaveLength(1);

      await interviewRepository.claimAnonymousSessions([session.id], randomUUID());

      const afterClaim = await interviewRepository.listCompletedSessionsByEmail(email);
      expect(afterClaim).toHaveLength(0);
    });
  });
});
