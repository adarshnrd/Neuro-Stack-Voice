/**
 * Single source of truth for the interview "difficulty level" feature — see
 * docs/project-improvement/DIFFICULTY_LEVEL_PLAN.md. Every prompt builder,
 * the API allowlist (interview.controller.ts's DIFFICULTY_LEVELS /
 * DIFFICULTY_LEVEL_IDS re-export), and the client's rendered picker all
 * read from this one frozen map, so a level's definition (its question
 * mix, its rubric weights, what earns full marks, its score anchors) can
 * never drift between the question-generation prompt and the scoring
 * prompt — the exact failure mode a second, hand-maintained copy anywhere
 * else would eventually produce.
 *
 * `software_engineer` is deliberately the default AND its rubricWeights
 * are identical to what this app scored with before this feature existed
 * (theory 3 / practical 3 / clarity 2 / completeness 2) — see
 * interview.service.ts's computeOverallScore, which divides by
 * `completed.length * 10` regardless of level, so every level here MUST
 * sum to 10. A session with no difficultyLevel stored (every row created
 * before this migration) resolves to this same default via
 * resolveDifficultyLevel below, so old sessions keep scoring exactly as
 * they always have — this feature is additive, not a breaking change to
 * existing data.
 */

export type DifficultyLevelId = 'trainee' | 'software_engineer' | 'senior_engineer' | 'staff_engineer';

/** Percentage split of question difficulty this level's question-generation
 *  prompt should aim for. Always sums to 100 — not mechanically enforced
 *  (the AI is instructed, not constrained), but kept internally consistent
 *  here so the prompt's wording and any future validation agree. */
export interface DifficultyMix {
  easy: number;
  medium: number;
  hard: number;
}

/** The four rubric dimensions used to score every answer, unchanged in
 *  NAME across every level (nothing downstream — computeOverallScore,
 *  the client's rendering — has to change per level) but different in
 *  WEIGHT. Must always sum to 10 (see this file's [P... ] note above and
 *  the DIFFICULTY_LEVELS values below, plus the parity check at the
 *  bottom of this file). */
export interface RubricWeights {
  theoryDepth: number;
  practicalApplication: number;
  communicationClarity: number;
  completeness: number;
}

/** One row of a level's score-calibration table, fed verbatim into the
 *  evaluation prompt so the model scores against THIS level's bar, not one
 *  absolute bar — see DIFFICULTY_LEVEL_PLAN.md §2.3. */
export interface ScoreAnchor {
  range: string; // e.g. '9-10'
  descriptor: string;
}

export interface DifficultyLevelConfig {
  id: DifficultyLevelId;
  /** Short display name — e.g. "Senior Software Engineer". */
  label: string;
  /** Experience band shown under the label — e.g. "4–8 yrs". */
  experience: string;
  /** One-line "what this stage is actually about" — used both on the
   *  picker card and as the frame for the question-generation prompt. */
  blurb: string;
  difficultyMix: DifficultyMix;
  /** Minimum % of questions that should be scenario-based at this level. */
  scenarioSharePct: number;
  /** Extra qualifier on the scenario requirement — e.g. "multi-part" for
   *  Staff/Principal. Empty string when there's nothing to add. */
  scenarioQualifier: string;
  /** What kind of question this level actually asks — feeds directly into
   *  the question-generation prompt's "question character" guidance. */
  questionCharacter: string;
  /** How long a real verbal answer at this level should run — feeds both
   *  the prompt and (eventually) any UI hint. */
  expectedAnswerLength: string;
  /** Explicitly OUT of scope at this level, so the model doesn't reward —
   *  or penalize the absence of — material this level was never meant to
   *  test. Empty string when nothing is explicitly excluded. */
  outOfScope: string;
  rubricWeights: RubricWeights;
  /** What "full marks" (9-10) means at this level, in the AI's own words —
   *  feeds the evaluation prompt directly. */
  fullMarksDescriptor: string;
  /** 4-row score-calibration table (9-10 / 6-8 / 3-5 / 0-2), most
   *  important entry first — see DIFFICULTY_LEVEL_PLAN.md §2.3. */
  scoreAnchors: ScoreAnchor[];
  /** Only true for staff_engineer today. Gates the claim-verification /
   *  assumption-audit / follow-up-challenge / failure-analysis extension
   *  to the evaluation prompt — see promptBuilder.ts's
   *  getEvaluationPrompt and DIFFICULTY_LEVEL_PLAN.md §2.4. */
  deepVerification: boolean;
}

