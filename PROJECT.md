# Promptly AI — Backend Project Reference

> **Purpose of this file:** a single, self-contained reference for anyone (human, agent, or
> AI) to fully understand this project without the full repo. It consolidates what used to
> live across several markdown docs (deployment runbook, payouts architecture) into one place.
> The repo intentionally keeps only two markdown files: **`README.md`** (quick start) and
> **`PROJECT.md`** (this deep reference).

---

## 1. What this is

**Promptly AI** is an **AI-prompt marketplace**: creators publish text prompts (with a cover
image), browse/save/trend prompts, and monetize via subscriptions and paid per-prompt unlocks.
Creators can withdraw earnings (manual settle). Payments are routed through **Razorpay**.

The **backend** is a **Node.js + Express 4** HTTP API (plain JavaScript, ESM, no build step)
that talks to **Firebase Firestore** (the datastore) and **Firebase Authentication** (identity),
serves user-uploaded images from **Google Cloud Storage**, and is deployed to **Google Cloud Run**
(container, `Dockerfile`). The mobile/UI app is a separate client that consumes this API.

```
Mobile/Web UI ──HTTPS──► Cloud Run (this API) ──► Firebase Auth (ID tokens)
                                         ──► Firestore (data)
                                         ──► Cloud Storage (images, public)
                                         ──► Razorpay (orders/subscriptions/webhooks)
                                         ──► Google Cloud Vision (NSFW moderation)
```

---

## 2. Stack & versions

| Layer | Choice |
|---|---|
| Runtime | Node.js ≥ 20 (ESM, `"type": "module"`) |
| Framework | Express 4 |
| Database | Firebase Firestore (Native) via `firebase-admin` |
| Auth | Firebase Auth (Admin SDK verifies client ID tokens) |
| Payments | Razorpay (orders, subscriptions, webhooks, HMAC signatures) |
| Image processing | `sharp` (watermarking), `adm-zip` (bulk ZIP), `@google-cloud/vision` (moderation) |
| Validation | `zod` (env + request bodies) |
| Middleware | `helmet`, `cors`, `morgan`, `multer`, custom rate limiter |
| Deploy | Docker → Google Cloud Run (`gcloud run deploy --source .`) |

All secret values come from environment variables; on Cloud Run they are pulled from
**Secret Manager** at deploy time (`deploy.cloudrun.sh --set-secrets`). On a fresh Firestore,
run `npm run db:seed` once to create the starter subscription plans + demo prompts.

---

## 3. Project layout

```
src/
  server.js                  # Entrypoint: binds 0.0.0.0 on PORT (default 8080), graceful shutdown
  app.js                     # Express assembly: helmet, cors, raw body for webhooks, json, routers
  config/env.js              # zod-validated environment + admin email + razorpay plan-id helpers
  config/urls.js             # single API base URL (PUBLIC_BASE_URL / CORS origins)
  db/
    firestore.js             # Firebase Admin init (Firestore + Auth), toTimestamp helpers, pingDb
    firestoreRepo.js         # Data-access layer: queryAll, findByPk, upsert, batch/tx helpers, COLS map
    config.js                # Re-exports db + runTransaction() + pingDb() (used by routes & payments)
    seed.js                  # npm run db:seed — idempotent starter data (plans, demo prompts)
  lib/razorpay.js            # Lazily-created Razorpay client + HMAC signature verifiers
  middleware/
    auth.js                  # requireAuth / optionalAuth (Firebase ID-token verify + dev fallback)
    errorHandler.js          # Converts errors to {error:{message,code}}; 5xx → generic "Internal server error"
    notFound.js              # 404 handler
    rateLimit.js             # In-memory per-IP/uid sliding-window limiter
  routes/                    # HTTP layer — thin; validates input, delegates to services
    health.js  auth.js  prompts.js  me.js  admin-prompts.js  payments.js  webhooks.js
  services/                  # Business logic + all Firestore/Storage reads & writes
    prompts.service.js       # list/detail/save/unsave/create/delete prompts, daily-post gate
    prompt-metrics.js        # Derived isTrending / isNew flags
    me.service.js            # Profile, own prompts, saved, transactions, purchases, earnings
    storage.service.js       # Raw image upload to Cloud Storage → public URL
    image-watermark.service.js # sharp watermark for paid prompt covers (admin wordmark)
    image-moderation.service.js # Google Vision SafeSearch → refuse adult/racy on user uploads
    bulk-prompts.service.js  # Admin bulk ZIP/CSV import (validate → upload images → batch writes)
    ledger.js                # user_balances running balance + writeLedger() helpers
    earnings.service.js      # Creator earnings aggregation from prompt_purchases
    webhooks.service.js      # Razorpay webhook verify → idempotent log → dispatch by event
    payments/
      checkout.service.js    # createCheckoutOrder / verifyAndUnlock (paid prompt unlock)
      subscriptions.service.js # create / cancel active subscription
      payouts.service.js     # Manual-settle withdrawals (request/list/mark paid/failed, eligibility)
      plans.js               # BUILTIN_PLANS fallback + plan lookups
      subscription-utils.js  # active-subscription + fee helpers
  utils/
    http-error.js            # httpError(status, message)
    paging.js                # parsePaging — limit (≤100, default 50) + offset clamps
    csv.js                   # CSV parsing (quotes, BOM)
    prompt-import.js         # Bulk CSV row validation + image-name helpers (pure, unit-tested)
test/                        # node:test unit tests (no framework dep)
```

