import { PrismaClient } from '@prisma/client';
import config from './config';

/**
 * Shared PrismaClient singleton.
 *
 * Using a single instance avoids creating duplicate connection pools
 * (the previous codebase had one in server.ts and another in the repository).
 *
 * In development, the instance is cached on `globalThis` so that
 * hot-reloads (nodemon / ts-node) don't exhaust the connection pool.
 */

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log:
      config.env === 'development'
        ? ['warn', 'error']
        : ['error'],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? createPrismaClient();

if (config.env !== 'production') {
  globalForPrisma.__prisma = prisma;
}

/**
 * Gracefully disconnect from the database.
 * Call this from the shutdown handler.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    console.log('[Database] Connection closed');
  } catch (err) {
    console.error('[Database] Error disconnecting:', err);
  }
}
