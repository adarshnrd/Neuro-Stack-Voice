# Quality Dimensions

Sixteen dimensions in four clusters. For each: what a **10 would look like for
this specific codebase**, the score, the evidence (three concrete instances plus a
count of the rest where a pattern exists), and the false positive that was checked
before reporting.

Scores are relative to this project's own size and stated goals — a ~4,500-line
single-service TypeScript app with an anonymous-first product model. They are not
comparisons to a hypothetical enterprise system.

**Headline: this is a well-built codebase.** The comment discipline is genuinely
unusual — most non-obvious decisions carry a "here's what this replaces and why"
note that made this review far faster than it would otherwise have been. The
weaknesses are concentrated in two places: **concurrent persistence** and
**verification**.

---

## Cluster 1 — Structure

### Modularity — **8/10**
*A 10 here:* every layer replaceable without touching its neighbours; the AI
provider set extensible by adding one file.
- `BaseAIService` + `AIFactory` achieve exactly that — adding a provider is one
  subclass and one `switch` arm.
- `interviewEvents` decouples the service layer from Socket.IO entirely, so
  `interview.service.ts` imports no transport.
- `createApp()` is separated from `server.ts` specifically so supertest can mount
  the app without binding a port — and the tests actually use it.
- Held below 9 by `interview.service.ts` at 31 KB doing session lifecycle,
  provider orchestration, score computation and digest building in one class.
- *False positive checked:* a small codebase with few modules is not
  "unmodular" — this one has clear seams, so the score reflects real structure.

### Separation of concerns — **8/10**
*A 10 here:* routes route, controllers translate HTTP, services hold rules,
repositories own persistence, with no leaks across.
- Held cleanly almost everywhere; controllers do shape checks and delegate.
- Leak 1: the repository owns the circuit breaker and the in-memory fallback —
  a *reliability policy* living in a persistence adapter (`P2-03`).
- Leak 2: `interview.controller.ts` re-implements the UUID regex and the email
  regex that already exist in `validate.ts`, because the middleware DSL cannot
  express "array of UUIDs" — a real gap, honestly commented.
- *False positive checked:* the controller duplication is 3 lines and locally
  justified; not padded into an architecture finding.

### Cohesion — **7/10**
*A 10 here:* each file has one reason to change.
- `utils/` is genuinely cohesive: `jwt`, `encryption`, `appError`, `logger`,
  `promptBuilder` each do one thing.
- `interview.service.ts` has at least four reasons to change (lifecycle,
  provider policy, scoring math, prompt digest shape).
- `interview.repository.ts` has two (persistence, and outage policy).

### Coupling — **8/10**
- Services depend on repository *instances*, not Prisma. The AI layer depends on
  `config`, not on `process.env`.
- The one tight coupling is intentional and documented: `server.ts` subscribes to
  `interviewEvents` exactly once, with a comment explaining why per-connection
  subscription would leak duplicate emits. That comment is a good example of the
  codebase's overall standard.

### Architectural consistency — **6/10**
*A 10 here:* one obvious place for each kind of thing.
- Two parallel trees exist: `src/http/**` (live) and `src/routes|controllers|
  middleware|interfaces` (emptied stubs), plus `src/services/interview.service.ts`
  alongside `src/services/interviewService.ts`. Fifteen files, five duplicated
  exclusion lists (`P5-02`).
- Two filename conventions coexist (`dot.case` in `http/`, `camelCase` in
  `services/ai/`).
- Two logging systems (`P5-01`).
- *False positive checked:* the stubs are excluded from build, lint, test and
  image, so this is maintainer friction, not a runtime defect — scored as such.

---

## Cluster 2 — Comprehension

### Readability — **9/10**
Consistent formatting (Prettier), short methods outside the two large files,
meaningful control flow. `runWithProviderChain` reads clearly despite doing
something genuinely intricate.

### Naming — **9/10**
`getOwnedSession`, `isStillInFlight`, `_maybeRefreshAggregateScore`,
`runWithProviderChain`, `persistProviderSwitch` — each says what it does and, in
the `_maybe` case, that it might do nothing. `attachUserIfPresent` versus
`requireAuth` names the exact distinction that matters. Minor: `historyEmail` is
easy to mistake for an account email; `SessionData` vs `AnswerData` vs
`EvaluationData` are fine but generic.

### Complexity — **6/10**
- `endSession` is the hot spot: bounded wait, re-fetch, placeholder backfill,
  second re-fetch, branch on answered-count, provider chain, score override,
  final write. Roughly seven interacting concerns in one method, and it is
  **untested** (`P3-02`).
