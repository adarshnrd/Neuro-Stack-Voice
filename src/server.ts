import http from 'http';
import { Server, Socket } from 'socket.io';

import config, { validateConfig } from './config/config';
import { disconnectDatabase } from './config/database';
import { createApp } from './app';
import socketHandler from './sockets/interview.socket';
import socketAuthMiddleware from './sockets/auth';
import logger from './utils/logger';

// ─── Startup config validation ──────────────────────────────────────────────
// Fails fast with a clear message before the server ever binds to a port.
validateConfig();

const app = createApp();
const server = http.createServer(app);

// ─── Socket.IO ──────────────────────────────────────────────────────────────
const allowedOrigins = config.cors.allowedOrigins;
const io = new Server(server, {
  cors: {
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Prevent oversized payloads via WebSocket
  maxHttpBufferSize: 1e6, // 1 MB
});

// Reject any handshake without a valid session cookie before a single event
// handler runs — see src/sockets/auth.ts.
io.use(socketAuthMiddleware);

io.on('connection', (socket: Socket) => {
  logger.info('Socket connected', { socketId: socket.id, userId: socket.data.userId });
  socketHandler(io, socket);

  socket.on('disconnect', () => {
    logger.info('Socket disconnected', { socketId: socket.id });
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return; // Prevent multiple concurrent shutdowns
  isShuttingDown = true;

  logger.info(`Received ${signal}. Shutting down gracefully...`);

  io.close(() => {
    logger.info('Socket.IO server closed');
  });

  server.close(async () => {
    logger.info('HTTP server closed — no new connections accepted');
    await disconnectDatabase();
    logger.info('Shutdown complete', { exitCode });
    process.exit(exitCode);
  });

  // Force kill if graceful shutdown stalls
  setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

// ─── Process-level crash guards ───────────────────────────────────────────────
// Exit code 1 on a genuine crash (as opposed to 0 for a clean signal-driven
// shutdown) — process managers (systemd, Docker, PM2, k8s) use the exit code
// to decide whether a restart indicates a real failure worth alerting on.
process.on('uncaughtException', (err: Error) => {
  logger.error('Uncaught Exception — this is a bug, shutting down', { error: err.message, stack: err.stack });
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('Unhandled Promise Rejection — this is a bug, shutting down', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
  shutdown('unhandledRejection', 1);
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  logger.info(`Server running on port ${config.port} in ${config.env} mode`);
  logger.info(`CORS origins: ${allowedOrigins.join(', ')}`);
  logger.info('Rate limit: 100 req / 15 min per IP');
});

export { app, server, io };
