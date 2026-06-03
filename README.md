# NeuroStack Voice: AI Interview Voice Application

A production-quality browser-based AI Interview application built with **Node.js, Express, TypeScript, and Socket.IO** on the backend, and **Vanilla HTML/CSS/JavaScript** on the frontend. 

It leverages browser-native **Chrome Web Speech APIs** (`speechSynthesis` and `SpeechRecognition`) to deliver a fully local speech interaction loop without requiring external third-party Text-To-Speech (TTS) or Speech-To-Text (STT) APIs.

---

## Key Features

1. **Dual AI Model Engine**: Choose between **NVIDIA Nemotron** (`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`) and **Groq Llama** (`llama-3.3-70b-versatile`) models for technical interview question generation and response evaluation.
2. **Automated API Fallback**: Built-in resilience. If one AI model provider fails during any stage, the system automatically falls back to the other.
3. **Local Text-to-Speech (TTS)**: Reads technical questions out loud using native `speechSynthesis`. Users can select different voice profiles directly in the browser.
4. **Local Speech-to-Text (STT)**: Uses continuous `webkitSpeechRecognition` to capture responses with live transcript visualization.
5. **Smart Silence Detection**: Auto-detects when the candidate stops speaking (default: 4 seconds of silence) to pause recording.
6. **Candidate Transcript Edit (Interactive Flow)**: After speech recording stops, the captured transcript is loaded into an editable text area. The candidate can verify and modify the recognized text before final submission or retry the voice recording.
7. **Real-time Socket.IO Syncing**: Live communication handles state transitions, interim transcription, evaluations, and interview completion.
8. **End-to-End Evaluation**: Backend uses AI models to grade each response with a score (out of 10), general feedback, and suggestions for improvement. The final report calculates an overall score (out of 100) and general analysis.
9. **Supabase Database Integration**: Stores session metadata, questions, transcripts, and evaluation results. Falls back gracefully to safe in-memory storage if credentials are not provided in `.env`.
10. **Stunning Glassmorphic Dark UI**: Modern dark theme complete with responsive layouts, customizable tech stack branding icons, and dynamic CSS status indicator animations (*Interviewer Speaking, Listening, Processing, Waiting for Submission, Idle*).

---

## Technical Architecture

```
                    ┌────────────────────────┐
                    │     Client Browser     │
                    │ (HTML5 / Vanilla CSS)  │
                    └───────────┬────────────┘
                                │
             WS / Events        │ HTTP REST
           (Socket.IO-client)   │ (Fetch)
                                │
  ┌─────────────────────────────▼─────────────────────────────┐
  │                   Node.js Express Server                  │
  │                         (TypeScript)                      │
  ├──────────────┬────────────────────────────┬───────────────┤
  │ API Routes   │      Socket.IO Handler     │  Middleware   │
  └──────┬───────┴──────────────┬─────────────┴───────┬───────┘
         │                      │                     │
         └──────────────┐       │                     │
                        ▼       ▼                     │
               ┌──────────────────┐                   │
               │  Service Layer   │                   │
               └────────┬─────────┘                   │
                        │                             │
         ┌──────────────┴──────────────┐              │
         ▼                             ▼              ▼
 ┌──────────────┐              ┌───────────────┐ ┌──────────┐
 │  AI Factory  │              │  Repository   │ │  Global  │
 ├──────────────┤              ├───────────────┤ │  Errors  │
 │  - NVIDIA    │              │  - Supabase   │ └──────────┘
 │  - Groq      │              │  - In-Memory  │
 └──────────────┘              └───────────────┘
```

---

## Folder Structure

