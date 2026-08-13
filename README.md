# Promptly AI — Backend

Backend for **Promptly AI**, an AI-prompt marketplace. **Node.js + Express + Firebase
Firestore + Firebase Auth** (plain JavaScript, ESM). Supports free/pro/creator
subscriptions, paid prompt unlocks, and creator payouts — all money routed through
**Razorpay**. Deploys to **Google Cloud Run**.

> The mobile/UI app is **UI-only today** (in-memory mocks). This backend is designed so
> the UI can swap its mock repository for this live API without visual changes.

## Stack

- **Node.js ≥ 20** + **Express 4** (ESM, no build step)
- **Firebase Firestore** (Native) as the datastore, via `firebase-admin`
- **Firebase Authentication** — the backend verifies client ID tokens (Admin SDK)
- **Razorpay** for payments (orders, subscriptions, webhooks)
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

# 3b. (Payments) Put your Razorpay keys in .env, plus the Subscription Plan IDs:
#    create two plans in dashboard.razorpay.com → Settings → Plans ("Pro" ₹49/mo,
#    "Creator" ₹99/mo), then set RAZORPAY_PLAN_PRO_ID / RAZORPAY_PLAN_CREATOR_ID.
#    Set RAZORPAY_WEBHOOK_SECRET to the secret from Settings → Webhooks and point the
#    webhook URL at your server's POST /webhooks/razorpay.

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
  --set-secrets RAZORPAY_KEY_ID=razorpay-key-id:latest,RAZORPAY_KEY_SECRET=razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=razorpay-webhook-secret:latest,FIREBASE_CLIENT_EMAIL=firebase-client-email:latest,FIREBASE_PRIVATE_KEY=firebase-private-key:latest,RAZORPAY_PLAN_PRO_ID=razorpay-plan-pro:latest,RAZORPAY_PLAN_CREATOR_ID=razorpay-plan-creator:latest
```

**After deploy:** point Razorpay's webhook at
`https://<cloud-run-url>/webhooks/razorpay`. In **test mode** you can use a tunnel
(ngrok / cloudflared) to forward to your local server for debugging webhooks.

**Notes for Cloud Run**
- The server binds `0.0.0.0` on `PORT` (default 8080) — Cloud Run injects `PORT`.
- Webhooks stay safe because the handler is idempotent (Razorpay retries, and a
  duplicate delivery is a no-op via the Firestore `webhook_events` dedupe).
- Swap `rzp_test_*` → `rzp_live_*` and set a real webhook secret before real money.

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
| POST | `/payments/checkout/order` | ✅ | Create a Razorpay order for a paid prompt. Body `{ promptId }` → `{ orderId, amountInr, currency, feePercent, feeInr, netInr }`. |
| POST | `/payments/checkout/verify` | ✅ | Verify the payment + unlock. Body = Razorpay Checkout success payload `{ promptId, orderId, paymentId, signature }`. Writes the purchase + ledger. |
| POST | `/payments/subscriptions` | ✅ | Create a Razorpay subscription. Body `{ planId: "pro" | "creator" }` → `{ subscription: { razorpaySubId, shortUrl, … } }`. The app opens `shortUrl` to collect the first payment. |
| POST | `/payments/payouts` | ✅ | Request a withdrawal (**manual settle**, min ₹60). Body `{ amountInr }`. Requires saved UPI; reserves the balance as `pending`. |
| GET | `/payments/admin/payouts` | ✅ + admin | **Admin.** List payout requests with UPI details. `?status=pending`. Requires `ADMIN_EMAILS` (403 otherwise). |
| POST | `/payments/admin/payouts/:id/mark-paid` | ✅ | **Admin.** Mark a pending payout `paid` after you've transferred the money. |
| POST | `/payments/admin/payouts/:id/mark-failed` | ✅ | **Admin.** Mark a payout `failed`; the reserved balance is returned to the creator. |
| POST | `/webhooks/razorpay` | signature | Verify `X-Razorpay-Signature` (HMAC), log idempotently to `webhook_events` (dedupe key = doc id), dispatch `subscription.charged` / `.cancelled` / `.expired`. |

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
Payments run against Razorpay **test keys** (`rzp_test_*`) for the initial stage;
only the URL is live.

## Money model (Razorpay, live app)

```
Subscriptions  Buyer ──(₹/mo, Razorpay Subscriptions)──► Platform (recurring)
Paid prompts   Buyer ──(₹, Razorpay Checkout)──────────► Platform pool
                                                         │  net = price × (100 − fee%) / 100  (Pro=5%, Creator=0%)
                                                         ▼
                                                  Creator balance
                                                         │  withdraw (min ₹60) → request
                                                         │  admin transfers via OWN bank app
                                                         ▼
                                                  Creator's bank account
```

