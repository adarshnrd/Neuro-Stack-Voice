import { Request, Response, NextFunction } from 'express';
import interviewService from '../../services/interview.service';
import config from '../../config/config';
import { DIFFICULTY_LEVELS as DIFFICULTY_LEVEL_MAP, DIFFICULTY_LEVEL_IDS } from '../../config/difficultyLevels';
import { AppError } from '../../utils/appError';

function requireUserId(req: Request): string {
  if (!req.user) throw new AppError('Authentication required', 401);
  return req.user.id;
}

/**
 * Resolves the caller's owner id for routes that work for both logged-in
 * and anonymous visitors (see interview.routes.ts): the real user id when
 * a valid session cookie was present (attachUserIfPresent populates
 * req.user), or null for an anonymous caller. Never throws — routes using
 * this are explicitly meant to allow anonymous access.
 */
function getOwnerId(req: Request): string | null {
  return req.user?.id ?? null;
}

/** UUID v4 format check — mirrors validateUuidParam's regex for validating
 *  the elements of an array body field (that middleware only checks a
 *  single route param, not an array inside req.body). */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLAIM_IDS = 200;

/** Same loose format check validate.ts's validateBody uses for 'email' rules. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The full set of model ids this app actually advertises (served, with
 * their display metadata, by GET /models). Exported so interview.routes.ts
 * can validate incoming `model` fields against the SAME list via
 * validateBody's `oneOf` rule — see docs/audit/01-BACKLOG-P0-P3.md
 * [P2-02]. Before this, any string was accepted and interpolated straight
 * into an outbound request URL (GeminiService.makeRequest) with no
 * allowlist anywhere in between; a caller could name an arbitrary
 * Gemini/Groq/NVIDIA model (billing the server's own key for it) or a
 * path-control payload like `gemini/../../../<path>` that survives the
 * `startsWith('gemini')` check in aiFactory.resolveModelInfo. `groq` and
 * `nvidia`'s `description` are filled in from config (env-overridable) at
 * request time in `getModels` below, same as before — only the id/name/
 * provider fields need to be static here, since only `id` feeds the
 * allowlist. Single source of truth for both consumers: update this array
 * once and both the advertised list and the accepted list move together.
 */
export const AI_MODELS = [
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', provider: 'Google Gemini', description: 'Latest — fast, high-quality (GA)' },
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', provider: 'Google Gemini', description: 'Premium reasoning & analysis' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', provider: 'Google Gemini', description: 'Stable multimodal understanding' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', provider: 'Google Gemini', description: 'Strong agentic performance' },
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview', provider: 'Google Gemini', description: 'Preview — latest features' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google Gemini', description: 'Cost-optimized speed' },
  { id: 'groq', name: 'Groq', provider: 'Groq', description: null as string | null },
  { id: 'nvidia', name: 'NVIDIA', provider: 'NVIDIA', description: null as string | null },
];

export const AI_MODEL_IDS: string[] = AI_MODELS.map((m) => m.id);

/**
 * The full set of tech-stack values this app advertises (served verbatim
 * by GET /tech-stacks). Exported so interview.routes.ts can validate
 * incoming `techStack` fields against the SAME list via validateBody's
 * `oneOf` rule — see docs/audit/01-BACKLOG-P0-P3.md [P3-05]: previously
 * `techStack` was accepted as any string up to 200 characters and flowed
 * unescaped into every question-generation prompt, making it a second,
 * unfiltered prompt-injection surface alongside `jobDescription` (the only
 * field `sanitizeJDInput` ever covered). Constraining it to this fixed,
 * known-safe vocabulary — the same treatment [P2-02] gives `model` —
 * removes that surface entirely rather than trying to filter it.
 */