Layering rule: **route → service → Firestore/Storage data-access**. Routes do not run
Firestore queries directly; they validate with `zod` and delegate to a service.

---

## 4. Authentication model

- Client signs in with **Firebase Auth**, sends the ID token as
  `Authorization: Bearer <idToken>`.
- `requireAuth` / `optionalAuth` verify it with the Admin SDK (`firebaseAuth.verifyIdToken`,
  `checkRevoked = true`) and resolve the Firebase UID → `users/{uid}` Firestore doc, lazily
  creating it from token claims if missing.
- **Dev fallback** (only when `DEV_AUTH_PASSWORD` is set — dev service): a token shaped
  `Bearer <password>:<email>` resolves a user by email. Never set this in production.
- In non-production, a bare UUID user id is also accepted as a token.
- **Admins** are identified purely by email membership in `ADMIN_EMAILS` (env), via
  `isAdminEmail()`. Admin-gated routes return 403 for everyone else.

---

## 5. Full API surface

Auth column: **–** = public, **optional** = works signed-in or anonymous, **✅** = required
Bearer token, **✅+admin** = required token + admin email.

### Health & auth
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | – | `{ status, db, uptime }` — Firestore ping |
| POST | `/auth/login` | – | Body `{ idToken }` → verifies Firebase token, upserts user, returns `{ user, token }` |
| POST | `/auth/dev/login` | – | Dev-only (404 in production). Body `{ email }` → returns a bare dev token |

### Prompts (marketplace)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/prompts` | optional | List published prompts. Query: `category`, `paid=free|paid`, `sort=trending|new|recent`, `q`, `limit`, `offset`. Annotates `savedByMe` for signed-in viewer. |
| GET | `/prompts/:id` | optional | Prompt detail (paid-text unlocked only for owner/unlockers). Bumps `viewCount`. |
| GET | `/prompts/:id/image` | optional | Serves the watermarked cover for paid prompts |
| POST | `/prompts` | ✅ | Publish a prompt. Body `{ title, description, promptText, imageUrl, category, tags?, isPaid, priceInr? }`. **An image is mandatory** (via `imageUrl` or `images[]`). Gated on plan daily-post limit; paid prompts require Creator plan (`canPostPaid`). |
| POST | `/prompts/image` | ✅ | Upload a prompt cover (raw `image/*` body, ≤3 MB). **Moderated** (Vision) — adult/racy rejected with 422; admins exempt (bulk import is separate). Returns `{ imageUrl }`. |
| POST | `/prompts/:id/save` | ✅ | Save a prompt (idempotent) |
| POST | `/prompts/:id/unsave` | ✅ | Remove a save (idempotent) |
| DELETE | `/prompts/:id` | ✅ | Owner deletes their prompt |

