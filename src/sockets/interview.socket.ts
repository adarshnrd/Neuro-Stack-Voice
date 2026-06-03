import { Server, Socket } from 'socket.io';
import interviewService from '../services/interviewService';
import { AppError } from '../utils/appError';

/** Basic UUID v4 shape check to reject obviously malformed session IDs. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum allowed answer text length (chars). */
const MAX_ANSWER_LENGTH = 5000;

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

/** Emits a structured error event back to the client. */
function emitError(socket: Socket, code: string, message: string): void {
  socket.emit('error', { code, message });
}

export default function socketHandler(io: Server, socket: Socket) {

  /**
   * interview:join — client joins the room for a session to receive events.
   */
  socket.on('interview:join', async (data: { sessionId: string }) => {
    try {
      if (!isValidSessionId(data?.sessionId)) {
        emitError(socket, 'INVALID_SESSION_ID', 'A valid session ID is required to join');
        return;
      }
      socket.join(data.sessionId);
      console.log(`[Socket] Client joined session: ${data.sessionId}`);
    } catch (error) {
      console.error('[Socket] Error joining session:', error);
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
        // ── Input validation ──
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

        // Trim and enforce length limit
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

        console.log(`[Socket] Received final answer for Q${data.questionId} in session ${data.sessionId}`);
        const result = await interviewService.processAnswer(
          data.sessionId,
          data.questionId,
          answerText
        );

        socket.emit('answer:evaluated', {
          questionId: data.questionId,
          evaluation: result.evaluation,
        });
      } catch (error: unknown) {
        const errMsg =
          error instanceof Error ? error.message : 'Failed to process answer. Please try again.';
        console.error('[Socket] Error processing answer:', error);
        emitError(socket, 'EVALUATION_FAILED', errMsg);
      }
    }
  );

  /**
   * interview:end — finalises the session and emits the complete summary.
   */
  socket.on('interview:end', async (data: { sessionId: string }) => {
    try {
      if (!isValidSessionId(data?.sessionId)) {
        emitError(socket, 'INVALID_SESSION_ID', 'A valid session ID is required');
        return;
      }

      console.log(`[Socket] Ending session: ${data.sessionId}`);
      const finalResult = await interviewService.endSession(data.sessionId);

      socket.emit('interview:complete', {
        summary: finalResult?.finalEvaluation ?? {
          overallScore: 0,
          overallFeedback: 'Unable to generate evaluation.',
        },
      });
    } catch (error: unknown) {
      const errMsg =
        error instanceof Error ? error.message : 'Failed to complete interview. Please try again.';
      console.error('[Socket] Error ending session:', error);
      emitError(socket, 'END_FAILED', errMsg);
    }
  });
}