```
NeuroStack voice/
├── src/
│   ├── config/
│   │   └── index.ts              # Config validation & dotenv
│   ├── api/
│   │   ├── routes/
│   │   │   ├── index.ts          # Express Router aggregator
│   │   │   └── interview.routes.ts
│   │   ├── controllers/
│   │   │   └── (Inlined into services/routes for simple architecture)
│   │   ├── services/
│   │   │   ├── interview.service.ts # Core orchestration
│   │   │   └── ai/
│   │   │       ├── base.service.ts  # Base abstract AI service
│   │   │       ├── ai.factory.ts    # Model selection & fallback handler
│   │   │       ├── nvidia.service.ts# NVIDIA API handler
│   │   │       └── groq.service.ts  # Groq API handler
│   │   └── repositories/
│   │       └── interview.repository.ts # Supabase & In-Memory storage
│   ├── sockets/
│   │   └── interview.socket.ts   # Real-time WebSocket handlers
│   ├── middleware/
│   │   └── errorHandler.ts       # Central Express error handling
│   └── utils/
│       └── promptBuilder.ts      # Structured prompting prompts
│
├── public/                       # Frontend SPA
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js                # Core state coordinator
│       ├── speechEngine.js       # synthesis wrapper (TTS)
│       ├── recognitionEngine.js  # SpeechRecognition wrapper (STT)
│       ├── socketManager.js      # Socket client events
│       └── uiManager.js          # DOM manipulation & visual effects
│
├── package.json
├── tsconfig.json
└── .env
```

---

## Getting Started

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher.
- **Web Browser**: Google Chrome (strongly recommended for optimal Web Speech API capabilities).

### 2. Installation
Navigate into the project directory and install the required dependencies:

```bash
# Install NPM dependencies
npm install
```

### 3. Environment Setup
Create a `.env` file in the root directory. You can use the `.env.example` file as a reference:

```bash
cp .env.example .env
```

Open the newly created `.env` file and fill in your API tokens:

```env
PORT=3000
NODE_ENV=development

# AI API Keys
NVIDIA_API_KEY=your_nvidia_api_key
GROQ_API_KEY=your_groq_api_key

# Supabase (Optional - falls back to local memory storage automatically)
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key

# App Configuration
QUESTIONS_PER_INTERVIEW=10
```

*Note: If you are setting up Supabase, ensure you have a `sessions` table that matches the fields serialized in `interview.repository.ts` (e.g. `id`, `techStack`, `model`, `questions`, `answers`, `evaluations`, `status`, `finalEvaluation`, `createdAt`).*

### 4. Running the Project

Start the application in development mode with auto-reload:

```bash
npm run dev
```

Or build and run in production:

```bash
# Build the TypeScript code
npx tsc

# Start the node server
npm start
```

Open your browser and navigate to **`http://localhost:3000`**.

---

## Detailed Application Workflow

1. **Configure Setup**: The user opens the page in Chrome, selects their target Tech Stack, chooses the AI model to query, picks an Interviewer Voice from the dropdown, and clicks **Start Interview**.
2. **AI Question Generation**: The backend receives the request, calls the selected AI provider (NVIDIA or Groq) to generate exactly 10 questions in a structured JSON schema, saves the session, and sends the first question to the frontend.
3. **Vocal Output (TTS)**: The browser reads the question aloud. The header status indicator changes to a cyan glow (`Speaking`).
4. **Listening Loop (STT)**: Once reading finishes, the microphone automatically starts recording. The status indicator blinks green (`Listening`). The candidate answers verbally, and a live transcript displays on-screen.
5. **Speech Correction**: If silence is detected for 4 seconds, recording stops. Instead of submitting immediately, the application shows an **Editable Transcript Textarea**. The candidate can correct typos, add technical depth, or press "Retry Recording" to re-record their answer.
6. **Socket Submission & Scoring**: Clicking **Submit Answer** sends the text via Socket.IO to the backend. The backend scores the answer and returns the evaluation.
7. **Next Question & Completion**: The loop repeats until all 10 questions are answered. At the end, the backend compiles the transcript history, requests an overall rating and detailed report from the AI, and returns it to the client to render on the final summary screen.


cd "/Users/mindpath/NeuroStack voice"

# 1. Install all dependencies (if not done yet)
npm install

# 2. Generate Prisma client
npx prisma generate

# 3. Push schema to Supabase (creates Session table)
npx prisma db push

# 4. Start the dev server
npm run dev
