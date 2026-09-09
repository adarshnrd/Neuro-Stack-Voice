import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import interviewController, { AI_MODEL_IDS, TECH_STACKS, DIFFICULTY_LEVEL_IDS } from '../controllers/interview.controller';
import { validateBody, validateUuidParam } from '../middleware/validate';
import { requireAuth, attachUserIfPresent } from '../middleware/auth';
import config from '../../config/config';

const router = Router();

// Tighter than the app-wide limiter — this endpoint takes a bare email and
// returns whether/what history exists for it with no proof of ownership
// (see docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md, Option B). Rate limiting here
// doesn't fix that trade-off, but it does blunt bulk scraping across many
// emails from one source. Mirrors auth.routes.ts's authLimiter shape.
const historyLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many lookups. Please try again later.' },
});

// Tighter still than historyLookupLimiter — see
// docs/project-improvement/RESUME_MODE_PLAN.md §9: this endpoint is
// unauthenticated AND burns a real AI call per request (unlike the lookup
// above, which is a cheap DB read), so it gets the tightest limit in the app.
const resumeAnalyzeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many resume analyses. Please try again later.' },
});

// See docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. Each
// answer produces at most one transcription call from the client (see
// audioRecorder.js) plus the occasional user-triggered retry, and a
// 10-question interview is the normal shape of this app — 60/15min is
// generous headroom for that while still bounding abuse of a per-request
// ASR call against the server's own provider keys.
const transcribeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many transcription requests. Please try again later.' },
});

// ── Public reference data — no user data involved ──
router.get('/tech-stacks', interviewController.getTechStacks);
router.get('/models', interviewController.getModels);
router.get('/config', interviewController.getConfig);

// Resume-mode pass 1 — see docs/project-improvement/RESUME_MODE_PLAN.md
// §4.1/§9. Standalone and anonymous-friendly, same as /start: runs BEFORE
// any session exists, so the client can show the extracted profile and let
// the candidate fix it before POST /start. `model` is validated against the
// same allowlist /start uses (GET /models) — optional, defaults to 'groq'
// in the service when omitted.
router.post(
  '/resume/analyze',
  resumeAnalyzeLimiter,
  attachUserIfPresent,
  validateBody({
    resumeText: { required: true, type: 'string', maxLength: 10000 },
    model: { required: false, type: 'string', maxLength: 100, oneOf: AI_MODEL_IDS },
  }),
  interviewController.analyzeResume
);

// ── No login required to take an interview or read one back ──
// These use attachUserIfPresent (populates req.user when a valid session
// cookie is present, but doesn't reject the request otherwise) instead of
// requireAuth, so an anonymous visitor can start, answer, extend, and
// review their own interview sessions. Ownership itself is still enforced
// inside interviewService.getOwnedSession: an anonymous session (userId
// null) is reachable by anyone holding its unguessable session UUID —
// the same "URL is the access token" model a share link uses — while a
// session that DOES belong to a real account stays rejected for anyone
// else, logged in or not. See POST /claim below for the migrate-to-account
// path once a visitor registers or logs in.
router.post(
  '/start',
  attachUserIfPresent,
  validateBody({
    // Constrained to the exact list GET /tech-stacks advertises — see
    // docs/audit/01-BACKLOG-P0-P3.md [P3-05]. Previously any string up to
    // 200 chars was accepted and flowed unescaped into every
    // question-generation prompt, a second unfiltered prompt-injection
    // surface alongside jobDescription.
    techStack: { required: true, type: 'string', maxLength: 200, oneOf: TECH_STACKS },
    // Constrained to the exact list GET /models advertises — see
    // docs/audit/01-BACKLOG-P0-P3.md [P2-02]. Previously any string up to
    // 100 chars was accepted and flowed unvalidated into an outbound
    // request URL (GeminiService.makeRequest) and into arbitrary model
    // selection against the server's own provider keys.
    model: { required: true, type: 'string', maxLength: 100, oneOf: AI_MODEL_IDS },
    // Optional — startSession falls back to DEFAULT_DIFFICULTY_LEVEL
    // (software_engineer) when omitted, so every existing caller that
    // doesn't send this keeps working unchanged. When present, constrained
    // to the exact list GET /config advertises — see
    // docs/project-improvement/DIFFICULTY_LEVEL_PLAN.md §3.3, mirroring
    // techStack's [P3-05] and model's [P2-02] allowlist treatment: this
    // string also flows into every generation/evaluation prompt.
    difficultyLevel: { required: false, type: 'string', maxLength: 50, oneOf: DIFFICULTY_LEVEL_IDS },
  }),
  interviewController.start
);

