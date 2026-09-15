# Payment API Audit & Production‑Readiness Report

> **Audit type:** Static code review (no changes made)
> **Date:** 2026-09-15
> **Scope:** `POST /payments/playbilling/verify` 400 error on top-up · full endpoint audit · route simplification / scalability / API response-time for app UX.

---

## 1. Why `POST /payments/playbilling/verify` returns 400 on top-up

### 1.1 Request path trace

```
App → POST /payments/playbilling/verify { productId: "playbold.promptly.deposit_m", purchaseToken }
  │ routes/payments.js:65   (requireAuth → moneyLimiter → verify handler)
  │ routes/payments.js:71   internalProductId("playbold.promptly.deposit_m") → "deposit_m"
  │ routes/payments.js:99   isDepositProduct("deposit_m") ✓
  │ services/.../playBilling.service.js:272  handleDepositTopUp(...)
  │ services/.../playBilling.service.js:279  playConsoleProductId("deposit_m") → "playbold.promptly.deposit_m"
  │ services/.../playBilling.service.js:283  safeVerify(() => verifyOneTimePurchase(...))
  │ lib/playBilling.js:31-35  purchases.products.get({ packageName: env.PLAY_BILLING_PACKAGE_NAME /* "" */, ... })
  │ ★ Google API rejects empty packageName → HTTP 400 "packageName must not be empty"
  │ lib/playBilling.js:75-79  safeVerify maps 400/403/404 → { error: { status: 400, message: "Purchase not verified — the token may be invalid or expired. Please try again." }}
  ▼ response 400
```

### 1.2 ROOT CAUSE — `PLAY_BILLING_PACKAGE_NAME` is unset

| Location | Value |
|---|---|
| `.env:6` | `# PLAY_BILLING_PACKAGE_NAME=com.promptlyai.app` (commented out) |
| `src/config/env.js:19` | `PLAY_BILLING_PACKAGE_NAME: z.string().optional().default('')` → defaults to **empty string** |
| `src/lib/playBilling.js:32,48` | Sent verbatim to Google as `packageName: ""` |

Because the env var is empty, **every** `verifyOneTimePurchase` / `verifySubscription` call sends `packageName: ""` to the androidpublisher API → Google returns 400 → `safeVerify` normalizes it to a clean 400 `"Purchase not verified — the token may be invalid or expired."`. This is a **config problem, not a real purchase problem** — the purchase token may be perfectly valid.

**Fix (config/data only, no code):** set the real package name, exactly as produced by `playboldstudio`:
```
PLAY_BILLING_PACKAGE_NAME=com.playboldstudio.promptlyai
```

**⚠ Package-name discrepancy found across the repo** — only one of these matches the real package:

| Source | Value |
|---|---|
| `APP_INTEGRATION.md:107` (authored by playboldstudio) | `com.playboldstudio.promptlyai` ✅ **real** |
| `.env.example:27` | `com.promptlyai.app` ❌ |
| `plans/play-billing.md:35` | `com.promptlyai.app` ❌ |
| `plans/reference.md:222` | `com.promptlyai.app` ❌ |

If you set the wrong one, `packageName` won't match the app's package and Google will return `packageNotFound` → again surfacing as 400.

### 1.3 Secondary causes on the same endpoint (once package name is fixed)

1. **Consumables are never consumed (deposit top-up).**
   `deposit_*` products are `type: 'consumable'` (`products.js:24-48`). In Play Billing, a consumable **must** be consumed (`purchases.products.consume`) after acknowledgement, or the user gets `ITEM_ALREADY_OWNED` on the **next** purchase of the same SKU. The codebase has **no consume call anywhere** (grep `consume|consumptionState` → only bonus-vintage code). Effect: second top-up of the same pack fails.

2. **Purchase-row ID collision breaks repeat top-ups & refunds.**
   `handleDepositTopUp` writes the purchase row at `purchaseRowId = `${userId}_${productId}`` (`playBilling.service.js:294`) with `inTxSet` (merge/overwrite). Buying `deposit_m` twice **overwrites** the same doc:
   - Top-up history (`me.service.js:139-168`) shows only the latest purchase.
   - `voidDeposit` (`void.service.js:175-182`) matches `grant.gatewayOrderToken === purchaseToken`; after a second purchase overwrites the row, refunding the **first** token → `409 Purchase token mismatch` → refund impossible.
   - The bonus vintage uses the same id (`wallet.service.js:332` `creditId = String(refId)` = `userId_productId`) → two deposits pool into one vintage; refunding one removes the whole vintage.

