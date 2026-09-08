import { pathToFileURL } from 'node:url';
import { expireBonusVintages } from '../services/wallet.service.js';

/**
 * `npm run wallet:expire` — run the daily bonus expiry sweep over every wallet.
 * Designed to be invoked by a Cloud Scheduler job once a day (plans/wallet.md
 * §5.3). The per-user expiring-soon reminder (`getBonusExpiringSoon`) is a
 * separate notification concern, called per user by a push job (wallet.md §5.4).
 *
 * Idempotent: expired vintages are removed once; re-running removes nothing more.
 */

async function main() {
  console.log('Running bonus expiry sweep…');
  const { walletsTouched, vintagesExpired } = await expireBonusVintages();
  console.log(
    `  ✅ ${walletsTouched} wallet(s) touched, ${vintagesExpired} vintage(s) expired`,
  );
  console.log('✅ Sweep complete.');
}

export default main;

// Run directly (`node src/scripts/expireBonus.js`) or via `npm run wallet:expire`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ Sweep failed:', err.message);
    process.exit(1);
  });
}