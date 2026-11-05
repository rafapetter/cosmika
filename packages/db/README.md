# @cosmika/db

Prisma schema + generated client. Source of truth for the DB schema.

## Scripts

```bash
pnpm generate         # regenerate Prisma client
pnpm migrate          # create + apply a new migration (dev)
pnpm migrate:deploy   # apply migrations (prod / CI)
pnpm reset            # drop + recreate dev DB
pnpm studio           # open Prisma Studio
```

## Consumers

- `apps/api` — main backend queries
- `apps/web` — Server Actions (uses Prisma for some mutations)
- `tools/migrate-from-nebula` — data migration scripts
