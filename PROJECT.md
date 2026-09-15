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
Creators can withdraw earnings (manual settle). Payments are routed through **Google Play
Billing**.

The **backend** is a **Node.js + Express 4** HTTP API (plain JavaScript, ESM, no build step)
that talks to **Firebase Firestore** (the datastore) and **Firebase Authentication** (identity),
serves user-uploaded images from **Google Cloud Storage**, and is deployed to **Google Cloud Run**
(container, `Dockerfile`). The mobile/UI app is a separate client that consumes this API.

```
Mobile/Web UI ──HTTPS──► Cloud Run (this API) ──► Firebase Auth (ID tokens)
                                         ──► Firestore (data)
                                         ──► Cloud Storage (images, public)
                                         ──► Google Play Billing (in-app purchases/subs, RTDN)
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
| Payments | Google Play Billing (purchases, subscriptions, RTDN webhooks) |
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
  config/env.js              # zod-validated environment + admin email + play-billing helpers
  config/urls.js             # single API base URL (PUBLIC_BASE_URL / CORS origins)
  db/
    firestore.js             # Firebase Admin init (Firestore + Auth), toTimestamp helpers, pingDb
    firestoreRepo.js         # Data-access layer: queryAll, findByPk, upsert, batch/tx helpers, COLS map
    config.js                # Re-exports db + runTransaction() + pingDb() (used by routes & payments)
    seed.js                  # npm run db:seed — idempotent starter data (plans, demo prompts)
    migrate-wallets.js       # npm run db:migrate-wallets — one-time user_balances → user_wallets
  lib/playBilling.js         # Google Play Billing client + purchase/acknowledge/fee helpers
  middleware/
    auth.js                  # requireAuth / optionalAuth (Firebase ID-token verify + dev fallback)
    errorHandler.js          # Converts errors to {error:{message,code}}; 5xx → generic "Internal server error"
    notFound.js              # 404 handler
    rateLimit.js             # In-memory per-IP/uid sliding-window limiter
  routes/                    # HTTP layer — thin; validates input, delegates to services
    health.js  auth.js  prompts.js  me.js  admin-prompts.js  payments.js  referrals.js  rtdn.js
  services/                  # Business logic + all Firestore/Storage reads & writes
    prompts.service.js       # list/detail/save/unsave/create/delete prompts, daily-post gate
    prompt-metrics.js        # Derived isTrending / isNew flags
    me.service.js            # Profile, own prompts, saved, transactions, purchases, earnings
    storage.service.js       # Raw image upload to Cloud Storage → public URL
    image-watermark.service.js # sharp watermark for paid prompt covers (admin wordmark)
    image-moderation.service.js # Google Vision SafeSearch → refuse adult/racy on user uploads
    bulk-prompts.service.js  # Admin bulk ZIP/CSV import (validate → upload images → batch writes)
    ledger.js                # Legacy user_balances running balance + writeLedger() helpers
    wallet.service.js        # ★ Multi-balance wallet: get/credit/debit, FEFO bonus vintages, deposit top-up split, expiry sweep, admin adjustWallet, wallet spend (payment source)
    notifications.service.js # in-app inbox — bonus-expiry reminders (wallet.md §5.4)
    earnings.service.js      # Creator earnings aggregation (wallet-backed)
    rtdn.service.js          # Play Billing RTDN → idempotent log → dispatch by event
    payments/
      balance-types.js       # ★ BALANCE_TYPES: earnings / deposits / bonus + spend rules & priority
      playBilling.service.js # verify+grant: prompt unlock (gross credit to wallet), ad-free, deposit top-up (net→deposits, fee→bonus)
      void.service.js        # ★ Refund/void handler: prompt (earnings debit), deposit (net refund), ad-free (revoke), subscription (mark voided)
      subscriptions.service.js # Play Billing token activation + cancel + RTDN lifecycle
      payouts.service.js     # Manual-settle withdrawals (wallet earnings as source of truth)
      withdrawal-fees.js     # ★ Withdrawal fee math (pure, unit-tested) — 15% Pro / 5% Creator only
      plans.js               # BUILTIN_PLANS fallback + plan lookups
      subscription-utils.js  # active-subscription + fee helpers
    referrals/
      referral.service.js   # ★ Referral program: generate/validate/apply (bonus credits) + stats/list
    moderation.service.js   # ★ Report → soft-delete → appeal → admin queue + like/share (plans/moderation.md)
  scripts/
    expireBonus.js           # npm run wallet:expire — daily bonus vintage expiry sweep
    reconcile.js             # npm run reconcile — monthly Play Billing commission reconciliation
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
| POST | `/prompts/:id/report` | ✅ | Report a prompt `{ reason, description? }`. Rate-limited (5/user/hour); auto-soft-deletes at threshold |
| POST | `/prompts/:id/appeal` | ✅ | Creator appeal within the 7-day window. `{ reason }` |
| POST | `/prompts/:id/like` | ✅ | Toggle like (idempotent). `{ liked, likeCount }` |
| POST | `/prompts/:id/share` | ✅ | Increment `shareCount`. `{ shared, shareCount }` |
| DELETE | `/prompts/:id` | ✅ | Owner deletes their prompt |

### Me (profile & creator account)
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/me/profile` | ✅ | User profile + current subscription + KYC/payout state + `adFree` entitlement (one-time purchase OR sub perk) |
| PATCH | `/me/profile` | ✅ | Update profile fields |
| GET | `/me/prompts` | ✅ | Prompts the user has published |
| GET | `/me/saved` | ✅ | Saved prompts (join table, newest first) |
| GET | `/me/transactions` | ✅ | My Account ledger rows |
| GET | `/me/notifications` | ✅ | In-app inbox (bonus-expiry reminders). `?unreadOnly=&limit=&offset=` |
| POST | `/me/notifications/read` | ✅ | Mark my notifications read — `{ ids: string[] }`, only own rows |
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

