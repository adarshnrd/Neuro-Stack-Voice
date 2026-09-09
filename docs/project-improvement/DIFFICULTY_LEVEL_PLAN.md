# Difficulty Level Plan

Status: **implemented** (approved via "Lets implement this plan."). See
§5 for exactly what was built and the defaults chosen for the three open
questions below.

Adds an explicit interview level to the setup page, and makes that level
change what the AI asks, how deeply it analyses each answer, and how
strictly it scores — with the top level getting genuinely rigorous,
claim-by-claim verification rather than just "harder questions".

---

## 1. The levels

Four levels, matching the real progression a candidate practises against:

| # | Level | id | Experience | What this stage is actually about |
|---|-------|-----|-----------|-----------------------------------|
| 1 | Software Trainee | `trainee` | 0–1 yrs | Do the fundamentals hold up? Can they explain a concept in their own words and apply it once? |
| 2 | Software Engineer | `software_engineer` | 1–3 yrs | Can they build, debug and test real features, and avoid the common traps? |
| 3 | Senior Software Engineer | `senior_engineer` | 4–8 yrs | Do they reason about trade-offs, performance and failure modes, and own a service end to end? |
| 4 | **Staff / Principal Engineer** | `staff_engineer` | 8+ yrs | Can they hold a multi-system architecture in their head, reason about scale economics, and make defensible calls under ambiguity? |

**Why Staff / Principal as the fourth level.** The request was for the
final level to get deep, rigorous analysis, which only makes sense if the
level itself demands depth. Staff/Principal is the first rung where the
question stops being "do you know this" and becomes "what breaks at 100×,
what did you assume, and what would you do differently with half the
budget" — exactly the material that a claim-verification pass has
something to chew on.

Two alternatives, and why not:

- *Intern / Fresher below Trainee* — overlaps almost entirely with
  Trainee, and adds a level at the shallow end when the stated goal is
  depth at the deep end.
- *Tech Lead / Engineering Manager* — drifts into people, process and
  delivery. This is a technical interview simulator; a management level
  would be evaluated on things the app can't meaningfully score from a
  voice answer.

**Default: Software Engineer.** It is the most common case, and — see
§3 — its rubric is deliberately identical to today's, so the default path
behaves exactly as the app does now.

---

## 2. What changes per level

Level flows into all four AI call sites. None of them are level-aware today.

| Call site | Function | What the level changes |
|-----------|----------|------------------------|
| Question generation | `getQuestionsPrompt` (+ JD and extend variants) | Difficulty mix, topic scope, scenario share, expected answer length |
| Per-answer scoring | `getEvaluationPrompt` | Rubric weights, what earns full marks, score calibration, analysis depth |
| Final summary | `getFinalEvaluationPrompt` | Readiness verdict framed against *this* level's bar |
| Answer guidance | `getAnswerGuidancePrompt` | Model answer pitched at the level |

### 2.1 Question generation

| | Trainee | Software Engineer | Senior | Staff / Principal |
|---|---|---|---|---|
| Difficulty mix (easy/med/hard) | 60 / 35 / 5 | 25 / 55 / 20 | 5 / 45 / 50 | 0 / 25 / 75 |
| Scenario-based share | ≥ 10% | ≥ 30% | ≥ 50% | ≥ 70%, multi-part |
| Question character | Definitions, "what happens when…", reading a small snippet, one concept at a time | Implementation, debugging, testing, API shape, common pitfalls | Trade-offs, performance, failure modes, service design, "why *not* X" | Multi-system architecture, scale economics, migration under constraint, ambiguity, blast radius |
| Expected verbal answer | 30–60s | 1–2 min | 2–3 min | 3–4 min, structured |
| Explicitly *out of scope* | Internals, scale, trade-off essays | Org-wide architecture | — | — |

### 2.2 Evaluation rubric

The four rubric dimensions stay the same (nothing downstream has to
change). What moves is **how the 10 points are split** and **what earns
full marks**:

