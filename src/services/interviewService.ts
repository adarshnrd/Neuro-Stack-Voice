import { v4 as uuidv4 } from 'uuid';
import aiFactory from './ai/aiFactory';
import interviewRepository from '../repositories/interviewRepository';
import { SessionData, StartSessionOptions } from '../interfaces';
import config from '../config/config';
import { AppError } from '../utils/appError';

class InterviewService {
  async startSession(
    techStack: string,
    modelId: string,
    questionsCount?: number,
    options: StartSessionOptions = {}
  ): Promise<SessionData> {
    const sessionId = uuidv4();

    // Dynamic question count logic
    let count: number;
    if (questionsCount && questionsCount > 0) {
      count = questionsCount;
    } else if (techStack === 'Job Description') {
      count = config.app.jdQuestionsPerInterview;
    } else {
      count = config.app.questionsPerInterview;
    }

    // Get AI service with optional user API key
    const aiService = aiFactory.getService(modelId, options.userApiKey);
    const modelInfo = aiFactory.resolveModelInfo(modelId);

    const generationOptions = { jobDescription: options.jobDescription };

    let questions;
    try {
      questions = await aiService.generateQuestions(techStack, count, generationOptions);
    } catch (primaryError) {
      console.warn(`[InterviewService] Primary model "${modelId}" failed:`, primaryError);
      console.log(`[InterviewService] Falling back to alternative model...`);
      try {
        const fallbackService = aiFactory.getFallbackService(modelId);
        questions = await fallbackService.generateQuestions(techStack, count, generationOptions);
      } catch (fallbackError) {
        console.error(`[InterviewService] Fallback model also failed:`, fallbackError);
        throw new AppError(
          'All AI providers are currently unavailable. Please try again in a few moments.',
          503
        );
      }
    }

    // Build question history for future deduplication
    const questionHistory = questions.map((q) => q.question);

    const sessionData: SessionData = {
      id: sessionId,
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
      userApiKeyUsed: !!options.userApiKey,
      createdAt: new Date().toISOString(),
    };

    await interviewRepository.createSession(sessionData);
    return sessionData;
  }

  async processAnswer(sessionId: string, questionId: number, answerText: string) {
    const session = await interviewRepository.getSession(sessionId);
    if (!session) throw new AppError('Session not found', 404);

    // ── Guard: reject answers on completed sessions ──
    if (session.status === 'completed') {
      throw new AppError('This session has already been completed', 400);
    }

    const question = session.questions.find((q) => q.id === questionId);
    if (!question) throw new AppError('Question not found', 404);

    // ── Guard: idempotency — reject duplicate answers for the same question ──
    const alreadyAnswered = session.answers?.some(
      (a) => a.questionId === questionId
    );
    if (alreadyAnswered) {
      throw new AppError(
        `Question ${questionId} has already been answered`,
        409
      );
    }

    // Save the raw answer first
    const newAnswer = {
      questionId,
      text: answerText,
      timestamp: new Date().toISOString(),
    };
    const answers = [...(session.answers || []), newAnswer];
    await interviewRepository.updateSession(sessionId, { answers });

    // Evaluate answer with primary model, fallback on failure
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

    const evaluations = [...(session.evaluations || []), { questionId, ...evaluation }];

    // Update interview context for adaptive questioning
    const contextEntry = {
      question: question.question,
      answer: answerText,
      score: evaluation.score,
      topic: question.topic,
    };
    const interviewContext = [...(session.interviewContext || []), contextEntry];

    await interviewRepository.updateSession(sessionId, { evaluations, interviewContext });

    return { session: await interviewRepository.getSession(sessionId), evaluation };
  }

  async endSession(sessionId: string) {
    const session = await interviewRepository.getSession(sessionId);
    if (!session) throw new AppError('Session not found', 404);

    // ── Guard: prevent double-completion ──
    if (session.status === 'completed') {
      // Already completed — return existing result (idempotent)
      return session;
    }

    // Only include questions that were actually answered
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
      // No questions answered — return default evaluation without calling AI
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

      // Override the subjective AI overall score with a strict mathematical average 
      // of the individual question scores to ensure consistency.
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

    return await interviewRepository.getSession(sessionId);
  }

  async extendSession(sessionId: string, additionalCount: number = 5) {
    const session = await interviewRepository.getSession(sessionId);
    if (!session) throw new AppError('Session not found', 404);

    const previousQuestions: string[] = (
      session.questionHistory || session.questions.map((q) => q.question)
    );

    const aiService = aiFactory.getService(session.model);
    let newQuestions;
    try {
      newQuestions = await aiService.generateQuestions(session.techStack, additionalCount, {
        previousQuestions,
        jobDescription: session.jobDescription || undefined,
        interviewContext: session.interviewContext
          ? JSON.stringify(session.interviewContext)
          : undefined,
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

    // Re-index question IDs to continue from last
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
      finalEvaluation: null, // Clear previous final evaluation
    });

    return await interviewRepository.getSession(sessionId);
  }

  async getHistory(limit: number = 20, offset: number = 0) {
    const sessions = await interviewRepository.listCompletedSessions(limit, offset);
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

  async getSessionDetail(sessionId: string) {
    const session = await interviewRepository.getSession(sessionId);
    if (!session) throw new AppError('Session not found', 404);
    return session;
  }
}

export default new InterviewService();
