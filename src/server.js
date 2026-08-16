import { createApp } from './app.js';
import { env } from './config/env.js';
import { pingDb } from './db/config.js';

const app = createApp();

const HOST = '0.0.0.0';

const server = app.listen(env.PORT, HOST, () => {
  console.log(`Promptly AI backend listening on http://${HOST}:${env.PORT} (${env.NODE_ENV})`);
});

// Crash-fast on unhandled errors instead of leaving the instance half-alive.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// Boot-time DB check (non-fatal — the app serves /health with db:"down" if absent).
pingDb()
  .then((up) => console.log(up ? 'Firestore reachable' : 'Firestore unreachable — app will run but DB-backed endpoints fail'))
  .catch((err) => console.error('Database check failed:', err.message));

function shutdown(signal) {
  console.log(`${signal} received — shutting down`);
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
