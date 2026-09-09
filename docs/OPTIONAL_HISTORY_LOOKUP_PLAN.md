# Plan: Optional "Enter Email/Username" History Lookup on the Home Page

Status: **IMPLEMENTED — Option B, email-only, no verification.**

Decision taken: identifier is **email only** (no free-text username — see
§4's "Identifier type" reasoning), and lookup is **unverified** (Option
B) — typing an email that was used to start a past interview immediately
shows its history, no password/PIN/code. That trade-off (§3) was
discussed and accepted explicitly, not defaulted into. Option A's PIN and
§6.7's change/forgot-PIN flow were NOT built, since there's no PIN in
this version — nothing to change or forget. If verified lookup (or a
PIN) is wanted later, the identity check described in §6.7 would need to
be added on top of what's shipped here.

**What shipped:** `Session.historyEmail` (optional, unverified, set at
start time), `POST /api/interviews/history/lookup` (rate-limited,
unauthenticated), and a "Returning?" box on the setup page. See §6 for
the as-built design (data model, endpoint, rate limiting, UI) — it's
accurate to what's live now, minus the PIN parts, which were skipped.
**Still needed from you:** run the Prisma schema sync — see the rollout
note at the end of §7.

## 1. What was asked for

On the home/setup page, add an optional field where a visitor can type a
username or email *before* starting an interview. If they've used that
identifier before, we look up and show their previous interview sessions —
the questions they were asked and the answers they gave — so they can
review past performance and pick up where they left off. Not filling it in
must not block starting a new interview.

## 2. What the app already has today

Worth being explicit about this, because it changes how much of this
feature is actually new:

- **Real accounts** (`src/services/auth.service.ts`, `auth.routes.ts`):
  email + password, bcrypt-hashed, JWT in an httpOnly cookie
  (`requireAuth`). `GET /api/interviews/history` returns every completed
  session for `req.user.id` — this is already a full cross-device history
  lookup, it's just gated behind a real login.
- **Anonymous sessions** (`interview.routes.ts`, `app.js`'s
  `HISTORY_IDS_KEY`): starting an interview with no login creates a
  session with `userId: null`. The browser remembers that session's UUID
  in `localStorage`. `GET /api/interviews/:sessionId` will return that
  session to *anyone* who holds the UUID — the trust model is "the
  unguessable UUID is the access token," the same idea as a share link.
  This already lets a visitor review old answers without ever registering
  — but only from the same browser, since the ID list lives in
  `localStorage` and never touches the server keyed by anything a human
  would type in.
- **Claim on login** (`POST /api/interviews/claim`, `_claimLocalHistory()`
  in `app.js`): when someone *does* register or log in, their browser's
  locally-remembered anonymous session IDs are automatically attached to
  the new account, so nothing is lost by delaying registration.

So the actual gap this feature needs to close is narrower than "let people
see their history without an account" (anonymous visitors already can, on
the same device) — it's **"let someone recover their history from a
*different* device/browser, or after clearing local storage, without
going through full registration."**

## 3. The problem: there is no free way to prove someone owns an identifier

This is the part I want to flag clearly rather than build past. If a
visitor can type *any* email or username and immediately see the full
interview transcript tied to it — no password, no confirmation — then
anyone who knows or guesses someone else's email/username can read that
person's interview answers. For a Job-Description-mode interview those
answers can include fairly specific professional/career detail. A common
username ("john", "test") would also mix unrelated people's history
together.

There are exactly two ways to close that gap:
1. Prove they know a **secret** (a password or PIN) tied to the
   identifier.
2. Prove they can **receive something** sent to the identifier (an email
   with a code/link).

You've ruled out (2) — a verification-email flow means standing up an
email-sending integration (SMTP/SES/Postmark/etc.), which is real added
infrastructure and ongoing cost/maintenance. That's a reasonable thing to
avoid for this feature. But it does mean option (1), or accepting the
risk outright, are the only paths left. Below are the three realistic
options given that constraint.

## 4. Options

### Option A — Short PIN tied to the identifier (recommended)

The first time someone types an email/username on the home page, they
also set a short PIN (e.g. 6 digits) — one extra tap, no new screen. We
store `identifier` (normalized) + `bcrypt(pin)`, reusing the exact hashing
approach `auth.service.ts` already uses for passwords. To look up history
later, they type the identifier **and** the PIN; wrong PIN → no data
returned (rate-limited, see §6). Skipping the field entirely still works
exactly as it does today — fully anonymous, browser-local history only.

This is the only option here that gives real protection without sending
anything or requiring a full password. It's effectively a much lighter
version of the existing account system — same hashing, same "not
mandatory" framing — just without email/password's usual weight (no
confirmation email, no 8-character minimum, no separate login screen).

