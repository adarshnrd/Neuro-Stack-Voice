/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.eslint.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'public/',
    'coverage/',
    '*.js',
    '*.cjs',
    // Deprecated stub files kept only because they can't be deleted by
    // automated tooling — see their file headers. Not worth linting.
    'src/api/**',
    'src/controllers/**',
    'src/interfaces/**',
    'src/middleware/**',
    'src/routes/**',
    'src/config/index.ts',
    'src/config/databaseConfig.ts',
    'src/repositories/interviewRepository.ts',
    'src/services/interviewService.ts',
    'src/services/apiKeyService.ts',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    'no-console': 'off',
    eqeqeq: ['error', 'always'],
  },
};