### Payments (Google Play Billing)
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/payments/playbilling/verify` | ✅ | Body `{ productId, purchaseToken, isSubscription? }` → verify Play Billing token + grant. `prompt_<id>` unlocks a prompt (buyer pays price + 5% transaction fee, creator credited **gross** to wallet `earnings`). `pro` / `pro_annual` / `creator` / `creator_annual` activate subscriptions (+ ad-free perk). `ad_free` grants one-time ad-free. `deposit_s/m/l/xl` credit a deposit top-up (**net** after gateway fee → `deposits`, fee recycled as `bonus`). |
| POST | `/payments/playbilling/void` | ✅ | Body `{ productId, purchaseToken, isSubscription?, reason? }` → refund/void a purchase. Prompt → creator earnings debit (capped); deposit → net refund from deposits; ad-free → revoke unless sub-perk; subscription → mark voided. |
| GET | `/payments/wallet` | ✅ | Wallet breakdown: `balances` (earnings / deposits / bonus with amounts + spend rules), `totalBalanceInr`, `bonusVintages` (per-credit remaining + expiry) |
| GET | `/payments/wallet/allocate` | ✅ | **Read-only** payment-source split preview: `?itemPriceInr=N` → per-bucket spend (deposits → earnings → bonus, 10% bonus cap). Builds on `calculatePaymentSplit` |
| POST | `/payments/wallet/spend` | ✅ | **Spend wallet balances** as payment source. Body `{ itemPriceInr, refId, note? }`; debits the split (deposits → earnings → bonus, 10% cap), returns `totalCovered` + `remaining` residual. **Idempotent by `refId`** |
| DELETE | `/payments/subscriptions` | ✅ | Cancel active subscription (user also cancels in Play Store) |
| GET | `/payments/payouts/eligibility` | ✅ | Withdrawable balance, min withdrawal, eligible + blockers |
| GET | `/payments/payouts` | ✅ | User's payout history |
| POST | `/payments/payouts` | ✅ | Request withdrawal. Body `{ amountInr }` (manual settle, min `MIN_WITHDRAWAL_INR`) |
| GET | `/payments/admin/payouts` | ✅+admin | List payout requests (`?status=pending`) with transfer details |
| POST | `/payments/admin/payouts/:id/mark-paid` | ✅+admin | Mark a payout paid after manual bank transfer |
| POST | `/payments/admin/payouts/:id/mark-failed` | ✅+admin | Mark failed; reserved balance returned to creator |
| PATCH | `/payments/admin/wallets/:id` | ✅+admin | **Manual wallet adjustment** (support/refund disputes). Body `{ balanceType: earnings|deposits|bonus, deltaInr: ±amount, note? }` → credits or debits the bucket through the same primitives as every other write (ledger + FEFO intact) |

### Referrals
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/referrals/code` | ✅ | Get my referral code (creates one if absent) |
| POST | `/referrals/code` | ✅ | Generate a referral code |
| GET | `/referrals/:code/validate` | – | Validate a code before signup (returns referrer name) |
| POST | `/referrals/apply` | ✅ | Apply a code (oAuth-only gate). Credits both sides as `bonus` |
| GET | `/referrals/stats` | ✅ | Invites, bonus earned, remaining slots |
| GET | `/referrals/list` | ✅ | My invites (newest first) |

