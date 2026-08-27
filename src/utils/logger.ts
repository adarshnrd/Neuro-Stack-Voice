import config from '../config/config';

type LogFields = Record<string, unknown>;

/**
 * Minimal structured logger.
 *
 * Not a full logging framework (pino/winston) — deliberately dependency-free
 * so it's easy to swap out later. Emits one JSON line per call in production
 * (machine-parseable by any log aggregator) and a readable line in
 * development. Every call site can attach a `requestId` for correlation.
 */
function write(level: 'info' | 'warn' | 'error', message: string, fields?: LogFields): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...fields,
  };

  const line = config.isProduction ? JSON.stringify(entry) : formatDev(level, message, fields);

  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

function formatDev(level: string, message: string, fields?: LogFields): string {
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  return `[${level.toUpperCase()}] ${message}${suffix}`;
}

export const logger = {
  info: (message: string, fields?: LogFields) => write('info', message, fields),
  warn: (message: string, fields?: LogFields) => write('warn', message, fields),
  error: (message: string, fields?: LogFields) => write('error', message, fields),
};

export default logger;
