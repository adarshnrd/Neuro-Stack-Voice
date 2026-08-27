// ─── Config ──────────────────────────────────────────────────────────────────

export interface AppConfig {
  env: string;
  isProduction: boolean;
  port: number;
  trustProxy: number | boolean;
  ai: {
    nvidiaKey?: string;
    groqKey?: string;
    geminiKey?: string;
  };
  app: {
    questionsPerInterview: number;
    jdQuestionsPerInterview: number;
    silenceTimeoutMs: number;
  };
  encryption: {
    secret: string;
  };
  auth: {
    jwtSecret: string;
    cookieSecure: boolean;
    tokenTtlSeconds: number;
  };
  cors: {
    allowedOrigins: string[];
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

export type FieldRule = {
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
  /** Min string length */
  minLength?: number;
  /** Expected type ('string' | 'number' | 'boolean') */
  type?: 'string' | 'number' | 'boolean';
  /** Simple email format check */
  email?: boolean;
};

export type Schema = Record<string, FieldRule>;

// ─── AI domain ───────────────────────────────────────────────────────────────

export interface Question {
  id: number;
  question: string;
  difficulty: string;
  topic: string;
  expectedKeywords: string[];
}

export interface EvaluationResult {
  score: number;
  feedback: string;
  betterAnswer: string;
}

export interface FinalEvaluation {
  overallScore: number;
  overallFeedback: string;
}

export interface GenerationOptions {
  jobDescription?: string;
  previousQuestions?: string[];
  interviewContext?: string;
}

export interface ResolvedModel {
  provider: string;
  model: string;
}

/** Runtime options passed to an AI service instance for a single request. */
export interface AIServiceOptions {
  model: string;
  /** Explicit caller-supplied API key, takes precedence over stored/config keys. */
  apiKey?: string;
}

// ─── Interview domain ────────────────────────────────────────────────────────

export interface StartSessionOptions {
  jobDescription?: string;
  userApiKey?: string;
}

export interface SessionData {
  id: string;
  userId: string | null;
  techStack: string;
  provider: string;
  model: string;
  questions: QuestionData[];
  answers: AnswerData[];
  evaluations: EvaluationData[];
  status: string;
  finalEvaluation: FinalEvaluationData | null;
  jobDescription: string | null;
  questionHistory: string[] | null;
  extensionCount: number;
  totalQuestions: number;
  answeredCount?: number;
  interviewContext: InterviewContextEntry[] | null;
  userApiKeyUsed: boolean;
  createdAt: string;
}

export interface QuestionData {
  id: number;
  question: string;
  difficulty: string;
  topic: string;
  expectedKeywords: string[];
}

export interface AnswerData {
  questionId: number;
  text: string;
  timestamp: string;
}

export interface EvaluationData {
  questionId: number;
  score: number;
  feedback: string;
  betterAnswer?: string;
}

export interface FinalEvaluationData {
  overallScore: number;
  overallFeedback: string;
}

export interface InterviewContextEntry {
  question: string;
  answer: string;
  score: number;
  topic: string;
}

// ─── Auth domain ─────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
}

export interface JwtPayload {
  sub: string; // user id
  email: string;
  iat?: number;
  exp?: number;
}

// Augment Express's Request type with the fields our middleware attaches.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}
