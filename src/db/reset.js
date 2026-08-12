import './models.js'; // registers all models + associations
import { sequelize } from './config.js';

/**
 * `npm run db:reset` — DROP + recreate all tables, then seed.
 * ⚠️ Destructive: wipes all data in the current schema. Dev-only.
 */
async function main() {
  console.log('Dropping all tables…');
  await sequelize.sync({ force: true });
  console.log('✅ Tables recreated from models.');

  // Delegate to the seed script.
  const { default: runSeed } = await import('./seed.js');
  await runSeed();
}

main().catch((err) => {
  console.error('❌ Reset failed:', err.message);
  process.exit(1);
});
