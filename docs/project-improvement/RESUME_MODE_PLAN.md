# Resume Mode + Selectable Question Count — Plan

Status: **Phases 1–2 implemented** (question-count control, Resume mode
core end-to-end — backend, prompts, opening sequence, narrative rubric,
frontend paste UI — and the JD floor fix). **Phase 4 (file upload
parsing) is deferred**, not skipped — see §16 for exactly what shipped,
what didn't, and why.

Adds a **Resume** option alongside the existing tech stacks, where the AI
first reads the candidate's resume, extracts what they actually claim to
know, and then interviews them on *that* — plus a question-count control
so the candidate picks how long the interview is.

Four asks, addressed in order:

1. Resume option under Tech Stack — §2
2. Upload / paste resume text, parsed from the file buffer with no
   storage anywhere — §3
3. AI extracts the tech stack first, then asks from it — §4
4. Interview opens with introduction, then best-project narration — §4.4
5. User-selectable number of questions — §7

---

## 1. What already exists (and what actually has to be built)

Worth stating up front, because it changes the size of this job
considerably:

| Piece | Status today |
|---|---|
| `questionsCount` in `POST /start` | **Already implemented and validated** (integer 1–50) — `interview.controller.ts` §`start`, honored in `interview.service.ts` §`startSession` |
| Untrusted free-text → prompt, safely | **Already solved** — `fenceUntrustedInput` + `sanitizeJDInput` in `promptBuilder.ts` |
| A non-tech-stack "mode" hanging off `techStack` | **Already exists** — `'Job Description'` is a `TECH_STACKS` member with its own prompt branch |
| Per-session prompt context surviving into extend | **Already exists** — `extendSession` re-passes `session.jobDescription` |
| Provider fallback for any AI call | **Already exists** — `runWithProviderChain` |
| Level-aware question calibration | **Already exists** — `buildLevelQuestionGuidance` |

So the genuinely new work is: **one new AI call type** (resume →
structured profile), **one new prompt branch** (profile → questions), two
additive DB columns, and the frontend for both features. The
question-count feature is almost entirely frontend — the server already
accepts it.

---

## 2. The Resume option

Add `'Resume'` to `TECH_STACKS` in `interview.controller.ts`, positioned
next to `'Job Description'`:

```ts
export const TECH_STACKS = [
  'Node.js', 'React', /* … */ 'MySQL',
  'Job Description',
  'Resume',
];
```

That single line gets it: served by `GET /tech-stacks`, rendered in the
picker, and accepted by `POST /start`'s `oneOf: TECH_STACKS` allowlist —
the same [P3-05] machinery that already guards `techStack`. No new
validation vocabulary, no second allowlist to keep in sync.

**Why `techStack: 'Resume'` and not a separate `mode` field.** JD mode
already established this shape, and every downstream consumer
(`toHistorySummary`, the history card, the interview badge, the stack
icon map) keys off `techStack` and will display "Resume" correctly with
zero changes. Introducing a parallel `mode` field would mean auditing
every one of those call sites for a second dimension they currently
don't have.

---

## 3. Getting the resume in

### 3.1 Phase 1 — paste text (no new dependencies)

Mirror the JD textarea exactly: a `#resume-input-group` block in
`index.html`, hidden by default, shown by `onTechStackChange()` when
`techStack === 'Resume'`, with a live character counter like
`#jd-char-count`.

| | JD (today) | Resume (proposed) |
|---|---|---|
| Element | `#jd-textarea` | `#resume-textarea` |
| Limit | 5,000 chars | **10,000 chars** |
| Body field | `jobDescription` | `resumeText` |

10,000 is roughly a dense three-page resume. It is deliberately *not*
higher: `express.json` is capped at 1 MB (fine), but the real ceiling is
the model's token budget — see §9.

### 3.2 Phase 4 — file input, parsed **server-side from the buffer**

Users will want to drop a PDF or a Word file. **There is no upload in the
storage sense anywhere in this design.** The bytes arrive in a request
body, are parsed in memory, the text goes into pass 1, and the buffer is
dropped when the request ends. Nothing is written to disk, nothing gets
an id, there is no storage location and no cleanup job.

**Where the parse runs: the backend.** Both are viable; the backend wins
here for concrete reasons:

| | Backend parse (recommended) | Browser parse |
|---|---|---|
| Production CSP (`scriptSrc: ["'self'"]` in `app.ts`) | Irrelevant — no client library | pdf.js **must be vendored** into `public/vendor/` and served same-origin; a CDN `<script>` is blocked in prod |
| Payload shipped to every visitor | 0 KB | ~1–2 MB of parser JS |
| Consistency | One code path | Varies by browser/device; heavy parse on phones |
| Bytes over the network | The file, once | None |
| New deps | 2 npm packages | 2 vendored bundles + build step |

The CSP line is the decider. Vendoring pdf.js and its worker is exactly
the kind of thing that works in `npm run dev` (where CSP is `false`) and
fails on deploy. Parsing server-side removes that failure mode entirely
rather than documenting around it.

Browser parsing stays a legitimate fallback if zero-bytes-to-server ever
becomes a requirement — the module list below covers both, since pdf.js
and mammoth run in either place.

#### Which modules (researched, not assumed)

