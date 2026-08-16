# Deploying the Promptly AI Backend — Beginner's Step-by-Step Guide

> Written for someone who has **never deployed anything**. Every command is exact
> and PowerShell-ready (Windows). Read top-to-bottom; each step builds on the last.
> You only do most steps **once**.

## What you're building toward

At the end you have a live HTTPS URL like `https://promptly-ai-backend-xxxx.run.app`
that anyone can call (login, browse prompts, pay, etc.).

```
Your laptop ──push code──► GitHub
Your laptop ──gcloud CLI──► Google Cloud (builds + deploys your code to Cloud Run)
Cloud Run ──reads/writes──► Firestore (database)  +  Firebase Auth (logins)
Razorpay (payments) ──webhook──► your Cloud Run URL
```

---

## Step 0 — Accounts (do this first, ~20 min)

1. **Google account** → https://console.cloud.google.com
2. **GitHub account** → https://github.com (your repo is already there)
3. **Razorpay account** → https://dashboard.razorpay.com (you'll only use *test* keys)

---

## Step 1 — Install tools on your PC

| Tool | Why | Download |
|---|---|---|
| **Node.js (LTS, 20+)** | Runs your code locally | https://nodejs.org |
| **Git** | Pulls/pushes code | https://git-scm.com/download/win |
| **Google Cloud CLI** | The main deploy tool | https://cloud.google.com/sdk/docs/install |

After each install, **close and reopen your terminal**, then verify:

```powershell
node --version        # prints v20 or higher
git --version         # prints a version
gcloud --version      # prints a version
```

---

## Step 2 — Log in to Google Cloud (one-time)

```powershell
gcloud auth login
# browser opens → pick your Google account → Allow

gcloud auth application-default login
# browser opens again → Allow
```

Check the active project:

```powershell
gcloud config get-value project
```

If empty/wrong, create + set one. **Write the project ID down — use it everywhere below:**

```powershell
# Project ID looks like "my-project-123456" (not the display name).
gcloud projects create YOUR-PROJECT-ID --name="Promptly AI"
gcloud config set project YOUR-PROJECT-ID
```

---

## Step 3 — Create a Firestore database (console)

1. https://console.cloud.google.com → select your project
2. Search **Firestore** → open it
3. **Select Native mode** → location **us-central1** → **Create database**

> *Native mode* is required — this codebase is built for it.

---

## Step 4 — Enable Firebase Authentication (console)

1. https://console.firebase.google.com → **Add project** → select your GCP project
2. **Build → Authentication → Get started**
3. Enable the sign-in methods your app uses (Email/Password, Google, ...)

---

## Step 5 — Enable the required Google APIs

```powershell
gcloud services enable firestore.googleapis.com firebaseauth.googleapis.com run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

*(Each prints "Operation finished" — success.)*

---

## Step 6 — Create a service account

A **service account** is a robot identity that lets Cloud Run talk to Firestore.

```powershell
gcloud iam service-accounts create promptly-ai-sa --display-name "Promptly AI backend SA"

gcloud projects add-iam-policy-binding YOUR-PROJECT-ID `
  --member="serviceAccount:promptly-ai-sa@YOUR-PROJECT-ID.iam.gserviceaccount.com" `
  --role="roles/datastore.user"

# Also required: the backend verifies ID tokens with checkRevoked=true (auth.js),
# which calls the Identity Platform GetAccountInfo API — without this role every
# login returns 401 "Invalid or expired Firebase token".
gcloud projects add-iam-policy-binding YOUR-PROJECT-ID `
  --member="serviceAccount:promptly-ai-sa@YOUR-PROJECT-ID.iam.gserviceaccount.com" `
  --role="roles/firebaseauth.admin"
```

> Replace `YOUR-PROJECT-ID` both times, for both bindings.

---

## Step 7 — Create the Secret Manager secrets

Secrets keep sensitive values out of code and env vars. Create **one per value**:

| Secret name | Value |
|---|---|
| `razorpay-key-id` | Razorpay Dashboard → Settings → API Keys (`rzp_test_...`) |
| `razorpay-key-secret` | same page |
| `razorpay-webhook-secret` | you make this up, e.g. `my_webhook_secret_123` |
| `razorpay-plan-pro` | `plan_...` from Razorpay → Settings → Plans (Step 9) |
| `razorpay-plan-creator` | `plan_...` from the same place (Step 9) |
| `firebase-client-email` | the service-account email (below) |
| `firebase-private-key` | the service-account private key (below) |

Get the service-account key file:

```powershell
gcloud iam service-accounts keys create firebase-sa-key.json `
  --iam-account="promptly-ai-sa@YOUR-PROJECT-ID.iam.gserviceaccount.com"
```

Open `firebase-sa-key.json` in Notepad. Copy:
- `"client_email"` → into `firebase-client-email`
- `"private_key"` → into `firebase-private-key`

Create each secret with PowerShell (the `|` pipe feeds the value in):

> ⚠️ **Gotcha — the `|` pipe appends a CRLF newline** to the stored value. Secret
> Manager stores those bytes verbatim, and Cloud Run mounts them as-is. A Razorpay
> key/plan ID with a trailing newline makes the app fail with
> `Authentication failed` (401) or `The plan id must be 19 characters`. Use the
> `Set-SecretValue` helper below instead of the bare pipe for keys and IDs.

