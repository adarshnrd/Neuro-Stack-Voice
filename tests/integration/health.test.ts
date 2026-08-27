jest.mock('../../src/config/database', () => ({
  prisma: {},
  pingDatabase: jest.fn(),
  disconnectDatabase: jest.fn(async () => undefined),
}));

import request from 'supertest';
import { createApp } from '../../src/app';
import { pingDatabase } from '../../src/config/database';

const app = createApp();

describe('GET /api/health', () => {
  it('reports ok with a live database', async () => {
    (pingDatabase as jest.Mock).mockResolvedValueOnce(true);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.database).toBe('up');
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('reports degraded (still HTTP 200) when the database ping fails', async () => {
    (pingDatabase as jest.Mock).mockResolvedValueOnce(false);
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.database).toBe('down');
  });
});
