# CI/CD — One-time Google Cloud Workload Identity Federation setup

The GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys to Cloud Run
on pushes:

- **master** → live (`promptly-ai-backend-git`) **and** dev (`promptly-ai-backend-dev`), plus Firestore indexes on both databases.
- **feature/\*** → dev only + dev indexes.

It authenticates to Google Cloud with **Workload Identity Federation** (no
long-lived service-account keys stored in GitHub). Run the setup below once per
project. Everything is idempotent — safe to re-run.

---

## 0. Prerequisites

- `gcloud` authenticated and pointed at the project: `gcloud config set project playbold-promptly-prod`
- GitHub repo: `playboldstudio/Promptly-AI-Backend`

## 1. Create the Workload Identity Pool + OIDC provider

```bash
export PROJECT_ID=playbold-promptly-prod
export GITHUB_ORG=playboldstudio
export REPO=Promptly-AI-Backend

# Pool
gcloud iam workload-identity-pools create "github-actions" \
  --project "$PROJECT_ID" \
  --location "global" \
  --display-name "GitHub Actions pool"

# OIDC provider bound to this repo
gcloud iam workload-identity-pools providers create-oidc "github" \
  --project "$PROJECT_ID" \
  --location "global" \
  --workload-identity-pool "github-actions" \
  --display-name "GitHub" \
  --issuer-uri "https://token.actions.githubusercontent.com" \
  --attribute-mapping "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
  --attribute-condition "assertion.repository_owner == '$GITHUB_ORG' && attribute.repository == '$GITHUB_ORG/$REPO'"
```

Take a note of two values for the repo secrets:

```bash
# Provider resource name (for the WIF_PROVIDER secret):
gcloud iam workload-identity-pools providers describe "github" \
  --project "$PROJECT_ID" \
  --location "global" \
  --workload-identity-pool "github-actions" \
  --format "value(name)"

# Service account email (for WIF_SERVICE_ACCOUNT):
gcloud iam service-accounts list --project "$PROJECT_ID" \
  --filter "email:deploy" --format "value(email)"
```

## 2. Service account + IAM bindings

Create a dedicated deploy service account and grant it the minimum rights the
workflow needs (deploy Cloud Run from source, and create Firestore indexes):

```bash
SA_EMAIL="cloud-run-deploy@$PROJECT_ID.iam.gserviceaccount.com"

gcloud iam service-accounts create "cloud-run-deploy" \
  --project "$PROJECT_ID" \
  --display-name "Cloud Run deployer"

# Allow the WIF identity (any branch) to act as this SA
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT_ID" \
  --role "roles/iam.workloadIdentityUser" \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/$GITHUB_ORG/$REPO"

# Deploy Cloud Run services + Firestore indexes.
# (Add --condition=None to each if the project IAM policy already has conditional
# bindings — gcloud refuses to add an unconditional binding otherwise.)
for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/artifactregistry.admin roles/datastore.owner; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:$SA_EMAIL" \
    --role "$ROLE" \
    --condition=None   # or drop this if the policy has no other conditions
done
```

> `PROJECT_NUMBER` — get it with `gcloud projects describe $PROJECT_ID --format "value(projectNumber)"`.

> For `--source .` builds, the deploy SA also needs to impersonate the runtime
> service account of each Cloud Run service (or you give the deploy SA
> `roles/iam.serviceAccountUser` on them). The roles above cover the common case;
> if a deploy fails with a permissions error about the service account, add the
> runtime SA emails to the binding above.

## 3. Add the GitHub Action secrets

Repo → **Settings → Secrets and variables → Actions** → add:

| Secret | Value |
|---|---|
| `WIF_PROVIDER` | the provider resource name from step 1 |
| `WIF_SERVICE_ACCOUNT` | `cloud-run-deploy@playbold-promptly-prod.iam.gserviceaccount.com` |

## 4. Allow the deploy SA to impersonate the services' runtime accounts

Each Cloud Run service has a runtime service account. `deploy-cloudrun@v2` with
`source: .` needs to act on behalf of that account. If the services use the
**default compute SA**, grant the deploy SA `roles/iam.serviceAccountUser` on it
(generally already implied by the project-level role). If they use a **custom
runtime SA** (e.g. `promptly-ai-sa`), add:

```bash
RUNTIME_SA="promptly-ai-sa@$PROJECT_ID.iam.gserviceaccount.com"
gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project "$PROJECT_ID" \
  --role "roles/iam.serviceAccountUser" \
  --member "serviceAccount:cloud-run-deploy@$PROJECT_ID.iam.gserviceaccount.com" \
  --condition=None   # needed if the SA policy has other conditions
```

## 5. Disable the old Cloud Run git-integration (avoids double deploys)

The live service `promptly-ai-backend-git` is currently auto-deployed by a
Cloud Run **"Deploy from Git"** webhook on master pushes. Once this workflow is
live, that same webhook would race the workflow and deploy the same service
twice. To keep a single source of truth for deployments:

1. Cloud Run console → the `promptly-ai-backend-git` service → **Triggers** (or
   **Set up continuous deployment**).
2. Delete / disconnect the GitHub repository binding (the `webhook-live` entry).
3. Keep the GitHub Actions workflow as the only deploy path.

(If you'd rather keep the webhook for live, then **remove the `deploy-live` job**
from the workflow and use the webhook for live + the workflow for dev only.)

## 6. Test

Push a branch to `feature/*` (deploys dev) — check the Actions tab. Then push to
`master` (deploys live + dev) and verify both service URLs are updated and the
health endpoints are green.

---

## How deploys keep their env

The workflow calls `deploy-cloudrun@v2` with only `service`, `region`, and
`source`. It does **not** pass `env_vars`/`secrets`, so Cloud Run preserves each
service's existing environment (Firestore DB, Razorpay keys, `DEV_AUTH_PASSWORD`,
`PUBLIC_BASE_URL`). Keep it that way — don't add env flags here, or you'll wipe
the service config.
