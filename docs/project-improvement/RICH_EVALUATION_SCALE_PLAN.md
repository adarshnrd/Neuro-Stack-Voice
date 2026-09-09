# Plan: Structured Per-Question Evaluation + a Final Summary That Actually Scales to 20-30+ Questions

Status: **PLANNING COMPLETE — all open questions decided (§9); nothing
in this doc is implemented yet.** This extends and, on one point,
supersedes item A of
`docs/project-improvement/EVALUATION_PIPELINE_PLAN.md` (that doc flagged
the same final-call problem more briefly; this one covers your full spec
in detail, verified line-by-line against the live code, not guessed).

## 0. Short answer: yes, this is fully possible — and most of the hard part is already built

Your spec describes an architecture in real detail. Going through it
against the actual code, the core hard-won piece — decoupled, non-blocking,
per-answer background evaluation that never makes the user wait — is
**already built correctly**, from an earlier round of this project. What's
genuinely missing is: far richer structured output per question (you want
distinct good/missing/improve/study-prep fields, today it's one blended
write-up), an explicit status lifecycle, consistent logging, and — this is
the one piece that actually matters for the "don't blow context limits"
concern you raised — **the interview's final summary call currently does
exactly the thing you're warning against**: it sends the full raw
transcript in one shot. That's real, not hypothetical, and I can quantify
why it's a genuine risk at 20-30 questions using numbers from this same
session (see §2).

## 1. Your requirements, one by one, against what's actually live today

**"Each answer evaluated independently in the background"** — already
true. `submitAnswer` persists the answer synchronously (fast DB write),
acks it back immediately, and fires evaluation in the background,
unawaited (`_evaluateAndPersist` in `interview.service.ts`).

**"User shouldn't wait; next question shown immediately"** — already
true. The client advances on the fast `answer:received` ack, never on the
evaluation result. This was a deliberate fix from an earlier round
(previously it did block on every question — the code comments there are
explicit about never regressing that).

**Steps 1-7 of your expected flow** — already true, end to end, exactly as
you described them: question shown → answer submitted → saved
immediately → background eval triggered → next question shown without
waiting → repeat → by the end, most/all answers already have their
evaluation.

**"By completion, most/all answers already evaluated"** — already true,
with one refinement worth knowing: at "End Interview" there's a bounded
catch-up wait (currently a flat 15 seconds, `END_SESSION_EVAL_WAIT_MS`)
for anything still in flight, so the summary reflects as much real
scoring as possible rather than gaps.

> **Superseded (see the "Not Scored" fix):** the flat 15s clock-based wait
> and `END_SESSION_EVAL_WAIT_MS` are gone. `endSession` now waits for every
> in-flight evaluation to actually settle — bounded naturally by
> `runWithProviderChain` exhausting every configured provider (each capped
> by its own ~120s request timeout), not by an arbitrary outer clock. A
> placeholder now only appears when every provider genuinely failed for
> that question, not because the wait ran out early.