**PDF — recommended: `pdf-parse`**

```ts
import pdfParse from 'pdf-parse';
const { text, numpages } = await pdfParse(buffer);
```

- Wraps Mozilla's pdf.js; **pure JS, no native binaries, no poppler**.
- Actively maintained (v2.4.5, millions of weekly downloads).
- **CommonJS-friendly — this matters:** `tsconfig.json` sets
  `"module": "CommonJS"`, so a plain `import` works.
- Known gotcha: older 1.x published a debug branch that did a sync read
  of a bundled test PDF when `module.parent` was falsy (the classic
  `ENOENT ./test/data/05-versions-space.pdf`). If it surfaces, import
  `pdf-parse/lib/pdf-parse.js` directly.

Alternatives considered:

| Module | Verdict |
|---|---|
| `unpdf` | Cleanest API, bundles a serverless pdf.js build (v5.x), runs in Node/edge/browser. **But it is ESM-only**, and under `"module": "CommonJS"` TypeScript downlevels `await import()` to `require()`, which fails on a true-ESM package. Needs a `new Function('s', 'return import(s)')` escape hatch or moving the project to `module: "Node16"`. Best choice *if* this codebase ever goes ESM or serverless. |
| `pdfjs-dist` | The real Mozilla engine, most robust, but a heavier API built for rendering; v4+ is ESM, same CommonJS friction. Overkill for text-only. |
| `pdf-text-extract`, `pdf2json` | Require native binaries or produce awkward output shapes. No. |

**DOCX — recommended: `mammoth`**

```ts
import mammoth from 'mammoth';
const { value: text } = await mammoth.extractRawText({ buffer });
```

- Purpose-built for `.docx`, pure JS, works in Node *and* the browser
  (so it serves the fallback plan unchanged).
- `extractRawText` is exactly the "give me the text, drop the styling"
  call this feature wants.

Alternative: `officeparser` handles docx/pptx/xlsx/pdf behind one API —
fewer dependencies, less control over each format. Reasonable if the
dependency count matters more than per-format tuning.

**TXT / MD** — no library. `buffer.toString('utf8')`.

**`.doc` (legacy binary) is NOT supported by any of these** and must be
rejected explicitly with a message telling the user to re-save as `.docx`
or PDF. Users will absolutely try it.

#### The failure case that will actually happen: scanned PDFs

None of these libraries do OCR. A resume exported as a **scan or image
PDF returns an empty string, not an error.** This is common with resumes
people have printed and re-scanned.

Handle it explicitly: if extracted text is under ~200 characters, do
**not** send it to the AI. Return a specific error and have the UI say:

> We couldn't read any text from that file — it may be a scanned image.
> Please paste your resume text instead.

The paste textarea from §3.1 stays available at all times as the escape
hatch, which is another reason to build it first.

#### Format validation on the frontend

Validate **before** any network call, and again server-side (a frontend
check is UX, never a control):

| Check | Rule | Message to the user |
|---|---|---|
| Extension + MIME | `.pdf`, `.docx`, `.txt`, `.md` | "Please upload a PDF, DOCX, TXT, or MD file." |
| Legacy Word | `.doc` rejected by name | "Old .doc files aren't supported — please save as .docx or PDF." |
| Size | ≤ 5 MB | "That file is over 5 MB. Please upload a smaller file or paste the text." |
| Empty file | 0 bytes | "That file appears to be empty." |

- Set `accept=".pdf,.docx,.txt,.md"` on the input, but **do not rely on
  it** — it is a filter hint, is trivially bypassed, and **does not apply
  to drag-and-drop at all**. The explicit check must run on both the
  `change` and `drop` handlers.
- Errors render inline in the resume group (reuse the
  `.api-key-status error` styling already in `style.css`), not as a
  toast — the user needs it to persist while they pick another file.

**Server-side validation is the real control**, since extension and
`Content-Type` are both attacker-controlled:

- Magic bytes: PDF must start `%PDF-`; DOCX must start `PK\x03\x04`.
- Hard size cap enforced by the body parser, not just checked after.
- A parse timeout, so a malformed or deeply-nested PDF cannot occupy a
  request thread indefinitely.
- Reject encrypted/password-protected PDFs with a clear message rather
  than letting the parser throw a raw error.

---

## 4. The two-pass AI design

### 4.1 Pass 1 — extract a structured profile

New AI call: **resume text → `ResumeProfile` JSON**. Nothing about the
interview is generated yet.

```ts
export interface ResumeProfile {
  /** Ranked most-central-first. Drives the interview's topic coverage. */
  primarySkills: string[];        // ≤ 12
  secondarySkills: string[];      // ≤ 12
  /** Short neutral descriptions — NO employer names, NO project names
   *  that identify a company. See §5. */
  projects: Array<{ summary: string; technologies: string[] }>;  // ≤ 6
  domains: string[];              // ≤ 5  e.g. "fintech", "IoT"
  /** Total years of professional experience the resume evidences. */
  yearsOfExperience: number | null;
  /** What the resume reads as, independent of what the user picked.
   *  Advisory only — never overrides the user's choice. See §8. */
  inferredLevel: DifficultyLevel | null;   // the type/index.ts re-export
  /** Claims worth probing: "led migration to microservices",
   *  "optimized query performance 10x". Interview gold. */
  notableClaims: string[];        // ≤ 8
}
```

