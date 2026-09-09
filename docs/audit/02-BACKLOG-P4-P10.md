# Backlog — P4 to P10 (Recommended and Informational)

P4–P6 are real improvements with a clear payoff. P7–P10 are observations; **no
action is implied** — they are recorded so a future reader does not have to
rediscover them.

Nothing in this file justifies widening the diff of a P1/P2 fix. Bundle an item
only if it is genuinely free inside a change already touching that exact code.

---

## P4–P6 — Recommended (12 items)

### `[P4-01]` The in-memory store hands out live references to its own objects
- **Location:** `src/repositories/interview.repository.ts` — `applyToMemory()`
  (`Object.assign(session, updates)`) and `getSession()` (returns the stored
  object directly).
- **Evidence:** Confirmed.
- **What / why:** Callers receive the same object the store holds. Any incidental
  mutation by a service is written back with no repository call, and two callers
  holding "different" snapshots actually share one object — so the
  read-old-snapshot semantics the DB path has, and the code is written against,
  silently do not apply on the fallback path. That divergence is exactly the kind
  of thing that makes a concurrency bug reproduce on one path and not the other.
- **Fix:** Deep-copy on read and on write in the memory path, so both paths obey
  the same value semantics. Do this **before** the P1-02 characterization tests,
  or those tests will encode the aliasing as intended behavior.

### `[P4-02]` Interview length is unbounded
- **Location:** `src/services/interview.service.ts` `extendSession()`;
  `src/http/controllers/interview.controller.ts` caps `additionalCount` at 20 and
  `questionsCount` at 50, but nothing caps total questions or extension count.
- **Evidence:** Confirmed. `extensionCount` is incremented and stored but never
  checked.
- **What / why:** Repeated extends grow `questions`, `questionHistory` and
  `interviewContext` without limit. All three are serialized into the
  question-generation prompt on the next extend, so prompt size grows
  quadratically with extends — the exact token-budget failure mode this project
  already fixed once for the final evaluation (see
  `docs/project-improvement/RICH_EVALUATION_SCALE_PLAN.md` §2).
- **Fix:** Cap total questions per session and cap `extensionCount`; truncate
  `previousQuestions`/`interviewContext` fed into the prompt to a recent window.

### `[P4-03]` The `endSession` wait timer is never cleared
- **Location:** `src/services/interview.service.ts` — `Promise.race([...,
  new Promise(resolve => setTimeout(resolve, config.app.endSessionEvaluationWaitMs))])`.
- **Evidence:** Confirmed. Compare `createTimeoutSignal` in
  `src/services/ai/baseService.ts`, which deliberately `unref()`s its timer for
  precisely this reason — the convention exists in the project and is not applied
  here.
- **What / why:** When the evaluations win the race, a 15-second timer stays
  armed and keeps the event loop alive, delaying graceful shutdown by up to that
  long per in-flight end-session.
- **Fix:** `clearTimeout` in a `finally`, or `.unref()` to match the existing
  convention.

### `[P4-04]` `validateQuestions` mutates its input and accepts any array length
- **Location:** `src/services/ai/baseService.ts` — `validateQuestions()`.
- **Evidence:** Confirmed. Assigns `q.id`, `q.difficulty`, `q.topic`,
  `q.expectedKeywords` onto the parsed object, then casts.
- **What / why:** A "validate" function that rewrites its argument is a
  surprise at the call site, and there is no upper bound — a model that returns
  500 questions produces a 500-question interview and a correspondingly large
  row. Every other validator in this file is pure.
- **Fix:** Return a new normalized array; reject a length far above the requested
  `count`.

### `[P4-05]` The fallback list paths return a different shape than the database paths
- **Location:** `src/repositories/interview.repository.ts` —
  `listCompletedFromMemory()` / `listCompletedByEmailFromMemory()` return whole
  `SessionData` objects; the Prisma paths `select` eight fields.
- **Evidence:** Confirmed.
- **What / why:** During a fallback window the history endpoints return every
  question, answer, evaluation and the full job description for each listed
  session — far more data than the endpoint's contract, over a path nobody tests.
  It is a quiet over-disclosure that only appears when the database is down.
- **Fix:** Project the same eight fields in the memory paths.

