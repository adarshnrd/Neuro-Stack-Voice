import express, { Express, Request, Response } from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';

import config from './config/config';
import routes from './http/routes';
import requestId from './http/middleware/requestId';
import apiNotFoundHandler from './http/middleware/notFound';
import errorHandler from './http/middleware/errorHandler';

/**
 * Builds and returns a configured Express app WITHOUT binding a port or
 * touching Socket.IO. Previously all of this lived directly in server.ts
 * alongside `server.listen(...)`, which made it impossible to import the
 * app into a test file (e.g. with supertest) without also starting a real
 * HTTP listener and a real Socket.IO server for every test run.
 */
export function createApp(): Express {
  const app: Express = express();

  // Trust a configured number of proxy hops so `req.ip` / X-Forwarded-For
  // reflect the real client behind a load balancer, and so express-rate-limit
  // keys correctly instead of collapsing every client into one bucket (or
  // throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) when TRUST_PROXY_HOPS=0.
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy:
        config.env === 'production'
          ? {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                fontSrc: ["'self'", 'https://fonts.gstatic.com'],
                connectSrc: ["'self'", 'wss:', 'ws:'],
                imgSrc: ["'self'", 'data:'],
              },
            }
          : false,
    })
  );

  const allowedOrigins = config.cors.allowedOrigins;
  app.use(
    cors({
      origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    })
  );

  app.use(requestId);
  app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.use(
    express.static(path.join(__dirname, '../public'), {
      maxAge: config.env === 'production' ? '7d' : 0,
      etag: true,
    })
  );

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // max 100 requests per window per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests. Please try again in 15 minutes.' },
  });
  app.use('/api', apiLimiter);
  app.use('/api', routes);

  // API 404 — mounted AFTER all /api routes but BEFORE the SPA wildcard, so
  // an unknown /api/* path returns a proper JSON 404 instead of silently
  // falling through to index.html with a 200 status.
  app.use('/api', apiNotFoundHandler);

  // Frontend fallback (must come AFTER API routes/404) — serves index.html
  // for all non-API routes → supports client-side routing.
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
  });

  // Error handling must be last.
  app.use(errorHandler);

  return app;
}

export default createApp;
