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

describe('Interview routes — require auth (previously these had NONE)', () => {
  it('POST /api/interviews/start -> 401 without a session', async () => {
    const res = await request(app)
      .post('/api/interviews/start')
      .send({ techStack: 'Node.js', model: 'groq' });
    expect(res.status).toBe(401);
  });

  it('POST /api/interviews/:id/extend -> 401 without a session', async () => {
    const res = await request(app).post(`/api/interviews/${VALID_UUID}/extend`).send({});
    expect(res.status).toBe(401);
  });

  it('GET /api/interviews/history -> 401 without a session (previously leaked every user\'s history)', async () => {
    const res = await request(app).get('/api/interviews/history');
    expect(res.status).toBe(401);
  });

  it('GET /api/interviews/:id -> 401 without a session', async () => {
    const res = await request(app).get(`/api/interviews/${VALID_UUID}`);
    expect(res.status).toBe(401);
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
