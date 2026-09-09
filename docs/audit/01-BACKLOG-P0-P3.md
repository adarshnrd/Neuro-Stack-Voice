# Backlog — P0 to P3 (Blocking and Required)

Every entry states **where · what · why it matters · impact · fix**.
Evidence labels: **Confirmed** (read the code) · **Inferred** (pattern-based, with
the check that would confirm) · **Assumed** (with what changes if wrong).
No blocking severity is assigned to a speculative finding.

---

## P0 — Blocking (0 items)

No P0 was found **within the scope listed in `00-AUDIT-OVERVIEW.md` §2**.

This is not a claim that none exists. Two P0-capable questions are unresolved
because the checks require access this pass did not have:

- Git history was not inspected — a credential committed and later gitignored
  would be a P0 (`W-1`).
- `npm audit` could not run — a known-exploitable transitive dependency would be
  a P0 (`W-2`).

Run both before treating "no P0" as settled.

---

## P1 — Blocking (4 items)

### `[P1-01]` Extending a completed interview permanently destroys its final evaluation

- **Source:** review (change-safety lens: data loss)
- **Location:** `src/services/interview.service.ts` — `extendSession()`, the
  `interviewRepository.updateSession` call (`finalEvaluation: null`);
  reachable via `POST /api/interviews/:sessionId/extend`
  (`src/http/routes/interview.routes.ts`).
- **Evidence:** **Confirmed.** `extendSession` has no `session.status` guard. It
  writes `status: 'active'` and `finalEvaluation: null` unconditionally.
  `updateSession` copies any field that is `!== undefined`, so `null` is written
  through to the column, not skipped.
- **What:** A session that is already `completed` — carrying `overallScore`,
  `overallFeedback`, `evaluationsCompleted/Total` and `overallFeedbackStatus` —
  is reopened and its entire `finalEvaluation` object is overwritten with `null`.
  There is no copy anywhere. Per-question `evaluations` survive; the synthesized
  report does not.
- **Why it matters:** The final report is the product. Generating it costs a full
  AI round-trip against a digest of the whole interview
  (`buildEvaluationDigest` → `evaluateInterview`). Once nulled it cannot be
  recovered from the row: `refreshOverallFeedback` explicitly refuses to run on a
  session whose `status !== 'completed'`, and `extendSession` has just set it to
  `'active'`. The user's only path back is answering the newly added questions and
  ending the session again — regenerating a *different* report, and only if every
  provider is up.
- **Impact:** Any user who finishes an interview, reads their score, and then asks
  for more questions. Silent — the API returns `success: true`. The severity floor
  for "possible data loss or corruption" is P1 and this is a certainty, not a
  possibility.
- **Fix:** Decide the intended semantics first, then implement one of:
  (a) reject `extend` on a `completed` session with a 400, matching how
  `refreshOverallFeedback` already guards its own precondition — smallest change,
  no schema impact, but it *is* a behavior change for anyone relying on
  extend-after-completion (surface it as such); or
  (b) preserve the report: leave `finalEvaluation` untouched on extend and mark it
  `overallFeedbackStatus: 'stale'`, reusing the exact mechanism
  `_maybeRefreshAggregateScore` already uses for late-landing evaluations, so the
  UI's existing "refresh overall feedback" banner covers it with no client change.
  **(b) preserves observable behavior and is the recommended path.**
  Either way: `answeredCount` must also be reconciled — it is left stale today.

---

### `[P1-02]` Concurrent evaluation writes silently overwrite each other

- **Source:** review (concurrency lens) + audit (change safety)
- **Location:** `src/repositories/interview.repository.ts` — `recordEvaluation()`
  (`getSession` → rebuild array → `updateSession`); driven by
  `src/services/interview.service.ts` `_evaluateAndPersist()`, which is invoked
  fire-and-forget from `submitAnswer()`.
- **Evidence:** **Confirmed.** `recordEvaluation` reads the whole session, filters
  the `evaluations` array by `questionId`, appends, and writes the entire array
  back via `prisma.session.update`. There is no transaction, no `WHERE` guard on a
  version/`updatedAt` column, and no application-level lock. `submitAnswer`
  deliberately does not await `_evaluateAndPersist` (documented as the fix for
  blocking progression), so two evaluations for two different questions overlap by
  design.
