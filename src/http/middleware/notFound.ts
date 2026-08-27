import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../utils/appError';

/**
 * 404 handler for the `/api` namespace ONLY.
 *
 * Must be mounted after all `/api` routes but BEFORE the SPA wildcard
 * fallback in app.ts. Previously this handler existed but was never
 * mounted, so an unknown API path (e.g. a typo'd endpoint, or a client on
 * a stale build hitting a removed route) fell through to the wildcard and
 * received `index.html` with a 200 status — a silent failure that looked
 * like success to any caller checking only the HTTP status code.
 */
export function apiNotFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(`Route not found: ${req.method} ${req.path}`, 404));
}

export default apiNotFoundHandler;
