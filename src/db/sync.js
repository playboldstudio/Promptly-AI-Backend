import { pingDb } from './config.js';

/**
 * `npm run db:sync` — Firestore is schemaless; this verifies connectivity so a
 * deploy can sanity-check before boot.
 */
async function main() {
  console.log('Checking Firestore connectivity…');
  const ok = await pingDb();
  if (!ok) {
    console.error('❌ Firestore unreachable — check FIREBASE_PROJECT_ID and credentials.');
    process.exit(1);
  }
  console.log('✅ Firestore reachable. Schema is implicit (no tables to sync).');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Sync failed:', err.message);
  process.exit(1);
});