```powershell
# Helper: write a value with NO trailing newline, then create the secret.
function Set-SecretValue($name, $value) {
  $tmp = "$env:TEMP\$name.txt"
  [System.IO.File]::WriteAllBytes($tmp, [System.Text.Encoding]::ASCII.GetBytes($value))
  gcloud secrets create $name --data-file=$tmp
  Remove-Item $tmp -Force
}

Set-SecretValue razorpay-key-id "rzp_test_XXXXXXXX"
Set-SecretValue razorpay-key-secret "rzp_test_XXXXXXXX"
Set-SecretValue razorpay-webhook-secret "my_webhook_secret_123"
Set-SecretValue firebase-client-email "promptly-ai-sa@YOUR-PROJECT-ID.iam.gserviceaccount.com"
# private key is multiline — paste from the JSON file, not from memory
Get-Content firebase-sa-key.json -Raw | Select-String -Pattern '"private_key":\s*"(.*?)"' -AllMatches | ForEach-Object { $_.Matches[0].Groups[1].Value } | gcloud secrets create firebase-private-key --data-file=-
# the two plan IDs — run AFTER Step 9
Set-SecretValue razorpay-plan-pro "plan_xxx"
Set-SecretValue razorpay-plan-creator "plan_xxx"
```

Give Cloud Run permission to read each secret:

```powershell
gcloud secrets add-iam-policy-binding razorpay-key-id `
  --member="serviceAccount:promptly-ai-sa@YOUR-PROJECT-ID.iam.gserviceaccount.com" `
  --role="roles/secretmanager.secretAccessor"
# repeat for all 7 secrets
```

---

## Step 8 — Deploy indexes + security rules

```powershell
npx firebase login
# browser opens → Allow

npx firebase deploy --only firestore
# creates composite indexes + applies the deny-all rules (firebase.json + firestore.rules)
```

---

## Step 9 — Create the Razorpay subscription plans (console)

1. https://dashboard.razorpay.com → **Settings → Plans** → **Create plan**
2. **Pro**: amount `49`, Monthly → copy its `plan_xxx` id → save as `razorpay-plan-pro`
3. **Creator**: amount `99`, Monthly → copy its `plan_xxx` id → save as `razorpay-plan-creator`

Set the webhook secret too: **Settings → Webhooks** (URL added in Step 12).

---

## Step 10 — Seed the database (add starter data, once)

From the project folder:

```powershell
$env:FIREBASE_PROJECT_ID = "YOUR-PROJECT-ID"
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\full\path\to\firebase-sa-key.json"

npm install
npm run db:seed
# → "✅ Seed complete." (3 plans + 5 demo prompts + demo creator)
```

---

## Step 11 — Deploy to Cloud Run (the big moment)

```powershell
gcloud run deploy promptly-ai-backend --source . --region us-west1 --allow-unauthenticated
```

- `--source .` → Cloud Run uploads this folder, builds it (via `Dockerfile`), deploys
- `--allow-unauthenticated` → anyone can hit the URL (your own auth checks protect the data)
- Accept the prompts / defaults. Takes ~3–5 min.

It prints your URL:

```
Service URL: https://promptly-ai-backend-XXXXXX-uc.a.run.app
```

**Save it** — you need it twice.

---

## Step 12 — Wire up env vars + the Razorpay webhook

```powershell
gcloud run services update promptly-ai-backend --region us-west1 `
  --set-env-vars "NODE_ENV=production,FIREBASE_PROJECT_ID=YOUR-PROJECT-ID,PUBLIC_BASE_URL=https://promptly-ai-backend-XXXXXX-uc.a.run.app" `
  --set-secrets "RAZORPAY_KEY_ID=razorpay-key-id:latest,RAZORPAY_KEY_SECRET=razorpay-key-secret:latest,RAZORPAY_WEBHOOK_SECRET=razorpay-webhook-secret:latest,FIREBASE_CLIENT_EMAIL=firebase-client-email:latest,FIREBASE_PRIVATE_KEY=firebase-private-key:latest,RAZORPAY_PLAN_PRO_ID=razorpay-plan-pro:latest,RAZORPAY_PLAN_CREATOR_ID=razorpay-plan-creator:latest"
```

Then **Razorpay Dashboard → Settings → Webhooks**:

```
Webhook URL: https://promptly-ai-backend-XXXXXX-uc.a.run.app/webhooks/razorpay
Secret:      (the webhook secret from Step 7)
Events:      payment.captured, subscription.charged, subscription.cancelled, subscription.expired
```

---

## Step 13 — Verify it's alive

```powershell
Invoke-RestMethod "https://promptly-ai-backend-XXXXXX-uc.a.run.app/health"
# → { status = "ok"; db = "up"; ... }
```

`db = "up"` = deployed + Firestore reachable. `db = "down"` = service-account/secret wiring issue.

---

## Step 14 — Point the Android app at it

Set the Android release `API_BASE_URL` to the Cloud Run URL (README: wired via
`BuildConfig.API_BASE_URL` / `-PAPI_BASE_URL=...`), and swap Razorpay test keys for
live ones before real money.

---

## Common gotchas

| Symptom | Cause / fix |
|---|---|
| "Permission denied" / IAM errors | Missed a `add-iam-policy-binding` in Step 7 for that secret |
| `db = "down"` | `FIREBASE_PRIVATE_KEY` wrong, or SA lacks `roles/datastore.user` (Steps 6–7) |
| Payments return "501 Not configured" | `RAZORPAY_KEY_ID`/`SECRET` secrets not attached (Step 12) |
| Webhook returns 401 | Razorpay webhook secret ≠ the `razorpay-webhook-secret` secret |
| Login returns 401 "Invalid or expired Firebase token" | SA missing `roles/firebaseauth.admin` (Step 6) — token verification calls GetAccountInfo, which that role gates |
| Private key corrupt | Keep literal `\n` newlines — paste from the JSON file, don't retype |
| Payments return 401 / "plan id must be 19 characters" | Secret value has a trailing CRLF from the `\|` pipe — recreate it without the newline (see Step 7's `Set-SecretValue`) |
| Redeploy after code changes | Just re-run Step 11 |