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
 * Socket.IO handshake middleware. Rejects the connection outright if no
 * valid session cookie is present — previously ANY client could connect and
 * join any interview room, submit answers for it, and end it, since the
 * socket layer had zero authorization.
 */
export function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): void {
  const token = readCookie(socket.handshake.headers.cookie, AUTH_COOKIE_NAME);
  if (!token) {
    return next(new Error('Authentication required'));
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
