import {
  getQuestionsPrompt,
  getResumeExtractionPrompt,
  sanitizeResumeInput,
  getEvaluationPrompt,
  getAnswerGuidancePrompt,
} from '../../src/utils/promptBuilder';
import { ResumeProfile } from '../../src/types';

function makeProfile(overrides: Partial<ResumeProfile> = {}): ResumeProfile {
  return {
    primarySkills: ['Node.js', 'PostgreSQL'],
    secondarySkills: ['Docker'],
    projects: [{ summary: 'Built a real-time chat service.', technologies: ['Node.js', 'Redis'] }],
    domains: ['fintech'],
    yearsOfExperience: 4,
    inferredLevel: 'senior_engineer',
    notableClaims: ['cut p99 latency by 40%'],
    ...overrides,
  };
}

// See docs/project-improvement/RESUME_MODE_PLAN.md §7.1 — getJDQuestionsPrompt's
// floor used to apply unconditionally; these pin the fix through the one
// PUBLIC entry point (getQuestionsPrompt), the same surface every real
// caller (interview.service.ts) actually goes through.
describe('getQuestionsPrompt — Job Description question-count floor', () => {
  it('honors an explicit count below the historical 15-question floor', () => {
    const prompt = getQuestionsPrompt('Job Description', 5, {
      jobDescription: 'We need a backend engineer.',
      explicitQuestionCount: true,
    });
    expect(prompt).toContain('Generate exactly 5 questions');
    expect(prompt).not.toContain('Generate exactly 15 questions');
  });

  it('still floors to 15 when the caller does not mark the count explicit (unchanged default behavior)', () => {
    const prompt = getQuestionsPrompt('Job Description', 5, {
      jobDescription: 'We need a backend engineer.',
      // explicitQuestionCount intentionally omitted — every pre-existing
      // call site (e.g. extendSession) never sets it.
    });
    expect(prompt).toContain('Generate exactly 15 questions');
  });

  it('still floors to 15 for a caller that never touches explicitQuestionCount at all (no options.explicitQuestionCount key)', () => {
    const prompt = getQuestionsPrompt('Job Description', 3, { jobDescription: 'JD text' });
    expect(prompt).toContain('Generate exactly 15 questions');
  });

  it('a count already at or above 15 is unaffected either way', () => {
    const explicit = getQuestionsPrompt('Job Description', 20, {
      jobDescription: 'JD text',
      explicitQuestionCount: true,
    });
    const implicit = getQuestionsPrompt('Job Description', 20, { jobDescription: 'JD text' });
    expect(explicit).toContain('Generate exactly 20 questions');
    expect(implicit).toContain('Generate exactly 20 questions');
  });
});

// See RESUME_MODE_PLAN.md §4.2 — Resume mode's question-generation prompt
// is built from the extracted ResumeProfile, never from raw resume text.
describe('getQuestionsPrompt — Resume mode dispatch', () => {
  it('routes to the resume-profile prompt when techStack is Resume and a profile is supplied', () => {
    const profile = makeProfile();
    const prompt = getQuestionsPrompt('Resume', 5, { resumeProfile: profile });

    expect(prompt).toContain('Generate exactly 5 questions');
    expect(prompt).toContain('Node.js, PostgreSQL'); // primarySkills
    expect(prompt).toContain('Built a real-time chat service.'); // project summary
    expect(prompt).toContain('cut p99 latency by 40%'); // notable claim
    // The two pinned openers are composed deterministically elsewhere
    // (interview.service.ts) — the AI prompt must explicitly steer clear
    // of generating a THIRD introduction/project question.
    expect(prompt).toMatch(/tell me about yourself/i);
    expect(prompt).toMatch(/already been asked|already covered elsewhere/i);
  });

  it('falls back to the standard prompt when techStack is Resume but no profile is supplied (defensive — should not happen via startSession)', () => {
    const prompt = getQuestionsPrompt('Resume', 5);
    // No resumeProfile branch taken — this must not throw, and must not
    // silently produce a Resume-flavored prompt with undefined fields.
    expect(prompt).toContain('Generate exactly 5 interview questions');
  });

  it('includes previously-asked questions (including the pinned openers) in the dedup section on extend', () => {
    const profile = makeProfile();
    const prompt = getQuestionsPrompt('Resume', 3, {
      resumeProfile: profile,
      previousQuestions: [
        'Tell me about yourself — walk me through your background, what you\'ve worked on, and how you got to where you are today.',
        'Tell me about your best project.',
      ],
    });
    expect(prompt).toContain('ALREADY been asked');
    expect(prompt).toContain('Tell me about your best project.');
  });
});

