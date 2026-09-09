# Test and Verification Plan

This is the safety net every fix in the backlog depends on. Nothing in
`01-BACKLOG-P0-P3.md` should be implemented before §1 is done, and the P1 items
should not be implemented before §2 is done.

---

## 1. Establish the baseline (R-00 — blocks everything)

This pass **could not run the suite**: no shell on the machine holding the repo,
and dependency installation in the analysis container failed at the npm registry
(`403 Forbidden`). So there is currently **no recorded baseline**, and any claim
that a future change "didn't break anything" would be an assertion, not evidence.

Run on a machine with registry access, from a clean checkout:

```bash
npm ci
npx prisma generate
npm run verify          # lint -> typecheck -> test -> build
npm run test:coverage
```

Record, in a file committed next to this one:

- Test suite counts: **passed / failed / skipped / total**, and wall-clock runtime.
- Any test that is currently failing or skipped — **and why**. A pre-existing
  failure is a finding in its own right and must be filed before it is fixed,
  not quietly repaired inside another change.
- Lint warning count (`@typescript-eslint/no-explicit-any` and `no-unused-vars`
  are `warn`, so they do not fail the build — the count is the ratchet).
- Coverage percentages per file for the files listed in §2.

Until that exists, treat every "no regressions" statement about this codebase as
unverified.

---

## 2. Characterization tests before touching P1 code (R-01, R-12)

`interview.repository.ts` and `interview.service.ts` have **no direct tests**.
Both carry P1 findings. Before changing either, pin what they do today —
**including the behavior that looks wrong and is not being fixed in that change**.
A characterization test that encodes a bug is correct; it is what proves the fix
changed only what it meant to.

### 2a. `interview.repository.ts` — required before R-03, R-04, R-08

Against a real Postgres (testcontainers or a disposable schema — the existing
`mockPrisma` helper deliberately leaves `session` undefined and therefore only
exercises the *fallback* path, which is not where the P1 bugs live):

