jest.mock('../../src/config/database', () => ({
  prisma: {},
  pingDatabase: jest.fn(async () => true),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import request from 'supertest';
import { createApp } from '../../src/app';

const app = createApp();

describe('Unknown /api/* routes', () => {
  it('returns a JSON 404, not index.html with a 200 (the old, silent-failure behavior)', async () => {
    const res = await request(app).get('/api/this-route-does-not-exist');
    expect(res.status).toBe(404);
    expect(res.type).toBe('application/json');
    expect(res.body.success).toBe(false);
  });

  it('still falls back to index.html for a genuinely unknown non-API route (SPA behavior preserved)', async () => {
    const res = await request(app).get('/some-client-side-route');
    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
  });
});
