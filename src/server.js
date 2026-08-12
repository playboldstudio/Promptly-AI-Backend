import { createApp } from './app.js';
import { env } from './config/env.js';
import { sequelize, pingDb } from './db/config.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`🚀 Promptly AI backend listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Boot-time DB check (non-fatal — the app serves /health with db:"down" if absent).
pingDb()
  .then((up) => console.log(up ? '✅ Database reachable' : '⚠️  Database unreachable — app will run but DB-backed endpoints fail'))
  .catch((err) => console.error('⚠️  Database check failed:', err.message));

// Graceful shutdown.
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  server.close(async () => {
    try {
      await sequelize.close();
    } finally {
      process.exit(0);
    }
  });
  // Hard-exit if graceful shutdown hangs.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
