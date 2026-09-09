import { createMockPrisma, MockSessionRecord } from '../helpers/mockPrisma';

const mock = createMockPrisma();

jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import { randomUUID } from 'crypto';
import request from 'supertest';
import { createApp } from '../../src/app';
import { MAX_EXTENSIONS, MAX_TOTAL_QUESTIONS } from '../../src/services/interview.service';

const GROQ_EXTEND_QUESTIONS_RESPONSE = {
  choices: [
    {
      message: {
        content: JSON.stringify([
          { id: 1, question: 'A follow-up question.', difficulty: 'medium', topic: 'General', expectedKeywords: [] },
        ]),
      },
    },
  ],
};

function makeQuestions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    question: `Question ${i + 1}?`,
    difficulty: 'medium',
    topic: 'General',
    expectedKeywords: [],
  }));
}

/**
 * Seeds a session directly into the mock Prisma store, bypassing
 * interviewService.startSession entirely — these tests are about
 * extendSession's own logic (the P1-01 preserve-and-mark-stale fix, and the
 * P4-02 ceilings), not about question generation, so they pin exactly the
 * pre-state each scenario needs without an extra round of AI-call mocking.
 */
function seedSession(overrides: Partial<MockSessionRecord> = {}): MockSessionRecord {
  const now = new Date();
  const record: MockSessionRecord = {
    id: randomUUID(),
    userId: null,
    techStack: 'Node.js',
    provider: 'groq',
    model: 'groq',
    difficultyLevel: 'software_engineer',
    questions: makeQuestions(3),
    answers: [],
    evaluations: [],
    status: 'active',
    finalEvaluation: null,
    jobDescription: null,
    questionHistory: null,
    extensionCount: 0,
    totalQuestions: 3,
    answeredCount: 0,
    interviewContext: null,
    userApiKeyUsed: false,
    historyEmail: null,
    resumeProfile: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  mock.sessions.set(record.id, record);
  return record;
}

const app = createApp();

describe('POST /api/interviews/:id/extend', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GROQ_EXTEND_QUESTIONS_RESPONSE,
      text: async () => JSON.stringify(GROQ_EXTEND_QUESTIONS_RESPONSE),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    mock.sessions.clear();
  });

  // [P1-01] docs/audit/01-BACKLOG-P0-P3.md: extending a COMPLETED session
  // must never destroy its finished report. Previously this unconditionally
  // nulled `finalEvaluation`; the fix instead preserves it and marks the
  // narrative 'stale' (the same shape _maybeRefreshAggregateScore already
  // produces for a late-arriving evaluation), reusing the existing
  // refresh-banner UI with no client changes.
  it('preserves finalEvaluation (marked stale) when extending a completed session, and reactivates it', async () => {
    const session = seedSession({
      status: 'completed',
      finalEvaluation: { overallScore: 82, overallFeedback: 'Great work overall.' },
    });

    const res = await request(app).post(`/api/interviews/${session.id}/extend`).send({ additionalCount: 2 });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('active');
    expect(res.body.session.finalEvaluation).toBeTruthy();
    expect(res.body.session.finalEvaluation.overallScore).toBe(82);
    expect(res.body.session.finalEvaluation.overallFeedback).toBe('Great work overall.');
    expect(res.body.session.finalEvaluation.overallFeedbackStatus).toBe('stale');
  });

  it('leaves finalEvaluation null when extending a session that was never completed', async () => {
    const session = seedSession({ status: 'active', finalEvaluation: null });

    const res = await request(app).post(`/api/interviews/${session.id}/extend`).send({ additionalCount: 2 });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe('active');
    expect(res.body.session.finalEvaluation).toBeNull();
  });

  // [P4-02] docs/audit/02-BACKLOG-P4-P10.md: extensionCount and total
  // question count are now hard-capped — previously unbounded, so prompt
  // size fed into the NEXT extend grew roughly quadratically with the
  // number of extends.
  it(`rejects extending a session that has already been extended ${MAX_EXTENSIONS} times`, async () => {
    const session = seedSession({ extensionCount: MAX_EXTENSIONS });

    const res = await request(app).post(`/api/interviews/${session.id}/extend`).send({ additionalCount: 2 });

    expect(res.status).toBe(400);
    // errorHandler's JSON shape is { success: false, error: <message string> }
    // — see src/http/middleware/errorHandler.ts.
    expect(res.body.error).toMatch(/already been extended the maximum/);
    // Rejected before any AI call — no provider was even asked.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(`rejects extending a session that already has ${MAX_TOTAL_QUESTIONS} questions`, async () => {
    const session = seedSession({ questions: makeQuestions(MAX_TOTAL_QUESTIONS), totalQuestions: MAX_TOTAL_QUESTIONS });

    const res = await request(app).post(`/api/interviews/${session.id}/extend`).send({ additionalCount: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already reached the maximum/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caps the number of NEW questions added so the session never exceeds the total ceiling', async () => {
    // One question short of the ceiling: asking for 10 more must be capped
    // down to exactly 1, not silently allowed to overshoot.
    const session = seedSession({
      questions: makeQuestions(MAX_TOTAL_QUESTIONS - 1),
      totalQuestions: MAX_TOTAL_QUESTIONS - 1,
    });

    const res = await request(app).post(`/api/interviews/${session.id}/extend`).send({ additionalCount: 10 });

    expect(res.status).toBe(200);
    expect(res.body.session.questions).toHaveLength(MAX_TOTAL_QUESTIONS);
    expect(res.body.session.totalQuestions).toBe(MAX_TOTAL_QUESTIONS);
  });
});