- **Effort:** moderate. New `SessionIdentity` concept (below), a small
  home-page UI addition, rate limiting on the lookup endpoint.
- **Security:** good — a brute-forced 6-digit PIN is slow to guess if
  rate-limited per identifier (see §6), same principle as a bank card PIN.
- **Trade-off:** it *is* one more thing to type and remember versus the
  literal "just type your email" ask — but it's the smallest addition
  that actually protects the data.

### Option B — No verification at all (matches the literal request)

Typing an identifier immediately shows every session tagged with it.
Simplest to build, closest to the original wording. I'd only want to ship
this with the risk written down and accepted explicitly — it turns any
known or guessable email/username into a way to read someone's interview
answers. Mitigations below (§6: rate limiting, exact normalized match)
reduce *bulk scraping* but do nothing against someone targeting one
specific person's known email.

- **Effort:** small — one new read endpoint plus tagging sessions with
  the identifier at start time.
- **Security:** none against a targeted lookup; some resistance to bulk
  scraping if rate-limited.

### Option C — Browser-persistent auto-recall, no typed lookup at all

Instead of a server-side identifier lookup, extend what already exists:
set a long-lived (e.g. 1-year) signed cookie the first time someone starts
an interview, in addition to `localStorage`. On return visits to the
*same* browser, history loads automatically with nothing typed — this
mainly helps when `localStorage` gets cleared but cookies don't. It does
**not** give cross-device recovery, so it doesn't fully answer the
original ask (viewing history from a different phone/laptop) — but it
needs no new identity concept, no PIN, no email, and closes the most
common real-world failure mode (cleared site data) other than a phone
outright not being the original device.

- **Effort:** small.
- **Security:** no new surface at all — same trust model as today.
- **Trade-off:** doesn't solve "look up my history from a different
  device," which seems to be the actual point of the request.

## 5. Recommendation

Option A. It's the smallest change that actually delivers what seems to
be wanted — "type something you remember, get your old interviews back,
from any device" — without opening a way for someone to read a stranger's
interview answers just by knowing their email. Option C is worth doing
*regardless* of which of A/B is chosen, since it's cheap and fixes the
"I cleared my browser data" case for free.

Everything below is written against Option A; if you'd rather go with B
or C instead, the shape changes (mainly: drop the PIN field and the
hashing, or drop the server lookup entirely for C) but I can adjust the
plan quickly once you pick.

## 6. Design (Option A)

### 6.1 Data model

Add a small new table rather than bolting fields onto `Session`, since an
identifier can have many sessions and the PIN hash belongs to the
identifier, not to any one session:

```prisma
model SessionIdentity {
  id           String   @id @default(uuid())
  identifier   String   @unique   // normalized: trimmed + lowercased
  pinHash      String
  createdAt    DateTime @default(now())
  lastUsedAt   DateTime @default(now())

  sessions Session[]
}
```

And on `Session`, an optional back-reference:

```prisma
  identityId String?
  identity   SessionIdentity? @relation(fields: [identityId], references: [id], onDelete: SetNull)

  @@index([identityId])
```

This needs a real migration (unlike the AI-provider-switch change, which
deliberately reused existing columns) — `prisma migrate dev` locally, then
apply to Supabase.

### 6.2 Start-of-interview flow

`POST /api/interviews/start` gains two optional body fields: `identifier`
and `pin`.

