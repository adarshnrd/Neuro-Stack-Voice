import { v4 as uuidv4 } from 'uuid';
import aiFactory from './ai/aiFactory';
import apiKeyService from './apiKey.service';
import interviewRepository from '../repositories/interview.repository';
import { SessionData, StartSessionOptions } from '../types';
import config from '../config/config';
import { AppError } from '../utils/appError';

class InterviewService {
  /**
   * Resolves the Gemini API key to use for this request: an explicit
   * ad-hoc key wins, otherwise fall back to the user's saved key (if any).
   * Both paths flow into the SAME per-request AI service instance — see
   * aiFactory.getService — never into shared mutable state.
   */
  private async resolveUserApiKey(
    userId: string | null,
    modelId: string,
    explicitKey?: string
  ): Promise<string | undefined> {
    if (explicitKey) return explicitKey;
    if (!userId) return undefined;
    if (!aiFactory.resolveModelInfo(modelId).provider.startsWith('google')) return undefined;
    const saved = await apiKeyService.getUserApiKey(userId, 'gemini');
    return saved ?? undefined;
  }

  async startSession(
    userId: string | null,
    techStack: string,
    modelId: string,
    questionsCount: number | undefined,
    options: StartSessionOptions = {}
  ): Promise<SessionData> {
    const sessionId = uuidv4();

    let count: number;
    if (questionsCount && questionsCount > 0) {
      count = questionsCount;
    } else if (techStack === 'Job Description') {
      count = config.app.jdQuestionsPerInterview;
    } else {
      count = config.app.questionsPerInterview;
    }

    const resolvedApiKey = await this.resolveUserApiKey(userId, modelId, options.userApiKey);
    const modelInfo = aiFactory.resolveModelInfo(modelId);
    const generationOptions = { jobDescription: options.jobDescription };

    let questions;
    try {
      const aiService = aiFactory.getService(modelId, resolvedApiKey);
      questions = await aiService.generateQuestions(techStack, count, generationOptions);
    } catch (primaryError) {
      console.warn(`[InterviewService] Primary model "${modelId}" failed:`, primaryError);
      console.log(`[InterviewService] Falling back to alternative model...`);
      try {
        const fallbackService = aiFactory.getFallbackService(modelId, resolvedApiKey);
        questions = await fallbackService.generateQuestions(techStack, count, generationOptions);
      } catch (fallbackError) {
        console.error(`[InterviewService] Fallback model also failed:`, fallbackError);
        throw new AppError(
          'All AI providers are currently unavailable. Please try again in a few moments.',
          503
        );
      }
    }

    const questionHistory = questions.map((q) => q.question);

    const sessionData: SessionData = {
      id: sessionId,
      userId,
      techStack,
      provider: modelInfo.provider,
      model: modelId,
      questions,
      answers: [],
      evaluations: [],
      status: 'active',
      finalEvaluation: null,
      jobDescription: options.jobDescription || null,
      questionHistory,
      extensionCount: 0,
      totalQuestions: questions.length,
      interviewContext: null,
      userApiKeyUsed: !!resolvedApiKey,
      createdAt: new Date().toISOString(),
    };

    await interviewRepository.createSession(sessionData);
    return sessionData;
  }

  /** Throws 404 if missing, 403 if it belongs to a different user. */
  private async getOwnedSession(sessionId: string, userId: string | null): Promise<SessionData> {
    const session = await interviewRepository.getSession(sessionId);
    if (!session) throw new AppError('Session not found', 404);
    // Sessions created before auth existed (or by an anonymous flow) have a
    // null userId and are only reachable by their creator's original,
    // unauthenticated path — treat any authenticated mismatch as forbidden.
    if (session.userId && session.userId !== userId) {
      throw new AppError('Session not found', 404);
    }
    return session;
  }

  async processAnswer(sessionId: string, userId: string | null, questionId: number, answerText: string) {
    const session = await this.getOwnedSession(sessionId, userId);

    if (session.status === 'completed') {
      throw new AppError('This session has already been completed', 400);
    }

    const question = session.questions.find((q) => q.id === questionId);
    if (!question) throw new AppError('Question not found', 404);

    const alreadyAnswered = session.answers?.some((a) => a.questionId === questionId);
    if (alreadyAnswered) {
      throw new AppError(`Question ${questionId} has already been answered`, 409);
    }

    // Evaluate BEFORE writing anything — if the AI call fails we want the
    // session left untouched, not left with a saved answer but no evaluation.
    const aiService = aiFactory.getService(session.model);
    let evaluation;
    try {
      evaluation = await aiService.evaluateAnswer(question.question, answerText);
    } catch (primaryError) {
      console.warn('[InterviewService] Evaluation failed with primary model, trying fallback:', primaryError);
      try {
        const fallbackService = aiFactory.getFallbackService(session.model);
        evaluation = await fallbackService.evaluateAnswer(question.question, answerText);
      } catch (fallbackError) {
        console.error('[InterviewService] Fallback evaluation also failed:', fallbackError);
        throw new AppError(
          'All AI providers are currently unavailable for evaluation. Please try again.',
          503
        );
      }
    }

    const newAnswer = { questionId, text: answerText, timestamp: new Date().toISOString() };

    // Single atomic read-modify-write combining the answer, its evaluation,
    // and the derived interview-context entry. Building all three from a
    // snapshot fetched immediately before this write (rather than the one
    // fetched at the top of this method, before the AI call had a chance to
    // run) closes the window where a concurrent answer on the same session
    // could be silently dropped by a stale overwrite.
    const updated = await interviewRepository.recordAnswerAndEvaluation(sessionId, (fresh) => {
      const answers = [...(fresh.answers || []), newAnswer];
      const evaluations = [...(fresh.evaluations || []), { questionId, ...evaluation }];
      const interviewContext = [
        ...(fresh.interviewContext || []),
        { question: question.question, answer: answerText, score: evaluation.score, topic: question.topic },
      ];
      return { answers, evaluations, interviewContext };
    });

    return { session: updated, evaluation };
  }

