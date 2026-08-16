# Promptly AI Backend — Google Cloud Run + Firebase Firestore Deployment

Migrated from a Render (Node + Express + PostgreSQL) deployment to **Google Cloud
Run** with **Firebase Firestore** as the database, **Firebase Auth** for identity,
and **Razorpay** for payments (unchanged).

> ⚠️ Requires the `gcloud` CLI (authenticated) and a Google Cloud project with
> Firestore + Firebase Auth enabled.

---

## 1. Files changed / created / removed

**Created**
- `Dockerfile` — Cloud Run container (Node 20, prod-only deps, non-root).
- `.dockerignore` — excludes secrets, node_modules, local git/config.
- `src/db/firestore.js` — Firebase Admin init (Firestore + Auth digests).
- `src/db/firestoreRepo.js` — Firestore data-access helpers (transactions, queries).
- `src/services/payments/subscription-utils.js` — shared subscription-with-plan reader.
- `firestore.indexes.json` — required composite indexes.
- `firestore.rules` + `firebase.json` — **deny-all** client access rules (decision:
  all reads/writes go through the Express API; see §4.1).
- `src/middleware/rateLimit.js` — in-memory fixed-window limiter (auth + money routes).
- `test/*` — unit tests (`npm test`, Node built-in `node:test`).
- `CLOUD_RUN_DEPLOYMENT.md` — this doc.
- `deploy.cloudrun.sh` — one-command deploy helper.

**Changed**
- `src/db/config.js` → Firestore connection + `runTransaction` + `pingDb`.
- `src/db/models.js`, `src/db/models/*` → removed (replaced by Firestore collections).
- `src/db/{sync,seed,reset}.js` → Firestore equivalents (schema-less; seed/reset/clear).
- `src/server.js` → binds `0.0.0.0`, uses `PORT` (default 8080), Firestore ping.
- `src/config/env.js` → `FIREBASE_PROJECT_ID` + Firebase SA keys; drops `DATABASE_URL`.
- `src/config/urls.js` → Cloud Run URL via `PUBLIC_BASE_URL`.
- `src/middleware/auth.js` → **Firebase Auth** ID-token verification.
- `src/routes/auth.js` → `/auth/login` (Firebase) + dev-only `/auth/dev/login`.
- All services (`prompts`, `me`, `ledger`, `earnings`, `checkout`, `payouts`,
  `subscriptions`, `webhooks`) → Firestore reads/writes + **Firestore transactions**
  for every money mutation (unlock, payout reserve, activation, payout-fail reversal).
- `package.json` → added `firebase-admin`, removed `pg`, `pg-hstore`, `sequelize`.
- `.env.example` → Firestore/Cloud Run variables (names only, no secrets).

**Removed**
- All Sequelize model files under `src/db/models/` and `src/db/models.js`.

---

## 2. Firestore structure

| Collection | Doc id | Notes |
|---|---|---|
| `users` | Firebase UID (or `demo_creator`) | `authProviderId, email, fullName, avatarUrl, role, upiId, timestamps` |
| `subscription_plans` | plan id (`free`/`pro`/`creator`) | price, fee %, limits |
| `prompts` | slug/auto | title, description, promptText, imageUrl, category, tags, isPaid, priceInr, status, viewCount, saveCount |
| `prompt_purchases` | `buyerId_promptId` | one unlock per buyer/prompt (deterministic id) |
| `transactions` | auto | ledger: userId, type, direction, amountInr, balanceAfterInr, refId, note |
| `user_balances` | userId | running `balanceInr` (maintained in transactions) |
| `payouts` | auto | userId, amountInr, status, upiId, processedAt, failureReason |
| `saved_prompts` | `userId_promptId` | savedAt |
| `user_subscriptions` | `sub_<razorpaySubId>` | userId, planId, status, period dates |
| `webhook_events` | sha256 dedupe key | provider, eventName, payload, processedAt |
| `user_posts`, `bank_accounts`, `kyc_verifications` | auto | kept for schema completeness |

Money-critical writes (unlock, payout reservation, subscription activation, payout
fail-reversal) run inside **Firestore multi-document transactions** for all-or-nothing
guarantees; the running balance lives in `user_balances` and is snapshotted per row.

## 3. Google Cloud Storage

No upload endpoints exist in the backend today (prompt images are external URLs).
If you add image uploads later, store bytes in **Cloud Storage** and keep only the
`gs://`/public URL in Firestore.

---

## 4. Required Google Cloud services

1. **Firestore** (Native mode) database.
2. **Firebase Authentication** (enable the sign-in methods your app uses).
3. **Cloud Run** (serverless container).
4. **Artifact Registry** (container image backing store).
5. **Secret Manager** (Razorpay + Firebase SA secrets — recommended).
6. *(Optional)* **Cloud Storage** for uploads only.

## 4.1 Firestore security rules — decision

All app reads/writes go through this Express API (Cloud Run, Admin SDK). The
`firestore.rules` file is **deny-all** (`allow read, write: if false`) so a
future accidental client-side Firestore connection can't expose paid prompt
text, PII, or the ledger. If the mobile app ever reads Firestore directly, relax
only the specific collections/fields it needs and keep writes server-side.
Rules + indexes deploy together via `npx firebase deploy --only firestore`.

## 5. Required environment variables

Set these on the Cloud Run service (recommended: sensitive ones via Secret Manager):

