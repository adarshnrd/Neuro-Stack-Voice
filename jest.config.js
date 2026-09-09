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
  // [P6-03] docs/audit/02-BACKLOG-P4-P10.md: coverage is collected above but
  // was never enforced, so it could silently fall to zero on a new file with
  // no signal. The audit's own fix says to set the threshold "at whatever
  // the recorded baseline actually is — a ratchet, not an aspiration," which
  // requires an actual `npm test -- --coverage` run to read real numbers
  // from; that could not be done from this sandbox (npm registry access is
  // blocked here — see docs/audit/06-DEFERRED-DECISIONS.md / R-00). Guessing
  // a number here would risk the opposite of the intent: too high and it
  // breaks CI immediately on the current, unmeasured baseline; too low and
  // it's a no-op that looks like a real gate. Uncomment and fill in with the
  // real percentages once you've run the command below locally:
  //
  //   npm test -- --coverage
  //
  // coverageThreshold: {
  //   global: {
  //     branches: <observed>,
  //     functions: <observed>,
  //     lines: <observed>,
  //     statements: <observed>,
  //   },
  // },
};
