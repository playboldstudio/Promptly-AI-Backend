import {
  COLS,
  findByPk,
  create,
  upsert,
  inTxGet,
  inTxSet,
  inTxAdd,
  queryAll,
} from '../db/firestoreRepo.js';
import { runTransaction } from '../db/config.js';
import { env, isAdminEmail } from '../config/env.js';
import {
  BALANCE_TYPES,
  getBalanceType,
  getBalanceTypesByPriority,
  zeroBalances,
} from './payments/balance-types.js';
import { currentActiveSubscriptionWithPlan } from './payments/subscription-utils.js';
import { notify } from './notify.js';

/**
 * Multi-balance wallet (Phase 2 — plans/wallet.md).
 *
 * The wallet doc (`user_wallets/{userId}`) holds three scalar balance buckets —
 * earnings / deposits / bonus — plus a `bonusVintages` map for per-credit FEFO
 * expiry. The `transactions` collection is the source of truth: every credit or
 * debit appends one ledger row with the running balance snapshotted.
 *
 * All mutating operations run inside Firestore transactions (never blind
 * reads/writes). `inTxSet` writes merge by default, so a partial wallet update
 * (e.g. only `bonus`) never clobbers the sibling balances.
 */

const MS_PER_DAY = 86_400_000;
const BONUS_EXPIRY_DAYS_DEFAULT = 90; // fallback when env + per-credit both unset

/** Harmonize a numeric amount to paise precision (2 decimals). */
function toMoney(value) {
  return Math.round(value * 100) / 100;
}

/** Read the numeric amount of a balance bucket (0 when doc/bucket missing). */
function bucketAmount(wallet, balanceType) {
  return Number(wallet?.[balanceType] ?? 0);
}

/** Sum all bonus vintage remainings — the canonical `bonus` scalar. */
function bonusFromVintages(vintages = {}) {
  return toMoney(
    Object.values(vintages).reduce((sum, v) => sum + toMoney(v.remaining ?? 0), 0),
  );
}

/**
 * Default expiry offset for a bonus credit. `BONUS_EXPIRY_DAYS` env overrides
 * the compiled default; per-credit overrides come via `days`.
 */
function bonusExpiryFor(days) {
  const dayCount = days ?? env.BONUS_EXPIRY_DAYS ?? BONUS_EXPIRY_DAYS_DEFAULT;
  return new Date(Date.now() + dayCount * MS_PER_DAY);
}

/* ── Read ──────────────────────────────────────────────────────────────── */

/**
 * Read a user's wallet. Missing wallets are lazily materialized as an all-zero
 * shape (never created as a phantom row in a read path).
 */
export async function getWallet(userId) {
  const doc = await findByPk(COLS.userWallets, userId);
  const amounts = doc ?? zeroBalances();

  const balances = {};
  let total = 0;
  for (const id of Object.keys(BALANCE_TYPES)) {
    const amount = toMoney(bucketAmount(amounts, id));
    balances[id] = { amountInr: amount, ...BALANCE_TYPES[id] };
    total = toMoney(total + amount);
  }

  return {
    userId,
    balances,
    totalBalanceInr: total,
    bonusVintages: doc?.bonusVintages ?? {},
  };
}

/* ── Credit ────────────────────────────────────────────────────────────── */

/**
 * Credit a wallet balance. For `bonus`, the amount is tracked as a vintage so
 * FEFO spend + 90-day expiry apply. Meta may carry `daysToExpire` (bonus only),
 * `type`, `note`, `refId`, `gateway`, `gatewayFeeInr`, `platformFeeInr`.
 */
