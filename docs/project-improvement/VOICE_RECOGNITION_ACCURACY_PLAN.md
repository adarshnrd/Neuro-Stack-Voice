# Plan — Fix Voice Recognition Accuracy (Zero-Cost)

**Problem:** words are mis-recognized, so the transcript sent for evaluation does not match what the
candidate actually said, and scores come back unfairly low.
**Constraint:** must cost ₹0 — no paid API, no card on file.
**Status:** plan only — nothing implemented yet.
**Date:** 2026-09-07

---

## 1. Why the current setup mis-hears words

`public/js/recognitionEngine.js` uses the browser's **Web Speech API**
(`webkitSpeechRecognition`) as the *only* source of answer text. For a technical interview
specifically, that engine has four hard limits — none of them tunable:

| # | Limitation | Effect on this app |
|---|---|---|
| 1 | **No custom vocabulary / no biasing.** The Web Speech API has no hint, phrase-list, or context parameter. | Domain terms are guessed from a general-English language model: `libuv` → *"lib UV" / "leave you"*, `async_hooks` → *"a sink hooks"*, `highWaterMark` → *"high water mark"*, `uv_queue_work` → *"you've cue work"*, `Prisma` → *"prisma / prism a"*, `nextTick` → *"next tick"*. Every one of these is a scoring keyword. |
| 2 | **Optimised for short commands, not long-form speech.** Chrome force-ends a stream after ~60 s of audio (and sooner on pauses). | `onend` → `this.recognition.start()` restart (lines 84-96). **Every restart drops the word being spoken at the boundary** and resets the engine's context, so a 3-minute answer is really 4-5 disconnected fragments with a hole between each. |
| 3 | **Single hypothesis only.** `maxAlternatives` is never set (defaults to 1) and `confidence` is never read. | A wrong first guess is silently accepted as fact. There is no signal anywhere that a word was uncertain. |
| 4 | **Not a stable platform.** Chrome/Edge only, Google's servers, undocumented behaviour, no SLA, silently degrades on poor mic/accent/network. | Non-Chrome users get nothing at all (`isSupported()` → false). |

### The second half of the problem — the scorer is not told it is reading a transcript

`src/utils/promptBuilder.ts` → `getEvaluationPrompt()` (line 559) hands the answer to the LLM as
plain text with **no mention that it came from speech-to-text**. So when the transcript says
*"the event loop uses a sink hooks"*, the model does not read that as a mis-heard `async_hooks` —
it reads it as the candidate saying something incorrect, and marks down **Theory depth**,
**Communication clarity** and **Completeness** for it. One ASR error can cost several points.

**Conclusion: this is two bugs, not one.** Better ASR fixes most of it; making the evaluator
ASR-aware fixes the residue and is free and immediate.

---

## 2. Chosen solution

> **Keep Web Speech API for the live on-screen text (instant, free).
> Add a real ASR pass on the recorded audio before the answer is scored, biased with the
> question's own vocabulary. Free tier, no card.**

### Why this shape

The UI already has the perfect seam for it. Flow today is:

```
LISTENING  ──(silence or Stop)──►  EDITING (textarea, user can fix text)  ──►  submit
```

`app.js` already routes every answer through an editable transcript box (`showEditTranscript`,
lines 973 / 1599) before submission. So the accurate transcript does not need to arrive in
real time — it only needs to arrive **before the user hits submit**, which is a second or two of
slack we already have for free. No interactive-latency budget to fight.

### The engine: Groq `whisper-large-v3-turbo`

The project **already has `GROQ_API_KEY` configured and working** (`.env.example` line 15; the
provider chain fell back to Groq successfully in the logs). The same key transcribes audio.

- The model is **free on Groq's free tier** — free since 10 May 2026, no credit card.
- Free-tier limits: **20 requests/min, 2,000 requests/day**, 25 MB max upload.
  One interview = ~10 answers = 10 requests. That is ~200 full interviews/day within the free tier.
- Word Error Rate is dramatically better than the Web Speech API on technical English, and it was
  trained on far more code/tech speech.
- **It accepts a `prompt` parameter (up to 224 tokens) for vocabulary steering** — this is the
  single most important feature for this app, see below.
- No 60-second cut-off, no restart gaps: it transcribes the whole answer as one continuous piece
  of audio with full context.

### The multiplier: bias the transcription with the question's own keywords

