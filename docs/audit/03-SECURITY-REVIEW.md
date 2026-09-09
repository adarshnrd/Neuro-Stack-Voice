# Security Review

Method: map the attack surface, walk STRIDE at each trust boundary, then work the
thirteen-category catalog against what the surface actually reaches. Exclusions
applied before reporting; confidence gate applied after. Findings at or above
~8/10 confidence are in the backlog; everything below sits in §6 with the check
that would settle it, at no blocking severity.

---

## 1. Attack surface

### Entry points

| # | Entry point | Auth | Notes |
|---|---|---|---|
| 1 | `POST /api/auth/register` | none | 20/15min limiter, bcrypt cost 12 |
| 2 | `POST /api/auth/login` | none | 20/15min limiter, constant-time-ish compare |
| 3 | `POST /api/auth/logout` | none | clears cookie only (stateless JWT) |
| 4 | `GET /api/auth/me` | required | re-reads the user row |
| 5 | `GET /api/health` | none | returns uptime + db up/down |
| 6 | `GET /api/interviews/tech-stacks` `\|` `/models` `\|` `/config` | none | static reference data |
| 7 | `POST /api/interviews/start` | **optional** | accepts `jobDescription`, `userApiKey`, `historyEmail`, `model` |
| 8 | `POST /api/interviews/:id/extend` | **optional** | ownership enforced in service |
| 9 | `POST /api/interviews/:id/refresh-feedback` | **optional** | triggers an AI call |
| 10 | `POST /api/interviews/history/lookup` | **none** | email → history. 20/15min |
| 11 | `GET /api/interviews/history` | required | user-scoped |
| 12 | `GET /api/interviews/:id` | **optional** | full transcript |
| 13 | `POST /api/interviews/claim` | required | ≤200 UUIDs, only unowned rows |
| 14 | `POST /api/settings/api-key` `\|` `GET /status` `\|` `DELETE /` | required | per-user encrypted key |
| 15 | `POST /api/settings/api-key/validate` | required | 10/15min, calls Gemini |
| 16 | Socket handshake | **optional** | cookie parsed; invalid ⇒ reject, absent ⇒ anonymous |
| 17 | `interview:join` / `answer:final` / `interview:end` | inherits handshake | **no rate limit** |
| 18 | Static files + SPA wildcard | none | `express.static` on `public/` |

No file upload, no deserialization of untrusted binary, no queue consumer, no
scheduled job, no CLI surface.

### Trust boundaries

1. **Internet → Express.** Guarded by helmet, CORS, three rate limiters,
   `express.json({limit:'1mb'})`, `validateBody`/`validateUuidParam`.
2. **Internet → Socket.IO.** `maxHttpBufferSize: 1e6`, handshake middleware,
   per-event shape checks. **No rate limiting** (P3-10).
3. **App → Postgres.** Prisma only; no raw SQL except a parameterless
   `` prisma.$queryRaw`SELECT 1` `` health ping.
4. **App → AI providers.** Outbound `fetch` with server-held or user-supplied
   keys. `model` reaches the URL path unvalidated (P2-02).
5. **User → user.** Ownership via `getOwnedSession`. Anonymous sessions are
   deliberately bearer-capability (the UUID is the credential).
6. **AI output → browser DOM.** Rendered through `renderMarkdown`.

### Assets worth taking

Interview transcripts and AI critiques (personal career data) · user emails and
bcrypt hashes · AES-256-GCM-encrypted per-user Gemini keys · the server's own
provider API keys · provider quota (spendable).

### Actors modelled

Unauthenticated internet · anonymous session holder (has a UUID) ·
low-privilege authenticated user · cross-tenant user (another account) ·
compromised dependency · operator with database access.

---

## 2. STRIDE at each boundary

