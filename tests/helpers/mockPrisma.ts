/**
 * A minimal in-memory stand-in for the Prisma client, used by integration
 * tests via `jest.mock('../../src/config/database', ...)`.
 *
 * Only the `user` model is implemented — `session` / `userApiKey` are left
 * undefined on purpose. Calls made through those (from
 * src/repositories/interview.repository.ts) throw synchronously, which is
 * caught by that repository's own try/catch and exercises its existing
 * bounded in-memory fallback path — the same path a real, briefly-down
 * database would trigger in production. That means these tests cover the
 * fallback path for free instead of needing a second mock surface.
 */
import { randomUUID } from 'crypto';

export interface MockUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export function createMockPrisma() {
  const users = new Map<string, MockUserRecord>(); // keyed by email

  const prisma = {
    user: {
      findUnique: jest.fn(
        async ({
          where,
          select,
        }: {
          where: { email?: string; id?: string };
          select?: Record<string, boolean>;
        }) => {
          let record: MockUserRecord | null = null;
          if (where.email) record = users.get(where.email) ?? null;
          else if (where.id) {
            for (const u of users.values()) {
              if (u.id === where.id) {
                record = u;
                break;
              }
            }
          }
          if (!record) return null;
          if (!select) return record;
          const projected: Partial<MockUserRecord> = {};
          for (const key of Object.keys(select)) {
            if (select[key]) (projected as Record<string, unknown>)[key] = (record as Record<string, unknown>)[key];
          }
          return projected;
        }
      ),
      create: jest.fn(async ({ data }: { data: { email: string; passwordHash: string } }) => {
        const record: MockUserRecord = {
          id: randomUUID(),
          email: data.email,
          passwordHash: data.passwordHash,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.set(data.email, record);
        return record;
      }),
    },
    $queryRaw: jest.fn(async () => [{ '?column?': 1 }]),
  };

  return { prisma, users };
}
