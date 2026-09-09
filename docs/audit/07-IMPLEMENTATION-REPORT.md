# Implementation Report — P1 through P6 Backlog

**Status: implemented, unverified by execution.** Every item below was written
with maximum care against the exact current codebase — existing patterns,
existing types, existing test conventions — but **none of it has been run**.
This sandbox has no npm registry access (every `npm`/`curl` attempt against
`registry.npmjs.org` returns `Host not in allowlist`) and no shell on the
linked device, only file staging/commit. There is no way to execute
`npm run verify` from here. Treat every claim in this report as "should be
correct on inspection," not "tested and passing," until you've run it
yourself — see **What you need to do** at the bottom.

This picks up from `docs/audit/00-AUDIT-OVERVIEW.md` through
`06-DEFERRED-DECISIONS.md` and implements the backlog in
`01-BACKLOG-P0-P3.md` and `02-BACKLOG-P4-P10.md`, phase-gated, per your
instruction to fix everything in those files starting with blocking
security/correctness items. Nothing was committed to git — every change is
a plain file write, left uncommitted, per your instruction not to commit
anything.

---

## 1. Decisions you made along the way (for the record)

- **Git:** don't commit anything — honored throughout; nothing here is committed.
- **P1-04** (email-history lookup): keep the no-verification design, add a
  visible consent notice, close the leak by scoping
  `listCompletedSessionsByEmail` to `userId: null`.
- **P1-01** (extend-after-completion): never destroy `finalEvaluation` —
  preserve it and mark `overallFeedbackStatus: 'stale'`, reusing the
  existing refresh-banner mechanism.
- **P3-03** (guest API key validation): scoped *only* to moving
  `POST /api/settings/api-key/validate` onto `attachUserIfPresent` — zero
  change to `resolveUserApiKey()`'s precedence (a user's own key always wins
  when supplied).
- **P3-04** (single-instance constraint): documented only, per the audit's
  own "Recommended: A now."

---

## 2. Everything implemented

### P1 — Blocking (all done)
- **P1-01** `extendSession` preserves `finalEvaluation` on a completed
  session, marks it `stale` instead of nulling it. (`interview.service.ts`)
- **P1-02** Concurrent writes to the same session now serialize through
  `withSessionLock` — `recordAnswer`, `recordEvaluation`, and the new
  general-purpose `updateSessionWith` atomic primitive all go through it.
  (`interview.repository.ts`)
- **P1-03** `recordAnswer` returns a discriminated
  `not_found | duplicate | recorded` result instead of ever silently
  reporting success on a write that persisted nowhere; `submitAnswer`
  branches on it (503 / 409 respectively). (`interview.repository.ts`,
  `interview.service.ts`)
- **P1-04** Consent notices added to both the setup and history-lookup
  panels (`public/index.html`); `listCompletedSessionsByEmail` scoped to
  `userId: null` so a claimed session stops surfacing via the unverified
  email lookup.

### P2 — Blocking (all done)
- **P2-01** Inline `onclick=` handlers removed from `uiManager.js`'s
  templates; replaced with delegated listeners (`_bindDelegatedListeners`,
  plus a new one in `app.js` for history-card clicks) — fixes the CSP break.
- **P2-02** `model` field allowlisted at the validation boundary
  (`AI_MODEL_IDS`, single-sourced from the same list `getModels` advertises).
- **P2-03** DB circuit breaker (`isDatabaseUnreachable`) narrowed to true
  connection-level Prisma errors only — an ordinary "no row matched" no
  longer trips the breaker for every other concurrent user.
- **P2-04** Provider error responses no longer echo the upstream body to
  clients — new shared `handleProviderErrorResponse` helper logs the full
  body server-side, returns a generic message client-side, across
  Groq/NVIDIA/Gemini.
- **P2-05** Duplicate-answer race closed — the uniqueness check now happens
  *inside* `withSessionLock`, right next to the write.

### P3 — Required (all done)
- **P3-01** `.github/workflows/ci.yml` added — `npm ci` → `prisma generate`
  → `npm run verify`, Node 20, on push to `main` and on every PR, against a
  throwaway Postgres service container (matching what README.md already
  claimed existed). **This one file could not be written to your device —
  see §4.**
- **P3-02** Characterization tests added — see §3, this was also where a
  real, pre-existing test-infrastructure bug was found and fixed.
