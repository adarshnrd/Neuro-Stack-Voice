// AuthManager — talks to /api/auth/*. The session itself lives in an
// httpOnly cookie set by the server (see src/http/controllers/auth.controller.ts),
// so this file never touches the token directly; it only tracks the
// currently-known user object in memory for the UI to read.
export class AuthManager {
  constructor() {
    this.user = null;
  }

  /** Returns the current user ({id, email}) or null, checking the server session. */
  async fetchCurrentUser() {
    try {
      const resp = await fetch('/api/auth/me');
      if (!resp.ok) {
        this.user = null;
        return null;
      }
      const data = await resp.json();
      this.user = data.success ? data.data.user : null;
      return this.user;
    } catch (err) {
      console.warn('[Auth] Failed to check session:', err);
      this.user = null;
      return null;
    }
  }

  async register(email, password) {
    const resp = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Registration failed');
    }
    this.user = data.data.user;
    return this.user;
  }

  async login(email, password) {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Login failed');
    }
    this.user = data.data.user;
    return this.user;
  }

  async logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      this.user = null;
    }
  }

  isAuthenticated() {
    return !!this.user;
  }
}
