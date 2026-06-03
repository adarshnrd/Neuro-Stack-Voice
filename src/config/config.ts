import dotenv from 'dotenv';
import { AppConfig } from '../interfaces';

dotenv.config();

const config: AppConfig = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  ai: {
    nvidiaKey: process.env.NVIDIA_API_KEY,
    groqKey: process.env.GROQ_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
  },
  app: {
    questionsPerInterview: parseInt(process.env.QUESTIONS_PER_INTERVIEW || '10', 10),
    jdQuestionsPerInterview: parseInt(process.env.JD_QUESTIONS_PER_INTERVIEW || '15', 10),
    silenceTimeoutMs: parseInt(process.env.SILENCE_TIMEOUT_MS || '15000', 10),
  },
  encryption: {
    secret: process.env.ENCRYPTION_SECRET || '',
  },
  cors: {
    // Comma-separated list of allowed origins; defaults to wildcard in development
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
      : ['*'],
  },
};

/**
 * Validates that all required environment variables are present.
 * Call this once at startup — fails fast with a clear message instead of
 * throwing cryptic runtime errors deep inside middleware.
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.encryption.secret) {
    errors.push('ENCRYPTION_SECRET is required');
  }

  // At least one AI provider key must be present
  const hasAnyAiKey =
    config.ai.groqKey || config.ai.nvidiaKey || config.ai.geminiKey;
  if (!hasAnyAiKey) {
    errors.push(
      'At least one AI API key is required: GROQ_API_KEY, NVIDIA_API_KEY, or GEMINI_API_KEY'
    );
  }

  if (errors.length > 0) {
    console.error('[Config] Missing required environment variables:');
    errors.forEach((e) => console.error(`  • ${e}`));
    process.exit(1);
  }
}

export default config;
