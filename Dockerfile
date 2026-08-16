# Promptly AI backend — Google Cloud Run container.
# Build:            gcloud builds submit --tag gcr.io/$PROJECT_ID/promptly-ai-backend .
# Deploy to Run:    gcloud run deploy promptly-ai-backend --image gcr.io/$PROJECT_ID/promptly-ai-backend ...
# (or deploy from source: gcloud run deploy --source . — see README.)

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Install production dependencies only (smaller image, no dev tooling).
COPY package*.json ./
RUN npm ci --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app

# Non-root user for Cloud Run hardening.
RUN groupadd --system nodejs && useradd --system --gid nodejs nodeuser

# Copy the app + production deps.
COPY --from=build --chown=nodeuser:nodejs /app/node_modules ./node_modules
COPY --chown=nodeuser:nodejs . .

USER nodeuser

# Cloud Run sets PORT (default 8080) and expects 0.0.0.0 — handled in src/server.js.
ENV PORT=8080
EXPOSE 8080

# Health-check for Cloud Run.
HEALTHCHECK --interval=30s --timeout=3s --retries=2 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
