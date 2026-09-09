# NeuroStack Voice — Full-Codebase Issue Sweep

**Status:** Findings only. **No code was changed by this pass.**
**Date:** 2026-09-03
**Depth:** Deep (full context ladder, every entry point and trust boundary enumerated)
**Driver:** Not stated by the requester — treated as *pre-release hardening / general
"make it solid"*. If the real driver was an incident follow-up, say which symptom and
the root-cause protocol in `05-TEST-AND-VERIFICATION-PLAN.md` §4 should run first.
**Hard constraints:** Not stated — this pass **assumed** the public HTTP/Socket.IO
contract, the Prisma schema, and the anonymous-session trust model are all frozen.
Every proposed fix below is written to hold that line; the three places where a fix
*cannot* avoid a behavior change are called out explicitly in
`06-DEFERRED-DECISIONS.md`.

---

## 1. Reconnaissance

```
Stack:        TypeScript 5.3 (strict, ES2022/CommonJS) on Node >= 20
              Express 4.19 + Socket.IO 4.7 + Prisma 5.11 -> PostgreSQL
              Vanilla ES-module frontend (no build step) served from public/
              AI providers: Google Gemini, Groq, NVIDIA (REST, native fetch)
              Docker multi-stage (node:20-alpine) + docker-compose w/ postgres:16

Conventions observed:
  - Errors: throw `AppError(message, statusCode, isOperational)`; controllers
    wrap in try/catch and `next(error)`; one global handler formats the response.
    (src/utils/appError.ts, src/http/middleware/errorHandler.ts)
  - Validation boundary: `validateBody` / `validateUuidParam` middleware at the
    route layer; extra ad-hoc checks in controllers for shapes the schema DSL
    can't express (arrays, conditional requirements).
    (src/http/middleware/validate.ts, src/http/controllers/interview.controller.ts)
  - Layering: routes -> controllers -> services -> repositories -> Prisma.
    Services never import Socket.IO; they publish through `interviewEvents`.
  - Naming: `dot.case` filenames in src/http and src/repositories,
    `camelCase` filenames in src/services/ai and src/utils. Both are live.
  - Tests: Jest + ts-jest, `tests/unit` and `tests/integration`, supertest for
    HTTP, a real Socket.IO client for the socket suite, Prisma faked via
    `jest.mock('../../src/config/database')` + `tests/helpers/mockPrisma.ts`.
  - Logging: structured `logger` (src/utils/logger.ts) in newer code; raw
    `console.*` in the repository, sockets, config and database layers.

Quality gate:  `npm run verify` = lint + typecheck + test + build.
               NOTHING ENFORCES IT. There is no .github/ directory and no CI
               config anywhere in the repo — the gate is a manual convention.

Existing safety net: 14 test files, ~70 test cases. Strong on auth, validation,
  the AI factory, JSON extraction and socket authorisation. ZERO direct tests on
  `interview.service.ts` (31 KB, the highest-complexity file in the repo) and
  `interview.repository.ts` (12 KB, the only persistence path). No coverage
  threshold is configured.

Constraints:  Deployment target appears to be a container / Render-style PaaS
  (socketManager.js references "Render free-tier spin-down"). Prisma points at a
  Supabase-shaped pooler URL in .env.example. Node >= 20 (native fetch is relied on).

Assumptions (state what changes if wrong):
  - No CI exists. Verified by directory listing only. If CI lives outside the
    repo, P3-01 drops to Informational.
  - `.env` is untracked. `.gitignore` lists it, but git *history* was not
    inspected (no shell available on the machine holding the repo). If `.env` was
    ever committed, that is a P0 by the severity floor — see "Worth verifying".
  - Single-instance deployment today. Several findings (P3-04) only bite at 2+
    replicas; they are filed at the severity they carry the moment you scale.
```

### Baseline — NOT ESTABLISHED. Read this before trusting any "no regressions" claim.

