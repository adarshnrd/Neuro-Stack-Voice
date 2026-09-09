import { Server, Socket } from 'socket.io';
import interviewService from '../services/interview.service';
import logger from '../utils/logger';

/** Basic UUID v4 shape check to reject obviously malformed session IDs. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Maximum allowed answer text length (chars). Must match app.js's
 * MAX_ANSWER_LENGTH — that copy is only a client-side UX guard (live
 * counter, disabling submit); this is the one that's actually enforced.
 *
 * Chosen against Groq's documented worst case (config.ts's
 * `groqMaxCompletionTokens` comment: "as low as 8000 TPM for some
 * models"), since Groq is the default provider. The per-answer evaluation
 * prompt (promptBuilder.ts's getEvaluationPrompt) reserves
 * GROQ_MAX_COMPLETION_TOKENS=4096 output tokens on every call — checked
 * against the TPM cap BEFORE generation, per that same comment — which
 * already dominates the budget on its own; a candidate answering several
 * questions within the same 60s window (the app never blocks a submission
 * on the previous answer's evaluation finishing) can hit that ceiling from
 * completion-token reservations alone, independent of answer length. Input
 * tokens (system prompt + rubric/formatting scaffolding + the question
 * text + this answer, each fenced per [P3-05]) add roughly 1000-1100
 * fixed tokens on top of the answer itself. 4000 chars is ~1000 tokens of
 * answer text — generous for a genuine spoken technical answer (a couple
 * of paragraphs, easily 500+ words) while keeping a single call's total
 * input comfortably under the ~3900-token budget an 8000 TPM cap leaves
 * once the 4096-token completion reservation is taken out, and without
 * multiplying across the interview: the FINAL evaluation
 * (buildEvaluationDigest) never re-includes raw answer text, only a
 * 220-char AI-generated summary per question, so this limit's cost is
 * strictly local to one evaluation call, not the whole interview. Raise
 * via a paid tier with a higher TPM budget if needed.
 */
const MAX_ANSWER_LENGTH = 4000;

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

/** Emits a structured error event back to the client. */
function emitError(socket: Socket, code: string, message: string): void {
  socket.emit('error', { code, message });
}

