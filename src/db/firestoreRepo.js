import { FieldValue } from 'firebase-admin/firestore';
import { db, toTimestamp, fromTimestamp } from './firestore.js';

/**
 * Firestore data-access helpers.
 *
 * Conventions:
 *  - Doc fields are camelCase, so responses keep the shapes the clients parse.
 *  - Timestamps are stored as Firestore Timestamps and normalized to ISO
 *    strings on read.
 *  - `toObject` returns { id, ...fields } with a null guard so we never leak
 *    `FieldValue` sentinels.
 */

const COLLECTIONS = Object.freeze({
  users: 'users',
  subscriptionPlans: 'subscription_plans',
  prompts: 'prompts',
  promptPurchases: 'prompt_purchases',
  transactions: 'transactions',
  payouts: 'payouts',
  savedPrompts: 'saved_prompts',
  userSubscriptions: 'user_subscriptions',
  webhookEvents: 'webhook_events',
  userPosts: 'user_posts',
  userBalances: 'user_balances',
  bankAccounts: 'bank_accounts',
  kycVerifications: 'kyc_verifications',
});

export const COLS = COLLECTIONS;

/** Normalize a Firestore doc snapshot ({ id, data() }) to a plain friendly object. */
export function toObject(snap) {
  if (!snap || !snap.exists) return null;
  const data = snap.data() ?? {};
  const out = { id: snap.id };
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && '_seconds' in v) {
      out[k] = fromTimestamp(v) ? fromTimestamp(v).toISOString() : null;
    } else if (v && typeof v === 'object' && v._methodName?.startsWith?.('FieldValue')) {
      out[k] = null; // omit unresolved sentinels
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Convert a plain object doc to a Firestore-safe write payload (Dates → Timestamps). */
export function toWritePayload(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === 'object' && !(v instanceof Date) && v._methodName?.startsWith?.('FieldValue')) {
      out[k] = v; // pass through FieldValue sentinels
    } else if (v instanceof Date) {
      out[k] = toTimestamp(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function increment(n = 1) {
  return FieldValue.increment(n);
}

export function serverTimestamp() {
  return FieldValue.serverTimestamp();
}

/**
 * Get a doc by id (or by a deterministic id you compute). Returns null if absent.
 */
export async function findByPk(collection, id) {
  const snap = await db.collection(collection).doc(id).get();
  return toObject(snap);
}

/**
 * Create a doc with a deterministic id. Returns the created object.
 * Throws if the id already exists (use upsert instead for idempotent writes).
 */
export async function create(collection, id, data) {
  const ref = db.collection(collection).doc(id);
  await ref.create(toWritePayload(data));
  return toObject(await ref.get());
}

/**
 * Upsert a doc by id (create-or-overwrite). Returns the object.
 */
export async function upsert(collection, id, data) {
  const ref = db.collection(collection).doc(id);
  await ref.set(toWritePayload(data), { merge: true });
  return toObject(await ref.get());
}

/**
 * Add a doc with an auto id. Returns the created object.
 */
export async function add(collection, data) {
  const ref = await db.collection(collection).add(toWritePayload(data));
  return toObject(await ref.get());
}

/**
 * Update an existing doc by id. Returns the updated object or null if absent.
 */
export async function update(collection, id, patch) {
  const ref = db.collection(collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.update(toWritePayload(patch));
  return toObject(await ref.get());
}

/**
 * Delete a doc. Returns true if it existed.
 */
export async function remove(collection, id) {
  const ref = db.collection(collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.delete();
  return true;
}

/**
 * Query a collection with optional equality filters, ordering and pagination.
 *   filters: [{ field, op, value }] (op in '==','!=','<','<=','>','>=','array-contains')
 *   orderBy: { field, direction: 'asc'|'desc' } (default desc on createdAt handled by caller)
 * Returns { rows: object[], count: number } — count is the limit-capped number
 * listed (Firestore has no cheap total count for paging; we return rows.length
 * and the route's response shape is preserved with a best-effort total).
 */
export async function queryAll({
  collection,
  filters = [],
  orderBy,
  limit = 50,
  offset = 0,
  fieldMask,
}) {
  let ref = db.collection(collection);
  for (const f of filters) {
    ref = ref.where(f.field, f.op ?? '==', f.value);
  }
  if (orderBy) {
    ref = ref.orderBy(orderBy.field, orderBy.direction ?? 'desc');
  }
  if (offset > 0) ref = ref.offset(offset);
  if (limit > 0) ref = ref.limit(limit);

  if (fieldMask && fieldMask.length) {
    ref = ref.select(...fieldMask);
  }

  const snap = await ref.get();
  const rows = [];
  snap.forEach((s) => rows.push(toObject(s)));
  return { rows, count: rows.length };
}

/**
 * Create many docs with deterministic ids in batched commits (Firestore caps a
 * single batch at 500 writes). Returns the created doc ids. Chunks the input so
 * bulk imports of 1,000+ prompts don't fan out into thousands of writes.
 */
export async function batchCreate(collection, entries) {
  const BATCH_LIMIT = 500;
  const created = [];
  const refs = entries.map(({ id, data }) => ({
    ref: db.collection(collection).doc(id),
    data,
  }));

  for (let i = 0; i < refs.length; i += BATCH_LIMIT) {
    const chunk = refs.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    for (const { ref, data } of chunk) batch.create(ref, toWritePayload(data));
    await batch.commit();
    created.push(...chunk.map((c) => c.ref.id));
  }

  return created;
}

/** Load many docs by ids in parallel. Returns objects keyed by id. */
export async function getMany(collection, ids) {
  const out = {};
  if (!ids.length) return out;
  await Promise.all(
    ids.map(async (id) => {
      const obj = await findByPk(collection, id);
      if (obj) out[id] = obj;
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Transaction-aware helpers — used inside `runTransaction(fn)` callbacks.
// Firestore transactions must read *before* write and can touch up to 500 docs.
// ---------------------------------------------------------------------------

/** Snapshot a doc as a plain object inside a transaction (null if absent). */
export function inTxGet(tx, collection, id) {
  return tx.get(db.collection(collection).doc(id)).then((s) => toObject(s));
}

/** Run a filtered query inside a transaction — returns rows (read-only). */
export function inTxQueryAll(tx, { collection, filters = [], orderBy, limit = 50, offset = 0 }) {
  let ref = db.collection(collection);
  for (const f of filters) {
    ref = ref.where(f.field, f.op ?? '==', f.value);
  }
  if (orderBy) {
    ref = ref.orderBy(orderBy.field, orderBy.direction ?? 'desc');
  }
  if (offset > 0) ref = ref.offset(offset);
  if (limit > 0) ref = ref.limit(limit);
  return tx.get(ref).then((snap) => {
    const rows = [];
    snap.forEach((s) => rows.push(toObject(s)));
    return rows;
  });
}

/** Read a doc ref's object inside a transaction. */
export function inTxGetRef(tx, ref) {
  return tx.get(ref).then((s) => toObject(s));
}

/** Create a doc inside a transaction (throws if the id already exists). */
export function inTxCreate(tx, collection, id, data) {
  const ref = db.collection(collection).doc(id);
  tx.create(ref, toWritePayload(data));
  return ref;
}

/** Upsert (merge) a doc inside a transaction. */
export function inTxSet(tx, collection, id, data, merge = true) {
  const ref = db.collection(collection).doc(id);
  tx.set(ref, toWritePayload(data), { merge });
  return ref;
}

/** Update a doc inside a transaction. */
export function inTxUpdate(tx, collection, id, patch) {
  const ref = db.collection(collection).doc(id);
  tx.update(ref, toWritePayload(patch));
  return ref;
}

/** Delete a doc inside a transaction. */
export function inTxDelete(tx, collection, id) {
  tx.delete(db.collection(collection).doc(id));
}

/** Add a doc with an auto-generated id inside a transaction and return its doc ref. */
export function inTxAdd(tx, collection, data) {
  const ref = db.collection(collection).doc();
  tx.set(ref, toWritePayload(data));
  return ref;
}