| Dimension | Trainee | Software Engineer | Senior | Staff / Principal |
|-----------|---------|-------------------|--------|-------------------|
| Theory depth | 3 | 3 | 3 | 3 |
| Practical application | 2 | 3 | 3 | 3 |
| Communication clarity | 3 | 2 | 1 | 1 |
| Completeness | 2 | 2 | 3 | 3 |
| **Total** | **10** | **10** | **10** | **10** |

Every level still totals 10, so `computeOverallScore` (which divides by
`completed.length * 10`) needs no change at all.

Note that **Software Engineer's split is exactly today's rubric** — the
default path is a no-op, which keeps this change safe to ship and keeps
old sessions comparable.

What "full marks" means shifts with the level:

- **Trainee** — the core concept is correct, explained in their own
  words, with one concrete example. Trade-offs, internals and scale are
  *not* expected and their absence must not cost points.
- **Software Engineer** — correct, plus how they'd actually implement or
  debug it, plus awareness of the common failure/pitfall.
- **Senior** — correct and practical, plus explicit trade-off reasoning,
  failure modes, and a clear "when I would *not* do this".
- **Staff / Principal** — all of the above at scale: stated assumptions,
  where it breaks first, blast radius, migration/rollback path, and cost
  or operational consequence.

### 2.3 Score calibration (the part that actually matters)

Without this, the model quietly scores everything against one absolute
bar and the levels become cosmetic. Each level's prompt carries explicit
anchors:

> Score against the bar for a **{level}**, not an absolute bar. The same
> answer is worth different scores at different levels.

| Score | Trainee | Software Engineer | Senior | Staff / Principal |
|-------|---------|-------------------|--------|-------------------|
| 9–10 | Correct, clear, with a real example | Correct + implementation detail + pitfalls | Correct + trade-offs + failure modes + limits | All that, at scale, with assumptions and blast radius stated |
| 6–8 | Right idea, thin example or shaky wording | Solid, missing one pitfall or edge case | Trade-offs present but shallow or one-sided | Sound design, but scale/failure reasoning underdeveloped |
| 3–5 | Partially right, key gap | Textbook answer with no practical grounding | Correct but no trade-off reasoning at all | Reads like a strong Senior answer — no systems-level reasoning |
| 0–2 | Fundamentally incorrect | Fundamentally incorrect | Fundamentally incorrect, or purely definitional | Fundamentally incorrect, or no architectural content |

The Staff row is the important one: a textbook-perfect fundamentals
answer that would be a 9 at Trainee is a **5** at Staff, and the prompt
says so in exactly those terms.

### 2.4 Deep analysis + verification at Staff / Principal

Only at `staff_engineer`, the evaluation prompt additionally requires:

1. **Claim verification pass** — extract each distinct technical claim
   the candidate made and mark it `correct` / `partially_correct` /
   `incorrect` / `unverifiable`, with a one-line correction where it's
   not correct. Capped at 5 claims to bound output size.
2. **Assumption audit** — which assumptions were stated, and which
   unstated ones were load-bearing.
