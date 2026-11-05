# @cosmika/proto

Shared event schemas for Cosmika services. Generates TypeScript (`gen/ts`) and
Go (`gen/go`) bindings from `schemas/cosmika/events/v1/*.proto`.

## Why protobuf

TS apps (api, web) and Go apps (whatsapp-ingest, realtime) all push and pull
the same events from Redis/BullMQ. Protobuf gives us a single source of truth
with cheap forward-compat (add fields without breaking consumers).

## Regenerate

```bash
cd packages/proto
pnpm install
pnpm generate   # buf generate
```

Generated files are committed so consumers don't need to run buf during
normal development.
