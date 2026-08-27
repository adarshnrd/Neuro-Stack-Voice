import { createMockPrisma } from '../helpers/mockPrisma';

const mock = createMockPrisma();

// Must precede the `import { createApp }` below — see tests/helpers/mockPrisma.ts
// doc comment for why only `user` (and $queryRaw) are implemented.
jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import request from 'supertest';
import { createApp } from '../../src/app';

const app = createApp();

describe('POST /api/auth/register', () => {
  it('creates a user and sets an httpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'alice@example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('alice@example.com');
    expect(res.body.data.user.passwordHash).toBeUndefined();

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(String(cookies)).toMatch(/nsv_token=/);
    expect(String(cookies)).toMatch(/HttpOnly/i);
  });

  it('rejects a duplicate email with 409, without confirming the account exists in the message', async () => {
    await request(app).post('/api/auth/register').send({ email: 'dup@example.com', password: 'password123' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@example.com', password: 'different-pass' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  it('rejects a short password (validateBody minLength)', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'short@example.com', password: '123' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'password123' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  beforeAll(async () => {
    await request(app).post('/api/auth/register').send({ email: 'bob@example.com', password: 'correct-password' });
  });

  it('logs in with correct credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bob@example.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('bob@example.com');
  });

  it('rejects a wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'bob@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-existent email with 401 (same status as wrong password — no enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever123' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/auth/me', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user when authenticated via cookie', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/register').send({ email: 'carol@example.com', password: 'password12345' });
    const res = await agent.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe('carol@example.com');
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(200);
    const cookies = String(res.headers['set-cookie']);
    expect(cookies).toMatch(/nsv_token=;/);
  });
});