- **P3-03** `/api/settings/api-key/validate` moved to `attachUserIfPresent`
  so anonymous visitors get a real validation result instead of a
  misleading "not authenticated" failure; key precedence logic untouched.
- **P3-04** Single-instance deployment constraint documented in a new
  README §7, naming the three process-local state pieces and the failure
  mode under 2+ replicas.
- **P3-05** `techStack` allowlisted the same way `model` was (`TECH_STACKS`);
  structural prompt-injection defense (`fenceUntrustedInput`) applied to
  `jobDescription`, `question`, and `answer` in `promptBuilder.ts` — clearly
  delimited, explicit "this is data, not instructions" framing, as the
  primary control (the existing denylist regex stays as defense-in-depth).
- **P3-06** `Session.user` relation changed `SetNull` → `Cascade` in
  `schema.prisma`, with a hand-written migration (see §4 — no network
  access to run `prisma migrate dev` from here, so verify this one
  yourself).
- **P3-07** `docker-compose.yml`'s hardcoded Postgres password replaced with
  a required `POSTGRES_PASSWORD` (no default), and the Postgres port bound
  to loopback only.
- **P3-08** `prisma migrate deploy` wired into the Docker deploy path via a
  new `migrate` build stage/compose service that runs once, to completion,
  before `app` starts — no `package.json`/lockfile edits needed (see §5 for
  why that path was deliberately avoided).
- **P3-09** `_maybeRefreshAggregateScore` rewritten atop the same
  `updateSessionWith` atomic primitive as P1-02/P1-03.
- **P3-10** Per-socket token-bucket rate limiting added for `answer:final`
  and `interview:end` — hand-rolled (no new dependency), scoped per-socket
  rather than globally.

### P4–P6 — Recommended (all done or explicitly deferred with reasoning)
- **P4-01** In-memory fallback store now deep-copies on read and write
  (`cloneSession`) so it has the same value semantics as the database path.
- **P4-02** Interview length bounded — `MAX_TOTAL_QUESTIONS = 150`,
  `MAX_EXTENSIONS = 10` (both now exported constants), prompt payload fed
  into an extend windowed to the last 30 entries while the full history
  still accumulates in the stored record.
- **P4-03** `endSession`'s bounded-wait timer is now cleared (`clearTimeout`
  in a `finally`) instead of leaking and delaying shutdown.
- **P4-04** `validateQuestions` rewritten pure (returns a new array, never
  mutates its input) and now rejects a response wildly larger than what was
  requested.
- **P4-05** Memory-fallback history-list paths project the same 8 fields as
  the database paths (`projectHistoryFields`, mirrored by the new
  `toHistorySummary` mapper on the DB side).
- **P5-01** All `console.*` call sites outside `logger.ts` converted to the
  structured `logger` — except `config.ts`'s pre-validation
  `console.error`, which is now explicitly commented as a deliberate
  exception (it runs before config, and therefore the logger's own
  transport target, can be trusted).
- **P5-02** **Not executed — see §4.** Confirmed safe (nothing imports any
  of the 16 dead stub files) but this session has no file-deletion
  capability on your device.
- **P5-03** New `toSessionData`/`toHistorySummary` mappers in
  `interview.repository.ts` replace 11 scattered `as unknown as ...` casts
  with one narrowing point each — and actually fix the masked bug (Prisma's
  `createdAt: Date` is now genuinely converted to the `string` the app's
  types promise, not just cast past the type checker).
- **P5-04** 429s now honor `Retry-After` when the provider sends one;
  otherwise treated as non-retryable within a provider so the chain moves
  on immediately instead of burning a fixed 1s/2s backoff that almost never
  helps.
- **P6-01** **Deliberately not implemented** — the audit's own fix says
  "measure first," and no profiling was possible from here. Documented only.
- **P6-02** Network-error detection rewritten to inspect `error.code` /
  `error.cause.code` against a real code set (`ECONNRESET`, `UND_ERR_*`,
  etc.) instead of matching on undici's exact error message text.
- **P6-03** **Scaffolded, not enforced.** `jest.config.js` has a commented
  `coverageThreshold` block with exact instructions — setting a real number
  requires an actual `npm test -- --coverage` run this sandbox can't do,
  and guessing one risks either breaking CI immediately or being a no-op
  that looks like a real gate. See §4.

