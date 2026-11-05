-- Per-account switch: agents see only their teams' conversations (Acme proof
-- of concept, item 09). Off by default, so nothing changes for anyone.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "teamScopedVisibility" BOOLEAN NOT NULL DEFAULT false;