`notableClaims` is the highest-value field in the whole feature: it is
what lets the interview ask *"you wrote that you cut query time 10× —
walk me through what was actually slow"* instead of a generic Postgres
question. It also pairs directly with the Staff/Principal
claim-verification pass already built in `DIFFICULTY_LEVEL_PLAN.md` §2.4.

**Prompt** — new `getResumeExtractionPrompt(resumeText)` in
`promptBuilder.ts`, reusing the existing defenses verbatim:

```ts
export const getResumeExtractionPrompt = (resumeText: string): string => `
You are analyzing a candidate's resume to prepare a technical interview.

${fenceUntrustedInput('resume', sanitizeResumeInput(resumeText))}

Extract ONLY what the resume actually evidences. Do not invent skills,
do not infer a technology merely because a related one is present, and
do not pad the lists to fill them.

PRIVACY — this is a hard requirement:
- Do NOT include the candidate's name, email, phone, address, or links.
- Do NOT include employer names, client names, or school names.
- Describe each project by WHAT IT DID and WHAT IT USED, never by who
  it was for.

Return ONLY valid JSON: { … }`;
```

`sanitizeResumeInput` is `sanitizeJDInput` generalized to take a max
length (`sanitizeUntrustedText(text, maxLen)`), with the JD call site
keeping its 5,000 default so its behavior is bit-for-bit unchanged.

**Validation** — new `validateResumeProfile(data, providerName)` in
`baseService.ts`, in the same style as `validateQuestions`: pure, returns
a new normalized object, hard-caps every array at the bounds above,
truncates every string, coerces `yearsOfExperience` to a sane 0–60
number or `null`, and drops `inferredLevel` unless it is one of the four
known ids. An unparseable profile throws `AppError(502)` and
`runWithProviderChain` moves to the next provider — exactly like a
malformed question array today.

**New abstract method** on `BaseAIService`:

```ts
abstract extractResumeProfile(resumeText: string): Promise<ResumeProfile>;
```

⚠️ **This is the one compile-breaking change in the plan.** All three
providers must implement it or the build fails. Each is a 6-line method
identical in shape to `generateQuestions` — `groqService.ts`,
`geminiService.ts`, `nvidiaService.ts`.

### 4.2 Pass 2 — generate questions from the profile

`getQuestionsPrompt` gains one branch, directly above the JD branch it
mirrors:

```ts
if (techStack === 'Resume' && options?.resumeProfile) {
  return getResumeQuestionsPrompt(
    options.resumeProfile, count, options.previousQuestions, level
  );
}
```

`getResumeQuestionsPrompt` renders the profile as a compact block (not
raw resume text) and instructs:

- Cover `primarySkills` first; touch `secondarySkills` only if count allows.
- At least one question per project, tied to the technologies it lists.
- **Probe `notableClaims` directly** — make the candidate substantiate
  what they wrote.
- Ask nothing outside the profile: "if the resume does not evidence it,
  do not ask about it."
- Then the standard `buildLevelQuestionGuidance(level)` block, unchanged.

### 4.3 Why two passes and not one

One pass ("here's a resume, ask questions") would work and is cheaper.
Two is still the right call:

- **It is the actual ask** — "AI should *first* extract the relevant tech
  stack" is a stated requirement, and a visible extraction step is what
  makes it real to the user (§10.2).
- **Prompt size stays flat.** A 10,000-char resume is ~2,500 tokens. Sent
  once for extraction, then replaced by a ~400-token profile for question
  generation — and, critically, for *every later* `extendSession` call.
  Under the one-pass design the full resume would be re-sent on every
  extend, on top of the accumulating `previousQuestions` list. Groq's TPM
  cap (see `config.ts`'s `groqMaxCompletionTokens` comment — this app has
  already been bitten by it) makes that a live risk, not a theoretical one.
- **It gives the user something to correct.** Extraction is where OCR
  noise and resume quirks show up; surfacing it is what lets a user fix
  "React Native" being read as "React" before 15 questions are built on
  the mistake.

Cost: one extra AI call per interview start. That is acceptable — it
happens once, on a screen that already shows a loading state.

### 4.4 The opening sequence — introduction, then best project

A real interview does not open with a technical question. Resume mode
pins the first two:

| # | Question | Why it's pinned |
|---|---|---|
| 1 | **Introduction** — "Tell me about yourself: walk me through your background and how you got here." | Every real interview starts here. It also settles the candidate's nerves before anything is being scored hard. |
| 2 | **Best project, narrated** — "Walk me through the project you're most proud of: your role, what you built, the hard part, and what you'd do differently." | This is where an interviewer actually forms their read: scope, ownership, decision-making, and whether the candidate can *narrate* work coherently. Nothing else in this app currently tests that. |

**Build them deterministically in the service, not by asking the model
to "please put them first."** A prompt instruction is a request, not a
guarantee — a model that ignores it produces an interview missing the
two questions the feature exists for.

So `startSession` composes the array:

```
[ Q1 introduction ]  +  [ Q2 project narration ]  +  [ AI-generated technical × (count − 2) ]
```

