import {
  COLS,
  findByPk,
  inTxGet,
  inTxSet,
  inTxAdd,
  queryAll,
} from '../db/firestoreRepo.js';
import { runTransaction } from '../db/config.js';
import { env } from '../config/env.js';
import {
  BALANCE_TYPES,
  getBalanceType,
  getBalanceTypesByPriority,
  zeroBalances,
} from './payments/balance-types.js';

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
  const remaining = { value: toMoney(itemPriceInr) };
  const split = [];

  for (const typeCfg of getBalanceTypesByPriority()) {
    if (remaining.value <= 0) break;
    const bal = wallet.balances[typeCfg.id]?.amountInr ?? 0;
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
export function creditDepositTopUpTx(tx, { userId, priceInr, gatewayFeeInr, refId, note }) {
  const netDeposit = toMoney(priceInr - gatewayFeeInr);
  const bonusCredit = toMoney(gatewayFeeInr);

  return inTxGet(tx, COLS.userWallets, userId).then((walletDoc) => {
    const wallet = walletDoc ?? zeroBalances();

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