import './models.js'; // side-effect: registers all models + associations on the sequelize instance
import { sequelize } from './config.js';

/**
 * `npm run db:sync`
 *
 * Creates/updates tables from the model definitions (dev convenience).
 * `alter: true` applies column changes in place.
 *
 * ⚠️ Before production, switch to real migrations (sequelize-cli) — `sync({ alter })`
 * is not safe for schema changes on a live database.
 */
async function main() {
  console.log('Syncing schema…');
  await sequelize.sync({ alter: true });
  console.log('✅ Schema synced.');
  await sequelize.close();
}

main().catch((err) => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1);
});
