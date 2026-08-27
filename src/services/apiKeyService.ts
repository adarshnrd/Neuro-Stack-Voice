// DEPRECATED — superseded by src/services/apiKey.service.ts as part of the Phase 2 restructure
// (renamed to the project's `<domain>.<layer>.ts` convention, and rewired to per-user storage
// as part of Phase 5 — see docs/project-improvement/phase-05-security.md finding 3).
//
// This file is intentionally emptied (not deleted) because the automated
// tooling used to carry out this restructure could only edit file content
// on disk, not delete/rename files. It is excluded from the TypeScript
// build via tsconfig.json ("exclude") and from linting via .eslintrc.cjs
// ("ignorePatterns"), so it has no effect on compilation, linting, or
// runtime. It is safe — and recommended — to delete this file once you've
// verified the new structure works:
//
//   git rm "src/services/apiKeyService.ts"
