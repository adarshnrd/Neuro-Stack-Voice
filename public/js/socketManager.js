export class SocketManager {
  constructor() {
    this.socket = window.io({
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    this.listeners = {};
    this.connected = false;
    this._pendingSessionId = null;

    this.setupSocket();
  }

  setupSocket() {
    this.socket.on('connect', () => {
      console.log('[Socket] Connected to server');
      this.connected = true;

      // Re-join session if we were in one when disconnect happened
      if (this._pendingSessionId) {
        this.joinSession(this._pendingSessionId);
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('[Socket] Disconnected:', reason);
      this.connected = false;
    });

    this.socket.on('reconnect', (attempt) => {
      console.log(`[Socket] Reconnected after ${attempt} attempt(s)`);
      this.connected = true;
    });

    this.socket.on('reconnect_failed', () => {
      console.error('[Socket] Reconnection failed after all attempts');
      this.connected = false;
    });

    this.socket.on('error', (err) => {
      console.error('[Socket] Error:', err);
    });
  }

  /** Whether the socket is currently connected. */
  isConnected() {
    return this.connected;
  }

  on(event, callback) {
    this.socket.on(event, callback);
  }

  emit(event, data) {
    this.socket.emit(event, data);
  }

  joinSession(sessionId) {
    this._pendingSessionId = sessionId;
    this.emit('interview:join', { sessionId });
  }

  sendFinalAnswer(sessionId, questionId, text) {
    this.emit('answer:final', { sessionId, questionId, text });
  }

  endSession(sessionId) {
    this.emit('interview:end', { sessionId });
  }

  /** Clear the pending session (e.g. on restart). */
  clearSession() {
    this._pendingSessionId = null;
  }
}
