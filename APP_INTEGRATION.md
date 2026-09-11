# APP_INTEGRATION.md — What the backend needs from the Android app

> **Contract for app-side integration.** The backend is being built ahead of the
> app. This file records — for each feature — exactly *what data the app must
> send*, *the shape*, and *where it goes*, so the app team can implement against
> it without the backend having to wait. Anything here is a **known app-side
> dependency**; it is deliberately scoped so the backend never blocks on it.
>
> Legend: ✅ = backend already accepts this shape → app can send it anytime.
> ◐ = backend stored, but has no consumer yet. ⛔ = not built yet.

---

## 0. Environments — base URLs

| Environment | Base URL | Notes |
|---|---|---|
| **DEV** | `https://promptly-ai-backend-dev-617959029813.us-west1.run.app` | Deploy target for the playbilling branch. Same Firestore project (`playbold-promptly-prod`) but the **`promptly-dev`** database. No RTDN wired yet. |
| PROD / LIVE | `https://promptly-ai-backend-git-3lssxylpca-uw.a.run.app` | The live service. **Do not deploy the new Play Billing branch here.** |

All routes below are relative to the base URL. The app uses the **DEV** base URL
for integration work until the branch is promoted to live.

---

## 1. Auth — `POST /auth/login`

Already built. The app sends a Firebase ID token; the backend verifies it and
upserts the `users/{uid}` doc from the token claims.

```jsonc
POST /auth/login
{
  "idToken": "<firebase-auth-id-token>",
  // Referral Phase 3 (see §2): optional — only needed at signup
  "referralCode": "WORTHY-TIGER-1",      // ✅ processed server-side (Phase 3)
  "playAccountId": "<1.2.9408901...>",   // ✅ stored + used for anti-abuse (Phase 3)
}
```

Backend stores `signInProvider` from the decoded token
(`decoded.firebase.sign_in_provider`) for the oAuth-only referral gate. **Nothing
to do app-side to send it** — it's already derived server-side.

When `referralCode` is present at signup, the backend applies it
(`applyReferralCode`, oAuth-only gate + Play Account ID + IP anti-abuse) and
returns `{ referral: { applied: true|false, ... } }` in the login response. It
never blocks login — a failed apply is returned as info, not an error.

---

## 2. Referral signup (Phase 3) — app-side TODO

When the plans/referrals phase builds, the app must pass the signup-time fields
below. Backend will validate oAuth-only + rate-limit on them. **Not active yet.**

| Field | Shape | Where the app gets it | Required? |
|---|---|---|---|
| `referralCode` | string, in the login body | The code the user typed/shared | at signup |
| `playAccountId` | string (Play Account ID, e.g. `1.2.9408901...`) | `PlayCore` / Google Play services | at signup (anti-fraud) |
| `ipAddress` | auto from request | backend derives from `req.ip` | backend-side |

---

## 3. Bonus-expiry push reminder (Phase 2) — app-side TODO

`getBonusExpiringSoon(userId)` already computes which bonus vintages expire
within 7 days. To actually **deliver** a push, the app must register an **FCM
device token**:

| Field | Shape | Where the app gets it | Status |
|---|---|---|---|
| `deviceToken` | string (FCM registration token) | `firebase.messaging().getToken()` | ◐ backend will store; **no endpoint yet** |
| `platform` | `'android'` | constant | ◐ |
| `appVersion` | string | `BuildConfig.VERSION_NAME` | ◐ |

Backend will expose `POST /me/device-token { token, platform?, appVersion? }`
(auth'd) to register. The app calls it at login/launch (and on token refresh).
See `src/services/wallet.service.js` → `getBonusExpiringSoon`.

> **Alternative (no app change):** an in-app **inbox/notification** — the backend
> writes a `notifications` doc and the app polls `GET /me/notifications` at
> launch. Works with zero native-push setup, shows on next open. Decide A (FCM
> push) vs B (inbox) when the reminder is wired.

---

## 4. Play Console product IDs — real values the app must use

These are the **actual product/plan IDs configured in Google Play Console**
(verified by playboldstudio). The app must launch purchases with **these exact
strings**; the backend maps them to its internal ids (see §4b) so entitlement +
wallet math works.

| Kind | Play Console ID (send this) | Backend internal id |
|---|---|---|
| Subscription — Pro monthly | `playbold-promptly-pro-monthly` | `pro` |
| Subscription — Pro yearly | `playbold-promptly-pro-yearly` | `pro_annual` |
| Subscription — Creator monthly | `playbold-promptly-creator-monthly` | `creator` |
| Subscription — Creator yearly | `playbold-promptly-creator-yearly` | `creator_annual` |
| One-time — Remove Ads (lifetime, ₹149) | `playbold.promptly.ad` | `ad_free` |
| One-time — Deposit Pack S (₹10) | `playbold.promptly.deposit_s` | `deposit_s` |
| One-time — Deposit Pack M (₹100) | `playbold.promptly.deposit_m` | `deposit_m` |
| One-time — Deposit Pack L (₹500) | `playbold.promptly.deposit_l` | `deposit_l` |
| One-time — Deposit Pack XL (₹1000) | `playbold.promptly.deposit_xl` | `deposit_xl` |

**Package name (env):** `PLAY_BILLING_PACKAGE_NAME=com.playboldstudio.promptlyai`.

> **Works without any env per-product config.** The mapping lives in code
> (`src/services/payments/playConsoleIds.js`): the app sends the Play Console id,
> the verify route translates it, Google verify/acknowledge calls use the **real
> console id**, and internal storage/ledger keep the short id. Nothing about these
> ids goes in `.env` — they don't vary by environment (dev + prod share the same
> package).

