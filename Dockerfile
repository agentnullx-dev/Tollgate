# syntax=docker/dockerfile:1.7
# Multi-stage build:
#   dev     -> hot-reloading development server (used by docker-compose)
#   builder -> compiles the Next.js standalone bundle
#   runner  -> minimal, non-root production web/API image
#   worker  -> non-root background worker (notifications + anomaly engine)

ARG NODE_VERSION=22-alpine

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS base
RUN apk add --no-cache libc6-compat openssl wget
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
# The postinstall hook runs `prisma generate`, which needs the schema.
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

# ---------------------------------------------------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY . .
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
FROM deps AS builder
COPY . .
ENV NODE_ENV=production
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "server.js"]

# ---------------------------------------------------------------------------
FROM base AS worker
ENV NODE_ENV=production \
    WORKER_HEALTH_PORT=9100
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs worker
COPY --from=deps --chown=worker:nodejs /app/node_modules ./node_modules
COPY --chown=worker:nodejs package.json tsconfig.json ./
COPY --chown=worker:nodejs prisma ./prisma
COPY --chown=worker:nodejs src ./src
RUN npx prisma generate
USER worker
EXPOSE 9100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9100/healthz >/dev/null || exit 1
CMD ["npx", "tsx", "src/worker/index.ts"]
