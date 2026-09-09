# Promptly AI — Backend

Backend for **Promptly AI**, an AI-prompt marketplace. **Node.js + Express + Firebase
Firestore + Firebase Auth** (plain JavaScript, ESM). Supports free/pro/creator
subscriptions, paid prompt unlocks, and creator payouts — all money routed through
**Google Play Billing**. Deploys to **Google Cloud Run**.

> The mobile/UI app is **UI-only today** (in-memory mocks). This backend is designed so
> the UI can swap its mock repository for this live API without visual changes.

## Stack

- **Node.js ≥ 20** + **Express 4** (ESM, no build step)
- **Firebase Firestore** (Native) as the datastore, via `firebase-admin`
- **Firebase Authentication** — the backend verifies client ID tokens (Admin SDK)
- **Google Play Billing** for in-app payments (purchases, subscriptions, RTDN webhooks)
- **Google Cloud Run** + **Docker** for deployment
- **zod** for env + input validation; `helmet`, `cors`, `morgan` middleware

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Create your environment file
copy .env.example .env     # Windows
# cp .env.example .env     # macOS/Linux

# 3. Set FIREBASE_PROJECT_ID (required) — the app connects to Firestore + Auth.
#    In local dev, either use Application Default Credentials
#    (gcloud auth application-default login) or set FIREBASE_CLIENT_EMAIL /
#    FIREBASE_PRIVATE_KEY from a service-account key. The emulator is also
#    supported via FIRESTORE_EMULATOR_HOST.

# 3b. (Payments) Set PLAY_BILLING_PACKAGE_NAME to your Android package name.
#    Play Billing verification uses the same Google creds as Firestore (ADC).
#    For subscription lifecycle events, set RTDN_SUBSCRIPTION and point the
#    Cloud Pub/Sub push subscription at POST /webhooks/google/rtdn.

# 4. Seed starter data into Firestore (plans, demo creator, sample prompts)
npm run db:seed

