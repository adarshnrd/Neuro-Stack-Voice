// Runs before ANY test file's imports — see jest.config.js `setupFiles`.
// Populates the environment variables src/config/config.ts reads at import
// time, so tests never depend on a real .env file or real secrets.
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.ENCRYPTION_SECRET = 'test-encryption-secret-please-ignore-32chars';
process.env.JWT_SECRET = 'test-jwt-secret-please-ignore-32-characters';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
process.env.COOKIE_SECURE = 'false';