| Variable | Secret? | Notes |
|---|---|---|
| `PORT` | no | injected by Cloud Run (8080 default) |
| `NODE_ENV` | no | `production` |
| `FIREBASE_PROJECT_ID` | no | GCP project id |
| `FIRESTORE_DATABASE` | no | Firestore database id — set to your named database if you created one (e.g. `promptly-ai`); empty = `(default)` |
| `FIREBASE_CLIENT_EMAIL` | yes | service-account email |
| `FIREBASE_PRIVATE_KEY` | yes | service-account private key (`\\n` escaped) |
| `GOOGLE_APPLICATION_CREDENTIALS` | alt | path to mounted SA JSON instead |
| `STORAGE_BUCKET` | no | only if uploads added |
| `RAZORPAY_KEY_ID` | yes | |
| `RAZORPAY_KEY_SECRET` | yes | |
| `RAZORPAY_WEBHOOK_SECRET` | yes | |
| `RAZORPAY_PLAN_PRO_ID` | yes | |
| `RAZORPAY_PLAN_CREATOR_ID` | yes | |
| `PUBLIC_BASE_URL` | no | Cloud Run HTTPS URL |
| `CORS_ORIGINS` | no | extra browser origins |
| `ADMIN_EMAILS` | yes* | admin payout emails |
| `MIN_WITHDRAWAL_INR` | no | default 60 |

## 6. One-time Firebase Firestore setup

```bash
# Enable APIs
gcloud services enable \
  firestore.googleapis.com \
  firebaseauth.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com

gcloud auth application-default login   # local dev creds

# Enable Firestore Native mode via console, then:
npx firebase login
npx firebase deploy --only firestore   # creates composite indexes + applies deny-all rules
```

Create the service-account and give it Firestore data access:
```bash
gcloud iam service-accounts create promptly-ai-sa \
  --display-name "Promptly AI backend SA"
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:promptly-ai-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user"
# Also required — the Admin SDK verifies tokens with checkRevoked=true and calls
# Identity Platform's GetAccountInfo API. Without roles/firebaseauth.admin every
# /auth/login returns 401 "Invalid or expired Firebase token".
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:promptly-ai-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/firebaseauth.admin"
```

## 7. Deploy to Cloud Run

```bash
# Recommended (build from source):
gcloud run deploy promptly-ai-backend \
  --source . \
  --region us-west1 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 5 \
  --set-env-vars NODE_ENV=production,FIREBASE_PROJECT_ID=$PROJECT_ID,PUBLIC_BASE_URL=https://promptly-ai-backend-<hash>.run.app \
  --set-secrets RAZORPAY_KEY_ID=razorpay-key-id:latest,RAZORPAY_KEY_SECRET=razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=razorpay-webhook-secret:latest,FIREBASE_PRIVATE_KEY=firebase-private-key:latest,FIREBASE_CLIENT_EMAIL=firebase-client-email:latest,RAZORPAY_PLAN_PRO_ID=razorpay-plan-pro:latest,RAZORPAY_PLAN_CREATOR_ID=razorpay-plan-creator:latest
```

Or with `gcloud auth configure-docker` + Buildpacks:
```bash
./deploy.cloudrun.sh
```

Grab the generated HTTPS URL:
```bash
gcloud run services describe promptly-ai-backend --region us-west1 --format 'value(status.url)'
```

Set it as `PUBLIC_BASE_URL` (and the Android client's `BASE_URL`).

## 8. Razorpay webhook URL

Point Razorpay's webhook (Dashboard → Settings → Webhooks) to:

```
https://<CLOUD-RUN-URL>/webhooks/razorpay
```

The event logging, HMAC verification and idempotent dedupe are preserved (backed
by Firestore `webhook_events`).

## 9. Android/Web API URL to change

`app/src/main/java/com/example/promptlyai/data/remote/PromptlyApi.kt` — `BASE_URL`
currently defaults to the old Render URL. Point it at the Cloud Run URL (see the
env-configurable `buildConfigField` in the migration; it's already wired to
`BuildConfig.API_BASE_URL`).

## 10. Remaining manual steps

1. Enable Firestore (Native) + Firebase Auth in your GCP project.
2. Create the service account + Secret Manager secrets listed in §5.
3. `firebase deploy --only firestore` (indexes + deny-all rules).
4. Add the Firebase Android (`google-services.json`) / Web config to the client and
   implement sign-in; the backend `requireAuth` already verifies ID tokens and maps
   UID → user.
5. Switch the Android `BASE_URL` to the Cloud Run URL (and remove the dev token
   path — `/auth/dev/login` is disabled in production).
6. Update the Razorpay webhook URL to `.../webhooks/razorpay`.
7. `npm run db:seed` once against Firestore for the starter plans/prompts.
8. Run `npm test` before deploy — unit tests cover prompt metrics, signature
   verification, and the rate limiter (no DB needed).

## 11. Endpoint inventory (unchanged)

```
GET  /health
POST /auth/login                 (new — Firebase)
POST /auth/dev/login             (dev only)
GET  /prompts                    (?category, ?paid, ?sort, ?q, ?limit, ?offset)
GET  /prompts/:id
POST /prompts                    (creator publish — plan gates, owner = caller)
POST /prompts/:id/save
POST /prompts/:id/unsave
GET  /me/profile
GET  /me/prompts
GET  /me/saved
GET  /me/transactions
GET  /me/earnings
GET  /me/earnings/prompts
POST /me/upi
POST /payments/checkout/order
POST /payments/checkout/verify
POST /payments/subscriptions
POST /payments/payouts
GET  /payments/admin/payouts          (admin)
POST /payments/admin/payouts/:id/mark-paid   (admin)
POST /payments/admin/payouts/:id/mark-failed (admin)
POST /webhooks/razorpay
```