**Evaluation content — question, answer, detailed review, what was good,
what was missing, improvement areas, suggested answer, study/prep
points** — **partially true, and this is the biggest real gap.** The
question and answer are already retrievable (joined by id from the
session's own records). A detailed write-up and a suggested/ideal answer
already exist — but as **one blended markdown block** (`feedback`) plus
one separate field (`betterAnswer`), not the distinct
good/missing/improve/study-points fields you're describing. The AI is
already instructed to structure that markdown with headings and bullets,
so the *information* is often already in there in prose form — but it's
not stored or retrievable as separate fields. See §3 for the proposed
fix.

**"Stored as part of history, retrievable later"** — already true.
Evaluations live in a JSON column on the session row (`Session.evaluations`
in Postgres via Prisma), already surfaced through the history and
detail views.

**"Do not evaluate everything only at the end"** — true for per-question
scoring, **false for the final summary.** `endSession` makes one
additional AI call, `evaluateInterview(qaPairs)`, where `qaPairs` is
**every question and every answer's full text, in one prompt.** This is
the literal thing your spec warns against, and it's the one place in the
whole pipeline where scale genuinely breaks today. See §2.

**Your sync/async flow diagram** ("submit Answer 1 → save → trigger bg
eval → show Q2 → eval finishes → store → submit Answer 2 → ...")* —
matches the live code exactly, no gap here.

**"Even if evaluation still processing when interview finishes, don't
lose it — keep processing, update history when done"** — true at the
per-question level, and this one surprised me pleasantly when I checked
it: `endSession`'s bounded wait doesn't cancel anything still running in
the background — those promises keep going on their own. And
`recordEvaluation` in the repository already **replaces by questionId**
rather than blindly appending, specifically so a late real result can
supersede an earlier "not scored in time" placeholder without creating a
duplicate. That part of your spec is already solved. **What's not
solved**: the interview's *aggregate* `finalEvaluation.overallScore` is
computed once, at the moment "End Interview" runs, and never revisited —
so if a late per-question score lands afterward, that individual question
correctly updates, but the overall number can go stale relative to it.
See §6.

**Reliability/logging checklist**, going through each line of yours:

| Requirement | Status |
|---|---|
| Every answer saved before triggering AI | ✅ already true |
| AI failure doesn't block continuing the interview | ✅ already true |
| Background processing can retry failed requests | ⚠️ partial — see below |
| Clear status: pending/processing/completed/failed | ❌ not built — only inferred from field presence + a boolean flag |
| Proper logs for every AI request/response | ⚠️ partial — see below |
| Errors captured with enough detail to debug | ⚠️ partial — see below |
| Duplicate evaluations avoided on retry | ✅ already true |
| User never blocked waiting on AI | ✅ already true |
| App keeps working if AI is temporarily down | ✅ already true (placeholder + fallback path) |
| Scalable to 20-30+ questions | ✅ per-question path, ❌ final summary call (§2) |

**Retry, decided**: no scheduled background sweep. Instead, extend
today's chain: 2 retries against the current provider (already true),
then on failure move to the *next* configured provider and repeat that
same "2 retries then move on" pattern — continuing until every provider
you have configured (e.g. Groq → Gemini → NVIDIA) has been tried, not
just one fallback as today. Only once every provider is exhausted does it
count as a genuine permanent failure. This is a same-request-lifecycle
change to `aiFactory`'s fallback chain, not new infrastructure — nothing
needs to run on a schedule. See §8 for where this lands in the build
order.

**Logging, decided**: metadata only, always — see §5.

## 2. The one real architectural gap: the final summary call, quantified

`getFinalEvaluationPrompt` (in `promptBuilder.ts`) embeds the entire
transcript as `JSON.stringify(qaPairs, null, 2)` — every question, every
answer, pretty-printed, in one prompt. For a 20-30 question interview with
real (often voice-transcribed, sometimes verbose) answers, this is not a
small ask.

Here's why this isn't hypothetical: earlier in this same session, we
found and fixed a real bug where Groq's `openai/gpt-oss-120b` model has an
**8000 tokens-per-minute** cap for your org, and it counts the *reserved*
output budget against that cap before generating anything — which is why
every call was failing with 413 until `max_completion_tokens` was lowered
to 4096. That leaves roughly **3,900 tokens of headroom for the prompt
itself** on a Groq call. A 25-30 question transcript, each with a
substantive answer, can very plausibly exceed that on its own — meaning
the exact 413 we just fixed for question generation and per-answer
evaluation could resurface at the finish line of a long interview,
specifically because that one call still does what your spec is asking us
not to do.

**Proposed fix**: the final call should never need the raw transcript at
all. Every per-question evaluation already produces a score and (proposed
in §3) a topic and a short structured writeup — build a **compact digest**
from that (topic + score + one line each, not full Q&A text) and feed
*that* into the final synthesis call instead. The digest's size scales
with question *count*, not with how much any individual candidate said,
and stays small even at 30 questions. The numeric `overallScore` already
doesn't need an AI call at all — it's a plain average of the individual
scores (already correct, already scale-proof) — so this change is purely
about shrinking the input to the narrative-writing call.

## 3. Proposed richer per-question evaluation shape

No database migration needed for any of this — `Session.evaluations` is
already a Prisma `Json` column (not a fixed relational schema), so this is
purely a TypeScript/prompt change, not a schema change:

```ts
interface EvaluationData {
  questionId: number;
  status: 'pending' | 'processing' | 'completed' | 'failed'; // see §4
  score?: number;
  summary?: string;            // short overall take on this answer
  strengths?: string;          // what was good
  gaps?: string;                // what was missing or incorrect
  improvementAreas?: string;   // where/how to improve
  betterAnswer?: string;       // suggested ideal answer (already exists today)
  studyPoints?: string[];      // concepts/topics to prepare further
  unavailable?: boolean;       // kept for backward-compat with existing data
  provider?: string;           // which provider actually produced this result
  evaluatedAt?: string;        // timestamp, mainly for logging/debugging
}
```

**Decided**: fully separate structured fields, as shown above — not the
cheaper "keep one markdown blob" alternative that was on the table. This
is the bigger change of the two options — new prompt structure, new
storage shape, new rendering on both the completion screen and the
history detail view — but it matches what you described precisely and
lets the app do things a blended blob can't (e.g. show "study points" as
its own list across the whole interview, or filter/search on "gaps"
later).

## 4. Status lifecycle

Formalizing what's currently only implicit:

`pending` (answer saved, evaluation not yet started) → `processing` (AI
call in flight) → `completed` (evaluation stored) or `failed` (both
providers exhausted, or it never finished before the interview ended and
the wait timed out). This replaces today's single `unavailable: true`
boolean with something that actually distinguishes "still working on it"
from "gave up" — useful both for a future live indicator (see the earlier
plan doc's item B) and for logging/debugging.

## 5. Logging plan

**Decided**: metadata only, always — no opt-in debug flag, no candidate
answer text or full request/response bodies ever logged. On every AI
call, log `sessionId`, `questionId` (where applicable), `provider`,
`model`, call type (`questions` / `answer-eval` / `final-eval`),
duration, and outcome (success/failure). **On failure specifically, log
in detail** — the actual upstream error text/status code (already fixed
for Gemini to stop discarding this), which retry attempt it was, and
which provider is next in the chain (per §1's decided retry behavior) —
enough to diagnose *why* something broke without ever needing the
candidate's actual words. Route all of this through the existing
`logger` utility consistently, replacing the current mix of raw
`console.*` calls scattered through the AI service files.

## 6. Keeping the aggregate score honest after a late arrival

**Decided** — your refinement of the original two-option framing, which
is more precise than either option alone:

- **`overallScore` is always kept mathematically up to date.** Whenever a
  background evaluation lands — including after the session is already
  `completed`, replacing an earlier placeholder (already handled
  correctly per-question, per §1) — recompute and persist `overallScore`
  immediately. Cheap, deterministic, pure math, no AI call.
- **Only `completed` evaluations contribute to that average.** A
  `pending`/`processing`/`failed` question is excluded from the
  denominator entirely, not counted as 0 — so, e.g., `(80+90+70)/3 = 80`
  while Q3 is still pending, not `(80+90+0+70)/4 = 60`. Once Q3 lands at
  85, it becomes `(80+90+85+70)/4 = 81.25`. This is a real behavior
  change from today — worth confirming exactly how today's `unavailable:
  true` placeholders are currently folded into the average during
  implementation, since this is the case it fixes.
- **`overallFeedback` (the narrative) is not auto-regenerated** on a late
  arrival — that would mean an extra AI call, extra latency, extra
  rate-limit consumption, and a real risk of inconsistent narratives if
  two evaluations land close together. It's left as-is by default.
- **New fields: `overallFeedbackStatus`** (`'generated' | 'stale'`), plus
  `evaluationsCompleted` / `evaluationsTotal` alongside it. When a late
  evaluation arrives after the narrative was already written, the
  narrative is marked `stale` instead of silently going out of sync with
  the (now-current) score — the UI can surface something like "Overall
  feedback was generated before the final evaluation was available."
- **A manual "Refresh overall feedback" action** — not automatic — is the
  only path that re-runs the narrative AI call, only when the user
  actually asks for it, not on every straggler.

None of this needs a schema migration — `finalEvaluation` is already a
`Json` column, so `overallFeedbackStatus` / `evaluationsCompleted` /
`evaluationsTotal` are just new keys in that same object.

## 7. What does NOT need to change

- The decoupled, non-blocking per-question flow — already correct, this
  is the foundation everything else sits on top of and nothing here
  touches it.
- Duplicate-avoidance — already correct (`recordEvaluation`'s
  replace-by-questionId, plus `submitAnswer`'s existing guard against
  answering the same question twice).
- No Prisma schema migration for any of this — everything above is JSON
  shape changes on columns that already exist.

## 8. Build order

**Decided**: the order below — fix the concrete production risk first,
land the small mechanical foundations next, then the larger feature, then
lower-risk hygiene last.

1. **Final-summary digest redesign (§2)** — the actual "don't blow
   context/rate limits" fix, and the most urgent given it's the one place
   scale genuinely breaks today.
2. **Status lifecycle (§4) + full-provider retry chain (§1)** — both
   small, mechanical, and everything else benefits from having real
   status tracking and "tried every provider before giving up" in place
   first.
3. **Structured evaluation fields (§3)** — the bigger prompt/storage/UI
   change: fully separate fields, decided above.
4. **Aggregate score / feedback-status handling (§6)** — depends on the
   status lifecycle from step 2 being in place.
5. **Logging (§5)** — can land alongside or after any of the above; no
   dependency on the others.

## 9. Decisions

All five questions are now settled — nothing left open before build
starts:

1. ~~**§3** — fully separate structured fields or keep one markdown
   write-up, just formalized?~~ **Decided: fully separate structured
   fields.**
2. ~~**§5** — metadata-only logging, or also full request/response text
   behind an opt-in debug flag?~~ **Decided: metadata only, always — but
   detailed error/status logging on failure so problems are easy to
   diagnose. No debug flag, never candidate answer text.**
3. ~~**§1's retry question** — 2 retries + 1 fallback then permanently
   failed, or a scheduled background sweep?~~ **Decided: no scheduled
   sweep. Retry 2× on the current provider, then move to the next
   configured provider and repeat, cycling through every provider before
   it counts as permanently failed.**
4. ~~**§6** — auto-refresh just the score, or also the narrative?~~
   **Decided: `overallScore` always auto-recomputed from completed
   evaluations only (never treating pending/failed as 0); narrative
   (`overallFeedback`) is not auto-regenerated — tracked via a new
   `overallFeedbackStatus` (`generated`/`stale`) field, refreshed only by
   an explicit manual action.**
5. ~~**Priority** — §8's order, or different?~~ **Decided: §8's order,
   updated above to slot in the full-provider retry chain alongside the
   status lifecycle.**

Now that every open question is resolved, the next step is implementation
— the same way the email-history feature went: build it, verify it
doesn't regress anything in §7, and report back plainly, including
telling you directly if anything turns out to be more involved than
expected rather than quietly leaving it half-done.