### Me (profile & creator account)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/me/profile` | ✅ | User profile + current subscription + KYC/payout state |
| PATCH | `/me/profile` | ✅ | Update profile fields |
| GET | `/me/prompts` | ✅ | Prompts the user has published |
| GET | `/me/saved` | ✅ | Saved prompts (join table, newest first) |
| GET | `/me/transactions` | ✅ | My Account ledger rows |
| GET | `/me/purchases` | ✅ | Prompts the user has bought/unlocked |
| GET | `/me/earnings` | ✅ | Earnings summary (lifetime, withdrawn, pending, balance) |
| GET | `/me/earnings/prompts` | ✅ | Per-prompt earnings breakdown |
| POST | `/me/upi` | ✅ | Save a UPI id for payouts |
| POST | `/me/bank` | ✅ | Save bank details for payout |
| POST | `/me/bank/pan-image` | ✅ | Upload PAN proof image |
| POST | `/me/bank/account-image` | ✅ | Upload bank-account proof image |
| DELETE | `/me/bank` | ✅ | Remove bank details |
| POST | `/me/avatar` | ✅ | Upload profile picture (raw `image/*` body) |
| DELETE | `/me/account` | ✅ | Delete account (soft-delete) |

### Payments (Razorpay)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/payments/checkout/order` | ✅ | Body `{ promptId }` → create Razorpay order for a paid prompt |
| POST | `/payments/checkout/verify` | ✅ | Body = Razorpay success payload `{ promptId, orderId, paymentId, signature }` → verify + unlock |
| POST | `/payments/subscriptions` | ✅ | Body `{ planId: "pro"|"creator" }` → create Razorpay subscription |
| DELETE | `/payments/subscriptions` | ✅ | Cancel active subscription (current paid period stays) |
| GET | `/payments/payouts/eligibility` | ✅ | Withdrawable balance, min withdrawal, eligible + blockers |
| GET | `/payments/payouts` | ✅ | User's payout history |
| POST | `/payments/payouts` | ✅ | Request withdrawal. Body `{ amountInr }` (manual settle, min `MIN_WITHDRAWAL_INR`) |
| GET | `/payments/admin/payouts` | ✅+admin | List payout requests (`?status=pending`) with transfer details |
| POST | `/payments/admin/payouts/:id/mark-paid` | ✅+admin | Mark a payout paid after manual bank transfer |
| POST | `/payments/admin/payouts/:id/mark-failed` | ✅+admin | Mark failed; reserved balance returned to creator |

### Admin bulk import
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/admin/prompts/bulk-upload/validate` | ✅+admin | Dry run — validates CSV + image availability, creates nothing |
| POST | `/admin/prompts/bulk-upload` | ✅+admin | Full import — validates, uploads images to Storage, batch-creates prompt docs. Accepts multipart (`csv` + `images[]`) **or** a single `bundle` ZIP containing `prompts.csv` + images. Returns a report with per-row errors. |

### Webhooks
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/webhooks/razorpay` | HMAC | Verify `X-Razorpay-Signature`, log idempotently (dedupe), dispatch `subscription.charged` / `.cancelled` / `.expired` |

All money-mutating/`login` routes are rate-limited (in-memory per-IP/uid).

---

## 6. Data model (Firestore collections)

Firestore is schemaless; collections are created on first write. Collection names are the single
source of truth in `src/db/firestoreRepo.js` (`COLS`).

| Collection | Purpose / shape |
|---|---|
| `users` | id = Firebase UID. `email, fullName, avatarUrl, role, upiId, ...`, soft-delete via `deleted` |
| `subscription_plans` | `free` / `pro` / `creator` plans (seeded). Gates daily post limit & `canPostPaid` |
| `user_subscriptions` | A user's Razorpay subscription (one active). Status: `active/inactive/cancelled/...` |
| `prompts` | Marketplace prompts: `authorId, title, description, promptText, imageUrl, images[], category, tags, isPaid, priceInr, status, viewCount, saveCount, createdAt` |
| `prompt_purchases` | One unlock per buyer per prompt. Deterministic id `(buyerId, promptId)`. Freezes `priceInr / platformFeeInr / netInr` |
| `transactions` | Ledger rows (every credit/debit) — drives `/me/transactions` |
| `payouts` | Withdrawal requests. Status: `pending / processing / paid / failed` |
| `saved_prompts` | Join table. Id `(userId, promptId)` |
| `user_balances` | Running INR balance per user (integer rupees) |
| `user_posts` | Daily post-count tracking for the plan gate |
| `bank_accounts` | Creator bank transfer details (payout) |
| `kyc_verifications` | KYC image references |
| `webhook_events` | Razorpay webhook idempotency/dedupe |

