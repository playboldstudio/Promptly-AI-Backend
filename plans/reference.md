# Shared Reference — Data Model, API, Env, Roadmap, Risks

> Cross-cutting definitions shared by all feature files. Update here, not per-file.

## 1. New Firestore collections

```javascript
// COLS additions in firestoreRepo.js
userWallets:        'user_wallets',        // multi-balance wallet
referralCodes:      'referral_codes',      // referral codes
referrals:          'referrals',           // referral records
deviceFingerprints: 'device_fingerprints', // anti-abuse Play Account ID
adFreePurchases:    'ad_free_purchases',   // one-time ad-free audit
promptLikes:        'prompt_likes',        // like join table
promptReports:      'prompt_reports',      // report join table
promptShares:       'prompt_shares',       // (optional analytics log — else just a counter)
```

> `promo_codes`, `promo_redemptions`, `reward_rules`, `reward_events` — **do not
> pre-create**. The unified `bonus` balance already future-proofs them; add
> collections only when each feature ships.

### Collection schemas

```javascript
// user_wallets
// deposits = NET of gateway fee (₹100 top-up → ₹85):
//   the ₹15 fee is recycled as a bonus vintage.
{ id: userId, earnings: 250, deposits: 85, bonus: 75,
  bonusVintages: { [creditId]: { remaining: 40, expiresAt: Date } },
  createdAt, updatedAt }

// referral_codes
{ id: code, code, userId, isActive, createdAt }

// referrals
{ id: 'referrerId_refereeId', referrerId, refereeId, code,
  status: 'completed', completedAt, bonusCredited, ipAddress?, createdAt }

// device_fingerprints
{ id: 'playAccountId_userId', userId, playAccountId,
  ipAddress?, createdAt, lastSeenAt }

// ad_free_purchases
{ id: userId, userId, productId: 'ad_free', purchaseToken,
  purchaseTime, amountInr, status: 'verified', createdAt, updatedAt }

// prompt_likes  (id: 'userId_promptId')
{ userId, promptId, likedAt }

// prompt_reports  (id: 'userId_promptId')
{ userId, promptId, reason, description, status: 'pending'|'resolved'|'dismissed', createdAt }

// prompt_shares  (analytics; or just shareCount on the prompt)
{ promptId, userId?, sharedAt }
```

## 2. Updated schemas

### `prompt_purchases`

```javascript
{
  // existing
  buyerId, authorId, promptId, status, createdAt, updatedAt,

  // renamed/added
  priceInr: 99,                  // creator's gross (the prompt price)
  buyerPaysInr: 103.95,          // ★ price + 5% transaction fee (in-app)
  transactionFeeInr: 4.95,       // ★ 5% → app income (not credited to any user)
  platformFeePercent: 15,        // seller's withdrawal-fee snapshot (15% Pro / 5% Creator)
  gateway: 'play_billing',       // always Play Billing (sole gateway)
  gatewayFeeInr: 15.59,          // per-sale commission (tracked for reconciliation only)
  gatewayFeePercent: 15,         // snapshot at sale
  gatewayFeeSource: 'calculated' | 'reconciled',
  gatewayOrderToken: 'xxx',      // Play Billing purchase token
  buyerPlanId: 'pro',            // for withdrawal-fee calc
  subscriberTenureMonths: 3,     // null for one-time
  voidedAt: Date | null,         // ★ refund/void marker
  voidReason: string | null,     // ★ 'refund' | 'void'
}
```

> **Fee model recap:** the 5% **transaction fee** is app income captured at
> purchase (buyer pays price + 5%). The **withdrawal fee** (15% Pro / 5% Creator)
> is applied only when the creator initiates a payout. The **gateway fee**
> (Play Billing commission) is tracked for reconciliation but is *never*
> deducted at payout — the platform absorbs it.

### `user_subscriptions`

```javascript
{
  userId, planId, status, currentPeriodStart, currentPeriodEnd,
  gateway: 'play_billing',          // sole gateway
  gatewaySubscriptionId: 'xxx',     // Play Billing purchase token
  firstSubscriptionStart: Date,     // tenure calc anchor
  subscriberTenureMonths: 3,
}
```