| Boundary | S | T | R | I | D | E |
|---|---|---|---|---|---|---|
| Internet → Express | JWT verified with a ≥32-char secret; no `alg:none` path — `jwt.verify` with a string secret rejects unsigned tokens. **OK** | `express.json` 1 MB cap; per-field validation; **`model` unvalidated → P2-02** | `requestId` on every request/response; but 18 `console.*` sites bypass structured logging → **P5-01** | **P1-04** (email lookup chain), **P2-04** (upstream bodies echoed) | Three limiters; **P2-03** lets one client degrade the whole process | `requireAuth`/`attachUserIfPresent` split is deliberate and correctly applied per route; no privilege escalation path found |
| Internet → Socket.IO | Cookie verified, tampered token rejected outright rather than downgraded — **correct** | Shape + length checks per event | Events logged via `console.*`, no requestId → **P5-01** | `interview:join` verifies ownership before joining the room — **correct** | **P3-10** no rate limit; each answer starts an AI call | Ownership re-checked in the service for every event |
| App → Postgres | n/a | Prisma parameterises; no string-built SQL | `updatedAt` exists but is not used as a write guard → **P1-02, P3-09** | Fallback list paths over-return → **P4-05** | **P2-03** | n/a |
| App → AI providers | Server key in a header, never a URL | **P2-02** path control | Provider errors logged | **P2-04** | Retry storm on 429 → **P5-04** | n/a |
| User → user | Session UUID is the anonymous credential (v4, `crypto`-backed via `uuid`) | `claimAnonymousSessions` is scoped `userId: null` — cannot steal an owned session | | **P1-04**; **P3-06** (deletion downgrades to public) | | `getOwnedSession` 404s on mismatch (not 403 — correct, avoids confirming existence) |
| AI output → DOM | | | | | | `renderMarkdown` escapes first — **no XSS found**, see §3 |

---

## 3. Thirteen-category catalog

| # | Category | Verdict |
|---|---|---|
| 1 | **Authentication** | **Sound.** bcrypt cost 12; login compares against a fixed dummy hash on a missing user, so timing does not enumerate emails; register returns a deliberately vague 409; `/me` re-reads the row so a deleted account cannot keep using a live token. Statelessness (no revocation list) is documented in `src/utils/jwt.ts` as an accepted trade-off — a **constraint**, not a defect. |
| 2 | **Authorization & access control** | **P1-04** (email lookup), **P3-06** (deletion downgrade). Otherwise correct: every interview route resolves ownership in one place (`getOwnedSession`), sockets reuse the same check, `/history` is correctly the one route that demands a real account, and `claim` cannot take an owned row. `tests/integration/historyIsolation.test.ts` covers the cross-user case. |
| 3 | **Injection** | **None found.** All database access is through Prisma; the single `$queryRaw` is a literal with no interpolation. No `eval`, `Function`, `child_process`, or shell invocation anywhere in `src/`. |
| 4 | **Input validation & deserialization** | **P2-02** (`model`), **P3-05** (prompt injection). Elsewhere validation is careful and consistent: UUID params, the claim-array element filter, `questionsCount` bounds, the 5000-char JD cap, `MAX_API_KEY_LENGTH`, `MAX_ANSWER_LENGTH`. No custom deserializer. |
| 5 | **Secrets & credential handling** | **No secret found in the examined scope.** `.env` is gitignored; `.env.example` holds placeholders only; `docker-compose.yml` uses `${VAR:?}` for app secrets. `tests/env.setup.ts` sets obviously-fake values — checked deliberately, since test fixtures are the classic hiding place. **P3-07** is the exception (hardcoded Postgres credentials). **Git history was not inspected — see W-1.** |
| 6 | **Sensitive data & cryptography** | AES-256-GCM with a random 16-byte IV per encryption and an authenticated tag — correct construction, correctly verified on decrypt. Key derivation is a **single unsalted SHA-256** of `ENCRYPTION_SECRET`. Given the enforced ≥32-character secret this is defensible, but a KDF (scrypt/PBKDF2 with a stored salt) is the idiomatic choice and would matter if a low-entropy secret is ever used. Filed here as an observation, **not** in the backlog — with a 32-char random secret the practical difference is nil, and changing it requires re-encrypting stored keys. |
| 7 | **Session management** | Cookie is `httpOnly`, `sameSite: lax`, `secure` in production, `path: '/'`, 7-day TTL. `lax` plus no state-changing GETs is adequate CSRF protection for the cookie flows. No fixation risk (token minted per login). |
| 8 | **SSRF & outbound requests** | **P2-02**, limited: scheme and host are fixed literals in all three providers, so only the path is influenced. No user-controlled hostname, no redirect following configured, no internal-network reachability. |
| 9 | **CSRF / CORS & browser trust** | CORS reflects a configured allowlist with `credentials: true`; `validateConfig` **refuses to start in production if `ALLOWED_ORIGINS` is a wildcard** — this is the right check in the right place. `sameSite: lax` covers the rest. |
| 10 | **XSS & client-side execution** | **No XSS found.** `renderMarkdown` HTML-escapes the entire input before any transform, emits tags only around already-escaped text, and restricts `href` to `http(s)`. `_escHtml` guards the non-markdown insertion points. The relevant finding here is the inverse: **P2-01**, where the CSP correctly blocks inline handlers and thereby breaks the UI. |
| 11 | **File handling & uploads** | No upload surface. `express.static` serves a fixed directory; `res.sendFile` uses a `path.join` on constants with no request input. |
| 12 | **Dependencies & supply chain** | 12 runtime dependencies, all mainstream and pinned by `package-lock.json`. **`npm audit` could not be run (registry blocked) — CVE status is Unknown, W-2.** `Dockerfile` does not use `--ignore-scripts` on `npm ci`; worth considering, noted here rather than in the backlog since it is a hardening preference, not a defect. |
| 13 | **Logging, monitoring & configuration** | **P2-04** (error bodies to clients), **P5-01** (split logging), **P3-07** (compose credentials), **P3-08** (migrations). Positives worth keeping: `logger` call sites are conspicuously careful never to log candidate answers or AI response text (a rule stated in `RICH_EVALUATION_SCALE_PLAN.md` §5 and actually followed), `requestId` is echoed as `X-Request-Id`, and `errorHandler` returns a generic message for non-operational errors. |

