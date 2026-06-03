import { Request, Response, NextFunction } from 'express';
import config from '../config/config';
import { AppError } from '../utils/appError';

/**
 * Global Express error-handling middleware.
 *
 * Operational errors (AppError.isOperational = true):
 *   → log message only, return structured JSON with the real status code.
 *
 * Programmer / unexpected errors:
 *   → log full stack, return generic 500 to avoid leaking internals.
 */
const errorHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
): void => {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const isOperational = isAppError ? err.isOperational : false;

  if (isOperational) {
    // Expected runtime error — log message only
    console.warn(`[Error] ${statusCode} ${req.method} ${req.path} — ${err.message}`);
  } else {
    // Unexpected programmer error — log full stack
    console.error(`[Error] Unhandled error on ${req.method} ${req.path}:`, err);
  }

  res.status(statusCode).json({
    success: false,
    error: isOperational ? err.message : 'An unexpected error occurred. Please try again.',
    ...(config.env === 'development' && { stack: err.stack }),
  });
};

/**
 * 404 handler — mount BEFORE errorHandler but AFTER all routes.
 */
export const notFoundHandler = (req: Request, _res: Response, next: NextFunction): void => {
  next(new AppError(`Route not found: ${req.method} ${req.path}`, 404));
};

export default errorHandler;
