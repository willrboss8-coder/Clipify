# syntax=docker/dockerfile:1
# Production image: Next.js + ffmpeg + Python (faster-whisper for scripts/transcribe.py)

FROM node:20-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json* ./
RUN npm ci

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
