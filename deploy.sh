#!/bin/bash
# Automated deployment script for Visio Accessibility Agent
# Deploys to GCP Cloud Run with a single command
#
# Usage: ./deploy.sh [PROJECT_ID]
# Requires: gcloud CLI authenticated, Docker, GOOGLE_API_KEY in .env

set -e

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null)}"
SERVICE_NAME="visio-agent"
REGION="us-central1"
IMAGE="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No GCP project ID. Pass as argument or set via 'gcloud config set project PROJECT_ID'"
  exit 1
fi

# Load API key from .env
if [ -f .env ]; then
  GOOGLE_API_KEY=$(grep GOOGLE_API_KEY .env | cut -d '=' -f2)
fi

if [ -z "$GOOGLE_API_KEY" ]; then
  echo "Error: GOOGLE_API_KEY not found in .env"
  exit 1
fi

echo "Deploying Visio to Cloud Run..."
echo "  Project: ${PROJECT_ID}"
echo "  Region:  ${REGION}"
echo "  Image:   ${IMAGE}"

# Enable required GCP APIs
echo "Enabling GCP APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  logging.googleapis.com \
  --project "${PROJECT_ID}" --quiet 2>/dev/null || true

# Build container image using Cloud Build
echo "Building container image..."
gcloud builds submit --tag "${IMAGE}" --project "${PROJECT_ID}" --quiet

# Deploy to Cloud Run
echo "Deploying to Cloud Run..."
gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE}" \
  --port 8080 \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_API_KEY=${GOOGLE_API_KEY},GOOGLE_GENAI_USE_VERTEXAI=FALSE" \
  --memory 1Gi \
  --cpu 2 \
  --timeout 3600 \
  --concurrency 10 \
  --quiet

# Get the service URL
URL=$(gcloud run services describe "${SERVICE_NAME}" --region "${REGION}" --project "${PROJECT_ID}" --format 'value(status.url)')

echo ""
echo "Deployment complete!"
echo "Visio is live at: ${URL}"
echo "Health check: ${URL}/health"
