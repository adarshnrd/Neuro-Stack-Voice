import { PrismaClient } from '@prisma/client';
import config from './config';
import logger from '../utils/logger';

/**
 * Shared PrismaClient singleton.
 *
 * Using a single instance avoids creating duplicate connection pools.
 * In development, the instance is cached on `globalThis` so that
 * hot-reloads (nodemon / ts-node) don't exhaust the connection pool.
 */

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: config.env === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient =
  globalForPrisma.__prisma ?? createPrismaClient();

if (config.env !== 'production') {
  globalForPrisma.__prisma = prisma;
}

/**
 * Pings the database with a trivial query. Used by the health endpoint —
 * returns false instead of throwing so callers can build a degraded-but-live
 * health response rather than crashing on a transient DB outage.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    logger.error('Database health ping failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Gracefully disconnect from the database.
 * Call this from the shutdown handler.
 */
export async function disconnectDatabase(): Promise<void> {
  try {
    await prisma.$disconnect();
    logger.info('Database connection closed');
  } catch (err) {
    logger.error('Database disconnect error', { error: err instanceof Error ? err.message : String(err) });
  }
}
