import { db } from './firestore.js';
import { COLS } from './firestoreRepo.js';

/**
 * Firestore data access entry point (replaces the Sequelize/Postgres setup).
 *
 * All reads/writes go through Firestore via `db` and the repository helpers in
 * ./firestoreRepo.js. Money-mutating operations use Firestore multi-document
 * transactions via `runTransaction` for all-or-nothing semantics.
 */

export { db };

/**
 * Run a Firestore transaction. Mirrors the signature/usage the Sequelize code
 * used (`await runTransaction(async (tx) => { ... })`) but the callbacks receive
 * a Firestore Transaction, used with the repository `inTx*` helpers.
 *
 * @param {(tx: import('firebase-admin/firestore').Transaction) => Promise<any>} fn
 * @returns the value returned by fn
 */
export async function runTransaction(fn) {
  return db.runTransaction(fn);
}

/**
 * Lightweight connectivity check used by /health and server boot.
 * Lists 1 doc from subscription_plans to confirm the DB is reachable.
 * Wrapped in a short timeout so /health always answers quickly even when
 * Firestore is unreachable.
 */
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