3. **Follow-up challenge** — the single question a real Staff interviewer
   would push back with next ("you said X — what happens at 10× write
   volume?").
4. **Failure analysis** — where the proposed approach breaks first, and
   at what scale.
5. A longer, explicitly structured `betterAnswer`.

This needs two **optional** additions to `EvaluationResult` /
`EvaluationData`:

```ts
claimVerification?: { claim: string; verdict: string; correction?: string }[];
followUpChallenge?: string;
```

Both default to empty in the validator and are only rendered when
present — the same additive, legacy-safe pattern the structured
evaluation fields already use. Nothing about the other three levels
changes.

**Token budget note.** Staff-level evaluation is the largest prompt *and*
the largest response in the app. Groq reserves
`GROQ_MAX_COMPLETION_TOKENS` (4096) per call against a TPM cap that can
be as low as 8000 — so the caps above (5 claims, existing study-point
limits) aren't cosmetic, they're what keeps a Staff evaluation inside one
call's budget. Worth watching after rollout.

### 2.5 Final summary and answer guidance

- **Final summary** gains a readiness verdict phrased against the level:
  "ready for a Senior interview / borderline / not yet", rather than a
  free-floating judgement.
- **Answer guidance** (the "How would I answer this?" button) pitches its
  model answer at the same level — a Trainee gets a clean explanation, a
  Staff candidate gets an architecture sketch with trade-offs.

---

## 3. Implementation

### 3.1 Single source of truth

One config module — `src/config/difficultyLevels.ts` — exporting a frozen
map of level id → `{ id, label, experience, blurb, difficultyMix,
scenarioShare, rubricWeights, fullMarksDescriptor, scoreAnchors,
deepVerification: boolean }`. Every prompt builder, the API allowlist, and
the client's rendered picker all read from this one place, so a level's
definition can never drift between the question prompt and the scoring
prompt.

### 3.2 Persistence

Add to `prisma/schema.prisma`:

```prisma
difficultyLevel String @default("software_engineer")
```

An additive, defaulted column — safe migration, existing rows land on the
default. Touch points: `toSessionData`, `toHistorySummary` (so history
rows can show the level), `createSession`'s data block, `updateSession`'s
`updatableFields` whitelist, `SessionData` in `src/types/index.ts`, and
`MockSessionRecord` in `tests/helpers/mockPrisma.ts`.

Storing it in an existing JSON column was considered and rejected — none
of them (`questions`, `answers`, `evaluations`, `interviewContext`) is a
natural home, and `finalEvaluation` only exists after completion.

### 3.3 API

Mirror the existing `TECH_STACKS` / `AI_MODEL_IDS` pattern exactly:

- Export `DIFFICULTY_LEVELS` / `DIFFICULTY_LEVEL_IDS` from the controller.
- Validate `difficultyLevel` on `POST /start` with `oneOf` in
  `interview.routes.ts`.
- Serve the list (id, label, experience, blurb) from `GET /config` so the
  client renders from the same source rather than hardcoding labels.

The allowlist is not optional: this string flows into every prompt, and
the same reasoning as `[P3-05]` (techStack) and `[P2-02]` (model) applies.

### 3.4 Level plumbing

`startSession` stores it. `extendSession`, `_evaluateAndPersist`,
`endSession`'s final digest, `refreshOverallFeedback` and
`getAnswerGuidance` all read it back off the session, so added questions
and later re-scoring stay at the level the interview was started at.

Every prompt builder takes `level?: DifficultyLevel` and falls back to
`software_engineer` when absent — which is what makes pre-existing
sessions render and score exactly as they do today.

### 3.5 How the user selects it

A dedicated **Interview Level** block, full width, directly under the
existing `.setup-grid` (a fourth dropdown in a three-column grid would
sit awkwardly, and these levels need a line of explanation each):

- Four selectable cards in a radio group — title, experience band, and a
  one-line "what this tests".
- Software Engineer preselected and marked *Recommended*.
- Keyboard and screen-reader accessible (`role="radiogroup"`, arrow-key
  navigation), matching how the rest of the setup panel behaves.

This needs new CSS in `public/css/style.css`. That file isn't in this
sandbox — it's on the device and would need staging first (one call,
~46 KB). If you'd rather avoid touching the stylesheet at all, the
fallback is a fourth `<select>` in the existing grid plus a live
`.field-hint` line describing the selected level — zero new CSS, but a
weaker picker.

**Where the level shows up afterwards**, so scores are never silently
compared across levels:

- A badge on the interview panel, next to the existing stack badge.
- On the completion page, next to the overall score.
- On each history row, next to the tech stack.

**JD mode.** The level stays an explicit choice even when a job
description is pasted — both feed the prompt, and the JD prompt gets the
same level instructions as the standard one.

### 3.6 Phasing

1. **Data + API + UI, no prompt changes.** Level is chosen, stored,
   displayed. Behaviour identical to today. Safe to ship alone.
2. **Question generation + evaluation rubric wiring.** The levels start
   to mean something.
3. **Staff-level deep verification.** New optional fields, prompt, and
   the UI sections that render them.
