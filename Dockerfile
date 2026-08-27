# syntax=docker/dockerfile:1

# ─── Stage 1: install dependencies (cached separately from source changes) ──
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ─── Stage 2: build TypeScript + generate the Prisma client ─────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate
RUN npm run build
# Prune devDependencies out of node_modules now that the build is done, so
# the runtime stage can copy a single, already-production-only node_modules
# instead of running a second `npm ci --omit=dev` (faster, one less step
# that can drift from the build-stage install).
RUN npm prune --omit=dev

# ─── Stage 3: slim runtime image ─────────────────────────────────────────────
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user — the image ships with a `node` user already.
RUN mkdir -p /app/dist && chown -R node:node /app
USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server.js"]
