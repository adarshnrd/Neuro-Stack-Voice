import {
  BaseAIService,
  withRetry,
  validateQuestions,
  validateEvaluation,
  validateFinalEvaluation,
} from '../../src/services/ai/baseService';
import { AppError } from '../../src/utils/appError';
import { Question, EvaluationResult, FinalEvaluation, GenerationOptions } from '../../src/types';

/** Minimal concrete subclass so we can exercise the protected helpers. */
class TestAIService extends BaseAIService {
  getDefaultModel(): string {
    return 'test-default-model';
  }
  async generateQuestions(_t: string, _c: number, _o?: GenerationOptions): Promise<Question[]> {
    throw new Error('not used in these tests');
  }
  async evaluateAnswer(_q: string, _a: string): Promise<EvaluationResult> {
    throw new Error('not used in these tests');
  }
  async evaluateInterview(_p: { question: string; answer: string }[]): Promise<FinalEvaluation> {
    throw new Error('not used in these tests');
  }

  // Expose protected members for testing.
  public publicExtractJson(text: string) {
    return this.extractJson(text, 'Test');
  }
  public publicSanitize(text: string) {
    return this.sanitizeJsonString(text);
  }
}

describe('BaseAIService construction', () => {
  it('uses the constructor-provided model over the default', () => {
    const svc = new TestAIService('custom-model');
    expect(svc.getActiveModel()).toBe('custom-model');
  });

  it('falls back to getDefaultModel() when no model is given', () => {
    const svc = new TestAIService('');
    expect(svc.getActiveModel()).toBe('test-default-model');
  });

  it('two instances never share state (fixes the old singleton-mutation bug)', () => {
    const a = new TestAIService('model-a', 'key-a');
    const b = new TestAIService('model-b', 'key-b');
    expect(a.getActiveModel()).toBe('model-a');
    expect(b.getActiveModel()).toBe('model-b');
    // Constructing `b` must not have altered `a` — there is no shared
    // mutable singleton state to leak between them any more.
    expect(a.getActiveModel()).toBe('model-a');
  });
});

describe('extractJson / sanitizeJsonString', () => {
  const svc = new TestAIService('m');

  it('parses clean JSON directly', () => {
    expect(svc.publicExtractJson('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  it('sanitises unescaped newlines INSIDE a string value', () => {
    const raw = '{"feedback":"line one\nline two"}';
    const result = svc.publicExtractJson(raw) as { feedback: string };
    expect(result.feedback).toBe('line one\nline two');
  });

  it('does not corrupt structural whitespace BETWEEN tokens', () => {
    // Pretty-printed JSON with newlines between elements — the old
    // implementation escaped every unescaped \n anywhere in the text,
    // which turned this into invalid JSON and made the sanitised-parse
    // stage fail even on well-formed pretty-printed responses.
    const raw = '[\n  {"question": "a"},\n  {"question": "b"}\n]';
    expect(svc.publicExtractJson(raw)).toEqual([{ question: 'a' }, { question: 'b' }]);
  });

  it('extracts JSON embedded in surrounding prose via regex fallback', () => {
    const raw = 'Sure, here is the JSON:\n```json\n{"score": 8}\n```\nHope that helps!';
    expect(svc.publicExtractJson(raw)).toEqual({ score: 8 });
  });

  it('throws an AppError(502) when nothing parseable is found', () => {
    expect(() => svc.publicExtractJson('not json at all, sorry')).toThrow(AppError);
  });
});

describe('validateQuestions', () => {
  it('fills in defaults for missing optional fields', () => {
    const result = validateQuestions([{ question: 'What is a closure?' }], 'Test');
    expect(result[0].id).toBe(1);
    expect(result[0].difficulty).toBe('medium');
    expect(result[0].topic).toBe('General');
    expect(result[0].expectedKeywords).toEqual([]);
  });

  it('rejects a non-array payload', () => {
    expect(() => validateQuestions({ not: 'an array' }, 'Test')).toThrow(AppError);
  });

  it('rejects an empty array', () => {
    expect(() => validateQuestions([], 'Test')).toThrow(AppError);
  });

  it('rejects a malformed question missing the `question` text', () => {
    expect(() => validateQuestions([{ id: 1 }], 'Test')).toThrow(AppError);
  });
});

describe('validateEvaluation', () => {
  it('clamps score into [0, 10]', () => {
    expect(validateEvaluation({ score: 15, feedback: 'x', betterAnswer: 'y' }, 'Test').score).toBe(10);
    expect(validateEvaluation({ score: -3, feedback: 'x' }, 'Test').score).toBe(0);
  });

  it('defaults missing fields', () => {
    const result = validateEvaluation({}, 'Test');
    expect(result.score).toBe(0);
    expect(result.feedback).toBe('No feedback provided.');
    expect(result.betterAnswer).toBe('');
  });
});

describe('validateFinalEvaluation', () => {
  it('clamps overallScore into [0, 100]', () => {
    expect(validateFinalEvaluation({ overallScore: 250 }, 'Test').overallScore).toBe(100);
    expect(validateFinalEvaluation({ overallScore: -10 }, 'Test').overallScore).toBe(0);
  });
});

describe('withRetry', () => {
  it('retries a 503 AppError and eventually succeeds', async () => {
    let attempts = 0;
    const fn = jest.fn(async () => {
      attempts += 1;
      if (attempts < 2) throw new AppError('temporary', 503);
      return 'ok';
    });
    const result = await withRetry(fn, 'Test', 2);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 400 AppError (not transient)', async () => {
    const fn = jest.fn(async () => {
      throw new AppError('bad request', 400);
    });
    await expect(withRetry(fn, 'Test', 2)).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry an AbortError (our own timeout already waited the full budget)', async () => {
    const fn = jest.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    await expect(withRetry(fn, 'Test', 2)).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
