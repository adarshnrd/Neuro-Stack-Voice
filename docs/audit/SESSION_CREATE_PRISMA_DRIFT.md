# Bug Report — `POST /api/interviews/start` fails with 500 (`Unknown argument userId`)

**Status:** Root cause identified — not fixed yet
**Date:** 2026-09-07
**Severity:** P0 — no interview can be started at all
**Failing endpoint:** `POST /api/interviews/start` → 500
**Failing call site:** `src/repositories/interview.repository.ts:289` → `prisma.session.create()`

---

## 1. Symptom

```
PrismaClientValidationError:
Invalid `prisma.session.create()` invocation in
/home/mindpath/Neuro_stack_voice/src/repositories/interview.repository.ts:289:44
          userId: null,
          ~~~~~~
Unknown argument `userId`. Did you mean `user`? Available options are marked with ?.
POST /api/interviews/start 500
```

Question generation itself succeeded (Gemini 404 → fell back to Groq correctly). The failure is
purely at the **persistence** step, so every session dies right after the LLM work is done.

---

## 2. Root cause — schema drift

`prisma/schema.prisma` has been edited, but **nothing downstream of it was regenerated or migrated.**
Three artefacts that must agree are now out of sync:

| Artefact | State | Evidence |
|---|---|---|
| `prisma/schema.prisma` | **Newest** — has `difficultyLevel`, `resumeProfile`, `onDelete: Cascade` | mtime ≈ 43 h newer than the generated client |
| `node_modules/.prisma/client` (generated client) | **Stale** — its embedded `schema.prisma` (2 132 B vs 3 569 B) has **no** `difficultyLevel`, **no** `resumeProfile`, and still says `onDelete: SetNull` | `node_modules/.prisma/client/schema.prisma` |
| Postgres database | **Stale** — no migration exists that adds the two new columns | `grep -ri "difficulty\|resumeProfile" prisma/migrations` → **no matches** |

### Why the error names `userId` specifically

Prisma generates two create-input shapes per model:

- `SessionCreateInput` (*checked*) — exposes the relation `user`, **not** the FK scalar `userId`
- `SessionUncheckedCreateInput` (*unchecked*) — exposes the FK scalar `userId`, not `user`

The repository passes the **unchecked** shape (`userId: null` plus plain scalars). Because the
generated client predates `difficultyLevel` / `resumeProfile`, the payload can no longer be matched
against the unchecked variant, so Prisma reports the failure against the checked variant — where
`userId` genuinely does not exist. Hence the misleading *"Unknown argument `userId`. Did you mean
`user`?"*. **`userId` is not the bug; the stale client is.**

### Why `npm run dev` never recovers on its own

```json
"dev":        "nodemon --exec ts-node --transpile-only src/server.ts --ext ts",
"dev:prisma": "npx prisma generate && nodemon ...",
"build":      "npx prisma generate && tsc",
```

`dev` is the only script that **skips** `prisma generate`. `--transpile-only` also strips type
checking, so TypeScript never flags the mismatch either — the drift stays invisible until runtime.

---

## 3. Second, currently hidden failure

Regenerating the client alone **will not fix this end to end.** Once the client knows about
`difficultyLevel` and `resumeProfile`, the INSERT reaches Postgres, which still has neither column
(`prisma/migrations/0_init/migration.sql` predates them, and the only other migration just swaps the
FK to `ON DELETE CASCADE`). Expect the 500 to change shape into:

```
The column `Session.difficultyLevel` does not exist in the current database.
```

A migration for both columns is required as part of the same fix.

---

## 4. Fix

1. **Add the missing migration** for the two additive columns (both have safe defaults / are
   nullable, so existing rows are unaffected):

   ```sql
   ALTER TABLE "Session" ADD COLUMN "difficultyLevel" TEXT NOT NULL DEFAULT 'software_engineer';
   ALTER TABLE "Session" ADD COLUMN "resumeProfile" JSONB;
   ```

   Preferably generated with `npx prisma migrate dev --name session_difficulty_and_resume_profile`
   so the checksum/history stays consistent (the cascade migration was hand-written and is flagged
   as unverified in its own header — verify it applies too).

2. **Apply it:** `npx prisma migrate deploy` (or `migrate dev` locally).

3. **Regenerate the client:** `npx prisma generate`.

4. **Restart** the dev server (nodemon does not watch `node_modules`).

Quick local sequence:

```bash
npx prisma migrate dev --name session_difficulty_and_resume_profile
npx prisma generate
npm run dev
```

### Prevention

- Use `npm run dev:prisma` as the default dev entry point, or make `dev` depend on
  `prisma generate` (e.g. a `predev` script) so the client can never lag the schema.
- Run `npm run typecheck` (no `--transpile-only`) in CI — a correctly generated client would have
  surfaced this as a compile error rather than a production 500.
- Treat `schema.prisma` edits as a three-part change: **schema + migration + generate**.

---

## 5. Unrelated warning seen in the same log (non-blocking)

```
[ERROR] Gemini API error response {"model":"gemini-3.1-pro","statusCode":404,
 "message":"models/gemini-3.1-pro is not found for API version v1beta"}
```

The configured Gemini model id does not exist on the `v1beta` endpoint. The provider auto-switch
chain handled it correctly (google → groq), so it is not the cause of the 500 — but the default
model id should be corrected (call `ListModels` for the valid ids), otherwise every request pays an
extra failed round trip before falling back.

---

## 6. Verification checklist

- [ ] `node_modules/.prisma/client/schema.prisma` matches `prisma/schema.prisma` after generate
- [ ] `difficultyLevel` and `resumeProfile` columns present in the `Session` table
- [ ] `POST /api/interviews/start` returns 200 and the row is readable back
- [ ] Anonymous session (`userId: null`) **and** logged-in session both persist
- [ ] Existing sessions created before the change still load (default `software_engineer`, null profile)