export const DIFFICULTY_LEVELS: Readonly<Record<DifficultyLevelId, DifficultyLevelConfig>> = Object.freeze({
  trainee: Object.freeze({
    id: 'trainee',
    label: 'Software Trainee',
    experience: '0–1 yrs',
    blurb: 'Do the fundamentals hold up? Explain a concept in your own words and apply it once.',
    difficultyMix: { easy: 60, medium: 35, hard: 5 },
    scenarioSharePct: 10,
    scenarioQualifier: '',
    questionCharacter:
      'Definitions, "what happens when…" questions, reading a small code snippet, one concept at a time — never stacking multiple concepts into one question.',
    expectedAnswerLength: '30–60 seconds',
    outOfScope: 'Internals, scale, or trade-off essays — do not ask for these and do not penalize their absence.',
    rubricWeights: { theoryDepth: 3, practicalApplication: 2, communicationClarity: 3, completeness: 2 },
    fullMarksDescriptor:
      'The core concept is correct, explained in the candidate\'s own words, with one concrete example. Trade-offs, internals, and scale are NOT expected at this level and their absence must never cost points.',
    scoreAnchors: [
      { range: '9-10', descriptor: 'Correct, clear, with a real example.' },
      { range: '6-8', descriptor: 'Right idea, but a thin example or shaky wording.' },
      { range: '3-5', descriptor: 'Partially right, with a key gap.' },
      { range: '0-2', descriptor: 'Fundamentally incorrect.' },
    ],
    deepVerification: false,
  }),

  software_engineer: Object.freeze({
    id: 'software_engineer',
    label: 'Software Engineer',
    experience: '1–3 yrs',
    blurb: 'Can you build, debug and test real features, and avoid the common traps?',
    difficultyMix: { easy: 25, medium: 55, hard: 20 },
    scenarioSharePct: 30,
    scenarioQualifier: '',
    questionCharacter: 'Implementation, debugging, testing, API shape, and common pitfalls.',
    expectedAnswerLength: '1–2 minutes',
    outOfScope: 'Org-wide architecture — that belongs to the Senior/Staff levels, not this one.',
    rubricWeights: { theoryDepth: 3, practicalApplication: 3, communicationClarity: 2, completeness: 2 },
    fullMarksDescriptor:
      'Correct, plus how the candidate would actually implement or debug it, plus awareness of the common failure or pitfall.',
    scoreAnchors: [
      { range: '9-10', descriptor: 'Correct + implementation detail + pitfalls.' },
      { range: '6-8', descriptor: 'Solid, but missing one pitfall or edge case.' },
      { range: '3-5', descriptor: 'Textbook answer with no practical grounding.' },
      { range: '0-2', descriptor: 'Fundamentally incorrect.' },
    ],
    deepVerification: false,
  }),

  senior_engineer: Object.freeze({
    id: 'senior_engineer',
    label: 'Senior Software Engineer',
    experience: '4–8 yrs',
    blurb: 'Do you reason about trade-offs, performance and failure modes, and own a service end to end?',
    difficultyMix: { easy: 5, medium: 45, hard: 50 },
    scenarioSharePct: 50,
    scenarioQualifier: '',
    questionCharacter: 'Trade-offs, performance, failure modes, service design, and "why NOT X" questions.',
    expectedAnswerLength: '2–3 minutes',
    outOfScope: '',
    rubricWeights: { theoryDepth: 3, practicalApplication: 3, communicationClarity: 1, completeness: 3 },
    fullMarksDescriptor:
      'Correct and practical, plus explicit trade-off reasoning, failure modes, and a clear statement of when the candidate would NOT do this.',
    scoreAnchors: [
      { range: '9-10', descriptor: 'Correct + trade-offs + failure modes + limits.' },
      { range: '6-8', descriptor: 'Trade-offs present but shallow or one-sided.' },
      { range: '3-5', descriptor: 'Correct but with no trade-off reasoning at all.' },
      { range: '0-2', descriptor: 'Fundamentally incorrect, or purely definitional.' },
    ],
    deepVerification: false,
  }),

  staff_engineer: Object.freeze({
    id: 'staff_engineer',
    label: 'Staff / Principal Engineer',
    experience: '8+ yrs',
    blurb: 'Can you hold a multi-system architecture in your head and make defensible calls under ambiguity?',
    difficultyMix: { easy: 0, medium: 25, hard: 75 },
    scenarioSharePct: 70,
    scenarioQualifier: 'multi-part',
    questionCharacter:
      'Multi-system architecture, scale economics, migration under constraint, ambiguity, and blast radius.',
    expectedAnswerLength: '3–4 minutes, structured',
    outOfScope: '',
    rubricWeights: { theoryDepth: 3, practicalApplication: 3, communicationClarity: 1, completeness: 3 },
    fullMarksDescriptor:
      'All of the Senior-level bar, at scale: stated assumptions, where it breaks first, blast radius, a migration/rollback path, and the cost or operational consequence.',
    scoreAnchors: [
      { range: '9-10', descriptor: 'All of the above, at scale, with assumptions and blast radius stated.' },
      { range: '6-8', descriptor: 'Sound design, but scale/failure reasoning is underdeveloped.' },
      { range: '3-5', descriptor: 'Reads like a strong Senior answer — no systems-level reasoning.' },
      { range: '0-2', descriptor: 'Fundamentally incorrect, or no architectural content at all.' },
    ],
    deepVerification: true,
  }),
});

