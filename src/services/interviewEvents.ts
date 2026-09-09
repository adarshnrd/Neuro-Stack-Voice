import { EventEmitter } from 'node:events';
import { EvaluationData, ProviderSwitchNotice } from '../types';

/**
 * Shared event bus between interviewService and the Socket.IO layer.
 *
 * Why this exists: per-question evaluation now runs in the background
 * (fire-and-forget from the request that submitted the answer — see
 * interview.service.ts's submitAnswer/_evaluateAndPersist), so by the time
 * an evaluation actually finishes, the socket handler that originally
 * received the answer has already returned. There's no request-scoped
 * `socket` left to emit on. interviewService doesn't import Socket.IO
 * (keeps it transport-agnostic and testable), so it emits here instead;
 * server.ts subscribes ONCE at startup and forwards to the right session's
 * room via `io.to(sessionId)`. A single global subscription (not one per
 * connection) is important — see server.ts's comment at the subscription
 * site.
 */
export interface AnswerEvaluatedEvent {
  sessionId: string;
  questionId: number;
  evaluation: EvaluationData;
}

export interface ProviderSwitchEvent extends ProviderSwitchNotice {
  sessionId: string;
}

class InterviewEvents extends EventEmitter {
  emitAnswerEvaluated(payload: AnswerEvaluatedEvent): void {
    this.emit('answer:evaluated', payload);
  }

  onAnswerEvaluated(handler: (payload: AnswerEvaluatedEvent) => void): void {
    this.on('answer:evaluated', handler);
  }

  emitProviderSwitch(payload: ProviderSwitchEvent): void {
    this.emit('provider:switch', payload);
  }

  onProviderSwitch(handler: (payload: ProviderSwitchEvent) => void): void {
    this.on('provider:switch', handler);
  }
}

export default new InterviewEvents();
