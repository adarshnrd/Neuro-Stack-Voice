export class SocketManager {
  constructor() {
    this.listeners = {};
    this.connected = false;
    this._pendingSessionId = null;

    // Guard: socket.io script may not have loaded yet (cold start, network error, etc.)
    if (typeof window.io !== 'function') {
      console.warn('[Socket] socket.io (window.io) is not available — real-time features disabled until page reload.');
      this.socket = null;
      return;
    }

    // autoConnect: false — the server now requires a valid session cookie
    // at handshake time (see src/sockets/auth.ts), so connecting before the
    // user is authenticated would just fail and retry pointlessly. Call
    // connect() once login/session-check succeeds instead.
    this.socket = window.io({
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    this.setupSocket();
  }

  /** Opens the connection. Safe to call once the auth cookie is set. */
  connect() {
    if (this.socket && !this.socket.connected) this.socket.connect();
  }

  /** Closes the connection (e.g. on logout) so a stale session isn't reused. */
  disconnect() {
    if (this.socket) this.socket.disconnect();
    this.connected = false;
    this._pendingSessionId = null;
  }

  setupSocket() {
    if (!this.socket) return;
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
    if (this.socket) this.socket.on(event, callback);
  }

  emit(event, data) {
    if (this.socket) this.socket.emit(event, data);
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
