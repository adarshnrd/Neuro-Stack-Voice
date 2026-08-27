import { GenerationOptions } from '../types';

// ============================================================
// GLOBAL SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `You are a senior technical interviewer at a top-tier technology company (Google/Meta/Amazon level). You conduct deep, realistic technical interviews that test fundamental understanding, not surface-level knowledge.

Your interview style:
- Test core theoretical understanding, not just syntax or definitions
- Include real-world scenarios and architecture decisions
- Require candidates to think critically and reason through problems
- Maintain a professional, firm, but fair interview tone
- Ask questions that a real interviewer would ask in a 45-minute technical round
- Focus on WHY and HOW, not just WHAT
- Validate depth by asking about trade-offs, edge cases, and failure modes

Question quality standards:
- No shallow or generic questions that could be answered by reading a tutorial
- Every question should require genuine understanding to answer well
- Include questions that test problem-solving ability
- Mix theoretical, practical, and scenario-based questions
- Progressive difficulty: start moderate, build to challenging`;

// ============================================================
// TECH-STACK SPECIFIC PROMPTS
// ============================================================
const TECH_STACK_PROMPTS: Record<string, string> = {
  'MySQL': `
Focus areas for MySQL interview:
- Core concepts: ACID properties, transactions, isolation levels (READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE) — test deep understanding with scenarios
- Indexing: B-Tree vs Hash indexes, composite indexes, covering indexes, index selectivity, when NOT to index
- Query optimization: EXPLAIN plan analysis, slow query diagnosis, query rewriting strategies, optimizer hints
- Joins: INNER, LEFT, RIGHT, FULL OUTER, CROSS, self-joins — ask about join algorithms (Nested Loop, Hash, Sort-Merge)
- Locks: row-level vs table-level locks, gap locks, next-key locks, deadlock detection and prevention
- Normalization: 1NF through BCNF, when to denormalize, trade-offs in real applications
- Stored procedures, views, triggers, cursors — practical use cases and performance implications
- Replication: master-slave setup, group replication, binlog formats (STATEMENT, ROW, MIXED)
- Performance: InnoDB buffer pool, query cache deprecation, connection pooling, table partitioning
- Real-world scenarios: schema design for e-commerce, social media, analytics — design decisions and trade-offs

IMPORTANT: Include 2-3 SQL query-based questions where the candidate must write or analyze a query.
For query-based questions, after the interview ends, provide the correct query with detailed explanation.`,

  'Node.js': `
Focus on: Event loop phases, libuv internals, streams (backpressure), cluster module, worker threads vs child processes, memory management (V8 heap), error handling patterns (domains vs async_hooks), module system (CJS vs ESM), performance profiling, real-world architecture patterns.`,

  'React': `
Focus on: Virtual DOM reconciliation algorithm, fiber architecture, hooks internals (rules & closures), state management patterns (Context vs Redux vs Zustand trade-offs), concurrent features (Suspense, transitions), server components, performance optimization (memoization pitfalls, code splitting), testing strategies, real-world component architecture.`,

  'Next.js': `
Focus on: SSR vs SSG vs ISR vs RSC trade-offs, App Router vs Pages Router, server actions, middleware, caching strategies (fetch cache, data cache, full route cache), streaming, parallel routes, intercepting routes, deployment optimization, real-world architecture decisions.`,

  'Python': `
Focus on: GIL and concurrency (threading vs multiprocessing vs asyncio), memory management (reference counting + generational GC), metaclasses, descriptors, decorators (implementation), generators and coroutines, type hints and protocols, performance optimization, package management, testing patterns.`,

  'Java': `
Focus on: JVM internals (class loading, memory model, GC algorithms), concurrency (synchronized vs Lock, CompletableFuture, virtual threads), generics (type erasure), design patterns in practice, Spring IoC/DI, microservices patterns, performance tuning (JIT, profiling), real-world architecture.`,

  'Spring Boot': `
