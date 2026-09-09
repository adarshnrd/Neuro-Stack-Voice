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

/** Reads a string env var with a fallback, trimming and treating blank as unset. */
function readStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
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
    // The actual model ID sent to each provider's API. Configurable because
    // providers (Groq especially) deprecate/rename models on their own
    // schedule — e.g. llama-3.3-70b-versatile stopped working for
    // free/developer-tier keys on 2026-08-16. Overriding via env means a
    // provider swapping their model lineup is a one-line .env change, not a
    // code deploy. See docs/AI_PROVIDER_AUTO_SWITCH_PLAN.md for how this
    // interacts with the fallback/auto-switch logic.
    groqModel: readStr('GROQ_MODEL', 'openai/gpt-oss-120b'),
    nvidiaModel: readStr('NVIDIA_MODEL', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'),
    // Model used when Gemini is chosen as the FALLBACK for a failed
    // Groq/NVIDIA call (not the primary Gemini model — that's whichever
    // gemini-* id the user picked, passed straight through).
    geminiFallbackModel: readStr('GEMINI_FALLBACK_MODEL', 'gemini-3.5-flash'),
    // Ceiling sent as `max_completion_tokens` on every Groq call (question
    // generation, per-answer evaluation, final evaluation alike). Groq's
    // free/on-demand tier enforces a hard tokens-per-minute cap per model
    // (as low as 8000 TPM for some models) and — since that cap is checked
    // BEFORE the response is generated — it must be counting this reserved
    // ceiling against the request, not actual output size. The old
    // hardcoded 8192 was already at or above that cap on its own, so every
    // single Groq call 413'd ("Request too large... Requested 8704")
    // regardless of prompt size. 4096 comfortably covers the largest real
    // response this app asks for (a 15-question JSON array, or a
    // multi-section markdown evaluation) while leaving headroom under an
    // 8000 TPM cap even with a full Job-Description prompt's input tokens
    // added on top. Raise this via env if your Groq tier has a higher TPM
    // limit and you want more headroom (e.g. a paid tier).
    groqMaxCompletionTokens: readInt('GROQ_MAX_COMPLETION_TOKENS', 4096),
  },
  app: {
    questionsPerInterview: readInt('QUESTIONS_PER_INTERVIEW', 10),
    jdQuestionsPerInterview: readInt('JD_QUESTIONS_PER_INTERVIEW', 15),
    silenceTimeoutMs: readInt('SILENCE_TIMEOUT_MS', 15000),
  },
  // Server-side speech-to-text on the recorded answer audio — see
  // docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. Runs
  // ALONGSIDE the browser's own Web Speech API (never replaces it as the
  // live/interim transcript) and only improves the final transcript
  // before the candidate submits — see interview.controller.ts's
  // transcribeAnswer and public/js/audioRecorder.js. Every field here has
  // a working default and the whole feature is additive: with no
  // GROQ_API_KEY/GEMINI_API_KEY configured, or with sttEnabled false, the
  // app behaves exactly as it did before this existed (Web Speech text
  // only, no new network call, no new UI state).
  stt: {
    enabled: readBool('STT_ENABLED', true),
    // Ordered provider preference — mirrors aiFactory's provider-chain
    // pattern (services/ai/aiFactory.ts) but this is a completely
    // different API shape (multipart/binary audio upload, not a JSON chat
    // completion), so it's a small standalone chain in
    // transcriptionService.ts rather than routed through aiFactory. Only
    // providers with a configured key are actually tried, in this order;
    // if every configured provider fails (or none are configured), the
    // caller falls back to the Web Speech transcript with no error shown.
    providerChain: readStr('STT_PROVIDER_CHAIN', 'groq,gemini')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // whisper-large-v3-turbo: free on Groq's free tier (see the plan doc's
    // Sources), 216x real-time, and accepts the `prompt` field this
    // feature uses for keyword biasing. Override via env if Groq
    // renames/deprecates it, same reasoning as ai.groqModel above.
    groqModel: readStr('STT_GROQ_MODEL', 'whisper-large-v3-turbo'),
    language: readStr('STT_LANGUAGE', 'en'),
    maxAudioBytes: readInt('STT_MAX_AUDIO_MB', 10) * 1024 * 1024,
    maxAudioSeconds: readInt('STT_MAX_AUDIO_SECONDS', 600),
    timeoutMs: readInt('STT_TIMEOUT_MS', 15000),
    // Feeds the question's own topic + expectedKeywords to the ASR model
    // as its biasing prompt (Groq's `prompt` param / a Gemini instruction)
    // — see transcriptionService.ts's buildBiasPrompt. This is the single
    // biggest accuracy lever for this app specifically, since those
    // keywords are exactly the technical terms most often mis-heard.
    keywordBias: readBool('STT_KEYWORD_BIAS', true),
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
    // Deliberately using console.error, not the structured logger, here —
    // see docs/audit/02-BACKLOG-P4-P10.md [P5-01]. This runs during config
    // validation itself, before `config` can be trusted; the logger module
    // may read from config (transport target, log level, etc.), so calling
    // it here risks either a chicken-and-egg failure or logging through an
    // unvalidated/partially-initialized config. A raw console.error right
    // before process.exit(1) has no such dependency. Every other call site
    // in the app runs after this validation has already passed, so it uses
    // the structured logger instead.
    console.error('[Config] Invalid configuration:');
    errors.forEach((e) => console.error(`  • ${e}`));
    process.exit(1);
  }
}

export default config;