| Pin | Current behavior to record |
|---|---|
| `recordEvaluation` replaces by `questionId` | one entry per question, never duplicates |
| `recordEvaluation` appends `interviewContext` only when a context entry is passed | placeholder writes leave context untouched |
| **Two concurrent `recordEvaluation` calls** | **one write is lost — record this as today's behavior; it is P1-02's reproduction** |
| `updateSession` ignores `undefined` fields but writes `null` | this is what makes P1-01 possible |
| `updateSession` on a missing id | throws → `markDbDown()` → breaker opens (P2-03's reproduction) |
| `applyToMemory` on an id not in `memoryStore` | returns `undefined`; caller reports success (P1-03's reproduction) |
| Breaker cooldown | 5 s, module-global, shared across sessions |
| `claimAnonymousSessions` | only `userId: null` rows; returns a count; replay is a no-op |
| Memory store bound | evicts oldest past 500 |
| Both list paths | DB path returns 8 fields, memory path returns everything (P4-05) |

### 2b. `interview.service.ts` — required before R-12, valuable before R-02

With the AI factory stubbed (return canned `Question[]` / `EvaluationResult` /
`FinalEvaluation`, and throw on demand to drive the chain):

| Pin | Current behavior to record |
|---|---|
| `computeOverallScore` | strict mean of `completed` only, `/(n*10)*100`, rounded; empty ⇒ 0 |
| `isEvaluationCompleted` | `status==='completed'` **or** legacy `!status && typeof score==='number'` |
| `buildEvaluationDigest` | one line per **answered** question; summary truncated at 220 chars with `…`; falls back `summary → feedback → 'Not scored in time.'` |
| `runWithProviderChain` | tries chain in order; `switched` true only when index > 0; rethrows the last `AppError` or a 503 |
| `getOwnedSession` | 404 on missing; 404 (not 403) on owner mismatch; **null-owner sessions readable by anyone** |
| `submitAnswer` | returns before evaluation completes; 409 on a duplicate question; 400 on a completed session |
| `_evaluateAndPersist` | writes `processing` first, then `completed`/`failed`; **never rejects**; emits on `interviewEvents` either way |
| `endSession` | idempotent on an already-completed session; bounded wait; backfills `failed` placeholders; overrides the AI's overall score with the computed mean |
| **`extendSession`** | **nulls `finalEvaluation` and sets `status:'active'` — P1-01's reproduction** |
| `refreshOverallFeedback` | 400 unless completed; 400 on an empty digest |

### 2c. Regression test per fix

Each backlog item ships with a test that **fails before the fix and passes after**:

| Item | The test |
|---|---|
| P1-01 | Complete a session, extend it, assert `finalEvaluation` survives (or that extend is rejected — per the decision taken) |
| P1-02 | Fire two `recordEvaluation` calls concurrently for different questions; assert both entries are present |
| P1-03 | With the breaker open and the session absent from memory, assert `submitAnswer` throws rather than returning `{ session }` |
| P2-01 | Render the breakdown, dispatch a click on a question header, assert the `open` class toggles **with no inline handler in the markup** |
| P2-02 | `POST /start` with `model: 'gemini/../../x'` and with `model: 'not-a-model'` ⇒ 400 |
| P2-03 | `updateSession` on a missing id ⇒ error propagates, breaker stays closed, a subsequent `getSession` still reaches the database |
| P2-04 | Force a provider 500 with a distinctive body; assert the body appears in the log and **not** in the HTTP response |
| P2-05 | Two concurrent `submitAnswer` calls for the same `questionId` ⇒ exactly one answer recorded, one 409 |
| P3-03 | `POST /api/settings/api-key/validate` without a cookie behaves per the decision taken, and the client distinguishes 401 from `isValid: false` |

---

## 3. Acceptance criteria template

Every item gets this filled in **before** any code is written:

```
Goal: <one sentence>
Done when:
  1. <observable behavior>  -> verify: <exact test or command>
  2. <observable behavior>  -> verify: <exact test or command>
  3. Full suite matches or exceeds the R-00 baseline
                            -> verify: npm run verify
Out of scope: <explicitly>
```

Worked example for P1-01:

```
Goal: Extending an interview never destroys its completed final evaluation.
Done when:
  1. Extending a completed session leaves finalEvaluation intact and marks
     overallFeedbackStatus 'stale'
     -> verify: tests/unit/interviewService.extend.test.ts
  2. Extending an active session behaves exactly as before
     -> verify: the 2b characterization test for extendSession, unchanged
  3. The client's existing 'stale' banner appears for the extended session
     -> verify: manual check on the completion panel
  4. Full suite matches the R-00 baseline
     -> verify: npm run verify
Out of scope: the P1-02 evaluation race; capping extension count (P4-02);
              answeredCount reconciliation (tracked separately if it needs
              its own change).
```

---

## 4. If a bug report arrives during this work

The Iron Law applies: **no fix without a confirmed cause.** Before writing a line:

1. State the symptom in observable terms (what a user sees, not a theory).
2. Reduce to the smallest reliable trigger.
3. Generate competing hypotheses and pick the **cheapest test that
   discriminates** between them — not the most convincing one.
4. A cause is confirmed only when it clears all four bars: a stated **mechanism**,
   a **prediction** that holds, a **reproduction**, and an explanation of the
   **negative cases** (why it does not fire when it does not).

A symptom disappearing after a change is **not** confirmation. If the cause is
unconfirmed, file it as a labelled suspect with a confidence level and the
instrumentation that would settle it — never as a confirmed defect, and never as
a blocking severity.

Three failed attempts against the same understanding means an assumption is
wrong. Stop and re-read the evidence rather than trying a fourth variant.

---

## 5. Operational notes for items with deploy surface

| Item | Deploy ordering | Rollback | Cost |
|---|---|---|---|
| P1-02 / P3-09 (conditional updates) | Code-only if you use the existing `updatedAt`. If you add a `version` column: **migrate first, deploy second — two deploys, not one.** | Revert code; an additive column is harmless if left. | Extra round-trip per contended write; retry loop on conflict. |
| P2-01 (CSP / inline handlers) | Code-only. **Verify under `NODE_ENV=production`** — dev disables CSP and will pass regardless. | Revert code. | None. |
| P2-02 (model allowlist) | Code-only. Confirm no existing client sends a model outside the served list before enabling — otherwise this is a **breaking change** for that client. | Revert code. | None. |
| P3-06 (`onDelete` change) | Migration. Additive-then-switch: deploy the new deletion path first, migrate the constraint second. | Constraint change needs a reverse migration — write it before shipping. | None. |
| P3-08 (migrations in deploy) | Establishes the ordering rule itself. Run `prisma migrate deploy` as an explicit pre-start step, **never inside `CMD`** where N replicas race it. | n/a | One step per deploy. |
| P6-01 (indexes) | Migration. `CREATE INDEX CONCURRENTLY` on a live table. | Drop the index. | Write amplification. **Measure before adding.** |

---

## 6. Final validation (run once, after every phase closes)

1. `npm run verify` from a cold, clean checkout. Compare against the R-00
   baseline: **same or more tests, same or fewer failures, no newly skipped
   tests**. A test that started failing is itself a finding — either the fix
   broke real behavior (revert and rethink) or the test was already wrong (say so
   explicitly; do not delete it quietly).
2. Re-check every fixed item against its own acceptance criteria as a batch, not
   just individually as it was written.
3. Re-run the security pass over everything touched during remediation — a fix
   introduces findings as easily as it closes them. In particular: confirm no
   `'unsafe-inline'` crept into `script-src` while fixing P2-01, and that P2-04's
   generic messages did not break `runWithProviderChain`'s status-code-driven
   fallback.
4. Restate coverage honestly. **Never write that the system is now "secure" or
   "bug-free".** The defensible claim is: *no issue was recorded within the
   examined scope* — with that scope stated.
5. Six-point check on the whole pass: the actual ask was addressed; project
   evidence was used and assumptions labelled; every severity is defensible at
   its level; every finding says what was done about it; no complexity was added
   beyond what each fix required; every fix matches the project's real language,
   framework, and architecture.
