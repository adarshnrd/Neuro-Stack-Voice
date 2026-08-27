import bcrypt from 'bcryptjs';
import userRepository from '../repositories/user.repository';
import { signToken } from '../utils/jwt';
import { AppError } from '../utils/appError';
import { AuthUser } from '../types';

const BCRYPT_ROUNDS = 12;

class AuthService {
  async register(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await userRepository.findByEmail(normalizedEmail);
    if (existing) {
      // Deliberately vague — do not confirm which emails are registered.
      throw new AppError('Unable to register with the provided details', 409);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const created = await userRepository.create(normalizedEmail, passwordHash);

    const user: AuthUser = { id: created.id, email: created.email };
    const token = signToken(user);
    return { user, token };
  }

  async login(email: string, password: string): Promise<{ user: AuthUser; token: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const record = await userRepository.findByEmail(normalizedEmail);

    // Always run bcrypt.compare, even on a missing user, against a fixed
    // dummy hash — otherwise a missing-user response returns faster than a
    // wrong-password response, letting an attacker enumerate registered
    // emails by timing.
    const hashToCompare =
      record?.passwordHash ?? '$2a$12$C6UzMDM.H6dfI/f/IKcEeOtcv6R/2ADEQjkX8OT4gVYT0BXQeM2mm';
    const isValid = await bcrypt.compare(password, hashToCompare);

    if (!record || !isValid) {
      throw new AppError('Invalid email or password', 401);
    }

    const user: AuthUser = { id: record.id, email: record.email };
    const token = signToken(user);
    return { user, token };
  }
}

export default new AuthService();
