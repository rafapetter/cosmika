# Cosmika

An AI-first help desk: a shared inbox for WhatsApp, e-mail, web widget and
API channels, with an AI agent that answers customers, a visual bot-flow
builder, and an admin assistant that configures the workspace from plain
language.

Built by [CosmoBots](https://cosmobots.io) (CosmoBots Desenvolvimento de Sistemas Ltda). Released under the MIT license.

## What's inside

- **Inbox and conversations** — assignment, teams, labels, SLA policies,
  CSAT surveys, canned responses, internal notes, saved views.
- **AI agent** — answers from your knowledge base, hands off to a human,
  tags and prioritizes; drafts replies for review or sends on its own.
- **Bot flows** — a deterministic flow engine with a visual editor (menus,
  buttons and lists, conditions, variables, webhook and code blocks).
- **Admin assistant** — ask about the workspace in plain language (volume,
  CSAT, AI spend, audit log) and have it build or edit bot flows, adjust the
  AI agent, member roles, labels and canned responses.
- **Record grids** — contacts and tickets as editable, filterable tables.
- **Channels** — WhatsApp Cloud API (including media and delivery
  receipts), e-mail, embeddable web widget, REST API with webhooks.
- **Languages** — Portuguese (Brazil), Spanish and English.

## Stack

| Layer | Technology |
| --- | --- |
| Web | Next.js 15 (App Router), React 19, Tailwind |
| API | NestJS (Fastify), Prisma, Anthropic SDK |
| Realtime | Go WebSocket gateway |
| Data | PostgreSQL with pgvector, Redis |
| Monorepo | Turborepo + pnpm |

```
apps/
  web/        Next.js frontend
  api/        NestJS backend (REST, AI agents, channel webhooks)
  realtime/   Go WebSocket gateway
packages/
  db/         Prisma schema and client
  shared/     Zod schemas, i18n, shared types
  ui/         Component library and Tailwind preset
  proto/      Cross-language event schemas
  eslint-config/
scripts/      End-to-end and smoke tests
```

## Running locally

Requirements: Node 20 (see `.nvmrc`), pnpm 9, Docker, Go 1.25 for the
realtime gateway.

```bash
pnpm install
pnpm infra:up                                   # Postgres + Redis
pnpm db:generate
pnpm --filter @cosmika/db exec prisma migrate deploy
pnpm dev
```

| Service | Port |
| --- | --- |
| web | 3100 |
| api | 3110 |
| realtime | 3120 |
| postgres | 5433 |
| redis | 6379 |

Copy each `apps/*/.env.example` to `.env` and fill in your own values. Set
`COSMIKA_AI_STUB=1` to run without an AI provider key.

## Self-hosting

`docker-compose.production.yml` runs the whole stack (Postgres with
pgvector, Redis, api, realtime, web) on one machine. Ports bind to
`127.0.0.1` only: put a reverse proxy with TLS in front (Caddy, nginx,
Traefik).

```bash
cp .env.production.example .env.production   # fill in your own values
COMPOSE="docker compose -f docker-compose.production.yml --env-file .env.production"
$COMPOSE build
$COMPOSE up -d postgres redis
$COMPOSE run --rm --entrypoint sh api -c "cd /workspace/packages/db && npx prisma migrate deploy"
$COMPOSE up -d
```

Run the same `migrate deploy` line after every upgrade, before `up -d`.

What you must set before going live:

- `POSTGRES_PASSWORD`, `WIDGET_JWT_SECRET` and `COSMIKA_SECRETS_KEY`
  (`openssl rand -base64 32`; back the last one up, losing it means
  re-entering every channel credential).
- Your public addresses: `API_PUBLIC_URL`, `PUBLIC_WEB_URL`, `CORS_ORIGIN`,
  `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REALTIME_URL`.
- `RESEND_API_KEY` and `EMAIL_FROM` on a domain you verified, for password
  resets and notifications.
- `ANTHROPIC_API_KEY` for the AI agent, or `COSMIKA_AI_STUB=1` to try it
  without one.
- `NEXT_PUBLIC_SUPPORT_EMAIL` (and optionally `NEXT_PUBLIC_FINANCE_EMAIL`):
  the contacts your users see. Left blank, those lines are hidden.

Billing is optional and off by default: with `COSMIKA_BILLING_API_URL` and
`COSMIKA_BILLING_API_SECRET` blank, every account has access and signup
gives no checkout link. WhatsApp, Instagram, Messenger and Telegram connect
with your own Meta app and bot tokens; see the comments in
`.env.production.example`.

`scripts/migration-trial.mjs` is a post-deploy smoke test
(`API_URL=... REALTIME_URL=... pnpm migration-trial`).

## Tests

```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## License

[MIT](LICENSE)
