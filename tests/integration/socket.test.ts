import { createMockPrisma } from '../helpers/mockPrisma';

const mock = createMockPrisma();

jest.mock('../../src/config/database', () => ({
  prisma: mock.prisma,
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import http from 'http';
import { AddressInfo } from 'net';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from '../../src/app';
import socketHandler from '../../src/sockets/interview.socket';
import socketAuthMiddleware from '../../src/sockets/auth';

const GROQ_QUESTIONS_RESPONSE = {
  choices: [
    {
      message: {
        content: JSON.stringify([
          { id: 1, question: 'Explain event loop.', difficulty: 'medium', topic: 'Node.js', expectedKeywords: [] },
          { id: 2, question: 'What is a closure?', difficulty: 'easy', topic: 'JS', expectedKeywords: [] },
        ]),
      },
    },
  ],
};

const GROQ_EVAL_RESPONSE = {
  choices: [{ message: { content: JSON.stringify({ score: 7, feedback: 'Solid.', betterAnswer: 'Even better.' }) } }],
};

const GROQ_FINAL_RESPONSE = {
  choices: [{ message: { content: JSON.stringify({ overallScore: 70, overallFeedback: 'Nice work.' }) } }],
};

describe('Socket.IO interview flow', () => {
  const app = createApp();
  let httpServer: http.Server;
  let io: SocketIOServer;
  let port: number;
  let fetchSpy: jest.SpyInstance;

  beforeAll((done) => {
    httpServer = http.createServer(app);
    io = new SocketIOServer(httpServer, { cors: { origin: '*' } });
    io.use(socketAuthMiddleware);
    io.on('connection', (socket) => socketHandler(io, socket));
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      done();
    });
  });

  afterAll((done) => {
    io.close();
    httpServer.close(() => done());
  });

  beforeEach(() => {
    // Default fallback for any fetch() not explicitly stubbed below via
    // mockResolvedValueOnce — every real assertion in these tests queues
    // its own specific response first, so this only guards against an
    // unexpected extra call hanging the test instead of failing loudly.
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => GROQ_QUESTIONS_RESPONSE,
      text: async () => JSON.stringify(GROQ_QUESTIONS_RESPONSE),
    } as Response);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  async function registerAndGetCookie(email: string): Promise<string> {
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password12345' });
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    return setCookie.split(';')[0];
  }

  async function startSession(cookie: string): Promise<string> {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => GROQ_QUESTIONS_RESPONSE,
      text: async () => JSON.stringify(GROQ_QUESTIONS_RESPONSE),
    } as Response);
    const res = await request(app)
      .post('/api/interviews/start')
      .set('Cookie', cookie)
      .send({ techStack: 'Node.js', model: 'groq' });
    expect(res.status).toBe(201);
    return res.body.session.id;
  }

  function connectClient(cookie: string): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const client = ioClient(`http://localhost:${port}`, {
        extraHeaders: { Cookie: cookie },
      });
      client.on('connect', () => resolve(client));
      client.on('connect_error', (err) => reject(err));
    });
  }

  it('rejects a handshake with no auth cookie', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const client = ioClient(`http://localhost:${port}`);
        client.on('connect', () => reject(new Error('should not have connected')));
        client.on('connect_error', (err) => resolve(err));
      })
    ).resolves.toBeDefined();
  });

  it('rejects interview:join for a session owned by a different user', async () => {
    const cookieA = await registerAndGetCookie('sock-a@example.com');
    const cookieB = await registerAndGetCookie('sock-b@example.com');
    const sessionId = await startSession(cookieA);

    const clientB = await connectClient(cookieB);
    const errorPromise = new Promise((resolve) => clientB.on('error', resolve));
    clientB.emit('interview:join', { sessionId });

    const err = (await errorPromise) as { code: string };
    expect(err.code).toBe('JOIN_FAILED');
    clientB.close();
  });

  it('allows the owner to join, answer, and end their own session; rejects a duplicate answer', async () => {
    const cookie = await registerAndGetCookie('sock-owner@example.com');
    const sessionId = await startSession(cookie);
    const client = await connectClient(cookie);

    client.emit('interview:join', { sessionId });

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => GROQ_EVAL_RESPONSE,
      text: async () => JSON.stringify(GROQ_EVAL_RESPONSE),
    } as Response);

    const evaluated = new Promise((resolve) => client.once('answer:evaluated', resolve));
    client.emit('answer:final', { sessionId, questionId: 1, text: 'The event loop handles async callbacks.' });
    const evalResult = (await evaluated) as { questionId: number; evaluation: { score: number } };
    expect(evalResult.questionId).toBe(1);
    expect(evalResult.evaluation.score).toBe(7);

    // Duplicate answer for the same question must be rejected.
    const dupError = new Promise((resolve) => client.once('error', resolve));
    client.emit('answer:final', { sessionId, questionId: 1, text: 'trying again' });
    const err = (await dupError) as { code: string; message: string };
    expect(err.code).toBe('EVALUATION_FAILED');
    expect(err.message).toMatch(/already been answered/);

    // End the interview.
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => GROQ_FINAL_RESPONSE,
      text: async () => JSON.stringify(GROQ_FINAL_RESPONSE),
    } as Response);
    const completed = new Promise((resolve) => client.once('interview:complete', resolve));
    client.emit('interview:end', { sessionId });
    const summary = (await completed) as { summary: { overallScore: number } };
    expect(typeof summary.summary.overallScore).toBe('number');

    // Answering again after completion must be rejected.
    const afterCompleteError = new Promise((resolve) => client.once('error', resolve));
    client.emit('answer:final', { sessionId, questionId: 2, text: 'too late' });
    const err2 = (await afterCompleteError) as { code: string; message: string };
    expect(err2.message).toMatch(/already been completed/);

    client.close();
  });
});