describe('getResumeExtractionPrompt / sanitizeResumeInput', () => {
  it('fences the resume text as untrusted data', () => {
    const prompt = getResumeExtractionPrompt('5 years building payment systems in Go.');
    expect(prompt).toContain('5 years building payment systems in Go.');
    expect(prompt).toContain('<<<RESUME_START>>>');
    expect(prompt).toContain('<<<RESUME_END>>>');
  });

  it('instructs the model not to include PII', () => {
    const prompt = getResumeExtractionPrompt('Jane Doe, jane@example.com');
    expect(prompt).toMatch(/do not include the candidate's name, email/i);
  });

  it('truncates resume text beyond the 10,000-character cap', () => {
    const longText = 'a'.repeat(15000);
    const sanitized = sanitizeResumeInput(longText);
    expect(sanitized.length).toBeLessThanOrEqual(10000);
  });

  it('leaves normal-length resume text untouched (aside from trimming)', () => {
    const text = 'Experienced backend engineer with a focus on distributed systems.';
    expect(sanitizeResumeInput(text)).toBe(text);
  });
});

// See RESUME_MODE_PLAN.md §4.5 — the narrative-rubric variant must ONLY
// activate for the two pinned Resume-mode question kinds; every existing
// caller (which never passes `kind`) must keep getting byte-identical
// technical-rubric wording.
describe('getEvaluationPrompt — narrative rubric variant', () => {
  const question = 'Explain how you would design a rate limiter.';
  const answer = 'I would use a token bucket algorithm...';

  it('uses the original technical dimension wording when kind is omitted', () => {
    const prompt = getEvaluationPrompt(question, answer);
    expect(prompt).toContain('Theory depth (0-');
    expect(prompt).toContain('Practical application (0-');
    expect(prompt).toContain('Communication clarity (0-');
    expect(prompt).toContain('Completeness (0-');
    expect(prompt).not.toContain('Substance (0-');
    expect(prompt).not.toContain('Narration flow (0-');
  });

  it('switches to narrative dimension wording for kind: introduction', () => {
    const prompt = getEvaluationPrompt(question, answer, undefined, 'introduction');
    expect(prompt).toContain('Substance (0-');
    expect(prompt).toContain('Narration flow (0-');
    expect(prompt).toContain('self-introduction');
    expect(prompt).not.toContain('Theory depth (0-');
  });

  it('switches to narrative dimension wording for kind: project_narration', () => {
    const prompt = getEvaluationPrompt(question, answer, undefined, 'project_narration');
    expect(prompt).toContain('best-project walkthrough');
    expect(prompt).toContain('Substance (0-');
  });

  it('keeps technical wording for kind: technical (explicit, not just absent)', () => {
    const prompt = getEvaluationPrompt(question, answer, undefined, 'technical');
    expect(prompt).toContain('Theory depth (0-');
    expect(prompt).not.toContain('Substance (0-');
  });
});

describe('getAnswerGuidancePrompt — narrative rubric variant', () => {
  it('uses technical framing when kind is omitted', () => {
    const prompt = getAnswerGuidancePrompt('Explain event loop phases.');
    expect(prompt).toMatch(/approach and answer this question well/);
  });

  it('uses narrative framing for kind: introduction', () => {
    const prompt = getAnswerGuidancePrompt('Tell me about yourself.', undefined, undefined, 'introduction');
    expect(prompt).toMatch(/structure and tell this narrative well/);
  });
});