The test suite **could not be run** during this pass. The repository lives on the
requester's machine, this session has no shell there, and dependency installation
in the analysis container failed at the registry (`403 Forbidden` fetching
transitive packages). Consequently:

- No pass/fail/skip counts, no runtime, no coverage numbers were captured.
- Every finding below is **static-analysis evidence** (files read, line-cited).
  Nothing here rests on an observed failure.
- **Before any fix is written, run `npm run verify` and record the output.**
  That recorded output is the baseline every later "the suite still passes"
  claim must be diffed against. This is item R-00 in the remediation sequence and
  it blocks everything else.

---

## 2. Scope and coverage

| Examined | Depth |
|---|---|
| `src/**` (all 32 live TypeScript files) | Read in full, line by line |
| `public/js/**` (7 files), `public/index.html` | Read in full except `css/style.css` |
| `tests/**` (14 files) | Test names enumerated; setup + Prisma mock read in full |
| `prisma/schema.prisma`, `prisma/migrations/0_init` | Read in full |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Read in full |
| `package.json`, `tsconfig*.json`, `.eslintrc.cjs`, `jest.config.js`, `.gitignore`, `.env.example` | Read in full |
| `docs/*.md` (4 design plans), `Agent.md`, `README.md` | Read as declared intent |

**Explicitly NOT examined:**

- `public/css/style.css` (45 KB) — no security or correctness surface; a11y
  contrast/focus states were therefore **not** assessed.
- `node_modules/`, `dist/`, `package-lock.json` contents — no `npm audit` was
  possible (registry blocked). The dependency tree's CVE status is **Unknown**.
- Git history — cannot confirm whether a secret was ever committed and later
  gitignored.
- The real `.env` file — deliberately not read.
- Runtime behavior of any kind. Nothing was executed, deployed, or profiled.

**Absence claims are scoped accordingly.** This pass found no committed credential,
no SQL injection, no auth bypass and no RCE *within the files listed above*. That is
not the same as "there are none".

---

## 3. Results at a glance

| Phase | Band | Items |
|---|---|---|
| P0 | Blocking | **0** (within examined scope — see caveat above) |
| P1 | Blocking | **4** |
| P2 | Blocking | **5** |
| P3 | Required | **10** |
| P4–P6 | Recommended | **12** |
| P7–P10 | Informational | **5** |
| | **Total** | **36** |

Full entries: `01-BACKLOG-P0-P3.md` (blocking + required),
`02-BACKLOG-P4-P10.md` (recommended + informational).

### The four things that matter most

1. **P1-01 — Extending a finished interview deletes its final report.**
   `extendSession` unconditionally writes `finalEvaluation: null`. There is no
   status guard and no backup. A user who clicks "add more questions" after
   finishing loses their score and write-up permanently.
2. **P1-02 — Concurrent evaluations silently overwrite each other.** Every
   evaluation write is a read-modify-write of one JSON column with no transaction
   and no version check. Two answers scored in parallel — the normal case, since
   scoring is deliberately fire-and-forget — race, and one result vanishes.
3. **P2-01 — The production CSP kills the results screen.** Two `onclick`
   attributes are injected via `innerHTML`; helmet's production CSP (`script-src
   'self'`, plus its default `script-src-attr 'none'`) blocks inline handlers.
   CSP is disabled in development, so this is invisible until deploy.
4. **P3-02 — The two files carrying findings 1 and 2 have no tests at all.**
   Fixing them without first pinning current behavior means shipping an
   unverifiable change into the most concurrency-sensitive code in the project.

---

## 4. Remediation sequence

Order is **P0 → P10**. Within a phase: live risk first, then enablers, then
high-impact/low-effort, then structural. Do not open a phase while the previous
one has an item that is neither fixed-and-verified nor explicitly deferred.

```
R-00  BLOCKS EVERYTHING
      Run `npm run verify`; record pass/fail/skip counts, runtime, and
      `npm run test:coverage` output. This is the baseline.

