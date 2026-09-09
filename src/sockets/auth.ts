import { Socket } from 'socket.io';
import { verifyToken } from '../utils/jwt';
import { AUTH_COOKIE_NAME } from '../http/middleware/auth';

/** Minimal cookie-header parser — avoids pulling in a whole cookie library
 *  for a single `name=value` lookup out of `socket.handshake.headers.cookie`. */
function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * Socket.IO handshake middleware.
 *
 * No login is required to use the app (see interview.routes.ts /
 * attachUserIfPresent) — an anonymous visitor's interview sessions are
 * owned by nobody (session.userId = null) and are reachable by anyone
 * holding the session's unguessable UUID, the same trust model
 * interviewService.getOwnedSession already applies to HTTP requests. So a
 * missing cookie here is a legitimate anonymous connection, not an error:
 * socket.data.userId is left null and event handlers pass that straight
 * through to the service layer exactly as an authenticated caller's id
 * would be.
 *
 * A cookie that IS present must still verify — a tampered or expired
 * token is rejected rather than silently downgraded to "anonymous", so a
 * logged-in user's broken session surfaces as an error instead of quietly
 * losing access to their own (non-null-owned) sessions.
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const token = readCookie(socket.handshake.headers.cookie, AUTH_COOKIE_NAME);
  if (!token) {
    socket.data.userId = null;
    socket.data.email = null;
    return next();
  }

  try {
    const payload = verifyToken(token);
    socket.data.userId = payload.sub;
    socket.data.email = payload.email;
    next();
  } catch {
    next(new Error('Invalid or expired session'));
  }
}

export default socketAuthMiddleware;
