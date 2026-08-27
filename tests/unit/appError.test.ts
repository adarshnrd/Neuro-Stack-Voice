import { AppError, badRequest, notFound, conflict, tooMany, serverError, unavailable } from '../../src/utils/appError';

describe('AppError', () => {
  it('defaults isOperational to true', () => {
    const err = new AppError('boom', 400);
    expect(err.statusCode).toBe(400);
    expect(err.isOperational).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof AppError).toBe(true);
  });

  it('supports isOperational=false for programmer errors', () => {
    const err = new AppError('unexpected', 500, false);
    expect(err.isOperational).toBe(false);
  });

  it('preserves the prototype chain for instanceof checks after being thrown/caught', () => {
    try {
      throw new AppError('nope', 404);
    } catch (e) {
      expect(e instanceof AppError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });

  describe('factory helpers', () => {
    it('badRequest -> 400 operational', () => {
      const e = badRequest('x');
      expect(e.statusCode).toBe(400);
      expect(e.isOperational).toBe(true);
    });
    it('notFound -> 404 operational', () => {
      expect(notFound('x').statusCode).toBe(404);
    });
    it('conflict -> 409 operational', () => {
      expect(conflict('x').statusCode).toBe(409);
    });
    it('tooMany -> 429 operational', () => {
      expect(tooMany('x').statusCode).toBe(429);
    });
    it('unavailable -> 503 operational', () => {
      expect(unavailable('x').statusCode).toBe(503);
    });
    it('serverError -> 500 NON-operational (stack should be hidden from clients)', () => {
      const e = serverError('x');
      expect(e.statusCode).toBe(500);
      expect(e.isOperational).toBe(false);
    });
  });
});