P7–P10 are the audit's own "informational, no action implied" band and were
left untouched.

---

## 3. A real bug this work found and fixed (not from the audit)

While writing characterization tests for P3-02, I found that
`tests/helpers/mockPrisma.ts` left the `session` model completely
unimplemented — every call to `prisma.session.*` threw a raw
`TypeError: Cannot read properties of undefined`. The intent (per its own
comment) was that this synthetic error would be caught by the repository's
own try/catch and exercise the bounded in-memory fallback path "for free."

That stopped being true the moment P2-03's fix (narrowing
`isDatabaseUnreachable` to genuine connection-level errors) landed: a raw
`TypeError` with no `.code` no longer looks like a database outage, so it
re-throws instead of falling back. Concretely, this would have broken
several existing tests — `socket.test.ts`'s entire join/answer/end flow,
`historyIsolation.test.ts`'s two tests, and `interview.routes.auth.test.ts`'s
404-for-missing-session assertions — turning `POST /api/interviews/start`
into a 500 instead of 201, and "get a nonexistent session" into a 500
instead of 404.

The audit had actually already flagged the *coverage* half of this ("mocks
Prisma such that `session` is undefined... exercises the in-memory fallback
path only, never the real persistence path" — `01-BACKLOG-P0-P3.md`
[P3-02]), but not this specific interaction with P2-03.

