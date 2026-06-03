export interface AppConfig {
  env: string;
  port: number;
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
  cors: {
    allowedOrigins: string[];
  };
}

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

export interface StartSessionOptions {
  jobDescription?: string;
  userApiKey?: string;
}

export interface SessionData {
  id: string;
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