Focus on: Auto-configuration internals, dependency injection lifecycle, AOP (proxy mechanisms), transaction management (@Transactional propagation levels), security (filter chain, OAuth2), reactive programming (WebFlux), testing (MockMvc, TestContainers), actuator, microservice patterns (circuit breaker, service discovery).`,
};

// Default prompt for stacks without specific templates
const DEFAULT_TECH_PROMPT = (techStack: string) => `
Focus on core fundamentals, architecture patterns, performance optimization, error handling, testing strategies, and real-world engineering scenarios specific to ${techStack}. Test both theoretical understanding and practical application.`;

// ============================================================
// INPUT SANITIZATION
// ============================================================
function sanitizeJDInput(jd: string): string {
  // Limit length
  let sanitized = jd.substring(0, 5000);
  
  // Remove potential prompt injection patterns
  const injectionPatterns = [
    /ignore\s+(all\s+)?previous\s+instructions/gi,
    /you\s+are\s+now/gi,
    /forget\s+(all\s+)?previous/gi,
    /disregard\s+(all\s+)?above/gi,
    /override\s+system/gi,
    /new\s+instructions?:/gi,
    /system\s*prompt/gi,
    /\bact\s+as\b/gi,
    /\brole\s*:\s*/gi,
  ];
  
  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '[FILTERED]');
  }
  
  return sanitized.trim();
}

// ============================================================
// QUESTION GENERATION PROMPTS
// ============================================================
export const getQuestionsPrompt = (techStack: string, count: number, options?: GenerationOptions): string => {
  // Job Description mode
  if (techStack === 'Job Description' && options?.jobDescription) {
    return getJDQuestionsPrompt(options.jobDescription, count, options.previousQuestions);
  }

  // Extended interview mode (with previous questions to avoid)
  if (options?.previousQuestions && options.previousQuestions.length > 0) {
    return getExtendedQuestionsPrompt(techStack, count, options.previousQuestions, options.interviewContext);
  }

  // Standard interview
  const techPrompt = TECH_STACK_PROMPTS[techStack] || DEFAULT_TECH_PROMPT(techStack);

  return `${SYSTEM_PROMPT}

${techPrompt}

Generate exactly ${count} interview questions for a ${techStack} developer position.

Requirements:
- Questions must be practical and test real-world knowledge
- Include a mix of conceptual, practical, and scenario-based questions
- Questions should be clear enough to be read aloud in a voice interview
- Each question should be answerable in 1-3 minutes of verbal response
- Progressive difficulty: start with medium, build to hard
- At least 30% of questions should be scenario-based ("You are building X, how would you...")
- At least 20% should test architecture/design thinking

Return ONLY a valid JSON array with this exact structure:
[
  {
    "id": 1,
    "question": "...",
    "difficulty": "easy|medium|hard",
    "topic": "...",
    "expectedKeywords": ["keyword1", "keyword2", "keyword3"]
  }
]

Do not include any text outside the JSON array.`;
};

// ============================================================
// JOB DESCRIPTION INTERVIEW PROMPT
// ============================================================
const getJDQuestionsPrompt = (jobDescription: string, count: number, previousQuestions?: string[]): string => {
  const sanitizedJD = sanitizeJDInput(jobDescription);
  const effectiveCount = Math.max(count, 15); // Minimum 15 for JD mode

  let dedupSection = '';
  if (previousQuestions && previousQuestions.length > 0) {
    dedupSection = `
