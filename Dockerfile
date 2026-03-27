# syntax=docker/dockerfile:1
# Production image: Next.js + ffmpeg + Python (faster-whisper for scripts/transcribe.py)
#
# Clerk:
# - NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must be present when `npm run build` runs (builder stage).
#   Next.js inlines NEXT_PUBLIC_* into the client bundle at compile time.
# - CLERK_SECRET_KEY must NOT appear in this file: keep it runtime-only (e.g. Render dashboard
#   env on the running service). Do not ARG/ENV the secret into the image layers.
#
# Local development: use `npm run dev` + `.env.local` (not this Dockerfile). Optional:
#   docker build --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$(grep ...)" .

FROM node:20-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
RUN npm ci

# Build-time public key only (safe to pass as build-arg; also exposed in browser bundle).
# Empty ARG is OK for CI smoke builds; production images must pass a real pk_live_/pk_test_ value.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}

COPY . .
RUN npm run build

# --- Runtime ---
FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ffmpeg / ffprobe (lib/ffmpeg.ts); Python venv for faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

ENV PATH="/opt/venv/bin:$PATH"

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p storage \
    && chown -R node:node /app

# Render sets PORT; listen on all interfaces
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

USER node

CMD ["node", "server.js"]