export async function creditBalance(userId, balanceType, amountInr, meta = {}) {
  if (!getBalanceType(balanceType)) throw new Error(`Unknown balance type: ${balanceType}`);
  if (!Number.isFinite(Number(amountInr)) || Number(amountInr) <= 0) {
    throw new Error('Amount must be a positive number');
  }
  const amount = toMoney(Number(amountInr));

  return runTransaction(async (tx) => {
    const wallet = (await inTxGet(tx, COLS.userWallets, userId)) ?? zeroBalances();

    if (balanceType === 'bonus') {
      const creditId = meta.refId ?? `bonus_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const expiresAt = bonusExpiryFor(meta.daysToExpire ?? BALANCE_TYPES.bonus.expires);
      const vintages = { ...(wallet.bonusVintages ?? {}) };
      const prior = vintages[creditId];
      vintages[creditId] = {
        remaining: toMoney(Number(prior?.remaining ?? 0) + amount),
        expiresAt,
      };
      const newBonus = bonusFromVintages(vintages);

      inTxSet(tx, COLS.userWallets, userId, {
        bonus: newBonus,
        bonusVintages: vintages,
        updatedAt: new Date(),
      });

      inTxAdd(tx, COLS.transactions, {
        userId,
        type: meta.type ?? 'bonus_credit',
        direction: 'credit',
        amountInr: amount,
        balanceType: 'bonus',
        balanceAfterInr: newBonus,
        refId: meta.refId ?? creditId,
        note: meta.note ?? `Bonus credited`,
        gateway: meta.gateway ?? null,
        gatewayFeeInr: meta.gatewayFeeInr ?? null,
        platformFeeInr: meta.platformFeeInr ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      return { balanceType, amountInr: amount, newBalance: newBonus, vintageId: creditId };
    }

    const newBalance = toMoney(bucketAmount(wallet, balanceType) + amount);
    inTxSet(tx, COLS.userWallets, userId, { [balanceType]: newBalance, updatedAt: new Date() });

    inTxAdd(tx, COLS.transactions, {
      userId,
      type: meta.type ?? `${balanceType}_credit`,
      direction: 'credit',
      amountInr: amount,
      balanceType,
      balanceAfterInr: newBalance,
      refId: meta.refId ?? null,
      note: meta.note ?? `Credited ${balanceType}`,
      gateway: meta.gateway ?? null,
      gatewayFeeInr: meta.gatewayFeeInr ?? null,
      platformFeeInr: meta.platformFeeInr ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { balanceType, amountInr: amount, newBalance };
  });
}

/* ── Debit (with FEFO bonus consume) ───────────────────────────────────── */

/**
 * Compute how much of an item price each balance type covers, in spend order
 * (deposits → earnings → bonus). `bonus` is capped at `maxUsePercent` (10%) of
 * the item price so it's always a discount, never the whole payment.
 */
export async function calculatePaymentSplit(userId, itemPriceInr) {
  const wallet = await getWallet(userId);
  return calculateSplitFromBalances(wallet.balances, itemPriceInr);
}

/**
 * Pure split math for a wallet balances map + item price. The map is the shape
 * `getWallet().balances` returns: `{ earnings: { amountInr }, deposits: {...},
 * bonus: {...} }`. Split by priority (deposits → earnings → bonus), each capped
 * at `maxUsePercent` of the item. Exported for unit tests — no Firestore.
 */
export function calculateSplitFromBalances(balances, itemPriceInr) {
  const remaining = { value: toMoney(itemPriceInr) };
  const split = [];

  for (const typeCfg of getBalanceTypesByPriority()) {
    if (remaining.value <= 0) break;
    const bal = toMoney(balances?.[typeCfg.id]?.amountInr ?? 0);
    if (bal <= 0) continue;

    const maxFromType = toMoney(itemPriceInr * (typeCfg.maxUsePercent / 100));
    const use = toMoney(Math.min(bal, maxFromType, remaining.value));
    if (use > 0) {
      split.push({ balanceType: typeCfg.id, amountToUse: use });
      remaining.value = toMoney(remaining.value - use);
    }
  }

  return {
    split,
    totalCovered: toMoney(itemPriceInr - remaining.value),
    remaining: remaining.value,
  };
}

/**
 * Consume bonus oldest-first (FEFO): sort vintages by `expiresAt`, take from the
 * earliest, delete a vintage when exhausted. Returns a fresh vintages map +
 * the consumed slice for the audit trail.
 */
function consumeBonusVintages(vintages, amountInr) {
  const working = { ...(vintages ?? {}) };
  let toConsume = toMoney(amountInr);
  const consumed = [];

  const ordered = Object.entries(working).sort(
    ([, a], [, b]) => new Date(a.expiresAt) - new Date(b.expiresAt),
  );
  for (const [id, v] of ordered) {
    if (toConsume <= 0) break;
    const take = toMoney(Math.min(Number(v.remaining ?? 0), toConsume));
    v.remaining = toMoney(Number(v.remaining ?? 0) - take);
    toConsume = toMoney(toConsume - take);
    consumed.push({ vintageId: id, amount: take });
    if (v.remaining <= 0) delete working[id];
  }

  return { vintages: working, consumed };
}

/**
 * Debit one or more balance entries inside one transaction. `entries` is a list
 * of `{ balanceType, amountInr, meta? }`. Bonus debits consume oldest vintages
 * first (FEFO). Throws `{ insufficient, balanceType }` when a bucket can't cover
 * its entry (callers translate to a friendly 400).
 */
export async function debitBalances(userId, entries) {
  return runTransaction(async (tx) => {
    const wallet = (await inTxGet(tx, COLS.userWallets, userId)) ?? zeroBalances();
    const results = [];

    for (const entry of entries) {
      const bt = getBalanceType(entry.balanceType);
      if (!bt) throw new Error(`Unknown balance type: ${entry.balanceType}`);
      const amount = toMoney(entry.amountInr);
      if (amount <= 0) continue;

      if (bt.id === 'bonus') {
        const { vintages, consumed } = consumeBonusVintages(
          wallet.bonusVintages ?? {},
          amount,
        );
        const newBonus = bonusFromVintages(vintages);
        wallet.bonusVintages = vintages;
        wallet.bonus = newBonus;
        inTxSet(tx, COLS.userWallets, userId, {
          bonus: newBonus,
          bonusVintages: vintages,
          updatedAt: new Date(),
        });
        inTxAdd(tx, COLS.transactions, {
          userId,
          type: entry.meta?.type ?? 'bonus_debit',
          direction: 'debit',
          amountInr: amount,
          balanceType: 'bonus',
          balanceAfterInr: newBonus,
          refId: entry.meta?.refId ?? null,
          note: entry.meta?.note ?? `Spent ${amount} bonus`,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        results.push({ balanceType: 'bonus', debited: amount, newBalance: newBonus, consumed });
        continue;
      }

      const cur = bucketAmount(wallet, bt.id);
      if (cur < amount) {
        throw Object.assign(new Error(`Insufficient ${bt.id} balance`), {
          insufficient: true,
          balanceType: bt.id,
        });
      }
      const newBalance = toMoney(cur - amount);
      wallet[bt.id] = newBalance;
      inTxSet(tx, COLS.userWallets, userId, { [bt.id]: newBalance, updatedAt: new Date() });
      inTxAdd(tx, COLS.transactions, {
        userId,
        type: entry.meta?.type ?? `${bt.id}_debit`,
        direction: 'debit',
        amountInr: amount,
        balanceType: bt.id,
        balanceAfterInr: newBalance,
        refId: entry.meta?.refId ?? null,
        note: entry.meta?.note ?? `Spent ${amount} ${bt.id}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      results.push({ balanceType: bt.id, debited: amount, newBalance });
    }

    return results;
  });
}