export const TECH_STACKS = [
  'Node.js', 'React', 'Next.js', 'Python', 'Django',
  'Java', 'Spring Boot', 'C#', '.NET', 'Ruby on Rails',
  'Go', 'Rust', 'PHP', 'Laravel', 'Vue.js', 'Angular',
  'Svelte', 'MERN Stack', 'MEAN Stack', 'LAMP Stack',
  'MySQL',
  'Job Description',
  // See docs/project-improvement/RESUME_MODE_PLAN.md §2. Interview
  // content is driven by a ResumeProfile extracted from the candidate's
  // resume (POST /resume/analyze), the same way 'Job Description' is
  // driven by jobDescription — everything downstream (toHistorySummary,
  // the stack icon map, the interview badge) already keys off techStack,
  // so this one addition is all that's needed to render correctly.
  'Resume',
];

/**
 * The full set of difficulty levels this app advertises (served, with
 * their display metadata, by GET /config) — see
 * docs/project-improvement/DIFFICULTY_LEVEL_PLAN.md and
 * src/config/difficultyLevels.ts (the single source of truth these are
 * derived from). Exported so interview.routes.ts can validate incoming
 * `difficultyLevel` fields against the SAME list via validateBody's
 * `oneOf` rule — the same allowlist pattern [P2-02]/[P3-05] already give
 * `model` and `techStack`, since this string also flows into every
 * generation/evaluation prompt.
 */
export const DIFFICULTY_LEVELS = DIFFICULTY_LEVEL_IDS.map((id) => {
  const level = DIFFICULTY_LEVEL_MAP[id];
  return { id: level.id, label: level.label, experience: level.experience, blurb: level.blurb };
});

export { DIFFICULTY_LEVEL_IDS };