### `[P5-01]` Two logging systems in one codebase
- **Location:** `logger` is used in `services/`, `http/middleware/`,
  `services/ai/`. Raw `console.*` is used in
  `repositories/interview.repository.ts` (6 sites), `sockets/interview.socket.ts`
  (6), `config/database.ts` (3), `config/config.ts` (2),
  `services/apiKey.service.ts` (1).
- **Evidence:** Confirmed — 18 `console.*` call sites outside `logger.ts` itself.
- **What / why:** In production `logger` emits one JSON object per line with a
  level, timestamp and correlating fields; `console.*` emits unstructured text
  with none. Every message from the persistence and socket layers — including all
  six database-fallback warnings, which are the ones that matter most during an
  incident — is invisible to a log aggregator and carries no `requestId` or
  `sessionId`. This is a **pattern**, not 18 separate nits: the fix is one
  convention applied consistently.
- **Fix:** Route these through `logger` with the fields already available at each
  site. `config.ts`'s pre-validation `console.error` is a reasonable exception
  (it runs before config is trusted) — keep it and note why.

### `[P5-02]` Fifteen dead stub files, with the exclusion list duplicated in five places
- **Location:** `src/api/**`, `src/controllers/**`, `src/interfaces/**`,
  `src/middleware/**`, `src/routes/**`, `src/config/index.{ts,js}`,
  `src/config/databaseConfig.ts`, `src/repositories/interviewRepository.ts`,
  `src/services/interviewService.ts`, `src/services/apiKeyService.ts`,
  plus root `server.js`, `recover.sh`, `delete_stubs.ts`.
- **Evidence:** Confirmed. Each carries a header explaining it was emptied rather
  than deleted because the tooling that restructured the project could not delete
  files, and each names the `git rm` that finishes the job.
- **What / why:** The same exclusion list is now maintained by hand in
  `tsconfig.json`, `tsconfig.eslint.json`, `.eslintrc.cjs`, `jest.config.js` and
  `.dockerignore`. Five lists that must move together is a standing trap, and a
  newcomer reading `src/` sees two of everything. This is the incomplete-deletion
  pattern.
- **Fix:** `git rm` the files and their empty directories, then delete all five
  exclusion lists in the same commit. Mechanical, zero runtime effect (they are
  already excluded from the build), and it removes five files' worth of config.
  Confirm nothing imports them first — a grep, not a guess.

### `[P5-03]` `as unknown as` casts hide a real type mismatch on `createdAt`
- **Location:** `src/repositories/interview.repository.ts` — 12 casts, including
  four `as unknown as SessionData` on Prisma results.
- **Evidence:** Confirmed. `SessionData.createdAt` is typed `string`
  (`src/types/index.ts`); Prisma returns `Date`. `listCompletedFromMemory` calls
  `new Date(s.createdAt)` on it, which works for both — masking the mismatch.
- **What / why:** `strict` is on and `noImplicitAny` is on; these casts are the
  one place the type system has been told to stop checking, and they are hiding a
  genuine lie. Any future code that does `session.createdAt.slice(...)` compiles
  and throws at runtime on the database path.
- **Fix:** Introduce an explicit mapper (`toSessionData(row)`) that converts
  `Date → ISO string` and narrows the `Json` columns once, and drop the casts.
  One function, and it is the natural home for the projection fix in P4-05.

### `[P5-04]` 429 backoff is far shorter than any real provider window, and `Retry-After` is ignored
- **Location:** `src/services/ai/baseService.ts` — `withRetry()`
  (`BACKOFF_BASE_MS = 1000`, `MAX_RETRIES = 2` → 1 s then 2 s);
  `isRetryableError()` treats 429 as retryable.
- **Evidence:** Confirmed. No provider path reads the `Retry-After` header.
- **What / why:** Provider rate limits reset on windows measured in seconds to a
  minute. Retrying a 429 after 1 s then 2 s almost always fails again, burns the
  quota further, and adds 3 s of latency before `runWithProviderChain` moves on.
  Given the config comments about Groq's TPM cap, this path is hit in practice.
- **Fix:** Honour `Retry-After` when present; otherwise treat 429 as
  non-retryable *within* a provider and let the chain move to the next one
  immediately — the chain is the better remedy for a rate limit than a retry is.

### `[P6-01]` Missing composite indexes for the two history queries
- **Location:** `prisma/schema.prisma` — single-column indexes on `status`,
  `createdAt`, `userId`, `historyEmail`. Queries in
  `interview.repository.ts` filter `(status, userId)` and `(status, historyEmail)`
  and order by `createdAt desc` with `take`/`skip`.
