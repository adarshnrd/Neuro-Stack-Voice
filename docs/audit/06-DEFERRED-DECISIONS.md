# Deferred Decisions

Four items where the fix necessarily changes observable behavior, or where the
"right" answer is a product call rather than an engineering one. The prep work is
done below — options, costs, and what unblocks each. **None of these should be
implemented unilaterally.**

---

## 1. `P1-04` — Unverified email history lookup

**The situation.** Anyone can POST an email address and receive that email's
completed interview summaries. Session ids in that response can be opened via
`GET /api/interviews/:sessionId`, which returns the full transcript for any
session that has no owner. No password, no PIN, no emailed code.

This was **decided deliberately** and is documented in
`docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md` as Option B, with the trade-off spelled
out at four separate code sites. It is listed here so the decision is re-affirmed
knowingly before release, not because it looks like an oversight.

**What changed since that decision was made** — one thing worth knowing:
`listCompletedSessionsByEmail` filters on `historyEmail` and `status` only, **not**
on `userId: null`. So a session that has since been claimed by a real account
still appears in the summary list for an unauthenticated caller who knows the
email — leaking its existence, score, tech stack and timestamp. The transcript
itself is still protected (the detail fetch 404s for a non-owner), so the
exposure is partial. This looks like a gap in the implementation of the decision
rather than part of the decision, and closing it is safe under any option below.

### Options

| | What it does | Cost | What breaks |
|---|---|---|---|
| **A. Keep as-is, add explicit consent** | Add a line next to the "Returning?" input: *anyone who knows this email will be able to see these results*. Filter the query to `userId: null`. | ~1 hour | Nothing. The trade-off becomes informed rather than surprising. |
| **B. Optional PIN at session start** | If a visitor supplies `historyEmail`, also let them set a 4–6 digit PIN, hashed and stored on the session. Lookup requires email + PIN. | ~half a day; schema column; a PIN input on two panels; forgotten-PIN has no recovery path by design | Existing sessions have no PIN — decide whether they stay lookup-able (grandfathered) or become unreachable by email. |
| **C. Email verification code** | Send a one-time code before returning results. | Days; needs an email provider, deliverability, template, rate limiting, a new failure mode | The "no account needed" promise is effectively gone — this *is* an account. |

**Recommendation: A**, plus the `userId: null` filter. B is the honest middle
ground if the exposure is judged unacceptable; C contradicts the product's
anonymous-first premise, which the rest of the codebase is built around.

**Needs from you:** which option. **Blocks:** R-05.

---

## 2. `P1-01` — What should extending a *completed* interview do?

**The situation.** `extendSession` has no status guard. On a completed session it
sets `status: 'active'` and `finalEvaluation: null`, permanently destroying the
score and narrative. Whether this is a bug or an unfinished feature depends on
whether extend-after-completion is meant to exist at all.

### Options

| | What it does | Cost | What breaks |
|---|---|---|---|
| **A. Preserve and mark stale (recommended)** | Leave `finalEvaluation` intact; set `overallFeedbackStatus: 'stale'`; keep the session active for the new questions. | Small | **Nothing.** Reuses the exact mechanism `_maybeRefreshAggregateScore` already uses, and the client already renders a "refresh overall feedback" banner for `stale`. No client change, no data loss. |
| **B. Reject the extend** | 400 on a completed session, matching how `refreshOverallFeedback` guards its own precondition. | Smallest | **Breaking** for any client that offers "add more questions" on the completion screen. Check the UI before choosing this. |
| **C. Snapshot then clear** | Archive the old evaluation before nulling. | Schema change or a JSON history array | Nothing, but it is more machinery than the problem needs. |

**Recommendation: A.** It is the only option that both stops the data loss and
preserves current observable behavior.

**Needs from you:** confirmation that A matches the intended product behavior —
specifically, whether a re-extended interview should still show its previous
score while the new questions are unanswered. **Blocks:** R-02.

---

## 3. `P3-03` — Should anonymous visitors be able to validate their own API key?