### Admin bulk import
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/admin/prompts/bulk-upload/validate` | ✅+admin | Dry run — validates CSV + image availability, creates nothing |
| POST | `/admin/prompts/bulk-upload` | ✅+admin | Full import — validates, uploads images to Storage, batch-creates prompt docs. Accepts multipart (`csv` + `images[]`) **or** a single `bundle` ZIP containing `prompts.csv` + images. Returns a report with per-row errors. |

### Admin moderation
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/admin/prompts/reports` | ✅+admin | **Moderation queue** — prompts in `reported`/`appealed` states joined with pending `prompt_reports`. `?status=` |
| POST | `/admin/prompts/:id/approve` | ✅+admin | Approve a creator appeal → restore to `published`, reset report counters |
| POST | `/admin/prompts/:id/reject` | ✅+admin | Reject an appeal → hard-delete the prompt |
| POST | `/admin/prompts/:id/dismiss-report` | ✅+admin | Dismiss reports → restore to `published`, clear counters |

### Webhooks
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/webhooks/google/rtdn` | – | Play Billing RTDN. Parse Pub/Sub message, verify subscription id, log idempotently (dedupe doc id), dispatch subscription lifecycle (`SUBSCRIPTION_RENEWED` / `CANCELED` / `EXPIRED`). Always 200. |

All money-mutating/`login` routes are rate-limited (in-memory per-IP/uid).

---

## 6. Data model (Firestore collections)

Firestore is schemaless; collections are created on first write. Collection names are the single
source of truth in `src/db/firestoreRepo.js` (`COLS`).

| Collection | Purpose / shape |
|---|---|
| `users` | id = Firebase UID. `email, fullName, avatarUrl, role, upiId, adFree, adFreePurchasedAt, adFreeSku, ...`, soft-delete via `deleted` |
| `subscription_plans` | `free` / `pro` / `pro_annual` / `creator` / `creator_annual` plans (seeded). Gates daily post limit & `canPostPaid`; carries `platformFeePercent` (withdrawal fee: Pro 15%, Creator 5%) and `perks` array (e.g. `ad_free`) |
| `user_subscriptions` | A user's Play Billing subscription (one active). `gatewaySubscriptionId` = purchase token. Status: `active/cancelled/expired` |
| `prompts` | Marketplace prompts: `authorId, title, description, promptText, imageUrl, images[], category, tags, isPaid, priceInr, status, viewCount, saveCount, likeCount, shareCount, reportCount, createdAt`. Moderation: `status` ∈ `published|reported|appealed|deleted`, `reportedAt, reportedBy[], appealStatus, appealReason, appealDeadline, appealedAt` |
| `prompt_purchases` | One unlock per buyer per prompt. Deterministic id `(buyerId, promptId)`. Freezes `priceInr` (gross) + `buyerPaysInr` (+5% tx fee) + `gatewayFeeInr` (commission, tracked only) |
| `transactions` | Ledger rows (every credit/debit, `balanceType` = which bucket) — drives `/me/transactions` and the wallet audit trail |
| `user_wallets` | ★ Multi-balance wallet, id = user id. `earnings` (withdrawable) / `deposits` (own money) / `bonus` (spend-capped + expiring), plus `bonusVintages` map for per-credit FEFO expiry |
| `payouts` | Withdrawal requests. Status: `pending / processing / paid / failed` |
| `saved_prompts` | Join table. Id `(userId, promptId)` |
| `prompt_reports` | ★ Moderation join table. Id `(userId, promptId)`. `userId, promptId, reason (spam/inappropriate/copyright/misleading/other), description, status (pending/resolved/dismissed), createdAt` |
| `prompt_likes` | ★ Like join table. Id `(userId, promptId)`. `userId, promptId, likedAt` |
| `user_balances` | **Legacy** running INR balance per user — superseded by `user_wallets` (migrated via `npm run db:migrate-wallets`) |
| `referral_codes` | Referral codes. Id = code. `code, userId, isActive` |
| `referrals` | Completed referrals. Deterministic id `(referrerId, refereeId)`. `referrerId, refereeId, code, status, bonusCredited, ipAddress` |
| `device_fingerprints` | Play Account ID linkage for anti-fraud. Id `(playAccountId, userId)`. `userId, playAccountId, ipAddress` |
| `user_posts` | Daily post-count tracking for the plan gate |
| `bank_accounts` | Creator bank transfer details (payout) |
| `kyc_verifications` | KYC image references |
| `webhook_events` | Play Billing RTDN idempotency/dedupe |

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
`user_subscriptions(userId,status)`, plus moderation — `prompts(status,updatedAt)`,
`prompt_reports(promptId,status,createdAt)` and referrals —
`referral_codes(userId,isActive)`, `referrals(ipAddress,createdAt)`, `referrals(referrerId,createdAt)`.

---

## 7. Money & payouts model (manual settle, two-fee model)

```
Subscriptions  Buyer ──(₹/mo, Play Billing)──────────► Platform (recurring)
Paid prompts   Buyer ──(₹ = price + 5% tx fee)───────► Platform (one-time)
                                                        │  creator credited GROSS = full price
                                                        │  buyer's +5% = app income (never credited)
                                                        ▼
                                                 Creator wallet  (earnings bucket)
                                                        │  withdraw (min ₹60) → deduct withdrawal fee
                                                        │    (15% Pro / 5% Creator) — only fee at payout
                                                        │  admin transfers via OWN bank app
                                                        ▼
                                                 Creator's bank account (manual)