class InterviewController {
  /**
   * Resume-mode pass 1 — see docs/project-improvement/RESUME_MODE_PLAN.md
   * §4.1/§9. Standalone and anonymous-friendly (mirrors /start's own
   * pattern): runs BEFORE any session exists, so the client can show the
   * extracted profile and let the candidate fix it before POST /start.
   * Rate-limited tightly at the route layer (interview.routes.ts) — it's
   * unauthenticated and burns an AI call per request.
   */
  async analyzeResume(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = getOwnerId(req);
      const { resumeText, model, userApiKey } = req.body;

      if (!resumeText || typeof resumeText !== 'string' || !resumeText.trim()) {
        return next(new AppError('resumeText is required', 400));
      }
      if (resumeText.length > 10000) {
        return next(new AppError('resumeText must not exceed 10,000 characters', 400));
      }
      if (userApiKey && (typeof userApiKey !== 'string' || userApiKey.length > 256)) {
        return next(new AppError('userApiKey must be a string of at most 256 characters', 400));
      }

      const { profile, providerSwitch } = await interviewService.analyzeResume(
        userId,
        resumeText,
        typeof model === 'string' && model ? model : undefined,
        userApiKey
      );
      res.status(200).json({ success: true, data: profile, ...(providerSwitch ? { providerSwitch } : {}) });
    } catch (error) {
      next(error);
    }
  }

  async start(req: Request, res: Response, next: NextFunction) {
    try {
      // No login required — anonymous sessions are owned by nobody
      // (userId null) and identified purely by their session UUID. See
      // interview.routes.ts for the full anonymous-history design.
      const userId = getOwnerId(req);
      const { techStack, model, questionsCount, jobDescription, userApiKey, historyEmail, difficultyLevel, resumeProfile } =
        req.body;

      if (techStack === 'Job Description' && (!jobDescription || !String(jobDescription).trim())) {
        return next(new AppError('Job Description text is required for JD mode', 400));
      }
      if (jobDescription && String(jobDescription).length > 5000) {
        return next(new AppError('Job Description must not exceed 5,000 characters', 400));
      }
      // See docs/project-improvement/RESUME_MODE_PLAN.md §9 — mirrors the
      // JD-mode check above. `resumeProfile` itself is re-validated and
      // sanitized server-side inside startSession (validateResumeProfile,
      // same treatment an AI-returned profile gets); this is just the
      // "did they even provide one" gate.
      if (techStack === 'Resume' && (!resumeProfile || typeof resumeProfile !== 'object')) {
        return next(new AppError('Resume analysis is required for Resume mode', 400));
      }
      if (questionsCount !== undefined) {
        const qc = Number(questionsCount);
        if (!Number.isInteger(qc) || qc < 1 || qc > 50) {
          return next(new AppError('questionsCount must be an integer between 1 and 50', 400));
        }
      }
      if (userApiKey && (typeof userApiKey !== 'string' || userApiKey.length > 256)) {
        return next(new AppError('userApiKey must be a string of at most 256 characters', 400));
      }
      // Optional, unverified self-reported email tag — see
      // docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md. Loosely format-checked only;
      // never required, never blocks starting the interview.
      if (historyEmail !== undefined && historyEmail !== null && historyEmail !== '') {
        if (typeof historyEmail !== 'string' || historyEmail.length > 254 || !EMAIL_RE.test(historyEmail)) {
          return next(new AppError('historyEmail must be a valid email address', 400));
        }
      }

      const { session, providerSwitch } = await interviewService.startSession(
        userId,
        techStack,
        model,
        questionsCount,
        {
          jobDescription,
          userApiKey,
          historyEmail: historyEmail || undefined,
          // Route-layer oneOf validation (interview.routes.ts) already
          // rejects anything outside DIFFICULTY_LEVEL_IDS before this runs;
          // startSession itself resolves an absent value to
          // DEFAULT_DIFFICULTY_LEVEL — see difficultyLevels.ts.
          difficultyLevel: difficultyLevel || undefined,
          resumeProfile: resumeProfile || undefined,
        }
      );
      res.status(201).json({ success: true, session, ...(providerSwitch ? { providerSwitch } : {}) });
    } catch (error) {
      next(error);
    }
  }

  async extend(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = getOwnerId(req);
      const { sessionId } = req.params;
      let { additionalCount = 5 } = req.body;

      additionalCount = Number(additionalCount);
      if (!Number.isInteger(additionalCount) || additionalCount < 1 || additionalCount > 20) {
        return next(new AppError('additionalCount must be an integer between 1 and 20', 400));
      }

      const { session, providerSwitch } = await interviewService.extendSession(
        sessionId,
        userId,
        additionalCount
      );
      res.status(200).json({ success: true, session, ...(providerSwitch ? { providerSwitch } : {}) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Manually re-runs the final narrative (overallFeedback) for an
   * already-completed session — see RICH_EVALUATION_SCALE_PLAN.md §6.
   * `overallScore` is already kept current automatically as per-question
   * evaluations land late; this is only for someone who explicitly wants
   * an up-to-date write-up after that's happened (the UI surfaces this as
   * a "Refresh overall feedback" action when overallFeedbackStatus is
   * 'stale').
   */
  async refreshFeedback(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = getOwnerId(req);
      const { sessionId } = req.params;
      const { session, providerSwitch } = await interviewService.refreshOverallFeedback(sessionId, userId);
      res.status(200).json({ success: true, session, ...(providerSwitch ? { providerSwitch } : {}) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * On-demand "how would I answer this" guidance for a question whose own
   * scoring genuinely failed — see interviewService.getAnswerGuidance.
   * Anonymous-friendly for the same reason /refresh-feedback and
   * GET /:sessionId are: ownership is enforced inside getOwnedSession.
   */
  async getAnswerGuidance(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = getOwnerId(req);
      const { sessionId, questionId } = req.params;

      const qid = Number(questionId);
      if (!Number.isInteger(qid) || qid < 0) {
        return next(new AppError('questionId must be a valid integer', 400));
      }

      const { session, providerSwitch } = await interviewService.getAnswerGuidance(sessionId, userId, qid);
      res.status(200).json({ success: true, session, ...(providerSwitch ? { providerSwitch } : {}) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Server-side ASR pass on a candidate's recorded answer audio — see
   * docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. The
   * request body IS the raw audio bytes (see interview.routes.ts's
   * express.raw() on this route — deliberately not multipart/form-data,
   * so this endpoint needs no new upload-handling dependency), not JSON.
   * Anonymous-friendly for the same reason /guidance is: ownership is
   * enforced inside interviewService.transcribeAnswer.
   */
  async transcribeAnswer(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = getOwnerId(req);
      const { sessionId, questionId } = req.params;

      const qid = Number(questionId);
      if (!Number.isInteger(qid) || qid < 0) {
        return next(new AppError('questionId must be a valid integer', 400));
      }

      const audio = req.body;
      if (!Buffer.isBuffer(audio) || audio.length === 0) {
        return next(new AppError('Request body must be non-empty audio data', 400));
      }
      if (audio.length > config.stt.maxAudioBytes) {
        return next(
          new AppError(`Audio exceeds the maximum size of ${Math.round(config.stt.maxAudioBytes / (1024 * 1024))}MB`, 413)
        );
      }

      const contentType =
        typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : 'audio/webm';

      const result = await interviewService.transcribeAnswer(sessionId, userId, qid, audio, contentType);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  getTechStacks(_req: Request, res: Response, next: NextFunction) {
    try {
      res.json({ success: true, data: TECH_STACKS });
    } catch (error) {
      next(error);
    }
  }

  getModels(_req: Request, res: Response, next: NextFunction) {
    try {
      // Built from the shared AI_MODELS constant (see its doc comment) so
      // this stays the exact list interview.routes.ts's `oneOf` validator
      // accepts — 'groq'/'nvidia' get their description filled in from
      // config here, same env-overridable values as before.
      const models = AI_MODELS.map((m) => ({
        ...m,
        description:
          m.description ?? (m.id === 'groq' ? config.ai.groqModel : m.id === 'nvidia' ? config.ai.nvidiaModel : ''),
      }));
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
          questionsPerInterview: config.app.questionsPerInterview,
          jdQuestionsPerInterview: config.app.jdQuestionsPerInterview,
          silenceTimeoutMs: config.app.silenceTimeoutMs,
          // See DIFFICULTY_LEVELS's doc comment above — the client's
          // level picker renders from this list rather than hardcoding
          // labels, so it can never drift from what POST /start actually
          // accepts.
          difficultyLevels: DIFFICULTY_LEVELS,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async getHistory(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = requireUserId(req);
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const sessions = await interviewService.getHistory(userId, limit, offset);
      res.json({ success: true, data: sessions });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Looks up completed interview history by a self-reported email — no
   * login, no password/PIN. See docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md
   * (Option B, explicitly chosen with no verification): this is
   * intentionally an unauthenticated, unverified lookup. Route-level rate
   * limiting (interview.routes.ts) is the only abuse guard.
   */
  async historyByEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 50);
      const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
      const sessions = await interviewService.getHistoryByEmail(email, limit, offset);
      res.json({ success: true, data: sessions });
    } catch (error) {
      next(error);
    }
  }

  async getSessionDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = getOwnerId(req);
      const { sessionId } = req.params;
      const session = await interviewService.getSessionDetail(sessionId, userId);
      res.json({ success: true, data: session });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Attaches the now-authenticated caller's own anonymous session ids
   * (collected client-side, from before they had an account) to their
   * account. Only touches sessions that are still unowned — never takes
   * over a session that already belongs to someone (including the caller
   * themselves, where it's a harmless no-op).
   */
  async claim(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = requireUserId(req);
      const { sessionIds } = req.body;

      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        return next(new AppError('sessionIds must be a non-empty array', 400));
      }
      if (sessionIds.length > MAX_CLAIM_IDS) {
        return next(new AppError(`sessionIds must contain at most ${MAX_CLAIM_IDS} ids`, 400));
      }
      const validIds = sessionIds.filter(
        (id): id is string => typeof id === 'string' && UUID_V4_RE.test(id)
      );
      if (validIds.length === 0) {
        return next(new AppError('sessionIds contained no valid session UUIDs', 400));
      }

      const claimed = await interviewService.claimSessions(validIds, userId);
      res.json({ success: true, data: { claimed } });
    } catch (error) {
      next(error);
    }
  }
}

export default new InterviewController();