/* ── Deposit top-up ────────────────────────────────────────────────────── */

/**
 * Credit a deposit top-up INSIDE an already-open transaction. The NET goes to
 * `deposits`, the gateway fee is recycled as bonus (a 90-day vintage). Two
 * ledger rows share the deposit refId. (plans/wallet.md §4.5)
 *
 * Exported so callers (e.g. the deposit verify handler) can run this inside
 * their own idempotency transaction alongside the purchase-row write.
 */
export function creditDepositTopUpTx(tx, { userId, priceInr, gatewayFeeInr, refId, note, walletDoc = null }) {
  const netDeposit = toMoney(priceInr - gatewayFeeInr);
  const bonusCredit = toMoney(gatewayFeeInr);

  // `walletDoc` is the caller's pre-read wallet (so we never do a read-after-write
  // inside the transaction). When absent we accept it — the caller is responsible
  // for having read the wallet BEFORE any writes in the same transaction.
  const wallet = walletDoc ?? zeroBalances();
  return Promise.resolve().then(() => {

    // 1) deposits += net.
    const newDeposits = toMoney(bucketAmount(wallet, 'deposits') + netDeposit);
    inTxSet(tx, COLS.userWallets, userId, { deposits: newDeposits, updatedAt: new Date() });

    // 2) bonus += fee, as a 90-day vintage.
    const creditId = String(refId ?? `dep_${Date.now()}`);
    const vintages = { ...(wallet.bonusVintages ?? {}) };
    const prior = vintages[creditId];
    vintages[creditId] = {
      remaining: toMoney(Number(prior?.remaining ?? 0) + bonusCredit),
      expiresAt: bonusExpiryFor(BALANCE_TYPES.bonus.expires),
    };
    const newBonus = bonusFromVintages(vintages);
    inTxSet(tx, COLS.userWallets, userId, { bonus: newBonus, bonusVintages: vintages, updatedAt: new Date() });

    // Two ledger rows, same refId.
    inTxAdd(tx, COLS.transactions, {
      userId,
      type: 'deposit_credit',
      direction: 'credit',
      amountInr: netDeposit,
      balanceType: 'deposits',
      balanceAfterInr: newDeposits,
      refId,
      note: note ?? 'Top-up — net after gateway fee',
      gateway: 'play_billing',
      gatewayFeeInr,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    inTxAdd(tx, COLS.transactions, {
      userId,
      type: 'deposit_fee_bonus',
      direction: 'credit',
      amountInr: bonusCredit,
      balanceType: 'bonus',
      balanceAfterInr: newBonus,
      refId,
      note: 'Gateway fee recycled as bonus',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return { deposits: newDeposits, bonus: newBonus, vintageId: creditId };
  });
}

/**
 * Credit a deposit top-up in its own transaction. Wrapper around
 * `creditDepositTopUpTx` for callers without an open transaction.
 */
export async function creditDepositTopUp(args) {
  return runTransaction((tx) => creditDepositTopUpTx(tx, args));
}

/**
 * Refund a deposit top-up INSIDE an already-open transaction: debit the NET
 * from `deposits` and remove the recycled bonus vintage (it never "belonged"
 * to the user). Exported so the void handler can mark the purchase voided and
 * refund atomically in one transaction (mirrors `creditDepositTopUpTx`).
 */
export function refundDepositTx(tx, { userId, netDeposit, vintageId, refId, note }) {
  return inTxGet(tx, COLS.userWallets, userId).then((walletDoc) => {
    const wallet = walletDoc ?? zeroBalances();
    const oldDeposits = bucketAmount(wallet, 'deposits');
    const newDeposits = toMoney(oldDeposits - netDeposit);

    const vintages = { ...(wallet.bonusVintages ?? {}) };
    const removedBonus = vintages[vintageId]?.remaining ?? 0;
    if (vintages[vintageId]) delete vintages[vintageId];
    const newBonus = bonusFromVintages(vintages);

    inTxSet(tx, COLS.userWallets, userId, {
      deposits: newDeposits,
      bonus: newBonus,
      bonusVintages: vintages,
      updatedAt: new Date(),
    });

    inTxAdd(tx, COLS.transactions, {
      userId,
      type: 'deposit_refund',
      direction: 'debit',
      amountInr: netDeposit,
      balanceType: 'deposits',
      balanceAfterInr: newDeposits,
      refId,
      note: note ?? `Refunded deposit — net ${netDeposit} removed`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (removedBonus > 0) {
      inTxAdd(tx, COLS.transactions, {
        userId,
        type: 'deposit_fee_bonus_reverse',
        direction: 'debit',
        amountInr: removedBonus,
        balanceType: 'bonus',
        balanceAfterInr: newBonus,
        refId,
        note: 'Recycled bonus vintage removed on refund',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    return {
      deposits: newDeposits,
      bonus: newBonus,
      removedBonus,
      depositsNegative: newDeposits < 0,
    };
  });
}

/**
 * Refund a deposit top-up in its own transaction. Wrapper around
 * `refundDepositTx` for callers without an open transaction.
 */
export async function refundDeposit(args) {
  return runTransaction((tx) => refundDepositTx(tx, args));
}

/* ── Bonus expiry sweep ────────────────────────────────────────────────── */

/**
 * Expire bonus credits whose vintage has lapsed (per-credit, so previously spent
 * bonus is never re-debited). Runs as a daily Cloud Scheduler job /
 * `npm run wallet:expire`. Returns how many wallets/vintages were touched.
 */
export async function expireBonusVintages({ now = Date.now() } = {}) {
  let walletsTouched = 0;
  let vintagesExpired = 0;

  const pages = await queryAll({
    collection: COLS.userWallets,
    fieldMask: ['id'],
    limit: 10000,
  });

  for (const { id: userId } of pages.rows) {
    const wallet = await findByPk(COLS.userWallets, userId);
    if (!wallet?.bonusVintages) continue;

    const expired = Object.entries(wallet.bonusVintages).filter(
      ([, v]) => new Date(v.expiresAt).getTime() <= now,
    );
    if (!expired.length) continue;

    await runTransaction(async (tx) => {
      const fresh = (await inTxGet(tx, COLS.userWallets, userId)) ?? zeroBalances();
      const vintages = { ...(fresh.bonusVintages ?? {}) };
      let removed = 0;
      for (const [id, v] of Object.entries(vintages)) {
        if (new Date(v.expiresAt).getTime() <= now) {
          removed += toMoney(v.remaining ?? 0);
          delete vintages[id];
        }
      }
      if (removed <= 0) return;
      const newBonus = bonusFromVintages(vintages);
      inTxSet(tx, COLS.userWallets, userId, {
        bonus: newBonus,
        bonusVintages: vintages,
        updatedAt: new Date(),
      });
      inTxAdd(tx, COLS.transactions, {
        userId,
        type: 'bonus_expired',
        direction: 'debit',
        amountInr: removed,
        balanceType: 'bonus',
        balanceAfterInr: newBonus,
        refId: 'expiry_sweep',
        note: `Expired ${expired.length} bonus credit(s)`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vintagesExpired += expired.length;
      walletsTouched += 1;
    });
  }

  return { walletsTouched, vintagesExpired };
}

/**
 * Bonus credits expiring within `days` (default 7 → the reminder window). Used
 * to push a "your ₹X bonus expires soon" notification.
 */
export async function getBonusExpiringSoon(userId, { withinDays = 7 } = {}) {
  const wallet = await getWallet(userId);
  const upcoming = Object.entries(wallet.bonusVintages ?? {})
    .filter(([, v]) => {
      const msLeft = new Date(v.expiresAt).getTime() - Date.now();
      return msLeft > 0 && msLeft <= withinDays * MS_PER_DAY;
    })
    .map(([id, v]) => ({ id, amount: toMoney(v.remaining ?? 0), expiresAt: v.expiresAt }));
  return { expiring: upcoming };
}

/* ── Admin manual adjustment ───────────────────────────────────────────────── */

/**
 * Admin-only manual wallet adjustment (support / refund-dispute tooling —
 * plans/moderation.md §7). `deltaInr` is signed: positive credits, negative
 * debits. Reuses `creditBalance` / `debitBalances` so the ledger row, FEFO
 * bonus vintages and balance snapshots stay consistent with every other write.
 */
export async function adjustWallet({ userId, balanceType, deltaInr, note }) {
  const bt = getBalanceType(balanceType);
  if (!bt) {
    return { error: { status: 400, message: `Unknown balance type — must be earnings, deposits or bonus` } };
  }
  if (!Number.isFinite(Number(deltaInr)) || Number(deltaInr) === 0) {
    return { error: { status: 400, message: 'deltaInr must be a non-zero number' } };
  }
  const user = await findByPk(COLS.users, userId);
  if (!user) return { error: { status: 404, message: 'User not found' } };

  const amount = Math.abs(Math.round(Number(deltaInr) * 100) / 100);
  const op = Number(deltaInr) > 0 ? 'credit' : 'debit';
  const token = `${op}:${balanceType}:${amount}:${Date.now()}`;

  if (op === 'credit') {
    await creditBalance(userId, balanceType, amount, {
      type: 'admin_adjustment',
      refId: token,
      note: note ?? `Admin adjustment +${amount} ${balanceType}`,
    });
  } else {
    try {
      await debitBalances(userId, [
        { balanceType, amountInr: amount, meta: { type: 'admin_adjustment', refId: token, note: note ?? `Admin adjustment -${amount} ${balanceType}` } },
      ]);
    } catch (e) {
      if (e.insufficient) {
        return { error: { status: 409, message: `Insufficient ${balanceType} balance for this adjustment` } };
      }
      throw e;
    }
  }

  const wallet = await getWallet(userId);
  return { success: true, action: op, balanceType, amountInr: amount, wallet: wallet.balances };
}

/* ── Wallet spend (payment source) ─────────────────────────────────────────── */

/**
 * Spend wallet balances as a payment source toward an item, in the documented
 * priority (deposits → earnings → bonus, bonus capped at 10% of the item price).
 * This is the "actual spend" counterpart to the read-only `GET /wallet/allocate`
 * preview (plans/wallet.md §4.3–4.4, reference.md).
 *
 * Partial-coverage semantics: the split covers exactly what the wallet can, and
 * `remaining` is the residual the caller pays via a real Play Billing purchase.
 *
 * Idempotent by `refId`:
 *   1. Pre-check the ledger for a prior `wallet_spend:${refId}` row → no-op.
 *   2. Race-close with a deterministic claim doc in `wallet_spends`
 *      (`create()` throws if another concurrent caller already claimed it).
 *   3. Debit via `debitBalances` (single tx, FEFO bonus).
 * A concurrent retry loses the claim (`already exists`) and reports `reused`.
 *
 * Returns `{ success, split, totalCovered, remaining, wallet }` or
 * `{ error: { status, message } }`.
 */
export async function spendFromWallet({ userId, itemPriceInr, refId, note }) {
  if (!Number.isFinite(Number(itemPriceInr)) || Number(itemPriceInr) <= 0) {
    return { error: { status: 400, message: 'itemPriceInr must be a positive number' } };
  }
  if (!refId || !String(refId).trim()) {
    return { error: { status: 400, message: 'refId is required for idempotency' } };
  }
  if (!userId) return { error: { status: 401, message: 'Not authenticated' } };

  const claimId = `${userId}_${String(refId)}`;
  const ledgerRefId = `wallet_spend:${String(refId)}`;

  // 1. Pre-check — a prior spend against this refId is a no-op.
  const prior = await queryAll({
    collection: COLS.transactions,
    filters: [
      { field: 'userId', value: userId },
      { field: 'refId', value: ledgerRefId },
    ],
    limit: 1,
  });
  if (prior.rows.length > 0) {
    return {
      success: true,
      reused: true,
      totalCovered: toMoney(prior.rows[0].amountInr ?? 0),
      remaining: 0,
      wallet: (await getWallet(userId)).balances,
    };
  }

  const split = await calculatePaymentSplit(userId, itemPriceInr);
  if (split.split.length === 0 || split.totalCovered <= 0) {
    return {
      success: true,
      totalCovered: 0,
      remaining: toMoney(itemPriceInr),
      wallet: (await getWallet(userId)).balances,
      note: 'No wallet funds to spend',
    };
  }

  // 2. Race-close: one caller claims this refId. `create()` throws if it exists.
  try {
    await create(COLS.walletSpends, claimId, {
      userId,
      refId,
      itemPriceInr: toMoney(itemPriceInr),
      totalCoveredInr: toMoney(split.totalCovered),
      status: 'claimed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (err) {
    if (/already exists|ABORTED/i.test(err.message)) {
      return { success: true, reused: true, totalCovered: split.totalCovered, remaining: split.remaining, wallet: (await getWallet(userId)).balances };
    }
    throw err;
  }

  // 3. Debit the split in one transaction.
  const results = await debitBalances(
    userId,
    split.split.map((s) => ({
      balanceType: s.balanceType,
      amountInr: s.amountToUse,
      meta: {
        type: 'wallet_spend',
        refId: ledgerRefId,
        note: note ?? `Wallet spend on ${String(refId)}`,
      },
    })),
  );

  // Mark the claim spent (best-effort — the ledger rows are the source of truth).
  try {
    await upsert(COLS.walletSpends, claimId, { status: 'completed', completedAt: new Date(), updatedAt: new Date() });
  } catch {
    /* non-fatal */
  }

  notify({
    userId,
    type: 'wallet_spend',
    title: 'Wallet payment',
    body: `Used ₹${toMoney(split.totalCovered)} from your wallet.`,
    refId: ledgerRefId,
    dedupeKey: `wallet_spend_${claimId}`,
    data: { totalCovered: split.totalCovered, itemPriceInr, note: note ?? null },
  });

  return {
    success: true,
    split: results,
    totalCovered: toMoney(split.totalCovered),
    remaining: split.remaining,
    wallet: (await getWallet(userId)).balances,
  };
}

/**
 * Buy a paid prompt's unlock entirely from the user's wallet — the pure-wallet
 * counterpart to Play Billing's `grantPromptUnlock`. Mirrors its fee: the buyer
 * pays `price × 1.05` (5% transaction fee), and the wallet covers the WHOLE
 * amount in ONE transaction (no second payment):
 *
 *   1. debits the wallet each split bucket (deposits → earnings → bonus,
 *      bonus capped at 10% of the total due, i.e. price + fee) via
 *      `debitBalances` — throws when a bucket can't cover,
 *   2. writes the deterministic `prompt_purchases/{buyerId}_{promptId}` row
 *      (`gateway:'wallet'`, `status:'completed'`, with `buyerPaysInr` = price
 *      + fee and `transactionFeeInr`), so `getPromptById` / `getPurchasedPrompts`
 *      treat the prompt as unlocked, and
 *   3. credits the author's `earnings` the FULL gross price + a
 *      `paid_prompt_sale` ledger row to their transactions feed.
 *
 * When the wallet can't cover the total due, returns a 402 with `shortfall`
 * (measured against `buyerPaysInr` — price + fee) so the UI routes to Top-up.
 *
 * Idempotent by `refId` (same `wallet_spend:` claim seam as [spendFromWallet]) —
 * a replay returns the existing purchase without double-debiting.
 *
 * Returns `{ success, unlocked, promptId, purchaseId, buyerPaysInr,
 * transactionFeeInr, wallet }` or `{ error: { status, message }, shortfall? }`.
 */
export async function buyPromptWithWallet({ userId, itemPriceInr, promptId, refId }) {
  if (!refId || !String(refId).trim() || !String(refId).startsWith('prompt_')) {
    return { error: { status: 400, message: 'refId must look like prompt_<id> for idempotency' } };
  }
  const idFromRef = String(refId).slice('prompt_'.length);
  if (idFromRef && idFromRef !== promptId) {
    return { error: { status: 400, message: 'refId does not match the prompt' } };
  }
  if (!userId) return { error: { status: 401, message: 'Not authenticated' } };

  const prompt = await findByPk(COLS.prompts, promptId);
  if (!prompt || prompt.status !== 'published') {
    return { error: { status: 404, message: 'Prompt not found' } };
  }
  if (!prompt.isPaid || !prompt.priceInr) {
    return { error: { status: 400, message: 'This prompt is free — nothing to pay' } };
  }

  // Admins have full access — never pay.
  const buyer = await findByPk(COLS.users, userId);
  if (buyer && isAdminEmail(buyer.email)) {
    return { error: { status: 409, message: 'You have full admin access — this prompt is already unlocked' } };
  }

  // One unlock per buyer per prompt — reject if already purchased.
  const purchaseId = `${userId}_${promptId}`;
  const existing = await findByPk(COLS.promptPurchases, purchaseId);
  if (existing) {
    return { error: { status: 409, message: 'You already own this prompt' } };
  }

  const priceInr = toMoney(Number(prompt.priceInr) || 0);

  // Re-validate the client's stated price matches the server price — never trust
  // a stale / forged amount in what the buyer is charged.
  if (itemPriceInr != null && Math.abs(Number(itemPriceInr) - priceInr) > 0.001) {
    return { error: { status: 400, message: 'Price mismatch — refresh and try again' } };
  }

  // Mirror grantPromptUnlock's fee: wallet prompt buys carry a 5% transaction
  // fee on top of the prompt price (price × 1.05). The wallet covers the WHOLE
  // amount — price + fee — so the buyer never sees a second payment.
  const buyerPaysInr = toMoney(priceInr * 1.05);
  const transactionFeeInr = toMoney(buyerPaysInr - priceInr);

  // Re-validate that the wallet can actually cover the TOTAL due (price + 5%
  // fee), never trust the client's preview. `debitBalances` throws
  // `{ insufficient }` below if a bucket can't cover its entry — translate to
  // a friendly 402 (shortfall measured against buyerPaysInr).
  const split = await calculatePaymentSplit(userId, buyerPaysInr);
  if (split.totalCovered < buyerPaysInr - 0.001) {
    const shortfall = toMoney(buyerPaysInr - split.totalCovered);
    return {
      error: { status: 402, message: `Insufficient wallet balance — add ₹${shortfall} to continue` },
      shortfall,
    };
  }

  // Snapshot the seller's platform-fee % (Pro 15 / Creator 5), same as grant.
  const authorSub = await currentActiveSubscriptionWithPlan(prompt.authorId);
  const authorFeePercent = authorSub?.plan?.platformFeePercent ?? 5;
  const netInr = toMoney(priceInr - toMoney((priceInr * authorFeePercent) / 100));

  const ledgerRefId = `wallet_spend:${String(refId)}`;

  try {
    await runTransaction(async (tx) => {
      // Already-owns race guard inside the tx.
      const already = await inTxGet(tx, COLS.promptPurchases, purchaseId);
      if (already) throw Object.assign(new Error('already-owns'), { alreadyOwns: true });

      // Firestore forbids reads AFTER writes inside a transaction — pre-read the
      // buyer wallet ONCE before any write, then compute all debits off it.
      const buyerWallet = (await inTxGet(tx, COLS.userWallets, userId)) ?? zeroBalances();
      const authorWallet =
        prompt.authorId
          ? (await inTxGet(tx, COLS.userWallets, prompt.authorId)) ?? zeroBalances()
          : null;

      // 1) Debit the wallet — per-bucket ledger rows, from the pre-read balance.
      for (const s of split.split) {
        await debitBalancesTx(
          tx,
          userId,
          buyerWallet,
          s.balanceType,
          s.amountToUse,
          { type: 'wallet_spend', refId: ledgerRefId, note: `Wallet purchase of "${prompt.title}"` },
        );
      }

      // 2) Purchase row (deterministic id — one per buyer per prompt).
      inTxSet(tx, COLS.promptPurchases, purchaseId, {
        buyerId: userId,
        promptId,
        authorId: prompt.authorId ?? null,
        priceInr,
        buyerPaysInr, // price + 5% tx fee — the wallet covers the whole amount
        transactionFeeInr,
        platformFeePercent: authorFeePercent,
        netInr,
        gateway: 'wallet',
        gatewayFeeInr: 0,
        gatewayFeePercent: 0,
        gatewayFeeSource: 'wallet',
        status: 'completed',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // 3) Creator earnings — credit the FULL gross price (withdrawal fee at payout).
      if (prompt.authorId && authorWallet) {
        const newEarnings = toMoney(Number(authorWallet.earnings ?? 0) + priceInr);
        inTxSet(tx, COLS.userWallets, prompt.authorId, {
          earnings: newEarnings,
          updatedAt: new Date(),
        });
        inTxAdd(tx, COLS.transactions, {
          userId: prompt.authorId,
          type: 'paid_prompt_sale',
          direction: 'credit',
          amountInr: priceInr,
          balanceType: 'earnings',
          balanceAfterInr: newEarnings,
          refId: purchaseId,
          note: `Sale of "${prompt.title}" — gross ${priceInr} (withdrawal fee at payout)`,
          gateway: 'wallet',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    });
  } catch (err) {
    if (err.alreadyOwns) return { error: { status: 409, message: 'You already own this prompt' } };
    if (/ABORTED|already exists/i.test(err.message)) return { error: { status: 409, message: 'You already own this prompt' } };
    if (err.insufficient) {
      const shortfall = toMoney(buyerPaysInr - (await walletCovered(userId, buyerPaysInr)));
      return { error: { status: 402, message: `Insufficient wallet balance — add ₹${shortfall} to continue` }, shortfall };
    }
    throw err;
  }

  notify({
    userId,
    type: 'prompt_unlocked',
    title: 'Prompt unlocked',
    body: `You unlocked "${prompt.title}"`,
    refId: purchaseId,
    dedupeKey: purchaseId,
  });
  if (prompt.authorId) {
    notify({
      userId: prompt.authorId,
      type: 'paid_prompt_sale',
      title: 'Someone purchased your prompt',
      body: `"${prompt.title}" was unlocked — +₹${priceInr} in earnings`,
      refId: purchaseId,
      dedupeKey: purchaseId,
      data: { buyerId: userId, priceInr },
    });
  }

  return {
    success: true,
    unlocked: true,
    promptId,
    purchaseId,
    buyerPaysInr,
    transactionFeeInr,
    wallet: (await getWallet(userId)).balances,
  };
}

/**
 * Debit a single bucket inside an already-open transaction, computed off a
 * caller's PRE-READ wallet. Callers must pre-read `userWallets/{userId}` before
 * any write (Firestore forbid reads-after-writes). Throws `{ insufficient,
 * balanceType }` when a bucket can't cover its entry (caller → friendly 402).
 */
async function debitBalancesTx(tx, userId, wallet, balanceType, amountInr, meta) {
  const bt = getBalanceType(balanceType);
  if (!bt) throw new Error(`Unknown balance type: ${balanceType}`);
  const amount = toMoney(amountInr);
  if (amount <= 0) return null;

  if (bt.id === 'bonus') {
    const { vintages, consumed } = consumeBonusVintages(wallet.bonusVintages ?? {}, amount);
    const newBonus = bonusFromVintages(vintages);
    inTxSet(tx, COLS.userWallets, userId, { bonus: newBonus, bonusVintages: vintages, updatedAt: new Date() });
    inTxAdd(tx, COLS.transactions, {
      userId,
      type: meta?.type ?? 'bonus_debit',
      direction: 'debit',
      amountInr: amount,
      balanceType: 'bonus',
      balanceAfterInr: newBonus,
      refId: meta?.refId ?? null,
      note: meta?.note ?? `Spent ${amount} bonus`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { balanceType: 'bonus', debited: amount, newBalance: newBonus, consumed };
  }

  const cur = bucketAmount(wallet, bt.id);
  if (cur < amount) {
    throw Object.assign(new Error(`Insufficient ${bt.id} balance`), { insufficient: true, balanceType: bt.id });
  }
  const newBalance = toMoney(cur - amount);
  inTxSet(tx, COLS.userWallets, userId, { [bt.id]: newBalance, updatedAt: new Date() });
  inTxAdd(tx, COLS.transactions, {
    userId,
    type: meta?.type ?? `${bt.id}_debit`,
    direction: 'debit',
    amountInr: amount,
    balanceType: bt.id,
    balanceAfterInr: newBalance,
    refId: meta?.refId ?? null,
    note: meta?.note ?? `Spent ${amount} ${bt.id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { balanceType: bt.id, debited: amount, newBalance };
}

/** How much of `itemPriceInr` the wallet currently covers (for 402 shortfall math). */
export async function walletCovered(userId, itemPriceInr) {
  const split = await calculatePaymentSplit(userId, itemPriceInr);
  return toMoney(split.totalCovered);
}