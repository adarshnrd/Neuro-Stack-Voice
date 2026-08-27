import { Request, Response, NextFunction } from 'express';
import { validateBody, validateUuidParam } from '../../src/http/middleware/validate';
import { AppError } from '../../src/utils/appError';

function mockReq(body: Record<string, unknown> = {}, params: Record<string, string> = {}): Request {
  return { body, params } as unknown as Request;
}

function runMiddleware(mw: (req: Request, res: Response, next: NextFunction) => void, req: Request) {
  const next = jest.fn();
  mw(req, {} as Response, next as NextFunction);
  return next;
}

describe('validateBody', () => {
  it('calls next() with no error when all rules pass', () => {
    const mw = validateBody({ techStack: { required: true, type: 'string', maxLength: 10 } });
    const next = runMiddleware(mw, mockReq({ techStack: 'Node.js' }));
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a missing required field', () => {
    const mw = validateBody({ techStack: { required: true } });
    const next = runMiddleware(mw, mockReq({}));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    const err = next.mock.calls[0][0] as AppError;
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('techStack');
  });

  it('rejects an empty string for a required field', () => {
    const mw = validateBody({ email: { required: true } });
    const next = runMiddleware(mw, mockReq({ email: '' }));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('enforces email format', () => {
    const mw = validateBody({ email: { required: true, email: true } });
    const next = runMiddleware(mw, mockReq({ email: 'not-an-email' }));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('accepts a valid email', () => {
    const mw = validateBody({ email: { required: true, email: true } });
    const next = runMiddleware(mw, mockReq({ email: 'user@example.com' }));
    expect(next).toHaveBeenCalledWith();
  });

  it('enforces minLength', () => {
    const mw = validateBody({ password: { required: true, minLength: 8 } });
    const next = runMiddleware(mw, mockReq({ password: 'short' }));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('enforces maxLength', () => {
    const mw = validateBody({ techStack: { maxLength: 3 } });
    const next = runMiddleware(mw, mockReq({ techStack: 'too-long-value' }));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('enforces positiveInt', () => {
    const mw = validateBody({ count: { positiveInt: true } });
    expect(runMiddleware(mw, mockReq({ count: -1 })).mock.calls[0][0]).toBeInstanceOf(AppError);
    expect(runMiddleware(mw, mockReq({ count: 0 })).mock.calls[0][0]).toBeInstanceOf(AppError);
    expect(runMiddleware(mw, mockReq({ count: 5 })).mock.calls[0][0]).toBeUndefined();
  });

  it('enforces oneOf', () => {
    const mw = validateBody({ provider: { oneOf: ['gemini', 'groq'] } });
    expect(runMiddleware(mw, mockReq({ provider: 'nvidia' })).mock.calls[0][0]).toBeInstanceOf(AppError);
    expect(runMiddleware(mw, mockReq({ provider: 'gemini' })).mock.calls[0][0]).toBeUndefined();
  });

  it('skips optional-field checks when the field is absent', () => {
    const mw = validateBody({ nickname: { type: 'string', maxLength: 5 } });
    const next = runMiddleware(mw, mockReq({}));
    expect(next).toHaveBeenCalledWith();
  });
});

describe('validateUuidParam', () => {
  const VALID_UUID_V4 = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('accepts a valid UUID v4', () => {
    const mw = validateUuidParam('sessionId');
    const next = runMiddleware(mw, mockReq({}, { sessionId: VALID_UUID_V4 }));
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a missing param', () => {
    const mw = validateUuidParam('sessionId');
    const next = runMiddleware(mw, mockReq({}, {}));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('rejects a malformed UUID', () => {
    const mw = validateUuidParam('sessionId');
    const next = runMiddleware(mw, mockReq({}, { sessionId: 'not-a-uuid' }));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });

  it('rejects a UUID of the wrong version (v1 instead of v4)', () => {
    const mw = validateUuidParam('sessionId');
    const v1 = '3fa85f64-5717-1562-b3fc-2c963f66afa6';
    const next = runMiddleware(mw, mockReq({}, { sessionId: v1 }));
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
  });
});
