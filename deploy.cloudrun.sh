#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Deploy the Promptly AI backend to Google Cloud Run.
#
# Requires:
#   - gcloud authenticated (gcloud auth login) + a project set (gcloud config set project X)
#   - Firestore Native mode + Firebase Auth enabled
#
# Creates: an Artifact Registry repo (if missing) and a Cloud Run service using a
# container image, with secrets pulled from Secret Manager. Edit the secret names
# below to match the ones you create (see CLOUD_RUN_DEPLOYMENT.md §5).
# ------------------------------------------------------------------------------
set -euo pipefail

REGION="${REGION:-us-west1}"
SERVICE="${SERVICE:-promptly-ai-backend}"
# PROJECT_ID is read from gcloud if not provided.
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "$PROJECT_ID" ]]; then
  echo "Error: could not determine PROJECT_ID. Set PROJECT_ID or run gcloud config set project." >&2
  exit 1
fi

IMAGE="gcr.io/${PROJECT_ID}/${SERVICE}"

echo "Project:  ${PROJECT_ID}"
echo "Region:   ${REGION}"
echo "Service:  ${SERVICE}"
echo "Image:    ${IMAGE}"

# Build + push the image.
gcloud builds submit --tag "$IMAGE" .

# Deploy. Adjust secret references to match your Secret Manager entries.
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 5 \
  --timeout 300 \
  --set-env-vars "NODE_ENV=production,FIREBASE_PROJECT_ID=${PROJECT_ID},FIRESTORE_DATABASE=${FIRESTORE_DATABASE:-},PLAY_BILLING_PACKAGE_NAME=${PLAY_BILLING_PACKAGE_NAME:-},RTDN_SUBSCRIPTION=${RTDN_SUBSCRIPTION:-}" \
  --set-secrets \
    "FIREBASE_CLIENT_EMAIL=firebase-client-email:latest,FIREBASE_PRIVATE_KEY=firebase-private-key:latest"

URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')
echo
echo "Deployed: $URL"
echo "Set PUBLIC_BASE_URL=$URL and point the Play Billing RTDN Pub/Sub subscription at $URL/webhooks/google/rtdn."