**Key invariants enforced in the service layer:**
- One unlock per buyer per prompt (deterministic id prevents double-purchase).
- Saved-marking is idempotent (deterministic join id).
- Money is **integer rupees** (never floats).
- Every credit/debit writes a `transactions` row.
- `prompt_purchases` freezes the financial snapshot at sale time.

**Composite indexes** live in `firestore.indexes.json` and are **not** auto-deployed — apply
manually with `gcloud firestore indexes composite create --database=<db> ...` per index, or
`npx firebase deploy --only firestore` for everything. Hot indexes: `prompts(status,createdAt)`,
`prompts(authorId,createdAt)`, `transactions(userId,createdAt)`, `prompt_purchases(authorId,status)`,
`prompt_purchases(buyerId,status)`, `saved_prompts(userId,savedAt)`, `payouts(userId,status)`,
`user_subscriptions(userId,status)`.

---

## 7. Money & payouts model (manual settle)

```
Subscriptions  Buyer ──(recurring, Razorpay)──────────► Platform
Paid prompts   Buyer ──(₹, Razorpay Checkout)────────► Platform pool
                                                        │  net = price × (100 − fee%) / 100
                                                        ▼
                                                 Creator balance (user_balances)
                                                        │  withdraw (min ₹60) → payout request (pending)
                                                        │  admin transfers via OWN bank app
                                                        ▼
                                                 Creator's bank account (manual)
```

- **Why manual:** RazorpayX Payouts (automatic third-party bank transfer) is business-only, so
  a solo individual cannot create a payout route. Hence: creator requests → `payouts` row
  `pending` + balance reserved (ledger debit) → dev transfers from their own bank → admin marks
  `paid`. `mark-failed` reverses the reservation.
- Fees: e.g. platform fee (Pro 5%, Creator 0%) plus Razorpay + GST on withdrawals, computed to
  2-decimal integer precision.
- Webhooks are **idempotent**: a dedupe key (hash of event+payload) makes replays no-ops, so a
  doubled delivery can't double-charge.

---

## 8. Image handling & moderation

- **Uploads** (`POST /prompts/image`, `POST /me/avatar`, bank images): raw image body, ≤3 MB,
  stored in Cloud Storage (`playbold-promptly-prod-media`), returning a public URL.
- **NSFW moderation** (`POST /prompts/image` only — user uploads, *not* admin bulk import):
  Google Vision **SafeSearch** (`SAFE_SEARCH_DETECTION`). If `adult` or `racy` is at or above
  `LIKELY`, the upload is rejected with a **422** and a friendly message. Admins are exempt
  (their bulk import uses a separate route). Requires the **Vision API enabled** on the project;
  it fails closed (upload errors if Vision is off).
- **Watermarking** (`image-watermark.service.js` with `sharp`): paid prompt covers get a
  watermark wordmark so they aren't free-previewed; admins (creator plan) are exempt.
- **Bulk** (`admin-prompts.js` + `bulk-prompts.service.js`): accepts multipart CSV+images **or** a
  ZIP bundle (`prompts.csv` + images). Each CSV row is validated (title/desc/promptText lengths,
  category enum, tags, paid-price, **and an image file that must be present in the upload**), then
  images upload with dedup (one upload per distinct filename, reused across rows), then prompt docs
  are created in Firestore **batches of 500**. Request body is capped by Cloud Run (~32 MB) and
  per-file at 30 MB; timeout pinned to 300 s.

---

