import {
  COLS,
  create,
  findByPk,
  queryAll,
  countDocuments,
  getMany,
  inTxGet,
  inTxSet,
  inTxAdd,
} from '../../db/firestoreRepo.js';
import { runTransaction } from '../../db/config.js';
import { env } from '../../config/env.js';
import { zeroBalances } from '../payments/balance-types.js';

/**
 * Referral program (Phase 3 — plans/referrals.md).
 *
 * Design principles:
 *   - IMMEDIATE qualification — no purchase required. Both referrer and referee
 *     get `bonus` instantly on a valid oAuth signup.
 *   - Anti-abuse without a raw device ID:
 *       · oAuth-only signup (kills fake email/password farms)
 *       · Play Account ID (same Google account = same ID across reinstalls)
 *       · Firebase UID (one account per real user)
 *       · IP rate limiting on signup with a code
 *       · Max referrals per referrer (default 100)
 *   - Bonus is `bonus`-type: non-withdrawable, 10%-max spend, 90-day expiry
 *     (handled as a bonus vintage, same rule set as every other bonus credit).
 *
 * Bonus amounts default from env, mirroring plans/pricing.md §5:
 *   referrer ₹50, referee welcome ₹25. Update both together.
 */

// oAuth providers that qualify for referral (blocks fake email/password farms).
const OAUTH_PROVIDERS = new Set([
  'google.com',
  'apple.com',
  'facebook.com',
  'github.com',
]);

function err(status, message) {
  return { error: { status, message } };
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/** True when the user signed in via a qualifying oAuth provider. */
export function isOAuthSignIn(user) {
  return OAUTH_PROVIDERS.has(user?.signInProvider);
}

/** 8-char alphanumeric (upper) referral code — no I/O/0/1 confusion chars. */
function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 8; i += 1) code += alphabet[rand[i] % alphabet.length];
  return code;
}

/** Find the user's active referral code, if one exists. */
async function findActiveCode(userId) {
  const existing = await queryAll({
    collection: COLS.referralCodes,
    filters: [
      { field: 'userId', value: userId },
      { field: 'isActive', value: true },
    ],
    limit: 1,
  });
  return existing.rows.length ? existing.rows[0].code : null;
}

/**
 * Generate a referral code (returns the existing active one if present).
 */
export async function generateReferralCode(userId) {
  const active = await findActiveCode(userId);
  if (active) return { code: active, alreadyExists: true };

  // Collision-avoiding insert: try a few codes, keep the first free slot.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const clash = await findByPk(COLS.referralCodes, code);
    if (!clash) {
      await create(COLS.referralCodes, code, {
        code,
        userId,
        isActive: true,
        createdAt: new Date(),
      });
      return { code, alreadyExists: false };
    }
  }
  throw new Error('Could not allocate a unique referral code');
}

/**
 * Return the user's active referral code, creating one if absent — idempotent,
 * safe to call on /code GET and /stats.
 */
export async function getReferralCode(userId) {
  const active = await findActiveCode(userId);
  if (active) return { code: active, alreadyExists: true };
  return generateReferralCode(userId);
}

/**
 * Validate a referral code (public, pre-signup) — returns referrer info when
 * the code is active and usable.
 */
export async function validateReferralCode(code) {
  const codeDoc = await findByPk(COLS.referralCodes, code?.toUpperCase());
  if (!codeDoc?.isActive) {
    return { valid: false, error: 'Invalid referral code' };
  }
  const referrer = await findByPk(COLS.users, codeDoc.userId);
  return {
    valid: true,
    code: codeDoc.code,
    referrerName: referrer?.fullName ?? 'A Promptly user',
    referrerId: codeDoc.userId,
  };
}

/**
 * Apply a referral code at oAuth signup, crediting both sides as bonus.
 *
 * Runs the whole grant (referral row + device fingerprint + both bonus
 * credits) inside ONE Firestore transaction so a crash mid-way can never
 * credit one side without the other.
 */
