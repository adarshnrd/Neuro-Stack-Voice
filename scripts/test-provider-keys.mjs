#!/usr/bin/env node
/**
 * Quick standalone health check for the three AI provider API keys used by
 * NeuroStack Voice. Sends a minimal "hi" prompt to each provider directly
 * (no app server needed) and reports PASS/FAIL + a short reply snippet.
 *
 * Usage (from the project root):
 *   node scripts/test-provider-keys.mjs
 *
 * Reads keys straight from .env in the project root. Never prints key
 * values — only lengths (to confirm something was loaded) and pass/fail
 * per provider.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

function loadEnv(file) {
  const out = {};
  const text = readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = loadEnv(envPath);
const GEMINI_API_KEY = env.GEMINI_API_KEY;
const GROQ_API_KEY = env.GROQ_API_KEY;
const NVIDIA_API_KEY = env.NVIDIA_API_KEY;
const GROQ_MODEL = env.GROQ_MODEL || 'openai/gpt-oss-120b'; // mirrors config.ts's default

console.log('Keys found in .env (length only, values never printed):');
console.log(`  GEMINI_API_KEY : ${GEMINI_API_KEY ? GEMINI_API_KEY.length + ' chars' : 'MISSING'}`);
console.log(`  GROQ_API_KEY   : ${GROQ_API_KEY ? GROQ_API_KEY.length + ' chars' : 'MISSING'}`);
console.log(`  NVIDIA_API_KEY : ${NVIDIA_API_KEY ? NVIDIA_API_KEY.length + ' chars' : 'MISSING'}`);
console.log('');

async function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function testGemini() {
  if (!GEMINI_API_KEY) return { ok: false, note: 'no key configured' };
  const res = await withTimeout(
    (signal) =>
      fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
        signal,
      }),
    20000
  );
  const status = res.status;
  const body = await res.text();
  if (!res.ok) return { ok: false, note: `HTTP ${status}: ${body.slice(0, 200)}` };
  let reply = '(unparsed)';
  try {
    reply = JSON.parse(body)?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text field)';
  } catch {}
  return { ok: true, note: `HTTP ${status}, reply: ${String(reply).slice(0, 80)}` };
}

async function testGroq() {
  if (!GROQ_API_KEY) return { ok: false, note: 'no key configured' };
  // Uses whatever GROQ_MODEL is actually configured (same as config.ts's
  // own fallback) instead of a hardcoded id, so this test reflects the
  // model the app will really call — the label below used to say
  // "llama-3.3-70b-versatile" while this body hardcoded
  // "openai/gpt-oss-120b", which was misleading about what was tested.
  const res = await withTimeout(
    (signal) =>
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: 'user', content: 'hi' }],
          max_completion_tokens: 20,
        }),
        signal,
      }),
    20000
  );
  const status = res.status;
  const body = await res.text();
  if (!res.ok) return { ok: false, note: `HTTP ${status}: ${body.slice(0, 200)}` };
  let reply = '(unparsed)';
  try {
    reply = JSON.parse(body)?.choices?.[0]?.message?.content ?? '(no content field)';
  } catch {}
  return { ok: true, note: `HTTP ${status}, reply: ${String(reply).slice(0, 80)}` };
}

async function testNvidia() {
  if (!NVIDIA_API_KEY) return { ok: false, note: 'no key configured' };
  const res = await withTimeout(
    (signal) =>
      fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${NVIDIA_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 20,
          stream: false,
        }),
        signal,
      }),
    30000
  );
  const status = res.status;
  const body = await res.text();
  if (!res.ok) return { ok: false, note: `HTTP ${status}: ${body.slice(0, 200)}` };
  let reply = '(unparsed)';
  try {
    reply = JSON.parse(body)?.choices?.[0]?.message?.content ?? '(no content field)';
  } catch {}
  return { ok: true, note: `HTTP ${status}, reply: ${String(reply).slice(0, 80)}` };
}

const providers = [
  { name: 'Gemini (gemini-3.5-flash)', fn: testGemini },
  { name: `Groq (${GROQ_MODEL})`, fn: testGroq },
  { name: 'NVIDIA (nemotron-3-nano-omni-30b)', fn: testNvidia },
];

let anyFail = false;
for (const p of providers) {
  process.stdout.write(`Testing ${p.name} ... `);
  try {
    const result = await p.fn();
    if (result.ok) {
      console.log(`PASS — ${result.note}`);
    } else {
      anyFail = true;
      console.log(`FAIL — ${result.note}`);
    }
  } catch (err) {
    anyFail = true;
    console.log(`FAIL — ${err instanceof Error ? err.message : err}`);
  }
}

console.log('');
console.log(anyFail ? 'One or more providers failed — see FAIL lines above.' : 'All providers responded successfully.');
process.exit(anyFail ? 1 : 0);


