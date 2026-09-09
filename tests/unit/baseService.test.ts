import {
  BaseAIService,
  withRetry,
  validateQuestions,
  validateEvaluation,
  validateFinalEvaluation,
  validateResumeProfile,
} from '../../src/services/ai/baseService';
import { AppError } from '../../src/utils/appError';
import {
  Question,
  EvaluationResult,
  EvaluationDigestItem,
  FinalEvaluation,
  GenerationOptions,
  AnswerGuidanceResult,
  ResumeProfile,
} from '../../src/types';

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
  async evaluateInterview(_digest: EvaluationDigestItem[]): Promise<FinalEvaluation> {
    throw new Error('not used in these tests');
  }
  async generateAnswerGuidance(_q: string, _topic?: string): Promise<AnswerGuidanceResult> {
    throw new Error('not used in these tests');
  }
  // Abstract on BaseAIService as of RESUME_MODE_PLAN.md — every concrete
  // subclass (this test double included) must implement it, even though
  // no test here exercises it directly.
  async extractResumeProfile(_resumeText: string): Promise<ResumeProfile> {
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
    expect(validateEvaluation({ score: 15, summary: 'x', betterAnswer: 'y' }, 'Test').score).toBe(10);
    expect(validateEvaluation({ score: -3, summary: 'x' }, 'Test').score).toBe(0);
  });

  it('defaults missing fields (fully separate structured fields, per RICH_EVALUATION_SCALE_PLAN.md §3/§9)', () => {
    const result = validateEvaluation({}, 'Test');
    expect(result.score).toBe(0);
    expect(result.summary).toBe('No summary provided.');
    expect(result.strengths).toBe('');
    expect(result.gaps).toBe('');
    expect(result.improvementAreas).toBe('');
    expect(result.betterAnswer).toBe('');
    expect(result.studyPoints).toEqual([]);
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

// See docs/project-improvement/RESUME_MODE_PLAN.md §4.1/§9 — this
// validator runs on BOTH a fresh AI extraction (untrusted model output)
// AND a client-submitted profile round-tripped through POST /start
// (untrusted input either way), so every one of these has to hold
// regardless of which caller triggered it.
describe('validateResumeProfile', () => {
  it('rejects a non-object payload', () => {
    expect(() => validateResumeProfile(null, 'Test')).toThrow(AppError);
    expect(() => validateResumeProfile('a string', 'Test')).toThrow(AppError);
    expect(() => validateResumeProfile(42, 'Test')).toThrow(AppError);
  });

  it('defaults an empty object to an all-empty, non-throwing profile', () => {
    const result = validateResumeProfile({}, 'Test');
    expect(result).toEqual({
      primarySkills: [],
      secondarySkills: [],
      projects: [],
      domains: [],
      yearsOfExperience: null,
      inferredLevel: null,
      notableClaims: [],
    });
  });

  it('caps primarySkills/secondarySkills at 12 entries each', () => {
    const many = Array.from({ length: 20 }, (_, i) => `skill-${i}`);
    const result = validateResumeProfile({ primarySkills: many, secondarySkills: many }, 'Test');
    expect(result.primarySkills).toHaveLength(12);
    expect(result.secondarySkills).toHaveLength(12);
    expect(result.primarySkills[0]).toBe('skill-0');
  });

  it('caps projects at 6, and each project\'s technologies at 10', () => {
    const manyProjects = Array.from({ length: 10 }, (_, i) => ({
      summary: `Project ${i}`,
      technologies: Array.from({ length: 15 }, (_, j) => `tech-${j}`),
    }));
    const result = validateResumeProfile({ projects: manyProjects }, 'Test');
    expect(result.projects).toHaveLength(6);
    expect(result.projects[0].technologies).toHaveLength(10);
  });

  it('drops a project with no usable summary rather than keeping an empty one', () => {
    const result = validateResumeProfile(
      { projects: [{ summary: '', technologies: ['Go'] }, { summary: 'Real project', technologies: [] }] },
      'Test'
    );
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].summary).toBe('Real project');
  });

  it('caps domains at 5 and notableClaims at 8', () => {
    const result = validateResumeProfile(
      {
        domains: Array.from({ length: 9 }, (_, i) => `domain-${i}`),
        notableClaims: Array.from({ length: 12 }, (_, i) => `claim-${i}`),
      },
      'Test'
    );
    expect(result.domains).toHaveLength(5);
    expect(result.notableClaims).toHaveLength(8);
  });

  it('truncates an over-long string to the 60-char skill / 300-char claim caps', () => {
    const longSkill = 'x'.repeat(200);
    const longClaim = 'y'.repeat(500);
    const result = validateResumeProfile({ primarySkills: [longSkill], notableClaims: [longClaim] }, 'Test');
    expect(result.primarySkills[0]).toHaveLength(60);
    expect(result.notableClaims[0]).toHaveLength(300);
  });

  it('scrubs an email address and a phone number out of any string field', () => {
    const result = validateResumeProfile(
      { notableClaims: ['reachable at jane.doe@example.com or +1 415 555 0199 for references'] },
      'Test'
    );
    expect(result.notableClaims[0]).not.toMatch(/jane\.doe@example\.com/);
    expect(result.notableClaims[0]).not.toMatch(/415.?555.?0199/);
    expect(result.notableClaims[0]).toContain('[redacted]');
  });

  it('accepts a valid inferredLevel id and rejects an unrecognized one', () => {
    expect(validateResumeProfile({ inferredLevel: 'senior_engineer' }, 'Test').inferredLevel).toBe('senior_engineer');
    expect(validateResumeProfile({ inferredLevel: 'expert-wizard' }, 'Test').inferredLevel).toBeNull();
  });

  it('rounds a valid yearsOfExperience and nulls out an out-of-range or non-numeric value', () => {
    expect(validateResumeProfile({ yearsOfExperience: 4.6 }, 'Test').yearsOfExperience).toBe(5);
    expect(validateResumeProfile({ yearsOfExperience: -1 }, 'Test').yearsOfExperience).toBeNull();
    expect(validateResumeProfile({ yearsOfExperience: 200 }, 'Test').yearsOfExperience).toBeNull();
    expect(validateResumeProfile({ yearsOfExperience: 'five' }, 'Test').yearsOfExperience).toBeNull();
  });

  it('uses statusCode 502 by default (AI extraction failure) and honors an explicit statusCode (client-submitted failure)', () => {
    let aiError: AppError | undefined;
    try {
      validateResumeProfile(null, 'AI');
    } catch (e) {
      aiError = e as AppError;
    }
    expect(aiError).toBeInstanceOf(AppError);
    expect(aiError?.statusCode).toBe(502);

    let clientError: AppError | undefined;
    try {
      validateResumeProfile(null, 'client-submitted', 400);
    } catch (e) {
      clientError = e as AppError;
    }
    expect(clientError).toBeInstanceOf(AppError);
    expect(clientError?.statusCode).toBe(400);
  });
});