- Q1 is a fixed template — the standard opener needs no personalization.
- Q2 is personalized from data already extracted: when
  `profile.projects[0]` exists, name it — *"You listed a payments
  platform built with Node and Kafka — walk me through it…"* — otherwise
  fall back to the generic phrasing. No extra AI call.
- The generation prompt asks for `count − 2` questions and is told:
  *"Do not ask a general 'tell me about yourself' or 'describe your best
  project' question — both are already covered."* One line, prevents
  duplicates.
- Both openers **count toward the user's selected total**. With a
  5-question interview that is 3 technical questions, which is why
  Resume mode should enforce a **minimum count of 5**.
- `extendSession` must **not** prepend them again. The composition
  belongs in `startSession` only — `extendSession` already passes
  `previousQuestions`, so the model won't re-ask them either.

A new optional field on `QuestionData` carries the distinction:

```ts
kind?: 'introduction' | 'project_narration' | 'technical';
```

Optional, so absence means `'technical'` and **no existing question row,
test factory, or code path changes**. It persists for free — `questions`
is already a `Json` column.

### 4.5 Scoring the narrative questions (do not skip this)

**This is the part that quietly breaks if it isn't planned for.** The
current rubric in `buildLevelEvaluationGuidance` scores every answer on
Theory depth / Practical application / Communication clarity /
Completeness. Score "tell me about yourself" against *Theory depth* and
the candidate gets a structurally low mark on a question that has no
theory in it — and since `computeOverallScore` is a straight average of
completed evaluations, the two opening questions would drag every Resume
interview's headline score down by construction.

Fix it the same way the difficulty-level feature did: **keep the four
dimension names, swap what they mean.** Nothing downstream —
`computeOverallScore`, `validateEvaluation`, the client's rendering —
needs to know anything changed.

| Dimension | Technical question (today) | Narrative question (Q1/Q2) |
|---|---|---|
| Theory depth | Understanding of underlying concepts | **Substance** — real technical detail and genuine ownership, not a vague summary |
| Practical application | Applying knowledge to real scenarios | **Specifics** — named technologies, actual decisions, trade-offs, numbers |
| Communication clarity | Clear, well-structured explanation | **Narration flow** — context → problem → action → result, easy to follow |
| Completeness | Key aspects covered | **Coverage** — role, scope, outcome, and what they'd change |

Implementation: `getEvaluationPrompt(question, answer, levelId, kind?)`
picks the narrative variant of that block when `kind` is `'introduction'`
or `'project_narration'`. The weights stay the level's own weights, so
the level calibration still applies — a Staff/Principal candidate is
still held to a higher bar on how they narrate a project. Same treatment
for `getAnswerGuidancePrompt`, so "how should I have answered this"
doesn't return a code sample for "tell me about yourself".

`_evaluateAndPersist` already reads the question object (it passes
`question.topic` today), so threading `question.kind` through is a
one-line change.

---

## 5. Privacy — what gets stored, and what deliberately does not

**This needs an explicit decision, because this app's session model makes
it consequential.** Anonymous sessions are readable by anyone holding the
session UUID (`getOwnedSession`, by design — see the anonymous-history
note in `interview.routes.ts`). A resume is the most PII-dense document a
user has: full name, phone, email, address, employers, schools.

**Recommendation: never persist the raw resume text.**

| | Stored? |
|---|---|
| Raw resume text | ❌ Never written to the DB. Lives in the request body, goes into pass 1, is discarded. |
| `ResumeProfile` (PII-stripped by the pass-1 prompt) | ✅ Stored — `extendSession` needs it |
| Generated questions | ✅ As today |

This costs nothing functionally: `extendSession` needs the *profile*, not
the resume, so there is no feature that requires keeping the text.

It does mean the pass-1 prompt's PII instruction (§4.1) is a real control,
not decoration — so `validateResumeProfile` should additionally scrub
anything that looks like an email or a phone number from profile strings
before storage. Cheap belt-and-braces on a model instruction.

A `jobDescription`-style `resumeText @db.Text` column is therefore
**deliberately not proposed**. If it is ever added, `GET /:sessionId`
must strip it from the response first.

---

## 6. Data model

Two additive, nullable columns on `Session` — no change to any existing
column, so every current row stays valid:

```prisma
model Session {
  // …
  /** PII-stripped structured profile extracted from the candidate's
   *  resume (techStack === 'Resume' only). Null for every other mode.
   *  The raw resume text is deliberately NOT stored — see
   *  docs/project-improvement/RESUME_MODE_PLAN.md §5. */
  resumeProfile    Json?
  /** What the candidate asked for at start time, when they chose
   *  explicitly. Null means "server default applied". Kept so history
   *  can show it and so extend has the original intent. */
  requestedQuestionCount Int?
  // …
}
```

Plumbing, each one line, matching how `difficultyLevel` was threaded:

- `types/index.ts` — `ResumeProfile` interface; `resumeProfile?` on
  `GenerationOptions` and `StartSessionOptions`; `resumeProfile: ResumeProfile | null`
  on `SessionData` (**nullable, not required** — unlike `difficultyLevel`,
  this must not force every test factory to be touched).
- `interview.repository.ts` — `toSessionData` (cast + `?? null`),
  `createSession`'s `data` block, `updatableFields`. **Not** in
  `toHistorySummary`'s `Pick<>`/`select` — a history row has no use for
  it, and [P4-05] deliberately keeps that projection minimal.

