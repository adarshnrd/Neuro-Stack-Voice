import { Request, Response, NextFunction } from 'express';
import interviewService from '../services/interviewService';
import config from '../config/config';
import { AppError } from '../utils/appError';

class InterviewController {
  async start(req: Request, res: Response, next: NextFunction) {
    try {
      const { techStack, model, questionsCount, jobDescription, userApiKey } = req.body;

      // Validate JD mode has content
      if (
        techStack === 'Job Description' &&
        (!jobDescription || !String(jobDescription).trim())
      ) {
        return next(new AppError('Job Description text is required for JD mode', 400));
      }

      // Validate JD length
      if (jobDescription && String(jobDescription).length > 5000) {
        return next(new AppError('Job Description must not exceed 5,000 characters', 400));
      }

      // Validate optional questionsCount when provided
      if (questionsCount !== undefined) {
        const qc = Number(questionsCount);
        if (!Number.isInteger(qc) || qc < 1 || qc > 50) {
          return next(new AppError('questionsCount must be an integer between 1 and 50', 400));
        }
      }

      // Validate optional user API key length
      if (userApiKey && (typeof userApiKey !== 'string' || userApiKey.length > 256)) {
        return next(new AppError('userApiKey must be a string of at most 256 characters', 400));
      }

      const session = await interviewService.startSession(techStack, model, questionsCount, {
        jobDescription,
        userApiKey,
      });
      res.status(201).json({ success: true, session });
    } catch (error) {
      next(error);
    }
  }

  async extend(req: Request, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      let { additionalCount = 5 } = req.body;

      additionalCount = Number(additionalCount);
      if (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 20) {
        return next(new AppError('additionalCount must be an integer between 1 and 20', 400));
      }

      const session = await interviewService.extendSession(sessionId, additionalCount);
      res.status(200).json({ success: true, session });
    } catch (error) {
      next(error);
    }
  }

  getTechStacks(_req: Request, res: Response, next: NextFunction) {
    try {
      const stacks = [
        'Node.js', 'React', 'Next.js', 'Python', 'Django',
        'Java', 'Spring Boot', 'C#', '.NET', 'Ruby on Rails',
        'Go', 'Rust', 'PHP', 'Laravel', 'Vue.js', 'Angular',
        'Svelte', 'MERN Stack', 'MEAN Stack', 'LAMP Stack',
        'MySQL',
        'Job Description',
      ];
      res.json({ success: true, data: stacks });
    } catch (error) {
      next(error);
    }
  }

  getModels(_req: Request, res: Response, next: NextFunction) {
    try {
      const models = [
        // Google Gemini models
        { id: 'gemini-3.5-flash',     name: 'Gemini 3.5 Flash',     provider: 'Google Gemini', description: 'Latest — fast, high-quality (GA)' },
        { id: 'gemini-3.1-pro',       name: 'Gemini 3.1 Pro',       provider: 'Google Gemini', description: 'Premium reasoning & analysis' },
        { id: 'gemini-3-pro',         name: 'Gemini 3 Pro',         provider: 'Google Gemini', description: 'Stable multimodal understanding' },
        { id: 'gemini-3-flash',       name: 'Gemini 3 Flash',       provider: 'Google Gemini', description: 'Strong agentic performance' },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', provider: 'Google Gemini', description: 'Preview — latest features' },
        { id: 'gemini-2.5-flash',     name: 'Gemini 2.5 Flash',     provider: 'Google Gemini', description: 'Cost-optimized speed' },
        // Groq models
        { id: 'groq',   name: 'Groq Llama',      provider: 'Groq',   description: 'llama-3.3-70b-versatile' },
        // NVIDIA models
        { id: 'nvidia', name: 'NVIDIA Nemotron', provider: 'NVIDIA', description: 'Nemotron-3-Nano-Omni-30b' },
      ];
      res.json({ success: true, data: models });
    } catch (error) {
      next(error);
    }
  }

  getConfig(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({
        success: true,
        data: {
          questionsPerInterview:   config.app.questionsPerInterview,
          jdQuestionsPerInterview: config.app.jdQuestionsPerInterview,
          silenceTimeoutMs:        config.app.silenceTimeoutMs,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const sessions = await interviewService.getHistory(limit, offset);
      res.json({ success: true, data: sessions });
    } catch (error) {
      next(error);
    }
  }

  async getSessionDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      const session = await interviewService.getSessionDetail(sessionId);
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }
}

export default new InterviewController();