Every generated question already carries `expectedKeywords` and a `topic` (visible in the session
JSON — `"expectedKeywords": ["thread pool", "uv_queue_work", "default size 4", ...]`). Those are
**exactly the words being mis-heard**, and they are known before the candidate opens their mouth.

Feeding them to Whisper as the `prompt` tells the model these strings are plausible, which is what
makes `libuv`, `uv_queue_work`, `AsyncLocalStorage` and `highWaterMark` come back spelled
correctly instead of phonetically. This is the difference between "Whisper is a bit better" and
"the technical terms are actually right".

```
prompt = "Technical interview about Node.js. Terms likely mentioned: thread pool,
          uv_queue_work, libuv, CPU-bound, blocking I/O, queue saturation,
          event loop, AsyncLocalStorage, highWaterMark."   // ≤224 tokens, truncate to fit
```

### Fallback chain (mirrors the existing AI provider chain, so the app never hard-fails)

| Order | Engine | Cost | When used |
|---|---|---|---|
| 1 | **Groq `whisper-large-v3-turbo`** + keyword prompt | Free (20 RPM / 2k RPD) | Default |
| 2 | **Gemini Flash** audio input (`GEMINI_API_KEY` already present) | Free tier (~15 RPM / ~1,500 RPD) | Groq 429/down |
| 3 | **Web Speech API text** (what we already collected live) | Free | Both APIs fail, or offline |
| 4 | *(optional, later)* **In-browser Whisper via Transformers.js + WebGPU** | Free, fully offline, zero server cost | Privacy mode / no keys |

The user is never blocked: worst case they get today's behaviour, which is the current baseline.

---

## 3. Implementation plan

### Phase 0 — Free, immediate, no ASR change (do this first)

**Ships value in ~30 minutes and is independent of everything below.**

**0.1 — Make the evaluator ASR-aware.** In `src/utils/promptBuilder.ts` → `getEvaluationPrompt()`,
add above the rubric:

> *The candidate's answer below is an automatic speech-to-text transcript of a spoken answer. It
> may contain transcription errors — especially in technical terms, library names, and code
> identifiers (e.g. "a sink hooks" for `async_hooks`, "lib UV" for `libuv`, "high water mark" for
> `highWaterMark`) — as well as missing punctuation, filler words, and false starts. Where a word
> is clearly a phonetic mis-transcription of a term that fits the context, score it as the term the
> candidate evidently said. Do not deduct for spelling, punctuation, grammar, or transcription
> artefacts. Score the substance of what was said, not the quality of the transcript.*

Apply the same clause in `getFinalEvaluationPrompt()`.

**0.2 — Reduce restart word-loss now.** In `recognitionEngine.js`: set
`this.recognition.maxAlternatives = 3`, and on restart in `onend`, re-issue `start()` inside a
`setTimeout(..., 0)` rather than synchronously (Chrome sometimes throws `InvalidStateError` on an
immediate restart, which the current `catch` swallows — silently ending the recording early).

**0.3 — Surface the risk to the user.** One line under the edit box:
*"Auto-transcribed — please correct any mis-heard technical terms before submitting."*
The edit box already exists; most users do not realise they are meant to use it.

> Expect Phase 0 alone to recover a meaningful chunk of the lost score, because the LLM stops
> punishing garbled words. It does **not** fix the missing/mangled words themselves — Phase 1 does.

### Phase 1 — Record the audio (client)

New `public/js/audioRecorder.js`:

- `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`
- `new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 })`
- Runs **in parallel with** the existing `RecognitionEngine` — same `start` / `stop` /
  `startContinue` lifecycle, hooked at the same call sites in `app.js`
  (`startListening` line 954, `continueRecording` line 999, `manualStopRecording` line 1593).
- In "continue" mode, keep the earlier chunks and concatenate, so the merged audio matches the
  merged text the engine already produces.
- Size check: Opus mono @24 kbps ≈ **180 KB per minute** — a 5-minute answer is ~0.9 MB, far under
  the 25 MB free-tier cap. No chunking needed.
- Feature-detect: no `MediaRecorder` / mic permission denied → skip silently, fall through to
  Web Speech text (chain step 3).

### Phase 2 — Transcription service (server)

New `src/services/ai/transcriptionService.ts`, following the existing `services/ai/` +
`aiFactory.ts` provider-chain pattern so retry/fallback/logging behave like the rest of the app:

