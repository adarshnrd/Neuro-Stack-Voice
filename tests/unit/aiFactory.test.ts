import aiFactory from '../../src/services/ai/aiFactory';
import { GeminiService } from '../../src/services/ai/geminiService';
import { GroqService } from '../../src/services/ai/groqService';
import { NvidiaService } from '../../src/services/ai/nvidiaService';
import config from '../../src/config/config';

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
    //
    // config.ai.groqModel is env-overridable (GROQ_MODEL) precisely because
    // providers deprecate/rename models on their own schedule — see
    // config.ts's comment — so this test pins its own value instead of
    // asserting a literal that would drift out of sync with that default
    // (or with whatever a real .env on the machine running this happens to
    // set) and break for a reason that has nothing to do with the isolation
    // behaviour actually under test.
    const originalGroqModel = config.ai.groqModel;
    config.ai.groqModel = 'test-pinned-groq-model';
    try {
      const geminiSvc = aiFactory.getService('gemini-3-pro');
      const groqSvc = aiFactory.getService('groq');
      expect(geminiSvc.getActiveModel()).toBe('gemini-3-pro');
      expect(groqSvc.getActiveModel()).toBe('test-pinned-groq-model');
    } finally {
      config.ai.groqModel = originalGroqModel;
    }
  });

  it('threads a caller-supplied API key into the Gemini instance without any shared state', () => {
    const withKey = aiFactory.getService('gemini-3.5-flash', 'user-supplied-key') as GeminiService;
    const withoutKey = aiFactory.getService('gemini-3.5-flash');
    // Both are independent instances — no global "runtime API key" to leak
    // from one caller's request into another's.
    expect(withKey).not.toBe(withoutKey);
  });
});

describe('aiFactory.getProviderChain', () => {
  // getProviderChain() reads config.ai.<provider>Key at CALL time (not at
  // import time), so these tests pin config.ai's key fields for the
  // duration of each test rather than relying on tests/env.setup.ts alone.
  // That matters because src/config/config.ts calls dotenv.config() at
  // import time, which fills in ANY key env.setup.ts didn't already set
  // (GEMINI_API_KEY, NVIDIA_API_KEY) from whatever real .env file happens
  // to exist on the machine running the suite — on a dev machine with real
  // provider keys configured for local use, that silently made every
  // provider "configured" and these tests non-deterministic (passing or
  // failing depending on whose machine/CI ran them, not on the code).
  const originalKeys = { ...config.ai };

  afterEach(() => {
    config.ai.groqKey = originalKeys.groqKey;
    config.ai.geminiKey = originalKeys.geminiKey;
    config.ai.nvidiaKey = originalKeys.nvidiaKey;
  });

  it('includes only the configured provider(s) when no extra key is supplied', () => {
    // groq is configured; google/nvidia are not, so the chain never queues
    // a call that would just 503 on a missing key.
    config.ai.groqKey = 'test-groq-key';
    config.ai.geminiKey = undefined;
    config.ai.nvidiaKey = undefined;
    const chain = aiFactory.getProviderChain('groq');
    expect(chain).toHaveLength(1);
    expect(chain[0].service).toBeInstanceOf(GroqService);
  });

  it('starts from the requested provider, then falls through the rest in order', () => {
    // A caller-supplied Gemini key makes google configured for THIS call
    // even though config.ai.geminiKey itself is unset, so the chain starts
    // with Gemini (the requested provider) and then falls through to groq,
    // which is also configured — replaces the old fixed "Gemini -> Groq"
    // fallback pair with an ordered, N-provider chain. NVIDIA stays
    // unconfigured, so it's correctly absent from the result.
    config.ai.groqKey = 'test-groq-key';
    config.ai.geminiKey = undefined;
    config.ai.nvidiaKey = undefined;
    const chain = aiFactory.getProviderChain('gemini-3.5-flash', 'user-supplied-key');
    expect(chain.map((c) => c.service.constructor)).toEqual([GeminiService, GroqService]);
  });

  it('never lists the same provider twice, even when the starting model IS that provider', () => {
    // All three configured this time — the specific regression this
    // guards is the starting candidate and the later "groq" candidate in
    // aiFactory's own candidate list resolving to the SAME provider.
    config.ai.groqKey = 'test-groq-key';
    config.ai.geminiKey = 'test-gemini-key';
    config.ai.nvidiaKey = 'test-nvidia-key';
    const chain = aiFactory.getProviderChain('groq');
    const providers = chain.map((c) => c.service.constructor);
    expect(providers).toHaveLength(3);
    expect(new Set(providers).size).toBe(providers.length);
  });
});