- **What:** Classic lost update on a JSON column. Timeline for questions 1 and 2
  answered a few seconds apart:
  ```
  eval(Q1) reads evaluations = [Q1:processing]
  eval(Q2) reads evaluations = [Q1:processing]          <- same snapshot
  eval(Q1) writes            = [Q1:completed]
  eval(Q2) writes            = [Q1:processing, Q2:completed]   <- Q1 result gone
  ```
  Each `_evaluateAndPersist` performs **two** such writes (the `processing`
  placeholder, then the result), so the window is wide and hit twice per answer.
- **Why it matters:** A dropped `completed` entry has three downstream effects,
  all silent: (1) `computeOverallScore` excludes it from the denominator, so the
  overall score is computed from fewer questions than were actually scored;
  (2) `endSession`'s `isStillInFlight` sees no entry, waits, then writes a
  `status: 'failed'` placeholder — the user is told their answer "wasn't scored in
  time" when it was in fact scored and then overwritten; (3) the question is
  reported to the user as unscored in the breakdown UI. The AI spend for that
  answer is paid and discarded.
- **Impact:** Every user who answers questions faster than the AI scores them —
  i.e. the normal case, since decoupling scoring from progression is the whole
  point of the current design. Frequency rises with faster answering and slower
  providers. Data-loss floor: P1.
- **Fix:** Make the write atomic with respect to other writers on the same
  session. In order of preference given the existing code:
  1. Wrap read-and-write in `prisma.$transaction` **and** add a conditional
     update (`where: { id, updatedAt: <value read> }`), retrying on zero rows
     affected. `Session.updatedAt` already exists with `@updatedAt`, so this needs
     no migration.
  2. If (1) proves awkward against the in-memory fallback path, add a per-session
     promise-chain mutex in the repository so writes to one session id serialize
     within the process — cheaper, but only correct at one instance (see P3-04).
  Do not "fix" this by re-awaiting evaluation inside `submitAnswer`; that reverts
  the deliberate decoupling and is a behavior regression, not a fix.
  **This fix requires the characterization tests in `R-01` to land first.**

---

### `[P1-03]` A write that persists nowhere is reported to the user as success

- **Source:** review (failure-path lens)
- **Location:** `src/repositories/interview.repository.ts` — `applyToMemory()`
  returns `undefined` when the session id is absent from `memoryStore`;
  called from `updateSession()`'s `isDbLikelyDown()` branch and its catch block.
  Consumed by `recordAnswer()` → `src/services/interview.service.ts`
  `submitAnswer()`: `return { session: updated ?? session }`.
- **Evidence:** **Confirmed.** Read the three call sites; the `?? session`
  fallback discards the `undefined` that signals "nothing was written".
- **What:** When the database is down (or the circuit breaker is open — see
  P2-03) and the session was originally created *in Postgres*, it is not in
  `memoryStore`. `applyToMemory` finds nothing, mutates nothing, returns
  `undefined`. `recordAnswer` propagates `undefined`. `submitAnswer` substitutes
  the pre-write snapshot and returns normally. The socket handler then emits
  `answer:received`. The answer exists in no store at all.
- **Why it matters:** The user is told their answer was accepted. They move to the
  next question. The answer is gone — not delayed, not queued, gone. On the next
  successful read the session shows that question as unanswered. This is worse
  than an error, because an error would let the client retry.
- **Impact:** Every in-flight interview during a database outage or a
  circuit-breaker window. Compounded by P2-03, which opens that window for
  reasons that are not outages at all.
- **Fix:** `applyToMemory` must distinguish "applied" from "no such session".
  When the target is absent, `updateSession` should surface a failure rather than
  a silent no-op, and `submitAnswer` must not substitute a stale snapshot for a
  failed write — it should throw an `AppError(503)` so the socket layer emits its
  existing structured error and the client can retry. Keep the in-memory fallback
  for sessions that genuinely live there; the defect is the silent-success path,
  not the fallback itself. **Do not remove the fallback to shrink the diff** —
  that is a data-loss-prevention control.

---

### `[P1-04]` Unverified email lookup + public anonymous sessions exposes full interview transcripts

- **Source:** security (authorization & access control / sensitive data)
- **Security scale:** High
- **Location:** `POST /api/interviews/history/lookup`
  (`src/http/routes/interview.routes.ts`) →
  `interviewController.historyByEmail` → `interviewService.getHistoryByEmail` →
  `interviewRepository.listCompletedSessionsByEmail`. Chained with
  `GET /api/interviews/:sessionId` (`attachUserIfPresent`, ownership checked in
  `interviewService.getOwnedSession`).