---

## 7. Selectable question count

### 7.1 Server — already done, with one wrinkle

`POST /start` already accepts and validates `questionsCount` (1–50), and
`startSession` already prefers it over the config default. Nothing to
build.

The wrinkle: `getJDQuestionsPrompt` contains

```ts
const effectiveCount = Math.max(count, 15); // Minimum 15 for JD mode
```

so in JD mode a user asking for 5 silently gets 15. Once the count is a
visible control, that becomes a bug the user can see.

**Recommendation:** apply the floor only when the count was *not*
explicitly chosen. `startSession` already knows the difference; pass an
`explicitCount: boolean` (or simply resolve the floor in `startSession`
where the branch already exists, and let the prompt builder honor
whatever it is handed). **Resume mode gets no floor at all.**

### 7.2 UI

A segmented control in the setup panel, beside the level picker:

```
Number of Questions:  [ 5 ] [ 10 ] [ 15 ] [ 20 ]  [ custom: __ ]
```

- Default = `serverConfig.questionsPerInterview` (10), or
  `jdQuestionsPerInterview` (15) in JD mode — i.e. **untouched behavior
  for anyone who ignores the control**.
- Custom input bounded 3–30 client-side; the server's own 1–50 check
  stays as the real guard.
- **Resume mode enforces a minimum of 5**, because the two pinned
  openers (§4.4) come out of the same total — below 5 there would be
  fewer than three technical questions.
- Drives the existing `#question-count-display` text, replacing the
  hardcoded strings in `onTechStackChange()`. In Resume mode it should
  read something like `10 Questions (2 intro + 8 technical)` so the
  split is never a surprise.

### 7.3 The token ceiling nobody will remember later

`GROQ_MAX_COMPLETION_TOKENS` defaults to **4096**, and `config.ts`'s own
comment says that comfortably covers *a 15-question JSON array*. So:

- ≤ 15 questions: fine today.
- 20+: the JSON array risks being truncated mid-response → `extractJson`
  fails → retries → provider switch → a slow, confusing failure.

Two options, in order of preference:

1. **Chunked generation** for counts > 15: generate in two calls, passing
   the first batch as `previousQuestions` — a mechanism that already
   exists and is already tested (it is exactly what `extendSession`
   does). Merge and renumber. No config change, works on every tier.
2. Cap the UI at 15 and document `GROQ_MAX_COMPLETION_TOKENS` for
   self-hosters.

Ship (2) with Phase 1 if time is short; (1) is the correct answer.

---

## 8. Interaction with Interview Level

Resume mode and the difficulty level both say something about seniority,
and they can disagree. Resolution:

- **The user's explicit level always wins.** It calibrates the questions,
  the rubric, and the scoring, exactly as it does in every other mode.
  `inferredLevel` never silently overrides it.
- `inferredLevel` is used **only** to offer a nudge after extraction:
  *"Your resume reads like ~6 years — try Senior Software Engineer?"*
  with a one-click switch. Dismissible, never automatic.
- Practicing above your level is a legitimate use case; auto-downgrading
  someone to what their resume implies would be both wrong and rude.

Resume mode also feeds the existing Staff/Principal deep-verification
pass unusually well: `notableClaims` gives the claim-verification step
concrete resume assertions to check the spoken answer against.

---

## 9. API

### `POST /api/interviews/resume/parse` (new — Phase 4)

Turns an uploaded file's bytes into plain text. Stateless: parses in
memory, returns the text, stores nothing.

```
Request:  raw bytes, Content-Type: application/pdf
                                | application/vnd.openxmlformats-officedocument.wordprocessingml.document
                                | text/plain | text/markdown
Response: { success: true, data: { text: string, truncated: boolean } }
```

- Body handled by a **route-scoped** `express.raw({ type: [...], limit: '5mb' })`.
  Raw bytes, not base64 — no 33% inflation, and no `multer`, no
  `memoryStorage`, no disk. Note the app-wide `express.json` limit is
  **1 MB**, which a base64'd PDF would blow straight through; scoping a
  raw parser to this one route avoids raising the global limit.
- Dispatch on `Content-Type`, then **verify magic bytes** before parsing
  (`%PDF-` / `PK\x03\x04`) — both the extension and the header are
  client-controlled.
- Truncate extracted text to the 10,000-char limit and report
  `truncated: true` so the UI can say so.
- Under ~200 chars extracted → `400` with the scanned-PDF message (§3.2).
- Same tight rate limiter as `/analyze` — it is unauthenticated and
  burns CPU.

Keeping parse and analyze as **separate endpoints** means a failed AI
call doesn't force the user to re-upload, and pasted text and uploaded
text converge on the identical downstream path.

### `POST /api/interviews/resume/analyze` (new)

Runs pass 1 alone, so the UI can show the extracted stack before
committing to an interview.

```
Request:  { resumeText: string }              // ≤ 10,000 chars
Response: { success: true, data: ResumeProfile }
```

- `attachUserIfPresent` (anonymous-friendly, like `/start`).
- `validateBody({ resumeText: { required: true, type: 'string', maxLength: 10000 } })`.
- **Its own rate limiter.** This is an unauthenticated endpoint that
  burns an AI call per request — the tightest limiter in the app,
  modelled on `historyLookupLimiter`. Non-negotiable.
