import { Request, Response, NextFunction } from 'express';
import authService from '../../services/auth.service';
import userRepository from '../../repositories/user.repository';
import { AppError } from '../../utils/appError';
import { AUTH_COOKIE_NAME } from '../middleware/auth';
import config from '../../config/config';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.auth.cookieSecure,
  sameSite: 'lax' as const,
  maxAge: config.auth.tokenTtlSeconds * 1000,
  path: '/',
};

class AuthController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const { user, token } = await authService.register(email, password);
      res.cookie(AUTH_COOKIE_NAME, token, COOKIE_OPTIONS);
      res.status(201).json({ success: true, data: { user } });
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const { user, token } = await authService.login(email, password);
      res.cookie(AUTH_COOKIE_NAME, token, COOKIE_OPTIONS);
      res.json({ success: true, data: { user } });
    } catch (error) {
      next(error);
    }
  }

  logout(_req: Request, res: Response) {
    res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
    res.json({ success: true, message: 'Logged out' });
  }

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401);
      }
      // Look the user up rather than trusting the JWT payload verbatim —
      // catches the case where the account was deleted after the token was
      // issued (tokens are stateless with no revocation list; see
      // src/utils/jwt.ts). Cheap to do here since /me is called far less
      // often than every protected request.
      const current = await userRepository.findById(req.user.id);
      if (!current) {
        throw new AppError('Account no longer exists', 401);
      }
      res.json({ success: true, data: { user: current } });
    } catch (error) {
      next(error);
    }
  }
}

export default new AuthController();