- `_renderQuestionItems` in `uiManager.js` computes six boolean states
  (`isProcessing`, `hasScore`, `isFailed`, `isStructured`, …) then branches five
  ways. Correct, well-commented, and hard to change safely.
- *False positive checked:* a long-but-flat function often reads better than eight
  small ones. `endSession` is not flat — it re-reads state three times and the
  branches interact — so this is a real finding, not a length complaint.

### Documentation — **9/10**
The strongest dimension. Non-obvious decisions carry a rationale, most of them
naming the bug being prevented (`server.ts`'s subscription comment, the
`interview.routes.ts` note on why `/history` must precede `/:sessionId`,
`config.ts`'s explanation of the Groq TPM ceiling). `docs/` holds four genuine
design records. Two deductions: `Agent.md` describes a different project
(`P7-03`), and `socketManager.js` documents an auth rule the server no longer
enforces (`P7-02`) — stale docs that mislead cost more than absent ones.

---

## Cluster 3 — Change safety

### Testability — **7/10**
The seams are excellent: `createApp()` is importable, the AI factory returns
fresh instances, `interviewEvents` is injectable in spirit, and the Prisma mock
strategy is clever. The rating is about what is *done* with them — see below.

### Error handling — **7/10**
- `AppError` + `isOperational` + one global handler is the right shape, applied
  consistently; the factory helpers (`badRequest`, `notFound`, …) are used.
- `_evaluateAndPersist` is careful: it never rejects, always writes a placeholder
  on total failure, and `submitAnswer` adds a belt-and-braces `.catch()` with a
  comment explaining that an escaping rejection would crash the process.
- Deductions: upstream bodies reach clients (`P2-04`); a write that persisted
  nowhere is reported as success (`P1-03`); every repository `catch` treats all
  errors identically (`P2-03`).

### Duplication — **7/10**
- **Real** (must change together): the exclusion list in five config files
  (`P5-02`); the UUID v4 regex in three files (`validate.ts`,
  `interview.controller.ts`, `interview.socket.ts`); the model list in
  `interview.controller.ts` and again as a fallback in `uiManager.js`.
- **Not real** (checked and excluded): the three provider services look near
  identical but differ in URL, auth header, body shape and error mapping —
  collapsing them would add a configuration abstraction to save little, and the
  shared parts are *already* extracted into `baseService`. The eight
  `try/catch → markDbDown → memory` blocks in the repository are one policy
  expressed eight times; that is `P2-03`'s finding, not a duplication finding.

### Abstraction quality — **9/10**
`BaseAIService`/`AIFactory` is a well-judged abstraction: it earns its keep, and
the per-request-instance rule is enforced structurally (`readonly` fields set in
the constructor) rather than by convention — with a class comment naming the
concurrency bug it replaces. `runWithProviderChain` collapses four duplicated
try/catch/fallback blocks into one policy. `validateBody`'s rule DSL is small and
stops short of over-generalising. Nothing here is speculative.

---

## Cluster 4 — Sustainability

### Dependency usage — **9/10**
Twelve runtime dependencies, all mainstream, all actually used. Notably
restrained: a hand-rolled 45-line logger and a 200-line markdown renderer instead
of pulling in winston and marked+DOMPurify — both are the right call at this size
and both are documented as deliberate. `uuid` is used where `crypto.randomUUID`
would now do, but that is a preference, not a finding.

### Technical debt — **6/10**
Debt is **visible and labelled**, which is the good version of debt: every stub
file names the `git rm` that removes it, the in-memory fallback explains itself,
the JWT trade-off names its alternative. What lowers the score is that the labels
have not been acted on, and one debt item (`P5-02`) has spread its cost into five
config files.

### Maintainability — **7/10**
A new contributor could find their way around quickly thanks to the comments and
the layering. Three things would slow them down or bite them: no CI to catch a
mistake (`P3-01`), no tests over the most intricate code (`P3-02`), and two
parallel directory trees to disambiguate (`P5-02`).

---

## Summary

| Cluster | Score | The question it answers |
|---|---|---|
| Structure | **7.4** | Can this be changed in parts? — Yes, once the duplicate tree is gone. |
| Comprehension | **8.3** | Can someone else understand it? — Yes; this is the project's strength. |
| Change safety | **7.5** | Can it change without breaking? — Only outside `interview.service.ts` and `interview.repository.ts`. |
| Sustainability | **7.3** | Can this continue for years? — Yes, once CI exists and the labelled debt is collected. |

**The pattern across all four clusters:** design and communication are strong;
verification is the gap. Every P1 in this backlog lives in the two files with no
tests, and nothing automated would catch a regression in them. Fixing `P3-01`
(CI) and `P3-02` (characterization tests) raises Change safety and Sustainability
together and is the prerequisite for safely fixing anything else.
