import { pathToFileURL } from 'node:url';
import { COLS, findByPk, queryAll, inTxGet, inTxSet } from './firestoreRepo.js';
import { runTransaction } from './config.js';

/**
 * `npm run db:migrate-wallets` — one-time, idempotent migration of legacy
 * `user_balances.balanceInr` → the Phase 2 `user_wallets` doc.
 *
 * Legacy semantics (plans/wallet.md §6): the old single balance was a BUYER-side
 * credit row (written by writeLedger on purchase/subscription debits), NOT the
 * creator earnings source (that was summed from prompt_purchases). So a legacy
 * `balanceInr` maps to `deposits` — the user's own money — preserving their
 * purchasing power. No bonus/earnings history exists pre-wallet.
 *
 * Idempotency: if a wallet doc already exists (e.g. a top-up happened before
 * this script ran), its existing bucket values are KEPT and the legacy row is
 * only merged in when the wallet has no `deposits` yet. This makes the script
 * safe to re-run and safe to run after partial Phase 2 rollout.
 */

async function main() {
  console.log('Migrating user_balances → user_wallets…');

  const { rows } = await queryAll({ collection: COLS.userBalances, limit: 10000 });
  const candidates = rows.filter((r) => Number(r.balanceInr ?? 0) > 0);
  console.log(`  ${rows.length} legacy balance rows, ${candidates.length} with a positive balance`);

  let migrated = 0;
  let skipped = 0;
  for (const legacy of candidates) {
    const userId = legacy.id;
    const amount = Number(legacy.balanceInr);
    const existing = await findByPk(COLS.userWallets, userId);

    // Already has a wallet — and it already has a deposits bucket (e.g. a top-up
    // or a prior partial run). Keep the live value, don't overwrite history.
    const existingDeposits = Number(existing?.deposits ?? 0);
    if (existing && existingDeposits > 0) {
      skipped += 1;
      continue;
    }

    await runTransaction(async (tx) => {
      const fresh = (await inTxGet(tx, COLS.userWallets, userId)) ?? {
        earnings: 0,
        deposits: 0,
        bonus: 0,
        bonusVintages: {},
      };
      const freshDeposits = Number(fresh.deposits ?? 0);
      if (freshDeposits > 0) return; // raced with another writer — keep theirs

      inTxSet(tx, COLS.userWallets, userId, {
        earnings: Number(fresh.earnings ?? 0),
        deposits: amount,
        bonus: Number(fresh.bonus ?? 0),
        bonusVintages: fresh.bonusVintages ?? {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      migrated += 1;
    });
  }

  console.log(`✅ Migration complete — ${migrated} wallet(s) seeded, ${skipped} skipped (already migrated).`);
}

export default main;

// Run directly (`node src/db/migrate-wallets.js`) or via `npm run db:migrate-wallets`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
}