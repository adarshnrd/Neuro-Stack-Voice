# Plan: Question/Answer Evaluation Pipeline — Current State & Improvements

Status: **PLANNING — nothing in this doc is implemented yet.** This is the
"what we do today, here's what could be better" writeup you asked for.
Nothing described in §3 has been built; §1 and §2 are a factual account of
what's live right now, verified directly against the current code (not
from memory of earlier rounds).

## 1. Your question, answered directly

> asking user question, gathering user input, keeping that... at final
> question providing that once and all to get feedback for all questions,
> or still doing one question at a time?

**Neither, exactly — it's a hybrid, and each half is intentional:**

- **Questions**: all of them (10 for a normal interview, 15 for a
  Job-Description interview, or however many you configure) are generated
  in **one single AI call, upfront, before the interview starts.** Not one
  at a time. This is what makes "Extend Interview" and instant question
  navigation possible — the next question's text is already sitting in
  the session record.
- **Answers/scoring**: this is where "one at a time" is half-true. Every
  answer you submit is scored **individually, immediately, in the
  background** — not batched to the end. But it's decoupled from the
  interview itself: the app does **not** wait for that score before
  letting you move to the next question. You answer Q1, the app instantly
  shows Q2, and Q1's score/feedback arrives silently a few seconds later
  over the socket connection.
- **At the very end** ("End Interview"), there's a **second, additional**
  AI call — a holistic one, fed the full transcript (every question +
  every answer, as plain text) — to produce one overall narrative
  ("strengths, gaps, readiness for the role," etc.). So you get both:
  a score+feedback+"better answer" for every individual question *and*
  one combined write-up at the end.

So concretely: question generation is batched-upfront, scoring is
per-answer-immediate-but-non-blocking, and there's a final holistic pass
on top of both. None of the three phrasings you offered ("ask, wait,
repeat" / "collect everything, evaluate once at the end") is quite it —
it's closer to "ask once for everything, score each answer as it comes in
without ever making you wait, then synthesize a summary at the end."

## 2. Exactly how that works today (verified against the live code)

**Start** (`interview.service.ts: startSession`): one call to
`generateQuestions(techStack, count)` returns the full question list
before the interview begins. If the primary AI provider fails, it falls
back to a different one automatically and the interview starts anyway
(this part already existed from an earlier round).

**Per answer** (`submitAnswer` / `_evaluateAndPersist`): the answer text
is saved synchronously (fast — just a DB write) and acknowledged back to
the client immediately via the `answer:received` socket event. That event
is what the client waits on to advance — **not** the AI score. Scoring
that question (`evaluateAnswer(question, answer)`) is fired in the
background, unawaited, with its own primary→fallback retry logic
identical to question generation. When it finishes (however long that
takes), the result is pushed to the client via `answer:evaluated`. The
client currently does nothing visible with that event mid-interview — it
just records it in memory (`this.evaluationResults[questionId] = ...`) for
later. This silence is a deliberate, documented decision from an earlier
round, not an oversight — but the code comment explicitly leaves the door
open: *"kept only in case future UI wants a live indicator."*

**End Interview** (`endSession`): before doing anything else, it waits —
up to `END_SESSION_EVAL_WAIT_MS` (default 15s) — for any answers whose
background scoring hasn't landed yet, so the summary reflects as much real
scoring as possible instead of empty gaps. Anything still not scored after
that gets a placeholder ("Scoring wasn't ready when the interview ended").

> **Superseded (see the "Not Scored" fix):** `END_SESSION_EVAL_WAIT_MS` and
> the fixed 15s clock are gone. `endSession` now waits for every in-flight
> evaluation to genuinely finish — the real bound is however many AI
> providers are configured × each one's own ~120s request timeout inside
> `runWithProviderChain`, not an arbitrary outer clock. The
> "wasn't ready in time" placeholder is now reserved for the rare case
> where there's no in-flight promise to even wait on at all (e.g. lost
> across a process restart); a question whose evaluation genuinely
> exhausted every provider gets the separate "we weren't able to get AI
> feedback for this question" state instead, with an on-demand "How would
> I answer this?" guidance button (see `getAnswerGuidance`).
Then it makes the one holistic call — `evaluateInterview(qaPairs)` — where
`qaPairs` is built as **just `{question, answer}` text pairs**, nothing
else. The AI's own opinion of the overall score is then **thrown away and
replaced** with a strict mathematical average of the individual
per-question scores, specifically for score consistency between the
per-question view and the summary view. Only the narrative *feedback*
text comes straight from that final AI call.

