import { Request, Response, NextFunction } from 'express';
import config from '../../config/config';
import { AppError } from '../../utils/appError';
import logger from '../../utils/logger';

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
  const fields = { requestId: req.requestId, method: req.method, path: req.path, statusCode };

  if (isOperational) {
    logger.warn(err.message, fields);
  } else {
    logger.error(err.message, { ...fields, stack: err.stack });
  }

  res.status(statusCode).json({
    success: false,
    error: isOperational ? err.message : 'An unexpected error occurred. Please try again.',
    requestId: req.requestId,
    ...(config.env === 'development' && { stack: err.stack }),
  });
};

export default errorHandler;