- Goes through `runWithProviderChain`, so it gets provider fallback for
  free.

### `POST /api/interviews/start` (extended)

```
+ resumeProfile?: ResumeProfile   // required when techStack === 'Resume'
+ questionsCount?: number         // already supported
```

Controller check, mirroring the existing JD one:

```ts
if (techStack === 'Resume' && !resumeProfile) {
  return next(new AppError('Resume analysis is required for Resume mode', 400));
}
```

**The trust question.** `resumeProfile` comes back from the client, so it
is untrusted input again. Two options:

- **(A) Re-validate strictly — recommended.** Run the client-supplied
  object through the *same* `validateResumeProfile` used on AI output
  (caps every array, truncates every string, drops unknown fields), then
  fence it in the prompt like any other untrusted text. Net exposure is
  strictly *lower* than what already ships: JD mode accepts 5,000 chars
  of arbitrary free text into a prompt today, and a bounded, schema-shaped
  profile is a much smaller surface than that.
- **(B) Server-side cache.** `/analyze` returns an `analysisId`; the
  server keeps the profile in a short-TTL map and `/start` takes the id
  plus a list of skill indices to *deselect*. Nothing free-form crosses
  the wire. Stronger, but adds server state that won't survive a restart
  or a second instance — and this app runs a DB-optional in-memory
  fallback precisely because it doesn't want to depend on that.

Go with (A). Revisit only if the app ever accepts resumes from a party
other than the interviewee.

---

## 10. Frontend

### 10.1 Files touched

| File | Change |
|---|---|
| `index.html` | `#resume-input-group` (textarea + file input + dropzone); `#question-count-group` segmented control |
| `app.js` | `onTechStackChange()` → show/hide resume group; `validateResumeFile(file)`; `parseResumeFile(file)`; `analyzeResume()`; `startInterview()` sends `resumeProfile` + `questionsCount` |
| `uiManager.js` | `'Resume'` entry in the stack-icon map; `'Resume'` in `populateSelects`'s hardcoded fallback list; `renderResumeAnalysis(profile)`; `showResumeError(msg)` |
| `style.css` | Dropzone + its drag-over state, extracted-skill chips, the segmented count control, the analysis panel |

### 10.2 The flow

```
Tech Stack: Resume
     │
     ├─ paste text ─────────────────────────────┐
     │                                          │
     └─ pick/drop a file                        │
            ↓  validateResumeFile()  ← extension, MIME, size, .doc
            ↓  POST /resume/parse (raw bytes)   │
            ↓  text fills the textarea, editable ┘
                              ↓  "Analyze Resume"
                              ↓  POST /resume/analyze
   ┌───────────────────────────────────────────────────────┐
   │ Detected from your resume                             │
   │  [React ×] [Node.js ×] [PostgreSQL ×] [Docker ×]      │
   │  4 projects · ~6 yrs                                  │
   │  💡 Reads like Senior Software Engineer — switch?     │
   └───────────────────────────────────────────────────────┘
                              ↓  [Start Interview]
                    POST /start { techStack: 'Resume',
                                  resumeProfile, questionsCount }
```

Parsed text lands **in the visible textarea**, not in a hidden variable.
The user can see exactly what was extracted and fix mangled formatting
(multi-column resumes parse badly in every library) before the AI ever
sees it. It also means the file path and the paste path converge
immediately — one downstream code path, not two.

Deselecting a chip removes that skill from the profile sent to `/start`.
This is the whole reason to split the endpoint: the user sees what the AI
understood, and fixes it *before* fifteen questions are built on a
misread. It also makes the "AI extracts the stack first" requirement
something the user can actually observe.

`#interview-stack-badge` shows `Resume`; the badge row already handles a
second badge since the level feature landed.

---

## 11. Not breaking what works

Explicit, because this is the standing constraint on this codebase:

- Every schema change is **additive and nullable**. No existing column
  changes type, nullability, or default.
- `SessionData.resumeProfile` is **optional/nullable**, so no existing
  test factory or literal construction needs touching — unlike
  `difficultyLevel`, which was required and forced edits across the test
  suite.
- `TECH_STACKS` only gains a member. Every existing value keeps working.
- `getQuestionsPrompt` gains a branch guarded on `techStack === 'Resume'
  && options?.resumeProfile`; the standard, JD, and extend paths are
  untouched.
- `sanitizeJDInput` → `sanitizeUntrustedText(text, maxLen = 5000)` keeps
  the JD call site's behavior identical.
- `QuestionData.kind` is **optional** — absent means `'technical'`, so
  every existing question row, every test factory, and every non-Resume
  interview behaves exactly as today.
- `getEvaluationPrompt` / `getAnswerGuidancePrompt` gain an **optional
  trailing `kind` parameter**. Omitted (every existing call site until
  updated) → the current technical rubric, unchanged.
- The narrative rubric changes dimension *descriptions* only. The four
  dimension **names**, the 0–10 score, and `EvaluationResult`'s shape are
  untouched, so `computeOverallScore` and the client need no changes.
- `express.raw` for `/resume/parse` is **route-scoped**. The global
  `express.json({ limit: '1mb' })` is not raised.
