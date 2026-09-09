# NeuroStack Voice: AI Interview Voice Application

A browser-based AI technical interview application built with **Node.js, Express, TypeScript, Prisma, and Socket.IO** on the backend, and **vanilla HTML/CSS/JavaScript** on the frontend.

It leverages browser-native **Web Speech APIs** (`speechSynthesis` and `SpeechRecognition`) to deliver a fully local speech interaction loop without requiring external third-party Text-to-Speech (TTS) or Speech-to-Text (STT) APIs.

---

## Key Features

1. **Three AI model providers**: Google Gemini, Groq (Llama), and NVIDIA (Nemotron) for question generation and answer evaluation, with automatic fallback to a second provider if the first fails.
2. **Accounts**: Email/password sign-up and login. Interview sessions and history are private to the account that created them.
3. **Bring-your-own Gemini key**: Users may optionally save their own encrypted Gemini API key (used instead of the server's) or supply one ad-hoc when starting an interview.
4. **Local Text-to-Speech (TTS)**: Reads technical questions aloud using native `speechSynthesis`, with selectable voice profiles.
5. **Local Speech-to-Text (STT)**: Uses continuous `webkitSpeechRecognition` to capture responses with a live transcript.
6. **Smart silence detection**: Auto-stops recording after a configurable period of silence.
7. **Editable transcript**: Before submitting, the candidate can review and correct the recognized text, or re-record.
8. **Real-time Socket.IO syncing**: Handles state transitions, evaluation results, and interview completion — authenticated per-connection, scoped to the owning user.
9. **End-to-end evaluation**: Each answer is scored out of 10 with feedback; the final report gives an overall score out of 100.
10. **PostgreSQL persistence via Prisma**, with a bounded in-memory fallback if the database is briefly unreachable.

---

## Technical Architecture

```
                    ┌────────────────────────┐
                    │     Client Browser     │
                    │ (HTML5 / Vanilla CSS)  │
                    └───────────┬────────────┘
                                │
             WS / Events        │ HTTP REST (cookie auth)
           (Socket.IO-client)   │ (Fetch)
                                │
  ┌─────────────────────────────▼─────────────────────────────┐
  │                   Node.js Express Server                  │
  │                         (TypeScript)                      │
  ├──────────────┬────────────────────────────┬───────────────┤
  │ HTTP Routes  │  Socket.IO (auth middleware)│  Middleware   │
  └──────┬───────┴──────────────┬─────────────┴───────┬───────┘
         │                      │                     │
         └──────────────┐       │                     │
                        ▼       ▼                     │
               ┌──────────────────┐                   │
               │  Service Layer   │                   │
               │ auth / interview │                   │
               │ / apiKey         │                   │
               └────────┬─────────┘                   │
                        │                             │
         ┌──────────────┴──────────────┐              │
         ▼                             ▼              ▼
 ┌──────────────┐              ┌───────────────┐ ┌──────────┐
 │  AI Factory  │              │  Repositories  │ │  Global  │
 ├──────────────┤              ├───────────────┤ │  Errors  │
 │  - Gemini    │              │  - Prisma/PG  │ └──────────┘
 │  - Groq      │              │  - In-Memory  │
 │  - NVIDIA    │              │    fallback   │
 └──────────────┘              └───────────────┘
```

Each AI provider call constructs a fresh, per-request service instance (never a shared singleton) — see `docs/project-improvement/phase-03-bug-fixes.md` for why that matters.

---

## Folder Structure

```
Neuro_stack_voice/
├── src/
│   ├── app.ts                  # Express app factory (no side effects — testable)
│   ├── server.ts                # Binds the port, wires Socket.IO, graceful shutdown
│   ├── config/
│   │   ├── config.ts             # Validated env config
│   │   └── database.ts           # Prisma client singleton + health ping
│   ├── http/
│   │   ├── routes/               # auth, interview, apiKey, health
│   │   ├── controllers/
│   │   └── middleware/           # auth, validate, errorHandler, notFound, requestId
│   ├── services/
│   │   ├── auth.service.ts
│   │   ├── interview.service.ts
│   │   ├── apiKey.service.ts
│   │   └── ai/                   # aiFactory + baseService + gemini/groq/nvidia
│   ├── repositories/             # interview.repository.ts, user.repository.ts
│   ├── sockets/                  # interview.socket.ts, auth.ts (handshake auth)
│   ├── types/                    # shared interfaces
│   └── utils/                    # appError, encryption, jwt, logger, promptBuilder
│
├── prisma/
│   └── schema.prisma
│
├── public/                       # Frontend (vanilla JS, served statically)
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js                # Core state coordinator
│       ├── authManager.js        # Register/login/logout/session-check
│       ├── speechEngine.js       # speechSynthesis wrapper (TTS)
│       ├── recognitionEngine.js  # SpeechRecognition wrapper (STT)
│       ├── socketManager.js      # Socket.IO client wrapper
│       └── uiManager.js          # DOM manipulation
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── docs/project-improvement/     # Audit, structure, bug-fix, security, testing,
│                                  # deployment, and final-verification reports
│
├── Dockerfile, docker-compose.yml, .dockerignore
├── package.json, tsconfig.json
└── .env.example
```

A handful of files from the pre-restructure codebase (`src/api/**`, `src/controllers/`, `src/interfaces/`, `src/middleware/`, `src/routes/`, and a few individual files) are kept on disk only as inert deprecation stubs — see `docs/project-improvement/phase-02-project-structure.md` for the full list and why they weren't deleted outright.

---

## Getting Started

### 1. Prerequisites
- **Node.js** 20 or later.
- **PostgreSQL** (a local instance, Docker, or a hosted provider like Supabase/Neon).
- **Google Chrome** (strongly recommended — best Web Speech API support).

### 2. Installation

```bash
npm install
```

### 3. Environment setup

```bash
cp .env.example .env
```

Fill in `.env`:
- At least one of `GROQ_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`.
- `ENCRYPTION_SECRET` and `JWT_SECRET` — each at least 32 characters, and **different from each other**. Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `DATABASE_URL` / `DIRECT_URL` — a PostgreSQL connection string (required in production; optional in development, where the app falls back to in-memory session storage if unreachable — but accounts/login always require a working database).
- `ALLOWED_ORIGINS` — required in production; a comma-separated list of allowed origins (no wildcard).

See `.env.example` for the full, commented list.

### 4. Database

```bash
npx prisma generate
npx prisma db push        # or: npx prisma migrate dev --name init
```

### 5. Running the project

Development (auto-reload):

```bash
npm run dev
```

Production:

```bash
npm run build
npm start
```

Or via Docker (also requires `POSTGRES_PASSWORD` — see `.env.example`; `docker compose up` runs database migrations automatically, in a one-shot `migrate` service, before starting the app — see `docker-compose.yml`):

```bash
docker compose up --build
```

Open **`http://localhost:3000`**.

### 6. Verifying your setup

```bash
npm run verify   # lint + typecheck + test + build
```

See `docs/project-improvement/phase-07-deployment-readiness.md` for the full production checklist.

### 7. Deployment constraints

**This service must currently run as a single instance — do not run more
than one replica.** Three pieces of runtime state live in process memory,
not in the database, and are not shared across instances:

- `pendingEvaluations` (`src/services/interview.service.ts`) — the map
  `endSession`'s bounded wait uses to find an in-flight background
  evaluation for this session.
- `memoryStore` and `dbUnavailableUntil` (`src/repositories/interview.repository.ts`)
  — the bounded in-memory fallback store and circuit-breaker state used
  when the database is briefly unreachable.

Behind two or more replicas, an answer submitted via one instance and an
interview ended via another means the second instance can't see the first
one's in-flight evaluation — it stops waiting and writes a "not scored in
time" placeholder for an answer that's actually being scored correctly
elsewhere. This is latent, not currently live: at one instance everything
works, and it costs nothing until a second replica exists. See
`docs/audit/06-DEFERRED-DECISIONS.md` §4 for the options for lifting this
constraint (deriving in-flight state from the already-persisted
`status: 'processing'` marker instead of an in-process Map is the
recommended path when horizontal scaling is actually needed) — do not add
a second replica without addressing this first.

---

## Detailed Application Workflow

1. **Sign in**: The user creates an account or logs in. The session is a JWT stored in an httpOnly cookie.
2. **Configure setup**: Selects a tech stack, an AI model, and an interviewer voice, then clicks **Start Interview**.
3. **AI question generation**: The backend calls the selected AI provider to generate a structured set of questions, persists the session (scoped to the account), and sends the first question to the client.
4. **Vocal output (TTS)**: The browser reads the question aloud.
5. **Listening loop (STT)**: The microphone starts automatically; a live transcript displays on-screen.
6. **Speech correction**: After silence is detected, the candidate reviews an editable transcript before submitting.
7. **Socket submission & scoring**: The answer is sent via an authenticated Socket.IO connection; the backend evaluates it and returns a score + feedback.
8. **Completion**: Once all questions are answered (or the candidate ends early), the backend requests an overall evaluation and returns the final report. Completed interviews appear in **History**, scoped to the signed-in account.

---

## Testing, linting, and CI

```bash
npm run lint         # ESLint
npm run format:check # Prettier
npm run typecheck    # tsc --noEmit
npm test             # Jest (unit + integration; AI providers are mocked, no real API calls or keys needed)
npm run build         # tsc -> dist/
```

GitHub Actions (`.github/workflows/ci.yml`) runs all of the above against a throwaway Postgres service container on every push/PR.

---

## Documentation

The full audit, restructuring rationale, bug-fix log, security write-up, testing report, and deployment guide live in [`docs/project-improvement/`](./docs/project-improvement/).

node scripts/test-provider-keys.mjs