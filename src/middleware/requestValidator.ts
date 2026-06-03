import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/appError';

type FieldRule = {
  /** The field must be present and non-empty */
  required?: boolean;
  /** The field must be one of these values */
  oneOf?: string[];
  /** The field must be a positive integer */
  positiveInt?: boolean;
  /** Max numeric value */
  max?: number;
  /** Min numeric value */
  min?: number;
  /** Max string length */
  maxLength?: number;
  /** Expected type ('string' | 'number' | 'boolean') */
  type?: 'string' | 'number' | 'boolean';
};

type Schema = Record<string, FieldRule>;

/**
 * Returns an Express middleware that validates `req.body` fields against
 * a schema. Calls `next(AppError)` with 400 on the first violation found.
 *
 * Usage:
 *   router.post('/start', validateBody({ techStack: { required: true } }), handler)
 */
export function validateBody(schema: Schema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    for (const [field, rules] of Object.entries(schema)) {
      const value = (req.body as Record<string, unknown>)[field];

      if (rules.required) {
        if (value === undefined || value === null || value === '') {
          return next(new AppError(`'${field}' is required`, 400));
        }
      }

      // Skip further checks if field is absent and not required
      if (value === undefined || value === null) continue;

      if (rules.type && typeof value !== rules.type) {
        return next(
          new AppError(`'${field}' must be of type ${rules.type}`, 400)
        );
      }

      if (rules.oneOf && !rules.oneOf.includes(String(value))) {
        return next(
          new AppError(
            `'${field}' must be one of: ${rules.oneOf.join(', ')}`,
            400
          )
        );
      }

      if (rules.positiveInt) {
        const num = Number(value);
        if (!Number.isInteger(num) || num <= 0) {
          return next(new AppError(`'${field}' must be a positive integer`, 400));
        }
      }

      if (rules.min !== undefined && Number(value) < rules.min) {
        return next(new AppError(`'${field}' must be at least ${rules.min}`, 400));
      }

      if (rules.max !== undefined && Number(value) > rules.max) {
        return next(new AppError(`'${field}' must be at most ${rules.max}`, 400));
      }

      if (rules.maxLength !== undefined && typeof value === 'string' && value.length > rules.maxLength) {
        return next(
          new AppError(
            `'${field}' exceeds maximum length of ${rules.maxLength} characters`,
            400
          )
        );
      }
    }

    next();
  };
}

/** UUID v4 format check for route parameters. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Middleware that validates `req.params[paramName]` is a valid UUID v4.
 * Returns 400 if the parameter is malformed.
 */
export function validateUuidParam(paramName: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const value = req.params[paramName];
    if (!value || !UUID_REGEX.test(value)) {
      return next(
        new AppError(`'${paramName}' must be a valid UUID`, 400)
      );
    }
    next();
  };
}
