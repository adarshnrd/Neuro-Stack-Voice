import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../../utils/jwt';
import { AppError } from '../../utils/appError';

export const AUTH_COOKIE_NAME = 'nsv_token';

function extractToken(req: Request): string | undefined {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.[AUTH_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  // Fall back to Authorization: Bearer <token> for non-browser clients.
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);

  return undefined;
}

/**
 * Requires a valid session. Attaches `req.user = { id, email }` on success.
 * Every interview and settings route is gated behind this — previously none
 * of them were, so any visitor could read every user's interview history
 * and mutate the (formerly shared, global) API key configuration.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    return next(new AppError('Authentication required', 401));
  }

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    next(new AppError('Invalid or expired session', 401));
  }
}

/**
 * Attaches `req.user` if a valid token is present, but does not reject the
 * request otherwise. Used for routes that behave differently for
 * authenticated vs. anonymous callers without requiring login.
 */
export function attachUserIfPresent(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, email: payload.email };
  } catch {
    // Ignore invalid/expired tokens on the optional path — treat as anonymous.
  }
  next();
}
