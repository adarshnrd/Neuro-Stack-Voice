import { signToken, verifyToken } from '../../src/utils/jwt';

describe('jwt sign/verify', () => {
  const user = { id: 'user-123', email: 'test@example.com' };

  it('round-trips a signed token', () => {
    const token = signToken(user);
    const payload = verifyToken(token);
    expect(payload.sub).toBe(user.id);
    expect(payload.email).toBe(user.email);
  });

  it('rejects a tampered token', () => {
    const token = signToken(user);
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
    expect(() => verifyToken(tampered)).toThrow();
  });

  it('rejects garbage input', () => {
    expect(() => verifyToken('not.a.jwt')).toThrow();
  });
});
