# syntax=docker/dockerfile:1.7
# Multi-target image for the monorepo: `api`, `worker`, `web`.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/router/package.json packages/router/
COPY packages/gtfs/package.json packages/gtfs/
COPY packages/db/package.json packages/db/
COPY packages/ingest/package.json packages/ingest/
COPY packages/bench/package.json packages/bench/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS source
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY data data

# ---------------------------------------------------------------- API (TypeScript run via tsx)
FROM source AS api
ENV NODE_ENV=production OPENBUS_ROOT=/app PORT=4080
EXPOSE 4080
WORKDIR /app/apps/api
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ---------------------------------------------------------------- worker
FROM source AS worker
ENV NODE_ENV=production OPENBUS_ROOT=/app
WORKDIR /app/apps/worker
CMD ["pnpm", "exec", "tsx", "src/index.ts"]

# ---------------------------------------------------------------- web (Next.js standalone)
FROM source AS web-build
ARG API_URL=http://api:4080
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @openbus/web build

FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