IMPORTANT: The following questions have ALREADY been asked. Do NOT repeat, rephrase, or ask similar questions:
${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

Generate completely NEW questions exploring different aspects of the job description.`;
  }

  return `${SYSTEM_PROMPT}

You are analyzing the following Job Description to generate a deep, realistic technical interview.

--- JOB DESCRIPTION START ---
${sanitizedJD}
--- JOB DESCRIPTION END ---

Extract and generate interview questions based on:
1. Required technical skills and technologies mentioned
2. Responsibilities and expected deliverables
3. Experience level expectations (junior/mid/senior/lead)
4. Architecture and domain requirements
5. Soft skills and collaboration aspects mentioned
6. Any specific tools, frameworks, or methodologies

${dedupSection}

Rules:
- Generate exactly ${effectiveCount} questions
- Questions must be deep, theoretical, and practical — real interview quality
- Include at least 4 scenario-based questions tied to the JD responsibilities
- Include at least 3 system design / architecture questions relevant to the role
- Include at least 2 questions testing domain knowledge specific to the industry
- Test BOTH breadth and depth of the required skills
- Questions should progressively increase in difficulty
- Include behavioral/situational questions where the JD mentions soft skills
- Every question should feel like it belongs in a real interview for THIS specific role

Return ONLY a valid JSON array with this exact structure:
[
  {
    "id": 1,
    "question": "...",
    "difficulty": "easy|medium|hard",
    "topic": "...",
    "expectedKeywords": ["keyword1", "keyword2", "keyword3"]
  }
]

Do not include any text outside the JSON array.`;
};

// ============================================================
// EXTENDED INTERVIEW PROMPT (DEDUP)
// ============================================================
const getExtendedQuestionsPrompt = (
  techStack: string, 
  count: number, 
  previousQuestions: string[],
  context?: string
): string => {
  const techPrompt = TECH_STACK_PROMPTS[techStack] || DEFAULT_TECH_PROMPT(techStack);

  return `${SYSTEM_PROMPT}

${techPrompt}

Generate ${count} NEW interview questions for a ${techStack} position.

CRITICAL: The following questions have ALREADY been asked in this interview. You MUST NOT repeat, rephrase, or ask semantically similar questions:
${previousQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

${context ? `Interview context so far:\n${context}\n` : ''}

Requirements:
- Generate completely unique questions that explore DIFFERENT aspects and topics
- Build upon areas not yet covered in the previous questions
- Increase difficulty progressively — these are follow-up questions for a deeper dive
- Focus on advanced topics, edge cases, and architecture-level thinking
- At least 50% should be scenario-based or design questions

Return ONLY a valid JSON array with this exact structure:
[
  {
    "id": 1,
    "question": "...",
    "difficulty": "easy|medium|hard",
    "topic": "...",
    "expectedKeywords": ["keyword1", "keyword2", "keyword3"]
  }
]

Do not include any text outside the JSON array.`;
};

// ============================================================
// EVALUATION PROMPTS
// ============================================================
export const getEvaluationPrompt = (question: string, answer: string): string => `
${SYSTEM_PROMPT}

You are evaluating a candidate's verbal response in a technical interview.

Question asked: "${question}"
Candidate's answer: "${answer}"

Evaluate using this rubric:
- Theory depth (0-3): Does the answer demonstrate deep understanding of underlying concepts?
- Practical application (0-3): Can the candidate apply knowledge to real scenarios?
- Communication clarity (0-2): Is the explanation clear and well-structured?
- Completeness (0-2): Are key aspects covered without major omissions?

Provide:
1. A score out of 10 (sum of rubric scores)
2. Specific feedback — what was strong and what specific concepts were missing
3. A model answer showing how a senior engineer would respond (include code examples if relevant)

Return ONLY a valid JSON object with this exact structure:
{
  "score": 8,
  "feedback": "...",
  "betterAnswer": "..."
}

Do not include any text outside the JSON object.`;

export const getFinalEvaluationPrompt = (qaPairs: {question: string, answer: string}[]): string => `
${SYSTEM_PROMPT}

You are providing a final evaluation of a candidate's complete technical interview performance.

Here is the full interview transcript (Questions and Answers):
${JSON.stringify(qaPairs, null, 2)}

Evaluate the candidate holistically:
1. Overall technical competency
2. Depth vs breadth of knowledge
3. Problem-solving approach
4. Communication skills
5. Readiness for the role
6. Specific strengths to highlight
7. Key areas needing improvement with actionable suggestions

Provide:
1. Overall score out of 100
2. Detailed feedback covering all evaluation areas above

Return ONLY a valid JSON object with this exact structure:
{
  "overallScore": 85,
  "overallFeedback": "..."
}

Do not include any text outside the JSON object.`;