- **Evidence:** **Confirmed**, and **explicitly documented as an accepted product
  decision** in `docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md` (Option B) and in comments
  at all four code sites. This entry exists so the decision is re-affirmed
  knowingly before release — not because it looks like an oversight.
- **What:** Anyone can POST any email address and receive that email's completed
  interview summaries (session id, tech stack, provider, model, overall score,
  answered/total, timestamp) with no password, no PIN, no emailed code. Because
  `getOwnedSession` treats a `userId`-null session as reachable by anyone holding
  its UUID, the returned ids can then be opened via `GET /:sessionId` to read the
  **full question-and-answer transcript, every per-question AI critique, and the
  final narrative**.
- **Why it matters:** The lookup is keyed on `historyEmail` only — it is **not**
  filtered to `userId: null`. So a session that has since been claimed by a real
  account still appears in the summary list for its tagged email (the detail
  fetch correctly 404s for a non-owner, so the transcript is protected once
  claimed — but the existence, score and timestamp are not). For unclaimed
  sessions the entire chain is open. Interview answers are self-reported career
  and competence data; a score plus a transcript attached to a guessable work
  email is exactly the kind of record a person would not expect a stranger to
  fetch.
- **Impact:** Anyone who knows or guesses an email used with this app. Rate
  limiting (20 requests / 15 min / IP) blunts bulk scraping, not a targeted
  lookup of one known colleague. Severity floor for an authorization defect is P1
  regardless of intent.
- **Fix:** **This is a decision, not a defect to fix silently — see
  `06-DEFERRED-DECISIONS.md` §1** for the three options (keep as-is with a
  consent notice / add a PIN at session start / email a one-time code) and their
  costs. Two changes are safe to make regardless of which option is chosen:
  - Filter `listCompletedSessionsByEmail` to `userId: null`, so a claimed
    session stops leaking its score and timestamp to an unauthenticated caller.
    This closes a gap the documented decision did not intend to open.
  - Tell the user at input time, next to the "Returning?" box, that anyone who
    knows this email will be able to see these results. Informed consent is the
    difference between an accepted trade-off and a surprise.

---

## P2 — Blocking (5 items)

### `[P2-01]` Production CSP blocks the inline handlers the results and history screens depend on

- **Source:** review (frontend lens) + security (configuration)
- **Location:** `public/js/uiManager.js` — `_renderQuestionItems()`
  (`onclick="this.parentElement.classList.toggle('open')"`) and
  `renderHistoryList()` (`onclick="window.app.viewHistoryDetail('...')"`);
  policy set in `src/app.ts` `helmet({ contentSecurityPolicy: ... })`.
- **Evidence:** **Confirmed.** Both handlers are string-interpolated into
  `innerHTML`. The production policy sets `scriptSrc: ["'self'"]` with no
  `'unsafe-inline'`. helmet v7 merges supplied directives with its defaults
  (`useDefaults` is on unless disabled), and those defaults include
  `script-src-attr 'none'`, which blocks inline event-handler attributes
  outright. `contentSecurityPolicy` is `false` outside production, which is why
  this cannot be seen while developing.
- **What:** In production, clicking a question row in the post-interview
  breakdown does nothing — the accordion never opens. Clicking a history card
  does nothing — the detail view never loads. There are no other click paths to
  either surface (checked `index.html`: no `data-*` delegated listeners for these,
  no other bindings in `app.js`).
- **Why it matters:** The per-question feedback — summary, strengths, gaps, how to
  improve, model answer, study points — is the payload of the entire product, and
  it is only reachable by expanding a row. A user in production finishes an
  interview, sees a score, and cannot open a single piece of feedback. No error is
  shown; the browser logs a CSP violation the user never sees.
- **Impact:** 100% of production users, on the two highest-value screens.
  "Core workflow non-functional" places this at P2 at minimum; it is held below P1
  only because no data is lost and the fix is small and reversible.
- **Fix:** Replace both inline handlers with delegated `addEventListener` calls
  bound once on the container, reading the id from the existing
  `data-session-id` / `data-idx` attributes (already present on both elements, so
  no markup change is needed for the history card). **Do not** add
  `'unsafe-inline'` to `script-src` to make the symptom go away — that removes a
  real XSS control to shrink a diff, which is a new finding at that control's
  floor, not a fix. **Verification must run with `NODE_ENV=production`**; a dev-mode
  test proves nothing here, which is precisely how this survived.