### `users`

```javascript
{
  // existing + NEW:
  signInProvider: 'google.com',   // ★ for oAuth-only referral gate
  adFree: true,                   // ★ ad-free entitlement
  adFreePurchasedAt: Date | null,
  adFreeSku: 'ad_free' | null,
}
```

### `prompts`

```javascript
{
  status: 'published' | 'reported' | 'appealed' | 'deleted',
  likeCount, saveCount, shareCount, reportCount,
  reportedAt, reportedBy: [], appealStatus, appealReason,
  appealDeadline, appealedAt,
}
```

### `transactions` (ledger)

```javascript
{
  userId, type, direction, amountInr, balanceAfterInr, refId, note,
  balanceType: 'earnings'|'deposits'|'bonus',   // ★ NEW
  gateway: 'play_billing',                      // if purchase
  platformFeeInr, gatewayFeeInr,                // if purchase
  createdAt, updatedAt,
}
```

## 3. Firestore indexes to add

```json
[
  { "collectionGroup": "user_wallets",   "fields": [{ "fieldPath": "earnings", "order": "DESCENDING" }] },
  { "collectionGroup": "referral_codes", "fields": [{ "fieldPath": "userId", "order": "ASCENDING" },
                                                     { "fieldPath": "isActive", "order": "ASCENDING" }] },
  { "collectionGroup": "referrals",      "fields": [{ "fieldPath": "referrerId", "order": "ASCENDING" },
                                                     { "fieldPath": "status", "order": "ASCENDING" }] },
  { "collectionGroup": "referrals",      "fields": [{ "fieldPath": "refereeId", "order": "ASCENDING" }] },
  { "collectionGroup": "transactions",   "fields": [{ "fieldPath": "userId", "order": "ASCENDING" },
                                                     { "fieldPath": "balanceType", "order": "ASCENDING" },
                                                     { "fieldPath": "createdAt", "order": "DESCENDING" }] }
]
```

## 4. API endpoints (full list)

### New

```
POST   /payments/playbilling/verify      — verify + grant one-time purchase (prompt / deposit / ad-free)
POST   /payments/playbilling/deposit     — verify + credit a deposit top-up
POST   /payments/playbilling/ad-free     — verify + grant lifetime ad-free
POST   /webhooks/google/rtdn             — Play Subscription RTDN
GET    /wallet                           — wallet breakdown (earnings/deposits/bonus)
POST   /wallet/allocate                  — choose payment source for a purchase
POST   /referrals/code                   — generate my referral code
GET    /referrals/code                   — get my referral code
GET    /referrals/:code/validate         — check a code (public)
POST   /referrals/apply                  — apply a code at signup (oAuth-only)
GET    /referrals/stats                  — my referral stats
GET    /referrals/list                   — my invites
POST   /payments/playbilling/void        — ★ refund/void a purchase (revoke unlock / debit amounts)
POST   /prompts/:id/like                 — like (toggle, idempotent)
POST   /prompts/:id/unlike               — unlike (idempotent)
POST   /prompts/:id/share                — shareCount++
POST   /prompts/:id/report               — report { reason, description? }
POST   /prompts/:id/appeal               — creator appeal (7-day window)
GET    /admin/prompts/reports            — moderation queue (admin)
POST   /admin/prompts/:id/approve        — approve appeal → published
POST   /admin/prompts/:id/reject         — reject → deleted
POST   /admin/prompts/:id/dismiss-report — dismiss below threshold (admin)
PATCH  /admin/wallets/:id                — ★ manual wallet adjustment for refund disputes (admin)
```

### Modified

```
POST   /payments/subscriptions      → Play Billing subs
DELETE /payments/subscriptions      → Play Billing cancel
POST   /payments/payouts            → deduct only withdrawal fee (15%/5%) — no gateway fee
GET    /payments/payouts/eligibility → show earnings + withdrawal fee percent
GET    /me/earnings                 → include gateway fees
GET    /me/transactions             → filter by balanceType
DELETE /me/account                  → clean up wallet, referral codes
POST   /auth/login                  → accept referralCode + playAccountId; persist signInProvider
```