router.post('/:sessionId/extend', attachUserIfPresent, validateUuidParam('sessionId'), interviewController.extend);

// Manually regenerates the final narrative (overallFeedback) for an
// already-completed session — see
// docs/project-improvement/RICH_EVALUATION_SCALE_PLAN.md §6.
// Anonymous-friendly for the same reason /extend and GET /:sessionId are:
// ownership is enforced inside interviewService.getOwnedSession, not here.
router.post(
  '/:sessionId/refresh-feedback',
  attachUserIfPresent,
  validateUuidParam('sessionId'),
  interviewController.refreshFeedback
);

// On-demand "how would I answer this" guidance for a question whose own
// scoring genuinely failed — see interviewService.getAnswerGuidance.
// Anonymous-friendly for the same reason /refresh-feedback is; questionId
// itself is validated inline in the controller (it's a small integer, not
// a UUID, so validateUuidParam doesn't apply).
router.post(
  '/:sessionId/questions/:questionId/guidance',
  attachUserIfPresent,
  validateUuidParam('sessionId'),
  interviewController.getAnswerGuidance
);

// Server-side ASR pass on a candidate's recorded answer audio — see
// docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md and
// audioRecorder.js. The body is raw audio bytes, not JSON — express.raw()
// is scoped to THIS route only (the app-wide express.json()/urlencoded()
// in app.ts simply no-op on a non-matching Content-Type, so nothing about
// any other route changes). Deliberately not multipart/form-data: a plain
// binary body needs no new upload-handling dependency (e.g. multer) at
// all, which matters here since this sandbox/environment can't run
// `npm install` to add one. `limit` is set one notch above
// config.stt.maxAudioBytes's default so a slightly-larger-than-default
// override still gets a clean 413 from the controller's own check instead
// of Express's raw-body-parser rejecting it first with a less specific
// error.
router.post(
  '/:sessionId/questions/:questionId/transcribe',
  transcribeLimiter,
  attachUserIfPresent,
  validateUuidParam('sessionId'),
  express.raw({
    type: ['audio/webm', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/m4a', 'audio/mpeg', 'audio/mp3'],
    limit: Math.max(config.stt.maxAudioBytes * 2, 20 * 1024 * 1024),
  }),
  interviewController.transcribeAnswer
);

// Looks up completed interview history by a self-reported email — no
// login, no password, no verification code. See
// docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md (Option B): explicitly chosen
// without proof of ownership, so anyone who knows or guesses an email
// used here can see that email's interview summaries (and, by opening
// one via GET /:sessionId below, its full Q&A — that route is already
// public for any userId-null session). This is a POST route, so it
// doesn't interact with GET /:sessionId's routing below either way.
router.post(
  '/history/lookup',
  historyLookupLimiter,
  validateBody({ email: { required: true, type: 'string', email: true, maxLength: 254 } }),
  interviewController.historyByEmail
);

// ── Requires a real account ──
// /history lists ALL of a user's completed sessions by userId, so it must
// stay behind requireAuth — an anonymous caller has no userId to key that
// query on, and querying by userId:null would leak every other anonymous
// visitor's sessions to anyone who asked. Anonymous visitors instead keep
// their own list of session ids client-side (localStorage) and fetch each
// one's detail individually via GET /:sessionId below.
//
// IMPORTANT: this must be registered BEFORE GET /:sessionId. Express
// matches GET routes in registration order, and /:sessionId matches ANY
// single path segment — including the literal string "history". If
// /:sessionId were registered first, a GET to /api/interviews/history
// would match IT instead, fail validateUuidParam("history" isn't a UUID),
// and short-circuit straight to the error handler — this route would
// never be reached at all. (Previously /:sessionId WAS registered first;
// this was a real bug, just a quiet one — the client's loadHistory()
// catches any failure here and silently falls back to the anonymous
// localStorage-based history, so a broken /history never surfaced as a
// visible error, it just silently always fell back.)
router.get('/history', requireAuth, interviewController.getHistory);

router.get('/:sessionId', attachUserIfPresent, validateUuidParam('sessionId'), interviewController.getSessionDetail);

// Attaches the caller's own anonymous session ids (created before they had
// an account) to their now-authenticated account, so history persists
// through the transition from anonymous to logged-in. Idempotent and only
// claims sessions that are still unowned (userId null) — replaying it, or
// passing someone else's session id, does nothing.
router.post(
  '/claim',
  requireAuth,
  validateBody({ sessionIds: { required: true } }),
  interviewController.claim
);

export default router;