---

## 4. Exclusions applied

Checked and deliberately **not** reported:

- **Framework-default escaping.** Express's JSON serialisation and helmet's
  default headers are doing their job; neither is a finding.
- **`sameSite: lax` without CSRF tokens.** Adequate here — no state-changing GET
  endpoint exists, and every mutating route is POST/DELETE with a JSON body.
- **Statelessness of JWTs.** Documented trade-off with a named alternative. A
  constraint, not a defect.
- **Anonymous sessions readable by UUID holders.** The documented, intentional
  share-link trust model. Reported **only** where it combines with the unverified
  email lookup to become reachable without holding the UUID (P1-04).
- **`'unsafe-inline'` in `style-src`.** Required by the app's inline `style=`
  attributes; low value as an XSS vector given `script-src 'self'`.
- **Test fixtures.** `tests/env.setup.ts` secrets are obviously synthetic. Checked
  explicitly — a real key here would be a P0 by the severity floor.
- **"Internal-only" claims.** None were assumed. Every route's reachability was
  read from the router, not inferred from a comment.

---

## 5. What this review does not cover

- Runtime behavior — nothing was executed, deployed, or attacked.
- Dependency CVEs (W-2).
- Git history (W-1).
- `public/css/style.css`, and therefore accessibility (contrast, focus visibility,
  reduced motion) — **unassessed**, not clean.
- Infrastructure outside the repository: TLS termination, WAF, database network
  policy, secret storage, backup and restore.

---

## 6. Below the confidence gate — not findings

Each of these is under ~8/10 confidence. None carries a severity. Each has the
one check that would resolve it.

| Item | Why it is uncertain | The check |
|---|---|---|
| SHA-256 key derivation for `ENCRYPTION_SECRET` | Real weakness only with a low-entropy secret, and the ≥32-char rule mitigates it. Migration cost is real (re-encrypt every stored key). | Decide whether operators are trusted to use a random 32-byte secret. If not, move to scrypt with a stored salt and a versioned ciphertext prefix. |
| `npm ci` without `--ignore-scripts` | Standard practice for most projects; only matters against a compromised dependency. | Add `--ignore-scripts` to the Dockerfile and confirm `prisma generate` still runs (it is already an explicit step, so it should). |
| Socket identity is frozen at handshake | A user who logs out keeps their socket identity until it drops. Consistent with the documented stateless-JWT model. | Confirm `_logout()` calls `socket.disconnect()` — it does. Closed, unless revocation is added later. |
| `historyEmail` is never re-normalised on update | `updateSession`'s `updatableFields` omits it, so it can only be set at creation, where it is normalised. Probably intentional. | Confirm no future path needs to change it. |
| Provider `errText` could contain a key | Not observed in any provider's documented error format; the concern is speculative. | Grep production logs for key prefixes (`AIza`, `gsk_`, `nvapi-`) once P2-04's logging lands. |