// ─── Per-socket rate limiting ───────────────────────────────────────────────
// See docs/audit/01-BACKLOG-P0-P3.md [P3-10]. HTTP has three rate limiters
// (app.ts: 100/15min app-wide, authLimiter 20/15min, historyLookupLimiter
// 20/15min); the socket layer had none. A socket holding one valid session
// UUID could emit `answer:final` for every unanswered question as fast as
// the event loop allows — each accepted answer starts a background AI
// call (see interviewService.submitAnswer/_evaluateAndPersist), so this is
// cost exposure and a way to exhaust a provider's rate limit for every
// OTHER user via runWithProviderChain, not just this one session.
//
// A small token bucket per connected socket — not global, not per-session:
// the socket is already the identity boundary socketAuthMiddleware attaches
// `userId` to, and limiting per-socket means one abusive connection can't
// degrade the shared HTTP rate-limit budget or other sockets. Deliberately
// hand-rolled instead of pulling in express-rate-limit, which only
// instruments HTTP middleware, not raw socket event handlers.
//
// This does not separately track "concurrent in-flight evaluations per
// session" as its own counter — the audit also suggests that as a second,
// independent guard. In practice the two together already bound it tightly
// enough without adding a second piece of shared state to a fire-and-forget
// evaluation path that is deliberately careful about concurrency elsewhere
// (see the repository's withSessionLock): this bucket bounds how fast a
// socket can SUBMIT answers at all, and [P4-02]'s cap on total questions
// per session bounds how many distinct evaluations a single session could
// ever have in flight even at the bucket's max rate.
class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillWindowMs: number
  ) {
    this.tokens = capacity;
    this.lastRefillAt = Date.now();
  }

  /** Refills proportionally to elapsed time, then takes one token if available. */
  tryTake(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed > 0) {
      const refilled = (elapsed / this.refillWindowMs) * this.capacity;
      if (refilled >= 0.01) {
        this.tokens = Math.min(this.capacity, this.tokens + refilled);
        this.lastRefillAt = now;
      }
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Generous enough for legitimate rapid-fire answering (retries, a fast
 *  typist skipping voice input) while still bounding a tight abuse loop —
 *  roughly one answer every 3s sustained, bursts up to the full capacity. */
const ANSWER_BUCKET_CAPACITY = 20;
const ANSWER_BUCKET_WINDOW_MS = 60_000;
/** interview:end is normally called once (or, on a retry, a handful of
 *  times) per session — a smaller bucket is plenty. */
const END_BUCKET_CAPACITY = 10;
const END_BUCKET_WINDOW_MS = 60_000;

/**
 * All handlers below rely on `socket.data.userId`, populated by
 * socketAuthMiddleware (io.use()) before any event handler runs. It is
 * `null` for an anonymous (not logged in) connection — no login is
 * required to use the app — and a real user id otherwise. Session
 * ownership itself is enforced downstream inside interviewService
 * (getOwnedSession), which is the same check the HTTP routes use, so
 * joining a room you don't own fails the same way extending or ending it
 * would.
 */
export default function socketHandler(io: Server, socket: Socket) {
  const userId: string | null = socket.data.userId;
  const answerBucket = new TokenBucket(ANSWER_BUCKET_CAPACITY, ANSWER_BUCKET_WINDOW_MS);
  const endBucket = new TokenBucket(END_BUCKET_CAPACITY, END_BUCKET_WINDOW_MS);

  /**
   * interview:join — client joins the room for a session to receive events.
   * Verifies ownership before joining so a client can't listen in on
   * another user's interview by guessing/reusing a session ID.
   */
  socket.on('interview:join', async (data: { sessionId: string }) => {
    try {
      if (!isValidSessionId(data?.sessionId)) {
        emitError(socket, 'INVALID_SESSION_ID', 'A valid session ID is required to join');
        return;
      }
      await interviewService.getSessionDetail(data.sessionId, userId);
      socket.join(data.sessionId);
      logger.info('Client joined session', { sessionId: data.sessionId, socketId: socket.id });
    } catch (error) {
      logger.error('Error joining session', {
        sessionId: data?.sessionId,
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      emitError(socket, 'JOIN_FAILED', 'Failed to join session');
    }
  });

  /**
   * answer:final — processes a submitted answer and emits evaluation result.
   */
  socket.on(
    'answer:final',
    async (data: { sessionId: string; questionId: number; text: string }) => {
      try {
        if (!answerBucket.tryTake()) {
          emitError(socket, 'RATE_LIMITED', 'Too many answers submitted too quickly. Please slow down.');
          return;
        }
        if (!isValidSessionId(data?.sessionId)) {
          emitError(socket, 'INVALID_SESSION_ID', 'A valid session ID is required');
          return;
        }
        if (typeof data.questionId !== 'number' || !Number.isFinite(data.questionId)) {
          emitError(socket, 'INVALID_INPUT', 'questionId must be a valid number');
          return;
        }
        if (!data.text || typeof data.text !== 'string') {
          emitError(socket, 'INVALID_INPUT', 'Answer text is required');
          return;
        }

        const answerText = data.text.trim();
        if (!answerText) {
          emitError(socket, 'INVALID_INPUT', 'Answer text cannot be empty');
          return;
        }
        if (answerText.length > MAX_ANSWER_LENGTH) {
          emitError(
            socket,
            'INPUT_TOO_LONG',
            `Answer text exceeds maximum length of ${MAX_ANSWER_LENGTH} characters`
          );
          return;
        }

        logger.info('Received final answer', {
          sessionId: data.sessionId,
          questionId: data.questionId,
          socketId: socket.id,
        });
        // Answer is persisted synchronously here so the client can move on
        // immediately; its AI evaluation now runs in the background (see
        // interviewService.submitAnswer/_evaluateAndPersist) and arrives
        // later via the global 'answer:evaluated' forward registered once
        // in server.ts (interviewEvents -> io.to(sessionId)). Do NOT wait
        // for it here — that was the exact blocking behavior being fixed.
        await interviewService.submitAnswer(data.sessionId, userId, data.questionId, answerText);

        socket.emit('answer:received', {
          questionId: data.questionId,
        });
      } catch (error: unknown) {
        const errMsg =
          error instanceof Error ? error.message : 'Failed to process answer. Please try again.';
        logger.error('Error processing answer', {
          sessionId: data?.sessionId,
          questionId: data?.questionId,
          socketId: socket.id,
          error: errMsg,
        });
        emitError(socket, 'EVALUATION_FAILED', errMsg);
      }
    }
  );

  /**
   * interview:end — finalises the session and emits the complete summary.
   */
  socket.on('interview:end', async (data: { sessionId: string }) => {
    try {
      if (!endBucket.tryTake()) {
        emitError(socket, 'RATE_LIMITED', 'Too many requests too quickly. Please slow down.');
        return;
      }
      if (!isValidSessionId(data?.sessionId)) {
        emitError(socket, 'INVALID_SESSION_ID', 'A valid session ID is required');
        return;
      }

      logger.info('Ending session', { sessionId: data.sessionId, socketId: socket.id });
      const { session: finalSession, providerSwitch } = await interviewService.endSession(
        data.sessionId,
        userId
      );

      socket.emit('interview:complete', {
        summary: finalSession?.finalEvaluation ?? {
          overallScore: 0,
          overallFeedback: 'Unable to generate evaluation.',
        },
        answers: finalSession?.answers ?? [],
        evaluations: finalSession?.evaluations ?? [],
        ...(providerSwitch ? { providerSwitch } : {}),
      });
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : 'Failed to complete interview. Please try again.';
      logger.error('Error ending session', {
        sessionId: data?.sessionId,
        socketId: socket.id,
        error: errMsg,
      });
      emitError(socket, 'END_FAILED', errMsg);
    }
  });
}
