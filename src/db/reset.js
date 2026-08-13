import { db } from './firestore.js';
import { COLS } from './firestoreRepo.js';

/**
 * `npm run db:reset` — DESTRUCTIVE. Deletes every document in every collection
 * the app uses, then re-seeds. Firestore has no "drop table"; clearing all docs
 * is the equivalent. Dev-only — never run on a production project.
 *
 * WARNING: deletes ALL data in the given Firestore database.
 */
async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Refusing to reset a production Firestore database.');
    process.exit(1);
  }

  for (const [name, col] of Object.entries(COLS)) {
    const snap = await db.collection(col).get();
    let n = 0;
    await Promise.all(
      snap.docs.map(async (d) => {
        await d.ref.delete();
        n += 1;
      }),
    );
    console.log(`  cleared ${col} (${n} docs)`);
  }

  console.log('✅ Firestore cleared.');
  const { default: runSeed } = await import('./seed.js');
  await runSeed();
}

main().catch((err) => {
  console.error('❌ Reset failed:', err.message);
  process.exit(1);
});
