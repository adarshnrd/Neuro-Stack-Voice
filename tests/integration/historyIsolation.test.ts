import { createMockPrisma } from '../helpers/mockPrisma';

const mock = createMockPrisma();

jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import request from 'supertest';
import { createApp } from '../../src/app';
import interviewService from '../../src/services/interview.service';

const GROQ_QUESTIONS_RESPONSE = {
  choices: [
    {
      message: {
        content: JSON.stringify([{ id: 1, question: 'Q1', difficulty: 'easy', topic: 'General', expectedKeywords: [] }]),
      },
    },
  ],
};
const GROQ_FINAL_RESPONSE = {
  choices: [{ message: { content: JSON.stringify({ overallScore: 50, overallFeedback: 'ok' }) } }],
};

const app = createApp();

async function registerAndGetCookie(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password12345' });
  const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
  return setCookie.split(';')[0];
}

describe('GET /api/interviews/history — cross-user isolation', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GROQ_QUESTIONS_RESPONSE,
      text: async () => JSON.stringify(GROQ_QUESTIONS_RESPONSE),
    } as Response);
  });

  afterEach(() => fetchSpy.mockRestore());

  it("only returns the requesting user's own completed sessions", async () => {
    const cookieA = await registerAndGetCookie('hist-a@example.com');
    const cookieB = await registerAndGetCookie('hist-b@example.com');

    const startA = await request(app)
      .post('/api/interviews/start')
      .set('Cookie', cookieA)
      .send({ techStack: 'Node.js', model: 'groq' });
    const startB = await request(app)
      .post('/api/interviews/start')
      .set('Cookie', cookieB)
      .send({ techStack: 'React', model: 'groq' });

    expect(startA.status).toBe(201);
    expect(startB.status).toBe(201);

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => GROQ_FINAL_RESPONSE,
      text: async () => JSON.stringify(GROQ_FINAL_RESPONSE),
    } as Response);
    // No HTTP route ends a session (that's a Socket.IO-only action — see
    // tests/integration/socket.test.ts); call the service directly here to
    // seed a completed session without standing up a second socket harness.
    await interviewService.endSession(startA.body.session.id, startA.body.session.userId);

    const historyA = await request(app).get('/api/interviews/history').set('Cookie', cookieA);
    const historyB = await request(app).get('/api/interviews/history').set('Cookie', cookieB);

    expect(historyA.status).toBe(200);
    expect(historyA.body.data).toHaveLength(1);
    expect(historyA.body.data[0].id).toBe(startA.body.session.id);

    // User B has an ACTIVE (not completed) session — history (completed-only)
    // must come back empty, and critically must NOT include user A's session.
    expect(historyB.status).toBe(200);
    expect(historyB.body.data).toHaveLength(0);
  });

  it("returns 404 (not another user's data) when fetching a session you don't own", async () => {
    const cookieA = await registerAndGetCookie('own-a@example.com');
    const cookieB = await registerAndGetCookie('own-b@example.com');

    const startA = await request(app)
      .post('/api/interviews/start')
      .set('Cookie', cookieA)
      .send({ techStack: 'Node.js', model: 'groq' });

    const res = await request(app)
      .get(`/api/interviews/${startA.body.session.id}`)
      .set('Cookie', cookieB);

    expect(res.status).toBe(404);
  });
});