**Fixed** by building out a real in-memory `session` model in
`mockPrisma.ts` (`create`/`findUnique`/`update`/`findMany`/`updateMany`,
matching Prisma's actual call shapes), so these tests now exercise the real
persistence path instead of an accidental fallback. New characterization
tests were added on top of that fixed foundation:

- `tests/integration/interview.repository.test.ts` — `createSession`/
  `getSession` round-trip (and that `createdAt` really is a string, pinning
  P5-03); `recordAnswer`'s not_found/duplicate/recorded outcomes; two
  concurrent `recordAnswer` calls for different questions on the same
  session, pinning that `withSessionLock` doesn't drop either write
  (P1-02); `recordEvaluation` replacing rather than duplicating by
  `questionId`; `updateSessionWith`'s no-op-on-`undefined` guard (P3-09);
  `claimAnonymousSessions` only ever taking `userId: null` rows; the
  history-list 8-field projection (P4-05); and — importantly —
  `listCompletedSessionsByEmail` never returning a session after it's been
  claimed (P1-04's leak closure, pinned directly at the repository layer).
- `tests/integration/interview.service.extend.test.ts` — extending a
  completed session preserves `finalEvaluation` and marks it `stale`
  (P1-01's actual regression test, previously missing entirely); extending
  an active session leaves it `null`; the `MAX_EXTENSIONS` and
  `MAX_TOTAL_QUESTIONS` ceilings reject with 400 before any AI call is even
  made (P4-02); and that the additional-question count is correctly capped
  down when only a few slots remain before the ceiling.

I did not attempt full characterization coverage of `interview.service.ts`
beyond `extendSession` — `computeOverallScore`, `buildEvaluationDigest`,
`runWithProviderChain`'s fallback edge cases, and `refreshOverallFeedback`
are still uncovered by a direct test, though `socket.test.ts` and
`historyIsolation.test.ts` now exercise `submitAnswer`, `endSession`, and
the background evaluation lifecycle end-to-end (for real, now that the mock
fix above makes them actually reach the database path instead of 500ing).

---

## 4. What you need to do manually

**1. Run the real thing:**
```bash
npm ci
npx prisma generate
npm run verify   # lint -> typecheck -> test -> build
```
This is the actual pass/fail signal — nothing above is a substitute for it.
If anything fails, it's far more useful to send me the exact output than to
assume any single item above is the cause.

**2. Add the CI workflow file by hand.** `.github/workflows/ci.yml` was
generated and sent to you in this conversation, but your device rejects
remote writes to that specific path ("protected file — cannot be written
via remote tools"), almost certainly a deliberate guard against a remote
session silently altering your CI pipeline. Save the file I sent to
`.github/workflows/ci.yml` yourself.

**3. Verify the hand-written Prisma migration.** I wrote
`prisma/migrations/20260903000000_session_cascade_delete_on_user/migration.sql`
by hand (no network access to run `prisma migrate dev` and let Prisma
generate it) — it changes `Session.userId`'s foreign key from
`ON DELETE SET NULL` to `ON DELETE CASCADE`. Please run
`npx prisma migrate deploy` (or review the SQL directly) to confirm it
applies cleanly against your actual schema history.

**4. P5-02 — delete the 16 dead stub files.** Confirmed via grep that
nothing imports any of them (the one hit — `src/app.ts` importing
`errorHandler` — resolves to the *real* file at
`src/http/middleware/errorHandler.ts`, not the stub). This sandbox has no
file-deletion capability on your device, so this is on you:

```bash
git rm "src/controllers/interviewController.ts"
git rm "src/controllers/apiKeyController.ts"
git rm "src/interfaces/index.ts"
git rm "src/middleware/requestValidator.ts"
git rm "src/middleware/errorHandler.ts"
git rm "src/routes/index.ts"
git rm "src/routes/apiKeyRoutes.ts"
git rm "src/routes/interviewRoutes.ts"
git rm "src/config/index.ts"
git rm "src/config/databaseConfig.ts"
git rm "src/repositories/interviewRepository.ts"
git rm "src/services/interviewService.ts"
git rm "src/services/apiKeyService.ts"
git rm server.js
git rm recover.sh
git rm delete_stubs.ts
rmdir src/controllers src/interfaces src/middleware src/routes
```

Then, **in the same change**, remove the now-dead entries for these paths
from all five places that exclude them: `tsconfig.json`, `tsconfig.eslint.json`,
`.eslintrc.cjs`, `jest.config.js` (`collectCoverageFrom`), and
`.dockerignore`. I deliberately did not touch these five files myself —
removing the exclusions while the stub files still exist would pull them
back into lint/typecheck/build scope and break things; it only works as one
atomic change together with the deletions above.

**5. P6-03 — set a real coverage threshold.** Run `npm test -- --coverage`,
then fill in the commented `coverageThreshold` block at the bottom of
`jest.config.js` with the real observed percentages (branches/functions/
lines/statements) and uncomment it. Guessing a number here would either
break CI immediately (too high) or be a no-op dressed up as a gate (too
low) — see the comment in the file for the exact spot.

---

## 5. One risk deliberately avoided

P3-08 (wiring `prisma migrate deploy` into the Docker deploy path) could
have been done by moving `prisma` from `devDependencies` to `dependencies`
in `package.json` so it survives `npm prune --omit=dev` in the runtime
image. I looked hard at this — `package-lock.json` is `lockfileVersion: 3`,
and `npm ci`'s consistency check requires the root `packages[""].dependencies`
/`devDependencies` to exactly mirror `package.json`, including `prisma`'s
own transitive deps (`@prisma/debug`, `@prisma/engines`, etc.) each carrying
their own `devOptional` flags. Hand-editing that without being able to run
`npm ci` to verify no mismatch felt too risky for a file `npm ci` depends on
completely. Instead, I added a separate `migrate` Dockerfile stage that
branches off the already-un-pruned `deps` stage — zero `package.json`/
lockfile changes, same result.

---

## 6. File manifest

All files below were pushed into this conversation and written to
`/home/mindpath/Neuro_stack_voice` on your linked device, except
`.github/workflows/ci.yml` (§4, item 2):

```
src/repositories/interview.repository.ts
src/services/interview.service.ts
src/utils/appError.ts
src/services/ai/baseService.ts
src/services/ai/groqService.ts
src/services/ai/nvidiaService.ts
src/services/ai/geminiService.ts
src/http/controllers/interview.controller.ts
src/http/routes/interview.routes.ts
src/http/routes/apiKey.routes.ts
src/utils/promptBuilder.ts
public/index.html
public/js/uiManager.js
public/js/app.js
prisma/schema.prisma
prisma/migrations/20260903000000_session_cascade_delete_on_user/migration.sql
prisma/migrations/migration_lock.toml
docker-compose.yml
Dockerfile
.env.example
README.md
src/sockets/interview.socket.ts
src/config/database.ts
src/config/config.ts
src/services/apiKey.service.ts
jest.config.js
tests/helpers/mockPrisma.ts
tests/integration/auth.test.ts
tests/integration/interview.repository.test.ts   (new)
tests/integration/interview.service.extend.test.ts   (new)
.github/workflows/ci.yml   (new — sent to you, not written to disk; see §4)
```

Nothing was committed to git. Nothing here has been executed. Please run
`npm run verify` and let me know what it says.