---

### `[P2-02]` The `model` request field is unvalidated and is interpolated into an outbound URL

- **Source:** security (input validation / SSRF-adjacent) + review (trust boundary)
- **Security scale:** Medium
- **Location:** `POST /api/interviews/start` accepts `model` with only
  `{ type: 'string', maxLength: 100 }` (`src/http/routes/interview.routes.ts`) →
  `aiFactory.resolveModelInfo()` (`src/services/ai/aiFactory.ts`) →
  `GeminiService.makeRequest()`:
  `` const url = `${this.baseUrl}/${this.getActiveModel()}:generateContent` ``.
- **Evidence:** **Confirmed** by reading the chain. There is no allowlist anywhere
  between the request body and the URL. `resolveModelInfo` routes any string
  starting with `gemini` straight through as the model id.
- **What:** Two problems from one missing check.
  1. **Path control on the outbound request.** A value like
     `gemini/../../../<other-path>` survives `startsWith('gemini')`, is
     interpolated into the URL, and is then normalised by the WHATWG URL parser —
     redirecting the request to a different path on
     `generativelanguage.googleapis.com` with the server's own API key attached.
     Blast radius is limited to that one host (the scheme and origin are fixed
     literals, so this is **not** full SSRF), but it is unconstrained input
     reaching a request the server authenticates.
  2. **Arbitrary model selection.** `GET /api/interviews/models` advertises eight
     ids; nothing enforces them. A caller can name any Gemini model, or via the
     `openai/` and `qwen/` prefixes any Groq model, and have the server bill its
     own key for it. The `groqMaxCompletionTokens` ceiling exists precisely
     because provider tiers matter — that control is bypassed by naming a
     different model.
- **Why it matters:** This is the one place in the codebase where request-body
  text becomes part of a URL the server signs with a secret. Everywhere else the
  project validates carefully (`validateUuidParam`, the claim-array UUID filter,
  `questionsCount` bounds, the 5000-char JD cap) — this is an inconsistency with
  the project's own convention, not a missing best practice.
- **Impact:** Any unauthenticated caller (`/start` uses `attachUserIfPresent`).
  Cost abuse is immediate; the path-control half needs a useful target on that
  host to matter. Severity floor for missing trust-boundary validation is P2.
- **Fix:** Validate `model` against the same list `getModels` serves. The list is
  already assembled in `interview.controller.ts`; lift it to a shared constant and
  use `validateBody`'s existing `oneOf` rule — the DSL supports this today, so the
  fix is one rule and one export, with no new abstraction.

---

### `[P2-03]` A "record not found" error trips the database circuit breaker for every user

- **Source:** review (failure-path lens) + root-cause reasoning
- **Location:** `src/repositories/interview.repository.ts` — every `catch` block
  calls `markDbDown()` unconditionally; `isDbLikelyDown()` then short-circuits
  `getSession`, `updateSession`, `createSession` and all three list methods to
  the in-memory store for `DB_COOLDOWN_MS` (5 s).
