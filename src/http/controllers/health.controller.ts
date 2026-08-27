import { Request, Response } from 'express';
import { pingDatabase } from '../../config/database';

/**
 * Liveness/readiness endpoint for load balancers, container orchestrators,
 * and uptime monitors. Never existed before — a deploy target had no way to
 * know if the process was actually serving traffic vs. merely running.
 */
export async function health(_req: Request, res: Response) {
  const dbOk = await pingDatabase();
  const body = {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    database: dbOk ? 'up' : 'down',
  };
  // 200 even when degraded — the process itself is alive and can still serve
  // the in-memory fallback path. A load balancer should not kill the pod for
  // a transient DB blip; 503 only if the process cannot serve traffic at all.
  res.status(200).json(body);
}
