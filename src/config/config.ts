import dotenv from 'dotenv';
import { AppConfig } from '../types';

dotenv.config();

/**
 * Reads an integer env var with a fallback, guarding against NaN from a
 * malformed value silently propagating into runtime config.
 */
function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true' || raw === '1';
}

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';

const config: AppConfig = {
  env,
  isProduction,
  port: readInt('PORT', 3000),
  // Number of proxy hops to trust for X-Forwarded-For (e.g. 1 behind a single
  // load balancer / reverse proxy). Defaults to 0 (trust nothing) so
  // rate-limiting can never be tricked into keying off a spoofed client IP.
  trustProxy: readInt('TRUST_PROXY_HOPS', 0),
  ai: {
    nvidiaKey: process.env.NVIDIA_API_KEY,
    groqKey: process.env.GROQ_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
  },
  app: {
    questionsPerInterview: readInt('QUESTIONS_PER_INTERVIEW', 10),
    jdQuestionsPerInterview: readInt('JD_QUESTIONS_PER_INTERVIEW', 15),
    silenceTimeoutMs: readInt('SILENCE_TIMEOUT_MS', 15000),
  },
  encryption: {
    secret: process.env.ENCRYPTION_SECRET || '',
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET || '',
    cookieSecure: readBool('COOKIE_SECURE', isProduction),
    tokenTtlSeconds: readInt('JWT_TTL_SECONDS', 7 * 24 * 60 * 60), // 7 days
  },
  cors: {
    // Comma-separated list of allowed origins; defaults to wildcard in development
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : ['*'],
  },
};

/**
 * Validates that all required environment variables are present and sane.
 * Call this once at startup — fails fast with a clear message instead of
 * throwing cryptic runtime errors deep inside middleware.
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.encryption.secret) {
    errors.push('ENCRYPTION_SECRET is required');
  } else if (config.encryption.secret.length < 32) {
    errors.push('ENCRYPTION_SECRET must be at least 32 characters');
  }

  if (!config.auth.jwtSecret) {
    errors.push('JWT_SECRET is required');
  } else if (config.auth.jwtSecret.length < 32) {
    errors.push('JWT_SECRET must be at least 32 characters');
  }

  // At least one AI provider key must be present
  const hasAnyAiKey =
    config.ai.groqKey || config.ai.nvidiaKey || config.ai.geminiKey;
  if (!hasAnyAiKey) {
    errors.push(
      'At least one AI API key is required: GROQ_API_KEY, NVIDIA_API_KEY, or GEMINI_API_KEY'
    );
  }

  if (config.isProduction) {
    if (config.cors.allowedOrigins.includes('*')) {
      errors.push(
        'ALLOWED_ORIGINS must be set to an explicit comma-separated list in production (wildcard CORS is not allowed)'
      );
    }
    if (!process.env.DATABASE_URL) {
      errors.push('DATABASE_URL is required in production');
    }
  }

  if (errors.length > 0) {
    console.error('[Config] Invalid configuration:');
    errors.forEach((e) => console.error(`  • ${e}`));
    process.exit(1);
  }
}

export default config;