- **Evidence:** **Confirmed.** `markDbDown()` is called in six catch blocks with
  no inspection of the error. `prisma.session.update` throws `P2025` ("record to
  update not found") for a missing id — an ordinary, client-triggerable outcome,
  not an outage. `dbUnavailableUntil` is module-level state shared by the whole
  process.
- **What:** One update against a non-existent session id — or any transient
  constraint/validation error — marks the database "down" globally. For the next
  5 seconds every request in the process reads from `memoryStore` only.
- **Why it matters:** During that window, `getSession` returns `undefined` for
  every session that lives in Postgres (which is all of them under normal
  operation). `getOwnedSession` turns that into `AppError('Session not found',
  404)`. Users mid-interview get "Session not found" on answer submission and on
  ending the interview. Worse, `createSession` writes new sessions to
  `memoryStore` instead of the database during the window — those sessions are
  bounded to 500 entries, evicted oldest-first, and lost entirely on restart.
  A single bad id from one client degrades correctness for every concurrent user,
  which is what makes this system-scope rather than local.
- **Impact:** All users of the instance, for 5 s per triggering error, repeatable.
  Trivially reachable: `POST /api/interviews/<valid-uuid-that-does-not-exist>/extend`.
  *Inferred* that this is client-triggerable at will — **confirm** by checking
  whether `extendSession`'s `getOwnedSession` 404s before reaching `updateSession`
  (it does for a missing session, which narrows but does not close the path; the
  `recordEvaluation` and `_maybeRefreshAggregateScore` paths can still hit P2025
  against a session deleted mid-flight).
- **Fix:** Only `markDbDown()` for errors that actually indicate an unreachable
  database — Prisma's `P1001`/`P1002`/`P1008`/`P1017` initialization and connection
  errors, plus raw connection-level failures. Let `P2025` and other
  `PrismaClientKnownRequestError` codes propagate as what they are. Keep the
  breaker; narrow its trigger.

---

### `[P2-04]` Upstream AI provider error bodies are returned verbatim to clients

- **Source:** security (information disclosure) + review (error handling)
- **Security scale:** Medium
- **Location:** `src/services/ai/groqService.ts`, `nvidiaService.ts`,
  `geminiService.ts` — each `makeRequest()` throws
  `` new AppError(`<Provider> API error (${response.status}): ${errText}`, ...) ``.
  These are `isOperational: true` by default, so
  `src/http/middleware/errorHandler.ts` returns `err.message` unmodified in the
  JSON body. They reach the client through `runWithProviderChain`'s
  `throw lastError instanceof AppError ? lastError : ...`.
- **Evidence:** **Confirmed.** Traced from each throw site to the response body.
  Gemini's 400/403 branch additionally appends a 300-character slice of the
  upstream body plus the sentence "check that GEMINI_API_KEY is valid and the
  Generative Language API is enabled for it".
- **What:** Whatever Google, Groq or NVIDIA put in an error body — internal request
  ids, quota structure, project/org identifiers, model availability details, the
  exact configured model name — is forwarded to an unauthenticated caller, along
  with a message naming the server's environment variables.
- **Why it matters:** The project already gets this right for its own errors:
  `errorHandler` deliberately returns a generic message for non-operational errors
  "to avoid leaking internals", and `logger` calls throughout carefully log
  metadata but never candidate content. This path bypasses that discipline by
  marking upstream failures operational. It also hands an attacker a free oracle
  for probing provider configuration through `/api/interviews/start`.
- **Impact:** Any unauthenticated caller who can make a provider call fail —
  e.g. by naming a model the key has no access to (which P2-02 makes trivial).
  Not a credential leak in the bodies observed by reading, so this stays below P1.
- **Fix:** Log the full upstream body with `logger.error` (as the Gemini path
  already does) and throw an `AppError` whose *message* is stable and generic —
  "The AI provider rejected this request" / "…is temporarily unavailable" — while
  keeping the accurate `statusCode` for retry logic. The diagnostic detail stays
  in logs, correlated by `requestId`. Do not simply lower these to
  `isOperational: false`; that would turn every provider hiccup into a 500 and
  break `runWithProviderChain`'s status-code-driven fallback.

---

### `[P2-05]` Duplicate-answer guard is check-then-act and races

- **Source:** review (concurrency lens)
- **Location:** `src/services/interview.service.ts` — `submitAnswer()`:
  `const alreadyAnswered = session.answers?.some(...)` followed by
  `interviewRepository.recordAnswer(...)`, which itself re-reads and appends.
- **Evidence:** **Confirmed.** The check reads a snapshot taken by
  `getOwnedSession` earlier in the same method; nothing holds a lock between the
  check and the write, and `recordAnswer` performs its own independent
  read-modify-write of the `answers` array.
- **What:** Two `answer:final` events for the same `questionId` arriving close
  together — a double-click, a socket reconnect replay (`socketManager.js`
  re-joins and the client may resend), or a deliberate duplicate — both pass the
  guard and both append. The result is two answer entries for one question, and
  two background evaluations racing to write the same `evaluations` slot
  (compounding P1-02).
- **Why it matters:** `endSession` derives `answeredCount` from
  `session.answers.length`, so the count exceeds the number of questions actually
  answered and `evaluationsTotal` is inflated. Two AI evaluation calls are billed
  for one answer. The `409 already answered` error the code intends to give is
  the correct behavior and is simply not enforced under concurrency.
- **Impact:** Any user who double-submits, plus every reconnect path. Not
  data-destroying on its own, which holds it at P2 rather than P1.
- **Fix:** Enforce uniqueness at the write, not before it — inside the same
  transaction/conditional update introduced for P1-02, re-check membership and
  reject if the questionId is already present. Because the mechanism is the same,
  **fix this immediately after P1-02, in the same area, as its own reviewed
  change** — not bundled into it.

---

## P3 — Required (10 items)

### `[P3-01]` No CI enforces the quality gate

- **Source:** audit (sustainability) · **Location:** repository root — no
  `.github/`, no `.gitlab-ci.yml`, no CI config of any kind.
- **Evidence:** **Confirmed** by directory listing. **Assumed** that no external
  CI is wired up; if one is, this drops to Informational.
- **What:** `npm run verify` (lint + typecheck + test + build) exists and is
  well-composed, but is a manual convention. Nothing prevents a push that fails
  lint, fails typecheck, breaks a test, or does not compile.
- **Why it matters:** Every fix in this backlog ends with "the whole suite still
  passes". Without automation that is an assertion made once, by whoever happened
  to remember. It is also the cheapest single item here: one workflow file.
- **Impact:** All future maintainers; the risk compounds with every merge.
- **Fix:** A workflow on push and PR: `npm ci` → `npx prisma generate` →
  `npm run verify`. Node 20 to match `engines`. No new tooling.

### `[P3-02]` No test coverage on the two files carrying the P1 findings

- **Source:** audit (testability) — severity floor for absent coverage on code
  about to change.
- **Location:** `src/services/interview.service.ts` (31 KB) and
  `src/repositories/interview.repository.ts` (12 KB). No file under `tests/`
  targets either directly.
- **Evidence:** **Confirmed.** Enumerated all 14 test files. The service is
  exercised only incidentally by `tests/integration/socket.test.ts`, which mocks
  Prisma such that `session` is undefined — meaning it exercises the *in-memory
  fallback path only*, never the real persistence path where P1-02 and P2-03 live.
- **What:** The provider chain, the background-evaluation lifecycle, the bounded
  wait in `endSession`, `computeOverallScore`, `buildEvaluationDigest`,
  `_maybeRefreshAggregateScore`, extend/claim, and every repository fallback
  branch are untested.
- **Why it matters:** This is the enabler for the entire P1 phase. Changing
  concurrency-sensitive code with no characterization tests means no fix can be
  shown to preserve behavior, and the prime directive — existing behavior is a
  contract until proven wrong — becomes unenforceable.
- **Impact:** Blocks R-03, R-04, R-08 from being verifiable at all.
- **Fix:** See `05-TEST-AND-VERIFICATION-PLAN.md` §2 for the specific
  characterization tests, including the ones that must pin current behavior that
  looks wrong but is not being fixed yet.

### `[P3-03]` "Validate API key" always reports failure for anonymous visitors

- **Source:** review (correctness / UX contract)
- **Location:** `public/js/app.js` `validateApiKey()` → `POST
  /api/settings/api-key/validate`, which sits behind `router.use(requireAuth)` in
  `src/http/routes/apiKey.routes.ts`.
- **Evidence:** **Confirmed.** The setup panel — reachable by guests via
  `_continueAsGuest()` — exposes the key input and validate button. The request
  carries no session, so `requireAuth` returns 401. The client reads
  `data.success && data.data.isValid`, both absent, and renders
  **"✗ Invalid API key — please check and try again"**.
- **What:** A guest pasting a perfectly valid Gemini key is told the key is
  invalid. The key still works if they start the interview anyway
  (`/interviews/start` accepts `userApiKey` anonymously) — so the app contradicts
  itself.
- **Why it matters:** It is a wrong answer, not a missing feature: the user is
  told something false about their own credential and will go re-issue a working
  key. It also strands the deliberate "no login required" design halfway.
- **Impact:** Every anonymous visitor who uses their own key — the exact user the
  anonymous flow was built for.
- **Fix:** `POST /validate` is stateless (`apiKeyService.validateKey` persists
  nothing) so it can move to `attachUserIfPresent` behind the existing 10/15min
  limiter; keep `POST /`, `GET /status` and `DELETE /` on `requireAuth`, since
  those are per-user storage. If keeping it authenticated is preferred, the
  client must distinguish 401 from a genuine invalid-key result and say "sign in
  to validate" instead. Either is small; picking one is the point.

### `[P3-04]` Background-evaluation tracking is process-local

- **Source:** review (concurrency / deployment lens)
- **Location:** `src/services/interview.service.ts` — `pendingEvaluations` is an
  instance field on a module singleton; `src/repositories/interview.repository.ts`
  — `memoryStore` and `dbUnavailableUntil` are module-level.
- **Evidence:** **Confirmed** by reading. **Assumed** single-instance deployment
  today — this is latent, not live, until a second replica exists.
- **What:** `endSession`'s bounded wait only sees evaluations started **in the
  same process**. Behind two replicas, an answer submitted via replica A and an
  interview ended via replica B means B finds no pending promise, skips the wait,
  and writes `status: 'failed'` placeholders for evaluations that are running
  fine on A — which then complete and are overwritten, or overwrite the
  placeholder, depending on P1-02's race.
- **Why it matters:** The failure is invisible in staging at one replica and
  appears the day autoscaling turns on, presenting as "some answers randomly
  aren't scored".
- **Impact:** Every user, the moment the app runs more than one instance.
- **Fix:** Derive in-flight state from the row (`status: 'processing'` is already
  persisted for exactly this purpose — `_evaluateAndPersist` writes it before the
  AI call) plus a timestamp, rather than from an in-process Map. Note the
  operational consequence in the deploy docs either way: **today this app cannot
  be horizontally scaled correctly.**

### `[P3-05]` Prompt injection: only `jobDescription` is filtered, and the filter is a bypassable denylist

- **Source:** security (input validation) · **Security scale:** Low–Medium
- **Location:** `src/utils/promptBuilder.ts` — `sanitizeJDInput()` (nine regexes);
  `getEvaluationPrompt()` interpolates `question` and `answer` inside double
  quotes with no escaping; `techStack` flows unescaped into
  `DEFAULT_TECH_PROMPT` and the prompt body.
- **Evidence:** **Confirmed** by reading. Denylist bypass is a property of the
  approach, not a specific tested payload — no payload was executed.
- **What:** A 5000-character answer containing quotes, newlines and instructions
  is embedded directly into the evaluation prompt. `techStack` (200 chars,
  unfiltered) is embedded into the question-generation prompt.
- **Why it matters:** The realistic impact is **self-directed** — a user
  manipulates the scoring of their own interview, or steers question generation.
  That is a product-integrity issue, not a cross-user compromise: the AI's output
  is rendered through `renderMarkdown`, which HTML-escapes everything up front,
  so injected content cannot become script. It is filed at P3 because the
  *existing* mitigation actively misleads — `sanitizeJDInput` reads like a
  security control while covering one field with a pattern list that any
  rephrasing defeats.
- **Impact:** Score integrity for any user willing to try; no cross-user impact.
- **Fix:** Stop relying on the denylist. Delimit untrusted spans structurally
  (a clearly-fenced block with an instruction that content inside is data, never
  instructions), and apply it to `answer`, `question` and `techStack` as well as
  `jobDescription`. Constrain `techStack` to the served list, the same way P2-02
  constrains `model`. Keep or drop the regex list on its own merits, but do not
  let it stand in for the structural fix.

### `[P3-06]` Deleting an account makes that user's interviews publicly readable

- **Source:** security (sensitive data) + review (database lens)
- **Security scale:** Medium
- **Location:** `prisma/schema.prisma` —
  `user User? @relation(fields: [userId], references: [id], onDelete: SetNull)`.
- **Evidence:** **Confirmed** by reading the schema alongside
  `interviewService.getOwnedSession`, which skips the ownership check entirely
  when `session.userId` is falsy.
- **What:** On user deletion, every one of their sessions has `userId` set to
  `NULL`. A null-owner session is, by this app's deliberate design, readable by
  anyone holding its UUID. Account deletion therefore *downgrades* those records
  from private to link-public rather than removing them.
- **Why it matters:** Deletion is the one operation a user performs specifically
  to stop their data being reachable. The current cascade does close to the
  opposite. If any session also carries a `historyEmail`, P1-04's lookup will
  keep surfacing it after the account is gone.
- **Impact:** Any user who deletes their account. **Inferred** that a deletion
  path exists — no delete-account endpoint was found in `src/http/routes/`, so
  today this is reachable only by direct database action. That keeps it at P3
  rather than P1, and makes it cheap to fix *before* the feature ships.
- **Fix:** `onDelete: Cascade` for sessions (matching what `UserApiKey` already
  does), or an explicit anonymisation step that also clears `historyEmail`,
  `answers` and `jobDescription`. Requires a migration — see the deploy-ordering
  note in `05-TEST-AND-VERIFICATION-PLAN.md` §5.

### `[P3-07]` docker-compose ships production mode with hardcoded database credentials

- **Source:** security (secrets & configuration) · **Security scale:** Medium
- **Location:** `docker-compose.yml` — `NODE_ENV: production` on the app service
  alongside `POSTGRES_USER/PASSWORD/DB: neurostack` and `ports: '5432:5432'`.
- **Evidence:** **Confirmed.** Note the file is otherwise careful — app secrets
  use `${VAR:?error}` with explicit "do NOT bake real secrets into this file"
  comments. The database block is the inconsistency.
- **What:** A compose file that declares itself production runs Postgres with
  `neurostack/neurostack` and publishes 5432 on the host interface.
- **Why it matters:** Someone will run this on a box with a public interface
  because it says `production` and comes up green. The credentials are in the
  repository.
- **Impact:** Whoever deploys with it; full database access.
- **Fix:** `${POSTGRES_PASSWORD:?...}` to match the pattern used three lines
  above; bind the port to `127.0.0.1:5432:5432` or drop the mapping entirely
  (the app reaches the DB over the compose network, not the host).

### `[P3-08]` Migrations have no place in the deploy path

- **Source:** review (database & migrations lens)
- **Location:** `Dockerfile` — `CMD ["node", "dist/server.js"]`; no
  `prisma migrate deploy` anywhere in the image, entrypoint, or compose file.
  `package.json` has the script; nothing calls it.
- **Evidence:** **Confirmed** by reading all three files.
- **What:** Deploying the container starts the server against whatever schema the
  database currently has.
- **Why it matters:** `historyEmail` and `answeredCount` are recent columns. Ship
  code that selects them against an un-migrated database and every session query
  fails — which, via P2-03's over-broad catch, silently degrades the whole process
  to the in-memory store rather than failing loudly. A schema problem presents as
  mysterious data loss.
- **Impact:** Every deploy, until it bites once.
- **Fix:** Run `prisma migrate deploy` as an explicit pre-start step (init
  container, release command, or entrypoint) — never as part of `CMD` where N
  replicas race it. Document that **a migration and the code depending on it are
  two deploys, not one**: migrate first (additive, backward compatible), then
  deploy code.

### `[P3-09]` `finalEvaluation` is refreshed with an unguarded read-modify-write

- **Source:** review (concurrency lens)
- **Location:** `src/services/interview.service.ts` —
  `_maybeRefreshAggregateScore()`: `getSession` → compute → `updateSession`.
  Called from every `_evaluateAndPersist`.
- **Evidence:** **Confirmed.** Same shape as P1-02, different column.
- **What:** Two late evaluations landing together both read the same
  `finalEvaluation`, both recompute, both write. The later write can carry the
  earlier snapshot's `evaluationsCompleted`.
- **Why it matters:** The displayed overall score and the "N of M scored" counter
  can settle on a stale value with no error, and the `stale` banner that tells the
  user to refresh may not appear.
- **Impact:** Users whose evaluations complete after the interview ends —
  the case this method exists to handle. Filed separately from P1-02 because it is
  a different column with a different fix, and bundling them would make one
  unreviewable change.
- **Fix:** Same conditional-update mechanism as P1-02; land it in the same phase,
  as its own change.

### `[P3-10]` Socket events are unmetered

- **Source:** security (denial of service) · **Security scale:** Low–Medium
- **Location:** `src/sockets/interview.socket.ts` — `answer:final`,
  `interview:end`, `interview:join`. HTTP has three rate limiters
  (`app.ts` 100/15min, `authLimiter` 20/15min, `historyLookupLimiter` 20/15min);
  the socket layer has none.
- **Evidence:** **Confirmed.** `maxHttpBufferSize: 1e6` caps payload size, and
  `MAX_ANSWER_LENGTH` caps text, but neither caps *rate*.
- **What:** An authenticated-or-anonymous socket holding one valid session UUID
  can emit `answer:final` for each unanswered question as fast as the loop allows.
  Each accepted answer starts a background AI call.
- **Why it matters:** Cost, and provider rate-limit exhaustion that degrades every
  other user's interview via `runWithProviderChain` burning through the whole
  chain. The `alreadyAnswered` guard bounds this per session — but P2-05 shows
  that guard races, and sessions are free to create.
- **Impact:** Provider spend and availability for all users. Held at P3 because it
  requires deliberate abuse and the per-session ceiling limits amplification.
- **Fix:** A small per-socket token bucket on `answer:final` and `interview:end`,
  mirroring the express-rate-limit shape already used at the HTTP layer, plus a
  cap on concurrent in-flight evaluations per session.