One thing worth knowing: there's already a richer data structure sitting
right there, `interviewContext` — an array of `{question, answer, score,
topic}` built up as each per-question evaluation lands — but today it's
used for exactly one thing: feeding "Extend Interview" so follow-up
questions don't repeat topics already covered. It is **not** passed into
the final holistic evaluation at all, even though the score and topic for
every question are already sitting right there when that call is made.

## 3. Gaps / opportunities (not yet built — this is the "what could be better" part)

**A. The final narrative ignores work already done.** `evaluateInterview`
gets raw `{question, answer}` text only — it has no idea what score or
feedback each answer already received, even though that's already
computed and already shown to the user per-question by that point. Two
consequences: the AI re-derives judgments it already made once (slower,
costs more, and can quietly disagree with itself — e.g. calling an answer
"strong" per-question but "a gap" in the summary), and the summary can't
reference *why* a particular topic scored low the way a human reviewing
both would.

**B. No visibility into scoring progress during the interview.** The data
(`evaluationResults`) is already being collected client-side for exactly
this purpose per that code comment, but nothing renders it. Someone on
Q4 has no way to know Q1's score already landed, or that Q2's is still
pending.

**C. The end-of-interview wait is a flat 15s regardless of how much is
outstanding.** A 15-question Job-Description interview with 4 answers
still scoring gets the exact same budget as a 5-question interview with
1 straggler — proportionally much less headroom per item.

**D. The end-of-interview loading screen is generic.** "AI is analyzing
your complete interview..." — no indication of what's actually happening
(e.g. "waiting on 2 of 10 answers to finish scoring" vs. "writing your
summary"), even though the server knows exactly which questionIds are
still outstanding at every point in that wait.

**E. Total-failure edge case at the very end is a hard stop.** If the
holistic call fails on *both* providers during `endSession`, the whole
thing throws a 503 — even though every individual per-question score
almost certainly already exists at that point. The interview is left
"active" with all its real scoring data sitting there, unreachable,
instead of completing with a clearly-labeled fallback summary.

## 4. Proposed approach (recommendation — not yet built)

1. **Feed `interviewContext` into the final evaluation prompt.** The data
   already exists and is already collected for a different purpose — this
   is mostly plumbing, not new data collection. Change
   `getFinalEvaluationPrompt`'s input from bare `{question, answer}[]` to
   include each item's already-known `score` and `topic`, so the AI is
   synthesizing from what's already been assessed instead of re-assessing
   blind. Low risk, no architecture change, the numeric `overallScore`
   math stays exactly as-is (already correct).
2. **Add a quiet, non-blocking per-question status badge** (e.g. a small
   dot/checkmark next to each question number: pending → scored) driven by
   the `evaluationResults` map that's already being populated client-side.
   Purely additive UI — doesn't touch the decoupled progression logic at
   all, and can be left out entirely if you'd rather keep the current
   silence (see the open question below — this was a deliberate choice
   before, so it's worth confirming rather than assuming).
3. **Scale the bounded end-of-interview wait with how much is actually
   outstanding**, instead of one flat timeout regardless of count (e.g. a
   per-item budget with a sensible ceiling), and **update the loading copy
   to reflect real progress** ("Waiting on 2 of 10 answers to finish
   scoring...") using data the server already has at that point.
4. **Make total final-evaluation failure gracefully degrade** instead of
   hard-503ing: complete the session with whatever per-question scores
   already exist plus a clearly-labeled "summary unavailable, see
   individual question feedback below" placeholder, rather than stranding
   a fully-scored interview in limbo because one last synthesis call
   failed on both providers.

## 5. Explicitly NOT proposing to change

- Per-question evaluation stays decoupled/non-blocking — this is correct
  and was hard-won in an earlier round; the interview must never wait on
  AI scoring mid-session again.
- Questions stay pre-generated upfront in one call, not one at a time —
  this is what makes instant progression and "Extend Interview" work.
- The strict mathematical average as the *numeric* overall score stays —
  only the narrative text's input is proposed to change (item 1 above).

## 6. Open questions for you before any of this gets built

- Item 2 (live per-question status badge) reverses a documented earlier
  decision to keep scoring silent mid-interview. Want it, or leave it
  silent as-is?
- Any preference on how "generous" the scaled end-of-interview wait
  (item 3) should be for a large JD interview (15 questions) vs. a small
  one — a hard ceiling either way, or scale unbounded with question count?
- Item 4's fallback summary copy — any specific wording you want for
  "summary unavailable" state, or fine with something plain and honest
  about what happened?

Once you tell me which of items 1-4 you want (all, some, or a different
priority order), I'll turn this into an implementation pass the same way
the email-history feature went — build it, verify it doesn't touch the
decoupled-scoring guarantees in §5, and report back before it's called
done.
