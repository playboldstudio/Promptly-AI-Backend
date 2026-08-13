import 'dotenv/config';
import { db } from '../src/db/firestore.js';
import { COLS } from '../src/db/firestoreRepo.js';

// Dev helper — wipe test state for the demo user (demo_creator).
const USER_ID = 'demo_creator';

function clearCollectionByField(collection, field, value) {
  return db
    .collection(collection)
    .where(field, '==', value)
    .get()
    .then((snap) => Promise.all(snap.docs.map((d) => d.ref.delete())));
}

await clearCollectionByField(COLS.userSubscriptions, 'userId', USER_ID);
await clearCollectionByField(COLS.payouts, 'userId', USER_ID);
await clearCollectionByField(COLS.transactions, 'userId', USER_ID);

await db.collection(COLS.userBalances).doc(USER_ID).delete().catch(() => {});
console.log('cleaned demo user test state');
process.exit(0);