**The situation.** The setup panel shows the key input and Validate button to
guests, but `POST /api/settings/api-key/validate` is behind `requireAuth`. A guest
with a perfectly valid key is told **"✗ Invalid API key"**. The key then works
anyway when they start the interview, because `/interviews/start` accepts
`userApiKey` anonymously. The app contradicts itself.

### Options

| | What it does | Cost | Consideration |
|---|---|---|---|
| **A. Open the validate route to anonymous callers** | Move `POST /validate` to `attachUserIfPresent`, keeping the existing 10/15min limiter. Save/status/delete stay authenticated. | Small | The endpoint is stateless — `validateKey` persists nothing. But it does spend an upstream Gemini call per request, so the limiter becomes the only guard for unauthenticated callers. |
| **B. Keep it authenticated; fix the message** | Client distinguishes 401 from `isValid: false` and shows "Sign in to validate this key". | Small | The guest is told the truth, but still cannot validate a key the app will happily use. |
| **C. Hide the key input from guests** | Remove the affordance entirely for anonymous users. | Small | Removes a feature guests can currently use successfully. |

**Recommendation: A.** It matches the anonymous-first design the rest of the app
commits to. B is acceptable if unauthenticated upstream calls are unwanted.

**Needs from you:** whether an anonymous caller may trigger a Gemini validation
request. **Blocks:** R-13 (P3-03 only).

---

## 4. `P3-04` — Is horizontal scaling in scope?

**The situation.** Three pieces of state are process-local: `pendingEvaluations`
(the map `endSession` waits on), `memoryStore`, and `dbUnavailableUntil`. At one
instance everything works. At two or more, `endSession` on replica B cannot see
evaluations running on replica A, so it stops waiting and writes
`status: 'failed'` placeholders for answers that are being scored perfectly well
elsewhere — surfacing to users as "some answers randomly weren't scored".

This is **latent**, not live. It costs nothing today and becomes a correctness
bug the moment a second replica exists.

### Options

| | What it does | Cost |
|---|---|---|
| **A. Document the constraint, fix nothing now** | Record in the README and deploy notes: *this service must run as a single instance.* | Minutes |
| **B. Make the wait row-based** | `endSession` derives in-flight state from the persisted `status: 'processing'` marker plus a timestamp, instead of from an in-process Map. `_evaluateAndPersist` already writes that marker for exactly this purpose. | ~a day, and it depends on P1-02 landing first |
| **C. Externalize state** | Redis for pending evaluations and the breaker; drop the in-memory session fallback. | Days; a new infrastructure dependency |

**Recommendation: A now, B when scaling becomes real.** B is the right long-term
shape and needs no new infrastructure, but it should not be built ahead of the
need — and it sits on top of the P1-02 fix either way.

**Needs from you:** whether more than one instance is planned in the next
release. **Blocks:** nothing today; scoped as prep.

---

## Not deferred, worth flagging before implementation starts

These are not decisions, but each fix has a sharp edge that will be tempting to
smooth over the wrong way:

- **`P2-01`** — do **not** add `'unsafe-inline'` to `script-src` to make the
  accordion work. That deletes an XSS control to shrink a diff, which is a new
  finding at that control's severity floor, not a fix. Use delegated listeners.
- **`P1-02`** — do **not** "fix" the evaluation race by awaiting evaluation
  inside `submitAnswer`. That reverts the deliberate decoupling documented in
  `RICH_EVALUATION_SCALE_PLAN.md` and reintroduces the per-question blocking the
  project already removed. That is a behavior regression wearing a smaller diff.
- **`P1-03`** — do **not** delete the in-memory fallback to simplify the fix. The
  defect is the silent-success path, not the fallback. Removing a data-loss
  prevention control is a new defect at that control's floor.
- **`P2-04`** — do **not** flip provider errors to `isOperational: false`. That
  turns every provider hiccup into a 500 and breaks `runWithProviderChain`'s
  status-code-driven fallback. Keep the status code; change only the message.