- The question-count control defaults to today's config values, so a user
  who never touches it gets exactly today's interview.
- **The one breaking change** is the new abstract method on
  `BaseAIService` — a compile error until all three providers implement
  it. Called out here so it is not discovered at build time.
- New runtime deps (`pdf-parse`, `mammoth`) land in **Phase 4 only** —
  Phases 1–3 add no dependencies at all.
- `npm run verify` (lint + typecheck + test + build) must pass before
  this is considered done.

---

## 12. Phasing

Ordered so each phase is independently shippable and the riskiest work
comes after the cheapest win.

1. **Question count.** Frontend control + the JD floor fix. No AI change,
   no schema change, no new endpoint, no new dependency. Ship alone.
2. **Resume mode core.** `'Resume'` in `TECH_STACKS`, paste textarea,
   `/resume/analyze`, extraction prompt + validator + three provider
   methods, question prompt branch, `resumeProfile` column, the pinned
   opening sequence (§4.4) + narrative rubric (§4.5), extend support.
   This is the feature.
3. **Extraction review UI.** Skill chips, deselection, level nudge.
   (Phase 2 can ship with an auto-analyze-then-start flow if this slips.)
4. **File input.** `pdf-parse` + `mammoth`, `/resume/parse`, frontend
   format validation, dropzone, scanned-PDF fallback messaging. First
   phase that adds a runtime dependency.
5. **Polish.** Chunked generation for counts > 15; resume-aware history
   labels.

§4.4 and §4.5 are deliberately inside Phase 2 rather than deferred: the
opening sequence is a stated requirement, and shipping it *without* the
narrative rubric would push every Resume interview's headline score down
— a regression that would be hard to attribute later.

---

## 13. Tests worth adding

- `POST /start` with `techStack: 'Resume'` and no `resumeProfile` → 400.
- `'Resume'` passes the `oneOf` allowlist; a bogus stack still 400s.
- `validateResumeProfile` caps oversized arrays, truncates long strings,
  rejects a non-object, and drops an unknown `inferredLevel`.
- Extraction output containing an email/phone is scrubbed before storage.
- `getResumeQuestionsPrompt` includes `primarySkills` and `notableClaims`,
  and contains no raw resume text.
- `extendSession` on a Resume session re-passes `resumeProfile` and
  produces non-duplicate questions.
- `questionsCount: 5` in JD mode yields 5 (not 15) once the floor is
  conditional — a regression guard on the §7.1 change.
- A Resume session round-trips through the repository with
  `resumeProfile` intact, and a non-Resume session stores `null`.

Opening sequence (§4.4):

- A Resume session's `questions[0].kind === 'introduction'` and
  `questions[1].kind === 'project_narration'`, **even when the AI returns
  a malformed or short array** — the whole point of composing them in the
  service.
- Requesting 10 questions yields exactly 10 total, not 12.
- Q2 names the top project when `profile.projects` is non-empty, and
  falls back to the generic phrasing when it is empty.
- `extendSession` on a Resume session adds **no** further intro/project
  questions.
- A non-Resume session has no `kind` on any question — nothing changed
  for JD or standard mode.

Narrative rubric (§4.5):

- `getEvaluationPrompt(q, a, level)` with no `kind` produces the exact
  current prompt, byte for byte — the regression guard for every existing
  interview.
- `kind: 'introduction'` swaps the dimension descriptions but keeps the
  four names and the level's weights.

File parsing (§3.2, Phase 4):

- `.doc`, `.rtf`, `.pages`, and an extensionless file are each rejected
  client-side with their own message.
- A PDF whose bytes don't start `%PDF-` is rejected server-side even when
  `Content-Type: application/pdf` is set — the extension-lies test.
- A text-free (scanned) PDF returns the 400 + paste-instead message
  rather than an empty analysis.
- A 6 MB file is rejected by the body limit, not after parsing.
- Extracted text over 10,000 chars is truncated and flagged.

- **Existing suite must pass untouched** — no test file should need
  editing for this feature. If one does, the nullability rule in §11 was
  violated.

---

## 14. Open choices

1. **Resume text limit** — 10,000 chars proposed. Higher covers a
   10-year CV; lower is safer against TPM caps.
2. **Extraction review step (§10.2)** — recommended, but Phase 2 could
   ship analyze-and-start in one click and add the review in Phase 3.
3. **Counts above 15** — chunked generation (correct) vs. capping the UI
   at 15 (fast). §7.3.
4. **Storing raw resume text** — the plan says never (§5). Confirm, since
   it forecloses features like "show me my resume next to my answers".
5. **PDF module** — `pdf-parse` recommended for this CommonJS codebase.
   `unpdf` is the nicer library and the right answer *if* the project
   moves to ESM (`module: "Node16"`); today it needs a dynamic-import
   escape hatch. §3.2.
6. **Whether Q1/Q2 are scored at all** — the plan scores them on a
   narrative rubric (§4.5). The alternative is to mark them
   unscored/practice-only, which protects the headline number but throws
   away signal on exactly the thing you said interviewers judge most.
   Recommendation: score them.

---

## 16. Implementation record

What actually shipped, against the phasing in §12:

