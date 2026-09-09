# Play Billing Integration

> **Phase 1** · Companion: [pricing.md](pricing.md), [wallet.md](wallet.md)

## 1. Scope

Integrate Google Play Billing as the **sole payment gateway** for all
in-app purchases (prompt sales, deposit top-ups, ad-free) and
subscriptions (Pro/Creator). There is no web checkout path — all payments
go through Play Billing.

```
Mobile App (Android)
┌───────────────┐
│ Play Billing   │
└──────┬────────┘
       │  purchase token
       ▼
┌──────────────────────────────────────────┐
│              Backend (Express)           │
│  verify → grant → acknowledge → chain    │
└──────────────────────────────────────────┘
```

## 2. New dependency

```bash
npm install googleapis   # androidpublisher v3
```

## 3. Env vars

```bash
# Google Play Billing — uses GOOGLE_APPLICATION_CREDENTIALS / FIREBASE_PRIVATE_KEY
PLAY_BILLING_PACKAGE_NAME=com.promptlyai.app

# Pub/Sub RTDN
GOOGLE_CLOUD_PROJECT=playbold-promptly-prod
RTDN_TOPIC=play-billing-rtdn
RTDN_SUBSCRIPTION=play-billing-rtdn-sub
```

## 4. Library — `src/lib/playBilling.js`

```javascript
import { google } from 'googleapis';
import { env } from '../config/env.js';

let _androidpublisher = null;
function getClient() {
  if (!_androidpublisher) {
    const auth = new google.auth.GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    _androidpublisher = google.androidpublisher({ version: 'v3', auth });
  }
  return _androidpublisher;
}

export async function verifyOneTimePurchase({ productId, purchaseToken }) {
  const { data } = await getClient().purchases.products.get({
    packageName: env.PLAY_BILLING_PACKAGE_NAME,
    productId, token: purchaseToken,
  });
  return data; // purchaseState, consumptionState, token, ...
}

export async function verifySubscription({ purchaseToken }) {
  const { data } = await getClient().purchases.subscriptions.get({
    packageName: env.PLAY_BILLING_PACKAGE_NAME,
    token: purchaseToken,
  });
  return data; // expiryTimeMillis, autoRenewing, cancelReason, ...
}

export async function acknowledgePurchase({ productId, purchaseToken, isSubscription = false }) {
  if (isSubscription) {
    await getClient().purchases.subscriptions.acknowledge({
      packageName: env.PLAY_BILLING_PACKAGE_NAME,
      token: purchaseToken, requestBody: { developerPayload: '' },
    });
  } else {
    await getClient().purchases.products.acknowledge({
      packageName: env.PLAY_BILLING_PACKAGE_NAME,
      productId, token: purchaseToken, requestBody: { developerPayload: '' },
    });
  }
}

/**********************************************************************
 * Play Billing commission — Google does NOT return it.               *
 * We calculate from public rules + track tenant tenure ourselves.    *
 **********************************************************************/
export function calculatePlayBillingFee({ salePriceInr, subscriberTenureMonths = 0,
                                          isSubscription = false, lifetimeRevenueUsd = 0 }) {
  if (isSubscription) {
    const feePercent = subscriberTenureMonths <= 12 ? 15 : 10;
    return {
      feePercent,
      feeInr: Math.round((salePriceInr * feePercent) / 100),
      tenureCategory: subscriberTenureMonths <= 12 ? 'year1' : 'year2plus',
    };
  }
  const feePercent = lifetimeRevenueUsd < 1_000_000 ? 15 : 30;
  return {
    feePercent,
    feeInr: Math.round((salePriceInr * feePercent) / 100),
    revenueCategory: lifetimeRevenueUsd < 1_000_000 ? 'under1M' : 'over1M', // fixed typo (was: revenuCategory)
  };
}
```

## 5. Verify + grant flow — `POST /payments/playbilling/verify`