# 5. Start the dev server (auto-restarts on file changes)
npm run dev                # http://localhost:8080
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run with hot reload (`node --watch`) |
| `npm start` | Run without watch |
| `npm test` | Unit tests (Node's built-in `node:test` — no framework dep) |
| `npm run db:sync` | Verify Firestore connectivity (schema is implicit — no tables) |
| `npm run db:seed` | Seed starter data into Firestore (idempotent) |
| `npm run db:migrate-wallets` | One-time: migrate legacy `user_balances` → `user_wallets` (idempotent) |
| `npm run wallet:expire` | Daily: bonus vintage expiry sweep (or via Cloud Scheduler) |
| `npm run reconcile` | Monthly: Play Billing commission reconciliation (snapshot vs re-computed fee drift check) |
| `npm run db:reset` | **Destructive** — clear all Firestore collections, then seed (dev only; refuses in production) |

> Firestore is schemaless — collections are created on first write. Composite
> indexes are defined in `firestore.indexes.json` and client access is locked
> down by `firestore.rules` (deny-all). Apply both via
> `npx firebase deploy --only firestore`.

## Deploy on Google Cloud Run

This backend now runs on **Google Cloud Run** with **Firebase Firestore** as the
database and **Firebase Auth** for identity. The old Render/PostgreSQL setup is
gone (no `DATABASE_URL`; the app no longer depends on Postgres or Sequelize).

Full runbook (Firestore setup, secrets, indexes, deploy commands, webhook URL,
manual steps): see **`CLOUD_RUN_DEPLOYMENT.md`**.

Quick start:

```bash
gcloud config set project $PROJECT_ID
gcloud services enable firestore.googleapis.com firebaseauth.googleapis.com \
  run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# One-time: create Firestore composite indexes + apply security rules
npx firebase deploy --only firestore

# Seed the starter plans + demo prompts into Firestore (once)
npm run db:seed

# Deploy
gcloud run deploy promptly-ai-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production \
  --set-secrets FIREBASE_CLIENT_EMAIL=firebase-client-email:latest,FIREBASE_PRIVATE_KEY=firebase-private-key:latest
```

**After deploy:** set `PLAY_BILLING_PACKAGE_NAME` (and `RTDN_SUBSCRIPTION`) on the
service, then create a Cloud Pub/Sub **push** subscription for the Play Billing
RTDN topic pointing at `https://<cloud-run-url>/webhooks/google/rtdn`.

**Notes for Cloud Run**
- The server binds `0.0.0.0` on `PORT` (default 8080) — Cloud Run injects `PORT`.
- RTDN handlers are idempotent (a dedupe key in `webhook_events` makes
  duplicates no-ops) and always return 200 to avoid Pub/Sub retry storms.
- Play Billing verification uses the project's service account via ADC — no
  gateway keys to rotate.

## API surface (current)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | App status + Firestore ping |
| POST | `/auth/login` | – | **Firebase Auth.** `{ idToken }` → verifies the ID token, upserts the user, returns `{ user, token }`. |
| POST | `/auth/dev/login` | – | **Dev only (disabled in production).** `{ email }` → dev user + bare token. |
| GET | `/prompts` | optional | List published prompts. `?category=`, `?paid=free|paid`, `?sort=trending|new|recent`, `?q=` |
| GET | `/prompts/:id` | optional | Prompt detail. Paid prompt text unlocked only for owner/unlockers. |
| POST | `/prompts` | ✅ | **Creator publish.** Body `{ title, description, promptText, imageUrl?, category, tags?, isPaid, priceInr? }`. `authorId` = caller. Gated on the plan's daily post limit (Free = 3/day; Pro/Creator unlimited) and paid prompts require the **Creator** plan (`canPostPaid`). |
| POST | `/prompts/:id/save` | ✅ | Save a prompt (idempotent). Returns `{ saved, saveCount }`. |
| POST | `/prompts/:id/unsave` | ✅ | Remove a save (idempotent). Returns `{ saved, saveCount }`. |
| GET | `/me/profile` | ✅ | Signed-in user profile + current subscription + KYC state |
| GET | `/me/prompts` | ✅ | Prompts the user has published |
| GET | `/me/saved` | ✅ | Saved prompts (join table) |
| GET | `/me/transactions` | ✅ | **My Account** ledger (from `transactions`) |
| GET | `/me/earnings` | ✅ | Creator earnings summary (lifetime, withdrawn, pending, balance) |
| GET | `/me/earnings/prompts` | ✅ | Per-prompt earnings breakdown |
| POST | `/payments/playbilling/verify` | ✅ | Verify a Play Billing purchase token + grant. Body `{ productId, purchaseToken, isSubscription? }`. `prompt_<id>` → paid prompt unlock (buyer pays price + 5% transaction fee; creator credited **gross** to wallet `earnings`). `pro`/`pro_annual`/`creator`/`creator_annual` → activate subscription (+ ad-free perk). `ad_free` → one-time ad-free. `deposit_s/m/l/xl` → deposit top-up (net after gateway fee → `deposits`, fee recycled as `bonus`). |
| POST | `/payments/playbilling/void` | ✅ | Refund/void a purchase. Body `{ productId, purchaseToken, isSubscription?, reason? }`. Reverses grant: prompt → creator earnings debit; deposit → net refund from deposits; ad-free → revoke (unless sub-perk); subscription → mark voided. |
| GET | `/payments/wallet` | ✅ | Wallet breakdown: `balances` (earnings / deposits / bonus with amounts + spend rules), `totalBalanceInr`, `bonusVintages` |
| POST | `/payments/payouts` | ✅ | Request a withdrawal (**manual settle**, min ₹60). Body `{ amountInr }`. Requires saved bank details; deducts only the withdrawal fee (15% Pro / 5% Creator), reserves the balance as `pending`. |
| GET | `/payments/admin/payouts` | ✅ + admin | **Admin.** List payout requests with UPI details. `?status=pending`. Requires `ADMIN_EMAILS` (403 otherwise). |
| POST | `/payments/admin/payouts/:id/mark-paid` | ✅ | **Admin.** Mark a pending payout `paid` after you've transferred the money. |
| POST | `/payments/admin/payouts/:id/mark-failed` | ✅ | **Admin.** Mark a payout `failed`; the reserved balance is returned to the creator. |
| GET | `/referrals/code` | ✅ | Get my referral code (creates one if absent). |
| POST | `/referrals/code` | ✅ | Generate my referral code. |
| GET | `/referrals/:code/validate` | – | Validate a referral code before signup. |
| POST | `/referrals/apply` | ✅ | Apply a referral code (oAuth-only). |
| GET | `/referrals/stats` | ✅ | My referral stats (invites, bonus earned, remaining slots). |
| GET | `/referrals/list` | ✅ | My invite list. |
| POST | `/webhooks/google/rtdn` | – | **Play Billing RTDN.** Parse Pub/Sub message, dedupe via `webhook_events`, dispatch subscription lifecycle (renewed/canceled/expired). Always 200. |

Auth uses **Firebase Auth**: the client sends a verified ID token as
`Authorization: Bearer <idToken>`. The backend verifies it with the Admin SDK and
maps the Firebase UID → the `users/{uid}` Firestore doc (lazily created from the
token's claims). The old bare-user-id token is accepted only in development.

Example:

```bash
curl -s http://localhost:8080/health
curl -s -X POST http://localhost:8080/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"idToken":"<firebase-id-token>"}'
# → { "user": { ... }, "token": "<idToken>" }

curl -s http://localhost:8080/prompts?paid=free
curl -s http://localhost:8080/prompts?sort=trending
curl -s http://localhost:8080/me/transactions \
  -H 'Authorization: Bearer <idToken>'
```

## Live base URL

The backend uses exactly **one** API base URL — the Cloud Run deployment. It's
defined in **one place**, `src/config/urls.js`:

| Constant | Value |
|---|---|
| `API_BASE_URL` | `PUBLIC_BASE_URL` env (default `http://localhost:8080`) |

CORS always allows the live URL, plus anything in `CORS_ORIGINS` (e.g. a web
frontend dev server). Mobile apps don't send an Origin header and don't need CORS.

The Android app reads its base URL from `BuildConfig.API_BASE_URL`
(`app/build.gradle.kts`) — debug points at the emulator's local backend, release
at the Cloud Run URL; override either with `-PAPI_BASE_URL=https://.../`.
Payments run against Play Billing; use **Play Console test/license testing** for
the initial stage.

## Money model (Google Play Billing, live app)

```
Subscriptions  Buyer ──(₹/mo, Play Billing subscriptions)──► Platform (recurring)
Paid prompts   Buyer ──(₹ = price + 5%, Play Billing)──────► Platform (prompt unlocked)
                                                         │  creator credited GROSS = price → wallet earnings
                                                         │  buyer's +5% = app income (not credited)
                                                         ▼
                                                  Creator wallet · earnings bucket
                                                         │  withdraw (min ₹60) → deduct withdrawal fee
                                                         │    (15% Pro / 5% Creator) — only fee at payout
                                                         │  admin transfers via OWN bank app
                                                         ▼
                                                  Creator's bank account
```

**Fees (see `plans/` for the full model):**
- **5% buyer transaction fee** on paid prompts — charged at purchase (app income),
  never credited to any user or withdrawable.
- **Withdrawal fee** (15% Pro / 5% Creator seller) — deducted when the creator
  initiates a payout; the *only* deduction at payout.
- **Play Billing commission** (~15%) — Google's cut, absorbed by the platform at
  payment time, never re-deducted at withdrawal (tracked for reconciliation).

**Wallet (see `plans/wallet.md`):** every user has a `user_wallets` doc with three
buckets — `earnings` (withdrawable), `deposits` (own money), `bonus` (spend-capped,
expiring). A deposit top-up credits the **net** (SKU price − Play Billing fee) to
`deposits` and recycles the fee as a **bonus** vintage (90-day expiry, FEFO spend,
10% spend cap). Legacy `user_balances` rows were migrated by `npm run db:migrate-wallets`;
the wallet is now the source of truth for the withdrawable earnings balance.

**Why "manual settle"?** Automatic third-party bank transfers (like RazorpayX / PayU payout)
are business-only, so a solo individual can't create a payout route. The payout flow is:
creator requests a withdrawal → a `payouts` row is created (`pending`) and the balance is
**reserved** (ledger debit) → the developer (you) transfers the money from your own bank
app → `POST /payments/admin/payouts/:id/mark-paid` flips it to `paid`. `mark-failed`
reverses the reservation.

- All money is stored as **integer rupees** (never floats) at paise precision.
- `prompt_purchases` freezes `priceInr / buyerPaysInr / transactionFeeInr / platformFeePercent / netInr` at sale time.
- Every credit/debit writes one row to `transactions` with a `balanceType` (earnings/deposits/bonus — My Account ledger + wallet audit).
- The wallet doc's `bonus` scalar ≡ Σ `bonusVintages[].remaining`. Bonus spends oldest-expiring first (FEFO) up to 10% of an item price.
- Payouts reserve the wallet `earnings` balance *at request time* — `pending` money can't be double-withdrawn.
- RTDN handlers are idempotent: a unique `dedupe_key` (hash of event + payload) makes
  replays no-ops, so a doubled delivery can't double-charge a subscription.

## Data model

Firestore collections (schema-less; see `src/db/firestoreRepo.js` for the
collection names): `users`, `subscription_plans`, `user_subscriptions`, `prompts`,
`prompt_purchases`, `transactions`, `payouts`, `saved_prompts`,
`user_balances` (legacy), **`user_wallets`** (multi-balance wallet),
`referral_codes` / `referrals` / `device_fingerprints` (referral program), plus
`webhook_events` for idempotent Play Billing RTDN replay.

Key invariants enforced by the service layer:
- One unlock per buyer per prompt → deterministic doc id `(buyer_id, prompt_id)`
- Saved prompts → composite id `(user_id, prompt_id)`
- Hot queries indexed: `prompts(status, createdAt)`, `prompts(authorId, createdAt)`,
  `transactions(userId, createdAt)`, `prompt_purchases(authorId, status)`
- Daily post limit derives from `COUNT(prompts WHERE authorId AND createdAt = today)`

### Metrics & how they're computed

| Metric | Where it lives | How it's computed |
|---|---|---|
| `view_count` | `prompts` column | `recordPromptView()` bumps it by 1 on `GET /prompts/:id` (fire-and-forget) |
| `save_count` | `prompts` column | `POST /prompts/:id/save` / `/unsave` increment/decrement it (floor 0) as they maintain the `saved_prompts` join table |
| `savedByMe` | response annotation | Set-membership from `saved_prompts` for the signed-in viewer (list + detail) |
| `is_trending` | **derived, not stored** | `view_count + save_count >= 100` (see `src/services/prompt-metrics.js`); also the `sort=trending` ordering |
| `is_new` | **derived, not stored** | `created_at` within 7 days |
| Earnings | derived from `prompt_purchases` | `priceInr` (gross) frozen at sale; withdrawal fee (15%/5%) applied at payout — not at sale. Summary + per-prompt in `/me/earnings*` |
| Author name | `prompt.author` object | Every prompt list/detail response includes `author: { id, fullName, avatarUrl, role }` |

## Project structure

```
src/
  server.js              # entrypoint: binds 0.0.0.0 on PORT, graceful shutdown
  app.js                 # Express app assembly (raw body for webhooks, JSON elsewhere)
  config/env.js          # zod-validated environment (Firebase, Play Billing, URLs)
  config/urls.js         # single live API base URL (Cloud Run via PUBLIC_BASE_URL)
  db/
    firestore.js         # Firebase Admin init (Firestore + Auth)
    firestoreRepo.js     # Firestore data-access helpers (queries, tx helpers, serializers)
    config.js            # db + runTransaction() + pingDb()
    sync.js              # npm run db:sync (connectivity check — schema is implicit)
    seed.js              # idempotent Firestore seed (plans, demo prompts)
    migrate-wallets.js   # npm run db:migrate-wallets (legacy → wallet, idempotent)
    reset.js             # npm run db:reset (clears collections — destructive)
  lib/playBilling.js     # Google Play Billing client + purchase/ack/fee helpers
  middleware/            # Firebase Auth, error handler, 404
  routes/                # HTTP layer — thin, delegates to services
  scripts/
    expireBonus.js       # npm run wallet:expire (bonus vintage expiry sweep)
    reconcile.js         # npm run reconcile (monthly Play Billing fee reconciliation)
  services/              # business logic + all Firestore queries
    ledger.js            # legacy running balance (user_balances) + writeLedger() helpers
    wallet.service.js    # multi-balance wallet: get/credit/debit, FEFO bonus, deposit top-up split, expiry
    referrals/           # referral program: generate/validate/apply (bonus credits) + stats/list
    prompt-metrics.js    # derived isTrending / isNew from counts + age
    earnings.service.js  # creator earnings aggregation (wallet-backed)
    rtdn.service.js      # Play Billing RTDN → idempotent log (dedupe doc id) → dispatch
    payments/            # Play Billing: prompt unlocks, deposits, ad-free, subscriptions, payouts
      products.js        # One-time product catalog (ad_free, deposit_*)
      balance-types.js   # BALANCE_TYPES: earnings / deposits / bonus + spend rules & priority
      withdrawal-fees.js # Withdrawal fee math (pure, unit-tested) — 15% Pro / 5% Creator
      plans.js           # Built-in plans (free/pro/pro_annual/creator/creator_annual) + map
```

## Roadmap / not yet built

- **Admin role gating** — `/payments/admin/*` is gated by `ADMIN_EMAILS` (403 for others).
- Refund/void flow (`prompt_purchases.status = 'voided'` → reverse ledger) — built
  (`src/services/payments/void.service.js` + `POST /payments/playbilling/void`).
  Wallet refund paths exist: `refundDeposit` debits `deposits` and removes the
  recycled bonus vintage.
- Automated payouts — only if/when you register a **business** account; the manual-settle
  flow is the solo-individual path
- Per-user bonus-expiry reminder push (`getBonusExpiringSoon` exists; the notification
  sweep is not yet wired to a push channel)
- Distributed rate limiting (the built-in limiter is per-instance in-memory)
- Client-side Firestore reads — **decided:** all access stays behind the API; `firestore.rules`
  denies all direct client access (the backend uses the Admin SDK, which bypasses rules)
