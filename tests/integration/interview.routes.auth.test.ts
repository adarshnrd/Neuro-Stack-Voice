import { createMockPrisma } from '../helpers/mockPrisma';

const mock = createMockPrisma();

jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import request from 'supertest';
import { createApp } from '../../src/app';

const app = createApp();
const VALID_UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

// The /start test below deliberately provokes a total AI-provider failure
// (see its own comment) rather than a real question-generation success, so
// it needs SOME fetch behaviour, not none. It used to rely on whatever real
// credentials happen to be in this machine's .env (loaded by
// src/config/config.ts's dotenv.config() for any provider tests/env.setup.ts
// doesn't already stub) — meaning it could silently fire live requests at
// Groq/Gemini/NVIDIA, and, since RICH_EVALUATION_SCALE_PLAN.md §1's
// full-provider retry chain now tries every configured provider (2 retries
// each) instead of "primary + one fallback", those live calls could also
// blow well past Jest's default per-test timeout. Mocking fetch here keeps
// the test fast, deterministic, and free of any dependency on real
// credentials or network access.
let fetchSpy: jest.SpyInstance;

beforeEach(() => {
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: false,
    status: 500,
    json: async () => ({ error: 'simulated provider outage' }),
    text: async () => 'simulated provider outage',
  } as Response);
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('Interview routes — public reference data (no auth required)', () => {
  it('GET /api/interviews/tech-stacks is accessible without auth', async () => {
    const res = await request(app).get('/api/interviews/tech-stacks');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/interviews/models is accessible without auth', async () => {
    const res = await request(app).get('/api/interviews/models');
    expect(res.status).toBe(200);
  });

  it('GET /api/interviews/config is accessible without auth', async () => {
    const res = await request(app).get('/api/interviews/config');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('questionsPerInterview');
  });
});

// NOTE: this describe block previously asserted 401 for /start, /:id/extend,
// and GET /:id without a session — that was correct for an earlier version
// of the app, before the anonymous-interview redesign (see
// interview.routes.ts's comment on attachUserIfPresent): those three routes
// were deliberately changed to allow anonymous access, identified purely by
// the session's own unguessable UUID (the same "URL is the access token"
// model a share link uses), so a logged-out visitor can take and review an
// interview without registering. This block was never updated to match at
// the time, so it was asserting behavior that contradicted the app's own
// documented design — fixed below to assert the actual, intentional
// contract for each route instead of blanket 401s.
describe('Interview routes — optional auth (anonymous access is intentional)', () => {
  it(
    'POST /api/interviews/start does NOT require a session (anonymous interviews are supported)',
    async () => {
      const res = await request(app)
        .post('/api/interviews/start')
        .send({ techStack: 'Node.js', model: 'groq' });
      // Not asserting 201 here: the fetch mock above simulates every AI
      // provider being down (see the comment on it) rather than a real
      // question-generation response — the only thing this test needs to
      // prove is that missing auth isn't why it would fail. A total
      // provider outage surfaces as a 5xx from runWithProviderChain, not a
      // 401.
      expect(res.status).not.toBe(401);
    },
    // Every configured provider is retried (2 retries each, exponential
    // backoff) before runWithProviderChain gives up — see
    // RICH_EVALUATION_SCALE_PLAN.md §1/§9 — so a real (if simulated) total
    // outage can legitimately take several seconds per provider. 20s gives
    // that room; the default 15s was tuned for the old "one fallback" path.
    20000
  );

  it("POST /api/interviews/:id/extend -> 404 for a nonexistent session (not 401 — no session required to attempt it)", async () => {
    const res = await request(app).post(`/api/interviews/${VALID_UUID}/extend`).send({});
    // extendSession looks the session up before touching any AI provider,
    // so a nonexistent id 404s deterministically — no fetch mock needed.
    expect(res.status).toBe(404);
  });

  it('GET /api/interviews/history -> 401 without a session (this one DOES require a real account — see interview.routes.ts)', async () => {
    const res = await request(app).get('/api/interviews/history');
    expect(res.status).toBe(401);
  });

  it("GET /api/interviews/:id -> 404 for a nonexistent session (not 401 — anonymous callers can read back a session by id)", async () => {
    const res = await request(app).get(`/api/interviews/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });
});

describe('API key settings routes — require auth (previously mutated a global shared key)', () => {
  it('POST /api/settings/api-key -> 401 without a session', async () => {
    const res = await request(app).post('/api/settings/api-key').send({ provider: 'gemini', apiKey: 'x' });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/settings/api-key -> 401 without a session', async () => {
    const res = await request(app).delete('/api/settings/api-key');
    expect(res.status).toBe(401);
  });

  it('GET /api/settings/api-key/status -> 401 without a session', async () => {
    const res = await request(app).get('/api/settings/api-key/status');
    expect(res.status).toBe(401);
  });
});