```
POST /api/interviews/:sessionId/transcribe     (multipart: audio blob + questionId)
  → auth + ownership check (reuse getOwnedSession — do not let any UUID holder POST audio)
  → rate-limit (reuse the existing limiter; audio is heavier than text)
  → reject > 10 MB / > 10 min server-side before touching the provider
  → look up the session's question by questionId → build the biasing prompt from
      techStack + question.topic + question.expectedKeywords  (truncate to 224 tokens)
  → Groq  POST https://api.groq.com/openai/v1/audio/transcriptions
      model=whisper-large-v3-turbo, language=en, response_format=verbose_json, prompt=<bias>
  → on failure → Gemini Flash inline audio → on failure → 200 with { transcript: null }
  → returns { transcript, provider, durationSec, lowConfidenceSegments[] }
```

Notes:
- `response_format=verbose_json` also returns per-segment `avg_logprob` / `no_speech_prob` — use
  them to mark low-confidence spans (Phase 4).
- **Audio is never persisted.** Buffer in memory, transcribe, discard. No new DB column, no disk
  writes, nothing to leak. Say so in the code comment so it stays true.
- Reuse the existing `AppError` + `logger` + requestId conventions.

### Phase 3 — Wire it into the answer flow (client)

In `app.js`, in the `onSilence` handler and `manualStopRecording()` — where it currently jumps
straight to `showEditTranscript(text)`:

1. Show the Web Speech text immediately (unchanged — no perceived latency).
2. Add a small inline status: *"Improving transcript…"* and POST the audio.
3. On success, replace the textarea content with the Whisper transcript and show
   *"Transcript improved · Groq Whisper"* + an **Undo** link restoring the Web Speech version.
4. On failure/timeout (cap at ~15 s), keep the Web Speech text and stay silent about it.
5. Never block submit on the transcription — if the user hits submit first, send what is in the box.

Turbo runs ~216× real-time, so a 3-minute answer transcribes in roughly a second plus upload.

### Phase 4 — Optional refinements (only if still short after Phases 0-3)

- **Highlight low-confidence spans** in the edit box (from `avg_logprob`) so the user's eye goes
  straight to the words worth checking.
- **Term-repair pass:** fuzzy/phonetic match (Double Metaphone) of transcript tokens against
  `expectedKeywords` + a curated tech glossary; auto-correct only on a high-confidence match, and
  show what was changed. Cheap, deterministic, no API call.
- **In-browser Whisper** (`@huggingface/transformers` + WebGPU, `whisper-base.en`) as a
  privacy/offline mode — model downloads once (~40 MB), then runs entirely on the user's GPU.
  Zero server cost and works with no API key at all.
- **Per-user API key:** the app already supports user-supplied keys (`UserApiKey` model) — let a
  user bring their own Groq key so heavy users never consume the shared free quota.

---

## 4. Config to add (`.env.example` + `src/config/config.ts`)

```bash
# ── Speech-to-text ────────────────────────────────────────────────
STT_ENABLED=true                        # master switch — false = today's Web-Speech-only behaviour
STT_PROVIDER_CHAIN=groq,gemini          # mirrors the existing AI provider chain
STT_GROQ_MODEL=whisper-large-v3-turbo   # free tier; whisper-large-v3 is more accurate but slower
STT_LANGUAGE=en
STT_MAX_AUDIO_MB=10
STT_MAX_AUDIO_SECONDS=600
STT_TIMEOUT_MS=15000
STT_KEYWORD_BIAS=true                   # feed question.expectedKeywords as the Whisper prompt
```

`STT_ENABLED=false` must restore exactly today's behaviour — that is the rollback switch, and it
means this whole change can ship without risking the working interview flow.

---

## 5. Cost — confirmed ₹0

| Item | Cost |
|---|---|
| Groq `whisper-large-v3-turbo` free tier | **₹0** — free since 10 May 2026, no card required. 20 RPM / 2,000 RPD / 25 MB per file |
| Gemini Flash fallback (existing key) | **₹0** — free tier (~15 RPM / ~1,500 RPD) |
| Web Speech API | **₹0** |
| In-browser Whisper (optional) | **₹0** — runs on the user's own device |
| Storage / bandwidth | **₹0** — audio is never stored, ~180 KB per answer |