**Why "manual settle"?** RazorpayX Payouts (automatic bank transfer to a third party) is
**business-only** — a solo individual can't create a payout route. So the payout flow here
is: the creator requests a withdrawal → a `payouts` row is created (`pending`) and the
balance is **reserved** (ledger debit) → the developer (you) transfers the money from your
own bank app → `POST /payments/admin/payouts/:id/mark-paid` flips it to `paid`. No
RazorpayX involved. `mark-failed` reverses the reservation.

- All money is stored as **integer rupees** (never floats).
- `prompt_purchases` freezes `price_inr / platform_fee_inr / net_inr` at sale time.
- Every credit/debit writes one row to `transactions` (the My Account ledger).
- Payouts reserve the balance *at request time* — `pending` money can't be double-withdrawn.
- Webhooks are idempotent: a unique `dedupe_key` (hash of event + payload) makes replays
  no-ops, so a doubled delivery can't double-charge a subscription.
- ⚠️ `bank_accounts.account_number_full` stores the full account number in **plaintext** for
  the manual transfer. **Encrypt it before real money** (see "Before launch").

## Data model

12 tables (see `src/db/models/*.js`): `users`, `subscription_plans`, `user_subscriptions`,
`prompts`, `user_posts`, `prompt_purchases`, `transactions`, `payouts`, `bank_accounts`,
`kyc_verifications`, `saved_prompts`, plus `webhook_events` for idempotent Razorpay webhook
replay.

Key invariants baked into the models:
- One unlock per buyer per prompt → unique index `(buyer_id, prompt_id)`
- Saved prompts → composite primary key `(user_id, prompt_id)`
- KYC is 1:1 with users → unique `user_id`
- Hot queries indexed: `prompts(category, is_paid)`, `prompts(created_at)`,
  `user_posts(user_id, posted_on)`, `transactions(user_id, created_at)`,
  `prompt_purchases(author_id)`
- Daily post limit derives from `COUNT(user_posts WHERE posted_on = today)` — no counter
  column to drift.

### Metrics & how they're computed

| Metric | Where it lives | How it's computed |
|---|---|---|
| `view_count` | `prompts` column | `recordPromptView()` bumps it by 1 on `GET /prompts/:id` (fire-and-forget) |
| `save_count` | `prompts` column | `POST /prompts/:id/save` / `/unsave` increment/decrement it (floor 0) as they maintain the `saved_prompts` join table |
| `savedByMe` | response annotation | Set-membership from `saved_prompts` for the signed-in viewer (list + detail) |
| `is_trending` | **derived, not stored** | `view_count + save_count >= 100` (see `src/services/prompt-metrics.js`); also the `sort=trending` ordering |
| `is_new` | **derived, not stored** | `created_at` within 7 days |
| Earnings | derived from `prompt_purchases` | `net_inr = price_inr × (100 − fee%) / 100` frozen at sale; summary + per-prompt in `/me/earnings*` |
| Author name | `prompt.author` object | Every prompt list/detail response includes `author: { id, fullName, avatarUrl, role }` |

## Project structure

```
src/
  server.js              # entrypoint: binds 0.0.0.0 on PORT, graceful shutdown
  app.js                 # Express app assembly (raw body for webhooks, JSON elsewhere)
  config/env.js          # zod-validated environment (Firebase, Razorpay, URLs)
  config/urls.js         # single live API base URL (Cloud Run via PUBLIC_BASE_URL)
  db/
    firestore.js         # Firebase Admin init (Firestore + Auth)
    firestoreRepo.js     # Firestore data-access helpers (queries, tx helpers, serializers)
    config.js            # db + runTransaction() + pingDb()
    sync.js              # npm run db:sync (connectivity check — schema is implicit)
    seed.js              # idempotent Firestore seed (plans, demo prompts)
    reset.js             # npm run db:reset (clears collections — destructive)
  middleware/            # Firebase Auth, error handler, 404
  routes/                # HTTP layer — thin, delegates to services
  services/              # business logic + all Firestore queries
    ledger.js            # running balance (user_balances) + writeLedger() helpers
    prompt-metrics.js    # derived isTrending / isNew from counts + age
    earnings.service.js  # creator earnings aggregation from prompt_purchases
    webhooks.service.js  # verify → idempotent log (dedupe doc id) → dispatch by event
    payments/            # Razorpay: checkout, subscriptions, manual-settle payouts
```

## Roadmap / not yet built

- **Admin role gating** — `/payments/admin/*` is gated by `ADMIN_EMAILS` (403 for others).
- Refund flow (`prompt_purchases.status = 'refunded'` → reverse ledger rows)
- **Encrypt** `bank_accounts.account_number_full` (and the KYC `pan`) — plaintext today, test-mode only
- RazorpayX Payouts — only if/when you register a **business** account; the manual-settle
  flow is the solo-individual path
- Distributed rate limiting (the built-in limiter is per-instance in-memory)
- Client-side Firestore reads — **decided:** all access stays behind the API; `firestore.rules`
  denies all direct client access (the backend uses the Admin SDK, which bypasses rules)
