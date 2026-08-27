import jwt from 'jsonwebtoken';
import config from '../config/config';
import { AuthUser, JwtPayload } from '../types';

/**
 * Signs a JWT for the given user. The token is stateless (no server-side
 * session store, no refresh-token rotation) — it is valid for its full TTL
 * regardless of logout. Logout only clears the client's cookie. This is a
 * deliberate tradeoff for a small deployment; see phase-05 docs for the
 * revocation-list alternative if that's ever needed.
 */
export function signToken(user: AuthUser): string {
  const payload: Pick<JwtPayload, 'sub' | 'email'> = { sub: user.id, email: user.email };
  return jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.auth.tokenTtlSeconds,
  });
}

/** Verifies and decodes a JWT. Throws if invalid or expired. */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, config.auth.jwtSecret) as JwtPayload;
}
