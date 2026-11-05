# Multi-stage build for the web app (Next.js 15, standalone output).

# ─── Stage 1: deps ─────────────────────────────────────────────────────────
# Node version is exact-pinned; keep in sync with .nvmrc and .gitlab-ci.yml.
FROM node:20.20.2-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.2 --activate
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY packages/eslint-config/package.json packages/eslint-config/

RUN pnpm install --frozen-lockfile --filter @cosmika/web... --filter @cosmika/shared... --filter @cosmika/ui...

# ─── Stage 2: build ────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/ui packages/ui
# `next build` runs ESLint, and apps/web/.eslintrc.json extends
# @cosmika/eslint-config/next. Only that package's package.json was copied, so
# the config file itself was missing and the build died with "Failed to load
# config ... to extend from". It stayed hidden while Docker served this layer
# from cache; the first real rebuild in a while surfaced it.
COPY packages/eslint-config packages/eslint-config
COPY apps/web apps/web

# Next.js inlines NEXT_PUBLIC_* into the client bundle at BUILD time — runtime
# env is too late. These must be supplied as build args (from compose/deploy),
# or the browser falls back to the localhost API base and every fetch fails.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_REALTIME_URL
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SUPPORT_EMAIL
ARG NEXT_PUBLIC_FINANCE_EMAIL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
ENV NEXT_PUBLIC_SUPPORT_EMAIL=$NEXT_PUBLIC_SUPPORT_EMAIL
ENV NEXT_PUBLIC_FINANCE_EMAIL=$NEXT_PUBLIC_FINANCE_EMAIL

RUN pnpm --filter @cosmika/shared build
RUN pnpm --filter @cosmika/web build

# ─── Stage 3: runtime ──────────────────────────────────────────────────────
FROM node:20.20.2-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.15.2 --activate
WORKDIR /workspace

ENV NODE_ENV=production
ENV PORT=3100

COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml /workspace/turbo.json /workspace/tsconfig.base.json ./
COPY --from=build /workspace/apps/web apps/web
COPY --from=build /workspace/packages/shared packages/shared
COPY --from=build /workspace/packages/ui packages/ui
COPY --from=build /workspace/packages/eslint-config/package.json packages/eslint-config/

RUN pnpm install --frozen-lockfile --prod --filter @cosmika/web...

EXPOSE 3100
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3100/ || exit 1

CMD ["pnpm", "--filter", "@cosmika/web", "start"]
