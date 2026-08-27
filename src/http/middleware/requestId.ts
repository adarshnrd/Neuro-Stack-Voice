import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * Attaches a unique ID to every request (`req.requestId`) and echoes it back
 * as `X-Request-Id`. Lets a client-reported error be correlated with the
 * matching server log line — without this there was no way to tie a user's
 * bug report back to a specific log entry.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length <= 100 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export default requestId;
