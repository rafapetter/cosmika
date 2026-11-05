-- SLA in seconds, a queue clock, and an alert (pilot, item 11).
-- All additive: nullable columns and a new enum value.
ALTER TABLE "SlaPolicy" ADD COLUMN IF NOT EXISTS "firstResponseSeconds" INTEGER;
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "queuedAt" TIMESTAMP(3);
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SLA_BREACH';
-- The breach sweep runs every 10 seconds over conversations not yet flagged.
CREATE INDEX IF NOT EXISTS "Conversation_slaBreachedNotifiedAt_idx" ON "Conversation" ("slaBreachedNotifiedAt");