### Removed

```
POST /webhooks/razorpay    → removed (Razorpay deprecated; RTDN handles subscriptions)
POST /payments/checkout/*  → removed (Razorpay checkout; Play Billing handles purchases)
```

## 5. Environment variables (consolidated)

```bash
# Play Billing
PLAY_BILLING_PACKAGE_NAME=com.promptlyai.app
# Uses GOOGLE_APPLICATION_CREDENTIALS for auth

# RTDN
GOOGLE_CLOUD_PROJECT=playbold-promptly-prod
RTDN_TOPIC=play-billing-rtdn
RTDN_SUBSCRIPTION=play-billing-rtdn-sub

# Referral
REFERRAL_BONUS_INR=50
REFERRAL_WELCOME_BONUS_INR=25
REFERRAL_MAX_PER_USER=100
REFERRAL_MAX_PER_IP_PER_DAY=5
BONUS_EXPIRY_DAYS=90
BONUS_EXPIRY_REMINDER_DAYS=7

# Wallet
DEPOSIT_MIN_INR=10
DEPOSIT_MAX_INR=10000

# Reconciliation
PLAY_BILLING_FEE_TOLERANCE_INR=0.01

# Ads & ad-free
AD_FREE_PRODUCT_ID=ad_free
AD_FREE_PRICE_INR=149

# Moderation
PROMPT_REPORT_THRESHOLD=5
PROMPT_APPEAL_WINDOW_DAYS=7

# Existing, unchanged
MIN_WITHDRAWAL_INR=60
ADMIN_EMAILS
```

> **Pricing-driven vars** live with the plans that use them: plan prices are
> decided in [pricing.md](pricing.md) (seed/`.env` updates come from there).

## 6. Future roadmap

| Horizon | Feature | Balance credit |
|---|---|---|
| Near-term | Deposit fee-recycle (built-in) | `bonus` (15% of top-up) |
| | Daily login streaks | `bonus` |
| | Promo codes / vouchers | `bonus` |
| | Top-creator reward | `bonus` |
| | Subscription perk | `bonus` |
| Medium | Prompt bundles, free trials, annual plans, prompt ratings, creator verification, leaderboards | – |
| Long | Gifting, share-and-earn, tip jar, early access, usage stats, multi-currency | – |

**Rule:** all incentives credit the unified `bonus` balance. No new balance types
planned; add a *collection* only when a feature ships.

> **Deposit top-ups** recycle the gateway fee as bonus (net → `deposits`, fee →
> bonus vintage). See [wallet.md](wallet.md) §4.5 and
> [pricing.md](pricing.md) §4 for the mechanics + the spend-liability note.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Play Billing API downtime | Cache verification, retry w/ backoff |
| RTDN message loss | Periodic reconciliation via API polling |
| Firestore tx limits | Chunk ops; Cloud Tasks for async |
| Google changes commission | Config-driven rates |
| Referral farming | oAuth-only + Play Account ID + IP limiter + max referrals |
| Fake purchase tokens | Server-side verify + acknowledge-after-grant |
| Wallet manipulation | All ops in Firestore transactions, idempotent |
| RTDN spoofing | Validate Pub/Sub origin + subscription id |
| **Refund/void** (★) | Dedicated void handler; cap creator debit at un-withdrawn earnings |
| Bonus expiry over-debit (★) | FEFO vintages — expire only remaining per credit |

## 8. Implementation order (summary)

```
Phase 0  pricing        ← decide tiers / SKUs / reward amounts
Phase 1  play-billing   ← verify + RTDN + void/refund + reconciliation
Phase 2  wallet         ← balances + FEFO bonus vintages + migration
Phase 3  referrals      ← oAuth gate + apply + anti-abuse
Phase 4  withdrawals    ← withdrawal fee (15%/5%) deduction at payout — no gateway fee
Phase 5  ads-adfree     ← ad-free SKU + entitlement
Phase 6  moderation     ← report→appeal→admin (+ defer like/share)
```

## 9. Related

- [README.md](README.md) — file index, build order
- Each feature file links back here for shared definitions.