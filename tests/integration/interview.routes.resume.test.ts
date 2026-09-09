import { createMockPrisma } from '../helpers/mockPrisma';

const mock = createMockPrisma();

jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import request from 'supertest';
import { createApp } from '../../src/app';
import { ResumeProfile } from '../../src/types';

/** A small, valid AI question-generation response — validateQuestions
 *  doesn't require the array to match any requested count exactly (only
 *  caps an unreasonably large one), so a fixed small array is enough for
 *  every "does this succeed and shape out correctly" test below. */
function groqQuestionsResponse(questions: Array<{ question: string; topic?: string }>) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify(
            questions.map((q, i) => ({
              id: i + 1,
              question: q.question,
              difficulty: 'medium',
              topic: q.topic ?? 'General',
              expectedKeywords: [],
            }))
          ),
        },
      },
    ],
  };
}

/** Mocks the next `fetch` call (the AI provider request) to return exactly
 *  `n` generic technical questions — used where the total session length
 *  matters (Resume mode's total = 2 pinned + N AI-generated technical),
 *  since validateQuestions doesn't clip/pad the AI's response to match. */
function mockTechnicalQuestions(fetchSpy: jest.SpyInstance, n: number) {
  const qs = Array.from({ length: n }, (_, i) => ({ question: `Technical question ${i + 1}?` }));
  fetchSpy.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => groqQuestionsResponse(qs),
    text: async () => '',
  } as Response);
}

const RESUME_PROFILE: ResumeProfile = {
  primarySkills: ['Node.js', 'PostgreSQL'],
  secondarySkills: ['Docker'],
  projects: [{ summary: 'Built a real-time chat service handling 10k concurrent users.', technologies: ['Node.js', 'Redis'] }],
  domains: ['fintech'],
  yearsOfExperience: 4,
  inferredLevel: 'senior_engineer',
  notableClaims: ['cut p99 latency by 40%'],
};

const app = createApp();

