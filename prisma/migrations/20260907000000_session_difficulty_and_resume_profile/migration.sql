-- See docs/audit/SESSION_CREATE_PRISMA_DRIFT.md. schema.prisma already
-- defines Session.difficultyLevel and Session.resumeProfile, but no
-- migration ever added the columns, so prisma.session.create() fails
-- (surfaced as "Unknown argument `userId`" once the generated client is
-- refreshed to match the schema — see that doc for why the error message
-- is misleading). Both columns are additive and safe for existing rows:
-- difficultyLevel backfills to 'software_engineer' (the same rubric every
-- existing session was already scored with, so no row's meaning changes),
-- and resumeProfile is nullable (only ever set for techStack === 'Resume'
-- sessions going forward).
--
-- Hand-written to match the format of 0_init and the existing
-- 20260903000000_session_cascade_delete_on_user migration. Please run
-- `npx prisma migrate deploy` (or `npx prisma migrate dev` in development)
-- against a real database to verify this applies cleanly, then
-- `npx prisma generate` to refresh the client before restarting the server.

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "difficultyLevel" TEXT NOT NULL DEFAULT 'software_engineer';
ALTER TABLE "Session" ADD COLUMN "resumeProfile" JSONB;