── P1 ──────────────────────────────────────────────────────────────────────
R-01  P3-02a (enabler, pulled forward): characterization tests for
      interview.repository.ts — pin today's behavior including the
      fallback quirks you are NOT fixing yet.        blocks R-03, R-04
R-02  P1-01  Guard extendSession against destroying finalEvaluation.
             Smallest sufficient change; independent of R-01.
R-03  P1-02  Serialize evaluation writes (transaction + conditional update,
             or a per-session async mutex).           depends on R-01
R-04  P1-03  Never return success when a write persisted nowhere.
                                                      depends on R-01
R-05  P1-04  DECISION REQUIRED — see 06-DEFERRED-DECISIONS.md §1.
             Do the prep work; do not change behavior unilaterally.

── P2 ──────────────────────────────────────────────────────────────────────
R-06  P2-01  Replace the two inline onclick handlers with delegated
             listeners. Verify under NODE_ENV=production, not dev.
R-07  P2-02  Allowlist `model` against the /api/interviews/models list.
R-08  P2-03  Distinguish "record not found" from "database unreachable"
             before tripping the circuit breaker.     depends on R-01
R-09  P2-04  Stop returning upstream provider error bodies to clients;
             log them, return a stable message.
R-10  P2-05  Close the duplicate-answer check-then-act race.
                                                      depends on R-03

── P3 ──────────────────────────────────────────────────────────────────────
R-11  P3-01  Add CI running `npm run verify` on every push/PR.
R-12  P3-02b Finish the characterization suite for interview.service.ts.
R-13  P3-03 … P3-10  (see 01-BACKLOG-P0-P3.md; no cross-dependencies)

── P4–P6 ──────────────────────────────────────────────────────────────────
R-14  Bundle opportunistically ONLY inside a phase already touching that
      file. Do not widen a P1 diff to chase a P5.

── P7–P10 ─────────────────────────────────────────────────────────────────
R-15  No action implied. Record and move on.
```

---

## 5. Worth verifying (below the reporting confidence gate)

These are **not** findings. Each is a cheap check that would either promote it to a
finding or close it. None carries a severity until checked.

| # | Question | The check that settles it |
|---|---|---|
| W-1 | Was `.env` ever committed before being gitignored? | `git log --all --full-history -- .env` — if it returns anything, rotate every key in it and file a P0. |
| W-2 | Does the dependency tree carry known CVEs? | `npm audit --omit=dev` on a machine with registry access. |
| W-3 | Does the CSP actually break the accordion, or does a browser quirk save it? | `NODE_ENV=production npm start`, finish an interview, click a question row, watch the console for a CSP violation. Confirms/denies P2-01 in 60 seconds. |
| W-4 | Do concurrent evaluations actually drop in practice, or does answer pacing serialize them? | Answer two questions <2s apart against a slow provider; count `evaluations` rows. Confirms P1-02's frequency, not its existence — the mechanism is already confirmed by reading. |
| W-5 | Is `answeredCount` ever written outside `endSession`? | It is in `updatableFields` but only `endSession` sets it; history rows for active sessions would read 0. Low stakes, one grep. |

---

## 6. Document map

| File | Contents |
|---|---|
| `00-AUDIT-OVERVIEW.md` | This file — recon, baseline, scope, sequence |
| `01-BACKLOG-P0-P3.md` | Blocking and required findings, full evidence format |
| `02-BACKLOG-P4-P10.md` | Recommended and informational findings |
| `03-SECURITY-REVIEW.md` | Attack surface, STRIDE walk, 13-category catalog, exclusions |
| `04-QUALITY-DIMENSIONS.md` | 16 quality dimensions, scored against this codebase |
| `05-TEST-AND-VERIFICATION-PLAN.md` | Baseline procedure, coverage gaps, per-fix acceptance criteria |
| `06-DEFERRED-DECISIONS.md` | Items only a human can decide, with options and costs |