describe('POST /api/interviews/start — Resume mode (RESUME_MODE_PLAN.md)', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => groqQuestionsResponse([
        { question: 'Walk me through your Redis caching strategy.' },
        { question: 'How would you scale that chat service further?' },
        { question: 'What tradeoffs did you consider for message ordering?' },
      ]),
      text: async () => '',
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    mock.sessions.clear();
  });

  it('rejects Resume mode with no resumeProfile at all', async () => {
    const res = await request(app).post('/api/interviews/start').send({ techStack: 'Resume', model: 'groq' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Resume analysis is required/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('accepts "Resume" as a valid techStack (passes the oneOf allowlist) and composes the pinned opening pair', async () => {
    // Server default (no explicit questionsCount) is 10 total; the AI is
    // only ever asked for the 8 TECHNICAL ones (10 - the 2 pinned openers).
    mockTechnicalQuestions(fetchSpy, 8);

    const res = await request(app)
      .post('/api/interviews/start')
      .send({ techStack: 'Resume', model: 'groq', resumeProfile: RESUME_PROFILE });

    expect(res.status).toBe(201);
    const questions = res.body.session.questions;
    // Server default (no explicit questionsCount) is 10 — see
    // config.app.questionsPerInterview under the test env.
    expect(questions).toHaveLength(10);

    // Q1: fixed introduction, deterministic, not AI-generated.
    expect(questions[0].id).toBe(1);
    expect(questions[0].kind).toBe('introduction');
    expect(questions[0].question).toMatch(/tell me about yourself/i);

    // Q2: personalized from the profile's top project.
    expect(questions[1].id).toBe(2);
    expect(questions[1].kind).toBe('project_narration');
    expect(questions[1].question).toContain('Built a real-time chat service handling 10k concurrent users.');

    // Q3+: AI-generated technical questions, contiguously renumbered.
    expect(questions[2].id).toBe(3);
    expect(questions[2].kind).toBe('technical');
    expect(questions.slice(2).map((q: { id: number }) => q.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('enforces its own 5-question floor even when a lower explicit count is requested', async () => {
    // Floored to 5 total → AI is asked for 5 - 2 pinned = 3 technical ones.
    mockTechnicalQuestions(fetchSpy, 3);

    const res = await request(app)
      .post('/api/interviews/start')
      .send({ techStack: 'Resume', model: 'groq', resumeProfile: RESUME_PROFILE, questionsCount: 2 });

    expect(res.status).toBe(201);
    expect(res.body.session.questions).toHaveLength(5);
    expect(res.body.session.questions[0].kind).toBe('introduction');
    expect(res.body.session.questions[1].kind).toBe('project_narration');
  });

  it('rejects a non-object resumeProfile (controller-level gate, before any AI call)', async () => {
    const res = await request(app)
      .post('/api/interviews/start')
      .send({ techStack: 'Resume', model: 'groq', resumeProfile: 'not an object' });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/interviews/resume/analyze', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('extracts and returns a validated ResumeProfile from pasted resume text', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primarySkills: ['Go', 'Kubernetes'],
                secondarySkills: [],
                projects: [{ summary: 'Migrated a monolith to microservices.', technologies: ['Go', 'gRPC'] }],
                domains: ['infra'],
                yearsOfExperience: 6,
                inferredLevel: 'senior_engineer',
                notableClaims: ['led the migration end to end'],
              }),
            },
          },
        ],
      }),
      text: async () => '',
    } as Response);

    const res = await request(app)
      .post('/api/interviews/resume/analyze')
      .send({ resumeText: 'Senior backend engineer. Migrated a monolith to microservices using Go and gRPC.' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.primarySkills).toEqual(['Go', 'Kubernetes']);
    expect(res.body.data.projects[0].summary).toBe('Migrated a monolith to microservices.');
    // Raw resume text must never be echoed back to the client — only the
    // extracted, PII-stripped profile (see RESUME_MODE_PLAN.md §5).
    expect(JSON.stringify(res.body)).not.toContain('Senior backend engineer');
  });

  it('rejects an empty resumeText', async () => {
    const res = await request(app).post('/api/interviews/resume/analyze').send({ resumeText: '' });
    expect(res.status).toBe(400);
  });

  it('rejects resumeText over the 10,000-character cap', async () => {
    const res = await request(app)
      .post('/api/interviews/resume/analyze')
      .send({ resumeText: 'a'.repeat(10001) });
    expect(res.status).toBe(400);
  });
});

// See RESUME_MODE_PLAN.md §7.1 — the JD question-count floor previously
// applied unconditionally; these confirm the fix end-to-end through the
// real HTTP surface, not just the prompt builder in isolation.
describe('POST /api/interviews/start — Job Description question-count floor fix', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => groqQuestionsResponse([
        { question: 'Q1?' }, { question: 'Q2?' }, { question: 'Q3?' },
      ]),
      text: async () => '',
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    mock.sessions.clear();
  });

  it('honors an explicit questionsCount below 15 for Job Description mode', async () => {
    const res = await request(app)
      .post('/api/interviews/start')
      .send({ techStack: 'Job Description', model: 'groq', jobDescription: 'Backend engineer role.', questionsCount: 5 });

    expect(res.status).toBe(201);
    // The prompt actually sent to the AI must ask for 5, not float back up
    // to the historical 15-question floor.
    const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    const promptSent = sentBody.messages[0].content as string;
    expect(promptSent).toContain('Generate exactly 5 questions');
    expect(promptSent).not.toContain('Generate exactly 15 questions');
  });

  it('still floors to 15 when no questionsCount is sent at all (unchanged default)', async () => {
    const res = await request(app)
      .post('/api/interviews/start')
      .send({ techStack: 'Job Description', model: 'groq', jobDescription: 'Backend engineer role.' });

    expect(res.status).toBe(201);
    const sentBody = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    const promptSent = sentBody.messages[0].content as string;
    expect(promptSent).toContain('Generate exactly 15 questions');
  });
});