```

**Fees (see `plans/withdrawals.md` for the full model):**
- **5% buyer transaction fee** — charged on every paid prompt purchase (buyer pays
  `price + 5%`). This is app income and is never credited to any user.
- **Withdrawal (platform) fee** — deducted when the creator initiates a payout:
  **15%** (Pro seller) / **5%** (Creator seller). This is the *only* deduction at
  payout time.
- **Play Billing commission** (~15%) — Google's cut, absorbed by the platform at
  payment time. Tracked on `prompt_purchases.gatewayFeeInr` for reconciliation but
  never deducted at withdrawal.

- **Why manual:** Automatic third-party bank transfers are business-only (require a business
  entity), so
  a solo individual cannot create a payout route. Hence: creator requests → `payouts` row
  `pending` + balance reserved (ledger debit) → dev transfers from their own bank → admin marks
  `paid`. `mark-failed` reverses the reservation.
- Creator earnings are **full gross** at sale — credited to the wallet `earnings` bucket; the
  withdrawal fee is applied only at payout.
- **Deposit top-ups** credit `net` (price − gateway fee) to the wallet `deposits` bucket and
  recycle the gateway fee as a **bonus** vintage. Bonus is spend-capped (10% of item price),
  expires per-credit in 90 days (FEFO — oldest first), and is never withdrawable.
- **Payouts** debit the wallet `earnings` bucket (action: reserve); `mark-paid`/`mark-failed`
  are pure bookkeeping (reversal credits `earnings` back on failure).
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
| `PLAY_BILLING_PACKAGE_NAME` | Android package name for Play Billing verification |
| `GOOGLE_CLOUD_PROJECT` | GCP project for Play Billing (used by `googleapis`) |
| `RTDN_TOPIC` | Cloud Pub/Sub topic for Play Billing RTDN notifications |
| `RTDN_SUBSCRIPTION` | Pub/Sub subscription id for RTDN push endpoint |
| `PUBLIC_BASE_URL` | Canonical API base URL (CORS + urls.js) |
| `CORS_ORIGINS` | Extra allowed origins |
| `ADMIN_EMAILS` | Comma-separated admin emails (payout/import back-office) |
| `DEV_AUTH_PASSWORD` | Dev-only password fallback (never in prod) |
| `MIN_WITHDRAWAL_INR` | Minimum withdrawal (default 60) |
| `DEPOSIT_MIN_INR` / `DEPOSIT_MAX_INR` | Deposit pack bounds (default 10 / 10000) |
| `BONUS_EXPIRY_DAYS` | Bonus credit expiry (default 90) |
| `PLAY_BILLING_FEE_TOLERANCE_INR` | Reconciliation tolerance (default 0.01) |
| `REFERRAL_BONUS_INR` | Referrer bonus per successful referral (default 50) |
| `REFERRAL_WELCOME_BONUS_INR` | Referee welcome bonus (default 25) |
| `REFERRAL_MAX_PER_USER` | Max referrals per referrer (default 100) |
| `REFERRAL_MAX_PER_IP_PER_DAY` | Max referrals from one IP per day (default 5) |
| `MODERATION_REPORT_THRESHOLD` | Reports before a prompt soft-deletes itself (default 5) |
| `MODERATION_APPEAL_WINDOW_DAYS` | Creator appeal window after soft-delete (default 7) |

**Security hygiene:** never commit `.env` or service-account key files (gitignored). On Cloud Run,
secret values are pulled from Secret Manager at deploy time.

---

## 10. Deployment (Google Cloud Run — manual)

Deploys are **manual** — there is no CI/CD; push to GitHub does not auto-deploy.

Two Cloud Run services in project `playbold-promptly-prod` (region `us-west1`), both run as the
same service account and preserve their own env/secrets on deploy:

- **LIVE** service `promptly-ai-backend-git` — Firestore DB `promptly-ai`, CORS locked to the
  production web app. Run: `gcloud run deploy promptly-ai-backend-git --source . --region us-west1`.
- **DEV** service `promptly-ai-backend-dev` — Firestore DB `promptly-dev`, `DEV_AUTH_PASSWORD` set.
  Run: `gcloud run deploy promptly-ai-backend-dev --source . --region us-west1`.

Both use `--timeout 300` (5-minute request budget) for the bulk-upload path. A manual
`--source .` deploy preserves existing env/secret bindings (no env flags needed). See
`deploy.cloudrun.sh` for the canonical command.

**One-time setup (already done):**
1. Enable APIs: `firestore.googleapis.com`, `firebaseauth.googleapis.com`, `run.googleapis.com`,
   `artifactregistry.googleapis.com`, `secretmanager.googleapis.com`, and **Vision API** (for moderation).
2. Apply composite indexes + Firestore security rules (`firestore.indexes.json` / `firestore.rules`,
   deny-all for direct client access — the backend uses the Admin SDK which bypasses rules).
3. `npm run db:seed` once to create the starter plans + demo prompts.
4. Create Secret Manager secrets for SA creds; wire via `--set-secrets`.
5. Set `PLAY_BILLING_PACKAGE_NAME` and `RTDN_SUBSCRIPTION` env vars on the Cloud Run service.
6. Create a Cloud Pub/Sub **push** subscription for the Play Billing RTDN topic pointing at
   `https://<service-url>/webhooks/google/rtdn`.

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
npm run db:migrate-wallets  # once — migrate legacy user_balances → user_wallets
npm run wallet:expire       # daily — bonus vintage expiry sweep (or via Cloud Scheduler)
npm run dev                 # http://localhost:8080, hot reload
npm test                    # node:test unit tests (44 tests, no framework dep)
```

The Firebase emulator is supported via `FIRESTORE_EMULATOR_HOST`. Tests only exercise pure /
util modules (CSV, paging, prompt-import, metrics, rate-limit, balance-types, withdrawal-fees,
moderation-config, wallet-spend split, notifications) — none touch live Firestore.
