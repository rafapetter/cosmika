# Cosmika Prisma migrations

Through May 2026 the dev workflow used `prisma db push` against the local
Postgres — no migration history existed. The `0_init` migration is a
baseline generated with:

```
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/0_init/migration.sql
npx prisma migrate resolve --applied 0_init
```

It contains the entire schema at the moment of cutover (Modules 1–9 +
WhatsApp + attachments + AUTO_SAFE).

## The 2026-07-29 catch-up

Between the `0_init` cutover and 2026-07, a lot of schema landed via
`db push` without a matching migration — 14 tables (CSAT, SLA, labels,
canned responses, webhooks, notifications, saved views, audit log, API
keys, articles, custom attributes, agent availability), 4 enums, ~30
indexes and the 2FA/`displayId`/`csatEnabled` columns. A database built
from `migrate deploy` alone was missing all of it and the API could not
boot against it — sign-up died on `User.totpEnabled` not existing.

`20260729120000_catch_up_history_to_schema` closes that gap. It was
generated with `migrate diff --from-migrations --to-schema-datamodel` and
then rewritten to be idempotent (`IF NOT EXISTS`, `duplicate_object`
guards, `pg_constraint` checks), so it is equally safe on:

  - a fresh database built purely from migrations, and
  - a database that already has these objects from `db push` — notably
    production, where applying it records the migration and changes
    nothing.

`migration_lock.toml` was also missing, which broke
`migrate diff --from-migrations` entirely.

`test:migrations` in `.gitlab-ci.yml` now builds a database from the
migrations and diffs it against `schema.prisma`, so this can't silently
recur.

## Going forward

Use `prisma migrate dev --name <thing>` for schema changes. Each change
produces a new timestamped folder under `prisma/migrations/`. CI/prod
applies them with `prisma migrate deploy`.

Do not use `db push` for anything that has to reach production. It is for
throwaway local iteration only — it leaves no migration behind, and CI
will now fail the branch.

## Production cutover

On the first production deploy, run:

```
npx prisma migrate resolve --applied 0_init    # if DB was created from db push
# OR
npx prisma migrate deploy                       # if DB is empty
```

Pick the first if you used `db push` against prod. Pick the second on a
fresh DB.

## Why not just `db push` forever

`db push` is destructive — it can drop columns silently. Migrations are
the audit trail of every schema change and let prod safely diff against
what the app expects.
