import { createApp } from './app.js';
import { env } from './config/env.js';
import { pingDb } from './db/config.js';

const app = createApp();

// Cloud Run expects the server to bind 0.0.0.0 on the PORT env/var (default 8080).
const HOST = '0.0.0.0';

const server = app.listen(env.PORT, HOST, () => {
  console.log(`🚀 Promptly AI backend listening on http://${HOST}:${env.PORT} (${env.NODE_ENV})`);
});

// Boot-time DB check (non-fatal — the app serves /health with db:"down" if absent).
pingDb()
  .then((up) => console.log(up ? '✅ Firestore reachable' : '⚠️  Firestore unreachable — app will run but DB-backed endpoints fail'))
  .catch((err) => console.error('⚠️  Database check failed:', err.message));

// Graceful shutdown (Cloud Run sends SIGTERM on instance termination).
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  server.close(() => {
    process.exit(0);
  });
  // Hard-exit if graceful shutdown hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
