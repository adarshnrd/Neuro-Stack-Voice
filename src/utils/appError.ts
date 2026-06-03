/**
 * AppError — typed operational error with HTTP status code.
 *
 * Use this instead of `new Error(...)` whenever you want the global
 * error handler to return a specific HTTP status code to the client.
 *
 * isOperational = true  → expected runtime error (400, 404, 503…) — log message only
 * isOperational = false → programmer bug — log full stack, return generic 500
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

/** Convenience factory helpers */
export const badRequest = (msg: string) => new AppError(msg, 400);
export const notFound   = (msg: string) => new AppError(msg, 404);
export const conflict   = (msg: string) => new AppError(msg, 409);
export const tooMany    = (msg: string) => new AppError(msg, 429);
export const serverError = (msg: string) => new AppError(msg, 500, false);
export const unavailable = (msg: string) => new AppError(msg, 503);
