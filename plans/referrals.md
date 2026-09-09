# Referral Program

> **Phase 3** · Companion: [wallet.md](wallet.md) (bonus crediting), [pricing.md](pricing.md) (bonus amounts)

## 1. Design principles

- **IMMEDIATE qualification** — no purchase required. Both referrer and referee
  get `bonus` instantly on a **valid oAuth signup**.
- **Anti-abuse, no raw device ID required** (Play Account ID is the near-device
  signal, but we avoid collecting a raw device identifier):
  - oAuth-only signup (kills fake email/password farms)
  - Play Account ID (same Google account = same ID across reinstalls)
  - Firebase UID (one account per real user)
  - IP rate limiting on signup with a code
  - Max referrals per referrer (default **100**)
  - Bonus is `bonus`-type: **non-withdrawable, 10%-max spend, 90-day expiry**

## 2. New Firestore collections

```
referral_codes:
  { code: string, userId: string, isActive: boolean, createdAt: Date }

referrals:
  { referrerId: string, refereeId: string, code: string,
    status: 'completed', completedAt: Date,
    bonusCredited: boolean, ipAddress?: string, createdAt: Date }

device_fingerprints:
  { userId: string, playAccountId: string,
    ipAddress?: string, createdAt: Date, lastSeenAt: Date }
```

## 3. Config

```javascript
const REFERRAL_CONFIG = {
  bonusPerReferralInr: 50,      // referrer
  welcomeBonusInr: 25,          // referee
  maxReferralsPerUser: 100,
  maxReferralsPerIpPerDay: 5,
  balanceType: 'bonus',
};
```

> Amounts are decided in [pricing.md](pricing.md) §5 — keep in sync.

## 4. oAuth-only qualification (★ anti-fraud gate)

A new user is **only eligible** for referral bonus if they signed up via an
oAuth provider (Google/Apple/etc.) — **not** email/password. This blocks batches of
fake accounts without needing device metadata.

```javascript
const OAUTH_PROVIDERS = new Set(['google.com', 'apple.com', 'facebook.com', 'github.com']);

// In the auth middleware / login resolver, persist the provider:
//   firebaseAuth.verifyIdToken(idToken, true) → decoded.firebase.sign_in_provider
//   store user.signInProvider = decoded.firebase.sign_in_provider

export function isOAuthSignIn(user) {
  return OAUTH_PROVIDERS.has(user?.signInProvider);
}
```

**Wiring:** In `POST /auth/login`, after resolving the user:

```javascript
if (parsed.data.referralCode) {
  // Only oAuth sign-ins can apply a referral code.
  if (!isOAuthSignIn(user)) {
    // skips gracefully — still logs in, but drops the referralCode
    console.warn('Referral skipped — non-oAuth sign-in', user.id);
  } else {
    const result = await applyReferralCode({
      refereeId: userId, code: parsed.data.referralCode,
      playAccountId: parsed.data.playAccountId, ipAddress: req.ip,
    });
    if (result.error) console.warn('Referral apply failed:', result.error.message);
  }
}
```

## 5. Service — `src/services/referrals/referral.service.js`

### 5.1 Generate

```javascript
export async function generateReferralCode(userId) {
  const existing = await queryAll({
    collection: COLS.referralCodes,
    filters: [{ field: 'userId', value: userId }, { field: 'isActive', value: true }],
    limit: 1,
  });
  if (existing.rows.length) return { code: existing.rows[0].code, alreadyExists: true };

  const code = generateCode(); // 8 alphanumeric, upper
  await create(COLS.referralCodes, code, { userId, code, isActive: true, createdAt: new Date() });
  return { code, alreadyExists: false };
}
```

### 5.2 Apply (with all checks)