  async endSession(sessionId: string, userId: string | null) {
    const session = await this.getOwnedSession(sessionId, userId);

    if (session.status === 'completed') {
      return session; // Idempotent — already completed.
    }

    const answeredQaPairs = session.questions
      .map((q) => {
        const answer = session.answers?.find((a) => a.questionId === q.id);
        return answer ? { question: q.question, answer: answer.text } : null;
      })
      .filter((pair): pair is { question: string; answer: string } => pair !== null);

    const answeredCount = answeredQaPairs.length;
    const totalCount = session.questions.length;

    let finalEval;

    if (answeredCount === 0) {
      finalEval = {
        overallScore: 0,
        overallFeedback: 'No questions were answered during this interview. Start a new session to practice your skills.',
      };
    } else {
      const aiService = aiFactory.getService(session.model);
      try {
        finalEval = await aiService.evaluateInterview(answeredQaPairs);
      } catch (primaryError) {
        console.warn('[InterviewService] Final evaluation failed with primary, trying fallback:', primaryError);
        try {
          const fallbackService = aiFactory.getFallbackService(session.model);
          finalEval = await fallbackService.evaluateInterview(answeredQaPairs);
        } catch (fallbackError) {
          console.error('[InterviewService] Fallback final evaluation also failed:', fallbackError);
          throw new AppError(
            'All AI providers are currently unavailable for final evaluation. Please try again.',
            503
          );
        }
      }

      // Override the subjective AI overall score with a strict mathematical
      // average of the individual question scores to ensure consistency.
      if (session.evaluations && session.evaluations.length > 0) {
        const validEvals = session.evaluations.filter((e) => typeof e.score === 'number');
        if (validEvals.length > 0) {
          const totalScore = validEvals.reduce((sum: number, e) => sum + e.score, 0);
          finalEval.overallScore = Math.round((totalScore / (validEvals.length * 10)) * 100);
        } else {
          finalEval.overallScore = 0;
        }
      } else {
        finalEval.overallScore = 0;
      }
    }

    await interviewRepository.updateSession(sessionId, {
      status: 'completed',
      finalEvaluation: finalEval,
      answeredCount,
      totalQuestions: totalCount,
    });

    return interviewRepository.getSession(sessionId);
  }

  async extendSession(sessionId: string, userId: string | null, additionalCount: number = 5) {
    const session = await this.getOwnedSession(sessionId, userId);

    const previousQuestions: string[] = session.questionHistory || session.questions.map((q) => q.question);

    const aiService = aiFactory.getService(session.model);
    let newQuestions;
    try {
      newQuestions = await aiService.generateQuestions(session.techStack, additionalCount, {
        previousQuestions,
        jobDescription: session.jobDescription || undefined,
        interviewContext: session.interviewContext ? JSON.stringify(session.interviewContext) : undefined,
      });
    } catch (primaryError) {
      console.warn('[InterviewService] Extend: primary model failed, trying fallback:', primaryError);
      try {
        const fallbackService = aiFactory.getFallbackService(session.model);
        newQuestions = await fallbackService.generateQuestions(session.techStack, additionalCount, {
          previousQuestions,
          jobDescription: session.jobDescription || undefined,
        });
      } catch (fallbackError) {
        console.error('[InterviewService] Extend: fallback also failed:', fallbackError);
        throw new AppError(
          'All AI providers are currently unavailable to extend the session. Please try again.',
          503
        );
      }
    }

    const maxId = Math.max(...session.questions.map((q) => q.id), 0);
    newQuestions.forEach((q, i: number) => {
      q.id = maxId + i + 1;
    });

    const updatedQuestions = [...session.questions, ...newQuestions];
    const updatedHistory = [...previousQuestions, ...newQuestions.map((q) => q.question)];

    await interviewRepository.updateSession(sessionId, {
      questions: updatedQuestions,
      questionHistory: updatedHistory,
      extensionCount: (session.extensionCount || 0) + 1,
      totalQuestions: updatedQuestions.length,
      status: 'active',
      finalEvaluation: null, // Clear previous final evaluation — session re-opens for more Q&A.
    });

    return interviewRepository.getSession(sessionId);
  }

  async getHistory(userId: string, limit: number = 20, offset: number = 0) {
    const sessions = await interviewRepository.listCompletedSessions(userId, limit, offset);
    return sessions.map((s) => ({
      id: s.id,
      techStack: s.techStack,
      model: s.model,
      provider: s.provider,
      overallScore: s.finalEvaluation?.overallScore ?? null,
      answeredCount: s.answeredCount ?? s.answers?.length ?? 0,
      totalQuestions: s.totalQuestions ?? s.questions?.length ?? 0,
      createdAt: s.createdAt,
    }));
  }

  async getSessionDetail(sessionId: string, userId: string | null) {
    return this.getOwnedSession(sessionId, userId);
  }
}

export default new InterviewService();