4. **Display polish.** History badges, level-aware comparisons.

### 3.7 Tests worth adding

- Rejects a level outside the allowlist (400).
- Missing level defaults to `software_engineer` and produces today's
  exact rubric.
- Rubric weights sum to 10 for every level (guards against a typo in the
  config silently rescaling scores).
- A session created at one level keeps that level through extend and
  refresh.
- Staff-only fields absent at other levels; present-but-empty parses
  cleanly.

---

## 4. Open choices (resolved — see §5)

1. **Fourth level** — Staff / Principal Engineer as recommended above, or
   something else.
2. **Picker style** — radio cards (needs `style.css` staged) vs. a fourth
   dropdown (no CSS).
3. **Phasing** — ship phase 1 on its own first, or do 1–3 in one go.

---

## 5. Implementation record

Approval ("Lets implement this plan.") arrived without answers to the
three open choices above. Rather than re-block on them, this pass went
with the plan's own stated recommendations, so all four phases (§3.6)
landed together in one pass:

1. **Fourth level: Staff / Principal Engineer** — built exactly as
   specified in §1, including the deep-verification extension in §2.4.
2. **Picker style: radio cards** — `public/css/style.css` was staged from
   the device and the full card picker (keyboard/ARIA `radiogroup`,
   *Recommended* badge on Software Engineer) was built, not the
   fallback `<select>`.
3. **Phasing: all at once** — data model, API, prompts, rubric, deep
   verification, and display polish (badges on the interview/completion/
   history views) shipped together rather than as separate increments.

### What changed, by layer

- **Config**: new `src/config/difficultyLevels.ts` — single source of
  truth for all four levels' mix/rubric/anchors, consumed by both the
  prompt builders and the API's `oneOf` allowlist. A module-load-time
  check throws if any level's rubric weights don't sum to 10.
- **Data model**: additive `Session.difficultyLevel String @default
  ("software_engineer")` in `prisma/schema.prisma` — existing rows are
  unaffected and read back as Software Engineer.
- **Backend plumbing**: `resolveDifficultyLevel()` is the single
  fallback path every read goes through (`interview.repository.ts`,
  `interview.service.ts`); `POST /api/interviews/start` accepts an
  optional `difficultyLevel` validated against the same allowlist;
  `GET /api/interviews/config` now returns `difficultyLevels` for the
  frontend to render the picker from.
- **Prompts**: `promptBuilder.ts`'s four call sites (§2) all take an
  optional `level`/`levelId` param and fall back to Software Engineer
  when absent, exactly as §3.4 describes. Staff/Principal additionally
  appends the claim-verification instructions and JSON fields from §2.4,
  gated on `level.deepVerification`.
- **Frontend**: `uiManager.js` renders and drives the radio-card picker
  (`populateLevelPicker`, roving-tabindex keyboard nav, `getSelectedLevel`
  /`getLevelLabel`) and the level badges on the interview, completion,
  and history views; `app.js` wires `startInterview()` to send the
  selected level and `showCompletion`/history rendering to display it.
- **Tests**: existing test factories that construct `SessionData` /
  `MockSessionRecord` literals directly were updated to include
  `difficultyLevel` (required by the now-updated types), so the
  pre-existing suite keeps compiling under `ts-jest`.

### Verification performed in this sandbox

This sandbox has no `npm`/`tsc`/test runner, so verification was manual:
careful tracing that every `SessionData`/`MockSessionRecord` construction
site got the new required field, that `resolveDifficultyLevel` is used on
every read path, and that Software Engineer's rubric weights are
byte-for-byte identical to the pre-feature rubric (so `computeOverallScore`
and old sessions are unaffected). `node --check` was run against both
modified frontend files (`public/js/uiManager.js`, `public/js/app.js`).
Running the real test suite (`npm test`) and a TypeScript build on the
device (where `npm`/`tsc` are available) is the recommended next step
before this ships to production.
3. **Phasing** — ship phase 1 on its own first, or do 1–3 in one go.
