import { pathToFileURL } from 'node:url';
import { expireBonusVintages } from '../services/wallet.service.js';
import { COLS, queryAll } from '../db/firestoreRepo.js';
import { getBonusExpiryReminder } from '../services/notifications.service.js';

/**
 * `npm run wallet:expire` — run the daily bonus expiry sweep over every wallet.
 * Designed to be invoked by a Cloud Scheduler job once a day (plans/wallet.md
 * §5.3). After expiring, it fills each user's notification inbox with a
 * deduped "bonus expiring soon" reminder for vintages within 7 days (wallet.md
 * §5.4 → notifications.service getBonusExpiryReminder).
 *
 * Idempotent: expired vintages are removed once; reminders are deduped by
 * vintage id so re-running never duplicates.
 */

async function main() {
  console.log('Running bonus expiry sweep + reminders…');

  const { walletsTouched, vintagesExpired } = await expireBonusVintages();
  console.log(
    `  ✅ ${walletsTouched} wallet(s) touched, ${vintagesExpired} vintage(s) expired`,
  );

  // Fill inboxes for wallets that still have (expiring-soon) vintages. The
  // reminder is per-user, deduped by vintage id — cheap enough to run over the
  // wallet docs themselves.
  const pages = await queryAll({
    collection: COLS.userWallets,
    fieldMask: ['id'],
    limit: 10000,
  });
  const walletIds = pages.rows.map((r) => r.id);
  console.log(`  📬 Checking ${walletIds.length} wallet(s) for expiring-soon reminders…`);

  let remindersSent = 0;
  for (const userId of walletIds) {
    try {
      const { notified } = await getBonusExpiryReminder(userId);
      remindersSent += notified;
    } catch (err) {
      console.warn(`  ⚠️  Reminder failed for user ${userId}: ${err.message}`);
    }
  }
  console.log(`  📬 ${remindersSent} reminder(s) delivered to inboxes`);

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