```javascript
router.post('/playbilling/verify', moneyLimiter, async (req, res, next) => {
  const { productId, purchaseToken, isSubscription } = req.body;

  if (isSubscription) {
    const result = await handleSubscriptionPurchase({ userId: req.userId, productId, purchaseToken });
    return result.error ? next(httpError(result.error.status, result.error.message)) : res.json(result);
  }

  const result = await handleOneTimePurchase({ userId: req.userId, productId, purchaseToken });
  return result.error ? next(httpError(result.error.status, result.error.message)) : res.json(result);
});
```

### 5.1 One-time purchase handler

```javascript
export async function handleOneTimePurchase({ userId, productId, purchaseToken }) {
  const purchase = await verifyOneTimePurchase({ productId, purchaseToken });
  if (!purchase || purchase.purchaseState !== 0) { // 0 = PURCHASED
    return { error: { status: 400, message: 'Purchase not completed' } };
  }

  // Grant entitlement, then acknowledge (ack prevents auto-refund).
  await routeOneTimeGrant({ userId, productId, purchaseToken, purchase });
  await acknowledgePurchase({ productId, purchaseToken, isSubscription: false });

  return { verified: true };
}
```

`routeOneTimeGrant` dispatches by `productId`:

| productId | Action |
|---|---|
| `prompt_<id>` | Unlock prompt → wallet debit (buyer pays **price + 5% transaction fee**) + `promptPurchases` row (5% → app income; creator credited **gross**) |
| `deposit_s/m/l/xl` | `handleDepositTopUp` — deposits += **net** (after 15% fee), fee → **bonus** vintage (consumable — see [wallet.md](wallet.md#45--deposit-top-up--deduct-fee-at-credit-recycle-as-bonus)) |
| `ad_free` | Set `user.adFree = true` (see [ads-adfree.md](ads-adfree.md)) |

### 5.2 Subscription handler

Play Billing subscription flow: verify → map `productId` to Pro/Creator plan →
store `user_subscriptions` → grant plan entitlements → **then** acknowledge.

**Entitlement sets:** For a new purchase we grant after verify + before
acknowledge. For **renewals** we rely on RTDN (`SUBSCRIPTION_RENEWED`) to extend
`currentPeriodEnd` — see §7.

## 6. RTDN webhook — `POST /webhooks/google/rtdn`

Google pushes subscription lifecycle events via Cloud Pub/Sub.

```javascript
router.post('/', async (req, res) => {
  const message = req.body?.message;
  if (!message) return res.status(200).json({ received: true });
  const data = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));

  // Verify origin — only accept our subscription name.
  if (req.body.subscription !== env.RTDN_SUBSCRIPTION) {
    return res.status(403).json({ error: 'Invalid subscription' });
  }

  try {
    const result = await handleRTDN(data);
    return res.status(200).json({ received: true, ...result });
  } catch (err) {
    console.error('RTDN handler failed:', err);
    return res.status(200).json({ received: true, status: 'error' }); // always 200 → no retry storm
  }
});
```

### RTDN event → action map

| Event | Action |
|---|---|
| `SUBSCRIPTION_RENEWED` | Extend `currentPeriodEnd`, bump `subscriberTenureMonths` |
| `SUBSCRIPTION_CANCELED` | Mark `status: 'canceled'` at period end (keep access until paid period ends) |
| `SUBSCRIPTION_EXPIRED` | Set `status: 'expired'`, drop entitlements |
| `SUBSCRIPTION_PAUSED` / `REACTIVATED` | Refresh status |

**Idempotency:** process by `notificationId`/`purchaseToken` — the same event can
arrive twice. Use deterministic doc ids in the log collection.

## 7. Refund & void handling — ★ NEW (was missing from old plan)

A user can get a refund for up to **48h** (sometimes longer, sometimes auto-granted
by Google). Without a handler, the creator's `earnings` phantom-credits — a real
money hole.

```
Play Console / Google grants a refund or voids the purchase
  → RTDN TEST event or manual/dev middle path
  → POST /payments/playbilling/void { productId, purchaseToken }
  → Backend:
       prompt purchase  → void the promptPurchases row (status: 'voided')
                          + DEBIT the creator's earnings back
                          (net 0 for the creator, buyer loses unlock)
       deposit top-up   → refund the **net** from deposits, remove the recycled
                          bonus vintage (see wallet.md §4.6)
       subscription     → cancel entitlement, refund per Google's cancel rules
  → ledger: { type: 'purchase_void' | 'deposit_refund', direction: 'debit' }
```

**Rules / safeguards:**
- **Store the purchase token on every grant** (already in `promptPurchases.gatewayOrderToken`).
- Void is **only** valid if the token matches a stored, non-voided grant.
- Creator debit is **capped at their *un-withdrawn* earnings** for that item — if
  they already cashed out, it becomes a negative float against future earnings
  (never overdraw the bank).
- On a refund, the **5% transaction fee is returned too** (it was charged to the
  buyer as app income at purchase; refunding the purchase means refunding the
  fee with it — the app's gross income shrinks by the refunded `buyerPaysInr`).
- Void/refund of a **deposit** debits the **net** from `deposits` and removes the
  recycled bonus **vintage** (§4.6). If the user already spent it, the debit can
  leave `deposits` negative → mark an owed balance, block further
  deposits-with-spend until recovered.

## 8. Entitlement policy — what happens on lapse/cancel

| State | Prompt unlocks | Deposit balance | Sub entitlements |
|---|---|---|---|
| Active sub | kept (owned content) | kept | full |
| Sub canceled (paid period still running) | kept | kept | keep until period end |
| Sub expired | **kept** (owned, per Play rules) | kept | dropped |
| Prompt refunded | **revoked** | unchanged | unchanged |

**Key rule (stated explicitly):** Paid prompt unlocks are *owned* once purchased —
subscription lapse does **not** revoke them. Only a refund/void revokes a prompt
unlock.

## 9. Commission calculation & reconciliation

- Gateway fee is **calculated at sale** and stored (`gatewayFeeInr`,
  `gatewayFeePercent`) for reconciliation only — it is the *platform's* cost and
  is **never** deducted at withdrawal.
- **Monthly reconciliation** against Play Console payout reports; adjust if the
  difference exceeds `PLAY_BILLING_FEE_TOLERANCE_INR` (₹0.01).
- **Withdrawal model:** two fees, separate — a **5% buyer transaction fee**
  collected at purchase (app income) and a **15% Pro / 5% Creator withdrawal fee**
  applied at payout. The Google commission is absorbed by the platform. Details in
  [withdrawals.md](withdrawals.md).

## 10. Implementation order

```
[x] Add googleapis dependency
[x] Create src/lib/playBilling.js
[x] Env vars (Play Billing + RTDN)
[x] POST /payments/playbilling/verify (one-time: prompt / deposit / ad-free)
[x] Subscription purchase handler (+ entitlements, monthly + annual)
[x] POST /webhooks/google/rtdn + event map
[x] Refund/void handler (★)  — src/services/payments/void.service.js + POST /payments/playbilling/void
[x] Purchase-token storage on grants
[ ] Test with Play Console internal track   ← APP-SIDE (Android build + tester list) — see APP_INTEGRATION.md §4
[x] Monthly reconciliation script  — npm run reconcile
```

## 11. Open questions

1. **Web access** — Play Billing is required for *Android* access. Web/browser
   users can still view free prompts. Paid prompt purchases and subscriptions
   are Play Billing only (Android app).
2. Refund policy: 48h blanket, or per-category grace windows?

## 12. Related

- [pricing.md](pricing.md) — SKUs & amounts §3
- [wallet.md](wallet.md) — wallet credit/debit on grant & void
- [ads-adfree.md](ads-adfree.md) — `ad_free` entitlement
- [reference.md](reference.md) — shared endpoints, env, indexes