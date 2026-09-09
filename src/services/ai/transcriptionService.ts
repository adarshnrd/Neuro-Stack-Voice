import config from '../../config/config';
import logger from '../../utils/logger';
import { TranscriptionResult } from '../../types';
import { createTimeoutSignal } from './baseService';

/**
 * Server-side speech-to-text on a candidate's recorded answer audio — see
 * docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md.
 *
 * This is deliberately NOT routed through aiFactory/baseService's
 * chat-completion provider chain (aiFactory.ts, baseService.ts's
 * withRetry/handleProviderErrorResponse): those are built around a single
 * JSON request/response shape (one prompt in, one JSON object out) that
 * every provider in this app happens to share for question generation and
 * evaluation. Transcription is a structurally different call — multipart
 * binary audio upload for Groq, inline base64 audio for Gemini, different
 * response shapes entirely — so this is its own small provider chain that
 * mirrors the SPIRIT of aiFactory.getProviderChain (try each configured
 * provider in order, in-process, never throw the whole feature away
 * because one provider is down) without forcing the mismatch.
 *
 * Every function here returns `null` (not a thrown error) on any failure —
 * a missing key, a timeout, a malformed upstream response, a rate limit.
 * `transcribe()` below is the only export the rest of the app calls, and
 * it NEVER throws: exhausting the chain returns
 * `{ transcript: '', provider: 'none', warning }`, which the caller
 * (interview.service.ts's transcribeAnswer) hands straight back to the
 * client. The client already has a transcript of its own — the browser's
 * Web Speech text — so a `provider: 'none'` result is a normal, silent
 * "nothing to improve on this one" outcome, never a failure the candidate
 * needs to see or retry.
 *
 * PRIVACY: audio is received, transcribed, and discarded within this
 * request. It is never written to disk, never persisted to the database,
 * and never logged (only metadata — provider, status code, byte length —
 * is logged, same discipline baseService.ts's handleProviderErrorResponse
 * already applies to candidate answer text).
 */

export interface TranscribeParams {
  audioBuffer: Buffer;
  /** e.g. 'audio/webm;codecs=opus' — the browser MediaRecorder's own
   *  mimeType, passed straight through as the request's Content-Type. */
  contentType: string;
  techStack: string;
  topic?: string;
  expectedKeywords?: string[];
}

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Groq's `prompt` field for transcription biasing is capped at 224 tokens.
 * There's no tokenizer in this codebase for a quick estimate, so this uses
 * a conservative ~4 chars/token English approximation and truncates well
 * under the real cap — the goal is steering the model toward the right
 * vocabulary, not exhausting the field.
 */
const MAX_BIAS_PROMPT_CHARS = 800;

/**
 * Builds the vocabulary-biasing prompt from the question the candidate is
 * actually answering — see the plan doc §2 ("the multiplier"). The
 * question's own `expectedKeywords`/`topic` are exactly the technical
 * terms most often mis-heard (e.g. `uv_queue_work`, `AsyncLocalStorage`,
 * `highWaterMark`), and they're known before the candidate speaks a word.
 * Used both as Groq's `prompt` param and folded into Gemini's instruction
 * text — same content, different transport.
 */
function buildBiasPrompt(params: TranscribeParams): string {
  const parts: string[] = [`Technical interview about ${params.techStack}.`];
  if (params.topic) parts.push(`Topic: ${params.topic}.`);
  if (params.expectedKeywords && params.expectedKeywords.length > 0) {
    parts.push(`Terms likely mentioned: ${params.expectedKeywords.join(', ')}.`);
  }
  const prompt = parts.join(' ');
  return prompt.length > MAX_BIAS_PROMPT_CHARS ? prompt.slice(0, MAX_BIAS_PROMPT_CHARS) : prompt;
}

/** Strips a codecs parameter (e.g. 'audio/webm;codecs=opus' → 'audio/webm')
 *  — both providers' MIME allowlists are base-type only. */
function baseMimeType(contentType: string): string {
  return (contentType.split(';')[0] || 'audio/webm').trim().toLowerCase();
}

function fileExtensionFor(mimeType: string): string {
  const map: Record<string, string> = {
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/flac': 'flac',
  };
  return map[mimeType] || 'webm';
}

/**
 * Groq whisper-large-v3-turbo — see config.ts's `stt.groqModel`. Free on
 * Groq's free tier as of this feature's plan doc; verify current limits
 * before relying on it at scale (console.groq.com/docs/speech-to-text).
 */