**Paid-prompt unlocks (`prompt_<id>`):** single-prompt purchases use a **dynamic**
`productId` = `prompt_<promptId>` (e.g. `prompt_9f3c2a`). This is not a fixed
Play Console SKU; create a **one-time product per paid prompt** in Play Console
with that id string, and have the app send it. (Not in the list above because it's
per-content, not static.)

**RTDN Pub/Sub** (optional, for real-time revocations) → push to
`POST /webhooks/google/rtdn`, subscription id in `RTDN_SUBSCRIPTION`. Not
required to start — revocations can also be handled via `POST /payments/playbilling/void`.

### 4b. Play Billing endpoints — request/response (the app calls these)

All require the Firebase ID token (Bearer). All under `{base}/payments`.

| Endpoint | Body | Response | Notes |
|---|---|---|---|
| `POST /playbilling/verify` | `{ productId, purchaseToken, isSubscription?:bool }` — **productId = the Play Console ID from §4** | Subscription: `{ verified:true, subscription:{ planId, planName, priceInr, billingCycle, perks, subscriptionId, currentPeriodEnd } }`. One-time (ad-free/deposit): `{ verified:true, productId, priceInr, gatewayFeeInr, netDeposit?, adFree? }` | Dispatches by productId; grants entitlement + wallet credit atomically. Send the **real** console id — the backend maps it (§4 table). |
| `POST /playbilling/void` | `{ productId, purchaseToken, isSubscription?:bool, reason? }` | `{ success:true, type, … }` | Void/refund. For subscriptions `isSubscription:true`. |
| `DELETE /subscriptions` | — | `{ success, subscriptionId, planId, note }` | Marks local sub cancelled (user still cancels in Play Store). |
| `GET /wallet` | — | `{ balances:{ earnings, deposits, bonus }, bonusVintages, … }` | Multi-balance wallet breakdown. |
| `GET /wallet/allocate?itemPriceInr=99` | — | `{ split:[{balanceType,amountToUse}], totalCovered, remaining, wallet }` | Read-only preview of the payment split before a real purchase. |
| `POST /wallet/spend` | `{ itemPriceInr, refId, note? }` | `{ success, totalCovered, remaining, wallet, split }` | Debit wallet as partial payment; `refId` idempotency. |
| `GET /payouts/eligibility` | — | `{ withdrawableBalance, minWithdrawalInr, eligible, blockers }` | Creator withdrawal rules. |
| `POST /payouts` | `{ amountInr }` | payout + balance | Request a withdrawal (min ₹60). |

The above is the full payment surface on the playbilling branch. The app sends
the callback token + product id from Play Billing; the backend verifies with
Google (using `PLAY_BILLING_PACKAGE_NAME` + the real console id), grants the
entitlement, and credits the wallet.

---

## 5. Enterprise / future — nothing needed yet

Nothing else. Keep this file updated as new app-side data requirements appear.

---

## 6. Bonus-expiry inbox (Phase 2, built) — app-side TODO (optional)

The bonus-expiry reminder (wallet.md §5.4) is delivered as an **in-app inbox** —
zero native-push setup. The backend writes a `notifications` row when a bonus
vintage is within 7 days of expiry; the app **polls at launch** (and can poll on
foreground) instead of registering FCM tokens. This is the plan-sanctioned
alternative to §3's push route and works with no app change at all.

| Endpoint | Shape | Notes |
|---|---|---|
| `GET /me/notifications?unreadOnly=true&limit=&offset=` | 🔐 auth | Newest-first inbox. `rows: [{ id, userId, type, title, body, refId, data, status:'unread'\|'read', createdAt, updatedAt }]`, `total` |
| `POST /me/notifications/read` | 🔐 auth, `{ ids: string[] }` | Mark mine as read. Only the caller's own rows are touched. Returns `{ updated }` |

The daily sweep (`npm run wallet:expire`) fills the inboxes. **App-side:** call
`GET /me/notifications?unreadOnly=true` at launch; show unread count as a badge
and the list in a notifications screen; call `POST /me/notifications/read` when
the user opens one. Nothing blocks if the app ignores it — inboxes just build up
until the vintages expire.