- **Evidence:** Confirmed by reading; **not measured** — no performance claim is
  made here, and none should be made without a profile on representative data.
- **Fix:** Consider `@@index([userId, status, createdAt])` and
  `@@index([historyEmail, status, createdAt])`. Measure first: on a small table
  this changes nothing, and an unmeasured index is just maintenance cost.

### `[P6-02]` Network-error detection is string-matching on an error message
- **Location:** `src/services/ai/baseService.ts` — `isRetryableError()`:
  `error instanceof TypeError && error.message.includes('fetch')`.
- **Evidence:** Confirmed.
- **What / why:** This depends on undici's exact message text ("fetch failed").
  A Node or undici change breaks retry-on-network-error silently — retries simply
  stop happening, and nothing fails loudly enough to notice.
- **Fix:** Inspect `error.cause` and its `code` (`ECONNRESET`, `ENOTFOUND`,
  `ETIMEDOUT`, `EAI_AGAIN`, `UND_ERR_*`) rather than the message string.

### `[P6-03]` Coverage is collected but never enforced
- **Location:** `jest.config.js` — `collectCoverageFrom` is configured with a
  thoughtful exclusion list; there is no `coverageThreshold`.
- **Evidence:** Confirmed.
- **What / why:** Coverage can fall to zero on a new file without any signal.
- **Fix:** Add a threshold at whatever the recorded baseline actually is (see
  R-00) — a ratchet, not an aspiration. Pairs naturally with P3-01's CI.

---

## P7–P10 — Informational (5 items)

### `[P7-01]` Three fields are interpolated into the model `<select>` without escaping
`public/js/uiManager.js` `_renderModelSelect()` inserts `m.id`, `m.name` and
`m.description` into `innerHTML` unescaped, while escaping `provider` on the line
above. The values come from the server's own hardcoded list, except
`description`, which is `config.ai.groqModel` / `nvidiaModel` — i.e. the
`GROQ_MODEL` / `NVIDIA_MODEL` **environment variables**. Not a finding: the only
actor who can set those already controls the server. Recorded because the
inconsistency invites someone to later feed user data through this function.
`_escHtml` is right there.

### `[P7-02]` `socketManager.js` documents a rule the server no longer enforces
Its header comment states the server "requires a valid session cookie at
handshake time", citing `src/sockets/auth.ts`. That file now explicitly allows
anonymous handshakes. The `autoConnect: false` behavior it justifies is still
correct for a different reason (`_continueAsGuest` calls `connect()`), so the
code is fine and only the comment is stale — but it is stale in a way that
would lead a reader to the wrong conclusion about the auth model.

### `[P7-03]` `Agent.md` describes a different project than the one in the repo
It prescribes JavaScript examples, an MVC structure, and `body-parser`. The
codebase is strict TypeScript with a routes→controllers→services→repositories
layering, uses `express.json()`, and has conventions
(`AppError`, `validateBody`, `logger`, per-request AI service instances) that the
document never mentions. As the declared-intent artifact at the top of the
context ladder, it currently sends a reader — human or automated — in the wrong
direction. The real conventions are catalogued in `00-AUDIT-OVERVIEW.md` §1 if
someone wants to rewrite it.

### `[P8-01]` Markdown placeholder tokens can collide with literal input
`public/js/markdown.js` swaps code spans and fenced blocks for ` CODE0 ` /
` BLOCK0 ` sentinels before parsing. Text that literally contains ` CODE0 ` is
substituted on the way back — producing `<code>undefined</code>` or duplicating
another span. Not a security issue (everything is HTML-escaped before this runs,
so no tag or attribute can be introduced); purely a rendering oddity in text that
would have to be deliberately crafted. A non-printable sentinel would remove it.

### `[P8-02]` Malformed numeric config silently becomes the default
`src/config/config.ts` `readInt()` returns the fallback when `parseInt` yields
`NaN`. `PORT=three thousand` starts the server on 3000 with no warning;
`GROQ_MAX_COMPLETION_TOKENS=8k` silently reverts to 4096. `validateConfig()` is
otherwise strict and fails fast with a clear message — a `logger.warn` (or an
error) on a malformed value would match that standard.