```javascript
export async function applyReferralCode({ refereeId, code, playAccountId, ipAddress }) {
  const codeDoc = await findByPk(COLS.referralCodes, code?.toUpperCase());
  if (!codeDoc?.isActive) return { error: { status: 404, message: 'Invalid referral code' } };
  if (codeDoc.userId === refereeId) return { error: { status: 400, message: 'You cannot use your own referral code' } };

  const already = await queryAll({ collection: COLS.referrals,
    filters: [{ field: 'refereeId', value: refereeId }], limit: 1 });
  if (already.rows.length) return { error: { status: 409, message: 'You were already referred by someone' } };

  const refsCount = await countDocuments(COLS.referrals, [{ field: 'referrerId', value: codeDoc.userId }]);
  if (refsCount >= REFERRAL_CONFIG.maxReferralsPerUser)
    return { error: { status: 400, message: 'This referral code has reached its limit' } };

  // ★ Play Account ID — reject if this Google account already got a referral bonus
  if (playAccountId) {
    const fp = await queryAll({ collection: COLS.deviceFingerprints,
      filters: [{ field: 'playAccountId', value: playAccountId }], limit: 1 });
    if (fp.rows.length) {
      const existingUserId = fp.rows[0].userId;
      if (existingUserId !== refereeId) {
        const ref = await queryAll({ collection: COLS.referrals,
          filters: [{ field: 'refereeId', value: existingUserId }], limit: 1 });
        if (ref.rows.length)
          return { error: { status: 400, message: 'This Google account already received a referral bonus' } };
      }
    }
  }

  // ★ IP rate limiting — max N referrals per IP per day
  if (ipAddress) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const fromIp = await queryAll({ collection: COLS.referrals,
      filters: [{ field: 'ipAddress', value: ipAddress }], orderBy: { field: 'createdAt', direction: 'desc' },
      limit: REFERRAL_CONFIG.maxReferralsPerIpPerDay });
    const recent = fromIp.rows.filter((r) => new Date(r.createdAt) > dayAgo).length;
    if (recent >= REFERRAL_CONFIG.maxReferralsPerIpPerDay)
      return { error: { status: 429, message: 'Too many referrals from this network. Please try again later' } };
  }

  // ALL CHECKS PASSED — create + credit both, atomically where possible.
  const referralId = `${codeDoc.userId}_${refereeId}`;
  await create(COLS.referrals, referralId, {
    referrerId: codeDoc.userId, refereeId, code: code.toUpperCase(),
    status: 'completed', completedAt: new Date(), bonusCredited: true,
    ipAddress: ipAddress ?? null, createdAt: new Date(),
  });
  if (playAccountId) {
    await upsert(COLS.deviceFingerprints, `${playAccountId}_${refereeId}`, {
      userId: refereeId, playAccountId, ipAddress: ipAddress ?? null,
      createdAt: new Date(), lastSeenAt: new Date() });
  }

  await creditBonus(codeDoc.userId, REFERRAL_CONFIG.bonusPerReferralInr, 'referral_bonus', referralId);
  await creditBonus(refereeId, REFERRAL_CONFIG.welcomeBonusInr, 'welcome_bonus', referralId);

  return { success: true, referrerBonus: REFERRAL_CONFIG.bonusPerReferralInr,
           refereeBonus: REFERRAL_CONFIG.welcomeBonusInr, balanceType: 'bonus' };
}

// Thin wrapper that routes into wallet's creditBalance with a bonus vintage.
export function creditBonus(userId, amount, type, refId) {
  return creditBalance(userId, 'bonus', amount, { type, refId, note: `Referral ${type}` });
}
```

> **Atomicity note:** the referral row create + both bonus credits ideally share a
> **single Firestore transaction** so a crash mid-way never credits one side only.
> If that's not possible, add a retry/idempotency key on `referralId`.

### 5.3 Stats & list

```javascript
export async function getReferralStats(userId) {
  const refs = await countDocuments(COLS.referrals, [{ field: 'referrerId', value: userId }]);
  return {
    totalReferrals: refs,
    totalBonusEarned: refs * REFERRAL_CONFIG.bonusPerReferralInr,
    maxReferrals: REFERRAL_CONFIG.maxReferralsPerUser,
    remainingReferrals: Math.max(0, REFERRAL_CONFIG.maxReferralsPerUser - refs),
    referralCode: null, // caller populates
  };
}

export async function getReferralList(userId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await queryAll({ collection: COLS.referrals,
    filters: [{ field: 'referrerId', value: userId }],
    orderBy: { field: 'createdAt', direction: 'desc' }, limit, offset });
  const ids = [...new Set(rows.map((r) => r.refereeId))].filter(Boolean);
  const users = ids.length ? await getMany(COLS.users, ids) : {};
  return {
    referrals: rows.map((r) => ({
      id: r.id, refereeName: users[r.refereeId]?.fullName ?? 'Anonymous',
      status: r.status, completedAt: r.completedAt, createdAt: r.createdAt })),
    total: rows.length,
  };
}
```

## 6. API endpoints

```
POST   /referrals/code          — Generate my code (authenticated)
GET    /referrals/code          — Get my code (authenticated)
GET    /referrals/:code/validate — Check a code (public)
POST   /referrals/apply         — Apply a code at signup (authenticated, oAuth-only)
GET    /referrals/stats         — My stats (authenticated)
GET    /referrals/list          — My invites (authenticated)
```

**Rate limiting:** `/referrals/apply` inherits the login limiter (30/min). General
**money-limit** on code-gen too (prevent code generation spam).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Fake email/password accounts | oAuth-only signup gate |
| Farmers with multiple Google accounts | Play Account ID linkage + IP limiter + max referrals |
| Burner domains / disposable emails | Optional email-domain allow/block list |
| Self-referral (own code) | Reject codeDoc.userId === refereeId |
| Gigantic referrer accounts | `maxReferralsPerUser` cap (100) |

## 8. Implementation order

```
[x] Persist signInProvider on users doc (auth middleware + login)
[x] referral_codes + referrals + device_fingerprints collections
[x] referral.service.js (generate/validate/apply/stats/list)
[x] POST /auth/login wiring (oAuth gate)
[x] referral API endpoints
[x] bonus crediting via creditBonus (vintage-aware)
[ ] Test: happy path + abuse attempts (own-code, IP flood, dup Play Account)   ← APP-SIDE (see APP_INTEGRATION.md §2)
```

## 9. Open questions

1. Should a **referrer be required to have their own account for ≥N days** before
   their code pays out (deters account-flip farming)? Recommended: no, keep
   immediate; enforce via Play Account ID + IP instead.

## 10. Related

- [wallet.md](wallet.md) §5 — bonus vintages & expiry
- [pricing.md](pricing.md) §5 — bonus amounts
- [reference.md](reference.md) — collections, endpoints, indexes