export const DIFFICULTY_LEVEL_IDS: DifficultyLevelId[] = Object.keys(DIFFICULTY_LEVELS) as DifficultyLevelId[];

/** Matches SessionData.difficultyLevel's default and every prompt
 *  builder's fallback — see this file's top doc comment for why this MUST
 *  stay the level whose rubricWeights equal the app's original,
 *  pre-feature rubric. */
export const DEFAULT_DIFFICULTY_LEVEL: DifficultyLevelId = 'software_engineer';

/** True for any string that names a real level — the one guard the API
 *  allowlist and every internal fallback both build on. */
export function isDifficultyLevelId(value: unknown): value is DifficultyLevelId {
  return typeof value === 'string' && (DIFFICULTY_LEVEL_IDS as string[]).includes(value);
}

/** Resolves a possibly-missing/unknown stored or requested level id to a
 *  real config, falling back to DEFAULT_DIFFICULTY_LEVEL — this is what
 *  keeps every session created before this feature existed (no
 *  difficultyLevel column value beyond Prisma's own schema default)
 *  scoring exactly as it always did. Every call site that reads a level
 *  off a session or a prompt option goes through this rather than
 *  indexing DIFFICULTY_LEVELS directly, so an unrecognized value (should
 *  never happen past the API's oneOf allowlist, but defensively) degrades
 *  to the safe default instead of throwing mid-interview. */
export function resolveDifficultyLevel(id?: string | null): DifficultyLevelConfig {
  if (isDifficultyLevelId(id)) return DIFFICULTY_LEVELS[id];
  return DIFFICULTY_LEVELS[DEFAULT_DIFFICULTY_LEVEL];
}

// Defensive parity check, evaluated once at module load: every level's
// rubric must sum to 10, or computeOverallScore's percentage math (which
// divides by `completed.length * 10` regardless of which level scored
// each answer) silently rescales that level's contribution to the overall
// score relative to the others. A typo here should fail loudly at boot,
// not quietly skew scores in production.
for (const level of Object.values(DIFFICULTY_LEVELS)) {
  const sum =
    level.rubricWeights.theoryDepth +
    level.rubricWeights.practicalApplication +
    level.rubricWeights.communicationClarity +
    level.rubricWeights.completeness;
  if (sum !== 10) {
    throw new Error(`difficultyLevels.ts: rubricWeights for '${level.id}' sum to ${sum}, not 10`);
  }
}
