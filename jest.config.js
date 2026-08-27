/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/env.setup.ts'],
  clearMocks: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts', // binds a real port — exercised indirectly, not unit-tested
    '!src/api/**',
    '!src/controllers/**',
    '!src/interfaces/**',
    '!src/middleware/**',
    '!src/routes/**',
    '!src/config/index.ts',
    '!src/config/databaseConfig.ts',
    '!src/repositories/interviewRepository.ts',
    '!src/services/interviewService.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  testTimeout: 15000,
};
