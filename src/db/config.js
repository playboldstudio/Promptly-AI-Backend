import { db } from './firestore.js';
import { COLS } from './firestoreRepo.js';

export { db };

export async function runTransaction(fn) {
  return db.runTransaction(fn);
}

export async function pingDb() {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 2500));
  const check = (async () => {
    try {
      const snap = await db.collection(COLS.subscriptionPlans).limit(1).get();
      return snap.size >= 0;
    } catch {
      return false;
    }
  })();
  return Promise.race([check, timeout]);
}