**Headroom:** 2,000 requests/day ÷ ~10 answers per interview ≈ **200 interviews/day** free.
If that is ever exceeded the chain degrades to Gemini, then to today's Web Speech text — it
never errors and never starts costing money. Nothing here requires a payment method.

---

## 6. Risks and how each is handled

| Risk | Handling |
|---|---|
| Groq free-tier limits change or the model stops being free | Provider chain + `STT_PROVIDER_CHAIN` env — swap order without a code change. Verify the limits page before shipping. |
| Free-tier rate limit hit mid-interview (429) | Fall through to Gemini, then to Web Speech text. Never fail the answer. |
| Mic permission denied / no `MediaRecorder` | Feature-detect, skip recording, current behaviour unchanged. |
| Audio upload slow on poor network | 15 s timeout, keep Web Speech text, submit is never blocked. |
| Privacy — sending voice to a third party | Audio is transient (never written to disk or DB). Disclose in the UI; offer the in-browser Whisper mode (Phase 4) as the fully-local option. |
| Regression to the working interview flow | `STT_ENABLED=false` is a complete rollback. Phases 0-3 are additive; no existing code path is removed. |
| `audio/webm;codecs=opus` accepted by Groq? | Documented as supported — **verify with one real curl before building Phase 3.** |

---

## 7. Order of work

1. **Phase 0** — prompt fix + `maxAlternatives` + UI hint. Independent, ship immediately.
2. Verify Groq transcription end-to-end with a single `curl` (one recorded webm file, real key,
   with and without the `prompt` bias) — **do this before writing any app code.**
3. **Phase 2** (server endpoint) → **Phase 1** (client recorder) → **Phase 3** (wire-up).
4. Measure (below). Only then consider **Phase 4**.

---

## 8. How we will know it actually worked

Build a tiny fixed benchmark first — **without it this is guesswork**:

- Record ~10 spoken answers containing known hard terms (`libuv`, `async_hooks`,
  `AsyncLocalStorage`, `highWaterMark`, `uv_queue_work`, `nextTick`, `V8`, `RSS`, `IPC`, `Prisma`).
- Write the exact ground-truth text for each, once.
- Score three ways: **(a)** Web Speech today, **(b)** Whisper without keyword bias,
  **(c)** Whisper with keyword bias.

Acceptance criteria:

- [ ] Word Error Rate on the benchmark drops by **≥50 %** from (a) to (c)
- [ ] **≥90 %** of the target technical terms transcribed correctly in (c) (baseline today is the
      number to beat — measure it, don't assume it)
- [ ] Same 10 answers re-scored by the evaluator: average score rises, and no answer scores lower
      than the Web Speech run
- [ ] Perceived latency between finishing speaking and the edit box appearing is unchanged
- [ ] `STT_ENABLED=false` reproduces current behaviour exactly
- [ ] Groq down / 429 / mic denied / non-Chrome browser → answer still submits successfully
- [ ] No audio written to disk or database anywhere in the flow

---

## 9. Open questions to settle before building

1. **Is the mis-recognition uniform, or worse for certain accents/mics?** If a specific mic or
   accent is the trigger, `whisper-large-v3` (the full model, still free-tier eligible but slower)
   may be worth it over `turbo`.
2. **Should the improved transcript auto-replace the user's text, or be offered as a suggestion?**
   Auto-replace with Undo is proposed here; if users have already started editing, do not clobber
   their edits.
3. **Do we want the in-browser Whisper mode at all,** or is the Groq chain sufficient? It is the
   only option that keeps voice entirely on-device.

---

## Sources

- [Groq Speech-to-Text docs — models, 25 MB free-tier limit, `prompt` parameter](https://console.groq.com/docs/speech-to-text)
- [whisper-large-v3-turbo on Groq — free since 10 May 2026, 20 RPM / 2,000 RPD, no card](https://www.free-model.com/models/groq/whisper-large-v3-turbo/)
- [Gemini API free tier rate limits](https://tinkerllm.com/blog/gemini-api-free-tier-limits-rate-quotas/)
- [Transformers.js in-browser Whisper with WebGPU](https://www.developersdigest.tech/blog/transformers-js-guide)
- [Open-source speech-to-text options compared](https://www.assemblyai.com/blog/top-open-source-stt-options-for-voice-applications)
