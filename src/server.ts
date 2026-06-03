import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { Server, Socket } from 'socket.io';

import config, { validateConfig } from './config/config';
import { prisma, disconnectDatabase } from './config/databaseConfig';
import socketHandler from './sockets/interview.socket';
import errorHandler from './middleware/errorHandler';
import routes from './routes';

// ─── Startup config validation ──────────────────────────────────────────────
// Fails fast with a clear message before the server ever binds to a port.
validateConfig();

const app: Express = express();
const server = http.createServer(app);

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const allowedOrigins = config.cors.allowedOrigins;
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ['GET', 'POST'],
  },
  // Prevent oversized payloads via WebSocket
  maxHttpBufferSize: 1e6, // 1 MB
});

// ─── HTTP Middleware ─────────────────────────────────────────────────────────
app.use(
  helmet({
    // In production, enable a strict CSP; in development, relax for
    // Web Speech API, inline scripts, and Socket.IO polling.
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

// CORS — restrict to configured origins in production
app.use(
  cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Static assets with cache headers
app.use(
  express.static(path.join(__dirname, '../public'), {
    maxAge: config.env === 'production' ? '7d' : 0,
    etag: true,
  })
);

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // max 100 requests per window per IP
  standardHeaders: true,     // return RateLimit-* headers
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests. Please try again in 15 minutes.',
  },
});
app.use('/api', apiLimiter);

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use('/api', routes);

// ─── Socket.IO Events ────────────────────────────────────────────────────────
io.on('connection', (socket: Socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);
  socketHandler(io, socket);

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
  });
});

// ─── Frontend fallback (must come AFTER API routes) ─────────────────────────
// Serves index.html for all non-API routes → supports client-side routing.
// This also acts as the 404 handler for non-API requests (SPA pattern).
app.get('*', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

// ─── Error handling (must be last) ──────────────────────────────────────────
// Note: notFoundHandler is intentionally omitted — the wildcard route above
// serves index.html for all unmatched paths (standard SPA behavior).
// API 404s are handled by individual route handlers / middleware.
app.use(errorHandler);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;          // Prevent multiple concurrent shutdowns
  isShuttingDown = true;

  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);

  // Stop accepting new Socket.IO connections & disconnect existing ones
  io.close(() => {
    console.log('[Server] Socket.IO server closed');
  });

  server.close(async () => {
    console.log('[Server] HTTP server closed — no new connections accepted');
    await disconnectDatabase();
    console.log('[Server] Shutdown complete');
    process.exit(0);
  });

  // Force kill if graceful shutdown stalls
  setTimeout(() => {
    console.error('[Server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Process-level crash guards ───────────────────────────────────────────────
process.on('uncaughtException', (err: Error) => {
  console.error('[Process] Uncaught Exception — this is a bug, shutting down:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Process] Unhandled Promise Rejection — this is a bug, shutting down:', reason);
  shutdown('unhandledRejection');
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`[Server] ✓ Running on port ${config.port} in ${config.env} mode`);
  console.log(`[Server] ✓ CORS origins: ${allowedOrigins.join(', ')}`);
  console.log(`[Server] ✓ Rate limit: 100 req / 15 min per IP`);
});