async function transcribeWithGroq(params: TranscribeParams): Promise<TranscriptionResult | null> {
  if (!config.ai.groqKey) return null;

  const mimeType = baseMimeType(params.contentType);
  const bias = config.stt.keywordBias ? buildBiasPrompt(params) : undefined;

  const form = new FormData();
  form.append(
    'file',
    new Blob([params.audioBuffer], { type: mimeType }),
    `answer.${fileExtensionFor(mimeType)}`
  );
  form.append('model', config.stt.groqModel);
  form.append('language', config.stt.language);
  form.append('response_format', 'verbose_json');
  if (bias) form.append('prompt', bias);

  let response: Response;
  try {
    response = await fetch(GROQ_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.ai.groqKey}` },
      body: form,
      signal: createTimeoutSignal(config.stt.timeoutMs),
    });
  } catch (error) {
    logger.warn('Groq transcription request failed', {
      provider: 'groq-stt',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.warn('Groq transcription: API error response', {
      provider: 'groq-stt',
      statusCode: response.status,
      body: errText.substring(0, 500),
    });
    return null;
  }

  const data: unknown = await response.json().catch(() => null);
  const text = (data as { text?: string } | null)?.text;
  if (typeof text !== 'string') {
    logger.warn('Groq transcription: unexpected response shape', { provider: 'groq-stt' });
    return null;
  }

  // verbose_json includes per-segment no_speech_prob / avg_logprob — a
  // heuristic confidence signal, not a hard guarantee. A segment the model
  // itself flagged as likely non-speech, or with a very low average log
  // probability, is a reasonable prompt to double-check the text rather
  // than an authoritative "this word is wrong".
  const segments = (data as { segments?: Array<{ no_speech_prob?: number; avg_logprob?: number }> } | null)
    ?.segments;
  const lowConfidence =
    Array.isArray(segments) && segments.length > 0
      ? segments.some((s) => (s.no_speech_prob ?? 0) > 0.6 || (s.avg_logprob ?? 0) < -1)
      : false;

  return {
    transcript: text.trim(),
    provider: 'groq',
    model: config.stt.groqModel,
    lowConfidence,
  };
}

/**
 * Gemini fallback — reuses the SAME key/model config geminiService.ts
 * already resolves for text evaluation (config.ai.geminiKey /
 * config.ai.geminiFallbackModel), so no new credential is required for
 * this path to work. Gemini's generateContent accepts inline audio
 * directly (including audio/webm — verified against the current Gemini
 * audio-understanding docs); asked to return plain verbatim text rather
 * than JSON, since a transcript has no structure worth parsing out.
 */
async function transcribeWithGemini(params: TranscribeParams): Promise<TranscriptionResult | null> {
  const key = config.ai.geminiKey;
  if (!key) return null;

  const model = config.ai.geminiFallbackModel;
  const mimeType = baseMimeType(params.contentType);
  const bias = config.stt.keywordBias ? buildBiasPrompt(params) : '';

  const instruction = [
    'Transcribe the following audio VERBATIM as plain text. This is a spoken answer in a technical interview.',
    bias,
    'Output ONLY the transcript text — no preamble, no commentary, no quotation marks, no markdown formatting.',
    'If the audio is silent or contains no intelligible speech, output nothing.',
  ]
    .filter(Boolean)
    .join(' ');

  let response: Response;
  try {
    response = await fetch(`${GEMINI_BASE_URL}/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: instruction },
              { inlineData: { mimeType, data: params.audioBuffer.toString('base64') } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2 },
      }),
      signal: createTimeoutSignal(config.stt.timeoutMs),
    });
  } catch (error) {
    logger.warn('Gemini transcription request failed', {
      provider: 'gemini-stt',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    logger.warn('Gemini transcription: API error response', {
      provider: 'gemini-stt',
      model,
      statusCode: response.status,
      body: errText.substring(0, 500),
    });
    return null;
  }

  const data: unknown = await response.json().catch(() => null);
  const text = (
    data as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null
  )?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string' || !text.trim()) {
    logger.warn('Gemini transcription: unexpected or empty response', { provider: 'gemini-stt', model });
    return null;
  }

  return { transcript: text.trim(), provider: 'gemini', model };
}

const PROVIDERS: Record<string, (p: TranscribeParams) => Promise<TranscriptionResult | null>> = {
  groq: transcribeWithGroq,
  gemini: transcribeWithGemini,
};

/**
 * Tries each configured provider in `config.stt.providerChain` order.
 * Never throws — see this file's header comment. Callers (currently only
 * interview.service.ts's transcribeAnswer) should treat every returned
 * value as a success from the HTTP layer's point of view; `provider:
 * 'none'` just means there's nothing better than what the client already
 * has.
 */
export async function transcribe(params: TranscribeParams): Promise<TranscriptionResult> {
  if (!config.stt.enabled) {
    return { transcript: '', provider: 'none', warning: 'Speech-to-text is disabled.' };
  }

  const tried: string[] = [];
  for (const name of config.stt.providerChain) {
    const fn = PROVIDERS[name];
    if (!fn) continue; // unrecognized entry in STT_PROVIDER_CHAIN — skip, don't crash
    tried.push(name);
    const result = await fn(params);
    if (result) return result;
  }

  if (tried.length === 0) {
    logger.warn('Transcription: no STT provider configured', { providerChain: config.stt.providerChain });
    return { transcript: '', provider: 'none', warning: 'No speech-to-text provider is configured.' };
  }

  logger.warn('Transcription: every configured provider failed', { tried });
  return { transcript: '', provider: 'none', warning: 'Speech-to-text was unavailable for this answer.' };
}

export default { transcribe };
