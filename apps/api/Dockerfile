# Multi-stage build for the Cosmika api (Nest.js).
# Final image is ~node:20.20.2-alpine + dist + node_modules (production only).

# ─── Stage 1: deps ─────────────────────────────────────────────────────────
# Node version is exact-pinned; keep in sync with .nvmrc and .gitlab-ci.yml.
FROM node:20.20.2-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.2 --activate
WORKDIR /workspace

# Copy workspace manifests for an isolated install.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/proto/package.json packages/proto/
COPY packages/eslint-config/package.json packages/eslint-config/

# Install full deps for the build stage (we'll prune in the final stage).
RUN pnpm install --frozen-lockfile --filter @cosmika/api... --filter @cosmika/shared... --filter @cosmika/db...

# ─── Stage 2: build ────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api

# Generate Prisma client + compile TS.
RUN pnpm --filter @cosmika/db generate
RUN pnpm --filter @cosmika/shared build
RUN pnpm --filter @cosmika/db build
RUN pnpm --filter @cosmika/api build

# ─── Stage 3: runtime ──────────────────────────────────────────────────────
FROM node:20.20.2-alpine AS runtime
RUN corepack enable && corepack prepare pnpm@9.15.2 --activate
# OpenSSL 3 is needed for prisma's musl-arm64-openssl-3 binary engine.
# libstdc++ is the runtime lib for the compiled isolated-vm native addon
# (the flow Code-block sandbox); the build toolchain is added/removed below.
RUN apk add --no-cache openssl libstdc++
WORKDIR /workspace

ENV NODE_ENV=production

# Copy the production workspace tree.
COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml /workspace/turbo.json /workspace/tsconfig.base.json ./
COPY --from=build /workspace/apps/api/package.json apps/api/
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY --from=build /workspace/packages/shared/package.json packages/shared/
COPY --from=build /workspace/packages/shared/dist packages/shared/dist
COPY --from=build /workspace/packages/db/package.json packages/db/
COPY --from=build /workspace/packages/db/dist packages/db/dist
COPY --from=build /workspace/packages/db/prisma packages/db/prisma
COPY --from=build /workspace/packages/proto/package.json packages/proto/
COPY --from=build /workspace/packages/eslint-config/package.json packages/eslint-config/

# Build deps (python3/make/g++) are needed only to compile the isolated-vm
# native addon during the prod install; they're added as a virtual package and
# removed in the same layer so they don't bloat the final image. If isolated-vm
# fails to build, it's an optional dependency — the install still succeeds and
# Code blocks fall back to a no-op (see flow-code-sandbox.ts).
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && pnpm install --frozen-lockfile --prod --filter @cosmika/api... \
  && pnpm --filter @cosmika/db generate \
  && apk del .build-deps

EXPOSE 3110
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3110/health || exit 1

CMD ["node", "apps/api/dist/main.js"]