- Neither provided → behaves exactly as today, fully anonymous.
- Both provided:
  - If `identifier` is new: create a `SessionIdentity` row, hash the PIN
    (bcrypt, same `BCRYPT_ROUNDS` as `auth.service.ts`), link the new
    session to it.
  - If `identifier` already exists: verify the PIN against the stored
    hash. Wrong PIN → **do not fail the interview start** — proceed
    anonymously and tell the client the PIN didn't match, so a typo never
    blocks someone from just taking the interview. (Whether to surface
    that as an error or a quiet toast is a UI call — leaning toward a
    small inline warning: "That PIN didn't match — starting without
    saving to that identifier.")
  - Only `identifier` provided, no `pin`: reject with a clear 400 message
    asking for the PIN — an identifier with no PIN would defeat the whole
    point.

### 6.3 History lookup flow

New endpoint, unauthenticated but rate-limited:

```
POST /api/interviews/history/lookup
body: { identifier, pin }
→ { success: true, data: [ ...same shape as GET /history... ] }
```

Verifies the PIN the same way login does (constant-time-ish via bcrypt,
plus the existing dummy-hash trick from `auth.service.ts` so a
nonexistent identifier and a wrong PIN take the same amount of time to
reject — that trick is already in the codebase for exactly this reason).
On success, returns the identity's sessions the same shape
`interviewService.getHistory` already returns.

Session **detail** (questions + the user's actual answers) is fetched the
same way it already is — `GET /api/interviews/:sessionId` — no change
needed there; the lookup endpoint only needs to return the list of
session summaries/IDs, and the existing detail route does the rest.

### 6.4 Rate limiting & abuse mitigation

- `history/lookup` gets its own `express-rate-limit` instance, tighter
  than the general API limiter — mirroring `authLimiter` in
  `auth.routes.ts` (20 req / 15 min per IP is a reasonable starting
  point; could go tighter specifically on this route since it's a
  targeted-guessing surface).
- Additionally rate-limit by identifier (not just IP) — a fixed number of
  failed attempts per identifier per hour, independent of which IP is
  trying — since an attacker with many IPs could otherwise brute-force a
  single target's 6-digit PIN (1,000,000 combinations is not that many
  without a per-identifier cap).
- Normalize `identifier` (trim + lowercase) before every lookup/compare so
  `Foo@Bar.com` and `foo@bar.com` are treated as the same identity.

### 6.5 Home-page UI

A small, clearly-optional block above or beside the existing setup form —
not a separate screen, not gating the "Start Interview" button:

```
┌─────────────────────────────────────────────┐
│ Returning? (optional)                        │
│ [ email or username        ] [ PIN (6-digit)]│
│                                [ Load my history ]
└─────────────────────────────────────────────┘
```

- "Load my history" calls the lookup endpoint and, on success, shows the
  results the same way `loadHistory()`/`renderHistoryList()` already do
  today (reuses the existing history panel — no new UI pattern needed).
- The *same* two fields, filled in (optionally) before clicking "Start
  Interview," get sent along with `POST /start` so the new session gets
  tagged to that identity per §6.2. Leaving them blank starts anonymously,
  exactly like today.
- Wrong PIN on lookup: a plain inline error, no hinting at whether the
  identifier itself exists or not (mirrors the "deliberately vague" login
  error already used in `auth.service.ts`).

### 6.6 What does NOT change

- Real accounts (email+password, `requireAuth`, JWT) are untouched — this
  is a parallel, lighter-weight path for people who don't want a full
  account, not a replacement.
- The existing anonymous `localStorage`-based history keeps working
  exactly as-is for people who never type an identifier at all.
- `POST /claim` is unaffected — if someone eventually does register a
  real account, claiming still works the same way. (Open question, not
  blocking: should registering also auto-migrate a `SessionIdentity`'s
  sessions into the new real account if the emails match? Leaning yes,
  but happy to leave that for a follow-up rather than scope it in now.)

### 6.7 Changing or recovering a forgotten PIN

Two different situations, worth separating clearly:

**They know the current PIN and want to change it.** Easy — a new
endpoint `POST /api/interviews/history/change-pin` taking
`{ identifier, currentPin, newPin }`: verify `currentPin` against the
stored hash exactly like the lookup endpoint does, and if it matches,
overwrite `pinHash` with the new one. No new trust model needed, same
rate limiting as §6.4 applies (a "change PIN" endpoint that verifies a
PIN is just as guessable a target as the lookup endpoint itself).

**They've forgotten the PIN entirely.** This is the harder case, and it
runs into the exact same wall as §3: proving someone owns an identifier
without email (or SMS) has no fully secure answer. Worth noting for
context — **the app's existing real-account system has this same gap
today**: `auth.service.ts` only has `register`/`login`, there is no
"forgot password" flow at all right now. So an identity with no recovery
path if the secret is lost isn't a new weakness this feature introduces
— it's consistent with how the rest of the app already works. Given
that, here's what's realistically available without adding email:

1. **No recovery — the honest default.** If the PIN is forgotten, that
   identifier is stuck; the fix is to just start using a different
   identifier (or the same one with a different case/typo, effectively a
   new identity) going forward. The old sessions aren't deleted or lost —
   they still exist in the database and are still reachable the way
   anonymous sessions always have been (the originating browser's
   `localStorage` history list is completely untouched by any of this) —
   they just can't be pulled up via the identifier+PIN lookup anymore.
   This should be stated plainly in the UI copy right where the PIN is
   first set ("If you forget this PIN, we can't reset it — write it down
   somewhere safe"), so it's an informed trade-off, not a surprise later.

2. **Same-browser reset, using the session UUIDs already trusted today
   (recommended addition).** If the PIN is forgotten but the person is on
   the *same* browser that originally used that identity, the browser
   already holds proof of ownership it doesn't realize it has: the
   session UUIDs in `HISTORY_IDS_KEY` (`localStorage`). Those UUIDs are
   already treated as bearer tokens everywhere else in the app (§2) — so
   a "Reset PIN" flow can check whether any of this browser's
   locally-remembered session IDs belong to the claimed identity's
   sessions, and if at least one matches, allow setting a new PIN without
   needing the old one. This adds zero new trust assumptions (it reuses
   the exact "holding the UUID proves ownership" model the anonymous flow
   already relies on) and needs no email — but it only helps if they're
   still on the device/browser where they used that identity before. A
   new phone/laptop, or a cleared `localStorage`, can't use this path
   (Option C from §4, the persistent cookie, would extend how long this
   stays available).

3. **Point them at a real account instead.** If someone specifically
   wants a recovery path that works from *any* device even after losing
   the PIN, that's exactly the durability trade real accounts already
   offer over this lighter mechanism — worth a line of UI copy ("want
   this to survive a lost PIN? create a free account instead") rather
   than trying to make the PIN path do everything a password can. A real
   forgot-password flow for accounts would need email too, and is a
   separate, larger decision outside this feature's scope.

Recommendation: ship (1) and (2) together — (2) costs almost nothing
(reuses data the client already has) and quietly covers the most common
real "I forgot my PIN" case (same laptop, forgot the digits), while (1)
is just honest, visible copy about the limit, and (3) is a one-line nudge
toward the durable path that already exists.

## 7. What was actually built (Option B, no PIN)

The original §6 above was written against Option A (PIN-protected). Since
Option B was chosen instead, here's what's live, mapped against that
design:

1. **Data model** — no separate `SessionIdentity` table (that only existed
   to hold a PIN hash — Option B has no PIN, so nothing to store beyond
   the email itself). Instead: `Session.historyEmail String?` — a plain
   optional column, normalized (trim + lowercase) before every write and
   read, with `@@index([historyEmail])`. Simpler than §6.1's design
   because there's no separate identity object to manage.
2. **Start-of-interview flow** — `POST /api/interviews/start` accepts an
   optional `historyEmail` field. Format-checked (basic email regex,
   ≤254 chars) but never required and never blocks starting — an invalid
   format is the only thing rejected (400); a valid email is simply
   attached to the new session.
3. **History lookup flow** — `POST /api/interviews/history/lookup`,
   unauthenticated, body `{ email }`, returns the same summary shape
   `GET /history` already does. No PIN, no code — matches §6.3 minus the
   verification step. Session **detail** (the actual Q&A) is unchanged —
   still `GET /:sessionId`, already public for any `userId`-null session.
4. **Rate limiting** — `historyLookupLimiter` (20 req / 15 min per IP,
   mirroring `auth.routes.ts`'s `authLimiter`) on the lookup route only.
   Per-identifier rate limiting from §6.4 was not added (that existed to
   slow down PIN brute-forcing specifically — with no PIN to guess, the
   IP-level limiter is what's left, and it still blunts bulk scraping of
   many emails from one source).
5. **UI** — a "Returning?" box on the setup panel (email input + "Load My
   History" button), matching §6.5 minus the PIN field. Filling in the
   email before clicking "Start Interview" tags the new session the same
   way; leaving it blank starts fully anonymous, unchanged from before.
6. **A bug fixed along the way**: `GET /api/interviews/history` (the
   real-account history endpoint) was silently unreachable — it was
   registered in `interview.routes.ts` AFTER `GET /:sessionId`, whose
   wildcard segment matched the literal path `/history` first and failed
   UUID validation before ever reaching the real handler. The client's
   `loadHistory()` already falls back to local anonymous history on ANY
   failure, so this never surfaced as a visible error — it just silently
   always used the fallback path. Fixed by reordering the two routes
   (literal paths must be registered before a `/:param` catch-all).

**Not built:** the PIN itself, `change-pin`/`reset-pin` endpoints, and
§6.7's forgot-PIN handling — there's no PIN in this version, so nothing
to change or forget. Option C (persistent cookie) also wasn't done.

## 8. One manual step left

I don't have a way to run commands on your machine or reach your
database directly from here, so the one thing I couldn't finish myself:
the `Session.historyEmail` column needs to actually exist in Postgres.
Run one of these locally (there's no `prisma/migrations` folder in the
repo yet, so `db push` matches how the project's been managed so far —
`migrate dev` is the alternative if you'd rather start tracking
migration history from here):

```bash
cd ~/Neuro_stack_voice
npm run prisma:push
# or, to start tracked migrations instead:
# npm run prisma:migrate -- --name add_history_email
```

Once that's run, the feature is live — no server restart should even be
needed beyond your normal dev workflow picking up the new schema.

## 9. Later, if wanted

If unverified lookup ever feels too loose in practice, §6.7's PIN design
(or the email-verification path ruled out in §3) can be layered on top
of what's here without touching the shape of what's already built —
`historyEmail` stays the lookup key either way.