3. **`hasPlayBilling` is exported but never used.** (`env.js:73`, exported; the verify route at `payments.js:65` doesn't guard on it). With an empty package name the route still calls Google instead of returning a clear configuration error.

4. **Product-id sent by the app must be the real Play Console id.** Accepted id forms:
   - OK: app sends `playbold.promptly.deposit_s` (mapped by `internalProductId`).
   - OK: app sends `deposit_s` (passthrough).
   - FAIL: anything not in `playConsoleIds.js` and not `prompt_*`/`ad_free`/`deposit_*` → `400 Unknown product` (`payments.js:105`).
   For subscriptions the app **must** send `isSubscription: true` **and** the console id; otherwise the id `pro` is treated as a one-time and hits the same missing-package-name path.

5. **`safeVerify` masks genuine authz/permission errors as 400** — a 403 (service account missing `androidpublisher` permission) silently becomes "token invalid". Wrong creds are a **500/403 ops issue** but present as 400 to the client. (See §3.2.)

### 1.4 Most likely real-world sequence

| # | Event | Result |
|---|---|---|
| 1 | Dev `.env` has package-name commented | First `verify` → 400 (Google: empty packageName) |
| 2 | Package name set but **wrong** (`com.promptlyai.app`) | 400 `packageNotFound` |
| 3 | Package name correct; first `deposit_m` purchase | Works — token verified, wallet credited, acknowledged |
| 4 | Second `deposit_m` purchase | **Fails** — consumable not consumed → `ITEM_ALREADY_OWNED` → 400 |
| 5 | Refund of the first deposit | **Fails** — row overwritten → 409 token mismatch |

---

## 2. Full endpoint audit

### 2.1 Inventory (all routes, from `src/app.js` mounting)

| # | Method | Path | Auth | Status / Notes |
|---|---|---|---|---|
| 1 | GET | `/health` | – | OK — pingDb 2.5s timeout |
| 2 | POST | `/auth/login` | – | OK — zod; also processes referral code |
| 3 | POST | `/auth/dev/login` | – | Dev-only (404 in prod) |
| 4 | POST | `/prompts` | req | OK — zod; raw image alt + multer variants |
| 5 | POST | `/prompts/image` | req | OK (raw image body) |
| 6 | GET | `/prompts` | opt | **SLOW RISK** — list can fan out (see §4.3) |
| 7 | GET | `/prompts/:id` | opt | OK |
| 8 | GET | `/prompts/:id/image` | opt | OK — watermarked, cached in GCS |
| 9 | DELETE | `/prompts/:id` | req | OK |
| 10 | POST | `/prompts/:id/save` | req | OK |
| 11 | POST | `/prompts/:id/unsave` | req | OK |
| 12 | POST | `/prompts/:id/report` | req+RL | OK |
| 13 | POST | `/prompts/:id/appeal` | req | OK |
| 14 | POST | `/prompts/:id/like` | req | OK |
| 15 | POST | `/prompts/:id/share` | req | OK |
| 16 | GET | `/me/profile` | req | OK |
| 17 | PATCH | `/me/profile` | req | OK |
| 18 | GET | `/me/prompts` | req | OK |
| 19 | GET | `/me/saved` | req | OK |
| 20 | GET | `/me/transactions` | req | OK |
| 21 | GET | `/me/notifications` | req | OK |
| 22 | POST | `/me/notifications/read` | req | OK |
| 23 | GET | `/me/purchases` | req | OK |
| 24 | GET | `/me/topups` | req | OK — **but see purchase-row collision (§1.3)** |
| 25 | GET | `/me/earnings` | req | OK |
| 26 | GET | `/me/earnings/prompts` | req | OK |
| 27 | POST | `/me/upi` | req | OK |
| 28 | POST | `/me/bank` | req | OK |
| 29 | POST | `/me/bank/pan-image` | req | OK |
| 30 | POST | `/me/bank/account-image` | req | OK |
| 31 | DELETE | `/me/bank` | req | OK |
| 32 | POST | `/me/avatar` | req | OK |
| 33 | DELETE | `/me/account` | req | OK |
| 34 | POST | `/payments/playbilling/verify` | req+RL | **FAILS — §1** |
| 35 | POST | `/payments/playbilling/void` | req+RL | **FRAGILE** — refund of overwritten deposit row impossible (§1.3) |
| 36 | DELETE | `/payments/subscriptions` | req+RL | OK |
| 37 | GET | `/payments/wallet` | req | OK |
| 38 | GET | `/payments/wallet/allocate` | req | OK |
| 39 | POST | `/payments/wallet/spend` | req+RL | OK — **redundant `requireAuth`** (§3.5) |
| 40 | POST | `/payments/wallet/buy` | req+RL | OK — **redundant `requireAuth`** (§3.5) |
| 41 | GET | `/payments/payouts/eligibility` | req | OK |
| 42 | GET | `/payments/payouts` | req | OK |
| 43 | POST | `/payments/payouts` | req+RL | OK |
| 44 | GET | `/payments/admin/payouts` | admin | OK |
| 45 | POST | `/payments/admin/payouts/:id/mark-paid` | admin+RL | OK |
| 46 | POST | `/payments/admin/payouts/:id/mark-failed` | admin+RL | OK |
| 47 | PATCH | `/payments/admin/wallets/:id` | admin+RL | OK |
| 48 | POST | `/referrals/code` | req | OK |
| 49 | GET | `/referrals/code` | req | OK |
| 50 | GET | `/referrals/:code/validate` | – | OK |
| 51 | POST | `/referrals/apply` | req | OK (oAuth gate) |
| 52 | GET | `/referrals/stats` | req | OK |
| 53 | GET | `/referrals/list` | req | OK |
| 54 | POST | `/admin/prompts/bulk-upload/validate` | admin | OK |
| 55 | POST | `/admin/prompts/bulk-upload` | admin | OK |
| 56 | GET | `/admin/prompts/reports` | admin | OK |
| 57 | POST | `/admin/prompts/:id/approve` | admin | OK |
| 58 | POST | `/admin/prompts/:id/reject` | admin | OK |
| 59 | POST | `/admin/prompts/:id/dismiss-report` | admin | OK |
| 60 | POST | `/webhooks/google/rtdn` | pub/sub | OK — but `RTDN_SUBSCRIPTION` also commented in `.env` |

Only the **Play Billing verify** endpoint is known-failing. The deposit **void** path is broken-by-design after a repeat purchase (§1.3). Everything else is structurally OK but has production gaps (see §3–§4).

### 2.2 Common quirks found across routes

- **Every handler repeats the same boilerplate:** `try { parse } catch → next(err)`. ~40 near-identical blocks. (see §3.3 for the wrapper that removes this.)
- **Error responses are inconsistent in shape/semantics:** some 400s return `{ error: { message, code: "BAD_REQUEST" } }`, service-level errors return `result.error { status, message }`, and 409/402/403 sometimes leak raw `err.message` instead of a stable body.
- **Schema errors collapse to a single generic message** (`"Missing purchase details"`) — never surfaces which field failed → bad app-side UX & debugging. Zod gives you `parsed.error.issues` — use them (`payments.js:68` discards them).

---

## 3. Route simplification & readability (how to make it maintainable)

### 3.1 The core problem
`routes/payments.js` grew to 377 lines mixing:
- validation schemas (inline),
- dispatch logic (verify → subscription / prompt / ad-free / deposit),
- feature handlers,
- admin gates.

The verify route alone is a **manual dispatch chain** (`payments.js:74-105`): `if (isSubscription) … if (prompt_) … if (adFree) … if (deposit) … else 400`. New product types mean touching the route again.

### 3.2 Recommended target structure (no code changed — proposal only)

```
src/routes/
  payments/
    index.js          → new Router(), mounts sub-routers (auth + limiter applied once)
    verify.js         → POST /playbilling/verify   (thin: schema → service dispatch)
    void.js           → POST /playbilling/void
    subscriptions.js  → DELETE /subscriptions
    wallet.js         → wallet, allocate, spend, buy
    payouts.js        → eligibility, payouts, mark-paid, mark-failed
    admin.js          → admin wallet adjust
```

Rules that make it consistent & readable:

1. **One `asyncHandler` + one `validate` middleware pair.** Replace
   ```js
   router.post('/x', async (req,res,next) => { try { const p = schema.safeParse(req.body); if(!p.success) return next(httpError(400,msg)); ... } catch(e){ next(e) } })
   ```
   with
   ```js
   router.post('/x', validate(schema), asyncHandler(async (req,res) => { ... }))
   ```
   Put a **stable 400 body** in `validate` that uses zod's `issues` (returns `{ field, message }[]` instead of a single blanket message).

2. **Replace the manual dispatch chain with a dispatch table (registry pattern).**
   ```js
   const HANDLERS = {
     // keyed by productId predicate → service fn, single source of truth
     (id) => PRODUCT_TO_PLAN[id]            : activateSubscription,
     'ad_free'                              : grantAdFree,
     (id) => isDepositProduct(id)           : handleDepositTopUp,
     (id) => id?.startsWith('prompt_')      : grantPromptUnlock,
   };
   ```
   Route becomes ~10 lines; adding a product = adding one entry.

3. **Keep routes thin.** Move all money math / dispatch / entity joins into services (already mostly done). Routes should only: validate → authorize → call one service → respond.

4. **Single error contract.** One error shape everywhere: `{ error: { code, message, details? } }`. Let `errorHandler` be the only place that shapes responses; routes stop building ad-hoc `next(httpError(...))`.

5. **Name helpers by intent** (already mostly true): `err(400, …)` → rename to `clientError` / `notFound` / `conflict` for legibility.

6. **Root-mount everything explicitly** in `app.js` (e.g. `app.use('/payments', paymentsRouter)`) — already done; keep routers self-contained so any can be moved independently.

### 3.3 What NOT to over-engineer
- Don't introduce classes/MVC layers — the service modules are adequate; the win is **removing duplication in routes**, not adding abstraction.
- Don't split every route into a file for the sake of it — split by **feature area** (verify/void/sub, wallet, payouts, admin), not per endpoint.

---

## 4. Scalability — what breaks when this grows / runs on many instances

### 4.1 Rate limiting is in-memory
`rateLimit.js` uses a module-level `Map`. On Cloud Run each instance has its **own** limiter, so:
- Limits don't apply across instances (a client can hit N instances × 60/min).
- Restart clears all buckets.
- **Fix options:** distribute with Firestore (native, already in-stack) or a small Redis; or move throttling to Cloud Armor / API Gateway. Simplest path: Firestore-backed fixed-window counter keyed by `userId+route`.

### 4.2 Firebase ID-token verification runs on every request
`requireAuth` → `firebaseAuth.verifyIdToken(token, true)` → a network call to Google per request (the `true` = `checkRevoked`, which forces revocation-state fetch — slow). For a chatty mobile app this is the biggest per-request latency tax.
- **Fix options:** verify once per signed-in session and cache result (TTL ~5-15 min, keyed by token hash) while still validating JWT signature locally; or verify on `/auth/login` and issue your own short-lived opaque session token. Signatures of _new_ JWTs can also be validated with the public keys cached from Google's JWKS (firebase-admin does this; the cost is mainly the revocation network call).

### 4.3 Firestore query fan-out on hot lists
`GET /prompts` and `GET /me/*` list endpoints do server-side `offset` (skipping) and unbounded reads (default `limit=50`), and map entities client-side in routes/services. Under scale:
- Switch to **cursor-based pagination** (`startAfter`) instead of `offset`.
- Add **projections** (`fieldMask` / `.select(...)`) so paywalled prompt list items don't ship huge image/desc bytes.
- Ensure required composite indexes are actually deployed (`firestore.indexes.json` — a missing composite index surfaces as a **500**, not 400). Verify `subscription_plans` seed isn't relied on at query time.

### 4.4 No response compression
`package.json` has no compression middleware. JSON payloads across `/me/*` and `/prompts` lists compress ~6-8× with gzip/br. This is a free, big UX win.

### 4.5 Firestore transaction limits
`playBilling.service.js`, `wallet.service.js` run multi-doc transactions (Firestore caps ~500 writes / op). Current transactions are small — fine — but the **verify flow does its heavy lifting inside a transaction with a Google API call made *before* the transaction**. Do **not** move the Google call inside the transaction (network in-txn keeps the transaction open too long → high contention + retries).

### 4.6 Play Billing verify latency = UX blocker (see §5)

---

## 5. Response-time & app UX improvements (quick responses)

### 5.1 Why the verify call feels slow
`POST /payments/playbilling/verify` is **synchronous**: it calls Google (150-600 ms) *then* runs a Firestore transaction (100-300 ms) *then* acknowledges (another Google call, fire-and-forget). Total typically **500 ms - 1.5 s** — acceptable for a checkout, but avoidable for every other screen.

### 5.2 Concrete wins (roughly ordered by effort → value)

| # | Change | Effect | Where |
|---|---|---|---|
| 1 | Add `compression` middleware | ~6-8× smaller JSON → faster TTFB on mobile | `app.js`, global |
| 2 | Cache verified auth tokens (§4.2) | Cuts ~150-400 ms off every authed call | `middleware/auth.js` |
| 3 | Cache the static product/plan catalog | Avoids re-parse + DB lookup on verify path | `products.js`/`plans.js` |
| 4 | Fetch prompt+author with a projection on lists | Smaller, faster list payloads | `routes/me.js`, `prompts.js` |
| 5 | Add `Cache-Control` / ETag on GET-only, `private` endpoints | Client caches profile/wallet/notifications between refreshes | route layer |
| 6 | Cursor pagination instead of `offset` (§4.3) | Stable under large result sets | `utils/paging.js` |
| 7 | Debounce / background RTDN confirmations | Delivers "pending" UI immediately, confirms entitlement via `POST /webhooks/google/rtdn` when available | `payments` + `rtdn.js` |
| 8 | Return **structured field-level 400 details** instead of a blanket message | App shows exactly which field/token is invalid instead of a generic toast | all zod routes |

### 5.3 For the app-side UX specifically

- **Top-up flow:** verify must return quickly and deterministically. The user-facing error on a 400 is currently *"Purchase not verified — the token may be invalid or expired…"* even when the real cause is **server config**. Fix the config (§1.2) first, then granular codes (`TOKEN_INVALID`, `ITEM_ALREADY_OWNED`, `PURCHASE_PENDING`, `NOT_A_DEPOSIT`) so the app can show the right message.
- **Wallet/topup history:** after fix §1.3, `GET /me/topups` should return one row **per purchase**, not per (user, pack) — otherwise the app under-reports history.
- **Latency budget:** keep interactive GETs (feed, profile, wallet) < 300 ms; keep the Play verify call on its own path with loading state and **idempotency** (client can safely retry — server already re-checks the token).

---

## 6. Production-readiness checklist (blocking vs recommended)

| Priority | Item | Status |
|---|---|---|
| **BLOCKER** | Set `PLAY_BILLING_PACKAGE_NAME=com.playboldstudio.promptlyai` in dev + prod env | ❌ now empty |
| **BLOCKER** | Add `consume` call for consumable deposit SKUs after acknowledge | ❌ missing |
| **BLOCKER** | Change deposit purchase-row id so repeat top-ups don't overwrite (e.g. id = `purchaseToken`, or add collection per purchase) + keep `userId_productId` index for lookup | ❌ collides |
| **BLOCKER** | Guard verify route with `hasPlayBilling` and return a clear 503/config error, not 400 | ❌ unused |
| HIGH | Used package name mismatch in `.env.example` / plans vs `APP_INTEGRATION.md` | ❌ conflicts |
| HIGH | `requireAuth` applied twice on `wallet/spend` + `wallet/buy` (`payments.js:201,247` after `router.use` at `:32`) | duplicate work |
| HIGH | Consistent error body + field-level validation details | partial |
| HIGH | Verify with RTDN (real-time revocations) — `.env` RTDN vars commented | ❌ deferred by design |
| MEDIUM | Distributed rate limit (Firestore/Redis) | ❌ in-memory |
| MEDIUM | Auth token verification caching | ❌ every request |
| MEDIUM | Compression middleware | ❌ absent |
| MEDIUM | Cursor pagination + projections on list endpoints | ❌ offset |
| LOW | Async `asyncHandler`/`validate` helpers to cut route boilerplate | ❌ none |
| LOW | Rename `err()` → `clientError()` etc. in services | style |

---

## 7. Summary

1. **The 400 on top-up is a configuration bug:** `PLAY_BILLING_PACKAGE_NAME` is empty in `.env`, so every verify call sends `packageName: ""` to Google and `safeVerify` turns Google's 400 into your 400. Fix the env var (to the correct value `com.playboldstudio.promptlyai`) and the endpoint starts working.
2. **After the config fix, two money-integrity bugs surface for top-ups:** consumables are never consumed (2nd purchase fails) and the deterministic purchase-row id overwrites prior purchases (history wrong + refunds blocked).
3. **The codebase is well-layered (route → service → data).** The route-simplification win is **removing ~40 copies of the same boilerplate** with `validate`/`asyncHandler` helpers, and replacing the manual dispatch chain in `/playbilling/verify` with a dispatch table. No new frameworks needed.
4. **Scale/UX priorities:** distributed rate limiting, auth-verification caching, compression, cursor pagination, and stable, structured error codes — in that order.

---

## 8. Additional API routes needed (gap analysis)

Gaps found against the existing 60-route inventory. Split into **app-facing** (blocks/improves UX) and **admin/ops** (support + integration tooling). The roadmap items from `plans/reference.md §6` (promo codes, bundles, etc.) are noted as *future*, not needed to ship.

### 8.1 App-facing (priority to add)

| # | Route | Why it's needed | Precedent / evidence |
|---|---|---|---|
| 1 | `GET /me/bank` 🔐 | Display saved bank-transfer details for the withdrawal screen. Today only `POST /me/bank` + `DELETE /me/bank` exist (`me.js:176,191`); `payouts/eligibility` returns only `hasBankDetails: boolean` (`payouts.service.js:90`), not the saved PAN/account/IFSC. The UI can't show "withdraw to ••••1234". | `routes/me.js` — no GET |
| 2 | `GET /payments/catalog` (public or authed) | Expose deposit packs + plans + ad-free pricing so the backend is the single source of truth. Prices currently live only in `products.js` / `plans.js` — the app must hardcode or re-ship for every price change (a Play Console price edit goes stale in the old app). Serves the deposit top-up and subscribe screens. | `products.js:13-49`, `plans.js:12-68` — no endpoint reads them |
| 3 | `POST /me/device-token` 🔐 `{ token, platform? ('android'), appVersion? }` | FCM push registration for the bonus-expiry reminder (Phase 2). Marked **◐ "backend will store; no endpoint yet"** in `APP_INTEGRATION.md §3`. Today reminders ship via in-app inbox only. | `APP_INTEGRATION.md:73-78` |
| 4 | `DELETE /me/device-token` 🔐 | Logout / token-rotation cleanup — otherwise stale tokens get FCM push errors. | pairs with #3 |
| 5 | `GET /me/subscription` 🔐 *(optional)* | A lean subscription-status endpoint (plan, expiry, perks, adFree-from-perk). Yes, `GET /me/profile` already returns `subscription` (`me.service.js:15-29`), but a dedicated endpoint keeps the profile payload small and gives a stable contract for the "billing/membership" screen. | `me.service.js:15-29` |

> **Not needed:** a per-prompt price endpoint (prompt detail already returns `priceInr`); a `consume`-purchase route (consumption belongs inside the verify transaction after ack — internal, not public).

### 8.2 Admin / ops (needed for production support)

| # | Route | Why it's needed |
|---|---|---|
| 6 | `GET /payments/admin/purchases?userId=&status=&limit=` 🔒 | Support/refund disputes need any user's purchase history incl. `voided` rows. Today there's no cross-user purchase view (users can only see their own via `/me/purchases`, `/me/topups`). |
| 7 | `GET /payments/admin/transactions?userId=&type=` 🔒 | Any user's full ledger for refund/fraud investigation. `GET /me/transactions` is self-only (`me.service.js:170-183`). |
| 8 | `POST /payments/admin/reconcile` 🔒 | Run the reconciliation (`npm run reconcile`) on demand from the console, and surface the last-run report. |
| 9 | `POST /webhooks/google/rtdn/test` 🔒 (dev-only guard) | Simulate `SUBSCRIPTION_RENEWED/CANCELED/EXPIRED` locally so `rtdn.js` + `handleRTDNSubscription` can be tested before live RTDN wiring (currently the `.env` RTDN vars are commented out). |

### 8.3 Recommended when these two fixes land (§1.3)

| Route | Reason |
|---|---|
| Deposit purchases as one-row-per-purchase (id = purchase token) | Then `GET /me/topups` (and #6) automatically list every top-up instead of the latest per pack. |

### 8.4 Future (roadmap — do NOT build now)

From `plans/reference.md §6`: promo-code/voucher redemption (`POST /admin/promo`, `POST /me/redeem`), daily-login streaks, prompt bundles, rating contracts. All credit the existing `bonus` balance — no schema change needed when they ship.

---

## 9. Code update & production-readiness recommendations

Audited against `package.json`, `Dockerfile`, `.gitignore`, `.dockerignore`, `src/app.js`, `src/server.js`, route/middleware layer. Grouped so you can tackle them in order: **resolve blockers first, then run/cost, then observability/CI**.

### 9.1 Dependency updates

| Package | Current | Recommended action | Why |
|---|---|---|---|
| `express` | `^4.21.2` | Evaluate **Express 5.x** (stable). If adopted: router wildcards move to `path-to-regexp` v8 (`'*'` → `'/*splat'`), `req.query` is a getter, async handlers auto-forward errors, `app.del` removed. Your routes use no `'*'` patterns except `notFound` middleware — low-risk migration. | 4.x only gets security patches; 5.x is the supported line with better async-await error handling (removes most `try/catch` boilerplate). |
| `firebase-admin` | `^13.0.1` | `npm update` to latest 13.x; evaluate v14 when published/LTS. | Security + feature patches; v14 is a major (Firestore/RC changes) — don't rush. |
| `googleapis` | `^146.0.0` | `npm update` (minor). | androidpublisher v3 surface is stable; get patches. |
| `zod` | `^3.24.1` | **Stay on 3.x for now.** If upgrading to v4, budget time — `.optional()` semantics, error `issues` shape, and some enum APIs changed; the audit doc assumes v3 `issues`. | v4 is a big migration; no current need. |
| `multer` | `^2.2.0` | Keep 2.x (do **not** drop below). | 2.x fixes CVE-2025-30065 (defined-path traversal in multer <2.0.0). |
| `adm-zip` | `^0.6.0` | Keep 0.6.x; consider `yauzl`/`yazl` when refactoring bulk import. | 0.6.x backports path-traversal fixes; library is otherwise old. |
| `dotenv` | `^16.4.5` | `npm update` (minor). Version 17 may be current. | Patches only. |
| `sharp` | `^0.35.3` | `npm update` within major. | Prebuilds + perf patches. |
| `helmet`, `cors`, `morgan`, `@google-cloud/vision` | as-listed | `npm update` within major. | Patches. |

**Discipline (add to CI):** run `npm audit` + `npm outdated` in a weekly job; pin with `package-lock.json` (already committed); never `npm install` ad-hoc on deploy.

### 9.2 Runtime / Docker

| Item | Current | Recommendation |
|---|---|---|
| Base image | `node:20-slim` (`Dockerfile:7,15`) | Move to **`node:22-slim`** (current LTS, in maintenance until 2027) and bump `engines` in `package.json`. Node 20 hits end-of-life → no security backports. Moving to **Node 24 LTS** is also reasonable (2026 LTS). |
| Non-root user | `USER nodeuser` ✅ | Keep. |
| HEALTHCHECK | `node -e fetch('/health')` ✅ | Keep; add a `/readyz` that also pings Firestore for Cloud Run startup probes (see 9.4). |
| Memory | not pinned | Set Cloud Run `--memory=512Mi` (sharp/vision use buffers); bump only if moderation image jobs peak. |
| Image layer | `COPY . .` | `.dockerignore` already excludes keys/tests — keep it lean. |

### 9.3 Security & secrets

| # | Finding | Where | Recommendation |
|---|---|---|---|
| 1 | `firebase-sa-key.json` exists locally but is **gitignored** (safe) and **excluded** from the image (`.dockerignore`) ✅ | `.gitignore:14,24` | Verify it is **not** in the git history (`git log --all -- firebase-sa-key.json`); if it ever was, rotate the key in GCP. In production prefer **Secret Manager + `firebase-admin` env vars** (`FIREBASE_PRIVATE_KEY`) or Workload Identity — not a mounted key file. |
| 2 | `.env` contains a **stale Postgres `DATABASE_URL`** with live credentials (`postgresql://neondb_owner:...`) that nothing in the codebase uses | `.env:1`, package.json has no pg driver | **Remove it.** Dead secrets invite misuse and rot. |
| 3 | `app.set('trust proxy', true)` trusts **all** proxies | `src/app.js:24` | Tighten to `app.set('trust proxy', 1)` (trust exactly one hop — Google front end on Cloud Run). With `true`, `req.ip`/rate-limit keys are spoofable if the service is ever reachable without the LB; with `1` the XFF the client sends is ignored because the front end overwrites it. |
| 4 | Dev backdoor gating | `auth.js:90` (404 on production), `DEV_AUTH_PASSWORD` warning at `server.js:11-13` ✅ | Keep. Add a **CI guard** that fails a deploy if `DEV_AUTH_PASSWORD` is present in the prod env set. |
| 5 | Admin gate | `isAdminEmail()` from `ADMIN_EMAILS` ✅ | Keep; derive from a stable source-of-truth (firestore admin doc) when the team grows. |
| 6 | `express.json({ limit: '1mb' })` | `app.js:46` | Fine for JSON. Raw image routes already use their own `raw({ limit: '3mb' })` (`prompts.js:84`) — do not let `express.json` swallow binary via mismatched content-type. |
| 7 | CORS | dev `allowAll || origins` ✅ | Keep locked in prod. Ensure `allowedOrigins()` includes the app's real device/web origin, not just localhost. |

### 9.4 Reliability

| # | Finding | Recommendation |
|---|---|---|
| 1 | `acknowledgePurchase(...).catch(() => {})` swallows ack failures (**money leak**: a failed ack → Google auto-refunds the user in 3 days while entitlement/wallet already granted) — `playBilling.service.js:164,251,341`, `subscriptions.service.js:96` | Don't swallow. Add **retry with exponential backoff**; if it still fails, persist an `AckPending` flag + background job (or Cloud Tasks) to re-ack. Do **not** do the retry inside the Firestore transaction. |
| 2 | Purchases verified synchronously w/ Google before granting | ✅ Correct and required — but see §5 for latency; keep Google call *outside* the transaction. |
| 3 | Rate limiter is per-instance (`rateLimit.js` Map) | Move to a distributed store (Firestore counter / Redis) so limits hold across Cloud Run instances & restarts. |
| 4 | Idempotency | verify/void/spend already keyed by token/refId ✅. After fixing the deposit-row collision (§1.3) keep **one row per purchase** (id = `purchaseToken`) and index by `(buyerId, productId)`. |
| 5 | Firestore transaction reuse | Transactions are small ✅. Never place network calls inside `runTransaction`. |
| 6 | `pingDb` / startup | `server.js:28-30` boot check is **non-fatal** ✅. Add `/readyz` (Firestore ping + `hasPlayBilling` flag) and wire it to Cloud Run startup/readiness probes so traffic doesn't hit during DB/gateway misconfig. |
| 7 | Unhandled rejection/exception → `process.exit(1)` | ✅ Correct (Cloud Run restarts the instance). Keep. |
| 8 | Graceful shutdown (SIGTERM close + 10s force) | ✅ `server.js:32-41`. Keep. |

### 9.5 Observability & latency

| Housekeeping | Recommendation |
|---|---|
| Request correlation | Add a `requestId` middleware (adopt `X-Cloud-Trace-Context` from Cloud Run) and echo it in error responses + logs so cross-instance debugging is possible. |
| Structured logging | Switch prod logs to **JSON** (morgan `json` format or `pino`) so Cloud Logging gets `severity`, `httpRequest`, and trace fields. Keep `console.error` for 5xx. |
| Compression | Add `compression` (gzip) — not present (§5.2). |
| HTTP caching headers | `Cache-Control` on `private` GETs (profile/wallet/catalog); images already immutable (`storage.service.js:57`). |
| Metrics | Expose minimal metrics (`/metrics` with prom-client, or use Cloud Run built-ins) for latency histogram + error rate on the money routes. |
| Sampling | Record request/response latency per route for `/payments/*` (money) — a budget-friendly way to spot slow-dependent calls (Google API). |

### 9.6 CI/CD & testing

| Gap | Recommendation |
|---|---|
| **No CI** — no `.github/workflows` | Add **GitHub Actions**: on PR → `npm ci` + `npm test` + `npm audit` + (optional) lint; on push to `main`/promote branch → `docker build` + `gcloud run deploy`. Tag deploys by commit so rollback is one command. |
| Tests are thin | Extend `node:test` coverage around the money modules: purchase dispatch (`verify`), deposit idempotency + repeat purchase, void/refund math, wallet FEFO. These are the highest-blast-radius paths. |
| Secrets in CI | Use GitHub Actions secrets / GCP Secret Manager for the service account; never a checked-in key. |

### 9.7 Go-live verification checklist (before promoting beyond dev)

```
[] PLAY_BILLING_PACKAGE_NAME=com.playboldstudio.promptlyai set everywhere; value matches app package
[] Consume deposit consumables after ack (else 2nd top-up fails)   ← §1.3
[] Deposit purchase rows keyed per-purchase (id = token)           ← §1.3
[] RTDN_SUBSCRIPTION configured + webhook verified (or revocations handled via /void)
[] /readyz returns healthy; startup probe attached
[] Secret Manager / env-based Firebase creds; no key file in image
[] Postgres DATABASE_URL removed
[] trust proxy tightened to 1
[] Ack retry/queue in place (no silent .catch)
[] npm audit clean on lock; Node 22-slim image
[] CI green (tests + audit); deploy tagged by commit
[] Smoke: deposit_s → verify → 200 → wallet shows ₹10 → repeat purchase → 200 → refund → void succeeds
```

### 9.8 Product design note (informs the code)

`prompt_<id>` purchases require **one Play Console product per paid prompt**, manually created (`APP_INTEGRATION.md:116-120`). That does not scale and blocks dynamic pricing. Preferred pattern for a marketplace this size: list **fixed, pre-created price-tier SKUs** (e.g. `prompt_unlock_49`, `prompt_unlock_99`, `prompt_unlock_199`) and pass the `promptId` in `developerPayload` / the verify body — the backend enforces that the tier price matches the prompt's `priceInr`. This removes the per-prompt Play Console chore and the collision risk entirely. The wallet `buy` path already uses `refId = prompt_<id>` so nothing breaks app-side if the product id is decoupled from the prompt id.