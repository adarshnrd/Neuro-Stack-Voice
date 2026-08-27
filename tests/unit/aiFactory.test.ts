import aiFactory from '../../src/services/ai/aiFactory';
import { GeminiService } from '../../src/services/ai/geminiService';
import { GroqService } from '../../src/services/ai/groqService';
import { NvidiaService } from '../../src/services/ai/nvidiaService';

describe('aiFactory.resolveModelInfo', () => {
  it.each([
    ['gemini-3.5-flash', 'google'],
    ['groq', 'groq'],
    ['llama-3.3-70b-versatile', 'groq'],
    ['nvidia', 'nvidia'],
    ['nvidia/some-model', 'nvidia'],
    ['totally-unknown-model', 'groq'], // failsafe default
  ])('resolves %s to provider %s', (modelId, provider) => {
    expect(aiFactory.resolveModelInfo(modelId).provider).toBe(provider);
  });
});

describe('aiFactory.getService — per-request isolation', () => {
  it('returns a NEW instance on every call, never a shared singleton', () => {
    const a = aiFactory.getService('groq');
    const b = aiFactory.getService('groq');
    expect(a).not.toBe(b);
  });

  it('routes each provider to the correct service class', () => {
    expect(aiFactory.getService('gemini-3.5-flash')).toBeInstanceOf(GeminiService);
    expect(aiFactory.getService('groq')).toBeInstanceOf(GroqService);
    expect(aiFactory.getService('nvidia')).toBeInstanceOf(NvidiaService);
  });

  it('two concurrent callers requesting different models never see each other\'s model', () => {
    // This is the regression test for the historical bug: aiFactory used to
    // return a shared singleton and mutate its `currentModel` field, so
    // request A's model choice could be overwritten by request B before A's
    // fetch call actually fired.
    const geminiSvc = aiFactory.getService('gemini-3-pro');
    const groqSvc = aiFactory.getService('groq');
    expect(geminiSvc.getActiveModel()).toBe('gemini-3-pro');
    expect(groqSvc.getActiveModel()).toBe('llama-3.3-70b-versatile');
  });

  it('threads a caller-supplied API key into the Gemini instance without any shared state', () => {
    const withKey = aiFactory.getService('gemini-3.5-flash', 'user-supplied-key') as GeminiService;
    const withoutKey = aiFactory.getService('gemini-3.5-flash');
    // Both are independent instances — no global "runtime API key" to leak
    // from one caller's request into another's.
    expect(withKey).not.toBe(withoutKey);
  });
});

describe('aiFactory.getFallbackService', () => {
  it('falls back Gemini -> Groq', () => {
    expect(aiFactory.getFallbackService('gemini-3.5-flash')).toBeInstanceOf(GroqService);
  });

  it('falls back Groq/NVIDIA -> Gemini', () => {
    expect(aiFactory.getFallbackService('groq')).toBeInstanceOf(GeminiService);
    expect(aiFactory.getFallbackService('nvidia')).toBeInstanceOf(GeminiService);
  });
});