export async function applyReferralCode({ refereeId, code, playAccountId, ipAddress }) {
  const normalized = code?.toUpperCase();
  const codeDoc = await findByPk(COLS.referralCodes, normalized);
  if (!codeDoc?.isActive) return err(404, 'Invalid referral code');
  if (codeDoc.userId === refereeId) {
    return err(400, 'You cannot use your own referral code');
  }

  const alreadyReferred = await countDocuments(COLS.referrals, [
    { field: 'refereeId', value: refereeId },
  ]);
  if (alreadyReferred) return err(409, 'You were already referred by someone');

  const referrerCount = await countDocuments(COLS.referrals, [
    { field: 'referrerId', value: codeDoc.userId },
  ]);
  if (referrerCount >= env.REFERRAL_MAX_PER_USER) {
    return err(400, 'This referral code has reached its limit');
  }

  // ★ Play Account ID — reject if this Google account already got a referral bonus.
  if (playAccountId) {
    const fp = await queryAll({
      collection: COLS.deviceFingerprints,
      filters: [{ field: 'playAccountId', value: playAccountId }],
      limit: 1,
    });
    if (fp.rows.length) {
      const existingUserId = fp.rows[0].userId;
      if (existingUserId !== refereeId) {
        const alreadyGotBonus = await countDocuments(COLS.referrals, [
          { field: 'refereeId', value: existingUserId },
        ]);
        if (alreadyGotBonus) {
          return err(400, 'This Google account already received a referral bonus');
        }
      }
    }
  }

  // ★ IP rate limiting — max N referrals from one IP per day.
  if (ipAddress) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fromIp = await queryAll({
      collection: COLS.referrals,
      filters: [{ field: 'ipAddress', value: ipAddress }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: env.REFERRAL_MAX_PER_IP_PER_DAY,
    });
    const recent = fromIp.rows.filter((r) => new Date(r.createdAt) > dayAgo).length;
    if (recent >= env.REFERRAL_MAX_PER_IP_PER_DAY) {
      return err(429, 'Too many referrals from this network. Please try again later');
    }
  }

  // ALL CHECKS PASSED — create + credit both, atomically in one transaction.
  const referralId = `${codeDoc.userId}_${refereeId}`;

  try {
    await runTransaction(async (tx) => {
      const existing = await inTxGet(tx, COLS.referrals, referralId);
      if (existing) {
        throw Object.assign(new Error('already-referred'), { alreadyReferred: true });
      }

      // Referral row.
      inTxSet(tx, COLS.referrals, referralId, {
        referrerId: codeDoc.userId,
        refereeId,
        code: normalized,
        status: 'completed',
        completedAt: new Date(),
        bonusCredited: true,
        ipAddress: ipAddress ?? null,
        createdAt: new Date(),
      });

      // Device fingerprint (Play Account ID is optional — skip when absent).
      if (playAccountId) {
        inTxSet(tx, COLS.deviceFingerprints, `${playAccountId}_${refereeId}`, {
          userId: refereeId,
          playAccountId,
          ipAddress: ipAddress ?? null,
          createdAt: new Date(),
          lastSeenAt: new Date(),
        });
      }

      // Both bonus credits inside the same transaction (vintage-aware).
      creditBonusInTx(tx, codeDoc.userId, env.REFERRAL_BONUS_INR, 'referral_bonus', referralId);
      creditBonusInTx(tx, refereeId, env.REFERRAL_WELCOME_BONUS_INR, 'welcome_bonus', referralId);
    });
  } catch (e) {
    if (e.alreadyReferred) return err(409, 'You were already referred by someone');
    throw e;
  }

  return {
    success: true,
    referrerBonus: env.REFERRAL_BONUS_INR,
    refereeBonus: env.REFERRAL_WELCOME_BONUS_INR,
    balanceType: 'bonus',
  };
}

/**
 * Credit a bonus inside the caller's transaction — writes the wallet's bonus
 * scalar + a bonus vintage entry + a ledger row. Mirrors creditBalance's bonus
 * path so referral credits follow the same FEFO/expiry rule set.
 */
function creditBonusInTx(tx, userId, amountInr, type, refId) {
  const wallet = inTxGet(tx, COLS.userWallets, userId) ?? zeroBalances();
  const vintages = { ...(wallet.bonusVintages ?? {}) };
  const prior = vintages[refId];

  const expiresAt = new Date(Date.now() + env.BONUS_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  vintages[refId] = {
    remaining: roundMoney(Number(prior?.remaining ?? 0) + amountInr),
    expiresAt,
  };
  const newBonus = roundMoney(
    Object.values(vintages).reduce((sum, v) => sum + roundMoney(v.remaining ?? 0), 0),
  );

  inTxSet(tx, COLS.userWallets, userId, {
    bonus: newBonus,
    bonusVintages: vintages,
    updatedAt: new Date(),
  });
  inTxAdd(tx, COLS.transactions, {
    userId,
    type,
    direction: 'credit',
    amountInr,
    balanceType: 'bonus',
    balanceAfterInr: newBonus,
    refId,
    note: `Referral ${type}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/**
 * Referral stats for a user (total invites, bonus earned, remaining slots).
 */
export async function getReferralStats(userId) {
  const refs = await countDocuments(COLS.referrals, [
    { field: 'referrerId', value: userId },
  ]);
  return {
    totalReferrals: refs,
    totalBonusEarned: refs * env.REFERRAL_BONUS_INR,
    maxReferrals: env.REFERRAL_MAX_PER_USER,
    remainingReferrals: Math.max(0, env.REFERRAL_MAX_PER_USER - refs),
    bonusExpiryDays: env.BONUS_EXPIRY_DAYS,
  };
}

/**
 * A user's invite list (newest first), with referee names.
 */
export async function getReferralList(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await queryAll({
    collection: COLS.referrals,
    filters: [{ field: 'referrerId', value: userId }],
    orderBy: { field: 'createdAt', direction: 'desc' },
    limit,
    offset,
  });
  const ids = [...new Set(rows.map((r) => r.refereeId))].filter(Boolean);
  const users = ids.length ? await getMany(COLS.users, ids) : {};
  return {
    referrals: rows.map((r) => ({
      id: r.id,
      refereeId: r.refereeId,
      refereeName: users[r.refereeId]?.fullName ?? 'Promptly user',
      status: r.status,
      completedAt: r.completedAt,
      createdAt: r.createdAt,
    })),
    total: rows.length,
  };
}