## 9. Environment variables (`src/config/env.js`)

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `development` / `test` / `production` |
| `PORT` | HTTP port (Cloud Run injects) |
| `FIREBASE_PROJECT_ID` | GCP project id (required) |
| `FIRESTORE_DATABASE` | Named Firestore DB (dev uses `promptly-dev`, live `promptly-ai`) |
| `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Service-account creds (or `GOOGLE_APPLICATION_CREDENTIALS`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to SA key for local dev |
| `STORAGE_BUCKET` | Cloud Storage bucket for images |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay keys (test in dev) |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook HMAC secret |
| `RAZORPAY_PLAN_PRO_ID` / `RAZORPAY_PLAN_CREATOR_ID` | Razorpay subscription plan ids |
| `PUBLIC_BASE_URL` | Canonical API base URL (CORS + urls.js) |
| `CORS_ORIGINS` | Extra allowed origins |
| `ADMIN_EMAILS` | Comma-separated admin emails (payout/import back-office) |
| `DEV_AUTH_PASSWORD` | Dev-only password fallback (never in prod) |
| `MIN_WITHDRAWAL_INR` | Minimum withdrawal (default 60) |

**Security hygiene:** never commit `.env` or service-account key files (gitignored). On Cloud Run,
secret values are pulled from Secret Manager at deploy time.

---

## 10. Deployment (Google Cloud Run — manual)

Deploys are **manual** — there is no CI/CD; push to GitHub does not auto-deploy.

Two Cloud Run services in project `playbold-promptly-prod` (region `us-west1`), both run as the
same service account and preserve their own env/secrets on deploy:

- **LIVE** service `promptly-ai-backend-git` — Firestore DB `promptly-ai`, **live** Razorpay keys,
  CORS locked to the production web app. Run: `gcloud run deploy promptly-ai-backend-git --source . --region us-west1`.
- **DEV** service `promptly-ai-backend-dev` — Firestore DB `promptly-dev`, **dev/test** Razorpay
  keys, `DEV_AUTH_PASSWORD` set. Run: `gcloud run deploy promptly-ai-backend-dev --source . --region us-west1`.

Both use `--timeout 300` (5-minute request budget) for the bulk-upload path. A manual
`--source .` deploy preserves existing env/secret bindings (no env flags needed). See
`deploy.cloudrun.sh` for the canonical command.

**One-time setup (already done):**
1. Enable APIs: `firestore.googleapis.com`, `firebaseauth.googleapis.com`, `run.googleapis.com`,
   `artifactregistry.googleapis.com`, `secretmanager.googleapis.com`, and **Vision API** (for moderation).
2. Apply composite indexes + Firestore security rules (`firestore.indexes.json` / `firestore.rules`,
   deny-all for direct client access — the backend uses the Admin SDK which bypasses rules).
3. `npm run db:seed` once to create the starter plans + demo prompts.
4. Create Secret Manager secrets for Razorpay keys, webhook secret, SA creds, plan ids; wire via
   `--set-secrets`.
5. Point the Razorpay webhook at `https://<service-url>/webhooks/razorpay`.

**Post-merge deploy flow:** pull/merge to `master` → `gcloud run deploy` dev (and live when ready).

---

## 11. Error handling style

`errorHandler.js` normalizes every failure to `{ error: { message, code } }`. Client errors
(4xx) surface the route/service message directly, which is written in **plain, user-friendly
language** (no internal field names like `imageUrl[]`, no stack details). Server errors (5xx)
return a generic `"Internal server error"` and log the real error server-side, so internals never
leak to clients. Internal sentinel errors thrown inside services (e.g. `already-owns`,
`in-flight`, `insufficient`) are caught and remapped to friendly messages before they reach the
response.

---

## 12. Running & testing locally

```bash
npm install
copy .env.example .env      # then set FIREBASE_PROJECT_ID + creds (or emulator)
npm run db:seed             # once — starter plans + demo prompts
npm run dev                 # http://localhost:8080, hot reload
npm test                    # node:test unit tests (25 tests, no framework dep)
```

The Firebase emulator is supported via `FIRESTORE_EMULATOR_HOST`. Tests only exercise pure /
util modules (CSV, paging, prompt-import, metrics, rate-limit, signatures) — none touch live
Firestore.