- **Phase 1 (question count) — done.** A segmented 5/10/15/20/Custom
  control on the setup panel (`#question-count-options` +
  `#question-count-custom`, index.html/app.js/style.css). Left untouched,
  behavior is byte-for-byte what it was before the control existed
  (`app.questionCountExplicit` stays `false`); touching it sends an
  explicit `questionsCount` for **any** tech stack, not just JD. The §7.1
  floor fix (`explicitQuestionCount` threaded through `startSession` →
  `GenerationOptions` → `getJDQuestionsPrompt`) shipped alongside it.
- **Phase 2 (Resume mode core) — done, paste-only.** Everything in §4
  through §10 except the file-input piece of §10: `'Resume'` in
  `TECH_STACKS`, `POST /resume/analyze`, the extraction/question prompts,
  `validateResumeProfile`, the three provider `extractResumeProfile`
  implementations, `resumeProfile Json?` on `Session`, the deterministic
  opening sequence (§4.4) via `composeResumeOpeningQuestions`, and the
  narrative rubric variant (§4.5) via `QuestionKind` +
  `isNarrativeKind`/`buildLevelEvaluationGuidance`. Frontend: a paste
  textarea (`#resume-input-group`, mirroring `#jd-input-group`), an
  "Analyze Resume" button, and a read-only extraction summary
  (`uiManager.renderResumeAnalysis`) with a "use this level" nudge when
  `inferredLevel` disagrees with the selected level.
- **Phase 3 (extraction review UI) — folded into Phase 2**, per §12's own
  note that this could ship alongside Phase 2 rather than after it: the
  skill/project/domain summary and level nudge are the "review" step:
  there's no per-skill deselection (open choice, not asked for), but the
  candidate sees exactly what was extracted before starting, and can
  edit-and-re-analyze if it's wrong (editing the textarea invalidates the
  stored profile client-side, per `resume-textarea`'s input listener).
- **Phase 4 (file upload — `pdf-parse`/`mammoth`) — deferred, not
  built.** This sandbox's `npm install` fails with a registry 403
  (`E403` on `yocto-queue@0.1.0`), so no new runtime dependency could
  actually be installed and exercised here. Phase 4 was always the
  correct place to stop for that reason — §12 explicitly calls it "first
  phase that adds a runtime dependency." `.txt`/`.md` paste already works
  today (it's just text in the textarea); `.pdf`/`.docx` upload is the
  only piece left, exactly as scoped in §3.2/§9's `POST /resume/parse`.
- **§13 tests — added**, all without requiring real `tsc`/`jest` (same
  constraint as above): `tests/unit/promptBuilder.test.ts` (new — JD
  floor regression through the public `getQuestionsPrompt` entry point,
  Resume prompt dispatch, extraction prompt PII instruction + truncation,
  narrative-rubric passthrough for both `getEvaluationPrompt` and
  `getAnswerGuidancePrompt`), `validateResumeProfile` bounds/truncation/
  PII-scrub/statusCode tests appended to `tests/unit/baseService.test.ts`,
  a `resumeProfile` round-trip pair appended to
  `tests/integration/interview.repository.test.ts`, and a new
  `tests/integration/interview.routes.resume.test.ts` covering the 400
  without a profile, the `oneOf` allowlist, the opening-sequence
  composition + personalization + renumbering end-to-end through
  `POST /start`, the 5-question floor, `POST /resume/analyze`'s
  happy path, and the JD floor fix at the HTTP layer (asserting on the
  actual prompt text sent to the mocked AI call). Verified only by
  careful manual tracing against the real source + `node --check` on the
  touched `.js`/`.html`/`.css` — flagged here so a real `npm run verify`
  is still owed once dependency installation works.
- **One documented, anticipated consequence of §11's "one breaking
  change"**: `tests/unit/baseService.test.ts`'s `TestAIService` now
  implements `extractResumeProfile` (the new abstract method), and
  `tests/helpers/mockPrisma.ts`'s `MockSessionRecord` gained a
  `resumeProfile` field (with `tests/integration/interview.service.extend.test.ts`'s
  `seedSession` updated to set it) — both were already called out in §11
  as the expected fallout of making `extractResumeProfile` abstract, not
  a new violation of the "no test file should need editing" aspiration
  in §13.
- **Scope trim**: §6's `requestedQuestionCount Int?` schema column was
  not added — `questionsCount` never needed persisting on the session row
  itself (it only shapes generation at `startSession` time, same as
  `additionalCount` on extend), so it was dropped as unnecessary rather
  than shipped speculatively.

---

## 15. Changelog

- **v3** — Implemented Phases 1–2 (question-count control, Resume mode
  core, narrative rubric, JD floor fix) plus the §13 test list; Phase 4
  (file upload) deferred for a sandbox-specific reason, not a design
  change. See §16 for the full record.
- **v2** — File parsing moved from browser-side (vendored pdf.js) to
  **server-side buffer parsing**, on the argument that nothing is being
  uploaded in the storage sense either way and the production CSP makes
  vendoring a deploy-time trap (§3.2). Added researched module
  comparison, frontend + server-side format validation, and the
  scanned-PDF failure path. Added the pinned opening sequence —
  introduction, then best-project narration (§4.4) — and the narrative
  rubric that keeps those two from dragging down the overall score
  (§4.5).
- **v1** — Initial plan.
